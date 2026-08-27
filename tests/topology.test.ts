import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, herdrCallFailed } from "../src/herdr";
import { openDatabase } from "../src/db";
import { Store } from "../src/store";
import { HerdrTopology } from "../src/topology";

function fixture() {
  const db = openDatabase(":memory:").unwrap();
  const herdr = new FakeHerdr();
  herdr.workspaces = [{ id: "w1", label: "Backend" }];
  const store = new Store(db);
  return { db, herdr, store };
}

describe("read-only topology discovery", () => {
  test("keeps an occupied external pane visible without provisioning access", async () => {
    const { db, herdr, store } = fixture();
    const scratch = mkdtempSync(join(tmpdir(), "msgr-topology-readonly-"));
    const previousTokenDirectory = process.env.MSGR_TOKEN_DIR;
    process.env.MSGR_TOKEN_DIR = scratch;
    try {
      herdr.withPane({
        paneId: "w1:p1",
        terminalId: "term-external",
        workspaceId: "w1",
        label: "external-agent",
        agent: "claude",
        agentStatus: "idle",
      });
      const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

      expect(await topology.refresh()).toBe(true);

      const pane = topology.snapshot().workspaces[0]?.panes[0];
      expect(pane).toMatchObject({
        paneId: "w1:p1",
        agentKind: "claude",
        participant: null,
        participantRouteState: null,
      });
      expect(store.listParticipants()).toEqual([]);
      expect(store.listChannels("workspace")).toEqual([]);
      const memberships = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memberships")
        .get();
      expect(memberships?.count).toBe(0);
      const enrollments = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM auto_enrollments")
        .get();
      expect(enrollments?.count).toBe(0);
      expect(herdr.prompts).toHaveLength(0);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (previousTokenDirectory === undefined) {
        delete process.env.MSGR_TOKEN_DIR;
      } else {
        process.env.MSGR_TOKEN_DIR = previousTokenDirectory;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("refreshes from a Herdr lifecycle event without waiting for a tick", async () => {
    const { herdr, store } = fixture();
    const snapshots: string[] = [];
    const topology = new HerdrTopology({
      herdr,
      store,
      onChange: (snapshot) => snapshots.push(JSON.stringify(snapshot)),
    });

    topology.start();
    await Bun.sleep(10);
    expect(herdr.subscribeCalls).toBe(1);
    expect(topology.isWatching()).toBe(true);

    herdr.emitEvent("workspace.created");
    await Bun.sleep(10);

    expect(topology.snapshot().workspaces.map((workspace) => workspace.id)).toEqual(["w1"]);
    expect(snapshots.length).toBeGreaterThan(0);
    topology.stop();
    expect(topology.isWatching()).toBe(false);
  });
});

function staleRouted(store: Store, handle: string): number {
  const created = store.createAgent(handle).unwrap();
  store.bindRoute(created.participant.id, {
    terminalId: `term-${handle}`,
    paneId: "w1:p1",
    occupantAgent: "claude",
  });
  store.markRouteStale(created.participant.id);
  return created.participant.id;
}

describe("stale route reconciliation", () => {
  test("reactivates a stale route whose pane is live, without the participant acting", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "scout");
    herdr.withPane({
      paneId: "w1:p7",
      terminalId: "term-scout",
      workspaceId: "w1",
      agent: "claude",
      agentStatus: "working",
    });
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    expect(store.findByHandle("scout")?.routeState).toBe("stale");
    expect(store.findByHandle("scout")?.paneId).toBe("w1:p1");
    await topology.refresh();

    expect(store.findByHandle("scout")?.routeState).toBe("active");
    expect(store.findByHandle("scout")?.paneId).toBe("w1:p7");
    expect(store.staleRoutedParticipants()).toHaveLength(0);
  });

  test("leaves a stale route stale when no pane carries its terminal", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "ranger");
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-someone-else",
      workspaceId: "w1",
      agent: "claude",
      agentStatus: "working",
    });
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    await topology.refresh();

    expect(store.findByHandle("ranger")?.routeState).toBe("stale");
    expect(store.staleRoutedParticipants()).toHaveLength(1);
  });

  test("leaves a stale route stale when its pane carries a different occupant", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "surveyor");
    herdr.withPane({
      paneId: "w1:p3",
      terminalId: "term-surveyor",
      workspaceId: "w1",
      agent: "codex",
      agentStatus: "working",
    });
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    await topology.refresh();

    expect(store.findByHandle("surveyor")?.routeState).toBe("stale");
    expect(store.staleRoutedParticipants()).toHaveLength(1);
  });

  test("refuses to take a terminal another active route already holds", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "first");
    const holder = store.createAgent("second").unwrap();
    store.bindRoute(holder.participant.id, {
      terminalId: "term-first",
      paneId: "w1:p9",
      occupantAgent: "claude",
    });
    herdr.withPane({
      paneId: "w1:p9",
      terminalId: "term-first",
      workspaceId: "w1",
      agent: "claude",
      agentStatus: "working",
    });
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    await topology.refresh();

    expect(store.findByHandle("first")?.routeState).toBe("stale");
    expect(store.findByHandle("second")?.routeState).toBe("active");
    expect(store.staleRoutedParticipants()).toHaveLength(1);
  });

  test("reactivating never stamps last seen, which is proof that no prompt was read", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "quiet");
    herdr.withPane({
      paneId: "w1:p4",
      terminalId: "term-quiet",
      workspaceId: "w1",
      agent: "claude",
      agentStatus: "working",
    });
    const before = store.findByHandle("quiet")?.lastSeenAt ?? null;
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    await topology.refresh();

    expect(store.findByHandle("quiet")?.routeState).toBe("active");
    expect(store.findByHandle("quiet")?.lastSeenAt ?? null).toBe(before);
    expect(herdr.prompts).toHaveLength(0);
  });

  test("reconciles nothing when the pane list fails, so an outage clears no marks", async () => {
    const { herdr, store } = fixture();
    staleRouted(store, "offline");
    herdr.withPane({
      paneId: "w1:p5",
      terminalId: "term-offline",
      workspaceId: "w1",
      agent: "claude",
      agentStatus: "working",
    });
    herdr.listFailure = herdrCallFailed("herdr is unreachable", "pane list");
    const topology = new HerdrTopology({ herdr, store, onChange: () => undefined });

    await topology.refresh();

    expect(store.findByHandle("offline")?.routeState).toBe("stale");
    expect(store.staleRoutedParticipants()).toHaveLength(1);
  });
});
