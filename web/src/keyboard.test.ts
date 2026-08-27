import { describe, expect, test } from "bun:test"

import { composerLayout } from "./composer"
import {
  ACTION_REGISTRY,
  actionForCombo,
  bindingConflicts,
  comboFromKeyEvent,
  defaultBindings,
  KeyboardLayerStack,
  parseBindings,
  parseBindingsWithMigration,
  replaceBinding,
  serializeBindings,
  shouldDispatchWhileTyping,
} from "./keyboard"

describe("keyboard bindings", () => {
  test("maps the default key combinations to named actions", () => {
    const bindings = defaultBindings()
    expect(actionForCombo(bindings, "/")).toBe("search.focus")
    expect(actionForCombo(bindings, "Ctrl+K")).toBe("channel.picker")
    expect(actionForCombo(bindings, "Shift+G")).toBe("message.jumpLatest")
    expect(actionForCombo(bindings, "ArrowDown")).toBe("message.focusNext")
    expect(actionForCombo(bindings, "d")).toBe("message.dmAuthor")
  })

  test("keeps typing contexts isolated while allowing explicit modifiers", () => {
    const bindings = defaultBindings()
    const letterEvent = { altKey: false, ctrlKey: false, key: "s", metaKey: false, shiftKey: false }
    const pickerEvent = { altKey: false, ctrlKey: true, key: "k", metaKey: false, shiftKey: false }
    const letterAction = actionForCombo(bindings, comboFromKeyEvent(letterEvent))
    const pickerAction = actionForCombo(bindings, comboFromKeyEvent(pickerEvent))
    expect(letterAction).toBe("search.scopeToggle")
    expect(shouldDispatchWhileTyping(letterAction ?? "search.scopeToggle", letterEvent, true, false)).toBe(false)
    expect(pickerAction).toBe("channel.picker")
    expect(shouldDispatchWhileTyping(pickerAction ?? "channel.picker", pickerEvent, true, false)).toBe(true)
  })

  test("serializes a complete map and restores it after reload", () => {
    const bindings = replaceBinding(defaultBindings(), "search.focus", "Ctrl+F")
    const restored = parseBindings(serializeBindings(bindings))
    expect(restored.match({ ok: (value) => value.get("search.focus"), err: () => undefined })).toBe("Ctrl+F")
  })

  test("rejects conflicts and migrates stale action maps", () => {
    const conflicting = replaceBinding(defaultBindings(), "search.focus", "s")
    expect(bindingConflicts(conflicting).has("s")).toBe(true)
    const stale = JSON.stringify({ version: 1, bindings: [{ action: "removed.action", combo: "x" }] })
    const migrated = parseBindingsWithMigration(stale)
    expect(migrated.match({ ok: ({ droppedActions }) => droppedActions, err: () => [] })).toEqual(["removed.action"])
    expect(migrated.match({ ok: ({ bindings }) => bindings.get("search.focus"), err: () => undefined })).toBe("/")
    const custom = JSON.stringify({ version: 1, bindings: [{ action: "search.focus", combo: "0" }] })
    expect(parseBindings(custom).match({ ok: (bindings) => bindings.get("search.focus"), err: () => undefined })).toBe("0")
    expect(ACTION_REGISTRY.length).toBeGreaterThan(10)
  })

  test("keeps Escape and composer send/newline behavior available in typing contexts", () => {
    const escapeEvent = { altKey: false, ctrlKey: false, key: "Escape", metaKey: false, shiftKey: false }
    const enterEvent = { altKey: false, ctrlKey: false, key: "Enter", metaKey: false, shiftKey: false }
    const newlineEvent = { altKey: false, ctrlKey: false, key: "Enter", metaKey: false, shiftKey: true }
    expect(shouldDispatchWhileTyping("overlay.close", escapeEvent, true, false)).toBe(true)
    expect(shouldDispatchWhileTyping("composer.send", enterEvent, true, true)).toBe(true)
    expect(shouldDispatchWhileTyping("composer.newline", newlineEvent, true, true)).toBe(true)
  })

  test("caps composer height at eight lines and enables internal scrolling", () => {
    expect(composerLayout(80)).toEqual({ height: 80, overflowY: "hidden" })
    expect(composerLayout(400)).toEqual({ height: 192, overflowY: "auto" })
  })

  test("blocks page-scope keys for every modal layer", () => {
    const scopes = ["dialog", "help", "inbox", "members", "picker", "settings"] as const
    const pageKeys = ["ArrowDown", "ArrowUp", "j", "k", "/", "c", "[", "]", "u", "G"]

    for (const scope of scopes) {
      const stack = new KeyboardLayerStack()
      let pageCalls = 0
      const release = stack.push({ mode: "modal", scope }, () => false, () => undefined)

      for (const key of pageKeys) {
        if (!stack.isPageBlocked()) pageCalls += 1
        stack.dispatch({ altKey: false, ctrlKey: false, key, metaKey: false, shiftKey: false })
      }

      expect(stack.top()).toEqual({ mode: "modal", scope })
      expect(pageCalls).toBe(0)
      release()
      expect(stack.isPageBlocked()).toBe(false)
    }
  })

  test("lets an unhandled inline layer fall through to page bindings", () => {
    const stack = new KeyboardLayerStack()
    const release = stack.push({ mode: "inline", scope: "viewer" }, () => false)
    const event = { altKey: false, ctrlKey: false, key: "m", metaKey: false, shiftKey: false }

    expect(stack.isPageBlocked()).toBe(false)
    expect(stack.dispatch(event)).toBe(false)
    release()
  })

  test("dispatches only the top layer and releases it on unmount", () => {
    const stack = new KeyboardLayerStack()
    const calls: string[] = []
    const releaseDialog = stack.push({ mode: "modal", scope: "dialog" }, () => {
      calls.push("dialog")
      return true
    }, () => calls.push("close-dialog"))
    const releasePicker = stack.push({ mode: "modal", scope: "picker" }, () => {
      calls.push("picker")
      return true
    }, () => calls.push("close-picker"))
    const event = { altKey: false, ctrlKey: false, key: "ArrowDown", metaKey: false, shiftKey: false }

    expect(stack.dispatch(event)).toBe(true)
    expect(calls).toEqual(["picker"])
    expect(stack.closeTop()).toBe(true)
    expect(calls).toEqual(["picker", "close-picker"])
    releasePicker()
    expect(stack.top()).toEqual({ mode: "modal", scope: "dialog" })
    expect(stack.dispatch(event)).toBe(true)
    expect(calls).toEqual(["picker", "close-picker", "dialog"])
    releaseDialog()
    expect(stack.top()).toBeUndefined()
  })
})

