import { useRef, useState } from "react"
import { LoaderCircle, UserPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Combobox } from "@/components/ui/combobox"
import { useSpawnAgentState } from "@/components/staffing/spawn-state"
import { roleOptions, workspaceOptions } from "@/components/staffing/spawn-sections-logic"
import { hasActiveNativeLead } from "@/components/native-lead"
import type { AppController } from "@/hooks/use-app-controller"
import { commandWriteFailure, type CommandFailure, type CommandSuccess } from "@/commands/execute"
import { COMMAND_MESSAGE_LIMIT, type SpawnLocation } from "@/commands/types"
import { shellRoutePath } from "@/shell-routing"

type SpawnSubmitState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "starting" }> | Readonly<{ kind: "failed"; failure: CommandFailure }>
const AGENT_HANDLE_LIMIT = 64
type WorkspaceChoice =
  Readonly<{ kind: "unchosen" }> | Readonly<{ kind: "chosen"; requestedId: string; selectedId: string }>

interface CommandSpawnProps {
  controller: AppController
  location: SpawnLocation
  requestedLocation: SpawnLocation
  onPending: (pending: boolean) => void
  onSuccess: (success: CommandSuccess) => void
}

function useCommandSpawn({ controller, location, requestedLocation, onPending, onSuccess }: CommandSpawnProps) {
  const model = useSpawnAgentState({
    controller,
    initialWorkspaceId: location.kind === "workspace" ? location.workspaceId : undefined,
  })
  const [state, setState] = useState<SpawnSubmitState>({ kind: "idle" })
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceChoice>({ kind: "unchosen" })
  const pending = useRef(false)
  const uncertain = state.kind === "failed" && state.failure.kind === "outcome-unknown"
  const requestedId = requestedLocation.kind === "workspace" ? requestedLocation.workspaceId : model.selectedWorkspaceId
  const workspaceMismatch =
    requestedId !== model.selectedWorkspaceId &&
    !(
      workspaceChoice.kind === "chosen" &&
      workspaceChoice.requestedId === requestedId &&
      workspaceChoice.selectedId === model.selectedWorkspaceId
    )
  const disabled = state.kind === "starting" || uncertain || controller.identity === null
  const chooseWorkspace = (id: string | null) => {
    if (id === null) return
    setWorkspaceChoice({ kind: "chosen", requestedId, selectedId: id })
    model.selectWorkspace(id)
  }
  async function spawn(): Promise<void> {
    if (pending.current || disabled || workspaceMismatch) return
    if (hasActiveNativeLead(model.selectedWorkspace, model.selectedRole)) {
      setState({
        kind: "failed",
        failure: { kind: "not-completed", message: "This workspace already has an active lead. Choose another role." },
      })
      return
    }
    const built = model.buildRequest()
    if (!built.ok) {
      setState({ kind: "failed", failure: { kind: "not-completed", message: built.message } })
      return
    }
    pending.current = true
    onPending(true)
    setState({ kind: "starting" })
    const result = await controller.api.spawnAgent(built.request)
    pending.current = false
    onPending(false)
    result.match({
      ok: ({ handle }) => {
        controller.workspaceData.reloadWorkspaces()
        onSuccess({ message: `Started ${handle}.`, destination: { kind: "agent", handle } })
      },
      err: (error) => setState({ kind: "failed", failure: commandWriteFailure(error) }),
    })
  }
  return { model, state, setState, uncertain, requestedId, workspaceMismatch, disabled, chooseWorkspace, spawn }
}

type SpawnEditor = ReturnType<typeof useCommandSpawn>
type SpawnFieldsProps = { model: SpawnEditor["model"]; disabled: boolean }

export function CommandSpawn(props: CommandSpawnProps) {
  const { controller } = props
  const editor = useCommandSpawn(props)
  const { model, disabled, chooseWorkspace, spawn } = editor
  return (
    <form
      className="command-spawn"
      onSubmit={(event) => {
        event.preventDefault()
        void spawn()
      }}
    >
      <div className="command-spawn-body">
        <SpawnIntroduction controller={controller} editor={editor} />
        <fieldset className="command-spawn-fields" disabled={disabled}>
          <SpawnAssignment
            controller={controller}
            model={model}
            disabled={disabled}
            chooseWorkspace={chooseWorkspace}
          />
          <SpawnRuntime model={model} disabled={disabled} />
          <SpawnModel model={model} disabled={disabled} />
          <SpawnGoal model={model} />
        </fieldset>
        <SpawnFeedback controller={controller} editor={editor} />
      </div>
      <SpawnFooter editor={editor} />
    </form>
  )
}

function SpawnIntroduction({ controller, editor }: { controller: AppController; editor: SpawnEditor }) {
  const { model, workspaceMismatch, disabled, requestedId, chooseWorkspace } = editor
  return (
    <>
      <div className="command-compose-heading">
        <span className="command-compose-mark">
          <UserPlus aria-hidden="true" />
        </span>
        <div>
          <p>Staff your workspace</p>
          <h2>Spawn an agent</h2>
        </div>
      </div>
      <p className="command-audience">Choose its job and runtime. The agent starts with Sheppard chat connected.</p>
      {workspaceMismatch && (
        <div className="command-data-warning" role="status">
          <p>
            Your saved setup uses a different workspace. Choose where this agent should start. The rest of your setup
            stays unchanged.
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Button
              disabled={disabled}
              onClick={() => chooseWorkspace(requestedId)}
              size="sm"
              type="button"
              variant="outline"
            >
              Use{" "}
              {controller.workspaceData.workspaces.find((workspace) => workspace.id === requestedId)?.label ??
                requestedId}
            </Button>
            <Button
              disabled={disabled}
              onClick={() => chooseWorkspace(model.selectedWorkspaceId)}
              size="sm"
              type="button"
              variant="outline"
            >
              Keep {model.selectedWorkspace?.label ?? model.selectedWorkspaceId}
            </Button>
          </div>
        </div>
      )}
      {model.metadataState.status === "loading" && <p role="status">Loading roles and launchers…</p>}
      {model.metadataState.status === "error" && (
        <p className="command-error" role="alert">
          {model.metadataState.message}
        </p>
      )}
    </>
  )
}

