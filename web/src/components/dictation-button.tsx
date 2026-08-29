import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { LoaderCircle, Mic, MicOff, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: { platform?: string }
}

interface AudioContextWindow extends Window {
  webkitAudioContext?: typeof AudioContext
}

interface ActiveRecording {
  chunks: Blob[]
  mimeType: string
  recorder: MediaRecorder
  stream: MediaStream
  timer: ReturnType<typeof setTimeout>
}

type DictationState =
  | { status: "idle" }
  | { status: "recording" }
  | { status: "transcribing" }
  | { status: "error"; message: string }

interface DictationButtonProps {
  disabled?: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  value: string
}

function isMacOs(): boolean {
  if (typeof navigator === "undefined") return false
  const device = navigator as NavigatorWithUserAgentData
  const platform = device.userAgentData?.platform ?? device.platform
  const isIPadDesktopMode = platform === "MacIntel" && device.maxTouchPoints > 1
  return /mac/iu.test(platform) && !isIPadDesktopMode
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined
  const audioWindow = window as AudioContextWindow
  return window.AudioContext ?? audioWindow.webkitAudioContext
}

function dictationAvailable(): boolean {
  return isMacOs() &&
    typeof MediaRecorder !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    audioContextConstructor() !== undefined
}

function selectedMimeType(): string {
  const supported = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
    .find((mimeType) => MediaRecorder.isTypeSupported(mimeType))
  return supported ?? ""
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function insertTranscript(value: string, start: number, end: number, transcript: string): { cursor: number; value: string } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const spaceBefore = before.length > 0 && !/[\s([{]$/u.test(before) && !/^[,.;:!?)}\]]/u.test(transcript) ? " " : ""
  const spaceAfter = after.length > 0 && !/^[\s,.;:!?)}\]]/u.test(after) && !/[\s([{]$/u.test(transcript) ? " " : ""
  const inserted = `${spaceBefore}${transcript}${spaceAfter}`
  return {
    cursor: before.length + inserted.length,
    value: `${before}${inserted}${after}`,
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function waveFile(buffer: AudioBuffer): ArrayBuffer {
  const sampleCount = buffer.length
  const channelCount = buffer.numberOfChannels
  const output = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(output)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, sampleCount * 2, true)

  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index))
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let sample = 0
    for (const channel of channels) sample += channel[sampleIndex] ?? 0
    const normalized = Math.max(-1, Math.min(1, sample / channelCount))
    view.setInt16(44 + sampleIndex * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
  }
  return output
}

async function recordedWave(chunks: readonly Blob[], mimeType: string): Promise<ArrayBuffer> {
  const RecordingAudioContext = audioContextConstructor()
  if (RecordingAudioContext === undefined) throw new Error("Audio decoding is not available.")
  const context = new RecordingAudioContext()
  try {
    const encoded = await new Blob([...chunks], { type: mimeType }).arrayBuffer()
    const decoded = await context.decodeAudioData(encoded.slice(0))
    return waveFile(decoded)
  } finally {
    await context.close()
  }
}

function responseError(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return "Local dictation could not finish."
  }
  const message = payload.error
  return typeof message === "string" && message.length > 0 ? message : "Local dictation could not finish."
}

async function transcribe(wave: ArrayBuffer): Promise<string> {
  const response = await fetch("/api/dictation/transcribe", {
    body: new Blob([wave], { type: "audio/wav" }),
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "audio/wav",
      "X-Sheppard-Dictation-Locale": navigator.language,
    },
    method: "POST",
  })
  if (!response.ok) {
    const errorPayload: unknown = await response.json().catch(() => null)
    throw new Error(responseError(errorPayload))
  }
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload !== "object" || payload === null || !("transcript" in payload)) {
    throw new Error("Local dictation returned an invalid response.")
  }
  const transcript = payload.transcript
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("No speech was detected.")
  }
  return transcript.trim()
}

function recordingErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Allow microphone access for Sheppard in your browser."
      case "NotFoundError":
        return "No microphone is available."
      case "NotReadableError":
        return "The microphone is in use by another application."
      default:
        return "The microphone could not start."
    }
  }
  return cause instanceof Error ? cause.message : "Local dictation could not start."
}

function recorderCleanup(recording: ActiveRecording): void {
  clearTimeout(recording.timer)
  recording.recorder.ondataavailable = null
  recording.recorder.onerror = null
  recording.recorder.onstop = null
  if (recording.recorder.state !== "inactive") recording.recorder.stop()
  stopStream(recording.stream)
}

