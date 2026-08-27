import { describe, expect, it } from "bun:test"

import type { DeviceCatalogue, DeviceModelEntry, RolePreset } from "@/api/types"
import {
  NO_ROLE_VALUE,
  buildSpawnAgentRequest,
  createSpawnSelectionState,
  reduceSpawnSelection,
  resolveSpawnDefaults,
} from "./spawn-state"

const effort = (name: string, isDefault = false) => ({ default: isDefault, description: null, name })

function catalogue(models: DeviceModelEntry[], status: DeviceCatalogue["status"] = "ready", launcher = "claude-main", harness = "claude"): DeviceCatalogue {
  return { checkedAt: null, error: null, executableAvailable: true, fetchedAt: null, freshUntil: null, harness, launcher, models, revision: 1, status }
}

const defaultModel: DeviceModelEntry = { default: true, description: null, efforts: [effort("medium", true), effort("high")], label: "Default", name: "opus", resolvedModel: null }

describe("spawn state", () => {
  it("uses worker for the default route and omits the no-role sentinel", () => {
    expect(createSpawnSelectionState(undefined, "w1").roleName).toBe("worker")
    const selection = createSpawnSelectionState("", "w1")
    expect(selection.roleName).toBe(NO_ROLE_VALUE)
    const result = buildSpawnAgentRequest({ currentCatalogue: true, effort: "", modelName: "opus", roleBriefingPresent: false, selectedCatalogue: catalogue([defaultModel]), selectedModel: { ...defaultModel, efforts: [] }, selection: { ...selection, handle: "manual", harness: "claude", launcher: "claude-main" }, targetWorkspaceId: "w1" })
    expect(result).toEqual({ ok: true, request: { handle: "manual", launcher: "claude-main", model: "opus", workspaceId: "w1" } })
  })

  it("clears downstream runtime values when an upstream value changes", () => {
    const selected = reduceSpawnSelection(createSpawnSelectionState("worker", "w1"), { generatedHandle: "worker-w1", harness: "claude", launcher: "claude-main", preserveHandle: false, roleName: "worker", type: "select-role" })
    const withModel = reduceSpawnSelection(selected, { model: "opus", type: "select-model" })
    const withEffort = reduceSpawnSelection(withModel, { effort: "high", type: "select-effort" })
    const reset = reduceSpawnSelection(withEffort, { harness: "codex", type: "select-harness" })
    expect(reset.harness).toBe("codex")
    expect(reset.launcher).toBe("")
    expect(reset.model).toBe("")
    expect(reset.effort).toBe("")
  })

  it("uses role defaults only when the exact catalogue entries exist", () => {
    const role: RolePreset = { effort: "high", launcher: "claude-main", model: "opus", name: "lead", summary: "Lead" }
    expect(resolveSpawnDefaults({ catalogue: catalogue([defaultModel]), effort: "", launcherSelected: true, model: "", role })).toMatchObject({ effort: "high", modelName: "opus" })
    expect(resolveSpawnDefaults({ catalogue: catalogue([{ ...defaultModel, efforts: [effort("medium", true)] }]), effort: "", launcherSelected: true, model: "", role })).toMatchObject({ effort: "medium", modelName: "opus" })
  })

  it("submits a model named default without a sentinel", () => {
    const selection = { ...createSpawnSelectionState("worker", "w1"), handle: "worker-w1", harness: "claude", launcher: "claude-main" }
    const model = { ...defaultModel, efforts: [], name: "default" }
    const result = buildSpawnAgentRequest({ currentCatalogue: true, effort: "", modelName: "default", roleBriefingPresent: false, selectedCatalogue: catalogue([model], "default-only"), selectedModel: model, selection, targetWorkspaceId: "w1" })
    expect(result).toEqual({ ok: true, request: { handle: "worker-w1", launcher: "claude-main", model: "default", role: "worker", workspaceId: "w1" } })
  })

  it("omits effort when the selected model reports no efforts", () => {
    const selection = { ...createSpawnSelectionState("worker", "w1"), handle: "worker-w1", harness: "pi", launcher: "pi-main" }
    const model: DeviceModelEntry = { default: true, description: null, efforts: [], label: "Pi default", name: "default", resolvedModel: null }
    const result = buildSpawnAgentRequest({ currentCatalogue: true, effort: "", modelName: "default", roleBriefingPresent: false, selectedCatalogue: catalogue([model], "ready", "pi-main", "pi"), selectedModel: model, selection, targetWorkspaceId: "w1" })
    expect(result).toEqual({ ok: true, request: { handle: "worker-w1", launcher: "pi-main", model: "default", role: "worker", workspaceId: "w1" } })
  })
})
