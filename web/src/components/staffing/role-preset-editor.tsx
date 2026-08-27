import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { RotateCcw } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { DeviceCatalogue, Launcher, RolePreset, UpdateRoleRuntimeRequest } from "@/api/types"
import { IdentityHint } from "@/components/staffing/shared"
import { Button } from "@/components/ui/button"
import type { AppController } from "@/hooks/use-app-controller"
import { cn } from "@/lib/utils"
import { RoleRuntimeSection } from "./role-runtime"
import {
  isRoleRuntimeValid,
  roleCatalogueNeedsRefresh,
  roleRuntimeStaleFields,
  type RoleRuntimeMetadataState,
  type RoleRuntimeValues,
} from "./role-runtime-logic"
import { roleAppearance, roleIcon } from "./spawn-sections-logic"

type SaveState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "saved" }
  | { status: "error"; message: string }

interface RolePresetEditorProps {
  canWrite: boolean
  catalogues: DeviceCatalogue[]
  controller: AppController
  launchers: Launcher[]
  onSaved: (role: RolePreset) => void
  role: RolePreset
}

function valuesFromRole(role: RolePreset): RoleRuntimeValues {
  return {
    effort: role.effort ?? "",
    harness: role.agentKind ?? "",
    launcher: role.launcher ?? "",
    model: role.model ?? "",
  }
}

function requestFromValues(values: RoleRuntimeValues): UpdateRoleRuntimeRequest {
  return {
    agentKind: values.harness.length === 0 ? null : values.harness,
    effort: values.effort.length === 0 ? null : values.effort,
    launcher: values.launcher.length === 0 ? null : values.launcher,
    model: values.model.length === 0 ? null : values.model,
  }
}

function sameRuntime(left: RoleRuntimeValues, right: RoleRuntimeValues): boolean {
  return left.harness === right.harness
    && left.launcher === right.launcher
    && left.model === right.model
    && left.effort === right.effort
}

function loadMetadata(api: AppController["api"]): Promise<RoleRuntimeMetadataState> {
  return Promise.all([
    apiCall(api, undefined, (client) => client.listLaunchers()),
    apiCall(api, undefined, (client) => client.listModelCatalogue()),
  ]).then(([launchersResult, cataloguesResult]) => {
    const nextLaunchers = launchersResult.match({ err: () => undefined, ok: ({ launchers }) => launchers })
    const nextCatalogues = cataloguesResult.match({ err: () => undefined, ok: ({ catalogues }) => catalogues })
    if (nextLaunchers === undefined || nextCatalogues === undefined) {
      const error = [launchersResult, cataloguesResult].find((result) => result.isErr())
      return {
        catalogues: nextCatalogues ?? [],
        launchers: nextLaunchers ?? [],
        message: error?.error === undefined ? "Runtime metadata could not be loaded." : formatApiError(error.error),
        status: "error",
      }
    }
    return { catalogues: nextCatalogues, launchers: nextLaunchers, status: "ready" }
  })
}

