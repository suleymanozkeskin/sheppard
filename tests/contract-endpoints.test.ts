/**
 * Acceptance tests for durable roles, models, spawn presets, agent memberships,
 * direct recency, attachment listings, and search filters.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "../src/herdr";
import { DeviceModelCatalogue } from "../src/model-catalogue";
import { auth, controlAuth, operatorAuth, provision, testHub } from "./http-support";
import type { RequestHeaders, TestHub } from "./http-support";

async function body<T>(response: Response): Promise<T> {
  // SAFETY: each caller names the type the endpoint is contracted to return.
  return (await response.json()) as T;
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

function spawnReadyHub() {
  const hub = testHub();
  const herdr = new FakeHerdr();
  herdr.workspaces = [{ id: "w1", label: "Backend" }];
  herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
  bindSpawnedAgent(hub, herdr);
  hub.hub.herdr = herdr;
  return {
    hub,
    herdr,
    cleanup: () => undefined,
  };
}

function multiWorkspaceSpawnReadyHub() {
  const hub = testHub();
  const herdr = new FakeHerdr();
  herdr.workspaces = [
    { id: "w1", label: "Claude workspace" },
    { id: "w2", label: "Codex workspace" },
  ];
  herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1" });
  herdr.withPane({ paneId: "w2:p1", terminalId: "term-2", workspaceId: "w2" });
  bindSpawnedAgent(hub, herdr);
  hub.hub.herdr = herdr;
  return {
    hub,
    herdr,
    cleanup: () => undefined,
  };
}

/** Prompts delivered to the spawned pane. */
function spawnedPanePrompts(herdr: FakeHerdr): Array<{ paneId: string; text: string }> {
  return herdr.prompts.filter((prompt) => prompt.paneId === "w1:spawned-2");
}

