import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_START_TIMEOUT_MS, type RoleConfig } from "../src/config";
import {
  ChannelExists,
  ChannelNotDeletable,
  ChannelNotFound,
  DirectMembershipLocked,
  HandleTaken,
  LauncherExists,
  NotAMember,
  NotFound,
  ValidationFailed,
} from "../src/errors";
import type { Store } from "../src/store";
import { expectErr, expectOk, freshStore } from "./support";

/** Creates a channel plus two joined agents, the common arrangement under test. */
function twoAgentChannel(store: Store) {
  const alice = expectOk(store.createAgent("alice")).participant.id;
  const bob = expectOk(store.createAgent("bob")).participant.id;
  expectOk(store.createChannel("backend", null));
  expectOk(store.join(alice, "backend"));
  expectOk(store.join(bob, "backend"));
  return { alice, bob, channel: "backend" };
}

function reporterSeed(native: boolean): RoleConfig {
  return {
    name: "reporter",
    agentKind: "claude",
    native,
    summary: "Seed reporter summary.",
    briefing: "Seed reporter briefing.",
    launcher: "claude",
    model: "default",
    effort: "medium",
  };
}

describe("participants", () => {
  test("returns a token once and never stores it in plain text", () => {
    const { db, store } = freshStore();
    const created = expectOk(store.createAgent("opus21"));

    expect(created.token.length).toBeGreaterThan(20);
    expect(created.participant.handle).toBe("opus21");
    expect(created.participant.kind).toBe("agent");

    const stored = db
      .query<{ token_hash: string }, []>(`SELECT token_hash FROM participants`)
      .get();
    expect(stored?.token_hash).not.toBe(created.token);
  });

  test("rejects a duplicate handle across kinds", () => {
    const { store } = freshStore();
    expectOk(store.createAgent("suleyman"));

    const error = expectErr(store.createHuman("suleyman"));
    expect(HandleTaken.is(error)).toBe(true);
    expect(error.handle).toBe("suleyman");
  });

  test("resolves a participant only by its own token", () => {
    const { store } = freshStore();
    const created = expectOk(store.createAgent("opus21"));
    const other = expectOk(store.createAgent("codex1"));

    expect(store.findByToken(created.token)?.handle).toBe("opus21");
    expect(store.findByToken(other.token)?.handle).toBe("codex1");
    expect(store.findByToken("not-a-real-token")).toBeNull();
  });

  test("deactivation removes active surfaces and keeps attributed history", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice"));
    const retired = expectOk(store.createAgent("retired"));
    store.bindRoute(alice.participant.id, {
      terminalId: "term_alice",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    store.bindRoute(retired.participant.id, {
      terminalId: "term_retired",
      paneId: "w1:p2",
      occupantAgent: "codex",
    });
    expectOk(store.createChannel("backend", null));
    expectOk(store.join(alice.participant.id, "backend"));
    expectOk(store.join(retired.participant.id, "backend"));
    expectOk(store.send(retired.participant.id, "backend", "keep this attribution"));
    const direct = expectOk(
      store.sendDirect(retired.participant.id, ["alice"], "keep this direct history"),
    );

    expect(expectOk(store.deactivateParticipant("retired"))).toEqual({ handle: "retired" });

    expect(store.findByToken(retired.token)).toBeNull();
    expect(store.findByHandle("retired")).toMatchObject({
      deactivated: true,
      occupantAgent: "codex",
      paneId: null,
      routeState: "stale",
      terminalId: null,
    });
    expect(store.listParticipants().map((participant) => participant.handle)).toEqual(["alice"]);
    expect(expectOk(store.listMembers("backend")).map((member) => member.handle)).toEqual(["alice"]);
    expect(store.findChannel("backend")?.memberCount).toBe(1);
    expect(store.inbox(alice.participant.id)).toEqual([
      expect.objectContaining({ channel: "backend", senders: [], unread: 0 }),
      expect.objectContaining({ channel: direct.channel, senders: [], unread: 0 }),
    ]);
    expect(store.pendingNotifications()).toEqual([]);
    expect(expectOk(store.history("backend", 10, null))[0]).toMatchObject({
      sender: "retired",
      senderAgentKind: "codex",
    });
    expect(expectOk(store.history(direct.channel, 10, null))[0]).toMatchObject({
      sender: "retired",
      senderAgentKind: "codex",
    });
    expect(store.listDirect(alice.participant.id)).toEqual([
      {
        channel: direct.channel,
        participants: ["retired"],
        unread: 1,
        lastMessageAt: expect.any(String),
      },
    ]);
    expect(NotFound.is(expectErr(store.send(alice.participant.id, direct.channel, "blocked")))).toBe(true);
    expect(NotFound.is(expectErr(store.sendDirect(alice.participant.id, ["retired"], "blocked")))).toBe(true);
    expect(NotFound.is(expectErr(store.deactivateParticipant("retired")))).toBe(true);
  });
});

describe("routes", () => {
  test("binds a route and reactivates a stale one", () => {
    const { store } = freshStore();
    const agent = expectOk(store.createAgent("opus21")).participant;

    store.bindRoute(agent.id, {
      terminalId: "term_1",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    expect(store.findByHandle("opus21")?.paneId).toBe("w1:p1");

    store.markRouteStale(agent.id);
    expect(store.findByHandle("opus21")?.routeState).toBe("stale");

    store.bindRoute(agent.id, {
      terminalId: "term_1",
      paneId: "w1:p2",
      occupantAgent: "claude",
    });
    const healed = store.findByHandle("opus21");
    expect(healed?.routeState).toBe("active");
    expect(healed?.paneId).toBe("w1:p2");
  });

  test("a replacement in the same terminal displaces the previous holder", () => {
    const { store } = freshStore();
    const first = expectOk(store.createAgent("opus21")).participant;
    const second = expectOk(store.createAgent("codex1")).participant;
    const route = { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" };

    store.bindRoute(first.id, route);
    store.bindRoute(second.id, route);

    const displaced = store.findByHandle("opus21");
    expect(displaced?.terminalId).toBe("term_1");
    expect(displaced?.paneId).toBe("w1:p1");
    expect(displaced?.occupantAgent).toBe("claude");
    expect(displaced?.routeState).toBe("stale");

    const holder = store.findByHandle("codex1");
    expect(holder?.terminalId).toBe("term_1");
    expect(holder?.routeState).toBe("active");
  });

  test("uses the most recently seen stale route for a terminal", () => {
    const { db, store } = freshStore();
    const older = expectOk(store.createParticipant("older", "agent", "codex"));
    const newer = expectOk(store.createParticipant("newer", "agent", "codex"));

    store.bindRoute(older.participant.id, {
      occupantAgent: "codex",
      paneId: "pane-old",
      terminalId: "terminal-shared",
    });
    store.bindRoute(newer.participant.id, {
      occupantAgent: "codex",
      paneId: "pane-new",
      terminalId: "terminal-shared",
    });
    db.query<never, { id: number; seenAt: string }>(
      `UPDATE participants SET last_seen_at = $seenAt WHERE id = $id`,
    ).run({ id: older.participant.id, seenAt: "2026-08-18T08:00:00.000Z" });
    db.query<never, { id: number; seenAt: string }>(
      `UPDATE participants SET last_seen_at = $seenAt WHERE id = $id`,
    ).run({ id: newer.participant.id, seenAt: "2026-08-18T08:01:00.000Z" });
    store.markRouteStale(newer.participant.id);

    expect(store.agentRouteForTerminal("terminal-shared")).toEqual({
      id: newer.participant.id,
      handle: "newer",
      routeState: "stale",
    });
  });
});

describe("session mappings", () => {
  test("stores and replaces the server-resolved row by terminal", () => {
    const { store } = freshStore();

    store.saveSessionMapping({
      terminal_id: "term-1",
      harness: "claude",
      session_id: "first",
      session_path: "/sessions/first.jsonl",
      confidence: "exact",
    });
    expect(store.findSessionMapping("term-1")).toMatchObject({
      terminal_id: "term-1",
      harness: "claude",
      session_id: "first",
      session_path: "/sessions/first.jsonl",
      confidence: "exact",
    });

    store.saveSessionMapping({
      terminal_id: "term-1",
      harness: "codex",
      session_id: "second",
      session_path: "/sessions/second.jsonl",
      confidence: "inferred",
    });
    expect(store.findSessionMapping("term-1")).toMatchObject({
      terminal_id: "term-1",
      harness: "codex",
      session_id: "second",
      session_path: "/sessions/second.jsonl",
      confidence: "inferred",
    });
  });
});

describe("launchers", () => {
  test("persists edits and seed tombstones", () => {
    const { store } = freshStore();
    store.seedLaunchers([
      {
        name: "claude",
        agentKind: "claude",
        argv: ["claude"],
        env: {},
        startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
      },
    ]);

    expect(store.listLaunchers()).toEqual([
      {
        name: "claude",
        agentKind: "claude",
        argv: ["claude"],
        env: {},
        startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        revision: 1,
      },
    ]);
    store.seedLaunchers([
      {
        name: "claude",
        agentKind: "claude",
        argv: ["claude", "--changed-seed"],
        env: {},
        startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
      },
    ]);
    expect(store.launcher("claude")?.argv).toEqual(["claude"]);

    expect(expectOk(store.deleteLauncher("claude"))).toEqual({ name: "claude" });
    store.seedLaunchers([
      {
        name: "claude",
        agentKind: "claude",
        argv: ["claude"],
        env: {},
        startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
      },
    ]);
    expect(store.launcher("claude")).toBeNull();

    store.seedLaunchers([
      {
        name: "codex",
        agentKind: "codex",
        argv: ["codex"],
        env: {},
        startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
      },
    ]);
    expect(store.listLaunchers().map((launcher) => launcher.name)).toEqual(["codex"]);
  });

  test("creates and revises a launcher without changing its name", () => {
    const { store } = freshStore();
    const created = expectOk(
      store.createLauncher({
        name: "claude-personal",
        agentKind: "claude",
        argv: ["claude", "--profile", "personal"],
        env: {},
        startTimeoutMs: 40_000,
      }),
    );
    expect(created.revision).toBe(1);
    expect(
      LauncherExists.is(
        expectErr(
          store.createLauncher({
            name: "claude-personal",
            agentKind: "claude",
            argv: ["claude"],
            env: {},
            startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
          }),
        ),
      ),
    ).toBe(true);

    const updated = expectOk(
      store.updateLauncher("claude-personal", {
        agentKind: "claude",
        argv: ["claude", "--profile", "work"],
        env: {},
        startTimeoutMs: 50_000,
      }),
    );
    expect(updated).toMatchObject({
      name: "claude-personal",
      argv: ["claude", "--profile", "work"],
      startTimeoutMs: 50_000,
      revision: 2,
    });
  });
});

describe("roles", () => {
  test("migrates a historical reporter seed and preserves product fields", () => {
    const { db, store } = freshStore();
    store.seedRoles([reporterSeed(false)]);
    db
      .query<never, {
        name: string;
        agentKind: string;
        summary: string;
        briefing: string;
        launcher: string;
        model: string;
        effort: string;
        revision: number;
        createdAt: string;
        updatedAt: string;
      }>(
        `UPDATE roles
            SET agent_kind = $agentKind,
                summary = $summary,
                briefing = $briefing,
                launcher = $launcher,
                model = $model,
                effort = $effort,
                revision = $revision,
                created_at = $createdAt,
                updated_at = $updatedAt
          WHERE name = $name`,
      )
      .run({
        name: "reporter",
        agentKind: "legacy-agent",
        summary: "Legacy summary.",
        briefing: "Legacy briefing.",
        launcher: "legacy-launcher",
        model: "legacy-model",
        effort: "legacy-effort",
        revision: 9,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      });

    store.seedRoles([{
      ...reporterSeed(true),
      agentKind: "new-agent",
      summary: "New summary.",
      briefing: "New briefing.",
      launcher: "new-launcher",
      model: "new-model",
      effort: "new-effort",
    }]);

    expect(
      db
        .query<{
          agent_kind: string | null;
          summary: string;
          briefing: string;
          launcher: string | null;
          model: string | null;
          effort: string | null;
          native: number;
          revision: number;
          created_at: string;
          updated_at: string;
        }, { name: string }>(
          `SELECT agent_kind, summary, briefing, launcher, model, effort, native,
                  revision, created_at, updated_at
             FROM roles
            WHERE name = $name`,
        )
        .get({ name: "reporter" }),
    ).toEqual({
      agent_kind: null,
      summary: "Legacy summary.",
      briefing: "Legacy briefing.",
      launcher: null,
      model: null,
      effort: null,
      native: 1,
      revision: 9,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
  });

  test("keeps a historical reporter tombstone absent", () => {
    const { store } = freshStore();
    store.seedRoles([reporterSeed(false)]);
    expectOk(store.deleteRole("reporter"));

    store.seedRoles([reporterSeed(true)]);

    expect(store.role("reporter")).toBeNull();
  });

  test("keeps a first-seen custom reporter row non-native", () => {
    const { store } = freshStore();
    expectOk(
      store.createRole({
        name: "reporter",
        agentKind: "custom-agent",
        summary: "Custom summary.",
        briefing: "Custom briefing.",
        launcher: "custom-launcher",
        model: "custom-model",
        effort: "custom-effort",
      }),
    );

    store.seedRoles([reporterSeed(true)]);

    expect(store.role("reporter")).toMatchObject({
      name: "reporter",
      agentKind: "custom-agent",
      summary: "Custom summary.",
      native: false,
    });
  });

  test("keeps launcher seeding separate from reporter role promotion", () => {
    const { store } = freshStore();
    expectOk(
      store.createRole({
        name: "reporter",
        agentKind: "custom-agent",
        summary: "Custom summary.",
        briefing: "Custom briefing.",
        launcher: null,
        model: null,
        effort: null,
      }),
    );

    store.seedLaunchers([{
      name: "reporter",
      agentKind: "claude",
      argv: ["claude"],
      env: {},
      startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
    }]);

    expect(store.launcher("reporter")).toMatchObject({
      name: "reporter",
      agentKind: "claude",
      argv: ["claude"],
      startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
    });
    expect(store.role("reporter")?.native).toBe(false);
  });
});

describe("channels and membership", () => {
  test("rejects a duplicate channel name", () => {
    const { store } = freshStore();
    expectOk(store.createChannel("backend", "API work"));

    const error = expectErr(store.createChannel("backend", null));
    expect(ChannelExists.is(error)).toBe(true);
  });

  test("reports a missing channel rather than creating one", () => {
    const { store } = freshStore();
    const agent = expectOk(store.createAgent("opus21")).participant;

    const error = expectErr(store.join(agent.id, "typo-channel"));
    expect(ChannelNotFound.is(error)).toBe(true);
    expect(store.listChannels()).toEqual([]);
  });

  test("deletes a chat channel and its dependent state after exact confirmation", () => {
    const { db, store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    const sent = expectOk(store.send(alice, "backend", "remove this history"));
    expectOk(store.ack(bob, "backend", sent.id));

    const wrongConfirmation = expectErr(store.deleteChannel("backend", "wrong"));
    expect(ValidationFailed.is(wrongConfirmation)).toBe(true);
    expect(store.findChannel("backend")).not.toBeNull();

    expect(expectOk(store.deleteChannel("backend", "backend"))).toEqual({ name: "backend" });
    expect(store.findChannel("backend")).toBeNull();
    expect(store.listChannels()).toEqual([]);
    expect(db.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM messages WHERE channel_id = (SELECT id FROM channels WHERE name = ?)`)
      .get("backend")?.count).toBe(0);
    expect(store.search("history", null, null, 50)).toEqual([]);
  });

  test("does not delete direct conversation channels", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    const bob = expectOk(store.createAgent("bob")).participant.id;
    const direct = expectOk(store.sendDirect(alice, ["bob"], "keep this conversation"));

    const error = expectErr(store.deleteChannel(direct.channel, direct.channel));
    expect(ChannelNotDeletable.is(error)).toBe(true);
    expect(store.findChannel(direct.channel)?.kind).toBe("direct");
  });

  test("a new member starts at the current high-water mark", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    expectOk(store.createChannel("backend", null));
    expectOk(store.join(alice, "backend"));

    expectOk(store.send(alice, "backend", "first"));
    expectOk(store.send(alice, "backend", "second"));

    const bob = expectOk(store.createAgent("bob")).participant.id;
    const joined = expectOk(store.join(bob, "backend"));

    expect(joined.cursorId).toBe(2);
    expect(expectOk(store.fetch(bob, "backend")).messages).toEqual([]);
    expect(expectOk(store.history("backend", 10, null)).length).toBe(2);
  });

  test("re-joining is idempotent and never rewinds the cursor", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);

    expectOk(store.send(alice, "backend", "hello"));
    expectOk(store.ack(bob, "backend", 1));

    const rejoined = expectOk(store.join(bob, "backend"));
    expect(rejoined.cursorId).toBe(1);
  });

  test("counts unread per member", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(alice, "backend", "two"));

    const members = expectOk(store.listMembers("backend"));
    expect(members.map((member) => [member.handle, member.unread])).toEqual([
      ["alice", 0],
      ["bob", 2],
    ]);
  });

  test("workspace member setup does not leave a channel for an unknown participant", () => {
    const { store } = freshStore();

    const error = expectErr(store.ensureWorkspaceMembers("workspace", [999]));
    expect(NotFound.is(error)).toBe(true);
    expect(store.findChannel("workspace")).toBeNull();
  });
});

describe("direct conversations", () => {
  test("uses one channel for the same participant set and reports unread counts", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    const bob = expectOk(store.createAgent("bob")).participant.id;
    expectOk(store.createAgent("carol"));

    const first = expectOk(store.sendDirect(alice, ["bob", "carol"], "first"));
    const second = expectOk(store.sendDirect(alice, ["carol", "bob"], "second"));

    expect(second.channel).toBe(first.channel);
    expect(store.listChannels()).toEqual([]);
    expect(store.findChannel(first.channel)?.kind).toBe("direct");
    expect(expectOk(store.listMembers(first.channel)).map((member) => member.handle)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(expectOk(store.history(first.channel, 10, null)).map((message) => message.body)).toEqual([
      "first",
      "second",
    ]);
    expect(store.listDirect(bob)).toEqual([
      {
        channel: first.channel,
        participants: ["alice", "carol"],
        unread: 2,
        lastMessageAt: second.createdAt,
      },
    ]);
  });

  test("keeps direct membership fixed", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    const bob = expectOk(store.createAgent("bob")).participant.id;
    const outsider = expectOk(store.createAgent("outsider")).participant.id;
    const sent = expectOk(store.sendDirect(alice, ["bob"], "private"));

    expect(DirectMembershipLocked.is(expectErr(store.join(outsider, sent.channel)))).toBe(true);
    expect(DirectMembershipLocked.is(expectErr(store.addMember(sent.channel, "outsider")))).toBe(true);
    expect(DirectMembershipLocked.is(expectErr(store.removeMember(sent.channel, "bob")))).toBe(true);
    expect(DirectMembershipLocked.is(expectErr(store.send(outsider, sent.channel, "intrude")))).toBe(true);
    expectOk(store.join(bob, sent.channel));
  });
});

describe("unread semantics", () => {
  test("excludes the reader's own messages", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);

    expectOk(store.send(alice, "backend", "from alice"));
    expectOk(store.send(bob, "backend", "from bob"));

    expect(expectOk(store.fetch(alice, "backend")).messages.map((m) => m.body)).toEqual([
      "from bob",
    ]);
    expect(expectOk(store.fetch(bob, "backend")).messages.map((m) => m.body)).toEqual([
      "from alice",
    ]);
  });

  test("requires membership to fetch", () => {
    const { store } = freshStore();
    twoAgentChannel(store);
    const outsider = expectOk(store.createAgent("outsider")).participant.id;

    const error = expectErr(store.fetch(outsider, "backend"));
    expect(NotAMember.is(error)).toBe(true);
  });

  test("advances a caught-up sender's cursor and notification watermark", () => {
    const { db, store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);

    expectOk(store.send(alice, "backend", "first"));
    expectOk(store.ack(bob, "backend", 1));
    expectOk(store.send(alice, "backend", "second"));

    const membership = db
      .query<
        { cursor_id: number; notified_id: number },
        { participantId: number; channel: string }
      >(
        `SELECT cursor_id, notified_id
           FROM memberships mem
           JOIN channels c ON c.id = mem.channel_id
          WHERE mem.participant_id = $participantId
            AND c.name = $channel`,
      )
      .get({ participantId: alice, channel: "backend" });
    expect(membership).toEqual({ cursor_id: 2, notified_id: 2 });
  });

  test("does not skip a sender's real unread backlog", () => {
    const { db, store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);

    expectOk(store.send(alice, "backend", "from alice"));
    expectOk(store.send(bob, "backend", "from bob"));
    expectOk(store.send(alice, "backend", "after unread"));

    const membership = db
      .query<
        { cursor_id: number; notified_id: number },
        { participantId: number; channel: string }
      >(
        `SELECT cursor_id, notified_id
           FROM memberships mem
           JOIN channels c ON c.id = mem.channel_id
          WHERE mem.participant_id = $participantId
            AND c.name = $channel`,
      )
      .get({ participantId: alice, channel: "backend" });
    expect(membership).toEqual({ cursor_id: 1, notified_id: 1 });
    expect(expectOk(store.fetch(alice, "backend")).messages.map((message) => message.body)).toEqual([
      "from bob",
    ]);
  });

  test("advances the sender watermark for workspace broadcasts", () => {
    const { db, store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    const bob = expectOk(store.createAgent("bob")).participant.id;
    expectOk(store.ensureWorkspaceMembers("workspace", [alice, bob]));

    expectOk(store.broadcastWorkspace(alice, "workspace", [], "first"));
    expectOk(store.broadcastWorkspace(alice, "workspace", [], "second"));

    const membership = db
      .query<
        { cursor_id: number; notified_id: number },
        { participantId: number; channel: string }
      >(
        `SELECT cursor_id, notified_id
           FROM memberships mem
           JOIN channels c ON c.id = mem.channel_id
          WHERE mem.participant_id = $participantId
            AND c.name = $channel`,
      )
      .get({ participantId: alice, channel: "workspace" });
    expect(membership).toEqual({ cursor_id: 2, notified_id: 2 });
  });
});

describe("fetch and ack", () => {
  test("fetch moves no cursor, so a lost response is safe to retry", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(alice, "backend", "two"));

    const first = expectOk(store.fetch(bob, "backend"));
    const retry = expectOk(store.fetch(bob, "backend"));

    expect(first.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(retry.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(first.throughId).toBe(2);

    expectOk(store.ack(bob, "backend", first.throughId));
    expect(expectOk(store.fetch(bob, "backend")).messages).toEqual([]);
  });

  test("throughId covers exactly the messages returned", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "for bob"));
    expectOk(store.send(bob, "backend", "bob's own"));

    const fetched = expectOk(store.fetch(bob, "backend"));
    expect(fetched.messages.map((m) => m.id)).toEqual([1]);
    expect(fetched.throughId).toBe(1);
  });

  test("throughId holds at the cursor when nothing is unread", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.ack(bob, "backend", 1));

    expect(expectOk(store.fetch(bob, "backend")).throughId).toBe(1);
  });

  test("ack is monotonic and never rewinds", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(alice, "backend", "two"));

    expect(expectOk(store.ack(bob, "backend", 2))).toEqual({ cursorId: 2, advanced: true });
    expect(expectOk(store.ack(bob, "backend", 1))).toEqual({ cursorId: 2, advanced: false });
    expect(expectOk(store.ack(bob, "backend", 0))).toEqual({ cursorId: 2, advanced: false });
  });

  test("ack accepts only message ids from the target channel", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.createChannel("other", null));
    expectOk(store.join(alice, "other"));
    expectOk(store.join(bob, "other"));
    const otherMessage = expectOk(store.send(alice, "other", "other channel")).id;

    const crossChannel = expectErr(store.ack(bob, "backend", otherMessage));
    expect(ValidationFailed.is(crossChannel)).toBe(true);
    const unknown = expectErr(store.ack(bob, "backend", 99_999));
    expect(ValidationFailed.is(unknown)).toBe(true);
    expect(expectOk(store.receipts(alice, "backend"))).toEqual([
      { handle: "alice", cursorMessageId: 0, routeState: "active" },
      { handle: "bob", cursorMessageId: 0, routeState: "active" },
    ]);
  });

  test("requires membership to ack", () => {
    const { store } = freshStore();
    twoAgentChannel(store);
    const outsider = expectOk(store.createAgent("outsider")).participant.id;

    expect(NotAMember.is(expectErr(store.ack(outsider, "backend", 1)))).toBe(true);
  });

  test("receipts expose cursor changes and keep stale members", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    const first = expectOk(store.send(alice, "backend", "first")).id;

    expect(expectOk(store.receipts(alice, "backend"))).toEqual([
      { handle: "alice", cursorMessageId: first, routeState: "active" },
      { handle: "bob", cursorMessageId: 0, routeState: "active" },
    ]);

    expectOk(store.ack(bob, "backend", first));
    const second = expectOk(store.send(alice, "backend", "second")).id;
    store.markRouteStale(bob);

    const receipts = expectOk(store.receipts(alice, "backend"));
    expect(receipts).toEqual([
      { handle: "alice", cursorMessageId: second, routeState: "active" },
      { handle: "bob", cursorMessageId: first, routeState: "stale" },
    ]);
    const bobReceipt = receipts.find((receipt) => receipt.handle === "bob");
    expect(bobReceipt?.cursorMessageId).toBeLessThan(second);
  });
});

describe("pending notifications", () => {
  test("uses MAX(cursor_id, notified_id) as the threshold", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    store.bindRoute(bob, { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" });

    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(alice, "backend", "two"));

    const pending = store.pendingNotifications();
    expect(pending.length).toBe(1);
    expect(pending[0]?.count).toBe(2);
    expect(pending[0]?.throughId).toBe(2);
    expect(pending[0]?.senders).toEqual(["alice"]);

    store.markNotified(bob, pending[0]!.channelId, pending[0]!.throughId);
    expect(store.pendingNotifications()).toEqual([]);

    expectOk(store.send(alice, "backend", "three"));
    expect(store.pendingNotifications()[0]?.count).toBe(1);
  });

  test("a read advances past a pending ping even when notified_id lags", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    store.bindRoute(bob, { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" });

    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.ack(bob, "backend", 1));

    expect(store.pendingNotifications()).toEqual([]);
  });

  test("markNotified is monotonic", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    store.bindRoute(bob, { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" });
    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(alice, "backend", "two"));

    const channelId = store.pendingNotifications()[0]!.channelId;
    store.markNotified(bob, channelId, 2);
    store.markNotified(bob, channelId, 1);

    expect(store.pendingNotifications()).toEqual([]);
  });

  test("skips humans, unbound routes, and stale routes", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;
    const human = expectOk(store.createHuman("suleyman")).participant.id;
    const unbound = expectOk(store.createAgent("unbound")).participant.id;
    const stale = expectOk(store.createAgent("stale")).participant.id;
    expectOk(store.createChannel("backend", null));
    for (const id of [alice, human, unbound, stale]) expectOk(store.join(id, "backend"));

    store.bindRoute(stale, { terminalId: "term_2", paneId: "w1:p2", occupantAgent: "claude" });
    store.markRouteStale(stale);

    expectOk(store.send(alice, "backend", "anybody there"));
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("reports one row per receiver and channel", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    store.bindRoute(bob, { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" });
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));
    expectOk(store.join(bob, "general"));

    expectOk(store.send(alice, "backend", "b1"));
    expectOk(store.send(alice, "general", "g1"));

    expect(store.pendingNotifications().map((row) => row.channel)).toEqual(["backend", "general"]);
  });
});

describe("messages and attachments", () => {
  test("stores attachment metadata and derives preview eligibility", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);

    const sent = expectOk(
      store.send(alice, "backend", "see the chart", [
        {
          path: "/tmp/chart.png",
          displayName: "chart.png",
          byteSize: 2048,
          mediaType: "image/png",
          mtime: "2026-08-17T00:00:00.000Z",
          sha256: "abc123",
        },
        {
          path: "/tmp/report.pdf",
          displayName: "report.pdf",
          byteSize: 9000,
          mediaType: "application/pdf",
          mtime: "2026-08-17T00:00:00.000Z",
          sha256: null,
        },
      ]),
    );

    expect(sent.attachments.map((a) => [a.displayName, a.previewEligible, a.previewKind])).toEqual([
      ["chart.png", true, "image"],
      ["report.pdf", false, null],
    ]);

    const stored = store.attachmentById(sent.attachments[0]!.id);
    expect(stored?.path).toBe("/tmp/chart.png");
    expect(stored?.sha256).toBe("abc123");
  });

  test("rejects a send to a channel that does not exist", () => {
    const { store } = freshStore();
    const alice = expectOk(store.createAgent("alice")).participant.id;

    expect(ChannelNotFound.is(expectErr(store.send(alice, "nope", "hi")))).toBe(true);
  });

  test("history returns the newest messages in ascending order", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);
    for (const body of ["one", "two", "three", "four"]) {
      expectOk(store.send(alice, "backend", body));
    }

    expect(expectOk(store.history("backend", 2, null)).map((m) => m.body)).toEqual([
      "three",
      "four",
    ]);
    expect(expectOk(store.history("backend", 2, 3)).map((m) => m.body)).toEqual(["one", "two"]);
  });

  test("context returns a window either side of a message", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);
    for (const body of ["one", "two", "three", "four", "five"]) {
      expectOk(store.send(alice, "backend", body));
    }

    expect(expectOk(store.context("backend", 3, 1)).map((m) => m.body)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  test("replayAfter feeds Last-Event-ID reconnects", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);
    for (const body of ["one", "two", "three"]) expectOk(store.send(alice, "backend", body));

    expect(store.replayAfter(1, 10).map((m) => m.id)).toEqual([2, 3]);
    expect(store.replayAfter(3, 10)).toEqual([]);
  });
});

describe("inbox", () => {
  test("summarises unread counts, senders, and push readiness", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    const carol = expectOk(store.createAgent("carol")).participant.id;
    expectOk(store.join(carol, "backend"));
    store.bindRoute(bob, { terminalId: "term_1", paneId: "w1:p1", occupantAgent: "claude" });

    expectOk(store.send(alice, "backend", "one"));
    expectOk(store.send(carol, "backend", "two"));

    const entries = store.inbox(bob);
    expect(entries.length).toBe(1);
    expect(entries[0]?.channel).toBe("backend");
    expect(entries[0]?.unread).toBe(2);
    expect(entries[0]?.senders).toEqual(["alice", "carol"]);
    expect(entries[0]?.pushEnabled).toBe(true);
  });

  test("reports an unbound agent as poll-only", () => {
    const { store } = freshStore();
    const { alice, bob } = twoAgentChannel(store);
    expectOk(store.send(alice, "backend", "one"));

    expect(store.inbox(bob)[0]?.pushEnabled).toBe(false);
  });

  test("lists a joined channel with nothing unread", () => {
    const { store } = freshStore();
    const { bob } = twoAgentChannel(store);

    expect(store.inbox(bob)).toEqual([
      { channel: "backend", unread: 0, senders: [], routeState: "active", pushEnabled: false },
    ]);
  });
});

describe("search", () => {
  test("finds messages and scopes them to one channel", () => {
    const { store } = freshStore();
    const { alice } = twoAgentChannel(store);
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));

    expectOk(store.send(alice, "backend", "the deploy pipeline is green"));
    expectOk(store.send(alice, "general", "deploy notes are posted"));

    expect(store.search(`"deploy"`, null, null, 50).length).toBe(2);
    const scoped = store.search(`"deploy"`, "backend", null, 50);
    expect(scoped.length).toBe(1);
    expect(scoped[0]?.channel).toBe("backend");
    expect(scoped[0]?.sender).toBe("alice");
    expect(scoped[0]?.snippet).toContain("deploy");
  });

  test("reflects the current body after an edit and drops deleted messages", () => {
    const { db, store } = freshStore();
    const { alice } = twoAgentChannel(store);
    const sent = expectOk(store.send(alice, "backend", "original wording"));

    db.query<never, [number]>(`UPDATE messages SET body = 'replaced wording' WHERE id = ?`).run(
      sent.id,
    );
    expect(store.search(`"original"`, null, null, 50)).toEqual([]);
    expect(store.search(`"replaced"`, null, null, 50).length).toBe(1);

    db.query<never, [number]>(`DELETE FROM messages WHERE id = ?`).run(sent.id);
    expect(store.search(`"replaced"`, null, null, 50)).toEqual([]);
  });
});
