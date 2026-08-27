import { describe, expect, test } from "bun:test";
import { FakeHerdr } from "../src/herdr";
import { DeviceModelCatalogue, runOpenCodeCatalogue } from "../src/model-catalogue";
import { auth, operatorAuth, provision, testHub } from "./http-support";
import type { TestHub } from "./http-support";

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

interface SpawnFixture {
  hub: TestHub;
  herdr: FakeHerdr;
  cleanup: () => void;
}

function spawnHub(): SpawnFixture {
  const hub = testHub();
  const herdr = new FakeHerdr();
  herdr.workspaces = [{ id: "w1", label: "Backend" }];
  herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
  bindSpawnedAgent(hub, herdr);
  hub.hub.herdr = herdr;
  return { hub, herdr, cleanup: () => undefined };
}

describe("launcher environment", () => {
  test("keeps environment values private and supports hidden-key patches", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const created = await hub.post(
      "/api/herdr/launchers",
      {
        name: "claude-profile",
        agentKind: "claude",
        argv: ["claude"],
        env: { CLAUDE_CONFIG_DIR: "/private/profile", KEEP_ME: "secret-value" },
      },
      operator,
    );
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).toContain("CLAUDE_CONFIG_DIR");
    expect(createdText).not.toContain("/private/profile");
    expect(createdText).not.toContain("secret-value");

    const listed = await hub.get("/api/herdr/launchers", operator);
    const listedText = await listed.text();
    expect(listedText).not.toContain("/private/profile");
    expect(listedText).not.toContain("secret-value");

    const patched = await hub.put(
      "/api/herdr/launchers/claude-profile",
      { envPatch: { set: { NEW_KEY: "new-secret" }, remove: ["KEEP_ME"] } },
      operator,
    );
    expect(patched.status).toBe(200);
    const patchedText = await patched.text();
    expect(patchedText).toContain("NEW_KEY");
    expect(patchedText).not.toContain("new-secret");
    expect(hub.hub.store.launcher("claude-profile")?.env).toEqual({
      CLAUDE_CONFIG_DIR: "/private/profile",
      NEW_KEY: "new-secret",
    });

    const kept = await hub.put("/api/herdr/launchers/claude-profile", {}, operator);
    expect(kept.status).toBe(200);
    expect(hub.hub.store.launcher("claude-profile")?.env.NEW_KEY).toBe("new-secret");
  });

  test("rejects dangerous environment keys before mutation", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const before = hub.hub.store.launcher("claude")?.revision;
    const response = await hub.put(
      "/api/herdr/launchers/claude",
      { envPatch: { set: { PATH: "private-value" }, remove: [] } },
      operator,
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("private-value");
    expect(hub.hub.store.launcher("claude")?.revision).toBe(before);
    expect(hub.hub.store.launcher("claude")?.env).toEqual({});
  });

  test("an environment update changes the launcher revision and catalogue state", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
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
    await hub.post("/api/herdr/model-catalogue", { launcher: "claude" }, operator);
    const changed = await hub.put(
      "/api/herdr/launchers/claude",
      { envPatch: { set: { CLAUDE_CONFIG_DIR: "/profile-two" }, remove: [] } },
      operator,
    );
    expect(changed.status).toBe(200);
    const catalogue = await hub.get("/api/herdr/model-catalogue");
    // SAFETY: the endpoint returns the catalogue envelope used by this test.
    const body = (await catalogue.json()) as {
      catalogues: Array<{ launcher: string; revision: number; status: string; models: Array<{ name: string }> }>;
    };
    expect(body.catalogues.find((entry) => entry.launcher === "claude")).toMatchObject({
      revision: 2,
      status: "unavailable",
      models: [],
    });
  });

  test("passes launcher environment to discovery and server-owned values win at spawn", async () => {
    const { hub, herdr, cleanup } = spawnHub();
    try {
      const operator = await operatorAuth(hub);
      const token = await provision(hub, "worker");
      const stored = hub.hub.store.launcher("claude");
      if (stored === null) throw new Error("canonical launcher fixture is missing");
      hub.hub.store.updateLauncher("claude", {
        agentKind: stored.agentKind,
        argv: stored.argv,
        startTimeoutMs: stored.startTimeoutMs,
        env: { ACCOUNT_PROFILE: "profile-a", MSGR_HANDLE: "bad", MSGR_TOKEN: "bad" },
      });
      let observedEnvironment: Readonly<Record<string, string>> | null = null;
      hub.hub.modelCatalogue = new DeviceModelCatalogue({
        executableAvailable: () => true,
        claudeRunner: async (selected) => {
          observedEnvironment = selected.env;
          return { status: "ok", models: [{
            name: "default",
            resolvedModel: null,
            label: "Default",
            description: null,
            default: true,
            efforts: [],
          }] };
        },
      });
      await hub.post("/api/herdr/model-catalogue", { launcher: "claude" }, operator);
      expect(observedEnvironment?.ACCOUNT_PROFILE).toBe("profile-a");

      const response = await hub.post(
        "/api/herdr/agents",
        { workspaceId: "w1", launcher: "claude", handle: "spawned-worker" },
        auth(token),
      );
      expect(response.status).toBe(201);
      expect(herdr.paneSplits[0]?.options.env).toMatchObject({ ACCOUNT_PROFILE: "profile-a" });
      expect(herdr.paneSplits[0]?.options.env?.MSGR_HANDLE).toBe("spawned-worker");
      expect(herdr.paneSplits[0]?.options.env?.MSGR_TOKEN).not.toBe("bad");
    } finally {
      cleanup();
    }
  });

  test("passes both OpenCode profile directories to its command", async () => {
    let observed: Readonly<Record<string, string>> | undefined;
    const result = await runOpenCodeCatalogue(
      {
        name: "opencode-profile",
        harness: "opencode",
        argv: ["opencode"],
        env: { XDG_CONFIG_HOME: "/profiles/config", XDG_DATA_HOME: "/profiles/data" },
        revision: 1,
      },
      async (_argv, _timeout, env) => {
        observed = env;
        return {
          status: "ok",
          stdout: [
            "openai/gpt-5",
            JSON.stringify({ id: "gpt-5", providerID: "openai", name: "GPT-5", status: "active", capabilities: {}, variants: {} }),
          ].join("\n"),
        };
      },
    );
    expect(result.status).toBe("ok");
    expect(observed?.XDG_CONFIG_HOME).toBe("/profiles/config");
    expect(observed?.XDG_DATA_HOME).toBe("/profiles/data");
  });
});
