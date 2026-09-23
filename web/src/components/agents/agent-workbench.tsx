import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { browserCommandModifier } from "@/commands/keyboard"
import {
  Focus,
  Hash,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  Send,
  SquareTerminal,
  StopCircle,
  ArrowUpRight,
} from "lucide-react"
import { Menu } from "@base-ui/react/menu"

import type { AgentDetail, AgentSession, HerdrPaneView, HerdrWorkspaceView, Message } from "@/api/types"
import { Button } from "@/components/ui/button"
import { AgentAvatar } from "@/components/agent-avatar"
import { AgentStatusMark } from "@/components/agent-status-mark"
import { ChannelView } from "@/components/channel-view"
import { DictationButton } from "@/components/dictation-button"
import { useAgentSession } from "@/hooks/use-agent-session"
import {
  useAgentActivity,
  useAgentConversation,
  useAgentRecord,
  type AgentActivityState,
  type AgentRefreshState,
} from "@/hooks/use-agent-workbench"
import { useComposerAutosize } from "@/hooks/use-composer-autosize"
import { useComposerFocusTarget } from "@/hooks/use-composer-focus"
import type { AppController } from "@/hooks/use-app-controller"
import type { WorkspaceLoadState } from "@/hooks/use-herdr-workspaces"
import { focusCommandAgent, type CommandFailure } from "@/commands/execute"
import { COMMAND_MESSAGE_LIMIT, type AgentLocation } from "@/commands/types"
import { agentLocation } from "@/commands/catalog"
import { absoluteTimeLabel, paneStatusLabel, relativeAgeLabel, workspaceLabel } from "@/workspace-presentation"
import { shellRoutePath, type AgentView, type ShellRoute, type ShellRouter } from "@/shell-routing"
import { AgentSessionPanel } from "./agent-session-panel"
import "./agent-workbench.css"

interface AgentWorkbenchProps {
  controller: AppController
  handle: string
  navigate: ShellRouter["navigate"]
  view?: AgentView
}
type PaneActionState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "working" }> | Readonly<{ kind: "failed"; failure: CommandFailure }>
const NO_RECENT_MESSAGES: AgentDetail["recentMessageIds"] = []
const SESSION_FOLLOW_DISTANCE_PX = 80
const SESSION_REFRESH_INTERVAL_MS = 5_000
type SessionScrollAnchor =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "preserve"; top: number; height: number; source: AgentSession | undefined }>
type AgentPaneState = AgentLocation["kind"] | "loading" | "unavailable"
const PANE_STATE_LABELS = {
  running: "Running",
  "not-running": "Not running",
  ambiguous: "Multiple pane links",
  loading: "Checking workspace…",
  unavailable: "Runtime unavailable",
} as const satisfies Record<AgentPaneState, string>

function currentPaneState(state: WorkspaceLoadState, location: AgentLocation): AgentPaneState {
  switch (state.status) {
    case "loading":
      return "loading"
    case "error":
      return "unavailable"
    case "ready":
      return state.errorMessage === undefined ? location.kind : "unavailable"
  }
}

export function AgentWorkbench(props: AgentWorkbenchProps) {
  const metadataRevision =
    props.controller.metadataRevision("members") + props.controller.metadataRevision("participants")
  const record = useAgentRecord(props.controller.api, props.handle, metadataRevision)
  switch (record.state.status) {
    case "loading":
      return (
        <div className="agent-workbench-state" role="status">
          Loading agent…
        </div>
      )
    case "error":
      return (
        <div className="agent-workbench-state">
          <h2>Agent details are unavailable</h2>
          <p role="alert">{record.state.message}</p>
          <Button onClick={record.reload} variant="outline">
            Retry
          </Button>
        </div>
      )
    case "ready":
      return (
        <ReadyAgentWorkbench
          {...props}
          detail={record.state.detail}
          refreshState={record.state.refresh}
          onRefresh={record.reload}
        />
      )
  }
}