interface DictationControlProps extends DictationButtonProps {
  disabled: boolean
}

export function DictationButton(props: DictationButtonProps) {
  const disabled = props.disabled ?? false
  return <DictationControl {...props} disabled={disabled} key={disabled ? "disabled" : "enabled"} />
}

function DictationControl({ disabled, inputRef, onChange, value }: DictationControlProps) {
  const [available] = useState(dictationAvailable)
  const [state, setState] = useState<DictationState>({ status: "idle" })
  const recordingRef = useRef<ActiveRecording | null>(null)
  const mountedRef = useRef(true)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const finishRecording = useCallback(async (recording: ActiveRecording): Promise<void> => {
    clearTimeout(recording.timer)
    stopStream(recording.stream)
    if (!mountedRef.current) return
    recordingRef.current = null
    setState({ status: "transcribing" })
    try {
      const wave = await recordedWave(recording.chunks, recording.mimeType)
      const transcript = await transcribe(wave)
      if (!mountedRef.current) return
      const input = inputRef.current
      const currentValue = valueRef.current
      const startAt = input?.selectionStart ?? currentValue.length
      const endAt = input?.selectionEnd ?? startAt
      const inserted = insertTranscript(currentValue, startAt, endAt, transcript)
      valueRef.current = inserted.value
      onChangeRef.current(inserted.value)
      setState({ status: "idle" })
      globalThis.requestAnimationFrame(() => {
        input?.focus()
        input?.setSelectionRange(inserted.cursor, inserted.cursor)
      })
    } catch (cause) {
      if (mountedRef.current) setState({ message: recordingErrorMessage(cause), status: "error" })
    }
  }, [inputRef])

  const stop = useCallback((): void => {
    const recording = recordingRef.current
    if (recording === null || recording.recorder.state === "inactive") return
    recording.recorder.stop()
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (disabled || !available || recordingRef.current !== null) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      if (!mountedRef.current || disabled) {
        stopStream(stream)
        return
      }
      const mimeType = selectedMimeType()
      const recorder = mimeType.length === 0 ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType })
      const recording: ActiveRecording = {
        chunks: [],
        mimeType: recorder.mimeType || mimeType,
        recorder,
        stream,
        timer: setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop()
        }, 60_000),
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recording.chunks.push(event.data)
      }
      recorder.onerror = () => {
        clearTimeout(recording.timer)
        recorder.onstop = null
        stopStream(stream)
        recordingRef.current = null
        if (mountedRef.current) setState({ message: "The microphone stopped unexpectedly.", status: "error" })
      }
      recorder.onstop = () => void finishRecording(recording)
      recordingRef.current = recording
      recorder.start(250)
      setState({ status: "recording" })
    } catch (cause) {
      if (mountedRef.current) setState({ message: recordingErrorMessage(cause), status: "error" })
    }
  }, [available, disabled, finishRecording])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recording = recordingRef.current
      if (recording === null) return
      recorderCleanup(recording)
      recordingRef.current = null
    }
  }, [])

  if (!available) return null

  const recording = state.status === "recording"
  const transcribing = state.status === "transcribing"
  const title = recording
    ? "Stop local dictation"
    : transcribing
    ? "Transcribing on this Mac"
    : state.status === "error"
    ? state.message
    : "Start local dictation"

  return (
    <div className="relative shrink-0">
      <Button
        aria-label={recording ? "Stop local dictation" : transcribing ? "Transcribing on this Mac" : "Start local dictation"}
        aria-pressed={recording}
        className={cn(
          recording && "border-red-500/60 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400",
          state.status === "error" && "text-destructive",
        )}
        data-dictation-state={state.status}
        disabled={disabled || transcribing}
        onClick={recording ? stop : () => void start()}
        size="icon-sm"
        title={title}
        type="button"
        variant="outline"
      >
        {transcribing
          ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : state.status === "error"
          ? <MicOff aria-hidden="true" />
          : <Mic aria-hidden="true" />}
      </Button>
      {state.status === "error" && (
        <div className="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 flex w-72 items-start gap-2 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-lg" role="alert">
          <span className="min-w-0 flex-1">{state.message}</span>
          <button aria-label="Dismiss dictation error" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setState({ status: "idle" })} type="button">
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {recording ? "Local dictation is recording." : transcribing ? "Transcribing on this Mac." : ""}
      </span>
    </div>
  )
}
