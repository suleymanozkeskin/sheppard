import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_START_TIMEOUT_MS, DEFAULT_ROLES, HOST } from "../src/config";
import {
  FakeHerdr,
  HERDR_AGENT_START_TIMEOUT_MS,
  herdrCallFailed,
  noAgentAtTarget,
} from "../src/herdr";
import { Notifier } from "../src/notifier";
import { workspaceChannelName } from "../src/topology";
import {
  BASE,
  TEST_HERDR_SOCKET_PATH,
  auth,
  controlAuth,
  operatorAuth,
  provision,
  testHub,
} from "./http-support";
import type { TestHub } from "./http-support";

const decoder = new TextDecoder();

function inPane(token: string, terminalId: string, paneId: string, occupant = "claude") {
  return {
    ...auth(token),
    "x-msgr-terminal-id": terminalId,
    "x-msgr-pane-id": paneId,
    "x-msgr-occupant": occupant,
    "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
  };
}

function inConnectedPane(terminalId: string, paneId: string, occupant = "codex") {
  return {
    ...controlAuth(),
    "x-msgr-terminal-id": terminalId,
    "x-msgr-pane-id": paneId,
    "x-msgr-occupant": occupant,
    "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
  };
}

async function bind(
  hub: TestHub,
  token: string,
  terminalId: string,
  paneId: string,
  occupant = "claude",
): Promise<void> {
  const response = await hub.get("/api/inbox", inPane(token, terminalId, paneId, occupant));
  expect(response.status).toBe(200);
}

function bindSpawnedAgent(hub: TestHub, herdr: FakeHerdr): void {
  herdr.afterAgentStart = (paneId, name, kind) => {
    const pane = herdr.panes.find((candidate) => candidate.paneId === paneId);
    const participant = hub.hub.store.findByHandle(name);
    if (pane === undefined || participant === null) return;
    hub.hub.store.bindRoute(participant.id, {
      terminalId: pane.terminalId,
      paneId,
      occupantAgent: kind,
    });
  };
}

function explicitSpawnOperationKey(hub: TestHub, idempotencyKey: string): string {
  const caller = hub.hub.store.findByHandle("operator");
  if (caller === null) throw new Error("operator fixture is missing");
  const material = JSON.stringify({ callerId: caller.id, idempotencyKey });
  return `spawn-${createHash("sha256").update(material).digest("hex")}`;
}