function ReadyAgentWorkbench({
  controller,
  detail,
  handle,
  navigate,
  refreshState,
  onRefresh,
  view = "session",
}: AgentWorkbenchProps & { detail: AgentDetail; refreshState: AgentRefreshState; onRefresh: () => void }) {
  const location = agentLocation(controller.workspaceData.workspaces, handle)
  const paneState = currentPaneState(controller.workspaceData.workspaceState, location)
  const pane = location.kind === "running" && paneState === "running" ? location.pane : null
  const workspace = location.kind === "running" ? location.workspace : undefined
  const session = useAgentSession(controller.api, handle, pane?.paneId ?? null)
  const conversation = useAgentConversation(controller, handle)
  const activity = useAgentActivity(controller.api, detail.recentMessageIds ?? NO_RECENT_MESSAGES, view === "activity")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [actionState, setActionState] = useState<PaneActionState>({ kind: "idle" })
  const selectView = (next: AgentView) => {
    if (next === "activity") onRefresh()
    navigate({ kind: "agent", handle, view: next })
  }
  const focus = async () => {
    setActionState({ kind: "working" })
    const result = await focusCommandAgent(controller.api, handle)
    result.match({
      ok: () => setActionState({ kind: "idle" }),
      err: (failure) => setActionState({ kind: "failed", failure }),
    })
  }
  const message = () => {
    selectView("messages")
    inputRef.current?.focus()
  }
  return (
    <div className="agent-workbench" data-agent-row={handle} data-agent-view={handle}>
      <AgentWorkbenchHeader
        controller={controller}
        detail={detail}
        glance={pane !== null && session.state.status === "ready" ? session.state.session.source.glance : null}
        paneState={paneState}
        onFocus={() => {
          void focus()
        }}
        onMessage={message}
        pane={pane}
        pending={actionState.kind === "working"}
        workspace={workspace}
      />
      {refreshState.kind === "failed" && (
        <p className="agent-workbench-alert" role="alert">
          The agent details could not be refreshed. {refreshState.message}{" "}
          <button onClick={onRefresh} type="button">
            Retry
          </button>
        </p>
      )}
      {actionState.kind === "failed" && (
        <p className="agent-workbench-alert" role="alert">
          {actionState.failure.message}
        </p>
      )}
      <div className="agent-workbench-grid">
        <div className="agent-workbench-main">
          <AgentViewTabs handle={handle} onSelect={selectView} view={view} />
          <AgentReadingArea
            paneState={paneState}
            activity={activity}
            controller={controller}
            conversation={conversation}
            detail={detail}
            navigate={navigate}
            pane={pane}
            session={session}
            view={view}
            workspace={workspace}
          />
          <AgentMessageComposer
            controller={controller}
            handle={handle}
            inputRef={inputRef}
            model={conversation}
            onViewConversation={() => selectView("messages")}
            routeState={detail.routeState}
          />
        </div>
        <aside className="agent-workbench-context">
          <AgentContext controller={controller} detail={detail} navigate={navigate} pane={pane} workspace={workspace} />
        </aside>
      </div>
    </div>
  )
}

interface AgentHeaderProps {
  controller: AppController
  detail: AgentDetail
  glance: string | null
  paneState: AgentPaneState
  pane: HerdrPaneView | null
  workspace: HerdrWorkspaceView | undefined
  pending: boolean
  onMessage: () => void
  onFocus: () => void
}

function AgentWorkbenchHeader({
  controller,
  detail,
  glance,
  paneState,
  pane,
  workspace,
  pending,
  onMessage,
  onFocus,
}: AgentHeaderProps) {
  const handle = detail.participant.handle
  const title = pane?.title ?? pane?.label ?? "No terminal title reported."
  return (
    <header className="agent-workbench-header" data-agent-header>
      <AgentHeading detail={detail} paneState={paneState} pane={pane} workspace={workspace} />
      <AgentHeaderControls
        controller={controller}
        handle={handle}
        pane={pane}
        pending={pending}
        onMessage={onMessage}
        onFocus={onFocus}
      />
      <div className="agent-current-task" data-pane-title={title}>
        <SquareTerminal aria-hidden="true" className="size-3.5" />
        <span title={glance ?? title} data-agent-glance={glance === null ? undefined : ""}>
          {glance ?? title}
        </span>
        <span className="agent-chat-status" data-route-state={detail.routeState}>
          {detail.routeState === "active" ? "Chat connected" : "Chat unavailable"}
        </span>
      </div>
      {paneState === "not-running" && (
        <p className="agent-workbench-offline">
          This identity has no running pane. Messages remain stored until an agent reconnects with this handle.
        </p>
      )}
      {paneState === "ambiguous" && (
        <p className="agent-workbench-offline" role="alert">
          More than one pane is linked to this handle. Check the workspace before you use terminal actions.
        </p>
      )}
      {paneState === "unavailable" && (
        <p className="agent-workbench-offline" role="alert">
          Live workspace data is unavailable.{" "}
          <button onClick={controller.workspaceData.reloadWorkspaces} type="button">
            Retry
          </button>
        </p>
      )}
    </header>
  )
}

