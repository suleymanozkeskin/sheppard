import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Bot, ChevronDown, ChevronRight, ExternalLink, Focus, MessageCircle, MessageCirclePlus, Send, SquareTerminal, StopCircle, Wrench } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { apiCall } from "@/api/runtime"
import { formatApiError } from "@/api/errors"
import type { AgentDetail, AgentSession, DirectConversation, HerdrPaneView, HerdrTabView, HerdrWorkspaceView, Message, SessionState, SessionTurn, SessionCandidate } from "@/api/types"
import { Button } from "@/components/ui/button"
import { AgentStatusMark } from "@/components/agent-status-mark"
import { DictationButton } from "@/components/dictation-button"
import type { AppController } from "@/hooks/use-app-controller"
import { useComposerAutosize } from "@/hooks/use-composer-autosize"
import { useComposerFocusTarget } from "@/hooks/use-composer-focus"
import { absoluteTimeLabel, paneIdentity, paneStatusLabel, relativeAgeLabel, workspaceLabel as formatWorkspaceLabel } from "@/workspace-presentation"
import type { ShellRoute, ShellRouter } from "@/shell-routing"

interface AgentEntry {
  identity: string
  pane: HerdrPaneView
  workspace: HerdrWorkspaceView
}

const statusPriority = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  unknown: 4,
} satisfies Record<HerdrPaneView["agentStatus"], number>

function collectAgents(workspaces: readonly HerdrWorkspaceView[]): AgentEntry[] {
  return workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) =>
    pane.agentKind === null ? [] : [{ identity: paneIdentity(pane, workspace), pane, workspace }],
  )).toSorted((left, right) =>
    statusPriority[left.pane.agentStatus] - statusPriority[right.pane.agentStatus]
      || left.identity.localeCompare(right.identity)
      || left.pane.paneId.localeCompare(right.pane.paneId),
  )
}

function directForAgent(conversations: readonly DirectConversation[], handle: string): DirectConversation | undefined {
  return conversations.find((conversation) => conversation.participants.includes(handle))
}

type AgentDetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: AgentDetail }

type RecentMessagesState =
  | { status: "loading" }
  | { status: "ready"; messages: Message[] }
  | { status: "error"; message: string }

function AgentMeta({ entry }: { entry: AgentEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{formatWorkspaceLabel(entry.workspace)}</span>
      <span>pane {entry.pane.paneId}</span>
      {entry.pane.role !== undefined && entry.pane.role !== null && <span data-agent-role={entry.pane.role}>role {entry.pane.role}</span>}
    </div>
  )
}

