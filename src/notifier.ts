/**
 * Turns unread messages into one small ping per agent.
 *
 * The ping carries counts, sender handles, and channel names — never message
 * bodies, topics, or paths. That is the whole point: the receiver learns that
 * something is waiting and decides for itself when to spend context reading it.
 *
 * Delivery is at-least-once. `notified_id` advances only after herdr reports a
 * prompt delivered, so a crash in between costs one duplicate ping, while the
 * opposite order would silently lose one. A duplicate is a wasted turn; a lost
 * ping is a message nobody ever hears about.
 */

import type { HerdrPort, PaneInfo } from "./herdr";
import type { Store } from "./store";
import type { PendingNotification } from "./types";

export const DEFAULT_INTERVAL_MS = 5_000;
export const DEFAULT_WORKING_PING_COOLDOWN_MS = 0;
export const DELIVERY_CONFIRMATION_WINDOW_MS = 120_000;
export const STALE_ROUTE_ESCALATION_PROMPT =
  "your msgr route is stale; run any msgr command to heal and read your pings";

/** Why a receiver was passed over on this tick. */
export type HoldReason =
  | "focused"
  | "status"
  | "working-cooldown"
  | "already-read"
  | "route-missing"
  | "occupant-changed"
  | "delivery-confirmation"
  | "delivery-failed"
  | "stale-route";

export interface TickOutcome {
  /** False when the tick was skipped because another was still running. */
  ran: boolean;
  /** False on a quiet tick: no pending rows means herdr is never called. */
  calledHerdr: boolean;
  delivered: string[];
  escalated: string[];
  held: Array<{ handle: string; reason: HoldReason }>;
  staled: string[];
}

