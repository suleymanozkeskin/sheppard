export const CANONICAL_BUN_VERSION = "1.4.0"

export function bunVersionMismatch(actualVersion: string): string | null {
  if (actualVersion === CANONICAL_BUN_VERSION) return null

  return `verify:gate requires bun --version ${CANONICAL_BUN_VERSION}; detected ${actualVersion}. The gate stopped before build; measurements from another Bun version are not comparable.`
}