function AgentMoreMenu({
  controller,
  handle,
  pane,
}: {
  controller: AppController
  handle: string
  pane: HerdrPaneView | null
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`More actions for ${handle}`} className="agent-more-trigger">
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} className="z-30">
          <Menu.Popup className="agent-more-menu">
            <Menu.Item onClick={() => controller.setChannelPickerOpen(true)} className="agent-more-item">
              All agent actions <kbd>{browserCommandModifier()} K</kbd>
            </Menu.Item>
            <Menu.Separator className="my-1 border-t" />
            <Menu.Item
              className="agent-more-item agent-stop-item"
              disabled={controller.identity === null || pane === null}
              onClick={() => {
                if (pane !== null) controller.openStopAgent(pane)
              }}
            >
              <StopCircle aria-hidden="true" className="size-4" />
              Stop agent…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

const AGENT_VIEWS = [
  { view: "session", label: "Session" },
  { view: "messages", label: "Messages" },
  { view: "activity", label: "Channel activity" },
  { view: "details", label: "Details" },
] as const

function AgentViewTabs({
  handle,
  onSelect,
  view,
}: {
  handle: string
  onSelect: (view: AgentView) => void
  view: AgentView
}) {
  return (
    <nav aria-label="Agent views" className="agent-view-tabs">
      {AGENT_VIEWS.map((item) => (
        <a
          aria-current={view === item.view ? "page" : undefined}
          className={item.view === "details" ? "agent-details-tab" : undefined}
          href={shellRoutePath({ kind: "agent", handle, view: item.view })}
          key={item.view}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
            event.preventDefault()
            onSelect(item.view)
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  )
}

interface ReadingAreaProps {
  paneState: AgentPaneState
  activity: AgentActivityState
  controller: AppController
  conversation: ReturnType<typeof useAgentConversation>
  detail: AgentDetail
  navigate: ShellRouter["navigate"]
  pane: HerdrPaneView | null
  session: ReturnType<typeof useAgentSession>
  view: AgentView
  workspace: HerdrWorkspaceView | undefined
}

function AgentReadingArea({
  activity,
  controller,
  conversation,
  detail,
  navigate,
  pane,
  paneState,
  session,
  view,
  workspace,
}: ReadingAreaProps) {
  switch (view) {
    case "session":
      if (paneState === "loading")
        return (
          <p className="agent-workbench-state" role="status">
            Checking the agent’s workspace…
          </p>
        )
      if (paneState === "unavailable")
        return (
          <p className="agent-workbench-state">The session cannot be read until live workspace data is available.</p>
        )
      if (paneState === "ambiguous")
        return (
          <p className="agent-workbench-state">
            The session is not selected because more than one pane is linked to this handle.
          </p>
        )
      return <AgentSessionReader canSelect={controller.identity !== null} pane={pane} session={session} />
    case "messages":
      return <AgentConversation controller={controller} model={conversation} />
    case "activity":
      return (
        <div className="agent-reading-scroll">
          <AgentActivity controller={controller} navigate={navigate} state={activity} />
        </div>
      )
    case "details":
      return (
        <div className="agent-reading-scroll">
          <AgentContext controller={controller} detail={detail} navigate={navigate} pane={pane} workspace={workspace} />
        </div>
      )
  }
}

function AgentSessionReader({
  canSelect,
  pane,
  session,
}: {
  canSelect: boolean
  pane: HerdrPaneView | null
  session: ReturnType<typeof useAgentSession>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const anchor = useRef<SessionScrollAnchor>({ kind: "none" })
  const source = session.state.status === "ready" ? session.state.session : undefined
  useEffect(() => {
    if (source?.source.state !== "ready" || session.readState.kind !== "idle") return
    const timer = window.setInterval(() => {
      if (follow.current && document.visibilityState === "visible") session.refresh()
    }, SESSION_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [source?.source.state, session.readState.kind, session.refresh])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null || source === undefined) return
    if (anchor.current.kind === "preserve" && anchor.current.source !== source) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height
      anchor.current = { kind: "none" }
      return
    }
    if (follow.current) element.scrollTop = element.scrollHeight
  }, [source])
  return (
    <div className="agent-session-reader">
      <div className="agent-reader-toolbar">
        <span>Saved harness transcript</span>
        <Button
          aria-label="Refresh session"
          disabled={session.readState.kind === "loading"}
          onClick={() => {
            anchor.current = { kind: "none" }
            session.refresh()
          }}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      <div
        className="agent-reading-scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < SESSION_FOLLOW_DISTANCE_PX
        }}
        ref={scrollRef}
      >
        <AgentSessionPanel
          canSelect={canSelect}
          onLoadOlder={() => {
            follow.current = false
            const element = scrollRef.current
            if (element !== null)
              anchor.current = { kind: "preserve", top: element.scrollTop, height: element.scrollHeight, source }
            session.loadOlder()
          }}
          onSelectSession={(id) => {
            void session.selectSession(id)
          }}
          paneId={pane?.paneId ?? null}
          selectionState={session.selectionState}
          readState={session.readState}
          state={session.state}
        />
      </div>
    </div>
  )
}

