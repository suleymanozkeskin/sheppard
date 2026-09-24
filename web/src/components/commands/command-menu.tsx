import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { browserCommandModifier } from "@/commands/keyboard"
import { Dialog } from "@base-ui/react/dialog"
import { Command, LoaderCircle, X } from "lucide-react"

import type { AppController } from "@/hooks/use-app-controller"
import type { WorkspaceLoadState } from "@/hooks/use-herdr-workspaces"
import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import { useCommandReturn, type CommandDialog } from "@/hooks/use-command-return"
import type { ShellRoute, ShellRouter } from "@/shell-routing"
import { Button } from "@/components/ui/button"
import { commandCatalog, contextCommands } from "@/commands/catalog"
import { defaultCommands } from "@/commands/defaults"
import type { CommandDraft, CommandDrafts } from "@/commands/drafts"
import { useCommandDrafts } from "@/hooks/use-command-drafts"
import {
  commandWriteFailure,
  currentAgentPane,
  focusCommandAgent,
  type CommandFailure,
  type CommandSuccess,
} from "@/commands/execute"
import {
  COMMAND_RECENT_LIMIT,
  commandChoice,
  commandEntry,
  messageTargetKey,
  messageTargetLabel,
  type CommandAction,
  type CommandChoice,
  type CommandEntry,
  type SpawnLocation,
} from "@/commands/types"
import { CommandBreadcrumb, CommandNotice } from "./command-parts"
import { CommandBrowser } from "./command-browser"
import { type CommandBrowserPosition } from "@/commands/browser-state"
import {
  commandScreenLabel,
  enterCommand,
  leaveCommand,
  replaceCommand,
  ROOT_NAVIGATION,
  type CommandScreen,
  type CommandChildScreen,
} from "@/commands/navigation"
import { commandFocus, commandKeyIntent, type CommandListKeyboard } from "@/commands/navigation-keys"
import { CommandComposer } from "./command-composer"
import { CommandSpawn } from "./command-spawn"
import "./command-menu.css"

type OperationState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "working" }> | Readonly<{ kind: "failed"; failure: CommandFailure }>
type Feedback = Readonly<{ kind: "none" }> | Readonly<{ kind: "success"; result: CommandSuccess }>
const COMMAND_LAYER = { mode: "modal", scope: "picker" } as const
const HOME_GROUP_LIMIT = 4

function spawnLocation(route: ShellRoute, entries: readonly CommandEntry[]): SpawnLocation {
  if (route.kind === "workspace") return { kind: "workspace", workspaceId: route.workspaceId }
  if (route.kind === "agent") {
    const workspace = entries
      .find((entry) => entry.id === `agent:${route.handle}`)
      ?.alternatives.find((choice) => choice.action.kind === "navigate" && choice.action.route.kind === "workspace")
    if (workspace?.action.kind === "navigate" && workspace.action.route.kind === "workspace")
      return { kind: "workspace", workspaceId: workspace.action.route.workspaceId }
  }
  return { kind: "choose" }
}

function homeCommands(
  entries: readonly CommandEntry[],
  context: readonly CommandEntry[],
  defaults: readonly CommandEntry[],
  recent: readonly string[],
): readonly CommandEntry[] {
  const remembered = recent.flatMap((id) => {
    const entry = entries.find((candidate) => candidate.id === id)
    return entry === undefined ? [] : [{ ...entry, group: "recent" as const }]
  })
  const recentIds = new Set(recent)
  const groups = ["agent", "chat", "direct", "workspace"] as const
  return [
    ...context,
    ...remembered,
    ...defaults.slice(0, HOME_GROUP_LIMIT),
    ...groups.flatMap((group) =>
      entries.filter((entry) => entry.group === group && !recentIds.has(entry.id)).slice(0, HOME_GROUP_LIMIT),
    ),
  ]
}

