import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../src/json";
import { IN_MEMORY, openDatabase } from "../src/db";
import { Store } from "../src/store";
import { type RequestHeaders, type TestHub, controlAuth, operatorAuth, testHub } from "./http-support";

const REMOTE_HOST = "mac.tail1234.ts.net";
const OWNER = "owner@example.com";

function proxyHeaders(extra: RequestHeaders = {}): RequestHeaders {
  return {
    "x-forwarded-for": "100.64.0.2",
    "x-forwarded-host": REMOTE_HOST,
    "x-forwarded-proto": "https",
    "tailscale-user-login": OWNER,
    ...extra,
  };
}

function remote(hub: TestHub, method: string, path: string, body: JsonValue | null, extra: RequestHeaders = {}) {
  const headers: RequestHeaders = { ...proxyHeaders(extra) };
  if (body !== null) headers["content-type"] = "application/json";
  return hub.handler(
    new Request(`https://${REMOTE_HOST}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    }),
  );
}

function cookieFrom(response: Response): RequestHeaders {
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { cookie };
}

async function enabled() {
  const hub = testHub();
  const human = await operatorAuth(hub);
  const on = await hub.put("/api/remote-access", { host: REMOTE_HOST, ownerLogin: OWNER }, controlAuth());
  expect(on.status).toBe(200);
  return { hub, human };
}

async function paired() {
  const { hub, human } = await enabled();
  const created = await hub.post("/api/pairing", {}, human);
  // SAFETY: a 201 from POST /api/pairing carries the documented pairing code.
  const pairing = (await created.json()) as { code: string; url: string };
  const redeemed = await remote(hub, "POST", "/api/pairing/redeem", { code: pairing.code });
  return { hub, human, pairing, redeemed, phone: cookieFrom(redeemed) };
}

describe("remote access settings", () => {
  test("the local-control credential turns remote access on, reports it, and turns it off", async () => {
    const { hub } = await enabled();
    const status = await hub.get("/api/remote-access", controlAuth());
    expect(await status.json()).toMatchObject({
      access: { kind: "on", host: REMOTE_HOST, origin: `https://${REMOTE_HOST}`, ownerLogin: OWNER },
      sessions: [],
    });
    const off = await hub.delete("/api/remote-access", controlAuth());
    expect(await off.json()).toEqual({ revokedSessions: 0 });
  });

  test("refuses a host with a port", async () => {
    const hub = testHub();
    const refused = await hub.put("/api/remote-access", { host: `${REMOTE_HOST}:443`, ownerLogin: OWNER }, controlAuth());
    expect(refused.status).toBe(400);
  });

  test("a remote device cannot change remote access, even with the control credential", async () => {
    const { phone, hub } = await paired();
    const refused = await remote(hub, "DELETE", "/api/remote-access", null, { ...phone, ...controlAuth() });
    expect(refused.status).toBe(403);
  });
});

describe("remote gate", () => {
  test("a remote request without a paired session reads nothing", async () => {
    const { hub } = await enabled();
    expect((await remote(hub, "GET", "/api/channels", null)).status).toBe(401);
    expect((await remote(hub, "GET", "/api/meta", null)).status).toBe(200);
  });

  test("sign-in by handle is refused from a remote device", async () => {
    const { hub } = await enabled();
    const refused = await remote(hub, "POST", "/api/humans", { handle: "human" });
    expect(refused.status).toBe(403);
  });

  test("a loopback human cookie does not authenticate a remote request", async () => {
    const { hub, human } = await enabled();
    expect((await remote(hub, "GET", "/api/channels", null, human)).status).toBe(401);
  });

  test("Funnel traffic and proxied traffic while off are refused", async () => {
    const hub = testHub();
    expect((await remote(hub, "GET", "/api/meta", null)).status).toBe(403);
    const funnel = await hub.get("/api/meta", { "tailscale-funnel-request": "?1" });
    expect(funnel.status).toBe(403);
  });

  test("another Tailscale login is refused", async () => {
    const { hub } = await enabled();
    const refused = await remote(hub, "GET", "/api/meta", null, { "tailscale-user-login": "guest@example.com" });
    expect(refused.status).toBe(403);
  });
});

