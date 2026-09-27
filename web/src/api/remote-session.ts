import { hubRefusal, type ApiError } from "./errors"
import type { MsgrApi } from "./types"

/** Whether a remote page holds a paired session. */
export type RemoteSessionCheck =
  | { kind: "paired"; handle: string }
  | { kind: "unpaired" }
  | { kind: "failed"; error: ApiError }

const UNAUTHORIZED_STATUS = 401

/**
 * A remote page cannot sign in by handle, so it asks the hub who its paired
 * session belongs to. The cookie is the only credential.
 */
export async function checkRemoteSession(api: MsgrApi): Promise<RemoteSessionCheck> {
  const probe = await api.getMe()
  if (probe.isOk()) return { kind: "paired", handle: probe.value.handle }
  const error = probe.error
  const unpaired = error._tag === "ApiHttpError" && error.status === UNAUTHORIZED_STATUS
  return unpaired || hubRefusal(error).code === "Unauthorized" ? { kind: "unpaired" } : { kind: "failed", error }
}
