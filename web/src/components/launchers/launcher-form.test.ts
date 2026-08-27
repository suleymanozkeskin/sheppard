import { describe, expect, it } from "bun:test"

import type { Launcher } from "@/api/types"
import { accountProfileEnvironment, accountProfileFromSavedKeys } from "@/components/launchers/account-profile"
import {
  argumentRowsFromArgv,
  argvFromArgumentRows,
  createLauncherRequestFromForm,
  harnessOptions,
  launcherDraftFromLauncher,
  launcherEnvironmentPatchFromRows,
  launcherFormError,
  preserveAccountProfileRowsOnHarnessChange,
  type EnvironmentRow,
  type LauncherFormDraft,
  updateLauncherRequestFromForm,
} from "@/components/launchers/launcher-form"

function row(value: string, id = value) {
  return { id, value }
}

function form(overrides: Partial<LauncherFormDraft> = {}): LauncherFormDraft {
  return {
    accountProfile: { folder: "", partialKeys: [], saved: false, selection: "default" },
    argumentRows: [],
    environmentRows: [],
    executable: "codex",
    harness: "codex",
    name: "local-codex",
    startTimeoutMs: "35000",
    ...overrides,
  }
}

describe("launcher form helpers", () => {
  it("keeps the executable separate from each launch argument boundary", () => {
    expect(argumentRowsFromArgv(["codex", "--profile", "two words"]).map(({ value }) => value)).toEqual(["--profile", "two words"])
    expect(argvFromArgumentRows("claude-work", [row("--profile"), row("two words")])).toEqual(["claude-work", "--profile", "two words"])
    expect(argvFromArgumentRows("/opt/tools/claude", [row("--profile")])).toEqual(["/opt/tools/claude", "--profile"])
  })

  it("accepts an executable name or absolute path, but not a shell command string", () => {
    expect(launcherFormError(form({ executable: "claude" }), "create")).toBeUndefined()
    expect(launcherFormError(form({ executable: "/opt/tools/claude" }), "create")).toBeUndefined()
    expect(launcherFormError(form({ executable: "/Applications/Claude Code/claude" }), "create")).toBeUndefined()
    expect(launcherFormError(form({ executable: "claude --profile work" }), "create")).toBe("Enter one executable name or absolute path. Put arguments in separate rows.")
    expect(launcherFormError(form({ executable: "./claude" }), "create")).toBe("Executable must be a name or an absolute path.")
    expect(launcherFormError(form({ executable: "claude[work]" }), "create")).toBeUndefined()
  })

  it("includes environment values only when creating a launcher", () => {
    const request = createLauncherRequestFromForm(form({
      environmentRows: [{ action: "new", id: "env-1", key: "CODEX_HOME", kind: "new", revealed: false, value: "/tmp/codex" }],
    }))
    expect(request).toEqual({
      agentKind: "codex",
      argv: ["codex"],
      env: { CODEX_HOME: "/tmp/codex" },
      name: "local-codex",
      startTimeoutMs: 35000,
    })
  })

  it("keeps an unseen saved value, replaces one, and removes one with an explicit patch", () => {
    const rows: EnvironmentRow[] = [
      { action: "keep", id: "saved-keep", key: "KEEP_ME", kind: "saved", revealed: false, value: "" },
      { action: "replace", id: "saved-replace", key: "REPLACE_ME", kind: "saved", revealed: false, value: "new-value" },
      { action: "remove", id: "saved-remove", key: "REMOVE_ME", kind: "saved", revealed: false, value: "" },
      { action: "new", id: "new-key", key: "NEW_KEY", kind: "new", revealed: false, value: "new-value" },
    ]
    expect(launcherEnvironmentPatchFromRows(rows)).toEqual({
      remove: ["REMOVE_ME"],
      set: { NEW_KEY: "new-value", REPLACE_ME: "new-value" },
    })
    expect(updateLauncherRequestFromForm(form({ environmentRows: rows }))).toMatchObject({
      agentKind: "codex",
      argv: ["codex"],
      envPatch: {
        remove: ["REMOVE_ME"],
        set: { NEW_KEY: "new-value", REPLACE_ME: "new-value" },
      },
    })
  })

  it("does not copy saved environment values into an edit draft", () => {
    const launcher: Launcher = { agentKind: "codex", argv: ["codex", "--profile", "one"], envKeys: ["CODEX_HOME"], name: "local-codex", startTimeoutMs: 35000 }
    const draft = launcherDraftFromLauncher(launcher)
    expect(draft.accountProfile).toEqual({ folder: "", partialKeys: [], saved: true, selection: "keep-saved" })
    expect(draft.environmentRows).toEqual([])
  })

  it("keeps the fixed harness family and adds unique saved kinds", () => {
    expect(harnessOptions([{ agentKind: "custom", argv: ["custom"], envKeys: [], name: "custom-alias", startTimeoutMs: 35000 }])).toEqual(["claude", "codex", "pi", "opencode", "custom"])
  })

  it("maps every supported harness account profile without exposing a saved path", () => {
    expect(accountProfileEnvironment("claude", "/accounts/claude/")).toEqual({ CLAUDE_CONFIG_DIR: "/accounts/claude" })
    expect(accountProfileEnvironment("codex", "/accounts/codex")).toEqual({ CODEX_HOME: "/accounts/codex" })
    expect(accountProfileEnvironment("pi", "/accounts/pi")).toEqual({ PI_CODING_AGENT_DIR: "/accounts/pi" })
    expect(accountProfileEnvironment("opencode", "/accounts/open")).toEqual({ XDG_CONFIG_HOME: "/accounts/open/config", XDG_DATA_HOME: "/accounts/open/data" })
    expect(accountProfileFromSavedKeys("opencode", ["XDG_CONFIG_HOME"])).toEqual({ folder: "", partialKeys: ["XDG_CONFIG_HOME"], saved: false, selection: "default" })
  })

  it("removes a complete saved account profile when default account is selected", () => {
    const request = updateLauncherRequestFromForm(form({
      accountProfile: { folder: "", partialKeys: [], saved: true, selection: "default" },
    }))
    expect(request.envPatch).toEqual({ remove: ["CODEX_HOME"], set: {} })
  })

  it("prevents a manual row from duplicating a profile-managed key", () => {
    expect(launcherFormError(form({
      accountProfile: { folder: "/accounts/codex", partialKeys: [], saved: false, selection: "separate" },
      environmentRows: [{ action: "new", id: "duplicate", key: "CODEX_HOME", kind: "new", revealed: false, value: "/other" }],
    }), "create")).toContain("CODEX_HOME")
  })

  it("marks old saved profile keys for removal when the harness changes", () => {
    const rows = preserveAccountProfileRowsOnHarnessChange("codex", { folder: "", partialKeys: [], saved: true, selection: "keep-saved" }, [])
    expect(rows).toMatchObject([{ action: "remove", key: "CODEX_HOME", kind: "saved", value: "" }])
  })
})
