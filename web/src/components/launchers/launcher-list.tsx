import type { FormEvent } from "react"
import { Pencil, RefreshCw, Trash2, X } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { DeviceCatalogue, Launcher } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { argumentSummary, harnessLabel } from "@/components/launchers/launcher-form"
import type { CatalogueAction, CatalogueState, LauncherActionState, LaunchersState } from "@/components/launchers/launcher-state"
import { Button } from "@/components/ui/button"
import { KeyboardOverlay } from "@/components/ui/keyboard-overlay"
import type { ShellRouter } from "@/shell-routing"

export interface LauncherListProps {
  actionState: LauncherActionState
  canWrite: boolean
  catalogueActions: Record<string, CatalogueAction>
  catalogueState: CatalogueState
  deleteConfirmation: string
  deleteTarget: Launcher | undefined
  launchersState: LaunchersState
  navigate: ShellRouter["navigate"]
  onCloseDelete: () => void
  onDelete: (event: FormEvent<HTMLFormElement>) => void
  onDeleteConfirmationChange: (value: string) => void
  onLoadModels: (launcher: Launcher) => void
  onOpenDelete: (launcher: Launcher) => void
}

function catalogueForLauncher(state: CatalogueState, launcherName: string): DeviceCatalogue | undefined {
  if (state.status === "loading") return undefined
  return state.catalogues.find((catalogue) => catalogue.launcher === launcherName)
}

function catalogueSummary(catalogue: DeviceCatalogue | undefined, catalogueState: CatalogueState): string {
  if (catalogue !== undefined) {
    const modelCount = catalogue.models.length
    return `${catalogue.status} · ${modelCount} model${modelCount === 1 ? "" : "s"}`
  }
  return catalogueState.status === "error" ? "Catalogue unavailable" : "Models not loaded"
}

export function LauncherList({
  actionState,
  canWrite,
  catalogueActions,
  catalogueState,
  deleteConfirmation,
  deleteTarget,
  launchersState,
  navigate,
  onCloseDelete,
  onDelete,
  onDeleteConfirmationChange,
  onLoadModels,
  onOpenDelete,
}: LauncherListProps) {
  return (
    <div className="w-full space-y-4 p-4 sm:p-6" data-directory="launchers">
      <p className="max-w-3xl text-sm text-muted-foreground">Each alias selects one supported harness. Arguments and environment settings stay separate from the alias name.</p>
      {launchersState.status === "loading" && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" role="status">Loading launcher aliases…</p>}
      {launchersState.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{launchersState.message}</p>}
      {catalogueState.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">Model catalogue: {catalogueState.message}</p>}
      {launchersState.status === "ready" && launchersState.launchers.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No launcher aliases are registered.</p>}
      {launchersState.status === "ready" && launchersState.launchers.length > 0 && (
        <ul aria-label="Launcher alias registry" className="grid items-start gap-3 xl:grid-cols-2 2xl:grid-cols-3" data-launcher-list role="list">
          {launchersState.launchers.map((launcher) => {
            const catalogue = catalogueForLauncher(catalogueState, launcher.name)
            const catalogueAction = catalogueActions[launcher.name] ?? { status: "idle" as const }
            return (
              <li className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card px-4 py-3" data-launcher-row={launcher.name} key={launcher.name}>
                <div className="flex min-w-0 items-center gap-3">
                  <AgentAvatar agentKind={launcher.agentKind} className="size-7 shrink-0" />
                  <div className="min-w-0">
                    <h3 className="truncate font-medium" data-launcher-name>{launcher.name}</h3>
                    <span className="block truncate text-xs text-muted-foreground" data-launcher-agent-kind>{harnessLabel(launcher.agentKind)}</span>
                  </div>
                </div>
                <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                  <p className="flex min-w-0 gap-2" data-launcher-executable><span className="shrink-0">Command</span><code className="truncate rounded bg-muted px-1.5 py-0.5 text-foreground">{launcher.argv[0] ?? launcher.agentKind}</code></p>
                  <p className="flex min-w-0 gap-2" data-launcher-argv-summary><span className="shrink-0">Arguments</span><code className="truncate rounded bg-muted px-1.5 py-0.5 text-foreground" title={argumentSummary(launcher.argv)}>{argumentSummary(launcher.argv)}</code></p>
                  <p data-launcher-environment-keys title={launcher.envKeys.join(", ")}>{launcher.envKeys.length === 0 ? "No environment keys" : `${launcher.envKeys.length} environment key${launcher.envKeys.length === 1 ? "" : "s"}`}</p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2" data-launcher-catalogue>
                  <span className="w-full text-xs text-muted-foreground sm:mr-auto sm:w-auto">{catalogueSummary(catalogue, catalogueState)}</span>
                  <Button aria-label={`${catalogue === undefined ? "Load" : "Refresh"} models for launcher alias ${launcher.name}`} disabled={!canWrite || catalogueAction.status === "working"} onClick={() => onLoadModels(launcher)} size="sm" type="button" variant="outline">
                    <RefreshCw aria-hidden="true" />
                    {catalogueAction.status === "working" ? "Loading…" : catalogue === undefined ? "Load models" : "Refresh"}
                  </Button>
                  <Button aria-label={`Edit launcher alias ${launcher.name}`} disabled={!canWrite} onClick={() => navigate({ kind: "edit-launcher", name: launcher.name })} size="sm" title={canWrite ? `Edit launcher alias ${launcher.name}` : NOT_CONNECTED_REASON} type="button" variant="outline">
                    <Pencil aria-hidden="true" />
                    Edit
                  </Button>
                  <Button aria-label={`Delete launcher alias ${launcher.name}`} disabled={!canWrite} onClick={() => onOpenDelete(launcher)} size="sm" title={canWrite ? `Delete launcher alias ${launcher.name}` : NOT_CONNECTED_REASON} type="button" variant="ghost">
                    <Trash2 aria-hidden="true" />
                    <span className="hidden sm:inline">Delete</span>
                  </Button>
                  {catalogueAction.status === "error" && <span className="basis-full text-xs text-destructive" role="alert">{catalogueAction.message}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {deleteTarget !== undefined && (
        <KeyboardOverlay className="max-w-md" dataDialog="delete-launcher" labelledBy="delete-launcher-title" onClose={onCloseDelete} scope="dialog">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold" id="delete-launcher-title">Delete launcher alias</h2>
            <Button aria-label="Close delete launcher alias" className="min-h-11 min-w-11" onClick={onCloseDelete} size="icon-lg" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">This removes <code className="rounded bg-muted px-1">{deleteTarget.name}</code> from the registry. Existing panes are not changed. Type the alias name to confirm.</p>
          <form className="mt-5 space-y-4" onSubmit={onDelete}>
            <label className="text-sm font-medium" htmlFor="delete-launcher-confirm">Alias name</label>
            <input autoComplete="off" data-autofocus data-confirm-input={deleteTarget.name} className="h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="delete-launcher-confirm" onChange={(event) => onDeleteConfirmationChange(event.target.value)} value={deleteConfirmation} />
            {actionState.status === "error" && <p className="text-sm text-destructive" role="alert">{actionState.message}</p>}
            <div className="flex justify-end gap-2"><Button onClick={onCloseDelete} size="lg" type="button" variant="ghost">Cancel</Button><Button disabled={!canWrite || actionState.status === "working" || deleteConfirmation !== deleteTarget.name} size="lg" type="submit">{actionState.status === "working" ? "Deleting…" : "Delete alias"}</Button></div>
          </form>
        </KeyboardOverlay>
      )}
    </div>
  )
}
