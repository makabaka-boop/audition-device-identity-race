import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CAPTURE_MODES,
  CaptureError,
  CaptureRecorder,
  type AddMarkerResult,
  type CaptureMode,
  type RecorderDeps,
  type RecorderStatus,
  type Take,
  type TakeMarker,
} from '../recorder/CaptureRecorder'

export interface MediaDeviceInfoLite {
  deviceId: string
  kind: 'videoinput' | 'audioinput'
  label: string
}

function createBrowserDeps(): RecorderDeps {
  const g = globalThis as unknown as {
    MediaRecorder: RecorderDeps['MediaRecorder']
  }
  return {
    MediaRecorder: g.MediaRecorder,
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => Date.now(),
    randomId: () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `take-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    setTimer: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

function detectCapabilities(
  recorder: CaptureRecorder,
): Record<CaptureMode, string | null> {
  return recorder.getSupportedMimeTypes()
}

export function useAuditionRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [devices, setDevices] = useState<MediaDeviceInfoLite[]>([])
  const [videoDeviceId, setVideoDeviceId] = useState('')
  const [audioDeviceId, setAudioDeviceId] = useState('')
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const [error, setError] = useState<CaptureError | null>(null)
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null)
  // 音视频为默认模式；只有空闲可切换
  const [mode, setModeState] = useState<CaptureMode>('av')
  const [mimeByMode, setMimeByMode] = useState<
    Record<CaptureMode, string | null>
  >({ av: null, 'video-only': null, 'audio-only': null })
  // 进行中的实际模式/MIME（starting 起冻结，回 idle 清空）
  const [activeMode, setActiveMode] = useState<CaptureMode | null>(null)
  const [activeMimeType, setActiveMimeType] = useState<string | null>(null)
  /**
   * 当前录制会话实时累积的瞬间标记（仅 recording 中可写入）。
   * 进入新会话（starting）或落定回 idle 时清空：停止成功后标记改由
   * 所选/列表 Take.markers 提供，切换 take 自然各带各的标记。
   */
  const [liveMarkers, setLiveMarkers] = useState<TakeMarker[]>([])

  const recorderRef = useRef<CaptureRecorder | null>(null)
  // take 列表镜像：卸载时批量 revoke，避免依赖 state 闭包过期
  const takesRef = useRef<Take[]>([])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const mapped: MediaDeviceInfoLite[] = list
        .filter(
          (d): d is MediaDeviceInfo =>
            d.kind === 'videoinput' || d.kind === 'audioinput',
        )
        .map((d) => ({
          deviceId: d.deviceId,
          kind: d.kind as 'videoinput' | 'audioinput',
          label:
            d.label ||
            (d.kind === 'videoinput'
              ? `摄像头 ${d.deviceId.slice(0, 4) || '默认'}`
              : `麦克风 ${d.deviceId.slice(0, 4) || '默认'}`),
        }))
      setDevices(mapped)
      setVideoDeviceId((prev) =>
        prev && mapped.some((d) => d.deviceId === prev)
          ? prev
          : (mapped.find((d) => d.kind === 'videoinput')?.deviceId ?? ''),
      )
      setAudioDeviceId((prev) =>
        prev && mapped.some((d) => d.deviceId === prev)
          ? prev
          : (mapped.find((d) => d.kind === 'audioinput')?.deviceId ?? ''),
      )
    } catch {
      // 枚举失败不致命：开拍时 getUserMedia 会暴露真正的授权/设备错误
    }
  }, [])

  useEffect(() => {
    const recorder = new CaptureRecorder(
      {
        onStatusChange: (next) => {
          setStatus(next)
          // 冻结中的模式/MIME/流随状态同步：starting 即冻结，idle 即解锁
          setActiveMode(recorder.getActiveMode())
          setActiveMimeType(recorder.getActiveMimeType())
          setLiveStream((recorder.getActiveStream() as MediaStream | null) ?? null)
          // 标记按会话存活：新会话开拍或落定回 idle 都必须清空实时镜像，
          // 旧会话迟到的 onMarker 不可能残留到新 take 的界面上。
          if (next === 'starting' || next === 'idle') setLiveMarkers([])
        },
        onTake: (take) => {
          takesRef.current = [...takesRef.current, take]
          setTakes(takesRef.current)
          // 首次成片自动选为交付版；之后不抢夺用户选择
          setSelectedTakeId((prev) => prev ?? take.id)
        },
        onMarker: (marker) => {
          // 内核按会话守卫，回调一次即一条新标记；追加次序即创建次序
          // （同毫秒以 order 稳定区分），回放冻结时不重排。
          setLiveMarkers((prev) => [...prev, marker])
        },
        onError: (err) => setError(err),
        onSettled: () => {
          // 授权过一次后 label 才完整，停止后刷新设备清单
          void refreshDevices()
        },
      },
      createBrowserDeps(),
    )
    recorderRef.current = recorder
    setMimeByMode(detectCapabilities(recorder))

    void refreshDevices()
    const onDeviceChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)

    return () => {
      navigator.mediaDevices?.removeEventListener?.(
        'devicechange',
        onDeviceChange,
      )
      // 卸载：停掉录制（释放摄像头/麦克风轨道），并撤销所有成片 URL
      recorder.dispose()
      for (const take of takesRef.current) URL.revokeObjectURL(take.url)
      takesRef.current = []
      recorderRef.current = null
      setLiveStream(null)
    }
  }, [refreshDevices])

  const start = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.getStatus() !== 'idle') return
    setError(null)
    // 绝不在开拍前清空既有成片：授权被拒 / 录制器初始化或启动失败时，
    // 已有的 take 及其交付版选择必须原样保留（新成片由 onTake 追加）。
    //
    // 取流统一由内核负责：进入 start 的同一拍即切到 starting 并冻结
    // 模式、MIME 与相关设备，随后才申请权限；等待授权期间重复 start
    // 被内核的状态守卫挡下，模式/设备切换也改不动已冻结的计划。
    recorder.start({
      mode,
      videoDeviceId,
      audioDeviceId,
    })
  }, [mode, videoDeviceId, audioDeviceId])

  const pause = useCallback(() => recorderRef.current?.pause(), [])
  const resume = useCallback(() => recorderRef.current?.resume(), [])
  const stop = useCallback(() => recorderRef.current?.stop(), [])

  /**
   * 写入瞬间标记：只有正在录制且未冻结停止时成功。
   * 返回明确结局供 UI 即时提示（暂停/等待权限/停止中/已结束/空标签…），
   * 时间戳由内核用排除暂停的有效时钟打。
   */
  const addMarker = useCallback(
    (label: string): AddMarkerResult => {
      const recorder = recorderRef.current
      if (!recorder) {
        return {
          ok: false,
          reason: 'not-recording',
          message: '当前没有正在录制的 take，不能打标记。',
        }
      }
      return recorder.addMarker(label)
    },
    [],
  )

  const selectTake = useCallback((id: string) => setSelectedTakeId(id), [])

  const deleteTake = useCallback((id: string) => {
    const target = takesRef.current.find((t) => t.id === id)
    if (target) URL.revokeObjectURL(target.url)
    const next = takesRef.current.filter((t) => t.id !== id)
    takesRef.current = next
    setTakes(next)
    setSelectedTakeId((prev) =>
      prev === id ? (next[0]?.id ?? null) : prev,
    )
  }, [])

  const isIdle = status === 'idle'
  const canSwitchDevice = isIdle
  // 当前所选模式有可用 MIME 才允许开拍；冻结期间（starting…）按钮同样禁用
  const canStart = isIdle && mimeByMode[mode] !== null
  // 瞬间标记只在录制中可写入：暂停/等待权限/停止中/已结束一律禁用入口
  const canMark = status === 'recording'
  const selectedTake = takes.find((t) => t.id === selectedTakeId) ?? null

  return {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    // 仅空闲可切换设备：录制/授权等待中调用直接忽略（读内核状态，
    // 同一拍内的重复点击也无法穿透）
    setVideoDeviceId: (id: string) => {
      if (recorderRef.current?.getStatus() === 'idle') setVideoDeviceId(id)
    },
    setAudioDeviceId: (id: string) => {
      if (recorderRef.current?.getStatus() === 'idle') setAudioDeviceId(id)
    },
    mode,
    modes: CAPTURE_MODES,
    /** 各模式独立的实际 MIME（该模式全不可用时为 null，仅禁用该模式） */
    mimeByMode,
    /** 向后兼容：当前所选（或进行中冻结）模式的 MIME */
    supportedMimeType: activeMimeType ?? mimeByMode[mode],
    activeMode,
    activeMimeType,
    // 仅空闲可切换模式：开拍后模式即冻结，回到 idle 才解锁；
    // 目标模式自身无可用 MIME（已被禁用）时同样不得选中——既不会取设备，
    // 也不会改动任何旧 take / 交付选择。
    setMode: (next: CaptureMode) => {
      if (recorderRef.current?.getStatus() !== 'idle') return
      if (mimeByMode[next] === null) return
      setModeState(next)
    },
    takes,
    selectedTake,
    selectTake,
    deleteTake,
    error,
    canStart,
    canSwitchDevice,
    canMark,
    liveMarkers,
    liveStream,
    start,
    pause,
    resume,
    stop,
    addMarker,
  }
}
