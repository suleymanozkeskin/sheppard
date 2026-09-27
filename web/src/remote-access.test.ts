import { describe, expect, it } from "bun:test"
import { Result } from "better-result"

import { HttpMsgrApi } from "@/api/client"
import { ApiHttpError, ApiNetworkError } from "@/api/errors"
import { MockMsgrApi } from "@/api/mock"
import { checkRemoteSession } from "@/api/remote-session"
import type { CallerIdentity, MsgrApi } from "@/api/types"
import {
  displayPairingCode,
  pageSite,
  pairingCodeFromHash,
  pairingCountdown,
  pairingFailureMessage,
  parsePairingCode,
} from "@/remote-access"

interface JsonObject {
  [key: string]: JsonValue
}
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status })
}

describe("pageSite", () => {
  it("treats only an HTTPS page as remote", () => {
    expect(pageSite("https:")).toBe("remote")
    expect(pageSite("http:")).toBe("local")
  })
})

describe("pairing codes", () => {
  it("accepts the displayed form in any case and maps look-alike letters", () => {
    expect(parsePairingCode("abcd-efgh")).toEqual({ kind: "valid", code: "ABCDEFGH" })
    expect(parsePairingCode(" ab cd ef oi ")).toEqual({ kind: "valid", code: "ABCDEF01" })
    expect(displayPairingCode("ABCDEFGH")).toBe("ABCD-EFGH")
  })

  it("refuses a short code and characters outside the alphabet", () => {
    expect(parsePairingCode("ABC").kind).toBe("invalid")
    expect(parsePairingCode("ABCD-EFG!").kind).toBe("invalid")
  })

  it("reads a code from the fragment, or reports none", () => {
    expect(pairingCodeFromHash("#code=ABCDEFGH")).toEqual({ kind: "valid", code: "ABCDEFGH" })
    expect(pairingCodeFromHash("")).toEqual({ kind: "absent" })
    expect(pairingCodeFromHash("#code=x").kind).toBe("invalid")
  })
})

describe("pairingCountdown", () => {
  const expiresAt = "2026-01-01T00:05:00.000Z"
  it("counts down in minutes and seconds, then expires", () => {
    expect(pairingCountdown(expiresAt, Date.parse("2026-01-01T00:00:00.000Z"))).toEqual({
      kind: "open",
      secondsLeft: 300,
      label: "5:00",
    })
    expect(pairingCountdown(expiresAt, Date.parse("2026-01-01T00:04:51.500Z"))).toMatchObject({ label: "0:09" })
    expect(pairingCountdown(expiresAt, Date.parse("2026-01-01T00:05:00.000Z"))).toEqual({ kind: "expired" })
  })
})

describe("pairingFailureMessage", () => {
  it("keeps the hub's pairing message and names other refusals", () => {
    expect(pairingFailureMessage("PairingRefused", "Too many wrong pairing codes.")).toBe("Too many wrong pairing codes.")
    expect(pairingFailureMessage("RemoteAccessOff", undefined)).toContain("sheppard remote enable")
    expect(pairingFailureMessage("RequestRejected", "x")).toContain("Tailscale account")
  })
})

describe("remote access API", () => {
  it("uses the remote access and pairing paths and decodes each reply", async () => {
    const requests: Request[] = []
    const replies = [
      jsonResponse({
        access: { kind: "on", host: "mac.ts.net", origin: "https://mac.ts.net", ownerLogin: "o@x", enabledAt: "t" },
        sessions: [{ id: 1, handle: "human", createdAt: "t", lastSeen: { kind: "not-seen" } }],
      }),
      jsonResponse({ code: "ABCD-EFGH", expiresAt: "t", url: "https://mac.ts.net/pair#code=ABCDEFGH" }, 201),
      jsonResponse({ handle: "human" }, 201),
      jsonResponse({ revoked: 1 }),
    ]
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return replies.shift() ?? jsonResponse({}, 500)
      },
    })
    const status = await api.getRemoteAccess()
    const pairing = await api.createPairingCode()
    const paired = await api.redeemPairingCode({ code: "ABCDEFGH" })
    const revoked = await api.revokeRemoteSession(1)
    expect(status.match({ ok: ({ access }) => access.kind, err: () => "error" })).toBe("on")
    expect(pairing.isOk() && paired.isOk() && revoked.isOk()).toBe(true)
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/remote-access"],
      ["POST", "/api/pairing"],
      ["POST", "/api/pairing/redeem"],
      ["DELETE", "/api/remote-access/sessions/1"],
    ])
  })

  it("refuses an unknown remote access state", async () => {
    const api = new HttpMsgrApi({ fetchImpl: async () => jsonResponse({ access: { kind: "maybe" }, sessions: [] }) })
    expect((await api.getRemoteAccess()).isErr()).toBe(true)
  })

  it("the mock pairs once, lists the device, and revokes it", async () => {
    const api = new MockMsgrApi()
    const created = await api.createPairingCode()
    if (created.isErr()) throw new Error("the mock must create a code")
    expect((await api.redeemPairingCode({ code: created.value.code })).isOk()).toBe(true)
    expect((await api.redeemPairingCode({ code: created.value.code })).isErr()).toBe(true)
    const listed = await api.getRemoteAccess()
    const sessions = listed.isOk() ? listed.value.sessions : []
    expect(sessions).toHaveLength(1)
    expect((await api.revokeRemoteSession(sessions[0]?.id ?? 0)).isOk()).toBe(true)
  })
})

describe("checkRemoteSession", () => {
  function apiWithMe(result: Awaited<ReturnType<MsgrApi["getMe"]>>): MsgrApi {
    const api = new MockMsgrApi()
    api.getMe = async () => result
    return api
  }

  it("is paired as the handle the hub reports", async () => {
    const me: CallerIdentity = { handle: "operator", kind: "human" }
    expect(await checkRemoteSession(apiWithMe(Result.ok(me)))).toEqual({ kind: "paired", handle: "operator" })
  })

  it("is unpaired on 401 and failed on a network error", async () => {
    const unauthorized = new ApiHttpError({ body: "{}", message: "no", status: 401 })
    expect(await checkRemoteSession(apiWithMe(Result.err(unauthorized)))).toEqual({ kind: "unpaired" })
    const offline = new ApiNetworkError({ cause: null, message: "down" })
    expect((await checkRemoteSession(apiWithMe(Result.err(offline)))).kind).toBe("failed")
  })
})
