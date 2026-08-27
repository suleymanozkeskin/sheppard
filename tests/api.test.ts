import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "../src/herdr";
import { Notifier } from "../src/notifier";
import type { AgentDetail, Channel, ChannelReceipt, InboxEntry, Member, Message } from "../src/types";
import { BASE, TEST_HERDR_SOCKET_PATH, auth, operatorAuth, provision, testHub } from "./http-support";
import type { TestHub } from "./http-support";

async function seed(): Promise<{ hub: TestHub; alice: string; bob: string }> {
  const hub = testHub();
  const alice = await provision(hub, "alice");
  const bob = await provision(hub, "bob");
  await hub.post("/api/channels", { name: "backend" }, auth(alice));
  await hub.post("/api/channels/backend/join", {}, auth(alice));
  await hub.post("/api/channels/backend/join", {}, auth(bob));
  return { hub, alice, bob };
}

async function body<T>(response: Response): Promise<T> {
  // SAFETY: each caller names the type the endpoint is contracted to return, and
  // then asserts on it. A response of any other shape fails that expectation.
  return (await response.json()) as T;
}

describe("identity", () => {
  test("returns the token once", async () => {
    const hub = testHub();
    const created = await hub.post("/api/agents", { handle: "opus21" });
    expect(created.status).toBe(201);
    expect(await body<{ handle: string; token: string }>(created)).toMatchObject({
      handle: "opus21",
    });
  });

  test("a taken agent handle is suffixed with the lowest free ordinal", async () => {
    const hub = testHub();
    await hub.post("/api/agents", { handle: "reviewer" });

    const second = await hub.post("/api/agents", { handle: "reviewer" });
    expect(second.status).toBe(201);
    expect((await body<{ handle: string }>(second)).handle).toBe("reviewer-2");

    const third = await hub.post("/api/agents", { handle: "reviewer" });
    expect((await body<{ handle: string }>(third)).handle).toBe("reviewer-3");
  });

  test("fills the lowest gap when a suffixed handle already exists", async () => {
    const hub = testHub();
    await hub.post("/api/agents", { handle: "worker" });
    await hub.post("/api/agents", { handle: "worker-2", exact: true });

    const next = await hub.post("/api/agents", { handle: "worker" });
    expect((await body<{ handle: string }>(next)).handle).toBe("worker-3");
  });

  test("each suffixed agent gets its own identity and token", async () => {
    const hub = testHub();
    const first = await body<{ handle: string; token: string }>(
      await hub.post("/api/agents", { handle: "reviewer" }),
    );
    const second = await body<{ handle: string; token: string }>(
      await hub.post("/api/agents", { handle: "reviewer" }),
    );

    expect(second.token).not.toBe(first.token);
    expect(hub.hub.store.findByToken(second.token)?.handle).toBe("reviewer-2");
  });

  test("exact mode refuses a taken handle instead of suffixing", async () => {
    const hub = testHub();
    await hub.post("/api/agents", { handle: "reviewer" });

    const exact = await hub.post("/api/agents", { handle: "reviewer", exact: true });
    expect(exact.status).toBe(409);
  });

  test("suffixing keeps the handle inside the permitted length", async () => {
    const hub = testHub();
    const long = "a".repeat(32);
    await hub.post("/api/agents", { handle: long });

    const suffixed = await body<{ handle: string }>(await hub.post("/api/agents", { handle: long }));
    expect(suffixed.handle.length).toBeLessThanOrEqual(32);
    expect(suffixed.handle.endsWith("-2")).toBe(true);
  });

  test("creates independent sessions for an existing human handle", async () => {
    const hub = testHub();
    const first = await hub.post("/api/humans", { handle: "suleyman" });
    const firstCookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const second = await hub.post("/api/humans", { handle: "suleyman" });
    const secondCookie = (second.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const third = await hub.post("/api/humans", { handle: "suleyman" });
    const thirdCookie = (third.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await body<{ handle: string }>(second)).toEqual({ handle: "suleyman" });
    expect(third.status).toBe(200);
    expect(secondCookie).not.toBe(firstCookie);
    expect(thirdCookie).not.toBe(firstCookie);
    expect(thirdCookie).not.toBe(secondCookie);
    expect((await hub.get("/api/inbox", { cookie: firstCookie })).status).toBe(200);
    expect((await hub.get("/api/inbox", { cookie: secondCookie })).status).toBe(200);
    expect((await hub.get("/api/inbox", { cookie: thirdCookie })).status).toBe(200);
  });

  test("keeps one human identity and names it on a different handle", async () => {
    const hub = testHub();
    const first = await hub.post("/api/humans", { handle: "operator" });
    const reclaim = await hub.post("/api/humans", { handle: "operator" });
    const different = await hub.post("/api/humans", { handle: "another" });

    expect(first.status).toBe(201);
    expect(reclaim.status).toBe(200);
    expect(different.status).toBe(409);
    expect(await body<{ error: string }>(different)).toMatchObject({
      error: 'Handle "operator" is already taken',
    });
    expect(
      hub.hub.store
        .listParticipants()
        .filter((participant) => participant.kind === "human"),
    ).toHaveLength(1);
  });

  test("concurrent identical claims on a fresh hub keep exactly one human row", async () => {
    // Automatic identification means every browser tab posts {handle: "human"} on
    // load, so two tabs on a fresh hub race their first claim. The singleton must
    // hold as a COUNT in the store, whatever the interleaving: one create, one
    // reclaim, never two rows.
    const hub = testHub();
    const [first, second] = await Promise.all([
      hub.post("/api/humans", { handle: "human" }),
      hub.post("/api/humans", { handle: "human" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(await body<{ handle: string }>(first)).toEqual({ handle: "human" });
    expect(await body<{ handle: string }>(second)).toEqual({ handle: "human" });
    expect(
      hub.hub.store
        .listParticipants()
        .filter((participant) => participant.kind === "human"),
    ).toHaveLength(1);
  });

  test("allows extra humans only in the QA configuration", async () => {
    const hub = testHub({ allowExtraHumans: true });
    const first = await hub.post("/api/humans", { handle: "operator" });
    const second = await hub.post("/api/humans", { handle: "tester" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(
      hub.hub.store
        .listParticipants()
        .filter((participant) => participant.kind === "human"),
    ).toHaveLength(2);
  });

  test("reclaims any legacy human and names the most recently seen one", async () => {
    const hub = testHub({ allowExtraHumans: true });
    const first = await hub.post("/api/humans", { handle: "human" });
    const second = await hub.post("/api/humans", { handle: "work-project" });
    const firstCookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const secondCookie = (second.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    await hub.get("/api/inbox", { cookie: firstCookie });
    await hub.get("/api/inbox", { cookie: secondCookie });
    hub.hub.config.allowExtraHumans = false;

    const reclaim = await hub.post("/api/humans", { handle: "human" });
    const different = await hub.post("/api/humans", { handle: "new-operator" });
    expect(reclaim.status).toBe(200);
    expect(different.status).toBe(409);
    expect(await body<{ error: string }>(different)).toMatchObject({
      error: 'Handle "work-project" is already taken',
    });
  });

  test("does not reissue or recreate a deactivated human identity", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const created = await hub.post("/api/humans", { handle: "retired-human" });
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    expect((await hub.delete("/api/participants/retired-human", auth(alice))).status).toBe(200);
    expect((await hub.get("/api/inbox", { cookie })).status).toBe(401);
    expect((await hub.post("/api/humans", { handle: "retired-human" })).status).toBe(409);
  });

  test("prunes the oldest human session after sixteen active sessions", async () => {
    const hub = testHub();
    const cookies: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const response = await hub.post("/api/humans", { handle: "suleyman" });
      cookies.push((response.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
    }

    expect((await hub.get("/api/inbox", { cookie: cookies[0] })).status).toBe(401);
    for (const cookie of cookies.slice(1)) {
      expect((await hub.get("/api/inbox", { cookie })).status).toBe(200);
    }
  });

  test("a human handle collides with an agent handle", async () => {
    const hub = testHub();
    await hub.post("/api/agents", { handle: "suleyman" });
    expect((await hub.post("/api/humans", { handle: "suleyman" })).status).toBe(409);
  });

  test("rejects handles outside the permitted pattern", async () => {
    const hub = testHub();
    for (const handle of [
      "Opus21",
      "1abc",
      "with space",
      "line\nbreak",
      "a".repeat(33),
      "",
      "semi;colon",
    ]) {
      const response = await hub.post("/api/agents", { handle });
      expect(`${handle} -> ${response.status}`).toBe(`${handle} -> 400`);
    }
  });

  test("reports malformed JSON as such, not as a missing field", async () => {
    const hub = testHub();
    const response = await hub.handler(
      new Request("http://127.0.0.1:6747/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    expect(await body<{ error: string }>(response)).toMatchObject({
      error: expect.stringContaining("valid JSON"),
    });
  });

  test("rejects a body that is not a JSON object", async () => {
    const hub = testHub();
    expect((await hub.post("/api/agents", ["opus21"])).status).toBe(400);
    expect((await hub.post("/api/agents", "opus21")).status).toBe(400);
    expect((await hub.post("/api/agents", { handle: 42 })).status).toBe(400);
    expect((await hub.post("/api/agents", {})).status).toBe(400);
  });
});

describe("agent detail", () => {
  test("is open and returns the route, pane, and message ids", async () => {
    const hub = testHub();
    const token = await provision(hub, "worker");
    await hub.post("/api/channels", { name: "backend" }, auth(token));
    await hub.post("/api/channels", { name: "ops" }, auth(token));

    const backendFirst = await body<Message>(
      await hub.post("/api/channels/backend/messages", { body: "first" }, auth(token)),
    );
    const backendSecond = await body<Message>(
      await hub.post("/api/channels/backend/messages", { body: "second" }, auth(token)),
    );
    const opsMessage = await body<Message>(
      await hub.post("/api/channels/ops/messages", { body: "status" }, auth(token)),
    );

    const participant = hub.hub.store.findByToken(token);
    expect(participant).not.toBeNull();
    hub.hub.store.bindRoute(participant!.id, {
      terminalId: "term-worker",
      paneId: "w1:p1",
      occupantAgent: "codex",
    });
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({
      terminalId: "term-worker",
      paneId: "w1:p1",
      label: "worker",
      agent: "codex",
      agentStatus: "working",
      focused: true,
    });
    hub.hub.herdr = herdr;

    const response = await hub.get("/api/agents/worker");

    expect(response.status).toBe(200);
    const detail = await body<AgentDetail>(response);
    expect(detail.participant).toMatchObject({
      handle: "worker",
      kind: "agent",
      agentKind: "codex",
      routeState: "active",
      lastSeenAt: expect.any(String),
    });
    expect(detail.routeState).toBe("active");
    expect(detail.pane).toEqual({
      paneId: "w1:p1",
      label: "worker",
      title: null,
      agentKind: "codex",
      agentStatus: "working",
      focused: true,
      participant: "worker",
      participantRouteState: "active",
      role: null,
    });
    expect(detail.recentMessageIds).toEqual([
      { channel: "backend", messageIds: [backendSecond.id, backendFirst.id] },
      { channel: "ops", messageIds: [opsMessage.id] },
    ]);
  });

  test("limits recent ids to the newest twenty per channel", async () => {
    const hub = testHub();
    const token = await provision(hub, "worker");
    await hub.post("/api/channels", { name: "backend" }, auth(token));
    const ids: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const sent = await body<Message>(
        await hub.post("/api/channels/backend/messages", { body: `message-${index}` }, auth(token)),
      );
      ids.push(sent.id);
    }

    const response = await hub.get("/api/agents/worker");

    expect(response.status).toBe(200);
    const detail = await body<AgentDetail>(response);
    expect(detail.recentMessageIds).toEqual([
      { channel: "backend", messageIds: ids.slice(-20).reverse() },
    ]);
  });

  test("returns a null pane when the agent is unbound, herdr is absent, or the pane is absent", async () => {
    const hub = testHub();
    const token = await provision(hub, "worker");

    const unbound = await body<AgentDetail>(await hub.get("/api/agents/worker"));
    expect(unbound.pane).toBeNull();

    const participant = hub.hub.store.findByToken(token);
    expect(participant).not.toBeNull();
    hub.hub.store.bindRoute(participant!.id, {
      terminalId: "term-worker",
      paneId: "w1:p1",
      occupantAgent: "codex",
    });
    const absentHerdr = await body<AgentDetail>(await hub.get("/api/agents/worker"));
    expect(absentHerdr.pane).toBeNull();

    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    hub.hub.herdr = herdr;
    const absentPane = await body<AgentDetail>(await hub.get("/api/agents/worker"));
    expect(absentPane.pane).toBeNull();
  });

  test("returns 404 for unknown, human, and deactivated handles", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    await hub.post("/api/humans", { handle: "reviewer" });
    await provision(hub, "retired");
    expect((await hub.get("/api/agents/missing")).status).toBe(404);
    expect((await hub.get("/api/agents/reviewer")).status).toBe(404);

    const removed = await hub.delete("/api/participants/retired", auth(token));
    expect(removed.status).toBe(200);
    expect((await hub.get("/api/agents/retired")).status).toBe(404);
  });
});

describe("participant roster", () => {
  test("is open and returns the public participant shape", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    await hub.post("/api/humans", { handle: "reviewer" });
    const participant = hub.hub.store.findByToken(alice);
    expect(participant).not.toBeNull();
    hub.hub.store.bindRoute(participant!.id, {
      terminalId: "term_alice",
      paneId: "w1:p1",
      occupantAgent: "codex",
    });

    const response = await hub.get("/api/participants");

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      participants: [
        { handle: "alice", kind: "agent", agentKind: "codex", routeState: "active" },
        { handle: "reviewer", kind: "human", agentKind: null, routeState: "active" },
      ],
    });
  });

  test("deactivates an identity without deleting its message history", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const retired = await provision(hub, "retired");
    const retiredParticipant = hub.hub.store.findByToken(retired);
    expect(retiredParticipant).not.toBeNull();
    hub.hub.store.bindRoute(retiredParticipant!.id, {
      terminalId: "term_retired",
      paneId: "w1:p2",
      occupantAgent: "codex",
    });
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(retired));
    await hub.post("/api/channels/backend/messages", { body: "historical post" }, auth(retired));
    const direct = await body<{ channel: string }>(
      await hub.post("/api/direct", { to: ["alice"], body: "historical direct" }, auth(retired)),
    );

    expect((await hub.delete("/api/participants/retired")).status).toBe(401);
    const removed = await hub.delete("/api/participants/retired", auth(alice));
    expect(removed.status).toBe(200);
    expect(await body<{ handle: string }>(removed)).toEqual({ handle: "retired" });

    const roster = await body<{ participants: Array<{ handle: string }> }>(
      await hub.get("/api/participants"),
    );
    expect(roster.participants.map((participant) => participant.handle)).toEqual(["alice"]);
    const members = await body<{ members: Member[] }>(
      await hub.get("/api/channels/backend/members"),
    );
    expect(members.members.map((member) => member.handle)).toEqual(["alice"]);
    const history = await body<{ messages: Message[] }>(
      await hub.get("/api/channels/backend/messages"),
    );
    expect(history.messages[0]).toMatchObject({
      body: "historical post",
      sender: "retired",
      senderAgentKind: "codex",
    });
    expect(await body(await hub.get(`/api/channels/${direct.channel}/messages`))).toMatchObject({
      messages: [{ body: "historical direct", sender: "retired", senderAgentKind: "codex" }],
    });
    expect(await body(await hub.get("/api/direct", auth(alice)))).toEqual({
      conversations: [
        {
          channel: direct.channel,
          participants: ["retired"],
          unread: 1,
          lastMessageAt: expect.any(String),
        },
      ],
    });
    expect(await body<{ entries: InboxEntry[] }>(await hub.get("/api/inbox", auth(alice)))).toEqual({
      entries: [
        expect.objectContaining({ channel: "backend", senders: [], unread: 0 }),
        expect.objectContaining({ channel: direct.channel, senders: [], unread: 0 }),
      ],
    });
    expect((await hub.get("/api/inbox", auth(retired))).status).toBe(401);
    expect(
      (await hub.post(`/api/channels/${direct.channel}/messages`, { body: "blocked" }, auth(alice))).status,
    ).toBe(404);
    expect((await hub.post("/api/direct", { to: ["retired"], body: "blocked" }, auth(alice))).status).toBe(404);
    expect((await hub.delete("/api/participants/retired", auth(alice))).status).toBe(404);
  });
});

describe("membership management", () => {
  test("adds a participant at the channel high-water mark", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "before add" }, auth(alice));

    const added = await hub.post("/api/channels/backend/members", { handle: "bob" }, auth(alice));
    expect(added.status).toBe(201);
    expect(await body<{ channel: string; handle: string; cursorId: number }>(added)).toEqual({
      channel: "backend",
      handle: "bob",
      cursorId: 1,
    });

    const before = await hub.post("/api/channels/backend/fetch", {}, auth(bob));
    expect(await body<{ messages: Message[] }>(before)).toMatchObject({ messages: [] });

    await hub.post("/api/channels/backend/messages", { body: "after add" }, auth(alice));
    const after = await hub.post("/api/channels/backend/fetch", {}, auth(bob));
    expect((await body<{ messages: Message[] }>(after)).messages.map((message) => message.body)).toEqual([
      "after add",
    ]);
  });

  test("rejects an unknown or already-added participant", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    await provision(hub, "bob");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));

    expect(
      (await hub.post("/api/channels/backend/members", { handle: "nobody" }, auth(alice))).status,
    ).toBe(404);
    expect(
      (await hub.post("/api/channels/backend/members", { handle: "bob" }, auth(alice))).status,
    ).toBe(201);
    expect(
      (await hub.post("/api/channels/backend/members", { handle: "bob" }, auth(alice))).status,
    ).toBe(409);
  });

  test("allows any authenticated participant to remove another member", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));
    await hub.post("/api/channels/backend/members", { handle: "bob" }, auth(alice));

    const removed = await hub.handler(
      new Request(`${BASE}/api/channels/backend/members/bob`, {
        method: "DELETE",
        headers: auth(alice),
      }),
    );
    expect(removed.status).toBe(200);
    expect(await body<{ channel: string; handle: string }>(removed)).toEqual({
      channel: "backend",
      handle: "bob",
    });

    const members = await body<{ members: Member[] }>(await hub.get("/api/channels/backend/members"));
    expect(members.members.map((member) => member.handle)).toEqual(["alice"]);
    expect((await hub.post("/api/channels/backend/fetch", {}, auth(bob))).status).toBe(400);
  });
});

