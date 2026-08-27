import { useEffect, useMemo, useState, type FormEvent } from "react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { Launcher } from "@/api/types"
import { LauncherAliasForm } from "@/components/launchers/launcher-alias-form"
import { accountProfileFromSavedKeys } from "@/components/launchers/account-profile"
import { argvFromArgumentRows, createLauncherRequestFromForm, harnessLabel, harnessOptions, initialLauncherForm, launcherDraftFromLauncher, launcherFormError, newArgumentRow, newEnvironmentRow, preserveAccountProfileRowsOnHarnessChange, updateLauncherRequestFromForm, type EnvironmentRow, type LauncherFormDraft } from "@/components/launchers/launcher-form"
import { LauncherList } from "@/components/launchers/launcher-list"
import type { CatalogueAction, CatalogueState, HarnessState, LauncherActionState, LaunchersState } from "@/components/launchers/launcher-state"
import { AgentAvatar } from "@/components/agent-avatar"
import type { ComboboxOption } from "@/components/ui/combobox"
import type { AppController } from "@/hooks/use-app-controller"
import type { ShellRouter } from "@/shell-routing"

interface LaunchersPageProps {
  controller: AppController
  launcherName?: string
  mode: "create" | "edit" | "list"
  navigate: ShellRouter["navigate"]
}

function formRouteSource(mode: LaunchersPageProps["mode"], launcherName: string | undefined): string {
  switch (mode) {
    case "create":
      return "create"
    case "edit":
      return `edit:${launcherName ?? ""}`
    case "list":
      return "list"
  }
}

