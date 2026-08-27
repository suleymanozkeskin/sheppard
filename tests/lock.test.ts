import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST } from "../src/config";
import type { ServerConfig } from "../src/config";
import { IN_MEMORY } from "../src/db";
import { HubAlreadyRunning, HubLockFailed, acquireHubLock } from "../src/lock";
import { startHub, type RunningHub } from "../src/server";
import { expectErr, expectOk } from "./support";

function scratchDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "msgr-lock-"));
  return {
    path: join(dir, "msgr.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("hub lock", () => {
  test("refuses a second hub on the same database", () => {
    const scratch = scratchDatabase();
    try {
      const first = expectOk(acquireHubLock(scratch.path));

      const error = expectErr(acquireHubLock(scratch.path));
      expect(HubAlreadyRunning.is(error)).toBe(true);
      expect(error.pid).toBe(process.pid);
      expect(error.message).toContain(scratch.path);

      first.release();
    } finally {
      scratch.cleanup();
    }
  });

  test("frees the database when the hub releases it", () => {
    const scratch = scratchDatabase();
    try {
      expectOk(acquireHubLock(scratch.path)).release();
      expect(existsSync(`${scratch.path}.lock`)).toBe(false);

      const second = expectOk(acquireHubLock(scratch.path));
      second.release();
    } finally {
      scratch.cleanup();
    }
  });

  test("reclaims a lock left behind by a hub that is gone", () => {
    const scratch = scratchDatabase();
    try {
      // A pid far above the system maximum cannot name a live process.
      writeFileSync(`${scratch.path}.lock`, "999999999");

      const reclaimed = expectOk(acquireHubLock(scratch.path));
      reclaimed.release();
    } finally {
      scratch.cleanup();
    }
  });

  test("keeps the lock when the holder is still alive", () => {
    const scratch = scratchDatabase();
    try {
      writeFileSync(`${scratch.path}.lock`, String(process.pid));
      expect(HubAlreadyRunning.is(expectErr(acquireHubLock(scratch.path)))).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  test("reclaims a lock whose contents are unreadable", () => {
    const scratch = scratchDatabase();
    try {
      writeFileSync(`${scratch.path}.lock`, "not a pid");
      expectOk(acquireHubLock(scratch.path)).release();
    } finally {
      scratch.cleanup();
    }
  });

  test("releasing twice is harmless", () => {
    const scratch = scratchDatabase();
    try {
      const lock = expectOk(acquireHubLock(scratch.path));
      lock.release();
      lock.release();
    } finally {
      scratch.cleanup();
    }
  });
});

describe("a database path that does not exist yet", () => {
  test("is created rather than mistaken for a lock held by someone else", () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-fresh-"));
    const databasePath = join(root, "config", "msgr", "msgr.db");
    try {
      expect(existsSync(join(root, "config"))).toBe(false);

      const lock = expectOk(acquireHubLock(databasePath));
      expect(existsSync(`${databasePath}.lock`)).toBe(true);
      lock.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the containing directory readable only by its owner", () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-fresh-"));
    const databasePath = join(root, "config", "msgr", "msgr.db");
    try {
      expectOk(acquireHubLock(databasePath)).release();
      expect(statSync(join(root, "config", "msgr")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lets a hub start, which is what a first run on a machine does", () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-fresh-"));
    const databasePath = join(root, "config", "msgr", "msgr.db");
    const config: ServerConfig = {
      port: 0,
      databasePath,
      allowedOrigin: `http://${HOST}:0`,
      pushAvailable: false,
      herdrSocketPath: null,
      webRoot: join(root, "no-web-root"),
      allowExtraHumans: false,
    };

    try {
      const started = startHub(config);
      const hub = expectOk(started);
      expect(hub.port).toBeGreaterThan(0);
      expect(existsSync(databasePath)).toBe(true);
      hub.stop();
      expect(existsSync(`${databasePath}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serves the root when push is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-smoke-"));
    const databasePath = join(root, "msgr.db");
    const webRoot = join(root, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>msgr</title>");
    const config: ServerConfig = {
      port: 0,
      databasePath,
      allowedOrigin: `http://${HOST}:0`,
      pushAvailable: true,
      herdrSocketPath: null,
      webRoot,
      allowExtraHumans: false,
    };
    let running: RunningHub | null = null;

    try {
      running = expectOk(startHub(config));
      expect(running.notifier).not.toBeNull();

      const response = await fetch(`http://${HOST}:${running.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("msgr");
    } finally {
      running?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("failures that are not contention", () => {
  test("a directory that cannot be created is reported as itself", () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-blocked-"));
    try {
      // A regular file where a directory is needed cannot become one.
      const blocker = join(root, "not-a-directory");
      writeFileSync(blocker, "");

      const error = expectErr(acquireHubLock(join(blocker, "msgr.db")));
      expect(HubLockFailed.is(error)).toBe(true);
      expect(HubAlreadyRunning.is(error)).toBe(false);
      expect(error.message).not.toContain("already using");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hub refusing to start says which problem it hit", () => {
    const root = mkdtempSync(join(tmpdir(), "msgr-blocked-"));
    try {
      const blocker = join(root, "not-a-directory");
      writeFileSync(blocker, "");

      const started = startHub({
        port: 0,
        databasePath: join(blocker, "msgr.db"),
        allowedOrigin: `http://${HOST}:0`,
        pushAvailable: false,
        webRoot: join(root, "no-web-root"),
      });
      expect(started.isErr()).toBe(true);
      expect(expectErr(started).message).toContain("Cannot create the directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("an in-memory database", () => {
  test("needs no lock file, because no other process can share it", () => {
    const lock = expectOk(acquireHubLock(IN_MEMORY));
    expect(existsSync(`${IN_MEMORY}.lock`)).toBe(false);
    lock.release();

    // And a second one is not refused, since there is nothing to contend for.
    expectOk(acquireHubLock(IN_MEMORY)).release();
  });
});
