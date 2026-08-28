import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ServerConfig } from "./config";
import { activeHubPid } from "./lock";

const RELEASE_DOWNLOAD_ROOT =
  "https://github.com/suleymanozkeskin/sheppard/releases/latest/download";

function releaseDownloadRoot(): string {
  return Bun.env.SHEPPARD_RELEASE_ROOT ?? RELEASE_DOWNLOAD_ROOT;
}

export const MSGR_WRAPPER_MARKER = "sheppard-msgr-wrapper-v1";

export type SheppardDistribution =
  | { kind: "source" }
  | { executablePath: string; kind: "standalone" };

export interface DistributionOutput {
  fail: (line: string) => void;
  write: (line: string) => void;
}

type ReleaseTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

interface DownloadedRelease {
  binaryPath: string;
  directory: string;
  version: string;
}

function releaseTarget(): ReleaseTarget | null {
  switch (process.platform) {
    case "darwin":
      switch (process.arch) {
        case "arm64":
          return "darwin-arm64";
        case "x64":
          return "darwin-x64";
        default:
          return null;
      }
    case "linux":
      switch (process.arch) {
        case "arm64":
          return "linux-arm64";
        case "x64":
          return "linux-x64";
        default:
          return null;
      }
    default:
      return null;
  }
}

async function download(url: string, description: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "sheppard-updater" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${description} download failed with HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function checksumFor(text: string, filename: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === filename) return match[1] ?? null;
  }
  return null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionFromOutput(output: string): string | null {
  return /^sheppard ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/u.exec(output.trim())?.[1] ?? null;
}

function releaseVersionParts(version: string): [number, number, number] | null {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)/u.exec(version);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [Number(major), Number(minor), Number(patch)];
}

