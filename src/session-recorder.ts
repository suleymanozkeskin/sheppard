/**
 * Records exact session mappings for running agents, so a resume point exists
 * before a restart ends their terminals.
 *
 * The agent page resolves a session only while someone looks at it. This
 * recorder runs the same mapping ladder on a timer for each routed agent pane
 * whose terminal has no exact mapping yet. It stores a mapping only when the
 * ladder is exact; an inferred mapping is a guess and waits for the human to
 * confirm it on the agent page.
 */

import type { HerdrPort, PaneInfo } from "./herdr";
import type { Store } from "./store";
import { type WindowReader, adapterFor, bunWindowReader, chooseSession } from "./transcripts";

export const SESSION_RECORD_INTERVAL_MS = 60_000;
/** Panes resolved in one pass. The others wait for the next pass. */
export const MAX_SESSION_RECORDS_PER_PASS = 8;

export type SessionRecordOutcome =
  | { kind: "recorded"; handle: string; sessionId: string }
  | { kind: "not-exact"; handle: string }
  | { kind: "unreadable"; handle: string; reason: string };

export interface SessionRecorderOptions {
  store: Store;
  herdr: HerdrPort;
  reader?: WindowReader;
  intervalMs?: number;
}

export class SessionRecorder {
  private readonly store: Store;
  private readonly herdr: HerdrPort;
  private readonly reader: WindowReader;
  private readonly intervalMs: number;
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionRecorderOptions) {
    this.store = options.store;
    this.herdr = options.herdr;
    this.reader = options.reader ?? bunWindowReader();
    this.intervalMs = options.intervalMs ?? SESSION_RECORD_INTERVAL_MS;
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

  /** One pass. A pass that starts while another runs does nothing. */
  async tick(): Promise<SessionRecordOutcome[]> {
    if (this.inFlight) return [];
    this.inFlight = true;
    try {
      const panes = await this.herdr.paneList();
      if (panes.isErr()) return [];
      const outcomes: SessionRecordOutcome[] = [];
      for (const pane of this.panesWithoutExactSession(panes.value)) outcomes.push(await this.record(pane));
      return outcomes;
    } finally {
      this.inFlight = false;
    }
  }

  private panesWithoutExactSession(panes: readonly PaneInfo[]): PaneInfo[] {
    return panes
      .filter((pane) => {
        if (pane.agent === null || pane.cwd === undefined) return false;
        if (this.store.findActiveAgentByTerminal(pane.terminalId) === null) return false;
        const stored = this.store.findSessionMapping(pane.terminalId);
        return stored === null || stored.confidence !== "exact" || stored.harness !== pane.agent;
      })
      .slice(0, MAX_SESSION_RECORDS_PER_PASS);
  }

  private async record(pane: PaneInfo): Promise<SessionRecordOutcome> {
    const participant = this.store.findActiveAgentByTerminal(pane.terminalId);
    const handle = participant?.handle ?? pane.paneId;
    const adapter = adapterFor(pane.agent);
    if (participant === null || adapter.isErr() || pane.cwd === undefined) return { kind: "not-exact", handle };
    const launch = this.store.lifecycleAgentForTerminal(pane.terminalId);
    const located = await adapter.value.locate(
      { cwd: pane.cwd, env: { ...process.env, ...launch?.launchEnv } },
      this.reader,
    );
    if (located.isErr()) return { kind: "unreadable", handle, reason: located.error.reason };
    const mapping = chooseSession(located.value, { handle: participant.handle, startedAt: participant.createdAt });
    if (mapping.confidence !== "exact" || mapping.chosen === null) return { kind: "not-exact", handle };
    this.store.saveSessionMapping({
      terminal_id: pane.terminalId,
      harness: adapter.value.harness,
      session_id: mapping.chosen.sessionId,
      session_path: mapping.chosen.path,
      confidence: "exact",
      cwd: pane.cwd,
    });
    return { kind: "recorded", handle, sessionId: mapping.chosen.sessionId };
  }
}
