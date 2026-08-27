import { afterEach, describe, expect, test } from "bun:test";
import { DeviceModelCatalogue } from "../src/model-catalogue";
import { type CliHarness, startCliHub } from "./cli-support";

const open: CliHarness[] = [];

interface RoleJson {
  name: string;
  agentKind: string | null;
  native: boolean;
  summary: string;
  launcher: string | null;
  model: string | null;
  effort: string | null;
}

function hub(): CliHarness {
  const harness = startCliHub();
  open.push(harness);
  return harness;
}

function seedLauncher(harness: CliHarness): void {
  harness.hub.store.seedLaunchers([
    { name: "codex", agentKind: "codex", argv: ["codex"], env: {}, startTimeoutMs: 1_000 },
  ]);
}

async function seedClaudeCatalogue(harness: CliHarness): Promise<void> {
  harness.hub.store.seedLaunchers([
    { name: "claude", agentKind: "claude", argv: ["claude"], env: {}, startTimeoutMs: 1_000 },
  ]);
  harness.hub.modelCatalogue = new DeviceModelCatalogue({
    executableAvailable: () => true,
    claudeRunner: async () => ({
      status: "ok",
      models: [{
        name: "opus",
        resolvedModel: "opus",
        label: "Opus",
        description: null,
        default: true,
        efforts: [{ name: "high", description: null, default: true }],
      }],
    }),
  });
  const refreshed = await harness.run(["models", "refresh", "claude"]);
  expect(refreshed.code).toBe(0);
}

afterEach(() => {
  while (open.length > 0) open.pop()?.stop();
});

describe("agent discovery commands", () => {
  test("lists open role presets without a token", async () => {
    const harness = hub();
    seedLauncher(harness);
    harness.hub.store.seedRoles([
      {
        name: "lead",
        agentKind: null,
        native: true,
        summary: "Coordinates this workspace.",
        briefing: "This briefing stays private.",
        launcher: null,
        model: null,
        effort: null,
      },
      {
        name: "reviewer",
        agentKind: null,
        native: false,
        summary: "Reviews changes.",
        briefing: "Review details stay private.",
        launcher: "codex",
        model: "opus",
        effort: "high",
      },
    ]);

    const outcome = await harness.run(["roles"]);

    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe("");
    expect(outcome.out).toContain("lead  native  harness any  launcher default  model default  effort default");
    expect(outcome.out).toContain("  Coordinates this workspace.");
    expect(outcome.out).toContain("reviewer  custom  harness any  launcher codex  model opus  effort high");
    expect(outcome.out).toContain("  Reviews changes.");
    expect(outcome.out).not.toContain("briefing");
  });

  test("returns role presets as JSON without briefings", async () => {
    const harness = hub();
    seedLauncher(harness);
    harness.hub.store.seedRoles([
      {
        name: "lead",
        agentKind: null,
        native: true,
        summary: "Coordinates this workspace.",
        briefing: "This briefing stays private.",
        launcher: null,
        model: null,
        effort: null,
      },
    ]);

    const outcome = await harness.run(["roles", "--json"]);

    expect(outcome.code).toBe(0);
    // SAFETY: `roles --json` returns the open role-list response shape.
    const response = JSON.parse(outcome.out) as { roles: RoleJson[] };
    expect(response).toEqual({
      roles: [
        {
          name: "lead",
          agentKind: null,
          native: true,
          summary: "Coordinates this workspace.",
          launcher: null,
          model: null,
          effort: null,
        },
      ],
    });
    expect(outcome.out).not.toContain("briefing");
  });

  test("lists model and effort names by launcher catalogue", async () => {
    const harness = hub();
    await seedClaudeCatalogue(harness);

    const outcome = await harness.run(["models"]);

    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe("");
    expect(outcome.out).toContain("claude  harness claude  ready");
    expect(outcome.out).toContain("opus*  efforts high*");
    expect(outcome.out).not.toContain("argvSuffix");
    expect(outcome.out).not.toContain("--model");
  });

  test("returns launcher catalogues as JSON without command arguments", async () => {
    const harness = hub();
    await seedClaudeCatalogue(harness);

    const outcome = await harness.run(["models", "--json"]);

    expect(outcome.code).toBe(0);
    // SAFETY: `models --json` returns the open launcher-catalogue response shape.
    const response = JSON.parse(outcome.out) as { catalogues: unknown[] };
    expect(response.catalogues).toHaveLength(1);
    expect(response.catalogues[0]).toMatchObject({
      launcher: "claude",
      harness: "claude",
      status: "ready",
      executableAvailable: true,
      error: null,
      models: [{
        name: "opus",
        label: "Opus",
        description: null,
        default: true,
        efforts: [{ name: "high", description: null, default: true }],
      }],
    });
    expect(outcome.out).not.toContain("argvSuffix");
    expect(outcome.out).not.toContain("--model");
  });
});
