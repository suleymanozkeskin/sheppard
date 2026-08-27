import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auth, operatorAuth, provision, testHub } from "./http-support";

describe("local directory picker", () => {
  test("requires a human and lists canonical child directories only", async () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-directory-picker-"));
    try {
      mkdirSync(join(root, "zeta"));
      mkdirSync(join(root, "alpha"));
      writeFileSync(join(root, "README.md"), "not a directory");
      const hub = testHub();
      const token = await provision(hub, "directory-agent");

      expect((await hub.get(`/api/herdr/directories?path=${encodeURIComponent(root)}`)).status).toBe(401);
      expect(
        (await hub.get(`/api/herdr/directories?path=${encodeURIComponent(root)}`, auth(token))).status,
      ).toBe(403);

      const response = await hub.get(
        `/api/herdr/directories?path=${encodeURIComponent(root)}`,
        await operatorAuth(hub),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        currentPath: realpathSync(root),
        parentPath: join(realpathSync(root), ".."),
        directories: [
          { name: "alpha", path: join(realpathSync(root), "alpha") },
          { name: "zeta", path: join(realpathSync(root), "zeta") },
        ],
        truncated: false,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects relative, control-character, and missing paths", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);

    expect((await hub.get("/api/herdr/directories?path=relative", operator)).status).toBe(400);
    expect((await hub.get("/api/herdr/directories?path=%2Ftmp%00bad", operator)).status).toBe(400);
    expect(
      (await hub.get(`/api/herdr/directories?path=${encodeURIComponent("/path/that/does/not/exist")}`, operator)).status,
    ).toBe(404);
  });
});
