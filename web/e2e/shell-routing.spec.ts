import { expect, test, type Page } from "@playwright/test"
import * as v from "valibot"

import { mockChannels, mockDirectConversations, mockMembers } from "../src/api/fixtures"
import type { AgentSession, AgentSessionSelectionRequest, Member } from "../src/api/types"

type DirectoryParticipant = Pick<Member, "agentKind" | "handle" | "kind" | "routeState">
type DirectoryPane = {
  paneId: string
  label: string | null
  agentKind: string | null
  agentStatus: "idle" | "working" | "blocked" | "done" | "unknown"
  focused: boolean
  participant: string | null
  participantRouteState: "active" | "stale" | null
}
type DirectoryTab = { id: string; label: string | null; panes: DirectoryPane[] }
type DirectoryTopology = {
  workspaces: Array<{
    id: string
    label: string | null
    panes: DirectoryPane[]
    tabs: DirectoryTab[]
  }>
}
type DirectoryAgentDetail = {
  participant: {
    handle: string
    kind: "agent"
    agentKind: string | null
    routeState: "active" | "stale"
    lastSeenAt: string | null
  }
  routeState: "active" | "stale"
  pane: DirectoryTopology["workspaces"][number]["panes"][number] | null
  recentMessageIds: Array<{ channel: string; messageIds: number[] }>
}
type DirectoryPayload =
  | { channels: typeof mockChannels }
  | { conversations: typeof mockDirectConversations }
  | { participants: DirectoryParticipant[] }
  | { members: typeof mockMembers }
  | { harnesses: string[] }
  | { roles: never[] }
  | { workspaces: DirectoryTopology["workspaces"] }
  | { currentPath: string; parentPath: string | null; directories: Array<{ name: string; path: string }>; truncated: boolean }
  | AgentSession
  | DirectoryAgentDetail
  | { state: "ready"; sessionId: string }
  | { handle: string }
  | { code: string; error: string }
  | { messages: never[] }
  | Record<string, never>

const sessionSelectionRequestSchema = v.object({ sessionId: v.string() })

interface SessionSelectionFixture {
  delayMs?: number
  fail?: boolean
  readySession?: AgentSession
}

interface DirectoryApiMockHandle {
  selectionRequests: AgentSessionSelectionRequest[]
  sessionRequests: string[]
}