export function RolePresetEditor({ canWrite, catalogues, controller, launchers, onSaved, role }: RolePresetEditorProps) {
  const appearance = roleAppearance(role.name)
  const initialValues = useMemo(() => valuesFromRole(role), [role])
  const [values, setValues] = useState<RoleRuntimeValues>(initialValues)
  const [metadataState, setMetadataState] = useState<RoleRuntimeMetadataState>({ catalogues, launchers, status: "ready" })
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" })
  const catalogueAttempts = useRef(new Set<string>())
  const catalogueInFlight = useRef(new Set<string>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refreshCatalogue = useCallback((launcher: string, force: boolean): void => {
    if (launcher.length === 0 || catalogueInFlight.current.has(launcher)) return
    if (!force && catalogueAttempts.current.has(launcher)) return
    catalogueAttempts.current.add(launcher)
    catalogueInFlight.current.add(launcher)
    setMetadataState((current) => ({ catalogues: current.catalogues, launcher, launchers: current.launchers, status: "refreshing" }))
    void apiCall(controller.api, undefined, (client) => client.refreshModelCatalogue({ launcher })).then((result) => {
      catalogueInFlight.current.delete(launcher)
      if (!mounted.current) return
      result.match({
        err: (error) => setMetadataState((current) => ({ catalogues: current.catalogues, launcher, launchers: current.launchers, message: formatApiError(error), status: "error" })),
        ok: ({ catalogues: nextCatalogues }) => setMetadataState((current) => ({ catalogues: nextCatalogues, launchers: current.launchers, status: "ready" })),
      })
    })
  }, [controller.api])

  function updateValues(next: RoleRuntimeValues): void {
    setValues(next)
    setSaveState({ status: "idle" })
  }

  function selectHarness(value: string | null): void {
    updateValues({ effort: "", harness: value ?? "", launcher: "", model: "" })
  }

  function selectLauncher(value: string | null): void {
    const launcher = value ?? ""
    updateValues({ ...values, effort: "", launcher, model: "" })
    if (roleCatalogueNeedsRefresh(metadataState, launcher, catalogueAttempts.current.has(launcher), catalogueInFlight.current.has(launcher))) {
      refreshCatalogue(launcher, false)
    }
  }

  function selectModel(value: string | null): void {
    updateValues({ ...values, effort: "", model: value ?? "" })
  }

  function selectEffort(value: string | null): void {
    updateValues({ ...values, effort: value ?? "" })
  }

  function retry(): void {
    const launcher = values.launcher.trim()
    const hasMatchingLauncher = metadataState.launchers.some((candidate) => candidate.name === launcher && candidate.agentKind === values.harness)
    if (launcher.length > 0 && hasMatchingLauncher) {
      refreshCatalogue(launcher, true)
      return
    }
    setMetadataState({ catalogues: metadataState.catalogues, launchers: metadataState.launchers, status: "loading" })
    void loadMetadata(controller.api).then((next) => {
      if (mounted.current) setMetadataState(next)
    })
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!canWrite) {
      setSaveState({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    if (!isRoleRuntimeValid(values, metadataState)) {
      setSaveState({ message: "Choose current runtime values or choose at spawn.", status: "error" })
      return
    }
    setSaveState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.updateRoleRuntime(role.name, requestFromValues(values))).then((result) => result.match({
      err: (error) => setSaveState({ message: formatApiError(error), status: "error" }),
      ok: (updatedRole) => {
        setValues(valuesFromRole(updatedRole))
        setSaveState({ status: "saved" })
        onSaved(updatedRole)
      },
    }))
  }

  const staleFields = roleRuntimeStaleFields(values, metadataState)
  const runtimeValid = isRoleRuntimeValid(values, metadataState)
  const dirty = !sameRuntime(values, initialValues)

  return (
    <section aria-labelledby="role-preset-editor-heading" className={cn("rounded-xl border border-t-2 bg-card shadow-sm xl:sticky xl:top-4", appearance.panelClassName)} data-role-preset-editor={role.name}>
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset", appearance.iconSurfaceClassName)}>{roleIcon(role.name)}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold" id="role-preset-editor-heading">{role.name} preset</h2>
              {role.native === true && <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Built in</span>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">New {role.name} agents start with these values. You can change them before launch.</p>
          </div>
        </div>
      </div>
      <form className="space-y-4 p-4" onSubmit={save}>
        <RoleRuntimeSection disabled={saveState.status === "working"} metadataState={metadataState} onEffortChange={selectEffort} onHarnessChange={selectHarness} onLauncherChange={selectLauncher} onModelChange={selectModel} onRetry={retry} showHeading={false} staleFields={staleFields} values={values} />
        {saveState.status === "saved" && <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">Preset saved.</p>}
        {saveState.status === "error" && <p className="text-sm text-destructive" role="alert">{saveState.message}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <Button disabled={saveState.status === "working" || sameRuntime(values, { effort: "", harness: "", launcher: "", model: "" })} onClick={() => updateValues({ effort: "", harness: "", launcher: "", model: "" })} type="button" variant="ghost"><RotateCcw aria-hidden="true" /> Use spawn choices</Button>
          <IdentityHint canWrite={canWrite}><Button disabled={!canWrite || !dirty || !runtimeValid || saveState.status === "working"} title={canWrite ? dirty ? "Save role preset" : "No preset changes" : NOT_CONNECTED_REASON} type="submit">{saveState.status === "working" ? "Saving…" : "Save preset"}</Button></IdentityHint>
        </div>
      </form>
    </section>
  )
}
