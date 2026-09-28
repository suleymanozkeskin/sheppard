/**
 * Wire and domain types.
 *
 * Channel, AttachmentMeta, Message, Member, InboxEntry, and SearchResult cross
 * the HTTP boundary. Renaming a field or changing its type changes the wire
 * format that the web client and the CLI both decode.
 *
 * Expected failures are the tagged error classes in ./errors, never values here.
 */

import type { UnrecognizedReason } from "./blocked-dialog";

export type Kind = "agent" | "human";
export type RouteState = "active" | "stale";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type ChannelKind = "chat" | "direct" | "workspace";
export type PreviewKind = "image" | "markdown";

/**
 * Metadata reads that a live subscriber can cache. A `meta` stream frame names
 * the scopes that changed, so the subscriber refetches only those reads.
 */
export const METADATA_SCOPES = [
  "channels",
  "members",
  "inbox",
  "participants",
  "direct",
  "roles",
  "launchers",
  "models",
  "keepAwake",
] as const;
export type MetadataScope = (typeof METADATA_SCOPES)[number];

export interface Channel {
  id: number;
  name: string;
  kind: ChannelKind;
  topic: string | null;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface DeleteChannelResult {
  name: string;
}

export interface AttachmentMeta {
  id: number;
  path: string;
  displayName: string;
  byteSize: number | null;
  mediaType: string | null;
  previewEligible: boolean;
  previewKind: PreviewKind | null;
}

export interface Message {
  id: number;
  channel: string;
  sender: string;
  senderKind: Kind;
  /** Which harness the sender runs: "claude", "codex", … Null unless routed. */
  senderAgentKind: string | null;
  body: string;
  attachments: AttachmentMeta[];
  createdAt: string;
}

export interface Member {
  handle: string;
  kind: Kind;
  /** Which harness the member runs. Null for humans and unrouted agents. */
  agentKind: string | null;
  routeState: RouteState;
  unread: number;
  joinedAt: string;
}

/** A channel member's acknowledged message watermark and current route state. */
export interface ChannelReceipt {
  handle: string;
  cursorMessageId: number;
  routeState: RouteState;
}

export interface InboxEntry {
  channel: string;
  unread: number;
  senders: string[];
  routeState: RouteState;
  pushEnabled: boolean;
}

export interface AddedMember {
  channel: string;
  handle: string;
  cursorId: number;
}

export interface RemovedMember {
  channel: string;
  handle: string;
}

export interface SearchResult {
  messageId: number;
  channel: string;
  sender: string;
  snippet: string;
  createdAt: string;
  attachmentCount: number;
}

/** A participant as the server sees it. The token is never part of this shape. */
export interface Participant {
  id: number;
  handle: string;
  kind: Kind;
  deactivated: boolean;
  terminalId: string | null;
  paneId: string | null;
  occupantAgent: string | null;
  routeState: RouteState;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ParticipantRosterEntry {
  handle: string;
  kind: Kind;
  agentKind: string | null;
  routeState: RouteState;
}

export interface AgentDetailParticipant {
  handle: string;
  kind: "agent";
  agentKind: string | null;
  role: string | null;
  routeState: RouteState;
  lastSeenAt: string | null;
}

export interface AgentRecentMessages {
  channel: string;
  messageIds: number[];
}

export interface AgentChannelMembership {
  channel: string;
  /** The AGENT'S unread backlog in that channel, never the viewer's. */
  unread: number;
}

export interface AgentDetail {
  participant: AgentDetailParticipant;
  routeState: RouteState;
  pane: HerdrPaneView | null;
  recentMessageIds: AgentRecentMessages[];
  channels: AgentChannelMembership[];
}

/** A launcher definition used by configuration and private storage paths. */
export interface LauncherDefinition {
  name: string;
  agentKind: string;
  argv: string[];
  startTimeoutMs: number;
  env: Readonly<Record<string, string>>;
}

/** A public launcher view. Environment values never cross the API boundary. */
export interface Launcher {
  name: string;
  agentKind: string;
  argv: string[];
  envKeys: string[];
  startTimeoutMs: number;
}

export interface DirectConversation {
  channel: string;
  participants: string[];
  unread: number;
  lastMessageAt: string | null;
}

export interface RoleRuntimePreset {
  agentKind: string | null;
  launcher: string | null;
  model: string | null;
  effort: string | null;
}

/** A role as the open surfaces see it: the preset without its briefing. */
export interface RolePreset extends RoleRuntimePreset {
  name: string;
  native: boolean;
  summary: string;
}

/** The authenticated role editor is the one surface that carries the briefing. */
export interface RoleDetail extends RolePreset {
  briefing: string;
}

/** A catalogue entry as the open read sees it: names only, never the suffix. */
export interface ModelEntry {
  harness: string;
  name: string;
  kind: "model" | "effort";
}

export interface AttachmentListingRow {
  attachment: AttachmentMeta;
  channel: string;
  messageId: number;
  sender: string;
  createdAt: string;
}

export interface AttachmentListing {
  rows: AttachmentListingRow[];
  /** Exact: more matching rows exist beyond the limit. Never a length guess. */
  truncated: boolean;
}

/** A pane binding, resolved by the CLI from `herdr pane current --current`. */
export interface Route {
  terminalId: string;
  paneId: string;
  occupantAgent: string | null;
}

export interface HerdrPaneView {
  paneId: string;
  label: string | null;
  /** The live terminal title, rendered as the agent's current task. */
  title: string | null;
  agentKind: string | null;
  agentStatus: AgentStatus;
  focused: boolean;
  participant: string | null;
  participantRouteState: RouteState | null;
  role: string | null;
}

export interface HerdrTabView {
  id: string;
  label: string | null;
  panes: HerdrPaneView[];
}

export interface HerdrWorkspaceView {
  id: string;
  label: string | null;
  panes: HerdrPaneView[];
  tabs: HerdrTabView[];
}

export interface HerdrTopologySnapshot {
  workspaces: HerdrWorkspaceView[];
}

/**
 * An attachment prepared for storage. The filesystem work that produces it
 * (canonicalize, stat, magic bytes, hash) happens above the store; `sha256` is
 * set only for preview-eligible images.
 */
export interface AttachmentInput {
  path: string;
  displayName: string;
  byteSize: number | null;
  mediaType: string | null;
  mtime: string | null;
  sha256: string | null;
}

/** A stored attachment row, used by the preview endpoint. */
export interface StoredAttachment extends AttachmentInput {
  id: number;
  messageId: number;
}

/**
 * How much of an agent's harness session the hub can show.
 *
 * The five states are distinct answers to distinct questions, and none of them
 * substitutes for another. `absent` says the harness wrote no session here;
 * `unsupported` says the hub has no reader for this harness; `error` says the
 * hub could not look. Rendering any of the last two as an empty transcript
 * would state something the hub does not know.
 */
export type SessionState = "ready" | "absent" | "ambiguous" | "unsupported" | "error";

export interface SessionSourceView {
  state: SessionState;
  harness: string | null;
  /** Present only when a session was chosen. */
  sessionPath: string | null;
  /** The last thing the agent said, or null. Never filled with tool output. */
  glance: string | null;
  /** Why the hub could not look, on `error`. */
  reason: string | null;
}

/** The shape every state answers with. Only the values differ. */
export interface AgentSessionView {
  turns: SessionTurnView[];
  /** Byte offset to page backward from, or null at the start of the session. */
  nextBefore: number | null;
  source: SessionSourceView;
  mapping: SessionMappingView | null;
}

/** The small success response from an explicit operator session selection. */
export interface AgentSessionSelectionView {
  state: "ready";
  sessionId: string;
}

export interface SessionTurnView {
  kind: "turn" | "tool";
  role: "user" | "assistant" | null;
  text: string;
  tool: { name: string; outcome: "ok" | "error" | "unknown" } | null;
  at: string | null;
  sidechain: boolean;
}

export interface SessionMappingView {
  confidence: "exact" | "inferred" | "ambiguous";
  /** Populated only when the ladder could not decide, for the picker. */
  candidates: SessionCandidateView[];
}

export interface SessionCandidateView {
  sessionId: string;
  path: string;
  /** Taken from the session's own content, never from a modification time. */
  startedAt: string | null;
  sizeBytes: number;
  cwd: string | null;
  firstUserText: string | null;
}

/** One receiver's pending ping for one channel, snapshotted by the notifier. */
export interface PendingNotification {
  participantId: number;
  handle: string;
  terminalId: string;
  paneId: string;
  occupantAgent: string | null;
  channelId: number;
  channel: string;
  throughId: number;
  count: number;
  senders: string[];
}

/** Whole minutes. Only the keep-awake limits parser constructs it. */
export type Minutes = number & { readonly unit: "minutes" };

/** A count of wake attempts. Only the keep-awake limits parser constructs it. */
export type WakeCount = number & { readonly unit: "wakes" };

export interface KeepAwakeLimits {
  /** How long a target stays idle before the hub wakes it. */
  idleMinutes: Minutes;
  /** How long a dialog stays unanswered before the hub closes it. */
  blockedMinutes: Minutes;
  /** Wakes allowed before the hub stops and asks for the human. */
  maxWakes: WakeCount;
}

/** What one keep-awake policy watches, and who receives a group wake. */
export type KeepAwakeTarget =
  | { kind: "agent"; participantId: number; handle: string }
  | {
      kind: "channel";
      channelId: number;
      channel: string;
      coordinatorId: number;
      coordinator: string;
    };

/** Why the hub stopped waking a target. Each cause names the agent involved. */
export type NeedsHumanCause =
  | { kind: "wakes-exhausted" }
  | { kind: "agent-requested"; handle: string; alert: AlertMessage }
  | { kind: "dialog-unrecognized"; handle: string; reason: UnrecognizedReason }
  | { kind: "dialog-stuck"; handle: string };

/** Where the human can read and answer an agent's `msgr alert-human` question. */
export type AlertMessage =
  | { kind: "message"; channelId: number; channel: string; messageId: number; excerpt: string }
  | { kind: "not-recorded" };

export type LastWake = { kind: "woken"; at: string } | { kind: "not-woken" };

/**
 * `watching` may wake the target. `needs-human` never does; a human message in
 * the target's scope or an explicit resume returns it to `watching`.
 */
export type KeepAwakeState =
  | { kind: "watching"; wakesUsed: number; lastWake: LastWake; since: string }
  | { kind: "needs-human"; cause: NeedsHumanCause; since: string };

export interface KeepAwakePolicy {
  id: number;
  target: KeepAwakeTarget;
  limits: KeepAwakeLimits;
  state: KeepAwakeState;
  /** The newest human message id in the target's scope when last checked. */
  humanMarkId: number;
}

/** The keep-awake setting of one agent or channel, as the API reports it. */
export type KeepAwakeSetting = { kind: "off" } | { kind: "on"; policy: KeepAwakePolicy };

/** A routed agent member of a watched channel, as the watcher needs it. */
export interface KeepAwakeMember {
  participantId: number;
  handle: string;
  terminalId: string;
  paneId: string;
  occupantAgent: string | null;
}

/** The result of `msgr alert-human`. */
export interface HumanAlertResult {
  channel: string;
  messageId: number;
  /** How many keep-awake policies stopped waking because of this alert. */
  pausedPolicies: number;
}

/**
 * Remote access through `tailscale serve`. `host` is the exact MagicDNS name
 * the browser uses; `ownerLogin` is the only Tailscale login admitted.
 */
export type RemoteAccess =
  | { kind: "off" }
  | { kind: "on"; host: string; origin: string; ownerLogin: string; enabledAt: string };

/** A phone or other device that paired with the hub. */
export interface RemoteSession {
  id: number;
  handle: string;
  createdAt: string;
  lastSeen: { kind: "seen"; at: string } | { kind: "not-seen" };
}

/** A one-time pairing code, shown once to the human who created it. */
export interface PairingCode {
  /** Eight characters, shown as two groups of four. */
  code: string;
  expiresAt: string;
  /** Opens the pairing page with the code in the fragment, so no log sees it. */
  url: string;
}
