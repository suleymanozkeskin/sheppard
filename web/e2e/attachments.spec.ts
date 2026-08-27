import { expect, test, type Page, type Route } from "@playwright/test"

import { mockAttachments, mockChannels, mockDirectConversations, mockMembers, mockMessages } from "../src/api/fixtures"

interface AttachmentMockOptions {
  identity?: boolean
}

interface AttachmentMockHandle {
  writes: string[]
}

const rows = [
  { attachment: mockAttachments[2], channel: "ops", createdAt: mockMessages[3]?.createdAt ?? "2026-08-17T09:45:00.000Z", messageId: 4, sender: "suleyman" },
  { attachment: mockAttachments[1], channel: "ops", createdAt: mockMessages[3]?.createdAt ?? "2026-08-17T09:45:00.000Z", messageId: 4, sender: "suleyman" },
  { attachment: mockAttachments[0], channel: "ops", createdAt: mockMessages[1]?.createdAt ?? "2026-08-12T09:24:00.000Z", messageId: 2, sender: "suleyman" },
]

type JsonValue = boolean | Record<string, JsonValue> | JsonValue[] | null | number | string

async function json(route: Route, payload: JsonValue, status = 200): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status })
}

async function installAttachmentApiMocks(page: Page, options: AttachmentMockOptions = {}): Promise<AttachmentMockHandle> {
  const writes: string[] = []
  await page.addInitScript((identityAvailable: boolean) => {
    if (!identityAvailable) {
      window.localStorage.removeItem("msgr.identity.v1")
      return
    }
    window.localStorage.setItem(
      "msgr.identity.v1",
      JSON.stringify({ version: 1, hub: window.location.origin, handle: "suleyman" }),
    )
  }, options.identity !== false)
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/api/events" || url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      if (options.identity === false) {
        await route.fulfill({ body: JSON.stringify({ code: "Unavailable", error: "refused" }), contentType: "application/json", status: 503 })
      } else {
        await json(route, { handle: "suleyman" })
      }
      return
    }
    if (url.pathname === "/api/attachments" && method === "GET") {
      const channel = url.searchParams.get("channel")
      const kind = url.searchParams.get("kind")
      const filtered = rows.filter((row) =>
        (channel === null || row.channel === channel) &&
        (kind === null || (kind === "image" ? row.attachment.previewKind === "image" : kind === "markdown" ? row.attachment.previewKind === "markdown" : row.attachment.previewKind === null)),
      )
      await json(route, { rows: filtered, truncated: false })
      return
    }
    if (url.pathname.startsWith("/api/attachments/") && url.pathname.endsWith("/content")) {
      if (url.pathname.endsWith("/101/content")) {
        await route.fulfill({ body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), contentType: "image/png", status: 200 })
      } else {
        await route.fulfill({ body: "# Release notes\n", contentType: "text/markdown", status: 200 })
      }
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await json(route, url.searchParams.get("kind") === "workspace" ? { channels: [] } : { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await json(route, { conversations: mockDirectConversations })
      return
    }
    if (url.pathname === "/api/inbox" && method === "GET") {
      await json(route, { entries: [] })
      return
    }
    if (url.pathname === "/api/participants" && method === "GET") {
      await json(route, { participants: mockMembers.map(({ agentKind, handle, kind, routeState }) => ({ agentKind, handle, kind, routeState })) })
      return
    }
    if (url.pathname === "/api/herdr/workspaces" && method === "GET") {
      await json(route, { workspaces: [] })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await json(route, { roles: [] })
      return
    }
    if (url.pathname.endsWith("/receipts") && method === "GET") {
      await json(route, [])
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await json(route, { members: mockMembers })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await json(route, { messages: mockMessages.filter((message) => message.channel === channel) })
      return
    }
    if (url.pathname.endsWith("/context") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await json(route, { messages: mockMessages.filter((message) => message.channel === channel) })
      return
    }
    if (method !== "GET" && url.pathname !== "/api/humans") writes.push(`${method} ${url.pathname}`)
    if (method === "GET") {
      await json(route, {})
      return
    }
    await json(route, { channel: "ops", cursorId: 0, messageId: 0 })
  })
  return { writes }
}

async function chooseAttachmentKind(page: Page, label: string): Promise<void> {
  await page.getByRole("group", { name: "File type" }).getByRole("button", { name: label, exact: true }).click()
}

