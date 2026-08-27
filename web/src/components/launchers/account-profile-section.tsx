import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"

import { AgentAvatar } from "@/components/agent-avatar"
import { DirectoryPicker } from "@/components/launchers/directory-picker"
import { accountProfileKeys, type AccountProfileDraft, type AccountProfileSelection } from "@/components/launchers/account-profile"
import type { MsgrApi } from "@/api/types"
import { Button } from "@/components/ui/button"

export interface AccountProfileSectionProps {
  api: MsgrApi
  disabled?: boolean
  harness: string
  onChange: (profile: AccountProfileDraft) => void
  profile: AccountProfileDraft
}

function selectionLabel(selection: AccountProfileSelection): string {
  switch (selection) {
    case "default":
      return "Use default account"
    case "keep-saved":
      return "Keep saved"
    case "separate":
      return "Use separate account folder"
  }
}

function mappingDescription(harness: string): string {
  switch (harness) {
    case "claude":
      return "The folder sets CLAUDE_CONFIG_DIR."
    case "codex":
      return "The folder sets CODEX_HOME."
    case "pi":
      return "The folder sets PI_CODING_AGENT_DIR."
    case "opencode":
      return "The folder sets XDG_CONFIG_HOME=<root>/config and XDG_DATA_HOME=<root>/data."
    default:
      return ""
  }
}

export function AccountProfileSection({ api, disabled = false, harness, onChange, profile }: AccountProfileSectionProps) {
  const [revealed, setRevealed] = useState(false)
  const keys = accountProfileKeys(harness)
  const supported = keys.length > 0
  const setSelection = (selection: AccountProfileSelection): void => onChange({ ...profile, selection, folder: selection === "separate" ? profile.folder : "" })

  return (
    <section aria-labelledby="launcher-account-profile-heading" className="rounded-lg border bg-background/40 p-3" data-launcher-account-profile>
      <div className="flex items-start gap-3">
        <AgentAvatar agentKind={harness.length === 0 ? null : harness} className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold" id="launcher-account-profile-heading">Account profile</h3>
          <p className="mt-1 text-xs text-muted-foreground">Use the default account or select a separate account folder. Sheppard stores the folder in this alias and sends only the alias name during spawn.</p>
          {supported && <p className="mt-1 text-xs text-muted-foreground">{mappingDescription(harness)}</p>}
        </div>
      </div>
      {!supported && <p className="mt-3 text-sm text-muted-foreground">Choose a supported harness to configure an account profile.</p>}
      {supported && (
        <>
          <div aria-label="Account profile choice" className="mt-3 flex flex-wrap gap-2" role="group">
            {profile.saved && <Button aria-pressed={profile.selection === "keep-saved"} className="min-h-11" disabled={disabled} onClick={() => setSelection("keep-saved")} size="lg" type="button" variant={profile.selection === "keep-saved" ? "secondary" : "outline"}>{selectionLabel("keep-saved")}</Button>}
            <Button aria-pressed={profile.selection === "separate"} className="min-h-11" disabled={disabled} onClick={() => setSelection("separate")} size="lg" type="button" variant={profile.selection === "separate" ? "secondary" : "outline"}>{selectionLabel("separate")}</Button>
            <Button aria-pressed={profile.selection === "default"} className="min-h-11" disabled={disabled} onClick={() => setSelection("default")} size="lg" type="button" variant={profile.selection === "default" ? "secondary" : "outline"}>{selectionLabel("default")}</Button>
          </div>
          {profile.saved && profile.selection === "keep-saved" && <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">Saved account folder is configured. Its path is hidden. Keep this setting to preserve it.</p>}
          {profile.partialKeys.length > 0 && !profile.saved && <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">Only some account keys are saved ({profile.partialKeys.join(", ")}). They stay in Environment settings until you set a complete account profile.</p>}
          {profile.selection === "separate" && (
            <div className="mt-3 space-y-2">
              <label className="text-sm font-medium" htmlFor="launcher-account-profile-folder">Account folder</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input aria-describedby="launcher-account-profile-folder-help" autoComplete="off" className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={disabled} id="launcher-account-profile-folder" name="account-folder" onChange={(event) => onChange({ ...profile, folder: event.target.value })} placeholder="/absolute/path/to/account" spellCheck={false} type={revealed ? "text" : "password"} value={profile.folder} />
                <div className="flex gap-2">
                  <Button aria-label={revealed ? "Hide account folder" : "Reveal account folder"} className="min-h-11 min-w-11" disabled={disabled} onClick={() => setRevealed((current) => !current)} size="icon-lg" type="button" variant="outline">{revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button>
                  <DirectoryPicker api={api} disabled={disabled} onSelect={(folder) => onChange({ ...profile, folder })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground" id="launcher-account-profile-folder-help">Folder paths are sensitive. The path is hidden from launcher lists and API error messages.</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
