import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Hash, MessageCircle, Search, Trash2, UserRound, X } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { Channel, DirectConversation } from "@/api/types"
import { Button } from "@/components/ui/button"
import type { AppController } from "@/hooks/use-app-controller"
import type { ChannelMembershipFilter, ShellRoute, ShellRouter } from "@/shell-routing"
import { absoluteTimeLabel } from "@/workspace-presentation"

const NO_CHANNELS: readonly Channel[] = []

function directConversationLabel(conversation: DirectConversation): string {
  const participants = conversation.participants.join(", ")
  return participants.length === 0 ? conversation.channel : participants
}

function relativeActivity(timestamp: string): string {
  const age = Math.max(0, Date.now() - Date.parse(timestamp))
  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function compareChannels(orderUnread: ReadonlyMap<string, number>) {
  return (left: Channel, right: Channel): number =>
    (orderUnread.get(right.name) ?? 0) - (orderUnread.get(left.name) ?? 0)
      || (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
      || left.name.localeCompare(right.name)
}

function channelsDirectoryRoute(query: string, membership: ChannelMembershipFilter): Extract<ShellRoute, { kind: "channels" }> {
  const normalizedQuery = query.trim()
  const route: Extract<ShellRoute, { kind: "channels" }> = { kind: "channels" }
  if (normalizedQuery.length > 0) route.query = normalizedQuery
  if (membership !== "all") route.membership = membership
  return route
}

function viewerIsChannelMember(identityHandle: string | undefined, membersByChannel: AppController["membersByChannel"], channel: Channel): boolean {
  const members = membersByChannel.get(channel.name)
  return identityHandle !== undefined && members?.some((member) => member.handle === identityHandle) === true
}

export function ChannelsDirectoryPage({ controller, navigate, route }: { controller: AppController; navigate: ShellRouter["navigate"]; route: Extract<ShellRoute, { kind: "channels" }> }) {
  const {
    channelState,
    identity,
    inboxByChannel,
    inboxState,
    joinChannel,
    leaveChannel,
    membersByChannel,
    reloadChannels,
  } = controller
  // A fresh array every render would defeat every memo that depends on it, so the
  // empty case is a stable constant and the ready case is the state's own array.
  const readyChannels = channelState.status === "ready" ? channelState.channels : NO_CHANNELS
  const channelSetKey = readyChannels.map((channel) => channel.name).toSorted().join(" ")
  const dataSettled = channelState.status === "ready" && inboxState.status !== "loading"
  const [openOrder, setOpenOrder] = useState<readonly string[]>([])
  const capturedKeyRef = useRef<string | undefined>(undefined)
  const query = route.query ?? ""
  const membershipFilter = route.membership ?? "all"
  const membershipReady = readyChannels.every((channel) => membersByChannel.has(channel.name))

  useEffect(() => {
    // The order is captured once the channels and the inbox have both settled, and then
    // again only when the channel SET changes. Unread is deliberately absent from the
    // dependencies: badges update live while rows stay put, so the list never re-sorts
    // under the operator's cursor. A later refresh — after a join or a leave — dips the
    // inbox back through "loading", and the captured key is what stops that dip from
    // reordering the page the operator is pointing at.
    // The exhaustive-deps warning on this effect is ACCEPTED, not overlooked:
    // adding readyChannels or inboxByChannel re-runs the capture on every unread
    // change, which is the re-sort this whole mechanism exists to prevent.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
    if (!dataSettled || capturedKeyRef.current === channelSetKey) return
    capturedKeyRef.current = channelSetKey
    setOpenOrder(readyChannels
      .toSorted(compareChannels(new Map(readyChannels.map((channel) => [channel.name, inboxByChannel.get(channel.name)?.unread ?? 0]))))
      .map((channel) => channel.name))
  }, [channelSetKey, dataSettled])

  const channels = useMemo(() => {
    const byName = new Map(readyChannels.map((channel) => [channel.name, channel]))
    const held = openOrder.flatMap((name) => {
      const channel = byName.get(name)
      return channel === undefined ? [] : [channel]
    })
    const heldNames = new Set(openOrder)
    return [...held, ...readyChannels.filter((channel) => !heldNames.has(channel.name))]
  }, [openOrder, readyChannels])
  const visibleChannels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return channels.filter((channel) => {
      const matchesQuery = normalizedQuery.length === 0
        || channel.name.toLocaleLowerCase().includes(normalizedQuery)
        || channel.topic?.toLocaleLowerCase().includes(normalizedQuery) === true
      if (!matchesQuery) return false
      const member = viewerIsChannelMember(identity?.handle, membersByChannel, channel)
      switch (membershipFilter) {
        case "joined":
          return member
        case "available":
          return !member
        case "all":
          return true
      }
    })
  }, [channels, identity?.handle, membershipFilter, membersByChannel, query])

  const openChannel = useCallback((channel: Channel) => {
    // The route names the channel; the destination loads it on arrival.
    navigate({ channel: channel.name, kind: "channel" })
  }, [navigate])

  return (
    <div className="w-full space-y-2 p-3 sm:p-4" data-directory="channels" data-directory-list="channels">
      <form className="flex flex-col gap-2 border-b pb-3 sm:flex-row sm:items-end" onSubmit={(event) => event.preventDefault()} role="search">
        <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground" htmlFor="channel-directory-search">
          Search Channels
          <span className="mt-1 flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              id="channel-directory-search"
              name="channel-query"
              onChange={(event) => navigate(channelsDirectoryRoute(event.target.value, membershipFilter), true)}
              placeholder="Search by name or topic…"
              spellCheck={false}
              type="search"
              value={query}
            />
            {query.length > 0 && (
              <Button aria-label="Clear channel search" onClick={() => navigate(channelsDirectoryRoute("", membershipFilter), true)} size="icon-xs" title="Clear channel search" type="button" variant="ghost">
                <X aria-hidden="true" />
              </Button>
            )}
          </span>
        </label>
        <fieldset className="min-w-0" disabled={!membershipReady}>
          <legend className="text-xs font-medium text-muted-foreground">Membership</legend>
          <div className="mt-1 inline-flex h-9 rounded-lg border bg-muted/30 p-0.5" data-channel-membership-filter>
            {([
              { label: "All", value: "all" },
              { label: "Joined", value: "joined" },
              { label: "Available", value: "available" },
            ] satisfies Array<{ label: string; value: ChannelMembershipFilter }>).map((option) => (
              <Button
                aria-pressed={membershipFilter === option.value}
                className="h-8 rounded-md px-3 text-xs aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                key={option.value}
                onClick={() => navigate(channelsDirectoryRoute(query, option.value), true)}
                size="sm"
                title={membershipReady ? `Show ${option.label.toLocaleLowerCase()} channels` : "Loading channel membership"}
                type="button"
                variant="ghost"
              >
                {option.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <p aria-live="polite" className="h-9 shrink-0 content-center text-xs tabular-nums text-muted-foreground" data-channel-result-count role="status">
          {visibleChannels.length} of {channels.length}
        </p>
      </form>
      {identity === null && (
        <p className="text-sm text-muted-foreground" data-page-readonly="channels">{NOT_CONNECTED_REASON}</p>
      )}

      {channelState.status === "loading" && (
        <div aria-label="Loading channels" className="space-y-2" role="status">
          {["one", "two", "three"].map((key) => <div className="h-20 animate-pulse rounded-xl bg-muted" key={key} />)}
        </div>
      )}
      {channelState.status === "error" && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4" role="alert">
          <p className="text-sm text-destructive">{channelState.message}</p>
          <Button className="mt-3" onClick={reloadChannels} size="sm" type="button" variant="outline">Try again</Button>
        </div>
      )}
      {channelState.status === "ready" && channelState.errorMessage !== undefined && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          Channel refresh failed: {channelState.errorMessage}
        </p>
      )}
      {channelState.status === "ready" && channels.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Hash aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">No channels are available.</p>
        </div>
      )}
      {channelState.status === "ready" && channels.length > 0 && visibleChannels.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Search aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">No channels match this search and membership filter.</p>
          <Button className="mt-4" onClick={() => navigate({ kind: "channels" }, true)} type="button" variant="outline">Clear Filters</Button>
        </div>
      )}
      {channelState.status === "ready" && visibleChannels.length > 0 && (
        <ul aria-label="Channel directory" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="list">
          {visibleChannels.map((channel) => {
            const inbox = inboxByChannel.get(channel.name)
            const unread = inbox?.unread ?? 0
            const members = membersByChannel.get(channel.name)
            const isMember = identity !== null && members?.some((member) => member.handle === identity.handle) === true
            const canManageMembership = identity !== null && channel.kind === "chat"
            const canDelete = identity !== null && channel.kind === "chat"
            const memberCount = channel.memberCount
            return (
              <li className="flex min-h-24 min-w-0 flex-col rounded-lg border bg-card p-3 transition-colors hover:bg-muted/30" data-channel-row={channel.name} key={channel.id}>
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    aria-current={channel.name === controller.selectedChannel ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-channel-open={channel.name}
                    onClick={() => openChannel(channel)}
                    type="button"
                  >
                    <Hash aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{channel.name}</span>
                      {channel.topic !== null && <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{channel.topic}</span>}
                    </span>
                  </button>
                  <div aria-label={`Actions for ${channel.name}`} className="flex shrink-0 items-center gap-0.5">
                    <Button aria-label={`View members of ${channel.name}`} data-channel-members-action={channel.name} onClick={() => controller.openMembers(channel.name)} size="icon-xs" title="View members" type="button" variant="ghost">
                      <UserRound aria-hidden="true" />
                    </Button>
                    <Button aria-label={`Copy channel name ${channel.name}`} data-channel-copy={channel.name} onClick={() => controller.copyChannelName(channel.name)} size="icon-xs" title="Copy channel name" type="button" variant="ghost">
                      <Copy aria-hidden="true" />
                    </Button>
                    {canDelete && (
                      <Button aria-label={`Delete ${channel.name}`} className="text-destructive hover:bg-destructive/10 hover:text-destructive" data-channel-delete={channel.name} onClick={() => controller.openDeleteChannel(channel.name)} size="icon-xs" title="Delete channel" type="button" variant="ghost">
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2 pt-3 text-xs text-muted-foreground">
                  {unread > 0
                    ? <span className="rounded-full bg-primary px-2 py-0.5 font-semibold text-primary-foreground" data-channel-unread={unread}>{unread} unread</span>
                    : channel.lastMessageAt !== null && <time dateTime={channel.lastMessageAt} data-channel-activity={channel.name} title={absoluteTimeLabel(channel.lastMessageAt)}>Active {relativeActivity(channel.lastMessageAt)}</time>}
                  <span data-channel-members={memberCount}>{memberCount} member{memberCount === 1 ? "" : "s"}</span>
                  {canManageMembership && members === undefined && (
                    <Button aria-label={`Loading membership for ${channel.name}`} className="ml-auto" disabled size="sm" title="Loading channel membership" type="button" variant="outline">
                      Loading…
                    </Button>
                  )}
                  {canManageMembership && members !== undefined && (
                    <Button
                      aria-label={`${isMember ? "Leave" : "Join"} ${channel.name}`}
                      className="ml-auto"
                      data-channel-membership={isMember ? "leave" : "join"}
                      onClick={() => (isMember ? leaveChannel(channel.name) : joinChannel(channel.name))}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {isMember ? "Leave" : "Join"}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function DirectOverviewPage({ controller, navigate }: { controller: AppController; navigate: ShellRouter["navigate"] }) {
  const {
    directConversations,
    directListState,
    reload,
    selectChannel,
    selectedChannel,
    setFocusedMessageId,
  } = controller
  const openConversation = useCallback((conversation: DirectConversation) => {
    selectChannel(conversation.channel, "direct")
    setFocusedMessageId(undefined)
    navigate({ channel: conversation.channel, kind: "conversation" })
  }, [navigate, selectChannel, setFocusedMessageId])
  return (
    <div className="w-full space-y-5 p-4 sm:p-6" data-directory="direct">
      <p className="max-w-3xl text-sm text-muted-foreground">Open a conversation to view its participants and messages.</p>

      {directListState.status === "disabled" && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <MessageCircle aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{NOT_CONNECTED_REASON} Direct conversations are read only.</p>
        </div>
      )}
      {directListState.status === "loading" && (
        <div aria-label="Loading direct conversations" className="space-y-2" role="status">
          {["one", "two"].map((key) => <div className="h-20 animate-pulse rounded-xl bg-muted" key={key} />)}
        </div>
      )}
      {directListState.status === "ready" && directListState.errorMessage !== undefined && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4" role="alert">
          <p className="text-sm text-destructive">{directListState.errorMessage}</p>
          <Button className="mt-3" onClick={reload} size="sm" type="button" variant="outline">Try again</Button>
        </div>
      )}
      {directListState.status === "ready" && directConversations.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <MessageCircle aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">No direct conversations.</p>
        </div>
      )}
      {directListState.status === "ready" && directConversations.length > 0 && (
        <ul aria-label="Direct conversations" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" role="list">
          {directConversations.map((conversation) => (
            <li className="flex min-h-20 items-center gap-3 overflow-hidden rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40" data-channel-row={conversation.channel} key={conversation.channel}>
              <button aria-current={conversation.channel === selectedChannel ? "page" : undefined} className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => openConversation(conversation)} type="button">
                <MessageCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{directConversationLabel(conversation)}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{conversation.participants.length} participant{conversation.participants.length === 1 ? "" : "s"}{conversation.lastMessageAt === undefined || conversation.lastMessageAt === null ? "" : ` · ${relativeActivity(conversation.lastMessageAt)}`}</span>
                </span>
              </button>
              {conversation.unread > 0 && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{conversation.unread} unread</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
