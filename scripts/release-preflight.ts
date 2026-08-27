import { stat } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    // The error below gives the maintainer one stable action.
  }
  throw new Error(`${label} is required before a public release.`);
}

async function main(): Promise<void> {
  const repositoryRoot = join(import.meta.dir, "..");
  await requireFile(join(repositoryRoot, "LICENSE"), "LICENSE");

  if (packageMetadata.license !== "MIT") {
    throw new Error("package.json must declare the MIT license.");
  }
  const packageManager = /^bun@(.+)$/u.exec(packageMetadata.packageManager)?.[1];
  if (packageManager === undefined) throw new Error("package.json must pin Bun with packageManager.");
  if (Bun.version !== packageManager) {
    throw new Error(`Bun ${packageManager} is required; detected ${Bun.version}.`);
  }

  const tag = Bun.env.RELEASE_TAG;
  if (tag === undefined || tag.length === 0) throw new Error("RELEASE_TAG is required.");
  const expectedTag = `v${packageMetadata.version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match package version ${packageMetadata.version}.`);
  }
  if (Bun.env.GITHUB_ACTIONS === "true" && Bun.env.REPOSITORY_VISIBILITY !== "public") {
    throw new Error("The GitHub repository must be public before a release.");
  }
  if (Bun.env.REQUIRE_MACOS_SIGNING === "true") {
    const requiredSecrets = [
      "MACOS_CERTIFICATE_BASE64",
      "MACOS_CERTIFICATE_PASSWORD",
      "MACOS_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_APP_PASSWORD",
      "APPLE_TEAM_ID",
    ] as const;
    const missing = requiredSecrets.filter((name) => Bun.env[name] === undefined || Bun.env[name]?.length === 0);
    if (missing.length > 0) throw new Error(`Missing release secrets: ${missing.join(", ")}.`);
  }
  console.log(`Release preflight passed for ${tag}.`);
}

await main();
