import { useCallback, useEffect, useMemo, useReducer } from "react"

import { apiCall } from "@/api/runtime"
import { formatApiError, type ApiError } from "@/api/errors"
import type { StoredIdentity } from "@/api/identity"
import type { Channel, DirectConversation, InboxEntry, Member, MetadataScope, MsgrApi, Participant, RouteState } from "@/api/types"
import {
  channelDataReducer,
  initialChannelData,
  type ChannelState,
  type DirectState,
  type InboxState,
  type MemberState,
  type ParticipantState,
  type SelectedChannelKind,
} from "@/hooks/channel-data"
import { useSettledRouteStates, type RouteObservation } from "@/hooks/use-settled-route-state"

export type { ChannelState, DirectState, InboxState, MemberState, ParticipantState, SelectedChannelKind } from "@/hooks/channel-data"

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
  reloadMetadata: (scopes: readonly MetadataScope[]) => void
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
  }, [api, fallback, memberChannelKey, onUnauthorized, sessionExpired, state.membersReloadKey, state.selectedChannel])

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
  }, [api, fallback, identity, onUnauthorized, sessionExpired, state.inboxReloadKey])

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
  }, [api, fallback, state.participantsReloadKey])

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
  }, [api, fallback, identity, onUnauthorized, sessionExpired, state.directReloadKey])

  const selectChannel = useCallback((channel: string | undefined, kind?: SelectedChannelKind) => {
    dispatch({ channel, kind, type: "channel.select" })
  }, [])
  const appendChannel = useCallback((channel: Channel) => {
    dispatch({ channel, type: "channel.add" })
  }, [])
  const reload = useCallback(() => dispatch({ type: "reload" }), [])
  const reloadChannels = useCallback(() => dispatch({ type: "reload.channels" }), [])
  const reloadMetadata = useCallback(
    (scopes: readonly MetadataScope[]) => dispatch({ scopes, type: "metadata.reload" }),
    [],
  )
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
    reloadMetadata,
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
