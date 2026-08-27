import { bunVersionMismatch } from "../src/bun-version.ts"

const mismatch = bunVersionMismatch(Bun.version)

if (mismatch !== null) {
  console.error(`Bun version preflight failed: ${mismatch}`)
  process.exit(1)
}

console.log(`Bun version preflight passed: ${Bun.version}`)
