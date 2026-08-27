import { describe, expect, test } from "bun:test";
import { operatorAuth, testHub } from "./http-support";

const nativeRoleNames = [
  "lead",
  "reporter",
  "planner",
  "web-searcher",
  "tester",
  "ui-ux-designer",
  "worker",
] as const;

describe("native role catalogue", () => {
  test("seeds the product roles as harness-neutral native presets", async () => {
    const hub = testHub();
    const response = await hub.get("/api/herdr/roles");
    expect(response.status).toBe(200);
    // SAFETY: the public role list carries only non-secret preset metadata.
    const body = (await response.json()) as {
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

    const roles = new Map(body.roles.map((role) => [role.name, role]));
    for (const name of nativeRoleNames) {
      const role = roles.get(name);
      expect(role).toBeDefined();
      expect(role).toMatchObject({
        name,
        agentKind: null,
        native: true,
        launcher: null,
        model: null,
        effort: null,
      });
      expect(role?.summary.length).toBeGreaterThan(0);
    }

    expect(JSON.stringify(body)).not.toContain("MISSION:");
  });

  test("keeps each native role briefing private and read-only", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);

    for (const name of nativeRoleNames) {
      const detail = await hub.get(`/api/herdr/roles/${name}`, operator);
      expect(detail.status).toBe(200);
      // SAFETY: the local role detail is the only public API surface
      // that returns a native role briefing.
      const role = (await detail.json()) as {
        name: string;
        native: boolean;
        briefing: string;
      };
      expect(role.name).toBe(name);
      expect(role.native).toBe(true);
      expect(role.briefing.length).toBeGreaterThan(0);

      const update = await hub.put(`/api/herdr/roles/${name}`, {}, operator);
      expect(update.status).toBe(400);
      expect(await update.json()).toMatchObject({
        code: "ValidationFailed",
        error: "role native roles are read-only; duplicate the role to customize it",
      });
    }
  });
});
