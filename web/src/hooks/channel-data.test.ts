import { describe, expect, it } from "bun:test"

import { channelDataReducer, initialChannelData } from "./channel-data"

function reduce(
  actions: ReadonlyArray<Parameters<typeof channelDataReducer>[1]>,
  seed = initialChannelData(null),
) {
  return actions.reduce(channelDataReducer, seed)
}

describe("channel metadata reloads", () => {
  it("bumps only the scopes a metadata frame names", () => {
    const next = channelDataReducer(initialChannelData(null), {
      scopes: ["channels", "inbox"],
      type: "metadata.reload",
    })

    expect(next.channelReloadKey).toBe(1)
    expect(next.inboxReloadKey).toBe(1)
    expect(next.membersReloadKey).toBe(0)
    expect(next.participantsReloadKey).toBe(0)
    expect(next.directReloadKey).toBe(0)
    expect(next.reloadKey).toBe(0)
  })

  it("counts a repeated scope once", () => {
    const next = channelDataReducer(initialChannelData(null), {
      scopes: ["members", "members"],
      type: "metadata.reload",
    })

    expect(next.membersReloadKey).toBe(1)
  })

  it("leaves non-channel scopes to their callers", () => {
    const next = channelDataReducer(initialChannelData(null), {
      scopes: ["roles", "launchers", "models"],
      type: "metadata.reload",
    })

    expect(next.reloadKey).toBe(0)
    expect(next.channelReloadKey).toBe(0)
    expect(next.membersReloadKey).toBe(0)
  })

  it("refreshes every scope on a full reload", () => {
    const next = channelDataReducer(initialChannelData(null), { type: "reload" })

    expect(next).toMatchObject({
      channelReloadKey: 1,
      directReloadKey: 1,
      inboxReloadKey: 1,
      membersReloadKey: 1,
      participantsReloadKey: 1,
      reloadKey: 1,
    })
  })

  it("refreshes only channels on reloadChannels", () => {
    const next = channelDataReducer(initialChannelData(null), { type: "reload.channels" })

    expect(next.channelReloadKey).toBe(1)
    expect(next.reloadKey).toBe(0)
    expect(next.inboxReloadKey).toBe(0)
  })

  it("keeps loaded metadata visible while a background refresh runs", () => {
    const loaded = reduce([
      { conversations: [], type: "direct.loaded" },
      { entries: [], type: "inbox.loaded" },
      { participants: [], type: "participants.loaded" },
      { channel: "ops", members: [], type: "members.loaded" },
    ])

    const refreshing = reduce([
      { type: "direct.loading" },
      { type: "inbox.loading" },
      { type: "participants.loading" },
      { type: "members.loading" },
    ], loaded)

    expect(refreshing.directState.status).toBe("ready")
    expect(refreshing.inboxState.status).toBe("ready")
    expect(refreshing.participantsState.status).toBe("ready")
    expect(refreshing.membersState.status).toBe("ready")
  })
})