async function installDirectoryApiMocks(
  page: Page,
  topology: DirectoryTopology = { workspaces: [] },
  session?: AgentSession,
  selection?: SessionSelectionFixture,
): Promise<DirectoryApiMockHandle> {
  let currentSession = session
  const selectionRequests: AgentSessionSelectionRequest[] = []
  const sessionRequests: string[] = []
  await page.addInitScript(() => {
    window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: window.location.origin, handle: "operator" }))
  })
  await page.addInitScript((snapshot: DirectoryTopology) => {
    const passThrough = globalThis.fetch.bind(globalThis)
    const encoder = new TextEncoder()
    const patched: typeof globalThis.fetch = (input, init) => {
      const href = String(input instanceof Request ? input.url : input)
      const path = new URL(href, globalThis.location.origin).pathname
      if (path !== "/api/events") return passThrough(input, init)
      const body = new ReadableStream<Uint8Array>({
        start: (stream) => {
          stream.enqueue(encoder.encode(`: ready\n\nevent: topology\ndata: ${JSON.stringify(snapshot)}\n\n`))
          init?.signal?.addEventListener("abort", () => stream.close(), { once: true })
        },
      })
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" }, status: 200 }))
    }
    globalThis.fetch = patched
  }, topology)
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const json = (payload: DirectoryPayload, status = 200): Promise<void> => route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status })
    if (url.pathname === "/api/channels" && method === "GET") {
      await json({ channels: mockChannels })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await json({ conversations: mockDirectConversations })
      return
    }
    if (url.pathname === "/api/participants") {
      await json({ participants: mockMembers.map(({ agentKind, handle, kind, routeState }) => ({ agentKind, handle, kind, routeState })) })
      return
    }
    if (url.pathname.startsWith("/api/agents/") && method === "GET") {
      const handle = decodeURIComponent(url.pathname.slice("/api/agents/".length))
      const pane = topology.workspaces.flatMap((workspace) => workspace.panes).find((candidate) => candidate.participant === handle) ?? null
      await json({
        participant: {
          agentKind: pane?.agentKind ?? null,
          handle,
          kind: "agent",
          lastSeenAt: null,
          routeState: pane?.participantRouteState ?? "active",
        },
        pane,
        recentMessageIds: [],
        routeState: pane?.participantRouteState ?? "active",
      })
      return
    }
    if (url.pathname.startsWith("/api/herdr/agents/") && url.pathname.endsWith("/session/select") && method === "POST") {
      const body = v.parse(sessionSelectionRequestSchema, JSON.parse(route.request().postData() ?? "{}"))
      selectionRequests.push(body)
      if ((selection?.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, selection.delayMs))
      if (selection?.fail === true) {
        await json({ code: "ValidationFailed", error: "The selected session is no longer a current candidate." }, 400)
        return
      }
      if (selection?.readySession !== undefined) currentSession = selection.readySession
      await json({ state: "ready", sessionId: body.sessionId })
      return
    }
    if (url.pathname.startsWith("/api/herdr/agents/") && url.pathname.endsWith("/session") && method === "GET") {
      sessionRequests.push(decodeURIComponent(url.pathname.split("/").at(-2) ?? ""))
      await json(currentSession ?? {})
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await json({ members: mockMembers })
      return
    }
    if (url.pathname === "/api/events") {
      await route.fulfill({ body: `: ready\n\nevent: topology\ndata: ${JSON.stringify(topology)}\n\n`, contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: `data: ${JSON.stringify({ workspaces: [] })}\n\n`, contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/harnesses") {
      await json({ harnesses: [] })
      return
    }
    if (url.pathname === "/api/herdr/roles") {
      await json({ roles: [] })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      await json({ handle: "operator" })
      return
    }
    if (url.pathname === "/api/herdr/workspaces") {
      await json({ workspaces: topology.workspaces })
      return
    }
    if (url.pathname === "/api/herdr/directories") {
      const currentPath = url.searchParams.get("path") ?? "/Users/suleyman/Desktop/Personal-Projects"
      const parentPath = currentPath === "/" ? null : currentPath.replace(/\/[^/]+$/u, "") || "/"
      const directories = currentPath === "/Users/suleyman/Desktop/Personal-Projects"
        ? ["sheppard", "herdr-contribute"].map((name) => ({ name, path: `${currentPath}/${name}` }))
        : currentPath.endsWith("/sheppard")
          ? ["src", "tests", "web"].map((name) => ({ name, path: `${currentPath}/${name}` }))
          : []
      await json({ currentPath, parentPath, directories, truncated: false })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      await json({ messages: [] })
      return
    }
    if (method === "GET") {
      await json({})
      return
    }
    await json({})
  })
  return { selectionRequests, sessionRequests }
}

test("@guard control-plane navigation uses browser history and exposes creation routes", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/workspaces")
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()

  // Two controls navigate to Channels and share an accessible name: the quick-nav row
  // and the section header. Scope to the quick-nav row rather than widening the name,
  // so this stays unambiguous when either control changes.
  await page.locator('[data-quick-nav-item="channels"]').click()
  await expect(page).toHaveURL(/\/channels$/)
  await expect(page.locator('[data-shell-page="channels"]')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()

  await page.locator('[data-directory="workspaces"]').getByRole("button", { name: "Create workspace" }).first().click()
  await expect(page).toHaveURL(/\/workspaces\/new$/)
  await expect(page.locator('[data-shell-page="create-workspace"]')).toBeVisible()
})

test("@guard every primary page has a Back control", async ({ page }) => {
  await installDirectoryApiMocks(page)
  const paths = [
    "/",
    "/workspaces",
    "/channels",
    "/channels/ops",
    "/direct",
    "/direct/dm-planner-runner",
    "/agents",
    "/launchers",
    "/staffing",
    "/search?q=&scope=all",
    "/attachments?scope=all&kind=all",
  ]

  for (const path of paths) {
    await page.goto(path)
    await expect(page.locator("[data-shell-back]"), `${path} must have a Back control`).toBeVisible()
  }
})

