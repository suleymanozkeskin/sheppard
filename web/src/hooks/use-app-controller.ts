import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Result } from "better-result"

import { createAckScheduler } from "@/api/ack"
import { ApiNetworkError, formatApiError } from "@/api/errors"
import { AUTO_IDENTIFY_HANDLE, autoIdentify, NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { identityForHandle, removeIdentity, saveIdentity, type StoredIdentity } from "@/api/identity"
import { mockApi } from "@/api/mock"
import { apiCall, createBrowserApi } from "@/api/runtime"
import type { DirectoryList, HerdrPaneView, Member, Message, MsgrApi, RolePreset, RouteState, WorkspaceList } from "@/api/types"
import { useChannelState } from "@/hooks/use-channel-state"
import { focusActiveComposer } from "@/hooks/use-composer-focus"
import { useComposerState, type AttachmentPath } from "@/hooks/use-composer-state"
import { useHerdrWorkspaces } from "@/hooks/use-herdr-workspaces"
import { useKeyboardDispatcher } from "@/hooks/use-keyboard-dispatcher"
import { useLiveMessages } from "@/hooks/use-live-messages"
import { useSearch } from "@/hooks/use-search"
import type { ShellNavigate, ShellRoute } from "@/shell-routing"
import { applyTheme, DEFAULT_THEME_MODE, loadThemeMode, nextThemeMode, prefersDarkTheme, resolveTheme, saveThemeMode, type ThemeMode } from "@/theme"
import { paneIdentity, paneStopConfirmation, suggestedPaneHandle, unmanagedAgentCount } from "@/workspace-presentation"
import {
  bindingConflicts,
  defaultBindings,
  loadBindingsWithMigration,
  saveBindings,
  type ActionName,
  type KeyboardBindings,
} from "@/keyboard"

export type CreateChannelState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "error"; message: string }

export type MemberAddState =
  | { status: "idle" }
  | { status: "adding" }
  | { status: "error"; message: string }

export type DirectCreateState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "error"; message: string }

export type WorkspaceActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

interface ConnectPaneTarget {
  label: string
  pane: HerdrPaneView
}

export type WorkspaceDirectoryPickerState =
  | { status: "closed" }
  | { status: "loading"; path: string | undefined }
  | { status: "ready"; listing: DirectoryList }
  | { status: "error"; message: string; path: string | undefined }

export type SpawnAgentState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "awaiting-topology"; assignedHandle: string }
  | { status: "error"; message: string }

type SpawnAgentMode = "spawn-agent" | "add-reporter"

function spawnAgentDestination(
  mode: SpawnAgentMode,
  workspaceId: string | undefined,
): Extract<ShellRoute, { kind: "spawn-agent" }> | undefined {
  switch (mode) {
    case "spawn-agent":
      return workspaceId === undefined
        ? { kind: "spawn-agent" }
        : { kind: "spawn-agent", workspaceId }
    case "add-reporter":
      return workspaceId === undefined
        ? undefined
        : { kind: "spawn-agent", mode: "add-reporter", role: "reporter", workspaceId }
  }
}

function routeStatesFromTopology(snapshot: WorkspaceList): ReadonlyMap<string, RouteState> {
  return new Map(snapshot.workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => (
    pane.participant === null || pane.participantRouteState === null
      ? []
      : [[pane.participant, pane.participantRouteState] as const]
  ))))
}

interface InitialBindings {
  bindings: KeyboardBindings
  notice: string | undefined
}

const noopNavigate: ShellNavigate = () => undefined

export interface MessageContextTarget {
  channel: string
  messageId: number
}

interface InitialTheme {
  mode: ThemeMode
  notice: string | undefined
}

function loadInitialTheme(): InitialTheme {
  return loadThemeMode().match({
    ok: (mode) => ({ mode, notice: undefined }),
    err: () => ({ mode: DEFAULT_THEME_MODE, notice: undefined }),
  })
}

function loadInitialBindings(): InitialBindings {
  return loadBindingsWithMigration().match({
    ok: ({ bindings, droppedActions }) => ({
      bindings,
      notice: droppedActions.length === 0
        ? undefined
        : `Keyboard shortcuts updated; removed unavailable actions: ${droppedActions.join(", ")}.`,
    }),
    err: () => ({ bindings: defaultBindings(), notice: undefined }),
  })
}

