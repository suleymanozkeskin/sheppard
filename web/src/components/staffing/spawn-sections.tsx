import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { DeviceCatalogue, DeviceModelEntry } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { IdentityHint } from "@/components/staffing/shared"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { NO_ROLE_VALUE, type CatalogueState, type SpawnMetadataState } from "./spawn-state"
import { roleIcon } from "./spawn-sections-logic"

interface SpawnAssignmentSectionProps {
  roleDisabled: boolean
  workspaceDisabled: boolean
  metadataError: string | undefined
  metadataState: SpawnMetadataState
  nativeLeadAlreadyActive: boolean
  onRoleChange: (value: string | null) => void
  onWorkspaceChange: (value: string | null) => void
  roleOptions: readonly ComboboxOption[]
  roleValue: string
  selectedRoleSummary: string | undefined
  selectedWorkspaceId: string
  workspaceDescription: string
  workspaceOptions: readonly ComboboxOption[]
}

export function SpawnAssignmentSection({ metadataError, metadataState, nativeLeadAlreadyActive, onRoleChange, onWorkspaceChange, roleDisabled, roleOptions, roleValue, selectedRoleSummary, selectedWorkspaceId, workspaceDescription, workspaceDisabled, workspaceOptions }: SpawnAssignmentSectionProps) {
  return (
    <section aria-labelledby="spawn-assignment-heading" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm" data-spawn-section="assignment">
      <h2 className="font-semibold" id="spawn-assignment-heading">Assignment</h2>
      <Combobox disabled={workspaceDisabled} id="spawn-agent-workspace" label="Workspace" options={workspaceOptions} placeholder="Search workspaces…" showAllOption={false} value={selectedWorkspaceId.length === 0 ? null : selectedWorkspaceId} onValueChange={onWorkspaceChange} description={workspaceDescription} required />
      <Combobox
        clearAriaLabel="Clear role"
        clearable
        disabled={roleDisabled}
        id="spawn-agent-role"
        label="Role"
        loading={metadataState.status === "loading"}
        errorMessage={metadataState.status === "error" ? metadataError ?? "Roles are unavailable." : null}
        options={roleOptions}
        placeholder="Search roles…"
        showAllOption={false}
        value={roleValue}
        onValueChange={onRoleChange}
        description={selectedRoleSummary ?? "No role preset. Choose a harness and launcher manually."}
      />
      {nativeLeadAlreadyActive && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200" data-native-lead-guard role="alert">This workspace already has an active native lead. Stop it before you spawn another lead.</p>}
    </section>
  )
}

interface SpawnRuntimeSectionProps {
  awaiting: boolean
  catalogueNeedsRetry: boolean
  catalogueRetry: () => void
  catalogueState: CatalogueState
  catalogueStatusText: string | undefined
  effort: string
  effortOptions: readonly ComboboxOption[]
  effortUnavailable: boolean
  harness: string
  harnessOptions: readonly ComboboxOption[]
  launcher: string
  launcherOptions: readonly ComboboxOption[]
  model: string
  modelOptions: readonly ComboboxOption[]
  modelPickerError: string | null
  modelPickerLoading: boolean
  onEffortChange: (value: string | null) => void
  onHarnessChange: (value: string | null) => void
  onLauncherChange: (value: string | null) => void
  onModelChange: (value: string | null) => void
  selectedCatalogue: DeviceCatalogue | undefined
  selectedModel: DeviceModelEntry | undefined
}

export function SpawnRuntimeSection({ awaiting, catalogueNeedsRetry, catalogueRetry, catalogueState, catalogueStatusText, effort, effortOptions, effortUnavailable, harness, harnessOptions, launcher, launcherOptions, model, modelOptions, modelPickerError, modelPickerLoading, onEffortChange, onHarnessChange, onLauncherChange, onModelChange, selectedCatalogue, selectedModel }: SpawnRuntimeSectionProps) {
  const catalogueStatus = selectedCatalogue?.status ?? (catalogueState.status === "error" ? "unavailable" : undefined)
  return (
    <section aria-labelledby="spawn-runtime-heading" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm lg:col-start-2 lg:row-span-2 lg:row-start-1" data-spawn-section="runtime">
      <h2 className="font-semibold" id="spawn-runtime-heading">Runtime</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Combobox disabled={awaiting} id="spawn-agent-harness" label="Harness" options={harnessOptions} placeholder="Search harnesses…" showAllOption={false} value={harness.length === 0 ? null : harness} onValueChange={onHarnessChange} required description={harnessOptions.length === 0 ? "No compatible harness is configured for this role." : "The launcher process family."} emptyMessage="No compatible harnesses are available." />
        <Combobox disabled={awaiting || harness.length === 0} id="spawn-agent-launcher" label="Launcher" options={launcherOptions} placeholder="Search launchers…" showAllOption={false} value={launcher.length === 0 ? null : launcher} onValueChange={onLauncherChange} required description={launcherOptions.length === 0 && harness.length > 0 ? "No launcher is compatible with this harness." : "Select the registered launcher to start."} emptyMessage="No compatible launchers are available." />
        <Combobox disabled={awaiting || harness.length === 0 || launcher.length === 0} id="spawn-agent-model" label="Model" options={modelOptions} placeholder="Search models…" showAllOption={false} value={model.length === 0 ? null : model} onValueChange={onModelChange} required loading={modelPickerLoading} loadingMessage="Loading current models…" errorMessage={modelPickerError} onRetry={catalogueRetry} emptyMessage="No models are available for this launcher." description={harness.length === 0 ? "Choose a harness first." : launcher.length === 0 ? "Choose a launcher first." : selectedCatalogue?.status === "unsupported" ? "This launcher manages its model selection." : catalogueStatusText} />
        <Combobox disabled={awaiting || selectedModel === undefined || selectedModel.efforts.length === 0} id="spawn-agent-effort" label="Reasoning effort" options={effortOptions} placeholder="Search reasoning efforts…" showAllOption={false} value={effort.length === 0 ? null : effort} onValueChange={onEffortChange} required={selectedModel !== undefined && selectedModel.efforts.length > 0} description={selectedModel === undefined ? "Select a model first." : effortUnavailable ? "This model does not report reasoning values." : "Choose a reasoning effort reported by this model."} emptyMessage="No reasoning values are available for this model." />
      </div>
      {modelPickerLoading && <p className="text-sm text-muted-foreground" data-model-catalogue-state="loading" role="status">Loading current models…</p>}
      {catalogueStatusText !== undefined && catalogueNeedsRetry && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-model-catalogue-state={catalogueStatus ?? "unavailable"}><p className="text-amber-800 dark:text-amber-200" role={catalogueStatus === "stale" ? "status" : "alert"}>{catalogueStatusText}</p><Button className="min-h-11" disabled={catalogueState.status === "refreshing"} onClick={catalogueRetry} size="sm" type="button" variant="outline">{catalogueState.status === "refreshing" ? "Retrying…" : "Retry"}</Button></div>}
      {selectedCatalogue?.status === "unsupported" && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-model-catalogue-state="unsupported">This launcher does not support a model catalogue.</p>}
      {selectedCatalogue !== undefined && (selectedCatalogue.status === "ready" || selectedCatalogue.status === "default-only") && selectedCatalogue.models.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-model-catalogue-state="empty">No models are available for this launcher.</p>}
    </section>
  )
}

interface SpawnDetailsSectionProps {
  awaiting: boolean
  goal: string
  handle: string
  onGoalChange: (value: string) => void
  onHandleChange: (value: string) => void
  roleBriefingPresent: boolean
  readOnlyHandle: boolean
}

export function SpawnDetailsSection({ awaiting, goal, handle, onGoalChange, onHandleChange, readOnlyHandle, roleBriefingPresent }: SpawnDetailsSectionProps) {
  return <section aria-labelledby="spawn-details-heading" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm lg:col-span-2" data-spawn-section="details">
    <h2 className="font-semibold" id="spawn-details-heading">Details</h2>
    <div className={roleBriefingPresent ? "grid gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]" : undefined}>
    <div><label className="text-sm font-medium" htmlFor="spawn-agent-handle">Handle</label><input className="mt-1.5 min-h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={awaiting} id="spawn-agent-handle" name="handle" onChange={(event) => onHandleChange(event.target.value)} readOnly={readOnlyHandle} value={handle} /><p className="mt-1 text-xs text-muted-foreground">Use a short, unique name for this workspace.</p></div>
    {roleBriefingPresent && <div><label className="text-sm font-medium" htmlFor="spawn-agent-goal">Goal <span className="font-normal text-muted-foreground">(optional)</span></label><textarea className="mt-1.5 min-h-20 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={awaiting} id="spawn-agent-goal" onChange={(event) => onGoalChange(event.target.value)} placeholder="What should this agent pursue here?" value={goal} /><p className="mt-1 text-xs text-muted-foreground">The goal is sent with the selected role.</p></div>}
    </div>
  </section>
}

interface SpawnReviewSectionProps {
  actionError: string | undefined
  assignedHandle: string | undefined
  awaiting: boolean
  canWrite: boolean
  effort: string
  effortUnavailable: boolean
  handle: string
  harness: string
  modelLabel: string
  navigateBack: () => void
  roleName: string
  selectedLauncher: string
  selectedWorkspace: string
  submitDisabled: boolean
  title: string
}

export function SpawnReviewSection({ actionError, assignedHandle, awaiting, canWrite, effort, effortUnavailable, handle, harness, modelLabel, navigateBack, roleName, selectedLauncher, selectedWorkspace, submitDisabled, title }: SpawnReviewSectionProps) {
  return <aside className="lg:col-span-2" data-spawn-review-column>
    <section aria-labelledby="spawn-review-heading" className="rounded-xl border bg-card p-4 shadow-sm" data-spawn-review>
      <h2 className="font-semibold" id="spawn-review-heading">Review</h2>
      <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end">
      <dl className="grid min-w-0 flex-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Workspace</dt><dd className="mt-0.5 break-words font-medium">{selectedWorkspace || "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Role</dt><dd className="mt-0.5 flex items-center gap-2 font-medium">{roleName !== NO_ROLE_VALUE && roleName.length > 0 && roleIcon(roleName)}{roleName === NO_ROLE_VALUE ? "No role" : roleName || "No role"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Runtime</dt><dd className="mt-0.5 flex min-w-0 items-center gap-2 font-medium">{harness.length > 0 && <AgentAvatar agentKind={harness} />}<span className="min-w-0 break-words">{[selectedLauncher || harness, modelLabel, effortUnavailable ? "managed effort" : effort].filter((value) => value.length > 0).join(" · ") || "—"}</span></dd></div>
        <div><dt className="text-xs text-muted-foreground">Handle</dt><dd className="mt-0.5 break-words font-medium">{handle.trim() || "—"}</dd></div>
      </dl>
      <div className="flex shrink-0 flex-wrap justify-end gap-2"><Button className="min-h-11" onClick={navigateBack} type="button" variant="ghost">Cancel</Button><IdentityHint canWrite={canWrite}><Button className="min-h-11" disabled={!canWrite || submitDisabled} title={canWrite ? (submitDisabled ? "Complete the required spawn fields" : title) : NOT_CONNECTED_REASON} type="submit">{awaiting ? "Waiting…" : title}</Button></IdentityHint></div>
      </div>
      {awaiting && assignedHandle !== undefined && <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm" data-assigned-handle={assignedHandle} role="status">Created <strong>{assignedHandle}</strong>. Waiting for the workspace route to appear.</p>}
      {actionError !== undefined && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
    </section>
  </aside>
}
