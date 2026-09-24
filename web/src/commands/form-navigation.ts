import type { CommandFieldIntent } from "./navigation-keys"

export type FieldDirection = Exclude<CommandFieldIntent, "edit-field" | "finish-field">
export type FormCell = Readonly<Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">>
export type FieldMove = Readonly<{ kind: "edge" }> | Readonly<{ kind: "move"; index: number }>
export const COMMAND_FORM_FIELD_LIMIT = 24

/** Pure spatial movement. Rows use vertical overlap. Edges do not wrap. No DOM effects. */
export function moveFormField(cells: readonly FormCell[], current: number, direction: FieldDirection): FieldMove {
  const origin = cells[current]
  if (origin === undefined || cells.length > COMMAND_FORM_FIELD_LIMIT) throw new Error("Command form layout violates its field bound or focus index")
  let result: FieldMove = { kind: "edge" }
  let bestDistance = Number.POSITIVE_INFINITY
  let bestAlignment = Number.POSITIVE_INFINITY
  for (const [index, cell] of cells.entries()) {
    if (index === current) continue
    const distance = fieldDistance(origin, cell, direction)
    if (distance.kind === "outside") continue
    if (distance.forward < bestDistance || distance.forward === bestDistance && distance.alignment < bestAlignment) {
      result = { kind: "move", index }
      bestDistance = distance.forward
      bestAlignment = distance.alignment
    }
  }
  return result
}

type FieldDistance = Readonly<{ kind: "outside" }> | Readonly<{ kind: "inside"; forward: number; alignment: number }>

/** Compares CSS pixel rectangles on the requested axis; other directions are excluded. */
function fieldDistance(origin: FormCell, target: FormCell, direction: FieldDirection): FieldDistance {
  const horizontalAlignment = Math.abs(origin.left + origin.right - target.left - target.right)
  const verticalAlignment = Math.abs(origin.top + origin.bottom - target.top - target.bottom)
  const sameRow = target.top < origin.bottom && target.bottom > origin.top
  switch (direction) {
    case "field-up": return target.bottom <= origin.top ? { kind: "inside", forward: origin.top - target.bottom, alignment: horizontalAlignment } : { kind: "outside" }
    case "field-down": return target.top >= origin.bottom ? { kind: "inside", forward: target.top - origin.bottom, alignment: horizontalAlignment } : { kind: "outside" }
    case "field-left": return sameRow && target.right <= origin.left ? { kind: "inside", forward: origin.left - target.right, alignment: verticalAlignment } : { kind: "outside" }
    case "field-right": return sameRow && target.left >= origin.right ? { kind: "inside", forward: target.left - origin.right, alignment: verticalAlignment } : { kind: "outside" }
    default: return direction satisfies never
  }
}
