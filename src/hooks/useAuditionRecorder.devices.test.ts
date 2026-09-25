import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAuditionRecorder } from './useAuditionRecorder'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * 设备热插拔与枚举时序（hook 层验收）。
 *
 * 可控编排：
 * - 枚举 Promise 全部手动落定（resolveEnum 可按任意顺序返回，模拟
 *   “较早发起的枚举在较新的设备变更之后才返回”）；
 * - plugDevices 模拟设备插拔并触发 devicechange（随之发起新枚举）；
 * - manualPermissions 下授权 Promise 由 grant() 手动放行。
 *
 * 核对：设备清单只反映最后一次有效设备事件；空闲时的明确选择在设备
 * 仍可用时保持、确实消失时回退并明确提示下一次录制将使用的设备；
 * 授权等待/录制/暂停期间设备变更只刷新清单、不改写待选设备；当前
 * 录制（冻结计划）与下一条录制（待选设备）的设备身份；旧成片与
 * 交付选择不受设备事件影响。
 */

interface DeviceDef {
  deviceId: string
  kind: 'videoinput' | 'audioinput'
  label: string
}

const CAM_A: DeviceDef = { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' }
const CAM_B: DeviceDef = { deviceId: 'cam2', kind: 'videoinput', label: '摄像头 B' }
const MIC_A: DeviceDef = { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' }
const MIC_B: DeviceDef = { deviceId: 'mic2', kind: 'audioinput', label: '麦克风 B' }

interface EnumCall {
  resolve: (list: DeviceDef[]) => void
  reject: (err: unknown) => void
}

interface Pending {
  constraints?: MediaStreamConstraints
  resolve: (stream: MediaStream) => void
  reject: (err: unknown) => void
}

function installGlobals(opts?: {
  devices?: DeviceDef[]
  manualPermissions?: boolean
}) {
  let currentDevices = opts?.devices ?? [CAM_A, MIC_A]
  const enumCalls: EnumCall[] = []
  const deviceChangeListeners = new Set<() => void>()
  const pending: Pending[] = []
  const createdTracks: FakeTrack[] = []

  const enumerateDevices = vi.fn(
    () =>
      new Promise<MediaDeviceInfo[]>((resolve, reject) => {
        enumCalls.push({
          resolve: (list) =>
            resolve(
              list.map((d) => ({ ...d, toJSON: () => d }) as MediaDeviceInfo),
            ),
          reject,
        })
      }),
  )

  const tracksFor = (constraints?: MediaStreamConstraints): FakeTrack[] => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) tracks.push(new FakeTrack('video'))
    if (constraints?.audio !== false) tracks.push(new FakeTrack('audio'))
    return tracks
  }

  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    if (opts?.manualPermissions) {
      return new Promise<MediaStream>((resolve, reject) => {
        pending.push({ constraints, resolve, reject })
      })
    }
    const tracks = tracksFor(constraints)
    createdTracks.push(...tracks)
    return Promise.resolve({ getTracks: () => tracks } as unknown as MediaStream)
  })

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'devicechange') deviceChangeListeners.add(listener)
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'devicechange') deviceChangeListeners.delete(listener)
      },
    },
  })

  return {
    enumCalls,
    getUserMedia,
    pending,
    tracks: () => createdTracks,
    /** 设备插拔：更新当前清单并派发 devicechange（随之发起一次新枚举） */
    plugDevices: (list: DeviceDef[]) => {
      currentDevices = list
      for (const listener of [...deviceChangeListeners]) listener()
    },
    /** 落定第 index 次枚举：缺省返回当前清单，可显式给清单模拟迟到的旧结果 */
    resolveEnum: (index: number, list?: DeviceDef[]) => {
      const call = enumCalls[index]
      if (!call) {
        throw new Error(`没有第 ${index} 次枚举（共 ${enumCalls.length} 次）`)
      }
      call.resolve(list ?? currentDevices)
    },
    rejectEnum: (index: number, err: unknown) => {
      enumCalls[index]?.reject(err)
    },
    /** 放行最早一次授权请求（按其约束产轨） */
    grant: () => {
      const item = pending.shift()
      if (!item) throw new Error('无等待中的授权请求')
      const tracks = tracksFor(item.constraints)
      createdTracks.push(...tracks)
      item.resolve({ getTracks: () => tracks } as unknown as MediaStream)
    },
  }
}