describe("the action registry is a fixed set", () => {
  // A new binding is a second answer to a job that already has one. Additions must update
  // this list in the same commit so the registry change is explicit.
  test("pins every action id, so a new binding cannot arrive unnoticed", () => {
    expect([...ACTION_REGISTRY].map((action) => action.id).sort()).toEqual([
      "agent.addReporter",
      "agent.spawn",
      "agent.stop",
      "attachment.copyPath",
      "attachment.view",
      "channel.create",
      "channel.members",
      "channel.next",
      "channel.picker",
      "channel.prev",
      "composer.attach",
      "composer.focus",
      "composer.newline",
      "composer.send",
      "help.show",
      "inbox.open",
      "menu.open",
      "message.dmAuthor",
      "message.focusNext",
      "message.focusPrev",
      "message.jumpLatest",
      "message.jumpUnread",
      "overlay.close",
      "page.agents",
      "page.channels",
      "page.direct",
      "page.workspaces",
      "pane.close",
      "search.focus",
      "search.scopeToggle",
      "settings.open",
      "sidebar.toggle",
      "theme.cycle",
      "workspace.broadcast",
      "workspace.close",
      "workspace.create",
    ])
  })

  test("names every action exactly once", () => {
    const ids = ACTION_REGISTRY.map((action) => action.id)
    expect(new Set(ids).size, "a duplicate id would shadow one action with another").toBe(ids.length)
  })
})
