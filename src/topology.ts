import { createHash } from "node:crypto";
import {
  type HerdrPort,
  type HerdrSubscription,
  type HerdrTab,
  type PaneInfo,
} from "./herdr";
import { occupantChanged } from "./notifier";
import type { Store } from "./store";
import type { HerdrPaneView, HerdrTopologySnapshot } from "./types";

export interface HerdrTopologyOptions {
  herdr: HerdrPort;
  store: Store;
  onChange: (snapshot: HerdrTopologySnapshot) => void;
}

const HERDR_SUBSCRIPTION_RETRY_MS = 5_000;

export function workspaceChannelName(id: string): string {
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 28);
  return `ws-${suffix}`;
}

function workspaceIdForPane(pane: PaneInfo): string | null {
  if (pane.workspaceId !== undefined) return pane.workspaceId;
  const separator = pane.paneId.indexOf(":");
  return separator <= 0 ? null : pane.paneId.slice(0, separator);
}

export class HerdrTopology {
  private readonly herdr: HerdrPort;
  private readonly store: Store;
  private readonly onChange: (snapshot: HerdrTopologySnapshot) => void;
  private current: HerdrTopologySnapshot = { workspaces: [] };
  private currentPanes: readonly PaneInfo[] = [];
  private serialized = JSON.stringify(this.current);
  private inFlight: Promise<boolean> | null = null;
  private subscription: HerdrSubscription | null = null;
  private subscriptionStarting = false;
  private subscriptionRetry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lifecycleGeneration = 0;

  constructor(options: HerdrTopologyOptions) {
    this.herdr = options.herdr;
    this.store = options.store;
    this.onChange = options.onChange;
  }

  snapshot(): HerdrTopologySnapshot {
    return this.current;
  }

  /** The successful raw pane read used for server-side identity checks. */
  livePanes(): readonly PaneInfo[] {
    return this.currentPanes;
  }

  /** True while the Herdr socket is delivering lifecycle events. */
  isWatching(): boolean {
    return this.subscription !== null && !this.subscription.closed;
  }

  /** Starts the event-driven refresh path. The notifier remains a fallback. */
  start(): void {
    this.stopped = false;
    this.lifecycleGeneration += 1;
    void this.connectSubscription(this.lifecycleGeneration);
  }

  stop(): void {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    if (this.subscriptionRetry !== null) {
      clearTimeout(this.subscriptionRetry);
      this.subscriptionRetry = null;
    }
    this.subscription?.close();
    this.subscription = null;
  }

  /** Refreshes the live view and reports whether both herdr reads succeeded. */
  async refresh(): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.refreshNow();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async connectSubscription(generation: number): Promise<void> {
    if (
      this.stopped ||
      generation !== this.lifecycleGeneration ||
      this.subscription !== null ||
      this.subscriptionStarting
    ) {
      return;
    }
    this.subscriptionStarting = true;
    const listedPanes = await this.herdr.paneList();
    const paneIds = listedPanes.isOk() ? listedPanes.value.map((pane) => pane.paneId) : [];
    const subscribed = await this.herdr.subscribe({
      paneIds,
      onEvent: (event) => {
        void this.handleTopologyEvent(event.type, generation);
      },
      onError: () => {
        if (generation !== this.lifecycleGeneration || this.stopped) return;
        this.subscription = null;
        this.scheduleSubscriptionRetry(generation);
      },
    });
    this.subscriptionStarting = false;
    if (this.stopped || generation !== this.lifecycleGeneration) {
      if (subscribed.isOk()) subscribed.value.close();
      if (!this.stopped && generation !== this.lifecycleGeneration) {
        void this.connectSubscription(this.lifecycleGeneration);
      }
      return;
    }
    if (subscribed.isErr()) {
      this.scheduleSubscriptionRetry(generation);
      return;
    }
    if (subscribed.value.closed) {
      this.scheduleSubscriptionRetry(generation);
      return;
    }
    this.subscription = subscribed.value;
    void this.refresh();
  }

  private async handleTopologyEvent(eventType: string, generation: number): Promise<void> {
    if (generation !== this.lifecycleGeneration || this.stopped) return;
    await this.refresh();
    switch (eventType) {
      case "pane.created":
      case "pane.closed":
      case "pane.moved":
      case "pane.exited":
        this.restartSubscription(generation);
        return;
      default:
        return;
    }
  }

