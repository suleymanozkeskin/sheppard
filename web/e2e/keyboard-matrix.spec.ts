/**
 * Keyboard-only acceptance cases for control-plane and creation surfaces.
 *
 * These tests are tagged `@guard` so the matrix stays green for shipped
 * operator surfaces and their keyboard contracts.
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

import { mockChannels, mockInbox, mockLaunchers, mockMembers, mockMessages } from "../src/api/fixtures"
import type { Message } from "../src/api/types"

const TOPOLOGY = {
  workspaces: [
    {
      id: "ws-alpha",
      label: "alpha",
      panes: [
        {
          paneId: "pane-alpha",
          label: "review",
          agentKind: "codex",
          agentStatus: "working",
          focused: true,
          participant: "runner",
          participantRouteState: "active",
        },
        {
          paneId: "pane-empty",
          label: null,
          agentKind: null,
          agentStatus: "unknown",
          focused: false,
          participant: null,
          participantRouteState: null,
        },
        {
          paneId: "pane-unmanaged",
          label: "unmanaged",
          agentKind: "codex",
          agentStatus: "idle",
          focused: false,
          participant: null,
          participantRouteState: null,
        },
      ],
      tabs: [{
        id: "tab-alpha-main",
        label: "Main",
        panes: [
          {
            paneId: "pane-alpha",
            label: "review",
            agentKind: "codex",
            agentStatus: "working",
            focused: true,
            participant: "runner",
            participantRouteState: "active",
          },
          {
            paneId: "pane-empty",
            label: null,
            agentKind: null,
            agentStatus: "unknown",
            focused: false,
            participant: null,
            participantRouteState: null,
          },
          {
            paneId: "pane-unmanaged",
            label: "unmanaged",
            agentKind: "codex",
            agentStatus: "idle",
            focused: false,
            participant: null,
            participantRouteState: null,
          },
        ],
      }],
    },
  ],
}

type JsonValue = boolean | Record<string, JsonValue> | JsonValue[] | null | number | string

function cloneMessages(): Message[] {
  return mockMessages.map((message) => ({
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
  }))
}

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

async function installApiMocks(page: Page, options: OpenAppOptions = {}): Promise<void> {
  const messages = cloneMessages()

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()

    if (url.pathname === "/api/events" || url.pathname === "/api/herdr/events") {
      await route.fulfill({
        body: `data: ${JSON.stringify(TOPOLOGY)}\n\n`,
        contentType: "text/event-stream",
        status: 200,
      })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/inbox" && method === "GET") {
      await fulfillJson(route, { entries: mockInbox })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, { conversations: [] })
      return
    }
    if (url.pathname === "/api/herdr/workspaces" && method === "GET") {
      await fulfillJson(route, TOPOLOGY)
      return
    }
    if (url.pathname === "/api/herdr/harnesses" && method === "GET") {
      await fulfillJson(route, { harnesses: ["claude", "codex"] })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await fulfillJson(route, { roles: [] })
      return
    }
    if (url.pathname === "/api/herdr/launchers" && method === "GET") {
      await fulfillJson(route, { launchers: mockLaunchers })
      return
    }
    if (url.pathname === "/api/herdr/directories" && method === "GET") {
      await fulfillJson(route, { currentPath: "/Users/example/project", directories: [], parentPath: "/Users/example", truncated: false })
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await fulfillJson(route, { members: mockMembers })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await fulfillJson(route, { messages: messages.filter((message) => message.channel === channel) })
      return
    }
    if (url.pathname.endsWith("/context") && method === "GET") {
      await fulfillJson(route, { messages })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      // identity: false is the failed-identify state, so the claim must refuse.
      if (options.identity === false) {
        await route.fulfill({ body: JSON.stringify({ code: "Internal", error: "identify refused for this check" }), contentType: "application/json", status: 503 })
        return
      }
      await fulfillJson(route, { handle: "operator" })
      return
    }
    if (method === "GET") {
      await fulfillJson(route, {})
      return
    }
    await fulfillJson(route, { channel: "dm-abc123def456", cursorId: 0, messageId: 0 })
  })
}

interface OpenAppOptions {
  identity?: boolean
}

async function openApp(page: Page, options: OpenAppOptions = {}): Promise<void> {
  await installApiMocks(page, options)
  if (options.identity !== false) {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "msgr.identity.v1",
        JSON.stringify({ version: 1, hub: "http://127.0.0.1:4173", handle: "suleyman" }),
      )
    })
  }
  await page.goto("/")
  await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()
  await page.locator('[data-slot="message-scroller-item"]').first().waitFor()
}

const OPERABLE_CONTROL_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[role="button"]:not([aria-disabled="true"])',
  '[role="tab"]:not([aria-disabled="true"])',
].join(", ")

async function expectKeyboardReachSet(
  page: Page,
  scope: Locator,
  description: string,
  selector = OPERABLE_CONTROL_SELECTOR,
): Promise<void> {
  const controls = await scope.evaluate((root, candidateSelector) => {
    const visible = (node: HTMLElement): boolean => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }
    const enabled = (node: HTMLElement): boolean => node.getAttribute("aria-disabled") !== "true"
      && !(node instanceof HTMLButtonElement && node.disabled)
      && !(node instanceof HTMLInputElement && node.disabled)
      && !(node instanceof HTMLSelectElement && node.disabled)
      && !(node instanceof HTMLTextAreaElement && node.disabled)
    return [...root.querySelectorAll<HTMLElement>(candidateSelector)]
      .filter((node) => visible(node) && enabled(node))
      .map((node, index) => ({
        index,
        label: node.getAttribute("aria-label") ?? node.id ?? node.textContent?.replace(/\s+/gu, " ").trim().slice(0, 80) ?? node.tagName.toLowerCase(),
      }))
  }, selector)
  expect(controls.length, `${description} must expose operable controls`).toBeGreaterThan(0)

  const activeControlIndex = async (): Promise<number> => scope.evaluate((root, candidateSelector) => {
    const visible = (node: HTMLElement): boolean => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }
    const enabled = (node: HTMLElement): boolean => node.getAttribute("aria-disabled") !== "true"
      && !(node instanceof HTMLButtonElement && node.disabled)
      && !(node instanceof HTMLInputElement && node.disabled)
      && !(node instanceof HTMLSelectElement && node.disabled)
      && !(node instanceof HTMLTextAreaElement && node.disabled)
    const candidates = [...root.querySelectorAll<HTMLElement>(candidateSelector)]
      .filter((node) => visible(node) && enabled(node))
    const active = document.activeElement
    return active instanceof HTMLElement ? candidates.indexOf(active) : -1
  }, selector)

  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  const visited = new Set<number>()
  const maxSteps = Math.max(controls.length * 4 + 16, 24)
  for (let step = 0; step < maxSteps && visited.size < controls.length; step += 1) {
    await page.keyboard.press("Tab")
    const afterTab = await activeControlIndex()
    if (afterTab >= 0) visited.add(afterTab)

    const inComposite = await page.evaluate(() => {
      const active = document.activeElement
      return active instanceof HTMLElement
        && active.closest('[role="list"], [role="listbox"], [role="grid"], [role="tree"], [role="tablist"], [role="menu"], [data-keyboard-composite]') !== null
    })
    if (!inComposite) continue
    for (const key of ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"] as const) {
      await page.keyboard.press(key)
      const afterArrow = await activeControlIndex()
      if (afterArrow >= 0) visited.add(afterArrow)
    }
  }

  const missing = controls.filter(({ index }) => !visited.has(index))
  expect(missing, `${description} controls must be reachable by Tab or composite arrows`).toEqual([])
}

async function expectTabSequence(page: Page, controls: Locator, description: string): Promise<void> {
  const count = await controls.count()
  expect(count, `${description} must expose a non-empty control sequence`).toBeGreaterThan(0)
  await controls.first().focus()
  await expect(controls.first()).toBeFocused()
  for (let index = 1; index < count; index += 1) {
    await page.keyboard.press("Tab")
    await expect(controls.nth(index), `${description} control ${index + 1} must follow the prior control`).toBeFocused()
  }
}

async function focusChannelRow(page: Page, channel = "research") {
  const row = page.locator(`[data-channel-row="${channel}"]`)
  await row.focus()
  await expect(row).toBeFocused()
  return row
}

async function focusWorkspaceRow(page: Page) {
  const row = page.locator('[data-workspace-id="ws-alpha"]')
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute("data-collapsed", "false")
  const pane = page.locator('[data-pane-id="pane-alpha"]')
  await expect(pane).toHaveAttribute("data-identity-source", "participant")
  await expect(pane).toHaveAttribute("data-pane-status", "working")
  await expect(pane).not.toHaveAttribute("data-stale-route")
  await row.focus()
  await expect(row).toBeFocused()
  return row
}

test("@guard period opens the focused channel menu and Escape restores focus", async ({ page }) => {
  await openApp(page)
  const opener = await focusChannelRow(page)

  await page.keyboard.press(".")
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await expect(opener.locator('[data-menu-trigger="channel"]')).toBeVisible()
  await expect(menu).toHaveAttribute("data-menu", "channel")
  await expect(menu.locator('[data-menu-item="members"]')).toBeVisible()
  const menuItems = menu.locator("[data-menu-item]")
  await expect(menuItems.first()).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(menuItems.nth(1)).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard m manages members for the focused channel row", async ({ page }) => {
  await openApp(page)
  const opener = await focusChannelRow(page)

  await page.keyboard.press("m")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/members/i)
  await expect(dialog).toContainText("research")
  await expect(page.locator('[data-membership="member"]')).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard Shift+N opens the workspace-create shell page", async ({ page }) => {
  await openApp(page)
  await focusChannelRow(page)

  await page.keyboard.press("Shift+n")
  const pageView = page.locator('[data-shell-page="create-workspace"]')
  await expect(pageView).toBeVisible()
  await expect(pageView).toContainText(/create workspace/i)
  await expect(page.locator("#workspace-label")).toBeVisible()
  await expectTabSequence(
    page,
    pageView.locator("form input:not([disabled]), form textarea:not([disabled]), form button:not([disabled])"),
    "workspace creation form",
  )

  await page.locator("#workspace-label").focus()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.locator("#workspace-cwd")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(pageView.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")

  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()
})

test("@guard Shift+B broadcasts from the focused workspace row", async ({ page }) => {
  await openApp(page)
  const opener = await focusWorkspaceRow(page)

  await page.keyboard.press("Shift+b")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/broadcast/i)
  await expect(dialog).toContainText("runner")
  await expect(page.locator('[data-pane-id="pane-unmanaged"]')).toHaveAttribute("data-pane-status", "unmanaged")
  await expect(dialog.locator('[data-broadcast-routing]')).toHaveText("Routed agents: 1 · Unmanaged agents: 1")
  await expect(dialog.locator('[data-unmanaged-agents]')).toContainText("1 unmanaged agent is not connected to msgr.")
  await expect(dialog.locator('[data-unmanaged-agents]')).toContainText("They are not recipients and will not receive this message:")
  await expect(dialog.locator("textarea").first()).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard a opens the spawn-agent shell page for the focused workspace row", async ({ page }) => {
  await openApp(page)
  const opener = await focusWorkspaceRow(page)

  await page.keyboard.press("a")
  const pageView = page.locator('[data-shell-page="spawn-agent"]')
  await expect(pageView).toBeVisible()
  await expect(pageView).toContainText(/spawn agent/i)

  await page.keyboard.press("m")
  await expect(pageView).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(pageView).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard workspace close is menu-only and Esc pops the dialog then menu", async ({ page }) => {
  await openApp(page)
  const opener = await focusWorkspaceRow(page)

  await page.keyboard.press("Shift+w")
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await page.keyboard.press(".")
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await expect(page.locator('[data-menu-trigger="workspace"]')).toBeVisible()
  await expect(menu).toHaveAttribute("data-menu", "workspace")
  const closeItem = menu.locator('[data-menu-item="close-workspace"]')
  await expect(closeItem).toBeVisible()
  await closeItem.focus()
  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/close workspace/i)
  await expect(dialog.locator("input").first()).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard agent stop is menu-only and restores pane focus after confirmation cancel", async ({ page }) => {
  await openApp(page)
  const opener = page.locator('[data-pane-id="pane-alpha"]')
  await expect(opener).toBeVisible()
  await opener.focus()
  await expect(opener).toBeFocused()

  await page.keyboard.press(".")
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await expect(opener.locator('[data-menu-trigger]')).toBeVisible()
  await expect(menu).toHaveAttribute("data-menu", "pane")
  const stopItem = menu.locator('[data-menu-item="stop-agent"]')
  await expect(stopItem).toBeVisible()
  await stopItem.focus()
  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/stop agent/i)
  await expect(dialog).toContainText("runner")
  await expect(dialog.locator("input").first()).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("@guard menu-only actions are registered without default bindings", async ({ page }) => {
  await openApp(page)
  await page.keyboard.press("?")
  const help = page.getByRole("list", { name: "Current keyboard shortcuts" })

  const menuBindings = help.locator("kbd").filter({ hasText: /^\.$/u })
  await expect(menuBindings).toHaveCount(1)

  const closeBinding = help.locator("li").filter({ hasText: "Close workspace" }).locator("kbd")
  const stopBinding = help.locator("li").filter({ hasText: "Stop agent" }).locator("kbd")
  await expect(closeBinding).toHaveText("—")
  await expect(closeBinding).toHaveAttribute("title", "Reachable from the context menu only")
  await expect(stopBinding).toHaveText("—")
  await expect(stopBinding).toHaveAttribute("title", "Reachable from the context menu only")
})

test("@guard workspace create requires identity and performs no write in read-only mode", async ({ page }) => {
  await openApp(page, { identity: false })
  const opener = await focusChannelRow(page)
  const writes: string[] = []
  page.on("request", (request) => {
    const writePath = new URL(request.url()).pathname
    if (request.method() !== "GET" && writePath.startsWith("/api/") && writePath !== "/api/humans") writes.push(request.url())
  })

  await page.keyboard.press("Shift+n")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: /not connected/i })).toBeVisible()
  await expect(opener).toBeFocused()
  expect(writes).toEqual([])
})

test("@guard broadcast without a focused workspace reports no active target", async ({ page }) => {
  await openApp(page)
  const opener = await focusChannelRow(page)

  await page.keyboard.press("Shift+b")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: /workspace/i })).toBeVisible()
  await expect(opener).toBeFocused()
})

test("@guard workspace broadcast requires identity and performs no write in read-only mode", async ({ page }) => {
  await openApp(page, { identity: false })
  const opener = await focusWorkspaceRow(page)
  const writes: string[] = []
  page.on("request", (request) => {
    const writePath = new URL(request.url()).pathname
    if (request.method() !== "GET" && writePath.startsWith("/api/") && writePath !== "/api/humans") writes.push(request.url())
  })

  await page.keyboard.press("Shift+b")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: /not connected/i })).toBeVisible()
  await expect(opener).toBeFocused()
  expect(writes).toEqual([])
})

test("@guard agent spawn requires identity and performs no write in read-only mode", async ({ page }) => {
  await openApp(page, { identity: false })
  const opener = await focusWorkspaceRow(page)
  const writes: string[] = []
  page.on("request", (request) => {
    const writePath = new URL(request.url()).pathname
    if (request.method() !== "GET" && writePath.startsWith("/api/") && writePath !== "/api/humans") writes.push(request.url())
  })

  await page.keyboard.press("a")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: /not connected/i })).toBeVisible()
  await expect(opener).toBeFocused()
  expect(writes).toEqual([])
})

test("@guard quick navigation reaches every new directory page with Enter", async ({ page }) => {
  await openApp(page)
  const quickNav = page.locator("[data-quick-nav]")
  await expectKeyboardReachSet(page, quickNav, "quick navigation")

  for (const route of ["workspaces", "agents", "channels", "direct"] as const) {
    const item = quickNav.locator(`[data-quick-nav-item="${route}"]`)
    await item.focus()
    await expect(item).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator(`[data-shell-page="${route}"]`)).toBeVisible()
    await expect(item).toHaveAttribute("aria-current", "page")
  }
})

test("@guard directory controls are reachable without asserting row order", async ({ page }) => {
  await openApp(page)

  for (const route of ["workspaces", "channels", "direct", "agents"] as const) {
    await page.goto(`/${route}`)
    const directory = page.locator(`[data-directory="${route}"]`)
    await expect(directory).toBeVisible()
    // Rebuilt directories use the page header. Direct and agents still use an h2.
    const headerOnly = new Set(["workspaces", "channels"])
    if (headerOnly.has(route)) await expect(page.locator(`[data-shell-page="${route}"] h1`)).toBeVisible()
    else await expect(directory.locator("h2").first()).toBeVisible()
    await expectKeyboardReachSet(page, directory, `${route} directory`)
  }
})

test("@guard section collapse controls are keyboard reachable and operable", async ({ page }) => {
  await openApp(page)
  const sidebar = page.locator("[data-sidebar-rail]")
  const sectionControlSelector = '[data-section] [data-shell-nav], [data-section-collapse]'
  await expectKeyboardReachSet(page, sidebar, "sidebar section controls", sectionControlSelector)

  for (const route of ["workspaces", "agents", "channels", "direct"] as const) {
    const collapse = page.locator(`[data-section-collapse="${route}"]`)
    const before = await collapse.getAttribute("aria-expanded")
    await collapse.focus()
    await expect(collapse).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(collapse, `${route} collapse control must change state on Enter`).not.toHaveAttribute("aria-expanded", before ?? "")
    await page.keyboard.press("Enter")
    await expect(collapse, `${route} collapse control must restore state on Enter`).toHaveAttribute("aria-expanded", before ?? "")
  }
})

test("@guard creation pages expose their form controls to keyboard focus", async ({ page }) => {
  await openApp(page)
  await focusChannelRow(page)

  await page.keyboard.press("n")
  const channelPage = page.locator('[data-shell-page="create-channel"]')
  await expect(channelPage).toBeVisible()
  await expectTabSequence(
    page,
    channelPage.locator("form input:not([disabled]), form textarea:not([disabled]), form button:not([disabled])"),
    "channel creation form",
  )
  await page.locator("#channel-name").focus()
  await page.keyboard.press("Tab")
  await expect(page.locator("#channel-topic")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(channelPage.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-shell-page="channels"]')).toBeVisible()

  const directNav = page.locator('[data-quick-nav-item="direct"]')
  await directNav.focus()
  await expect(directNav).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-shell-page="direct"]')).toBeVisible()
  const startDirect = page.locator('[data-shell-page="direct"]').getByRole("button", { name: "Start direct message", exact: true }).first()
  await startDirect.focus()
  await page.keyboard.press("Enter")

  const directPage = page.locator('[data-shell-page="compose-direct"]')
  await expect(directPage).toBeVisible()
  await expectTabSequence(
    page,
    directPage.locator("form input:not([disabled]), form textarea:not([disabled]), form button:not([disabled])"),
    "direct-message creation form",
  )
  await page.locator("#direct-recipients").focus()
  await page.keyboard.press("Tab")
  const attachPath = directPage.getByRole("button", { name: "Attach path", exact: true })
  await expect(attachPath).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("#direct-attachment-path")).toBeVisible()
  await page.locator("#direct-attachment-path").focus()
  await page.keyboard.press("Tab")
  await expect(directPage.getByRole("button", { name: "Add", exact: true })).toBeFocused()
  await directPage.getByRole("button", { name: "Back to direct", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-shell-page="direct"]')).toBeVisible()
})

test("@guard launcher list and forms expose keyboard actions", async ({ page }) => {
  await openApp(page)
  await page.goto("/launchers")

  const list = page.locator('[data-shell-page="launchers"]')
  await expect(list).toBeVisible()
  await expect(page.locator('[data-launcher-row="codex"]')).toBeVisible()
  await expectKeyboardReachSet(page, list, "launcher list")

  const create = page.getByRole("button", { name: "Create launcher alias", exact: true })
  await create.focus()
  await page.keyboard.press("Enter")
  const createForm = page.locator('[data-launcher-form="create"]')
  await expect(createForm).toBeVisible()
  await page.locator("#launcher-name").focus()
  await page.keyboard.press("Tab")
  await expect(page.locator("#launcher-agent-kind")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.locator("#launcher-account-profile-heading")).toBeVisible()
  await createForm.getByRole("button", { name: "Add argument", exact: true }).click()
  await expect(page.locator("#launcher-argv")).toBeVisible()
  await page.locator("#launcher-argv").fill("--example")
  await expect(createForm.getByRole("button", { name: "Remove launch argument 1", exact: true })).toBeVisible()
  const launcherPrimaryControls = "button:not([disabled]):not([aria-label='Open Harness options']), input:not([disabled]):not(#launcher-agent-kind-hidden-input):not(#launcher-start-timeout)"
  await expectKeyboardReachSet(page, createForm, "launcher creation form", launcherPrimaryControls)
  const advanced = createForm.locator("[data-launcher-advanced]")
  await advanced.locator("summary").click()
  await expect(advanced.locator("#launcher-start-timeout")).toBeVisible()
  await expectTabSequence(page, advanced.locator("button:not([disabled]), input:not([disabled])"), "launcher creation advanced controls")
  await createForm.getByRole("button", { name: "Cancel", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(list).toBeVisible()

  const edit = page.getByRole("button", { name: "Edit launcher alias codex", exact: true })
  await edit.focus()
  await page.keyboard.press("Enter")
  const editForm = page.locator('[data-launcher-form="edit"]')
  await expect(editForm).toBeVisible()
  await expect(page.locator("#launcher-name")).toHaveAttribute("readonly", "")
  await expect(page.locator("#launcher-executable")).toHaveValue("codex")
  await expectKeyboardReachSet(page, editForm, "launcher edit form", launcherPrimaryControls)
  await page.locator("#launcher-name").focus()
  await page.keyboard.press("Tab")
  await expect(page.locator("#launcher-agent-kind")).toBeFocused()
  await page.keyboard.press("Tab")
  await page.locator("#launcher-executable").focus()
  await expect(page.locator("#launcher-executable")).toBeFocused()
  await editForm.getByRole("button", { name: "Cancel", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(list).toBeVisible()
})

test("@guard launcher account profile folder browser sets an absolute value", async ({ page }) => {
  await openApp(page)
  await page.goto("/launchers/new")
  const form = page.locator('[data-launcher-form="create"]')
  await expect(form).toBeVisible()
  await page.locator("#launcher-agent-kind").click()
  await page.locator('[data-combobox-option="codex"]').click()
  await form.getByRole("button", { name: "Use separate account folder", exact: true }).click()
  await form.getByRole("button", { name: "Browse folder", exact: true }).click()
  await expect(page.locator('[data-launcher-directory-picker="true"]')).toBeVisible()
  await page.getByRole("button", { name: "Use this folder", exact: true }).click()
  await expect(page.locator("#launcher-account-profile-folder")).toHaveValue("/Users/example/project")
})

test("@guard detail-only workspace tab controls stay reachable without a pointer", async ({ page }) => {
  await openApp(page)
  await page.goto("/workspaces")
  await page.locator('[data-workspace-open="ws-alpha"]').click()
  await expect(page).toHaveURL(/\/workspaces\/ws-alpha$/)

  const tabs = page.locator('[data-workspace-tabs="ws-alpha"]')
  await expect(tabs).toBeVisible()
  await expectKeyboardReachSet(page, tabs, "workspace tab controls")
  const newTabName = page.locator("#new-tab-ws-alpha")
  await newTabName.focus()
  await page.keyboard.press("Tab")
  await expect(tabs.getByRole("button", { name: "Create tab", exact: true })).toBeFocused()

  const tab = tabs.getByRole("tab", { name: /Main/ })
  await tab.focus()
  await page.keyboard.press("Tab")
  const rename = tabs.getByRole("button", { name: "Rename Main", exact: true })
  await expect(rename).toBeFocused()
  await page.keyboard.press("Tab")
  const close = tabs.getByRole("button", { name: "Close Main", exact: true })
  await expect(close).toBeFocused()

  await rename.focus()
  await page.keyboard.press("Enter")
  const renameInput = page.locator("#rename-tab-tab-alpha-main")
  await expect(renameInput).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(tabs.getByRole("button", { name: "Save name for Main", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(tabs.getByRole("button", { name: "Cancel rename for Main", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(renameInput).toHaveCount(0)

  await close.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.locator("#close-tab-confirm")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
