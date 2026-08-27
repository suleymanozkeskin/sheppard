import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Bot, Eye, Pencil, Plus, Trash2 } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type {
  CreateModelRequest,
  CreateRoleRequest,
  DeviceCatalogue,
  Launcher,
  ModelEntry,
  RolePreset,
  RoleDefinition,
} from "@/api/types"
import { Button } from "@/components/ui/button"
import { SpawnAgentPage } from "@/components/staffing/spawn-page"
import { IdentityHint } from "@/components/staffing/shared"
import { RolePresetEditor } from "@/components/staffing/role-preset-editor"
import {
  RoleRuntimeSection,
} from "@/components/staffing/role-runtime"
import { isRoleRuntimeValid, roleCatalogueNeedsRefresh, roleRuntimeStaleFields, type RoleRuntimeMetadataState, type RoleRuntimeValues } from "@/components/staffing/role-runtime-logic"
import type { AppController } from "@/hooks/use-app-controller"
import type { ShellRouter } from "@/shell-routing"
import { cn } from "@/lib/utils"
import { roleAppearance, roleIcon } from "@/components/staffing/spawn-sections-logic"

type ActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

type RegistryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalogues: DeviceCatalogue[]; launchers: Launcher[]; models: ModelEntry[]; roles: RolePreset[] }

interface StaffingPageProps {
  controller: AppController
  navigate: ShellRouter["navigate"]
}

interface RoleFormValues {
  agentKind: string
  briefing: string
  effort: string
  launcher: string
  model: string
  name: string
  summary: string
}

interface RoleFormPageProps extends StaffingPageProps {
  name?: string
}

interface ModelFormValues {
  argvSuffix: string
  harness: string
  label: string
  name: string
}

const initialRoleForm: RoleFormValues = {
  agentKind: "",
  briefing: "",
  effort: "",
  launcher: "",
  model: "",
  name: "",
  summary: "",
}

const initialModelForm: ModelFormValues = { argvSuffix: "", harness: "", label: "", name: "" }

function optionalText(value: string | null | undefined): string {
  return value ?? ""
}

function roleFormFromDefinition(role: RoleDefinition): RoleFormValues {
  return {
    agentKind: optionalText(role.agentKind),
    briefing: role.briefing,
    effort: optionalText(role.effort),
    launcher: optionalText(role.launcher),
    model: optionalText(role.model),
    name: role.name,
    summary: role.summary,
  }
}

function roleRequestFromForm(form: RoleFormValues): CreateRoleRequest {
  const agentKind = form.agentKind.trim()
  return {
    agentKind: agentKind.length === 0 ? null : agentKind,
    briefing: form.briefing.trim(),
    effort: form.effort.trim().length === 0 ? null : form.effort.trim(),
    launcher: form.launcher.trim().length === 0 ? null : form.launcher.trim(),
    model: form.model.trim().length === 0 ? null : form.model.trim(),
    name: form.name.trim(),
    summary: form.summary.trim(),
  }
}

function loadRoleRuntimeMetadata(api: AppController["api"]): Promise<RoleRuntimeMetadataState> {
  const launchersRequest = apiCall(api, undefined, (client) => client.listLaunchers())
  const cataloguesRequest = apiCall(api, undefined, (client) => client.listModelCatalogue())
  return Promise.all([launchersRequest, cataloguesRequest]).then(([launchersResult, cataloguesResult]) => {
    const launchers = launchersResult.match({ err: () => undefined, ok: ({ launchers: entries }) => entries })
    const catalogues = cataloguesResult.match({ err: () => undefined, ok: ({ catalogues: entries }) => entries })
    if (launchers === undefined || catalogues === undefined) {
      const error = [launchersResult, cataloguesResult].find((result) => result.isErr())
      return {
        catalogues: catalogues ?? [],
        launchers: launchers ?? [],
        message: error?.error === undefined ? "Runtime metadata could not be loaded." : formatApiError(error.error),
        status: "error",
      }
    }
    return { catalogues, launchers, status: "ready" }
  })
}

function roleChip(label: string, value: string | null | undefined): ReactNode {
  if (value === null || value === undefined || value.length === 0) return null
  return <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground" data-role-chip={`${label}:${value}`}>{label}: {value}</span>
}

function modelKey(model: ModelEntry): string {
  return `${model.harness}:${model.name}`
}

function LoadingBlock({ children = "Loading…" }: { children?: ReactNode }) {
  return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" role="status">{children}</p>
}

