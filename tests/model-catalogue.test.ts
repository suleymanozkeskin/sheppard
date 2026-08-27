import { describe, expect, test } from "bun:test";
import {
  decodeClaudeCatalogue,
  decodeCodexModelList,
  decodeOpenCodeCatalogue,
  decodePiCatalogue,
  DeviceModelCatalogue,
  parsePiCatalogue,
  runClaudeCatalogue,
  type AdapterResult,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type DeviceLauncher,
} from "../src/model-catalogue";
import { operatorAuth, testHub } from "./http-support";

const launcher = (
  name: string,
  harness: string,
  env: Record<string, string> = {},
  revision = 1,
  argv: readonly string[] = [harness],
): DeviceLauncher => ({ name, harness, argv, env, revision });

function model(
  name: string,
  defaultModel = false,
  effort = "low",
): AdapterResult["models"][number] {
  return {
    name,
    resolvedModel: null,
    label: name,
    description: null,
    default: defaultModel,
    efforts: [{ name: effort, description: null, default: true }],
  };
}

interface CatalogueWire {
  launcher: string;
  status: string;
  models: Array<{ name: string }>;
  error: string | null;
  executableAvailable: boolean | null;
}

describe("launcher-scoped device model catalogue", () => {
  test("returns one unrefreshed entry per registered launcher", async () => {
    const hub = testHub();
    const response = await hub.get("/api/herdr/model-catalogue");
    expect(response.status).toBe(200);
    // SAFETY: the endpoint returns the catalogue envelope used by this test.
    const body = (await response.json()) as { catalogues: CatalogueWire[] };
    expect(body.catalogues).toHaveLength(4);
    expect(body.catalogues.map((entry) => entry.launcher)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
    ]);
    expect(body.catalogues.every((entry) => entry.status === "unavailable")).toBe(true);
    expect(body.catalogues.every((entry) => entry.models instanceof Array && entry.models.length === 0)).toBe(true);
    expect(body.catalogues.every((entry) => entry.error === "The launcher catalogue has not been refreshed.")).toBe(true);
    expect(body.catalogues.every((entry) => entry.executableAvailable === null)).toBe(true);
    expect(body.catalogues.every((entry) => !Object.hasOwn(entry, "reason"))).toBe(true);
    expect(body.catalogues.every((entry) => !Object.hasOwn(entry, "launcherRevision"))).toBe(true);
  });

  test("keeps two same-harness launcher catalogues separate", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    expect(
      (await hub.post(
        "/api/herdr/launchers",
        {
          name: "claude-personal",
          agentKind: "claude",
          argv: ["claude"],
          env: { CLAUDE_CONFIG_DIR: "/profiles/personal" },
        },
        operator,
      )).status,
    ).toBe(201);
    expect(
      (await hub.post(
        "/api/herdr/launchers",
        {
          name: "claude-work",
          agentKind: "claude",
          argv: ["claude"],
          env: { CLAUDE_CONFIG_DIR: "/profiles/work" },
        },
        operator,
      )).status,
    ).toBe(201);

    const calls: string[] = [];
    hub.hub.modelCatalogue = new DeviceModelCatalogue({
      executableAvailable: () => true,
      claudeRunner: async (selected) => {
        const profile = selected.env.CLAUDE_CONFIG_DIR ?? "missing";
        calls.push(selected.name);
        return { status: "ok", models: [model(profile.endsWith("work") ? "work-model" : "personal-model", true)] };
      },
    });

    const refreshed = await hub.post("/api/herdr/model-catalogue", { launcher: "claude-work" }, operator);
    expect(refreshed.status).toBe(200);
    expect(calls).toEqual(["claude-work"]);
    // SAFETY: the endpoint returns the catalogue envelope used by this test.
    const first = (await refreshed.json()) as { catalogues: CatalogueWire[] };
    expect(first.catalogues.find((entry) => entry.launcher === "claude-work")).toMatchObject({
      status: "ready",
      models: [expect.objectContaining({ name: "work-model" })],
    });
    expect(first.catalogues.find((entry) => entry.launcher === "claude-personal")).toMatchObject({
      status: "unavailable",
      models: [],
    });

    const second = await hub.post("/api/herdr/model-catalogue", { launcher: "claude-personal" }, operator);
    expect(second.status).toBe(200);
    expect(calls).toEqual(["claude-work", "claude-personal"]);
    // SAFETY: the endpoint returns the catalogue envelope used by this test.
    const all = (await second.json()) as { catalogues: CatalogueWire[] };
    expect(all.catalogues.find((entry) => entry.launcher === "claude-work")?.models[0]?.name).toBe("work-model");
    expect(all.catalogues.find((entry) => entry.launcher === "claude-personal")?.models[0]?.name).toBe("personal-model");
  });

  test("does not allow a sibling launcher model or effort", async () => {
    const first = launcher("claude-one", "claude");
    const second = launcher("claude-two", "claude");
    const device = new DeviceModelCatalogue({
      executableAvailable: () => true,
      claudeRunner: async (selected) => ({
        status: "ok",
        models: [model(selected.name === "claude-one" ? "one" : "two", true, selected.name === "claude-one" ? "low" : "high")],
      }),
    });
    await device.refresh([first, second]);
    expect(device.resolveSelection(first, "two", "high")).toEqual({
      ok: false,
      field: "model",
      reason: "is not available for this launcher on this device",
    });
    expect(device.resolveSelection(first, "one", "high")).toEqual({
      ok: false,
      field: "effort",
      reason: "is not available for the selected model",
    });
  });

  test("launcher revision makes the prior catalogue non-current", async () => {
    const first = launcher("claude", "claude", {}, 1);
    const device = new DeviceModelCatalogue({
      now: () => 1_000,
      executableAvailable: () => true,
      claudeRunner: async () => ({ status: "ok", models: [model("one", true)] }),
    });
    await device.refresh([first]);
    expect(device.hasCurrentCatalogue(first)).toBe(true);
    const changed = launcher("claude", "claude", {}, 2);
    expect(device.snapshot([changed]).catalogues[0]).toMatchObject({
      revision: 2,
      status: "unavailable",
      models: [],
    });
    expect(device.resolveSelection(changed, "one", "low").ok).toBe(false);
  });

  test("Claude maps SDK rows and closes the query", async () => {
    let received: ClaudeQueryOptions | null = null;
    let closed = 0;
    const query: ClaudeQuery = {
      supportedModels: async () => [
        {
          value: "default",
          resolvedModel: "claude-default-wire",
          displayName: "Configured",
          description: "Account default",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        {
          value: "sonnet[1m]",
          resolvedModel: "claude-sonnet-wire[1m]",
          displayName: "Sonnet",
          description: "Explicit model",
          supportsEffort: false,
        },
      ],
      close: () => { closed += 1; },
    };
    const result = await runClaudeCatalogue(
      launcher("claude", "claude", { CLAUDE_CONFIG_DIR: "/profiles/test" }, 4, ["node"]),
      (options) => {
        received = options;
        return query;
      },
    );
    expect(result.status).toBe("ok");
    expect(result.models).toEqual([
      {
        name: "default",
        resolvedModel: "claude-default-wire",
        label: "Configured",
        description: "Account default",
        default: true,
        efforts: [
          { name: "low", description: null, default: false },
          { name: "high", description: null, default: false },
        ],
      },
      {
        name: "sonnet[1m]",
        resolvedModel: "claude-sonnet-wire[1m]",
        label: "Sonnet",
        description: "Explicit model",
        default: false,
        efforts: [],
      },
    ]);
    expect(closed).toBe(1);
    expect(received?.options.pathToClaudeCodeExecutable).toMatch(/\/node$/u);
    expect(received?.options.cwd).toBe(process.cwd());
    expect(received?.options.env.CLAUDE_CONFIG_DIR).toBe("/profiles/test");
    expect(received?.options.settingSources).toEqual(["user", "project", "local"]);
    expect(received?.options.persistSession).toBe(false);
    expect(received?.options.tools).toEqual([]);
    expect(Object.hasOwn(received?.options ?? {}, "executableArgs")).toBe(false);
  });

  test("Claude rejects empty, duplicate, and malformed SDK rows", () => {
    expect(decodeClaudeCatalogue([])).toBeNull();
    expect(decodeClaudeCatalogue([
      { value: "default", displayName: "A", description: "A" },
      { value: "default", displayName: "B", description: "B" },
    ])).toBeNull();
    expect(decodeClaudeCatalogue([
      { value: "default", displayName: "A", description: "A", supportedEffortLevels: ["low", "low"] },
    ])).toBeNull();
    expect(decodeClaudeCatalogue([
      { value: "default", displayName: "A", description: "A", resolvedModel: "bad\nmodel" },
    ])).toBeNull();
  });

  test("keeps bracketed Claude identifiers exact through selection", async () => {
    const selectedLauncher = launcher("claude-bracketed", "claude");
    const device = new DeviceModelCatalogue({
      executableAvailable: () => true,
      claudeRunner: async () => ({
        status: "ok",
        models: [model("opus[1m]", true, "xhigh[1m]")],
      }),
    });
    await device.refresh([selectedLauncher], selectedLauncher.name);
    expect(device.resolveSelection(selectedLauncher, "opus[1m]", "xhigh[1m]")).toEqual({
      ok: true,
      argvSuffix: ["--model", "opus[1m]", "--effort", "xhigh[1m]"],
    });
  });

  test("Claude does not claim support for arbitrary CLI args", async () => {
    const result = await runClaudeCatalogue(launcher("claude-profile", "claude", {}, 1, ["node", "--profile", "x"]), () => ({
      supportedModels: async () => [],
      close: () => undefined,
    }));
    expect(result).toEqual({ status: "unsupported", models: [] });
  });

  test("Pi preserves each model's exact thinking levels", () => {
    const models = decodePiCatalogue(
      { id: 1, type: "response", command: "get_state", success: true, data: { model: { provider: "openai", id: "gpt-a" }, thinkingLevel: "high" } },
      { id: 2, type: "response", command: "get_available_models", success: true, data: { models: [
        { provider: "openai", id: "gpt-a", name: "A" },
        { provider: "anthropic", id: "sonnet", name: "Sonnet" },
      ] } },
      [
        { id: 4, type: "response", command: "get_available_thinking_levels", success: true, data: { levels: ["off", "low", "high"] } },
        { id: 6, type: "response", command: "get_available_thinking_levels", success: true, data: { levels: ["off", "max"] } },
      ],
    );
    expect(models).toEqual([
      {
        name: "openai/gpt-a",
        resolvedModel: null,
        label: "A",
        description: null,
        default: true,
        efforts: [
          { name: "off", description: null, default: false },
          { name: "low", description: null, default: false },
          { name: "high", description: null, default: true },
        ],
      },
      {
        name: "anthropic/sonnet",
        resolvedModel: null,
        label: "Sonnet",
        description: null,
        default: false,
        efforts: [
          { name: "off", description: null, default: false },
          { name: "max", description: null, default: false },
        ],
      },
    ]);
  });

  test("Pi compatibility parsing ignores correlated set_model responses", () => {
    const transcript = [
      JSON.stringify({
        id: 1,
        type: "response",
        command: "get_state",
        success: true,
        data: { model: { provider: "openai", id: "gpt-a" }, thinkingLevel: "high" },
      }),
      JSON.stringify({
        id: 2,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "openai", id: "gpt-a", name: "A" }] },
      }),
      JSON.stringify({
        id: 3,
        type: "response",
        command: "set_model",
        success: true,
        data: { provider: "openai", id: "gpt-a", name: "A" },
      }),
      JSON.stringify({
        id: 4,
        type: "response",
        command: "get_available_thinking_levels",
        success: true,
        data: { levels: ["off", "high"] },
      }),
    ].join("\n");
    expect(parsePiCatalogue(transcript)).toMatchObject([
      { name: "openai/gpt-a", default: true, efforts: [{ name: "off" }, { name: "high", default: true }] },
    ]);
  });

  test("OpenCode accepts only active heading-matched rows and local variants", () => {
    const models = decodeOpenCodeCatalogue([
      "openai/gpt-5",
      JSON.stringify({
        id: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        status: "active",
        capabilities: {},
        variants: { low: {}, high: { disabled: true } },
      }),
      "anthropic/sonnet",
      JSON.stringify({
        id: "sonnet",
        providerID: "anthropic",
        name: "Sonnet",
        status: "active",
        capabilities: {},
        variants: { max: { disabled: false } },
      }),
    ].join("\n"));
    expect(models).toMatchObject([
      { name: "openai/gpt-5", efforts: [{ name: "low" }] },
      { name: "anthropic/sonnet", efforts: [{ name: "max" }] },
    ]);
    expect(decodeOpenCodeCatalogue([
      "openai/gpt-5",
      JSON.stringify({ id: "other", providerID: "openai", name: "GPT-5", status: "active", capabilities: {}, variants: {} }),
    ].join("\n"))).toBeNull();
  });

  test("Codex keeps exact model and effort defaults", () => {
    const page = decodeCodexModelList({
      id: 1,
      result: {
        data: [{
          id: "gpt-5",
          displayName: "GPT-5",
          description: null,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: null },
          ],
        }],
        nextCursor: null,
      },
    });
    expect(page).toEqual({
      models: [{
        name: "gpt-5",
        resolvedModel: null,
        label: "GPT-5",
        description: null,
        default: true,
        efforts: [
          { name: "low", description: "Fast", default: false },
          { name: "high", description: null, default: true },
        ],
      }],
      nextCursor: null,
    });
    expect(decodeCodexModelList({ result: { data: [{ id: "gpt-5" }] } })).toBeNull();
  });

  test("catalogue endpoint keeps discovery and refresh open", async () => {
    const hub = testHub();
    hub.hub.modelCatalogue = new DeviceModelCatalogue({
      executableAvailable: () => true,
      codexRunner: async () => ({ status: "ok", models: [model("gpt-5", true)] }),
    });
    expect((await hub.get("/api/herdr/model-catalogue")).status).toBe(200);
    const refreshed = await hub.post("/api/herdr/model-catalogue", { launcher: "codex" });
    expect(refreshed.status).toBe(200);
    // SAFETY: the endpoint returns the catalogue envelope used by this test.
    const body = (await refreshed.json()) as { catalogues: CatalogueWire[] };
    expect(body.catalogues.find((entry) => entry.launcher === "codex")).toMatchObject({ status: "ready" });
    expect((await hub.post(
      "/api/herdr/model-catalogue",
      { launcher: "codex", argv: ["unsafe"] },
    )).status).toBe(400);
    expect((await hub.post("/api/herdr/model-catalogue", { launcher: "missing" })).status).toBe(400);
  });
});