function commandRuntimeState(state: WorkspaceLoadState): "ready" | "loading" | "unavailable" {
  switch (state.status) {
    case "loading":
      return "loading"
    case "error":
      return "unavailable"
    case "ready":
      return state.errorMessage === undefined ? "ready" : "unavailable"
  }
}

function useCommandData(controller: AppController, route: ShellRoute, recent: readonly string[]) {
  const runtimeState = commandRuntimeState(controller.workspaceData.workspaceState)
  const catalog = useMemo(
    () =>
      commandCatalog({
        runtimeState,
        channels: controller.channelState.status === "ready" ? controller.channelState.channels : [],
        direct: controller.directConversations,
        participants: controller.participants,
        workspaces: controller.workspaceData.workspaces,
        joinedChannels: new Set(controller.inboxEntries.map((entry) => entry.channel)),
      }),
    [
      runtimeState,
      controller.channelState,
      controller.directConversations,
      controller.participants,
      controller.workspaceData.workspaces,
      controller.inboxEntries,
    ],
  )
  const entries = catalog.isOk() ? catalog.value : []
  const defaults = defaultCommands(spawnLocation(route, entries))
  const context = contextCommands(entries, route)
  const warnings: string[] = []
  if (catalog.isErr()) warnings.push(catalog.error.message)
  if (controller.channelState.status === "error") warnings.push("Channels could not be loaded.")
  if (controller.participantsState.status === "ready" && controller.participantsState.errorMessage !== undefined)
    warnings.push("Chat identities could not be loaded.")
  if (runtimeState === "unavailable") warnings.push("Live workspaces could not be loaded.")
  return {
    entries: [...entries, ...defaults, ...context],
    entities: entries,
    home: homeCommands(entries, context, defaults, recent),
    warnings,
  }
}

type SpawnSetupState = Readonly<{ kind: "none" }> | Readonly<{ kind: "saved"; location: SpawnLocation }>
function useCommandNavigation(controller: AppController, router: ShellRouter) {
  const [navigation, setNavigation] = useState(ROOT_NAVIGATION)
  const screen = navigation.current.screen
  const [recent, setRecent] = useState<readonly string[]>([])
  const [spawnSetup, setSpawnSetup] = useState<SpawnSetupState>({ kind: "none" })
  const [formPending, setFormPending] = useState(false)
  const pending = useRef(false)
  const close = () => controller.setChannelPickerOpen(false)
  const home = () => setNavigation(ROOT_NAVIGATION)
  const enter = (next: CommandChildScreen) => {
    const result = enterCommand(navigation, next)
    if (result.isOk()) setNavigation(result.value)
    return result
  }
  const replace = (next: CommandChildScreen) => setNavigation((current) => replaceCommand(current, next))
  const back = () => {
    const result = leaveCommand(navigation)
    switch (result.kind) {
      case "close":
        close()
        return
      case "parent":
        setNavigation(result.navigation)
        return
    }
  }
  const navigate = (route: ShellRoute) => {
    close()
    home()
    router.navigate(route)
  }
  const remember = (id: string) =>
    setRecent((ids) => [id, ...ids.filter((item) => item !== id)].slice(0, COMMAND_RECENT_LIMIT))
  const rememberSpawn = (location: SpawnLocation) =>
    setSpawnSetup((current) => (current.kind === "none" ? { kind: "saved", location } : current))
  const clearSpawn = () => setSpawnSetup({ kind: "none" })
  const onPosition = (position: CommandBrowserPosition) =>
    setNavigation((current) => ({ ...current, current: { ...current.current, position } }))
  return {
    screen,
    enter,
    replace,
    back,
    path: [...navigation.parents, navigation.current].map((frame) => commandScreenLabel(frame.screen)),
    recent,
    spawnSetup,
    rememberSpawn,
    clearSpawn,
    formPending,
    setFormPending,
    pending,
    close,
    home,
    navigate,
    remember,
    position: navigation.current.position,
    onPosition,
  }
}

