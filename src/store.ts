/**
 * Typed query layer over the hub database.
 *
 * Everything above this file works in domain types; SQL and row types stay
 * here. Two cursor rules govern the whole design:
 *   unread       = messages.id > cursor_id AND sender_id != self
 *   pending ping = messages.id > MAX(cursor_id, notified_id) AND sender_id != self
 * Every cursor write is monotonic in SQL, so a retry or a race can never move a
 * reader backwards past a message it has already been shown.
 */

import type { Database } from "bun:sqlite";
import { Result, panic } from "better-result";
import { createHash } from "node:crypto";
import {
  type MembershipExists,
  type ChannelExists,
  type ChannelNotDeletable,
  type ChannelNotFound,
  type DirectMembershipLocked,
  type HandleTaken,
  type LauncherExists,
  type RoleExists,
  type ModelExists,
  type NotAMember,
  type NotFound,
  type ValidationFailed,
  channelExists,
  channelNotDeletable,
  channelNotFound,
  directMembershipLocked,
  handleTaken,
  launcherExists,
  roleExists,
  modelExists,
  membershipExists,
  notAMember,
  notFound,
  validationFailed,
} from "./errors";
import { hashToken, mintToken } from "./tokens";
import { isObject, isString, type JsonValue } from "./json";
import type { ModelConfig, RoleConfig } from "./config";
import type {
  AddedMember,
  AgentChannelMembership,
  AttachmentInput,
  AttachmentListing,
  AttachmentMeta,
  Channel,
  ChannelReceipt,
  ChannelKind,
  DirectConversation,
  AgentRecentMessages,
  InboxEntry,
  Kind,
  LauncherDefinition,
  Member,
  Message,
  Participant,
  PendingNotification,
  ParticipantRosterEntry,
  PreviewKind,
  Route,
  RouteState,
  RemovedMember,
  RoleRuntimePreset,
  SearchResult,
  StoredAttachment,
} from "./types";

/**
 * Column types narrower than TEXT are sound because the schema CHECK
 * constraints admit no other value.
 */
export interface SessionMappingRow {
  terminal_id: string;
  harness: string;
  session_id: string;
  session_path: string;
  confidence: string;
  resolved_at: string;
}

interface ParticipantRow {
  id: number;
  handle: string;
  kind: Kind;
  deactivated: number;
  token_hash: string;
  terminal_id: string | null;
  pane_id: string | null;
  occupant_agent: string | null;
  route_state: RouteState;
  last_seen_at: string | null;
  created_at: string;
}

interface ChannelRow {
  id: number;
  name: string;
  kind: ChannelKind;
  topic: string | null;
  created_at: string;
}

interface ChannelSummaryRow extends ChannelRow {
  member_count: number;
  message_count: number;
  last_message_at: string | null;
}

interface MessageRow {
  id: number;
  channel: string;
  sender: string;
  sender_kind: Kind;
  sender_agent_kind: string | null;
  body: string;
  created_at: string;
}

interface RecentMessageIdRow {
  channel: string;
  id: number;
}

interface AttachmentRow {
  id: number;
  message_id: number;
  path: string;
  display_name: string;
  byte_size: number | null;
  media_type: string | null;
  mtime: string | null;
  sha256: string | null;
}

const PREVIEW_KIND_BY_MEDIA_TYPE = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "text/markdown": "markdown",
} satisfies Readonly<Record<string, PreviewKind>>;

function previewKindForRow(row: Pick<AttachmentRow, "media_type" | "sha256">): PreviewKind | null {
  if (row.sha256 === null || row.media_type === null) return null;
  return PREVIEW_KIND_BY_MEDIA_TYPE[row.media_type] ?? null;
}

interface MemberRow {
  handle: string;
  kind: Kind;
  agent_kind: string | null;
  route_state: RouteState;
  joined_at: string;
  unread: number;
}

interface ChannelReceiptRow {
  handle: string;
  cursor_message_id: number;
  route_state: RouteState;
}

interface InboxRow {
  channel: string;
  unread: number;
  senders: string | null;
  kind: Kind;
  route_state: RouteState;
  terminal_id: string | null;
}

interface PendingRow {
  participant_id: number;
  handle: string;
  terminal_id: string;
  pane_id: string;
  occupant_agent: string | null;
  channel_id: number;
  channel: string;
  through_id: number;
  count: number;
  senders: string;
}

interface DirectConversationRow {
  channel: string;
  participants: string | null;
  unread: number;
  last_message_at: string | null;
}

interface LifecycleAgentRow {
  pane_id: string;
  terminal_id: string | null;
  workspace_id: string;
  participant_id: number;
  role: string | null;
  harness: string;
  launch_env_json: string;
  active: number;
  created_at: string;
}

type LifecycleSpawnStatus = "pending" | "committed" | "failed";
export type LifecycleCleanupOutcome = "closed" | "skipped" | "failed";

interface LifecycleSpawnOperationRow {
  operation_key: string;
  requester_id: number;
  workspace_id: string;
  harness: string;
  launcher: string | null;
  launcher_revision: number | null;
  launch_env_json: string;
  role: string | null;
  requested_handle: string;
  assigned_handle: string | null;
  participant_id: number | null;
  pane_id: string | null;
  terminal_id: string | null;
  baseline_panes: string;
  status: LifecycleSpawnStatus;
  cleanup_outcome: LifecycleCleanupOutcome | null;
  cleanup_error: string | null;
  created_at: string;
  updated_at: string;
}

interface LauncherRow {
  name: string;
  agent_kind: string;
  argv_json: string;
  env_json: string;
  start_timeout_ms: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RoleRow {
  name: string;
  agent_kind: string | null;
  summary: string;
  briefing: string;
  launcher: string | null;
  model: string | null;
  effort: string | null;
  native: number;
  revision: number;
}

interface ModelRow {
  harness: string;
  name: string;
  kind: "model" | "effort";
  argv_suffix_json: string;
  revision: number;
}

export interface RoleRecord {
  name: string;
  agentKind: string | null;
  summary: string;
  briefing: string;
  launcher: string | null;
  model: string | null;
  effort: string | null;
  native: boolean;
  revision: number;
}

export interface ModelRecord {
  harness: string;
  name: string;
  kind: "model" | "effort";
  argvSuffix: string[];
  revision: number;
}

const MESSAGE_COLUMNS = `
  m.id              AS id,
  c.name            AS channel,
  p.handle          AS sender,
  p.kind            AS sender_kind,
  p.occupant_agent  AS sender_agent_kind,
  m.body            AS body,
  m.created_at      AS created_at
`;

const MESSAGE_SOURCE = `
  FROM messages m
  JOIN channels c     ON c.id = m.channel_id
  JOIN participants p ON p.id = m.sender_id
`;

/**
 * Handles match `^[a-z][a-z0-9_-]{0,31}$`, so a comma never occurs inside one
 * and GROUP_CONCAT's default separator is unambiguous.
 */
function splitHandles(concatenated: string | null): string[] {
  if (concatenated === null || concatenated.length === 0) return [];
  return concatenated.split(",").sort();
}

function isStoredString(value: JsonValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

interface StoredEnvironment {
  [key: string]: string;
}

function parseStoredEnvironment(value: string, subject: string): StoredEnvironment {
  const parsed = Result.try<JsonValue, Error>({
    try: () => JSON.parse(value),
    catch: () => new Error(`${subject} environment is not valid JSON`),
  });
  if (parsed.isErr()) panic(`${subject} carried invalid environment JSON`);
  const raw = parsed.value;
  if (!isObject(raw)) panic(`${subject} carried invalid environment`);
  const environment: StoredEnvironment = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key.length === 0 || !isString(entry)) panic(`${subject} carried invalid environment`);
    environment[key] = entry;
  }
  return environment;
}

function baselinePanes(row: LifecycleSpawnOperationRow): string[] {
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(row.baseline_panes),
    catch: () => null,
  });
  if (parsed.isErr()) {
    panic("lifecycle spawn operation carried an invalid pane baseline");
  }
  const value = parsed.value;
  if (!Array.isArray(value) || !value.every(isStoredString)) {
    panic("lifecycle spawn operation carried an invalid pane baseline");
  }
  return value;
}

function toLifecycleSpawnOperation(row: LifecycleSpawnOperationRow): LifecycleSpawnOperation {
  return {
    operationKey: row.operation_key,
    requesterId: row.requester_id,
    workspaceId: row.workspace_id,
    harness: row.harness,
    launcher: row.launcher,
    launcherRevision: row.launcher_revision,
    launchEnv: parseStoredEnvironment(row.launch_env_json, "spawn operation"),
    role: row.role,
    requestedHandle: row.requested_handle,
    assignedHandle: row.assigned_handle,
    participantId: row.participant_id,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    baselinePanes: baselinePanes(row),
    status: row.status,
    cleanupOutcome: row.cleanup_outcome,
    cleanupError: row.cleanup_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLauncher(row: LauncherRow): LauncherRecord {
  const parsed = Result.try<JsonValue, Error>({
    try: () => JSON.parse(row.argv_json),
    catch: () => new Error("launcher argv is not valid JSON"),
  });
  if (parsed.isErr()) panic("launcher carried invalid argv JSON");
  const argv = parsed.value;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isStoredString)) {
    panic("launcher carried invalid argv");
  }
  const env = parseStoredEnvironment(row.env_json, "launcher");
  const record: LauncherRecord = {
    name: row.name,
    agentKind: row.agent_kind,
    argv,
    env,
    startTimeoutMs: row.start_timeout_ms,
    revision: row.revision,
  };
  return record;
}

function toRole(row: RoleRow): RoleRecord {
  return {
    name: row.name,
    agentKind: row.agent_kind,
    summary: row.summary,
    briefing: row.briefing,
    launcher: row.launcher,
    model: row.model,
    effort: row.effort,
    native: row.native === 1,
    revision: row.revision,
  };
}

function toModel(row: ModelRow): ModelRecord {
  const parsed = Result.try<JsonValue, Error>({
    try: () => JSON.parse(row.argv_suffix_json),
    catch: () => new Error("model argv suffix is not valid JSON"),
  });
  if (parsed.isErr()) panic("model carried invalid argv suffix JSON");
  const argvSuffix = parsed.value;
  if (!Array.isArray(argvSuffix) || !argvSuffix.every(isStoredString)) {
    panic("model carried an invalid argv suffix");
  }
  return {
    harness: row.harness,
    name: row.name,
    kind: row.kind,
    argvSuffix,
    revision: row.revision,
  };
}

function directChannelName(participantIds: readonly number[]): string {
  const digest = createHash("sha256")
    .update(participantIds.join(","))
    .digest("hex")
    .slice(0, 16);
  return `dm-${digest}`;
}

const MAX_HANDLE_LENGTH = 32;
const MAX_HANDLE_ORDINAL = 999;
const MAX_AGENT_RECENT_MESSAGE_IDS = 20;

/**
 * Appends an ordinal, trimming the base when the suffix would otherwise push the
 * handle past the length every handle is validated against. Only the tail is
 * trimmed, so the result still begins with the requested letter.
 */
function withOrdinal(base: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  const room = MAX_HANDLE_LENGTH - suffix.length;
  return `${base.length > room ? base.slice(0, room) : base}${suffix}`;
}

export interface StoreOptions {
  /** Injectable clock so tests produce deterministic timestamps. */
  now?: () => string;
}

export interface CreatedParticipant {
  participant: Participant;
  /** The raw session token is returned only for the session just created. */
  token: string;
}

export interface DeactivatedParticipant {
  handle: string;
}

export interface LauncherRecord extends LauncherDefinition {
  revision: number;
}

export interface LauncherView extends Launcher {
  revision: number;
}

export interface FetchResult {
  messages: Message[];
  throughId: number;
}

export interface JoinResult {
  channel: string;
  cursorId: number;
}

