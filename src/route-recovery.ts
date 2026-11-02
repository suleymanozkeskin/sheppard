/**
 * Restores stale agent routes from evidence the hub gathers itself.
 *
 * No agent is asked to reconnect. A route comes back when one of these holds:
 *
 * - Same terminal: the route's recorded terminal is live and holds the same
 *   agent kind. This covers an agent process that restarted in its terminal.
 * - Same harness session: a pane with no identity runs the harness session
 *   the identity last ran, as herdr's integration reported it. This covers a
 *   new terminal for the same pane, which herdr creates after its server or
 *   the computer restarts and it resumes the agent session.
 *
 * Neither path stamps `last_seen_at`, sends input to a pane, or changes
 * memberships and cursors. A route that matches neither stays stale.
 */

import type { AgentSessionReference, PaneInfo } from "./herdr";
import type { Store } from "./store";

/** A route without a recorded occupant cannot prove that delivery is safe. */
export function occupantChanged(recorded: string | null, current: string | null): boolean {
  return recorded === null || recorded !== current;
}

/** The handles whose routes one recovery pass restored, by evidence kind. */
export interface RouteRecoveryReport {
  readonly sameTerminal: readonly string[];
  readonly sameSession: readonly string[];
}

/** Runs both recovery paths over one complete herdr pane list. */
export function recoverStaleRoutes(store: Store, panes: readonly PaneInfo[]): RouteRecoveryReport {
  const sameTerminal = reactivateOnSameTerminal(store, panes);
  const sameSession = moveToSessionPanes(store, panes);
  return Object.freeze({ sameTerminal: Object.freeze(sameTerminal), sameSession: Object.freeze(sameSession) });
}

/**
 * Reactivates a unique stale identity whose recorded terminal is live with the
 * same occupant. Active owners and ambiguous stale identities prevent it. A
 * pane move updates the public pane id.
 */
function reactivateOnSameTerminal(store: Store, panes: readonly PaneInfo[]): string[] {
  const restored: string[] = [];
  for (const route of store.staleRoutedParticipants()) {
    if (route.terminalId === null || route.paneId === null) continue;
    const pane = panes.find((candidate) => candidate.terminalId === route.terminalId);
    if (pane === undefined || occupantChanged(route.occupantAgent, pane.agent)) continue;
    const identity = store.identityForRoute({
      terminalId: route.terminalId, paneId: route.paneId, occupantAgent: pane.agent,
    });
    if (identity.kind !== "matched" || identity.participant.id !== route.id) continue;
    if (store.reactivateRoute(route.id, route.terminalId, pane.paneId)) restored.push(route.handle);
  }
  return restored;
}

interface SessionPane {
  readonly pane: PaneInfo;
  readonly agent: string;
  readonly reference: AgentSessionReference;
}

/**
 * Moves a stale identity to the pane that runs its recorded harness session.
 *
 * The pane must hold the same agent kind that reported the session, and must
 * not already belong to an active identity. A session that two panes report
 * is ambiguous, and neither pane is used.
 */
function moveToSessionPanes(store: Store, panes: readonly PaneInfo[]): string[] {
  const moved: string[] = [];
  for (const candidate of uniqueSessionPanes(panes)) {
    const { pane, agent, reference } = candidate;
    if (store.findActiveAgentByTerminal(pane.terminalId) !== null) continue;
    const identity = store.staleIdentityForSession(agent, reference);
    switch (identity.kind) {
      case "none":
      case "ambiguous":
        continue;
      case "matched": {
        const route = { terminalId: pane.terminalId, paneId: pane.paneId, occupantAgent: agent };
        if (store.moveStaleRouteToTerminal(identity.participant.id, route)) moved.push(identity.participant.handle);
        continue;
      }
    }
  }
  return moved;
}

/** Panes whose reported session no other pane reports. */
function uniqueSessionPanes(panes: readonly PaneInfo[]): SessionPane[] {
  const byKey = new Map<string, SessionPane[]>();
  for (const pane of panes) {
    const session = pane.agentSession;
    switch (session.kind) {
      case "not-reported":
      case "unrecognised":
        continue;
      case "reported":
        break;
    }
    if (pane.agent === null || pane.agent !== session.agent) continue;
    const key = sessionKey(session.agent, session.reference);
    const group = byKey.get(key) ?? [];
    group.push({ pane, agent: session.agent, reference: session.reference });
    byKey.set(key, group);
  }
  return [...byKey.values()].flatMap((group) => (group.length === 1 ? group : []));
}

function sessionKey(agent: string, reference: AgentSessionReference): string {
  switch (reference.kind) {
    case "id":
      return JSON.stringify([agent, "id", reference.id]);
    case "path":
      return JSON.stringify([agent, "path", reference.path]);
  }
}