function useCommandFeedback(controller: AppController, nav: ReturnType<typeof useCommandNavigation>) {
  const [operation, setOperation] = useState<OperationState>({ kind: "idle" })
  const [feedback, setFeedback] = useState<Feedback>({ kind: "none" })
  const clear = () => setFeedback({ kind: "none" })
  const fail = (failure: CommandFailure) => setOperation({ kind: "failed", failure })
  const complete = (result: CommandSuccess) => {
    setFeedback({ kind: "success", result })
    setOperation({ kind: "idle" })
    controller.reload()
    nav.close()
    nav.home()
  }
  const back = () => {
    if (nav.formPending || nav.pending.current) return
    nav.back()
    setOperation({ kind: "idle" })
  }
  return { operation, setOperation, feedback, clear, fail, complete, back }
}

function useCommandDraftEditor(screen: CommandScreen, feedback: ReturnType<typeof useCommandFeedback>) {
  const { store, drafts } = useCommandDrafts()
  const draftKey =
    screen.kind === "compose"
      ? messageTargetKey(screen.target)
      : screen.kind === "prompt"
        ? `prompt:${screen.handle}`
        : ""
  const draft = drafts.get(draftKey)
  const changeDraft = (text: string) => {
    if (screen.kind !== "compose" && screen.kind !== "prompt") return
    const target =
      screen.kind === "compose"
        ? { kind: "message" as const, recipient: screen.target }
        : { kind: "terminal" as const, handle: screen.handle }
    const result = store.write(target, text)
    if (result.isErr()) feedback.fail({ kind: "not-completed", message: result.error.message })
  }
  const changeDelivery = (delivery: "editable" | "uncertain") => store.settle(draftKey, delivery)
  const sent = (result: CommandSuccess) => {
    store.complete(draftKey)
    feedback.complete(result)
  }
  return {
    entries: commandDraftEntries(drafts),
    body: draft?.body ?? "",
    delivery: draft?.delivery ?? "editable",
    changeDraft,
    changeDelivery,
    sent,
  }
}

function commandChoiceHandler(
  controller: AppController,
  nav: ReturnType<typeof useCommandNavigation>,
  feedback: ReturnType<typeof useCommandFeedback>,
  suspend: (dialog: CommandDialog) => void,
) {
  return (choice: CommandChoice): void => {
    if (choice.availability.kind === "unavailable") {
      feedback.fail({ kind: "not-completed", message: choice.availability.reason })
      return
    }
    if (nav.pending.current) return
    feedback.setOperation({ kind: "idle" })
    if (choice.action.kind === "navigate") {
      nav.remember(choice.id)
      nav.navigate(choice.action.route)
      return
    }
    if (controller.identity === null && choice.action.kind !== "theme" && choice.action.kind !== "shell") {
      feedback.fail({ kind: "not-completed", message: "Reload Sheppard to reconnect before you use this action." })
      return
    }
    if (choice.action.kind === "spawn") nav.rememberSpawn(choice.action.location)
    void dispatchCommand(choice.action, {
      controller,
      close: nav.close,
      complete: feedback.complete,
      fail: feedback.fail,
      pending: nav.pending,
      setOperation: feedback.setOperation,
      setScreen: (screen) => {
        nav
          .enter(screen)
          .match({
            ok: () => undefined,
            err: (error) => feedback.fail({ kind: "not-completed", message: error.message }),
          })
      },
      home: nav.home,
      suspend,
    })
  }
}

