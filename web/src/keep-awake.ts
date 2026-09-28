import type {
  AlertMessage,
  HerdrWorkspaceView,
  KeepAwakeLimits,
  KeepAwakePolicy,
  KeepAwakeSetting,
  Member,
  NeedsHumanCause,
  UnrecognizedDialogReason,
} from "@/api/types"

/** The same bounds and defaults the hub's limits parser enforces. */
export const KEEP_AWAKE_MIN = 1
export const KEEP_AWAKE_MAX_MINUTES = 1_440
export const KEEP_AWAKE_MAX_WAKES = 10
export const KEEP_AWAKE_DEFAULTS: KeepAwakeLimits = { idleMinutes: 20, blockedMinutes: 30, maxWakes: 3 }

export type LimitField = keyof KeepAwakeLimits

/** The form holds text, so a half-typed number is a draft, not a limit. */
export interface LimitsDraft {
  idleMinutes: string
  blockedMinutes: string
  maxWakes: string
}

export interface LimitBounds {
  min: number
  max: number
}

export type LimitsDraftResult =
  | { kind: "valid"; limits: KeepAwakeLimits }
  | { kind: "invalid"; field: LimitField; message: string }

const LIMIT_FIELDS: readonly LimitField[] = ["idleMinutes", "blockedMinutes", "maxWakes"]

function ceilingFor(field: LimitField): number {
  switch (field) {
    case "idleMinutes":
    case "blockedMinutes":
      return KEEP_AWAKE_MAX_MINUTES
    case "maxWakes":
      return KEEP_AWAKE_MAX_WAKES
  }
}

export function limitLabel(field: LimitField): string {
  switch (field) {
    case "idleMinutes":
      return "Idle minutes"
    case "blockedMinutes":
      return "Dialog minutes"
    case "maxWakes":
      return "Wakes"
  }
}

export function limitHint(field: LimitField): string {
  switch (field) {
    case "idleMinutes":
      return "Wake after this many idle minutes."
    case "blockedMinutes":
      return "Close an unanswered dialog after this many minutes."
    case "maxWakes":
      return "Stop and ask you after this many wakes."
  }
}

export function limitBounds(field: LimitField): LimitBounds {
  return { min: KEEP_AWAKE_MIN, max: ceilingFor(field) }
}

export function draftFromLimits(limits: KeepAwakeLimits): LimitsDraft {
  return {
    idleMinutes: String(limits.idleMinutes),
    blockedMinutes: String(limits.blockedMinutes),
    maxWakes: String(limits.maxWakes),
  }
}

/** Parses the form. Each field must be a whole number inside its bound. */
export function parseLimitsDraft(draft: LimitsDraft): LimitsDraftResult {
  const parsed: KeepAwakeLimits = { ...KEEP_AWAKE_DEFAULTS }
  for (const field of LIMIT_FIELDS) {
    const text = draft[field].trim()
    const value = Number(text)
    const ceiling = ceilingFor(field)
    if (text.length === 0 || !Number.isInteger(value) || value < KEEP_AWAKE_MIN || value > ceiling) {
      return {
        kind: "invalid",
        field,
        message: `${limitLabel(field)} must be a whole number from ${KEEP_AWAKE_MIN} to ${ceiling}.`,
      }
    }
    parsed[field] = value
  }
  return { kind: "valid", limits: parsed }
}

function reasonWords(reason: UnrecognizedDialogReason): string {
  switch (reason) {
    case "harness-unsupported":
      return "this harness is not supported"
    case "folder-trust":
      return "folder trust"
    case "no-known-dialog":
      return "unknown dialog"
  }
}

export function describeCause(cause: NeedsHumanCause, maxWakes: number): string {
  switch (cause.kind) {
    case "wakes-exhausted":
      return `Stopped after ${maxWakes} ${maxWakes === 1 ? "wake" : "wakes"}.`
    case "agent-requested":
      return `@${cause.handle} asked for a human decision.`
    case "dialog-unrecognized":
      return `@${cause.handle} shows a dialog sheppard cannot close (${reasonWords(cause.reason)}).`
    case "dialog-stuck":
      return `@${cause.handle}'s dialog stayed open after Escape.`
  }
}

export type KeepAwakeTone = "off" | "watching" | "needs-human"

export interface KeepAwakeSummary {
  tone: KeepAwakeTone
  headline: string
  detail: string
}

export function describeSetting(setting: KeepAwakeSetting, formatTime: (iso: string) => string): KeepAwakeSummary {
  switch (setting.kind) {
    case "off":
      return { tone: "off", headline: "Keep awake is off", detail: "Sheppard does not wake this target." }
    case "on":
      return describePolicy(setting.policy, formatTime)
  }
}

function describePolicy(policy: KeepAwakePolicy, formatTime: (iso: string) => string): KeepAwakeSummary {
  const state = policy.state
  switch (state.kind) {
    case "watching": {
      const last = state.lastWake.kind === "woken" ? ` Last wake ${formatTime(state.lastWake.at)}.` : ""
      return {
        tone: "watching",
        headline: "Keep awake is on",
        detail: `${state.wakesUsed} of ${policy.limits.maxWakes} wakes used.${last}`,
      }
    }
    case "needs-human":
      return {
        tone: "needs-human",
        headline: "Needs you",
        detail: describeCause(state.cause, policy.limits.maxWakes),
      }
  }
}