export interface AckResult {
  cursorId: number;
  advanced: boolean;
}

export interface WorkspaceBroadcastResult {
  message: Message;
  recipients: string[];
}

export interface LifecycleAgentRecord {
  paneId: string;
  terminalId: string | null;
  workspaceId: string;
  participantId: number;
  role: string | null;
  harness: string;
  launchEnv: Readonly<Record<string, string>>;
  active: boolean;
  createdAt: string;
}

export interface LifecycleSpawnOperation {
  operationKey: string;
  requesterId: number;
  workspaceId: string;
  harness: string;
  launcher: string | null;
  launcherRevision: number | null;
  launchEnv: Readonly<Record<string, string>>;
  role: string | null;
  requestedHandle: string;
  assignedHandle: string | null;
  participantId: number | null;
  paneId: string | null;
  terminalId: string | null;
  baselinePanes: string[];
  status: LifecycleSpawnStatus;
  cleanupOutcome: LifecycleCleanupOutcome | null;
  cleanupError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipChange {
  channel: string;
  created: boolean;
  addedParticipantIds: number[];
}

export class Store {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private tx<T>(body: () => T): T {
    return this.db.transaction(body)();
  }

  // ---------------------------------------------------------------- participants

  /**
   * Creates an agent, taking the next free ordinal when the requested handle is
   * held: `reviewer`, then `reviewer-2`, `reviewer-3`. A spawner launching many
   * workers under one name therefore does not have to invent unique names, and
   * must read the assigned handle back from the result.
   *
   * `exact` refuses the collision instead, for a caller that needs the name it
   * asked for or nothing.
   */
  createAgent(handle: string, exact = false): Result<CreatedParticipant, HandleTaken> {
    return this.createParticipant(handle, "agent", exact);
  }

  /** Creates the first operator identity, or an extra one in a QA hub. */
  createHuman(handle: string): Result<CreatedParticipant, HandleTaken> {
    return this.createParticipant(handle, "human", true);
  }

  mostRecentlySeenHuman(): Participant | null {
    const row = this.db
      .query<ParticipantRow, []>(
        `SELECT * FROM participants
          WHERE kind = 'human' AND deactivated = 0
          ORDER BY last_seen_at IS NULL, last_seen_at DESC, id DESC
          LIMIT 1`,
      )
      .get();
    return row === null ? null : toParticipant(row);
  }

  /** Creates a new human session without invalidating existing sessions. */
  reissueHuman(handle: string): Result<CreatedParticipant, HandleTaken> {
    const token = mintToken();
    const updated = this.tx(() => {
      const existing = this.db
        .query<ParticipantRow, { handle: string }>(
          `SELECT * FROM participants
            WHERE handle = $handle AND kind = 'human' AND deactivated = 0`,
        )
        .get({ handle });
      if (existing === null) return null;

      this.db
        .query<never, { participantId: number; tokenHash: string; createdAt: string }>(
          `INSERT OR IGNORE INTO human_sessions (participant_id, token_hash, created_at)
           VALUES ($participantId, $tokenHash, $createdAt)`,
        )
        .run({
          participantId: existing.id,
          tokenHash: existing.token_hash,
          createdAt: this.now(),
        });
      const next = this.db
        .query<ParticipantRow, { id: number; tokenHash: string }>(
          `UPDATE participants
              SET token_hash = $tokenHash
            WHERE id = $id
            RETURNING *`,
        )
        .get({ id: existing.id, tokenHash: hashToken(token) });
      if (next === null) return null;

      // Keep the current participant token plus the newest fifteen previous
      // sessions. The delete is scoped to this participant only.
      this.db
        .query<never, { participantId: number }>(
          `DELETE FROM human_sessions
            WHERE participant_id = $participantId
              AND id NOT IN (
                SELECT id FROM human_sessions
                 WHERE participant_id = $participantId
                 ORDER BY id DESC
                 LIMIT 15
              )`,
        )
        .run({ participantId: existing.id });
      return next;
    });

    if (updated === null) return Result.err(handleTaken(handle));
    return Result.ok({ participant: toParticipant(updated), token });
  }

  private createParticipant(
    handle: string,
    kind: Kind,
    exact: boolean,
  ): Result<CreatedParticipant, HandleTaken> {
    const token = mintToken();
    // Choosing the name and claiming it happen in one transaction, so two
    // spawners racing on the same base name cannot be assigned the same handle.
    const created = this.tx((): ParticipantRow | null => {
      const assigned = exact
        ? this.handleFree(handle)
          ? handle
          : null
        : this.nextFreeHandle(handle);
      if (assigned === null) return null;

      return this.db
        .query<ParticipantRow, { handle: string; kind: Kind; tokenHash: string; now: string }>(
          `INSERT INTO participants (handle, kind, token_hash, created_at)
           VALUES ($handle, $kind, $tokenHash, $now)
           RETURNING *`,
        )
        .get({ handle: assigned, kind, tokenHash: hashToken(token), now: this.now() });
    });

    if (created === null) return Result.err(handleTaken(handle));
    return Result.ok({ participant: toParticipant(created), token });
  }

  private handleFree(handle: string): boolean {
    const taken = this.db
      .query<{ id: number }, { handle: string }>(
        `SELECT id FROM participants WHERE handle = $handle`,
      )
      .get({ handle });
    return taken === null;
  }

  private nextFreeHandle(requested: string): string | null {
    if (this.handleFree(requested)) return requested;
    for (let ordinal = 2; ordinal <= MAX_HANDLE_ORDINAL; ordinal += 1) {
      const candidate = withOrdinal(requested, ordinal);
      if (this.handleFree(candidate)) return candidate;
    }
    return null;
  }

  findByToken(token: string): Participant | null {
    const row = this.db
      .query<ParticipantRow, { tokenHash: string }>(
        `SELECT p.*
           FROM participants p
           LEFT JOIN human_sessions hs ON hs.participant_id = p.id
          WHERE p.deactivated = 0
            AND (p.token_hash = $tokenHash OR hs.token_hash = $tokenHash)
          LIMIT 1`,
      )
      .get({ tokenHash: hashToken(token) });
    return row === null ? null : toParticipant(row);
  }

  findByHandle(handle: string): Participant | null {
    const row = this.db
      .query<ParticipantRow, { handle: string }>(
        `SELECT * FROM participants WHERE handle = $handle`,
      )
      .get({ handle });
    return row === null ? null : toParticipant(row);
  }

  findById(id: number): Participant | null {
    const row = this.db
      .query<ParticipantRow, { id: number }>(`SELECT * FROM participants WHERE id = $id`)
      .get({ id });
    return row === null ? null : toParticipant(row);
  }