describe("herdr control plane", () => {
  test("publishes names-only harness and role metadata", async () => {
    const hub = testHub();

    const harnesses = await hub.get("/api/herdr/harnesses");
    expect(harnesses.status).toBe(200);
    expect(await harnesses.json()).toEqual({ harnesses: ["claude", "codex", "opencode", "pi"] });

    const roles = await hub.get("/api/herdr/roles");
    expect(roles.status).toBe(200);
    // SAFETY: GET /api/herdr/roles returns the frozen public role preset shape.
    const body = (await roles.json()) as { roles: Array<{ name: string; summary: string }> };
    expect(body.roles).toEqual([
      {
        name: "lead",
        agentKind: null,
        native: true,
        summary: "Coordinates this workspace's agents toward the operator's goal.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "planner",
        agentKind: null,
        native: true,
        summary: "Turns a workspace goal into an executable plan with criteria and dependencies.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "reporter",
        agentKind: null,
        native: true,
        summary: "Read-only operational observer. Runs continuously and posts synthesized progress updates.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "tester",
        agentKind: null,
        native: true,
        summary: "Verifies assigned behavior with reproducible checks and reports defects.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "ui-ux-designer",
        agentKind: null,
        native: true,
        summary: "Designs and reviews usable, accessible, and consistent user workflows.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "web-searcher",
        agentKind: null,
        native: true,
        summary: "Researches external sources and returns verified evidence with references.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "worker",
        agentKind: null,
        native: true,
        summary: "Implements assigned engineering work and verifies the result.",
        launcher: null,
        model: null,
        effort: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("briefing");
    expect(JSON.stringify(body)).not.toContain("Observe git");
  });

  test("manages authenticated launcher definitions without exposing revisions", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const operator = await operatorAuth(hub);

    expect((await hub.get("/api/herdr/launchers")).status).toBe(401);
    const seeded = await hub.get("/api/herdr/launchers", auth(token));
    expect(await seeded.json()).toEqual({
      launchers: [
        {
          name: "claude",
          agentKind: "claude",
          argv: ["claude"],
          envKeys: [],
          startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        },
        {
          name: "codex",
          agentKind: "codex",
          argv: ["codex"],
          envKeys: [],
          startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        },
        {
          name: "opencode",
          agentKind: "opencode",
          argv: ["opencode"],
          envKeys: [],
          startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        },
        {
          name: "pi",
          agentKind: "pi",
          argv: ["pi"],
          envKeys: [],
          startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        },
      ],
    });

    const created = await hub.post(
      "/api/herdr/launchers",
      {
        name: "claude-personal",
        agentKind: "claude",
        argv: ["claude", "--profile", "personal"],
        startTimeoutMs: 42_000,
      },
      operator,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      name: "claude-personal",
      agentKind: "claude",
      argv: ["claude", "--profile", "personal"],
      envKeys: [],
      startTimeoutMs: 42_000,
    });
    expect(
      (
        await hub.post(
          "/api/herdr/launchers",
          { name: "claude-personal", agentKind: "claude", argv: ["claude"] },
          operator,
        )
      ).status,
    ).toBe(409);

    const updated = await hub.put(
      "/api/herdr/launchers/claude-personal",
      { agentKind: "claude", argv: ["claude", "--profile", "work"], startTimeoutMs: 43_000 },
      operator,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      name: "claude-personal",
      agentKind: "claude",
      argv: ["claude", "--profile", "work"],
      envKeys: [],
      startTimeoutMs: 43_000,
    });
    expect(
      (
        await hub.put(
          "/api/herdr/launchers/claude-personal",
          { name: "renamed", agentKind: "claude", argv: ["claude"] },
          operator,
        )
      ).status,
    ).toBe(400);

    const deleted = await hub.delete("/api/herdr/launchers/claude-personal", operator);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ name: "claude-personal" });
    expect((await hub.delete("/api/herdr/launchers/claude-personal", operator)).status).toBe(404);
  });

  test("rejects invalid launcher definitions", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    for (const definition of [
      { name: "BAD", agentKind: "claude", argv: ["claude"] },
      { name: "empty", agentKind: "claude", argv: [] },
      { name: "empty-arg", agentKind: "claude", argv: [""] },
      { name: "control", agentKind: "claude", argv: ["claude\u0000"] },
      { name: "bad-kind", agentKind: "Claude", argv: ["claude"] },
      { name: "zero-timeout", agentKind: "claude", argv: ["claude"], startTimeoutMs: 0 },
      { name: "large-timeout", agentKind: "claude", argv: ["claude"], startTimeoutMs: 300_001 },
      { name: "text-timeout", agentKind: "claude", argv: ["claude"], startTimeoutMs: "slow" },
    ]) {
      const response = await hub.post("/api/herdr/launchers", definition, operator);
      expect(response.status).toBe(400);
    }
    const customExecutable = await hub.post(
      "/api/herdr/launchers",
      { name: "claude-wrapper", agentKind: "claude", argv: ["claude-wrapper"] },
      operator,
    );
    expect(customExecutable.status).toBe(201);
  });

  test("rejects an unknown launcher and request-supplied command fields", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "missing", handle: "worker" },
      auth(token),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ValidationFailed" });
    expect(herdr.paneSplits).toHaveLength(0);

    for (const forbidden of [
      { workspaceId: "w1", launcher: "claude", harness: "claude", handle: "worker" },
      { workspaceId: "w1", launcher: "claude", argv: ["claude"], handle: "worker" },
    ]) {
      const rejected = await hub.post("/api/herdr/agents", forbidden, auth(token));
      expect(rejected.status).toBe(400);
    }
  });

  test("spawns from a fixed hub argv and never returns the token", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const operator = await operatorAuth(hub);
    const launcher = await hub.post(
      "/api/herdr/launchers",
      {
        name: "codex-review",
        agentKind: "codex",
        argv: ["codex", "--profile", "review"],
        startTimeoutMs: 48_000,
      },
      operator,
    );
    expect(launcher.status).toBe(201);
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex-review", handle: "worker" },
      auth(operatorToken),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ paneId: "w1:spawned-2", handle: "worker" });
    expect(JSON.stringify(body)).not.toContain("MSGR_TOKEN");
    expect(herdr.agentStarts).toEqual([
      { paneId: "w1:spawned-2", name: "worker", kind: "codex", argv: ["codex", "--profile", "review"] },
    ]);
    expect(herdr.agentStartTimeouts).toEqual([48_000]);
    expect(herdr.paneSplits[0]?.options.env?.MSGR_TOKEN).toEqual(expect.any(String));
    expect(herdr.prompts).toHaveLength(0);

    const replay = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex-review", handle: "worker" },
      auth(operatorToken),
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ paneId: "w1:spawned-2", handle: "worker" });
    expect(herdr.paneSplits).toHaveLength(1);
    expect(herdr.agentStarts).toHaveLength(1);
    expect(herdr.prompts).toHaveLength(0);
  });

  test("passes the configured hub URL to a managed lifecycle pane", async () => {
    const port = 7_123;
    const base = `http://${HOST}:${port}`;
    const hub = testHub({ port, allowedOrigin: base });
    const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
      hub.handler(
        new Request(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    const provisioned = await post("/api/agents", { handle: "operator" });
    expect(provisioned.status).toBe(201);
    // SAFETY: a 201 from POST /api/agents carries the provisioned token.
    const identity = (await provisioned.json()) as { token: string };

    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent: null });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const response = await post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex", role: "reporter", handle: "worker" },
      auth(identity.token),
    );

    expect(response.status).toBe(201);
    const responseText = await response.text();
    expect(responseText).not.toContain("MSGR_TOKEN");
    expect(responseText).not.toContain(identity.token);
    expect(herdr.paneSplits[0]?.options.env).toMatchObject({
      MSGR_URL: base,
      MSGR_HANDLE: "worker",
    });
    expect(herdr.paneSplits[0]?.options.env?.MSGR_TOKEN).toEqual(expect.any(String));
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.text).not.toContain("MSGR_TOKEN");
    expect(herdr.prompts[0]?.text).not.toContain(identity.token);
  });

  test("retries only a shell-readiness refusal without creating another pane", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.agentStartFailures.push(
      herdrCallFailed("agent_pane_busy", "agent start", "reported", "w1:spawned-2"),
    );
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "shell-readiness-retry" },
    );

    expect(response.status).toBe(201);
    expect(herdr.paneSplits).toHaveLength(1);
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.panes).toHaveLength(2);
    expect(herdr.agentStartTimeouts[0]).toBeGreaterThan(3_000);
    expect(herdr.agentStartTimeouts[1]).toBeGreaterThan(3_000);
    expect(hub.hub.store.findByHandle("worker")?.routeState).toBe("active");
  });

  test("does not call Herdr with a start budget at its three-second boundary", async () => {
    const hub = testHub({
      harnesses: [{ name: "codex", argv: ["codex"], startTimeoutMs: 3_000 }],
    });
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent: null });
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex", handle: "worker" },
      auth(operatorToken),
    );

    expect(response.status).toBe(503);
    expect(herdr.agentStarts).toHaveLength(0);
    expect(herdr.agentStartTimeouts).toHaveLength(0);
    expect(herdr.paneSplits).toHaveLength(1);
    expect(herdr.paneCloses).toHaveLength(0);
  });

  test("binds the lifecycle identity before topology reports the pane", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent: null });
    herdr.afterAgentStart = async () => {
      const topology = hub.hub.topology;
      if (topology === undefined) throw new Error("lifecycle topology is missing");
      expect(await topology.refresh()).toBe(true);
      expect(herdr.prompts).toHaveLength(0);
    };
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "codex", handle: "worker" },
      auth(operatorToken),
    );

    expect(response.status).toBe(201);
    expect(hub.hub.store.listParticipants().map((participant) => participant.handle).sort()).toEqual([
      "operator",
      "worker",
    ]);
    expect(hub.hub.store.findByHandle("worker")).toMatchObject({
      terminalId: "term-spawned-2",
      paneId: "w1:spawned-2",
      occupantAgent: "codex",
      routeState: "active",
      lastSeenAt: null,
    });
    expect(herdr.prompts).toHaveLength(0);
  });

  test("keeps a custom executable separate from its logical harness kind", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const operator = await operatorAuth(hub);
    const launcher = await hub.post(
      "/api/herdr/launchers",
      {
        name: "claude-work-wrapper",
        agentKind: "claude",
        argv: ["/tmp/claude-wrapper", "--profile", "work"],
      },
      operator,
    );
    expect(launcher.status).toBe(201);

    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude-work-wrapper", handle: "worker" },
      auth(operatorToken),
    );
    expect(response.status).toBe(201);
    expect(herdr.agentStarts).toEqual([
      {
        paneId: "w1:spawned-2",
        name: "worker",
        kind: "claude",
        argv: ["/tmp/claude-wrapper", "--profile", "work"],
      },
    ]);
    expect(herdr.panes.find((pane) => pane.paneId === "w1:spawned-2")?.agent).toBe("claude");
  });

  test("uses the budget from each selected launcher", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const operator = await operatorAuth(hub);
    for (const launcher of [
      { name: "claude-fast", agentKind: "claude", timeout: 11_000 },
      { name: "codex-slow", agentKind: "codex", timeout: 22_000 },
    ]) {
      const created = await hub.post(
        "/api/herdr/launchers",
        {
          name: launcher.name,
          agentKind: launcher.agentKind,
          argv: [launcher.agentKind],
          startTimeoutMs: launcher.timeout,
        },
        operator,
      );
      expect(created.status).toBe(201);
    }

    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    for (const [launcher, handle] of [["claude-fast", "fast"], ["codex-slow", "slow"]] as const) {
      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher, handle },
        auth(operatorToken),
      );
      expect(response.status).toBe(201);
    }
    expect(herdr.agentStartTimeouts).toEqual([11_000, 22_000]);
  });

  test("allows one reporter per workspace and keeps its briefing hub-side", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent: null });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const first = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "reporter" },
      auth(operatorToken),
    );
    expect(first.status).toBe(201);
    expect(JSON.stringify(await first.clone().json())).not.toContain("Observe git");

    const workspaceChannels = await (await hub.get("/api/channels?kind=workspace")).json();
    expect(workspaceChannels).toMatchObject({
      channels: [{ name: "ws-60c5590f72eef292f9545afc28bf", kind: "workspace" }],
    });
    const members = await (
      await hub.get("/api/channels/ws-60c5590f72eef292f9545afc28bf/members")
    ).json();
    expect(members).toMatchObject({
      members: [{ handle: "operator" }, { handle: "reporter" }],
    });

    const second = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "another" },
      auth(operatorToken),
    );
    expect(second.status).toBe(400);
    expect(herdr.paneSplits).toHaveLength(1);
  });

  test("audits the reporter lifecycle from spawn through stop on one workspace", async () => {
    const auditDirectory = mkdtempSync(join(tmpdir(), "msgr-reporter-audit-"));
    try {
      const hub = testHub({ databasePath: join(auditDirectory, "msgr.db") });
      const operatorToken = await provision(hub, "operator");
      const herdr = new FakeHerdr();
      herdr.workspaces = [{ id: "w1H", label: "Personal-Projects" }];
      herdr.withPane({ paneId: "w1H:p1", terminalId: "term-1", workspaceId: "w1H", agent: null });
      bindSpawnedAgent(hub, herdr);
      hub.hub.herdr = herdr;

      const reporterRole = DEFAULT_ROLES.find((role) => role.name === "reporter");
      if (reporterRole === undefined) throw new Error("default reporter role is missing");

      const first = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1H",
          launcher: "codex",
          role: "reporter",
          handle: "reporter-personal-projects",
          goal: "watch workspace progress",
        },
        auth(operatorToken),
      );
      expect(first.status).toBe(201);
      // SAFETY: a 201 lifecycle spawn response carries the assigned pane id and handle.
      const assigned = (await first.json()) as { handle: string; paneId: string };
      expect(assigned).toEqual({ handle: "reporter-personal-projects", paneId: "w1H:spawned-2" });
      expect(herdr.agentStarts).toEqual([
        { paneId: assigned.paneId, name: assigned.handle, kind: "codex", argv: ["codex"] },
      ]);
      expect(hub.hub.store.lifecycleAgentForPane(assigned.paneId)).toMatchObject({
        role: "reporter",
        harness: "codex",
        active: true,
      });
      const reporterPrompts = herdr.prompts.filter((prompt) => prompt.paneId === assigned.paneId);
      expect(reporterPrompts).toHaveLength(1);
      expect(reporterPrompts[0]).toEqual({
        paneId: assigned.paneId,
        text: `${reporterRole.briefing}\n\nOPERATOR GOAL: watch workspace progress`,
      });

      const channel = workspaceChannelName("w1H");
      const channelBody = await (await hub.get("/api/channels?kind=workspace")).json();
      expect(channelBody).toMatchObject({ channels: [{ name: channel, kind: "workspace" }] });
      const members = await (await hub.get(`/api/channels/${channel}/members`)).json();
      expect(members).toMatchObject({
        members: [{ handle: "operator" }, { handle: "reporter-personal-projects" }],
      });

      const duplicate = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1H", launcher: "codex", role: "reporter", handle: "reporter-second" },
        auth(operatorToken),
      );
      expect(duplicate.status).toBe(400);
      expect(await duplicate.json()).toMatchObject({ code: "ValidationFailed", error: "role already has a reporter" });
      expect(herdr.paneSplits).toHaveLength(1);

      const stopped = await hub.handler(
        new Request(`${BASE}/api/herdr/agents/${encodeURIComponent(assigned.paneId)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json", ...auth(operatorToken) },
          body: JSON.stringify({ confirm: assigned.handle }),
        }),
      );
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ paneId: assigned.paneId });
      expect(herdr.paneCloses).toEqual([assigned.paneId]);
      expect(herdr.panes.some((pane) => pane.paneId === assigned.paneId)).toBe(false);
      expect(hub.hub.store.lifecycleAgentForPane(assigned.paneId)?.active).toBe(false);
      expect(hub.hub.store.findByHandle(assigned.handle)?.routeState).toBe("stale");
    } finally {
      rmSync(auditDirectory, { recursive: true, force: true });
    }
  });

  test("cleans the pane and unbound identity when launch fails", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.paneSplitResult = {
      paneId: "w1:spawned-2",
      terminalId: "term-spawned-2",
      agent: "claude",
      agentStatus: "unknown",
      focused: false,
      label: "worker",
      workspaceId: "w1",
    };
    herdr.agentStartFailure = herdrCallFailed("agent unavailable", "agent start", "reported");
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "known-launch-failure" },
    );
    expect(response.status).toBe(503);
    expect(herdr.paneCloses).toEqual(["w1:spawned-2"]);
    expect(hub.hub.store.findByHandle("worker")).toBeNull();
    expect(
      hub.hub.store.lifecycleSpawnOperation(
        explicitSpawnOperationKey(hub, "known-launch-failure"),
      ),
    ).toMatchObject({
      cleanupOutcome: "closed",
      cleanupError: null,
    });
  });

  test("reports a timed-out start without closing its pane", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.agentStartFailure = herdrCallFailed(
      "start exceeded the readiness budget",
      "agent start",
      "timeout",
    );
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "timed-out-launch" },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("w1:spawned-2");
    expect(herdr.paneCloses).toEqual([]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(herdr.agentStartTimeouts).toEqual([HERDR_AGENT_START_TIMEOUT_MS]);
    expect(
      hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "timed-out-launch")),
    ).toMatchObject({
      cleanupOutcome: "skipped",
      cleanupError: "timeout",
    });
  });

  test("reports unresolved cleanup when pane split times out before a pane id exists", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.paneSplitFailure = herdrCallFailed(
      "split exceeded the readiness budget",
      "pane split",
      "timeout",
    );
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "split-timeout-without-pane" },
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("pane identity is unknown");
    expect(body).toContain("cleanup state is unresolved");
    expect(body).not.toContain("partial spawn was closed");
    expect(herdr.paneCloses).toEqual([]);
    expect(
      hub.hub.store.lifecycleSpawnOperation(
        explicitSpawnOperationKey(hub, "split-timeout-without-pane"),
      ),
    ).toMatchObject({ cleanupOutcome: "skipped", cleanupError: "timeout" });
  });

  test("reports an unreachable start with its leftover pane", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.agentStartFailure = herdrCallFailed("herdr socket closed", "agent start", "unknown");
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "unreachable-launch" },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("w1:spawned-2");
    expect(herdr.paneCloses).toEqual([]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(
      hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "unreachable-launch")),
    ).toMatchObject({
      cleanupOutcome: "skipped",
      cleanupError: null,
    });
  });

  test("reports a timed-out role briefing without closing its pane", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.promptFailure = (paneId) =>
      herdrCallFailed("prompt exceeded the deadline", "agent prompt", "timeout", paneId);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "timed-out-briefing" },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("w1:spawned-2");
    expect(herdr.paneCloses).toEqual([]);
    expect(
      hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "timed-out-briefing")),
    ).toMatchObject({
      cleanupOutcome: "skipped",
      cleanupError: "timeout",
    });
  });

  test("rebinds an incomplete lifecycle operation without prompting the agent", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.afterAgentStart = () => {
      herdr.listFailure = herdrCallFailed("pane list unavailable", "pane list");
    };
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      auth(operatorToken),
    );
    expect(response.status).toBe(503);
    expect(herdr.paneCloses).toEqual([]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(hub.hub.store.findByHandle("worker")?.terminalId).toBeNull();
    expect(herdr.prompts).toHaveLength(0);

    herdr.listFailure = null;
    const retry = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      auth(operatorToken),
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({ paneId: "w1:spawned-2", handle: "worker" });
    expect(herdr.paneSplits).toHaveLength(1);
    expect(herdr.agentStarts).toHaveLength(1);
    expect(hub.hub.store.findByHandle("worker")).toMatchObject({
      terminalId: "term-spawned-2",
      paneId: "w1:spawned-2",
      occupantAgent: "claude",
      routeState: "active",
    });
    expect(herdr.prompts).toHaveLength(0);
  });

  test("does not rebind an incomplete lifecycle operation after an identity mismatch", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.afterAgentStart = () => {
      herdr.listFailure = herdrCallFailed("pane list unavailable", "pane list");
    };
    hub.hub.herdr = herdr;

    const first = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "recovery-identity-mismatch" },
    );
    expect(first.status).toBe(503);
    const pane = herdr.panes.find((candidate) => candidate.paneId === "w1:spawned-2");
    if (pane === undefined) throw new Error("spawned pane fixture is missing");
    pane.label = "replacement";
    herdr.listFailure = null;

    const retry = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "recovery-identity-mismatch" },
    );
    expect(retry.status).toBe(503);
    expect(hub.hub.store.findByHandle("worker")).toMatchObject({
      terminalId: null,
      paneId: null,
      routeState: "active",
    });
    expect(herdr.paneCloses).toHaveLength(0);
    expect(herdr.prompts).toHaveLength(0);
  });

  test("keeps the identity and pane when pane cleanup fails", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.paneSplitResult = {
      paneId: "w1:spawned-2",
      terminalId: "term-spawned-2",
      agent: "claude",
      agentStatus: "unknown",
      focused: false,
      label: "worker",
      workspaceId: "w1",
    };
    herdr.agentStartFailure = herdrCallFailed("agent unavailable", "agent start", "reported");
    herdr.paneCloseFailure = herdrCallFailed("pane close unavailable", "pane close");
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "cleanup-failure" },
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("cleanup state is unresolved");
    expect(body).not.toContain("partial spawn was closed");
    expect(herdr.paneCloses).toEqual(["w1:spawned-2"]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(hub.hub.store.findByHandle("worker")?.routeState).toBe("active");
    expect(
      hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "cleanup-failure")),
    ).toMatchObject({
      cleanupOutcome: "failed",
      cleanupError: expect.stringContaining("spawn cleanup pane close"),
    });
  });

  test("does not close a pane reused by another participant", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    herdr.beforePrompt = (paneId) => {
      const pane = herdr.panes.find((candidate) => candidate.paneId === paneId);
      if (pane !== undefined) pane.label = "replacement";
    };
    herdr.promptFailure = (paneId) =>
      herdrCallFailed("briefing failed", "agent prompt", "reported", paneId);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "reused-cleanup-pane" },
    );

    expect(response.status).toBe(503);
    expect(herdr.paneCloses).toEqual([]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(
      hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "reused-cleanup-pane")),
    ).toMatchObject({
      cleanupOutcome: "failed",
      cleanupError: expect.stringContaining("identity could not be proved"),
    });
  });

  test("does not close a pane after its terminal changes", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    herdr.beforePrompt = (paneId) => {
      const pane = herdr.panes.find((candidate) => candidate.paneId === paneId);
      if (pane !== undefined) pane.terminalId = "term-replaced";
    };
    herdr.promptFailure = (paneId) =>
      herdrCallFailed("briefing failed", "agent prompt", "reported", paneId);
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "worker" },
      { ...auth(operatorToken), "idempotency-key": "changed-terminal-cleanup-pane" },
    );

    expect(response.status).toBe(503);
    expect(herdr.paneCloses).toEqual([]);
    expect(herdr.panes.some((pane) => pane.paneId === "w1:spawned-2")).toBe(true);
    expect(
      hub.hub.store.lifecycleSpawnOperation(
        explicitSpawnOperationKey(hub, "changed-terminal-cleanup-pane"),
      ),
    ).toMatchObject({
      cleanupOutcome: "failed",
      cleanupError: expect.stringContaining("identity could not be proved"),
    });
  });

  test("keeps a lifecycle role active when a pane moves with its terminal", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const first = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "reporter" },
      auth(operatorToken),
    );
    expect(first.status).toBe(201);
    const spawned = herdr.panes.find((pane) => pane.label === "reporter");
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    spawned.paneId = "w1:moved";

    const duplicate = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "another" },
      auth(operatorToken),
    );
    expect(duplicate.status).toBe(400);
    expect(hub.hub.store.lifecycleAgents("w1")[0]?.active).toBe(true);
  });

  test("deactivates a lifecycle role when a pane keeps its id but changes terminal", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    bindSpawnedAgent(hub, herdr);
    hub.hub.herdr = herdr;

    const first = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "reporter" },
      auth(operatorToken),
    );
    expect(first.status).toBe(201);
    const spawned = herdr.panes.find((pane) => pane.label === "reporter");
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    const originalPaneId = spawned.paneId;
    spawned.terminalId = "term-replaced";

    const replacement = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "another" },
      auth(operatorToken),
    );
    expect(replacement.status).toBe(201);
    expect(hub.hub.store.lifecycleAgentForPane(originalPaneId)?.active).toBe(false);
  });

  test("does not expose raw herdr lifecycle failure detail", async () => {
    const hub = testHub();
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    herdr.paneSplitFailure = herdrCallFailed("child-secret", "pane split");
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/agents",
      { workspaceId: "w1", launcher: "claude", handle: "worker" },
      auth(operatorToken),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("child-secret");
  });

  test("requires the current pane identity for stop confirmation", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", label: "worker" });
    hub.hub.herdr = herdr;

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/agents/w1%3Ap1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "wrong" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ValidationFailed" });
    expect(herdr.paneCloses).toHaveLength(0);
  });

  test("rechecks a replaced pane before closing it", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", label: "old" });
    let lists = 0;
    herdr.afterList = () => {
      lists += 1;
      if (lists === 1 && herdr.panes[0] !== undefined) {
        herdr.panes[0] = { ...herdr.panes[0], terminalId: "term-2", label: "new" };
      }
    };
    hub.hub.herdr = herdr;

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/agents/w1%3Ap1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "old" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(herdr.paneCloses).toHaveLength(0);
  });

  test("rejects a stale participant route when the occupant kind changes", async () => {
    const hub = testHub();
    const agentToken = await provision(hub, "worker");
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      label: "worker",
      agent: "codex",
    });
    hub.hub.herdr = herdr;
    await bind(hub, agentToken, "term-1", "w1:p1", "claude");

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/agents/w1%3Ap1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(operatorToken) },
        body: JSON.stringify({ confirm: "worker" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(herdr.paneCloses).toHaveLength(0);
  });

  test("marks the matched route stale while preserving the participant", async () => {
    const hub = testHub();
    const agentToken = await provision(hub, "worker");
    const operatorToken = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", label: "worker" });
    hub.hub.herdr = herdr;
    await bind(hub, agentToken, "term-1", "w1:p1");

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/agents/w1%3Ap1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(operatorToken) },
        body: JSON.stringify({ confirm: "worker" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paneId: "w1:p1" });
    expect(herdr.paneCloses).toEqual(["w1:p1"]);
    expect(hub.hub.store.findByHandle("worker")?.routeState).toBe("stale");
  });

  test("reports when the hub has no herdr control plane", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");

    const response = await hub.post("/api/herdr/workspaces", {}, auth(token));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "HerdrNotConfigured" });
  });

  test("creates a workspace through the authenticated herdr operation", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/workspaces",
      { label: "Feature", cwd: "/tmp/project" },
      auth(token),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      workspace: { id: "w1", label: "Feature" },
    });
    expect(herdr.workspaceCreates).toEqual([{ label: "Feature", cwd: "/tmp/project" }]);
  });

  test("creates, renames, and focuses a tab through authenticated operations", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.tabs = [{ id: "w1:t1", workspaceId: "w1", label: "Main" }];
    hub.hub.herdr = herdr;

    const created = await hub.post(
      "/api/herdr/tabs",
      { workspaceId: "w1", label: "Feature" },
      auth(token),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      tab: { id: "w1:t2", workspaceId: "w1", label: "Feature" },
    });
    expect(herdr.tabCreates).toEqual([{ workspaceId: "w1", label: "Feature" }]);

    const renamed = await hub.put("/api/herdr/tabs/w1%3At1", { label: "Renamed" }, auth(token));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ tabId: "w1:t1", label: "Renamed" });
    expect(herdr.tabRenames).toEqual([{ id: "w1:t1", label: "Renamed" }]);

    const focused = await hub.post("/api/herdr/tabs/w1%3At1/focus", {}, auth(token));
    expect(focused.status).toBe(200);
    expect(await focused.json()).toEqual({ tabId: "w1:t1" });
    expect(herdr.tabFocuses).toEqual(["w1:t1"]);
  });

  test("groups panes into labeled tabs and keeps the flat pane view", async () => {
    const hub = testHub();
    const token = await provision(hub, "opus21");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.tabs = [
      { id: "w1:t1", workspaceId: "w1", label: "Main" },
      { id: "w1:t2", workspaceId: "w1", label: null },
    ];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      tabId: "w1:t1",
      label: "worker",
      agent: "claude",
      agentStatus: "working",
      focused: true,
    });
    herdr.withPane({
      paneId: "w1:p2",
      terminalId: "term-2",
      tabId: "w1:t2",
      agent: "codex",
      agentStatus: "idle",
      focused: false,
    });
    hub.hub.herdr = herdr;
    await bind(hub, token, "term-1", "w1:p1");

    const response = await hub.get("/api/herdr/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaces: [
        {
          id: "w1",
          label: "Backend",
          panes: [
            {
              paneId: "w1:p1",
              label: "worker",
              title: null,
              agentKind: "claude",
              agentStatus: "working",
              focused: true,
              participant: "opus21",
              participantRouteState: "active",
              role: null,
            },
            {
              paneId: "w1:p2",
              label: null,
              title: null,
              agentKind: "codex",
              agentStatus: "idle",
              focused: false,
              participant: null,
              participantRouteState: null,
              role: null,
            },
          ],
          tabs: [
            {
              id: "w1:t1",
              label: "Main",
              panes: [
                {
                  paneId: "w1:p1",
                  label: "worker",
                  title: null,
                  agentKind: "claude",
                  agentStatus: "working",
                  focused: true,
                  participant: "opus21",
                  participantRouteState: "active",
                  role: null,
                },
              ],
            },
            {
              id: "w1:t2",
              label: null,
              panes: [
                {
                  paneId: "w1:p2",
                  label: null,
                  title: null,
                  agentKind: "codex",
                  agentStatus: "idle",
                  focused: false,
                  participant: null,
                  participantRouteState: null,
                  role: null,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("requires the tab label for destructive close and closes its panes", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.tabs = [{ id: "w1:t1", workspaceId: "w1", label: "Main" }];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      tabId: "w1:t1",
    });
    hub.hub.herdr = herdr;

    const rejected = await hub.delete(
      "/api/herdr/tabs/w1%3At1",
      auth(token),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "ValidationFailed" });
    expect(herdr.tabCloses).toEqual([]);

    const closed = await hub.handler(
      new Request(`${BASE}/api/herdr/tabs/w1%3At1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "Main" }),
      }),
    );
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ tabId: "w1:t1" });
    expect(herdr.tabCloses).toEqual(["w1:t1"]);
    expect(herdr.panes).toEqual([]);
  });

  test("builds topology with participant matching by active terminal route", async () => {
    const hub = testHub();
    const token = await provision(hub, "opus21");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      label: "worker",
      agent: "claude",
      agentStatus: "working",
      focused: true,
    });
    hub.hub.herdr = herdr;
    await bind(hub, token, "term-1", "w1:p1");

    const response = await hub.get("/api/herdr/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaces: [
        {
          id: "w1",
          label: "Backend",
          panes: [
            {
              paneId: "w1:p1",
              label: "worker",
              title: null,
              agentKind: "claude",
              agentStatus: "working",
              focused: true,
              participant: "opus21",
              participantRouteState: "active",
              role: null,
            },
          ],
          tabs: [],
        },
      ],
    });
  });

  test("does not assign a stale participant identity to a live herdr pane", async () => {
    const hub = testHub();
    const token = await provision(hub, "opus21");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      agent: "codex",
      agentStatus: "working",
    });
    hub.hub.herdr = herdr;
    await bind(hub, token, "term-1", "w1:p1");

    const participant = hub.hub.store.findByToken(token);
    expect(participant).not.toBeNull();
    hub.hub.store.markRouteStale(participant!.id);

    const response = await hub.get("/api/herdr/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaces: [
        {
          panes: [{ agentStatus: "working", participant: null, participantRouteState: null }],
        },
      ],
    });
    expect(hub.hub.store.findByHandle("opus21")?.routeState).toBe("stale");
  });

  test("broadcast auto-joins routed participants before insert and notifies them", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-a", agent: "claude" });
    herdr.withPane({ paneId: "w1:p2", terminalId: "term-b", agent: "codex" });
    hub.hub.herdr = herdr;
    await bind(hub, alice, "term-a", "w1:p1");
    await bind(hub, bob, "term-b", "w1:p2", "codex");
    hub.hub.notifier = new Notifier({ store: hub.hub.store, herdr });

    const sent = await hub.post(
      "/api/herdr/workspaces/w1/broadcast",
      { body: "status update" },
      auth(alice),
    );
    expect(sent.status).toBe(201);
    expect(await sent.json()).toEqual({
      channel: "ws-60c5590f72eef292f9545afc28bf",
      messageId: 1,
      recipients: ["alice", "bob"],
    });

    expect(await (await hub.get("/api/channels")).json()).toEqual({ channels: [] });
    const workspaceChannels = await (await hub.get("/api/channels?kind=workspace")).json();
    expect(workspaceChannels).toMatchObject({
      channels: [{ name: "ws-60c5590f72eef292f9545afc28bf", kind: "workspace" }],
    });

    const unread = await hub.post(
      "/api/channels/ws-60c5590f72eef292f9545afc28bf/fetch",
      {},
      auth(bob),
    );
    expect(unread.status).toBe(200);
    expect(await unread.json()).toMatchObject({ messages: [{ body: "status update" }] });

    await Bun.sleep(10);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.paneId).toBe("w1:p2");
  });

  test("requires the workspace label or id for destructive close", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    hub.hub.herdr = herdr;

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/workspaces/w1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "wrong" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ValidationFailed" });
    expect(herdr.workspaceCloses).toEqual([]);
  });

  test("reports an unknown workspace id instead of closing it", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    hub.hub.herdr = herdr;

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/workspaces/missing`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "missing" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(herdr.workspaceCloses).toEqual([]);
  });

  test("reports a transient herdr failure separately", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaceListFailure = herdrCallFailed("socket unavailable");
    hub.hub.herdr = herdr;

    const response = await hub.post(
      "/api/herdr/workspaces/w1/broadcast",
      { body: "status update" },
      auth(token),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "HerdrCallFailed" });
  });

  test("closes a workspace after the required confirmation", async () => {
    const hub = testHub();
    const token = await provision(hub, "operator");
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    hub.hub.herdr = herdr;

    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/workspaces/w1`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ confirm: "Backend" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: "w1" });
    expect(herdr.workspaceCloses).toEqual(["w1"]);
  });

  test("sends the current topology on connect and only on changes", async () => {
    const hub = testHub();
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", focused: false });
    hub.hub.herdr = herdr;

    const aborter = new AbortController();
    const response = await hub.handler(
      new Request(`${BASE}/api/herdr/events`, { signal: aborter.signal }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstText = decoder.decode(first.value);
    expect(JSON.parse(firstText.split("data: ")[1]?.trim() ?? "{}")).toEqual({
      workspaces: [
        {
          id: "w1",
          label: "Backend",
          panes: [
            {
              paneId: "w1:p1",
              label: null,
              title: null,
              agentKind: "claude",
              agentStatus: "idle",
              focused: false,
              participant: null,
              participantRouteState: null,
              role: null,
            },
          ],
          tabs: [],
        },
      ],
    });

    herdr.panes[0]!.focused = true;
    await hub.hub.topology?.refresh();
    const changed = await reader.read();
    expect(decoder.decode(changed.value)).toContain('"focused":true');
    await reader.cancel();
    aborter.abort();
  });
});