test("@guard workspace creation uses the folder picker and keeps path entry", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/workspaces/new")

  await page.getByRole("button", { name: "Choose folder" }).click()
  const picker = page.locator('[data-workspace-directory-picker="true"]')
  await expect(picker).toBeVisible()
  await expect(picker).toContainText("/Users/suleyman/Desktop/Personal-Projects")
  await picker.getByRole("button", { name: "sheppard" }).click()
  await expect(picker).toContainText("/Users/suleyman/Desktop/Personal-Projects/sheppard")
  await picker.getByRole("button", { name: "Use this folder" }).click()
  await expect(picker).toHaveCount(0)
  await expect(page.locator("#workspace-cwd")).toHaveValue("/Users/suleyman/Desktop/Personal-Projects/sheppard")
  await expect(page.locator("#workspace-cwd")).toBeEditable()
})

test("@guard directory pages show channel and direct conversation rows", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/channels")
  await expect(page.locator('[data-shell-page="channels"]')).toBeVisible()
  await expect(page.locator('[data-directory="channels"]')).toBeVisible()
  await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toContainText("Deployments, incidents, and hand-offs")
  await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toContainText("4 members")

  await page.goto("/direct")
  await expect(page.locator('[data-shell-page="direct"]')).toBeVisible()
  const directSidebar = page.locator('[data-sidebar-family="direct"]')
  await expect(directSidebar).toBeVisible()
  await expect(directSidebar.locator('[data-channel-row="dm-planner-runner"]')).toContainText("planner, runner")
  await expect(directSidebar.locator('[data-channel-row="dm-planner-runner"]')).toContainText("1")
})

test("@guard Agents directory opens an agent detail page", async ({ page }) => {
  await installDirectoryApiMocks(page, {
    workspaces: [{
      id: "workspace-sheppard",
      label: "sheppard",
      panes: [{
        paneId: "pane-web",
        label: "web",
        agentKind: "codex",
        agentStatus: "working",
        focused: true,
        participant: "codex-reviewer",
        participantRouteState: "active",
      }],
      tabs: [{
        id: "tab-main",
        label: "Main",
        panes: [{
          paneId: "pane-web",
          label: "web",
          agentKind: "codex",
          agentStatus: "working",
          focused: true,
          participant: "codex-reviewer",
          participantRouteState: "active",
        }],
      }],
    }],
  })
  await page.goto("/agents")
  await expect(page.locator('[data-shell-page="agents"]')).toBeVisible()
  await expect(page.locator('[data-directory="agents"] [data-agent-row="codex-reviewer"]')).toContainText("codex")
  await expect(page.locator('[data-directory="agents"] [data-agent-row="codex-reviewer"] [data-agent-status-size="20"]')).toBeVisible()

  await page.getByRole("button", { name: "Open agent codex-reviewer" }).click()
  await expect(page).toHaveURL(/\/agents\/codex-reviewer$/)
  await expect(page.locator('[data-agent-view="codex-reviewer"]')).toContainText("pane-web")
})

test("@guard empty Agents page keeps one spawn action", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/agents")

  await expect(page.locator('[data-directory="agents"]')).toBeVisible()
  await expect(page.locator('[data-directory="agents"] [data-agent-row]')).toHaveCount(0)
  await expect(page.locator('[data-shell-page="agents"]').getByRole("button", { name: "Spawn agent", exact: true })).toHaveCount(1)
  await expect(page.locator('[data-directory="agents"]').getByText("Herdr reports no agent panes.")).toBeVisible()
})