  /** Returns the active agent currently bound to a pane, without exposing a token. */
  findActiveAgentByPaneId(paneId: string): Participant | null {
    const row = this.db
      .query<ParticipantRow, { paneId: string }>(
        `SELECT * FROM participants
          WHERE pane_id = $paneId
            AND kind = 'agent'
            AND route_state = 'active'
            AND deactivated = 0
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get({ paneId });
    return row === null ? null : toParticipant(row);
  }

  /** Returns the active pane-scoped identity for one durable terminal. */
  findActiveAgentByTerminal(terminalId: string): Participant | null {
    const row = this.db
      .query<ParticipantRow, { terminalId: string }>(
        `SELECT * FROM participants
          WHERE terminal_id = $terminalId
            AND kind = 'agent'
            AND route_state = 'active'
            AND deactivated = 0
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get({ terminalId });
    return row === null ? null : toParticipant(row);
  }

  /** Returns the public roster without tokens or internal participant ids. */
  listParticipants(): ParticipantRosterEntry[] {
    const rows = this.db
      .query<
        { handle: string; kind: Kind; agent_kind: string | null; route_state: RouteState },
        []
      >(
        `SELECT handle, kind, occupant_agent AS agent_kind, route_state
           FROM participants
          WHERE deactivated = 0
          ORDER BY handle`,
      )
      .all();

    return rows.map((row) => ({
      handle: row.handle,
      kind: row.kind,
      agentKind: row.agent_kind,
      routeState: row.route_state,
    }));
  }

  recentMessageIds(participantId: number): AgentRecentMessages[] {
    const rows = this.db
      .query<RecentMessageIdRow, { participantId: number; limit: number }>(
        `WITH ranked AS (
           SELECT c.name AS channel,
                  m.id AS id,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.channel_id
                    ORDER BY m.id DESC
                  ) AS message_rank
             FROM messages m
             JOIN channels c ON c.id = m.channel_id
            WHERE m.sender_id = $participantId
         )
         SELECT channel, id
           FROM ranked
          WHERE message_rank <= $limit
          ORDER BY channel ASC, id DESC`,
      )
      .all({ participantId, limit: MAX_AGENT_RECENT_MESSAGE_IDS });

    const byChannel = new Map<string, number[]>();
    for (const row of rows) {
      const messageIds = byChannel.get(row.channel) ?? [];
      messageIds.push(row.id);
      byChannel.set(row.channel, messageIds);
    }
    return [...byChannel].map(([channel, messageIds]) => ({ channel, messageIds }));
  }

  /**
   * Permanently removes an identity from active surfaces while retaining its
   * row for message attribution and stable direct-conversation history.
   */
  deactivateParticipant(handle: string): Result<DeactivatedParticipant, NotFound> {
    const changed = this.db
      .query<{ handle: string }, { handle: string }>(
        `UPDATE participants
            SET deactivated = 1,
                terminal_id = NULL,
                pane_id = NULL,
                route_state = 'stale'
          WHERE handle = $handle AND deactivated = 0
          RETURNING handle`,
      )
      .get({ handle });
    return changed === null
      ? Result.err(notFound(`Participant "${handle}"`))
      : Result.ok({ handle: changed.handle });
  }

  /**
   * Binds a pane route to a participant and reactivates it.
   *
   * A terminal has one active route. Binding a terminal that another
   * participant still holds releases the older binding. The displaced route
   * keeps its identity fields so stale visibility and later healing remain
   * possible.
   */
  bindRoute(participantId: number, route: Route): void {
    this.tx(() => {
      this.db
        .query<never, { terminalId: string; participantId: number }>(
          `UPDATE participants
              SET route_state = 'stale'
            WHERE terminal_id = $terminalId
              AND route_state = 'active'
              AND deactivated = 0
              AND id != $participantId`,
        )
        .run({ terminalId: route.terminalId, participantId });

      this.db
        .query<
          never,
          {
            participantId: number;
            terminalId: string;
            paneId: string;
            occupantAgent: string | null;
          }
        >(
          `UPDATE participants
              SET terminal_id = $terminalId, pane_id = $paneId, occupant_agent = $occupantAgent,
                  route_state = 'active'
            WHERE id = $participantId AND deactivated = 0`,
        )
        .run({
          participantId,
          terminalId: route.terminalId,
          paneId: route.paneId,
          occupantAgent: route.occupantAgent,
        });
      this.markSeen(participantId);
    });
  }

  /** Binds the route created by a verified lifecycle spawn. */
  bindLifecycleSpawnRoute(
    participantId: number,
    paneId: string,
    terminalId: string,
    occupantAgent: string,
  ): boolean {
    return this.tx(() => {
      const participant = this.db
        .query<{ id: number }, { participantId: number }>(
          `SELECT id FROM participants
            WHERE id = $participantId AND kind = 'agent' AND deactivated = 0`,
        )
        .get({ participantId });
      if (participant === null) return false;

      this.db
        .query<never, { terminalId: string; participantId: number }>(
          `UPDATE participants
              SET route_state = 'stale'
            WHERE terminal_id = $terminalId
              AND route_state = 'active'
              AND deactivated = 0
              AND id != $participantId`,
        )
        .run({ terminalId, participantId });
      this.db
        .query<never, {
          participantId: number;
          terminalId: string;
          paneId: string;
          occupantAgent: string;
        }>(
          `UPDATE participants
              SET terminal_id = $terminalId, pane_id = $paneId,
                  occupant_agent = $occupantAgent, route_state = 'active'
            WHERE id = $participantId AND deactivated = 0`,
        )
        .run({ participantId, terminalId, paneId, occupantAgent });
      return true;
    });
  }

  /**
   * Follows a route to its pane's new public id.
   *
   * herdr pane ids are compact: closing one pane renumbers the rest, so a live
   * pane can change id while its terminal id stays. This writes the new pane id
   * and nothing else — the route state is left as it was, and `last_seen_at` is
   * untouched, because the hub followed the pane rather than the participant
   * making a request.
   */
  healRoutePane(participantId: number, paneId: string): void {
    this.db
      .query<never, { participantId: number; paneId: string }>(
        `UPDATE participants SET pane_id = $paneId WHERE id = $participantId`,
      )
      .run({ participantId, paneId });
  }

  /**
   * The session mapping is keyed on terminal_id — the identity a pane move does
   * not change — so a resolved session survives a renumber without being
   * re-derived by description.
   */
  findSessionMapping(terminalId: string): SessionMappingRow | null {
    return (
      this.db
        .query<SessionMappingRow, { terminalId: string }>(
          `SELECT terminal_id, harness, session_id, session_path, confidence, resolved_at
             FROM session_mappings WHERE terminal_id = $terminalId`,
        )
        .get({ terminalId }) ?? null
    );
  }

  saveSessionMapping(row: Omit<SessionMappingRow, "resolved_at">): void {
    this.db
      .query<never, SessionMappingRow>(
        `INSERT INTO session_mappings
           (terminal_id, harness, session_id, session_path, confidence, resolved_at)
         VALUES ($terminal_id, $harness, $session_id, $session_path, $confidence, $resolved_at)
         ON CONFLICT (terminal_id) DO UPDATE SET
           harness = excluded.harness,
           session_id = excluded.session_id,
           session_path = excluded.session_path,
           confidence = excluded.confidence,
           resolved_at = excluded.resolved_at`,
      )
      .run({ ...row, resolved_at: new Date().toISOString() });
  }

  markRouteStale(participantId: number): void {
    this.db
      .query<never, { participantId: number }>(
        `UPDATE participants SET route_state = 'stale' WHERE id = $participantId`,
      )
      .run({ participantId });
  }

  /** Routes marked stale, which only their own participant acting can clear. */
  staleRoutedParticipants(): Participant[] {
    return this.db
      .query<ParticipantRow, []>(
        `SELECT * FROM participants
          WHERE route_state = 'stale' AND deactivated = 0 AND terminal_id IS NOT NULL
          ORDER BY id`,
      )
      .all()
      .map(toParticipant);
  }

  /**
   * Returns a stale route to active on evidence the hub gathered itself.
   *
   * A fix stops new staleness; it does not clear a mark the old code wrote, and
   * only the participant acting clears one. This reactivates from the same
   * evidence `bindRoute` trusts — a live pane on the recorded terminal — and
   * writes the pane id with it, because the pane may have renumbered while the
   * route was stale.
   *
   * `last_seen_at` stays untouched: it is the proof a prompt was consumed, and
   * the participant has not acted. The conflict test lives inside the statement
   * rather than beside it, so a terminal another route has since claimed cannot
   * be taken between the check and the write. Returns whether the route moved.
   */
  reactivateRoute(participantId: number, terminalId: string, paneId: string): boolean {
    const changed = this.db
      .query<
        { handle: string },
        { participantId: number; terminalId: string; paneId: string }
      >(
        `UPDATE participants
            SET pane_id = $paneId, route_state = 'active'
          WHERE id = $participantId
            AND deactivated = 0
            AND route_state = 'stale'
            AND terminal_id = $terminalId
            AND NOT EXISTS (
              SELECT 1 FROM participants AS holder
               WHERE holder.terminal_id = $terminalId
                 AND holder.route_state = 'active'
                 AND holder.deactivated = 0
                 AND holder.id != $participantId
            )
          RETURNING handle`,
      )
      .get({ participantId, terminalId, paneId });
    return changed !== null;
  }

  /** Records an authenticated request without changing the participant route. */
  markSeen(participantId: number): void {
    const previous = this.db
      .query<{ last_seen_at: string | null }, { participantId: number }>(
        `SELECT last_seen_at FROM participants WHERE id = $participantId`,
      )
      .get({ participantId });
    const requestedAt = this.now();
    const previousAt = previous?.last_seen_at;
    const requestedMs = Date.parse(requestedAt);
    const previousMs = previousAt === null || previousAt === undefined
      ? Number.NaN
      : Date.parse(previousAt);
    const now =
      Number.isFinite(requestedMs) && Number.isFinite(previousMs) && requestedMs <= previousMs
        ? new Date(previousMs + 1).toISOString()
        : requestedAt;
    this.db
      .query<never, { participantId: number; now: string }>(
        `UPDATE participants SET last_seen_at = $now WHERE id = $participantId`,
      )
      .run({ participantId, now });
  }

  /** Returns the timestamp of the last authenticated request. */
  lastSeenAt(participantId: number): string | null {
    const row = this.db
      .query<{ last_seen_at: string | null }, { participantId: number }>(
        `SELECT last_seen_at FROM participants WHERE id = $participantId`,
      )
      .get({ participantId });
    return row?.last_seen_at ?? null;
  }

  seedLaunchers(seeds: readonly LauncherDefinition[]): void {
    this.tx(() => {
      for (const seed of seeds) {
        const firstSeen = this.db
          .query<{ name: string }, { name: string; now: string }>(
            `INSERT OR IGNORE INTO launcher_seeds (name, first_seen_at)
             VALUES ($name, $now)
             RETURNING name`,
          )
          .get({ name: seed.name, now: this.now() });
        if (firstSeen === null) continue;
        this.db
          .query<never, {
            name: string;
            agentKind: string;
            argvJson: string;
            envJson: string;
            startTimeoutMs: number;
            now: string;
          }>(
            `INSERT OR IGNORE INTO launchers
              (name, agent_kind, argv_json, env_json, start_timeout_ms, created_at, updated_at)
             VALUES ($name, $agentKind, $argvJson, $envJson, $startTimeoutMs, $now, $now)`,
          )
          .run({
            name: seed.name,
            agentKind: seed.agentKind,
            argvJson: JSON.stringify(seed.argv),
            envJson: JSON.stringify(seed.env),
            startTimeoutMs: seed.startTimeoutMs,
            now: this.now(),
          });
      }
    });
  }

  listLaunchers(): LauncherRecord[] {
    return this.db
      .query<LauncherRow, []>(
        `SELECT name, agent_kind, argv_json, env_json, start_timeout_ms, revision, created_at, updated_at
           FROM launchers
          ORDER BY name`,
      )
      .all()
      .map(toLauncher);
  }

  launcher(name: string): LauncherRecord | null {
    const row = this.db
      .query<LauncherRow, { name: string }>(
        `SELECT name, agent_kind, argv_json, env_json, start_timeout_ms, revision, created_at, updated_at
           FROM launchers
          WHERE name = $name`,
      )
      .get({ name });
    return row === null ? null : toLauncher(row);
  }

  createLauncher(launcher: LauncherDefinition): Result<LauncherRecord, LauncherExists> {
    const now = this.now();
    const row = this.db
      .query<LauncherRow, {
        name: string;
        agentKind: string;
        argvJson: string;
        envJson: string;
        startTimeoutMs: number;
        now: string;
      }>(
        `INSERT OR IGNORE INTO launchers
          (name, agent_kind, argv_json, env_json, start_timeout_ms, created_at, updated_at)
         VALUES ($name, $agentKind, $argvJson, $envJson, $startTimeoutMs, $now, $now)
         RETURNING name, agent_kind, argv_json, env_json, start_timeout_ms, revision, created_at, updated_at`,
      )
      .get({
        name: launcher.name,
        agentKind: launcher.agentKind,
        argvJson: JSON.stringify(launcher.argv),
        envJson: JSON.stringify(launcher.env),
        startTimeoutMs: launcher.startTimeoutMs,
        now,
      });
    return row === null ? Result.err(launcherExists(launcher.name)) : Result.ok(toLauncher(row));
  }

  updateLauncher(
    name: string,
    definition: Pick<LauncherDefinition, "agentKind" | "argv" | "startTimeoutMs" | "env">,
  ): Result<LauncherRecord, NotFound> {
    const row = this.db
      .query<LauncherRow, {
        name: string;
        agentKind: string;
        argvJson: string;
        envJson: string;
        startTimeoutMs: number;
        now: string;
      }>(
        `UPDATE launchers
            SET agent_kind = $agentKind,
                argv_json = $argvJson,
                env_json = $envJson,
                start_timeout_ms = $startTimeoutMs,
                revision = revision + 1,
                updated_at = $now
          WHERE name = $name
          RETURNING name, agent_kind, argv_json, env_json, start_timeout_ms, revision, created_at, updated_at`,
      )
      .get({
        name,
        agentKind: definition.agentKind,
        argvJson: JSON.stringify(definition.argv),
        envJson: JSON.stringify(definition.env),
        startTimeoutMs: definition.startTimeoutMs,
        now: this.now(),
      });
    return row === null ? Result.err(notFound(`Launcher "${name}"`)) : Result.ok(toLauncher(row));
  }

  deleteLauncher(name: string): Result<{ name: string }, NotFound> {
    const deleted = this.db
      .query<{ name: string }, { name: string }>(
        `DELETE FROM launchers WHERE name = $name RETURNING name`,
      )
      .get({ name });
    return deleted === null
      ? Result.err(notFound(`Launcher "${name}"`))
      : Result.ok({ name: deleted.name });
  }

  seedRoles(seeds: readonly RoleConfig[]): void {
    this.tx(() => {
      for (const seed of seeds) {
        const firstSeen = this.db
          .query<{ name: string }, { name: string; now: string }>(
            `INSERT OR IGNORE INTO role_seeds (name, first_seen_at)
             VALUES ($name, $now)
             RETURNING name`,
          )
          .get({ name: seed.name, now: this.now() });
        if (firstSeen === null) {
          if (seed.name === "reporter" && seed.native === true) {
            this.db
              .query<never, { name: string }>(
                `UPDATE roles
                    SET native = 1
                  WHERE name = $name`,
              )
              .run({ name: seed.name });
          }
          continue;
        }
        this.db
          .query<never, {
            name: string;
            agentKind: string | null;
            summary: string;
            briefing: string;
            launcher: string | null;
            model: string | null;
            effort: string | null;
            native: number;
            now: string;
          }>(
            `INSERT OR IGNORE INTO roles
              (name, agent_kind, summary, briefing, launcher, model, effort, native, created_at, updated_at)
             VALUES ($name, $agentKind, $summary, $briefing, $launcher, $model, $effort, $native, $now, $now)`,
          )
          .run({
            name: seed.name,
            agentKind: seed.agentKind,
            summary: seed.summary,
            briefing: seed.briefing,
            launcher: seed.launcher ?? null,
            model: seed.model ?? null,
            effort: seed.effort ?? null,
            native: seed.native === true ? 1 : 0,
            now: this.now(),
          });
      }
    });
  }

  listRoles(): RoleRecord[] {
    return this.db
      .query<RoleRow, []>(
        `SELECT name, agent_kind, summary, briefing, launcher, model, effort, native, revision
           FROM roles
          ORDER BY name`,
      )
      .all()
      .map(toRole);
  }

  role(name: string): RoleRecord | null {
    const row = this.db
      .query<RoleRow, { name: string }>(
        `SELECT name, agent_kind, summary, briefing, launcher, model, effort, native, revision
           FROM roles
          WHERE name = $name`,
      )
      .get({ name });
    return row === null ? null : toRole(row);
  }

  createRole(
    role: Omit<RoleRecord, "revision" | "native">,
  ): Result<RoleRecord, RoleExists> {
    const now = this.now();
    const row = this.db
      .query<RoleRow, {
        name: string;
        agentKind: string | null;
        summary: string;
        briefing: string;
        launcher: string | null;
        model: string | null;
        effort: string | null;
        now: string;
      }>(
        `INSERT OR IGNORE INTO roles
          (name, agent_kind, summary, briefing, launcher, model, effort, native, created_at, updated_at)
         VALUES ($name, $agentKind, $summary, $briefing, $launcher, $model, $effort, 0, $now, $now)
         RETURNING name, agent_kind, summary, briefing, launcher, model, effort, native, revision`,
      )
      .get({
        name: role.name,
        agentKind: role.agentKind,
        summary: role.summary,
        briefing: role.briefing,
        launcher: role.launcher,
        model: role.model,
        effort: role.effort,
        now,
      });
    return row === null ? Result.err(roleExists(role.name)) : Result.ok(toRole(row));
  }

  updateRole(
    name: string,
    definition: Omit<RoleRecord, "name" | "revision" | "native">,
  ): Result<RoleRecord, NotFound> {
    const row = this.db
      .query<RoleRow, {
        name: string;
        agentKind: string | null;
        summary: string;
        briefing: string;
        launcher: string | null;
        model: string | null;
        effort: string | null;
        now: string;
      }>(
        `UPDATE roles
            SET agent_kind = $agentKind,
                summary = $summary,
                briefing = $briefing,
                launcher = $launcher,
                model = $model,
                effort = $effort,
                revision = revision + 1,
                updated_at = $now
          WHERE name = $name
          RETURNING name, agent_kind, summary, briefing, launcher, model, effort, native, revision`,
      )
      .get({
        name,
        agentKind: definition.agentKind,
        summary: definition.summary,
        briefing: definition.briefing,
        launcher: definition.launcher,
        model: definition.model,
        effort: definition.effort,
        now: this.now(),
      });
    return row === null ? Result.err(notFound(`Role "${name}"`)) : Result.ok(toRole(row));
  }

  updateRoleRuntime(
    name: string,
    runtime: RoleRuntimePreset,
  ): Result<RoleRecord, NotFound> {
    const row = this.db
      .query<RoleRow, {
        name: string;
        agentKind: string | null;
        launcher: string | null;
        model: string | null;
        effort: string | null;
        now: string;
      }>(
        `UPDATE roles
            SET agent_kind = $agentKind,
                launcher = $launcher,
                model = $model,
                effort = $effort,
                revision = revision + 1,
                updated_at = $now
          WHERE name = $name
          RETURNING name, agent_kind, summary, briefing, launcher, model, effort, native, revision`,
      )
      .get({
        name,
        agentKind: runtime.agentKind,
        launcher: runtime.launcher,
        model: runtime.model,
        effort: runtime.effort,
        now: this.now(),
      });
    return row === null ? Result.err(notFound(`Role "${name}"`)) : Result.ok(toRole(row));
  }

  deleteRole(name: string): Result<{ name: string }, NotFound> {
    const deleted = this.db
      .query<{ name: string }, { name: string }>(
        `DELETE FROM roles WHERE name = $name RETURNING name`,
      )
      .get({ name });
    return deleted === null
      ? Result.err(notFound(`Role "${name}"`))
      : Result.ok({ name: deleted.name });
  }

  seedModels(seeds: readonly ModelConfig[]): void {
    this.tx(() => {
      for (const seed of seeds) {
        const firstSeen = this.db
          .query<{ name: string }, { harness: string; name: string; now: string }>(
            `INSERT OR IGNORE INTO model_seeds (harness, name, first_seen_at)
             VALUES ($harness, $name, $now)
             RETURNING name`,
          )
          .get({ harness: seed.harness, name: seed.name, now: this.now() });
        if (firstSeen === null) continue;
        this.db
          .query<never, {
            harness: string;
            name: string;
            kind: string;
            argvSuffixJson: string;
            now: string;
          }>(
            `INSERT OR IGNORE INTO models
              (harness, name, kind, argv_suffix_json, created_at, updated_at)
             VALUES ($harness, $name, $kind, $argvSuffixJson, $now, $now)`,
          )
          .run({
            harness: seed.harness,
            name: seed.name,
            kind: seed.kind,
            argvSuffixJson: JSON.stringify(seed.argvSuffix),
            now: this.now(),
          });
      }
    });
  }

  listModels(): ModelRecord[] {
    return this.db
      .query<ModelRow, []>(
        `SELECT harness, name, kind, argv_suffix_json, revision
           FROM models
          ORDER BY harness, name`,
      )
      .all()
      .map(toModel);
  }

  model(harness: string, name: string): ModelRecord | null {
    const row = this.db
      .query<ModelRow, { harness: string; name: string }>(
        `SELECT harness, name, kind, argv_suffix_json, revision
           FROM models
          WHERE harness = $harness AND name = $name`,
      )
      .get({ harness, name });
    return row === null ? null : toModel(row);
  }

  createModel(model: Omit<ModelRecord, "revision">): Result<ModelRecord, ModelExists> {
    const now = this.now();
    const row = this.db
      .query<ModelRow, {
        harness: string;
        name: string;
        kind: string;
        argvSuffixJson: string;
        now: string;
      }>(
        `INSERT OR IGNORE INTO models
          (harness, name, kind, argv_suffix_json, created_at, updated_at)
         VALUES ($harness, $name, $kind, $argvSuffixJson, $now, $now)
         RETURNING harness, name, kind, argv_suffix_json, revision`,
      )
      .get({
        harness: model.harness,
        name: model.name,
        kind: model.kind,
        argvSuffixJson: JSON.stringify(model.argvSuffix),
        now,
      });
    return row === null
      ? Result.err(modelExists(model.harness, model.name))
      : Result.ok(toModel(row));
  }

  deleteModel(harness: string, name: string): Result<{ harness: string; name: string }, NotFound> {
    const deleted = this.db
      .query<{ harness: string; name: string }, { harness: string; name: string }>(
        `DELETE FROM models WHERE harness = $harness AND name = $name
         RETURNING harness, name`,
      )
      .get({ harness, name });
    return deleted === null
      ? Result.err(notFound(`Model "${name}" for harness "${harness}"`))
      : Result.ok({ harness: deleted.harness, name: deleted.name });
  }

  /** Removes an agent created by a failed launch when it never acquired a route. */
  removeUnboundAgent(participantId: number): boolean {
    return this.tx(() => {
      const removable = this.db
        .query<{ id: number }, { participantId: number }>(
          `SELECT p.id
             FROM participants p
            WHERE p.id = $participantId
              AND p.kind = 'agent'
              AND p.terminal_id IS NULL
              AND NOT EXISTS (
                    SELECT 1 FROM memberships m WHERE m.participant_id = p.id
              )
              AND NOT EXISTS (
                    SELECT 1 FROM messages msg WHERE msg.sender_id = p.id
              )`,
        )
        .get({ participantId });
      if (removable === null) return false;
      this.db
        .query<never, { participantId: number }>(`DELETE FROM participants WHERE id = $participantId`)
        .run({ participantId });
      return true;
    });
  }

  /** Removes a failed lifecycle identity only when it has no durable history. */
  removeEmptyLifecycleAgent(participantId: number): boolean {
    return this.tx(() => {
      const removable = this.db
        .query<{ id: number }, { participantId: number }>(
          `SELECT p.id
             FROM participants p
            WHERE p.id = $participantId
              AND p.kind = 'agent'
              AND (p.terminal_id IS NULL OR p.route_state = 'stale')
              AND NOT EXISTS (
                    SELECT 1 FROM lifecycle_agents la WHERE la.participant_id = p.id
              )
              AND NOT EXISTS (
                    SELECT 1 FROM memberships m WHERE m.participant_id = p.id
              )
              AND NOT EXISTS (
                    SELECT 1 FROM messages msg WHERE msg.sender_id = p.id
              )`,
        )
        .get({ participantId });
      if (removable === null) return false;
      this.db
        .query<never, { participantId: number }>(`DELETE FROM participants WHERE id = $participantId`)
        .run({ participantId });
      return true;
    });
  }

  lifecycleSpawnOperation(operationKey: string): LifecycleSpawnOperation | null {
    const row = this.db
      .query<LifecycleSpawnOperationRow, { operationKey: string }>(
        `SELECT operation_key, requester_id, workspace_id, harness, launcher,
                launcher_revision, launch_env_json, role,
                requested_handle, assigned_handle, participant_id, pane_id,
                terminal_id, baseline_panes, status, cleanup_outcome, cleanup_error,
                created_at, updated_at
           FROM lifecycle_spawn_operations
          WHERE operation_key = $operationKey`,
      )
      .get({ operationKey });
    return row === null ? null : toLifecycleSpawnOperation(row);
  }

  beginLifecycleSpawnOperation(
    operationKey: string,
    requesterId: number,
    workspaceId: string,
    harness: string,
    launcher: string,
    launcherRevision: number,
    role: string | null,
    requestedHandle: string,
    launchEnv: Readonly<Record<string, string>> = {},
  ): void {
    const now = this.now();
    this.db
      .query<never, {
        operationKey: string;
        requesterId: number;
        workspaceId: string;
        harness: string;
        launcher: string;
        launcherRevision: number;
        launchEnvJson: string;
        role: string | null;
        requestedHandle: string;
        now: string;
      }>(
        `INSERT OR IGNORE INTO lifecycle_spawn_operations
          (operation_key, requester_id, workspace_id, harness, launcher, launcher_revision, launch_env_json,
           role, requested_handle,
           status, created_at, updated_at)
         VALUES ($operationKey, $requesterId, $workspaceId, $harness, $launcher,
                 $launcherRevision, $launchEnvJson, $role,
                 $requestedHandle, 'pending', $now, $now)`,
      )
      .run({
        operationKey,
        requesterId,
        workspaceId,
        harness,
        launcher,
        launcherRevision,
        launchEnvJson: JSON.stringify(launchEnv),
        role,
        requestedHandle,
        now,
      });
  }

  resetLifecycleSpawnOperation(operationKey: string): void {
    this.db
      .query<never, { operationKey: string; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET assigned_handle = NULL,
                participant_id = NULL,
                pane_id = NULL,
                terminal_id = NULL,
                baseline_panes = '[]',
                cleanup_outcome = NULL,
                cleanup_error = NULL,
                status = 'pending',
                updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({ operationKey, now: this.now() });
  }

  createLifecycleParticipant(
    operationKey: string,
  ): Result<CreatedParticipant, HandleTaken | NotFound> {
    const token = mintToken();
    const outcome = this.tx(() => {
      const operation = this.db
        .query<
          { requested_handle: string; participant_id: number | null; status: LifecycleSpawnStatus },
          { operationKey: string }
        >(
          `SELECT requested_handle, participant_id, status
             FROM lifecycle_spawn_operations
            WHERE operation_key = $operationKey`,
        )
        .get({ operationKey });
      if (operation === null) return { kind: "missing" as const };
      if (operation.status !== "pending" || operation.participant_id !== null) {
        return { kind: "missing" as const };
      }

      const assigned = this.nextFreeHandle(operation.requested_handle);
      if (assigned === null) {
        return { kind: "taken" as const, requestedHandle: operation.requested_handle };
      }
      const created = this.db
        .query<ParticipantRow, { handle: string; tokenHash: string; now: string }>(
          `INSERT INTO participants (handle, kind, token_hash, created_at)
           VALUES ($handle, 'agent', $tokenHash, $now)
           RETURNING *`,
        )
        .get({ handle: assigned, tokenHash: hashToken(token), now: this.now() });
      if (created === null) panic("INSERT lifecycle participant RETURNING * produced no row");

      this.db
        .query<never, {
          operationKey: string;
          assignedHandle: string;
          participantId: number;
          now: string;
        }>(
          `UPDATE lifecycle_spawn_operations
              SET assigned_handle = $assignedHandle,
                  participant_id = $participantId,
                  updated_at = $now
            WHERE operation_key = $operationKey`,
        )
        .run({
          operationKey,
          assignedHandle: assigned,
          participantId: created.id,
          now: this.now(),
        });
      return { kind: "created" as const, participant: toParticipant(created) };
    });

    if (outcome.kind === "taken") return Result.err(handleTaken(outcome.requestedHandle));
    if (outcome.kind === "missing") return Result.err(notFound("Lifecycle spawn operation"));
    return Result.ok({ participant: outcome.participant, token });
  }

  recordLifecycleSpawnBaseline(operationKey: string, paneIds: ReadonlySet<string>): void {
    this.db
      .query<never, { operationKey: string; baselinePanes: string; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET baseline_panes = $baselinePanes, updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({
        operationKey,
        baselinePanes: JSON.stringify([...paneIds].sort()),
        now: this.now(),
      });
  }

  recordLifecycleSpawnPane(operationKey: string, paneId: string, terminalId: string): void {
    this.db
      .query<never, { operationKey: string; paneId: string; terminalId: string; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET pane_id = $paneId, terminal_id = $terminalId, updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({ operationKey, paneId, terminalId, now: this.now() });
  }

  failLifecycleSpawn(operationKey: string): void {
    this.db
      .query<never, { operationKey: string; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET status = 'failed', updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({ operationKey, now: this.now() });
  }

  recordLifecycleSpawnCleanup(
    operationKey: string,
    outcome: LifecycleCleanupOutcome,
    error: string | null = null,
  ): void {
    this.db
      .query<never, { operationKey: string; outcome: LifecycleCleanupOutcome; error: string | null; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET cleanup_outcome = $outcome, cleanup_error = $error, updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({ operationKey, outcome, error, now: this.now() });
  }

  completeLifecycleSpawn(operationKey: string): void {
    this.db
      .query<never, { operationKey: string; now: string }>(
        `UPDATE lifecycle_spawn_operations
            SET status = 'committed', updated_at = $now
          WHERE operation_key = $operationKey`,
      )
      .run({ operationKey, now: this.now() });
  }

  registerLifecycleAgent(
    workspaceId: string,
    paneId: string,
    terminalId: string,
    participantId: number,
    role: string | null,
    harness: string,
    launchEnv: Readonly<Record<string, string>> = {},
  ): void {
    this.db
      .query<never, {
        workspaceId: string;
        paneId: string;
        terminalId: string;
        participantId: number;
        role: string | null;
        harness: string;
        launchEnvJson: string;
        createdAt: string;
      }>(
        `INSERT INTO lifecycle_agents
          (pane_id, terminal_id, workspace_id, participant_id, role, harness, launch_env_json, created_at)
         VALUES ($paneId, $terminalId, $workspaceId, $participantId, $role, $harness, $launchEnvJson, $createdAt)
         ON CONFLICT(pane_id) DO UPDATE SET
           terminal_id = excluded.terminal_id,
           workspace_id = excluded.workspace_id,
           participant_id = excluded.participant_id,
           role = excluded.role,
           harness = excluded.harness,
           launch_env_json = excluded.launch_env_json,
           active = 1`,
      )
      .run({
        workspaceId,
        paneId,
        terminalId,
        participantId,
        role,
        harness,
        launchEnvJson: JSON.stringify(launchEnv),
        createdAt: this.now(),
      });
  }

  removeLifecycleAgent(paneId: string, participantId: number): void {
    this.db
      .query<never, { paneId: string; participantId: number }>(
        `DELETE FROM lifecycle_agents
          WHERE pane_id = $paneId AND participant_id = $participantId`,
      )
      .run({ paneId, participantId });
  }

  lifecycleAgents(workspaceId: string): LifecycleAgentRecord[] {
    return this.db
      .query<LifecycleAgentRow, { workspaceId: string }>(
        `SELECT pane_id, terminal_id, workspace_id, participant_id, role, harness, launch_env_json, active, created_at
           FROM lifecycle_agents
          WHERE workspace_id = $workspaceId
          ORDER BY pane_id`,
      )
      .all({ workspaceId })
      .map((row) => ({
        paneId: row.pane_id,
        terminalId: row.terminal_id,
        workspaceId: row.workspace_id,
        participantId: row.participant_id,
        role: row.role,
        harness: row.harness,
        launchEnv: parseStoredEnvironment(row.launch_env_json, "lifecycle agent"),
        active: row.active === 1,
        createdAt: row.created_at,
      }));
  }

  hasActiveLifecycleRole(workspaceId: string, role: string): boolean {
    return (
      this.db
        .query<{ present: number }, { workspaceId: string; role: string }>(
          `SELECT 1 AS present
             FROM lifecycle_agents
            WHERE workspace_id = $workspaceId AND role = $role AND active = 1
            LIMIT 1`,
        )
        .get({ workspaceId, role })?.present ?? 0
    ) === 1;
  }

  activeLifecycleAgentCount(workspaceId: string): number {
    return this.db
      .query<{ count: number }, { workspaceId: string }>(
        `SELECT COUNT(*) AS count
           FROM lifecycle_agents
          WHERE workspace_id = $workspaceId AND active = 1`,
      )
      .get({ workspaceId })?.count ?? 0;
  }

  deactivateLifecycleAgent(paneId: string): void {
    this.db
      .query<never, { paneId: string }>(
        `UPDATE lifecycle_agents SET active = 0 WHERE pane_id = $paneId`,
      )
      .run({ paneId });
  }

  lifecycleAgentForPane(paneId: string): LifecycleAgentRecord | null {
    const row = this.db
      .query<LifecycleAgentRow, { paneId: string }>(
        `SELECT pane_id, terminal_id, workspace_id, participant_id, role, harness, launch_env_json, active, created_at
           FROM lifecycle_agents
          WHERE pane_id = $paneId`,
      )
      .get({ paneId });
    return row === null
      ? null
      : {
          paneId: row.pane_id,
          terminalId: row.terminal_id,
          workspaceId: row.workspace_id,
          participantId: row.participant_id,
          role: row.role,
          harness: row.harness,
          launchEnv: parseStoredEnvironment(row.launch_env_json, "lifecycle agent"),
          active: row.active === 1,
        createdAt: row.created_at,
      };
  }

  lifecycleAgentForTerminal(terminalId: string): LifecycleAgentRecord | null {
    const row = this.db
      .query<LifecycleAgentRow, { terminalId: string }>(
        `SELECT pane_id, terminal_id, workspace_id, participant_id, role, harness, launch_env_json, active, created_at
           FROM lifecycle_agents
          WHERE terminal_id = $terminalId AND active = 1
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get({ terminalId });
    return row === null
      ? null
      : {
          paneId: row.pane_id,
          terminalId: row.terminal_id,
          workspaceId: row.workspace_id,
          participantId: row.participant_id,
          role: row.role,
          harness: row.harness,
          launchEnv: parseStoredEnvironment(row.launch_env_json, "lifecycle agent"),
          active: row.active === 1,
          createdAt: row.created_at,
        };
  }

  lifecycleAgentForParticipant(participantId: number): LifecycleAgentRecord | null {
    const row = this.db
      .query<LifecycleAgentRow, { participantId: number }>(
        `SELECT pane_id, terminal_id, workspace_id, participant_id, role, harness, launch_env_json, active, created_at
           FROM lifecycle_agents
          WHERE participant_id = $participantId AND active = 1
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get({ participantId });
    return row === null
      ? null
      : {
          paneId: row.pane_id,
          terminalId: row.terminal_id,
          workspaceId: row.workspace_id,
          participantId: row.participant_id,
          role: row.role,
          harness: row.harness,
          launchEnv: parseStoredEnvironment(row.launch_env_json, "lifecycle agent"),
          active: row.active === 1,
          createdAt: row.created_at,
        };
  }

  ensureWorkspaceMembers(
    channelName: string,
    participantIds: readonly number[],
  ): Result<WorkspaceMembershipChange, ChannelExists | NotFound> {
    return this.tx(() => {
      let channel = this.channelRow(channelName);
      if (channel !== null && channel.kind !== "workspace") {
        return Result.err(channelExists(channelName));
      }

      const uniqueParticipantIds = [...new Set(participantIds)];
      for (const participantId of uniqueParticipantIds) {
        const exists = this.db
          .query<{ id: number }, { participantId: number }>(
            `SELECT id FROM participants WHERE id = $participantId AND deactivated = 0`,
          )
          .get({ participantId });
        if (exists === null) return Result.err(notFound("Participant"));
      }

      let created = false;
      if (channel === null) {
        channel = this.db
          .query<ChannelRow, { name: string; now: string }>(
            `INSERT INTO channels (name, topic, kind, created_at)
             VALUES ($name, NULL, 'workspace', $now)
             RETURNING *`,
          )
          .get({ name: channelName, now: this.now() });
        if (channel === null) panic("INSERT reporter workspace channel RETURNING * produced no row");
        created = true;
      }

      const addedParticipantIds: number[] = [];
      const highWater = this.highWaterMark(channel.id);
      for (const participantId of uniqueParticipantIds) {
        const member = this.db
          .query<{ one: number }, { channelId: number; participantId: number }>(
            `SELECT 1 AS one FROM memberships
              WHERE channel_id = $channelId AND participant_id = $participantId`,
          )
          .get({ channelId: channel.id, participantId });
        if (member !== null) continue;
        this.db
          .query<never, { channelId: number; participantId: number; cursorId: number; now: string }>(
            `INSERT INTO memberships (channel_id, participant_id, cursor_id, notified_id, joined_at)
             VALUES ($channelId, $participantId, $cursorId, $cursorId, $now)`,
          )
          .run({
            channelId: channel.id,
            participantId,
            cursorId: highWater,
            now: this.now(),
          });
        addedParticipantIds.push(participantId);
      }

      return Result.ok({ channel: channel.name, created, addedParticipantIds });
    });
  }

  rollbackWorkspaceMembers(
    channelName: string,
    participantIds: readonly number[],
    deleteIfEmpty: boolean,
  ): void {
    this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null || channel.kind !== "workspace") return;
      for (const participantId of new Set(participantIds)) {
        this.db
          .query<never, { channelId: number; participantId: number }>(
            `DELETE FROM memberships
              WHERE channel_id = $channelId AND participant_id = $participantId`,
          )
          .run({ channelId: channel.id, participantId });
      }
      if (!deleteIfEmpty) return;
      const hasMessages = this.db
        .query<{ one: number }, { channelId: number }>(
          `SELECT 1 AS one FROM messages WHERE channel_id = $channelId LIMIT 1`,
        )
        .get({ channelId: channel.id });
      const hasMembers = this.db
        .query<{ one: number }, { channelId: number }>(
          `SELECT 1 AS one FROM memberships WHERE channel_id = $channelId LIMIT 1`,
        )
        .get({ channelId: channel.id });
      if (hasMessages === null && hasMembers === null) {
        this.db
          .query<never, { channelId: number }>(`DELETE FROM channels WHERE id = $channelId`)
          .run({ channelId: channel.id });
      }
    });
  }

  // -------------------------------------------------------------------- channels

  createChannel(name: string, topic: string | null): Result<Channel, ChannelExists> {
    const created = this.tx((): ChannelRow | null => {
      const taken = this.db
        .query<{ id: number }, { name: string }>(`SELECT id FROM channels WHERE name = $name`)
        .get({ name });
      if (taken !== null) return null;

      return this.db
        .query<ChannelRow, { name: string; topic: string | null; now: string }>(
          `INSERT INTO channels (name, topic, kind, created_at)
           VALUES ($name, $topic, 'chat', $now)
           RETURNING *`,
        )
        .get({ name, topic, now: this.now() });
    });

    if (created === null) return Result.err(channelExists(name));
    return Result.ok({
      id: created.id,
      name: created.name,
      kind: created.kind,
      topic: created.topic,
      memberCount: 0,
      messageCount: 0,
      lastMessageAt: null,
    });
  }

  findChannel(name: string): Channel | null {
    const row = this.db
      .query<ChannelSummaryRow, { name: string }>(
        `${CHANNEL_SUMMARY_SELECT} WHERE c.name = $name`,
      )
      .get({ name });
    return row === null ? null : toChannel(row);
  }

  listChannels(kind: "chat" | "workspace" = "chat"): Channel[] {
    return this.db
      .query<ChannelSummaryRow, { kind: "chat" | "workspace" }>(
        `${CHANNEL_SUMMARY_SELECT} WHERE c.kind = $kind ORDER BY c.name`,
      )
      .all({ kind })
      .map(toChannel);
  }

  deleteChannel(
    name: string,
    confirmation: string,
  ): Result<{ name: string }, ChannelNotFound | ChannelNotDeletable | ValidationFailed> {
    return this.tx(() => {
      const channel = this.channelRow(name);
      if (channel === null) return Result.err(channelNotFound(name));
      if (channel.kind === "workspace") return Result.err(channelNotDeletable(channel.name, channel.kind));
      if (confirmation !== channel.name) return Result.err(validationFailed("confirm", "does not match the channel name"));

      this.db
        .query<never, { channelId: number }>(
          `DELETE FROM attachments
            WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $channelId)`,
        )
        .run({ channelId: channel.id });
      this.db
        .query<never, { channelId: number }>(`DELETE FROM messages WHERE channel_id = $channelId`)
        .run({ channelId: channel.id });
      this.db
        .query<never, { channelId: number }>(`DELETE FROM memberships WHERE channel_id = $channelId`)
        .run({ channelId: channel.id });
      const deleted = this.db
        .query<{ name: string }, { channelId: number }>(
          `DELETE FROM channels WHERE id = $channelId RETURNING name`,
        )
        .get({ channelId: channel.id });
      if (deleted === null) panic("DELETE channel RETURNING name produced no row");
      return Result.ok({ name: deleted.name });
    });
  }

  /** Returns any active identity on a terminal, including a human identity. */
  participantRouteForTerminal(terminalId: string): Participant | null {
    const row = this.db
      .query<ParticipantRow, { terminalId: string }>(
        `SELECT * FROM participants
          WHERE terminal_id = $terminalId AND deactivated = 0
          ORDER BY CASE route_state WHEN 'active' THEN 0 ELSE 1 END,
                   last_seen_at DESC,
                   id DESC
          LIMIT 1`,
      )
      .get({ terminalId });
    return row === null ? null : toParticipant(row);
  }

  /** Returns the active route, or a matching stale route when no active route remains. */
  agentRouteForTerminal(
    terminalId: string,
  ): { id: number; handle: string; routeState: RouteState } | null {
    const row = this.db
      .query<{ id: number; handle: string; route_state: RouteState }, { terminalId: string }>(
        `SELECT id, handle, route_state
           FROM participants
          WHERE kind = 'agent' AND terminal_id = $terminalId AND deactivated = 0
          ORDER BY CASE route_state WHEN 'active' THEN 0 ELSE 1 END,
                   last_seen_at DESC,
                   id DESC
          LIMIT 1`,
      )
      .get({ terminalId });
    return row === null
      ? null
      : { id: row.id, handle: row.handle, routeState: row.route_state };
  }

  // ----------------------------------------------------------------- memberships

  /**
   * Idempotent. A new membership starts at the channel's current high-water
   * mark in the same transaction, so history stays browsable without counting
   * as unread. Re-joining never rewinds an existing cursor.
   */
  join(
    participantId: number,
    channelName: string,
  ): Result<JoinResult, ChannelNotFound | DirectMembershipLocked> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));

      const existing = this.db
        .query<{ cursor_id: number }, { channelId: number; participantId: number }>(
          `SELECT cursor_id FROM memberships
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .get({ channelId: channel.id, participantId });

      if (existing !== null) {
        return Result.ok({ channel: channel.name, cursorId: existing.cursor_id });
      }

      if (channel.kind === "direct") {
        return Result.err(directMembershipLocked(channel.name));
      }

      const highWater = this.highWaterMark(channel.id);
      this.db
        .query<never, { channelId: number; participantId: number; cursorId: number; now: string }>(
          `INSERT INTO memberships (channel_id, participant_id, cursor_id, notified_id, joined_at)
           VALUES ($channelId, $participantId, $cursorId, $cursorId, $now)`,
        )
        .run({ channelId: channel.id, participantId, cursorId: highWater, now: this.now() });

      return Result.ok({ channel: channel.name, cursorId: highWater });
    });
  }

  /** Adds a named participant and captures the channel high-water mark atomically. */
  addMember(
    channelName: string,
    handle: string,
  ): Result<AddedMember, ChannelNotFound | DirectMembershipLocked | NotFound | MembershipExists> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));
      if (channel.kind === "direct") return Result.err(directMembershipLocked(channel.name));

      const participant = this.db
        .query<{ id: number }, { handle: string }>(
          `SELECT id FROM participants WHERE handle = $handle AND deactivated = 0`,
        )
        .get({ handle });
      if (participant === null) return Result.err(notFound(`Participant "${handle}"`));

      const existing = this.db
        .query<{ one: number }, { channelId: number; participantId: number }>(
          `SELECT 1 AS one FROM memberships
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .get({ channelId: channel.id, participantId: participant.id });
      if (existing !== null) return Result.err(membershipExists(channel.name, handle));

      const highWater = this.highWaterMark(channel.id);
      this.db
        .query<never, { channelId: number; participantId: number; cursorId: number; now: string }>(
          `INSERT INTO memberships (channel_id, participant_id, cursor_id, notified_id, joined_at)
           VALUES ($channelId, $participantId, $cursorId, $cursorId, $now)`,
        )
        .run({ channelId: channel.id, participantId: participant.id, cursorId: highWater, now: this.now() });

      return Result.ok({ channel: channel.name, handle, cursorId: highWater });
    });
  }

