import { useCallback, useEffect, useMemo, useReducer } from "react"

import { apiCall } from "@/api/runtime"
import { formatApiError, type ApiError } from "@/api/errors"
import type { StoredIdentity } from "@/api/identity"
import type { Channel, ChannelKind, DirectConversation, InboxEntry, Member, MsgrApi, Participant, RouteState } from "@/api/types"
import { useSettledRouteStates, type RouteObservation } from "@/hooks/use-settled-route-state"

export type SelectedChannelKind = ChannelKind | "direct"

export type ChannelState =
  | { status: "loading" }
  | { status: "ready"; channels: Channel[]; errorMessage?: string }
  | { status: "error"; message: string }

export type MemberState =
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }

export type InboxState =
  | { status: "disabled" }
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }

export type ParticipantState =
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }

export type DirectState =
  | { status: "disabled" }
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }

interface ChannelDataState {
  channelState: ChannelState
  selectedChannel: string | undefined
  selectedChannelKind: SelectedChannelKind | undefined
  reloadKey: number
  channelReloadKey: number
  directConversations: DirectConversation[]
  directState: DirectState
  membersState: MemberState
  membersByChannel: Map<string, Member[]>
  cursorByChannel: Map<string, number>
  inboxState: InboxState
  inboxEntries: InboxEntry[]
  participants: Participant[]
  participantsState: ParticipantState
}

type ChannelDataAction =
  | { type: "channels.loading" }
  | { type: "channels.loaded"; channels: Channel[] }
  | { type: "channels.error"; message: string }
  | { type: "channel.select"; channel: string | undefined; kind?: SelectedChannelKind }
  | { type: "channel.add"; channel: Channel }
  | { type: "reload" }
  | { type: "reload.channels" }
  | { type: "direct.disabled" }
  | { type: "direct.loading" }
  | { type: "direct.loaded"; conversations: DirectConversation[] }
  | { type: "direct.removed"; channel: string }
  | { type: "message.incoming"; channel: string; sender: string; selfHandle?: string }
  | { type: "message.ack"; channel: string }
  | { type: "cursor.set"; channel: string; cursorId: number }
  | { type: "direct.error"; message: string }
  | { type: "members.loading" }
  | { type: "members.loaded"; channel: string; members: Member[] }
  | { type: "members.routeStates"; channel: string; routeStates: ReadonlyMap<string, RouteState> }
  | { type: "members.error"; message: string }
  | { type: "inbox.disabled" }
  | { type: "inbox.loading" }
  | { type: "inbox.loaded"; entries: InboxEntry[] }
  | { type: "inbox.error"; message: string }
  | { type: "participants.loading" }
  | { type: "participants.loaded"; participants: Participant[] }
  | { type: "participants.error"; message: string }

function initialChannelData(identity: StoredIdentity | null): ChannelDataState {
  return {
    channelReloadKey: 0,
    channelState: { status: "loading" },
    cursorByChannel: new Map(),
    directConversations: [],
    directState: identity === null ? { status: "disabled" } : { status: "loading" },
    inboxEntries: [],
    inboxState: identity === null ? { status: "disabled" } : { status: "loading" },
    membersByChannel: new Map(),
    membersState: { status: "loading" },
    participants: [],
    participantsState: { status: "loading" },
    reloadKey: 0,
    selectedChannel: undefined,
    selectedChannelKind: undefined,
  }
}

