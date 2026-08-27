import { useEffect, useMemo, useState, type FormEvent } from "react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { SpawnAgentRequest } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { hasActiveNativeLead } from "@/components/native-lead"
import type { AppController } from "@/hooks/use-app-controller"
import type { ShellRouter } from "@/shell-routing"
import {
  NO_ROLE_VALUE,
  deviceModelLabel,
  useSpawnAgentState,
} from "./spawn-state"
import {
  SpawnAssignmentSection,
  SpawnDetailsSection,
  SpawnReviewSection,
  SpawnRuntimeSection,
} from "./spawn-sections"
import { roleOptions, workspaceOptions } from "./spawn-sections-logic"

type ActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

export interface SpawnAgentPageProps {
  controller: AppController
  mode?: "add-reporter"
  navigate: ShellRouter["navigate"]
  roleName?: string
  workspaceId?: string
}

export function SpawnAgentPage({ controller, mode, navigate, roleName, workspaceId: initialWorkspaceId }: SpawnAgentPageProps) {
  const state = useSpawnAgentState({ controller, initialWorkspaceId, mode, roleName })
  const [actionState, setActionState] = useState<ActionState>({ status: "idle" })
  const [assignedHandle, setAssignedHandle] = useState<string | undefined>()
  const [assignedPaneId, setAssignedPaneId] = useState<string | undefined>()
  const canWrite = controller.identity !== null
  const awaiting = actionState.status === "working" && assignedHandle !== undefined
  const title = mode === "add-reporter" ? "Add reporter" : "Spawn agent"
  const selectedRoleName = state.selection.roleName
  const nativeLeadAlreadyActive = hasActiveNativeLead(state.selectedWorkspace, state.selectedRole)
  const currentCatalogue = state.selectedCatalogue?.status === "ready" || state.selectedCatalogue?.status === "default-only"
  const modelLabel = state.selectedModel === undefined ? "" : deviceModelLabel(state.selectedModel)
  const effortUnavailable = state.effortUnavailable
  const targetWorkspaceLabel = state.selectedWorkspace?.label ?? state.selectedWorkspaceId
  const roleSummary = state.selectedRole?.summary

  useEffect(() => {
    if (assignedPaneId === undefined || assignedHandle === undefined || actionState.status !== "working") return
    const pane = controller.workspaceData.workspaces.flatMap((workspace) => workspace.panes).find((candidate) => candidate.paneId === assignedPaneId)
    if (pane?.participant !== assignedHandle) return
    navigate({ kind: "agent", handle: assignedHandle })
  }, [actionState.status, assignedHandle, assignedPaneId, controller.workspaceData.workspaces, navigate])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return
      if (globalThis.document.querySelector('[data-combobox-open="true"]') !== null) return
      event.preventDefault()
      event.stopPropagation()
      controller.restoreSpawnAgentFocus()
      navigate(initialWorkspaceId === undefined ? { kind: "agents" } : { kind: "workspace", workspaceId: initialWorkspaceId })
    }
    globalThis.addEventListener("keydown", onKeyDown, true)
    return () => globalThis.removeEventListener("keydown", onKeyDown, true)
  }, [controller.restoreSpawnAgentFocus, initialWorkspaceId, navigate])

  const roleOptionList = useMemo(() => roleOptions(state.roles), [state.roles])
  const workspaceOptionList = useMemo(() => workspaceOptions(controller.workspaceData.workspaces), [controller.workspaceData.workspaces])
  const harnessOptionList = useMemo(() => state.harnessOptions.map((option) => ({ ...option, leading: <AgentAvatar agentKind={option.value} /> })), [state.harnessOptions])
  const launcherOptionList = useMemo(() => state.launcherOptions.map((option) => {
    const launcher = state.launchers.find((candidate) => candidate.name === option.value)
    return { ...option, leading: <AgentAvatar agentKind={launcher?.agentKind ?? state.selection.harness} /> }
  }), [state.launcherOptions, state.launchers, state.selection.harness])
  const submitDisabled = !canWrite || awaiting || nativeLeadAlreadyActive || state.metadataState.status !== "ready" || state.selectedWorkspaceId.length === 0 || state.selection.harness.length === 0 || state.selectedLauncher === undefined || !currentCatalogue || state.selectedModel === undefined || (!effortUnavailable && state.effort.length === 0)

  function clearActionState(): void {
    setActionState({ status: "idle" })
  }

  function selectRole(value: string | null): void {
    state.selectRole(value)
    clearActionState()
  }

  function selectWorkspace(value: string | null): void {
    state.selectWorkspace(value)
    clearActionState()
  }

  function selectHarness(value: string | null): void {
    state.selectHarness(value)
    clearActionState()
  }

  function selectLauncher(value: string | null): void {
    state.selectLauncher(value)
    clearActionState()
  }

  function selectModel(value: string | null): void {
    state.selectModel(value)
    clearActionState()
  }

  function selectEffort(value: string | null): void {
    state.selectEffort(value)
    clearActionState()
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (nativeLeadAlreadyActive) {
      setActionState({ message: "This workspace already has an active native lead. Stop it before you spawn another lead.", status: "error" })
      return
    }
    if (!canWrite) {
      setActionState({ message: NOT_CONNECTED_REASON, status: "error" })
      return
    }
    const built = state.buildRequest()
    if (!built.ok) {
      setActionState({ message: built.message, status: "error" })
      return
    }
    const request: SpawnAgentRequest = built.request
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.spawnAgent(request)).then((result) => result.match({
      err: (error) => setActionState({ message: formatApiError(error, { launchers: state.launchers.map((candidate) => candidate.name), lifecycleRole: selectedRoleName === NO_ROLE_VALUE ? undefined : selectedRoleName || undefined, lifecycleWorkspaceLabel: targetWorkspaceLabel, roles: state.roles.map((candidate) => candidate.name) }), status: "error" }),
      ok: ({ handle, paneId }) => {
        setAssignedHandle(handle)
        setAssignedPaneId(paneId)
        controller.setSpawnAgentPaneId(paneId)
        controller.setSpawnAgentAssignedHandle(handle)
        controller.setSpawnAgentState({ assignedHandle: handle, status: "awaiting-topology" })
        setActionState({ status: "working" })
      },
    }))
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-3 sm:p-4" data-dialog={mode === "add-reporter" ? "add-reporter" : "spawn-agent"} data-spawn-page>
      <form className="grid items-start gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]" data-shell-page-form="spawn-agent" data-spawn-layout onSubmit={submit}>
        {state.metadataState.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive lg:col-span-2" role="alert">{state.metadataState.message}</p>}
        {state.metadataState.status === "loading" && <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground lg:col-span-2" data-spawn-metadata-state="loading" role="status">Loading roles, launchers, and device model catalogue…</p>}
        <SpawnAssignmentSection
          metadataError={state.metadataState.status === "error" ? state.metadataState.message : undefined}
          metadataState={state.metadataState}
          nativeLeadAlreadyActive={nativeLeadAlreadyActive}
          onRoleChange={selectRole}
          onWorkspaceChange={selectWorkspace}
          roleDisabled={awaiting || mode === "add-reporter"}
          roleOptions={roleOptionList}
          roleValue={selectedRoleName}
          selectedRoleSummary={roleSummary}
          selectedWorkspaceId={state.selectedWorkspaceId}
          workspaceDescription={state.selectedWorkspace === undefined ? "Loading workspaces…" : `The agent will open in ${state.selectedWorkspace.label ?? state.selectedWorkspace.id}.`}
          workspaceDisabled={awaiting}
          workspaceOptions={workspaceOptionList}
        />
        <SpawnRuntimeSection
          awaiting={awaiting}
          catalogueNeedsRetry={state.catalogueNeedsRetry}
          catalogueRetry={state.catalogueRetry}
          catalogueState={state.catalogueState}
          catalogueStatusText={state.catalogueStatusText}
          effort={state.effort}
          effortOptions={state.effortOptions}
          effortUnavailable={effortUnavailable}
          harness={state.selection.harness}
          harnessOptions={harnessOptionList}
          launcher={state.selection.launcher}
          launcherOptions={launcherOptionList}
          model={state.selectedModelName}
          modelOptions={state.modelOptions}
          modelPickerError={state.modelPickerError}
          modelPickerLoading={state.modelPickerLoading}
          onEffortChange={selectEffort}
          onHarnessChange={selectHarness}
          onLauncherChange={selectLauncher}
          onModelChange={selectModel}
          selectedCatalogue={state.selectedCatalogue}
          selectedModel={state.selectedModel}
        />
        <SpawnDetailsSection awaiting={awaiting} goal={state.selection.goal} handle={state.resolvedHandle} onGoalChange={state.setGoal} onHandleChange={state.setHandle} readOnlyHandle={mode === "add-reporter"} roleBriefingPresent={state.roleBriefing.status === "present"} />
        <SpawnReviewSection actionError={actionState.status === "error" ? actionState.message : undefined} assignedHandle={assignedHandle} awaiting={awaiting} canWrite={canWrite} effort={state.effort} effortUnavailable={effortUnavailable} handle={state.resolvedHandle} harness={state.selection.harness} modelLabel={modelLabel} navigateBack={() => navigate(initialWorkspaceId === undefined ? { kind: "agents" } : { kind: "workspace", workspaceId: initialWorkspaceId })} roleName={selectedRoleName} selectedLauncher={state.selectedLauncher?.name ?? ""} selectedWorkspace={targetWorkspaceLabel} submitDisabled={submitDisabled} title={title} />
      </form>
    </div>
  )
}