  private restartSubscription(generation: number): void {
    if (generation !== this.lifecycleGeneration || this.stopped) return;
    this.lifecycleGeneration += 1;
    this.subscription?.close();
    this.subscription = null;
    void this.connectSubscription(this.lifecycleGeneration);
  }

  private scheduleSubscriptionRetry(generation: number): void {
    if (this.stopped || generation !== this.lifecycleGeneration || this.subscriptionRetry !== null) {
      return;
    }
    this.subscriptionRetry = setTimeout(() => {
      this.subscriptionRetry = null;
      void this.connectSubscription(generation);
    }, HERDR_SUBSCRIPTION_RETRY_MS);
  }

  private async refreshNow(): Promise<boolean> {
    const listed = await this.herdr.workspaceList();
    if (listed.isErr()) return false;

    const panes = await this.herdr.paneList();
    if (panes.isErr()) return false;

    const tabs = await this.herdr.tabList();
    if (tabs.isErr()) return false;

    this.currentPanes = [...panes.value];

    this.reconcileStaleRoutes(panes.value);

    const viewForPane = (pane: PaneInfo): HerdrPaneView => {
      const routedParticipant = this.store.agentRouteForTerminal(pane.terminalId);
      const participant = routedParticipant?.routeState === "active" ? routedParticipant : null;
      const lifecycle = this.store.lifecycleAgentForTerminal(pane.terminalId);
      const paneWorkspaceId = workspaceIdForPane(pane);
      const role =
        lifecycle !== null &&
        paneWorkspaceId !== null &&
        lifecycle.workspaceId === paneWorkspaceId &&
        lifecycle.harness === pane.agent &&
        participant?.id === lifecycle.participantId
          ? lifecycle.role
          : null;
      return {
        paneId: pane.paneId,
        label: pane.label ?? null,
        title: pane.terminalTitle ?? null,
        agentKind: pane.agent,
        agentStatus: pane.agentStatus,
        focused: pane.focused,
        participant: participant?.handle ?? null,
        participantRouteState: participant?.routeState ?? null,
        role,
      };
    };

    const panesForWorkspace = (workspaceId: string): PaneInfo[] =>
      panes.value.filter((pane) => workspaceIdForPane(pane) === workspaceId);

    const tabsForWorkspace = (workspaceId: string, workspacePanes: PaneInfo[]): HerdrTab[] => {
      const listedTabs = tabs.value.filter((tab) => tab.workspaceId === workspaceId);
      const knownIds = new Set(listedTabs.map((tab) => tab.id));
      const paneTabs = workspacePanes
        .map((pane) => pane.tabId)
        .filter((tabId): tabId is string => tabId !== undefined && !knownIds.has(tabId));
      const derivedTabs = [...new Set(paneTabs)].map((id) => ({
        id,
        workspaceId,
        label: null,
      }));
      return [...listedTabs, ...derivedTabs];
    };

    const next: HerdrTopologySnapshot = {
      workspaces: listed.value.map((workspace) => ({
        id: workspace.id,
        label: workspace.label,
        panes: panesForWorkspace(workspace.id).map(viewForPane),
        tabs: tabsForWorkspace(workspace.id, panesForWorkspace(workspace.id)).map((tab) => ({
          id: tab.id,
          label: tab.label,
          panes: panesForWorkspace(workspace.id)
            .filter((pane) => pane.tabId === tab.id)
            .map(viewForPane),
        })),
      })),
    };
    const serialized = JSON.stringify(next);
    if (serialized === this.serialized) return true;

    this.current = next;
    this.serialized = serialized;
    this.onChange(next);
    return true;
  }

  /**
   * Returns routes marked stale whose panes are in fact live.
   *
   * Only the participant acting clears a stale mark, so a route marked by an
   * earlier defect stays marked until that participant happens to send
   * something — the fix stops new marks and leaves the written ones. This runs
   * on a successful pane list only: an empty or failed list is absence of
   * evidence, and reactivating on it would clear every mark at once.
   */
  private reconcileStaleRoutes(panes: readonly PaneInfo[]): void {
    for (const route of this.store.staleRoutedParticipants()) {
      if (route.terminalId === null) continue;
      const pane = panes.find((candidate) => candidate.terminalId === route.terminalId);
      if (pane === undefined || occupantChanged(route.occupantAgent, pane.agent)) continue;
      this.store.reactivateRoute(route.id, route.terminalId, pane.paneId);
    }
  }

}
