import { useEffect, useMemo, useState, type FormEvent } from "react"
import { AlarmClock } from "lucide-react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { ApiResult, KeepAwakeSetting, KeepAwakeSettingResult, Member, MsgrApi } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import {
  KEEP_AWAKE_DEFAULTS,
  coordinatorCandidates,
  defaultCoordinator,
  describeSetting,
  draftFromLimits,
  limitBounds,
  limitHint,
  limitLabel,
  parseLimitsDraft,
  type KeepAwakeTone,
  type LimitField,
  type LimitsDraft,
} from "@/keep-awake"
import { cn } from "@/lib/utils"

/** What the control keeps awake. A channel also names its possible coordinators. */
export type KeepAwakeSubject =
  | { kind: "agent"; handle: string }
  | { kind: "channel"; name: string; members: readonly Member[]; leadHandles: ReadonlySet<string> }

export interface KeepAwakeControlProps {
  api: MsgrApi
  subject: KeepAwakeSubject
  /** Bumped by the `keepAwake` metadata scope, so the setting reloads. */
  revision: number
  /** Present when the viewer cannot change the setting, with the reason. */
  disabledReason?: string
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; setting: KeepAwakeSetting }
  | { status: "error"; message: string }

type ActionState = { status: "idle" } | { status: "working" } | { status: "error"; message: string }

type EditorState = { kind: "closed" } | { kind: "open"; draft: LimitsDraft; coordinator: string | null }

const LIMIT_FIELDS: readonly LimitField[] = ["idleMinutes", "blockedMinutes", "maxWakes"]

function subjectKey(subject: KeepAwakeSubject): string {
  switch (subject.kind) {
    case "agent":
      return `agent:${subject.handle}`
    case "channel":
      return `channel:${subject.name}`
  }
}

/** The agent handle or channel name that the subject names. */
function subjectName(subject: KeepAwakeSubject): string {
  switch (subject.kind) {
    case "agent":
      return subject.handle
    case "channel":
      return subject.name
  }
}

function readSetting(
  client: MsgrApi,
  kind: KeepAwakeSubject["kind"],
  name: string,
): ApiResult<KeepAwakeSettingResult> {
  switch (kind) {
    case "agent":
      return client.getAgentKeepAwake(name)
    case "channel":
      return client.getChannelKeepAwake(name)
  }
}

function clearSetting(client: MsgrApi, subject: KeepAwakeSubject): ApiResult<KeepAwakeSettingResult> {
  switch (subject.kind) {
    case "agent":
      return client.clearAgentKeepAwake(subject.handle)
    case "channel":
      return client.clearChannelKeepAwake(subject.name)
  }
}

function toneClass(tone: KeepAwakeTone): string {
  switch (tone) {
    case "off":
      return "text-muted-foreground"
    case "watching":
      return "text-primary"
    case "needs-human":
      return "text-amber-700 dark:text-amber-300"
  }
}

function formatWakeTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function initialCoordinator(subject: KeepAwakeSubject, setting: KeepAwakeSetting): string | null {
  if (subject.kind !== "channel") return null
  if (setting.kind === "on" && setting.policy.target.kind === "channel") return setting.policy.target.coordinator
  const choice = defaultCoordinator(subject.members, subject.leadHandles)
  return choice.kind === "chosen" ? choice.handle : null
}

/** Shows and edits one agent's or channel's keep-awake setting. */
export function KeepAwakeControl({ api, subject, revision, disabledReason }: KeepAwakeControlProps) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" })
  const [action, setAction] = useState<ActionState>({ status: "idle" })
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" })
  const key = subjectKey(subject)

  const kind = subject.kind
  const name = subjectName(subject)

  useEffect(() => {
    let active = true
    void apiCall(api, undefined, (client) => readSetting(client, kind, name)).then((result) => {
      if (!active) return
      setLoad(result.isOk()
        ? { status: "ready", setting: result.value.setting }
        : { status: "error", message: formatApiError(result.error) })
    })
    return () => {
      active = false
    }
  }, [api, kind, name, revision])

  const coordinatorOptions = useMemo<ComboboxOption[]>(
    () => subject.kind === "channel"
      ? coordinatorCandidates(subject.members).map((member) => ({
          value: member.handle,
          label: `@${member.handle}`,
          sublabel: subject.leadHandles.has(member.handle) ? "workspace lead" : member.agentKind ?? undefined,
        }))
      : [],
    [subject],
  )

  async function run(call: (client: MsgrApi) => ApiResult<KeepAwakeSettingResult>): Promise<void> {
    setAction({ status: "working" })
    const result = await apiCall(api, undefined, call)
    if (result.isErr()) {
      setAction({ status: "error", message: formatApiError(result.error) })
      return
    }
    setLoad({ status: "ready", setting: result.value.setting })
    setAction({ status: "idle" })
    setEditor({ kind: "closed" })
  }

  function openEditor(setting: KeepAwakeSetting): void {
    const limits = setting.kind === "on" ? setting.policy.limits : KEEP_AWAKE_DEFAULTS
    setAction({ status: "idle" })
    setEditor({ kind: "open", draft: draftFromLimits(limits), coordinator: initialCoordinator(subject, setting) })
  }

  function save(draft: LimitsDraft, coordinator: string | null): void {
    const parsed = parseLimitsDraft(draft)
    if (parsed.kind === "invalid") {
      setAction({ status: "error", message: parsed.message })
      return
    }
    switch (subject.kind) {
      case "agent":
        void run((client) => client.setAgentKeepAwake(subject.handle, parsed.limits))
        return
      case "channel":
        if (coordinator === null) {
          setAction({ status: "error", message: "Choose an agent member to receive the wake." })
          return
        }
        void run((client) => client.setChannelKeepAwake(subject.name, { ...parsed.limits, coordinator }))
    }
  }

  function resume(setting: KeepAwakeSetting): void {
    if (setting.kind !== "on") return
    save(draftFromLimits(setting.policy.limits), initialCoordinator(subject, setting))
  }

  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm" data-keep-awake={key}>
      <KeepAwakeSummaryRow
        action={action}
        disabledReason={disabledReason}
        editorOpen={editor.kind === "open"}
        load={load}
        onClear={() => void run((client) => clearSetting(client, subject))}
        onEdit={openEditor}
        onResume={resume}
      />
      {editor.kind === "open" && (
        <KeepAwakeEditor
          busy={action.status === "working"}
          coordinator={editor.coordinator}
          coordinatorOptions={coordinatorOptions}
          draft={editor.draft}
          onCancel={() => setEditor({ kind: "closed" })}
          onChange={(draft, coordinator) => setEditor({ kind: "open", draft, coordinator })}
          onSave={save}
          subject={subject}
        />
      )}
      {action.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{action.message}</p>}
    </section>
  )
}

