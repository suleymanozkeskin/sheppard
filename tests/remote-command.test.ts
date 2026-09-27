import { afterEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { runRemote } from "../src/remote-command";
import { Store } from "../src/store";
import {
  TailscaleFailed,
  parseTailscaleStatus,
  type TailscalePort,
  type TailscaleSelf,
} from "../src/tailscale";
import { expectErr, expectOk } from "./support";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "Mac.tail1234.ts.net.", UserID: 42 },
  User: { "42": { LoginName: "owner@example.com" } },
});

class FakeTailscale implements TailscalePort {
  readonly calls: string[] = [];
  selfResult: Result<TailscaleSelf, TailscaleFailed> = Result.ok({
    host: "mac.tail1234.ts.net",
    ownerLogin: "owner@example.com",
  });
  serveOnResult: Result<void, TailscaleFailed> = Result.ok();

  self(): Promise<Result<TailscaleSelf, TailscaleFailed>> {
    this.calls.push("self");
    return Promise.resolve(this.selfResult);
  }

  serveOn(port: number): Promise<Result<void, TailscaleFailed>> {
    this.calls.push(`serve on ${port}`);
    return Promise.resolve(this.serveOnResult);
  }

  serveOff(port: number): Promise<Result<void, TailscaleFailed>> {
    this.calls.push(`serve off ${port}`);
    return Promise.resolve(Result.ok());
  }
}

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sheppard-remote-"));
  directories.push(directory);
  const config: ServerConfig = loadConfig({ MSGR_DB: join(directory, "msgr.db"), MSGR_PORT: "6747" });
  const lines: string[] = [];
  const output = { write: (line: string) => lines.push(line), fail: (line: string) => lines.push(`! ${line}`) };
  const read = <T>(body: (store: Store) => T): T => {
    const db = openDatabase(config.databasePath).unwrap("db");
    try {
      return body(new Store(db));
    } finally {
      db.close();
    }
  };
  return { config, lines, output, read, tailscale: new FakeTailscale() };
}

describe("parseTailscaleStatus", () => {
  test("reads the MagicDNS name without its dot and the owner's login", () => {
    expect(expectOk(parseTailscaleStatus(STATUS))).toEqual({
      host: "mac.tail1234.ts.net",
      ownerLogin: "owner@example.com",
    });
  });

  test("names a stopped daemon and a reply that is not JSON", () => {
    const stopped = JSON.stringify({ BackendState: "Stopped" });
    expect(expectErr(parseTailscaleStatus(stopped)).reason).toBe("not-running");
    expect(expectErr(parseTailscaleStatus("nope")).reason).toBe("reply-invalid");
  });
});

describe("sheppard remote", () => {
  test("enable serves the hub port and stores the host and login", async () => {
    const { config, lines, output, read, tailscale } = setup();
    expect(await runRemote(["enable"], config, tailscale, output)).toBe(0);
    expect(tailscale.calls).toEqual(["self", "serve on 6747"]);
    expect(read((store) => store.remoteAccess())).toMatchObject({
      kind: "on",
      host: "mac.tail1234.ts.net",
      ownerLogin: "owner@example.com",
    });
    expect(lines[0]).toBe("Remote access is on at https://mac.tail1234.ts.net.");
  });

  test("enable stores nothing when Tailscale cannot serve", async () => {
    const { config, output, read, tailscale } = setup();
    tailscale.serveOnResult = Result.err(new TailscaleFailed({ reason: "call-failed", message: "no HTTPS" }));
    expect(await runRemote(["enable"], config, tailscale, output)).toBe(1);
    expect(read((store) => store.remoteAccess())).toEqual({ kind: "off" });
  });

  test("disable signs out paired devices and removes the mount", async () => {
    const { config, lines, output, read, tailscale } = setup();
    await runRemote(["enable"], config, tailscale, output);
    read((store) => {
      const human = expectOk(store.createHuman("human")).participant.id;
      store.createPairingCode(human, "ABCDEFGH");
      expectOk(store.redeemPairingCode("ABCDEFGH"));
    });

    expect(await runRemote(["disable"], config, tailscale, output)).toBe(0);
    expect(tailscale.calls.at(-1)).toBe("serve off 6747");
    expect(read((store) => store.remoteAccess())).toEqual({ kind: "off" });
    expect(lines).toContain("Remote access is off. 1 paired device was signed out.");
  });

  test("status reports off, then the address and devices", async () => {
    const { config, lines, output, tailscale } = setup();
    expect(await runRemote(["status"], config, tailscale, output)).toBe(0);
    await runRemote(["enable"], config, tailscale, output);
    await runRemote(["status"], config, tailscale, output);
    expect(lines).toContain("Remote access is off.");
    expect(lines).toContain("Remote access is on at https://mac.tail1234.ts.net for owner@example.com.");
    expect(lines).toContain("No device is paired.");
  });

  test("an unknown subcommand prints usage", async () => {
    const { config, output, tailscale } = setup();
    expect(await runRemote(["open"], config, tailscale, output)).toBe(2);
    expect(await runRemote(["enable", "now"], config, tailscale, output)).toBe(2);
  });
});