  /**
   * Removes any participant's membership. This is intentionally not restricted
   * to self-removal: the v0 local trust model allows any authenticated identity
   * to manage channel membership.
   */
  removeMember(
    channelName: string,
    handle: string,
  ): Result<RemovedMember, ChannelNotFound | DirectMembershipLocked | NotFound> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));
      if (channel.kind === "direct") return Result.err(directMembershipLocked(channel.name));

      const participant = this.db
        .query<{ id: number }, { handle: string }>(
          `SELECT id FROM participants WHERE handle = $handle`,
        )
        .get({ handle });
      if (participant === null) return Result.err(notFound(`Participant "${handle}"`));

      this.db
        .query<never, { channelId: number; participantId: number }>(
          `DELETE FROM memberships
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .run({ channelId: channel.id, participantId: participant.id });

      return Result.ok({ channel: channel.name, handle });
    });
  }

  isMember(participantId: number, channelId: number): boolean {
    const row = this.db
      .query<{ one: number }, { channelId: number; participantId: number }>(
        `SELECT 1 AS one FROM memberships
          WHERE channel_id = $channelId AND participant_id = $participantId`,
      )
      .get({ channelId, participantId });
    return row !== null;
  }

  /** Checks current membership by the channel name used on the HTTP surface. */
  isMemberOfChannel(participantId: number, channelName: string): boolean {
    const channel = this.channelRow(channelName);
    return channel !== null && this.isMember(participantId, channel.id);
  }

  listMembers(channelName: string): Result<Member[], ChannelNotFound> {
    const channel = this.channelRow(channelName);
    if (channel === null) return Result.err(channelNotFound(channelName));

    const rows = this.db
      .query<MemberRow, { channelId: number }>(
        `SELECT p.handle         AS handle,
                p.kind           AS kind,
                p.occupant_agent AS agent_kind,
                p.route_state    AS route_state,
                mem.joined_at    AS joined_at,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.channel_id = mem.channel_id
                    AND m.id > mem.cursor_id
                    AND m.sender_id != mem.participant_id) AS unread
           FROM memberships mem
           JOIN participants p ON p.id = mem.participant_id
          WHERE mem.channel_id = $channelId AND p.deactivated = 0
          ORDER BY p.handle`,
      )
      .all({ channelId: channel.id });

    return Result.ok(
      rows.map((row) => ({
        handle: row.handle,
        kind: row.kind,
        agentKind: row.agent_kind,
        routeState: row.route_state,
        unread: row.unread,
        joinedAt: row.joined_at,
      })),
    );
  }

  /** Returns member watermarks without moving the caller's cursor. */
  receipts(
    participantId: number,
    channelName: string,
  ): Result<ChannelReceipt[], ChannelNotFound | NotAMember> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));
      if (!this.isMember(participantId, channel.id)) {
        return Result.err(notAMember(channelName, participantId));
      }

      const rows = this.db
        .query<ChannelReceiptRow, { channelId: number }>(
          `SELECT p.handle AS handle,
                  mem.cursor_id AS cursor_message_id,
                  p.route_state AS route_state
             FROM memberships mem
             JOIN participants p ON p.id = mem.participant_id
            WHERE mem.channel_id = $channelId
              AND p.deactivated = 0
            ORDER BY p.handle`,
        )
        .all({ channelId: channel.id });

      return Result.ok(
        rows.map((row) => ({
          handle: row.handle,
          cursorMessageId: row.cursor_message_id,
          routeState: row.route_state,
        })),
      );
    });
  }

  listDirect(participantId: number): DirectConversation[] {
    const rows = this.db
      .query<DirectConversationRow, { participantId: number }>(
        `SELECT c.name AS channel,
                GROUP_CONCAT(DISTINCT other.handle) AS participants,
                COUNT(DISTINCT CASE
                  WHEN m.id > own.cursor_id AND m.sender_id != own.participant_id THEN m.id
                END) AS unread,
                MAX(m.created_at) AS last_message_at
           FROM memberships own
           JOIN channels c
             ON c.id = own.channel_id
            AND c.kind = 'direct'
           JOIN memberships other_mem
             ON other_mem.channel_id = own.channel_id
            AND other_mem.participant_id != own.participant_id
           JOIN participants other ON other.id = other_mem.participant_id
           LEFT JOIN messages m ON m.channel_id = own.channel_id
          WHERE own.participant_id = $participantId
          GROUP BY c.id, own.cursor_id
          ORDER BY c.name`,
      )
      .all({ participantId });

    return rows.map((row) => ({
      channel: row.channel,
      participants: splitHandles(row.participants),
      unread: row.unread,
      lastMessageAt: row.last_message_at,
    }));
  }

  /** Every channel the participant belongs to, with THAT PARTICIPANT'S unread. */
  agentChannels(participantId: number): AgentChannelMembership[] {
    return this.db
      .query<{ channel: string; unread: number }, { participantId: number }>(
        `SELECT c.name AS channel,
                COUNT(CASE
                  WHEN m.id > own.cursor_id AND m.sender_id != own.participant_id THEN m.id
                END) AS unread
           FROM memberships own
           JOIN channels c ON c.id = own.channel_id
           LEFT JOIN messages m ON m.channel_id = own.channel_id
          WHERE own.participant_id = $participantId
          GROUP BY c.id, own.cursor_id
          ORDER BY c.name`,
      )
      .all({ participantId });
  }

  // -------------------------------------------------------------------- messages

  /** Chat membership is not required to post; direct membership is fixed. */
  send(
    senderId: number,
    channelName: string,
    body: string,
    attachments: readonly AttachmentInput[] = [],
  ): Result<Message, ChannelNotFound | DirectMembershipLocked | NotFound> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));

      if (channel.kind === "direct" && !this.isMember(senderId, channel.id)) {
        return Result.err(directMembershipLocked(channel.name));
      }
      if (channel.kind === "direct") {
        const deactivated = this.db
          .query<{ handle: string }, { channelId: number }>(
            `SELECT p.handle AS handle
               FROM memberships mem
               JOIN participants p ON p.id = mem.participant_id
              WHERE mem.channel_id = $channelId AND p.deactivated = 1
              ORDER BY p.handle
              LIMIT 1`,
          )
          .get({ channelId: channel.id });
        if (deactivated !== null) {
          return Result.err(notFound(`Participant "${deactivated.handle}"`));
        }
      }

      return Result.ok(this.insertMessage(channel.id, senderId, body, attachments));
    });
  }

  sendDirect(
    senderId: number,
    recipientHandles: readonly string[],
    body: string,
    attachments: readonly AttachmentInput[] = [],
  ): Result<Message, NotFound | ChannelExists> {
    return this.tx(() => {
      const sender = this.db
        .query<{ id: number }, { participantId: number }>(
          `SELECT id FROM participants WHERE id = $participantId AND deactivated = 0`,
        )
        .get({ participantId: senderId });
      if (sender === null) return Result.err(notFound(`Participant "${senderId}"`));

      const recipientIds = new Set<number>();
      for (const handle of new Set(recipientHandles)) {
        const recipient = this.db
          .query<{ id: number }, { handle: string }>(
            `SELECT id FROM participants WHERE handle = $handle AND deactivated = 0`,
          )
          .get({ handle });
        if (recipient === null) return Result.err(notFound(`Participant "${handle}"`));
        recipientIds.add(recipient.id);
      }

      const participantIds = [...new Set([senderId, ...recipientIds])].sort((a, b) => a - b);
      const channelName = directChannelName(participantIds);
      let channel = this.channelRow(channelName);

      if (channel !== null && channel.kind !== "direct") {
        return Result.err(channelExists(channelName));
      }

      if (channel === null) {
        channel = this.db
          .query<ChannelRow, { name: string; now: string }>(
            `INSERT INTO channels (name, topic, kind, created_at)
             VALUES ($name, NULL, 'direct', $now)
             RETURNING *`,
          )
          .get({ name: channelName, now: this.now() });
        if (channel === null) panic("INSERT direct channel RETURNING * produced no row");

        for (const participantId of participantIds) {
          this.db
            .query<never, { channelId: number; participantId: number; now: string }>(
              `INSERT INTO memberships (channel_id, participant_id, joined_at)
               VALUES ($channelId, $participantId, $now)`,
            )
            .run({ channelId: channel.id, participantId, now: this.now() });
        }
      }

      return Result.ok(this.insertMessage(channel.id, senderId, body, attachments));
    });
  }

  /**
   * Creates or reuses a workspace channel, joins every currently routed
   * recipient before inserting, and returns one transactionally consistent send.
   */
  broadcastWorkspace(
    senderId: number,
    channelName: string,
    recipientHandles: readonly string[],
    body: string,
    attachments: readonly AttachmentInput[] = [],
  ): Result<WorkspaceBroadcastResult, ChannelExists> {
    return this.tx(() => {
      let channel = this.channelRow(channelName);
      if (channel !== null && channel.kind !== "workspace") {
        return Result.err(channelExists(channelName));
      }

      if (channel === null) {
        channel = this.db
          .query<ChannelRow, { name: string; now: string }>(
            `INSERT INTO channels (name, topic, kind, created_at)
             VALUES ($name, NULL, 'workspace', $now)
             RETURNING *`,
          )
          .get({ name: channelName, now: this.now() });
        if (channel === null) panic("INSERT workspace channel RETURNING * produced no row");
      }

      const recipients: string[] = [];
      const uniqueHandles = [...new Set(recipientHandles)];
      const previousHighWater = this.highWaterMark(channel.id);
      for (const handle of uniqueHandles) {
        const participant = this.db
          .query<
            { id: number; handle: string },
            { handle: string }
          >(
            `SELECT id, handle FROM participants
               WHERE handle = $handle
                 AND kind = 'agent'
                 AND deactivated = 0
                 AND route_state = 'active'
                 AND terminal_id IS NOT NULL`,
          )
          .get({ handle });
        if (participant === null) continue;

        if (!this.isMember(participant.id, channel.id)) {
          this.db
            .query<never, { channelId: number; participantId: number; cursorId: number; now: string }>(
              `INSERT INTO memberships (channel_id, participant_id, cursor_id, notified_id, joined_at)
               VALUES ($channelId, $participantId, $cursorId, $cursorId, $now)`,
            )
            .run({
              channelId: channel.id,
              participantId: participant.id,
              cursorId: previousHighWater,
              now: this.now(),
            });
        }
        recipients.push(participant.handle);
      }

      return Result.ok({
        message: this.insertMessage(channel.id, senderId, body, attachments),
        recipients,
      });
    });
  }

  private insertMessage(
    channelId: number,
    senderId: number,
    body: string,
    attachments: readonly AttachmentInput[],
  ): Message {
    // This read and the insert run in the caller's transaction. The cursor
    // therefore cannot miss another message committed between the two steps.
    const previousHighWater = this.highWaterMark(channelId);
    const senderMembership = this.db
      .query<{ cursor_id: number }, { channelId: number; participantId: number }>(
        `SELECT cursor_id FROM memberships
          WHERE channel_id = $channelId AND participant_id = $participantId`,
      )
      .get({ channelId, participantId: senderId });

    const inserted = this.db
      .query<{ id: number }, { channelId: number; senderId: number; body: string; now: string }>(
        `INSERT INTO messages (channel_id, sender_id, body, created_at)
         VALUES ($channelId, $senderId, $body, $now)
         RETURNING id`,
      )
      .get({ channelId, senderId, body, now: this.now() });

    if (inserted === null) panic("INSERT ... RETURNING id produced no row");

    // A missing membership row is not a cursor at zero. On an empty channel
    // there is still no row to advance; on a non-empty channel it cannot pass
    // the caught-up check. Normal members have a row because join initializes
    // it at the channel high-water mark.
    if (senderMembership !== null && senderMembership.cursor_id === previousHighWater) {
      this.db
        .query<never, { participantId: number; channelId: number; messageId: number }>(
          `UPDATE memberships
              SET cursor_id = $messageId,
                  notified_id = $messageId
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .run({ participantId: senderId, channelId, messageId: inserted.id });
    }

    for (const attachment of attachments) {
      this.db
        .query<never, AttachmentInput & { messageId: number }>(
          `INSERT INTO attachments
             (message_id, path, display_name, byte_size, media_type, mtime, sha256)
           VALUES ($messageId, $path, $displayName, $byteSize, $mediaType, $mtime, $sha256)`,
        )
        .run({ ...attachment, messageId: inserted.id });
    }

    const message = this.messageById(inserted.id);
    if (message === null) panic("message vanished within its own transaction");
    return message;
  }

  messageById(id: number): Message | null {
    const row = this.db
      .query<MessageRow, { id: number }>(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE} WHERE m.id = $id`,
      )
      .get({ id });
    if (row === null) return null;
    return this.withAttachments([row])[0] ?? null;
  }

  /** Newest `limit` messages, optionally older than `before`, returned ascending. */
  history(
    channelName: string,
    limit: number,
    before: number | null,
  ): Result<Message[], ChannelNotFound> {
    const channel = this.channelRow(channelName);
    if (channel === null) return Result.err(channelNotFound(channelName));

    const rows = this.db
      .query<MessageRow, { channelId: number; before: number; limit: number }>(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE}
          WHERE m.channel_id = $channelId AND ($before = 0 OR m.id < $before)
          ORDER BY m.id DESC
          LIMIT $limit`,
      )
      .all({ channelId: channel.id, before: before ?? 0, limit });

    return Result.ok(this.withAttachments(rows.reverse()));
  }

  /** A window of `span` messages either side of `around`, returned ascending. */
  context(channelName: string, around: number, span: number): Result<Message[], ChannelNotFound> {
    const channel = this.channelRow(channelName);
    if (channel === null) return Result.err(channelNotFound(channelName));

    const before = this.db
      .query<MessageRow, { channelId: number; around: number; span: number }>(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE}
          WHERE m.channel_id = $channelId AND m.id <= $around
          ORDER BY m.id DESC
          LIMIT $span`,
      )
      .all({ channelId: channel.id, around, span: span + 1 });

    const after = this.db
      .query<MessageRow, { channelId: number; around: number; span: number }>(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE}
          WHERE m.channel_id = $channelId AND m.id > $around
          ORDER BY m.id ASC
          LIMIT $span`,
      )
      .all({ channelId: channel.id, around, span });

    return Result.ok(this.withAttachments([...before.reverse(), ...after]));
  }

  /** Every stored message with an id above `afterId`, for SSE `Last-Event-ID` replay. */
  replayAfter(afterId: number, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, { afterId: number; limit: number }>(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE}
          WHERE m.id > $afterId
          ORDER BY m.id ASC
          LIMIT $limit`,
      )
      .all({ afterId, limit });
    return this.withAttachments(rows);
  }

  // --------------------------------------------------------------------- cursors

  /**
   * Returns unread messages without moving any cursor, so a lost response is
   * safe to retry. `throughId` covers exactly the messages returned; it stays at
   * the current cursor when there are none.
   */
  fetch(
    participantId: number,
    channelName: string,
  ): Result<FetchResult, ChannelNotFound | NotAMember> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));

      const membership = this.db
        .query<{ cursor_id: number }, { channelId: number; participantId: number }>(
          `SELECT cursor_id FROM memberships
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .get({ channelId: channel.id, participantId });
      if (membership === null) return Result.err(notAMember(channelName, participantId));

      const rows = this.db
        .query<MessageRow, { channelId: number; cursorId: number; participantId: number }>(
          `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_SOURCE}
            WHERE m.channel_id = $channelId
              AND m.id > $cursorId
              AND m.sender_id != $participantId
            ORDER BY m.id ASC`,
        )
        .all({ channelId: channel.id, cursorId: membership.cursor_id, participantId });

      const messages = this.withAttachments(rows);
      const last = messages[messages.length - 1];
      return Result.ok({
        messages,
        throughId: last === undefined ? membership.cursor_id : last.id,
      });
    });
  }

  /** Monotonic: neither cursor ever moves backwards. */
  ack(
    participantId: number,
    channelName: string,
    throughId: number,
  ): Result<AckResult, ChannelNotFound | NotAMember | ValidationFailed> {
    return this.tx(() => {
      const channel = this.channelRow(channelName);
      if (channel === null) return Result.err(channelNotFound(channelName));
      if (!this.isMember(participantId, channel.id)) {
        return Result.err(notAMember(channelName, participantId));
      }

      if (!Number.isInteger(throughId) || throughId < 0) {
        return Result.err(validationFailed("throughId", "must be 0 or a message in this channel"));
      }
      if (throughId > 0) {
        const message = this.db
          .query<{ one: number }, { channelId: number; messageId: number }>(
            `SELECT 1 AS one FROM messages
              WHERE channel_id = $channelId AND id = $messageId`,
          )
          .get({ channelId: channel.id, messageId: throughId });
        if (message === null) {
          return Result.err(
            validationFailed("throughId", "must be 0 or a message in this channel"),
          );
        }
      }

      const before = this.db
        .query<{ cursor_id: number }, { channelId: number; participantId: number }>(
          `SELECT cursor_id FROM memberships
            WHERE channel_id = $channelId AND participant_id = $participantId`,
        )
        .get({ channelId: channel.id, participantId });
      if (before === null) panic("membership vanished within its own transaction");

      const updated = this.db
        .query<
          { cursor_id: number },
          { channelId: number; participantId: number; throughId: number }
        >(
          `UPDATE memberships
              SET cursor_id   = MAX(cursor_id, $throughId),
                  notified_id = MAX(notified_id, $throughId)
            WHERE channel_id = $channelId AND participant_id = $participantId
            RETURNING cursor_id`,
        )
        .get({ channelId: channel.id, participantId, throughId });

      if (updated === null) panic("membership vanished within its own transaction");
      return Result.ok({
        cursorId: updated.cursor_id,
        advanced: updated.cursor_id > before.cursor_id,
      });
    });
  }

  /**
   * `pushEnabled` reports route readiness only. The server ANDs it with whether
   * push is available at all for this hub.
   */
  inbox(participantId: number): InboxEntry[] {
    const rows = this.db
      .query<InboxRow, { participantId: number }>(
        `SELECT c.name                        AS channel,
                COUNT(m.id)                   AS unread,
                GROUP_CONCAT(DISTINCT s.handle) AS senders,
                p.kind                        AS kind,
                p.route_state                 AS route_state,
                p.terminal_id                 AS terminal_id
           FROM memberships mem
           JOIN channels c     ON c.id = mem.channel_id
           JOIN participants p ON p.id = mem.participant_id
           LEFT JOIN messages m
                  ON m.channel_id = mem.channel_id
                 AND m.id > mem.cursor_id
                 AND m.sender_id != mem.participant_id
                 AND EXISTS (
                   SELECT 1
                     FROM participants sender
                    WHERE sender.id = m.sender_id AND sender.deactivated = 0
                 )
           LEFT JOIN participants s ON s.id = m.sender_id AND s.deactivated = 0
          WHERE mem.participant_id = $participantId
          GROUP BY c.id
          ORDER BY c.name`,
      )
      .all({ participantId });

    return rows.map((row) => ({
      channel: row.channel,
      unread: row.unread,
      senders: splitHandles(row.senders),
      routeState: row.route_state,
      pushEnabled: row.kind === "agent" && row.terminal_id !== null && row.route_state === "active",
    }));
  }

  // -------------------------------------------------------------------- notifier

  /**
   * One row per (agent, channel) with messages past `MAX(cursor_id,
   * notified_id)`. `throughId` is the snapshot the notifier pins its ping to.
   */
  private pendingNotificationsForRouteState(
    channelName: string | null,
    routeState: RouteState,
  ): PendingNotification[] {
    const rows = this.db
      .query<PendingRow, { channelName: string | null; routeState: RouteState }>(
        `SELECT p.id             AS participant_id,
                p.handle         AS handle,
                p.terminal_id    AS terminal_id,
                p.pane_id        AS pane_id,
                p.occupant_agent AS occupant_agent,
                c.id             AS channel_id,
                c.name           AS channel,
                MAX(m.id)        AS through_id,
                COUNT(m.id)      AS count,
                GROUP_CONCAT(DISTINCT s.handle) AS senders
           FROM memberships mem
           JOIN participants p ON p.id = mem.participant_id
           JOIN channels c     ON c.id = mem.channel_id
           JOIN messages m
                  ON m.channel_id = mem.channel_id
                 AND m.id > MAX(mem.cursor_id, mem.notified_id)
                 AND m.sender_id != mem.participant_id
           JOIN participants s ON s.id = m.sender_id AND s.deactivated = 0
          WHERE p.kind = 'agent'
            AND p.deactivated = 0
            AND p.terminal_id IS NOT NULL
            AND p.pane_id IS NOT NULL
            AND p.route_state = $routeState
            AND ($channelName IS NULL OR c.name = $channelName)
          GROUP BY p.id, c.id
          ORDER BY p.handle, c.name`,
      )
      .all({ channelName, routeState });

    return rows.map((row) => ({
      participantId: row.participant_id,
      handle: row.handle,
      terminalId: row.terminal_id,
      paneId: row.pane_id,
      occupantAgent: row.occupant_agent,
      channelId: row.channel_id,
      channel: row.channel,
      throughId: row.through_id,
      count: row.count,
      senders: splitHandles(row.senders),
    }));
  }

  pendingNotifications(channelName: string | null = null): PendingNotification[] {
    return this.pendingNotificationsForRouteState(channelName, "active");
  }

  /** Pending pings held for agents whose route has been marked stale. */
  stalePendingNotifications(channelName: string | null = null): PendingNotification[] {
    return this.pendingNotificationsForRouteState(channelName, "stale");
  }

  /** Called only after a ping is reported delivered. Monotonic. */
  markNotified(participantId: number, channelId: number, throughId: number): void {
    this.db
      .query<never, { participantId: number; channelId: number; throughId: number }>(
        `UPDATE memberships
            SET notified_id = MAX(notified_id, $throughId)
          WHERE channel_id = $channelId AND participant_id = $participantId`,
      )
      .run({ participantId, channelId, throughId });
  }

  /** Removes an unconfirmed ping from the pending watermark without rewinding a read. */
  rollbackNotifiedToCursor(participantId: number, channelId: number): void {
    this.db
      .query<never, { participantId: number; channelId: number }>(
        `UPDATE memberships
            SET notified_id = MIN(notified_id, cursor_id)
          WHERE channel_id = $channelId AND participant_id = $participantId`,
      )
      .run({ participantId, channelId });
  }

  /** The cursor as it stands now, for the notifier's pre-injection recheck. */
  cursorFor(participantId: number, channelId: number): number | null {
    const row = this.db
      .query<{ cursor_id: number }, { participantId: number; channelId: number }>(
        `SELECT cursor_id FROM memberships
          WHERE channel_id = $channelId AND participant_id = $participantId`,
      )
      .get({ participantId, channelId });
    return row === null ? null : row.cursor_id;
  }

  // ---------------------------------------------------------------------- search

  /**
   * `expression` must already be a valid FTS5 query. Escaping user input into
   * one is the caller's job, so this layer never interprets raw search text.
   */
  search(
    expression: string,
    channelName: string | null,
    sender: string | null,
    limit: number,
    channelKind: ChannelKind | null = null,
  ): SearchResult[] {
    return this.db
      .query<
        {
          message_id: number;
          channel: string;
          sender: string;
          snippet: string;
          created_at: string;
          attachment_count: number;
        },
        { expression: string; channel: string | null; sender: string | null; kind: ChannelKind | null; limit: number }
      >(
        `SELECT m.id         AS message_id,
                c.name       AS channel,
                p.handle     AS sender,
                snippet(messages_fts, 0, '', '', '…', 12) AS snippet,
                m.created_at AS created_at,
                (SELECT COUNT(*)
                   FROM attachments a
                  WHERE a.message_id = m.id) AS attachment_count
           FROM messages_fts
           JOIN messages m     ON m.id = messages_fts.rowid
           JOIN channels c     ON c.id = m.channel_id
           JOIN participants p ON p.id = m.sender_id
          WHERE messages_fts MATCH $expression
            AND ($channel IS NULL OR c.name = $channel)
            AND ($kind IS NULL OR c.kind = $kind)
            AND ($sender IS NULL OR p.handle = $sender)
          ORDER BY rank, m.id DESC
          LIMIT $limit`,
      )
      .all({ expression, channel: channelName, kind: channelKind, sender, limit })
      .map((row) => ({
        messageId: row.message_id,
        channel: row.channel,
        sender: row.sender,
        snippet: row.snippet,
        createdAt: row.created_at,
        attachmentCount: Number(row.attachment_count),
      }));
  }

  // ----------------------------------------------------------------- attachments

  /**
   * Newest-first attachment metadata across channels. The extra row beyond
   * `limit` lets the caller report truncation exactly rather than by a
   * length-based floor.
   */
  listAttachments(
    channelName: string | null,
    kind: "image" | "markdown" | "other" | null,
    limit: number,
  ): AttachmentListing {
    const rows = this.db
      .query<
        AttachmentRow & { channel: string; sender: string; created_at: string },
        { channel: string | null }
      >(
        `SELECT a.*, c.name AS channel, p.handle AS sender, m.created_at AS created_at
           FROM attachments a
           JOIN messages m     ON m.id = a.message_id
           JOIN channels c     ON c.id = m.channel_id
           JOIN participants p ON p.id = m.sender_id
          WHERE ($channel IS NULL OR c.name = $channel)
          ORDER BY a.id DESC`,
      )
      .all({ channel: channelName });

    const matching = rows.filter((row) => {
      if (kind === null) return true;
      const previewKind = previewKindForRow(row);
      return kind === "other" ? previewKind === null : previewKind === kind;
    });

    return {
      rows: matching.slice(0, limit).map((row) => ({
        attachment: {
          id: row.id,
          path: row.path,
          displayName: row.display_name,
          byteSize: row.byte_size,
          mediaType: row.media_type,
          previewEligible: row.sha256 !== null,
          previewKind: previewKindForRow(row),
        },
        channel: row.channel,
        messageId: row.message_id,
        sender: row.sender,
        createdAt: row.created_at,
      })),
      truncated: matching.length > limit,
    };
  }

  attachmentById(id: number): StoredAttachment | null {
    const row = this.db
      .query<AttachmentRow, { id: number }>(`SELECT * FROM attachments WHERE id = $id`)
      .get({ id });
    if (row === null) return null;
    return {
      id: row.id,
      messageId: row.message_id,
      path: row.path,
      displayName: row.display_name,
      byteSize: row.byte_size,
      mediaType: row.media_type,
      mtime: row.mtime,
      sha256: row.sha256,
    };
  }

  // --------------------------------------------------------------------- helpers

  private channelRow(name: string): ChannelRow | null {
    return this.db
      .query<ChannelRow, { name: string }>(`SELECT * FROM channels WHERE name = $name`)
      .get({ name });
  }

  private highWaterMark(channelId: number): number {
    const row = this.db
      .query<{ high: number }, { channelId: number }>(
        `SELECT COALESCE(MAX(id), 0) AS high FROM messages WHERE channel_id = $channelId`,
      )
      .get({ channelId });
    return row === null ? 0 : row.high;
  }

  /** One extra query for the whole batch rather than one per message. */
  private withAttachments(rows: readonly MessageRow[]): Message[] {
    if (rows.length === 0) return [];

    const placeholders = rows.map(() => "?").join(",");
    const attachmentRows = this.db
      .query<AttachmentRow, number[]>(
        `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...rows.map((row) => row.id));

    const byMessage = new Map<number, AttachmentMeta[]>();
    for (const row of attachmentRows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        path: row.path,
        displayName: row.display_name,
        byteSize: row.byte_size,
        mediaType: row.media_type,
        previewEligible: row.sha256 !== null,
        previewKind: previewKindForRow(row),
      });
      byMessage.set(row.message_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      sender: row.sender,
      senderKind: row.sender_kind,
      senderAgentKind: row.sender_agent_kind,
      body: row.body,
      attachments: byMessage.get(row.id) ?? [],
      createdAt: row.created_at,
    }));
  }
}

const CHANNEL_SUMMARY_SELECT = `
  SELECT c.id, c.name, c.kind, c.topic, c.created_at,
         (SELECT COUNT(*)
            FROM memberships mem
            JOIN participants member ON member.id = mem.participant_id
           WHERE mem.channel_id = c.id AND member.deactivated = 0) AS member_count,
         (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id)        AS message_count,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at
    FROM channels c
`;

function toParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    deactivated: row.deactivated === 1,
    terminalId: row.terminal_id,
    paneId: row.pane_id,
    occupantAgent: row.occupant_agent,
    routeState: row.route_state,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function toChannel(row: ChannelSummaryRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    topic: row.topic,
    memberCount: row.member_count,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
  };
}
