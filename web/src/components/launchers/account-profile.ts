export type AccountProfileSelection = "default" | "keep-saved" | "separate"

export interface AccountProfileDraft {
  folder: string
  partialKeys: string[]
  saved: boolean
  selection: AccountProfileSelection
}

const ACCOUNT_PROFILE_KEY_MAP = {
  claude: ["CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  opencode: ["XDG_CONFIG_HOME", "XDG_DATA_HOME"],
  pi: ["PI_CODING_AGENT_DIR"],
} as const

export function accountProfileKeys(harness: string): string[] {
  switch (harness) {
    case "claude":
      return [...ACCOUNT_PROFILE_KEY_MAP.claude]
    case "codex":
      return [...ACCOUNT_PROFILE_KEY_MAP.codex]
    case "pi":
      return [...ACCOUNT_PROFILE_KEY_MAP.pi]
    case "opencode":
      return [...ACCOUNT_PROFILE_KEY_MAP.opencode]
    default:
      return []
  }
}

export function accountProfileEnvironment(harness: string, folder: string) {
  const base = folder.trim().replace(/\/+$/u, "")
  if (base.length === 0) return {}
  const values = new Map<string, string>()
  switch (harness) {
    case "claude":
      values.set("CLAUDE_CONFIG_DIR", base)
      break
    case "codex":
      values.set("CODEX_HOME", base)
      break
    case "pi":
      values.set("PI_CODING_AGENT_DIR", base)
      break
    case "opencode":
      values.set("XDG_CONFIG_HOME", `${base}/config`)
      values.set("XDG_DATA_HOME", `${base}/data`)
      break
  }
  return Object.fromEntries(values)
}

export function accountProfileFromSavedKeys(harness: string, envKeys: readonly string[]): AccountProfileDraft {
  const required = accountProfileKeys(harness)
  const present = required.filter((key) => envKeys.includes(key))
  if (required.length > 0 && present.length === required.length) {
    return { folder: "", partialKeys: [], saved: true, selection: "keep-saved" }
  }
  return { folder: "", partialKeys: present, saved: false, selection: "default" }
}

export function accountProfileIsComplete(harness: string, envKeys: readonly string[]): boolean {
  const required = accountProfileKeys(harness)
  return required.length > 0 && required.every((key) => envKeys.includes(key))
}
