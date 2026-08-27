export const COMPOSER_MAX_LINES = 8
export const COMPOSER_LINE_HEIGHT_PX = 24

export interface ComposerLayout {
  height: number
  overflowY: "auto" | "hidden"
}

export function composerLayout(scrollHeight: number): ComposerLayout {
  const maxHeight = COMPOSER_MAX_LINES * COMPOSER_LINE_HEIGHT_PX
  return {
    height: Math.min(scrollHeight, maxHeight),
    overflowY: scrollHeight > maxHeight ? "auto" : "hidden",
  }
}