function channelDataReducer(state: ChannelDataState, action: ChannelDataAction): ChannelDataState {
  switch (action.type) {
    case "channels.loading":
      return state.channelState.status === "ready"
        ? state
        : { ...state, channelState: { status: "loading" } }
    case "channels.loaded": {
      const selectedChannel = state.selectedChannel !== undefined && state.selectedChannelKind !== "chat"
        ? state.selectedChannel
        : action.channels.some((channel) => channel.name === state.selectedChannel)
        ? state.selectedChannel
        : action.channels[0]?.name
      return {
        ...state,
        channelState: { channels: action.channels, status: "ready" },
        selectedChannel,
        selectedChannelKind: selectedChannel === state.selectedChannel
          ? state.selectedChannelKind
          : selectedChannel === undefined ? undefined : "chat",
      }
    }
    case "channels.error":
      return state.channelState.status === "ready"
        ? { ...state, channelState: { ...state.channelState, errorMessage: action.message } }
        : { ...state, channelState: { message: action.message, status: "error" } }
    case "channel.select":
      return {
        ...state,
        selectedChannel: action.channel,
        selectedChannelKind: action.channel === undefined ? undefined : action.kind ?? state.selectedChannelKind ?? "chat",
      }
    case "channel.add": {
      const channels = state.channelState.status === "ready" ? state.channelState.channels : []
      return {
        ...state,
        channelState: {
          channels: [...channels.filter((channel) => channel.name !== action.channel.name), action.channel],
          status: "ready",
        },
      }
    }
    case "reload":
      return {
        ...state,
        channelReloadKey: state.channelReloadKey + 1,
        reloadKey: state.reloadKey + 1,
      }
    case "reload.channels":
      return { ...state, channelReloadKey: state.channelReloadKey + 1 }
    case "direct.disabled":
      return { ...state, directConversations: [], directState: { status: "disabled" } }
    case "direct.loading":
      return { ...state, directState: { status: "loading" } }
    case "direct.loaded":
      return {
        ...state,
        directConversations: action.conversations,
        directState: { status: "ready" },
        selectedChannel: state.selectedChannel ?? (state.channelState.status === "ready" && state.channelState.channels.length === 0 ? action.conversations[0]?.channel : undefined),
        selectedChannelKind: state.selectedChannel === undefined && state.channelState.status === "ready" && state.channelState.channels.length === 0 && action.conversations[0] !== undefined ? "direct" : state.selectedChannelKind,
      }
    case "direct.removed":
      return {
        ...state,
        directConversations: state.directConversations.filter((conversation) => conversation.channel !== action.channel),
        inboxEntries: state.inboxEntries.filter((entry) => entry.channel !== action.channel),
        selectedChannel: state.selectedChannel === action.channel ? undefined : state.selectedChannel,
        selectedChannelKind: state.selectedChannel === action.channel ? undefined : state.selectedChannelKind,
      }
    case "message.incoming":
      if (action.sender === action.selfHandle) return state
      return {
        ...state,
        directConversations: state.directConversations.map((conversation) => conversation.channel === action.channel
          ? { ...conversation, unread: conversation.unread + 1 }
          : conversation),
        inboxEntries: state.inboxEntries.map((entry) => entry.channel === action.channel
          ? { ...entry, unread: entry.unread + 1 }
          : entry),
      }
    case "message.ack":
      return {
        ...state,
        directConversations: state.directConversations.map((conversation) => conversation.channel === action.channel
          ? { ...conversation, unread: 0 }
          : conversation),
        inboxEntries: state.inboxEntries.map((entry) => entry.channel === action.channel
          ? { ...entry, unread: 0 }
          : entry),
      }
    case "cursor.set": {
      const cursorByChannel = new Map(state.cursorByChannel)
      const previous = cursorByChannel.get(action.channel) ?? 0
      cursorByChannel.set(action.channel, Math.max(previous, action.cursorId))
      return { ...state, cursorByChannel }
    }
    case "direct.error":
      return { ...state, directState: { errorMessage: action.message, status: "ready" } }
    case "members.loading":
      return { ...state, membersState: { status: "loading" } }
    case "members.loaded": {
      const membersByChannel = new Map(state.membersByChannel)
      membersByChannel.set(action.channel, action.members)
      return { ...state, membersByChannel, membersState: { status: "ready" } }
    }
    case "members.routeStates": {
      const members = state.membersByChannel.get(action.channel)
      if (members === undefined) return state
      let changed = false
      const nextMembers = members.map((member) => {
        const routeState = action.routeStates.get(member.handle)
        if (routeState === undefined || routeState === member.routeState) return member
        changed = true
        return { ...member, routeState }
      })
      if (!changed) return state
      const membersByChannel = new Map(state.membersByChannel)
      membersByChannel.set(action.channel, nextMembers)
      return { ...state, membersByChannel }
    }
    case "members.error":
      return { ...state, membersState: { errorMessage: action.message, status: "ready" } }
    case "inbox.disabled":
      return { ...state, inboxEntries: [], inboxState: { status: "disabled" } }
    case "inbox.loading":
      return { ...state, inboxState: { status: "loading" } }
    case "inbox.loaded":
      return { ...state, inboxEntries: action.entries, inboxState: { status: "ready" } }
    case "inbox.error":
      return { ...state, inboxState: { errorMessage: action.message, status: "ready" } }
    case "participants.loading":
      return { ...state, participantsState: { status: "loading" } }
    case "participants.loaded":
      return { ...state, participants: action.participants, participantsState: { status: "ready" } }
    case "participants.error":
      return { ...state, participantsState: { errorMessage: action.message, status: "ready" } }
  }
}

