import { describe, expect, test } from "bun:test"

import {
  COMMAND_DEPTH_LIMIT,
  enterCommand,
  leaveCommand,
  replaceCommand,
  ROOT_NAVIGATION,
  type CommandNavigation,
  type CommandChildScreen,
} from "./navigation"

function enter(navigation: CommandNavigation, screen: CommandChildScreen): CommandNavigation {
  const result = enterCommand(navigation, screen)
  if (result.isErr()) throw new Error(result.error.message)
  return result.value
}

describe("command history", () => {
  test("Back restores one parent with its exact search, filter, and selection", () => {
    const root: CommandNavigation = {
      ...ROOT_NAVIGATION,
      current: { ...ROOT_NAVIGATION.current, position: { query: "review", filter: "agent", active: 2 } },
    }
    const actions = enter(root, { kind: "actions", id: "agent:reviewer", title: "reviewer" })
    const selected: CommandNavigation = {
      ...actions,
      current: { ...actions.current, position: { query: "message", filter: "all", active: 0 } },
    }
    const form = enter(selected, { kind: "prompt", handle: "reviewer" })
    expect(leaveCommand(form)).toEqual({ kind: "parent", navigation: selected })
    expect(leaveCommand(selected)).toEqual({ kind: "parent", navigation: root })
    expect(leaveCommand(root)).toEqual({ kind: "close" })
  })

  test("a completed step is replaced without adding a dead return level", () => {
    const recipients = enter(ROOT_NAVIGATION, { kind: "recipients" })
    const joined = enter(recipients, { kind: "join", channel: "ops" })
    const compose = replaceCommand(joined, {
      kind: "compose",
      target: { kind: "channel", channel: "ops", membership: "joined" },
    })
    expect(leaveCommand(compose)).toEqual({ kind: "parent", navigation: recipients })
  })

  test("a full history fails without changing existing frames", () => {
    let state = ROOT_NAVIGATION
    for (let depth = 1; depth < COMMAND_DEPTH_LIMIT; depth += 1) state = enter(state, { kind: "recipients" })
    const result = enterCommand(state, { kind: "recipients" })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("depth-limit")
    expect(state.parents).toHaveLength(COMMAND_DEPTH_LIMIT - 1)
    const back = leaveCommand(state)
    if (back.kind !== "parent") throw new Error("A full history must have a parent")
    expect(enterCommand(back.navigation, { kind: "recipients" }).isOk()).toBe(true)
  })
})
