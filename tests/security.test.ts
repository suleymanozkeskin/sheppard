import { describe, expect, test } from "bun:test";
import { ALLOWED_ORIGIN, BASE, auth, provision, testHub } from "./http-support";

describe("host check", () => {
  test("refuses a Host the hub does not answer to", async () => {
    const hub = testHub();
    const response = await hub.get("/api/channels", { host: "attacker.example" });
    expect(response.status).toBe(403);
  });

  test("redirects non-API GETs from localhost to the canonical host", async () => {
    const hub = testHub();
    const response = await hub.get("/?view=channels", { host: "localhost:6747" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:6747/?view=channels",
    );
  });

  test("does not redirect API requests from localhost", async () => {
    const hub = testHub();
    const response = await hub.get("/api/channels", { host: "localhost:6747" });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  test("accepts both loopback spellings", async () => {
    const hub = testHub();
    expect((await hub.get("/api/channels", { host: "127.0.0.1:6747" })).status).toBe(200);
    expect((await hub.get("/api/channels", { host: "localhost:6747" })).status).toBe(200);
  });
});

describe("origin check", () => {
  test("refuses a page from any other origin", async () => {
    const hub = testHub();
    const response = await hub.get("/api/channels", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  test("accepts the origin the interface is served from", async () => {
    const hub = testHub();
    expect((await hub.get("/api/channels", { origin: ALLOWED_ORIGIN })).status).toBe(200);
  });

  test("accepts a request with no Origin, which is how the CLI calls", async () => {
    const hub = testHub();
    expect((await hub.get("/api/channels")).status).toBe(200);
  });

  test("grants CORS only to the allowed origin", async () => {
    const hub = testHub();
    const allowed = await hub.get("/api/channels", { origin: ALLOWED_ORIGIN });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const bare = await hub.get("/api/channels");
    expect(bare.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("refuses to answer a preflight from another origin", async () => {
    const hub = testHub();
    const response = await hub.handler(
      new Request(`${BASE}/api/channels`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("answers a preflight from the allowed origin", async () => {
    const hub = testHub();
    const response = await hub.handler(
      new Request(`${BASE}/api/channels`, {
        method: "OPTIONS",
        headers: { origin: ALLOWED_ORIGIN },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("content type check", () => {
  test("refuses a write that would skip the CORS preflight", async () => {
    const hub = testHub();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await hub.handler(
        new Request(`${BASE}/api/agents`, {
          method: "POST",
          headers: { "content-type": contentType },
          body: JSON.stringify({ handle: "opus21" }),
        }),
      );
      expect(response.status).toBe(403);
    }
  });

  test("refuses a write with no Content-Type at all", async () => {
    const hub = testHub();
    const response = await hub.handler(
      new Request(`${BASE}/api/agents`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(403);
  });

  test("accepts a charset parameter on the media type", async () => {
    const hub = testHub();
    const response = await hub.handler(
      new Request(`${BASE}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ handle: "opus21" }),
      }),
    );
    expect(response.status).toBe(201);
  });

  test("refuses a JSON body sent with a DELETE request unless its type is JSON", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/workspaces/w1`, {
        method: "DELETE",
        headers: { "content-type": "text/plain", ...auth(token) },
        body: JSON.stringify({ confirm: "w1" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("refuses a JSON body sent with a PUT request unless its type is JSON", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/launchers/claude`, {
        method: "PUT",
        headers: { "content-type": "text/plain", ...auth(token) },
        body: JSON.stringify({ agentKind: "claude", argv: ["claude"] }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("authentication matrix", () => {
  const openEndpoints: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/api/channels"],
    ["GET", "/api/channels/backend/messages"],
    ["GET", "/api/channels/backend/context?around=1"],
    ["GET", "/api/channels/backend/members"],
    ["GET", "/api/search?q=hello"],
    ["GET", "/api/herdr/agents/w1:p1"],
  ];

  const guardedEndpoints: ReadonlyArray<readonly [string, string]> = [
    ["POST", "/api/channels"],
    ["POST", "/api/channels/backend/join"],
    ["POST", "/api/channels/backend/messages"],
    ["POST", "/api/channels/backend/fetch"],
    ["POST", "/api/channels/backend/ack"],
    ["GET", "/api/inbox"],
    ["GET", "/api/attachments/1/content"],
  ];

  async function seed() {
    const hub = testHub();
    const token = await provision(hub, "opus21");
    await hub.post("/api/channels", { name: "backend" }, auth(token));
    return { hub, token };
  }

  test("open endpoints answer without a token", async () => {
    const { hub } = await seed();
    for (const [method, path] of openEndpoints) {
      const response =
        method === "GET" ? await hub.get(path) : await hub.post(path);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);
    }
  });

  test("guarded endpoints refuse an absent token", async () => {
    const { hub } = await seed();
    for (const [method, path] of guardedEndpoints) {
      const response = method === "GET" ? await hub.get(path) : await hub.post(path);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`);
    }
  });

  test("guarded endpoints refuse a token that was never issued", async () => {
    const { hub } = await seed();
    const bogus = auth("not-a-real-token");
    for (const [method, path] of guardedEndpoints) {
      const response =
        method === "GET" ? await hub.get(path, bogus) : await hub.post(path, {}, bogus);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`);
    }
  });

  test("accepts the token as a cookie, which is how the browser holds it", async () => {
    const hub = testHub();
    const created = await hub.post("/api/humans", { handle: "suleyman" });
    const setCookie = created.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const token = setCookie.split(";")[0]?.split("=")[1] ?? "";
    const response = await hub.get("/api/inbox", { cookie: `msgr_token=${token}` });
    expect(response.status).toBe(200);
  });

  test("returns a JSON error for a malformed cookie", async () => {
    const hub = testHub();
    const response = await hub.get("/api/inbox", { cookie: "msgr_token=%" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("URL encoding"),
    });
  });

  test("a token never appears in a response after it is issued", async () => {
    const hub = testHub();
    const token = await provision(hub, "opus21");
    await hub.post("/api/channels", { name: "backend" }, auth(token));
    await hub.post("/api/channels/backend/join", {}, auth(token));
    await hub.post("/api/channels/backend/messages", { body: "hello" }, auth(token));

    for (const path of ["/api/channels", "/api/channels/backend/messages", "/api/channels/backend/members"]) {
      expect(await (await hub.get(path)).text()).not.toContain(token);
    }
    expect(await (await hub.get("/api/inbox", auth(token))).text()).not.toContain(token);
  });

  test("does not bind a route when the hub has no herdr session", async () => {
    const hub = testHub({ herdrSocketPath: null });
    const token = await provision(hub, "opus21");
    const response = await hub.get("/api/inbox", {
      ...auth(token),
      "x-msgr-terminal-id": "term_w1:p1",
      "x-msgr-pane-id": "w1:p1",
      "x-msgr-occupant": "claude",
    });

    expect(response.status).toBe(403);
    expect(hub.hub.store.findByHandle("opus21")?.terminalId).toBeNull();
  });
});

describe("path decoding", () => {
  test("returns a JSON error for malformed percent-encoding", async () => {
    const hub = testHub();
    const response = await hub.get("/api/channels/%E0%A4%A/messages");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("URL encoding"),
    });
  });
});
