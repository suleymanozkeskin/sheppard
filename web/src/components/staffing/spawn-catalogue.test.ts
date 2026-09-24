import { expect, test } from "bun:test"
import { Result } from "better-result"
import { ApiNetworkError } from "@/api/errors"
import type { DeviceCatalogue, ModelCatalogueSnapshot, MsgrApi, SpawnAgentRequest } from "@/api/types"
import { checkSpawnSelection, currentSpawnCatalogue } from "./spawn-catalogue"

const catalogue: DeviceCatalogue = { launcher: "test", harness: "codex", revision: 1, status: "ready", error: null, executableAvailable: true, checkedAt: null, fetchedAt: null, freshUntil: null, models: [{ name: "model-one", label: "Model one", description: null, resolvedModel: null, default: true, efforts: [{ name: "high", default: true, description: null }] }] }
const ready: ModelCatalogueSnapshot = { catalogues: [catalogue] }
const request: SpawnAgentRequest = { workspaceId: "workspace", handle: "worker", launcher: "test", model: "model-one", effort: "high" }
const unavailable = new ApiNetworkError({ message: "Offline", cause: new Error("Connection refused") })

test("current catalogue checks never refresh or start an agent", async () => {
  let refreshes = 0
  const api: Pick<MsgrApi, "listModelCatalogue" | "refreshModelCatalogue"> = {
    listModelCatalogue: async () => Result.ok(ready),
    refreshModelCatalogue: async () => { refreshes += 1; return Result.ok(ready) },
  }
  expect((await currentSpawnCatalogue(api, "test")).unwrap()).toEqual(ready)
  expect(refreshes).toBe(0)
})

test.each(["stale", "unavailable", "missing"] as const)("%s catalogue refreshes only the selected launcher once", async (status) => {
  const launchers: string[] = []
  const api: Pick<MsgrApi, "listModelCatalogue" | "refreshModelCatalogue"> = {
    listModelCatalogue: async () => Result.ok({ catalogues: status === "missing" ? [] : [{ ...catalogue, status }] }),
    refreshModelCatalogue: async ({ launcher }) => { launchers.push(launcher ?? ""); return Result.ok(ready) },
  }
  expect((await currentSpawnCatalogue(api, "test")).unwrap()).toEqual(ready)
  expect(launchers).toEqual(["test"])
})

test("failed reads and refreshes stop before spawning", async () => {
  const api: Pick<MsgrApi, "listModelCatalogue" | "refreshModelCatalogue"> = {
    listModelCatalogue: async () => Result.err(unavailable),
    refreshModelCatalogue: async () => Result.err(unavailable),
  }
  expect((await currentSpawnCatalogue(api, "test")).match({ ok: () => "success", err: (error) => error.kind })).toBe("read-failed")
  const stale = { ...api, listModelCatalogue: async () => Result.ok({ catalogues: [{ ...catalogue, status: "stale" as const }] }) }
  expect((await currentSpawnCatalogue(stale, "test")).match({ ok: () => "success", err: (error) => error.kind })).toBe("refresh-failed")
})

test("a near-expiry catalogue refreshes before the spawn request", async () => {
  let refreshes = 0
  const api: Pick<MsgrApi, "listModelCatalogue" | "refreshModelCatalogue"> = {
    listModelCatalogue: async () => Result.ok({ catalogues: [{ ...catalogue, freshUntil: new Date(Date.now() + 5_000).toISOString() }] }),
    refreshModelCatalogue: async () => { refreshes += 1; return Result.ok(ready) },
  }
  expect((await currentSpawnCatalogue(api, "test")).isOk()).toBe(true)
  expect(refreshes).toBe(1)
})

test("exact model and effort pass without changing the request", () => {
  expect(checkSpawnSelection(ready, request).unwrap()).toBe(request)
})

const SELECTION_CASES: readonly [ModelCatalogueSnapshot, SpawnAgentRequest, string][] = [
  [{ catalogues: [] }, request, "catalogue-unavailable"],
  [{ catalogues: [{ ...catalogue, status: "stale" as const }] }, request, "catalogue-unavailable"],
  [ready, { ...request, model: "removed-model" }, "model-unavailable"],
  [ready, { ...request, effort: "removed-effort" }, "effort-unavailable"],
]
test.each(SELECTION_CASES)("catalogue validation refuses unavailable selections", (snapshot, selected, expected) => {
  expect(checkSpawnSelection(snapshot, selected).match({ ok: () => "success", err: (error) => error.kind })).toBe(expected)
})
