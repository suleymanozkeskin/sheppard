import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config";
import { MSGR_WRAPPER_MARKER, uninstallSheppard, updateSheppard, type DistributionOutput } from "../src/distribution";
import { runSheppard } from "../src/sheppard";
import { SHEPPARD_VERSION } from "../src/version";

const scratchDirectories = new Set<string>();
const originalReleaseRoot = Bun.env.SHEPPARD_RELEASE_ROOT;

interface OutputCapture {
  errors: string[];
  lines: string[];
  value: DistributionOutput;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sheppard-distribution-"));
  scratchDirectories.add(directory);
  return directory;
}

function config(databasePath: string): ServerConfig {
  return {
    allowExtraHumans: false,
    allowedOrigin: "http://127.0.0.1:6747",
    databasePath,
    herdrSocketPath: null,
    port: 6747,
    pushAvailable: false,
    webRoot: "/unused",
  };
}

function output(): OutputCapture {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    value: {
      fail: (line) => errors.push(line),
      write: (line) => lines.push(line),
    },
  };
}

function releaseTarget(): string {
  switch (`${process.platform}-${process.arch}`) {
    case "darwin-arm64":
      return "darwin-arm64";
    case "darwin-x64":
      return "darwin-x64";
    case "linux-arm64":
      return "linux-arm64";
    case "linux-x64":
      return "linux-x64";
    default:
      throw new Error(`Unsupported test target: ${process.platform} ${process.arch}`);
  }
}

afterEach(() => {
  for (const directory of scratchDirectories) rmSync(directory, { force: true, recursive: true });
  scratchDirectories.clear();
  if (originalReleaseRoot === undefined) delete Bun.env.SHEPPARD_RELEASE_ROOT;
  else Bun.env.SHEPPARD_RELEASE_ROOT = originalReleaseRoot;
});

describe("standalone distribution", () => {
  test("prints the installed version", async () => {
    const result = output();
    expect(await runSheppard({ argv: ["--version"], output: result.value })).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([`sheppard ${SHEPPARD_VERSION}`]);
  });

  test("stops the hub process recorded for the configured database", async () => {
    const result = output();
    const databasePath = join(scratchDirectory(), "msgr.db");
    let activePid: number | null = 4512;
    const signals: number[] = [];

    expect(await runSheppard({
      argv: ["stop"],
      env: { ...Bun.env, MSGR_DB: databasePath },
      output: result.value,
      processControl: {
        activeHubPid: () => activePid,
        signal: (pid) => { signals.push(pid); },
        wait: async () => { activePid = null; },
      },
    })).toBe(0);

    expect(signals).toEqual([4512]);
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual(["Sheppard stopped."]);
  });

  test("reports success when Sheppard is not running", async () => {
    const result = output();

    expect(await runSheppard({
      argv: ["stop"],
      output: result.value,
      processControl: {
        activeHubPid: () => null,
        signal: () => { throw new Error("signal must not run"); },
        wait: async () => { throw new Error("wait must not run"); },
      },
    })).toBe(0);

    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual(["Sheppard is not running."]);
  });

  test("installs a newer release after checksum and version checks", async () => {
    const root = scratchDirectory();
    const payload = join(root, "payload");
    const archive = join(root, `sheppard-${releaseTarget()}.tar.gz`);
    const executablePath = join(root, "bin", "sheppard");
    mkdirSync(payload);
    mkdirSync(join(root, "bin"));
    writeFileSync(join(payload, "sheppard"), "#!/bin/sh\necho 'sheppard 0.2.0'\n");
    chmodSync(join(payload, "sheppard"), 0o755);
    const tar = Bun.spawn({ cmd: ["tar", "-czf", archive, "-C", payload, "."], stderr: "pipe", stdout: "ignore" });
    expect(await tar.exited).toBe(0);
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const checksumText = `${checksum}  ${archive.split("/").at(-1)}\n`;

    const server = Bun.serve({
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/checksums.txt")) return new Response(checksumText);
        if (pathname.endsWith(".tar.gz")) return new Response(Bun.file(archive));
        return new Response("Not found", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    Bun.env.SHEPPARD_RELEASE_ROOT = `${server.url.protocol}//${server.url.host}`;
    writeFileSync(executablePath, "#!/bin/sh\necho 'sheppard 0.1.0'\n");
    chmodSync(executablePath, 0o755);
    const result = output();

    try {
      expect(await updateSheppard(
        { executablePath, kind: "standalone" },
        "0.1.0",
        config(join(root, "data", "msgr.db")),
        result.value,
      )).toBe(0);
    } finally {
      server.stop(true);
    }

    expect(result.errors).toEqual([]);
    expect(result.lines).toContain("Updated Sheppard 0.1.0 to 0.2.0.");
    const installed = Bun.spawn({ cmd: [executablePath, "--version"], stderr: "pipe", stdout: "pipe" });
    expect(await installed.exited).toBe(0);
    expect((await new Response(installed.stdout).text()).trim()).toBe("sheppard 0.2.0");
  });

  test("removes standalone commands and keeps user data", async () => {
    const root = scratchDirectory();
    const executablePath = join(root, "bin", "sheppard");
    const wrapperPath = join(root, "bin", "msgr");
    const databasePath = join(root, "data", "msgr.db");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "data"));
    writeFileSync(executablePath, "standalone executable");
    writeFileSync(wrapperPath, `#!/bin/sh\n# ${MSGR_WRAPPER_MARKER}\n`);
    writeFileSync(databasePath, "kept data");
    const result = output();

    expect(await uninstallSheppard(
      { executablePath, kind: "standalone" },
      config(databasePath),
      true,
      result.value,
    )).toBe(0);

    expect(result.errors).toEqual([]);
    expect(existsSync(executablePath)).toBe(false);
    expect(existsSync(wrapperPath)).toBe(false);
    expect(existsSync(databasePath)).toBe(true);
    expect(result.lines).toContain(`Data was kept at ${databasePath}.`);
  });
});
