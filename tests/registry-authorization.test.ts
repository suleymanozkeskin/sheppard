import { describe, expect, test } from "bun:test";
import { auth, controlAuth, operatorAuth, provision, testHub } from "./http-support";

describe("staffing registry authorization", () => {
  test("local setup can manage roles but agent tokens cannot delete roles or mutate runtime registries", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const agentToken = await provision(hub, "registry-agent");

    const createdRole = await hub.post(
      "/api/herdr/roles",
      {
        name: "private-role",
        agentKind: "claude",
        summary: "A private role.",
        briefing: "Do not disclose this briefing.",
      },
      operator,
    );
    expect(createdRole.status).toBe(201);
    const createdModel = await hub.post(
      "/api/herdr/models",
      { harness: "claude", name: "private-model", kind: "model", argvSuffix: ["--private"] },
      operator,
    );
    expect(createdModel.status).toBe(201);
    const createdLauncher = await hub.post(
      "/api/herdr/launchers",
      { name: "private-launcher", agentKind: "claude", argv: ["claude", "--private"] },
      operator,
    );
    expect(createdLauncher.status).toBe(201);

    for (const path of [
      "/api/herdr/roles",
      "/api/herdr/models",
      "/api/herdr/launchers",
    ]) {
      const response = await hub.get(path, auth(agentToken));
      expect(response.status).toBe(200);
    }

    const role = hub.hub.store.role("private-role");
    if (role === null) throw new Error("private role fixture is missing");
    const detail = await hub.get("/api/herdr/roles/private-role", controlAuth());
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ briefing: role.briefing });

    expect(
      (
        await hub.post(
          "/api/herdr/roles",
          {
            name: "agent-role",
            agentKind: "claude",
            summary: "Created by local setup.",
            briefing: "Use this role briefing.",
          },
          controlAuth(),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await hub.put(
          "/api/herdr/roles/private-role",
          {
            agentKind: "claude",
            summary: "Changed by local setup.",
            briefing: "Use the changed briefing.",
            launcher: null,
            model: null,
            effort: null,
          },
          controlAuth(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await hub.put(
          "/api/herdr/roles/private-role/runtime",
          {
            agentKind: "claude",
            launcher: "claude",
            model: "private-model",
            effort: null,
          },
          controlAuth(),
        )
      ).status,
    ).toBe(200);

    const modelsBefore = JSON.stringify(hub.hub.store.listModels());
    const launchersBefore = JSON.stringify(hub.hub.store.listLaunchers());
    const refused = [
      hub.delete("/api/herdr/roles/private-role", auth(agentToken)),
      hub.post(
        "/api/herdr/models",
        { harness: "claude", name: "agent-model", kind: "model", argvSuffix: ["--agent"] },
        auth(agentToken),
      ),
      hub.delete("/api/herdr/models/claude/private-model", auth(agentToken)),
      hub.post(
        "/api/herdr/launchers",
        { name: "agent-launcher", agentKind: "claude", argv: ["claude", "--agent"] },
        auth(agentToken),
      ),
      hub.put(
        "/api/herdr/launchers/private-launcher",
        { agentKind: "claude", argv: ["claude", "--changed"] },
        auth(agentToken),
      ),
      hub.delete("/api/herdr/launchers/private-launcher", auth(agentToken)),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "OperatorOnly" });
    }

    expect(hub.hub.store.role("agent-role")).not.toBeNull();
    expect(hub.hub.store.role("private-role")).toMatchObject({
      briefing: "Use the changed briefing.",
      model: "private-model",
    });
    expect(JSON.stringify(hub.hub.store.listModels())).toBe(modelsBefore);
    expect(JSON.stringify(hub.hub.store.listLaunchers())).toBe(launchersBefore);
  });
});
