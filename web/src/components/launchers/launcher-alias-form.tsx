import { useState, type FormEvent } from "react"
import { Plus, Trash2 } from "lucide-react"

import type { MsgrApi } from "@/api/types"
import { AccountProfileSection } from "@/components/launchers/account-profile-section"
import { EnvironmentRows } from "@/components/launchers/environment-rows"
import type { EnvironmentRow, LauncherFormDraft } from "@/components/launchers/launcher-form"
import type { LauncherActionState } from "@/components/launchers/launcher-state"
import { Button } from "@/components/ui/button"
import { Combobox, ComboboxOptionRow, type ComboboxOption } from "@/components/ui/combobox"

export interface LauncherAliasFormProps {
  actionState: LauncherActionState
  api: MsgrApi
  canWrite: boolean
  comboboxOptions: readonly ComboboxOption[]
  displayedForm: LauncherFormDraft
  formDisabled: boolean
  formPreview: string
  launcherName?: string
  missingEditTarget: boolean
  mode: "create" | "edit"
  onAddArgument: () => void
  onAddEnvironment: () => void
  onCancel: () => void
  onRemoveArgument: (id: string) => void
  onRemoveEnvironment: (id: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onUpdateEnvironmentRow: (id: string, patch: Partial<EnvironmentRow>) => void
  onHarnessChange: (harness: string) => void
  onUpdateField: <K extends keyof LauncherFormDraft>(key: K, value: LauncherFormDraft[K]) => void
}

export function LauncherAliasForm({
  actionState,
  api,
  canWrite,
  comboboxOptions,
  displayedForm,
  formDisabled,
  formPreview,
  launcherName,
  missingEditTarget,
  mode,
  onAddArgument,
  onAddEnvironment,
  onCancel,
  onRemoveArgument,
  onRemoveEnvironment,
  onSubmit,
  onUpdateEnvironmentRow,
  onHarnessChange,
  onUpdateField,
}: LauncherAliasFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6" data-launcher-form={mode}>
      {missingEditTarget && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">That launcher alias is no longer registered. Return to the launcher list.</p>}
      {formDisabled && mode === "edit" && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" role="status">Loading launcher alias…</p>}
      <form className="space-y-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6" data-shell-page-form={mode} onSubmit={onSubmit}>
        <div>
          <h2 className="text-base font-semibold">{mode === "create" ? "Create launcher alias" : `Edit launcher alias · ${launcherName ?? ""}`}</h2>
          <p className="mt-1 text-sm text-muted-foreground">A launcher alias is a user-managed name for one logical harness. Sheppard stores the alias and sends only its name during spawn.</p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="launcher-name">Alias name</label>
          <input autoComplete="off" className="mt-2 h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 read-only:bg-muted/40" data-launcher-name-field disabled={formDisabled} id="launcher-name" name="name" onChange={(event) => onUpdateField("name", event.target.value)} readOnly={mode === "edit"} value={displayedForm.name} />
          {mode === "edit" && <p className="mt-1 text-xs text-muted-foreground">The alias name is immutable.</p>}
        </div>
        <div data-launcher-harness>
          <Combobox
            autoComplete="off"
            description="Harness controls Herdr detection. Executable controls what runs."
            disabled={formDisabled}
            emptyMessage="No harnesses match this search."
            id="launcher-agent-kind"
            label="Harness"
            name="launcher-agent-kind"
            onValueChange={(value) => onHarnessChange(value ?? "")}
            options={comboboxOptions}
            placeholder="Search or choose a harness"
            renderOption={(option) => <ComboboxOptionRow icon={option.leading} label={option.label} sublabel={option.sublabel} />}
            renderValue={(option) => option.label}
            required
            showAllOption={false}
            spellCheck={false}
            value={displayedForm.harness.length === 0 ? null : displayedForm.harness}
          />
        </div>
        <AccountProfileSection api={api} disabled={formDisabled} harness={displayedForm.harness} onChange={(accountProfile) => onUpdateField("accountProfile", accountProfile)} profile={displayedForm.accountProfile} />
        <div>
          <label className="text-sm font-medium" htmlFor="launcher-executable">Executable</label>
          <input autoComplete="off" className="mt-2 h-11 w-full rounded-lg border bg-background px-3 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={formDisabled} id="launcher-executable" name="executable" onChange={(event) => onUpdateField("executable", event.target.value)} placeholder={displayedForm.harness || "executable name or /absolute/path"} spellCheck={false} value={displayedForm.executable} />
          <p className="mt-1 text-xs text-muted-foreground">Enter one executable name or absolute path. Put options in the separate argument rows. Sheppard starts it directly and does not expand shell aliases or command strings.</p>
        </div>
        <section aria-labelledby="launcher-arguments-heading" className="space-y-3" data-launcher-arguments>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold" id="launcher-arguments-heading">Launch arguments</h3>
              <p className="mt-1 text-xs text-muted-foreground">Each row is exactly one argument after Executable. Sheppard does not parse a shell command string.</p>
            </div>
            <Button className="min-h-11" disabled={formDisabled} onClick={onAddArgument} size="lg" type="button" variant="outline"><Plus aria-hidden="true" /> Add argument</Button>
          </div>
          {displayedForm.argumentRows.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No extra arguments. Add one only when the harness needs it.</p>}
          <div className="space-y-2">
            {displayedForm.argumentRows.map((row, rowIndex) => (
              <div className="flex items-center gap-2" data-launcher-argument-row={row.id} key={row.id}>
                <label className="sr-only" htmlFor={rowIndex === 0 ? "launcher-argv" : `launcher-argv-${rowIndex}`}>Launch argument {rowIndex + 1}</label>
                <input autoComplete="off" className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={formDisabled} id={rowIndex === 0 ? "launcher-argv" : `launcher-argv-${rowIndex}`} name={`argument-${rowIndex + 1}`} onChange={(event) => onUpdateField("argumentRows", displayedForm.argumentRows.map((candidate) => candidate.id === row.id ? { ...candidate, value: event.target.value } : candidate))} placeholder={`Argument ${rowIndex + 1}`} spellCheck={false} value={row.value} />
                <Button aria-label={`Remove launch argument ${rowIndex + 1}`} className="min-h-11 min-w-11" disabled={formDisabled} onClick={() => onRemoveArgument(row.id)} size="icon-lg" type="button" variant="ghost"><Trash2 aria-hidden="true" /></Button>
              </div>
            ))}
          </div>
        </section>
        <details className="rounded-lg border bg-background/40" data-launcher-advanced onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced</summary>
          {advancedOpen && <div className="space-y-4 border-t p-3">
            <EnvironmentRows api={api} disabled={formDisabled} onAdd={onAddEnvironment} onChange={onUpdateEnvironmentRow} onRemove={onRemoveEnvironment} rows={displayedForm.environmentRows} />
            <div>
              <label className="text-sm font-medium" htmlFor="launcher-start-timeout">Startup timeout (ms)</label>
              <input autoComplete="off" className="mt-2 h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={formDisabled} id="launcher-start-timeout" inputMode="numeric" min="1" max="300000" name="start-timeout-ms" onChange={(event) => onUpdateField("startTimeoutMs", event.target.value)} type="number" value={displayedForm.startTimeoutMs} />
            </div>
            <div>
              <p className="text-sm font-medium">Technical command preview</p>
              <code className="mt-2 block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs" data-launcher-form-preview>{formPreview}</code>
            </div>
            <p className="text-xs text-muted-foreground">Installed Herdr starts Executable directly with the separate argument rows. It does not expand shell aliases or run wrapper command strings.</p>
          </div>}
        </details>
        {actionState.status === "error" && <p className="text-sm text-destructive" role="alert">{actionState.message}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel} size="lg" type="button" variant="ghost">Cancel</Button>
          {canWrite ? <Button disabled={formDisabled} title={missingEditTarget ? "This launcher alias is no longer registered" : "Save launcher alias"} size="lg" type="submit">{actionState.status === "working" ? "Saving…" : mode === "create" ? "Create alias" : "Save alias"}</Button> : <span title="You are not connected"><Button disabled size="lg" type="submit">{mode === "create" ? "Create alias" : "Save alias"}</Button></span>}
        </div>
      </form>
    </div>
  )
}