test("@guard attachments route preserves filters, reload, and replace history", async ({ page }) => {
  await installAttachmentApiMocks(page)
  await page.goto("/")
  await page.keyboard.press("Control+k")
  await page.locator('[data-dialog="channel-picker"]').getByText("Attachments", { exact: true }).click()
  await expect(page).toHaveURL(/\/attachments\?scope=all&kind=all$/)
  await expect(page.locator('[data-shell-page="attachments"]')).toBeVisible()
  await expect(page.locator('[data-attachment-row="103"]')).toBeVisible()
  await expect(page.locator('[data-attachment-truncated="true"]')).toHaveCount(0)
  await expect(page.locator('[data-attachment-row="101"] [data-attachment-preview="thumbnail"]')).toBeVisible()
  await expect(page.locator('[data-attachment-metadata]').first()).toContainText("suleyman")
  await expect(page.locator('[data-attachment-metadata]').first()).toContainText("#ops")
  await expect(page.locator("select")).toHaveCount(0)
  await expect(page.locator('[data-combobox="attachments-scope"]')).toBeVisible()
  await expect(page.getByRole("group", { name: "File type" })).toBeVisible()
  await expect(page.locator('[data-scope-filter="all"] [data-combobox-value]')).toHaveText("All channels")
  await expect(page.getByRole("button", { name: "All file types", exact: true })).toHaveAttribute("aria-pressed", "true")

  const scopeInput = page.locator("#attachments-scope")
  await scopeInput.click()
  await scopeInput.fill("Direct conversation")
  await expect(page.locator('[data-combobox-option="channel:dm-planner-runner"]')).toBeVisible()
  await expect(page.locator('[data-combobox-option="channel:ops"]')).toHaveCount(0)
  await scopeInput.fill("dm-planner-runner")
  await expect(page.locator('[data-combobox-option="channel:dm-planner-runner"]')).toBeVisible()
  await expect(page.locator('[data-combobox-option="channel:ops"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-combobox="attachments-scope"]')).toHaveAttribute("data-combobox-open", "false")
  await expect(page).toHaveURL(/\/attachments\?scope=all&kind=all$/)

  await scopeInput.click()
  await scopeInput.fill("ops")
  await scopeInput.press("ArrowDown")
  await scopeInput.press("Enter")
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aops&kind=all$/)

  await chooseAttachmentKind(page, "Markdown")
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aops&kind=markdown$/)
  await expect(page.locator('[data-attachment-row="103"]')).toBeVisible()
  await page.locator('[data-attachment-row="103"]').focus()
  await expect(page.locator('[data-attachment-row="103"]')).toBeFocused()
  await expect(page.locator('[data-attachment-row="102"]')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('[data-scope-filter="channel:ops"] [data-combobox-value]')).toHaveText("#ops")
  await expect(page.locator('[data-kind-filter="markdown"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Markdown", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator('[data-attachment-row="103"]')).toBeVisible()

  await page.locator("#attachments-scope").click()
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-combobox="attachments-scope"]')).toHaveAttribute("data-combobox-open", "false")
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aops&kind=markdown$/)
  await expect(page.locator("#attachments-scope")).toBeFocused()
  await page.locator("#attachments-scope").press("Escape")
  await expect(page).toHaveURL(/\/$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aops&kind=markdown$/)
})

test("@guard attachments use one roving row stop, open previews, and route message context", async ({ page }) => {
  await installAttachmentApiMocks(page)
  await page.goto("/attachments?scope=all&kind=all")
  const firstRow = page.locator('[data-attachment-row="103"]')
  await expect(firstRow).toBeFocused()
  await page.keyboard.press(".")
  const firstMenu = page.locator('[data-attachment-menu]')
  await expect(firstMenu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(firstMenu).toHaveCount(0)
  await expect(firstRow).toBeFocused()
  await page.keyboard.press(".")
  await page.locator('[data-attachment-menu-item="copy"]').click()
  await expect(page.locator('[data-attachment-copy-state]')).toHaveText("Attachment path copied.")
  await expect(firstRow).toBeFocused()
  await page.keyboard.press("j")
  await expect(page.locator('[data-attachment-row="102"]')).toBeFocused()
  await expect(page.locator('[data-attachment-row="102"] [data-attachment-action]')).toHaveCount(1)
  await expect(page.locator('[data-attachment-row] [data-attachment-action]').evaluateAll((actions) => actions.map((action) => action.getAttribute("tabindex")))).resolves.toEqual(["-1", "-1", "-1", "-1", "-1"])
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/channels\/ops\?messageId=4$/)

  await page.goto("/attachments?scope=all&kind=all")
  const imageRow = page.locator('[data-attachment-row="101"]')
  await expect(page.locator('[data-attachment-row="103"]')).toBeFocused()
  await page.keyboard.press("j")
  await page.keyboard.press("j")
  await expect(imageRow).toBeFocused()
  await page.keyboard.press(".")
  const imageMenu = page.locator('[data-attachment-menu]')
  await imageMenu.getByRole("menuitem", { name: "View" }).click()
  await expect(page.locator('[data-attachment-viewer-kind="image"]')).toBeVisible()
  await expect(imageRow).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-attachment-viewer-kind="image"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(/\/$/)
})

