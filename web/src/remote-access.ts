/**
 * Pure rules for remote access and pairing in the browser.
 *
 * The hub itself is always served on http://127.0.0.1. A page served over
 * HTTPS therefore came through `tailscale serve`, and it can only use a
 * session created by pairing.
 */

/** Where this page runs. `remote` pages pair; `local` pages sign in by handle. */
export type PageSite = "local" | "remote"

export function pageSite(protocol: string): PageSite {
  return protocol === "https:" ? "remote" : "local"
}

/** The pathname of the phone pairing page. */
export const PAIR_PATH = "/pair"

export const PAIRING_CODE_LENGTH = 8

/** Crockford base32, as the hub uses it: no I, L, O, or U. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export type PairingCodeInput =
  | { kind: "valid"; code: string }
  | { kind: "invalid"; message: string }

/**
 * Turns typed text into the form the hub checks. Case, spaces, and dashes are
 * ignored; O maps to 0 and I or L map to 1, as on the hub.
 */
export function parsePairingCode(value: string): PairingCodeInput {
  const mapped = [...value.toUpperCase().replace(/[\s-]/gu, "")]
    .map((character) => {
      switch (character) {
        case "O":
          return "0"
        case "I":
        case "L":
          return "1"
        default:
          return character
      }
    })
    .join("")
  if (mapped.length !== PAIRING_CODE_LENGTH || ![...mapped].every((character) => PAIRING_ALPHABET.includes(character))) {
    return { kind: "invalid", message: `Enter the ${PAIRING_CODE_LENGTH}-character code shown on your computer.` }
  }
  return { kind: "valid", code: mapped }
}

/** Shows a code as two groups of four. */
export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Reads the code from a `#code=…` fragment. */
export function pairingCodeFromHash(hash: string): PairingCodeInput | { kind: "absent" } {
  const raw = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("code")
  return raw === null || raw.length === 0 ? { kind: "absent" } : parsePairingCode(raw)
}

export type PairingCountdown =
  | { kind: "open"; secondsLeft: number; label: string }
  | { kind: "expired" }

const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

export function pairingCountdown(expiresAt: string, nowMs: number): PairingCountdown {
  const left = Math.ceil((Date.parse(expiresAt) - nowMs) / MILLISECONDS_PER_SECOND)
  if (!Number.isFinite(left) || left <= 0) return { kind: "expired" }
  const minutes = Math.floor(left / SECONDS_PER_MINUTE)
  const seconds = String(left % SECONDS_PER_MINUTE).padStart(2, "0")
  return { kind: "open", secondsLeft: left, label: `${minutes}:${seconds}` }
}

/** The hub's refusal codes on redeem, in words a phone user can act on. */
export function pairingFailureMessage(code: string | undefined, hubMessage: string | undefined): string {
  switch (code) {
    case "PairingRefused":
      return hubMessage ?? "The code is not valid or has expired. Create a new code on your computer."
    case "RemoteAccessOff":
      return "Remote access is off. Run `sheppard remote enable` on your computer."
    case "RequestRejected":
      return "This device is not allowed. Use the Tailscale account that owns this Sheppard."
    default:
      return hubMessage ?? "Pairing failed. Try again."
  }
}