function AgentConversation({
  controller,
  model,
}: {
  controller: AppController
  model: ReturnType<typeof useAgentConversation>
}) {
  if (model.channel === undefined)
    return (
      <div className="agent-conversation-empty" data-agent-conversation="none">
        <MessageCircle aria-hidden="true" className="size-7" />
        <h3>Start a direct conversation</h3>
        <p>
          Your messages and the agent’s replies appear here.
          <br />
          Write your first message below.
        </p>
      </div>
    )
  return (
    <div className="agent-conversation-thread" data-agent-conversation={model.channel}>
      <ChannelView
        ackScheduler={controller.identity === null ? undefined : controller.ackScheduler}
        attachmentContentUrl={(id) => controller.api.attachmentContentUrl(id)}
        canPreview={controller.identity !== null}
        channelName={model.channel}
        errorMessage={model.live.messageState.status === "ready" ? model.live.messageState.errorMessage : undefined}
        fetchAttachmentContent={(id) => controller.api.attachmentContent(id)}
        fetchMessageMarkdown={(id, path) => controller.api.messageMarkdownContent(id, path)}
        loadState={model.live.messageState.status}
        messages={model.live.selectedMessages}
        onRetry={model.retry}
        receiptApi={controller.api}
        receiptUpdates={model.live.receiptUpdates}
        receiptUpdatesChannel={model.live.receiptUpdatesChannel}
        selfHandle={controller.identity?.handle}
        unread={0}
      />
    </div>
  )
}

function AgentMessageComposer({
  controller,
  handle,
  inputRef,
  model,
  onViewConversation,
  routeState,
}: {
  controller: AppController
  handle: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  model: ReturnType<typeof useAgentConversation>
  onViewConversation: () => void
  routeState: AgentDetail["routeState"]
}) {
  useComposerAutosize(inputRef, model.draft)
  useComposerFocusTarget(inputRef)
  const disabled = controller.identity === null || model.state.kind === "sending"
  return (
    <form
      className="agent-message-composer"
      data-agent-composer={handle}
      onSubmit={(event) => {
        event.preventDefault()
        void model.send()
      }}
    >
      <label htmlFor="agent-composer">
        <MessageCircle aria-hidden="true" className="size-3.5" />
        Direct message to <strong>{handle}</strong>
        {routeState === "stale" && <span>Stored until chat reconnects</span>}
      </label>
      <div className="agent-message-field">
        <textarea
          autoComplete="off"
          disabled={disabled}
          id="agent-composer"
          maxLength={COMMAND_MESSAGE_LIMIT}
          name="agent-message"
          onChange={(event) => model.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return
            event.preventDefault()
            event.stopPropagation()
            void model.send()
          }}
          placeholder="Send an instruction, ask a question, or share context…"
          ref={inputRef}
          rows={2}
          value={model.draft}
        />
        <AgentMessageTools model={model} inputRef={inputRef} disabled={disabled} />
      </div>
      <AgentSendFeedback model={model} onViewConversation={onViewConversation} />
    </form>
  )
}

function agentChannelRoute(channel: string, controller: AppController): ShellRoute {
  if (controller.directConversations.some((conversation) => conversation.channel === channel))
    return { kind: "conversation", channel }
  const workspace = [...controller.workspaceData.workspaceChannelsById.entries()].find(([, name]) => name === channel)
  return workspace === undefined ? { kind: "channel", channel } : { kind: "workspace", workspaceId: workspace[0] }
}