function isUnauthorized(error: ApiError): boolean {
  return error.match({
    ApiNetworkError: () => false,
    ApiHttpError: (failure) => failure.status === 401,
    ApiDecodeError: () => false,
    ApiNotFoundError: () => false,
    ApiConflictError: () => false,
  })
}

export interface ChannelData {
  activeChannel: Channel | undefined
  appendChannel: (channel: Channel) => void
  channelState: ChannelState
  directConversations: DirectConversation[]
  directState: DirectState
  inboxByChannel: Map<string, InboxEntry>
  inboxEntries: InboxEntry[]
  inboxState: InboxState
  membersByChannel: Map<string, Member[]>
  selectedCursorId: number | undefined
  membersState: MemberState
  participants: Participant[]
  participantsState: ParticipantState
  reload: () => void
  reloadChannels: () => void
  reloadKey: number
  removeDirect: (channel: string) => void
  selectedChannel: string | undefined
  selectedChannelKind: SelectedChannelKind | undefined
  selectedDirect: DirectConversation | undefined
  selectedInbox: InboxEntry | undefined
  selectedMembers: Member[]
  isSelectedMember: boolean
  selectChannel: (channel: string | undefined, kind?: SelectedChannelKind) => void
  updateMemberRouteStates: (channel: string, routeStates: ReadonlyMap<string, RouteState>) => void
  staleMemberCount: number
  staleChannels: string[]
  unreadTotal: number
  noteDirectMessage: (channel: string, sender: string, selfHandle?: string) => void
  noteAcknowledged: (channel: string, throughId?: number) => void
  setCursorId: (channel: string, cursorId: number) => void
}