test("@guard agent detail selects an ambiguous session, keeps the glance, and persists it", async ({ page }) => {
  const pane: DirectoryPane = {
    paneId: "pane-session",
    label: "session",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "codex-reviewer",
    participantRouteState: "active",
  }
  const topology: DirectoryTopology = {
    workspaces: [{
      id: "workspace-session",
      label: "session-workspace",
      panes: [pane],
      tabs: [{ id: "tab-session", label: "Main", panes: [pane] }],
    }],
  }
  const session: AgentSession = {
    turns: [],
    nextBefore: null,
    source: { state: "ambiguous", harness: "codex", sessionPath: null, glance: null, reason: null },
    mapping: {
      confidence: "ambiguous",
      candidates: [
        { sessionId: "older", path: "/sessions/older.jsonl", startedAt: "2026-08-19T08:00:00.000Z", sizeBytes: 1024, cwd: "/work/session", firstUserText: "Review the first batch." },
        { sessionId: "newer", path: "/sessions/newer.jsonl", startedAt: "2026-08-19T09:00:00.000Z", sizeBytes: 2048, cwd: "/work/session", firstUserText: "Review the second batch." },
      ],
    },
  }
  const selected: AgentSession = {
    turns: [{ kind: "turn", role: "assistant", text: "The selected session is ready.", tool: null, at: "2026-08-19T09:00:10.000Z", sidechain: false }],
    nextBefore: null,
    source: { state: "ready", harness: "codex", sessionPath: "/sessions/newer.jsonl", glance: "The selected session is ready.", reason: null },
    mapping: { confidence: "exact", candidates: [] },
  }
  const mock = await installDirectoryApiMocks(page, topology, session, { delayMs: 300, readySession: selected })
  await page.goto("/agents/codex-reviewer")
  await expect(page.locator('[data-agent-view="codex-reviewer"]')).toBeVisible()
  await expect(page.locator('[data-session-state="ambiguous"]')).toContainText("More than one session matches this pane")
  await expect(page.locator("[data-session-candidate]")).toHaveCount(2)
  await expect(page.locator('[data-session-candidate="older"]')).toContainText("Review the first batch.")
  await expect(page.locator('[data-session-candidate="newer"]')).toContainText("2048 bytes")
  await expect(page.locator("[data-session-picker] button")).toHaveCount(2)

  await page.getByRole("button", { name: "Select session newer" }).dblclick()
  await expect(page.locator('[data-session-selection-state="working"]')).toHaveText("Selecting session newer…")
  expect(mock.selectionRequests).toEqual([{ sessionId: "newer" }])
  await expect(page.locator('[data-agent-glance]')).toHaveText("The selected session is ready.")
  await expect(page.locator("[data-session-picker]")).toHaveCount(0)

  await page.reload()
  await expect(page.locator('[data-agent-glance]')).toHaveText("The selected session is ready.")
  await expect(page.locator("[data-session-picker]")).toHaveCount(0)
})

test("@guard agent detail keeps the picker and reports a failed session selection", async ({ page }) => {
  const pane: DirectoryPane = {
    paneId: "pane-session-fail",
    label: "session-fail",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "codex-reviewer",
    participantRouteState: "active",
  }
  const topology: DirectoryTopology = {
    workspaces: [{
      id: "workspace-session-fail",
      label: "session-fail-workspace",
      panes: [pane],
      tabs: [{ id: "tab-session-fail", label: "Main", panes: [pane] }],
    }],
  }
  const session: AgentSession = {
    turns: [],
    nextBefore: null,
    source: { state: "ambiguous", harness: "codex", sessionPath: null, glance: null, reason: null },
    mapping: {
      confidence: "ambiguous",
      candidates: [{ sessionId: "candidate", path: "/sessions/candidate.jsonl", startedAt: null, sizeBytes: 1024, cwd: "/work/session", firstUserText: "Continue the work." }],
    },
  }
  const mock = await installDirectoryApiMocks(page, topology, session, { fail: true })
  await page.goto("/agents/codex-reviewer")
  await expect(page.locator('[data-session-state="ambiguous"]')).toBeVisible()

  await page.getByRole("button", { name: "Select session candidate" }).click()
  await expect(page.locator('[data-session-selection-state="error"]')).toContainText("current candidate")
  await expect(page.locator('[data-session-state="ambiguous"]')).toBeVisible()
  expect(mock.selectionRequests).toEqual([{ sessionId: "candidate" }])
})

