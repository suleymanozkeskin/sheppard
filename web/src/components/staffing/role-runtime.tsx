import type { ReactNode } from "react"

import type { DeviceCatalogue, DeviceModelEntry, Launcher } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import {
  catalogueReasonText,
  deviceModelLabel,
} from "./spawn-state"
import {
  type RoleRuntimeMetadataState,
  type RoleRuntimeStaleFields,
  type RoleRuntimeValues,
} from "./role-runtime-logic"

interface RoleRuntimeSectionProps {
  disabled: boolean
  metadataState: RoleRuntimeMetadataState
  onEffortChange: (value: string | null) => void
  onHarnessChange: (value: string | null) => void
  onLauncherChange: (value: string | null) => void
  onModelChange: (value: string | null) => void
  onRetry: () => void
  staleFields?: RoleRuntimeStaleFields
  showHeading?: boolean
  values: RoleRuntimeValues
}

function catalogueFor(metadataState: RoleRuntimeMetadataState, launcher: string): DeviceCatalogue | undefined {
  return metadataState.catalogues.find((catalogue) => catalogue.launcher === launcher)
}

function currentCatalogue(catalogue: DeviceCatalogue | undefined): boolean {
  return catalogue?.status === "ready" || catalogue?.status === "default-only"
}

function modelFor(catalogue: DeviceCatalogue | undefined, value: string): DeviceModelEntry | undefined {
  if (value.length === 0) return undefined
  return catalogue?.models.find((model) => model.name === value)
}

function unavailableOption(value: string, kind: string): ComboboxOption {
  return { disabled: true, label: `${value} (unavailable)`, leading: kind === "harness" ? <AgentAvatar agentKind={value} /> : undefined, sublabel: `Saved ${kind} is not in the current catalogue.`, value }
}

function withSavedValue(options: ComboboxOption[], value: string, kind: string): ComboboxOption[] {
  return value.length > 0 && !options.some((option) => option.value === value)
    ? [unavailableOption(value, kind), ...options]
    : options
}

function uniqueHarnessOptions(launchers: readonly Launcher[]): ComboboxOption[] {
  const names = [...new Set(launchers.map((launcher) => launcher.agentKind))].toSorted((left, right) => left.localeCompare(right))
  return names.map((name) => {
    const count = launchers.filter((launcher) => launcher.agentKind === name).length
    return { label: name, leading: <AgentAvatar agentKind={name} />, sublabel: `${count} registered launcher${count === 1 ? "" : "s"}`, value: name }
  })
}

function correctiveText(staleFields: RoleRuntimeStaleFields, field: keyof RoleRuntimeStaleFields): ReactNode {
  const message = staleFields[field]
  return message === undefined ? null : <p className="text-xs text-destructive" data-role-runtime-stale={field} role="alert">{message}</p>
}

