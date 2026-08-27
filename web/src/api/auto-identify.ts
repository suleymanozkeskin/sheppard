import type { Result } from "better-result"
import type { ApiError } from "./errors"
import type { HumanRegistration } from "./types"

/** The operator's only identity. The hub creates it once and reclaims it after. */
export const AUTO_IDENTIFY_HANDLE = "human"

/**
 * The reason shown on write controls while the browser is not identified.
 * Identification is automatic, so the only unidentified state is a failed
 * request to the hub. The copy names the connection, never an identity choice.
 */
export const NOT_CONNECTED_REASON = "Not connected to the hub."

type IdentifyResult = Result<HumanRegistration, ApiError>

let attempt: Promise<IdentifyResult> | undefined

/**
 * Runs one identification request at a time.
 *
 * Concurrent callers, including a second StrictMode mount, share the active
 * request. The cache clears when the request settles so a later 401 can start
 * one recovery request.
 */
export function autoIdentify(run: () => Promise<IdentifyResult>): Promise<IdentifyResult> {
  if (attempt !== undefined) return attempt
  const current = run()
  attempt = current
  const clear = (): void => {
    if (attempt === current) attempt = undefined
  }
  void current.then(clear, clear)
  return current
}