describe("channels", () => {
  test("creates a channel and reports counts", async () => {
    const hub = testHub();
    const token = await provision(hub, "alice");

    const created = await hub.post("/api/channels", { name: "backend", topic: "API work" }, auth(token));
    expect(created.status).toBe(201);
    expect(await body(created)).toMatchObject({
      name: "backend",
      topic: "API work",
      memberCount: 0,
      messageCount: 0,
      lastMessageAt: null,
    });

    expect((await hub.post("/api/channels", { name: "backend" }, auth(token))).status).toBe(409);
  });

  test("treats an omitted topic as null", async () => {
    const hub = testHub();
    const token = await provision(hub, "alice");
    const created = await hub.post("/api/channels", { name: "backend" }, auth(token));
    expect((await body<{ topic: string | null }>(created)).topic).toBeNull();
  });

  test("deletes a chat channel for the operator after exact confirmation", async () => {
    const hub = testHub();
    const agentToken = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "backend" }, auth(agentToken));
    await hub.post("/api/channels/backend/messages", { body: "remove this history" }, auth(agentToken));
    const operator = await operatorAuth(hub);

    const deleteChannel = (confirmation: string, headers: Record<string, string> = {}) =>
      hub.handler(new Request(`${BASE}/api/channels/backend`, {
        body: JSON.stringify({ confirm: confirmation }),
        headers: { "content-type": "application/json", ...headers },
        method: "DELETE",
      }));

    expect((await deleteChannel("backend")).status).toBe(401);
    expect((await deleteChannel("backend", auth(agentToken))).status).toBe(403);
    expect((await deleteChannel("wrong", operator)).status).toBe(400);
    const deleted = await deleteChannel("backend", operator);
    expect(deleted.status).toBe(200);
    expect(await body<{ name: string }>(deleted)).toEqual({ name: "backend" });
    expect((await hub.get("/api/channels/backend/messages")).status).toBe(404);
  });

  test("reports a missing channel rather than creating one", async () => {
    const hub = testHub();
    const token = await provision(hub, "alice");
    expect((await hub.post("/api/channels/ghost/join", {}, auth(token))).status).toBe(404);
    expect((await hub.get("/api/channels/ghost/messages")).status).toBe(404);
  });

  test("lists members with route state and unread counts", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));

    const members = await body<{ members: Array<{ handle: string; unread: number }> }>(
      await hub.get("/api/channels/backend/members"),
    );
    expect(members.members.map((m) => [m.handle, m.unread])).toEqual([
      ["alice", 0],
      ["bob", 1],
    ]);
  });
});

