import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "bun:test"

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, relativePath), "utf8")
}

describe("route-based spawn implementation", () => {
  it("keeps the active spawn files free of native selectors and the removed dialog", () => {
    const app = source("../../App.tsx")
    const staffingPages = source("../staffing-pages.tsx")
    const spawnPage = source("spawn-page.tsx")
    const spawnSections = source("spawn-sections.tsx")

    expect(app).not.toContain("SpawnAgentDialog")
    expect(app).not.toContain('id="spawn-agent-launcher"')
    expect(app).not.toContain('id="spawn-agent-role"')
    for (const activeSpawnSource of [staffingPages, spawnPage, spawnSections]) {
      expect(activeSpawnSource).not.toContain("<select")
    }
  })
})