describe("connecting an existing agent pane", () => {
  function hostingHerdr(agent: string | null = "codex"): FakeHerdr {
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      workspaceId: "w1",
      agent,
    });
    return herdr;
  }

  test("the operator creates a pane-scoped identity without a prompt or returned token", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;
    const operator = await operatorAuth(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1%3Ap1/connect",
      { handle: "lead-2" },
      operator,
    );
    expect(response.status).toBe(201);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ handle: "lead-2", paneId: "w1:p1" });
    expect(raw).not.toContain("token");
    expect(herdr.prompts).toHaveLength(0);
    expect(hub.hub.store.findByHandle("lead-2")).toMatchObject({
      kind: "agent",
      terminalId: "term-1",
      paneId: "w1:p1",
      occupantAgent: "codex",
      routeState: "active",
    });

    const identity = await hub.get("/api/herdr/agents/w1%3Ap1");
    expect(await identity.json()).toEqual({ handle: "lead-2" });
    expect((await hub.get("/api/inbox", inConnectedPane("term-1", "w1:p1"))).status).toBe(200);
  });

  test("only the operator can connect a pane that has an agent occupant", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;

    expect(
      (await hub.post("/api/herdr/agents/w1%3Ap1/connect", { handle: "lead-2" })).status,
    ).toBe(401);
    const agentToken = await provision(hub, "requester");
    expect(
      (
        await hub.post(
          "/api/herdr/agents/w1%3Ap1/connect",
          { handle: "lead-2" },
          auth(agentToken),
        )
      ).status,
    ).toBe(403);
    expect(hub.hub.store.findByHandle("lead-2")).toBeNull();
    expect(herdr.prompts).toHaveLength(0);

    const emptyHub = testHub();
    const emptyHerdr = hostingHerdr(null);
    emptyHub.hub.herdr = emptyHerdr;
    const operator = await operatorAuth(emptyHub);
    expect(
      (
        await emptyHub.post(
          "/api/herdr/agents/w1%3Ap1/connect",
          { handle: "empty-pane" },
          operator,
        )
      ).status,
    ).toBe(400);
    expect(emptyHub.hub.store.findByHandle("empty-pane")).toBeNull();
  });

  test("pane-scoped access requires the local control credential and exact Herdr route", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;
    const operator = await operatorAuth(hub);
    expect(
      (
        await hub.post(
          "/api/herdr/agents/w1%3Ap1/connect",
          { handle: "lead-2" },
          operator,
        )
      ).status,
    ).toBe(201);

    const valid = inConnectedPane("term-1", "w1:p1");
    const missingControl = {
      "x-msgr-terminal-id": "term-1",
      "x-msgr-pane-id": "w1:p1",
      "x-msgr-occupant": "codex",
      "x-msgr-herdr-socket-path": TEST_HERDR_SOCKET_PATH,
    };
    const refused: Array<readonly [Record<string, string>, number]> = [
      [missingControl, 401],
      [{ ...valid, "x-msgr-control-token": "wrong" }, 401],
      [{ ...valid, "x-msgr-terminal-id": "term-2" }, 401],
      [{ ...valid, "x-msgr-pane-id": "w1:p2" }, 401],
      [{ ...valid, "x-msgr-occupant": "claude" }, 401],
      [{ ...valid, "x-msgr-herdr-socket-path": "/tmp/another-herdr.sock" }, 403],
    ];
    for (const [headers, status] of refused) {
      expect((await hub.get("/api/inbox", headers)).status).toBe(status);
    }
  });

  test("a pane change during connection deactivates the new identity", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    herdr.afterList = () => {
      const pane = herdr.panes[0];
      if (herdr.listCalls === 1 && pane !== undefined) {
        herdr.panes[0] = { ...pane, agent: "claude" };
      }
    };
    hub.hub.herdr = herdr;
    const operator = await operatorAuth(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1%3Ap1/connect",
      { handle: "raced-agent" },
      operator,
    );
    expect(response.status).toBe(400);
    expect(hub.hub.store.findByHandle("raced-agent")).toMatchObject({
      deactivated: true,
      routeState: "stale",
      terminalId: null,
      paneId: null,
    });
    expect(herdr.prompts).toHaveLength(0);
  });
});