describe("messages", () => {
  test("a successful send starts an immediate notifier pass", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(bob));

    const bobParticipant = hub.hub.store.findByToken(bob);
    expect(bobParticipant).not.toBeNull();
    hub.hub.store.bindRoute(bobParticipant!.id, {
      terminalId: "term_bob",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    const herdr = new FakeHerdr().withPane({
      terminalId: "term_bob",
      paneId: "w1:p1",
    });
    const prompted = new Promise<void>((resolve) => {
      herdr.beforePrompt = () => resolve();
    });
    hub.hub.notifier = new Notifier({ store: hub.hub.store, herdr });

    const sent = await hub.post("/api/channels/backend/messages", { body: "immediate" }, auth(alice));
    await prompted;

    expect(sent.status).toBe(201);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.text).toContain("1 new message");
    expect(hub.hub.store.pendingNotifications()).toEqual([]);
  });

  test("takes the sender from the token, never from the payload", async () => {
    const { hub, alice } = await seed();
    const sent = await hub.post(
      "/api/channels/backend/messages",
      { body: "hello", sender: "bob", handle: "bob" },
      auth(alice),
    );
    expect((await body<Message>(sent)).sender).toBe("alice");
  });

  test("rejects an empty or oversized body", async () => {
    const { hub, alice } = await seed();
    expect((await hub.post("/api/channels/backend/messages", { body: "" }, auth(alice))).status).toBe(400);
    expect(
      (await hub.post("/api/channels/backend/messages", { body: "x".repeat(65_537) }, auth(alice)))
        .status,
    ).toBe(400);
  });

  test("rejects control characters outside message layout whitespace", async () => {
    const { hub, alice } = await seed();
    const bell = await hub.post("/api/channels/backend/messages", { body: "ring\u0007" }, auth(alice));
    expect(bell.status).toBe(400);

    const c1 = await hub.post(
      "/api/channels/backend/messages",
      { body: "line one\u0085line two" },
      auth(alice),
    );
    expect(c1.status).toBe(400);
  });

  test("round-trips multiline and tabbed message bodies", async () => {
    const { hub, alice } = await seed();
    const bodyText = "line one\nline\ttwo\rline three";
    const sent = await hub.post("/api/channels/backend/messages", { body: bodyText }, auth(alice));

    expect(sent.status).toBe(201);
    expect((await body<Message>(sent)).body).toBe(bodyText);
  });

  test("allows layout whitespace in topics but rejects C1 controls", async () => {
    const { hub, alice } = await seed();
    const topic = await hub.post(
      "/api/channels",
      { name: "alerts", topic: "line\nwrapped\twith\rspacing" },
      auth(alice),
    );
    expect(topic.status).toBe(201);
    expect((await body<Channel>(topic)).topic).toBe("line\nwrapped\twith\rspacing");

    const c1Topic = await hub.post(
      "/api/channels",
      { name: "blocked", topic: "line\u0085wrapped" },
      auth(alice),
    );
    expect(c1Topic.status).toBe(400);

    const attachment = await hub.post(
      "/api/channels/backend/messages",
      { body: "path", attachments: ["/tmp/file\tname"] },
      auth(alice),
    );
    expect(attachment.status).toBe(400);
  });

  test("pages history backwards from newest", async () => {
    const { hub, alice } = await seed();
    for (const text of ["one", "two", "three", "four"]) {
      await hub.post("/api/channels/backend/messages", { body: text }, auth(alice));
    }

    const latest = await body<{ messages: Message[] }>(
      await hub.get("/api/channels/backend/messages?limit=2"),
    );
    expect(latest.messages.map((m) => m.body)).toEqual(["three", "four"]);

    const earlier = await body<{ messages: Message[] }>(
      await hub.get("/api/channels/backend/messages?limit=2&before=3"),
    );
    expect(earlier.messages.map((m) => m.body)).toEqual(["one", "two"]);
  });

  test("context requires an anchor and returns a window around it", async () => {
    const { hub, alice } = await seed();
    for (const text of ["one", "two", "three", "four", "five"]) {
      await hub.post("/api/channels/backend/messages", { body: text }, auth(alice));
    }

    expect((await hub.get("/api/channels/backend/context")).status).toBe(400);
    const around = await body<{ messages: Message[] }>(
      await hub.get("/api/channels/backend/context?around=3&span=1"),
    );
    expect(around.messages.map((m) => m.body)).toEqual(["two", "three", "four"]);
  });
});

