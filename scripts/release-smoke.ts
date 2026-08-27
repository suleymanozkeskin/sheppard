import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { MSGR_WRAPPER_MARKER } from "../src/distribution";

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    // The error below gives one stable release action.
  }
  throw new Error(`${label} is missing from ${basename(path)}.`);
}

async function command(command: readonly string[], env?: Record<string, string | undefined>): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn({
    cmd: command,
    env: env === undefined ? Bun.env : { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

async function main(): Promise<void> {
  const releaseDirectoryArgument = Bun.argv[2];
  if (releaseDirectoryArgument === undefined) {
    throw new Error("Usage: bun scripts/release-smoke.ts <release-directory>");
  }

  const releaseDirectory = resolve(releaseDirectoryArgument);
  const sheppard = join(releaseDirectory, "sheppard");
  const msgr = join(releaseDirectory, "msgr");
  for (const file of ["LICENSE", "README.md", "SKILL.md", "product-definition.md"] as const) {
    await requireFile(join(releaseDirectory, file), file);
  }
  await requireFile(sheppard, "sheppard executable");
  await requireFile(msgr, "msgr wrapper");

  const wrapper = await readFile(msgr, "utf8");
  if (!wrapper.includes(MSGR_WRAPPER_MARKER)) throw new Error("The msgr wrapper marker is missing.");

  const version = await command([sheppard, "--version"]);
  if (version.code !== 0 || version.stdout.trim() !== `sheppard ${packageMetadata.version}`) {
    throw new Error(`The standalone version check failed: ${version.stderr.trim() || version.stdout.trim()}`);
  }

  const help = await command([msgr, "help"]);
  if (help.code !== 0 || !help.stdout.includes("msgr — a messenger for agents running inside herdr")) {
    throw new Error(`The msgr wrapper check failed: ${help.stderr.trim() || help.stdout.trim()}`);
  }

  const scratch = await mkdtemp(join(tmpdir(), "sheppard-release-smoke-"));
  try {
    const installDirectory = join(scratch, "bin");
    const databasePath = join(scratch, "data", "msgr.db");
    await cp(releaseDirectory, installDirectory, { recursive: true });
    await mkdir(join(scratch, "data"), { recursive: true });
    await writeFile(databasePath, "kept data");

    const uninstall = await command(
      [join(installDirectory, "sheppard"), "uninstall", "--yes"],
      { MSGR_DB: databasePath },
    );
    if (uninstall.code !== 0) throw new Error(`The standalone uninstall check failed: ${uninstall.stderr.trim() || uninstall.stdout.trim()}`);
    if (await Bun.file(join(installDirectory, "sheppard")).exists()) throw new Error("Uninstall kept the sheppard executable.");
    if (await Bun.file(join(installDirectory, "msgr")).exists()) throw new Error("Uninstall kept the msgr wrapper.");
    if (!await Bun.file(databasePath).exists()) throw new Error("Uninstall removed user data.");
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }

  console.log(`Release smoke checks passed for Sheppard ${packageMetadata.version}.`);
}

await main();