export function RoleRuntimeSection({ disabled, metadataState, onEffortChange, onHarnessChange, onLauncherChange, onModelChange, onRetry, showHeading = true, staleFields = {}, values }: RoleRuntimeSectionProps) {
  const harnessOptions = withSavedValue(uniqueHarnessOptions(metadataState.launchers), values.harness, "harness")
  const matchingLaunchers = metadataState.launchers.filter((launcher) => launcher.agentKind === values.harness)
  const launcherOptions = withSavedValue(
    matchingLaunchers.toSorted((left, right) => left.name.localeCompare(right.name)).map((launcher) => ({ label: launcher.name, leading: <AgentAvatar agentKind={launcher.agentKind} />, sublabel: launcher.agentKind, value: launcher.name })),
    values.launcher,
    "launcher",
  )
  const catalogue = catalogueFor(metadataState, values.launcher)
  const modelEntries = currentCatalogue(catalogue) ? catalogue?.models ?? [] : []
  const modelOptions = withSavedValue(modelEntries.map((model) => ({ label: deviceModelLabel(model), sublabel: model.description ?? undefined, value: model.name })), values.model, "model")
  const selectedModel = modelFor(catalogue, values.model)
  const effortOptions = selectedModel?.efforts.map((effort) => ({ label: effort.name, sublabel: effort.description ?? undefined, value: effort.name })) ?? []
  const loading = metadataState.status === "loading"
  const refreshing = metadataState.status === "refreshing" && metadataState.launcher === values.launcher
  const metadataError = metadataState.status === "error" && (metadataState.launcher === undefined || metadataState.launcher === values.launcher) ? metadataState.message : undefined
  const catalogueStatus = catalogue?.status ?? (values.launcher.length > 0 && (metadataError !== undefined || !loading && !refreshing) ? "unavailable" : undefined)
  const catalogueText = values.launcher.length === 0
    ? undefined
    : catalogueStatus === "stale"
      ? catalogueReasonText(catalogue, metadataError)
      : catalogueStatus === "unavailable"
        ? catalogueReasonText(catalogue, metadataError)
        : catalogueStatus === "unsupported"
          ? catalogueReasonText(catalogue, undefined)
          : catalogueStatus === "default-only"
            ? catalogueReasonText(catalogue, undefined)
            : catalogue !== undefined && catalogue.models.length === 0
              ? "No device models are available for this launcher."
              : catalogue === undefined && !loading && !refreshing
                ? catalogueReasonText(undefined, metadataError)
                : undefined
  const retryNeeded = values.launcher.length > 0 && (metadataError !== undefined || catalogueStatus === "stale" || catalogueStatus === "unavailable" || catalogue === undefined && !loading && !refreshing)
  const modelError = catalogueStatus === "unavailable" ? catalogueText ?? "The device model catalogue is unavailable." : null
  const modelDisabled = disabled || loading || values.launcher.length === 0 || catalogueStatus === "unsupported"
  const effortDisabled = disabled || selectedModel === undefined || selectedModel.efforts.length === 0

  return (
    <section aria-label={showHeading ? undefined : "Runtime preset"} aria-labelledby={showHeading ? "role-runtime-heading" : undefined} className={showHeading ? "space-y-4 border-t pt-5" : "space-y-4"} data-role-runtime>
      {showHeading && <div><h2 className="font-semibold" id="role-runtime-heading">Runtime defaults</h2><p className="mt-1 text-sm text-muted-foreground">Choose registered runtime values, or choose at spawn.</p></div>}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Combobox
            allOptionLabel="Choose at spawn"
            autoComplete="off"
            disabled={disabled || loading}
            id="role-agent-kind"
            label="Harness"
            name="agentKind"
            options={harnessOptions}
            placeholder="Search harnesses…"
            spellCheck={false}
            value={values.harness.length === 0 ? null : values.harness}
            onValueChange={onHarnessChange}
            description="The launcher process family."
            emptyMessage="No registered harnesses are available."
          />
          {correctiveText(staleFields, "harness")}
        </div>
        <div>
          <Combobox
            allOptionLabel="Choose at spawn"
            autoComplete="off"
            disabled={disabled || loading || values.harness.length === 0}
            id="role-launcher"
            label="Launcher"
            name="launcher"
            options={launcherOptions}
            placeholder="Search launchers…"
            spellCheck={false}
            value={values.launcher.length === 0 ? null : values.launcher}
            onValueChange={onLauncherChange}
            description={values.harness.length === 0 ? "Choose a harness first." : "A registered launcher for the selected harness."}
            emptyMessage="No registered launchers are available for this harness."
          />
          {correctiveText(staleFields, "launcher")}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Combobox
            allOptionLabel="Use launcher default"
            autoComplete="off"
            disabled={modelDisabled}
            errorMessage={modelError}
            id="role-model"
            label="Model"
            loading={refreshing}
            loadingMessage="Loading current models…"
            name="model"
            onRetry={onRetry}
            options={modelOptions}
            placeholder="Search models…"
            value={values.model.length === 0 ? null : values.model}
            onValueChange={onModelChange}
            description={values.launcher.length === 0 ? "Choose a launcher first." : catalogueText}
            emptyMessage="No models are reported by this launcher."
          />
          {correctiveText(staleFields, "model")}
        </div>
        <div>
          <Combobox
            allOptionLabel="Choose at spawn"
            autoComplete="off"
            disabled={effortDisabled}
            id="role-effort"
            label="Reasoning effort"
            name="effort"
            options={effortOptions}
            placeholder="Search efforts…"
            value={values.effort.length === 0 ? null : values.effort}
            onValueChange={onEffortChange}
            description={selectedModel === undefined ? "Choose a model first." : selectedModel.efforts.length === 0 ? "This model does not report reasoning values." : "Choose a reasoning effort reported by this model."}
            emptyMessage="No reasoning values are reported by this model."
          />
          {correctiveText(staleFields, "effort")}
        </div>
      </div>
      {metadataState.status === "loading" && <p className="text-sm text-muted-foreground" data-role-runtime-state="loading" role="status">Loading registered launchers and device model catalogues…</p>}
      {metadataState.status === "error" && metadataState.launcher === undefined && values.launcher.length === 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" data-role-runtime-state="error"><p className="text-destructive" role="alert">{metadataState.message}</p><Button data-role-runtime-retry onClick={onRetry} size="sm" type="button" variant="outline">Retry</Button></div>}
      {values.launcher.length > 0 && catalogueStatus !== undefined && catalogueText !== undefined && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-role-runtime-catalogue-state={catalogueStatus}><p className="text-amber-800 dark:text-amber-200" role={catalogueStatus === "stale" ? "status" : "alert"}>{catalogueText}</p>{retryNeeded && <Button data-role-runtime-retry disabled={metadataState.status === "refreshing"} onClick={onRetry} size="sm" type="button" variant="outline">{metadataState.status === "refreshing" ? "Retrying…" : "Retry"}</Button>}</div>}
      {values.launcher.length > 0 && catalogueStatus === "unsupported" && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-role-runtime-catalogue-state="unsupported">This launcher does not support model selection.</p>}
      {values.launcher.length > 0 && catalogueStatus === "default-only" && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-role-runtime-catalogue-state="default-only">This launcher provides its default model only.</p>}
      {values.launcher.length > 0 && catalogue !== undefined && currentCatalogue(catalogue) && catalogue.models.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-role-runtime-catalogue-state="empty">No models are available for this launcher.</p>}
      {values.harness.length === 0 && harnessOptions.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-role-runtime-state="empty">No registered launchers are available. Choose at spawn after a launcher is registered.</p>}
    </section>
  )
}