function compareVersions(left: string, right: string): number {
  const leftParts = releaseVersionParts(left);
  const rightParts = releaseVersionParts(right);
  if (leftParts === null || rightParts === null) return left.localeCompare(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const leftPrerelease = left.includes("-");
  const rightPrerelease = right.includes("-");
  if (leftPrerelease === rightPrerelease) return left.localeCompare(right);
  return leftPrerelease ? -1 : 1;
}

async function binaryVersion(path: string): Promise<string> {
  const child = Bun.spawn({ cmd: [path, "--version"], stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`The downloaded executable failed its version check: ${stderr.trim()}`);
  const version = versionFromOutput(stdout);
  if (version === null) throw new Error("The downloaded executable returned an invalid version.");
  return version;
}

async function downloadedRelease(): Promise<DownloadedRelease> {
  const target = releaseTarget();
  if (target === null) throw new Error(`Sheppard does not publish an update for ${process.platform} ${process.arch}.`);

  const filename = `sheppard-${target}.tar.gz`;
  const downloadRoot = releaseDownloadRoot();
  const directory = await mkdtemp(join(tmpdir(), "sheppard-update-"));
  try {
    const archivePath = join(directory, filename);
    const [archive, checksumBytes] = await Promise.all([
      download(`${downloadRoot}/${filename}`, "Release"),
      download(`${downloadRoot}/checksums.txt`, "Checksum"),
    ]);
    const expected = checksumFor(new TextDecoder().decode(checksumBytes), filename);
    if (expected === null) throw new Error(`checksums.txt does not contain ${filename}.`);
    const actual = sha256(archive);
    if (actual !== expected) throw new Error(`Checksum verification failed for ${filename}.`);

    await Bun.write(archivePath, archive);
    const extractedDirectory = join(directory, "release");
    await mkdir(extractedDirectory);
    const extraction = Bun.spawn({
      cmd: ["tar", "-xzf", archivePath, "-C", extractedDirectory],
      stderr: "pipe",
      stdout: "ignore",
    });
    const [exitCode, extractionError] = await Promise.all([
      extraction.exited,
      new Response(extraction.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Cannot extract the release: ${extractionError.trim()}`);

    const binaryPath = join(extractedDirectory, "sheppard");
    await chmod(binaryPath, 0o755);
    const version = await binaryVersion(binaryPath);
    return { binaryPath, directory, version };
  } catch (cause) {
    await rm(directory, { force: true, recursive: true });
    throw cause;
  }
}

function homebrewManaged(path: string): boolean {
  return path.includes("/Cellar/sheppard/") || path.includes("/Homebrew/Cellar/sheppard/");
}

function sourceInstallAction(action: "update" | "uninstall"): string {
  switch (action) {
    case "update":
      return "This is a source installation. Update the repository, then rebuild Sheppard.";
    case "uninstall":
      return "This is a source installation. Remove its global link with `bun unlink` from the repository root.";
  }
}

function stoppedHub(config: ServerConfig, output: DistributionOutput): boolean {
  const pid = activeHubPid(config.databasePath);
  if (pid === null) return true;
  output.fail(`Sheppard is running as process ${pid}. Run \`sheppard stop\`, then run this command again.`);
  return false;
}

export async function updateSheppard(
  distribution: SheppardDistribution,
  currentVersion: string,
  config: ServerConfig,
  output: DistributionOutput,
): Promise<number> {
  if (distribution.kind === "source") {
    output.fail(sourceInstallAction("update"));
    return 1;
  }
  if (!stoppedHub(config, output)) return 1;

  const executablePath = await realpath(distribution.executablePath);
  if (homebrewManaged(executablePath)) {
    output.fail("Homebrew manages this installation. Run `brew upgrade sheppard`.");
    return 1;
  }

  output.write("Checking the latest Sheppard release…");
  let release: DownloadedRelease | null = null;
  let stagedPath: string | null = null;
  try {
    release = await downloadedRelease();
    const comparison = compareVersions(release.version, currentVersion);
    if (comparison === 0) {
      output.write(`Sheppard ${currentVersion} is current.`);
      return 0;
    }
    if (comparison < 0) {
      output.fail(`The latest published release is ${release.version}; this build is ${currentVersion}.`);
      return 1;
    }

    stagedPath = join(dirname(executablePath), `.sheppard-update-${process.pid}`);
    await copyFile(release.binaryPath, stagedPath);
    await chmod(stagedPath, 0o755);
    await rename(stagedPath, executablePath);
    output.write(`Updated Sheppard ${currentVersion} to ${release.version}.`);
    return 0;
  } catch (cause) {
    output.fail(cause instanceof Error ? cause.message : "The update failed.");
    return 1;
  } finally {
    if (stagedPath !== null) await rm(stagedPath, { force: true });
    if (release !== null) await rm(release.directory, { force: true, recursive: true });
  }
}

async function confirmedUninstall(assumeYes: boolean, executablePath: string): Promise<boolean> {
  if (assumeYes) return true;
  if (process.stdin.isTTY !== true) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Remove ${executablePath}? [y/N] `);
    return answer.trim().toLocaleLowerCase() === "y";
  } finally {
    terminal.close();
  }
}

async function removeMsgrWrapper(directory: string): Promise<boolean> {
  const wrapperPath = join(directory, "msgr");
  try {
    const wrapper = await readFile(wrapperPath, "utf8");
    if (!wrapper.includes(MSGR_WRAPPER_MARKER)) return false;
    await unlink(wrapperPath);
    return true;
  } catch {
    return false;
  }
}

export async function uninstallSheppard(
  distribution: SheppardDistribution,
  config: ServerConfig,
  assumeYes: boolean,
  output: DistributionOutput,
): Promise<number> {
  if (distribution.kind === "source") {
    output.fail(sourceInstallAction("uninstall"));
    return 1;
  }
  if (!stoppedHub(config, output)) return 1;

  const executablePath = await realpath(distribution.executablePath);
  if (homebrewManaged(executablePath)) {
    output.fail("Homebrew manages this installation. Run `brew uninstall sheppard`.");
    return 1;
  }
  if (basename(executablePath) !== "sheppard") {
    output.fail(`Refusing to remove an executable not named sheppard: ${executablePath}`);
    return 1;
  }
  if (!await confirmedUninstall(assumeYes, executablePath)) {
    output.fail(process.stdin.isTTY === true ? "Uninstall cancelled." : "Use `sheppard uninstall --yes` without an interactive terminal.");
    return 1;
  }

  try {
    await unlink(executablePath);
    const wrapperRemoved = await removeMsgrWrapper(dirname(executablePath));
    output.write(`Removed ${executablePath}.`);
    if (wrapperRemoved) output.write("Removed the msgr launcher.");
    output.write(`Data was kept at ${config.databasePath}.`);
    return 0;
  } catch (cause) {
    output.fail(cause instanceof Error ? cause.message : "The uninstall failed.");
    return 1;
  }
}
