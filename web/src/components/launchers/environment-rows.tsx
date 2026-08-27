import { Eye, EyeOff, Plus, Trash2 } from "lucide-react"

import type { MsgrApi } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DirectoryPicker } from "@/components/launchers/directory-picker"
import type { EnvironmentRow, SavedEnvironmentAction } from "@/components/launchers/launcher-form"

export interface EnvironmentRowsProps {
  api: MsgrApi
  disabled?: boolean
  onAdd: () => void
  onChange: (id: string, patch: Partial<EnvironmentRow>) => void
  onRemove: (id: string) => void
  rows: readonly EnvironmentRow[]
}

function fieldId(prefix: string, row: EnvironmentRow, index: number): string {
  const suffix = row.id.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")
  return `${prefix}-${index}-${suffix}`
}

function actionLabel(action: SavedEnvironmentAction): string {
  switch (action) {
    case "keep":
      return "Keep saved"
    case "replace":
      return "Replace"
    case "remove":
      return "Remove"
  }
}

function EnvironmentValueEditor({ api, disabled, onChange, row, rowIndex }: { api: MsgrApi; disabled: boolean; onChange: (patch: Partial<EnvironmentRow>) => void; row: EnvironmentRow; rowIndex: number }) {
  const keyLabel = row.key.trim() || "new key"
  const valueId = fieldId("launcher-env-value", row, rowIndex)
  const revealLabel = row.revealed ? `Hide value for ${keyLabel}` : `Reveal value for ${keyLabel}`
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className="text-sm font-medium" htmlFor={valueId}>Value</label>
          <input
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            disabled={disabled}
            id={valueId}
            name={`environment-value-${rowIndex + 1}`}
            onChange={(event) => onChange({ value: event.target.value })}
            placeholder="Enter a value"
            spellCheck={false}
            type={row.revealed ? "text" : "password"}
            value={row.value}
          />
        </div>
        <div className="flex gap-2">
          <Button aria-label={revealLabel} className="min-h-11 min-w-11" disabled={disabled} onClick={() => onChange({ revealed: !row.revealed })} size="icon-lg" type="button" variant="outline">
            {row.revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
          <DirectoryPicker api={api} disabled={disabled} onSelect={(absolutePath) => onChange({ value: absolutePath })} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Values are hidden by default. Sheppard stores this value only in the launcher configuration.</p>
    </div>
  )
}

export function EnvironmentRows({ api, disabled = false, onAdd, onChange, onRemove, rows }: EnvironmentRowsProps) {
  return (
    <section aria-labelledby="launcher-environment-heading" className="space-y-3" data-launcher-environment-settings>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" id="launcher-environment-heading">Environment settings</h3>
          <p className="mt-1 text-xs text-muted-foreground">Select different accounts or profiles with environment keys. Saved values are never returned to the browser.</p>
        </div>
        <Button className="min-h-11" disabled={disabled} onClick={onAdd} size="lg" type="button" variant="outline"><Plus aria-hidden="true" /> Add setting</Button>
      </div>
      {rows.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No environment settings. Add a key when this alias needs one.</p>}
      <div className="space-y-3">
        {rows.map((row, rowIndex) => {
          const keyId = fieldId("launcher-env-key", row, rowIndex)
          const savedAction = row.kind === "saved" ? row.action : undefined
          const valueVisible = row.kind === "new" || savedAction === "replace"
          return (
            <div className="rounded-lg border bg-background/60 p-3" data-launcher-environment-row={row.id} key={row.id}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium" htmlFor={keyId}>Key</label>
                  <input
                    autoComplete="off"
                    className="mt-1 h-11 w-full rounded-lg border bg-background px-3 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 read-only:bg-muted/40"
                    disabled={disabled}
                    id={keyId}
                    name={`environment-key-${rowIndex + 1}`}
                    onChange={(event) => onChange(row.id, { key: event.target.value })}
                    placeholder="ENVIRONMENT_KEY"
                    readOnly={row.kind === "saved"}
                    spellCheck={false}
                    value={row.key}
                  />
                  {row.kind === "saved" && <p className="mt-1 text-xs text-muted-foreground">Saved key. Its value is not visible.</p>}
                </div>
                {row.kind === "saved" && (
                  <div aria-label={`Saved value action for ${row.key}`} className="flex shrink-0 flex-wrap gap-2" role="group">
                    {(["keep", "replace", "remove"] as const).map((action) => (
                      <Button
                        aria-pressed={savedAction === action}
                        className="min-h-11"
                        disabled={disabled}
                        key={action}
                        onClick={() => onChange(row.id, { action })}
                        size="lg"
                        type="button"
                        variant={savedAction === action ? "secondary" : "outline"}
                      >
                        {actionLabel(action)}
                      </Button>
                    ))}
                  </div>
                )}
                <Button aria-label={`Remove environment setting ${row.key || rowIndex + 1}`} className="min-h-11" disabled={disabled} onClick={() => onRemove(row.id)} size="lg" type="button" variant="ghost"><Trash2 aria-hidden="true" /> Remove</Button>
              </div>
              {valueVisible && <div className="mt-3"><EnvironmentValueEditor api={api} disabled={disabled} onChange={(patch) => onChange(row.id, patch)} row={row} rowIndex={rowIndex} /></div>}
              {row.kind === "saved" && savedAction === "remove" && <p className="mt-2 text-xs text-destructive">This key will be removed when you save the alias.</p>}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">Sheppard stores the alias and sends only its name during spawn. It never runs a shell command string.</p>
    </section>
  )
}
