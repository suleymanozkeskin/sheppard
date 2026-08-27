import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAD_BRIEFING } from "../src/config";
import { SCHEMA_VERSION, openDatabase } from "../src/db";
import { FakeHerdr } from "../src/herdr";
import { DeviceModelCatalogue } from "../src/model-catalogue";
import { Store } from "../src/store";
import { controlAuth, operatorAuth, provision, testHub } from "./http-support";
import type { RequestHeaders, TestHub } from "./http-support";

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

function leadContentAnchors(): string[] {
  return [
    "MISSION: Coordinate this workspace's agents toward the operator's goal.",
    "COMMUNICATION: Use msgr for all coordination",
    "ASSIGNMENT: Name the assignee, the deliverable, and the authority text",
    "CRITERIA FIRST: Do not start a build before its acceptance criteria exist.",
    "VERIFICATION: Give every branch two independent checks",
    "NUMBERS: State every number with its conditions",
    "SHARED RESOURCES: Use one browser suite on the machine at a time.",
    "ESCALATION: A refusal that names a control is a TRADE",
    "STAFFING: Use the roles read and spawn endpoint",
  ];
}

function explicitSpawnOperationKey(hub: TestHub, idempotencyKey: string): string {
  const caller = hub.hub.store.findByHandle("operator");
  if (caller === null) throw new Error("operator fixture is missing");
  const material = JSON.stringify({ callerId: caller.id, idempotencyKey });
  return `spawn-${createHash("sha256").update(material).digest("hex")}`;
}

function spawnReadyHub() {
  const hub = testHub();
  const herdr = new FakeHerdr();
  herdr.workspaces = [{ id: "w1", label: "Backend" }];
  herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1" });
  bindSpawnedAgent(hub, herdr);
  hub.hub.herdr = herdr;
  return {
    hub,
    herdr,
    cleanup: () => undefined,
  };
}

async function seedCodexModel(hub: TestHub, headers: RequestHeaders): Promise<void> {
  void headers;
  hub.hub.modelCatalogue = new DeviceModelCatalogue({
    executableAvailable: () => true,
    codexRunner: async () => ({
      status: "ok",
      models: [
        {
          name: "lead-model",
          resolvedModel: null,
          label: "Lead model",
          description: null,
          default: true,
          efforts: [],
        },
      ],
    }),
  });
  await hub.hub.modelCatalogue.refresh([
    { name: "codex", harness: "codex", argv: ["codex"], env: {}, revision: 1 },
  ], "codex");
}