export type CoordinatorChoice = { kind: "chosen"; handle: string } | { kind: "no-agent-members" }

/** Agent members that can coordinate a channel, in the order the picker shows them. */
export function coordinatorCandidates(members: readonly Member[]): Member[] {
  return members.filter((member) => member.kind === "agent")
}

/** The workspace lead when it is a member, else the first agent member. */
export function defaultCoordinator(members: readonly Member[], leadHandles: ReadonlySet<string>): CoordinatorChoice {
  const candidates = coordinatorCandidates(members)
  const lead = candidates.find((member) => leadHandles.has(member.handle))
  const chosen = lead ?? candidates[0]
  return chosen === undefined ? { kind: "no-agent-members" } : { kind: "chosen", handle: chosen.handle }
}

/**
 * Where an alarm leads. An agent's question opens its direct message, ready for
 * a reply; a dialog opens the agent's session, where the dialog shows; any
 * other stop opens the policy's target.
 */
export type KeepAwakeRoute =
  | { kind: "agent"; handle: string }
  | { kind: "channel"; name: string }
  | { kind: "question"; channel: string; messageId: number }

/** What Resume sends: the same limits again, which starts a fresh watch. */
export type KeepAwakeResume =
  | { kind: "agent"; handle: string; limits: KeepAwakeLimits }
  | { kind: "channel"; name: string; coordinator: string; limits: KeepAwakeLimits }

export interface KeepAwakeAlarm {
  policyId: number
  route: KeepAwakeRoute
  resume: KeepAwakeResume
  label: string
  detail: string
}

/** Policies that stopped and wait for the human, oldest first. */
export function keepAwakeAlarms(policies: readonly KeepAwakePolicy[]): KeepAwakeAlarm[] {
  const alarms: Array<KeepAwakeAlarm & { since: string }> = []
  for (const policy of policies) {
    const state = policy.state
    switch (state.kind) {
      case "watching":
        continue
      case "needs-human":
        alarms.push({
          policyId: policy.id,
          route: alarmRoute(policy, state.cause),
          resume: resumeFor(policy),
          label: labelFor(policy),
          detail: alarmDetail(state.cause, policy.limits.maxWakes),
          since: state.since,
        })
    }
  }
  return alarms
    .sort((left, right) => left.since.localeCompare(right.since) || left.policyId - right.policyId)
    .map(({ since: _since, ...alarm }) => alarm)
}

function targetRoute(policy: KeepAwakePolicy): KeepAwakeRoute {
  switch (policy.target.kind) {
    case "agent":
      return { kind: "agent", handle: policy.target.handle }
    case "channel":
      return { kind: "channel", name: policy.target.channel }
  }
}

/** Chooses where a stopped policy's alarm leads. Does no I/O. */
export function alarmRoute(policy: KeepAwakePolicy, cause: NeedsHumanCause): KeepAwakeRoute {
  switch (cause.kind) {
    case "agent-requested":
      return questionRoute(policy, cause.alert)
    case "dialog-unrecognized":
    case "dialog-stuck":
      return { kind: "agent", handle: cause.handle }
    case "wakes-exhausted":
      return targetRoute(policy)
  }
}

/** A question from before the alert was recorded opens the target instead. */
function questionRoute(policy: KeepAwakePolicy, alert: AlertMessage): KeepAwakeRoute {
  switch (alert.kind) {
    case "message":
      return { kind: "question", channel: alert.channel, messageId: alert.messageId }
    case "not-recorded":
      return targetRoute(policy)
  }
}

/** An agent's question shows as the question itself; other causes keep their sentence. */
export function alarmDetail(cause: NeedsHumanCause, maxWakes: number): string {
  switch (cause.kind) {
    case "agent-requested":
      switch (cause.alert.kind) {
        case "message":
          return `@${cause.handle}: ${cause.alert.excerpt}`
        case "not-recorded":
          return describeCause(cause, maxWakes)
      }
    case "wakes-exhausted":
    case "dialog-unrecognized":
    case "dialog-stuck":
      return describeCause(cause, maxWakes)
  }
}

function resumeFor(policy: KeepAwakePolicy): KeepAwakeResume {
  switch (policy.target.kind) {
    case "agent":
      return { kind: "agent", handle: policy.target.handle, limits: policy.limits }
    case "channel":
      return { kind: "channel", name: policy.target.channel, coordinator: policy.target.coordinator, limits: policy.limits }
  }
}

function labelFor(policy: KeepAwakePolicy): string {
  switch (policy.target.kind) {
    case "agent":
      return `@${policy.target.handle}`
    case "channel":
      return `#${policy.target.channel}`
  }
}

/** Participants that lead a workspace, from the live topology. */
export function workspaceLeadHandles(workspaces: readonly HerdrWorkspaceView[]): Set<string> {
  const leads = new Set<string>()
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (pane.role === "lead" && pane.participant !== null) leads.add(pane.participant)
    }
  }
  return leads
}