describe("fetch and ack", () => {
  test("a repeated fetch returns the same messages until acked", async () => {
    const { hub, alice, bob } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "two" }, auth(alice));

    const first = await body<{ messages: Message[]; throughId: number }>(
      await hub.post("/api/channels/backend/fetch", {}, auth(bob)),
    );
    expect(first.messages.map((m) => m.body)).toEqual(["one", "two"]);
    expect(first.throughId).toBe(2);

    const retry = await body<{ messages: Message[] }>(
      await hub.post("/api/channels/backend/fetch", {}, auth(bob)),
    );
    expect(retry.messages.map((m) => m.body)).toEqual(["one", "two"]);

    const acked = await hub.post("/api/channels/backend/ack", { throughId: 2 }, auth(bob));
    expect(await body(acked)).toEqual({ cursorId: 2 });

    const after = await body<{ messages: Message[] }>(
      await hub.post("/api/channels/backend/fetch", {}, auth(bob)),
    );
    expect(after.messages).toEqual([]);
  });

  test("ack never moves a cursor backwards", async () => {
    const { hub, alice, bob } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "two" }, auth(alice));

    await hub.post("/api/channels/backend/ack", { throughId: 2 }, auth(bob));
    const rewound = await hub.post("/api/channels/backend/ack", { throughId: 1 }, auth(bob));
    expect(await body(rewound)).toEqual({ cursorId: 2 });
  });

  test("rejects cross-channel and unknown message ids without moving the cursor", async () => {
    const { hub, alice, bob } = await seed();
    await hub.post("/api/channels", { name: "other" }, auth(alice));
    await hub.post("/api/channels/other/join", {}, auth(alice));
    await hub.post("/api/channels/other/join", {}, auth(bob));
    const other = await body<{ id: number }>(
      await hub.post("/api/channels/other/messages", { body: "other channel" }, auth(alice)),
    );

    const crossChannel = await hub.post(
      "/api/channels/backend/ack",
      { throughId: other.id },
      auth(bob),
    );
    expect(crossChannel.status).toBe(400);
    expect(await body<{ code: string }>(crossChannel)).toMatchObject({ code: "ValidationFailed" });

    const unknown = await hub.post(
      "/api/channels/backend/ack",
      { throughId: 99_999 },
      auth(bob),
    );
    expect(unknown.status).toBe(400);
    expect(await body<{ code: string }>(unknown)).toMatchObject({ code: "ValidationFailed" });

    const receipts = await body<ChannelReceipt[]>(
      await hub.get("/api/channels/backend/receipts", auth(alice)),
    );
    expect(receipts.find((receipt) => receipt.handle === "bob")?.cursorMessageId).toBe(0);
  });

  test("rejects a throughId that is not a non-negative integer", async () => {
    const { hub, bob } = await seed();
    for (const throughId of [-1, 1.5, "2", null]) {
      const response = await hub.post("/api/channels/backend/ack", { throughId }, auth(bob));
      expect(`${String(throughId)} -> ${response.status}`).toBe(`${String(throughId)} -> 400`);
    }
  });

  test("a non-member is told why rather than that the channel is missing", async () => {
    const { hub } = await seed();
    const outsider = await provision(hub, "outsider");
    const response = await hub.post("/api/channels/backend/fetch", {}, auth(outsider));
    expect(response.status).toBe(400);
    expect(await body<{ error: string }>(response)).toMatchObject({
      error: expect.stringContaining("Not a member"),
    });
  });
});

