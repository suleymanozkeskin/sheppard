import { expect, test, type Page, type Route } from "@playwright/test"

import { mockChannels, mockInbox, mockMembers } from "../src/api/fixtures"
import type { ResumeState } from "../src/api/types"

type JsonValue = boolean | { [key: string]: JsonValue } | JsonValue[] | null | number | string

const LONG_HANDLE = "claude-personal-reviewer"

/** One workspace whose agent pane lost its identity at a restart. */
const TOPOLOGY = {
  workspaces: [{
    id: "w1",
    label: "schmart-ats",
    panes: [{
      paneId: "w1:pV",
      label: LONG_HANDLE,
      agentKind: "claude",
      agentStatus: "idle",
      focused: false,
      participant: null,
      participantRouteState: null,
      previousIdentity: { kind: "ended", handle: LONG_HANDLE },
    }],
    tabs: [],
  }],
}

const MATCHED: ResumeState = {
  kind: "resumable",
  harness: "claude",
  sessionId: "5f0c7c2e",
  launcher: { kind: "matched", launcher: "claude-personal" },
}
const CHOOSE: ResumeState = {
  kind: "resumable",
  harness: "claude",
  sessionId: "9a1d44b0",
  launcher: { kind: "choose", launchers: ["claude-personal", "claude-work"] },
}

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

/** Serves fixtures, two resumable identities, and records resume requests. */
async function installResumeApi(page: Page, resumes: string[]): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: window.location.origin, handle: "suleyman" }))
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/api/events") {
      await route.fulfill({ body: `: ready\n\nevent: topology\ndata: ${JSON.stringify(TOPOLOGY)}\n\n`, contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/resumable-agents" && method === "GET") {
      await fulfillJson(route, { agents: [{ handle: "old-worker", resume: MATCHED }, { handle: "old-lead", resume: CHOOSE }] })
      return
    }
    if (url.pathname.endsWith("/resume") && method === "POST") {
      resumes.push(`${url.pathname} ${route.request().postData() ?? ""}`)
      const handle = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await fulfillJson(route, { handle, paneId: "w1:p9", sessionId: "5f0c7c2e" })
      return
    }
    if (url.pathname.startsWith("/api/agents/") && method === "GET") {
      const handle = decodeURIComponent(url.pathname.slice("/api/agents/".length))
      await fulfillJson(route, {
        participant: { handle, kind: "agent", agentKind: "claude", routeState: "stale", lastSeenAt: null },
        routeState: "stale",
        pane: null,
        recentMessageIds: [],
        channels: [],
        resume: handle === "old-lead" ? CHOOSE : MATCHED,
      })
      return
    }
    if (url.pathname === "/api/herdr/workspaces" && method === "GET") {
      await fulfillJson(route, TOPOLOGY)
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, url.searchParams.get("kind") === "workspace" ? { channels: [] } : { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/inbox" && method === "GET") {
      await fulfillJson(route, { entries: mockInbox })
      return
    }
    if (url.pathname === "/api/participants" && method === "GET") {
      await fulfillJson(route, { participants: mockMembers.map(({ agentKind, handle, kind, routeState }) => ({ agentKind, handle, kind, routeState })) })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, { conversations: [] })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await fulfillJson(route, { roles: [] })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      await fulfillJson(route, { handle: "suleyman" })
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await fulfillJson(route, { members: mockMembers })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      await fulfillJson(route, { messages: [] })
      return
    }
    await fulfillJson(route, {})
  })
}

test("the agent page resumes a recorded session", async ({ page }) => {
  const resumes: string[] = []
  await installResumeApi(page, resumes)
  await page.goto("/agents/old-worker")

  await expect(page.locator('[data-agent-resume="action"]')).toContainText("The session continues in a new pane in its folder.")
  await page.locator("[data-agent-resume-start]").click()
  await expect.poll(() => resumes).toEqual(["/api/agents/old-worker/resume {}"])
})

test("Resume all starts the agents with a known launcher and leaves the choice", async ({ page }) => {
  const resumes: string[] = []
  await installResumeApi(page, resumes)
  await page.goto("/channels/ops")

  const rail = page.locator("[data-resumable-agents]")
  await expect(rail).toContainText("Resume 2 agents")
  await expect(rail.locator('[data-resumable-agent="old-lead"]')).toContainText("choose launcher")
  await rail.locator("[data-resume-all]").click()
  await expect(rail.locator('[data-resumable-agent="old-worker"]')).toContainText("resumed")
  expect(resumes).toEqual(["/api/agents/old-worker/resume {}"])
})

test("the agent card fits a long handle in its Reconnect button", async ({ page }) => {
  await installResumeApi(page, [])
  await page.goto("/agents")

  const connect = page.locator("[data-agent-card-connect]")
  await expect(connect).toHaveText("Reconnect")
  await expect(connect).toHaveAttribute("aria-label", `Reconnect as @${LONG_HANDLE}`)
  await expect(connect).toHaveAttribute("title", `Reconnect as @${LONG_HANDLE}`)
})
