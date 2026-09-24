import { useCallback, useEffect, useRef, useState } from "react"

import { formatApiError } from "@/api/errors"
import type { AgentDetail, AgentRecentMessages, Message, MsgrApi } from "@/api/types"
import type { AppController } from "@/hooks/use-app-controller"
import { useLiveMessages } from "@/hooks/use-live-messages"
import { directChannelForAgent } from "@/commands/search"
import { sendCommandMessage, type CommandFailure } from "@/commands/execute"
import { commandDraftKey, type CommandDraftTarget } from "@/commands/drafts"
import { useCommandDrafts } from "@/hooks/use-command-drafts"
import { readAgentActivity } from "@/agent-activity"

export type AgentRecordState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; detail: AgentDetail; refresh: AgentRefreshState }>
  | Readonly<{ status: "error"; message: string }>
export type AgentRefreshState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "loading" }> | Readonly<{ kind: "failed"; message: string }>
export type AgentActivityState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; messages: readonly Message[] }>
  | Readonly<{ status: "error"; message: string }>
export type AgentSendState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{ kind: "sent" }>
  | Readonly<{ kind: "failed"; failure: CommandFailure }>

export function useAgentRecord(api: MsgrApi, handle: string, metadataRevision: number) {
  const [state, setState] = useState<AgentRecordState>({ status: "loading" })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setState((current) =>
      current.status === "ready" ? { ...current, refresh: { kind: "loading" } } : { status: "loading" },
    )
    void api.getAgentDetail(handle).then((result) => {
      if (!active) return
      result.match({
        ok: (detail) => setState({ status: "ready", detail, refresh: { kind: "idle" } }),
        err: (error) => {
          const message = formatApiError(error)
          setState((current) =>
            current.status === "ready"
              ? { ...current, refresh: { kind: "failed", message } }
              : { status: "error", message },
          )
        },
      })
    })
    return () => {
      active = false
    }
  }, [api, handle, revision, metadataRevision])
  const reload = useCallback(() => setRevision((current) => current + 1), [])
  return { state, reload }
}

export function useAgentActivity(
  api: MsgrApi,
  references: readonly AgentRecentMessages[],
  active: boolean,
): AgentActivityState {
  const [state, setState] = useState<AgentActivityState>({ status: "loading" })
  useEffect(() => {
    if (!active) return
    let current = true
    setState({ status: "loading" })
    void readAgentActivity(api, references).then((result) => {
      if (!current) return
      result.match({
        ok: (messages) => setState({ status: "ready", messages }),
        err: (error) => setState({ status: "error", message: formatApiError(error) }),
      })
    })
    return () => {
      current = false
    }
  }, [active, api, references])
  return state
}

/** Uses the exact single-agent audience. Messages stream through the shared SSE
 * client. Drafts stay intact on failure; uncertain sends cannot be repeated.
 */
export function useAgentConversation(controller: AppController, handle: string) {
  const known = directChannelForAgent(controller.directConversations, handle)
  const [created, setCreated] = useState<ReturnType<typeof directChannelForAgent>>({ kind: "not-started" })
  const channel = created.kind === "existing" ? created.channel : known.kind === "existing" ? known.channel : undefined
  const { store, drafts } = useCommandDrafts()
  const target: CommandDraftTarget = { kind: "message", recipient: { kind: "agent", handle, routeState: "active" } }
  const key = commandDraftKey(target)
  const draft = drafts.get(key)?.body ?? ""
  const delivery = drafts.get(key)?.delivery ?? "editable"
  const [state, setState] = useState<AgentSendState>({ kind: "idle" })
  const [revision, setRevision] = useState(0)
  const pending = useRef(false)
  const live = useLiveMessages(controller.api, undefined, channel, revision)
  async function send(): Promise<void> {
    if (controller.identity === null || pending.current || delivery !== "editable") return
    const started = store.start(key)
    if (started.isErr()) {
      setState({ kind: "failed", failure: { kind: "not-completed", message: started.error.message } })
      return
    }
    pending.current = true
    setState({ kind: "sending" })
    const result = await sendCommandMessage(
      controller.api,
      { kind: "agent", handle, routeState: "active" },
      started.value.body,
    )
    pending.current = false
    result.match({
      ok: ({ destination }) => {
        if (destination.kind !== "conversation")
          throw new Error("Agent message returned a non-conversation destination")
        setCreated({ kind: "existing", channel: destination.channel })
        store.complete(key)
        setState({ kind: "sent" })
        setRevision((value) => value + 1)
        controller.reload()
      },
      err: (failure) => {
        store.settle(key, failure.kind === "outcome-unknown" ? "uncertain" : "editable")
        setState(failure.kind === "outcome-unknown" ? { kind: "idle" } : { kind: "failed", failure })
      },
    })
  }
  const setDraft = (body: string) => {
    const result = store.write(target, body)
    if (result.isErr()) setState({ kind: "failed", failure: { kind: "not-completed", message: result.error.message } })
    else setState({ kind: "idle" })
  }
  const allowAnotherSend = () => {
    store.settle(key, "editable")
    setState({ kind: "idle" })
  }
  const shownState: AgentSendState =
    delivery === "sending"
      ? { kind: "sending" }
      : delivery === "uncertain"
        ? {
            kind: "failed",
            failure: {
              kind: "outcome-unknown",
              message: "The last send was not confirmed. Check the conversation before sending again.",
            },
          }
        : state
  return {
    channel,
    draft,
    setDraft,
    state: shownState,
    send,
    live,
    allowAnotherSend,
    retry: () => setRevision((value) => value + 1),
  }
}