describe("role registry", () => {
  test("manages local role definitions and keeps briefings out of the open list", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);

    expect((await hub.post("/api/herdr/roles", {}, {})).status).toBe(401);
    expect((await hub.get("/api/herdr/roles/reporter")).status).toBe(401);

    const created = await hub.post(
      "/api/herdr/roles",
      {
        name: "reviewer",
        agentKind: "claude",
        summary: "Reads diffs and posts verdicts.",
        briefing: "Review every branch tip adversarially.",
        launcher: "claude",
        model: "opus",
        effort: "high",
      },
      controlAuth(),
    );
    expect(created.status).toBe(201);
    // The create response is the PRESET shape: no briefing even for the author.
    expect(await created.json()).toEqual({
      name: "reviewer",
      agentKind: "claude",
      native: false,
      summary: "Reads diffs and posts verdicts.",
      launcher: "claude",
      model: "opus",
      effort: "high",
    });

    // Role is a complete preset: the open list carries launcher, model, and
    // effort so the spawn dialog can prefill all three — and never the briefing.
    const open = await hub.get("/api/herdr/roles");
    const openBody = await body<{ roles: Array<{ name: string }> }>(open);
    expect(openBody.roles.map((role) => role.name)).toEqual([
      "lead",
      "planner",
      "reporter",
      "reviewer",
      "tester",
      "ui-ux-designer",
      "web-searcher",
      "worker",
    ]);
    expect(JSON.stringify(openBody)).not.toContain("briefing");
    expect(JSON.stringify(openBody)).not.toContain("adversarially");

    // The local detail endpoint carries the briefing. The open list does not.
    const detail = await hub.get("/api/herdr/roles/reviewer", controlAuth());
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      name: "reviewer",
      briefing: "Review every branch tip adversarially.",
    });

    expect(
      (
        await hub.post(
          "/api/herdr/roles",
          { name: "reviewer", agentKind: "claude", summary: "s", briefing: "b" },
          operator,
        )
      ).status,
    ).toBe(409);

    const updated = await hub.put(
      "/api/herdr/roles/reviewer",
      {
        agentKind: "claude",
        summary: "Reads diffs and posts verdicts.",
        briefing: "Review, then verify by running.",
        launcher: null,
        model: null,
        effort: null,
      },
      operator,
    );
    expect(updated.status).toBe(200);
    expect(
      await body<{ briefing: string }>(await hub.get("/api/herdr/roles/reviewer", operator)),
    ).toMatchObject({ briefing: "Review, then verify by running." });

    expect(
      (
        await hub.put(
          "/api/herdr/roles/reviewer",
          { name: "renamed", agentKind: "claude", summary: "s", briefing: "b" },
          operator,
        )
      ).status,
    ).toBe(400);

    const deleted = await hub.delete("/api/herdr/roles/reviewer", operator);
    expect(deleted.status).toBe(200);
    expect((await hub.delete("/api/herdr/roles/reviewer", operator)).status).toBe(404);
  });

  test("creates and updates harness-neutral custom roles", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const created = await hub.post(
      "/api/herdr/roles",
      {
        name: "neutral-role",
        agentKind: null,
        summary: "Runs with the selected launcher.",
        briefing: "Use the selected launcher and report the result.",
        launcher: null,
        model: null,
        effort: null,
      },
      operator,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "neutral-role",
      agentKind: null,
      native: false,
    });

    const open = await body<{
      roles: Array<{ name: string; agentKind: string | null }>;
    }>(await hub.get("/api/herdr/roles"));
    expect(open.roles.find((role) => role.name === "neutral-role")).toMatchObject({
      agentKind: null,
    });
    const detail = await body<{ agentKind: string | null }>(
      await hub.get("/api/herdr/roles/neutral-role", operator),
    );
    expect(detail.agentKind).toBeNull();

    const updated = await hub.put(
      "/api/herdr/roles/neutral-role",
      {
        agentKind: null,
        summary: "Runs with the selected launcher after an update.",
        briefing: "Use the selected launcher after the update.",
        launcher: null,
        model: null,
        effort: null,
      },
      operator,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      name: "neutral-role",
      agentKind: null,
    });
    const openAfterUpdate = await body<{
      roles: Array<{ name: string; agentKind: string | null }>;
    }>(await hub.get("/api/herdr/roles"));
    expect(openAfterUpdate.roles.find((role) => role.name === "neutral-role")).toMatchObject({
      agentKind: null,
    });
    const detailAfterUpdate = await body<{ agentKind: string | null }>(
      await hub.get("/api/herdr/roles/neutral-role", operator),
    );
    expect(detailAfterUpdate.agentKind).toBeNull();

    const emptyAgentKind = await hub.post(
      "/api/herdr/roles",
      {
        name: "empty-agent-kind",
        agentKind: "",
        summary: "Invalid harness.",
        briefing: "Invalid harness.",
      },
      operator,
    );
    expect(emptyAgentKind.status).toBe(400);
    expect(await emptyAgentKind.json()).toMatchObject({
      code: "ValidationFailed",
      error: expect.stringContaining("agentKind"),
    });
  });

  test("a deleted role refuses spawns that name it", async () => {
    // Before v11 the reporter was configuration; now it is a deletable row,
    // so "the operator deleted the reporter role" is a reachable state.
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      expect((await hub.delete("/api/herdr/roles/reporter", operator)).status).toBe(200);

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", role: "reporter", handle: "reporter" },
        auth(token),
      );
      expect(response.status).toBe(400);
      expect(await body<{ error: string }>(response)).toMatchObject({
        error: expect.stringContaining("is not an available role"),
      });
      expect(herdr.paneSplits).toHaveLength(0);
      expect(herdr.prompts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a deleted seed role stays deleted when seeding runs again", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);

    expect((await hub.delete("/api/herdr/roles/reporter", operator)).status).toBe(200);
    hub.hub.store.seedRoles([
      {
        name: "reporter",
        agentKind: "claude",
        summary: "seed",
        briefing: "seed",
      },
    ]);
    const open = await body<{ roles: unknown[] }>(await hub.get("/api/herdr/roles"));
    expect(open.roles).toEqual([
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
  });
});

describe("model catalogue", () => {
  test("keeps argv suffixes hub-side and refuses duplicates", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);

    expect((await hub.post("/api/herdr/models", {}, {})).status).toBe(401);

    const created = await hub.post(
      "/api/herdr/models",
      { harness: "claude", name: "opus", kind: "model", argvSuffix: ["--model", "opus"] },
      operator,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ harness: "claude", name: "opus", kind: "model" });

    expect(
      (
        await hub.post(
          "/api/herdr/models",
          { harness: "claude", name: "opus", kind: "model", argvSuffix: ["--model", "opus"] },
          operator,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await hub.post(
          "/api/herdr/models",
          { harness: "claude", name: "fast", kind: "speed", argvSuffix: [] },
          operator,
        )
      ).status,
    ).toBe(400);

    // The catalogue is names only: no argv fragment ever leaves the hub on the
    // open read.
    const open = await hub.get("/api/herdr/models");
    expect(open.status).toBe(200);
    const openBody = await open.json();
    expect(openBody).toEqual({ models: [{ harness: "claude", name: "opus", kind: "model" }] });
    expect(JSON.stringify(openBody)).not.toContain("--model");
    expect(JSON.stringify(openBody)).not.toContain("argvSuffix");

    const deleted = await hub.delete("/api/herdr/models/claude/opus", operator);
    expect(deleted.status).toBe(200);
    expect((await hub.delete("/api/herdr/models/claude/opus", operator)).status).toBe(404);
  });
});