test("@guard delayed session selection cannot affect a different agent after navigation", async ({ page }) => {
  const oldPane: DirectoryPane = {
    paneId: "pane-session-old",
    label: "old-session",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "codex-reviewer",
    participantRouteState: "active",
  }
  const newPane: DirectoryPane = {
    paneId: "pane-session-new",
    label: "new-session",
    agentKind: "codex",
    agentStatus: "idle",
    focused: false,
    participant: "builder-3",
    participantRouteState: "active",
  }
  const topology: DirectoryTopology = {
    workspaces: [{
      id: "workspace-session-race",
      label: "session-race-workspace",
      panes: [oldPane, newPane],
      tabs: [{ id: "tab-session-race", label: "Main", panes: [oldPane, newPane] }],
    }],
  }
  const session: AgentSession = {
    turns: [],
    nextBefore: null,
    source: { state: "ambiguous", harness: "codex", sessionPath: null, glance: null, reason: null },
    mapping: {
      confidence: "ambiguous",
      candidates: [{ sessionId: "candidate", path: "/sessions/candidate.jsonl", startedAt: null, sizeBytes: 1024, cwd: "/work/session", firstUserText: "Continue the work." }],
    },
  }
  const mock = await installDirectoryApiMocks(page, topology, session, { delayMs: 500, fail: true })
  await page.goto("/agents/codex-reviewer")
  await expect(page.locator('[data-session-state="ambiguous"]')).toBeVisible()

  await page.getByRole("button", { name: "Select session candidate" }).click()
  await expect(page.locator('[data-session-selection-state="working"]')).toBeVisible()
  await page.locator('[data-quick-nav-item="agents"]').click()
  await expect(page).toHaveURL(/\/agents$/)
  await page.getByRole("button", { name: "Open agent builder-3" }).click()
  await expect(page).toHaveURL(/\/agents\/builder-3$/)
  await expect(page.locator('[data-agent-view="builder-3"]')).toBeVisible()
  await expect(page.locator('[data-session-state="ambiguous"]')).toBeVisible()
  const sessionRequestsOnNewPage = mock.sessionRequests.length

  await page.waitForTimeout(700)
  await expect(page.locator('[data-agent-view="builder-3"]')).toBeVisible()
  await expect(page.locator('[data-session-state="ambiguous"]')).toBeVisible()
  await expect(page.locator('[data-session-selection-state="error"]')).toHaveCount(0)
  expect(mock.sessionRequests.length).toBe(sessionRequestsOnNewPage)
  expect(mock.selectionRequests).toEqual([{ sessionId: "candidate" }])
})

test("@guard agent detail places the session glance in the pane title strip", async ({ page }) => {
  const pane: DirectoryPane = {
    paneId: "pane-glance",
    label: "glance",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "codex-reviewer",
    participantRouteState: "active",
  }
  const topology: DirectoryTopology = {
    workspaces: [{
      id: "workspace-glance",
      label: "glance-workspace",
      panes: [pane],
      tabs: [{ id: "tab-glance", label: "Main", panes: [pane] }],
    }],
  }
  const session: AgentSession = {
    turns: [],
    nextBefore: null,
    source: { state: "ready", harness: "codex", sessionPath: "/sessions/glance.jsonl", glance: "The pane is ready for review.", reason: null },
    mapping: { confidence: "exact", candidates: [] },
  }
  await installDirectoryApiMocks(page, topology, session)
  await page.goto("/agents/codex-reviewer")
  await expect(page.locator('[data-agent-glance]')).toHaveText("The pane is ready for review.")
  await expect(page.locator('[data-pane-title] [data-agent-glance]')).toHaveText("The pane is ready for review.")
})