describe("native lead", () => {
  test("seeds a native lead with anchored briefing and nullable harness", async () => {
    const hub = testHub();
    const open = await hub.get("/api/herdr/roles");
    expect(open.status).toBe(200);
    // SAFETY: the open role endpoint returns the documented role-list envelope.
    const openBody = (await open.json()) as {
      roles: Array<{
        name: string;
        agentKind: string | null;
        native: boolean;
        summary: string;
        launcher: string | null;
        model: string | null;
        effort: string | null;
      }>;
    };
    const lead = openBody.roles.find((role) => role.name === "lead");
    expect(lead).toEqual({
      name: "lead",
      agentKind: null,
      native: true,
      summary: "Coordinates this workspace's agents toward the operator's goal.",
      launcher: null,
      model: null,
      effort: null,
    });
    expect(JSON.stringify(openBody)).not.toContain("MISSION:");

    const detail = await hub.get("/api/herdr/roles/lead", controlAuth());
    expect(detail.status).toBe(200);
    // SAFETY: the controlled role endpoint returns the documented role detail.
    const detailBody = (await detail.json()) as {
      agentKind: string | null;
      native: boolean;
      briefing: string;
    };
    expect(detailBody.agentKind).toBeNull();
    expect(detailBody.native).toBe(true);
    expect(detailBody.briefing).toBe(LEAD_BRIEFING);
    for (const anchor of leadContentAnchors()) expect(detailBody.briefing).toContain(anchor);
  });

  test("keeps native role definitions read-only", async () => {
    const hub = testHub();
    const operatorHeaders = await operatorAuth(hub, "operator");
    const response = await hub.put(
      "/api/herdr/roles/lead",
      {
        agentKind: "codex",
        summary: "Changed",
        briefing: "Changed",
        launcher: "codex",
        model: "lead-model",
        effort: null,
      },
      operatorHeaders,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "ValidationFailed",
      error: "role native roles are read-only; duplicate the role to customize it",
    });
    const detail = await hub.get("/api/herdr/roles/lead", operatorHeaders);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ agentKind: null, native: true, briefing: LEAD_BRIEFING });
  });

  test("migrates roles without changing nullable harnesses or seed tombstones", () => {
    const directory = mkdtempSync(join(tmpdir(), "msgr-lead-schema-"));
    const path = join(directory, "msgr.db");
    try {
      const current = openDatabase(path).unwrap("current database must open");
      current.query(
        `INSERT INTO roles
          (name, agent_kind, summary, briefing, launcher, model, effort, native, created_at, updated_at)
         VALUES ('legacy', 'claude', 'summary', 'briefing', NULL, NULL, NULL, 0, 'x', 'x')`,
      ).run();
      current.query(
        `INSERT INTO role_seeds (name, first_seen_at) VALUES ('lead', 'x')`,
      ).run();
      current.exec(`ALTER TABLE roles DROP COLUMN native`);
      current.exec(`ALTER TABLE launchers DROP COLUMN env_json`);
      current.exec(`ALTER TABLE lifecycle_agents DROP COLUMN launch_env_json`);
      current.exec(`ALTER TABLE lifecycle_spawn_operations DROP COLUMN launch_env_json`);
      current.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 2}`);
      current.close();

      const migrated = openDatabase(path).unwrap("migrated database must open");
      const legacy = migrated
        .query<{ agent_kind: string | null; native: number }, { name: string }>(
          `SELECT agent_kind, native FROM roles WHERE name = $name`,
        )
        .get({ name: "legacy" });
      expect(legacy).toEqual({ agent_kind: "claude", native: 0 });
      expect(
        migrated.query<{ name: string }, { name: string }>(
          `SELECT name FROM role_seeds WHERE name = $name`,
        ).get({ name: "lead" }),
      ).toEqual({ name: "lead" });

      const store = new Store(migrated);
      store.seedRoles([
        {
          name: "lead",
          agentKind: null,
          native: true,
          summary: "restored",
          briefing: LEAD_BRIEFING,
        },
      ]);
      expect(store.role("lead")).toBeNull();
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the selected launcher and model, then sends the briefing and goal", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub, "operator");
      await seedCodexModel(hub, operatorHeaders);

      const response = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "codex",
          role: "lead",
          model: "lead-model",
          goal: "Coordinate the release.",
          handle: "lead",
        },
        operatorHeaders,
      );
      expect(response.status).toBe(201);
      expect(herdr.agentStarts).toEqual([
        { paneId: "w1:spawned-2", name: "lead", kind: "codex", argv: ["codex", "-m", "lead-model"] },
      ]);
      expect(herdr.prompts.filter((prompt) => prompt.paneId === "w1:spawned-2")).toEqual([
        {
          paneId: "w1:spawned-2",
          text: `${LEAD_BRIEFING}\n\nOPERATOR GOAL: Coordinate the release.`,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("uses the harness default when model is omitted and refuses a second active lead", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub, "operator");
      await seedCodexModel(hub, operatorHeaders);

      const first = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", handle: "lead" },
        operatorHeaders,
      );
      expect(first.status).toBe(201);
      expect(herdr.agentStarts[0]?.argv).toEqual(["codex"]);
      const second = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "codex",
          role: "lead",
          model: "lead-model",
          handle: "lead-second",
        },
        { ...operatorHeaders, "idempotency-key": "duplicate-lead" },
      );
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({
        code: "ValidationFailed",
        error: "role already has a lead",
      });
      expect(
        hub.hub.store.lifecycleSpawnOperation(explicitSpawnOperationKey(hub, "duplicate-lead")),
      ).toBeNull();
      expect(herdr.paneSplits).toHaveLength(1);
      expect(herdr.prompts.filter((prompt) => prompt.paneId === "w1:spawned-3")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("exposes lifecycle lead attribution in topology and agent detail", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub, "operator");
      await seedCodexModel(hub, operatorHeaders);
      const spawned = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", model: "lead-model", handle: "lead" },
        operatorHeaders,
      );
      expect(spawned.status).toBe(201);
      expect(hub.hub.store.lifecycleAgentForTerminal("term-spawned-2")?.role).toBe("lead");
      expect(hub.hub.store.agentRouteForTerminal("term-spawned-2")?.handle).toBe("lead");

      // SAFETY: the topology endpoint returns the documented workspace and pane view.
      const topology = (await (await hub.get("/api/herdr/workspaces")).json()) as {
        workspaces: Array<{ panes: Array<{ paneId: string; role: string | null }> }>;
      };
      expect(topology.workspaces[0]?.panes.find((pane) => pane.paneId === "w1:spawned-2")?.role).toBe(
        "lead",
      );

      // SAFETY: the agent detail endpoint returns the documented participant and pane view.
      const detail = (await (await hub.get("/api/agents/lead")).json()) as {
        participant: { role: string | null };
        pane: { role: string | null } | null;
      };
      expect(detail.participant.role).toBe("lead");
      expect(detail.pane?.role).toBe("lead");
      expect(herdr.agentStarts[0]?.argv[0]).toBe("codex");
    } finally {
      cleanup();
    }
  });

  test("does not attribute a role when the live pane harness differs", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub, "operator");
      await seedCodexModel(hub, operatorHeaders);
      const spawned = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", model: "lead-model", handle: "lead" },
        operatorHeaders,
      );
      expect(spawned.status).toBe(201);
      const pane = herdr.panes.find((candidate) => candidate.paneId === "w1:spawned-2");
      if (pane === undefined) throw new Error("spawned pane is missing");
      pane.agent = "claude";

      // SAFETY: the topology endpoint returns the documented workspace and pane view.
      const topology = (await (await hub.get("/api/herdr/workspaces")).json()) as {
        workspaces: Array<{ panes: Array<{ paneId: string; role: string | null }> }>;
      };
      expect(topology.workspaces[0]?.panes.find((candidate) => candidate.paneId === "w1:spawned-2")?.role).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("does not attribute a role when the active route participant differs", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub, "operator");
      await seedCodexModel(hub, operatorHeaders);
      const spawned = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", model: "lead-model", handle: "lead" },
        operatorHeaders,
      );
      expect(spawned.status).toBe(201);
      const otherToken = await provision(hub, "other");
      const other = hub.hub.store.findByHandle("other");
      if (other === null) throw new Error("other fixture is missing");
      hub.hub.store.bindRoute(other.id, {
        terminalId: "term-spawned-2",
        paneId: "w1:spawned-2",
        occupantAgent: "codex",
      });
      expect(otherToken).toMatch(/.+/u);

      // SAFETY: the topology endpoint returns the documented workspace and pane view.
      const topology = (await (await hub.get("/api/herdr/workspaces")).json()) as {
        workspaces: Array<{ panes: Array<{ paneId: string; role: string | null }> }>;
      };
      expect(topology.workspaces[0]?.panes.find((candidate) => candidate.paneId === "w1:spawned-2")?.role).toBeNull();

      // SAFETY: the agent detail endpoint returns the documented participant and pane view.
      const detail = (await (await hub.get("/api/agents/lead")).json()) as {
        participant: { role: string | null };
        pane: { role: string | null } | null;
      };
      expect(detail.participant.role).toBeNull();
      expect(detail.pane).toBeNull();
      expect(herdr.agentStarts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("does not attribute a topology role after a pane moves workspace", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub);
      await seedCodexModel(hub, operatorHeaders);
      const spawned = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", model: "lead-model", handle: "lead" },
        operatorHeaders,
      );
      expect(spawned.status).toBe(201);
      const pane = herdr.panes.find((candidate) => candidate.paneId === "w1:spawned-2");
      if (pane === undefined) throw new Error("spawned pane is missing");
      herdr.workspaces = [
        { id: "w1", label: "Backend" },
        { id: "w2", label: "Moved" },
      ];
      pane.workspaceId = "w2";
      pane.paneId = "w2:moved";

      // SAFETY: the topology endpoint returns the documented workspace and pane view.
      const topology = (await (await hub.get("/api/herdr/workspaces", operatorHeaders)).json()) as {
        workspaces: Array<{ id: string; panes: Array<{ paneId: string; role: string | null }> }>;
      };
      expect(topology.workspaces.find((workspace) => workspace.id === "w2")?.panes).toEqual([
        expect.objectContaining({ paneId: "w2:moved", role: null }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("does not attribute an agent-detail role after a pane moves workspace", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const operatorHeaders = await operatorAuth(hub);
      await seedCodexModel(hub, operatorHeaders);
      const spawned = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", role: "lead", model: "lead-model", handle: "lead" },
        operatorHeaders,
      );
      expect(spawned.status).toBe(201);
      const pane = herdr.panes.find((candidate) => candidate.paneId === "w1:spawned-2");
      const participant = hub.hub.store.findByHandle("lead");
      if (pane === undefined || participant === null) throw new Error("spawned agent is missing");
      herdr.workspaces = [
        { id: "w1", label: "Backend" },
        { id: "w2", label: "Moved" },
      ];
      pane.workspaceId = "w2";
      pane.paneId = "w2:moved";
      hub.hub.store.healRoutePane(participant.id, pane.paneId);

      // SAFETY: the agent detail endpoint returns the documented participant and pane view.
      const detail = (await (await hub.get("/api/agents/lead", operatorHeaders)).json()) as {
        participant: { role: string | null };
        pane: { paneId: string; role: string | null } | null;
      };
      expect(detail.participant.role).toBeNull();
      expect(detail.pane).toMatchObject({ paneId: "w2:moved", role: null });
    } finally {
      cleanup();
    }
  });
});
