/**
 * Wakes agents and channels that a human asked the hub to keep awake.
 *
 * The watcher reads herdr's pane statuses on a timer and remembers when each
 * pane entered its current status. A target that stays idle past its limit
 * gets one fixed wake prompt. A dialog that stays unanswered past its limit is
 * closed with Escape, which declines and never grants, and the agent then gets
 * a fixed prompt that says what happened. Every wake and every closed dialog
 * counts against the policy's wake budget. An exhausted budget, an unknown
 * dialog, or an agent's own `msgr alert-human` stops the policy until a human
 * writes in the target's scope or resumes it.
 *
 * The prompts carry channel names and minute counts only, never message
 * bodies, like the notifier's pings.
 */

import { type BlockedDialog, DIALOG_SCREEN_LINES, classifyBlockedScreen } from "./blocked-dialog";
import type { HerdrCallFailed, HerdrPort, NoAgentAtTarget, PaneInfo } from "./herdr";
import { occupantChanged } from "./notifier";
import type { ChannelLastMessage, Store } from "./store";
import type {
  AgentStatus,
  KeepAwakeMember,
  KeepAwakePolicy,
  KeepAwakeState,
  Minutes,
  NeedsHumanCause,
} from "./types";

export const KEEP_AWAKE_INTERVAL_MS = 30_000;
/** How many times the watcher checks that a closed dialog left the screen. */
export const DIALOG_CLOSE_CHECKS = 5;
export const DIALOG_CLOSE_CHECK_MS = 1_000;
const MINUTE_MS = 60_000;

const ALERT_CLAUSE = 'run: msgr alert-human "<your question>"';

export function idleWakeText(minutes: Minutes): string {
  return `[sheppard] You have been idle for at least ${minutes}m and keep-awake is on. Continue your assigned task. If you wait for someone, ask them with msgr. If the task is complete, report it with msgr. If you cannot continue without a human decision, ${ALERT_CLAUSE}.`;
}

export function coordinatorWakeText(channel: string, minutes: Minutes): string {
  return `[sheppard] #${channel} has been quiet for at least ${minutes}m and all its agents are idle or blocked. Run: msgr read ${channel}. Check if a member waits for your reply, a commit notice, or a review, then assign the next step with msgr. If the work cannot continue without a human decision, ${ALERT_CLAUSE}.`;
}

export function dialogWakeText(dialog: "question" | "permission", minutes: Minutes): string {
  switch (dialog) {
    case "question":
      return `[sheppard] Your question waited ${minutes}m with no human answer, so sheppard closed it. If you cannot continue without a human decision, ${ALERT_CLAUSE} and stop. Otherwise continue and record the open decision as the repository's conventions require.`;
    case "permission":
      return `[sheppard] Your permission request waited ${minutes}m with no human answer, so sheppard declined it. Do not retry the same action. If you cannot continue without it, ${ALERT_CLAUSE} and stop. Otherwise continue with work that does not need it and record the open decision.`;
  }
}

/** Why the watcher did nothing for one agent on this tick. */
export type KeepAwakeHoldReason =
  | "working"
  | "status-unknown"
  | "waiting"
  | "unread-pending"
  | "route-missing"
  | "occupant-changed"
  | "coordinator-unrouted"
  | "no-routed-members"
  | "delivery-failed";

export type KeepAwakeAction =
  | { kind: "woke"; policyId: number; handle: string; wake: "idle" | "coordinator" }
  | { kind: "closed-dialog"; policyId: number; handle: string; dialog: "question" | "permission" }
  | { kind: "held"; policyId: number; handle: string | null; reason: KeepAwakeHoldReason }
  | { kind: "needs-human"; policyId: number; cause: NeedsHumanCause }
  | { kind: "resumed"; policyId: number };

export interface KeepAwakeTickOutcome {
  /** False when the tick was skipped because another was still running. */
  ran: boolean;
  /** False when no policy exists, so herdr was never called. */
  calledHerdr: boolean;
  actions: KeepAwakeAction[];
}

/** The status one pane had when last read, and when it entered that status. */
interface StatusObservation {
  status: AgentStatus;
  sinceMs: number;
}

