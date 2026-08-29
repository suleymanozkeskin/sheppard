import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { MSGR_WRAPPER_MARKER } from "../src/distribution";

interface TargetConfig {
  bunTarget: Bun.Build.Target;
  name: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
}

function targetConfig(name: string | undefined): TargetConfig | null {
  switch (name) {
    case "darwin-arm64":
      return { bunTarget: "bun-darwin-arm64", name };
    case "darwin-x64":
      return { bunTarget: "bun-darwin-x64-baseline", name };
    case "linux-arm64":
      return { bunTarget: "bun-linux-arm64", name };
    case "linux-x64":
      return { bunTarget: "bun-linux-x64-baseline", name };
    default:
      return null;
  }
}

function requestedTarget(argv: readonly string[]): TargetConfig {
  const targetIndex = argv.indexOf("--target");
  const configured = targetConfig(targetIndex === -1 ? undefined : argv[targetIndex + 1]);
  if (configured !== null) return configured;
  throw new Error("Usage: bun scripts/build-release.ts --target <darwin-arm64|darwin-x64|linux-arm64|linux-x64>");
}

async function run(command: readonly string[], description: string): Promise<void> {
  const process = Bun.spawn({ cmd: command, stderr: "inherit", stdout: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${description} failed with exit code ${exitCode}.`);
}

async function buildMacOsDictationHelper(
  target: TargetConfig,
  repositoryRoot: string,
  targetRoot: string,
): Promise<void> {
  if (!target.name.startsWith("darwin-")) return;
  const helperPath = join(targetRoot, "sheppard-dictation");
  const nativeRoot = join(repositoryRoot, "native");
  await run([
    "xcrun",
    "clang",
    "-fobjc-arc",
    "-fblocks",
    "-mmacosx-version-min=12.0",
    "-framework",
    "Foundation",
    "-framework",
    "Speech",
    join(nativeRoot, "macos-dictation.m"),
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    join(nativeRoot, "macos-dictation.plist"),
    "-o",
    helperPath,
  ], "macOS dictation helper build");
  await run([
    "codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.sheppard.dictation",
    helperPath,
  ], "macOS dictation helper signing");
  await chmod(helperPath, 0o755);
}

async function filesBelow(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    switch (entry.isDirectory()) {
      case true:
        files.push(...await filesBelow(root, path));
        break;
      case false:
        if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
        break;
    }
  }
  return files;
}

function generatedEntry(files: readonly string[]): string {
  const imports = files.map((file, index) =>
    `import webAsset${index} from ${JSON.stringify(`../web/dist/${file}`)} with { type: "file" };`,
  );
  const entries = files.map((file, index) => `  [${JSON.stringify(`/${file}`)}, webAsset${index}],`);
  return `${imports.join("\n")}
import { main } from "../src/sheppard";

const webAssets = new Map<string, string>([
${entries.join("\n")}
]);

await main({
  argv: Bun.argv.slice(2),
  distribution: { executablePath: process.execPath, kind: "standalone" },
  webAssets,
});
`;
}

function msgrWrapper(): string {
  return `#!/bin/sh
# ${MSGR_WRAPPER_MARKER}
exec "$(dirname "$0")/sheppard" msgr "$@"
`;
}

async function main(): Promise<void> {
  const target = requestedTarget(Bun.argv.slice(2));
  const repositoryRoot = join(import.meta.dir, "..");
  const webRoot = join(repositoryRoot, "web", "dist");
  const generatedRoot = join(repositoryRoot, ".release-build");
  const releaseRoot = join(repositoryRoot, "release");
  const targetRoot = join(releaseRoot, `sheppard-${target.name}`);
  const binaryPath = join(targetRoot, "sheppard");

  await run(["bun", "run", "--cwd", "web", "build"], "Web build");
  const webFiles = await filesBelow(webRoot);
  if (!webFiles.includes("index.html")) throw new Error("The web build did not create index.html.");

  await rm(generatedRoot, { force: true, recursive: true });
  await rm(targetRoot, { force: true, recursive: true });
  await mkdir(generatedRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await buildMacOsDictationHelper(target, repositoryRoot, targetRoot);
  const entryPath = join(generatedRoot, "standalone-entry.ts");
  await writeFile(entryPath, generatedEntry(webFiles));

  const build = await Bun.build({
    compile: { outfile: binaryPath, target: target.bunTarget },
    entrypoints: [entryPath],
    minify: true,
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error(`Standalone build failed for ${target.name}.`);
  }

  await writeFile(join(targetRoot, "msgr"), msgrWrapper());
  await copyFile(join(repositoryRoot, "README.md"), join(targetRoot, "README.md"));
  await copyFile(
    join(repositoryRoot, "product-definition.md"),
    join(targetRoot, "product-definition.md"),
  );
  await copyFile(join(repositoryRoot, "SKILL.md"), join(targetRoot, "SKILL.md"));
  await cp(join(repositoryRoot, "docs"), join(targetRoot, "docs"), { recursive: true });
  await copyFile(join(repositoryRoot, "LICENSE"), join(targetRoot, "LICENSE"));
  await chmod(binaryPath, 0o755);
  await chmod(join(targetRoot, "msgr"), 0o755);

  const archivePath = join(releaseRoot, `sheppard-${target.name}.tar.gz`);
  await rm(archivePath, { force: true });
  await run(["tar", "-czf", archivePath, "-C", targetRoot, "."], "Release archive");
  await rm(generatedRoot, { force: true, recursive: true });
  console.log(`Built ${archivePath}`);
}

await main();
