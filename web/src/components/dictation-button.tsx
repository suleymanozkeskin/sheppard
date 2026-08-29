import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Mic, MicOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  abort: () => void
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: { platform?: string }
}

type DictationState =
  | { status: "idle" }
  | { status: "listening" }
  | { status: "error"; message: string }

interface DictationButtonProps {
  disabled?: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  value: string
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined
  const speechWindow = window as SpeechRecognitionWindow
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

function isMacOs(): boolean {
  if (typeof navigator === "undefined") return false
  const device = navigator as NavigatorWithUserAgentData
  const platform = device.userAgentData?.platform ?? device.platform
  const isIPadDesktopMode = platform === "MacIntel" && device.maxTouchPoints > 1
  return /mac/iu.test(platform) && !isIPadDesktopMode
}

function recognitionErrorMessage(error: string): string {
  switch (error) {
    case "audio-capture":
      return "No microphone is available."
    case "network":
      return "The speech service is not available."
    case "no-speech":
      return "No speech was detected."
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked for Sheppard."
    default:
      return "Voice dictation stopped."
  }
}

function finalTranscript(event: SpeechRecognitionEventLike): string {
  let transcript = ""
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index]
    if (result?.isFinal !== true) continue
    transcript += result[0]?.transcript ?? ""
  }
  return transcript.trim()
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

export function DictationButton({ disabled = false, inputRef, onChange, value }: DictationButtonProps) {
  const [available] = useState(() => isMacOs() && speechRecognitionConstructor() !== undefined)
  const [state, setState] = useState<DictationState>({ status: "idle" })
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const stoppingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const stop = useCallback((): void => {
    const recognition = recognitionRef.current
    if (recognition === null) return
    stoppingRef.current = true
    recognition.stop()
  }, [])

  const start = useCallback((): void => {
    const Recognition = speechRecognitionConstructor()
    if (Recognition === undefined || disabled) return

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = navigator.language
    recognition.maxAlternatives = 1
    stoppingRef.current = false
    recognitionRef.current = recognition
    recognition.onresult = (event) => {
      const transcript = finalTranscript(event)
      if (transcript.length === 0) return
      const input = inputRef.current
      const currentValue = valueRef.current
      const startAt = input?.selectionStart ?? currentValue.length
      const endAt = input?.selectionEnd ?? startAt
      const inserted = insertTranscript(currentValue, startAt, endAt, transcript)
      valueRef.current = inserted.value
      onChangeRef.current(inserted.value)
      globalThis.requestAnimationFrame(() => {
        input?.focus()
        input?.setSelectionRange(inserted.cursor, inserted.cursor)
      })
    }
    recognition.onerror = (event) => {
      if (stoppingRef.current && event.error === "aborted") return
      setState({ message: recognitionErrorMessage(event.error), status: "error" })
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setState((current) => current.status === "error" ? current : { status: "idle" })
    }

    setState({ status: "listening" })
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      setState({ message: "Voice dictation could not start.", status: "error" })
    }
  }, [disabled, inputRef])

  useEffect(() => {
    const recognition = recognitionRef.current
    if (!disabled || recognition === null) return
    stoppingRef.current = true
    recognition.abort()
    recognitionRef.current = null
  }, [disabled])

  useEffect(() => () => {
    const recognition = recognitionRef.current
    if (recognition === null) return
    recognition.onend = null
    recognition.onerror = null
    recognition.onresult = null
    recognition.abort()
    recognitionRef.current = null
  }, [])

  if (!available) return null

  const listening = state.status === "listening"
  const title = listening
    ? "Stop voice dictation"
    : state.status === "error"
    ? state.message
    : "Start voice dictation. Your browser may process audio online."

  return (
    <>
      <Button
        aria-label={listening ? "Stop voice dictation" : "Start voice dictation"}
        aria-pressed={listening}
        className={cn(
          listening && "border-red-500/60 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400",
          state.status === "error" && "text-destructive",
        )}
        data-dictation-state={state.status}
        disabled={disabled}
        onClick={listening ? stop : start}
        size="icon-sm"
        title={title}
        type="button"
        variant="outline"
      >
        {state.status === "error" ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {listening ? "Voice dictation is listening." : state.status === "error" ? state.message : ""}
      </span>
    </>
  )
}