/** One watched agent, resolved to its live pane for this tick. */
interface LiveAgent {
  participantId: number;
  handle: string;
  pane: PaneInfo;
  observation: StatusObservation;
}

type LiveLookup =
  | { kind: "live"; agent: LiveAgent }
  | { kind: "held"; reason: KeepAwakeHoldReason };

/** What the pure decision says to do for one agent. */
export type AgentDecision =
  | { kind: "hold"; reason: KeepAwakeHoldReason }
  | { kind: "wake" }
  | { kind: "close-dialog" }
  | { kind: "exhausted" };

type WatchingState = Extract<KeepAwakeState, { kind: "watching" }>;

function msOf(iso: string): number {
  return Date.parse(iso);
}

/** The last moment a watch was reset or a wake was sent, whichever is later. */
function watchFloorMs(state: WatchingState): number {
  const since = msOf(state.since);
  switch (state.lastWake.kind) {
    case "not-woken":
      return since;
    case "woken":
      return Math.max(since, msOf(state.lastWake.at));
  }
}

function budgetLeft(policy: KeepAwakePolicy, state: WatchingState): boolean {
  return state.wakesUsed < policy.limits.maxWakes;
}

/** Decides for one agent under an agent policy. Does no I/O. */
export function decideAgent(
  policy: KeepAwakePolicy,
  state: WatchingState,
  observation: StatusObservation,
  nowMs: number,
): AgentDecision {
  const floor = watchFloorMs(state);
  switch (observation.status) {
    case "working":
      return { kind: "hold", reason: "working" };
    case "unknown":
      return { kind: "hold", reason: "status-unknown" };
    case "blocked": {
      const waited = nowMs - Math.max(observation.sinceMs, floor);
      if (waited < policy.limits.blockedMinutes * MINUTE_MS) return { kind: "hold", reason: "waiting" };
      return budgetLeft(policy, state) ? { kind: "close-dialog" } : { kind: "exhausted" };
    }
    case "idle":
    case "done": {
      const waited = nowMs - Math.max(observation.sinceMs, floor);
      if (waited < policy.limits.idleMinutes * MINUTE_MS) return { kind: "hold", reason: "waiting" };
      return budgetLeft(policy, state) ? { kind: "wake" } : { kind: "exhausted" };
    }
  }
}

function inactive(status: AgentStatus): boolean {
  switch (status) {
    case "idle":
    case "done":
    case "blocked":
      return true;
    case "working":
    case "unknown":
      return false;
  }
}

/**
 * Decides the group wake under a channel policy. The group is quiet when every
 * routed agent is idle, done, or blocked, and nobody wrote in the channel, for
 * the idle limit. Blocked members are handled separately by `decideAgent`.
 */
export function decideChannel(
  policy: KeepAwakePolicy,
  state: WatchingState,
  members: readonly StatusObservation[],
  lastMessage: ChannelLastMessage,
  nowMs: number,
): AgentDecision {
  if (members.length === 0) return { kind: "hold", reason: "no-routed-members" };
  if (!members.every((member) => inactive(member.status))) return { kind: "hold", reason: "working" };

  const lastMessageMs = (() => {
    switch (lastMessage.kind) {
      case "none":
        return 0;
      case "at":
        return msOf(lastMessage.at);
    }
  })();
  const quietSince = Math.max(
    watchFloorMs(state),
    lastMessageMs,
    ...members.map((member) => member.sinceMs),
  );
  if (nowMs - quietSince < policy.limits.idleMinutes * MINUTE_MS) {
    return { kind: "hold", reason: "waiting" };
  }
  return budgetLeft(policy, state) ? { kind: "wake" } : { kind: "exhausted" };
}

export interface KeepAwakeWatcherOptions {
  store: Store;
  herdr: HerdrPort;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs after a tick that changed any policy row. */
  onChange?: () => void;
}