test("@guard attachments expose channel navigation, header paperclip, and quick-switcher entries", async ({ page }) => {
  await installAttachmentApiMocks(page)
  await page.goto("/attachments?scope=all&kind=all")
  await page.locator('[data-attachment-channel="ops"]').first().click()
  await expect(page).toHaveURL(/\/channels\/ops$/)

  await page.goto("/attachments?scope=all&kind=all")
  await expect(page.locator('[data-attachment-row="103"]')).toBeVisible()
  await page.keyboard.press("Control+k")
  const picker = page.locator('[data-dialog="channel-picker"]')
  await expect(picker.getByText("Search", { exact: true })).toBeVisible()
  await expect(picker.getByText("Attachments", { exact: true })).toBeVisible()
  await picker.getByText("Search", { exact: true }).click()
  await expect(page).toHaveURL(/\/search\?q=&scope=all$/)

  await page.goto("/")
  await expect(page.locator("[data-channel-attachments]")).toBeVisible()
  await page.locator("[data-channel-attachments]").click()
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aops&kind=all$/)
})

test("@guard workspace broadcast attachments use the workspace channel kind", async ({ page }) => {
  await installAttachmentApiMocks(page)
  await page.route("**/api/attachments**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/api/attachments") {
      await route.fallback()
      return
    }
    await json(route, {
      rows: [{
        attachment: { ...mockAttachments[1], id: 104, path: "/workspace/broadcast.txt", displayName: "broadcast.txt" },
        channel: "ws-sheppard",
        createdAt: "2026-08-18T09:00:00.000Z",
        messageId: 8,
        sender: "planner",
      }, ...rows],
      truncated: false,
    })
  })
  await page.goto("/attachments?scope=all&kind=all")
  await page.locator('[data-attachment-row="104"]').click()
  await expect(page).toHaveURL(/\/channels\/ws-sheppard\?messageId=8$/)
  await expect(page.getByText("Workspace broadcast", { exact: true }).first()).toBeVisible()
  await expect(page.locator("body")).not.toContainText("#ws-sheppard")
})

test("@guard attachments show retry and empty states", async ({ page }) => {
  await installAttachmentApiMocks(page)
  let listAttempts = 0
  await page.route("**/api/attachments**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/api/attachments") {
      await route.fallback()
      return
    }
    listAttempts += 1
    if (listAttempts === 1) {
      await json(route, { error: "temporary listing failure" }, 503)
      return
    }
    await json(route, { rows: [], truncated: false })
  })
  await page.goto("/attachments?scope=all&kind=all")
  await expect(page.locator('[data-attachment-state="error"]')).toBeVisible()
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.locator('[data-attachment-state="empty"]')).toBeVisible()
  await expect(page.getByText("No files have been shared.", { exact: true })).toBeVisible()
  await expect(page.getByText("Attach a file by absolute path from any composer.", { exact: true })).toBeVisible()
})

test("@guard attachments without hub identity keep filters and copy but block preview", async ({ page }) => {
  const mock = await installAttachmentApiMocks(page, { identity: false })
  await page.goto("/attachments?scope=all&kind=all")
  const firstRow = page.locator('[data-attachment-row="103"]')
  await expect(page.locator('[data-attachment-identity]')).toHaveText("Not connected to the hub.")
  await expect(firstRow).toBeFocused()
  await expect(page.locator('[data-attachment-row="101"] [data-attachment-preview="thumbnail"]')).toHaveCount(0)
  expect(mock.writes).toEqual([])

  await chooseAttachmentKind(page, "Markdown")
  await expect(page).toHaveURL(/\/attachments\?scope=all&kind=markdown$/)
  await firstRow.focus()
  await expect(firstRow).toBeFocused()
  expect(mock.writes).toEqual([])
  await page.keyboard.press(".")
  const markdownMenu = page.locator('[data-attachment-menu]')
  await expect(markdownMenu.getByRole("menuitem", { name: "View" })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(markdownMenu).toHaveCount(0)
  await expect(firstRow).toBeFocused()
  expect(mock.writes).toEqual([])

  await page.keyboard.press(".")
  await markdownMenu.getByRole("menuitem", { name: "Copy path" }).click()
  await expect(page.locator('[data-attachment-copy-state]')).toHaveText("Attachment path copied.")
  await expect(firstRow).toBeFocused()
  await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe("/Users/demo/notes/release-notes.md")
  expect(mock.writes).toEqual([])

  await chooseAttachmentKind(page, "All file types")
  const imageRow = page.locator('[data-attachment-row="101"]')
  await expect(imageRow).toBeVisible()
  await expect(imageRow.locator('[data-attachment-action="view"]')).toHaveCount(0)
  await imageRow.focus()
  await page.keyboard.press(".")
  const imageMenu = page.locator('[data-attachment-menu]')
  await expect(imageMenu.getByRole("menuitem", { name: "View" })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(imageMenu).toHaveCount(0)
  await expect(imageRow).toBeFocused()
  expect(mock.writes).toEqual([])
})