export function useChannelState(
  api: MsgrApi,
  fallback: MsgrApi | undefined,
  identity: StoredIdentity | null,
  sessionExpired: boolean,
  onUnauthorized: () => void,
): ChannelData {
  const [state, dispatch] = useReducer(channelDataReducer, identity, initialChannelData)

  useEffect(() => {
    let mounted = true
    dispatch({ type: "channels.loading" })

    void apiCall(api, fallback, (client) => client.listChannels()).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ channels }) => dispatch({ channels, type: "channels.loaded" }),
        err: (error) => dispatch({ message: formatApiError(error), type: "channels.error" }),
      })
    })

    return () => {
      mounted = false
    }
  }, [api, fallback, state.channelReloadKey])

  const memberChannelNames = useMemo(() => Array.from(new Set([
      ...(state.channelState.status === "ready" ? state.channelState.channels.map((channel) => channel.name) : []),
      ...state.directConversations.map((conversation) => conversation.channel),
  ])), [state.channelState, state.directConversations])
  const memberChannelKey = memberChannelNames.join("\u0000")

  useEffect(() => {
    if (sessionExpired) return
    const channelNames = memberChannelKey.length === 0 ? [] : memberChannelKey.split("\u0000")
    if (channelNames.length === 0) {
      dispatch({ type: "members.loading" })
      return
    }

    let mounted = true
    dispatch({ type: "members.loading" })
    for (const channel of new Set(channelNames)) {
      void apiCall(api, fallback, (client) => client.listMembers(channel)).then((result) => {
        if (!mounted) return
        result.match({
          ok: ({ members }) => dispatch({ channel, members, type: "members.loaded" }),
          err: (error) => {
            if (isUnauthorized(error)) {
              onUnauthorized()
              return
            }
            if (channel === state.selectedChannel) dispatch({ message: formatApiError(error), type: "members.error" })
          },
        })
      })
    }

    return () => {
      mounted = false
    }
  }, [api, fallback, memberChannelKey, onUnauthorized, sessionExpired, state.reloadKey, state.selectedChannel])

  useEffect(() => {
    if (identity === null || sessionExpired) {
      dispatch({ type: "inbox.disabled" })
      return
    }

    let mounted = true
    dispatch({ type: "inbox.loading" })

    void apiCall(api, fallback, (client) => client.inbox()).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ entries }) => dispatch({ entries, type: "inbox.loaded" }),
        err: (error) => {
          if (isUnauthorized(error)) {
            dispatch({ type: "inbox.disabled" })
            onUnauthorized()
            return
          }
          dispatch({ message: formatApiError(error), type: "inbox.error" })
        },
      })
    })

    return () => {
      mounted = false
    }
  }, [api, fallback, identity, onUnauthorized, sessionExpired, state.reloadKey])

  useEffect(() => {
    let mounted = true
    dispatch({ type: "participants.loading" })

    void apiCall(api, fallback, (client) => client.listParticipants()).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ participants }) => dispatch({ participants, type: "participants.loaded" }),
        err: (error) => dispatch({ message: formatApiError(error), type: "participants.error" }),
      })
    })

    return () => {
      mounted = false
    }
  }, [api, fallback, state.reloadKey])

  useEffect(() => {
    if (identity === null || sessionExpired) {
      dispatch({ type: "direct.disabled" })
      return
    }

    let mounted = true
    dispatch({ type: "direct.loading" })

    void apiCall(api, fallback, (client) => client.listDirect()).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ conversations }) => dispatch({ conversations, type: "direct.loaded" }),
        err: (error) => {
          if (isUnauthorized(error)) {
            dispatch({ type: "direct.disabled" })
            onUnauthorized()
            return
          }
          dispatch({ message: formatApiError(error), type: "direct.error" })
        },
      })
    })

    return () => {
      mounted = false
    }
  }, [api, fallback, identity, onUnauthorized, sessionExpired, state.reloadKey])

  const selectChannel = useCallback((channel: string | undefined, kind?: SelectedChannelKind) => {
    dispatch({ channel, kind, type: "channel.select" })
  }, [])
  const appendChannel = useCallback((channel: Channel) => {
    dispatch({ channel, type: "channel.add" })
  }, [])
  const reload = useCallback(() => dispatch({ type: "reload" }), [])
  const reloadChannels = useCallback(() => dispatch({ type: "reload.channels" }), [])
  const removeDirect = useCallback((channel: string) => dispatch({ channel, type: "direct.removed" }), [])
  const activeChannel = state.channelState.status === "ready"
    ? state.channelState.channels.find((channel) => channel.name === state.selectedChannel)
    : undefined
  const memberRouteObservations = useMemo<RouteObservation[]>(
    () => [...state.membersByChannel].flatMap(([channel, members]) => members.map((member) => ({
      key: `${channel}\u0000${member.handle}`,
      state: member.routeState,
    }))),
    [state.membersByChannel],
  )
  const settledRouteStates = useSettledRouteStates(memberRouteObservations)
  const settledMembersByChannel = useMemo(() => {
    const next = new Map<string, Member[]>()
    for (const [channel, members] of state.membersByChannel) {
      next.set(channel, members.map((member) => ({
        ...member,
        routeState: settledRouteStates.get(`${channel}\u0000${member.handle}`) ?? member.routeState,
      })))
    }
    return next
  }, [settledRouteStates, state.membersByChannel])
  const selectedMembers = state.selectedChannel === undefined
    ? []
    : settledMembersByChannel.get(state.selectedChannel) ?? []
  const selectedInbox = identity === null || state.selectedChannel === undefined
    ? undefined
    : state.inboxEntries.find((entry) => entry.channel === state.selectedChannel)
  const selectedDirect = state.directConversations.find(
    (conversation) => conversation.channel === state.selectedChannel,
  )
  const isSelectedMember = identity !== null && selectedMembers.some((member) => member.handle === identity.handle)
  const staleMemberCount = selectedMembers.filter((member) => member.routeState === "stale").length
  const staleChannels = useMemo(() => {
    const channels: string[] = []
    for (const [channel, members] of settledMembersByChannel) {
      if (members.some((member) => member.routeState === "stale")) channels.push(channel)
    }
    return channels
  }, [settledMembersByChannel])
  const unreadTotal = useMemo(
    () => {
      const directNames = new Set(state.directConversations.map((conversation) => conversation.channel))
      const channelUnread = state.inboxEntries
        .filter((entry) => !directNames.has(entry.channel))
        .reduce((total, entry) => total + entry.unread, 0)
      return channelUnread + state.directConversations.reduce((total, conversation) => total + conversation.unread, 0)
    },
    [state.directConversations, state.inboxEntries],
  )
  const noteDirectMessage = useCallback((channel: string, sender: string, selfHandle?: string) => {
    dispatch({ channel, selfHandle, sender, type: "message.incoming" })
  }, [])
  const noteAcknowledged = useCallback((channel: string, throughId?: number) => {
    dispatch({ channel, type: "message.ack" })
    if (throughId !== undefined) dispatch({ channel, cursorId: throughId, type: "cursor.set" })
  }, [])
  const setCursorId = useCallback((channel: string, cursorId: number) => {
    dispatch({ channel, cursorId, type: "cursor.set" })
  }, [])
  const updateMemberRouteStates = useCallback((channel: string, routeStates: ReadonlyMap<string, RouteState>) => {
    dispatch({ channel, routeStates, type: "members.routeStates" })
  }, [])
  const inboxByChannel = useMemo(
    () => new Map(state.inboxEntries.map((entry) => [entry.channel, entry])),
    [state.inboxEntries],
  )

  return {
    activeChannel,
    appendChannel,
    channelState: state.channelState,
    directConversations: state.directConversations,
    directState: state.directState,
    inboxByChannel,
    inboxEntries: state.inboxEntries,
    inboxState: state.inboxState,
    membersByChannel: state.membersByChannel,
    membersState: state.membersState,
    selectedCursorId: state.selectedChannel === undefined ? undefined : state.cursorByChannel.get(state.selectedChannel),
    participants: state.participants,
    participantsState: state.participantsState,
    reload,
    reloadChannels,
    reloadKey: state.reloadKey,
    removeDirect,
    selectedChannel: state.selectedChannel,
    selectedChannelKind: state.selectedChannelKind,
    selectedDirect,
    selectedInbox,
    selectedMembers,
    isSelectedMember,
    selectChannel,
    updateMemberRouteStates,
    staleMemberCount,
    staleChannels,
    unreadTotal,
    noteDirectMessage,
    noteAcknowledged,
    setCursorId,
  }
}
