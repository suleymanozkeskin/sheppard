import { Result } from "better-result"
import { formatApiError } from "@/api/errors"
import type { ModelCatalogueSnapshot, MsgrApi, SpawnAgentRequest } from "@/api/types"

type CatalogueApi = Pick<MsgrApi, "listModelCatalogue" | "refreshModelCatalogue">
type CatalogueFailure = Readonly<{ kind: "read-failed"; message: string }> | Readonly<{ kind: "refresh-failed"; message: string }>
type SelectionFailure = Readonly<{ kind: "catalogue-unavailable" | "model-unavailable" | "effort-unavailable"; message: string }>
const SPAWN_CATALOGUE_MARGIN_MS = 30_000

/** Reads hub freshness, then refreshes only this launcher once if needed. Never starts an agent.
 * Failure leaves the form unchanged; retry is safe because only catalogue data can change.
 */
export async function currentSpawnCatalogue(api: CatalogueApi, launcher: string): Promise<Result<ModelCatalogueSnapshot, CatalogueFailure>> {
  const listed = await api.listModelCatalogue()
  if (listed.isErr()) return Result.err({ kind: "read-failed", message: `Could not check models for ${launcher}. ${formatApiError(listed.error)} No agent was started.` })
  const catalogue = listed.value.catalogues.find((entry) => entry.launcher === launcher)
  const current = catalogue?.status === "ready" || catalogue?.status === "default-only"
  const hasTime = catalogue?.freshUntil === null || Date.parse(catalogue?.freshUntil ?? "") > Date.now() + SPAWN_CATALOGUE_MARGIN_MS
  if (current && hasTime) return Result.ok(listed.value)
  const refreshed = await api.refreshModelCatalogue({ launcher })
  return refreshed.mapError((error): CatalogueFailure => ({ kind: "refresh-failed", message: `Could not refresh models for ${launcher}. ${formatApiError(error)} No agent was started.` }))
}

/** Validates exact saved names against the new catalogue. No fallback model, effort, or I/O. */
export function checkSpawnSelection(snapshot: ModelCatalogueSnapshot, request: SpawnAgentRequest): Result<SpawnAgentRequest, SelectionFailure> {
  const catalogue = snapshot.catalogues.find((entry) => entry.launcher === request.launcher)
  if (catalogue === undefined || catalogue.status !== "ready" && catalogue.status !== "default-only") {
    return Result.err({ kind: "catalogue-unavailable", message: `Models for ${request.launcher} are unavailable. ${catalogue?.error ?? "Retry the model list or choose another launcher."} No agent was started.` })
  }
  const model = catalogue.models.find((entry) => entry.name === request.model)
  if (model === undefined) return Result.err({ kind: "model-unavailable", message: `The selected model is no longer available for ${request.launcher}. Choose a model from the updated list. Your other fields are kept. No agent was started.` })
  if (request.effort !== undefined && !model.efforts.some((entry) => entry.name === request.effort)) {
    return Result.err({ kind: "effort-unavailable", message: "The selected effort is no longer available for this model. Choose an effort from the updated list. No agent was started." })
  }
  return Result.ok(request)
}
