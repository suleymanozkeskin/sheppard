/** Maps the browser platform to its usual shortcut label. It does not change bindings. */
export function commandModifier(platform: string): "⌘" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "⌘" : "Ctrl"
}

export function browserCommandModifier(): "⌘" | "Ctrl" {
  return commandModifier(navigator.platform)
}