describe("prompting a pane", () => {
  const PROMPT_TEXT = "read the checklist before the gate";

  async function operatorCookie(hub: TestHub): Promise<{ cookie: string }> {
    const created = await hub.post("/api/humans", { handle: "human" });
    expect(created.status).toBe(201);
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie.length).toBeGreaterThan(0);
    return { cookie };
  }

  function hostingHerdr(): FakeHerdr {
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    return herdr;
  }

  test("the operator prompts the exact pane, once, with the exact text", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;
    const operator = await operatorCookie(hub);

    const response = await hub.post("/api/herdr/agents/w1:p1/prompt", { text: PROMPT_TEXT }, operator);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: true });
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]).toEqual({ paneId: "w1:p1", text: PROMPT_TEXT });
  });

  test("an agent token is refused with 403 and nothing is delivered", async () => {
    // The rule-13 boundary: an agent driving another agent's terminal over
    // HTTP would act as that agent without ever holding its token.
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;
    const agentToken = await provision(hub, "impersonator");

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/prompt",
      { text: PROMPT_TEXT },
      auth(agentToken),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "OperatorOnly",
      error: "Only the operator may prompt an agent's pane",
    });
    expect(herdr.prompts).toHaveLength(0);
  });

  test("an unauthenticated call is refused and nothing is delivered", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;

    const response = await hub.post("/api/herdr/agents/w1:p1/prompt", { text: PROMPT_TEXT });
    expect(response.status).toBe(401);
    expect(herdr.prompts).toHaveLength(0);
  });

  test("a pane hosting no agent is 404 and nothing is delivered", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    herdr.promptFailure = (paneId) => noAgentAtTarget(paneId);
    hub.hub.herdr = herdr;
    const operator = await operatorCookie(hub);

    const response = await hub.post("/api/herdr/agents/w1:p9/prompt", { text: PROMPT_TEXT }, operator);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NotFound" });
    expect(herdr.prompts).toHaveLength(0);
  });

  test("a failed delivery never echoes the prompt text", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    herdr.promptFailure = () => herdrCallFailed("socket closed mid-write", "agent prompt w1:p1");
    hub.hub.herdr = herdr;
    const operator = await operatorCookie(hub);

    const response = await hub.post("/api/herdr/agents/w1:p1/prompt", { text: PROMPT_TEXT }, operator);
    expect(response.status).toBe(503);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(PROMPT_TEXT);
    expect(herdr.prompts).toHaveLength(0);
  });

  test("empty text is refused before any delivery", async () => {
    const hub = testHub();
    const herdr = hostingHerdr();
    hub.hub.herdr = herdr;
    const operator = await operatorCookie(hub);

    const response = await hub.post("/api/herdr/agents/w1:p1/prompt", { text: "" }, operator);
    expect(response.status).toBe(400);
    expect(herdr.prompts).toHaveLength(0);
  });
});