describe("pairing", () => {
  test("a code pairs a phone with a Secure cookie that then authenticates", async () => {
    const { hub, pairing, redeemed, phone } = await paired();
    expect(pairing.url).toStartWith(`https://${REMOTE_HOST}/pair#code=`);
    expect(redeemed.status).toBe(201);
    expect(await redeemed.json()).toEqual({ handle: "human" });
    expect(redeemed.headers.get("set-cookie")).toContain("Secure");

    expect((await remote(hub, "GET", "/api/channels", null, phone)).status).toBe(200);
    const status = await hub.get("/api/remote-access", controlAuth());
    expect(await status.json()).toMatchObject({ sessions: [{ handle: "human" }] });
  });

  test("a paired phone reads its own identity", async () => {
    const { hub, phone } = await paired();
    const me = await remote(hub, "GET", "/api/me", null, phone);
    expect(await me.json()).toEqual({ handle: "human", kind: "human" });
    expect((await remote(hub, "GET", "/api/me", null)).status).toBe(401);
  });

  test("a code works once", async () => {
    const { hub, pairing } = await paired();
    const again = await remote(hub, "POST", "/api/pairing/redeem", { code: pairing.code });
    expect(again.status).toBe(401);
  });

  test("five wrong codes cancel every open code", async () => {
    const { hub, human } = await enabled();
    const created = await hub.post("/api/pairing", {}, human);
    // SAFETY: a 201 from POST /api/pairing carries the documented pairing code.
    const { code } = (await created.json()) as { code: string };
    const replies: JsonValue[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await remote(hub, "POST", "/api/pairing/redeem", { code: "ZZZZ-ZZZZ" });
      replies.push(await wrong.json());
    }
    expect(replies.at(-1)).toMatchObject({ code: "PairingRefused" });
    expect((await remote(hub, "POST", "/api/pairing/redeem", { code })).status).toBe(401);
  });

  test("turning remote access off revokes paired sessions", async () => {
    const { hub, phone } = await paired();
    const off = await hub.delete("/api/remote-access", controlAuth());
    expect(await off.json()).toEqual({ revokedSessions: 1 });
    await hub.put("/api/remote-access", { host: REMOTE_HOST, ownerLogin: OWNER }, controlAuth());
    expect((await remote(hub, "GET", "/api/channels", null, phone)).status).toBe(401);
  });

  test("pairing needs remote access and a loopback human", async () => {
    const hub = testHub();
    const human = await operatorAuth(hub);
    expect((await hub.post("/api/pairing", {}, human)).status).toBe(409);
    const local = await hub.post("/api/pairing/redeem", { code: "ABCD-EFGH" });
    expect(local.status).toBe(400);
  });

  test("a paired phone cannot create more pairing codes", async () => {
    const { hub, phone } = await paired();
    expect((await remote(hub, "POST", "/api/pairing", {}, phone)).status).toBe(403);
  });
});

describe("pairing code expiry", () => {
  test("a code is refused after five minutes", () => {
    let now = "2026-08-17T00:00:00.000Z";
    const store = new Store(openDatabase(IN_MEMORY).unwrap("db"), { now: () => now });
    const human = store.createHuman("human").unwrap("human").participant.id;
    store.enableRemoteAccess(REMOTE_HOST, OWNER);
    store.createPairingCode(human, "ABCDEFGH");
    now = "2026-08-17T00:05:00.000Z";
    const redeemed = store.redeemPairingCode("ABCDEFGH");
    expect(redeemed.isErr() && redeemed.error._tag).toBe("PairingRefused");
  });
});
