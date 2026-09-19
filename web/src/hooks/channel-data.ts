import type { StoredIdentity } from "@/api/identity"
import type { Channel, ChannelKind, DirectConversation, InboxEntry, Member, MetadataScope, Participant, RouteState } from "@/api/types"

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

export interface ChannelDataState {
  channelState: ChannelState
  selectedChannel: string | undefined
  selectedChannelKind: SelectedChannelKind | undefined
  reloadKey: number
  channelReloadKey: number
  directReloadKey: number
  inboxReloadKey: number
  membersReloadKey: number
  participantsReloadKey: number
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

export type ChannelDataAction =
  | { type: "channels.loading" }
  | { type: "channels.loaded"; channels: Channel[] }
  | { type: "channels.error"; message: string }
  | { type: "channel.select"; channel: string | undefined; kind?: SelectedChannelKind }
  | { type: "channel.add"; channel: Channel }
  | { type: "reload" }
  | { type: "reload.channels" }
  | { type: "metadata.reload"; scopes: readonly MetadataScope[] }
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

export function initialChannelData(identity: StoredIdentity | null): ChannelDataState {
  return {
    channelReloadKey: 0,
    channelState: { status: "loading" },
    cursorByChannel: new Map(),
    directConversations: [],
    directReloadKey: 0,
    directState: identity === null ? { status: "disabled" } : { status: "loading" },
    inboxEntries: [],
    inboxReloadKey: 0,
    inboxState: identity === null ? { status: "disabled" } : { status: "loading" },
    membersByChannel: new Map(),
    membersReloadKey: 0,
    membersState: { status: "loading" },
    participants: [],
    participantsReloadKey: 0,
    participantsState: { status: "loading" },
    reloadKey: 0,
    selectedChannel: undefined,
    selectedChannelKind: undefined,
  }
}

function metadataReloaded(state: ChannelDataState, scope: MetadataScope): ChannelDataState {
  switch (scope) {
    case "channels":
      return { ...state, channelReloadKey: state.channelReloadKey + 1 }
    case "members":
      return { ...state, membersReloadKey: state.membersReloadKey + 1 }
    case "inbox":
      return { ...state, inboxReloadKey: state.inboxReloadKey + 1 }
    case "participants":
      return { ...state, participantsReloadKey: state.participantsReloadKey + 1 }
    case "direct":
      return { ...state, directReloadKey: state.directReloadKey + 1 }
    case "roles":
      return state
    default:
      return assertNeverMetadataScope(scope)
  }
}

/** A new metadata scope must fail typecheck here, not fall through silently. */
function assertNeverMetadataScope(scope: never): never {
  throw new Error(`Unhandled metadata scope: ${String(scope)}`)
}

export function channelDataReducer(state: ChannelDataState, action: ChannelDataAction): ChannelDataState {
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
        directReloadKey: state.directReloadKey + 1,
        inboxReloadKey: state.inboxReloadKey + 1,
        membersReloadKey: state.membersReloadKey + 1,
        participantsReloadKey: state.participantsReloadKey + 1,
        reloadKey: state.reloadKey + 1,
      }
    case "reload.channels":
      return { ...state, channelReloadKey: state.channelReloadKey + 1 }
    case "metadata.reload": {
      let next = state
      for (const scope of new Set(action.scopes)) {
        next = metadataReloaded(next, scope)
      }
      return next
    }
    case "direct.disabled":
      return { ...state, directConversations: [], directState: { status: "disabled" } }
    case "direct.loading":
      return state.directState.status === "ready"
        ? state
        : { ...state, directState: { status: "loading" } }
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
      return state.membersState.status === "ready"
        ? state
        : { ...state, membersState: { status: "loading" } }
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
      return state.inboxState.status === "ready"
        ? state
        : { ...state, inboxState: { status: "loading" } }
    case "inbox.loaded":
      return { ...state, inboxEntries: action.entries, inboxState: { status: "ready" } }
    case "inbox.error":
      return { ...state, inboxState: { errorMessage: action.message, status: "ready" } }
    case "participants.loading":
      return state.participantsState.status === "ready"
        ? state
        : { ...state, participantsState: { status: "loading" } }
    case "participants.loaded":
      return { ...state, participants: action.participants, participantsState: { status: "ready" } }
    case "participants.error":
      return { ...state, participantsState: { errorMessage: action.message, status: "ready" } }
  }
}