export function CommandMenu({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const nav = useCommandNavigation(controller, router)
  const returnToMenu = useCommandReturn()
  if (returnToMenu === null) throw new Error("CommandMenu requires CommandReturnProvider")
  const listKeyboard = useRef<CommandListKeyboard | null>(null)
  const feedback = useCommandFeedback(controller, nav)
  const editor = useCommandDraftEditor(nav.screen, feedback)
  const data = useCommandData(controller, router.route, nav.recent)
  const withDrafts = { ...data, home: [...editor.entries, ...data.home], entries: [...editor.entries, ...data.entries] }
  const content = commandContent({
    screen: nav.screen,
    data: withDrafts,
    controller,
    choose: commandChoiceHandler(controller, nav, feedback, (dialog) =>
      returnToMenu.suspend(dialog, commandScreenLabel(nav.screen), nav.home),
    ),
    actions: (entry) =>
      nav.enter({ kind: "actions", id: entry.id, title: entry.title }).match({
        ok: () => undefined,
        err: (error) => feedback.fail({ kind: "not-completed", message: error.message }),
      }),
    replace: nav.replace,
    listKeyboard,
    ...editor,
    onPending: nav.setFormPending,
    position: nav.position,
    onPosition: nav.onPosition,
  })
  return (
    <>
      <CommandWindow
        onBack={feedback.back}
        onClose={nav.close}
        open={controller.channelPickerOpen}
        screen={nav.screen}
        listKeyboard={listKeyboard}
        suspended={returnToMenu.destination.kind === "menu"}
      >
        <CommandMenuChrome
          controller={controller}
          onBack={feedback.back}
          operation={feedback.operation}
          screen={nav.screen}
          warnings={data.warnings}
          path={nav.path}
          query={nav.position.query}
        />
        <div data-command-screen="active">{content}</div>
        {nav.spawnSetup.kind === "saved" && (
          <div
            data-command-screen={nav.screen.kind === "spawn" ? "active" : "hidden"}
            hidden={nav.screen.kind !== "spawn"}
          >
            <CommandSpawn
              controller={controller}
              location={nav.spawnSetup.location}
              requestedLocation={nav.screen.kind === "spawn" ? nav.screen.location : nav.spawnSetup.location}
              onPending={nav.setFormPending}
              onSuccess={(result) => {
                nav.clearSpawn()
                feedback.complete(result)
              }}
            />
          </div>
        )}
      </CommandWindow>
      <CommandFeedback state={feedback.feedback} onClear={feedback.clear} onNavigate={nav.navigate} />
    </>
  )
}

function CommandMenuChrome({
  controller,
  onBack,
  operation,
  screen,
  warnings,
  path,
  query,
}: {
  controller: AppController
  onBack: () => void
  operation: OperationState
  screen: CommandScreen
  warnings: readonly string[]
  path: readonly string[]
  query: string
}) {
  return (
    <>
      {screen.kind !== "browse" && (
        <CommandBreadcrumb
          onBack={onBack}
          path={path}
          leftBack={(screen.kind === "actions" || screen.kind === "recipients") && query.length === 0}
        />
      )}
      {warnings.length > 0 && (
        <div className="command-data-warning" role="status">
          {warnings.join(" ")}{" "}
          <button
            onClick={() => {
              controller.reload()
              controller.workspaceData.reloadWorkspaces()
            }}
            type="button"
          >
            Retry
          </button>
        </div>
      )}
      {operation.kind === "working" && (
        <p className="command-pending" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> Working…
        </p>
      )}
      {operation.kind === "failed" && (
        <p className="command-error" role="alert">
          {operation.failure.message}
        </p>
      )}
    </>
  )
}

function CommandFeedback({
  state,
  onClear,
  onNavigate,
}: {
  state: Feedback
  onClear: () => void
  onNavigate: (route: ShellRoute) => void
}) {
  if (state.kind === "none") return null
  return (
    <CommandNotice message={state.result.message} onClose={onClear}>
      {state.result.destination.kind !== "current" && (
        <Button
          onClick={() => {
            onNavigate(state.result.destination)
            onClear()
          }}
          size="sm"
          variant="ghost"
        >
          Open
        </Button>
      )}
    </CommandNotice>
  )
}

function commandDraftEntries(drafts: CommandDrafts): readonly CommandEntry[] {
  return [...drafts.entries()].map(([key, draft]) => {
    const target = draft.target
    const label = target.kind === "message" ? messageTargetLabel(target.recipient) : target.handle
    const action: CommandAction =
      target.kind === "message"
        ? { kind: "compose", target: target.recipient }
        : { kind: "prompt-agent", handle: target.handle }
    return commandEntry(
      commandChoice(
        `draft:${key}`,
        `Resume ${target.kind === "message" ? "message" : "terminal input"} to ${label}`,
        draft.delivery === "uncertain" ? "Previous send unconfirmed; check before sending again" : draft.body,
        target.kind === "message" ? "message" : "terminal",
        action,
        "draft",
      ),
    )
  })
}

interface CommandDispatch {
  controller: AppController
  close: () => void
  complete: (result: CommandSuccess) => void
  fail: (failure: CommandFailure) => void
  pending: { current: boolean }
  setOperation: (state: OperationState) => void
  setScreen: (screen: CommandChildScreen) => void
  home: () => void
  suspend: (dialog: CommandDialog) => void
}

async function dispatchCommand(
  action: Exclude<CommandAction, { kind: "navigate" }>,
  host: CommandDispatch,
): Promise<void> {
  const { controller, close, complete, fail, setScreen } = host
  switch (action.kind) {
    case "compose":
      setScreen({ kind: "compose", target: action.target })
      return
    case "recipients":
      setScreen({ kind: "recipients" })
      return
    case "spawn":
      setScreen({ kind: "spawn", location: action.location })
      return
    case "prompt-agent":
      setScreen({ kind: "prompt", handle: action.handle })
      return
    case "join-channel":
      setScreen({ kind: "join", channel: action.channel })
      return
    case "members":
      host.suspend("members")
      controller.openMembers(action.channel)
      return
    case "theme":
      controller.saveThemePreference(action.mode)
      complete({ message: `Theme set to ${action.mode}.`, destination: { kind: "current" } })
      return
    case "connect":
      host.suspend("connect")
      controller.openConnectPane(action.pane, action.label)
      return
    case "shell":
      switch (action.name) {
        case "inbox":
        case "settings":
        case "help":
          host.suspend(action.name)
          break
        case "create-channel":
        case "create-workspace":
          close()
          host.home()
          break
      }
      dispatchShellCommand(action.name, controller)
      return
    case "focus-agent": {
      host.pending.current = true
      host.setOperation({ kind: "working" })
      const result = await focusCommandAgent(controller.api, action.handle)
      host.pending.current = false
      result.match({ ok: complete, err: fail })
      return
    }
    case "stop-agent": {
      host.pending.current = true
      host.setOperation({ kind: "working" })
      const result = await currentAgentPane(controller.api, action.handle)
      host.pending.current = false
      result.match({
        ok: (pane) => {
          host.suspend("stop-agent")
          host.setOperation({ kind: "idle" })
          controller.openStopAgent(pane)
        },
        err: fail,
      })
      return
    }
  }
}

function dispatchShellCommand(
  name: Extract<CommandAction, { kind: "shell" }>["name"],
  controller: AppController,
): void {
  switch (name) {
    case "inbox":
      controller.dispatchAction("inbox.open")
      return
    case "settings":
      controller.dispatchAction("settings.open")
      return
    case "help":
      controller.dispatchAction("help.show")
      return
    case "create-channel":
      controller.dispatchAction("channel.create")
      return
    case "create-workspace":
      controller.openCreateWorkspace()
      return
  }
}

interface CommandContentProps {
  screen: CommandScreen
  data: ReturnType<typeof useCommandData>
  controller: AppController
  choose: (choice: CommandChoice) => void
  actions: (entry: CommandEntry) => void
  body: string
  delivery: CommandDraft["delivery"]
  changeDelivery: (delivery: "editable" | "uncertain") => void
  changeDraft: (body: string) => void
  sent: (success: CommandSuccess) => void
  onPending: (pending: boolean) => void
  position: CommandBrowserPosition
  onPosition: (position: CommandBrowserPosition) => void
  listKeyboard: RefObject<CommandListKeyboard | null>
  replace: (screen: CommandChildScreen) => void
}

function commandContent({
  screen,
  data,
  controller,
  choose,
  actions,
  body,
  delivery,
  changeDelivery,
  changeDraft,
  sent,
  onPending,
  position,
  onPosition,
  listKeyboard,
  replace,
}: CommandContentProps): ReactNode {
  switch (screen.kind) {
    case "browse":
      return (
        <CommandBrowser
          listKeyboard={listKeyboard}
          position={position}
          onPosition={onPosition}
          entries={data.entries}
          home={data.home}
          mode="browse"
          onActions={actions}
          onChoose={choose}
        />
      )
    case "recipients":
      return (
        <CommandBrowser
          listKeyboard={listKeyboard}
          position={position}
          onPosition={onPosition}
          entries={data.entities}
          home={data.entities}
          key="recipients"
          mode="recipients"
          onActions={actions}
          onChoose={choose}
        />
      )
    case "actions": {
      const target = data.entities.find((entry) => entry.id === screen.id)
      if (target === undefined)
        return (
          <p className="command-error" role="alert">
            This target is no longer available. Go back to search again.
          </p>
        )
      const entries = target.alternatives.map((choice) => commandEntry(choice))
      return (
        <CommandBrowser
          listKeyboard={listKeyboard}
          position={position}
          onPosition={onPosition}
          entries={entries}
          home={entries}
          key={screen.id}
          mode="actions"
          onActions={actions}
          onChoose={choose}
        />
      )
    }
    case "compose":
      return (
        <CommandComposer
          api={controller.api}
          body={body}
          canWrite={controller.identity !== null}
          delivery={delivery}
          key={messageTargetKey(screen.target)}
          onBodyChange={changeDraft}
          onDeliveryChange={changeDelivery}
          onPending={onPending}
          onSuccess={sent}
          target={{ kind: "message", recipient: screen.target }}
        />
      )
    case "prompt":
      return (
        <CommandComposer
          api={controller.api}
          body={body}
          canWrite={controller.identity !== null}
          delivery={delivery}
          key={`prompt:${screen.handle}`}
          onBodyChange={changeDraft}
          onDeliveryChange={changeDelivery}
          onPending={onPending}
          onSuccess={sent}
          target={{ kind: "terminal", handle: screen.handle }}
        />
      )
    case "spawn":
      return null
    case "join":
      return (
        <CommandJoin
          channel={screen.channel}
          controller={controller}
          onPending={onPending}
          onJoined={() =>
            replace({ kind: "compose", target: { kind: "channel", channel: screen.channel, membership: "joined" } })
          }
        />
      )
  }
}

function CommandJoin({
  channel,
  controller,
  onJoined,
  onPending,
}: {
  channel: string
  controller: AppController
  onJoined: () => void
  onPending: (pending: boolean) => void
}) {
  const [state, setState] = useState<OperationState>({ kind: "idle" })
  const pending = useRef(false)
  async function join(): Promise<void> {
    if (
      pending.current ||
      controller.identity === null ||
      (state.kind === "failed" && state.failure.kind === "outcome-unknown")
    )
      return
    pending.current = true
    onPending(true)
    setState({ kind: "working" })
    const result = await controller.api.joinChannel(channel)
    pending.current = false
    onPending(false)
    result.match({
      ok: () => {
        controller.reload()
        onJoined()
      },
      err: (error) => setState({ kind: "failed", failure: commandWriteFailure(error) }),
    })
  }
  return (
    <div className="command-compose">
      <h2>Join #{channel}</h2>
      <p className="command-audience">
        Join this channel to send a message. Earlier messages stay in history; only new messages become unread.
      </p>
      {state.kind === "failed" && (
        <p className="command-error" role="alert">
          {state.failure.message}
        </p>
      )}
      <Button
        data-command-autofocus
        disabled={
          state.kind === "working" ||
          controller.identity === null ||
          (state.kind === "failed" && state.failure.kind === "outcome-unknown")
        }
        onClick={() => {
          void join()
        }}
      >
        Join and write a message
      </Button>
    </div>
  )
}

function CommandKeyboard({ onBack }: { onBack: () => void }) {
  useKeyboardLayer(COMMAND_LAYER, undefined, onBack)
  return null
}

const COMMAND_FOCUS_SELECTOR =
  "[data-command-screen=active] [data-command-autofocus]:not(:disabled), [data-command-screen=active] input:not([type=hidden]):not(:disabled)"

function CommandWindow({
  children,
  open,
  onBack,
  onClose,
  screen,
  listKeyboard,
  suspended,
}: {
  children: ReactNode
  open: boolean
  onBack: () => void
  onClose: () => void
  screen: CommandScreen
  listKeyboard: RefObject<CommandListKeyboard | null>
  suspended: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const dialogActions = useRef<Dialog.Root.Actions | null>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const changedLevel = open && wasOpen.current
    const closed = !open && wasOpen.current
    wasOpen.current = open
    if (closed) {
      dialogActions.current?.unmount()
      // Release retained fields after the focus trap is removed, before the next keyboard event.
      queueMicrotask(() => {
        if (wasOpen.current) return
        const focused = panelRef.current?.ownerDocument.activeElement
        if (focused instanceof HTMLElement && panelRef.current?.contains(focused)) focused.blur()
      })
    }
    if (changedLevel) panelRef.current?.querySelector<HTMLElement>(COMMAND_FOCUS_SELECTOR)?.focus()
    if (changedLevel && !panelRef.current?.contains(document.activeElement))
      panelRef.current?.querySelector<HTMLElement>("[data-command-back]")?.focus()
  }, [open, screen])
  return (
    <Dialog.Root
      actionsRef={dialogActions}
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        if (details.reason === "escape-key") {
          details.cancel()
          if (commandKeyIntent(details.event, commandFocus(details.event.target), screen.kind !== "browse") === "back") onBack()
        } else onClose()
      }}
    >
      <Dialog.Portal keepMounted>
        <Dialog.Backdrop className="command-backdrop" />
        <Dialog.Popup
          className="command-window"
          data-dialog="channel-picker"
          data-command-menu
          finalFocus={() => (open || suspended ? false : true)}
          initialFocus={() => {
            const input = panelRef.current?.querySelector<HTMLElement>(COMMAND_FOCUS_SELECTOR)
            if (input === null || input === undefined) return true
            // Focus after the dialog becomes active, before another key or animation frame.
            input.focus({ preventScroll: true })
            return false
          }}
          ref={panelRef}
          onKeyDown={(event) => {
            if (!open || event.defaultPrevented) return
            const intent = commandKeyIntent(
              { ...event, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 },
              commandFocus(event.target),
              screen.kind !== "browse",
            )
            switch (intent) {
              case "native":
              case "field-up":
              case "field-down":
              case "field-left":
              case "field-right":
              case "edit-field":
              case "finish-field":
                return
              case "back":
                onBack()
                break
              case "close":
                onClose()
                break
              default:
                if (listKeyboard.current?.(intent, event.key) !== true) return
            }
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {open && <CommandKeyboard onBack={onBack} />}
          <Dialog.Title className="sr-only">Sheppard command menu</Dialog.Title>
          <Dialog.Description className="sr-only">
            Find agents and channels, navigate, and take action without leaving your work.
          </Dialog.Description>
          <Dialog.Close className="command-close" aria-label="Close command menu">
            <X aria-hidden="true" className="size-4" />
          </Dialog.Close>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function CommandMenuTrigger({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  return (
    <button
      aria-label="Open command menu"
      className={compact ? "command-trigger command-trigger-compact" : "command-trigger"}
      onClick={onOpen}
      type="button"
    >
      <Command aria-hidden="true" className="size-4" />
      {!compact && (
        <>
          <span>Find or do anything…</span>
          <kbd>{browserCommandModifier()} K</kbd>
        </>
      )}
    </button>
  )
}