export function useAppController(
  navigate: ShellNavigate = noopNavigate,
  contextTarget?: MessageContextTarget,
  searchRoute?: Extract<ShellRoute, { kind: "search" }>,
) {
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])
  const navigateShell = useCallback<ShellNavigate>((route, replace) => {
    navigateRef.current(route, replace)
  }, [])
  const [initialBindings] = useState<InitialBindings>(loadInitialBindings)
  const [initialTheme] = useState<InitialTheme>(loadInitialTheme)
  const [bindings, setBindings] = useState<KeyboardBindings>(initialBindings.bindings)
  const [storageNotice, setStorageNotice] = useState<string | undefined>(initialBindings.notice ?? initialTheme.notice)
  const clearStorageNotice = useCallback((): void => setStorageNotice(undefined), [])
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialTheme.mode)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const toggleSidebar = useCallback(() => setSidebarHidden((hidden) => !hidden), [])
  const [prefersDark, setPrefersDark] = useState(prefersDarkTheme)
  const resolvedTheme = resolveTheme(themeMode, prefersDark)
  useLayoutEffect(() => {
    if (globalThis.document !== undefined) applyTheme(globalThis.document.documentElement, resolvedTheme)
  }, [resolvedTheme])
  useEffect(() => {
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  const [identity, setIdentity] = useState<StoredIdentity | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [authRevision, setAuthRevision] = useState(0)
  const authRevisionRef = useRef(0)
  const authRecoveryActiveRef = useRef(true)
  const authRecoveryAttemptedRef = useRef(false)
  const requestSessionRecovery = useCallback((requestRevision: number) => {
    if (requestRevision !== authRevisionRef.current || authRecoveryActiveRef.current) return
    authRecoveryActiveRef.current = true
    setIdentity(null)
    removeIdentity().match({
      ok: () => undefined,
      err: (error) => setStorageNotice(error.message),
    })
    if (authRecoveryAttemptedRef.current) {
      setSessionExpired(true)
      return
    }
    authRecoveryAttemptedRef.current = true
    const nextRevision = requestRevision + 1
    authRevisionRef.current = nextRevision
    setSessionExpired(false)
    setAuthRevision(nextRevision)
  }, [])
  const fallbackApi = useMemo<MsgrApi | undefined>(
    () => (import.meta.env?.DEV ? mockApi : undefined),
    [],
  )
  const onUnauthorized = useCallback(
    () => requestSessionRecovery(authRevision),
    [authRevision, requestSessionRecovery],
  )
  const api = useMemo(() => createBrowserApi(onUnauthorized), [onUnauthorized])
  const sessionApi = useMemo(() => createBrowserApi(), [])
  // The cookie is the credential. Browser storage only contains display metadata,
  // so every app load creates or reissues the operator session before protected
  // requests are enabled. A 401 advances the revision and runs the same flow once.
  useEffect(() => {
    let mounted = true
    authRecoveryActiveRef.current = true
    void autoIdentify(() => apiCall(sessionApi, fallbackApi, (client) => client.createHuman({ handle: AUTO_IDENTIFY_HANDLE }))).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ handle: registeredHandle }) => {
          const nextIdentity = identityForHandle(registeredHandle)
          setSessionExpired(false)
          setIdentity(nextIdentity)
          saveIdentity(nextIdentity).match({
            ok: () => undefined,
            err: (storageError) => setStorageNotice(storageError.message),
          })
        },
        err: () => setSessionExpired(true),
      })
      authRecoveryActiveRef.current = false
    })
    return () => {
      mounted = false
    }
  }, [authRevision, fallbackApi, sessionApi])
  const [focusedMessageId, setFocusedMessageId] = useState<number | undefined>()
  const [createChannelName, setCreateChannelName] = useState("")
  const [createChannelTopic, setCreateChannelTopic] = useState("")
  const [createChannelState, setCreateChannelState] = useState<CreateChannelState>({ status: "idle" })
  const [channelDeleteOpen, setChannelDeleteOpen] = useState(false)
  const [channelDeleteName, setChannelDeleteName] = useState<string | undefined>()
  const [channelDeleteConfirm, setChannelDeleteConfirm] = useState("")
  const [channelDeleteState, setChannelDeleteState] = useState<WorkspaceActionState>({ status: "idle" })
  const [channelPickerOpen, setChannelPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [membersPanelChannel, setMembersPanelChannel] = useState<string | undefined>()
  const [membersPanelMembers, setMembersPanelMembers] = useState<Member[]>([])
  const [membersPanelError, setMembersPanelError] = useState<string | undefined>()
  const [focusedChannelRow, setFocusedChannelRow] = useState<string | undefined>()
  const [memberHandle, setMemberHandle] = useState("")
  const [memberAddState, setMemberAddState] = useState<MemberAddState>({ status: "idle" })
  const [directRecipients, setDirectRecipients] = useState("")
  const [directBody, setDirectBody] = useState("")
  const [directState, setDirectState] = useState<DirectCreateState>({ status: "idle" })
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | undefined>()
  const [workspaceLabel, setWorkspaceLabel] = useState("")
  const [workspaceCwd, setWorkspaceCwd] = useState("")
  const [workspaceCreateState, setWorkspaceCreateState] = useState<WorkspaceActionState>({ status: "idle" })
  const [workspaceDirectoryPickerState, setWorkspaceDirectoryPickerState] = useState<WorkspaceDirectoryPickerState>({ status: "closed" })
  const [workspaceCloseOpen, setWorkspaceCloseOpen] = useState(false)
  const [workspaceCloseId, setWorkspaceCloseId] = useState<string | undefined>()
  const [workspaceCloseConfirm, setWorkspaceCloseConfirm] = useState("")
  const [workspaceCloseState, setWorkspaceCloseState] = useState<WorkspaceActionState>({ status: "idle" })
  const [workspaceBroadcastOpen, setWorkspaceBroadcastOpen] = useState(false)
  const [workspaceBroadcastId, setWorkspaceBroadcastId] = useState<string | undefined>()
  const [workspaceBroadcastBody, setWorkspaceBroadcastBody] = useState("")
  const [workspaceBroadcastState, setWorkspaceBroadcastState] = useState<WorkspaceActionState>({ status: "idle" })
  const [workspaceHistoryChannels, setWorkspaceHistoryChannels] = useState<Map<string, string>>(new Map())
  const [roles, setRoles] = useState<RolePreset[]>([])
  const [spawnAgentState, setSpawnAgentState] = useState<SpawnAgentState>({ status: "idle" })
  const [spawnAgentPaneId, setSpawnAgentPaneId] = useState<string | undefined>()
  const [spawnAgentAssignedHandle, setSpawnAgentAssignedHandle] = useState<string | undefined>()
  const spawnAgentReturnFocusRef = useRef<{ element: HTMLElement; paneId?: string; workspaceId?: string } | null>(null)
  const restoreSpawnAgentFocus = useCallback(() => {
    const target = spawnAgentReturnFocusRef.current
    spawnAgentReturnFocusRef.current = null
    if (target === null) return
    const restore = (): void => {
      if (target.element.isConnected) {
        target.element.focus()
        return
      }
      const rows = target.workspaceId === undefined
        ? globalThis.document.querySelectorAll<HTMLElement>("[data-pane-id]")
        : globalThis.document.querySelectorAll<HTMLElement>("[data-workspace-id]")
      const row = [...rows].find((candidate) => target.workspaceId === undefined
        ? candidate.dataset.paneId === target.paneId
        : candidate.dataset.workspaceId === target.workspaceId)
      row?.querySelector<HTMLElement>("a, button")?.focus()
    }
    if (globalThis.requestAnimationFrame === undefined) {
      restore()
      return
    }
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(restore))
  }, [])
  const [stopAgentOpen, setStopAgentOpen] = useState(false)
  const [stopAgentPane, setStopAgentPane] = useState<HerdrPaneView | undefined>()
  const [stopAgentConfirm, setStopAgentConfirm] = useState("")
  const [stopAgentState, setStopAgentState] = useState<WorkspaceActionState>({ status: "idle" })
  const [closePaneOpen, setClosePaneOpen] = useState(false)
  const [closePaneTarget, setClosePaneTarget] = useState<HerdrPaneView | undefined>()
  const [closePaneConfirm, setClosePaneConfirm] = useState("")
  const [closePaneState, setClosePaneState] = useState<WorkspaceActionState>({ status: "idle" })
  const [connectPaneTarget, setConnectPaneTarget] = useState<ConnectPaneTarget | undefined>()
  const [connectPaneHandle, setConnectPaneHandle] = useState("")
  const [connectPaneState, setConnectPaneState] = useState<WorkspaceActionState>({ status: "idle" })
  const pendingInboxJumpRef = useRef<string | undefined>(undefined)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const attachmentPathRef = useRef<HTMLInputElement>(null)
  const composer = useComposerState()
  const directComposer = useComposerState()
  const {
    addAttachmentPath,
    addUploadPlaceholder,
    attachmentInputOpen,
    attachmentPathInput,
    attachments,
    draft,
    handleAttachmentInputChange,
    markAttachmentErrors,
    markUploadError,
    markSent,
    removeAttachmentPath,
    setDraft,
    setStatus: setComposerStatus,
    setUploadProgress,
    status: composerState,
    toggleAttachmentInput,
    completeUpload,
  } = composer
  const handleComposerChange = useCallback((value: string) => {
    setDraft(value)
  }, [setDraft])
  const {
    addAttachmentPath: addDirectAttachmentPath,
    attachmentInputOpen: directAttachmentInputOpen,
    attachmentPathInput: directAttachmentPathInput,
    attachments: directAttachments,
    handleAttachmentInputChange: handleDirectAttachmentInputChange,
    markAttachmentErrors: markDirectAttachmentErrors,
    markSent: markDirectSent,
    removeAttachmentPath: removeDirectAttachmentPath,
    toggleAttachmentInput: toggleDirectAttachmentInput,
  } = directComposer
  const channelData = useChannelState(api, fallbackApi, identity, sessionExpired, onUnauthorized)
  const {
    activeChannel,
    appendChannel,
    channelState,
    directConversations,
    directState: directListState,
    inboxByChannel,
    inboxEntries,
    inboxState,
    membersByChannel,
    membersState,
    participants,
    participantsState,
    reload,
    reloadChannels,
    reloadKey,
    removeDirect,
    selectedChannel,
    selectedDirect,
    selectedCursorId,
    selectedInbox,
    selectedMembers,
    selectChannel: selectChannelState,
    updateMemberRouteStates,
    staleMemberCount,
    selectedChannelKind,
    isSelectedMember,
    noteDirectMessage,
    noteAcknowledged,
    setCursorId,
    staleChannels,
    unreadTotal,
  } = channelData
  const workspaceData = useHerdrWorkspaces(api, fallbackApi)
  const applyTopologySnapshot = workspaceData.onTopologySnapshot
  const onTopologySnapshot = useCallback((snapshot: WorkspaceList) => {
    applyTopologySnapshot(snapshot)
    if (selectedChannel !== undefined) {
      updateMemberRouteStates(selectedChannel, routeStatesFromTopology(snapshot))
    }
  }, [applyTopologySnapshot, selectedChannel, updateMemberRouteStates])
  useEffect(() => {
    let mounted = true
    void apiCall(api, fallbackApi, (client) => client.listRoles()).then((roleResult) => {
      if (!mounted) return
      roleResult.match({
        ok: ({ roles: available }) => setRoles(available),
        err: () => setRoles([]),
      })
    })
    return () => {
      mounted = false
    }
  }, [api, fallbackApi])

  const selectChannel = useCallback((channel: string | undefined, kind?: "chat" | "workspace" | "direct") => {
    setActiveWorkspaceId(undefined)
    selectChannelState(channel, kind)
  }, [selectChannelState])
  const openFocusedContextMenu = useCallback(() => {
    const activeElement = globalThis.document.activeElement
    const focusedPane = activeElement instanceof HTMLElement
      ? activeElement.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId
      : undefined
    if (focusedPane !== undefined) {
      globalThis.dispatchEvent(new CustomEvent("msgr:context-menu", { detail: { kind: "pane", paneId: focusedPane } }))
      return
    }
    const focusedWorkspace = activeElement instanceof HTMLElement
      ? activeElement.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId
      : undefined
    if (focusedWorkspace !== undefined) {
      globalThis.dispatchEvent(new CustomEvent("msgr:context-menu", { detail: { kind: "workspace", workspaceId: focusedWorkspace } }))
      return
    }
    const channel = focusedChannelRow ?? selectedChannel
    if (channel === undefined) {
      setStorageNotice("Focus a channel row before opening its menu.")
      return
    }
    globalThis.dispatchEvent(new CustomEvent("msgr:context-menu", { detail: { channel, kind: "channel" } }))
  }, [focusedChannelRow, selectedChannel])
  const openMembers = useCallback((channel = selectedChannel) => {
    if (channel === undefined) {
      setStorageNotice("Select a channel before opening members.")
      return
    }
    setMembersPanelChannel(channel)
    setMembersOpen(true)
    setMemberAddState({ status: "idle" })
    setMembersPanelError(undefined)
    void apiCall(api, fallbackApi, (client) => client.listMembers(channel)).then((result) => {
      result.match({
        ok: ({ members }) => setMembersPanelMembers(members),
        err: (error) => setMembersPanelError(formatApiError(error)),
      })
    })
  }, [api, fallbackApi, selectedChannel])
  const openStaleMembers = useCallback(() => {
    openMembers(staleChannels[0])
  }, [openMembers, staleChannels])

  const markChannelRead = useCallback((channel: string) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    void apiCall(api, fallbackApi, (client) => client.listMessages(channel)).then((result) => {
      result.match({
        ok: ({ messages }) => {
          const latest = messages.at(-1)
          if (latest === undefined) return
          void apiCall(api, fallbackApi, (client) => client.acknowledge(channel, { throughId: latest.id })).then((ack) => {
            ack.match({
              ok: ({ cursorId }) => noteAcknowledged(channel, cursorId),
              err: (error) => setStorageNotice(formatApiError(error)),
            })
          })
        },
        err: (error) => setStorageNotice(formatApiError(error)),
      })
    })
  }, [api, fallbackApi, identity, noteAcknowledged])

  const leaveChannel = useCallback((channel: string) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    void apiCall(api, fallbackApi, (client) => client.removeMember(channel, identity.handle)).then((result) => {
      result.match({
        ok: () => reload(),
        err: (error) => setStorageNotice(formatApiError(error)),
      })
    })
  }, [api, fallbackApi, identity, reload])

  const openDeleteChannel = useCallback((channel: string) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setChannelDeleteName(channel)
    setChannelDeleteConfirm("")
    setChannelDeleteState({ status: "idle" })
    setChannelDeleteOpen(true)
  }, [identity])

  const handleChannelDeleteSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const channel = channelDeleteName
    if (channel === undefined || channelDeleteConfirm !== channel) return
    if (identity === null) {
      setChannelDeleteOpen(false)
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    const deletingDirect = directConversations.some((conversation) => conversation.channel === channel)
    setChannelDeleteState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.deleteChannel(channel, { confirm: channelDeleteConfirm })).then((result) => {
      result.match({
        ok: ({ name }) => {
          setChannelDeleteOpen(false)
          setChannelDeleteName(undefined)
          setChannelDeleteConfirm("")
          setChannelDeleteState({ status: "idle" })
          if (deletingDirect) removeDirect(name)
          if (selectedChannel === name) {
            selectChannel(undefined)
            setFocusedMessageId(undefined)
            navigateShell({ kind: deletingDirect ? "direct" : "channels" })
          }
          reload()
        },
        err: (error) => setChannelDeleteState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, channelDeleteConfirm, channelDeleteName, directConversations, fallbackApi, identity, navigateShell, reload, removeDirect, selectedChannel, selectChannel])

  const copyChannelName = useCallback((channel: string) => {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) {
      setStorageNotice("Clipboard access is not available.")
      return
    }
    void Result.tryPromise<void, ApiNetworkError>({
      try: () => clipboard.writeText(channel),
      catch: (cause) => new ApiNetworkError({ cause, message: "The channel name could not be copied." }),
    }).then((result) => result.match({
      ok: () => setStorageNotice(channel.startsWith("dm-") || channel.startsWith("ws-") ? "Copied channel name." : `Copied #${channel}.`),
      err: (error) => setStorageNotice(formatApiError(error)),
    }))
  }, [])
  const activeDirect = selectedDirect
  const recoverFromStream = useCallback(() => {
    if (!sessionExpired) reloadChannels()
  }, [reloadChannels, sessionExpired])
  const noteIncomingMessage = useCallback((message: Message) => {
    noteDirectMessage(message.channel, message.sender, identity?.handle)
  }, [identity?.handle, noteDirectMessage])
  const {
    selectedMessages,
    messageState,
    mergeChannelMessages,
    receiptUpdates,
    receiptUpdatesChannel,
    receiptReloadKey,
    streamState,
  } = useLiveMessages(
    api,
    fallbackApi,
    selectedChannel,
    reloadKey,
    recoverFromStream,
    noteIncomingMessage,
    onUnauthorized,
    sessionExpired,
    {
      onTopologyDegraded: workspaceData.onTopologyDegraded,
      onTopologyError: workspaceData.onTopologyError,
      onTopologyOpen: workspaceData.onTopologyOpen,
      onTopologySnapshot,
      contextTarget,
    },
  )
  useEffect(() => {
    const pending = pendingInboxJumpRef.current
    if (pending === undefined || pending !== selectedChannel || selectedMessages.length === 0) return
    const unreadCount = selectedInbox?.unread ?? 0
    const cursorId = selectedCursorId ?? selectedInbox?.cursorId
    const target = unreadCount > 0 && cursorId !== undefined
      ? selectedMessages.find((message) => message.id > cursorId)
      : unreadCount > 0
      ? selectedMessages.find((message) => message.sender !== identity?.handle)
      : selectedMessages.at(-1)
    if (target !== undefined) {
      setFocusedMessageId(target.id)
      pendingInboxJumpRef.current = undefined
    }
  }, [identity?.handle, selectedChannel, selectedCursorId, selectedInbox, selectedMessages])
  const ackScheduler = useMemo(
    () => createAckScheduler(api, fallbackApi, (channel, throughId) => {
      noteAcknowledged(channel, throughId)
    }),
    [api, fallbackApi, noteAcknowledged],
  )
  const effectiveFocusedMessageId = focusedMessageId !== undefined &&
    selectedMessages.some((message) => message.id === focusedMessageId)
    ? focusedMessageId
    : selectedMessages[0]?.id

  useEffect(() => () => ackScheduler.close(), [ackScheduler])

  const uploadSequenceRef = useRef(0)

  const uploadFiles = useCallback(
    (files: readonly File[]) => {
      const remaining = Math.max(16 - attachments.length, 0)
      if (remaining === 0) {
        setComposerStatus({ message: "This message already has the maximum number of attachments.", status: "error" })
        return
      }
      for (const file of files.slice(0, remaining)) {
        const uploadKey = `upload:${uploadSequenceRef.current}:${file.name}`
        uploadSequenceRef.current += 1
        addUploadPlaceholder(uploadKey, file.name)
        void apiCall(api, fallbackApi, (client) =>
          client.uploadFile(file, file.name, ({ loaded, total }) => {
            const progress = total === 0 ? 0 : Math.round((loaded / total) * 100)
            setUploadProgress(uploadKey, progress)
          }),
        ).then((result) => {
          result.match({
            ok: ({ path }) => completeUpload(uploadKey, path),
            err: (error) => markUploadError(uploadKey, formatApiError(error)),
          })
        })
      }
      if (files.length > remaining) {
        setComposerStatus({ message: `Only ${remaining} attachment${remaining === 1 ? "" : "s"} added; the message cap is 16.`, status: "error" })
      }
    },
    [addUploadPlaceholder, api, attachments.length, completeUpload, fallbackApi, markUploadError, setComposerStatus, setUploadProgress],
  )

  const handleDropFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return
      if (identity === null) {
        setComposerStatus({ message: NOT_CONNECTED_REASON, status: "error" })
        return
      }
      uploadFiles(files)
    },
    [identity, setComposerStatus, uploadFiles],
  )

  useEffect(() => {
    if (attachmentInputOpen) attachmentPathRef.current?.focus()
  }, [attachmentInputOpen])

  const searchChannelKind = useCallback((channel: string): "chat" | "workspace" | "direct" => {
    if (directConversations.some((conversation) => conversation.channel === channel)) return "direct"
    if ([...workspaceData.workspaceChannelsById.values()].includes(channel)) return "workspace"
    return "chat"
  }, [directConversations, workspaceData.workspaceChannelsById])

  const search = useSearch(
    api,
    fallbackApi,
    selectedChannel,
    navigateShell,
    searchChannelKind,
    searchRoute,
  )

  const postMessage = useCallback(
    (body: string) => {
      const normalized = body.trim()
      if (normalized.length === 0) {
        setComposerStatus({ message: "Write a message before sending.", status: "error" })
        return
      }
      if (selectedChannel === undefined) {
        setComposerStatus({ message: "Select a channel before sending.", status: "error" })
        return
      }
      const blockedAttachment = attachments.find(
        (attachment) => attachment.status !== "ready" || attachment.error !== undefined,
      )
      if (blockedAttachment !== undefined) {
        setComposerStatus({ message: "Wait for uploads to finish and fix attachment errors before sending.", status: "error" })
        return
      }
      setComposerStatus({ status: "sending" })
      const send = (client: MsgrApi) => client.sendMessage(selectedChannel, {
        attachments: attachments.map((attachment) => attachment.path),
        body: normalized,
      })
      const sendResult = selectedChannelKind === "chat" && !isSelectedMember
        ? apiCall(api, fallbackApi, (client) => client.joinChannel(selectedChannel)).then((joined) => joined.andThenAsync(({ cursorId }) => {
          setCursorId(selectedChannel, cursorId)
          return apiCall(api, fallbackApi, send)
        }))
        : apiCall(api, fallbackApi, send)
      void sendResult.then((result) => {
        result.match({
          ok: (message) => {
            mergeChannelMessages(selectedChannel, [message])
            markSent()
          },
          err: (error) => {
            const message = formatApiError(error)
            markAttachmentErrors(message)
            setComposerStatus({ message, status: "error" })
          },
        })
      })
    },
    [api, attachments, fallbackApi, isSelectedMember, markAttachmentErrors, markSent, mergeChannelMessages, selectedChannel, selectedChannelKind, setComposerStatus, setCursorId],
  )

  const joinChannel = useCallback((channel: string) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    void apiCall(api, fallbackApi, (client) => client.joinChannel(channel)).then((result) => {
      result.match({
        ok: ({ cursorId }) => {
          setCursorId(channel, cursorId)
          reload()
        },
        err: (error) => setComposerStatus({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, fallbackApi, identity, reload, setComposerStatus, setCursorId, setStorageNotice])

  const joinSelectedChannel = useCallback(() => {
    if (selectedChannel === undefined || selectedChannelKind !== "chat" || isSelectedMember) return
    joinChannel(selectedChannel)
  }, [isSelectedMember, joinChannel, selectedChannel, selectedChannelKind])

  const openInboxChannel = useCallback((channel: string, kind: "chat" | "direct" | "workspace") => {
    pendingInboxJumpRef.current = channel
    selectChannel(channel, kind)
    setInboxOpen(false)
    switch (kind) {
      case "chat":
        navigateShell({ channel, kind: "channel" })
        break
      case "direct":
        navigateShell({ channel, kind: "conversation" })
        break
      case "workspace":
        navigateShell({ kind: "current" })
        break
    }
  }, [navigateShell, selectChannel])

  const handleAttachmentInputSubmit = useCallback(() => addAttachmentPath(), [addAttachmentPath])

  const submitComposer = useCallback(() => {
    if (identity === null) {
      setComposerStatus({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    postMessage(draft)
  }, [draft, identity, postMessage, setComposerStatus])

  const handleComposerSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitComposer()
    },
    [submitComposer],
  )

  const startDirect = useCallback((handle?: string) => {
    setMembersOpen(false)
    setDirectRecipients(handle ?? "")
    setDirectBody("")
    markDirectSent()
    setDirectState({ status: "idle" })
    navigateShell({ kind: "create-direct" })
  }, [markDirectSent, navigateShell])

  const handleDirectSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const recipients = [...new Set(directRecipients.split(",").map((handle) => handle.trim()).filter((handle) => handle.length > 0))]
      const body = directBody.trim()
      if (recipients.length === 0) {
        setDirectState({ message: "Enter at least one recipient handle.", status: "error" })
        return
      }
      if (body.length === 0) {
        setDirectState({ message: "Write a message before sending.", status: "error" })
        return
      }
      if (identity === null) {
        setDirectState({ message: NOT_CONNECTED_REASON, status: "error" })
        return
      }
      setDirectState({ status: "creating" })
      void apiCall(api, fallbackApi, (client) =>
        client.createDirect({
          attachments: directAttachments.map((attachment: AttachmentPath) => attachment.path),
          body,
          to: recipients,
        }),
      ).then((result) => {
        result.match({
          ok: ({ channel }) => {
            setDirectState({ status: "idle" })
            setDirectRecipients("")
            setDirectBody("")
            markDirectSent()
            selectChannel(channel, "direct")
            setFocusedMessageId(undefined)
            reload()
            navigateShell({ channel, kind: "conversation" })
          },
          err: (error) => {
            const message = formatApiError(error)
            markDirectAttachmentErrors(message)
            setDirectState({ message, status: "error" })
          },
        })
      })
    },
    [api, directAttachments, directBody, directRecipients, fallbackApi, identity, markDirectAttachmentErrors, markDirectSent, navigateShell, reload, selectChannel],
  )

  const openCreateChannel = useCallback(() => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setCreateChannelState({ status: "idle" })
    navigateShell({ kind: "create-channel" })
  }, [identity, navigateShell])

  const openWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId)
  }, [])

  const openCreateWorkspace = useCallback(() => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceCreateState({ status: "idle" })
    setWorkspaceDirectoryPickerState({ status: "closed" })
    navigateShell({ kind: "create-workspace" })
  }, [identity, navigateShell])

  const browseWorkspaceDirectory = useCallback((path?: string) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceDirectoryPickerState({ path, status: "loading" })
    void apiCall(api, fallbackApi, (client) => client.listDirectories(path)).then((result) => {
      result.match({
        ok: (listing) => setWorkspaceDirectoryPickerState({ listing, status: "ready" }),
        err: (error) => setWorkspaceDirectoryPickerState({ message: formatApiError(error), path, status: "error" }),
      })
    })
  }, [api, fallbackApi, identity])

  const openWorkspaceDirectoryPicker = useCallback(() => {
    browseWorkspaceDirectory()
  }, [browseWorkspaceDirectory])

  const closeWorkspaceDirectoryPicker = useCallback(() => {
    setWorkspaceDirectoryPickerState({ status: "closed" })
  }, [])

  const chooseWorkspaceDirectory = useCallback(() => {
    if (workspaceDirectoryPickerState.status !== "ready") return
    setWorkspaceCwd(workspaceDirectoryPickerState.listing.currentPath)
    setWorkspaceDirectoryPickerState({ status: "closed" })
  }, [workspaceDirectoryPickerState])

  const openCloseWorkspace = useCallback((workspaceId: string) => {
    if (identity === null) {
      setWorkspaceCloseId(workspaceId)
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceCloseId(workspaceId)
    setWorkspaceCloseConfirm("")
    setWorkspaceCloseState({ status: "idle" })
    setWorkspaceCloseOpen(true)
  }, [identity])

  const openWorkspaceBroadcast = useCallback((workspaceId?: string) => {
    const target = workspaceId ?? activeWorkspaceId
    if (target === undefined) {
      setStorageNotice("Open a workspace before broadcasting.")
      return
    }
    setWorkspaceBroadcastId(target)
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceBroadcastBody("")
    setWorkspaceBroadcastState({ status: "idle" })
    setWorkspaceBroadcastOpen(true)
  }, [activeWorkspaceId, identity])

  const broadcastFocusedWorkspace = useCallback(() => {
    const activeElement = globalThis.document.activeElement
    const workspaceId = activeElement instanceof HTMLElement
      ? activeElement.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId
      : undefined
    openWorkspaceBroadcast(workspaceId)
  }, [openWorkspaceBroadcast])

  const openSpawnAgent = useCallback((workspaceId?: string, mode: SpawnAgentMode = "spawn-agent") => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    if (mode === "add-reporter" && !roles.some((role) => role.name === "reporter")) {
      setStorageNotice("The hub does not publish a reporter role.")
      return
    }
    const focusedWorkspace = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId
      : undefined
    const target = workspaceId ?? focusedWorkspace ?? activeWorkspaceId
    const destination = spawnAgentDestination(mode, target)
    if (destination === undefined) {
      setStorageNotice("Open a workspace before adding a reporter.")
      return
    }
    const opener = globalThis.document.activeElement
    const paneRow = opener instanceof HTMLElement ? opener.closest<HTMLElement>("[data-pane-id]") : null
    const workspaceRow = opener instanceof HTMLElement ? opener.closest<HTMLElement>("[data-workspace-id]") : null
    spawnAgentReturnFocusRef.current = opener instanceof HTMLElement
      ? {
          element: opener,
          paneId: paneRow?.dataset.paneId,
          workspaceId: workspaceRow?.dataset.workspaceId,
        }
      : null
    setSpawnAgentPaneId(undefined)
    setSpawnAgentAssignedHandle(undefined)
    setSpawnAgentState({ status: "idle" })
    navigate(destination)
  }, [activeWorkspaceId, identity, navigate, roles])

  const openAddReporter = useCallback((workspaceId: string) => {
    openSpawnAgent(workspaceId, "add-reporter")
  }, [openSpawnAgent])

  useEffect(() => {
    if (spawnAgentState.status !== "awaiting-topology" || spawnAgentPaneId === undefined || spawnAgentAssignedHandle === undefined) return
    const pane = workspaceData.workspaces
      .flatMap((workspace) => workspace.panes)
      .find((candidate) => candidate.paneId === spawnAgentPaneId)
    if (pane === undefined || pane.participant !== spawnAgentAssignedHandle) return
    setSpawnAgentState({ status: "idle" })
    setSpawnAgentPaneId(undefined)
    setSpawnAgentAssignedHandle(undefined)
    setStorageNotice(`Started ${pane.participant}.`)
  }, [spawnAgentAssignedHandle, spawnAgentPaneId, spawnAgentState.status, workspaceData.workspaces])

  const openStopAgent = useCallback((pane: HerdrPaneView) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    const confirm = paneStopConfirmation(pane)
    if (pane.agentKind === null || confirm === null || confirm.length === 0) return
    setStopAgentPane(pane)
    setStopAgentConfirm("")
    setStopAgentState({ status: "idle" })
    setStopAgentOpen(true)
  }, [identity])

  const openConnectPane = useCallback((pane: HerdrPaneView, label = paneIdentity(pane)) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    if (pane.agentKind === null) return
    setConnectPaneTarget({ label, pane })
    setConnectPaneHandle(suggestedPaneHandle(label, pane.paneId))
    setConnectPaneState({ status: "idle" })
  }, [identity])

  const closeConnectPane = useCallback(() => {
    setConnectPaneTarget(undefined)
    setConnectPaneHandle("")
    setConnectPaneState({ status: "idle" })
  }, [])

  const handleConnectPaneSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = connectPaneTarget
    const handle = connectPaneHandle.trim()
    if (target === undefined || handle.length === 0 || identity === null) return
    setConnectPaneState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.connectAgent(target.pane.paneId, { handle })).then((result) => result.match({
      ok: (connected) => {
        closeConnectPane()
        workspaceData.reloadWorkspaces()
        setStorageNotice(`${connected.handle} is connected to Sheppard chat.`)
        navigateShell({ handle: connected.handle, kind: "agent" })
      },
      err: (error) => setConnectPaneState({ message: formatApiError(error), status: "error" }),
    }))
  }, [api, closeConnectPane, connectPaneHandle, connectPaneTarget, fallbackApi, identity, navigateShell, workspaceData])

  const openClosePane = useCallback((pane: HerdrPaneView) => {
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    if (pane.agentKind !== null || pane.label === null || pane.label.length === 0) return
    setClosePaneTarget(pane)
    setClosePaneConfirm("")
    setClosePaneState({ status: "idle" })
    setClosePaneOpen(true)
  }, [identity])

  const handleStopAgentSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const pane = stopAgentPane
    if (pane === undefined) return
    setStopAgentState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.stopAgent(pane.paneId, { confirm: stopAgentConfirm })).then((result) => {
      result.match({
        ok: () => {
          setStopAgentOpen(false)
          setStopAgentState({ status: "idle" })
          setStopAgentConfirm("")
          setStopAgentPane(undefined)
          workspaceData.reloadWorkspaces()
        },
        err: (error) => setStopAgentState({ message: formatApiError(error, { lifecycleExpected: paneStopConfirmation(pane) ?? undefined }), status: "error" }),
      })
    })
  }, [api, fallbackApi, stopAgentConfirm, stopAgentPane, workspaceData])

  const handleClosePaneSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const pane = closePaneTarget
    if (pane === undefined) return
    setClosePaneState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.stopAgent(pane.paneId, { confirm: closePaneConfirm })).then((result) => {
      result.match({
        ok: () => {
          setClosePaneOpen(false)
          setClosePaneState({ status: "idle" })
          setClosePaneConfirm("")
          setClosePaneTarget(undefined)
          workspaceData.reloadWorkspaces()
        },
        err: (error) => setClosePaneState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, closePaneConfirm, closePaneTarget, fallbackApi, workspaceData])

  const handleWorkspaceCreateSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (identity === null) {
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceCreateState({ status: "working" })
    const label = workspaceLabel.trim()
    const cwd = workspaceCwd.trim()
    void apiCall(api, fallbackApi, (client) => client.createWorkspace({
      cwd: cwd.length === 0 ? undefined : cwd,
      label: label.length === 0 ? undefined : label,
    })).then((result) => {
      result.match({
        ok: (workspace) => {
          setWorkspaceCreateState({ status: "idle" })
          setWorkspaceLabel("")
          setWorkspaceCwd("")
          setActiveWorkspaceId(workspace.id)
          workspaceData.reloadWorkspaces()
          navigateShell({ kind: "workspace", workspaceId: workspace.id })
        },
        err: (error) => setWorkspaceCreateState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, fallbackApi, identity, navigateShell, workspaceCwd, workspaceData, workspaceLabel])

  const handleWorkspaceCloseSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const workspaceId = workspaceCloseId
    if (workspaceId === undefined) return
    if (identity === null) {
      setWorkspaceCloseOpen(false)
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    setWorkspaceCloseState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.closeWorkspace(workspaceId, { confirm: workspaceCloseConfirm })).then((result) => {
      result.match({
        ok: () => {
          setWorkspaceCloseOpen(false)
          setWorkspaceCloseState({ status: "idle" })
          setWorkspaceCloseConfirm("")
          if (activeWorkspaceId === workspaceId) setActiveWorkspaceId(undefined)
          workspaceData.reloadWorkspaces()
        },
        err: (error) => setWorkspaceCloseState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [activeWorkspaceId, api, fallbackApi, identity, workspaceCloseConfirm, workspaceCloseId, workspaceData])

  const handleWorkspaceBroadcastSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const workspaceId = workspaceBroadcastId
    const body = workspaceBroadcastBody.trim()
    if (workspaceId === undefined || body.length === 0) {
      setWorkspaceBroadcastState({ message: "Write a broadcast before sending.", status: "error" })
      return
    }
    if (identity === null) {
      setWorkspaceBroadcastOpen(false)
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    const workspace = workspaceData.workspaces.find((candidate) => candidate.id === workspaceId)
    const unmanagedAgents = workspace === undefined ? 0 : unmanagedAgentCount(workspace)
    const unmanagedNotice = unmanagedAgents === 0
      ? undefined
      : `${unmanagedAgents} Herdr agent pane${unmanagedAgents === 1 ? " has" : "s have"} no chat identity. The broadcast cannot address ${unmanagedAgents === 1 ? "this pane" : "these panes"}.`
    setWorkspaceBroadcastState({ status: "working" })
    void apiCall(api, fallbackApi, (client) => client.broadcastWorkspace(workspaceId, { body })).then((result) => {
      result.match({
        ok: ({ channel, recipients }) => {
          setWorkspaceBroadcastOpen(false)
          setWorkspaceBroadcastState({ status: "idle" })
          setWorkspaceBroadcastBody("")
          setWorkspaceHistoryChannels((current) => new Map(current).set(workspaceId, channel))
          setActiveWorkspaceId(workspaceId)
          setStorageNotice(recipients.length === 0
            ? unmanagedNotice === undefined
              ? "The message is stored but nobody was notified."
              : `The message is stored; ${unmanagedNotice}`
            : unmanagedNotice === undefined
              ? `Sent to ${recipients.length} agent${recipients.length === 1 ? "" : "s"}.`
              : `Sent to ${recipients.length} routed agent${recipients.length === 1 ? "" : "s"}; ${unmanagedNotice}`)
          reload()
        },
        err: (error) => setWorkspaceBroadcastState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, fallbackApi, identity, reload, setStorageNotice, workspaceBroadcastBody, workspaceBroadcastId, workspaceData.workspaces])

  const memberCandidates = useMemo(() => {
    const currentHandles = new Set(membersPanelMembers.map((member) => member.handle))
    return participants
      .filter((participant) => !currentHandles.has(participant.handle))
      .sort((left, right) => left.handle.localeCompare(right.handle))
  }, [membersPanelMembers, participants])

  const handleMemberAdd = useCallback((candidateHandle?: string) => {
    const handle = (candidateHandle ?? memberHandle).trim()
    if (handle.length === 0) {
      setMemberAddState({ message: "Choose a participant.", status: "error" })
      return
    }
    if (identity === null) {
      setMembersOpen(false)
      setStorageNotice(NOT_CONNECTED_REASON)
      return
    }
    if (membersPanelChannel === undefined) {
      setMemberAddState({ message: "Select a channel before adding a participant.", status: "error" })
      return
    }
    setMemberAddState({ status: "adding" })
    void apiCall(api, fallbackApi, (client) => client.addMember(membersPanelChannel, handle)).then((result) => {
      result.match({
        ok: () => {
          setMemberHandle("")
          setMemberAddState({ status: "idle" })
          openMembers(membersPanelChannel)
          reload()
        },
        err: (error) => setMemberAddState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, fallbackApi, identity, memberHandle, membersPanelChannel, openMembers, reload])

  const startDirectFromFocusedMessage = useCallback(() => {
    const message = selectedMessages.find((candidate) => candidate.id === effectiveFocusedMessageId)
    if (message === undefined) {
      startDirect()
      return
    }
    if (message.sender === identity?.handle) {
      setStorageNotice("Focus a message from another participant first.")
      return
    }
    if (!participants.some((participant) => participant.handle === message.sender)) {
      setStorageNotice(`${message.sender} is deactivated. The message history remains readable.`)
      return
    }
    startDirect(message.sender)
  }, [effectiveFocusedMessageId, identity?.handle, participants, selectedMessages, startDirect])

  const handleCreateChannelSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const name = createChannelName.trim()
      const topic = createChannelTopic.trim()
      if (name.length === 0) {
        setCreateChannelState({ status: "error", message: "Enter a channel name." })
        return
      }
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) {
        setCreateChannelState({
          message: "That channel name is not allowed. Use lowercase letters, digits, - or _. Start with a letter. Keep it to 32 characters.",
          status: "error",
        })
        return
      }
      if (identity === null) {
        setStorageNotice(NOT_CONNECTED_REASON)
        return
      }
      setCreateChannelState({ status: "creating" })
      void apiCall(api, fallbackApi, (client) =>
        client.createChannel({ name, topic: topic.length === 0 ? undefined : topic }),
      ).then((result) => {
        result.match({
          ok: (channel) => {
            appendChannel(channel)
            selectChannel(channel.name)
            void apiCall(api, fallbackApi, (client) => client.joinChannel(channel.name)).then((joined) => {
              joined.match({
                ok: () => {
                  setCreateChannelState({ status: "idle" })
                  setCreateChannelName("")
                  setCreateChannelTopic("")
                  reload()
                  navigateShell({ channel: channel.name, kind: "channel" })
                },
                err: (error) => setCreateChannelState({ status: "error", message: formatApiError(error) }),
              })
            })
          },
          err: (error) => setCreateChannelState({ status: "error", message: formatApiError(error) }),
        })
      })
    },
    [api, appendChannel, createChannelName, createChannelTopic, fallbackApi, identity, navigateShell, reload, selectChannel],
  )

  const moveChannel = useCallback(
    (direction: 1 | -1) => {
      const entries = [
        ...(channelState.status === "ready" ? channelState.channels.map((channel) => ({ kind: "chat" as const, name: channel.name })) : []),
        ...directConversations.map((conversation) => ({ kind: "direct" as const, name: conversation.channel })),
      ]
      if (entries.length === 0) return
      const currentIndex = entries.findIndex((entry) => entry.name === selectedChannel)
      const nextIndex = currentIndex < 0
        ? 0
        : (currentIndex + direction + entries.length) % entries.length
      const nextChannel = entries[nextIndex]
      if (nextChannel === undefined) return
      selectChannel(nextChannel.name, nextChannel.kind)
      setFocusedMessageId(undefined)
    },
    [channelState, directConversations, selectChannel, selectedChannel],
  )

  const {
    query: searchQuery,
    searchActive,
    searchScope,
    searchState,
    results: searchResults,
    selectedResultId,
    contextError,
    contextLoadingId,
    searchNotice,
    submittedQuery: searchSubmitted,
    runSearch,
    setSearchQuery,
    setSearchScope,
    openSearchResult,
    clearSearch,
    toggleSearchScope,
  } = search

  const openChannelContext = useCallback((channel: string, messageId: number, kind: "chat" | "workspace" | "direct") => {
    clearSearch()
    selectChannel(channel, kind)
    setFocusedMessageId(messageId)
  }, [clearSearch, selectChannel])

  const moveMessageFocus = useCallback(
    (direction: 1 | -1) => {
      if (selectedMessages.length === 0) {
        setStorageNotice("There are no messages to focus.")
        return
      }
      const currentIndex = focusedMessageId === undefined
        ? -1
        : selectedMessages.findIndex((message) => message.id === focusedMessageId)
      const nextIndex = currentIndex < 0
        ? direction > 0 ? 0 : selectedMessages.length - 1
        : Math.min(Math.max(currentIndex + direction, 0), selectedMessages.length - 1)
      const nextMessage = selectedMessages[nextIndex]
      if (nextMessage !== undefined) setFocusedMessageId(nextMessage.id)
    },
    [focusedMessageId, selectedMessages],
  )

  const jumpToUnread = useCallback(() => {
    if (selectedMessages.length === 0) return
    const unreadCount = selectedInbox?.unread ?? 0
    const cursorId = selectedCursorId ?? selectedInbox?.cursorId
    const message = cursorId !== undefined
      ? selectedMessages.find((candidate) => candidate.id > cursorId)
      : unreadCount > 0
      ? selectedMessages.find((candidate) => candidate.sender !== identity?.handle)
      : undefined
    if (message !== undefined) {
      setFocusedMessageId(message.id)
      return
    }
    setStorageNotice("There are no unread messages in this channel.")
  }, [identity?.handle, selectedCursorId, selectedInbox, selectedMessages])

  const jumpToLatest = useCallback(() => {
    const message = selectedMessages[selectedMessages.length - 1]
    if (message !== undefined) setFocusedMessageId(message.id)
  }, [selectedMessages])

  const focusedAttachmentAction = useCallback(
    (action: "copy" | "view") => {
      const message = selectedMessages.find((candidate) => candidate.id === effectiveFocusedMessageId)
      const row = message === undefined ? undefined : globalThis.document.getElementById(`message-${message.id}`)
      const activeAttachmentId = row === undefined || !(globalThis.document.activeElement instanceof HTMLElement)
        ? undefined
        : globalThis.document.activeElement.closest<HTMLElement>("[data-attachment-id]")?.dataset.attachmentId
      const focusedAttachment = activeAttachmentId === undefined
        ? undefined
        : message?.attachments.find((candidate) => String(candidate.id) === activeAttachmentId)
      const attachment = action === "view"
        ? focusedAttachment ?? message?.attachments.find((candidate) => candidate.previewEligible && (candidate.previewKind === "image" || candidate.previewKind === "markdown"))
        : focusedAttachment ?? message?.attachments[0]
      if (message === undefined || attachment === undefined) {
        setStorageNotice("The focused message has no attachment.")
        return
      }
      if (action === "view" && identity === null) {
        setStorageNotice(NOT_CONNECTED_REASON)
        return
      }
      if (action === "view" && (!attachment.previewEligible || (attachment.previewKind !== "image" && attachment.previewKind !== "markdown"))) {
        setStorageNotice("The focused attachment has no preview.")
        return
      }
      const attachmentSurface = activeAttachmentId === undefined
        ? row
        : [...(row?.querySelectorAll<HTMLElement>("[data-attachment-id]") ?? [])].find((candidate) => candidate.dataset.attachmentId === activeAttachmentId)
      const button = attachmentSurface?.querySelector<HTMLButtonElement>(`[data-attachment-action="${action}"]`)
      if (button === null || button === undefined) {
        setStorageNotice("The focused attachment action is not available.")
        return
      }
      button.click()
    },
    [effectiveFocusedMessageId, identity, selectedMessages],
  )

  const saveKeyboardBindings = useCallback((next: KeyboardBindings) => {
    if (bindingConflicts(next).size > 0) {
      setStorageNotice("Resolve duplicate keyboard bindings before saving.")
      return
    }
    saveBindings(next).match({
      ok: () => {
        setBindings(new Map(next))
        setStorageNotice("Keyboard bindings saved.")
      },
      err: (error) => setStorageNotice(error.message),
    })
  }, [])

  const saveThemePreference = useCallback((next: ThemeMode) => {
    saveThemeMode(next).match({
      ok: () => {
        setThemeMode(next)
        setStorageNotice("Theme preference saved.")
      },
      err: (error) => {
        setThemeMode(next)
        setStorageNotice(error.message)
      },
    })
  }, [])

  const closeTopOverlay = useCallback(() => {
    if (connectPaneTarget !== undefined) {
      closeConnectPane()
      return
    }
    if (stopAgentOpen) {
      setStopAgentOpen(false)
      return
    }
    if (closePaneOpen) {
      setClosePaneOpen(false)
      return
    }
    if (helpOpen) {
      setHelpOpen(false)
      return
    }
    if (membersOpen) {
      setMembersOpen(false)
      return
    }
    if (inboxOpen) {
      setInboxOpen(false)
      return
    }
    if (settingsOpen) {
      setSettingsOpen(false)
      return
    }
    if (channelPickerOpen) {
      setChannelPickerOpen(false)
      return
    }
    if (attachmentInputOpen) {
      toggleAttachmentInput()
      return
    }
    const active = globalThis.document.activeElement
    if (active instanceof HTMLElement) active.blur()
  }, [attachmentInputOpen, channelPickerOpen, closeConnectPane, closePaneOpen, connectPaneTarget, helpOpen, inboxOpen, membersOpen, settingsOpen, stopAgentOpen, toggleAttachmentInput])

  const openFocusedPaneAction = useCallback((action: "stop" | "close") => {
    const paneId = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId
      : undefined
    const pane = paneId === undefined
      ? undefined
      : workspaceData.workspaces.flatMap((workspace) => workspace.panes).find((candidate) => candidate.paneId === paneId)
    if (pane === undefined) {
      setStorageNotice("Focus a pane before using its lifecycle action.")
      return
    }
    if (action === "stop") openStopAgent(pane)
    else openClosePane(pane)
  }, [openClosePane, openStopAgent, workspaceData.workspaces])

  const actionHandlers = useMemo<Map<ActionName, () => void>>(
    () => new Map<ActionName, () => void>([
      ["sidebar.toggle", toggleSidebar],
      ["page.workspaces", () => navigateShell({ kind: "workspaces" })],
      ["page.channels", () => navigateShell({ kind: "channels" })],
      ["page.direct", () => navigateShell({ kind: "direct" })],
      ["page.agents", () => navigateShell({ kind: "agents" })],
      ["channel.next", () => moveChannel(1)],
      ["channel.prev", () => moveChannel(-1)],
      ["channel.picker", () => setChannelPickerOpen(true)],
      ["channel.members", () => openMembers(focusedChannelRow ?? selectedChannel)],
      ["menu.open", openFocusedContextMenu],
      ["channel.create", openCreateChannel],
      ["workspace.create", openCreateWorkspace],
      ["workspace.close", () => {
        if (activeWorkspaceId !== undefined) openCloseWorkspace(activeWorkspaceId)
        else setStorageNotice("Open a workspace before closing it.")
      }],
      ["workspace.broadcast", broadcastFocusedWorkspace],
      ["agent.spawn", () => openSpawnAgent()],
      ["agent.addReporter", () => {
        const workspaceId = globalThis.document.activeElement instanceof HTMLElement
          ? globalThis.document.activeElement.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId
          : activeWorkspaceId
        if (workspaceId !== undefined) openAddReporter(workspaceId)
        else setStorageNotice("Focus a workspace before adding a reporter.")
      }],
      ["agent.stop", () => openFocusedPaneAction("stop")],
      ["pane.close", () => openFocusedPaneAction("close")],
      ["search.focus", () => searchInputRef.current?.focus()],
      ["search.scopeToggle", toggleSearchScope],
      ["composer.focus", () => focusActiveComposer(() => composerRef.current)],
      ["composer.attach", toggleAttachmentInput],
      ["composer.send", submitComposer],
      ["composer.newline", () => undefined],
      ["message.focusNext", () => moveMessageFocus(1)],
      ["message.focusPrev", () => moveMessageFocus(-1)],
      ["message.dmAuthor", startDirectFromFocusedMessage],
      ["message.jumpUnread", jumpToUnread],
      ["message.jumpLatest", jumpToLatest],
      ["attachment.view", () => focusedAttachmentAction("view")],
      ["attachment.copyPath", () => focusedAttachmentAction("copy")],
      ["overlay.close", closeTopOverlay],
      ["help.show", () => setHelpOpen(true)],
      ["settings.open", () => setSettingsOpen(true)],
      ["inbox.open", () => setInboxOpen(true)],
      ["theme.cycle", () => saveThemePreference(nextThemeMode(themeMode))],
    ]),
    [
      closeTopOverlay,
      focusedAttachmentAction,
      jumpToLatest,
      jumpToUnread,
      moveChannel,
      moveMessageFocus,
      openFocusedContextMenu,
      openCreateChannel,
      startDirectFromFocusedMessage,
      submitComposer,
      toggleSidebar,
      toggleSearchScope,
      toggleAttachmentInput,
      activeWorkspaceId,
      openCloseWorkspace,
      openCreateWorkspace,
      broadcastFocusedWorkspace,
      openMembers,
      openAddReporter,
      openFocusedPaneAction,
      openSpawnAgent,
      focusedChannelRow,
      selectedChannel,
      composerRef,
      searchInputRef,
      setChannelPickerOpen,
      setHelpOpen,
      setInboxOpen,
      setSettingsOpen,
      setStorageNotice,
      navigateShell,
      saveThemePreference,
      themeMode,
    ],
  )
  const dispatchAction = useKeyboardDispatcher({
    actionHandlers,
    bindings,
    composerRef,
    onUnavailableAction: (action) => setStorageNotice(`Action ${action} is not available.`),
  })

  return {
    activeChannel,
    activeDirect,
    activeWorkspaceId,
    api,
    ackScheduler,
    attachmentInputOpen,
    attachmentPathInput,
    attachmentPathRef,
    attachments,
    bindings,
    themeMode,
    resolvedTheme,
    sidebarHidden,
    fallbackApi,
    channelPickerOpen,
    channelState,
    composerRef,
    composerState,
    createChannelName,
    createChannelState,
    createChannelTopic,
    directBody,
    directAttachmentInputOpen,
    directAttachmentPathInput,
    directAttachments,
    directRecipients,
    directState,
    directConversations,
    directListState,
    draft,
    dispatchAction,
    focusedMessageId,
    handleAttachmentInputChange,
    handleAttachmentInputSubmit,
    addDirectAttachmentPath,
    handleDirectAttachmentInputChange,
    removeDirectAttachmentPath,
    toggleDirectAttachmentInput,
    toggleSidebar,
    handleComposerSubmit,
    handleCreateChannelSubmit,
    handleChannelDeleteSubmit,
    handleDirectSubmit,
    handleWorkspaceBroadcastSubmit,
    handleWorkspaceCloseSubmit,
    handleWorkspaceCreateSubmit,
    markChannelRead,
    leaveChannel,
    openDeleteChannel,
    copyChannelName,
    helpOpen,
    identity,
    inboxByChannel,
    inboxEntries,
    inboxOpen,
    inboxState,
    membersState,
    membersByChannel,
    memberAddState,
    memberCandidates,
    memberHandle,
    membersOpen,
    membersPanelChannel,
    membersPanelMembers,
    membersPanelError,
    messageState,
    openChannelContext,
    openSearchResult,
    openSearch: search.openSearch,
    retrySearch: search.retrySearch,
    searchTruncated: search.searchTruncated,
    openInboxChannel,
    openMembers,
    openStaleMembers,
    contextError,
    contextLoadingId,
    searchSubmitted,
    removeAttachmentPath,
    reload,
    reloadChannels,
    runSearch,
    searchActive,
    searchInputRef,
    searchQuery,
    searchResults,
    selectedResultId,
    searchScope,
    searchState,
    searchNotice,
    selectedChannel,
    selectedChannelKind,
    selectedCursorId,
    selectedDirect,
    selectedInbox,
    selectedMembers,
    selectedMessages,
    receiptUpdates,
    receiptUpdatesChannel,
    receiptReloadKey,
    selectChannel,
    staleMemberCount,
    staleChannels,
    unreadTotal,
    isSelectedMember,
    joinChannel,
    joinSelectedChannel,
    participants,
    participantsState,
    setChannelPickerOpen,
    setCreateChannelName,
    setCreateChannelTopic,
    channelDeleteConfirm,
    channelDeleteName,
    channelDeleteOpen,
    channelDeleteState,
    setChannelDeleteConfirm,
    setChannelDeleteOpen,
    setDirectBody,
    setDirectRecipients,
    setFocusedMessageId,
    setCursorId,
    focusedChannelRow,
    setFocusedChannelRow,
    setHelpOpen,
    setInboxOpen,
    setMemberHandle,
    setMembersOpen,
    setSearchQuery,
    setSearchScope,
    setSettingsOpen,
    setWorkspaceBroadcastBody,
    setWorkspaceBroadcastOpen,
    setWorkspaceCloseConfirm,
    setWorkspaceCloseOpen,
    setWorkspaceCwd,
    setWorkspaceLabel,
    setDraft,
    settingsOpen,
    streamState,
    workspaceData,
    roles,
    spawnAgentState,
    setSpawnAgentState,
    setSpawnAgentPaneId,
    setSpawnAgentAssignedHandle,
    spawnAgentAssignedHandle,
    restoreSpawnAgentFocus,
    stopAgentOpen,
    stopAgentPane,
    stopAgentConfirm,
    stopAgentState,
    closePaneOpen,
    closePaneTarget,
    closePaneConfirm,
    closePaneState,
    connectPaneTarget,
    connectPaneHandle,
    connectPaneState,
    handleStopAgentSubmit,
    handleClosePaneSubmit,
    handleConnectPaneSubmit,
    openSpawnAgent,
    openAddReporter,
    openStopAgent,
    openClosePane,
    openConnectPane,
    closeConnectPane,
    setStopAgentConfirm,
    setStopAgentOpen,
    setClosePaneConfirm,
    setClosePaneOpen,
    setConnectPaneHandle,
    workspaceHistoryChannels,
    workspaceBroadcastBody,
    workspaceBroadcastId,
    workspaceBroadcastOpen,
    workspaceBroadcastState,
    workspaceCloseConfirm,
    workspaceCloseId,
    workspaceCloseOpen,
    workspaceCloseState,
    workspaceCreateState,
    workspaceCwd,
    workspaceLabel,
    workspaceDirectoryPickerState,
    browseWorkspaceDirectory,
    chooseWorkspaceDirectory,
    closeWorkspaceDirectoryPicker,
    openCloseWorkspace,
    openCreateWorkspace,
    openWorkspaceDirectoryPicker,
    openWorkspace,
    openWorkspaceBroadcast,
    handleComposerChange,
    storageNotice,
    clearStorageNotice,
    submitComposer,
    startDirect,
    handleDropFiles,
    handleMemberAdd,
    toggleSearchScope,
    unread: identity === null ? 0 : selectedDirect?.unread ?? selectedInbox?.unread ?? 0,
    saveKeyboardBindings,
    saveThemePreference,
  }
}

export type AppController = ReturnType<typeof useAppController>
