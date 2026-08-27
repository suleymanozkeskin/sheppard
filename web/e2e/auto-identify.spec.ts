import { expect, test, type Page, type Route } from "@playwright/test"
import { mockChannels, mockMembers, mockMessages } from "../src/api/fixtures"

/**
 * Automatic identification (spec 3b, checklist 11.13).
 *
 * These checks count requests. The failure mode this surface can regress into is
 * a request storm on the 401 path, and a storm is invisible to success checks —
 * a client that posts on every render satisfies "identification succeeded" while
 * flooding the hub. Every test here asserts the POST /api/humans COUNT.
 */

type IdentifyBehavior = "ok" | "http-401" | "http-500" | "network-error"

interface JsonObject {
  [key: string]: JsonValue
}
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

const EXTRA_TOKEN = "tok-e2e-must-never-persist"

// Shared fixtures only: a hand-rolled copy of the API contract drifts in
// silence, and this file's first version proved it (checklist 11.16).
// mockMessages[3] (id 4) carries the markdown attachment the anonymous
// guard needs to drive attachment.view — its refusal notice renders only on
// dispatch, so a fixture without one leaves that copy invisible (11.14).

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

/** Counts POST /api/humans and serves a minimal one-channel hub. */
async function openAnonymously(page: Page, behavior: IdentifyBehavior): Promise<string[]> {
  const humanPosts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/humans") {
      humanPosts.push(request.postData() ?? "")
    }
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/api/humans" && method === "POST") {
      if (behavior === "network-error") {
        await route.abort("connectionrefused")
        return
      }
      if (behavior === "http-401") {
        await route.fulfill({ body: JSON.stringify({ code: "Unauthorized", error: "refused" }), contentType: "application/json", status: 401 })
        return
      }
      if (behavior === "http-500") {
        await route.fulfill({ body: JSON.stringify({ code: "Internal", error: "refused" }), contentType: "application/json", status: 500 })
        return
      }
      // A hostile or buggy hub could attach a credential-shaped field. The
      // client must consume the handle and let everything else fall on the floor.
      await fulfillJson(route, { handle: "human", token: EXTRA_TOKEN })
      return
    }
    if (url.pathname === "/api/events" || url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/inbox") {
      await fulfillJson(route, { entries: [{ channel: "ops", unread: 0, senders: [], routeState: null, pushEnabled: false }] })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, { conversations: [] })
      return
    }
    if (url.pathname === "/api/participants") {
      await fulfillJson(route, { participants: mockMembers })
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await fulfillJson(route, { members: mockMembers })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      await fulfillJson(route, { messages: mockMessages })
      return
    }
    if (url.pathname === "/api/herdr/workspaces") {
      await fulfillJson(route, { workspaces: [] })
      return
    }
    if (method === "GET") {
      await fulfillJson(route, {})
      return
    }
    await fulfillJson(route, {})
  })
  await page.goto("/")
  await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()
  return humanPosts
}

test("@guard a fresh session posts /api/humans exactly once, counted", async ({ page }) => {
  const humanPosts = await openAnonymously(page, "ok")
  // The identified state renders from the response: the inbox control exists
  // only with an identity, so the claim was consumed, not merely sent.
  await expect(page.getByRole("button", { name: "Open inbox" })).toBeVisible()
  // Idle long enough that a post-per-render regression would have fired again.
  await page.waitForTimeout(800)
  expect(humanPosts, "one session, one claim").toHaveLength(1)
  expect(JSON.parse(humanPosts[0] ?? "{}"), "the claim carries the handle and nothing else").toEqual({ handle: "human" })
})

for (const behavior of ["http-401", "http-500", "network-error"] as const) {
  test(`@guard a failed identify (${behavior}) settles read-only after exactly one attempt`, async ({ page }) => {
    const humanPosts = await openAnonymously(page, behavior)
    // The read-only pill is the EXISTS anchor: the fallback state rendered, so
    // the zero matches below cannot come from a blank page.
    await expect(page.getByText("Read only", { exact: true })).toBeVisible()
    await page.waitForTimeout(800)
    expect(humanPosts, "a failure is terminal for the session, never retried").toHaveLength(1)
    await expect(page.getByRole("button", { name: "Open inbox" })).toHaveCount(0)
  })
}

test("@guard no surface offers or demands an identity choice, in both states", async ({ page }) => {
  // Failed-identify state first: it is the state whose copy historically
  // instructed the operator to choose a name.
  const humanPosts = await openAnonymously(page, "http-500")
  await expect(page.getByText("Read only", { exact: true })).toBeVisible()
  // "identity" itself is the forbidden word: the concept is removed from the
  // operator's view entirely, so any rendered use of it is dangling copy.
  const offendersWhenAnonymous = await page.evaluate(() =>
    (document.body.textContent ?? "").match(/choose (a|an|your) (name|identity|display name)|pick a( +different)? name|set your name|send as\b|identity/i),
  )
  expect(offendersWhenAnonymous, "the fallback state names the connection, never a choice").toBeNull()
  const titleOffenders = await page.evaluate(() =>
    [...document.querySelectorAll("[title]")]
      .map((node) => node.getAttribute("title") ?? "")
      .filter((title) => /choose|pick a name|identity/i.test(title)),
  )
  expect(titleOffenders, "disabled titles carry the connection reason only").toEqual([])

  expect(humanPosts, "the rendered read-only state minted no second claim").toHaveLength(1)
})

test("@guard identification is not a login: no credential leaves the response", async ({ page }) => {
  await openAnonymously(page, "ok")
  await expect(page.getByRole("button", { name: "Open inbox" })).toBeVisible()
  const stored = await page.evaluate(() => window.localStorage.getItem("msgr.identity.v1"))
  expect(stored, "the identity persists — so the negative below inspects a real record").not.toBeNull()
  const origin = await page.evaluate(() => window.location.origin)
  expect(JSON.parse(stored ?? "{}"), "the stored identity is the handle and the hub, nothing credential-shaped").toEqual({
    version: 1,
    hub: origin,
    handle: "human",
  })
  const leaked = await page.evaluate((needle) => {
    const inStorage = Object.keys(window.localStorage).some((key) => (window.localStorage.getItem(key) ?? "").includes(needle))
    const inPage = (document.documentElement.outerHTML ?? "").includes(needle)
    return { inPage, inStorage }
  }, EXTRA_TOKEN)
  expect(leaked, "a token-shaped response field must never reach storage or the page").toEqual({ inPage: false, inStorage: false })
})
