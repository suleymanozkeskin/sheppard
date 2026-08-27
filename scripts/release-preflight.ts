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

  const tag = Bun.env.RELEASE_TAG;
  if (tag === undefined || tag.length === 0) throw new Error("RELEASE_TAG is required.");
  const expectedTag = `v${packageMetadata.version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match package version ${packageMetadata.version}.`);
  }
  console.log(`Release preflight passed for ${tag}.`);
}

await main();