describe("seen receipts", () => {
  test("returns cursor watermarks and keeps a stale member visible", async () => {
    const { hub, alice, bob } = await seed();
    const first = await body<{ id: number }>(
      await hub.post("/api/channels/backend/messages", { body: "first" }, auth(alice)),
    );

    const before = await hub.get("/api/channels/backend/receipts", auth(alice));
    expect(before.status).toBe(200);
    expect(await body<ChannelReceipt[]>(before)).toEqual([
      { handle: "alice", cursorMessageId: first.id, routeState: "active" },
      { handle: "bob", cursorMessageId: 0, routeState: "active" },
    ]);

    const agentView = await hub.get("/api/channels/backend/receipts", auth(bob));
    expect(agentView.status).toBe(200);
    expect(await body<ChannelReceipt[]>(agentView)).toHaveLength(2);

    const fetched = await hub.post("/api/channels/backend/fetch", {}, auth(bob));
    expect(fetched.status).toBe(200);
    const afterFetch = await body<ChannelReceipt[]>(
      await hub.get("/api/channels/backend/receipts", auth(alice)),
    );
    expect(afterFetch.find((receipt) => receipt.handle === "bob")?.cursorMessageId).toBe(0);

    await hub.post("/api/channels/backend/ack", { throughId: first.id }, auth(bob));
    const second = await body<{ id: number }>(
      await hub.post("/api/channels/backend/messages", { body: "second" }, auth(alice)),
    );
    const bobParticipant = hub.hub.store.findByHandle("bob");
    if (bobParticipant === null) throw new Error("bob fixture is missing");
    hub.hub.store.markRouteStale(bobParticipant.id);

    const after = await body<ChannelReceipt[]>(
      await hub.get("/api/channels/backend/receipts", auth(alice)),
    );
    expect(after).toEqual([
      { handle: "alice", cursorMessageId: second.id, routeState: "active" },
      { handle: "bob", cursorMessageId: first.id, routeState: "stale" },
    ]);
    expect(after.find((receipt) => receipt.handle === "bob")?.cursorMessageId).toBeLessThan(second.id);
  });

  test("requires channel membership without exposing receipt rows", async () => {
    const { hub } = await seed();
    const outsider = await provision(hub, "outsider");

    const response = await hub.get("/api/channels/backend/receipts", auth(outsider));
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ code: "NotAMember", error: 'Not a member of "backend"' });
  });
});

describe("inbox", () => {
  test("reports unread, senders, and push readiness", async () => {
    const { hub, alice, bob } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));

    const inbox = await body<{ entries: InboxEntry[] }>(await hub.get("/api/inbox", auth(bob)));
    expect(inbox.entries).toEqual([
      { channel: "backend", unread: 1, senders: ["alice"], routeState: "active", pushEnabled: false },
    ]);
  });

  test("push stays off for every participant when the hub has no herdr", async () => {
    const hub = testHub({ pushAvailable: false });
    const alice = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));

    const inbox = await body<{ entries: Array<{ pushEnabled: boolean }> }>(
      await hub.get("/api/inbox", auth(alice)),
    );
    expect(inbox.entries[0]?.pushEnabled).toBe(false);
  });
});

describe("harness kind", () => {
  function inPane(token: string, paneId: string, agent: string) {
    return {
      ...auth(token),
      "x-msgr-terminal-id": `term_${paneId}`,
      "x-msgr-pane-id": paneId,
      "x-msgr-occupant": agent,
      "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
    };
  }

  test("is null before a route is bound and set afterwards", async () => {
    const { hub, alice } = await seed();

    const before = await body<{ members: Member[] }>(
      await hub.get("/api/channels/backend/members"),
    );
    expect(before.members.map((m) => m.agentKind)).toEqual([null, null]);

    await hub.get("/api/inbox", inPane(alice, "w1:p1", "claude"));

    const after = await body<{ members: Member[] }>(await hub.get("/api/channels/backend/members"));
    expect(after.members.find((m) => m.handle === "alice")?.agentKind).toBe("claude");
    expect(after.members.find((m) => m.handle === "bob")?.agentKind).toBeNull();
  });

  test("appears on the messages an agent sends", async () => {
    const { hub, alice } = await seed();
    await hub.get("/api/inbox", inPane(alice, "w1:p1", "codex"));

    const sent = await body<Message>(
      await hub.post("/api/channels/backend/messages", { body: "from codex" }, auth(alice)),
    );
    expect(sent.senderKind).toBe("agent");
    expect(sent.senderAgentKind).toBe("codex");
  });

  test("is null for a human", async () => {
    const hub = testHub();
    const created = await hub.post("/api/humans", { handle: "suleyman" });
    const token = (created.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
    const cookie = { cookie: `msgr_token=${token}` };

    const agentToken = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "backend" }, auth(agentToken));
    await hub.post("/api/channels/backend/join", {}, cookie);

    const sent = await body<Message>(
      await hub.post("/api/channels/backend/messages", { body: "hello" }, cookie),
    );
    expect(sent.senderKind).toBe("human");
    expect(sent.senderAgentKind).toBeNull();

    const members = await body<{ members: Member[] }>(
      await hub.get("/api/channels/backend/members"),
    );
    expect(members.members.find((m) => m.handle === "suleyman")?.agentKind).toBeNull();
  });

  test("history reports the kind alongside each message", async () => {
    const { hub, alice } = await seed();
    await hub.get("/api/inbox", inPane(alice, "w1:p1", "claude"));
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));

    const history = await body<{ messages: Message[] }>(
      await hub.get("/api/channels/backend/messages"),
    );
    expect(history.messages[0]?.senderAgentKind).toBe("claude");
  });
});