test("@guard quick switcher finds each kind and routes Enter to its subject", async ({ page }) => {
  const pane: DirectoryPane = {
    paneId: "pane-switcher",
    label: "switcher",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "builder-3",
    participantRouteState: "active",
  }
  await installDirectoryApiMocks(page, {
    workspaces: [{
      id: "workspace-charlie",
      label: "charlie-workspace",
      panes: [pane],
      tabs: [{ id: "tab-switcher", label: "Switcher", panes: [pane] }],
    }],
  })
  await page.goto("/workspaces")
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()
  await expect(page.locator('[data-workspace-card="workspace-charlie"]')).toBeVisible()
  await expect(page.locator('[data-sidebar-family="workspaces"]')).toBeVisible()

  await page.keyboard.press("Control+k")
  const picker = page.locator('[data-dialog="channel-picker"]')
  await expect(picker).toBeVisible()
  const glyphs = await Promise.all(["chat", "direct", "agent", "workspace"].map(async (kind) =>
    picker.locator(`[data-picker-group="${kind}"] [data-picker-glyph]`).first().getAttribute("data-picker-glyph"),
  ))
  expect(new Set(glyphs).size).toBe(4)

  await picker.locator("#channel-picker-input").fill("builder-3")
  const agentOption = picker.locator('[data-picker-group="agent"] [role="option"]')
  await expect(agentOption).toHaveCount(1)
  await agentOption.press("Enter")
  await expect(page).toHaveURL(/\/agents\/builder-3$/)
  await expect(page.locator('[data-agent-view="builder-3"]')).toBeVisible()

  await page.goto("/workspaces")
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()
  await page.keyboard.press("Control+k")
  const workspacePicker = page.locator('[data-dialog="channel-picker"]')
  await workspacePicker.locator("#channel-picker-input").fill("charlie-workspace")
  const workspaceOption = workspacePicker.locator('[data-picker-group="workspace"] [role="option"]')
  await expect(workspaceOption).toHaveCount(1)
  await workspaceOption.press("Enter")
  await expect(page).toHaveURL(/\/workspaces\/workspace-charlie$/)
  await expect(page.locator('[data-workspace-view="workspace-charlie"]')).toContainText("charlie-workspace")

  await page.goto("/workspaces")
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()
  await page.keyboard.press("Control+k")
  const channelPicker = page.locator('[data-dialog="channel-picker"]')
  await channelPicker.locator("#channel-picker-input").fill("ops")
  const channelOption = channelPicker.locator('[data-picker-group="chat"] [role="option"]')
  await expect(channelOption).toHaveCount(1)
  await channelOption.press("Enter")
  await expect(page).toHaveURL(/\/channels\/ops$/)
  // A channel route renders the channel itself instead of a shell placeholder.
  await expect(page.locator('[data-shell-page="current"] h1')).toHaveText("ops")

  await page.goto("/workspaces")
  await expect(page.locator('[data-shell-page="workspaces"]')).toBeVisible()
  await page.keyboard.press("Control+k")
  const directPicker = page.locator('[data-dialog="channel-picker"]')
  await directPicker.locator("#channel-picker-input").fill("dm-planner-runner")
  const directOption = directPicker.locator('[data-picker-group="direct"] [role="option"]')
  await expect(directOption).toHaveCount(1)
  await directOption.press("Enter")
  await expect(page).toHaveURL(/\/direct\/dm-planner-runner$/)
  // The destination uses participant names. The dm- storage name stays internal.
  await expect(page.locator('[data-shell-page="current"] h1')).toHaveText("planner, runner")
})