function AgentEntryCard({ entry, onConnect, onMessage, onOpen, onOpenWorkspace }: { entry: AgentEntry; onConnect: () => void; onMessage: () => void; onOpen: () => void; onOpenWorkspace: () => void }) {
  const linked = entry.pane.participant !== null
  const routeState = entry.pane.participantRouteState
  return (
    <li className="overflow-hidden rounded-xl border bg-card transition-colors hover:bg-muted/40" data-agent-row={entry.identity}>
      <button aria-label={linked ? `Open agent ${entry.identity}` : `Connect ${entry.identity} to Sheppard chat`} className="flex min-h-16 w-full min-w-0 items-center gap-3 px-4 py-3 text-left" onClick={onOpen} type="button">
        <AgentStatusMark size={20} status={entry.pane.agentStatus} />
        <span className="min-w-0 flex-1" data-agent-identity>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate font-medium">{entry.identity}</span>
            <span className="text-sm text-muted-foreground">{entry.pane.agentKind}</span>
          </span>
          <AgentMeta entry={entry} />
        </span>
        <span className="shrink-0 text-right text-xs">
          <span className="block font-medium capitalize text-foreground">{paneStatusLabel(entry.pane)}</span>
          <span className="mt-1 block text-muted-foreground">
            {linked ? routeState === "active" ? "Chat connected" : "Chat unavailable" : "Not connected"}
          </span>
        </span>
        {linked
          ? <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          : <SquareTerminal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      <div className="flex items-center justify-end gap-1 border-t px-3 py-1.5">
        {linked
          ? <Button onClick={onMessage} size="sm" type="button" variant="ghost"><MessageCircle aria-hidden="true" />Message</Button>
          : <Button onClick={onConnect} size="sm" type="button" variant="ghost"><MessageCirclePlus aria-hidden="true" />Connect to chat</Button>}
        <Button onClick={onOpenWorkspace} size="sm" type="button" variant="ghost">Workspace</Button>
      </div>
    </li>
  )
}

export function AgentsDirectoryPage({ controller, navigate }: { controller: AppController; navigate: ShellRouter["navigate"] }) {
  const agents = useMemo(() => collectAgents(controller.workspaceData.settledWorkspaces), [controller.workspaceData.settledWorkspaces])
  return (
    <div className="w-full space-y-5 p-4 sm:p-6" data-directory="agents">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Herdr pane status and chat link state are shown separately.</p>
        <Button onClick={() => navigate({ kind: "launchers" })} size="sm" type="button" variant="ghost">Manage launchers</Button>
      </div>

      {controller.workspaceData.workspaceState.status === "loading" && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" role="status">Loading agents…</p>}
      {controller.workspaceData.workspaceState.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{controller.workspaceData.workspaceState.message}</p>}
      {controller.workspaceData.workspaceState.status === "ready" && agents.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Bot aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">Herdr reports no agent panes.</p>
        </div>
      )}
      {controller.workspaceData.workspaceState.status === "ready" && agents.length > 0 && (
        <ul aria-label="Agent directory" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" role="list">
          {agents.map((entry) => (
            <AgentEntryCard
              entry={entry}
              key={`${entry.workspace.id}:${entry.pane.paneId}`}
              onConnect={() => controller.openConnectPane(entry.pane, entry.identity)}
              onMessage={() => { if (entry.pane.participant !== null) controller.startDirect(entry.pane.participant) }}
              onOpen={() => entry.pane.participant === null
                ? controller.openConnectPane(entry.pane, entry.identity)
                : navigate({ handle: entry.pane.participant, kind: "agent" })}
              onOpenWorkspace={() => navigate({ kind: "workspace", workspaceId: entry.workspace.id })}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function agentChannelLabel(channel: string, controller: AppController): string {
  const direct = controller.directConversations.find((conversation) => conversation.channel === channel)
  if (direct !== undefined) return `Direct with ${direct.participants.join(", ")}`
  const workspaceId = [...controller.workspaceData.workspaceChannelsById.entries()]
    .find(([, channelName]) => channelName === channel)?.[0]
  if (workspaceId !== undefined) {
    const workspace = controller.workspaceData.settledWorkspaces.find((candidate) => candidate.id === workspaceId)
    if (workspace !== undefined) return `Workspace · ${formatWorkspaceLabel(workspace)}`
  }
  if (channel.startsWith("dm-")) return "Direct conversation"
  if (channel.startsWith("ws-")) return "Workspace broadcast"
  return `#${channel}`
}

function RecentMessages({ controller, messages, onOpen }: { controller: AppController; messages: readonly Message[]; onOpen: (message: Message) => void }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No recent messages from this agent are recorded.</p>
  }
  return (
    <ul aria-label="Recent activity" className="space-y-2">
      {messages.map((message) => (
        <li key={message.id}>
          <button className="w-full rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted" data-agent-activity={message.id} data-agent-message-row={message.id} onClick={() => onOpen(message)} type="button">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{message.sender}</span>
              <time dateTime={message.createdAt} title={absoluteTimeLabel(message.createdAt)}>{relativeAgeLabel(message.createdAt)}</time>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{agentChannelLabel(message.channel, controller)}</p>
            <p className="mt-1 line-clamp-2 text-sm">{message.body}</p>
          </button>
        </li>
      ))}
    </ul>
  )
}

type ConversationState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; channel: string; messages: Message[] }
  | { status: "error"; message: string }

type ActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

function findWorkspaceForPane(workspaces: readonly HerdrWorkspaceView[], paneId: string | undefined): HerdrWorkspaceView | undefined {
  if (paneId === undefined) return undefined
  return workspaces.find((workspace) => workspace.panes.some((pane) => pane.paneId === paneId))
}

function findTabForPane(workspace: HerdrWorkspaceView | undefined, paneId: string | undefined): HerdrTabView | undefined {
  if (workspace === undefined || paneId === undefined) return undefined
  return workspace.tabs.find((tab) => tab.panes.some((pane) => pane.paneId === paneId))
}

function channelHref(channel: string, controller: AppController): string {
  if (controller.directConversations.some((conversation) => conversation.channel === channel)) {
    return `/direct/${encodeURIComponent(channel)}`
  }
  const workspaceId = [...controller.workspaceData.workspaceChannelsById.entries()].find(([, name]) => name === channel)?.[0]
  if (workspaceId !== undefined) {
    return `/workspaces/${encodeURIComponent(workspaceId)}`
  }
  return `/channels/${encodeURIComponent(channel)}`
}

function ConversationMessages({ messages }: { messages: readonly Message[] }) {
  if (messages.length === 0) {
    return <p className="px-1 py-8 text-center text-sm text-muted-foreground">No messages yet.</p>
  }
  return (
    <ul aria-label="Embedded messages" className="space-y-3" role="list">
      {messages.map((message) => (
        <li className="rounded-lg border bg-card px-3 py-2" data-agent-conversation-message={message.id} key={message.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">{message.sender}</span>
            <time className="text-muted-foreground" dateTime={message.createdAt} title={absoluteTimeLabel(message.createdAt)}>{relativeAgeLabel(message.createdAt)}</time>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{message.body}</p>
        </li>
      ))}
    </ul>
  )
}

type SessionPanelState =
  | { status: "loading" }
  | { status: "ready"; session: AgentSession }
  | { status: "error"; message: string }

type SessionSelectionState =
  | { status: "idle" }
  | { status: "working"; sessionId: string }
  | { status: "error"; message: string }

interface SessionSelectionIdentity {
  handle: string
  paneId: string | null
}

/** What each non-ready state means, in the panel's own words. */
const sessionStateCopy = {
  absent: "This harness has written no session for this working directory.",
  ambiguous: "More than one session matches this pane. None was chosen.",
  unsupported: "No session reader exists for this harness yet.",
  error: "The session could not be read.",
} satisfies Record<Exclude<SessionState, "ready">, string>

function SessionToolLine({ turn }: { turn: SessionTurn }) {
  const [open, setOpen] = useState(false)
  const name = turn.tool?.name ?? "tool"
  const failed = turn.tool?.outcome === "error"
  return (
    <li data-session-tool={name}>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? <ChevronDown aria-hidden="true" className="size-3 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-3 shrink-0" />}
        <Wrench aria-hidden="true" className="size-3 shrink-0" />
        <span className={failed ? "font-medium text-destructive" : "font-medium text-foreground"}>{name}</span>
        <span className="min-w-0 flex-1 truncate">{turn.text}</span>
      </button>
      {open && <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-xs whitespace-pre-wrap" data-session-tool-body>{turn.text}</pre>}
    </li>
  )
}

function SessionTurnLine({ turn }: { turn: SessionTurn }) {
  const mine = turn.role === "user"
  return (
    <li className="rounded-lg border bg-card px-3 py-2" data-session-turn={turn.role ?? "unknown"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{mine ? "Operator" : "Agent"}</span>
        {turn.at !== null && <time className="text-muted-foreground" dateTime={turn.at} title={absoluteTimeLabel(turn.at)}>{relativeAgeLabel(turn.at)}</time>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{turn.text}</p>
    </li>
  )
}

function SessionCandidatePicker({ canSelect, candidates, onSelect, selectionState }: {
  canSelect: boolean
  candidates: SessionCandidate[]
  onSelect: (sessionId: string) => void
  selectionState: SessionSelectionState
}) {
  const selecting = selectionState.status === "working"
  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-3" data-session-picker>
      <p className="text-sm font-medium">Candidate sessions</p>
      <p className="mt-1 text-xs text-muted-foreground">Choose the session that belongs to this pane.</p>
      {selectionState.status === "working" && <p className="mt-2 text-sm text-muted-foreground" data-session-selection-state="working" role="status">Selecting session {selectionState.sessionId}…</p>}
      {selectionState.status === "error" && <p className="mt-2 text-sm text-destructive" data-session-selection-state="error" role="alert">{selectionState.message}</p>}
      <ol aria-label="Session candidates" className="mt-3 space-y-2" role="list">
        {candidates.map((candidate) => (
          <li className="rounded-md border bg-card p-3" data-session-candidate={candidate.sessionId} key={candidate.sessionId}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <code className="text-xs font-medium" data-session-candidate-id>{candidate.sessionId}</code>
              <span className="text-xs text-muted-foreground" data-session-candidate-size>{candidate.sizeBytes} bytes</span>
            </div>
            {candidate.startedAt !== null && <time className="mt-1 block text-xs text-muted-foreground" dateTime={candidate.startedAt} title={absoluteTimeLabel(candidate.startedAt)} data-session-candidate-started>{relativeAgeLabel(candidate.startedAt)}</time>}
            {candidate.cwd !== null && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" data-session-candidate-cwd title={candidate.cwd}>{candidate.cwd}</p>}
            {candidate.firstUserText !== null && <p className="mt-2 line-clamp-2 text-sm" data-session-candidate-prompt title={candidate.firstUserText}>{candidate.firstUserText}</p>}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" data-session-candidate-path title={candidate.path}>{candidate.path}</p>
              <Button
                aria-label={`Select session ${candidate.sessionId}`}
                data-session-select={candidate.sessionId}
                disabled={!canSelect || selecting}
                onClick={() => onSelect(candidate.sessionId)}
                size="sm"
                title={canSelect ? `Use session ${candidate.sessionId}` : NOT_CONNECTED_REASON}
                type="button"
                variant="outline"
              >
                {selectionState.status === "working" && selectionState.sessionId === candidate.sessionId ? "Selecting…" : "Select"}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function SessionPanel({ canSelect, onLoadOlder, onSelectSession, paneId, selectionState, state }: {
  canSelect: boolean
  onLoadOlder: () => void
  onSelectSession: (sessionId: string) => void
  paneId: string | null
  selectionState: SessionSelectionState
  state: SessionPanelState
}) {
  return (
    <section aria-labelledby="agent-session-heading" className="rounded-xl border p-5" data-agent-session={paneId ?? "none"}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" id="agent-session-heading">SESSION</h2>
        {state.status === "ready" && state.session.source.harness !== null && (
          <span className="text-xs text-muted-foreground">{state.session.source.harness}</span>
        )}
      </div>
      <div className="mt-4">
        {paneId === null && <p className="text-sm text-muted-foreground">This agent has no active pane, so it has no session to read.</p>}
        {paneId !== null && state.status === "loading" && <p className="text-sm text-muted-foreground" role="status">Loading session…</p>}
        {paneId !== null && state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
        {paneId !== null && state.status === "ready" && state.session.source.state !== "ready" && (
          // Each of these is a statement about what the hub knows. None of them
          // is rendered as an empty transcript.
          <>
            <p className="text-sm text-muted-foreground" data-session-state={state.session.source.state}>
              {sessionStateCopy[state.session.source.state]}
              {state.session.source.reason !== null && <span className="ml-1 text-xs">({state.session.source.reason})</span>}
            </p>
            {state.session.source.state === "ambiguous" && state.session.mapping !== null && state.session.mapping.candidates.length > 0 && (
              <SessionCandidatePicker
                canSelect={canSelect}
                candidates={state.session.mapping.candidates}
                onSelect={onSelectSession}
                selectionState={selectionState}
              />
            )}
          </>
        )}
        {paneId !== null && state.status === "ready" && state.session.source.state === "ready" && (
          <>
            {state.session.nextBefore !== null && (
              <Button className="mb-3" onClick={onLoadOlder} size="sm" type="button" variant="ghost">Load older turns</Button>
            )}
            <ul aria-label="Session transcript" className="space-y-2" role="list">
              {state.session.turns.map((turn, index) => (
                turn.kind === "tool"
                  ? <SessionToolLine key={`${index}-${turn.at ?? ""}`} turn={turn} />
                  : <SessionTurnLine key={`${index}-${turn.at ?? ""}`} turn={turn} />
              ))}
            </ul>
            {state.session.turns.length === 0 && <p className="px-1 py-8 text-center text-sm text-muted-foreground">This session has no turns yet.</p>}
          </>
        )}
      </div>
    </section>
  )
}

/**
 * The embedded conversation composer. It sends through the ordinary message
 * path, so the agent reads it on its own turn. The pane prompt is a different
 * surface with a different endpoint; see PromptPanel.
 */
function EmbeddedComposer({
  disabledReason,
  draft,
  onChange,
  onSend,
  sending,
  target,
}: {
  disabledReason: string | undefined
  draft: string
  onChange: (value: string) => void
  onSend: () => void
  sending: boolean
  target: string
}) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  useComposerAutosize(composerRef, draft)
  useComposerFocusTarget(composerRef)
  const blocked = disabledReason !== undefined
  return (
    <form
      className="mt-4 flex items-end gap-2 border-t pt-4"
      data-agent-composer={target}
      onSubmit={(event) => { event.preventDefault(); if (!blocked && !sending) onSend() }}
    >
      <label className="sr-only" htmlFor="agent-composer">Message {target}</label>
      <DictationButton disabled={blocked || sending} inputRef={composerRef} onChange={onChange} value={draft} />
      <textarea
        className="min-h-10 max-h-48 min-w-0 flex-1 resize-none overflow-y-hidden rounded-lg border bg-muted/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20 motion-safe:transition-[height] motion-safe:duration-150 motion-safe:ease-out"
        disabled={blocked}
        id="agent-composer"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          if (!blocked && !sending) onSend()
        }}
        placeholder={disabledReason ?? `Message ${target}`}
        ref={composerRef}
        rows={1}
        value={draft}
      />
      <Button disabled={blocked || sending || draft.trim().length === 0} type="submit">
        <Send aria-hidden="true" />
        Send
      </Button>
    </form>
  )
}

/**
 * Typing into the pane is not messaging. The panel names the pane and states
 * the difference before the operator acts, because the two are confusable and
 * only one of them interrupts.
 */
function PromptPanel({
  disabledReason,
  onClose,
  onSend,
  paneId,
  state,
}: {
  disabledReason: string | undefined
  onClose: () => void
  onSend: (text: string) => void
  paneId: string
  state: ActionState
}) {
  const [text, setText] = useState("")
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  useComposerAutosize(promptRef, text)
  const blocked = disabledReason !== undefined
  return (
    <section aria-labelledby="agent-prompt-heading" className="rounded-xl border bg-card p-5 shadow-sm" data-agent-prompt-panel={paneId}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" id="agent-prompt-heading">PROMPT PANE</h2>
        <Button onClick={onClose} size="sm" type="button" variant="ghost">Close</Button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground" data-agent-prompt-notice>
        Types directly into pane {paneId}. The agent sees it as terminal input, not as a message.
      </p>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => { event.preventDefault(); if (!blocked && state.status !== "working") onSend(text) }}
      >
        <label className="sr-only" htmlFor="agent-prompt-input">Prompt pane {paneId}</label>
        <textarea
          className="min-h-10 max-h-48 min-w-0 flex-1 resize-none overflow-y-hidden rounded-lg border bg-muted/30 px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
          disabled={blocked}
          id="agent-prompt-input"
          onChange={(event) => setText(event.target.value)}
          placeholder={disabledReason ?? "Terminal input"}
          ref={promptRef}
          rows={1}
          value={text}
        />
        <Button disabled={blocked || state.status === "working" || text.trim().length === 0} type="submit" variant="outline">
          <SquareTerminal aria-hidden="true" />
          Send to pane
        </Button>
      </form>
      {state.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{state.message}</p>}
    </section>
  )
}

export function AgentDetailPage({ controller, handle, navigate }: { controller: AppController; handle: string; navigate: ShellRouter["navigate"] }) {
  const [detailState, setDetailState] = useState<AgentDetailState>({ status: "loading" })
  const [recentMessagesState, setRecentMessagesState] = useState<RecentMessagesState>({ status: "loading" })
  const direct = directForAgent(controller.directConversations, handle)
  const directChannel = direct?.channel
  const directExists = direct !== undefined
  const [conversationChannel, setConversationChannel] = useState<string | undefined>(direct?.channel)
  const [conversationState, setConversationState] = useState<ConversationState>({ status: direct === undefined ? "empty" : "loading" })
  const [focusState, setFocusState] = useState<ActionState>({ status: "idle" })
  const [sessionState, setSessionState] = useState<SessionPanelState>({ status: "loading" })
  const [sessionSelectionState, setSessionSelectionState] = useState<SessionSelectionState>({ status: "idle" })
  const sessionSelectionStateRef = useRef<SessionSelectionState>({ status: "idle" })
  const sessionSelectionRequestRef = useRef(0)
  const [sessionBefore, setSessionBefore] = useState<number | undefined>(undefined)
  const [sessionReloadKey, setSessionReloadKey] = useState(0)
  const [draft, setDraft] = useState("")
  const [sendState, setSendState] = useState<ActionState>({ status: "idle" })
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptState, setPromptState] = useState<ActionState>({ status: "idle" })
  const { api, fallbackApi } = controller

  const sessionPaneId = detailState.status === "ready" && detailState.detail.participant.handle === handle
    ? detailState.detail.pane?.paneId ?? null
    : null
  const sessionSelectionIdentityRef = useRef<SessionSelectionIdentity>({ handle, paneId: sessionPaneId })

  useLayoutEffect(() => {
    sessionSelectionIdentityRef.current = { handle, paneId: sessionPaneId }
    sessionSelectionRequestRef.current += 1
    sessionSelectionStateRef.current = { status: "idle" }
  }, [handle, sessionPaneId])

  useEffect(() => {
    sessionSelectionStateRef.current = sessionSelectionState
  }, [sessionSelectionState])

  useEffect(() => {
    let mounted = true
    setDetailState({ status: "loading" })
    setRecentMessagesState({ status: "loading" })
    setSessionState({ status: "loading" })
    setSessionSelectionState({ status: "idle" })
    setSessionBefore(undefined)
    setSessionReloadKey(0)
    void apiCall(api, fallbackApi, (client) => client.getAgentDetail(handle)).then((result) => {
      if (!mounted) return
      result.match({
        ok: (detail) => {
          setDetailState({ detail, status: "ready" })
          if (detail.recentMessageIds.length === 0) {
            setRecentMessagesState({ messages: [], status: "ready" })
            return
          }
          void Promise.all(detail.recentMessageIds.map(async ({ channel, messageIds }) => {
            const messagesResult = await apiCall(api, fallbackApi, (client) => client.listMessages(channel))
            return messagesResult.match({
              ok: ({ messages }) => messages.filter((message) => messageIds.includes(message.id)),
              err: () => [],
            })
          })).then((groups) => {
            if (!mounted) return
            const messages = groups.flat().toSorted((left, right) => right.id - left.id).slice(0, 20)
            setRecentMessagesState({ messages, status: "ready" })
          })
        },
        err: (error) => setDetailState({ message: formatApiError(error), status: "error" }),
      })
    })
    return () => {
      mounted = false
    }
  }, [api, fallbackApi, handle])

  useEffect(() => {
    setConversationChannel(directChannel)
    setConversationState(directExists ? { status: "loading" } : { status: "empty" })
  }, [directChannel, directExists])

  useEffect(() => {
    if (sessionPaneId === null) return
    let mounted = true
    const requestHandle = handle
    const requestPaneId = sessionPaneId
    const requestId = sessionSelectionRequestRef.current
    const query = sessionBefore === undefined ? {} : { before: sessionBefore }
    void apiCall(api, fallbackApi, (client) => client.getAgentSession(sessionPaneId, query)).then((result) => {
      if (!mounted
        || requestId !== sessionSelectionRequestRef.current
        || sessionSelectionIdentityRef.current.handle !== requestHandle
        || sessionSelectionIdentityRef.current.paneId !== requestPaneId) return
      result.match({
        // A page fetched with `before` is older than what is on screen, so it is
        // placed in front of it. The glance stays the newest one.
        ok: (session) => {
          sessionSelectionStateRef.current = { status: "idle" }
          setSessionSelectionState({ status: "idle" })
          setSessionState((current) => sessionBefore === undefined || current.status !== "ready"
            ? { session, status: "ready" }
            : {
              session: {
                turns: [...session.turns, ...current.session.turns],
                nextBefore: session.nextBefore,
                source: current.session.source,
                mapping: current.session.mapping,
              },
              status: "ready",
            })
        },
        err: (error) => {
          const message = formatApiError(error)
          if (sessionSelectionStateRef.current.status === "working") {
            const errorState: SessionSelectionState = { message, status: "error" }
            sessionSelectionStateRef.current = errorState
            setSessionSelectionState(errorState)
            return
          }
          setSessionState({ message, status: "error" })
        },
      })
    })
    return () => {
      mounted = false
    }
  }, [api, fallbackApi, handle, sessionBefore, sessionPaneId, sessionReloadKey])

  useEffect(() => {
    const channel = conversationChannel
    if (channel === undefined) return
    let mounted = true
    void apiCall(api, fallbackApi, (client) => client.listMessages(channel)).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ messages }) => setConversationState({ channel, messages, status: "ready" }),
        err: (error) => setConversationState({ message: formatApiError(error), status: "error" }),
      })
    })
    return () => {
      mounted = false
    }
  }, [api, conversationChannel, fallbackApi])

  if (detailState.status === "loading") {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl items-center justify-center p-6">
        <p className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground" role="status">Loading agent details…</p>
      </div>
    )
  }

  if (detailState.status === "error") {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center p-6 text-center">
        <Bot aria-hidden="true" className="size-8 text-muted-foreground" />
        <h2 className="mt-4 text-base font-semibold">Agent details unavailable</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{detailState.message}</p>
      </div>
    )
  }

  const detail = detailState.detail
  const pane = detail.pane
  const hasPane = pane !== null
  const workspace = findWorkspaceForPane(controller.workspaceData.settledWorkspaces, pane?.paneId)
  const tab = findTabForPane(workspace, pane?.paneId)
  const paneTitle = pane?.title ?? pane?.label ?? "No terminal title reported."
  const workspaceHref = workspace === undefined ? undefined : `/workspaces/${encodeURIComponent(workspace.id)}`
  const lastSeen = detail.participant.lastSeenAt === null ? "not reported" : relativeAgeLabel(detail.participant.lastSeenAt)

  const openRecentMessage = (message: Message) => {
    const directConversation = controller.directConversations.find((conversation) => conversation.channel === message.channel)
    const workspaceKind = [...controller.workspaceData.workspaceChannelsById.values()].includes(message.channel)
    controller.selectChannel(message.channel, directConversation === undefined ? workspaceKind ? "workspace" : "chat" : "direct")
    controller.setFocusedMessageId(message.id)
    if (directConversation !== undefined) {
      navigate({ channel: message.channel, kind: "conversation", messageId: message.id })
      return
    }
    const route: Extract<ShellRoute, { kind: "channel" }> = {
      channel: message.channel,
      kind: "channel",
      messageId: message.id,
    }
    if (workspaceKind) route.channelKind = "workspace"
    navigate(route)
  }

  const openDirect = () => {
    if (direct === undefined) {
      controller.startDirect(handle)
      return
    }
    controller.selectChannel(direct.channel, "direct")
    controller.setFocusedMessageId(undefined)
    navigate({ channel: direct.channel, kind: "conversation" })
  }

  const selectSession = (sessionId: string) => {
    if (sessionPaneId === null || controller.identity === null || sessionSelectionStateRef.current.status === "working") return
    const requestId = sessionSelectionRequestRef.current + 1
    sessionSelectionRequestRef.current = requestId
    const requestHandle = handle
    const requestPaneId = sessionPaneId
    const nextState: SessionSelectionState = { sessionId, status: "working" }
    sessionSelectionStateRef.current = nextState
    setSessionSelectionState(nextState)
    void apiCall(api, fallbackApi, (client) => client.selectAgentSession(requestPaneId, { sessionId })).then((result) => {
      if (requestId !== sessionSelectionRequestRef.current
        || sessionSelectionIdentityRef.current.handle !== requestHandle
        || sessionSelectionIdentityRef.current.paneId !== requestPaneId) return
      result.match({
        ok: () => {
          setSessionBefore(undefined)
          setSessionReloadKey((current) => current + 1)
        },
        err: (error) => {
          const errorState: SessionSelectionState = { message: formatApiError(error), status: "error" }
          sessionSelectionStateRef.current = errorState
          setSessionSelectionState(errorState)
        },
      })
    })
  }

  const focusPane = () => {
    if (controller.identity === null || tab === undefined) return
    setFocusState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.focusTab(tab.id)).then((result) => result.match({
      ok: () => {
        setFocusState({ status: "idle" })
        controller.workspaceData.reloadWorkspaces()
      },
      err: (error) => setFocusState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const reloadConversation = (channel: string) => {
    void apiCall(api, fallbackApi, (client) => client.listMessages(channel)).then((result) => result.match({
      ok: ({ messages }) => setConversationState({ channel, messages, status: "ready" }),
      err: (error) => setConversationState({ message: formatApiError(error), status: "error" }),
    }))
  }

  // The message path, not the pane path: this send reaches the agent as unread.
  const sendMessage = () => {
    const body = draft.trim()
    if (body.length === 0 || controller.identity === null) return
    setSendState({ status: "working" })
    const channel = conversationChannel
    const sent = channel === undefined
      ? apiCall(api, fallbackApi, (client) => client.createDirect({ body, to: [handle] })).then((result) => result.map(({ channel: created }) => created))
      : apiCall(api, fallbackApi, (client) => client.sendMessage(channel, { body })).then((result) => result.map(() => channel))
    void sent.then((result) => result.match({
      ok: (target) => {
        setDraft("")
        setSendState({ status: "idle" })
        setConversationChannel(target)
        reloadConversation(target)
      },
      err: (error) => setSendState({ message: formatApiError(error), status: "error" }),
    }))
  }

  // The pane path: this types into the terminal and interrupts.
  const sendPrompt = (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || pane === null || controller.identity === null) return
    setPromptState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.promptAgent(pane.paneId, { text: trimmed })).then((result) => result.match({
      ok: () => {
        setPromptState({ status: "idle" })
        setPromptOpen(false)
      },
      err: (error) => setPromptState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const openMembership = (channel: string) => {
    const directConversation = controller.directConversations.find((conversation) => conversation.channel === channel)
    if (directConversation !== undefined) {
      navigate({ channel, kind: "conversation" })
      return
    }
    const workspaceId = [...controller.workspaceData.workspaceChannelsById.entries()].find(([, name]) => name === channel)?.[0]
    if (workspaceId !== undefined) {
      navigate({ kind: "workspace", workspaceId })
      return
    }
    navigate({ channel, kind: "channel" })
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6" data-agent-row={detail.participant.handle} data-agent-view={detail.participant.handle}>
      <section className="rounded-xl border bg-card p-5 shadow-sm" data-agent-header>
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-1 items-start gap-4" data-agent-identity-block>
            <AgentStatusMark size={64} status={pane?.agentStatus ?? "unknown"} />
            <div className="min-w-0 flex-1" data-agent-identity>
              <h2 className="truncate text-xl font-semibold">{detail.participant.handle}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" data-agent-identity-facts>
                <span>{detail.participant.agentKind ?? "unknown kind"}</span>
                {detail.participant.role !== undefined && detail.participant.role !== null && <span data-agent-role={detail.participant.role}>role {detail.participant.role}</span>}
                {workspace === undefined
                  ? <span>not attached to a workspace</span>
                  : <a className="rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={workspaceHref} onClick={(event) => { event.preventDefault(); navigate({ kind: "workspace", workspaceId: workspace.id }) }}>{formatWorkspaceLabel(workspace)}</a>}
                <span>{pane === null ? "No Herdr pane" : <code className="font-mono text-xs">pane {pane.paneId}</code>}</span>
                <span className={hasPane ? undefined : "text-amber-700 dark:text-amber-300"}>{hasPane ? `Herdr: ${paneStatusLabel(pane)}` : "Not running in Herdr"}</span>
                <span>Chat route {detail.routeState === "active" ? "active" : "inactive"}</span>
                <span>seen {lastSeen}</span>
              </div>
              {!hasPane && <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">This chat identity has no current Herdr pane. Messages stay stored until a new agent uses this handle.</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={controller.identity === null} onClick={openDirect} title={controller.identity === null ? NOT_CONNECTED_REASON : `Open a direct conversation with ${handle}`} type="button">
              <MessageCircle aria-hidden="true" />
              Message
            </Button>
            <Button disabled={controller.identity === null || pane === null} onClick={() => setPromptOpen((open) => !open)} title={controller.identity === null ? NOT_CONNECTED_REASON : pane === null ? "This agent has no active pane" : `Type into pane ${pane.paneId}`} type="button" variant="outline">
              <SquareTerminal aria-hidden="true" />
              Prompt pane
            </Button>
            <Button disabled={controller.identity === null || tab === undefined || focusState.status === "working"} onClick={focusPane} title={controller.identity === null ? NOT_CONNECTED_REASON : tab === undefined ? "This pane is not in a reported tab" : `Focus tab ${tab.label ?? tab.id}`} type="button" variant="outline">
              <Focus aria-hidden="true" />
              Focus pane
            </Button>
            <Button disabled={controller.identity === null || pane === null} onClick={() => { if (pane !== null) controller.openStopAgent(pane) }} title={controller.identity === null ? NOT_CONNECTED_REASON : pane === null ? "This agent has no active pane" : "Stop agent"} type="button" variant="outline">
              <StopCircle aria-hidden="true" />
              Stop
            </Button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 border-t pt-3 text-sm" data-pane-title={paneTitle}>
          <SquareTerminal aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{paneTitle}</span>
          {sessionState.status === "ready" && sessionState.session.source.glance !== null && (
            <span className="max-w-[50%] min-w-0 truncate text-muted-foreground" data-agent-glance title={sessionState.session.source.glance}>{sessionState.session.source.glance}</span>
          )}
          {pane?.focused === true && <span className="shrink-0 text-xs text-primary">focused</span>}
        </div>
        {focusState.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{focusState.message}</p>}
      </section>

      {/* The prompt panel sits next to the control that opened it, above the
          session it will change. */}
      {promptOpen && pane !== null && (
        <PromptPanel
          disabledReason={controller.identity === null ? NOT_CONNECTED_REASON : undefined}
          onClose={() => setPromptOpen(false)}
          onSend={sendPrompt}
          paneId={pane.paneId}
          state={promptState}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <section aria-labelledby="agent-conversation-heading" className="rounded-xl border p-5" data-agent-conversation={conversationChannel ?? "none"}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold" id="agent-conversation-heading">CONVERSATION</h2>
            {direct?.lastMessageAt !== undefined && direct.lastMessageAt !== null && <span className="text-xs text-muted-foreground">Last activity {relativeAgeLabel(direct.lastMessageAt)}</span>}
          </div>
          <div className="mt-4">
            {conversationState.status === "loading" && <p className="text-sm text-muted-foreground" role="status">Loading conversation…</p>}
            {conversationState.status === "error" && <p className="text-sm text-destructive" role="alert">{conversationState.message}</p>}
            {conversationState.status === "empty" && <p className="px-1 py-8 text-center text-sm text-muted-foreground">No existing conversation.</p>}
            {conversationState.status === "ready" && <ConversationMessages messages={conversationState.messages} />}
          </div>
          <EmbeddedComposer
            disabledReason={controller.identity === null ? NOT_CONNECTED_REASON : undefined}
            draft={draft}
            onChange={setDraft}
            onSend={sendMessage}
            sending={sendState.status === "working"}
            target={detail.participant.handle}
          />
          {sendState.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{sendState.message}</p>}
        </section>

        <aside className="space-y-5">
          <section aria-labelledby="agent-memberships-heading" className="rounded-xl border p-5">
            <h2 className="text-sm font-semibold" id="agent-memberships-heading">BELONGS TO</h2>
            {detail.channels === undefined || detail.channels.length === 0
              ? <p className="mt-4 text-sm text-muted-foreground">No channel memberships are reported.</p>
              : <ul className="mt-4 space-y-2" role="list">{detail.channels.map(({ channel, unread }) => (
                <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2" data-agent-channel={channel} key={channel}>
                  <a className="min-w-0 truncate text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={channelHref(channel, controller)} onClick={(event) => { event.preventDefault(); openMembership(channel) }}>{agentChannelLabel(channel, controller)}</a>
                  <span className={unread > 10 ? "shrink-0 font-semibold text-amber-700 dark:text-amber-300" : "shrink-0 text-xs text-muted-foreground"} data-agent-unread={unread}>{unread} unread</span>
                </li>
              ))}</ul>}
          </section>

          <section aria-labelledby="agent-activity-heading" className="rounded-xl border p-5">
            <h2 className="text-sm font-semibold" id="agent-activity-heading">RECENT ACTIVITY</h2>
            <div className="mt-4">
              {recentMessagesState.status === "loading" && <p className="text-sm text-muted-foreground" role="status">Loading activity…</p>}
              {recentMessagesState.status === "error" && <p className="text-sm text-destructive" role="alert">{recentMessagesState.message}</p>}
              {recentMessagesState.status === "ready" && <RecentMessages controller={controller} messages={recentMessagesState.messages} onOpen={openRecentMessage} />}
            </div>
          </section>
        </aside>
      </div>

      <SessionPanel
        canSelect={controller.identity !== null}
        onLoadOlder={() => {
          if (sessionState.status === "ready" && sessionState.session.nextBefore !== null) {
            setSessionBefore(sessionState.session.nextBefore)
          }
        }}
        onSelectSession={selectSession}
        paneId={sessionPaneId}
        selectionState={sessionSelectionState}
        state={sessionState}
      />

      {workspace !== undefined && <a className="inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={workspaceHref} onClick={(event) => { event.preventDefault(); navigate({ kind: "workspace", workspaceId: workspace.id }) }}><ExternalLink aria-hidden="true" />Open workspace</a>}
    </div>
  )
}