function AgentChannelLabel({ channel, controller }: { channel: string; controller: AppController }) {
  const direct = controller.directConversations.find((conversation) => conversation.channel === channel)
  if (direct !== undefined)
    return (
      <>
        <MessageCircle aria-hidden="true" className="size-3.5" />
        <span>{direct.participants.length === 0 ? "Direct conversation" : direct.participants.join(", ")}</span>
      </>
    )
  const workspaceEntry = [...controller.workspaceData.workspaceChannelsById.entries()].find(
    ([, name]) => name === channel,
  )
  if (workspaceEntry !== undefined) {
    const workspace = controller.workspaceData.workspaces.find((item) => item.id === workspaceEntry[0])
    return (
      <>
        <SquareTerminal aria-hidden="true" className="size-3.5" />
        <span>{workspace === undefined ? "Workspace broadcast" : workspaceLabel(workspace)}</span>
      </>
    )
  }
  return (
    <>
      <Hash aria-hidden="true" className="size-3.5" />
      <span>{channel}</span>
    </>
  )
}

function AgentContext({
  controller,
  detail,
  navigate,
  pane,
  workspace,
}: {
  controller: AppController
  detail: AgentDetail
  navigate: ShellRouter["navigate"]
  pane: HerdrPaneView | null
  workspace: HerdrWorkspaceView | undefined
}) {
  return (
    <div className="agent-context-content">
      <section>
        <h3>
          Channels <span>{detail.channels?.length ?? 0}</span>
        </h3>
        <p className="agent-context-caption">Unread counts belong to this agent.</p>
        {detail.channels === undefined || detail.channels.length === 0 ? (
          <p className="agent-context-empty">No channel memberships.</p>
        ) : (
          <ul>
            {detail.channels.map(({ channel, unread }) => (
              <li data-agent-channel={channel} key={channel}>
                <a
                  href={shellRoutePath(agentChannelRoute(channel, controller))}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                    event.preventDefault()
                    navigate(agentChannelRoute(channel, controller))
                  }}
                >
                  <AgentChannelLabel channel={channel} controller={controller} />
                  <span className="agent-unread" data-agent-unread={unread}>
                    {unread > 0 ? `${unread} unread` : "Caught up"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="agent-connection-details">
        <h3>Connection</h3>
        <dl>
          <dt>Chat route</dt>
          <dd>{detail.routeState === "active" ? "Active" : "Unavailable"}</dd>
          <dt>Last seen</dt>
          <dd>
            {detail.participant.lastSeenAt === null ? "Not reported" : relativeAgeLabel(detail.participant.lastSeenAt)}
          </dd>
          <dt>Pane</dt>
          <dd>{pane?.paneId ?? "Not running"}</dd>
          {workspace !== undefined && (
            <>
              <dt>Workspace</dt>
              <dd>
                <a href={shellRoutePath({ kind: "workspace", workspaceId: workspace.id })}>
                  {workspaceLabel(workspace)}
                </a>
              </dd>
            </>
          )}
        </dl>
      </section>
      <p className="agent-context-note">
        Messages are stored in Sheppard. Terminal input is a separate action in the command menu.
      </p>
    </div>
  )
}

function AgentActivity({
  controller,
  navigate,
  state,
}: {
  controller: AppController
  navigate: ShellRouter["navigate"]
  state: AgentActivityState
}) {
  switch (state.status) {
    case "loading":
      return (
        <p className="agent-workbench-state" role="status">
          Loading channel activity…
        </p>
      )
    case "error":
      return (
        <p className="agent-workbench-alert" role="alert">
          {state.message}
        </p>
      )
    case "ready":
      return state.messages.length === 0 ? (
        <div className="agent-workbench-state">No recent messages from this agent.</div>
      ) : (
        <ul className="agent-activity-list">
          {state.messages.map((message) => (
            <AgentActivityItem controller={controller} key={message.id} message={message} navigate={navigate} />
          ))}
        </ul>
      )
  }
}

function AgentActivityItem({
  controller,
  message,
  navigate,
}: {
  controller: AppController
  message: Message
  navigate: ShellRouter["navigate"]
}) {
  const destination = agentChannelRoute(message.channel, controller)
  const route: ShellRoute =
    destination.kind === "channel" || destination.kind === "conversation"
      ? { ...destination, messageId: message.id }
      : { kind: "channel", channel: message.channel, channelKind: "workspace", messageId: message.id }
  return (
    <li data-agent-activity={message.id}>
      <a
        href={shellRoutePath(route)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          navigate(route)
        }}
      >
        <div>
          <span>
            <AgentChannelLabel channel={message.channel} controller={controller} />
          </span>
          <time dateTime={message.createdAt} title={absoluteTimeLabel(message.createdAt)}>
            {relativeAgeLabel(message.createdAt)}
          </time>
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </div>
        <p>{message.body}</p>
      </a>
    </li>
  )
}

function AgentHeading({
  detail,
  paneState,
  pane,
  workspace,
}: Pick<AgentHeaderProps, "detail" | "paneState" | "pane" | "workspace">) {
  const handle = detail.participant.handle
  return (
    <div className="agent-workbench-heading">
      <span className="agent-workbench-avatar">
        <AgentAvatar agentKind={detail.participant.agentKind} />
      </span>
      <div>
        <h2 data-agent-identity>{handle}</h2>
        <div className="agent-workbench-facts" data-agent-identity-facts>
          <span>{detail.participant.agentKind ?? "Agent"}</span>
          {detail.participant.role != null && (
            <span data-agent-role={detail.participant.role}>{detail.participant.role}</span>
          )}
          {workspace !== undefined && (
            <a href={shellRoutePath({ kind: "workspace", workspaceId: workspace.id })}>{workspaceLabel(workspace)}</a>
          )}
          <span className="agent-runtime-state">
            <AgentStatusMark size={20} status={pane?.agentStatus ?? "unknown"} />
            {paneState === "running" && pane !== null ? paneStatusLabel(pane) : PANE_STATE_LABELS[paneState]}
          </span>
        </div>
      </div>
    </div>
  )
}

function AgentHeaderControls({
  controller,
  handle,
  pane,
  pending,
  onMessage,
  onFocus,
}: Pick<AgentHeaderProps, "controller" | "pane" | "pending" | "onMessage" | "onFocus"> & { handle: string }) {
  return (
    <div className="agent-workbench-controls">
      <Button disabled={controller.identity === null} onClick={onMessage} size="sm">
        <MessageCircle aria-hidden="true" />
        Message
      </Button>
      <Button
        disabled={controller.identity === null || pane === null || pending}
        onClick={onFocus}
        size="sm"
        variant="outline"
      >
        <Focus aria-hidden="true" />
        Focus terminal
      </Button>
      <AgentMoreMenu controller={controller} handle={handle} pane={pane} />
    </div>
  )
}

function AgentSendFeedback({
  model,
  onViewConversation,
}: {
  model: ReturnType<typeof useAgentConversation>
  onViewConversation: () => void
}) {
  return (
    <>
      {model.state.kind === "failed" && (
        <div className="agent-workbench-alert" role="alert">
          <p>{model.state.failure.message}</p>
          {model.state.failure.kind === "outcome-unknown" && (
            <div className="flex flex-wrap gap-2 mt-2">
              <Button onClick={onViewConversation} size="sm" type="button" variant="outline">
                Check conversation
              </Button>
              <Button onClick={model.allowAnotherSend} size="sm" type="button" variant="outline">
                I checked; allow another send
              </Button>
            </div>
          )}
        </div>
      )}
      {model.state.kind === "sent" && (
        <p className="agent-send-confirmation" role="status">
          Message sent.{" "}
          <button onClick={onViewConversation} type="button">
            View conversation
          </button>
        </p>
      )}
    </>
  )
}

function AgentMessageTools({
  model,
  inputRef,
  disabled,
}: {
  model: ReturnType<typeof useAgentConversation>
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  return (
    <div className="agent-message-tools">
      <DictationButton disabled={disabled} inputRef={inputRef} onChange={model.setDraft} value={model.draft} />
      <span>{browserCommandModifier()} ↵ to send</span>
      <Button
        disabled={disabled || (model.state.kind === "failed" && model.state.failure.kind === "outcome-unknown")}
        size="sm"
        type="submit"
      >
        <Send aria-hidden="true" />
        {model.state.kind === "sending" ? "Sending…" : "Send"}
      </Button>
    </div>
  )
}