describe("spawn presets", () => {
  async function seedCatalogue(hub: TestHub, operator: RequestHeaders): Promise<void> {
    void operator;
    hub.hub.modelCatalogue = new DeviceModelCatalogue({
      executableAvailable: () => true,
      claudeRunner: async () => ({
        status: "ok",
        models: [
          {
            name: "default",
            resolvedModel: null,
            label: "Default",
            description: null,
            default: true,
            efforts: [{ name: "high", description: null, default: true }],
          },
          {
            name: "opus",
            resolvedModel: null,
            label: "Opus",
            description: null,
            default: false,
            efforts: [{ name: "high", description: null, default: true }],
          },
        ],
      }),
    });
    await hub.hub.modelCatalogue.refresh([
      { name: "claude", harness: "claude", argv: ["claude"], env: {}, revision: 1 },
    ], "claude");
  }

  test("lets a harness-neutral custom role choose validated launchers per workspace", async () => {
    const { hub, herdr, cleanup } = multiWorkspaceSpawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      const role = await hub.post(
        "/api/herdr/roles",
        {
          name: "neutral-spawner",
          agentKind: null,
          summary: "Uses the selected launcher.",
          briefing: "Use the selected launcher and report the result.",
          launcher: null,
          model: null,
          effort: null,
        },
        operator,
      );
      expect(role.status).toBe(201);

      const neutralModels = () => [{
        name: "neutral-model",
        resolvedModel: null,
        label: "Neutral",
        description: null,
        default: true,
        efforts: [{ name: "neutral-effort", description: null, default: true }],
      }];
      hub.hub.modelCatalogue = new DeviceModelCatalogue({
        executableAvailable: () => true,
        claudeRunner: async () => ({ status: "ok", models: neutralModels() }),
        codexRunner: async () => ({ status: "ok", models: neutralModels() }),
      });
      await hub.hub.modelCatalogue.refresh([
        { name: "claude", harness: "claude", argv: ["claude"], env: {}, revision: 1 },
        { name: "codex", harness: "codex", argv: ["codex"], env: {}, revision: 1 },
      ]);

      const claude = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "claude",
          role: "neutral-spawner",
          model: "neutral-model",
          effort: "neutral-effort",
          handle: "neutral-claude",
        },
        auth(token),
      );
      expect(claude.status).toBe(201);

      const codex = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w2",
          launcher: "codex",
          role: "neutral-spawner",
          model: "neutral-model",
          effort: "neutral-effort",
          handle: "neutral-codex",
        },
        auth(token),
      );
      expect(codex.status).toBe(201);
      expect(herdr.agentStarts).toEqual([
        {
          paneId: "w1:spawned-3",
          name: "neutral-claude",
          kind: "claude",
          argv: ["claude", "--model", "neutral-model", "--effort", "neutral-effort"],
        },
        {
          paneId: "w2:spawned-4",
          name: "neutral-codex",
          kind: "codex",
          argv: ["codex", "-m", "neutral-model", "-c", "model_reasoning_effort=\"neutral-effort\""],
        },
      ]);
      expect(herdr.prompts.filter((prompt) => prompt.text.includes("Use the selected launcher"))).toEqual([
        expect.objectContaining({ paneId: "w1:spawned-3" }),
        expect.objectContaining({ paneId: "w2:spawned-4" }),
      ]);

      const invalidLauncher = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "missing-launcher",
          role: "neutral-spawner",
          handle: "invalid-launcher",
        },
        auth(token),
      );
      expect(invalidLauncher.status).toBe(400);

      const wrongModelKind = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "claude",
          role: "neutral-spawner",
          model: "neutral-effort",
          handle: "invalid-model-kind",
        },
        auth(token),
      );
      expect(wrongModelKind.status).toBe(400);

      const wrongEffortKind = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w2",
          launcher: "codex",
          role: "neutral-spawner",
          effort: "neutral-model",
          handle: "invalid-effort-kind",
        },
        auth(token),
      );
      expect(wrongEffortKind.status).toBe(400);
      expect(herdr.agentStarts).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("resolves model and effort names into the start argv hub-side", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      await seedCatalogue(hub, operator);

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", model: "opus", effort: "high", handle: "lead" },
        auth(token),
      );
      expect(response.status).toBe(201);
      expect(herdr.agentStarts).toEqual([
        {
          paneId: "w1:spawned-2",
          name: "lead",
          kind: "claude",
          argv: ["claude", "--model", "opus", "--effort", "high"],
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("uses the Claude harness default when model and effort are omitted", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", handle: "claude-default" },
        auth(token),
      );

      expect(response.status).toBe(201);
      expect(herdr.agentStarts).toEqual([
        { paneId: "w1:spawned-2", name: "claude-default", kind: "claude", argv: ["claude"] },
      ]);
    } finally {
      cleanup();
    }
  });

  test("validates a Claude effort against its default model when model is omitted", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      hub.hub.modelCatalogue = new DeviceModelCatalogue({
        executableAvailable: () => true,
        claudeRunner: async () => ({
          status: "ok",
          models: [{
            name: "default",
            resolvedModel: null,
            label: "Default",
            description: null,
            default: true,
            efforts: [{ name: "high", description: null, default: true }],
          }],
        }),
      });
      await hub.hub.modelCatalogue.refresh([
        { name: "claude", harness: "claude", argv: ["claude"], env: {}, revision: 1 },
      ], "claude");
      const token = await provision(hub, "operator");
      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", effort: "high", handle: "claude-effort" },
        auth(token),
      );

      expect(response.status).toBe(201);
      expect(herdr.agentStarts).toEqual([
        {
          paneId: "w1:spawned-2",
          name: "claude-effort",
          kind: "claude",
          argv: ["claude", "--effort", "high"],
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("rejects catalogue names that do not resolve, before any pane opens", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      await seedCatalogue(hub, operator);

      const unknown = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", model: "sonnet", handle: "lead" },
        auth(token),
      );
      expect(unknown.status).toBe(400);

      // An effort entry referenced through the model parameter is a wrong-kind
      // reference, not a resolution.
      const wrongKind = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", model: "high", handle: "lead" },
        auth(token),
      );
      expect(wrongKind.status).toBe(400);
      expect(herdr.paneSplits).toHaveLength(0);
      expect(herdr.agentStarts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("does not use a curated same-harness effort outside the launcher catalogue", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      const curated = await hub.post(
        "/api/herdr/models",
        { harness: "claude", name: "curated-only", kind: "effort", argvSuffix: ["--effort", "curated-only"] },
        operator,
      );
      expect(curated.status).toBe(201);

      hub.hub.modelCatalogue = new DeviceModelCatalogue({
        executableAvailable: () => true,
        claudeRunner: async () => ({
          status: "ok",
          models: [{
            name: "default",
            resolvedModel: null,
            label: "Default",
            description: null,
            default: true,
            efforts: [],
          }],
        }),
      });
      await hub.hub.modelCatalogue.refresh([
        { name: "claude", harness: "claude", argv: ["claude"], env: {}, revision: 1 },
      ], "claude");

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", effort: "curated-only", handle: "curated-only" },
        auth(token),
      );
      expect(response.status).toBe(400);
      expect(herdr.paneSplits).toHaveLength(0);
      expect(herdr.agentStarts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("rejects an effort that belongs to another selected model", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      hub.hub.modelCatalogue = new DeviceModelCatalogue({
        codexRunner: async () => ({
          status: "ok",
          models: [
            {
              name: "model-a",
              resolvedModel: null,
              label: "Model A",
              description: null,
              default: true,
              efforts: [{ name: "high", description: null, default: true }],
            },
            {
              name: "model-b",
              resolvedModel: null,
              label: "Model B",
              description: null,
              default: false,
              efforts: [{ name: "low", description: null, default: true }],
            },
          ],
        }),
        executableAvailable: () => true,
      });
      await hub.hub.modelCatalogue.refresh([
        { name: "codex", harness: "codex", argv: ["codex"], env: {}, revision: 1 },
      ], "codex");
      const token = await provision(hub, "operator");
      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "codex", model: "model-b", effort: "high", handle: "cross-model" },
        auth(token),
      );

      expect(response.status).toBe(400);
      expect(herdr.paneSplits).toHaveLength(0);
      expect(herdr.agentStarts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("still rejects request-supplied argv over the new fields", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      await seedCatalogue(hub, operator);

      const response = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "claude",
          model: "opus",
          argv: ["claude", "--dangerously"],
          handle: "lead",
        },
        auth(token),
      );
      expect(response.status).toBe(400);
      expect(herdr.paneSplits).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("delivers briefing plus operator goal as one first prompt", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");

      const response = await hub.post(
        "/api/herdr/agents",
        {
          workspaceId: "w1",
          launcher: "claude",
          role: "reporter",
          goal: "Watch the deploy and report every ten minutes.",
          handle: "reporter",
        },
        auth(token),
      );
      expect(response.status).toBe(201);
      const reporterPrompts = spawnedPanePrompts(herdr);
      expect(reporterPrompts).toHaveLength(1);
      expect(reporterPrompts[0]?.text).toContain("progress channel");
      expect(reporterPrompts[0]?.text).toContain(
        "OPERATOR GOAL: Watch the deploy and report every ten minutes.",
      );
    } finally {
      cleanup();
    }
  });

  test("delivers a goal without a role as the whole first prompt", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", goal: "Fix the flaky gate.", handle: "worker" },
        auth(token),
      );
      expect(response.status).toBe(201);
      expect(spawnedPanePrompts(herdr)).toEqual([
        { paneId: "w1:spawned-2", text: "OPERATOR GOAL: Fix the flaky gate." },
      ]);
    } finally {
      cleanup();
    }
  });

  test("prefers request values over the role's preset defaults", async () => {
    const { hub, herdr, cleanup } = spawnReadyHub();
    try {
      const token = await provision(hub, "operator");
      const operator = await operatorAuth(hub);
      await seedCatalogue(hub, operator);
      await hub.post(
        "/api/herdr/models",
        { harness: "claude", name: "haiku", kind: "model", argvSuffix: ["--model", "haiku"] },
        operator,
      );
      await hub.post(
        "/api/herdr/roles",
        {
          name: "scout",
          agentKind: "claude",
          summary: "Explores quickly.",
          briefing: "Scout the repository.",
          launcher: "claude",
          model: "haiku",
          effort: "high",
        },
        operator,
      );

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", role: "scout", model: "opus", handle: "scout" },
        auth(token),
      );
      expect(response.status).toBe(201);
      // The request's model overrides the preset; the preset's effort still applies.
      expect(herdr.agentStarts).toEqual([
        {
          paneId: "w1:spawned-2",
          name: "scout",
          kind: "claude",
          argv: ["claude", "--model", "opus", "--effort", "high"],
        },
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("agent memberships", () => {
  test("carries the agent's unread backlog, not the viewer's", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await hub.post("/api/channels", { name: "ops" }, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(bob));

    // Two messages from alice: bob's unread is 2, alice's own is 0. The
    // fixture makes the two counts DIFFER so the assertion can tell whose
    // number the endpoint serves.
    await hub.post("/api/channels/ops/messages", { body: "first" }, auth(alice));
    await hub.post("/api/channels/ops/messages", { body: "second" }, auth(alice));

    const bobDetail = await body<{ channels: Array<{ channel: string; unread: number }> }>(
      await hub.get("/api/agents/bob"),
    );
    expect(bobDetail.channels).toEqual([{ channel: "ops", unread: 2 }]);

    const aliceDetail = await body<{ channels: Array<{ channel: string; unread: number }> }>(
      await hub.get("/api/agents/alice"),
    );
    expect(aliceDetail.channels).toEqual([{ channel: "ops", unread: 0 }]);
  });
});

describe("attachments listing", () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "msgr-attach-listing-"));
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

  test("serves newest-first metadata openly with an exact truncation flag", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "ops" }, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(alice));
    const files = scratch();
    try {
      for (let index = 1; index <= 3; index += 1) {
        const path = files.file(`notes-${index}.md`, `note ${index}`);
        const posted = await hub.post(
          "/api/channels/ops/messages",
          { body: `message ${index}`, attachments: [path] },
          auth(alice),
        );
        expect(posted.status).toBe(201);
      }

      // Open read: no token.
      const capped = await body<{
        rows: Array<{ attachment: { displayName: string }; channel: string; sender: string }>;
        truncated: boolean;
      }>(await hub.get("/api/attachments?limit=2"));
      // Exactly limit rows with one more behind them: truncated is a fact.
      expect(capped.rows.map((row) => row.attachment.displayName)).toEqual([
        "notes-3.md",
        "notes-2.md",
      ]);
      expect(capped.truncated).toBe(true);

      // Exactly limit rows and nothing behind them: no flag, no floor guess.
      const exact = await body<{ rows: unknown[]; truncated: boolean }>(
        await hub.get("/api/attachments?limit=3"),
      );
      expect(exact.rows).toHaveLength(3);
      expect(exact.truncated).toBe(false);

      expect((await hub.get("/api/attachments?channel=ghost")).status).toBe(404);
      expect((await hub.get("/api/attachments?kind=video")).status).toBe(400);
    } finally {
      files.cleanup();
    }
  });

  test("filters by preview kind with the flag computed after the filter", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "ops" }, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(alice));
    const files = scratch();
    try {
      const image = files.file("chart.png", PNG);
      const markdown = files.file("notes.md", "# notes");
      const plain = files.file("raw.txt", "text");
      await hub.post(
        "/api/channels/ops/messages",
        { body: "mixed", attachments: [image, markdown, plain] },
        auth(alice),
      );

      const images = await body<{
        rows: Array<{ attachment: { displayName: string } }>;
        truncated: boolean;
      }>(await hub.get("/api/attachments?kind=image"));
      expect(images.rows.map((row) => row.attachment.displayName)).toEqual(["chart.png"]);
      expect(images.truncated).toBe(false);

      const other = await body<{ rows: Array<{ attachment: { displayName: string } }> }>(
        await hub.get("/api/attachments?kind=other"),
      );
      expect(other.rows.map((row) => row.attachment.displayName)).toEqual(["raw.txt"]);
    } finally {
      files.cleanup();
    }
  });
});