type Hook = { current: ReturnType<typeof useAuditionRecorder> }

/** 落定一次枚举并等待其应用到界面状态 */
async function applyEnum(
  g: ReturnType<typeof installGlobals>,
  index: number,
  list?: DeviceDef[],
) {
  await act(async () => {
    g.resolveEnum(index, list)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 自动授权模式下录一条成片并停止；停止后回 idle 会再发起一次枚举 */
async function shootAndStop(result: Hook, content = 'x') {
  await act(async () => {
    await result.current.start()
  })
  expect(result.current.status).toBe('recording')
  const rec = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
  await act(async () => {
    rec.emitData([content])
    result.current.stop()
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(result.current.status).toBe('idle')
  return rec
}

const deviceIds = (result: Hook) =>
  result.current.devices.map((d) => d.deviceId)

const noticeOf = (result: Hook, kind: 'video' | 'audio') =>
  result.current.deviceNotices.find((n) => n.kind === kind)?.message

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('枚举时序：清单只反映最后一次有效设备事件', () => {
  it('迟到的旧枚举不覆盖新清单，也不退回已手动选定的新设备', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    expect(g.enumCalls).toHaveLength(1) // 初次载入枚举 E0（未落定）

    // 插入摄像头 B：devicechange 发起新枚举 E1，先返回新清单
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    expect(g.enumCalls).toHaveLength(2)
    await applyEnum(g, 1)
    expect(deviceIds(result)).toEqual(['cam1', 'cam2', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')

    // 导演在新清单中手动选定新接入的摄像头 B
    act(() => {
      result.current.setVideoDeviceId('cam2')
    })
    expect(result.current.videoDeviceId).toBe('cam2')

    // 较早发起的 E0 此刻才返回旧清单（无 cam2）：必须被丢弃
    await applyEnum(g, 0, [CAM_A, MIC_A])
    expect(deviceIds(result)).toEqual(['cam1', 'cam2', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.deviceNotices).toHaveLength(0)

    // 开拍：精确设备请求落到手动选定的 cam2，而非被退回的旧设备
    await act(async () => {
      await result.current.start()
    })
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 收尾枚举 E2：cam2 仍在清单中，选择保持
    await applyEnum(g, 2)
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.takes).toHaveLength(1)
  })

  it('正常顺序下清单随最后一次设备变更更新，仍可用的选择保持', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)
    expect(deviceIds(result)).toEqual(['cam1', 'mic1'])

    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A, MIC_B])
    })
    await applyEnum(g, 1)
    expect(deviceIds(result)).toEqual(['cam1', 'cam2', 'mic1', 'mic2'])
    // 原选择仍可用：保持，不产生提示
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')
    expect(result.current.deviceNotices).toHaveLength(0)
  })

  it('枚举失败不致命：清单与选择保持，旧成片不受影响', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await shootAndStop(result, 'old')
    await applyEnum(g, 1) // 收尾枚举
    expect(result.current.takes).toHaveLength(1)

    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    await act(async () => {
      g.rejectEnum(2, new Error('enumerate denied'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(deviceIds(result)).toEqual(['cam1', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })
})

describe('空闲选择：可用则保持，消失则回退并明确提示', () => {
  it('手动选择在设备仍可用时不被后续枚举改写', async () => {
    const g = installGlobals({ devices: [CAM_A, CAM_B, MIC_A] })
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    act(() => {
      result.current.setVideoDeviceId('cam2')
    })
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A, MIC_B])
    })
    await applyEnum(g, 1)
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(result.current.deviceNotices).toHaveLength(0)
  })

  it('所选设备确实消失：回退到可用设备，明确提示下一次录制将使用的设备', async () => {
    const g = installGlobals({ devices: [CAM_A, CAM_B, MIC_A] })
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    act(() => {
      result.current.setVideoDeviceId('cam2')
    })
    // 拔掉摄像头 B：选择回退到摄像头 A 并给出明确提示
    act(() => {
      g.plugDevices([CAM_A, MIC_A])
    })
    await applyEnum(g, 1)
    expect(result.current.videoDeviceId).toBe('cam1')
    const notice = noticeOf(result, 'video')
    expect(notice).toContain('摄像头 B')
    expect(notice).toContain('已断开')
    expect(notice).toContain('下一次录制将使用「摄像头 A」')

    // 开拍即按回退后的设备冻结：提示使命结束，约束指向 cam1
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.deviceNotices).toHaveLength(0)
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    await applyEnum(g, 2)
    // cam1 仍在：不再产生新提示
    expect(result.current.deviceNotices).toHaveLength(0)
    expect(result.current.videoDeviceId).toBe('cam1')
  })

  it('同类设备全部消失：回退为系统默认并提示', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)
    expect(result.current.videoDeviceId).toBe('cam1')

    act(() => {
      g.plugDevices([MIC_A])
    })
    await applyEnum(g, 1)
    expect(result.current.videoDeviceId).toBe('')
    const notice = noticeOf(result, 'video')
    expect(notice).toContain('摄像头 A')
    expect(notice).toContain('系统默认设备')
  })

  it('麦克风消失同样回退并提示，且不影响摄像头选择', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    act(() => {
      g.plugDevices([CAM_A])
    })
    await applyEnum(g, 1)
    expect(result.current.audioDeviceId).toBe('')
    expect(result.current.videoDeviceId).toBe('cam1')
    const notice = noticeOf(result, 'audio')
    expect(notice).toContain('麦克风 A')
    expect(noticeOf(result, 'video')).toBeUndefined()
  })
})