test("@guard Workspaces directory exposes compact panes and opens workspace detail", async ({ page }) => {
  await installDirectoryApiMocks(page, {
    workspaces: [{
      id: "workspace-sheppard",
      label: "sheppard",
      panes: [
        {
          paneId: "pane-web",
          label: "web",
          agentKind: "codex",
          agentStatus: "working",
          focused: true,
          participant: "codex-reviewer",
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
      ],
      tabs: [{
        id: "tab-main",
        label: "Main",
        panes: [
          {
            paneId: "pane-web",
            label: "web",
            agentKind: "codex",
            agentStatus: "working",
            focused: true,
            participant: "codex-reviewer",
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
        ],
      }],
    }],
  })
  await page.goto("/workspaces")
  await expect(page.locator('[data-directory="workspaces"]')).toBeVisible()
  await expect(page.locator('[data-workspace-card="workspace-sheppard"]')).toContainText("codex-reviewer")
  await expect(page.locator('[data-workspace-card="workspace-sheppard"] [data-pane-status="working"]')).toBeVisible()
  const emptyMetric = page.locator('[data-workspace-card="workspace-sheppard"] dt').filter({ hasText: /^Empty$/u }).locator("..")
  await expect(emptyMetric.locator("dd")).toHaveText("1")
  await expect(page.locator('[data-workspace-card="workspace-sheppard"] [data-agent-row][data-pane-status="empty pane"]')).toHaveCount(0)

  await page.getByRole("button", { exact: true, name: "Open workspace sheppard" }).click()
  await expect(page).toHaveURL(/\/workspaces\/workspace-sheppard$/)
  await expect(page.locator('[data-workspace-view="workspace-sheppard"]')).toContainText("Broadcast history")
  await expect(page.locator('[data-workspace-view="workspace-sheppard"] [data-identity-source="participant"]')).toContainText("codex-reviewer")

  await page.getByRole("link", { name: "Back to Workspaces" }).click()
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.locator('[data-directory="workspaces"]')).toBeVisible()
})

test("@guard tabs appear only on workspace details", async ({ page }) => {
  const mainPane: DirectoryPane = {
    paneId: "pane-main",
    label: "web",
    agentKind: "codex",
    agentStatus: "working",
    focused: true,
    participant: "codex-reviewer",
    participantRouteState: "active",
  }
  const toolsPane: DirectoryPane = {
    paneId: "pane-tools",
    label: "tests",
    agentKind: "claude",
    agentStatus: "idle",
    focused: false,
    participant: "claude-personal",
    participantRouteState: "active",
  }
  await installDirectoryApiMocks(page, {
    workspaces: [{
      id: "workspace-tabs",
      label: "tabs",
      panes: [mainPane, toolsPane],
      tabs: [
        { id: "tab-main", label: "Main", panes: [mainPane] },
        { id: "tab-tools", label: "Tools", panes: [toolsPane] },
      ],
    }],
  })
  let focusRequests = 0
  await page.route("**/api/herdr/tabs/tab-tools/focus", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    focusRequests += 1
    await route.fulfill({ body: JSON.stringify({ tabId: "tab-tools" }), contentType: "application/json", status: 200 })
  })
  await page.goto("/workspaces")
  await page.getByRole("button", { name: "Open workspace tabs" }).click()
  await expect(page).toHaveURL(/\/workspaces\/workspace-tabs$/)

  const card = page.locator('[data-workspace-view="workspace-tabs"]')
  const groups = card.locator("[data-tab-id]")
  await expect(groups).toHaveCount(2)
  await expect(groups.locator('[role="tab"]')).toHaveText(["Main 1", "Tools 1"])
  const activePanel = card.locator('[role="tabpanel"]')
  await expect(activePanel.locator('[data-pane-id="pane-main"]')).toBeVisible()
  await expect(activePanel.locator('[data-pane-id="pane-tools"]')).toHaveCount(0)

  const toolsGroup = card.locator('[data-tab-id="tab-tools"]')
  await expect(toolsGroup.getByRole("button", { name: "Focus Tools" })).toHaveCount(0)
  await toolsGroup.getByRole("tab", { name: /Tools/ }).click()
  await expect.poll(() => focusRequests).toBe(1)
  await expect(activePanel.locator('[data-pane-id="pane-tools"]')).toBeVisible()
  await expect(activePanel.locator('[data-pane-id="pane-main"]')).toHaveCount(0)
})