/** A missing pane is a route problem; any other herdr failure may clear by itself. */
function failureHold(error: NoAgentAtTarget | HerdrCallFailed): KeepAwakeHoldReason {
  switch (error._tag) {
    case "NoAgentAtTarget":
      return "route-missing";
    case "HerdrCallFailed":
      return "delivery-failed";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KeepAwakeWatcher {
  private readonly store: Store;
  private readonly herdr: HerdrPort;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onChange: () => void;
  private readonly observations = new Map<string, StatusObservation>();
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KeepAwakeWatcherOptions) {
    this.store = options.store;
    this.herdr = options.herdr;
    this.intervalMs = options.intervalMs ?? KEEP_AWAKE_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.onChange = options.onChange ?? (() => undefined);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<KeepAwakeTickOutcome> {
    if (this.inFlight) return { ran: false, calledHerdr: false, actions: [] };
    this.inFlight = true;
    try {
      const outcome = await this.watch();
      const changed = outcome.actions.some((action) => action.kind !== "held");
      if (changed) this.onChange();
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }

  private async watch(): Promise<KeepAwakeTickOutcome> {
    const policies = this.store.keepAwakePolicies();
    if (policies.length === 0) {
      this.observations.clear();
      return { ran: true, calledHerdr: false, actions: [] };
    }

    const panes = await this.herdr.paneList();
    // Nothing was learned about any pane, so nothing is decided.
    if (panes.isErr()) return { ran: true, calledHerdr: true, actions: [] };
    this.observe(panes.value);

    const pending = new Set(this.store.pendingNotifications().map((row) => row.participantId));
    const actions: KeepAwakeAction[] = [];
    for (const policy of policies) {
      if (this.resumeOnHumanMessage(policy)) {
        actions.push({ kind: "resumed", policyId: policy.id });
        continue;
      }
      switch (policy.state.kind) {
        case "needs-human":
          continue;
        case "watching":
          actions.push(...(await this.watchPolicy(policy, policy.state, panes.value, pending)));
      }
    }
    return { ran: true, calledHerdr: true, actions };
  }

  /** Records status changes by terminal, and forgets panes that are gone. */
  private observe(panes: readonly PaneInfo[]): void {
    const nowMs = this.now();
    const live = new Set<string>();
    for (const pane of panes) {
      live.add(pane.terminalId);
      const previous = this.observations.get(pane.terminalId);
      if (previous === undefined || previous.status !== pane.agentStatus) {
        this.observations.set(pane.terminalId, { status: pane.agentStatus, sinceMs: nowMs });
      }
    }
    for (const terminalId of this.observations.keys()) {
      if (!live.has(terminalId)) this.observations.delete(terminalId);
    }
  }

  /** A human message in the target's scope resets the watch and its budget. */
  private resumeOnHumanMessage(policy: KeepAwakePolicy): boolean {
    const latest = (() => {
      switch (policy.target.kind) {
        case "agent":
          return this.store.latestHumanMessageIdForAgent(policy.target.participantId);
        case "channel":
          return this.store.latestHumanMessageIdForChannel(policy.target.channelId);
      }
    })();
    if (latest <= policy.humanMarkId) return false;
    this.store.resumeKeepAwake(policy.id, latest, new Date(this.now()).toISOString());
    return true;
  }

  private watchPolicy(
    policy: KeepAwakePolicy,
    state: WatchingState,
    panes: readonly PaneInfo[],
    pending: ReadonlySet<number>,
  ): Promise<KeepAwakeAction[]> {
    switch (policy.target.kind) {
      case "agent":
        return this.watchAgent(policy, state, policy.target.participantId, panes, pending);
      case "channel":
        return this.watchChannel(policy, state, policy.target, panes, pending);
    }
  }

  /** Resolves a routed agent to its live pane, or names why it cannot. */
  private liveAgent(
    member: KeepAwakeMember,
    panes: readonly PaneInfo[],
  ): LiveLookup {
    const pane = panes.find((candidate) => candidate.terminalId === member.terminalId);
    if (pane === undefined) return { kind: "held", reason: "route-missing" };
    if (occupantChanged(member.occupantAgent, pane.agent)) {
      return { kind: "held", reason: "occupant-changed" };
    }
    const observation = this.observations.get(pane.terminalId);
    if (observation === undefined) return { kind: "held", reason: "route-missing" };
    return {
      kind: "live",
      agent: { participantId: member.participantId, handle: member.handle, pane, observation },
    };
  }

  private routedMember(participantId: number): KeepAwakeMember | null {
    const participant = this.store.findById(participantId);
    if (
      participant === null ||
      participant.deactivated ||
      participant.routeState !== "active" ||
      participant.terminalId === null ||
      participant.paneId === null
    ) {
      return null;
    }
    return {
      participantId,
      handle: participant.handle,
      terminalId: participant.terminalId,
      paneId: participant.paneId,
      occupantAgent: participant.occupantAgent,
    };
  }

  private async watchAgent(
    policy: KeepAwakePolicy,
    state: WatchingState,
    participantId: number,
    panes: readonly PaneInfo[],
    pending: ReadonlySet<number>,
  ): Promise<KeepAwakeAction[]> {
    const member = this.routedMember(participantId);
    if (member === null) {
      return [{ kind: "held", policyId: policy.id, handle: null, reason: "route-missing" }];
    }
    const lookup = this.liveAgent(member, panes);
    if (lookup.kind === "held") {
      return [{ kind: "held", policyId: policy.id, handle: member.handle, reason: lookup.reason }];
    }
    const agent = lookup.agent;

    const decision = decideAgent(policy, state, agent.observation, this.now());
    switch (decision.kind) {
      case "hold":
        return [{ kind: "held", policyId: policy.id, handle: agent.handle, reason: decision.reason }];
      case "exhausted":
        return [this.needsHuman(policy, { kind: "wakes-exhausted" })];
      case "close-dialog":
        return [await this.closeDialog(policy, agent)];
      case "wake":
        if (pending.has(agent.participantId)) {
          return [{ kind: "held", policyId: policy.id, handle: agent.handle, reason: "unread-pending" }];
        }
        return [await this.wake(policy, agent, idleWakeText(policy.limits.idleMinutes), "idle")];
    }
  }

  private async watchChannel(
    policy: KeepAwakePolicy,
    state: WatchingState,
    target: Extract<KeepAwakePolicy["target"], { kind: "channel" }>,
    panes: readonly PaneInfo[],
    pending: ReadonlySet<number>,
  ): Promise<KeepAwakeAction[]> {
    const live: LiveAgent[] = [];
    for (const member of this.store.keepAwakeMembers(target.channelId)) {
      const lookup = this.liveAgent(member, panes);
      if (lookup.kind === "live") live.push(lookup.agent);
    }

    // A blocked member is closed on its own clock, even while others work.
    const actions: KeepAwakeAction[] = [];
    let budget = state;
    for (const agent of live) {
      if (agent.observation.status !== "blocked") continue;
      const decision = decideAgent(policy, budget, agent.observation, this.now());
      if (decision.kind === "exhausted") {
        return [...actions, this.needsHuman(policy, { kind: "wakes-exhausted" })];
      }
      if (decision.kind !== "close-dialog") continue;
      const closed = await this.closeDialog(policy, agent);
      actions.push(closed);
      if (closed.kind === "needs-human") return actions;
      budget = { ...budget, wakesUsed: budget.wakesUsed + 1 };
    }
    if (actions.length > 0) return actions;

    const decision = decideChannel(
      policy,
      state,
      live.map((agent) => agent.observation),
      this.store.channelLastMessage(target.channelId),
      this.now(),
    );
    return [await this.wakeCoordinator(policy, target, decision, live, pending)];
  }

  private async wakeCoordinator(
    policy: KeepAwakePolicy,
    target: Extract<KeepAwakePolicy["target"], { kind: "channel" }>,
    decision: AgentDecision,
    live: readonly LiveAgent[],
    pending: ReadonlySet<number>,
  ): Promise<KeepAwakeAction> {
    switch (decision.kind) {
      case "hold":
        return { kind: "held", policyId: policy.id, handle: null, reason: decision.reason };
      case "exhausted":
        return this.needsHuman(policy, { kind: "wakes-exhausted" });
      case "close-dialog":
      case "wake":
        break;
    }
    const coordinator = live.find((agent) => agent.participantId === target.coordinatorId);
    if (coordinator === undefined) {
      return { kind: "held", policyId: policy.id, handle: null, reason: "coordinator-unrouted" };
    }
    // The coordinator's own dialog is closed on its blocked clock, not here.
    if (coordinator.observation.status === "blocked") {
      return { kind: "held", policyId: policy.id, handle: coordinator.handle, reason: "waiting" };
    }
    if (pending.has(coordinator.participantId)) {
      return { kind: "held", policyId: policy.id, handle: coordinator.handle, reason: "unread-pending" };
    }
    const text = coordinatorWakeText(target.channel, policy.limits.idleMinutes);
    return this.wake(policy, coordinator, text, "coordinator");
  }

  private async wake(
    policy: KeepAwakePolicy,
    agent: LiveAgent,
    text: string,
    wake: "idle" | "coordinator",
  ): Promise<KeepAwakeAction> {
    const sent = await this.herdr.agentPrompt(agent.pane.paneId, text);
    if (sent.isErr()) {
      return { kind: "held", policyId: policy.id, handle: agent.handle, reason: failureHold(sent.error) };
    }
    this.store.recordKeepAwakeWake(policy.id, this.nowIso());
    return { kind: "woke", policyId: policy.id, handle: agent.handle, wake };
  }

  /**
   * Reads the dialog, confirms the pane is still blocked on it, presses
   * Escape, waits for the pane to leave `blocked`, then explains by prompt.
   * The wake is counted once Escape is sent, because the pane has changed.
   */
  private async closeDialog(policy: KeepAwakePolicy, agent: LiveAgent): Promise<KeepAwakeAction> {
    const held = (reason: KeepAwakeHoldReason): KeepAwakeAction =>
      ({ kind: "held", policyId: policy.id, handle: agent.handle, reason });

    const screen = await this.herdr.paneRead(agent.pane.paneId, DIALOG_SCREEN_LINES);
    if (screen.isErr()) return held(failureHold(screen.error));
    const dialog: BlockedDialog = classifyBlockedScreen(agent.pane.agent, screen.value);
    if (dialog.kind === "unrecognized") {
      return this.needsHuman(policy, {
        kind: "dialog-unrecognized",
        handle: agent.handle,
        reason: dialog.reason,
      });
    }

    const still = await this.paneStatus(agent.pane.terminalId);
    if (still !== "blocked") return held("waiting");

    const pressed = await this.herdr.paneSendKey(agent.pane.paneId, "esc");
    if (pressed.isErr()) return held(failureHold(pressed.error));
    this.store.recordKeepAwakeWake(policy.id, this.nowIso());

    if (!(await this.leftBlocked(agent.pane.terminalId))) {
      return this.needsHuman(policy, { kind: "dialog-stuck", handle: agent.handle });
    }
    const explained = await this.herdr.agentPrompt(
      agent.pane.paneId,
      dialogWakeText(dialog.kind, policy.limits.blockedMinutes),
    );
    if (explained.isErr()) return held("delivery-failed");
    return { kind: "closed-dialog", policyId: policy.id, handle: agent.handle, dialog: dialog.kind };
  }

  /** The pane's current status, or `unknown` when herdr cannot say. */
  private async paneStatus(terminalId: string): Promise<AgentStatus> {
    const panes = await this.herdr.paneList();
    if (panes.isErr()) return "unknown";
    const pane = panes.value.find((candidate) => candidate.terminalId === terminalId);
    return pane === undefined ? "unknown" : pane.agentStatus;
  }

  private async leftBlocked(terminalId: string): Promise<boolean> {
    for (let check = 0; check < DIALOG_CLOSE_CHECKS; check += 1) {
      await this.sleep(DIALOG_CLOSE_CHECK_MS);
      const status = await this.paneStatus(terminalId);
      if (status !== "blocked" && status !== "unknown") return true;
    }
    return false;
  }

  private needsHuman(policy: KeepAwakePolicy, cause: NeedsHumanCause): KeepAwakeAction {
    this.store.markKeepAwakeNeedsHuman(policy.id, cause, this.nowIso());
    return { kind: "needs-human", policyId: policy.id, cause };
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