describe('非空闲冻结：设备变更只刷新清单，不改写待选设备', () => {
  it('录制中插入新设备：清单更新、待选不改写，收尾后仍沿用原选择', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    // 本次录制的设备身份：冻结计划即实际采集设备
    expect(result.current.activePlan).toEqual({
      videoDeviceId: 'cam1',
      audioDeviceId: 'mic1',
    })

    // 录制中插入摄像头 B：清单反映最新事件，但待选设备不被改写
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(deviceIds(result)).toEqual(['cam1', 'cam2', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.activePlan?.videoDeviceId).toBe('cam1')

    // 停止后收尾枚举：cam1 仍在清单中，下一条沿用原选择
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    await applyEnum(g, 2)
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.activePlan).toBeNull()

    await act(async () => {
      await result.current.start()
    })
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
  })

  it('授权等待（starting）期间设备变更不改写待选，取流约束保持冻结值', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await act(async () => {
      result.current.start()
    })
    expect(result.current.status).toBe('starting')
    expect(result.current.activePlan).toEqual({
      videoDeviceId: 'cam1',
      audioDeviceId: 'mic1',
    })

    // 授权弹窗未决时插入摄像头 B：清单可更新，待选与冻结计划不动
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(deviceIds(result)).toEqual(['cam1', 'cam2', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.activePlan?.videoDeviceId).toBe('cam1')

    // 放行授权：取流约束仍是开拍瞬间冻结的 cam1/mic1
    expect(g.pending[0].constraints).toEqual({
      video: { deviceId: { exact: 'cam1' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    await act(async () => {
      g.grant()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('recording')

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    await applyEnum(g, 2)
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.deviceNotices).toHaveLength(0)
  })

  it('暂停期间设备变更不改写待选；继续并停止后才对齐清单', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await act(async () => {
      await result.current.start()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    act(() => {
      result.current.pause()
    })
    expect(result.current.status).toBe('paused')

    // 暂停期间拔掉摄像头 A、换入摄像头 B：待选绝不被改写
    act(() => {
      g.plugDevices([CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(deviceIds(result)).toEqual(['cam2', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.activePlan?.videoDeviceId).toBe('cam1')

    act(() => {
      result.current.resume()
    })
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 收尾枚举应用：cam1 确实消失 → 回退 cam2 并明确提示
    await applyEnum(g, 2)
    expect(result.current.videoDeviceId).toBe('cam2')
    const notice = noticeOf(result, 'video')
    expect(notice).toContain('摄像头 A')
    expect(notice).toContain('下一次录制将使用「摄像头 B」')

    // 下一条按回退后的设备取流
    await act(async () => {
      await result.current.start()
    })
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
  })

  it('授权等待中取消：回空闲的枚举才对齐选择并提示', async () => {
    const g = installGlobals({ manualPermissions: true })
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await act(async () => {
      result.current.start()
    })
    expect(result.current.status).toBe('starting')

    // 等待授权期间摄像头 A 被拔掉：待选不改写
    act(() => {
      g.plugDevices([CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(result.current.videoDeviceId).toBe('cam1')

    // 取消本次开拍：回空闲触发枚举，此时才对齐到 cam2 并提示
    await act(async () => {
      result.current.stop()
    })
    expect(result.current.status).toBe('idle')
    await applyEnum(g, 2)
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(noticeOf(result, 'video')).toContain('下一次录制将使用「摄像头 B」')

    await act(async () => {
      result.current.start()
    })
    // 首次开拍的授权请求未被消费（取消作废旧会话），重拍是新的请求
    expect(g.pending[g.pending.length - 1].constraints).toEqual({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
  })
})

describe('当前采集设备中断与旧素材兼容', () => {
  it('录制中当前设备被拔除：中断成片保留，收尾后回退并提示，下一条用回退设备', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await act(async () => {
      await result.current.start()
    })
    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    // 摄像头 A（当前采集设备）被拔除：轨道 ended → 设备中断停止
    await act(async () => {
      rec.emitData(['before-unplug'])
      g.tracks()[0].emitEnded()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.takes[0].reason).toBe('device-interrupted')

    // 收尾枚举：清单里已是摄像头 B → 回退并明确提示
    await applyEnum(g, 1, [CAM_B, MIC_A])
    expect(result.current.videoDeviceId).toBe('cam2')
    expect(noticeOf(result, 'video')).toContain('下一次录制将使用「摄像头 B」')

    // 下一条精确请求回退后的设备；旧成片原样保留
    await act(async () => {
      await result.current.start()
    })
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    expect(result.current.takes).toHaveLength(1)
  })

  it('枚举乱序与设备插拔不影响旧成片与交付选择', async () => {
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await applyEnum(g, 0)

    await shootAndStop(result, 'A')
    await applyEnum(g, 1)
    await shootAndStop(result, 'B')
    await applyEnum(g, 2)
    expect(result.current.takes).toHaveLength(2)
    const [takeA, takeB] = result.current.takes
    act(() => {
      result.current.selectTake(takeB.id)
    })
    expect(result.current.selectedTake?.id).toBe(takeB.id)

    // 连续两次插拔：E3（插入 B）、E4（拔掉 B）；后发起的 E4 先返回
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    act(() => {
      g.plugDevices([CAM_A, MIC_A])
    })
    expect(g.enumCalls).toHaveLength(5)
    await applyEnum(g, 4, [CAM_A, MIC_A])
    // E3 迟到返回含 cam2 的旧清单：必须被丢弃
    await applyEnum(g, 3, [CAM_A, CAM_B, MIC_A])
    expect(deviceIds(result)).toEqual(['cam1', 'mic1'])
    expect(result.current.videoDeviceId).toBe('cam1')

    // 旧成片、交付选择原样保留
    expect(result.current.takes.map((t) => t.id)).toEqual([takeA.id, takeB.id])
    expect(result.current.selectedTake?.id).toBe(takeB.id)
    expect(result.current.deviceNotices).toHaveLength(0)
  })
})