function loadRegistry(api: AppController["api"]): Promise<RegistryState> {
  return Promise.all([
    apiCall(api, undefined, (client) => client.listLaunchers()),
    apiCall(api, undefined, (client) => client.listModels()),
    apiCall(api, undefined, (client) => client.listRoles()),
    apiCall(api, undefined, (client) => client.listModelCatalogue()),
  ]).then(([launchersResult, modelsResult, rolesResult, cataloguesResult]) => {
    const launchers = launchersResult.match({ ok: ({ launchers: entries }) => entries, err: () => undefined })
    const models = modelsResult.match({ ok: ({ models: entries }) => entries, err: () => undefined })
    const roles = rolesResult.match({ ok: ({ roles: entries }) => entries, err: () => undefined })
    const catalogues = cataloguesResult.match({ ok: ({ catalogues: entries }) => entries, err: () => undefined })
    if (launchers === undefined || models === undefined || roles === undefined || catalogues === undefined) {
      const error = [launchersResult, modelsResult, rolesResult, cataloguesResult].find((result) => result.isErr())
      return { message: error?.error === undefined ? "The staffing registry could not be loaded." : formatApiError(error.error), status: "error" }
    }
    return { catalogues, launchers, models, roles, status: "ready" }
  })
}

export function StaffingPage({ controller, navigate }: StaffingPageProps) {
  const [state, setState] = useState<RegistryState>({ status: "loading" })
  const [actionState, setActionState] = useState<ActionState>({ status: "idle" })
  const [deleteTarget, setDeleteTarget] = useState<RolePreset | undefined>()
  const [deleteConfirmation, setDeleteConfirmation] = useState("")
  const [selectedRoleName, setSelectedRoleName] = useState("worker")
  const canWrite = controller.identity !== null

  useEffect(() => {
    let mounted = true
    void loadRegistry(controller.api).then((next) => {
      if (mounted) setState(next)
    })
    return () => { mounted = false }
  }, [controller.api])

  function openDelete(role: RolePreset): void {
    if (role.native === true) return
    setDeleteTarget(role)
    setDeleteConfirmation("")
    setActionState({ status: "idle" })
  }

  function closeDelete(): void {
    setDeleteTarget(undefined)
    setDeleteConfirmation("")
  }

  function deleteRole(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (deleteTarget === undefined || deleteTarget.native === true || deleteConfirmation !== deleteTarget.name) return
    if (!canWrite) {
      setActionState({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.deleteRole(deleteTarget.name)).then((result) => result.match({
      ok: () => {
        setState((current) => current.status === "ready"
          ? { ...current, roles: current.roles.filter((role) => role.name !== deleteTarget.name) }
          : current)
        closeDelete()
        setActionState({ status: "idle" })
      },
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const selectedRole = state.status === "ready"
    ? state.roles.find((role) => role.name === selectedRoleName) ?? state.roles.find((role) => role.name === "worker") ?? state.roles[0]
    : undefined

  function savePreset(updatedRole: RolePreset): void {
    setState((current) => current.status === "ready"
      ? { ...current, roles: current.roles.map((role) => role.name === updatedRole.name ? updatedRole : role) }
      : current)
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 p-4 sm:p-6" data-directory="staffing" data-staffing-page>
      <p className="max-w-3xl text-sm text-muted-foreground">Choose a role, then set the runtime values that new agents should use by default.</p>
      {state.status === "loading" && <LoadingBlock>Loading staffing registry…</LoadingBlock>}
      {state.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{state.message}</p>}
      {state.status === "ready" && (
        <div className="space-y-5">
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(26rem,0.9fr)]">
          <section aria-labelledby="staffing-roles-heading" className="rounded-xl border bg-card" data-staffing-roles>
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div><h2 className="font-semibold" id="staffing-roles-heading">Role presets</h2><p className="mt-1 text-xs text-muted-foreground">Select a role to change its default runtime.</p></div>
              <span className="text-xs text-muted-foreground" data-role-count>{state.roles.length}</span>
            </div>
            {state.roles.length === 0 && <p className="p-6 text-sm text-muted-foreground">No roles are registered.</p>}
            {state.roles.length > 0 && (
              <ul className="divide-y" data-role-list role="list">
                {state.roles.toSorted((left, right) => left.name.localeCompare(right.name)).map((role) => {
                  const appearance = roleAppearance(role.name)
                  return <li className={cn("border-l-2 border-l-transparent p-3 transition-colors", selectedRole?.name === role.name && appearance.selectedClassName)} data-role-row={role.name} key={role.name}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <button aria-pressed={selectedRole?.name === role.name} className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedRoleName(role.name)} type="button">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset", appearance.iconSurfaceClassName)}>{roleIcon(role.name)}</span>
                          <h3 className="font-medium" data-role-name>{role.name}</h3>
                          {role.native === true && <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground" data-role-native>Built in</span>}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground" data-role-summary>{role.summary}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5" data-role-chips>
                          {roleChip("kind", role.agentKind)}
                          {roleChip("launcher", role.launcher)}
                          {roleChip("model", role.model)}
                          {roleChip("effort", role.effort)}
                        </div>
                      </button>
                      <div className="flex shrink-0 flex-wrap gap-1 sm:justify-end">
                        <IdentityHint canWrite={canWrite}><Button aria-label={`Spawn ${role.name}`} data-role-spawn={role.name} disabled={!canWrite} onClick={() => navigate({ kind: "spawn-agent", role: role.name })} size="sm" title={canWrite ? `Spawn ${role.name}` : NOT_CONNECTED_REASON} type="button" variant="outline"><Bot aria-hidden="true" /> Spawn</Button></IdentityHint>
                        <Button aria-label={`${role.native === true ? "View" : "Edit"} role ${role.name}`} data-role-edit={role.name} disabled={!canWrite} onClick={() => navigate({ kind: "edit-role", name: role.name })} size="sm" title={role.native === true ? "View built-in role instructions" : canWrite ? `Edit role ${role.name}` : NOT_CONNECTED_REASON} type="button" variant="ghost">{role.native === true ? <Eye aria-hidden="true" /> : <Pencil aria-hidden="true" />} {role.native === true ? "View" : "Edit"}</Button>
                        {role.native !== true && <Button aria-label={`Delete role ${role.name}`} data-role-delete={role.name} disabled={!canWrite} onClick={() => openDelete(role)} size="sm" title={canWrite ? `Delete role ${role.name}` : NOT_CONNECTED_REASON} type="button" variant="ghost"><Trash2 aria-hidden="true" /> Delete</Button>}
                      </div>
                    </div>
                  </li>
                })}
              </ul>
            )}
            {deleteTarget !== undefined && (
              <div className="border-t bg-muted/20 p-4" data-role-delete-confirmation>
                <p className="text-sm">Type <code>{deleteTarget.name}</code> to delete this role.</p>
                <form className="mt-3 flex flex-wrap gap-2" onSubmit={deleteRole}>
                  <label className="sr-only" htmlFor="delete-role-confirm">Role name</label>
                  <input className="h-9 min-w-48 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" data-confirm-input={deleteTarget.name} id="delete-role-confirm" onChange={(event) => setDeleteConfirmation(event.target.value)} value={deleteConfirmation} />
                  <Button onClick={closeDelete} type="button" variant="ghost">Cancel</Button>
                  <Button disabled={!canWrite || actionState.status === "working" || deleteConfirmation !== deleteTarget.name} type="submit">{actionState.status === "working" ? "Deleting…" : "Delete role"}</Button>
                </form>
                {actionState.status === "error" && <p className="mt-2 text-sm text-destructive" role="alert">{actionState.message}</p>}
              </div>
            )}
          </section>

          {selectedRole === undefined
            ? <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Create a role to add a runtime preset.</p>
            : <RolePresetEditor canWrite={canWrite} catalogues={state.catalogues} controller={controller} key={selectedRole.name} launchers={state.launchers} onSaved={savePreset} role={selectedRole} />}
        </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <section aria-labelledby="staffing-models-heading" className="rounded-xl border bg-card" data-staffing-models>
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div><h3 className="font-semibold" id="staffing-models-heading">Models</h3><p className="mt-1 text-xs text-muted-foreground">The registry shows names only. Command suffixes stay server-owned.</p></div><Button aria-label="Add model" data-staffing-create-model disabled={!canWrite} onClick={() => navigate({ kind: "create-model" })} title={canWrite ? "Add model" : NOT_CONNECTED_REASON} type="button" variant="outline"><Plus aria-hidden="true" /> Add model</Button></div>
              {state.models.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No models are registered.</p> : <ul aria-label="Model registry" className="divide-y" data-model-list role="list">{state.models.toSorted((left, right) => modelKey(left).localeCompare(modelKey(right))).map((model) => <li className="flex items-center justify-between gap-3 px-4 py-3" data-model-row={modelKey(model)} key={modelKey(model)}><span className="font-mono text-sm" data-model-name>{model.harness}/{model.name}</span>{model.label !== undefined && <span className="text-xs text-muted-foreground">{model.label}</span>}</li>)}</ul>}
            </section>
            <section aria-labelledby="staffing-launchers-heading" className="rounded-xl border bg-card" data-staffing-launchers>
              <div className="border-b px-4 py-3"><h3 className="font-semibold" id="staffing-launchers-heading">Launchers</h3><p className="mt-1 text-xs text-muted-foreground">Launcher names bind to registered commands and agent kinds.</p></div>
              {state.launchers.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No launchers are registered.</p> : <ul aria-label="Staffing launcher registry" className="divide-y" data-staffing-launcher-list role="list">{state.launchers.toSorted((left, right) => left.name.localeCompare(right.name)).map((launcher) => <li className="flex items-center justify-between gap-3 px-4 py-3" data-launcher-row={launcher.name} key={launcher.name}><span className="font-mono text-sm">{launcher.name}</span><span className="text-xs text-muted-foreground">{launcher.agentKind}</span></li>)}</ul>}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

export function RoleFormPage({ controller, name, navigate }: RoleFormPageProps) {
  const editing = name !== undefined
  const [form, setForm] = useState<RoleFormValues>(initialRoleForm)
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(editing ? "loading" : "ready")
  const [runtimeState, setRuntimeState] = useState<RoleRuntimeMetadataState>({ catalogues: [], launchers: [], status: "loading" })
  const [nativeRole, setNativeRole] = useState(false)
  const [actionState, setActionState] = useState<ActionState>({ status: "idle" })
  const catalogueAttempts = useRef(new Set<string>())
  const catalogueInFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  const canWrite = controller.identity !== null

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refreshRuntimeCatalogue = useCallback((launcher: string, force: boolean): void => {
    if (launcher.length === 0 || catalogueInFlight.current.has(launcher)) return
    if (!force && catalogueAttempts.current.has(launcher)) return
    catalogueAttempts.current.add(launcher)
    catalogueInFlight.current.add(launcher)
    setRuntimeState((current) => ({ catalogues: current.catalogues, launcher, launchers: current.launchers, status: "refreshing" }))
    void apiCall(controller.api, undefined, (client) => client.refreshModelCatalogue({ launcher })).then((result) => {
      catalogueInFlight.current.delete(launcher)
      if (!mounted.current) return
      result.match({
        err: (error) => setRuntimeState((current) => ({ catalogues: current.catalogues, launcher, launchers: current.launchers, message: formatApiError(error), status: "error" })),
        ok: ({ catalogues }) => setRuntimeState((current) => ({ catalogues, launchers: current.launchers, status: "ready" })),
      })
    })
  }, [controller.api])

  useEffect(() => {
    let mounted = true
    setRuntimeState({ catalogues: [], launchers: [], status: "loading" })
    const roleRequest = editing && name !== undefined
      ? apiCall(controller.api, undefined, (client) => client.getRole(name))
      : Promise.resolve(undefined)
    const runtimeRequest = loadRoleRuntimeMetadata(controller.api)
    void Promise.all([roleRequest, runtimeRequest]).then(([result, nextRuntimeState]) => {
      if (!mounted) return
      setRuntimeState(nextRuntimeState)
      if (result === undefined) {
        setLoadState("ready")
        return
      }
      result.match({
        ok: ({ role }) => { setForm(roleFormFromDefinition(role)); setNativeRole(role.native === true); setLoadState("ready") },
        err: (error) => { setActionState({ message: formatApiError(error), status: "error" }); setLoadState("error") },
      })
    })
    return () => { mounted = false }
  }, [controller.api, editing, name])

  useEffect(() => {
    const launcher = form.launcher.trim()
    if (!roleCatalogueNeedsRefresh(runtimeState, launcher, catalogueAttempts.current.has(launcher), catalogueInFlight.current.has(launcher))) return
    refreshRuntimeCatalogue(launcher, false)
  }, [form.launcher, refreshRuntimeCatalogue, runtimeState])

  function update<K extends keyof RoleFormValues>(key: K, value: RoleFormValues[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
    setActionState({ status: "idle" })
  }

  function updateRuntime(values: Partial<Pick<RoleFormValues, "agentKind" | "effort" | "launcher" | "model">>): void {
    setForm((current) => ({ ...current, ...values }))
    setActionState({ status: "idle" })
  }

  function selectHarness(value: string | null): void {
    const harness = value ?? ""
    updateRuntime({ agentKind: harness, effort: "", launcher: "", model: "" })
  }

  function selectLauncher(value: string | null): void {
    updateRuntime({ effort: "", launcher: value ?? "", model: "" })
  }

  function selectModel(value: string | null): void {
    updateRuntime({ effort: "", model: value ?? "" })
  }

  function selectEffort(value: string | null): void {
    updateRuntime({ effort: value ?? "" })
  }

  const roleRuntimeValues = useMemo<RoleRuntimeValues>(() => ({ effort: form.effort, harness: form.agentKind, launcher: form.launcher, model: form.model }), [form.agentKind, form.effort, form.launcher, form.model])
  const staleRuntimeFields = useMemo(() => roleRuntimeStaleFields(roleRuntimeValues, runtimeState), [roleRuntimeValues, runtimeState])
  const runtimeValid = isRoleRuntimeValid(roleRuntimeValues, runtimeState)
  const retryRuntime = useCallback((): void => {
    const launcher = form.launcher.trim()
    const hasMatchingLauncher = runtimeState.launchers.some((candidate) => candidate.name === launcher && candidate.agentKind === form.agentKind.trim())
    if (launcher.length > 0 && hasMatchingLauncher) {
      refreshRuntimeCatalogue(launcher, true)
      return
    }
    setRuntimeState((current) => ({ catalogues: current.catalogues, launchers: current.launchers, status: "loading" }))
    void loadRoleRuntimeMetadata(controller.api).then((next) => setRuntimeState(next))
  }, [controller.api, form.agentKind, form.launcher, refreshRuntimeCatalogue, runtimeState.launchers])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (nativeRole) { setActionState({ message: "Native roles are read-only. Create a new role to customize these values.", status: "error" }); return }
    if (!canWrite) { setActionState({ message: NOT_CONNECTED_REASON, status: "error" }); return }
    if (!runtimeValid) {
      setActionState({ message: "Choose current runtime values or choose at spawn.", status: "error" })
      return
    }
    const request = roleRequestFromForm(form)
    if (request.name.length === 0 || request.summary.length === 0 || request.briefing.length === 0) {
      setActionState({ message: "Enter a name, summary, and briefing.", status: "error" })
      return
    }
    setActionState({ status: "working" })
    const operation = editing && name !== undefined
      ? apiCall(controller.api, controller.fallbackApi, (client) => client.updateRole(name, request))
      : apiCall(controller.api, controller.fallbackApi, (client) => client.createRole(request))
    void operation.then((result) => result.match({
      ok: () => navigate({ kind: "staffing" }),
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  if (loadState === "loading") return <div className="mx-auto w-full max-w-2xl p-4 sm:p-6"><LoadingBlock>{editing ? "Loading role and runtime metadata…" : "Loading runtime metadata…"}</LoadingBlock></div>
  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6" data-role-form={editing ? "edit" : "create"} data-role-native={nativeRole ? "true" : undefined}>
      <form className="space-y-5 rounded-xl border bg-card p-5 shadow-sm sm:p-6" data-shell-page-form={editing ? "edit-role" : "create-role"} onSubmit={submit}>
        <div><h2 className="text-base font-semibold">{editing ? `${nativeRole ? "View" : "Edit"} ${name}` : "Create role"}</h2><p className="mt-1 text-sm text-muted-foreground">A role supplies instructions and spawn defaults.</p>{nativeRole && <p className="mt-2 text-sm text-muted-foreground" data-role-native-message>Built-in role instructions are read-only. Change this role's runtime preset on Role presets.</p>}</div>
        <div><label className="text-sm font-medium" htmlFor="role-name">Name</label><input autoComplete="off" className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 read-only:bg-muted/40" disabled={editing} id="role-name" name="name" onChange={(event) => update("name", event.target.value)} readOnly={editing} spellCheck={false} value={form.name} /></div>
        <div><label className="text-sm font-medium" htmlFor="role-summary">Summary</label><input autoComplete="off" className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={nativeRole} id="role-summary" name="summary" onChange={(event) => update("summary", event.target.value)} spellCheck={false} value={form.summary} /></div>
        <RoleRuntimeSection disabled={nativeRole} metadataState={runtimeState} onEffortChange={selectEffort} onHarnessChange={selectHarness} onLauncherChange={selectLauncher} onModelChange={selectModel} onRetry={retryRuntime} staleFields={staleRuntimeFields} values={roleRuntimeValues} />
        <div><label className="text-sm font-medium" htmlFor="role-briefing">Briefing</label><textarea autoComplete="off" className="mt-2 min-h-40 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" data-role-briefing disabled={nativeRole} id="role-briefing" name="briefing" onChange={(event) => update("briefing", event.target.value)} spellCheck={false} value={form.briefing} /><p className="mt-1 text-xs text-muted-foreground">This text is sent when the role is selected for spawn. It is not shown in the open role list.</p></div>
        {actionState.status === "error" && <p className="text-sm text-destructive" role="alert">{actionState.message}</p>}
        <div className="flex justify-end gap-2"><Button onClick={() => navigate({ kind: "staffing" })} type="button" variant="ghost">Cancel</Button><IdentityHint canWrite={canWrite}><Button disabled={!canWrite || nativeRole || !runtimeValid || actionState.status === "working" || loadState === "error"} title={nativeRole ? "Native roles are read-only" : canWrite ? "Save role" : NOT_CONNECTED_REASON} type="submit">{actionState.status === "working" ? "Saving…" : editing ? "Save role" : "Create role"}</Button></IdentityHint></div>
      </form>
    </div>
  )
}

export function ModelFormPage({ controller, navigate }: StaffingPageProps) {
  const [form, setForm] = useState<ModelFormValues>(initialModelForm)
  const [actionState, setActionState] = useState<ActionState>({ status: "idle" })
  const canWrite = controller.identity !== null

  function update<K extends keyof ModelFormValues>(key: K, value: ModelFormValues[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
    setActionState({ status: "idle" })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!canWrite) { setActionState({ message: NOT_CONNECTED_REASON, status: "error" }); return }
    const request: CreateModelRequest = {
      argvSuffix: form.argvSuffix.length === 0 ? [] : form.argvSuffix.split(/\r?\n/u),
      harness: form.harness.trim(),
      label: form.label.trim().length === 0 ? undefined : form.label.trim(),
      name: form.name.trim(),
    }
    if (request.harness.length === 0 || request.name.length === 0) {
      setActionState({ message: "Enter a harness and model name.", status: "error" })
      return
    }
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.createModel(request)).then((result) => result.match({
      ok: () => navigate({ kind: "staffing" }),
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6" data-model-form>
      <form className="space-y-5 rounded-xl border bg-card p-5 shadow-sm sm:p-6" data-shell-page-form="create-model" onSubmit={submit}>
        <div><h2 className="text-base font-semibold">Add model</h2><p className="mt-1 text-sm text-muted-foreground">Register a model name. Command arguments remain in the server registry.</p></div>
        <div><label className="text-sm font-medium" htmlFor="model-harness">Harness</label><input className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="model-harness" onChange={(event) => update("harness", event.target.value)} placeholder="claude" value={form.harness} /></div>
        <div><label className="text-sm font-medium" htmlFor="model-name">Model name</label><input className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="model-name" onChange={(event) => update("name", event.target.value)} placeholder="Enter model name" value={form.name} /></div>
        <div><label className="text-sm font-medium" htmlFor="model-label">Label (optional)</label><input className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="model-label" onChange={(event) => update("label", event.target.value)} value={form.label} /></div>
        <div><label className="text-sm font-medium" htmlFor="model-argv-suffix">Server argv suffix</label><textarea className="mt-2 min-h-28 w-full resize-y rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="model-argv-suffix" onChange={(event) => update("argvSuffix", event.target.value)} value={form.argvSuffix} /><p className="mt-1 text-xs text-muted-foreground">One server-owned argument per line. This value is never shown in the open model list or spawn request.</p></div>
        {actionState.status === "error" && <p className="text-sm text-destructive" role="alert">{actionState.message}</p>}
        <div className="flex justify-end gap-2"><Button onClick={() => navigate({ kind: "staffing" })} type="button" variant="ghost">Cancel</Button><IdentityHint canWrite={canWrite}><Button disabled={!canWrite || actionState.status === "working"} title={canWrite ? "Add model" : NOT_CONNECTED_REASON} type="submit">{actionState.status === "working" ? "Saving…" : "Add model"}</Button></IdentityHint></div>
      </form>
    </div>
  )
}

export { SpawnAgentPage }