function sortedLaunchers(launchers: readonly Launcher[]): Launcher[] {
  return launchers
    .map((launcher) => ({ ...launcher, argv: [...launcher.argv], envKeys: [...launcher.envKeys] }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
}

function launcherByName(state: LaunchersState, name: string | undefined): Launcher | undefined {
  if (state.status !== "ready" || name === undefined) return undefined
  return state.launchers.find((launcher) => launcher.name === name)
}

function harnessComboboxOptions(harnesses: readonly string[], launchers: readonly Launcher[]): ComboboxOption[] {
  return harnessOptions(launchers, harnesses).map((harness) => ({
    keywords: [harnessLabel(harness)],
    label: harnessLabel(harness),
    leading: <AgentAvatar agentKind={harness} />,
    sublabel: harness,
    value: harness,
  }))
}

function launcherErrorMessage(error: Parameters<typeof formatApiError>[0], form: LauncherFormDraft): string {
  const message = formatApiError(error)
  const folder = form.accountProfile.folder.trim()
  return folder.length === 0 ? message : message.replaceAll(folder, "[hidden account folder]")
}

export function LaunchersPage({ controller, launcherName, mode, navigate }: LaunchersPageProps) {
  const [launchersState, setLaunchersState] = useState<LaunchersState>({ status: "loading" })
  const [catalogueState, setCatalogueState] = useState<CatalogueState>({ status: "loading" })
  const [harnessState, setHarnessState] = useState<HarnessState>({ harnesses: [], status: "loading" })
  const [catalogueActions, setCatalogueActions] = useState<Record<string, CatalogueAction>>({})
  const [actionState, setActionState] = useState<LauncherActionState>({ status: "idle" })
  const [form, setForm] = useState<LauncherFormDraft>(initialLauncherForm)
  const [formSource, setFormSource] = useState<string | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<Launcher | undefined>()
  const [deleteConfirmation, setDeleteConfirmation] = useState("")
  const canWrite = controller.identity !== null

  useEffect(() => {
    let active = true
    setLaunchersState({ status: "loading" })
    setCatalogueState({ status: "loading" })
    setHarnessState({ harnesses: [], status: "loading" })
    void Promise.all([
      apiCall(controller.api, undefined, (client) => client.listLaunchers()),
      apiCall(controller.api, undefined, (client) => client.listModelCatalogue()),
      apiCall(controller.api, undefined, (client) => client.listHarnesses()),
    ]).then(([launchersResult, catalogueResult, harnessResult]) => {
      if (!active) return
      if (launchersResult.isOk()) setLaunchersState({ launchers: sortedLaunchers(launchersResult.value.launchers), status: "ready" })
      else setLaunchersState({ message: formatApiError(launchersResult.error), status: "error" })
      if (catalogueResult.isOk()) setCatalogueState({ catalogues: catalogueResult.value.catalogues, status: "ready" })
      else setCatalogueState({ catalogues: [], message: formatApiError(catalogueResult.error), status: "error" })
      if (harnessResult.isOk()) setHarnessState({ harnesses: harnessResult.value.harnesses, status: "ready" })
      else setHarnessState({ harnesses: [], status: "error" })
    })
    return () => {
      active = false
    }
  }, [controller.api])

  const editingLauncher = launcherByName(launchersState, launcherName)
  const routeSource = formRouteSource(mode, launcherName)
  const derivedForm = mode === "edit" && editingLauncher !== undefined ? launcherDraftFromLauncher(editingLauncher) : initialLauncherForm()
  const displayedForm = formSource === routeSource ? form : derivedForm
  const editNotReady = mode === "edit" && (launchersState.status !== "ready" || editingLauncher === undefined)
  const formDisabled = editNotReady || actionState.status === "working"
  const formPreview = useMemo(() => JSON.stringify(displayedForm.harness.length === 0 ? [] : argvFromArgumentRows(displayedForm.executable.length === 0 ? displayedForm.harness : displayedForm.executable, displayedForm.argumentRows)), [displayedForm.argumentRows, displayedForm.executable, displayedForm.harness])
  const comboboxOptions = useMemo(
    () => harnessComboboxOptions(harnessState.harnesses, launchersState.status === "ready" ? launchersState.launchers : []),
    [harnessState.harnesses, launchersState],
  )

  function updateForm<K extends keyof LauncherFormDraft>(key: K, value: LauncherFormDraft[K]): void {
    setForm((current) => {
      const base = formSource === routeSource ? current : displayedForm
      return { ...base, [key]: value }
    })
    setFormSource(routeSource)
    setActionState({ status: "idle" })
  }

  function updateEnvironmentRow(id: string, patch: Partial<EnvironmentRow>): void {
    updateForm("environmentRows", displayedForm.environmentRows.map((row) => row.id === id ? { ...row, ...patch } : row))
  }

  function updateHarness(harness: string): void {
    const previousHarness = displayedForm.harness
    const executable = displayedForm.executable.trim()
    const nextExecutable = executable.length === 0 || executable === previousHarness ? harness : displayedForm.executable
    const nextForm: LauncherFormDraft = {
      ...displayedForm,
      accountProfile: accountProfileFromSavedKeys(harness, []),
      environmentRows: preserveAccountProfileRowsOnHarnessChange(previousHarness, displayedForm.accountProfile, displayedForm.environmentRows),
      executable: nextExecutable,
      harness,
    }
    setForm(nextForm)
    setFormSource(routeSource)
    setActionState({ status: "idle" })
  }

  function clearDraft(): void {
    setForm(initialLauncherForm())
    setFormSource(undefined)
  }

  async function refreshExactLauncher(name: string): Promise<void> {
    const result = await apiCall(controller.api, undefined, (client) => client.refreshModelCatalogue({ launcher: name }))
    if (result.isOk()) {
      setCatalogueState({ catalogues: result.value.catalogues, status: "ready" })
      setCatalogueActions((current) => ({ ...current, [name]: { status: "idle" } }))
    } else {
      setCatalogueActions((current) => ({ ...current, [name]: { message: formatApiError(result.error), status: "error" } }))
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!canWrite) {
      setActionState({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    if (editNotReady) {
      setActionState({ message: "This launcher alias is not ready. Return to the launcher list.", status: "error" })
      return
    }
    const validation = launcherFormError(displayedForm, mode === "create" ? "create" : "edit")
    if (validation !== undefined) {
      setActionState({ message: validation, status: "error" })
      return
    }
    const operation = mode === "create"
      ? apiCall(controller.api, undefined, (client) => client.createLauncher(createLauncherRequestFromForm(displayedForm)))
      : launcherName === undefined
      ? undefined
      : apiCall(controller.api, undefined, (client) => client.updateLauncher(launcherName, updateLauncherRequestFromForm(displayedForm)))
    if (operation === undefined) {
      setActionState({ message: "This launcher alias is no longer available. Return to the launcher list.", status: "error" })
      return
    }
    setActionState({ status: "working" })
    void operation.then((result) => {
      if (result.isErr()) {
        setActionState({ message: launcherErrorMessage(result.error, displayedForm), status: "error" })
        return
      }
      const launcher = result.value
      setLaunchersState((current) => {
        const remaining = current.status === "ready" ? current.launchers.filter((candidate) => candidate.name !== launcher.name) : []
        return { launchers: sortedLaunchers([...remaining, launcher]), status: "ready" }
      })
      void refreshExactLauncher(launcher.name).finally(() => {
        clearDraft()
        setActionState({ status: "idle" })
        navigate({ kind: "launchers" })
      })
    })
  }

  function openDelete(launcher: Launcher): void {
    setDeleteTarget(launcher)
    setDeleteConfirmation("")
    setActionState({ status: "idle" })
  }

  function closeDelete(): void {
    setDeleteTarget(undefined)
    setDeleteConfirmation("")
  }

  function deleteLauncher(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (deleteTarget === undefined || deleteConfirmation !== deleteTarget.name) return
    if (!canWrite) {
      setActionState({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    setActionState({ status: "working" })
    void apiCall(controller.api, undefined, (client) => client.deleteLauncher(deleteTarget.name)).then((result) => {
      if (result.isErr()) {
        setActionState({ message: formatApiError(result.error), status: "error" })
        return
      }
      setLaunchersState((current) => current.status === "ready" ? { launchers: current.launchers.filter((launcher) => launcher.name !== deleteTarget.name), status: "ready" } : current)
      closeDelete()
      setActionState({ status: "idle" })
    })
  }

  function loadModels(launcher: Launcher): void {
    setCatalogueActions((current) => ({ ...current, [launcher.name]: { status: "working" } }))
    void apiCall(controller.api, undefined, (client) => client.refreshModelCatalogue({ launcher: launcher.name })).then((result) => {
      if (result.isErr()) {
        setCatalogueActions((current) => ({ ...current, [launcher.name]: { message: formatApiError(result.error), status: "error" } }))
        return
      }
      setCatalogueState({ catalogues: result.value.catalogues, status: "ready" })
      setCatalogueActions((current) => ({ ...current, [launcher.name]: { status: "idle" } }))
    })
  }

  if (mode === "list") {
    return <LauncherList
      actionState={actionState}
      canWrite={canWrite}
      catalogueActions={catalogueActions}
      catalogueState={catalogueState}
      deleteConfirmation={deleteConfirmation}
      deleteTarget={deleteTarget}
      launchersState={launchersState}
      navigate={navigate}
      onCloseDelete={closeDelete}
      onDelete={deleteLauncher}
      onDeleteConfirmationChange={setDeleteConfirmation}
      onLoadModels={loadModels}
      onOpenDelete={openDelete}
    />
  }

  const missingEditTarget = mode === "edit" && launchersState.status === "ready" && editingLauncher === undefined
  return <LauncherAliasForm
    actionState={actionState}
    api={controller.api}
    canWrite={canWrite}
    comboboxOptions={comboboxOptions}
    displayedForm={displayedForm}
    formDisabled={formDisabled}
    formPreview={formPreview}
    launcherName={launcherName}
    missingEditTarget={missingEditTarget}
    mode={mode}
    onAddArgument={() => updateForm("argumentRows", [...displayedForm.argumentRows, newArgumentRow()])}
    onAddEnvironment={() => updateForm("environmentRows", [...displayedForm.environmentRows, newEnvironmentRow()])}
    onCancel={() => { clearDraft(); navigate({ kind: "launchers" }) }}
    onRemoveArgument={(id) => updateForm("argumentRows", displayedForm.argumentRows.filter((row) => row.id !== id))}
    onRemoveEnvironment={(id) => {
      const target = displayedForm.environmentRows.find((row) => row.id === id)
      if (target?.kind === "saved") {
        updateEnvironmentRow(id, { action: "remove" })
        return
      }
      updateForm("environmentRows", displayedForm.environmentRows.filter((row) => row.id !== id))
    }}
    onSubmit={submitForm}
    onUpdateEnvironmentRow={updateEnvironmentRow}
    onHarnessChange={updateHarness}
    onUpdateField={updateForm}
  />
}