interface SummaryRowProps {
  load: LoadState
  action: ActionState
  editorOpen: boolean
  disabledReason: string | undefined
  onEdit: (setting: KeepAwakeSetting) => void
  onClear: () => void
  onResume: (setting: KeepAwakeSetting) => void
}

function KeepAwakeSummaryRow({ load, action, editorOpen, disabledReason, onEdit, onClear, onResume }: SummaryRowProps) {
  switch (load.status) {
    case "loading":
      return <p className="text-sm text-muted-foreground">Loading keep awake…</p>
    case "error":
      return <p className="text-sm text-destructive" role="alert">{load.message}</p>
    case "ready":
      break
  }
  const setting = load.setting
  const summary = describeSetting(setting, formatWakeTime)
  const locked = disabledReason !== undefined || action.status === "working"
  return (
    <div className="flex flex-wrap items-center gap-3" data-keep-awake-state={summary.tone}>
      <AlarmClock aria-hidden="true" className={cn("size-5 shrink-0", toneClass(summary.tone))} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", toneClass(summary.tone))}>{summary.headline}</p>
        <p className="text-sm text-muted-foreground">{summary.detail}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {summary.tone === "needs-human" && (
          <Button disabled={locked} onClick={() => onResume(setting)} title={disabledReason ?? "Start a fresh watch with the same limits"} type="button">
            Resume
          </Button>
        )}
        {!editorOpen && (
          <Button disabled={locked} onClick={() => onEdit(setting)} title={disabledReason} type="button" variant="outline">
            {setting.kind === "off" ? "Turn on" : "Change"}
          </Button>
        )}
        {setting.kind === "on" && (
          <Button disabled={locked} onClick={onClear} title={disabledReason ?? "Stop keeping this awake"} type="button" variant="outline">
            Turn off
          </Button>
        )}
      </div>
    </div>
  )
}

interface EditorProps {
  subject: KeepAwakeSubject
  draft: LimitsDraft
  coordinator: string | null
  coordinatorOptions: readonly ComboboxOption[]
  busy: boolean
  onChange: (draft: LimitsDraft, coordinator: string | null) => void
  onSave: (draft: LimitsDraft, coordinator: string | null) => void
  onCancel: () => void
}

function KeepAwakeEditor({ subject, draft, coordinator, coordinatorOptions, busy, onChange, onSave, onCancel }: EditorProps) {
  const idPrefix = `keep-awake-${subjectKey(subject).replace(":", "-")}`

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSave(draft, coordinator)
  }

  return (
    <form className="mt-4 space-y-4 border-t pt-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-3">
        {LIMIT_FIELDS.map((field) => {
          const bounds = limitBounds(field)
          const id = `${idPrefix}-${field}`
          return (
            <div key={field}>
              <label className="text-sm font-medium" htmlFor={id}>{limitLabel(field)}</label>
              <input
                className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                disabled={busy}
                id={id}
                inputMode="numeric"
                max={bounds.max}
                min={bounds.min}
                name={field}
                onChange={(event) => onChange({ ...draft, [field]: event.target.value }, coordinator)}
                type="number"
                value={draft[field]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{limitHint(field)}</p>
            </div>
          )
        })}
      </div>
      {subject.kind === "channel" && (
        <Combobox
          description="This agent gets the wake when the whole channel is quiet."
          disabled={busy}
          emptyMessage="This channel has no agent members."
          id={`${idPrefix}-coordinator`}
          label="Wake this agent"
          onValueChange={(value) => onChange(draft, value)}
          options={coordinatorOptions}
          required
          showAllOption={false}
          value={coordinator}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} type="submit">Save</Button>
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">Cancel</Button>
      </div>
    </form>
  )
}