function emptyOutcome(ran: boolean, calledHerdr: boolean): TickOutcome {
  return { ran, calledHerdr, delivered: [], escalated: [], held: [], staled: [] };
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

const RESUME_CLAUSE =
  "then resume your interrupted task unless the messages explicitly reassign you";

/**
 * One line, whatever the shape of the backlog. A single channel names it and the
 * command to read it; several channels get a per-channel breakdown and the
 * command that drains them all.
 */
export function formatPing(rows: readonly PendingNotification[]): string {
  const first = rows[0];
  if (first === undefined) return "";

  if (rows.length === 1) {
    const senders = first.senders.join(", ");
    return `[msgr] ${plural(first.count, "new message")} from ${senders} in #${first.channel}. Run: msgr read ${first.channel}, ${RESUME_CLAUSE}.`;
  }

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const breakdown = rows
    .map((row) => `#${row.channel}: ${row.count} from ${row.senders.join(", ")}`)
    .join("; ");
  return `[msgr] ${plural(total, "new message")} — ${breakdown}. Run: msgr read --all, ${RESUME_CLAUSE}.`;
}

function groupByParticipant(
  rows: readonly PendingNotification[],
): Map<number, PendingNotification[]> {
  const grouped = new Map<number, PendingNotification[]>();
  for (const row of rows) {
    const existing = grouped.get(row.participantId) ?? [];
    existing.push(row);
    grouped.set(row.participantId, existing);
  }
  return grouped;
}

/** A route without a recorded occupant cannot prove that delivery is safe. */
export function occupantChanged(recorded: string | null, current: string | null): boolean {
  return recorded === null || recorded !== current;
}

type InjectionDisposition =
  | { kind: "ready"; working: boolean }
  | { kind: "hold"; reason: HoldReason };

/** Focused panes hold only when opted in; blocked and unknown panes always hold. */
function injectionDisposition(pane: PaneInfo, focusedHold: boolean): InjectionDisposition {
  // A focused pane may have a human mid-sentence at the prompt.
  if (focusedHold && pane.focused) return { kind: "hold", reason: "focused" };

  switch (pane.agentStatus) {
    case "idle":
    case "done":
      return { kind: "ready", working: false };
    case "working":
      return { kind: "ready", working: true };
    // `blocked` is a permission dialog: injected keys could answer it.
    case "blocked":
    case "unknown":
      return { kind: "hold", reason: "status" };
  }
}

function focusedHoldFromEnv(): boolean {
  return Bun.env.MSGR_FOCUSED_HOLD === "1";
}

function workingPingCooldownFromEnv(): number {
  const raw = Bun.env.MSGR_WORKING_PING_COOLDOWN;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_WORKING_PING_COOLDOWN_MS;

  const seconds = Number(raw);
  const milliseconds = seconds * 1_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : DEFAULT_WORKING_PING_COOLDOWN_MS;
}

function validWorkingPingCooldown(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : DEFAULT_WORKING_PING_COOLDOWN_MS;
}

interface PendingConfirmation {
  baselineSeenAt: string | null;
  expiresAt: number;
  rows: Array<Pick<PendingNotification, "channelId" | "throughId">>;
}

function sawAuthenticatedRequest(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  return before === null || after !== before;
}

export interface NotifierOptions {
  store: Store;
  herdr: HerdrPort;
  intervalMs?: number;
  workingPingCooldownMs?: number;
  now?: () => number;
  onTick?: () => void | Promise<void>;
}

export class Notifier {
  private readonly store: Store;
  private readonly herdr: HerdrPort;
  private readonly intervalMs: number;
  private readonly workingPingCooldownMs: number;
  private readonly focusedHold: boolean;
  private readonly now: () => number;
  private readonly onTick: (() => void | Promise<void>) | undefined;
  private readonly lastWorkingDeliveryAt = new Map<number, number>();
  private readonly pendingConfirmations = new Map<number, PendingConfirmation>();
  private readonly staleIdleTicks = new Map<number, number>();
  private readonly staleEscalated = new Set<number>();
  private readonly queuedChannels = new Set<string>();
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: NotifierOptions) {
    this.store = options.store;
    this.herdr = options.herdr;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.workingPingCooldownMs = validWorkingPingCooldown(
      options.workingPingCooldownMs ?? workingPingCooldownFromEnv(),
    );
    this.focusedHold = focusedHoldFromEnv();
    this.now = options.now ?? (() => Date.now());
    this.onTick = options.onTick;
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

  async tick(): Promise<TickOutcome> {
    // A tick that overruns the interval must not have a second one alongside it,
    // or both would read the same pending rows and ping twice.
    if (this.inFlight) return emptyOutcome(false, false);
    this.inFlight = true;
    try {
      const outcome = await this.deliver();
      try {
        await this.onTick?.();
      } finally {
        await this.drainQueuedChannels();
      }
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }

  /** Delivers one channel immediately after a successful send. */
  async notifyChannel(channel: string): Promise<TickOutcome> {
    if (this.inFlight) {
      this.queuedChannels.add(channel);
      return emptyOutcome(false, false);
    }
    this.inFlight = true;
    try {
      const outcome = await this.deliver(channel);
      await this.drainQueuedChannels();
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }

  private async drainQueuedChannels(): Promise<void> {
    while (this.queuedChannels.size > 0) {
      const channels = [...this.queuedChannels];
      this.queuedChannels.clear();
      for (const channel of channels) await this.deliver(channel);
    }
  }

  private async deliver(channelName: string | null = null): Promise<TickOutcome> {
    this.resolveConfirmations();
    this.clearRecoveredStaleState();
    const pending = this.store.pendingNotifications(channelName);
    const stalePending = this.store.stalePendingNotifications(channelName);
    if (channelName === null) {
      const observed = new Set(stalePending.map((row) => row.participantId));
      for (const participantId of this.staleIdleTicks.keys()) {
        if (!observed.has(participantId)) this.staleIdleTicks.delete(participantId);
      }
    }
    if (pending.length === 0 && stalePending.length === 0) return emptyOutcome(true, false);

    const panes = await this.herdr.paneList();
    if (panes.isErr()) {
      // Nothing was learned about any route, so nothing changes.
      return emptyOutcome(true, true);
    }

    const outcome = emptyOutcome(true, true);

    for (const [participantId, rows] of groupByParticipant(pending)) {
      const first = rows[0];
      if (first === undefined) continue;

      if (this.pendingConfirmations.has(participantId)) {
        outcome.held.push({ handle: first.handle, reason: "delivery-confirmation" });
        continue;
      }

      const pane = this.resolveRoutedPane(panes.value, participantId, first);
      if (pane === undefined) {
        this.store.markRouteStale(participantId);
        outcome.staled.push(first.handle);
        continue;
      }

      if (occupantChanged(first.occupantAgent, pane.agent)) {
        this.store.markRouteStale(participantId);
        outcome.staled.push(first.handle);
        continue;
      }

      const disposition = injectionDisposition(pane, this.focusedHold);
      if (disposition.kind === "hold") {
        outcome.held.push({ handle: first.handle, reason: disposition.reason });
        continue;
      }

      const lastWorkingDelivery = this.lastWorkingDeliveryAt.get(participantId);
      if (
        disposition.working &&
        lastWorkingDelivery !== undefined &&
        this.now() - lastWorkingDelivery < this.workingPingCooldownMs
      ) {
        outcome.held.push({ handle: first.handle, reason: "working-cooldown" });
        continue;
      }

      // The batch was snapshotted before the pane lookup. A read that landed in
      // between makes this ping stale, so it is dropped rather than sent.
      const live = rows.filter(
        (row) => (this.store.cursorFor(row.participantId, row.channelId) ?? 0) < row.throughId,
      );
      if (live.length === 0) {
        outcome.held.push({ handle: first.handle, reason: "already-read" });
        continue;
      }

      const baselineSeenAt = this.store.lastSeenAt(participantId);
      const sent = await this.herdr.agentPrompt(pane.paneId, formatPing(live));
      if (sent.isErr()) {
        sent.error.match({
          NoAgentAtTarget: () => {
            this.store.markRouteStale(participantId);
            outcome.staled.push(first.handle);
          },
          HerdrCallFailed: () => {
            outcome.held.push({ handle: first.handle, reason: "delivery-failed" });
          },
        });
        continue;
      }

      for (const row of live) {
        this.store.markNotified(row.participantId, row.channelId, row.throughId);
      }
      const afterSeenAt = this.store.lastSeenAt(participantId);
      if (!sawAuthenticatedRequest(baselineSeenAt, afterSeenAt)) {
        this.pendingConfirmations.set(participantId, {
          baselineSeenAt,
          expiresAt: this.now() + DELIVERY_CONFIRMATION_WINDOW_MS,
          rows: live.map(({ channelId, throughId }) => ({ channelId, throughId })),
        });
      }
      if (disposition.working) this.lastWorkingDeliveryAt.set(participantId, this.now());
      outcome.delivered.push(first.handle);
    }

    // Stale routes keep their unread rows visible to this pass. A matching
    // pane that stays idle or done for two ticks gets one direct healing prompt.
    const currentStalePending = this.store.stalePendingNotifications(channelName);
    for (const [participantId, rows] of groupByParticipant(currentStalePending)) {
      const first = rows[0];
      if (first === undefined) continue;

      const pane = this.resolveRoutedPane(panes.value, participantId, first);
      if (pane === undefined) {
        this.staleIdleTicks.delete(participantId);
        outcome.held.push({ handle: first.handle, reason: "route-missing" });
        continue;
      }

      if (occupantChanged(first.occupantAgent, pane.agent)) {
        this.staleIdleTicks.delete(participantId);
        outcome.held.push({ handle: first.handle, reason: "occupant-changed" });
        continue;
      }

      if (pane.agentStatus !== "idle" && pane.agentStatus !== "done") {
        this.staleIdleTicks.delete(participantId);
        outcome.held.push({ handle: first.handle, reason: "status" });
        continue;
      }

      const idleTicks = (this.staleIdleTicks.get(participantId) ?? 0) + 1;
      this.staleIdleTicks.set(participantId, idleTicks);
      if (idleTicks <= 1) {
        outcome.held.push({ handle: first.handle, reason: "stale-route" });
        continue;
      }
      if (this.staleEscalated.has(participantId)) {
        outcome.held.push({ handle: first.handle, reason: "stale-route" });
        continue;
      }

      // Record the attempt before awaiting the transport. This makes the
      // once-per-outage rule hold even when the pane prompt itself fails.
      this.staleEscalated.add(participantId);
      const escalated = await this.herdr.agentPrompt(
        pane.paneId,
        STALE_ROUTE_ESCALATION_PROMPT,
      );
      if (escalated.isErr()) {
        escalated.error.match({
          NoAgentAtTarget: () => {
            outcome.held.push({ handle: first.handle, reason: "route-missing" });
          },
          HerdrCallFailed: () => {
            outcome.held.push({ handle: first.handle, reason: "delivery-failed" });
          },
        });
        continue;
      }
      outcome.escalated.push(first.handle);
    }

    return outcome;
  }

  /**
   * Finds the routed pane by its DURABLE identity.
   *
   * herdr pane ids are compact public ids: closing any pane renumbers the rest,
   * which is why a route stores the terminal id. Matching both ids made the
   * durable half decorative — a sibling closing renamed a live pane and the
   * route was abandoned. A shifted pane id is followed and written back; only a
   * terminal that no pane carries is a route that no longer exists.
   */
  private resolveRoutedPane(
    panes: readonly PaneInfo[],
    participantId: number,
    route: { terminalId: string; paneId: string },
  ): PaneInfo | undefined {
    const pane = panes.find((candidate) => candidate.terminalId === route.terminalId);
    if (pane === undefined) return undefined;
    if (pane.paneId !== route.paneId) this.store.healRoutePane(participantId, pane.paneId);
    return pane;
  }

  private clearRecoveredStaleState(): void {
    const tracked = new Set([...this.staleIdleTicks.keys(), ...this.staleEscalated]);
    for (const participantId of tracked) {
      const participant = this.store.findById(participantId);
      if (
        participant === null ||
        participant.deactivated ||
        participant.routeState === "active"
      ) {
        this.staleIdleTicks.delete(participantId);
        this.staleEscalated.delete(participantId);
      }
    }
  }

  /**
   * A prompt is only delivery-confirmed by a later authenticated request from
   * the same participant. Until then, the optimistic watermark suppresses
   * duplicate ticks. Expiry rolls it back to the current read cursor and
   * disables the route so a healed pane receives the unread batch again.
   */
  private resolveConfirmations(): void {
    const now = this.now();
    for (const [participantId, confirmation] of this.pendingConfirmations) {
      const seenAt = this.store.lastSeenAt(participantId);
      if (now < confirmation.expiresAt) {
        if (sawAuthenticatedRequest(confirmation.baselineSeenAt, seenAt)) {
          this.pendingConfirmations.delete(participantId);
        }
        continue;
      }

      for (const row of confirmation.rows) {
        this.store.rollbackNotifiedToCursor(participantId, row.channelId);
      }
      this.store.markRouteStale(participantId);
      this.pendingConfirmations.delete(participantId);
    }
  }
}