describe("route binding", () => {
  /**
   * Route headers are how the CLI reports the pane it is running in. They ride
   * alongside the token on any authenticated call, so one ordinary command
   * repairs delivery after a restart or a pane move.
   */
  function inPane(token: string, paneId: string) {
    return {
      ...auth(token),
      "x-msgr-terminal-id": `term_${paneId}`,
      "x-msgr-pane-id": paneId,
      "x-msgr-occupant": "claude",
      "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
    };
  }

  test("an agent becomes reachable by push once it reports a pane", async () => {
    const { hub, alice } = await seed();

    const before = await body<{ entries: InboxEntry[] }>(await hub.get("/api/inbox", auth(alice)));
    expect(before.entries[0]?.pushEnabled).toBe(false);

    await hub.get("/api/inbox", inPane(alice, "w1:p1"));

    const after = await body<{ entries: InboxEntry[] }>(await hub.get("/api/inbox", auth(alice)));
    expect(after.entries[0]?.pushEnabled).toBe(true);
    expect(after.entries[0]?.routeState).toBe("active");
  });

  test("a later call from a different pane rebinds the route", async () => {
    const { hub, alice } = await seed();
    await hub.get("/api/inbox", inPane(alice, "w1:p1"));
    await hub.get("/api/inbox", inPane(alice, "w1:p9"));

    expect(hub.hub.store.findByHandle("alice")?.paneId).toBe("w1:p9");
  });

  test("reports the active handle for an open pane identity read", async () => {
    const { hub, alice } = await seed();
    await hub.get("/api/inbox", inPane(alice, "w1:p1"));

    expect(await body<{ handle: string | null }>(await hub.get("/api/herdr/agents/w1:p1"))).toEqual({
      handle: "alice",
    });
    expect(await body<{ handle: string | null }>(await hub.get("/api/herdr/agents/w1:p9"))).toEqual({
      handle: null,
    });
  });

  test("a pane taken over by another agent leaves the first one stale", async () => {
    const { hub, alice, bob } = await seed();
    await hub.get("/api/inbox", inPane(alice, "w1:p1"));
    await hub.get("/api/inbox", inPane(bob, "w1:p1"));

    const displaced = hub.hub.store.findByHandle("alice");
    expect(displaced?.terminalId).toBe("term_w1:p1");
    expect(displaced?.paneId).toBe("w1:p1");
    expect(displaced?.occupantAgent).toBe("claude");
    expect(displaced?.routeState).toBe("stale");
    expect(hub.hub.store.findByHandle("bob")?.paneId).toBe("w1:p1");
  });

  test("a human is never given a route, even if the headers are sent", async () => {
    const hub = testHub();
    const created = await hub.post("/api/humans", { handle: "suleyman" });
    const token = (created.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";

    await hub.get("/api/inbox", {
      cookie: `msgr_token=${token}`,
      "x-msgr-terminal-id": "term_1",
      "x-msgr-pane-id": "w1:p1",
    });

    expect(hub.hub.store.findByHandle("suleyman")?.terminalId).toBeNull();
  });

  test("incomplete route headers bind nothing", async () => {
    const { hub, alice } = await seed();
    await hub.get("/api/inbox", { ...auth(alice), "x-msgr-pane-id": "w1:p1" });
    expect(hub.hub.store.findByHandle("alice")?.terminalId).toBeNull();
  });

  test("rejects a route from another herdr session", async () => {
    const { hub, alice } = await seed();
    const response = await hub.get("/api/inbox", {
      ...auth(alice),
      "x-msgr-terminal-id": "term_w1:p1",
      "x-msgr-pane-id": "w1:p1",
      "x-msgr-occupant": "claude",
      "x-msgr-herdr-socket-path": "/tmp/other-herdr.sock",
    });

    expect(response.status).toBe(403);
    expect((await body<{ error: string }>(response)).error).toContain("another herdr session");
    expect(hub.hub.store.findByHandle("alice")?.paneId).toBeNull();
  });

  test("rejects control characters in route headers", async () => {
    const { hub, alice } = await seed();
    const response = await hub.get("/api/inbox", {
      ...auth(alice),
      "x-msgr-terminal-id": "term_w1:p1",
      "x-msgr-pane-id": "w1:p1",
      "x-msgr-occupant": "claude\u001b[31m",
      "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
    });

    expect(response.status).toBe(400);
    expect((await body<{ error: string }>(response)).error).toContain("control characters");
    expect(hub.hub.store.findByHandle("alice")?.paneId).toBeNull();
  });
});

describe("direct messages", () => {
  test("creates an idempotent conversation and excludes it from chat channels", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await provision(hub, "carol");
    await hub.post("/api/channels", { name: "general" }, auth(alice));

    const first = await hub.post(
      "/api/direct",
      { to: ["bob", "carol"], body: "first" },
      auth(alice),
    );
    expect(first.status).toBe(201);
    const firstReply = await body<{ channel: string; messageId: number }>(first);
    expect(firstReply.channel.startsWith("dm-")).toBe(true);

    const second = await hub.post(
      "/api/direct",
      { to: ["carol", "bob"], body: "second" },
      auth(alice),
    );
    const secondReply = await body<{ channel: string; messageId: number }>(second);
    expect(secondReply.channel).toBe(firstReply.channel);
    expect(secondReply.messageId).not.toBe(firstReply.messageId);

    const channels = await body<{ channels: Array<{ name: string; kind: string }> }>(
      await hub.get("/api/channels"),
    );
    expect(channels.channels.map((channel) => [channel.name, channel.kind])).toEqual([
      ["general", "chat"],
    ]);
    expect(
      await body<{ conversations: Array<{ channel: string; participants: string[]; unread: number }> }>(
        await hub.get("/api/direct", auth(bob)),
      ),
    ).toEqual({
      conversations: [
        {
          channel: firstReply.channel,
          participants: ["alice", "carol"],
          unread: 2,
          lastMessageAt: expect.any(String),
        },
      ],
    });

    const history = await hub.get(`/api/channels/${firstReply.channel}/messages`);
    expect((await body<{ messages: Message[] }>(history)).messages.map((message) => message.body)).toEqual([
      "first",
      "second",
    ]);
  });

  test("delivers direct messages only to direct members", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    const carol = await provision(hub, "carol");
    await hub.post("/api/channels", { name: "shared" }, auth(alice));
    await hub.post("/api/channels/shared/join", {}, auth(alice));
    await hub.post("/api/channels/shared/join", {}, auth(carol));

    const bobParticipant = hub.hub.store.findByToken(bob);
    const carolParticipant = hub.hub.store.findByToken(carol);
    expect(bobParticipant).not.toBeNull();
    expect(carolParticipant).not.toBeNull();
    hub.hub.store.bindRoute(bobParticipant!.id, {
      terminalId: "term_bob",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    hub.hub.store.bindRoute(carolParticipant!.id, {
      terminalId: "term_carol",
      paneId: "w1:p2",
      occupantAgent: "claude",
    });
    const herdr = new FakeHerdr()
      .withPane({ terminalId: "term_bob", paneId: "w1:p1", agentStatus: "idle" })
      .withPane({ terminalId: "term_carol", paneId: "w1:p2", agentStatus: "idle" });
    const notifier = new Notifier({ store: hub.hub.store, herdr });

    const sent = await hub.post("/api/direct", { to: ["bob"], body: "only bob" }, auth(alice));
    const reply = await body<{ channel: string; messageId: number }>(sent);
    const outcome = await notifier.notifyChannel(reply.channel);

    expect(outcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([
      {
        paneId: "w1:p1",
        text: `[msgr] 1 new message from alice in #${reply.channel}. Run: msgr read ${reply.channel}, then resume your interrupted task unless the messages explicitly reassign you.`,
      },
    ]);
    expect(hub.hub.store.pendingNotifications()).toEqual([]);
  });

  test("rejects unknown recipients and outsider joins", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    await provision(hub, "bob");
    const outsider = await provision(hub, "outsider");

    expect((await hub.post("/api/direct", { to: ["nobody"], body: "missing" }, auth(alice))).status).toBe(404);
    const sent = await hub.post("/api/direct", { to: ["bob"], body: "private" }, auth(alice));
    const reply = await body<{ channel: string; messageId: number }>(sent);
    const joined = await hub.post(`/api/channels/${reply.channel}/join`, {}, auth(outsider));
    expect(joined.status).toBe(403);
    expect((await body<{ error: string }>(joined)).error).toContain("fixed membership");
    expect(
      (
        await hub.post(
          `/api/channels/${reply.channel}/messages`,
          { body: "intrude" },
          auth(outsider),
        )
      ).status,
    ).toBe(403);
  });
});

describe("search", () => {
  test("matches literally and scopes to a channel", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels", { name: "general" }, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "the deploy pipeline is green" }, auth(alice));
    await hub.post("/api/channels/general/messages", { body: "deploy notes posted" }, auth(alice));

    const all = await body<{ results: Array<{ channel: string }> }>(
      await hub.get("/api/search?q=deploy"),
    );
    expect(all.results.length).toBe(2);

    const scoped = await body<{ results: Array<{ channel: string; messageId: number }> }>(
      await hub.get("/api/search?q=deploy&channel=backend"),
    );
    expect(scoped.results.map((r) => r.channel)).toEqual(["backend"]);
    expect(scoped.results[0]?.messageId).toBeGreaterThan(0);
  });

  test("reports attachment counts without exposing attachment metadata", async () => {
    const { hub, alice } = await seed();
    const directory = mkdtempSync(join(tmpdir(), "msgr-search-attachments-"));
    const firstPath = join(directory, "private-first-secret.md");
    const secondPath = join(directory, "private-second-secret.md");
    writeFileSync(firstPath, "first attachment");
    writeFileSync(secondPath, "second attachment");

    try {
      const withoutAttachments = await body<Message>(await hub.post(
        "/api/channels/backend/messages",
        { body: "searchable without files" },
        auth(alice),
      ));
      const withAttachments = await body<Message>(await hub.post(
        "/api/channels/backend/messages",
        { body: "searchable with files", attachments: [firstPath, secondPath] },
        auth(alice),
      ));

      const response = await hub.get("/api/search?q=searchable");
      expect(response.status).toBe(200);
      const encoded = await response.text();
      interface SearchWire {
        messageId: number;
        channel: string;
        sender: string;
        snippet: string;
        createdAt: string;
        attachmentCount: number;
      }
      interface SearchResponseWire {
        results: SearchWire[];
        truncated: boolean;
      }
      // SAFETY: the endpoint returns the search envelope used by this test.
      const parsed = JSON.parse(encoded) as SearchResponseWire;
      expect(parsed.results).toHaveLength(2);
      expect(Object.keys(parsed.results[0] ?? {}).sort()).toEqual([
        "attachmentCount",
        "channel",
        "createdAt",
        "messageId",
        "sender",
        "snippet",
      ]);
      expect(parsed.results.find((result) => result.messageId === withoutAttachments.id)?.attachmentCount).toBe(0);
      expect(parsed.results.find((result) => result.messageId === withAttachments.id)?.attachmentCount).toBe(2);
      expect(encoded).not.toContain(firstPath);
      expect(encoded).not.toContain(secondPath);
      expect(encoded).not.toContain("private-first-secret.md");
      expect(encoded).not.toContain("private-second-secret.md");
      expect(encoded).not.toContain("mediaType");
      expect(encoded).not.toContain("displayName");
      expect(encoded).not.toContain("attachments");
      expect(parsed.truncated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats query operators as text", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "green build" }, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "red build" }, auth(alice));

    const both = await body<{ results: unknown[] }>(await hub.get("/api/search?q=build"));
    expect(both.results.length).toBe(2);

    // As an operator this would match either term; as text it matches neither.
    const asText = await body<{ results: unknown[] }>(await hub.get("/api/search?q=green+OR+red"));
    expect(asText.results.length).toBe(0);
  });

  test("survives punctuation and unbalanced quotes instead of erroring", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "ordinary text" }, auth(alice));

    for (const query of [`"`, `foo"`, `NEAR(a b)`, `*`, `a AND`, `-x`, `col:val`]) {
      const response = await hub.get(`/api/search?q=${encodeURIComponent(query)}`);
      expect(response.status).toBeLessThan(500);
    }
  });

  test("reports an unknown channel filter", async () => {
    const { hub } = await seed();
    expect((await hub.get("/api/search?q=hello&channel=ghost")).status).toBe(404);
  });

  test("requires a query with something matchable in it", async () => {
    const { hub } = await seed();
    expect((await hub.get("/api/search")).status).toBe(400);
    expect((await hub.get("/api/search?q=%20%20")).status).toBe(400);
    expect((await hub.get(`/api/search?q=${"x".repeat(257)}`)).status).toBe(400);
  });
});

