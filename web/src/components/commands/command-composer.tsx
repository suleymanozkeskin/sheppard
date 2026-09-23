import { useRef, useState, type ReactNode, type RefObject } from "react"
import { browserCommandModifier } from "@/commands/keyboard"
import { ArrowUp, LoaderCircle, MessageCircle, SquareTerminal } from "lucide-react"

import type { MsgrApi } from "@/api/types"
import { commandDraftKey, type CommandDraftTarget, type CommandDraft } from "@/commands/drafts"
import { useCommandDrafts } from "@/hooks/use-command-drafts"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { DictationButton } from "@/components/dictation-button"
import { useComposerAutosize } from "@/hooks/use-composer-autosize"
import { COMMAND_MESSAGE_LIMIT, messageTargetLabel } from "@/commands/types"
import {
  messageDestination,
  promptCommandAgent,
  sendCommandMessage,
  type CommandFailure,
  type CommandSuccess,
} from "@/commands/execute"
import { shellRoutePath } from "@/shell-routing"

type SendState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "sending" }> | Readonly<{ kind: "failed"; failure: CommandFailure }>

function audienceCopy(target: CommandDraftTarget): ReactNode {
  if (target.kind === "terminal")
    return <>Types into this agent’s terminal and presses Enter. This is not a Sheppard message.</>
  switch (target.recipient.kind) {
    case "agent":
      return target.recipient.routeState === "stale" ? (
        <>Chat is currently unavailable. Your message will remain stored for this agent to read after it reconnects.</>
      ) : (
        <>Only this agent receives the message. It stays in Sheppard until the agent reads it.</>
      )
    case "channel":
      return <>All members of this channel can read the message.</>
    case "direct":
      return (
        <>
          Everyone in this conversation can read the message: <strong>{target.recipient.label}</strong>.
        </>
      )
    case "broadcast":
      return (
        <>
          Sends to agents currently connected in this workspace. Current recipients:{" "}
          <strong>{target.recipient.recipients.length === 0 ? "none" : target.recipient.recipients.join(", ")}</strong>.
        </>
      )
  }
}

interface CommandComposerProps {
  api: MsgrApi
  target: CommandDraftTarget
  body: string
  onBodyChange: (body: string) => void
  onSuccess: (success: CommandSuccess) => void
  delivery: CommandDraft["delivery"]
  onDeliveryChange: (delivery: "editable" | "uncertain") => void
  onPending: (pending: boolean) => void
  canWrite: boolean
}

function useCommandSend({
  api,
  target,
  onSuccess,
  delivery,
  onDeliveryChange,
  onPending,
  canWrite,
}: CommandComposerProps) {
  const [state, setState] = useState<SendState>({ kind: "idle" })
  const { store } = useCommandDrafts()
  const sendingRef = useRef(false)
  const uncertain = delivery === "uncertain"
  const busy = state.kind === "sending" || delivery === "sending"
  const send = async () => {
    if (!canWrite || sendingRef.current || uncertain || delivery === "sending") return
    const started = store.start(commandDraftKey(target))
    if (started.isErr()) {
      setState({ kind: "failed", failure: { kind: "not-completed", message: started.error.message } })
      return
    }
    sendingRef.current = true
    onPending(true)
    setState({ kind: "sending" })
    const result =
      target.kind === "terminal"
        ? await promptCommandAgent(api, target.handle, started.value.body)
        : await sendCommandMessage(api, target.recipient, started.value.body)
    sendingRef.current = false
    onPending(false)
    result.match({
      ok: onSuccess,
      err: (failure) => {
        onDeliveryChange(failure.kind === "outcome-unknown" ? "uncertain" : "editable")
        setState({ kind: "failed", failure })
      },
    })
  }
  return { state, setState, busy, uncertain, send }
}

export function CommandComposer(props: CommandComposerProps) {
  const { target, body, onBodyChange, onDeliveryChange, canWrite } = props
  const sender = useCommandSend(props)
  const { state, setState, busy, uncertain, send } = sender
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useComposerAutosize(inputRef, body)
  const label = target.kind === "terminal" ? target.handle : messageTargetLabel(target.recipient)
  return (
    <form
      className="command-compose"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <CommandAudience target={target} label={label} />
      <label className="sr-only" htmlFor="command-message">
        {target.kind === "terminal" ? "Terminal input" : `Message ${label}`}
      </label>
      <textarea
        autoComplete="off"
        data-command-autofocus
        disabled={busy || !canWrite}
        id="command-message"
        maxLength={COMMAND_MESSAGE_LIMIT}
        name="command-message"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.stopPropagation()
            void send()
          }
        }}
        placeholder={target.kind === "terminal" ? "Type terminal input…" : "Write your message…"}
        ref={inputRef}
        rows={5}
        value={body}
      />
      {!canWrite && (
        <p className="command-error" role="alert">
          Your session is not connected. Reload Sheppard to send.
        </p>
      )}
      <CommandSendFeedback
        state={state}
        uncertain={uncertain}
        target={target}
        onAllow={() => {
          onDeliveryChange("editable")
          setState({ kind: "idle" })
        }}
      />
      <CommandSendFooter {...props} inputRef={inputRef} busy={busy} uncertain={uncertain} />
    </form>
  )
}

function CommandAudience({ target, label }: { target: CommandDraftTarget; label: string }) {
  return (
    <>
      <div className="command-compose-heading">
        <span className="command-compose-mark">
          {target.kind === "terminal" ? <SquareTerminal aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
        </span>
        <div>
          <p>{target.kind === "terminal" ? "Prompt terminal" : "New message"}</p>
          <h2>{label}</h2>
        </div>
      </div>
      <p className="command-audience">{audienceCopy(target)}</p>
    </>
  )
}

function CommandSendFeedback({
  state,
  uncertain,
  target,
  onAllow,
}: {
  state: SendState
  uncertain: boolean
  target: CommandDraftTarget
  onAllow: () => void
}) {
  return (
    <>
      {(state.kind === "failed" || uncertain) && (
        <div className="command-error" role="alert">
          <p>
            {state.kind === "failed"
              ? state.failure.message
              : "The last send was not confirmed. Check the target before sending again."}
          </p>
          {uncertain && (
            <div className="flex flex-wrap gap-2">
              <a
                className={buttonVariants({ size: "sm", variant: "outline" })}
                href={shellRoutePath(
                  target.kind === "terminal"
                    ? { kind: "agent", handle: target.handle }
                    : messageDestination(target.recipient),
                )}
                rel="noreferrer"
                target="_blank"
              >
                Check target in a new tab
              </a>
              <Button onClick={onAllow} size="sm" type="button" variant="outline">
                I checked; allow another send
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function CommandSendFooter({
  target,
  body,
  canWrite,
  onBodyChange,
  inputRef,
  busy,
  uncertain,
}: CommandComposerProps & { inputRef: RefObject<HTMLTextAreaElement | null>; busy: boolean; uncertain: boolean }) {
  return (
    <div className="command-compose-footer">
      <DictationButton disabled={!canWrite || busy} inputRef={inputRef} onChange={onBodyChange} value={body} />
      <span>Your draft stays here when you close.</span>
      <Button disabled={!canWrite || busy || uncertain} type="submit">
        {busy ? (
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        ) : (
          <ArrowUp aria-hidden="true" />
        )}{" "}
        {busy ? "Sending…" : target.kind === "terminal" ? "Send to terminal" : "Send message"}
        <kbd>{browserCommandModifier()} ↵</kbd>
      </Button>
    </div>
  )
}
