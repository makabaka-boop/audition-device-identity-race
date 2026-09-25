import { describe, expect, it, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { FakeMediaRecorder, FakeTrack } from './test/fakes'

/**
 * 设备热插拔（UI 层验收）：
 * - 下拉框清单只反映最后一次有效设备事件，迟到的旧枚举不覆盖；
 * - 录制/授权等待期间下拉框展示本次实际采集设备（冻结计划），
 *   不随热插拔改名；当前设备断开时以占位项显示原设备（已断开）；
 * - 所选设备确实消失时，页面明确提示下一次录制将使用的设备；
 * - 旧成片与交付选择不受设备事件影响。
 */

interface DeviceDef {
  deviceId: string
  kind: 'videoinput' | 'audioinput'
  label: string
}

const CAM_A: DeviceDef = { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' }
const CAM_B: DeviceDef = { deviceId: 'cam2', kind: 'videoinput', label: '摄像头 B' }
const MIC_A: DeviceDef = { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' }

interface EnumCall {
  resolve: (list: DeviceDef[]) => void
  reject: (err: unknown) => void
}

function installGlobals(opts?: { devices?: DeviceDef[] }) {
  let currentDevices = opts?.devices ?? [CAM_A, MIC_A]
  const enumCalls: EnumCall[] = []
  const deviceChangeListeners = new Set<() => void>()

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
  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints) => {
    const tracks: FakeTrack[] = []
    if (constraints?.video !== false) tracks.push(new FakeTrack('video'))
    if (constraints?.audio !== false) tracks.push(new FakeTrack('audio'))
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
    plugDevices: (list: DeviceDef[]) => {
      currentDevices = list
      for (const listener of [...deviceChangeListeners]) listener()
    },
    resolveEnum: (index: number, list?: DeviceDef[]) => {
      const call = enumCalls[index]
      if (!call) {
        throw new Error(`没有第 ${index} 次枚举（共 ${enumCalls.length} 次）`)
      }
      call.resolve(list ?? currentDevices)
    },
  }
}

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

const cameraSelect = () =>
  screen.getByRole('combobox', { name: '摄像头' }) as HTMLSelectElement

const optionTexts = (select: HTMLSelectElement) =>
  Array.from(select.options).map((o) => o.text)

/** 点击开始 → 录制 → 停止，形成一条成片；停止后回 idle 会再发起一次枚举 */
async function shootAndStop(content: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
  })
  const rec = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]
  await act(async () => {
    rec.emitData([content])
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    rec.emitStop()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rec
}

describe('设备热插拔（UI）', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve(),
    )
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined,
    )
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    FakeMediaRecorder.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('下拉框清单只反映最后一次设备事件：迟到的旧枚举不覆盖，新设备不消失', async () => {
    const g = installGlobals({})
    render(<App />)
    expect(g.enumCalls).toHaveLength(1) // 初次载入枚举 E0（未落定）

    // 插入摄像头 B：新枚举 E1 先返回新清单
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(optionTexts(cameraSelect())).toEqual(['摄像头 A', '摄像头 B'])

    // 导演在新清单中手动选定摄像头 B
    fireEvent.change(cameraSelect(), { target: { value: 'cam2' } })
    expect(cameraSelect().value).toBe('cam2')

    // 较早发起的 E0 迟到返回旧清单：下拉框与选择都不被退回
    await applyEnum(g, 0, [CAM_A, MIC_A])
    expect(optionTexts(cameraSelect())).toEqual(['摄像头 A', '摄像头 B'])
    expect(cameraSelect().value).toBe('cam2')
    expect(screen.queryByText(/已断开/)).toBeNull()
  })

  it('录制中下拉框展示本次实际采集设备，不随热插拔改名；停止后解锁', async () => {
    const g = installGlobals({})
    render(<App />)
    await applyEnum(g, 0)
    expect(cameraSelect().value).toBe('cam1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect((cameraSelect() as HTMLSelectElement).disabled).toBe(true)

    // 录制中插入摄像头 B：新设备进清单，但下拉框仍显示本次采集的摄像头 A
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(optionTexts(cameraSelect())).toEqual(['摄像头 A', '摄像头 B'])
    expect(cameraSelect().value).toBe('cam1')
    expect(screen.getByText('录制进行中，设备已锁定；停止后才可切换。')).toBeTruthy()

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 收尾枚举 E2：cam1 仍在清单中，下一条沿用原选择
    await applyEnum(g, 2)
    expect(cameraSelect().value).toBe('cam1')
    expect((cameraSelect() as HTMLSelectElement).disabled).toBe(false)
    expect(screen.queryByText(/下一次录制将使用/)).toBeNull()
  })

  it('录制中当前设备断开：占位项显示原设备（已断开），收尾后提示下一次使用的设备', async () => {
    const g = installGlobals({})
    render(<App />)
    await applyEnum(g, 0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })

    // 录制中摄像头 A 被拔掉、换入摄像头 B：清单更新，
    // 但下拉框仍以占位项显示本次实际采集的摄像头 A（已断开）
    act(() => {
      g.plugDevices([CAM_B, MIC_A])
    })
    await applyEnum(g, 1)
    expect(cameraSelect().value).toBe('cam1')
    expect(optionTexts(cameraSelect())).toEqual([
      '摄像头 B',
      '摄像头 A（已断开）',
    ])

    const rec = FakeMediaRecorder.instances[
      FakeMediaRecorder.instances.length - 1
    ]
    await act(async () => {
      rec.emitData(['x'])
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 收尾枚举 E2：cam1 确实消失 → 回退 cam2 并明确提示下一次录制设备
    await applyEnum(g, 2)
    expect(cameraSelect().value).toBe('cam2')
    expect(optionTexts(cameraSelect())).toEqual(['摄像头 B'])
    expect(
      screen.getByText(
        '所选摄像头「摄像头 A」已断开，下一次录制将使用「摄像头 B」。',
      ),
    ).toBeTruthy()

    // 下一条开拍：精确请求回退后的摄像头 B，提示随之消失
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 take' }))
    })
    expect(g.getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam2' } },
      audio: { deviceId: { exact: 'mic1' } },
    })
    expect(screen.queryByText(/下一次录制将使用/)).toBeNull()
  })

  it('空闲时设备消失：明确提示下一次录制将使用的设备；手动改选后提示消除', async () => {
    const g = installGlobals({ devices: [CAM_A, CAM_B, MIC_A] })
    render(<App />)
    await applyEnum(g, 0)

    // 导演选定摄像头 B，随后 B 被拔掉
    fireEvent.change(cameraSelect(), { target: { value: 'cam2' } })
    act(() => {
      g.plugDevices([CAM_A, MIC_A])
    })
    await applyEnum(g, 1)
    expect(cameraSelect().value).toBe('cam1')
    expect(
      screen.getByText(
        '所选摄像头「摄像头 B」已断开，下一次录制将使用「摄像头 A」。',
      ),
    ).toBeTruthy()

    // 导演看到提示后手动改选（这里改回摄像头 A）：提示消除
    fireEvent.change(cameraSelect(), { target: { value: 'cam1' } })
    expect(screen.queryByText(/下一次录制将使用/)).toBeNull()
  })

  it('旧成片与交付选择不受设备事件与枚举乱序影响', async () => {
    const g = installGlobals({})
    render(<App />)
    await applyEnum(g, 0)

    await shootAndStop('A')
    await applyEnum(g, 1)
    await shootAndStop('B')
    await applyEnum(g, 2)
    expect(document.querySelectorAll('video.take-video')).toHaveLength(2)

    // 把较早的 A 选为交付版
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '选为交付版' })[0])
    })
    expect(screen.getByRole('button', { name: '★ 交付版' })).toBeTruthy()

    // 连续插拔 + 枚举乱序返回
    act(() => {
      g.plugDevices([CAM_A, CAM_B, MIC_A])
    })
    act(() => {
      g.plugDevices([CAM_A, MIC_A])
    })
    await applyEnum(g, 4, [CAM_A, MIC_A]) // 后发起的先返回
    await applyEnum(g, 3, [CAM_A, CAM_B, MIC_A]) // 旧清单迟到，丢弃

    expect(optionTexts(cameraSelect())).toEqual(['摄像头 A'])
    expect(document.querySelectorAll('video.take-video')).toHaveLength(2)
    // 交付选择仍是 A（列表倒序渲染：第二张卡片是 A）
    const deliveryButtons = screen.getAllByRole('button', {
      name: /交付版|选为交付版/,
    })
    expect(deliveryButtons[1].textContent).toBe('★ 交付版')
    expect(screen.queryByText(/下一次录制将使用/)).toBeNull()
  })
})