describe("attachments", () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "msgr-attach-"));
    return {
      dir,
      file: (name: string, contents: Buffer | string) => {
        const path = join(dir, name);
        writeFileSync(path, contents);
        return path;
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("records metadata and marks a real image previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const image = files.file("chart.png", PNG);
      const notes = files.file("notes.txt", "plain text");

      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "see attached", attachments: [image, notes] },
          auth(alice),
        ),
      );

      expect(sent.attachments.map((a) => [a.displayName, a.previewEligible, a.mediaType, a.previewKind])).toEqual([
        ["chart.png", true, "image/png", "image"],
        ["notes.txt", false, "text/plain", null],
      ]);
      expect(sent.attachments[0]?.byteSize).toBe(PNG.byteLength);
    } finally {
      files.cleanup();
    }
  });

  test("an image extension without image bytes is not previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const fake = files.file("payload.png", "#!/bin/sh\necho not an image");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "look", attachments: [fake] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(false);

      const served = await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`, auth(alice));
      expect(served.status).toBe(415);
    } finally {
      files.cleanup();
    }
  });

  test("rejects a relative path and a path that names no file", async () => {
    const { hub, alice } = await seed();
    for (const path of ["relative/chart.png", "/tmp/definitely-not-here-99999.png"]) {
      const response = await hub.post(
        "/api/channels/backend/messages",
        { body: "x", attachments: [path] },
        auth(alice),
      );
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 400`);
    }
  });

  test("serves an image and refuses it once the bytes change", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const image = files.file("chart.png", PNG);
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "chart", attachments: [image] },
          auth(alice),
        ),
      );
      const id = sent.attachments[0]?.id ?? 0;

      const served = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toBe("sandbox");
      expect(served.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(PNG));

      writeFileSync(image, Buffer.concat([PNG, Buffer.from("extra")]));
      const changed = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(changed.status).toBe(404);

      rmSync(image);
      const missing = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(missing.status).toBe(404);
    } finally {
      files.cleanup();
    }
  });

  test("refuses a path swapped for a file nobody shared", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const image = files.file("chart.png", PNG);
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "chart", attachments: [image] },
          auth(alice),
        ),
      );
      const id = sent.attachments[0]?.id ?? 0;

      writeFileSync(image, "PRIVATE KEY MATERIAL");
      const swapped = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(swapped.status).toBe(404);
      expect(await swapped.text()).not.toContain("PRIVATE KEY");
    } finally {
      files.cleanup();
    }
  });

  test("markdown is previewable and served as text", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const notes = files.file("notes.md", "# Findings\n\nThe deploy is green.\n");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "notes attached", attachments: [notes] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(true);
      expect(sent.attachments[0]?.mediaType).toBe("text/markdown");
      expect(sent.attachments[0]?.previewKind).toBe("markdown");

      const served = await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`, auth(alice));
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-security-policy")).toBe("sandbox");
      expect(served.headers.get("cache-control")).toBe("no-store");
      expect(await served.text()).toContain("# Findings");
    } finally {
      files.cleanup();
    }
  });

  test("the .markdown extension is previewable too", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const notes = files.file("notes.markdown", "# Title\n");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [notes] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(true);
    } finally {
      files.cleanup();
    }
  });

  test("markdown that is not valid UTF-8 is not previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      // A lone continuation byte cannot begin a UTF-8 sequence.
      const broken = files.file("broken.md", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [broken] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(false);

      const served = await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`, auth(alice));
      expect(served.status).toBe(415);
    } finally {
      files.cleanup();
    }
  });

  test("markdown past the size cap stays shareable but not previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const huge = files.file("huge.md", "#".repeat(1024 * 1024 + 1));
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [huge] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(false);
      expect(sent.attachments[0]?.displayName).toBe("huge.md");
      expect((await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`, auth(alice))).status).toBe(415);
    } finally {
      files.cleanup();
    }
  });

  test("markdown just inside the cap is previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const atLimit = files.file("limit.md", "#".repeat(1024 * 1024));
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [atLimit] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(true);
    } finally {
      files.cleanup();
    }
  });

  test("markdown edited after sending is refused, like an image", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const notes = files.file("notes.md", "# Original\n");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [notes] },
          auth(alice),
        ),
      );
      const id = sent.attachments[0]?.id ?? 0;
      expect((await hub.get(`/api/attachments/${id}/content`, auth(alice))).status).toBe(200);

      writeFileSync(notes, "# Replaced with something else\n");
      const changed = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(changed.status).toBe(404);
      expect(await changed.text()).not.toContain("Replaced");
    } finally {
      files.cleanup();
    }
  });

  test("markdown preview still requires a token", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const notes = files.file("notes.md", "# Secret notes\n");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [notes] },
          auth(alice),
        ),
      );
      const anonymous = await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.text()).not.toContain("Secret notes");
    } finally {
      files.cleanup();
    }
  });

  test("a plain text file is still not previewable", async () => {
    const { hub, alice } = await seed();
    const files = scratch();
    try {
      const notes = files.file("notes.txt", "# Looks like markdown but is not\n");
      const sent = await body<Message>(
        await hub.post(
          "/api/channels/backend/messages",
          { body: "x", attachments: [notes] },
          auth(alice),
        ),
      );
      expect(sent.attachments[0]?.previewEligible).toBe(false);
      expect(sent.attachments[0]?.mediaType).toBe("text/plain");
      expect((await hub.get(`/api/attachments/${sent.attachments[0]?.id}/content`, auth(alice))).status).toBe(415);
    } finally {
      files.cleanup();
    }
  });

  test("an unknown attachment id is not distinguishable from a forbidden one", async () => {
    const { hub, alice } = await seed();
    for (const id of ["999", "0", "-1", "abc"]) {
      const response = await hub.get(`/api/attachments/${id}/content`, auth(alice));
      expect(`${id} -> ${response.status}`).toBe(`${id} -> 404`);
    }
  });
});

describe("routing", () => {
  test("an unknown api path is a JSON 404, never the web interface", async () => {
    const hub = testHub();
    const response = await hub.get("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("a channel name with a slash or hash survives encoding", async () => {
    const hub = testHub();
    const token = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "backend" }, auth(token));

    const response = await hub.get(`/api/channels/${encodeURIComponent("backend")}/members`);
    expect(response.status).toBe(200);
  });

  test("every success carries a JSON body the client can parse", async () => {
    const { hub, alice } = await seed();
    const responses = [
      await hub.get("/api/channels"),
      await hub.get("/api/inbox", auth(alice)),
      await hub.post("/api/channels/backend/fetch", {}, auth(alice)),
      await hub.get("/api/channels/backend/members"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(1);
    }
  });
});
