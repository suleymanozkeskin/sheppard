import { afterEach, describe, expect, test } from "bun:test";
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

interface ModelJson {
  harness: string;
  name: string;
  kind: "model" | "effort";
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

  test("lists model and effort names grouped by harness", async () => {
    const harness = hub();
    harness.hub.store.seedModels([
      {
        harness: "claude",
        name: "opus",
        kind: "model",
        argvSuffix: ["--model", "opus"],
      },
      {
        harness: "claude",
        name: "high",
        kind: "effort",
        argvSuffix: ["--effort", "high"],
      },
      {
        harness: "codex",
        name: "gpt",
        kind: "model",
        argvSuffix: ["--model", "gpt"],
      },
    ]);

    const outcome = await harness.run(["models"]);

    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe("");
    expect(outcome.out).toContain("claude  high (effort)  opus (model)");
    expect(outcome.out).toContain("codex  gpt (model)");
    expect(outcome.out).not.toContain("argvSuffix");
    expect(outcome.out).not.toContain("--model");
  });

  test("returns model and effort names as JSON without argv suffixes", async () => {
    const harness = hub();
    harness.hub.store.seedModels([
      {
        harness: "claude",
        name: "opus",
        kind: "model",
        argvSuffix: ["--model", "opus"],
      },
      {
        harness: "claude",
        name: "high",
        kind: "effort",
        argvSuffix: ["--effort", "high"],
      },
    ]);

    const outcome = await harness.run(["models", "--json"]);

    expect(outcome.code).toBe(0);
    // SAFETY: `models --json` returns the open model-list response shape.
    const response = JSON.parse(outcome.out) as { models: ModelJson[] };
    expect(response).toEqual({
      models: [
        { harness: "claude", name: "high", kind: "effort" },
        { harness: "claude", name: "opus", kind: "model" },
      ],
    });
    expect(outcome.out).not.toContain("argvSuffix");
    expect(outcome.out).not.toContain("--model");
  });
});