function SpawnAssignment({
  controller,
  model,
  disabled,
  chooseWorkspace,
}: SpawnFieldsProps & { controller: AppController; chooseWorkspace: SpawnEditor["chooseWorkspace"] }) {
  return (
    <>
      <Combobox
        disabled={disabled}
        showAllOption={false}
        label="Workspace"
        id="command-workspace"
        name="command-workspace"
        options={workspaceOptions(controller.workspaceData.workspaces)}
        onValueChange={chooseWorkspace}
        placeholder="Choose a workspace…"
        required
        value={model.selectedWorkspaceId || null}
      />
      <Combobox
        showAllOption={false}
        label="Role"
        id="command-role"
        disabled={disabled}
        name="command-role"
        options={roleOptions(model.roles)}
        onValueChange={model.selectRole}
        placeholder="Choose a role…"
        required
        value={model.selection.roleName || null}
      />
    </>
  )
}

function SpawnRuntime({ model, disabled }: SpawnFieldsProps) {
  return (
    <>
      <Combobox
        showAllOption={false}
        label="Harness"
        id="command-harness"
        disabled={disabled}
        name="command-harness"
        options={model.harnessOptions}
        onValueChange={model.selectHarness}
        placeholder="Choose a harness…"
        required
        value={model.selection.harness || null}
      />
      <Combobox
        showAllOption={false}
        label="Launcher"
        id="command-launcher"
        disabled={disabled}
        name="command-launcher"
        options={model.launcherOptions}
        onValueChange={model.selectLauncher}
        placeholder="Choose a launcher…"
        required
        value={model.selection.launcher || null}
      />
    </>
  )
}

function SpawnModel({ model, disabled }: SpawnFieldsProps) {
  return (
    <>
      <Combobox
        showAllOption={false}
        errorMessage={model.modelPickerError}
        label="Model"
        id="command-model"
        disabled={disabled}
        loading={model.modelPickerLoading}
        name="command-model"
        onRetry={model.catalogueRetry}
        options={model.modelOptions}
        onValueChange={model.selectModel}
        placeholder="Choose a device model…"
        required
        value={model.selectedModelName || null}
      />
      <Combobox
        showAllOption={false}
        disabled={disabled || model.effortUnavailable}
        label="Effort"
        id="command-effort"
        name="command-effort"
        options={model.effortOptions}
        onValueChange={model.selectEffort}
        placeholder={model.effortUnavailable ? "Not used by this model" : "Choose effort…"}
        required={!model.effortUnavailable}
        value={model.effort || null}
      />
    </>
  )
}

function SpawnGoal({ model }: { model: SpawnEditor["model"] }) {
  return (
    <>
      <label className="command-field">
        Handle
        <input
          autoComplete="off"
          maxLength={AGENT_HANDLE_LIMIT}
          name="command-handle"
          onChange={(event) => model.setHandle(event.target.value)}
          spellCheck={false}
          value={model.resolvedHandle}
        />
      </label>
      <p className="command-role-summary">{model.selectedRole?.summary ?? "Select a role to see its job."}</p>
      {model.roleBriefing.status === "present" && (
        <label className="command-field command-goal">
          Initial goal
          <textarea
            autoComplete="off"
            maxLength={COMMAND_MESSAGE_LIMIT}
            name="command-goal"
            onChange={(event) => model.setGoal(event.target.value)}
            placeholder="Describe what this agent should do…"
            rows={3}
            value={model.selection.goal}
          />
        </label>
      )}
      {model.roleBriefing.status === "empty" && (
        <p className="command-audience">This role has no initial briefing. Send the agent a message after it starts.</p>
      )}
    </>
  )
}

function SpawnFeedback({ controller, editor }: { controller: AppController; editor: SpawnEditor }) {
  const { model, state, uncertain, setState } = editor
  return (
    <>
      {model.catalogueStatusText !== undefined && <p className="command-audience">{model.catalogueStatusText}</p>}
      {state.kind === "failed" && (
        <p className="command-error" role="alert">
          {state.failure.message}
        </p>
      )}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            href={shellRoutePath({ kind: "workspace", workspaceId: model.selectedWorkspaceId })}
            target="_blank"
            rel="noreferrer"
          >
            Check workspace in a new tab
          </a>
          <Button onClick={() => setState({ kind: "idle" })} size="sm" type="button" variant="outline">
            I checked; allow another start
          </Button>
        </div>
      )}
      {controller.identity === null && (
        <p className="command-error" role="alert">
          Reload Sheppard to connect before you start an agent.
        </p>
      )}
    </>
  )
}

function SpawnFooter({ editor }: { editor: SpawnEditor }) {
  const { model, state, disabled, workspaceMismatch } = editor
  return (
    <div className="command-spawn-submit">
      <span>
        Starts in{" "}
        <strong>{model.selectedWorkspace?.label ?? (model.selectedWorkspaceId || "your selected workspace")}</strong>
      </span>
      <Button disabled={disabled || workspaceMismatch} type="submit">
        {state.kind === "starting" ? (
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        ) : (
          <UserPlus aria-hidden="true" />
        )}
        {state.kind === "starting" ? "Starting agent…" : "Spawn agent"}
      </Button>
    </div>
  )
}
