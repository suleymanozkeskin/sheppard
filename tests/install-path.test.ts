import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SCRIPT = join(import.meta.dir, "..", "install.sh");

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function pathReport(pathEntries: readonly string[], installDirectory: string): Promise<string> {
  const child = Bun.spawn({
    cmd: ["sh", INSTALL_SCRIPT],
    env: {
      ...Bun.env,
      PATH: pathEntries.join(":"),
      SHEPPARD_INSTALL_DIR: installDirectory,
      SHEPPARD_INSTALL_PATH_CHECK: "1",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

describe("install.sh command lookup", () => {
  test("names an earlier sheppard and msgr", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheppard-install-path-"));
    try {
      const installed = join(root, "installed");
      const earlier = join(root, "earlier");
      mkdirSync(installed);
      mkdirSync(earlier);
      executable(join(installed, "sheppard"), "#!/bin/sh\necho sheppard 0.1.3\n");
      executable(join(installed, "msgr"), "#!/bin/sh\nexit 0\n");
      executable(join(earlier, "sheppard"), "#!/bin/sh\necho sheppard 0.1.1\n");
      executable(join(earlier, "msgr"), "#!/bin/sh\nexit 0\n");

      const stdout = await pathReport([earlier, installed, "/bin", "/usr/bin"], installed);

      expect(stdout).toBe(
        [
          `The command sheppard runs ${earlier}/sheppard.`,
          "That command reports sheppard 0.1.1.",
          `The command msgr runs ${earlier}/msgr.`,
          `Run ${installed}/sheppard.`,
          `Put ${installed} before ${earlier} on PATH.`,
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("accepts a symlink to the installed command", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheppard-install-path-"));
    try {
      const installed = join(root, "installed");
      const linked = join(root, "linked");
      mkdirSync(installed);
      mkdirSync(linked);
      executable(join(installed, "sheppard"), "#!/bin/sh\necho sheppard 0.1.3\n");
      executable(join(installed, "msgr"), "#!/bin/sh\nexit 0\n");
      symlinkSync(join(installed, "sheppard"), join(linked, "sheppard"));
      symlinkSync(join(installed, "msgr"), join(linked, "msgr"));

      const stdout = await pathReport([linked, "/bin", "/usr/bin"], installed);

      expect(stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("tells the operator to add a missing install directory to PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheppard-install-path-"));
    try {
      const installed = join(root, "installed");
      mkdirSync(installed);

      const stdout = await pathReport(["/bin", "/usr/bin"], installed);

      expect(stdout).toBe(`Add ${installed} to PATH, then run: sheppard\n`);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("stays quiet when the installed commands come first", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheppard-install-path-"));
    try {
      const installed = join(root, "installed");
      const later = join(root, "later");
      mkdirSync(installed);
      mkdirSync(later);
      executable(join(installed, "sheppard"), "#!/bin/sh\necho sheppard 0.1.3\n");
      executable(join(installed, "msgr"), "#!/bin/sh\nexit 0\n");
      executable(join(later, "sheppard"), "#!/bin/sh\necho sheppard 0.1.1\n");
      executable(join(later, "msgr"), "#!/bin/sh\nexit 0\n");

      const stdout = await pathReport([installed, later, "/bin", "/usr/bin"], installed);

      expect(stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