describe("search filters", () => {
  test("filters by sender and reports truncation exactly", async () => {
    const hub = testHub();
    const alice = await provision(hub, "alice");
    const bob = await provision(hub, "bob");
    await hub.post("/api/channels", { name: "ops" }, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(alice));
    await hub.post("/api/channels/ops/join", {}, auth(bob));
    await hub.post("/api/channels/ops/messages", { body: "deploy one" }, auth(alice));
    await hub.post("/api/channels/ops/messages", { body: "deploy two" }, auth(alice));
    await hub.post("/api/channels/ops/messages", { body: "deploy three" }, auth(bob));

    const bySender = await body<{ results: Array<{ sender: string }>; truncated: boolean }>(
      await hub.get("/api/search?q=deploy&sender=bob"),
    );
    expect(bySender.results.map((result) => result.sender)).toEqual(["bob"]);
    expect(bySender.truncated).toBe(false);

    // At limit-minus-one of the matching set the flag trips; at the limit it
    // must not — the off-by-one is the defect this pair exists to catch.
    const truncated = await body<{ results: unknown[]; truncated: boolean }>(
      await hub.get("/api/search?q=deploy&limit=2"),
    );
    expect(truncated.results).toHaveLength(2);
    expect(truncated.truncated).toBe(true);

    const wholeSet = await body<{ results: unknown[]; truncated: boolean }>(
      await hub.get("/api/search?q=deploy&limit=3"),
    );
    expect(wholeSet.results).toHaveLength(3);
    expect(wholeSet.truncated).toBe(false);

    expect((await hub.get("/api/search?q=deploy&sender=UPPER")).status).toBe(400);
  });
});

describe("pane titles", () => {
  test("surfaces the live terminal title in the topology snapshot", async () => {
    const hub = testHub();
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({
      paneId: "w1:p1",
      terminalId: "term-1",
      terminalTitle: "Review PR #532",
    });
    herdr.withPane({ paneId: "w1:p2", terminalId: "term-2" });
    hub.hub.herdr = herdr;

    const response = await body<{
      workspaces: Array<{ panes: Array<{ paneId: string; title: string | null }> }>;
    }>(await hub.get("/api/herdr/workspaces"));
    const titles = response.workspaces[0]?.panes.map((pane) => [pane.paneId, pane.title]);
    expect(titles).toEqual([
      ["w1:p1", "Review PR #532"],
      ["w1:p2", null],
    ]);
  });
});