test("@guard detail-only tab closing is refused until the operator types its name", async ({ page }) => {
  const pane: DirectoryPane = {
    paneId: "pane-tools",
    label: "tests",
    agentKind: "claude",
    agentStatus: "idle",
    focused: false,
    participant: "claude-personal",
    participantRouteState: "active",
  }
  await installDirectoryApiMocks(page, {
    workspaces: [{
      id: "workspace-tabs",
      label: "tabs",
      panes: [pane],
      tabs: [{ id: "tab-tools", label: "Tools", panes: [pane] }],
    }],
  })
  // Tab controls belong to the workspace detail page. Counting the DELETE proves
  // refusal. Asserting only that the button is
  // disabled passes for a control that is disabled AND still fires on click.
  let closeRequests = 0
  await page.route("**/api/herdr/tabs/tab-tools", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback()
      return
    }
    closeRequests += 1
    await route.fulfill({ body: JSON.stringify({ tabId: "tab-tools" }), contentType: "application/json", status: 200 })
  })
  await page.goto("/workspaces")
  await page.getByRole("button", { name: "Open workspace tabs" }).click()

  await page.locator('[data-workspace-view="workspace-tabs"]').getByRole("button", { name: "Close Tools" }).click()
  const dialog = page.locator('[data-dialog="close-tab"]')
  await expect(dialog).toBeVisible()

  // The confirmation names the TAB, not its id. A dialog confirming the wrong string is
  // how an operator types a name that closes something else.
  await expect(dialog.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "Tools")
  // The consequence is stated, because closing a tab closes every pane inside it.
  await expect(dialog).toContainText("every pane inside it")

  // exact, because Playwright matches accessible names by substring: a bare "Close tab"
  // also matches the dismiss control's "Cancel close tab".
  const confirmButton = dialog.getByRole("button", { name: "Close tab", exact: true })
  await expect(confirmButton).toBeDisabled()

  // A near-miss must stay refused. Without this half the guard passes on a button that
  // enables for any non-empty input, which is the regression worth catching.
  await dialog.locator("#close-tab-confirm").fill("tools")
  await expect(confirmButton).toBeDisabled()
  expect(closeRequests, "a mistyped confirmation must not reach the hub").toBe(0)

  await dialog.locator("#close-tab-confirm").fill("Tools")
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()
  await expect.poll(() => closeRequests, { message: "the exact name must close the tab" }).toBe(1)
})

test("@guard no raw ISO timestamp reaches operator-visible chrome", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/channels")
  await expect(page.locator('[data-shell-page="channels"]')).toBeVisible()

  // The fixtures carry ISO timestamps, so this only means something if the page is
  // actually rendering one. Anchor on the humanised form being present first: without
  // it, a page that shows no time at all satisfies the sweep perfectly.
  await expect(page.locator('[data-directory="channels"]').getByText(/^Active /).first()).toBeVisible()

  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
  const offenders = await page.evaluate(() => {
    const found: Array<{ kind: string; sample: string; where: string }> = []
    const pattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
    const describe = (node: Element): string =>
      node.getAttribute("data-channel-row") ?? node.getAttribute("data-shell-page") ?? node.tagName.toLowerCase()
    for (const node of document.querySelectorAll<HTMLElement>("main, main *")) {
      // `datetime` is the machine-readable attribute of <time> and is CORRECT as ISO —
      // it is never shown. Only rendered text and tooltips are operator-visible.
      const title = node.getAttribute("title")
      if (title !== null && pattern.test(title)) found.push({ kind: "title", sample: title, where: describe(node) })
      for (const child of node.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE) continue
        const text = child.textContent ?? ""
        if (pattern.test(text)) found.push({ kind: "text", sample: text.trim().slice(0, 40), where: describe(node) })
      }
    }
    return found
  })

  expect(iso.test("2026-08-17T15:00"), "the sweep pattern must match a real ISO string").toBe(true)
  expect(offenders.filter(({ kind }) => kind === "text"), "no rendered text may show a machine timestamp").toEqual([])
})

test("@finding 31 a tooltip shows a machine timestamp instead of a readable time", async ({ page }) => {
  await installDirectoryApiMocks(page)
  await page.goto("/channels")
  await expect(page.locator('[data-shell-page="channels"]')).toBeVisible()
  await expect(page.locator('[data-directory="channels"]').getByText(/^Active /).first()).toBeVisible()

  // The relative label is right and the tooltip behind it is the raw column value. The
  // `datetime` attribute SHOULD stay ISO — it is machine-readable and never shown — but
  // `title` is what the operator reads on hover.
  const tooltips = await page.evaluate(() => {
    const pattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
    return [...document.querySelectorAll<HTMLElement>("main [title]")]
      .map((node) => node.getAttribute("title") ?? "")
      .filter((title) => pattern.test(title))
  })
  expect(tooltips, "a tooltip is chrome: it must carry a readable time, not the stored value").toEqual([])
})
