import type { SessionTurn } from "@/api/types"

export interface SessionRow {
  readonly key: string
  readonly turn: SessionTurn
}

/** Builds view keys from full turn contents and duplicate order, counted from
 * the newest end. Prepending older turns keeps current disclosure state.
 * These are view keys, not harness event IDs. No data is changed or stored.
 */
export function sessionRows(turns: readonly SessionTurn[]): readonly SessionRow[] {
  const occurrences = new Map<string, number>()
  return turns
    .toReversed()
    .map((turn) => {
      const content = JSON.stringify(turn)
      const count = occurrences.get(content) ?? 0
      occurrences.set(content, count + 1)
      return Object.freeze({ key: `${count}:${content}`, turn })
    })
    .reverse()
}
