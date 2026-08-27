import { describe, expect, it } from "bun:test"

import type { DeviceCatalogue, Launcher } from "@/api/types"
import { isRoleRuntimeValid, roleCatalogueNeedsRefresh, roleRuntimeStaleFields, type RoleRuntimeMetadataState, type RoleRuntimeValues } from "./role-runtime-logic"

const launchers: Launcher[] = [
  { agentKind: "codex", argv: ["codex"], envKeys: [], name: "codex-main", startTimeoutMs: 35_000 },
  { agentKind: "claude", argv: ["claude"], envKeys: [], name: "claude-main", startTimeoutMs: 35_000 },
]

const catalogue: DeviceCatalogue = {
  launcher: "codex-main",
  checkedAt: null,
  error: null,
  executableAvailable: true,
  fetchedAt: null,
  freshUntil: null,
  harness: "codex",
  models: [{ default: true, description: "A device model.", efforts: [{ default: true, description: "Balanced.", name: "medium" }], label: "Codex model", name: "gpt-5", resolvedModel: null }],
  revision: 1,
  status: "ready",
}

const values: RoleRuntimeValues = { effort: "medium", harness: "codex", launcher: "codex-main", model: "gpt-5" }
const ready: RoleRuntimeMetadataState = { catalogues: [catalogue], launchers, status: "ready" }

describe("role runtime defaults", () => {
  it("allows a fully neutral role when metadata is unavailable", () => {
    const neutral: RoleRuntimeValues = { effort: "", harness: "", launcher: "", model: "" }
    expect(isRoleRuntimeValid(neutral, { catalogues: [], launchers: [], message: "catalogue unavailable", status: "error" })).toBe(true)
    expect(isRoleRuntimeValid(neutral, { catalogues: [], launchers: [], status: "loading" })).toBe(true)
  })

  it("requires exact current catalogue values for non-neutral defaults", () => {
    expect(isRoleRuntimeValid(values, ready)).toBe(true)
    expect(isRoleRuntimeValid({ ...values, effort: "high" }, ready)).toBe(false)
    expect(isRoleRuntimeValid({ ...values, model: "old-model" }, ready)).toBe(false)
  })

  it("reports saved values that are not in current metadata", () => {
    expect(roleRuntimeStaleFields({ ...values, launcher: "old-launcher" }, ready)).toMatchObject({ launcher: expect.any(String) })
    expect(roleRuntimeStaleFields({ ...values, model: "old-model", effort: "old-effort" }, ready)).toMatchObject({ model: expect.any(String), effort: expect.any(String) })
  })

  it("refreshes only the selected launcher when its catalogue is missing or stale", () => {
    expect(roleCatalogueNeedsRefresh(ready, "codex-main")).toBe(false)
    expect(roleCatalogueNeedsRefresh({ ...ready, catalogues: [] }, "claude-main")).toBe(true)
    expect(roleCatalogueNeedsRefresh({ ...ready, catalogues: [{ ...catalogue, status: "stale" }] }, "codex-main")).toBe(true)
    expect(roleCatalogueNeedsRefresh({ ...ready, catalogues: [{ ...catalogue, launcher: "claude-main", harness: "claude", status: "unavailable" }] }, "claude-main")).toBe(true)
    expect(roleCatalogueNeedsRefresh({ ...ready, catalogues: [] }, "claude-main", true)).toBe(false)
    expect(roleCatalogueNeedsRefresh({ ...ready, catalogues: [] }, "claude-main", false, true)).toBe(false)
  })
})
