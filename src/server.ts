/**
 * The hub: one HTTP surface over the store.
 *
 * Reads of channel content are open, because every local process already runs
 * as the one user who owns this machine. Tokens gate acting AS a participant —
 * sending under a handle, moving its cursors, joining channels as it, and
 * reading the local files it attached.
 */

import { Result } from "better-result";
import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { ingestAttachment, readMarkdownPath, readPreview } from "./attachments";
import { transcribeDictation } from "./dictation";
import {
  DEFAULT_HARNESSES,
  DEFAULT_ROLES,
  MAX_AGENT_START_TIMEOUT_MS,
  type ModelConfig,
  type RoleConfig,
  type ServerConfig,
  HOST,
  loadConfig,
} from "./config";
import { CONTROL_TOKEN_HEADER, ensureLocalControlToken } from "./control-token";
import { openDatabase } from "./db";
import {
  HerdrCallFailed,
  type ChannelNotFound,
  type NotAMember,
  type ValidationFailed,
  channelNotFound,
  handleTaken,
  herdrCallFailed,
  herdrNotConfigured,
  notFound,
  operatorOnly,
  validationFailed,
} from "./errors";
import {
  type ApiError,
  admit,
  authenticate,
  canonicalHostRedirect,
  corsHeaders,
  errorResponse,
  jsonResponse,
  setTokenCookie,
} from "./http";
import {
  decodeObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requiredNullableString,
  requiredInteger,
  requiredString,
} from "./json";
import { type JsonObject, type JsonValue } from "./json";
import {
  CliHerdr,
  HERDR_AGENT_START_TIMEOUT_MS,
  HERDR_CONFIRM_TIMEOUT_MS,
  HERDR_TIMEOUT_MS,
  type HerdrPort,
  type PaneInfo,
} from "./herdr";
import { acquireHubLock } from "./lock";
import { Notifier } from "./notifier";
import { DeviceModelCatalogue, type DeviceLauncher } from "./model-catalogue";
import { literalQuery } from "./search";
import {
  Store,
  type CreatedParticipant,
  type LauncherRecord,
  type LifecycleSpawnOperation,
  type ModelRecord,
  type RoleRecord,
  type WorkspaceMembershipChange,
} from "./store";
import { HerdrTopology, workspaceChannelName } from "./topology";
import { Broadcaster, TopologyBroadcaster, frameFor, frameForTopology } from "./sse";
import { UploadStore } from "./uploads";
import type {
  AgentDetail,
  AgentSessionView,
  AgentSessionSelectionView,
  AttachmentInput,
  ChannelKind,
  ChannelReceipt,
  HerdrPaneView,
  HerdrTopologySnapshot,
  Launcher,
  LauncherDefinition,
  Message,
  ModelEntry,
  Participant,
  RoleDetail,
  RolePreset,
  RoleRuntimePreset,
  SessionMappingView,
  SessionState,
} from "./types";
import {
  DEFAULT_CONTEXT_SPAN,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_CONTEXT_SPAN,
  MAX_HISTORY_LIMIT,
  MAX_PATH_LENGTH,
  MAX_REPLAY,
  MAX_SEARCH_LIMIT,
  clampLimit,
  validAttachmentPaths,
  validBody,
  validLauncherEnvironment,
  validLauncherArgv,
  validModelIdentifier,
  validName,
  validPromptText,
  validStoredText,
  validTopic,
} from "./validate";
import {
  type MappingConfidence,
  type SessionWindow,
  type WindowReader,
  DEFAULT_TURN_LIMIT,
  adapterFor,
  bunWindowReader,
  chooseSession,
  glanceLine,
  readWindow,
} from "./transcripts";
import { SHEPPARD_VERSION } from "./version";
import { hashToken } from "./tokens";

export interface Hub {
  store: Store;
  config: ServerConfig;
  broadcaster: Broadcaster;
  notifier?: Notifier;
  herdr?: HerdrPort;
  topology?: HerdrTopology;
  herdrBroadcaster?: TopologyBroadcaster;
  modelCatalogue?: DeviceModelCatalogue;
  lifecycleLocks?: Map<string, Promise<void>>;
  localControlTokenHash: string;
  /** Injected by tests to count the bytes a session read actually takes. */
  windowReader?: WindowReader;
}

/** A request path with its dynamic segment replaced, so routing is one switch. */
interface RoutedPath {
  key: string;
  param: string;
  extra: string;
}

function routedPath(pathname: string): Result<RoutedPath, ValidationFailed> {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const [first, second, third, fourth] = segments;

  if (first === "api" && second === "channels" && segments.length === 3 && third !== undefined) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/channels/:name",
        param: decodeURIComponent(third),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }

  if (first === "api" && second === "channels" && segments.length === 4 && third !== undefined) {
    return Result.try({
      try: (): RoutedPath => ({
        key: `/api/channels/:name/${fourth ?? ""}`,
        param: decodeURIComponent(third),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "channels" &&
    segments.length === 5 &&
    third !== undefined &&
    fourth === "members" &&
    segments[4] !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/channels/:name/members/:handle",
        param: decodeURIComponent(third),
        extra: decodeURIComponent(segments[4]!),
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "attachments" &&
    segments.length === 4 &&
    fourth === "content" &&
    third !== undefined
  ) {
    return Result.ok({ key: "/api/attachments/:id/content", param: third, extra: "" });
  }
  if (
    first === "api" &&
    second === "messages" &&
    segments.length === 4 &&
    fourth === "markdown" &&
    third !== undefined
  ) {
    return Result.ok({ key: "/api/messages/:id/markdown", param: third, extra: "" });
  }
  if (first === "api" && second === "agents" && segments.length === 3 && third !== undefined) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/agents/:handle",
        param: decodeURIComponent(third),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "participants" &&
    segments.length === 3 &&
    third !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/participants/:handle",
        param: decodeURIComponent(third),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "tabs" &&
    segments.length === 3
  ) {
    return Result.ok({ key: "/api/herdr/tabs", param: "", extra: "" });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "tabs" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "focus"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/tabs/:id/focus",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "tabs" &&
    segments.length === 4 &&
    fourth !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/tabs/:id",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "workspaces" &&
    segments.length === 4 &&
    fourth !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/workspaces/:id",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "roles" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "runtime"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/roles/:name/runtime",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "roles" &&
    segments.length === 4 &&
    fourth !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/roles/:name",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "models" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/models/:harness/:name",
        param: decodeURIComponent(fourth),
        extra: decodeURIComponent(segments[4]!),
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "model-catalogue" &&
    segments.length === 3
  ) {
    return Result.ok({ key: "/api/herdr/model-catalogue", param: "", extra: "" });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "launchers" &&
    segments.length === 4 &&
    fourth !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/launchers/:name",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "agents" &&
    segments.length === 4 &&
    fourth !== undefined
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/agents/:paneId",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "agents" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "connect"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/agents/:paneId/connect",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "agents" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "prompt"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/agents/:paneId/prompt",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "agents" &&
    segments.length === 6 &&
    fourth !== undefined &&
    segments[4] === "session" &&
    segments[5] === "select"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/agents/:paneId/session/select",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "agents" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "session"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/agents/:paneId/session",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  if (
    first === "api" &&
    second === "herdr" &&
    third === "workspaces" &&
    segments.length === 5 &&
    fourth !== undefined &&
    segments[4] === "broadcast"
  ) {
    return Result.try({
      try: (): RoutedPath => ({
        key: "/api/herdr/workspaces/:id/broadcast",
        param: decodeURIComponent(fourth),
        extra: "",
      }),
      catch: () => validationFailed("path", "must use valid URL encoding"),
    });
  }
  return Result.ok({ key: `/${segments.join("/")}`, param: "", extra: "" });
}

async function readJsonBody(request: Request): Promise<Result<JsonValue, ValidationFailed>> {
  const text = await request.text();
  if (text.length === 0) return Result.ok({});
  return Result.try({
    try: (): JsonValue => JSON.parse(text),
    catch: () => validationFailed("body", "must be valid JSON"),
  });
}

function integerFromQuery(
  url: URL,
  field: string,
  fallback: number,
): Result<number, ValidationFailed> {
  const raw = url.searchParams.get(field);
  if (raw === null || raw.length === 0) return Result.ok(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return Result.err(validationFailed(field, "must be an integer"));
  return Result.ok(parsed);
}

const EMPTY_TOPOLOGY: HerdrTopologySnapshot = { workspaces: [] };

/** Bounds one local directory listing returned to the browser. */
const MAX_DIRECTORY_ENTRIES = 500;

function ensureTopology(hub: Hub): HerdrTopology | null {
  if (hub.topology !== undefined) return hub.topology;
  if (hub.herdr === undefined) return null;

  const broadcaster = hub.herdrBroadcaster ?? new TopologyBroadcaster();
  hub.herdrBroadcaster = broadcaster;
  hub.topology = new HerdrTopology({
    herdr: hub.herdr,
    store: hub.store,
    onChange: (snapshot) => broadcaster.publish(snapshot),
  });
  return hub.topology;
}

function herdrPort(hub: Hub): Result<HerdrPort, ReturnType<typeof herdrNotConfigured>> {
  return hub.herdr === undefined ? Result.err(herdrNotConfigured()) : Result.ok(hub.herdr);
}

async function currentTopology(hub: Hub): Promise<HerdrTopologySnapshot> {
  const topology = ensureTopology(hub);
  if (topology === null) return EMPTY_TOPOLOGY;
  await topology.refresh();
  return topology.snapshot();
}

async function requiredTopology(
  hub: Hub,
): Promise<
  Result<HerdrTopology, ReturnType<typeof herdrNotConfigured> | ReturnType<typeof herdrCallFailed>>
> {
  const topology = ensureTopology(hub);
  if (topology === null) return Result.err(herdrNotConfigured());
  if (!(await topology.refresh())) {
    return Result.err(herdrCallFailed("topology refresh failed", "control plane"));
  }
  return Result.ok(topology);
}

const MAX_ACTIVE_LIFECYCLE_AGENTS_PER_WORKSPACE = 16;
const LIFECYCLE_CONFIRM_TIMEOUT_MS = HERDR_CONFIRM_TIMEOUT_MS;
const LIFECYCLE_CONFIRM_INTERVAL_MS = 50;

function isShellReadinessRefusal(error: HerdrCallFailed, paneId: string): boolean {
  if (error.command !== "agent start" || error.kind !== "reported") return false;
  switch (error.detail) {
    case "agent_pane_busy":
      return true;
    default:
      return error.detail === `agent target pane ${paneId} is not an available shell`;
  }
}

async function startLifecycleAgent(
  herdr: HerdrPort,
  paneId: string,
  name: string,
  kind: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<Result<void, ReturnType<typeof herdrCallFailed>>> {
  const minimumAgentStartTimeoutMs = 3_001;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining < minimumAgentStartTimeoutMs) {
      return Result.err(
        herdrCallFailed("agent start timed out while waiting for an available shell", "agent start", "timeout", paneId),
      );
    }
    const started = await herdr.agentStart(paneId, name, kind, argv, remaining);
    if (started.isOk()) return Result.ok();
    if (!isShellReadinessRefusal(started.error, paneId)) return started;
    const waitFor = deadline - Date.now();
    if (waitFor < minimumAgentStartTimeoutMs) {
      return Result.err(
        herdrCallFailed("agent start timed out while waiting for an available shell", "agent start", "timeout", paneId),
      );
    }
    await Bun.sleep(Math.min(LIFECYCLE_CONFIRM_INTERVAL_MS, waitFor - minimumAgentStartTimeoutMs + 1));
  }
}

function lifecyclePaneMatches(
  store: Store,
  operation: LifecycleSpawnOperation,
  pane: PaneInfo,
  requireLabel: boolean,
): boolean {
  if (
    operation.participantId === null ||
    operation.paneId === null ||
    operation.terminalId === null ||
    operation.assignedHandle === null
  ) {
    return false;
  }
  const participant = store.findById(operation.participantId);
  return (
    workspaceIdForPane(pane) === operation.workspaceId &&
    pane.paneId === operation.paneId &&
    pane.terminalId === operation.terminalId &&
    pane.agent === operation.harness &&
    (!requireLabel || pane.label === operation.assignedHandle) &&
    participant?.handle === operation.assignedHandle
  );
}

async function bindLifecycleSpawnRoute(
  hub: Hub,
  herdr: HerdrPort,
  operation: LifecycleSpawnOperation,
  requireLabel = false,
): Promise<Result<void, ReturnType<typeof herdrCallFailed>>> {
  if (
    operation.participantId === null ||
    operation.paneId === null ||
    operation.terminalId === null ||
    operation.assignedHandle === null
  ) {
    return Result.err(
      herdrCallFailed("stored spawn operation is incomplete", "lifecycle route bind", "reported", operation.paneId),
    );
  }
  const listed = await herdr.paneList();
  if (listed.isErr()) {
    return Result.err(
      herdrCallFailed(listed.error.detail, "lifecycle route bind", listed.error.kind, operation.paneId),
    );
  }
  const pane = listed.value.find((candidate) => candidate.paneId === operation.paneId);
  if (pane === undefined || !lifecyclePaneMatches(hub.store, operation, pane, requireLabel)) {
    return Result.err(
      herdrCallFailed(
        "live pane does not match the stored lifecycle spawn identity",
        "lifecycle route bind",
        "reported",
        operation.paneId,
      ),
    );
  }
  if (
    !hub.store.bindLifecycleSpawnRoute(
      operation.participantId,
      operation.paneId,
      operation.terminalId,
      operation.harness,
    )
  ) {
    return Result.err(
      herdrCallFailed("lifecycle participant is unavailable", "lifecycle route bind", "reported", operation.paneId),
    );
  }
  return Result.ok();
}
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function launcherSeeds(config: ServerConfig): LauncherDefinition[] {
  return (config.harnesses ?? DEFAULT_HARNESSES).map((harness) => ({
    name: harness.name,
    agentKind: harness.name,
    argv: [...harness.argv],
    startTimeoutMs: harness.startTimeoutMs,
    env: {},
  }));
}

export function roleSeeds(config: ServerConfig): readonly RoleConfig[] {
  return config.roles ?? DEFAULT_ROLES;
}

export function modelSeeds(config: ServerConfig): readonly ModelConfig[] {
  return config.models ?? [];
}

function findExactLauncher(hub: Hub, name: string): LauncherRecord | null {
  return hub.store.launcher(name);
}

/** A role is offerable only while a launcher of its agent kind exists. */
function findExactRole(hub: Hub, name: string): RoleRecord | null {
  const role = hub.store.role(name);
  if (role === null) return null;
  const launchable = hub.store
    .listLaunchers()
    .some((launcher) => role.agentKind === null || launcher.agentKind === role.agentKind);
  return launchable ? role : null;
}

async function withLifecycleLock<T>(
  hub: Hub,
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = hub.lifecycleLocks ?? new Map<string, Promise<void>>();
  hub.lifecycleLocks = locks;
  const previous = locks.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(workspaceId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(workspaceId) === current) locks.delete(workspaceId);
  }
}

function workspaceIdForPane(pane: PaneInfo): string | null {
  if (pane.workspaceId !== undefined) return pane.workspaceId;
  const separator = pane.paneId.indexOf(":");
  return separator <= 0 ? null : pane.paneId.slice(0, separator);
}

function lifecycleHerdrFailure(operation: string, paneId: string | null = null) {
  return herdrCallFailed(`${operation} failed`, operation, "unknown", paneId);
}

function lifecycleCleanupFailure(paneId: string | null) {
  const detail = paneId === null
    ? "spawn cleanup pane close failed; pane identity is unknown; cleanup state is unresolved"
    : `spawn cleanup pane close failed while cleaning up pane ${paneId}; cleanup state is unresolved`;
  return herdrCallFailed(detail, "spawn cleanup pane close", "unknown", paneId);
}

function lifecycleCleanupIdentityUnknown(paneId: string) {
  return herdrCallFailed(
    `spawn cleanup identity could not be proved for pane ${paneId}; cleanup state is unresolved`,
    "spawn cleanup pane identity",
    "unknown",
    paneId,
  );
}

interface ConfirmedLifecycleSpawn {
  paneId: string;
  handle: string;
}

interface LifecycleOperationRequest {
  workspaceId: string;
  launcher: string;
  launcherRevision: number;
  role: string | null;
  handle: string;
}

function lifecycleOperationKey(
  callerId: number,
  request: LifecycleOperationRequest,
  headers: Headers,
): Result<string, ValidationFailed> {
  const explicit = headers.get(IDEMPOTENCY_KEY_HEADER);
  if (explicit !== null) {
    if (explicit.length === 0 || explicit.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return Result.err(
        validationFailed(
          IDEMPOTENCY_KEY_HEADER,
          `must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        ),
      );
    }
    const valid = validStoredText(explicit, IDEMPOTENCY_KEY_HEADER);
    if (valid.isErr()) return valid;
  }

  const material =
    explicit === null
      ? { callerId, request }
      : { callerId, idempotencyKey: explicit };
  const digest = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return Result.ok(`spawn-${digest}`);
}

function lifecycleOperationMatches(
  operation: LifecycleSpawnOperation,
  callerId: number,
  request: LifecycleOperationRequest,
): boolean {
  return (
    operation.requesterId === callerId &&
    operation.workspaceId === request.workspaceId &&
    operation.launcher === request.launcher &&
    operation.launcherRevision === request.launcherRevision &&
    operation.role === request.role &&
    operation.requestedHandle === request.handle
  );
}

function topologyPane(
  snapshot: HerdrTopologySnapshot,
  workspaceId: string,
  paneId: string,
) {
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId);
  return workspace?.panes.find((pane) => pane.paneId === paneId) ?? null;
}

interface TopologyPaneMatch {
  workspaceId: string;
  pane: HerdrPaneView;
}

function topologyPaneForParticipant(
  snapshot: HerdrTopologySnapshot,
  participant: Participant,
): TopologyPaneMatch | null {
  if (participant.paneId === null) return null;
  for (const workspace of snapshot.workspaces) {
    const pane = workspace.panes.find(
      (candidate) =>
        candidate.paneId === participant.paneId && candidate.participant === participant.handle,
    );
    if (pane !== undefined) return { workspaceId: workspace.id, pane };
  }
  return null;
}

async function confirmLifecycleSpawn(
  hub: Hub,
  workspaceId: string,
  paneId: string,
  participantId: number,
  assignedHandle: string,
  harness: string,
  timeoutMs = LIFECYCLE_CONFIRM_TIMEOUT_MS,
): Promise<
  Result<
    ConfirmedLifecycleSpawn,
    ReturnType<typeof herdrNotConfigured> | ReturnType<typeof herdrCallFailed>
  >
> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const topology = await requiredTopology(hub);
    if (topology.isErr()) return Result.err(topology.error);
    const pane = topologyPane(topology.value.snapshot(), workspaceId, paneId);
    const participant = hub.store.findById(participantId);
    if (
      pane !== null &&
      pane.agentKind === harness &&
      pane.participant === assignedHandle &&
      pane.participantRouteState === "active" &&
      participant?.handle === assignedHandle &&
      participant.routeState === "active" &&
      participant.paneId === paneId &&
      participant.occupantAgent === harness
    ) {
      return Result.ok({ paneId, handle: assignedHandle });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Result.err(
        herdrCallFailed("spawn confirmation timed out", "control plane", "timeout", paneId),
      );
    }
    await Bun.sleep(Math.min(LIFECYCLE_CONFIRM_INTERVAL_MS, remaining));
  }
}

function channelKindFromQuery(url: URL): Result<"chat" | "workspace", ValidationFailed> {
  const kind = url.searchParams.get("kind");
  if (kind === null || kind === "chat") return Result.ok("chat");
  if (kind === "workspace") return Result.ok("workspace");
  return Result.err(validationFailed("kind", "must be chat or workspace"));
}

function optionalChannelKindFromQuery(url: URL): Result<ChannelKind | null, ValidationFailed> {
  switch (url.searchParams.get("kind")) {
    case null:
      return Result.ok(null);
    case "chat":
      return Result.ok("chat");
    case "direct":
      return Result.ok("direct");
    case "workspace":
      return Result.ok("workspace");
    default:
      return Result.err(validationFailed("kind", "must be chat, direct, or workspace"));
  }
}

// ------------------------------------------------------------------ handlers

/**
 * The response carries the ASSIGNED handle, which differs from the requested one
 * when the name was taken and a suffix was applied. A spawner must pass the
 * returned handle to the agent it launches.
 */
function createAgent(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) =>
      Result.gen(function* () {
        const requested = yield* requiredString(object, "handle");
        const handle = yield* validName(requested, "handle");
        const exact = yield* optionalBoolean(object, "exact", false);
        return hub.store.createAgent(handle, exact);
      }),
    )
    .match({
      ok: (created) =>
        jsonResponse({ handle: created.participant.handle, token: created.token }, 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function humanSessionResponse(
  created: CreatedParticipant,
  status: 200 | 201,
  headers: Headers,
): Response {
  setTokenCookie(headers, created.token);
  return jsonResponse({ handle: created.participant.handle }, status, headers);
}

function createHuman(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) => requiredString(object, "handle"))
    .andThen((handle) => validName(handle, "handle"))
    .match({
      ok: (handle) => {
        const existing = hub.store.findByHandle(handle);
        if (existing?.kind === "human" && !existing.deactivated) {
          return hub.store.reissueHuman(handle).match({
            ok: (created) => humanSessionResponse(created, 200, headers),
            err: (error) => errorResponse(error, headers),
          });
        }

        const activeHuman = hub.store.mostRecentlySeenHuman();
        if (!hub.config.allowExtraHumans && activeHuman !== null) {
          return errorResponse(handleTaken(activeHuman.handle), headers);
        }
        return hub.store.createHuman(handle).match({
          ok: (created) => humanSessionResponse(created, 201, headers),
          err: (error) => errorResponse(error, headers),
        });
      },
      err: (error) => errorResponse(error, headers),
    });
}

function createChannel(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) =>
      Result.gen(function* () {
        const name = yield* requiredString(object, "name");
        const validated = yield* validName(name, "name");
        const rawTopic = yield* optionalString(object, "topic");
        const topic = yield* validTopic(rawTopic);
        return hub.store.createChannel(validated, topic);
      }),
    )
    .match({
      ok: (channel) => jsonResponse(channel, 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function deleteChannel(hub: Hub, channel: string, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) => requiredString(object, "confirm"))
    .andThen((confirm) => validStoredText(confirm, "confirm"))
    .andThen((confirm) => validName(channel, "name").map(() => confirm))
    .andThen((confirm) => hub.store.deleteChannel(channel, confirm))
    .match({
      ok: (deleted) => jsonResponse(deleted, 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function joinChannel(hub: Hub, caller: Participant, channel: string, headers: Headers): Response {
  return hub.store.join(caller.id, channel).match({
    ok: (joined) => jsonResponse(joined, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

async function agentDetail(hub: Hub, handle: string, headers: Headers): Promise<Response> {
  const validHandle = validName(handle, "handle");
  if (validHandle.isErr()) return errorResponse(validHandle.error, headers);

  const participant = hub.store.findByHandle(validHandle.value);
  if (participant === null || participant.kind !== "agent" || participant.deactivated) {
    return errorResponse(notFound("Agent"), headers);
  }

  const topology = await currentTopology(hub);
  const paneMatch = topologyPaneForParticipant(topology, participant);
  const pane = paneMatch?.pane ?? null;
  const lifecycle = hub.store.lifecycleAgentForParticipant(participant.id);
  const role =
    lifecycle !== null &&
    participant.routeState === "active" &&
    paneMatch?.workspaceId === lifecycle.workspaceId &&
    participant.terminalId === lifecycle.terminalId &&
    participant.paneId === lifecycle.paneId &&
    participant.occupantAgent === lifecycle.harness &&
    pane?.agentKind === lifecycle.harness
      ? lifecycle.role
      : null;
  const detail: AgentDetail = {
    participant: {
      handle: participant.handle,
      kind: "agent",
      agentKind: participant.occupantAgent,
      role,
      routeState: participant.routeState,
      lastSeenAt: participant.lastSeenAt,
    },
    routeState: participant.routeState,
    pane,
    recentMessageIds: hub.store.recentMessageIds(participant.id),
    channels: hub.store.agentChannels(participant.id),
  };
  return jsonResponse(detail, 200, headers);
}

function addMember(
  hub: Hub,
  channel: string,
  body: JsonValue,
  headers: Headers,
): Response {
  return decodeObject(body)
    .andThen((object) => requiredString(object, "handle"))
    .andThen((handle) => validName(handle, "handle"))
    .andThen((handle) => hub.store.addMember(channel, handle))
    .match({
      ok: (added) => jsonResponse(added, 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function removeMember(
  hub: Hub,
  channel: string,
  handle: string,
  headers: Headers,
): Response {
  return validName(handle, "handle").andThen((valid) => hub.store.removeMember(channel, valid)).match({
    ok: (removed) => jsonResponse(removed, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

function ingestAll(paths: readonly string[]): Result<AttachmentInput[], ValidationFailed> {
  const ingested: AttachmentInput[] = [];
  for (const path of paths) {
    const one = ingestAttachment(path);
    if (one.isErr()) return Result.err(one.error);
    ingested.push(one.value);
  }
  return Result.ok(ingested);
}

function sendMessage(
  hub: Hub,
  caller: Participant,
  channel: string,
  body: JsonValue,
  headers: Headers,
): Response {
  const sent = decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const text = yield* requiredString(object, "body");
      const validated = yield* validBody(text);
      const rawPaths = yield* optionalStringArray(object, "attachments");
      const paths = yield* validAttachmentPaths(rawPaths);
      const attachments = yield* ingestAll(paths);
      return hub.store.send(caller.id, channel, validated, attachments);
    }),
  );

  return sent.match({
    ok: (message) => {
      hub.broadcaster.publish(message);
      void hub.notifier?.notifyChannel(message.channel);
      return jsonResponse(message, 201, headers);
    },
    err: (error) => errorResponse(error, headers),
  });
}

function sendDirectMessage(
  hub: Hub,
  caller: Participant,
  body: JsonValue,
  headers: Headers,
): Response {
  const sent = decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawHandles = yield* optionalStringArray(object, "to");
      if (rawHandles.length === 0) yield* validationFailed("to", "must not be empty");

      const handles: string[] = [];
      for (const handle of rawHandles) handles.push(yield* validName(handle, "to"));

      const text = yield* requiredString(object, "body");
      const validated = yield* validBody(text);
      const rawPaths = yield* optionalStringArray(object, "attachments");
      const paths = yield* validAttachmentPaths(rawPaths);
      const attachments = yield* ingestAll(paths);
      return hub.store.sendDirect(caller.id, handles, validated, attachments);
    }),
  );

  return sent.match({
    ok: (message) => {
      hub.broadcaster.publish(message);
      void hub.notifier?.notifyChannel(message.channel);
      return jsonResponse({ channel: message.channel, messageId: message.id }, 201, headers);
    },
    err: (error) => errorResponse(error, headers),
  });
}

function fetchUnread(hub: Hub, caller: Participant, channel: string, headers: Headers): Response {
  return hub.store.fetch(caller.id, channel).match({
    ok: (result) => jsonResponse(result, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

function acknowledge(
  hub: Hub,
  caller: Participant,
  channel: string,
  body: JsonValue,
  headers: Headers,
): Response {
  return decodeObject(body)
    .andThen((object) => requiredInteger(object, "throughId"))
    .andThen((throughId) =>
      throughId < 0
        ? Result.err(validationFailed("throughId", "must not be negative"))
        : hub.store.ack(caller.id, channel, throughId),
    )
    .match({
      ok: (acked) => {
        if (acked.advanced) {
          hub.broadcaster.publishReceipt({
            channel,
            handle: caller.handle,
            cursorMessageId: acked.cursorId,
          });
        }
        return jsonResponse({ cursorId: acked.cursorId }, 200, headers);
      },
      err: (error) => errorResponse(error, headers),
    });
}

function listHistory(hub: Hub, url: URL, channel: string, headers: Headers): Response {
  return Result.gen(function* () {
    const requested = yield* integerFromQuery(url, "limit", DEFAULT_HISTORY_LIMIT);
    const before = yield* integerFromQuery(url, "before", 0);
    const limit = clampLimit(requested, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    return hub.store.history(channel, limit, before > 0 ? before : null);
  }).match({
    ok: (messages) => jsonResponse({ messages }, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

function listContext(hub: Hub, url: URL, channel: string, headers: Headers): Response {
  return Result.gen(function* () {
    const around = yield* integerFromQuery(url, "around", 0);
    if (around <= 0) yield* validationFailed("around", "is required");
    const requested = yield* integerFromQuery(url, "span", DEFAULT_CONTEXT_SPAN);
    const span = clampLimit(requested, DEFAULT_CONTEXT_SPAN, MAX_CONTEXT_SPAN);
    return hub.store.context(channel, around, span);
  }).match({
    ok: (messages) => jsonResponse({ messages }, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

function listMembers(hub: Hub, channel: string, headers: Headers): Response {
  return hub.store.listMembers(channel).match({
    ok: (members) => jsonResponse({ members }, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

function receiptsErrorResponse(
  error: ChannelNotFound | NotAMember,
  headers: Headers,
): Response {
  return error.match({
    ChannelNotFound: (failure) => errorResponse(failure, headers),
    NotAMember: (failure) =>
      jsonResponse({ error: failure.message, code: failure._tag }, 403, headers),
  });
}

function listReceipts(
  hub: Hub,
  caller: Participant,
  channel: string,
  headers: Headers,
): Response {
  return hub.store.receipts(caller.id, channel).match({
    ok: (receipts: ChannelReceipt[]) => jsonResponse(receipts, 200, headers),
    err: (error) => receiptsErrorResponse(error, headers),
  });
}

function listInbox(hub: Hub, caller: Participant, headers: Headers): Response {
  const entries = hub.store.inbox(caller.id).map((entry) => ({
    ...entry,
    pushEnabled: entry.pushEnabled && hub.config.pushAvailable,
  }));
  return jsonResponse({ entries }, 200, headers);
}

function listDirect(hub: Hub, caller: Participant, headers: Headers): Response {
  return jsonResponse({ conversations: hub.store.listDirect(caller.id) }, 200, headers);
}

function listParticipants(hub: Hub, headers: Headers): Response {
  return jsonResponse({ participants: hub.store.listParticipants() }, 200, headers);
}

function deactivateParticipant(hub: Hub, handle: string, headers: Headers): Response {
  return validName(handle, "handle")
    .andThen((validHandle) => hub.store.deactivateParticipant(validHandle))
    .match({
      ok: (deactivated) => jsonResponse(deactivated, 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function listHerdrHarnesses(hub: Hub, headers: Headers): Response {
  const harnesses = [
    ...new Set([
      ...DEFAULT_HARNESSES.map((harness) => harness.name),
      ...hub.store.listLaunchers().map((launcher) => launcher.agentKind),
    ]),
  ].sort();
  return jsonResponse({ harnesses }, 200, headers);
}

function rolePresetView(role: RoleRecord): RolePreset {
  return {
    name: role.name,
    agentKind: role.agentKind,
    native: role.native,
    summary: role.summary,
    launcher: role.launcher,
    model: role.model,
    effort: role.effort,
  };
}

/** The open list carries the preset fields and never the briefing. */
function listHerdrRoles(hub: Hub, headers: Headers): Response {
  const launchers = hub.store.listLaunchers();
  const roles = hub.store
    .listRoles()
    .filter((role) =>
      launchers.some(
        (launcher) => role.agentKind === null || launcher.agentKind === role.agentKind,
      ),
    )
    .map(rolePresetView);
  return jsonResponse({ roles }, 200, headers);
}

function readHerdrRole(hub: Hub, name: string, headers: Headers): Response {
  return validName(name, "name")
    .andThen((valid) => {
      const role = hub.store.role(valid);
      return role === null ? Result.err(notFound(`Role "${valid}"`)) : Result.ok(role);
    })
    .match({
      ok: (role) => {
        const detail: RoleDetail = { ...rolePresetView(role), briefing: role.briefing };
        return jsonResponse(detail, 200, headers);
      },
      err: (error) => errorResponse(error, headers),
    });
}

function roleDefinition(
  body: JsonValue,
): Result<Omit<RoleRecord, "name" | "revision" | "native">, ValidationFailed> {
  return decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawAgentKind = yield* optionalString(object, "agentKind");
      const agentKind = rawAgentKind === null ? null : yield* validName(rawAgentKind, "agentKind");
      const rawSummary = yield* requiredString(object, "summary");
      const summary = yield* validStoredText(rawSummary, "summary");
      const rawBriefing = yield* requiredString(object, "briefing");
      const briefing = yield* validBody(rawBriefing);
      const rawLauncher = yield* optionalString(object, "launcher");
      const launcher = rawLauncher === null ? null : yield* validName(rawLauncher, "launcher");
      const rawModel = yield* optionalString(object, "model");
      const model = rawModel === null ? null : yield* validModelIdentifier(rawModel, "model");
      const rawEffort = yield* optionalString(object, "effort");
      const effort = rawEffort === null ? null : yield* validModelIdentifier(rawEffort, "effort");
      return Result.ok({ agentKind, summary, briefing, launcher, model, effort });
    }),
  );
}

function createHerdrRole(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) => requiredString(object, "name"))
    .andThen((name) => validName(name, "name"))
    .andThen((name) =>
      roleDefinition(body).andThen((definition) => hub.store.createRole({ name, ...definition })),
    )
    .match({
      ok: (role) => jsonResponse(rolePresetView(role), 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function updateHerdrRole(hub: Hub, name: string, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) =>
      Object.hasOwn(object, "name")
        ? Result.err(validationFailed("name", "is immutable"))
        : Result.ok(object),
    )
    .andThen(() => validName(name, "name"))
    .andThen((validRoleName) => {
      const current = hub.store.role(validRoleName);
      if (current?.native === true) {
        return Result.err(
          validationFailed("role", "native roles are read-only; duplicate the role to customize it"),
        );
      }
      return roleDefinition(body).andThen((definition) =>
        hub.store.updateRole(validRoleName, definition),
      );
    })
    .match({
      ok: (role) => jsonResponse(rolePresetView(role), 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function roleRuntimePreset(body: JsonValue): Result<RoleRuntimePreset, ValidationFailed> {
  return decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawAgentKind = yield* requiredNullableString(object, "agentKind");
      const agentKind = rawAgentKind === null ? null : yield* validName(rawAgentKind, "agentKind");
      const rawLauncher = yield* requiredNullableString(object, "launcher");
      const launcher = rawLauncher === null ? null : yield* validName(rawLauncher, "launcher");
      const rawModel = yield* requiredNullableString(object, "model");
      const model = rawModel === null ? null : yield* validModelIdentifier(rawModel, "model");
      const rawEffort = yield* requiredNullableString(object, "effort");
      const effort = rawEffort === null ? null : yield* validModelIdentifier(rawEffort, "effort");
      return Result.ok({ agentKind, effort, launcher, model });
    }),
  );
}

function updateHerdrRoleRuntime(hub: Hub, name: string, body: JsonValue, headers: Headers): Response {
  return validName(name, "name")
    .andThen((validRoleName) =>
      roleRuntimePreset(body).andThen((runtime) =>
        hub.store.updateRoleRuntime(validRoleName, runtime),
      ),
    )
    .match({
      ok: (role) => jsonResponse(rolePresetView(role), 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function deleteHerdrRole(hub: Hub, name: string, headers: Headers): Response {
  return validName(name, "name")
    .andThen((validRoleName) => hub.store.deleteRole(validRoleName))
    .match({
      ok: (deleted) => jsonResponse(deleted, 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function modelEntryView(model: ModelRecord): ModelEntry {
  return { harness: model.harness, name: model.name, kind: model.kind };
}

/** Names only; the argv suffix never leaves the hub on an open read. */
function listHerdrModels(hub: Hub, headers: Headers): Response {
  return jsonResponse({ models: hub.store.listModels().map(modelEntryView) }, 200, headers);
}

function modelCatalogueFor(hub: Hub): DeviceModelCatalogue {
  hub.modelCatalogue ??= new DeviceModelCatalogue();
  return hub.modelCatalogue;
}

function modelCatalogueLaunchers(hub: Hub): readonly DeviceLauncher[] {
  return hub.store.listLaunchers().map((launcher) => ({
    name: launcher.name,
    harness: launcher.agentKind,
    argv: launcher.argv,
    env: launcher.env,
    revision: launcher.revision,
  }));
}

function listHerdrModelCatalogue(hub: Hub, headers: Headers): Response {
  return jsonResponse(
    modelCatalogueFor(hub).snapshot(modelCatalogueLaunchers(hub)),
    200,
    headers,
  );
}

async function refreshHerdrModelCatalogue(
  hub: Hub,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body).andThen((object) => {
    for (const field of ["argv", "executable", "env", "modelArgs", "harness"] as const) {
      if (Object.hasOwn(object, field)) {
        return Result.err(validationFailed(field, "is not accepted for catalogue refresh"));
      }
    }
    return optionalString(object, "launcher");
  });
  if (parsed.isErr()) return errorResponse(parsed.error, headers);
  const launchers = modelCatalogueLaunchers(hub);
  const target = parsed.value;
  if (target !== null && !launchers.some((launcher) => launcher.name === target)) {
    return errorResponse(validationFailed("launcher", "is not a configured launcher"), headers);
  }
  const snapshot = await modelCatalogueFor(hub).refresh(
    launchers,
    target === null ? undefined : target,
  );
  return jsonResponse(snapshot, 200, headers);
}

function createHerdrModel(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) =>
      Result.gen(function* () {
        const rawHarness = yield* requiredString(object, "harness");
        const harness = yield* validName(rawHarness, "harness");
        const rawName = yield* requiredString(object, "name");
        const name = yield* validModelIdentifier(rawName, "name");
        const rawKind = yield* requiredString(object, "kind");
        if (rawKind !== "model" && rawKind !== "effort") {
          return Result.err(validationFailed("kind", "must be model or effort"));
        }
        const argvSuffix = yield* optionalStringArray(object, "argvSuffix");
        for (const argument of argvSuffix) {
          yield* validStoredText(argument, "argvSuffix");
          if (argument.length === 0) {
            return Result.err(validationFailed("argvSuffix", "must not contain empty arguments"));
          }
        }
        return Result.ok({ harness, name, kind: rawKind, argvSuffix });
      }),
    )
    .andThen((model) => hub.store.createModel(model))
    .match({
      ok: (model) => jsonResponse(modelEntryView(model), 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function deleteHerdrModel(
  hub: Hub,
  harness: string,
  name: string,
  headers: Headers,
): Response {
  return validName(harness, "harness")
    .andThen((validHarness) =>
      validModelIdentifier(name, "name").andThen((validModelName) =>
        hub.store.deleteModel(validHarness, validModelName),
      ),
    )
    .match({
      ok: (deleted) => jsonResponse(deleted, 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function launcherView(launcher: LauncherRecord): Launcher {
  return {
    name: launcher.name,
    agentKind: launcher.agentKind,
    argv: launcher.argv,
    envKeys: Object.keys(launcher.env).sort(),
    startTimeoutMs: launcher.startTimeoutMs,
  };
}

function launcherEnvironmentValue(
  raw: JsonValue | undefined,
  field: string,
): Result<Record<string, string>, ValidationFailed> {
  if (raw === undefined || raw === null) return Result.ok({});
  return decodeObject(raw).andThen((environment) =>
    Result.gen(function* () {
      const values: Record<string, string> = {};
      for (const key of Object.keys(environment)) {
        values[key] = yield* requiredString(environment, key);
      }
      const validated = yield* validLauncherEnvironment(values, field);
      return Result.ok(validated);
    }),
  );
}

function launcherEnvironment(
  object: JsonObject,
  field: string,
): Result<Record<string, string>, ValidationFailed> {
  return launcherEnvironmentValue(object[field], field);
}

interface LauncherEnvironmentPatch {
  set: Record<string, string>;
  remove: readonly string[];
}

function launcherEnvironmentPatch(
  object: JsonObject,
): Result<LauncherEnvironmentPatch | null, ValidationFailed> {
  const raw = object.envPatch;
  if (raw === undefined || raw === null) return Result.ok(null);
  return decodeObject(raw).andThen((patch) =>
    Result.gen(function* () {
      const set = yield* launcherEnvironmentValue(patch.set, "envPatch.set");
      const remove = yield* optionalStringArray(patch, "remove");
      const unique = new Set<string>();
      for (const key of remove) {
        if (unique.has(key)) return Result.err(validationFailed("envPatch.remove", "must not contain duplicates"));
        unique.add(key);
        const keyValidation = validLauncherEnvironment({ [key]: "" }, "envPatch.remove");
        if (keyValidation.isErr()) return Result.err(keyValidation.error);
        if (Object.hasOwn(set, key)) {
          return Result.err(validationFailed("envPatch", "set and remove must not overlap"));
        }
      }
      return Result.ok({ set, remove });
    }),
  );
}

function launcherDefinition(
  body: JsonValue,
  defaultStartTimeoutMs = HERDR_AGENT_START_TIMEOUT_MS,
): Result<Pick<LauncherDefinition, "agentKind" | "argv" | "startTimeoutMs" | "env">, ValidationFailed> {
  return decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawAgentKind = yield* requiredString(object, "agentKind");
      const agentKind = yield* validName(rawAgentKind, "agentKind");
      const rawArgv = yield* optionalStringArray(object, "argv");
      const argv = yield* validLauncherArgv(rawArgv);
      const env = yield* launcherEnvironment(object, "env");
      const startTimeoutMs = yield* optionalInteger(
        object,
        "startTimeoutMs",
        defaultStartTimeoutMs,
      );
      if (startTimeoutMs <= 0 || startTimeoutMs > MAX_AGENT_START_TIMEOUT_MS) {
        return Result.err(
          validationFailed(
            "startTimeoutMs",
            `must be from 1 through ${MAX_AGENT_START_TIMEOUT_MS}`,
          ),
        );
      }
      return Result.ok({ agentKind, argv, startTimeoutMs, env });
    }),
  );
}

function launcherUpdateDefinition(
  body: JsonValue,
  current: LauncherRecord,
): Result<Pick<LauncherDefinition, "agentKind" | "argv" | "startTimeoutMs" | "env">, ValidationFailed> {
  return decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawAgentKind = yield* optionalString(object, "agentKind");
      const agentKind = rawAgentKind === null ? current.agentKind : yield* validName(rawAgentKind, "agentKind");
      const argv = yield* (Object.hasOwn(object, "argv")
        ? optionalStringArray(object, "argv")
        : Result.ok([...current.argv])).andThen((value) => validLauncherArgv(value));
      const startTimeoutMs = yield* optionalInteger(object, "startTimeoutMs", current.startTimeoutMs);
      if (startTimeoutMs <= 0 || startTimeoutMs > MAX_AGENT_START_TIMEOUT_MS) {
        return Result.err(validationFailed("startTimeoutMs", `must be from 1 through ${MAX_AGENT_START_TIMEOUT_MS}`));
      }
      const patch = yield* launcherEnvironmentPatch(object);
      const env = { ...current.env };
      if (patch !== null) {
        for (const key of patch.remove) delete env[key];
        Object.assign(env, patch.set);
        yield* validLauncherEnvironment(env, "envPatch");
      }
      return Result.ok({ agentKind, argv, startTimeoutMs, env });
    }),
  );
}

function listHerdrLaunchers(hub: Hub, headers: Headers): Response {
  return jsonResponse(
    { launchers: hub.store.listLaunchers().map(launcherView) },
    200,
    headers,
  );
}

function createHerdrLauncher(hub: Hub, body: JsonValue, headers: Headers): Response {
  return decodeObject(body)
    .andThen((object) => requiredString(object, "name"))
    .andThen((name) => validName(name, "name"))
    .andThen((name) =>
      launcherDefinition(body).andThen((definition) =>
        hub.store.createLauncher({ name, ...definition }),
      ),
    )
    .match({
      ok: (launcher) => jsonResponse(launcherView(launcher), 201, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function updateHerdrLauncher(
  hub: Hub,
  name: string,
  body: JsonValue,
  headers: Headers,
): Response {
  return decodeObject(body)
    .andThen((object) =>
      Object.hasOwn(object, "name")
        ? Result.err(validationFailed("name", "is immutable"))
        : Result.ok(object),
    )
    .andThen(() => validName(name, "name"))
    .andThen((validLauncherName) => {
      const current = hub.store.launcher(validLauncherName);
      return current === null
        ? Result.err(notFound(`Launcher "${validLauncherName}"`))
        : launcherUpdateDefinition(body, current).andThen((definition) =>
            hub.store.updateLauncher(validLauncherName, definition),
          );
    })
    .match({
      ok: (launcher) => jsonResponse(launcherView(launcher), 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function deleteHerdrLauncher(hub: Hub, name: string, headers: Headers): Response {
  return validName(name, "name")
    .andThen((validLauncherName) => hub.store.deleteLauncher(validLauncherName))
    .match({
      ok: (deleted) => jsonResponse(deleted, 200, headers),
      err: (error) => errorResponse(error, headers),
    });
}

function herdrAgentIdentity(hub: Hub, paneId: string, headers: Headers): Response {
  const participant = hub.store.findActiveAgentByPaneId(paneId);
  return jsonResponse({ handle: participant?.handle ?? null }, 200, headers);
}

async function connectHerdrAgent(
  hub: Hub,
  paneId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const validPaneId = validStoredText(paneId, "paneId");
  if (validPaneId.isErr()) return errorResponse(validPaneId.error, headers);
  const requestedHandle = decodeObject(body)
    .andThen((object) => requiredString(object, "handle"))
    .andThen((handle) => validName(handle, "handle"));
  if (requestedHandle.isErr()) return errorResponse(requestedHandle.error, headers);

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);
  const listed = await herdr.value.paneList();
  if (listed.isErr()) return errorResponse(listed.error, headers);
  const pane = listed.value.find((candidate) => candidate.paneId === validPaneId.value);
  if (pane === undefined) return errorResponse(notFound("Pane"), headers);
  if (pane.agent === null) {
    return errorResponse(validationFailed("paneId", "has no agent occupant"), headers);
  }

  const routed = hub.store.participantRouteForTerminal(pane.terminalId);
  const reusable = routed?.kind === "agent" && routed.occupantAgent === pane.agent ? routed : null;
  const created = reusable === null ? hub.store.createAgent(requestedHandle.value) : null;
  if (created?.isErr()) return errorResponse(created.error, headers);
  const participant = reusable ?? created?.value.participant;
  if (participant === undefined) {
    return errorResponse(herdrCallFailed("agent identity was not created", "pane connect"), headers);
  }

  const relisted = await herdr.value.paneList();
  const current = relisted.isOk()
    ? relisted.value.find((candidate) => candidate.paneId === validPaneId.value)
    : undefined;
  if (
    current === undefined ||
    current.terminalId !== pane.terminalId ||
    current.agent !== pane.agent
  ) {
    if (created?.isOk()) hub.store.deactivateParticipant(created.value.participant.handle);
    return errorResponse(validationFailed("paneId", "changed while connecting"), headers);
  }

  hub.store.bindRoute(participant.id, {
    terminalId: current.terminalId,
    paneId: current.paneId,
    occupantAgent: current.agent,
  });
  await hub.topology?.refresh();
  return jsonResponse(
    { handle: participant.handle, paneId: current.paneId },
    reusable === null ? 201 : 200,
    headers,
  );
}

/**
 * Serves one window of an agent's harness session.
 *
 * Operator-only, the prompt endpoint's shape: a transcript carries every tool
 * result the agent ever saw, and an agent reading another agent's session over
 * HTTP is the never-run-another's-token rule bypassed by proxy.
 *
 * The three outcomes stay distinct on the wire — a harness with no reader, a
 * pane with no session, and a reader that could not look are different facts,
 * and only the second one is emptiness.
 */
async function herdrAgentSession(
  hub: Hub,
  caller: Participant,
  paneId: string,
  url: URL,
  headers: Headers,
): Promise<Response> {
  if (caller.kind !== "human") {
    return errorResponse(operatorOnly("read an agent's session"), headers);
  }
  const validPaneId = validStoredText(paneId, "paneId");
  if (validPaneId.isErr()) return errorResponse(validPaneId.error, headers);

  const requestedLimit = integerFromQuery(url, "limit", DEFAULT_TURN_LIMIT);
  if (requestedLimit.isErr()) return errorResponse(requestedLimit.error, headers);
  const limit = clampLimit(requestedLimit.value, DEFAULT_TURN_LIMIT, DEFAULT_TURN_LIMIT * 4);
  const requestedBefore = integerFromQuery(url, "before", 0);
  if (requestedBefore.isErr()) return errorResponse(requestedBefore.error, headers);
  const before = requestedBefore.value > 0 ? requestedBefore.value : null;

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);
  const listed = await herdr.value.paneList();
  if (listed.isErr()) return errorResponse(herdrCallFailed("pane list", "session lookup"), headers);
  const pane = listed.value.find((candidate) => candidate.paneId === paneId);
  if (pane === undefined) return errorResponse(notFound("Pane"), headers);

  const adapter = adapterFor(pane.agent);
  // No reader for this harness is a gap in what the hub can do, not a statement
  // about the agent. It is named, and it is never dressed as an empty session.
  if (adapter.isErr()) return sessionResponse("unsupported", pane.agent, headers);
  const harness = adapter.value.harness;
  if (pane.cwd === undefined) return sessionResponse("absent", harness, headers);

  const reader = hub.windowReader ?? bunWindowReader();
  const participant = hub.store.findActiveAgentByPaneId(paneId);
  const stored = hub.store.findSessionMapping(pane.terminalId);
  const storedForHarness = stored !== null && stored.harness === harness ? stored : null;

  // The harness must match, not only the terminal. A terminal outlives the
  // agent inside it — that is why the mapping is keyed on it — so a stopped
  // claude and a started codex share one terminal id. Reading the old
  // transcript with the new adapter raises no error: every line parses to no
  // turn, so the answer would be READY with an empty session, and the stored
  // row is never revisited to correct it.
  // Use the immutable launch environment. A later launcher edit must not move
  // session lookup to a different account or profile.
  const launchRecord =
    hub.store.lifecycleAgentForPane(paneId) ??
    (pane.terminalId === null ? null : hub.store.lifecycleAgentForTerminal(pane.terminalId));
  const launchEnvironment = { ...process.env, ...launchRecord?.launchEnv };
  const located = await adapter.value.locate({ cwd: pane.cwd, env: launchEnvironment }, reader);
  if (located.isErr()) {
    if (storedForHarness !== null) {
      const window = await readWindow(adapter.value, storedForHarness.session_path, reader, { before, limit });
      if (window.isOk()) {
        const mapping = { confidence: storedConfidence(storedForHarness.confidence), candidates: [] };
        return readySession(window.value, harness, storedForHarness.session_path, mapping, headers);
      }
    }
    return sessionResponse("error", harness, headers, { reason: located.error.reason });
  }
  if (located.value.length === 0) {
    if (storedForHarness !== null) {
      const window = await readWindow(adapter.value, storedForHarness.session_path, reader, { before, limit });
      if (window.isOk()) {
        const storedView = { confidence: storedConfidence(storedForHarness.confidence), candidates: [] };
        return readySession(window.value, harness, storedForHarness.session_path, storedView, headers);
      }
    }
    return sessionResponse("absent", harness, headers);
  }

  const mapping = chooseSession(located.value, {
    handle: participant?.handle ?? null,
    startedAt: participant?.createdAt ?? null,
  });
  const storedCandidate = storedForHarness === null
    ? undefined
    : located.value.find(
        (candidate) =>
          candidate.sessionId === storedForHarness.session_id &&
          candidate.path === storedForHarness.session_path,
      );
  const freshMappingMakesStoredStale = storedForHarness !== null &&
    mapping.chosen !== null &&
    (mapping.chosen.sessionId !== storedForHarness.session_id ||
      mapping.chosen.path !== storedForHarness.session_path);

  if (storedForHarness !== null && !freshMappingMakesStoredStale && storedCandidate !== undefined) {
    const window = await readWindow(adapter.value, storedForHarness.session_path, reader, { before, limit });
    // A stored path that no longer reads is not reported as a failure. The
    // harness may have written a new session, so the ladder is run again.
    if (window.isOk()) {
      const storedView = { confidence: storedConfidence(storedForHarness.confidence), candidates: [] };
      return readySession(window.value, harness, storedForHarness.session_path, storedView, headers);
    }
  }

  if (mapping.chosen === null) {
    return sessionResponse("ambiguous", harness, headers, {
      mapping: { confidence: mapping.confidence, candidates: mapping.candidates },
    });
  }

  // Keyed on the terminal id: a pane move changes the pane id and leaves the
  // terminal, and its session, exactly where they were.
  hub.store.saveSessionMapping({
    terminal_id: pane.terminalId,
    harness,
    session_id: mapping.chosen.sessionId,
    session_path: mapping.chosen.path,
    confidence: mapping.confidence,
  });

  const window = await readWindow(adapter.value, mapping.chosen.path, reader, { before, limit });
  if (window.isErr()) {
    return sessionResponse("error", harness, headers, { reason: window.error.reason });
  }
  return readySession(
    window.value,
    harness,
    mapping.chosen.path,
    { confidence: mapping.confidence, candidates: mapping.candidates },
    headers,
  );
}

function selectedSessionId(body: JsonValue): Result<string, ValidationFailed> {
  return decodeObject(body).andThen((object) => {
    const unexpected = Object.keys(object).find((field) => field !== "sessionId");
    if (unexpected !== undefined) {
      return Result.err(validationFailed(unexpected, "is not accepted; send sessionId only"));
    }
    return requiredString(object, "sessionId").andThen((sessionId) => {
      if (sessionId.length === 0) return Result.err(validationFailed("sessionId", "must not be empty"));
      return validStoredText(sessionId, "sessionId");
    });
  });
}

type SessionPaneChangedField = "terminalId" | "agent" | "cwd";

function sessionPaneChangedField(
  initial: PaneInfo,
  current: PaneInfo,
): SessionPaneChangedField | null {
  if (initial.terminalId !== current.terminalId) return "terminalId";
  if (initial.agent !== current.agent) return "agent";
  if (initial.cwd !== current.cwd) return "cwd";
  return null;
}

/**
 * Persists one operator choice from the current candidate set.
 *
 * The client supplies only the opaque session id. The path, harness, cwd, and
 * terminal id all come from a fresh pane list and the matching adapter.
 */
async function selectHerdrAgentSession(
  hub: Hub,
  caller: Participant,
  paneId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  if (caller.kind !== "human") {
    return errorResponse(operatorOnly("select an agent's session"), headers);
  }
  const validPaneId = validStoredText(paneId, "paneId");
  if (validPaneId.isErr()) return errorResponse(validPaneId.error, headers);

  const selected = selectedSessionId(body);
  if (selected.isErr()) return errorResponse(selected.error, headers);

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);
  const listed = await herdr.value.paneList();
  if (listed.isErr()) return errorResponse(herdrCallFailed("pane list", "session selection"), headers);
  const pane = listed.value.find((candidate) => candidate.paneId === paneId);
  if (pane === undefined) return errorResponse(notFound("Pane"), headers);
  if (pane.agent === null) {
    return errorResponse(validationFailed("paneId", "has no agent occupant"), headers);
  }
  if (pane.cwd === undefined) {
    return errorResponse(validationFailed("paneId", "has no current working directory"), headers);
  }

  const adapter = adapterFor(pane.agent);
  if (adapter.isErr()) {
    return errorResponse(validationFailed("paneId", "has no supported session reader"), headers);
  }

  const reader = hub.windowReader ?? bunWindowReader();
  const launchRecord =
    hub.store.lifecycleAgentForPane(paneId) ??
    (pane.terminalId === null ? null : hub.store.lifecycleAgentForTerminal(pane.terminalId));
  const launchEnvironment = { ...process.env, ...launchRecord?.launchEnv };
  const located = await adapter.value.locate({ cwd: pane.cwd, env: launchEnvironment }, reader);
  if (located.isErr()) {
    return errorResponse(herdrCallFailed("session locator", "session selection"), headers);
  }

  const relisted = await herdr.value.paneList();
  if (relisted.isErr()) {
    return errorResponse(herdrCallFailed("pane list", "session selection"), headers);
  }
  const currentPane = relisted.value.find((candidate) => candidate.paneId === paneId);
  if (currentPane === undefined) return errorResponse(notFound("Pane"), headers);
  const changedField = sessionPaneChangedField(pane, currentPane);
  if (changedField !== null) {
    return errorResponse(
      validationFailed("paneId", `changed while selecting; ${changedField} no longer matches`),
      headers,
    );
  }

  const participant = hub.store.findActiveAgentByPaneId(paneId);
  const mapping = chooseSession(located.value, {
    handle: participant?.handle ?? null,
    startedAt: participant?.createdAt ?? null,
  });
  if (mapping.confidence !== "ambiguous") {
    return errorResponse(
      validationFailed("sessionId", "can only be selected when the current mapping is ambiguous"),
      headers,
    );
  }

  const matches = mapping.candidates.filter((candidate) => candidate.sessionId === selected.value);
  if (matches.length !== 1) {
    const problem = matches.length === 0
      ? "is not a current candidate for this pane"
      : "matches more than one current candidate";
    return errorResponse(validationFailed("sessionId", problem), headers);
  }
  const candidate = matches[0];
  if (candidate === undefined) {
    // The length guard above makes this unreachable. Keep the narrowing
    // explicit so a future change cannot save an undefined path.
    return errorResponse(validationFailed("sessionId", "must identify one current candidate"), headers);
  }

  hub.store.saveSessionMapping({
    terminal_id: pane.terminalId,
    harness: adapter.value.harness,
    session_id: candidate.sessionId,
    session_path: candidate.path,
    confidence: "exact",
  });

  const selectedView: AgentSessionSelectionView = {
    state: "ready",
    sessionId: candidate.sessionId,
  };
  return jsonResponse(selectedView, 200, headers);
}

/**
 * A stored row's confidence, narrowed back to the contract. The table's CHECK
 * admits only the two decided values, so anything else is a row written by a
 * future version and reads as the weaker claim.
 */
function storedConfidence(value: string): MappingConfidence {
  return value === "exact" ? "exact" : "inferred";
}

/** Every state but `ready` carries no turns, and says which state it is. */
function sessionResponse(
  state: Exclude<SessionState, "ready">,
  harness: string | null,
  headers: Headers,
  extra: { reason?: string; mapping?: SessionMappingView } = {},
): Response {
  const view: AgentSessionView = {
    turns: [],
    nextBefore: null,
    source: {
      state,
      harness,
      sessionPath: null,
      glance: null,
      reason: extra.reason ?? null,
    },
    mapping: extra.mapping ?? null,
  };
  return jsonResponse(view, 200, headers);
}

function readySession(
  window: SessionWindow,
  harness: string,
  sessionPath: string,
  mapping: SessionMappingView,
  headers: Headers,
): Response {
  const view: AgentSessionView = {
    turns: window.turns,
    nextBefore: window.nextBefore,
    source: {
      state: "ready",
      harness,
      sessionPath,
      // The last thing the agent actually said, or nothing. No tool output is
      // promoted to fill the line.
      glance: glanceLine(window.turns),
      reason: null,
    },
    mapping,
  };
  return jsonResponse(view, 200, headers);
}

async function cleanupLifecycleSpawn(
  hub: Hub,
  herdr: HerdrPort,
  operation: LifecycleSpawnOperation,
): Promise<Result<void, ReturnType<typeof herdrCallFailed>>> {
  const participant =
    operation.participantId === null ? null : hub.store.findById(operation.participantId);
  if (operation.paneId === null || operation.terminalId === null) {
    if (participant !== null) hub.store.removeUnboundAgent(participant.id);
    return Result.ok();
  }

  const listed = await herdr.paneList();
  if (listed.isErr()) return Result.err(lifecycleCleanupFailure(operation.paneId));
  const pane = listed.value.find((candidate) => candidate.paneId === operation.paneId);
  const preStartPlainShell =
    pane !== undefined &&
    !operation.baselinePanes.includes(operation.paneId) &&
    pane.terminalId === operation.terminalId &&
    pane.agent === null;
  const identityMatches =
    pane !== undefined &&
    participant !== null &&
    operation.assignedHandle !== null &&
    pane.terminalId === operation.terminalId &&
    pane.agent === operation.harness &&
    pane.label === operation.assignedHandle &&
    participant.handle === operation.assignedHandle;
  if (!identityMatches && !preStartPlainShell) {
    return Result.err(lifecycleCleanupIdentityUnknown(operation.paneId));
  }

  const closed = await herdr.paneClose(operation.paneId);
  if (closed.isErr()) {
    return Result.err(lifecycleCleanupFailure(operation.paneId));
  }

  if (participant !== null) {
    const routeBelongsToOperation =
      participant.paneId === operation.paneId && participant.terminalId === operation.terminalId;
    if (routeBelongsToOperation) hub.store.markRouteStale(participant.id);
    hub.store.removeLifecycleAgent(operation.paneId, participant.id);
    hub.store.removeEmptyLifecycleAgent(participant.id);
  }
  return Result.ok();
}

function finalizeLifecycleSpawn(
  hub: Hub,
  caller: Participant,
  operation: LifecycleSpawnOperation,
  confirmed: ConfirmedLifecycleSpawn,
): Result<WorkspaceMembershipChange | null, ApiError> {
  if (
    operation.participantId === null ||
    operation.paneId === null ||
    operation.terminalId === null ||
    operation.assignedHandle === null ||
    operation.assignedHandle !== confirmed.handle ||
    operation.paneId !== confirmed.paneId
  ) {
    return Result.err(
      herdrCallFailed("spawn operation is incomplete", "control plane", "reported", operation.paneId),
    );
  }

  const participant = hub.store.findById(operation.participantId);
  if (participant === null || participant.handle !== confirmed.handle) {
    return Result.err(
      herdrCallFailed("spawn participant is missing", "control plane", "reported", operation.paneId),
    );
  }

  const registered = Result.try({
    try: () =>
      hub.store.registerLifecycleAgent(
        operation.workspaceId,
        confirmed.paneId,
        operation.terminalId,
        participant.id,
        operation.role,
        operation.harness,
        operation.launchEnv,
      ),
      catch: () =>
        herdrCallFailed("lifecycle record failed", "agent start", "unknown", operation.paneId),
  });
  if (registered.isErr()) return registered;

  let membershipChange: WorkspaceMembershipChange | null = null;
  if (operation.role === "reporter") {
    const ensured = hub.store.ensureWorkspaceMembers(workspaceChannelName(operation.workspaceId), [
      caller.id,
      participant.id,
    ]);
    if (ensured.isErr()) return ensured;
    membershipChange = ensured.value;
  }

  hub.store.completeLifecycleSpawn(operation.operationKey);
  return Result.ok(membershipChange);
}

function lifecycleFailureWithPane(
  error: ApiError,
  paneId: string | null,
): ApiError {
  if (!HerdrCallFailed.is(error)) return error;
  const targetPane = paneId ?? error.paneId;
  if (targetPane === null) {
    const detail = error.kind === "timeout"
      ? `${error.command} timed out; pane identity is unknown; cleanup state is unresolved`
      : `${error.command} failed; pane identity is unknown; cleanup state is unresolved`;
    return herdrCallFailed(detail, error.command, error.kind, null);
  }
  const detail =
    error.kind === "timeout"
      ? `timed out while starting pane ${targetPane}`
      : error.kind !== "reported"
        ? `${error.command} failed while starting pane ${targetPane}`
        : `${error.command} failed`;
  return herdrCallFailed(detail, error.command, error.kind, targetPane);
}

async function failLifecycleSpawnRequest(
  hub: Hub,
  herdr: HerdrPort,
  operation: LifecycleSpawnOperation,
  primary: ApiError,
  headers: Headers,
  membershipChange: WorkspaceMembershipChange | null = null,
): Promise<Response> {
  if (membershipChange !== null) {
    hub.store.rollbackWorkspaceMembers(
      membershipChange.channel,
      membershipChange.addedParticipantIds,
      membershipChange.created,
    );
  }
  const failure = lifecycleFailureWithPane(primary, operation.paneId);
  hub.store.failLifecycleSpawn(operation.operationKey);

  const safeToRollback = !HerdrCallFailed.is(failure) || failure.kind === "reported";
  if (!safeToRollback) {
    const reason = HerdrCallFailed.is(failure) && failure.kind === "timeout" ? "timeout" : null;
    hub.store.recordLifecycleSpawnCleanup(operation.operationKey, "skipped", reason);
    return errorResponse(failure, headers);
  }

  const cleaned = await cleanupLifecycleSpawn(hub, herdr, operation);
  if (cleaned.isErr()) {
    hub.store.recordLifecycleSpawnCleanup(
      operation.operationKey,
      "failed",
      cleaned.error.message,
    );
    return errorResponse(cleaned.error, headers);
  }
  const outcome = operation.paneId === null ? "skipped" : "closed";
  hub.store.recordLifecycleSpawnCleanup(operation.operationKey, outcome);
  return errorResponse(failure, headers);
}

async function spawnHerdrAgent(
  hub: Hub,
  caller: Participant,
  body: JsonValue,
  requestHeaders: Headers,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body).andThen((object) => {
    if (Object.hasOwn(object, "argv")) {
      return Result.err(validationFailed("argv", "is accepted only when defining a launcher"));
    }
    if (Object.hasOwn(object, "harness")) {
      return Result.err(validationFailed("harness", "has been replaced by launcher"));
    }
    return Result.gen(function* () {
      const workspaceId = yield* requiredString(object, "workspaceId");
      const validatedWorkspaceId = yield* validStoredText(workspaceId, "workspaceId");
      const rawLauncher = yield* requiredString(object, "launcher");
      const launcher = yield* validName(rawLauncher, "launcher");
      const rawRole = yield* optionalString(object, "role");
      const role = rawRole === null ? null : yield* validStoredText(rawRole, "role");
      const rawModel = yield* optionalString(object, "model");
      const model = rawModel === null ? null : yield* validModelIdentifier(rawModel, "model");
      const rawEffort = yield* optionalString(object, "effort");
      const effort = rawEffort === null ? null : yield* validModelIdentifier(rawEffort, "effort");
      const rawGoal = yield* optionalString(object, "goal");
      const goal = rawGoal === null ? null : yield* validBody(rawGoal);
      const requestedHandle = yield* requiredString(object, "handle");
      const handle = yield* validName(requestedHandle, "handle");
      return Result.ok({
        workspaceId: validatedWorkspaceId,
        launcher,
        role,
        model,
        effort,
        goal,
        handle,
      });
    });
  });
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  const request = parsed.value;
  return withLifecycleLock(hub, request.workspaceId, async () => {
    const role = request.role === null ? null : findExactRole(hub, request.role);
    if (request.role !== null && role === null) {
      return errorResponse(validationFailed("role", "is not an available role"), headers);
    }

    const launcher = findExactLauncher(hub, request.launcher);
    if (launcher === null) {
      return errorResponse(validationFailed("launcher", "is not an available launcher"), headers);
    }

    if (role !== null && role.agentKind !== null && launcher.agentKind !== role.agentKind) {
      return errorResponse(
        validationFailed("launcher", "does not match the selected role agent kind"),
        headers,
      );
    }

    const nativeLead = role?.native === true && role.name === "lead";

    // The request overrides the role's defaults; the server resolves catalogue
    // names to argv, so a client never sends command fragments.
    const modelName = request.model ?? role?.model ?? null;
    const effortName = request.effort ?? role?.effort ?? null;
    let optionArgv: readonly string[];
    const catalogue = modelCatalogueFor(hub);
    const deviceLauncher: DeviceLauncher = {
      name: launcher.name,
      harness: launcher.agentKind,
      argv: launcher.argv,
      env: launcher.env,
      revision: launcher.revision,
    };
    if (modelName === null && effortName === null) {
      optionArgv = [];
    } else if (catalogue.supportsHarness(launcher.agentKind)) {
      const resolved = catalogue.resolveSelection(deviceLauncher, modelName, effortName);
      if (!resolved.ok) {
        return errorResponse(validationFailed(resolved.field, resolved.reason), headers);
      }
      optionArgv = resolved.argvSuffix;
    } else {
      // The curated registry remains the compatibility path for custom
      // launchers whose harness has no device adapter. Registered adapters
      // always validate against the exact launcher catalogue above.
      const curatedModel = modelName === null ? null : hub.store.model(launcher.agentKind, modelName);
      const curatedEffort = effortName === null ? null : hub.store.model(launcher.agentKind, effortName);
      if (
        (modelName !== null && curatedModel?.kind !== "model") ||
        (effortName !== null && curatedEffort?.kind !== "effort")
      ) {
        return errorResponse(
          validationFailed(modelName !== null && curatedModel?.kind !== "model" ? "model" : "effort", "is not available for this launcher"),
          headers,
        );
      }
      optionArgv = [
        ...(curatedModel?.argvSuffix ?? []),
        ...(curatedEffort?.argvSuffix ?? []),
      ];
    }
    const spawnArgv = [...launcher.argv, ...optionArgv];

    const operationRequest = {
      workspaceId: request.workspaceId,
      launcher: launcher.name,
      launcherRevision: launcher.revision,
      role: role?.name ?? null,
      handle: request.handle,
    } satisfies LifecycleOperationRequest;
    const operationKey = lifecycleOperationKey(caller.id, operationRequest, requestHeaders);
    if (operationKey.isErr()) return errorResponse(operationKey.error, headers);

    let operation = hub.store.lifecycleSpawnOperation(operationKey.value);
    if (operation !== null && !lifecycleOperationMatches(operation, caller.id, operationRequest)) {
      return errorResponse(
        validationFailed("idempotency-key", "does not match the original spawn request"),
        headers,
      );
    }

    if (operation !== null && operation.status === "committed") {
      if (
        operation.assignedHandle === null ||
        operation.participantId === null ||
        operation.paneId === null
      ) {
        return errorResponse(
          herdrCallFailed(
            "stored spawn operation is incomplete",
            "control plane",
            "reported",
            operation.paneId,
          ),
          headers,
        );
      }
      const confirmed = await confirmLifecycleSpawn(
        hub,
        operation.workspaceId,
        operation.paneId,
        operation.participantId,
        operation.assignedHandle,
        operation.harness,
      );
      if (confirmed.isErr()) {
        return errorResponse(lifecycleFailureWithPane(confirmed.error, operation.paneId), headers);
      }
      const finalized = finalizeLifecycleSpawn(hub, caller, operation, confirmed.value);
      if (finalized.isErr()) return errorResponse(finalized.error, headers);
      return jsonResponse(
        { paneId: confirmed.value.paneId, handle: confirmed.value.handle },
        201,
        headers,
      );
    }

    if (operation !== null && operation.status === "failed" && operation.cleanupOutcome === "closed") {
      hub.store.resetLifecycleSpawnOperation(operation.operationKey);
      operation = hub.store.lifecycleSpawnOperation(operation.operationKey);
    }

    if (operation !== null && (operation.participantId !== null || operation.paneId !== null)) {
      if (
        operation.assignedHandle !== null &&
        operation.participantId !== null &&
        operation.paneId !== null
      ) {
        const configuredHerdr = herdrPort(hub);
        if (configuredHerdr.isErr()) return errorResponse(configuredHerdr.error, headers);
        const rebound = await bindLifecycleSpawnRoute(hub, configuredHerdr.value, operation, true);
        if (rebound.isErr()) {
          return failLifecycleSpawnRequest(
            hub,
            configuredHerdr.value,
            operation,
            rebound.error,
            headers,
          );
        }
        const confirmed = await confirmLifecycleSpawn(
          hub,
          operation.workspaceId,
          operation.paneId,
          operation.participantId,
          operation.assignedHandle,
          operation.harness,
        );
        if (confirmed.isOk()) {
          const finalized = finalizeLifecycleSpawn(hub, caller, operation, confirmed.value);
          if (finalized.isOk()) {
            return jsonResponse(
              { paneId: confirmed.value.paneId, handle: confirmed.value.handle },
              201,
              headers,
            );
          }
          return failLifecycleSpawnRequest(
            hub,
            configuredHerdr.value,
            operation,
            finalized.error,
            headers,
          );
        }
        if (confirmed.isErr()) {
          return failLifecycleSpawnRequest(
            hub,
            configuredHerdr.value,
            operation,
            confirmed.error,
            headers,
          );
        }
      }

      const failure = herdrCallFailed(
        "stored spawn operation is incomplete",
        "control plane",
        "reported",
        operation.paneId,
      );
      const configuredHerdr = herdrPort(hub);
      if (configuredHerdr.isErr()) return errorResponse(configuredHerdr.error, headers);
      return failLifecycleSpawnRequest(
        hub,
        configuredHerdr.value,
        operation,
        failure,
        headers,
      );
    } else if (operation !== null) {
      hub.store.resetLifecycleSpawnOperation(operation.operationKey);
      operation = hub.store.lifecycleSpawnOperation(operation.operationKey);
    }

    const topology = await requiredTopology(hub);
    if (topology.isErr()) return errorResponse(topology.error, headers);
    const workspace = topology.value.snapshot().workspaces.find(
      (candidate) => candidate.id === request.workspaceId,
    );
    if (workspace === undefined) return errorResponse(notFound("Workspace"), headers);

    const livePanes = new Map(
      topology.value
        .livePanes()
        .filter((pane) => workspaceIdForPane(pane) === request.workspaceId)
        .map((pane) => [pane.paneId, pane]),
    );
    for (const record of hub.store.lifecycleAgents(request.workspaceId)) {
      if (!record.active) continue;
      const pane =
        record.terminalId === null
          ? undefined
          : [...livePanes.values()].find(
              (candidate) => candidate.terminalId === record.terminalId,
            );
      if (pane === undefined || pane.agent === null || pane.agent !== record.harness) {
        hub.store.deactivateLifecycleAgent(record.paneId);
      }
    }

    if (role?.name === "reporter" && hub.store.hasActiveLifecycleRole(request.workspaceId, "reporter")) {
      return errorResponse(validationFailed("role", "already has a reporter"), headers);
    }
    if (nativeLead && hub.store.hasActiveLifecycleRole(request.workspaceId, "lead")) {
      return errorResponse(validationFailed("role", "already has a lead"), headers);
    }
    if (hub.store.activeLifecycleAgentCount(request.workspaceId) >= MAX_ACTIVE_LIFECYCLE_AGENTS_PER_WORKSPACE) {
      return errorResponse(validationFailed("workspaceId", "has reached its active agent limit"), headers);
    }

    const rootPane = workspace.panes[0];
    if (rootPane === undefined) return errorResponse(notFound("Workspace root pane"), headers);
    const beforePaneIds = new Set(workspace.panes.map((pane) => pane.paneId));

    hub.store.beginLifecycleSpawnOperation(
      operationKey.value,
      caller.id,
      operationRequest.workspaceId,
      launcher.agentKind,
      operationRequest.launcher,
      operationRequest.launcherRevision,
      operationRequest.role,
      operationRequest.handle,
      launcher.env,
    );
    operation = hub.store.lifecycleSpawnOperation(operationKey.value);
    if (operation === null) {
      return errorResponse(herdrCallFailed("spawn operation was not recorded", "control plane"), headers);
    }

    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);
    hub.store.recordLifecycleSpawnBaseline(operation.operationKey, beforePaneIds);
    operation = hub.store.lifecycleSpawnOperation(operation.operationKey);
    if (operation === null) {
      return errorResponse(herdrCallFailed("spawn operation was not recorded", "control plane"), headers);
    }
    const created = hub.store.createLifecycleParticipant(operation.operationKey);
    if (created.isErr()) {
      hub.store.failLifecycleSpawn(operation.operationKey);
      return errorResponse(created.error, headers);
    }
    operation = hub.store.lifecycleSpawnOperation(operation.operationKey);
    if (operation === null) {
      return errorResponse(herdrCallFailed("spawn operation was not recorded", "control plane"), headers);
    }

    const assigned = created.value.participant.handle;
    const split = await herdr.value.paneSplit(rootPane.paneId, {
      env: {
        ...launcher.env,
        MSGR_URL: `http://${HOST}:${hub.config.port}`,
        MSGR_HANDLE: assigned,
        MSGR_TOKEN: created.value.token,
      },
    });
    if (split.isErr()) {
      return failLifecycleSpawnRequest(
        hub,
        herdr.value,
        operation,
        split.error,
        headers,
      );
    }

    const spawnedPane = split.value;
    hub.store.recordLifecycleSpawnPane(operation.operationKey, spawnedPane.paneId, spawnedPane.terminalId);
    operation = hub.store.lifecycleSpawnOperation(operation.operationKey);
    if (operation === null) {
      return errorResponse(herdrCallFailed("spawn operation was not recorded", "control plane"), headers);
    }
    if (workspaceIdForPane(spawnedPane) !== request.workspaceId) {
      return failLifecycleSpawnRequest(
        hub,
        herdr.value,
        operation,
        herdrCallFailed(
          "split returned a pane in another workspace",
          "pane split",
          "reported",
          spawnedPane.paneId,
        ),
        headers,
      );
    }

    const started = await startLifecycleAgent(
      herdr.value,
      spawnedPane.paneId,
      assigned,
      launcher.agentKind,
      spawnArgv,
      launcher.startTimeoutMs,
    );
    if (started.isErr()) {
      return failLifecycleSpawnRequest(
        hub,
        herdr.value,
        operation,
        started.error,
        headers,
      );
    }

    const bound = await bindLifecycleSpawnRoute(hub, herdr.value, operation);
    if (bound.isErr()) {
      return failLifecycleSpawnRequest(
        hub,
        herdr.value,
        operation,
        bound.error,
        headers,
      );
    }

    const firstPrompt = [
      role?.briefing ?? null,
      request.goal === null ? null : `OPERATOR GOAL: ${request.goal}`,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    if (firstPrompt.length > 0) {
      const briefed = await herdr.value.agentPrompt(spawnedPane.paneId, firstPrompt);
      if (briefed.isErr()) {
        return failLifecycleSpawnRequest(
          hub,
          herdr.value,
          operation,
          briefed.error,
          headers,
        );
      }
    }

    const confirmed = await confirmLifecycleSpawn(
      hub,
      request.workspaceId,
      spawnedPane.paneId,
      created.value.participant.id,
      assigned,
      launcher.agentKind,
    );
    if (confirmed.isErr()) {
      return failLifecycleSpawnRequest(hub, herdr.value, operation, confirmed.error, headers);
    }

    const finalized = finalizeLifecycleSpawn(hub, caller, operation, confirmed.value);
    if (finalized.isErr()) {
      return failLifecycleSpawnRequest(hub, herdr.value, operation, finalized.error, headers);
    }

    await ensureTopology(hub)?.refresh();
    return jsonResponse(
      { paneId: confirmed.value.paneId, handle: confirmed.value.handle },
      201,
      headers,
    );
  });
}

interface StopTarget {
  participantId: number | null;
  expected: string | null;
  routeMismatch: boolean;
}

function stopTarget(hub: Hub, pane: PaneInfo): StopTarget {
  const route = hub.store.agentRouteForTerminal(pane.terminalId);
  const candidate = route === null ? null : hub.store.findByHandle(route.handle);
  const activeRoute = route?.routeState === "active";
  const participant =
    activeRoute &&
    candidate?.paneId === pane.paneId &&
    candidate?.occupantAgent !== null &&
    candidate?.occupantAgent === pane.agent
      ? route
      : null;
  return {
    participantId: participant === null ? null : hub.store.findByHandle(participant.handle)?.id ?? null,
    expected:
      participant?.handle ??
      (activeRoute ? null : pane.label !== undefined && pane.label.length > 0 ? pane.label : null),
    routeMismatch: activeRoute && participant === null,
  };
}

/**
 * Only the operator's human identity may drive another agent's terminal: an
 * agent doing so over HTTP would bypass the never-run-another's-token rule.
 */
async function promptHerdrAgent(
  hub: Hub,
  caller: Participant,
  paneId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  if (caller.kind !== "human") {
    return errorResponse(operatorOnly("prompt an agent's pane"), headers);
  }
  const validPaneId = validStoredText(paneId, "paneId");
  if (validPaneId.isErr()) return errorResponse(validPaneId.error, headers);

  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "text"))
    .andThen((text) => validPromptText(text));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);

  const delivered = await herdr.value.agentPrompt(paneId, parsed.value);
  if (delivered.isErr()) {
    return delivered.error._tag === "NoAgentAtTarget"
      ? errorResponse(notFound("Pane"), headers)
      : errorResponse(delivered.error, headers);
  }
  return jsonResponse({ delivered: true }, 200, headers);
}

async function stopHerdrAgent(
  hub: Hub,
  paneId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const validPaneId = validStoredText(paneId, "paneId");
  if (validPaneId.isErr()) return errorResponse(validPaneId.error, headers);

  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "confirm"))
    .andThen((confirm) => validStoredText(confirm, "confirm"));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  return withLifecycleLock(hub, `pane:${paneId}`, async () => {
    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);
    const firstList = await herdr.value.paneList();
    if (firstList.isErr()) return errorResponse(lifecycleHerdrFailure("pane list"), headers);
    const first = firstList.value.find((pane) => pane.paneId === paneId);
    if (first === undefined) return errorResponse(notFound("Pane"), headers);
    const expected = stopTarget(hub, first);
    if (expected.expected === null) {
      return errorResponse(
        validationFailed(
          "confirm",
          expected.routeMismatch
            ? "does not match the current pane identity"
            : "cannot close an unnamed pane",
        ),
        headers,
      );
    }
    if (parsed.value !== expected.expected) {
      return errorResponse(validationFailed("confirm", "does not match the current pane identity"), headers);
    }

    const secondList = await herdr.value.paneList();
    if (secondList.isErr()) return errorResponse(lifecycleHerdrFailure("pane list"), headers);
    const second = secondList.value.find((pane) => pane.paneId === paneId);
    if (second === undefined) return errorResponse(notFound("Pane"), headers);
    const revalidated = stopTarget(hub, second);
    if (
      second.terminalId !== first.terminalId ||
      revalidated.expected !== expected.expected ||
      revalidated.participantId !== expected.participantId
    ) {
      return errorResponse(validationFailed("confirm", "pane identity changed; try again"), headers);
    }

    const closed = await herdr.value.paneClose(paneId);
    if (closed.isErr()) return errorResponse(lifecycleHerdrFailure("pane close"), headers);
    if (revalidated.participantId !== null) hub.store.markRouteStale(revalidated.participantId);
    hub.store.deactivateLifecycleAgent(paneId);
    await ensureTopology(hub)?.refresh();
    return jsonResponse({ paneId }, 200, headers);
  });
}

async function listHerdrWorkspaces(hub: Hub, headers: Headers): Promise<Response> {
  return jsonResponse(await currentTopology(hub), 200, headers);
}

interface DirectoryError {
  code?: string;
}

function isMissingDirectory(cause: unknown): boolean {
  // SAFETY: filesystem APIs expose an optional string error code; all other
  // thrown values are treated as non-directory failures.
  const error = cause as DirectoryError | null | undefined;
  return error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EACCES";
}

/**
 * Lists immediate child directories for the human-facing workspace picker.
 * The hub returns canonical absolute paths, never file contents. Symlinks are
 * not listed as children, so one browse step cannot silently cross a link.
 */
async function listHerdrDirectories(url: URL, headers: Headers): Promise<Response> {
  const rawPath = url.searchParams.get("path");
  const requestedPath = rawPath === null || rawPath.length === 0 ? homedir() : rawPath;
  if (!isAbsolute(requestedPath)) {
    return errorResponse(validationFailed("path", "must be an absolute path"), headers);
  }
  if (requestedPath.length > MAX_PATH_LENGTH) {
    return errorResponse(
      validationFailed("path", `must be at most ${MAX_PATH_LENGTH} characters`),
      headers,
    );
  }
  const validPath = validStoredText(requestedPath, "path");
  if (validPath.isErr()) return errorResponse(validPath.error, headers);

  const canonical = await Result.tryPromise({
    try: () => realpath(requestedPath),
    catch: (cause) => cause,
  });
  if (canonical.isErr()) {
    return errorResponse(
      isMissingDirectory(canonical.error) ? notFound("Directory") : validationFailed("path", "could not be read"),
      headers,
    );
  }

  const listed = await Result.tryPromise({
    try: () => readdir(canonical.value, { withFileTypes: true }),
    catch: (cause) => cause,
  });
  if (listed.isErr()) {
    return errorResponse(
      isMissingDirectory(listed.error) ? notFound("Directory") : validationFailed("path", "could not be read"),
      headers,
    );
  }

  const directories = listed.value
    .filter((entry) => entry.isDirectory())
    .filter((entry) => validStoredText(entry.name, "path").isOk())
    .map((entry) => ({ name: entry.name, path: join(canonical.value, entry.name) }))
    .filter((entry) => entry.path.length <= MAX_PATH_LENGTH)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const parent = dirname(canonical.value);
  return jsonResponse(
    {
      currentPath: canonical.value,
      parentPath: parent === canonical.value ? null : parent,
      directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
      truncated: directories.length > MAX_DIRECTORY_ENTRIES,
    },
    200,
    headers,
  );
}

async function createHerdrWorkspace(
  hub: Hub,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawLabel = yield* optionalString(object, "label");
      const rawCwd = yield* optionalString(object, "cwd");
      const label = rawLabel === null ? null : yield* validStoredText(rawLabel, "label");
      const cwd = rawCwd === null ? null : yield* validStoredText(rawCwd, "cwd");
      return Result.ok({ label, cwd });
    }),
  );
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);

  const created = await herdr.value.workspaceCreate(
    parsed.value.label === null || parsed.value.label.length === 0
      ? undefined
      : parsed.value.label,
    parsed.value.cwd === null || parsed.value.cwd.length === 0 ? undefined : parsed.value.cwd,
  );
  if (created.isErr()) return errorResponse(created.error, headers);

  await ensureTopology(hub)?.refresh();
  return jsonResponse({ workspace: created.value }, 201, headers);
}

async function createHerdrTab(
  hub: Hub,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body).andThen((object) =>
    Result.gen(function* () {
      const rawWorkspaceId = yield* requiredString(object, "workspaceId");
      const workspaceId = yield* validStoredText(rawWorkspaceId, "workspaceId");
      const rawLabel = yield* optionalString(object, "label");
      const label = rawLabel === null ? null : yield* validStoredText(rawLabel, "label");
      return Result.ok({ workspaceId, label });
    }),
  );
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  return withLifecycleLock(hub, `workspace:${parsed.value.workspaceId}`, async () => {
    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);

    const created = await herdr.value.tabCreate(
      parsed.value.workspaceId,
      parsed.value.label === null || parsed.value.label.length === 0
        ? undefined
        : parsed.value.label,
    );
    if (created.isErr()) return errorResponse(created.error, headers);

    await ensureTopology(hub)?.refresh();
    return jsonResponse({ tab: created.value }, 201, headers);
  });
}

async function renameHerdrTab(
  hub: Hub,
  tabId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const validTabId = validStoredText(tabId, "tabId");
  if (validTabId.isErr()) return errorResponse(validTabId.error, headers);

  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "label"))
    .andThen((label) => validStoredText(label, "label"));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  return withLifecycleLock(hub, `tab:${validTabId.value}`, async () => {
    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);
    const renamed = await herdr.value.tabRename(validTabId.value, parsed.value);
    if (renamed.isErr()) return errorResponse(renamed.error, headers);

    await ensureTopology(hub)?.refresh();
    return jsonResponse(
      {
        tabId: validTabId.value,
        label: parsed.value.length === 0 ? null : parsed.value,
      },
      200,
      headers,
    );
  });
}

async function focusHerdrTab(
  hub: Hub,
  tabId: string,
  headers: Headers,
): Promise<Response> {
  const validTabId = validStoredText(tabId, "tabId");
  if (validTabId.isErr()) return errorResponse(validTabId.error, headers);

  return withLifecycleLock(hub, `tab:${validTabId.value}`, async () => {
    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);
    const focused = await herdr.value.tabFocus(validTabId.value);
    if (focused.isErr()) return errorResponse(focused.error, headers);

    await ensureTopology(hub)?.refresh();
    return jsonResponse({ tabId: validTabId.value }, 200, headers);
  });
}

async function closeHerdrTab(
  hub: Hub,
  tabId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const validTabId = validStoredText(tabId, "tabId");
  if (validTabId.isErr()) return errorResponse(validTabId.error, headers);

  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "confirm"))
    .andThen((confirm) => validStoredText(confirm, "confirm"));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  return withLifecycleLock(hub, `tab:${validTabId.value}`, async () => {
    const herdr = herdrPort(hub);
    if (herdr.isErr()) return errorResponse(herdr.error, headers);

    const firstList = await herdr.value.tabList();
    if (firstList.isErr()) return errorResponse(firstList.error, headers);
    const first = firstList.value.find((tab) => tab.id === validTabId.value);
    if (first === undefined) return errorResponse(notFound("Tab"), headers);

    const expected = first.label ?? first.id;
    if (parsed.value !== expected) {
      return errorResponse(validationFailed("confirm", "does not match the tab label"), headers);
    }

    const secondList = await herdr.value.tabList();
    if (secondList.isErr()) return errorResponse(secondList.error, headers);
    const second = secondList.value.find((tab) => tab.id === validTabId.value);
    if (
      second === undefined ||
      second.workspaceId !== first.workspaceId ||
      second.label !== first.label
    ) {
      return errorResponse(validationFailed("confirm", "tab identity changed; try again"), headers);
    }

    const closed = await herdr.value.tabClose(validTabId.value);
    if (closed.isErr()) return errorResponse(closed.error, headers);

    await ensureTopology(hub)?.refresh();
    return jsonResponse({ tabId: validTabId.value }, 200, headers);
  });
}

async function closeHerdrWorkspace(
  hub: Hub,
  workspaceId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "confirm"))
    .andThen((confirm) => validStoredText(confirm, "confirm"));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  const topology = await requiredTopology(hub);
  if (topology.isErr()) return errorResponse(topology.error, headers);
  const workspace = topology.value.snapshot().workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) return errorResponse(notFound("Workspace"), headers);

  const expected = workspace.label ?? workspace.id;
  if (parsed.value !== expected) {
    return errorResponse(validationFailed("confirm", "does not match the workspace label"), headers);
  }

  const herdr = herdrPort(hub);
  if (herdr.isErr()) return errorResponse(herdr.error, headers);
  const closed = await herdr.value.workspaceClose(workspaceId);
  if (closed.isErr()) return errorResponse(closed.error, headers);

  await ensureTopology(hub)?.refresh();
  return jsonResponse({ workspaceId }, 200, headers);
}

async function broadcastToHerdrWorkspace(
  hub: Hub,
  caller: Participant,
  workspaceId: string,
  body: JsonValue,
  headers: Headers,
): Promise<Response> {
  const parsed = decodeObject(body)
    .andThen((object) => requiredString(object, "body"))
    .andThen((text) => validBody(text));
  if (parsed.isErr()) return errorResponse(parsed.error, headers);

  const topology = await requiredTopology(hub);
  if (topology.isErr()) return errorResponse(topology.error, headers);
  const workspace = topology.value.snapshot().workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) return errorResponse(notFound("Workspace"), headers);

  const recipients = workspace.panes.flatMap((pane) =>
    pane.participant === null || pane.participantRouteState !== "active"
      ? []
      : [pane.participant],
  );
  const sent = hub.store.broadcastWorkspace(
    caller.id,
    workspaceChannelName(workspace.id),
    recipients,
    parsed.value,
  );
  return sent.match({
    ok: (result) => {
      hub.broadcaster.publish(result.message);
      void hub.notifier?.notifyChannel(result.message.channel);
      return jsonResponse(
        {
          channel: result.message.channel,
          messageId: result.message.id,
          recipients: result.recipients,
        },
        201,
        headers,
      );
    },
    err: (error) => errorResponse(error, headers),
  });
}

function search(hub: Hub, url: URL, headers: Headers): Response {
  return Result.gen(function* () {
    const raw = url.searchParams.get("q");
    if (raw === null) yield* validationFailed("q", "is required");
    const expression = yield* literalQuery(raw ?? "");
    const requested = yield* integerFromQuery(url, "limit", DEFAULT_SEARCH_LIMIT);
    const limit = clampLimit(requested, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    const channel = url.searchParams.get("channel");
    if (channel !== null && hub.store.findChannel(channel) === null) {
      yield* channelNotFound(channel);
    }
    const rawSender = url.searchParams.get("sender");
    const sender = rawSender === null ? null : yield* validName(rawSender, "sender");
    const kind = yield* optionalChannelKindFromQuery(url);

    // One row past the limit turns truncation into a fact instead of a floor.
    const rows = hub.store.search(expression, channel, sender, limit + 1, kind);
    return Result.ok({ results: rows.slice(0, limit), truncated: rows.length > limit });
  }).match({
    ok: (body) => jsonResponse(body, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

/** Attachment metadata is an open read; content stays behind the token. */
function listAttachmentsEndpoint(hub: Hub, url: URL, headers: Headers): Response {
  return Result.gen(function* () {
    const channel = url.searchParams.get("channel");
    if (channel !== null && hub.store.findChannel(channel) === null) {
      yield* channelNotFound(channel);
    }
    const rawKind = url.searchParams.get("kind");
    if (rawKind !== null && rawKind !== "image" && rawKind !== "markdown" && rawKind !== "other") {
      yield* validationFailed("kind", "must be image, markdown, or other");
    }
    // SAFETY: the check above yields a validation failure for every other value.
    const kind = rawKind as "image" | "markdown" | "other" | null;
    const requested = yield* integerFromQuery(url, "limit", DEFAULT_SEARCH_LIMIT);
    const limit = clampLimit(requested, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    return Result.ok(hub.store.listAttachments(channel, kind, limit));
  }).match({
    ok: (body) => jsonResponse(body, 200, headers),
    err: (error) => errorResponse(error, headers),
  });
}

/**
 * Serving is gated on the token because this is the one endpoint that reads
 * local files. A missing, changed, or non-image attachment is reported the same
 * way, so probing ids reveals nothing about the filesystem.
 */
function serveAttachment(hub: Hub, rawId: string, headers: Headers): Response {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return errorResponse(notFound("Attachment"), headers);

  const attachment = hub.store.attachmentById(id);
  if (attachment === null) return errorResponse(notFound("Attachment"), headers);

  return readPreview(attachment).match({
    ok: (preview) => {
      headers.set("content-type", preview.contentType);
      headers.set("content-length", String(preview.bytes.byteLength));
      headers.set("x-content-type-options", "nosniff");
      headers.set("content-security-policy", "sandbox");
      headers.set("cache-control", "no-store");
      return new Response(preview.bytes, { status: 200, headers });
    },
    err: (error) => errorResponse(error, headers),
  });
}

const BEFORE_PATH_BOUNDARIES = new Set([" ", "\t", "\r", "\n", "`", "(", "[", "{", "<", "\"", "'", ":", ";", "="]);
const AFTER_PATH_BOUNDARIES = new Set([" ", "\t", "\r", "\n", "`", ".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "\"", "'"]);

/** The exact path must be a distinct reference, not a substring of another path. */
function messageReferencesPath(body: string, path: string): boolean {
  if (!isAbsolute(path) || path.length > MAX_PATH_LENGTH) return false;
  let cursor = body.indexOf(path);
  while (cursor >= 0) {
    const before = body[cursor - 1];
    const after = body[cursor + path.length];
    const startsReference = before === undefined || BEFORE_PATH_BOUNDARIES.has(before);
    const endsReference = after === undefined || AFTER_PATH_BOUNDARIES.has(after);
    if (startsReference && endsReference) return true;
    cursor = body.indexOf(path, cursor + path.length);
  }
  return false;
}

/**
 * A message reference grants the human browser access to that one Markdown
 * path. Raw HTML stays disabled in the browser renderer.
 */
function serveMessageMarkdown(hub: Hub, rawId: string, url: URL, headers: Headers): Response {
  const id = Number(rawId);
  const path = url.searchParams.get("path");
  if (!Number.isInteger(id) || id <= 0 || path === null) {
    return errorResponse(notFound("Markdown file"), headers);
  }

  const message = hub.store.messageById(id);
  if (message === null || !messageReferencesPath(message.body, path)) {
    return errorResponse(notFound("Markdown file"), headers);
  }

  return readMarkdownPath(path).match({
    ok: (preview) => {
      headers.set("content-type", preview.contentType);
      headers.set("content-length", String(preview.bytes.byteLength));
      headers.set("x-content-type-options", "nosniff");
      headers.set("content-security-policy", "sandbox");
      headers.set("cache-control", "no-store");
      return new Response(preview.bytes, { status: 200, headers });
    },
    err: (error) => errorResponse(error, headers),
  });
}

async function uploadFile(hub: Hub, request: Request, headers: Headers): Promise<Response> {
  const filename = request.headers.get("x-msgr-filename");
  if (filename === null || filename.length === 0) {
    return errorResponse(validationFailed("filename", "is required"), headers);
  }

  const stored = await new UploadStore(hub.config.uploadDirectory).save(request.body, filename);
  return stored.match({
    ok: (upload) => jsonResponse(upload, 201, headers),
    err: (error) => errorResponse(error, headers),
  });
}

async function eventStream(hub: Hub, request: Request, headers: Headers): Promise<Response> {
  const lastEventId = Number(request.headers.get("last-event-id") ?? "");
  const replayFrom = Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : null;

  // Message frames keep their existing local stream semantics. Receipt frames
  // carry cursor state, so only an authenticated member of that channel can
  // receive them. An unauthenticated stream receives no receipt frames.
  const receiptPermission = authenticate(
    request,
    hub.store,
    hub.config.herdrSocketPath,
    presentsLocalControl(hub, request),
  ).match({
    ok: (caller) => (channel: string) => hub.store.isMemberOfChannel(caller.id, channel),
    err: () => undefined,
  });

  const broadcaster = hub.broadcaster;
  const backlog: Message[] = replayFrom === null ? [] : hub.store.replayAfter(replayFrom, MAX_REPLAY);
  const topology = ensureTopology(hub);
  if (topology !== null) await topology.refresh();
  const topologySnapshot = topology?.snapshot();
  const topologyBroadcaster = topology === null ? undefined : (hub.herdrBroadcaster ?? new TopologyBroadcaster());
  if (topologyBroadcaster !== undefined) hub.herdrBroadcaster = topologyBroadcaster;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const message of backlog) controller.enqueue(frameFor(message));
      if (topologySnapshot !== undefined) controller.enqueue(frameForTopology(topologySnapshot));
      broadcaster.add(controller, receiptPermission);
      topologyBroadcaster?.add(controller);
      request.signal.addEventListener("abort", () => {
        broadcaster.remove(controller);
        topologyBroadcaster?.remove(controller);
        try {
          controller.close();
        } catch {
          // The client is already gone.
        }
      });
    },
    cancel(controller) {
      broadcaster.remove(controller);
      topologyBroadcaster?.remove(controller);
    },
  });

  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-store");
  headers.set("connection", "keep-alive");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { status: 200, headers });
}

async function herdrEventStream(
  hub: Hub,
  request: Request,
  headers: Headers,
): Promise<Response> {
  const topology = ensureTopology(hub);
  if (topology !== null) await topology.refresh();
  const snapshot = topology?.snapshot() ?? EMPTY_TOPOLOGY;
  const broadcaster = hub.herdrBroadcaster ?? new TopologyBroadcaster();
  hub.herdrBroadcaster = broadcaster;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frameForTopology(snapshot));
      broadcaster.add(controller);
      request.signal.addEventListener("abort", () => {
        broadcaster.remove(controller);
        try {
          controller.close();
        } catch {
          // The client is already gone.
        }
      });
    },
    cancel(controller) {
      broadcaster.remove(controller);
    },
  });

  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-store");
  headers.set("connection", "keep-alive");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { status: 200, headers });
}

// -------------------------------------------------------------------- static

const IMMUTABLE_ASSETS = /^\/assets\//u;

async function serveStatic(hub: Hub, url: URL, headers: Headers): Promise<Response> {
  const requested = normalize(url.pathname);
  if (requested.includes("..")) return errorResponse(notFound("Page"), headers);

  const candidate = requested === "/" ? "/index.html" : requested;
  const embeddedPath = hub.config.webAssets?.get(candidate);
  const file = Bun.file(embeddedPath ?? join(hub.config.webRoot, candidate));

  if (embeddedPath !== undefined || await file.exists()) {
    headers.set(
      "cache-control",
      IMMUTABLE_ASSETS.test(candidate) ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return new Response(file, { status: 200, headers });
  }

  const embeddedIndexPath = hub.config.webAssets?.get("/index.html");
  const index = Bun.file(embeddedIndexPath ?? join(hub.config.webRoot, "index.html"));
  if (embeddedIndexPath !== undefined || await index.exists()) {
    headers.set("cache-control", "no-cache");
    return new Response(index, { status: 200, headers });
  }

  return jsonResponse({ error: "The web interface has not been built" }, 404, headers);
}

// ------------------------------------------------------------------- routing

function requireAuth(
  hub: Hub,
  request: Request,
  headers: Headers,
  handler: (caller: Participant) => Response,
): Response {
  return authenticate(
    request,
    hub.store,
    hub.config.herdrSocketPath,
    presentsLocalControl(hub, request),
  ).match({
    ok: handler,
    err: (error: ApiError) => errorResponse(error, headers),
  });
}

function requireHuman(
  hub: Hub,
  request: Request,
  headers: Headers,
  capability: string,
  handler: () => Response,
): Response {
  return authenticate(
    request,
    hub.store,
    hub.config.herdrSocketPath,
    presentsLocalControl(hub, request),
  ).match({
    ok: (caller) =>
      caller.kind === "human"
        ? handler()
        : errorResponse(operatorOnly(capability), headers),
    err: (error: ApiError) => errorResponse(error, headers),
  });
}

function presentsLocalControl(hub: Hub, request: Request): boolean {
  const token = request.headers.get(CONTROL_TOKEN_HEADER);
  if (token === null) return false;
  const expected = Buffer.from(hub.localControlTokenHash, "hex");
  const presented = Buffer.from(hashToken(token), "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

function requireRoleControl(
  hub: Hub,
  request: Request,
  headers: Headers,
  handler: () => Response,
): Response {
  return presentsLocalControl(hub, request)
    ? handler()
    : requireHuman(hub, request, headers, "manage role definitions", handler);
}

async function requireHumanAsync(
  hub: Hub,
  request: Request,
  headers: Headers,
  capability: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const authenticated = authenticate(
    request,
    hub.store,
    hub.config.herdrSocketPath,
    presentsLocalControl(hub, request),
  );
  if (authenticated.isErr()) return errorResponse(authenticated.error, headers);
  if (authenticated.value.kind !== "human") {
    return errorResponse(operatorOnly(capability), headers);
  }
  return handler();
}

async function requireAuthAsync(
  hub: Hub,
  request: Request,
  headers: Headers,
  handler: (caller: Participant) => Promise<Response>,
): Promise<Response> {
  return authenticate(
    request,
    hub.store,
    hub.config.herdrSocketPath,
    presentsLocalControl(hub, request),
  ).match({
    ok: handler,
    err: (error: ApiError) => errorResponse(error, headers),
  });
}

export function createFetchHandler(hub: Hub): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const redirect = canonicalHostRedirect(request, hub.config);
    if (redirect !== null) return redirect;

    const headers = corsHeaders(request, hub.config);

    const admitted = admit(request, hub.config);
    if (admitted.isErr()) return errorResponse(admitted.error, headers);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const routed = routedPath(url.pathname);
    if (routed.isErr()) return errorResponse(routed.error, headers);
    const { key, param, extra } = routed.value;
    const route = `${request.method} ${key}`;

    // Read once, before routing, so malformed JSON is reported as such rather
    // than as whichever field the handler happened to look for first.
    let body: JsonValue = {};
    if (
      (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") &&
      url.pathname !== "/api/uploads" &&
      url.pathname !== "/api/dictation/transcribe"
    ) {
      const parsed = await readJsonBody(request);
      if (parsed.isErr()) return errorResponse(parsed.error, headers);
      body = parsed.value;
    }

    switch (route) {
      case "GET /api/meta":
        return jsonResponse({ name: "sheppard", version: hub.config.applicationVersion ?? SHEPPARD_VERSION }, 200, headers);
      case "POST /api/agents":
        return createAgent(hub, body, headers);
      case "GET /api/agents/:handle":
        return agentDetail(hub, param, headers);
      case "POST /api/humans":
        return createHuman(hub, body, headers);
      case "POST /api/channels":
        return requireAuth(hub, request, headers, () => createChannel(hub, body, headers));
      case "DELETE /api/channels/:name":
        return requireHuman(hub, request, headers, "delete channels", () =>
          deleteChannel(hub, param, body, headers),
        );
      case "GET /api/channels":
        return channelKindFromQuery(url).match({
          ok: (kind) => jsonResponse({ channels: hub.store.listChannels(kind) }, 200, headers),
          err: (error) => errorResponse(error, headers),
        });
      case "GET /api/direct":
        return requireAuth(hub, request, headers, (caller) => listDirect(hub, caller, headers));
      case "GET /api/participants":
        return listParticipants(hub, headers);
      case "DELETE /api/participants/:handle":
        return requireAuth(hub, request, headers, () =>
          deactivateParticipant(hub, param, headers),
        );
      case "GET /api/inbox":
        return requireAuth(hub, request, headers, (caller) => listInbox(hub, caller, headers));
      case "GET /api/search":
        return search(hub, url, headers);
      case "GET /api/attachments":
        return listAttachmentsEndpoint(hub, url, headers);
      case "GET /api/events":
        return eventStream(hub, request, headers);
      case "GET /api/herdr/workspaces":
        return listHerdrWorkspaces(hub, headers);
      case "GET /api/herdr/directories":
        return requireHumanAsync(hub, request, headers, "browse local directories", () =>
          listHerdrDirectories(url, headers),
        );
      case "GET /api/herdr/harnesses":
        return listHerdrHarnesses(hub, headers);
      case "GET /api/herdr/roles":
        return listHerdrRoles(hub, headers);
      case "POST /api/herdr/roles":
        return requireRoleControl(hub, request, headers, () =>
          createHerdrRole(hub, body, headers),
        );
      case "GET /api/herdr/roles/:name":
        return requireRoleControl(hub, request, headers, () =>
          readHerdrRole(hub, param, headers),
        );
      case "PUT /api/herdr/roles/:name":
        return requireRoleControl(hub, request, headers, () =>
          updateHerdrRole(hub, param, body, headers),
        );
      case "PUT /api/herdr/roles/:name/runtime":
        return requireRoleControl(hub, request, headers, () =>
          updateHerdrRoleRuntime(hub, param, body, headers),
        );
      case "DELETE /api/herdr/roles/:name":
        return requireHuman(hub, request, headers, "manage role definitions", () =>
          deleteHerdrRole(hub, param, headers),
        );
      case "GET /api/herdr/models":
        return listHerdrModels(hub, headers);
      case "GET /api/herdr/model-catalogue":
        return listHerdrModelCatalogue(hub, headers);
      case "POST /api/herdr/model-catalogue":
        return refreshHerdrModelCatalogue(hub, body, headers);
      case "POST /api/herdr/models":
        return requireHuman(hub, request, headers, "manage model definitions", () =>
          createHerdrModel(hub, body, headers),
        );
      case "DELETE /api/herdr/models/:harness/:name":
        return requireHuman(hub, request, headers, "manage model definitions", () =>
          deleteHerdrModel(hub, param, extra, headers),
        );
      case "GET /api/herdr/launchers":
        return requireAuth(hub, request, headers, () => listHerdrLaunchers(hub, headers));
      case "POST /api/herdr/launchers":
        return requireHuman(hub, request, headers, "manage launcher definitions", () =>
          createHerdrLauncher(hub, body, headers),
        );
      case "PUT /api/herdr/launchers/:name":
        return requireHuman(hub, request, headers, "manage launcher definitions", () =>
          updateHerdrLauncher(hub, param, body, headers),
        );
      case "DELETE /api/herdr/launchers/:name":
        return requireHuman(hub, request, headers, "manage launcher definitions", () =>
          deleteHerdrLauncher(hub, param, headers),
        );
      case "GET /api/herdr/agents/:paneId":
        return herdrAgentIdentity(hub, param, headers);
      case "POST /api/herdr/agents/:paneId/connect":
        return requireHumanAsync(hub, request, headers, "connect agent panes", () =>
          connectHerdrAgent(hub, param, body, headers),
        );
      case "GET /api/herdr/agents/:paneId/session":
        return requireAuthAsync(hub, request, headers, (caller) =>
          herdrAgentSession(hub, caller, param, url, headers),
        );
      case "POST /api/herdr/agents/:paneId/session/select":
        return requireAuthAsync(hub, request, headers, (caller) =>
          selectHerdrAgentSession(hub, caller, param, body, headers),
        );
      case "GET /api/herdr/events":
        return herdrEventStream(hub, request, headers);
      case "POST /api/herdr/agents":
        return requireAuthAsync(hub, request, headers, (caller) =>
          spawnHerdrAgent(hub, caller, body, request.headers, headers),
        );
      case "DELETE /api/herdr/agents/:paneId":
        return requireAuthAsync(hub, request, headers, () =>
          stopHerdrAgent(hub, param, body, headers),
        );
      case "POST /api/herdr/agents/:paneId/prompt":
        return requireAuthAsync(hub, request, headers, (caller) =>
          promptHerdrAgent(hub, caller, param, body, headers),
        );
      case "POST /api/herdr/workspaces":
        return requireAuthAsync(hub, request, headers, () =>
          createHerdrWorkspace(hub, body, headers),
        );
      case "DELETE /api/herdr/workspaces/:id":
        return requireAuthAsync(hub, request, headers, () =>
          closeHerdrWorkspace(hub, param, body, headers),
        );
      case "POST /api/herdr/workspaces/:id/broadcast":
        return requireAuthAsync(hub, request, headers, (caller) =>
          broadcastToHerdrWorkspace(hub, caller, param, body, headers),
        );
      case "POST /api/herdr/tabs":
        return requireAuthAsync(hub, request, headers, () =>
          createHerdrTab(hub, body, headers),
        );
      case "PUT /api/herdr/tabs/:id":
        return requireAuthAsync(hub, request, headers, () =>
          renameHerdrTab(hub, param, body, headers),
        );
      case "POST /api/herdr/tabs/:id/focus":
        return requireAuthAsync(hub, request, headers, () =>
          focusHerdrTab(hub, param, headers),
        );
      case "DELETE /api/herdr/tabs/:id":
        return requireAuthAsync(hub, request, headers, () =>
          closeHerdrTab(hub, param, body, headers),
        );
      case "POST /api/channels/:name/join":
        return requireAuth(hub, request, headers, (caller) =>
          joinChannel(hub, caller, param, headers),
        );
      case "POST /api/channels/:name/members":
        return requireAuth(hub, request, headers, () =>
          addMember(hub, param, body, headers),
        );
      case "DELETE /api/channels/:name/members/:handle":
        return requireAuth(hub, request, headers, () =>
          removeMember(hub, param, extra, headers),
        );
      case "POST /api/channels/:name/messages":
        return requireAuth(hub, request, headers, (caller) =>
          sendMessage(hub, caller, param, body, headers),
        );
      case "POST /api/direct":
        return requireAuth(hub, request, headers, (caller) =>
          sendDirectMessage(hub, caller, body, headers),
        );
      case "GET /api/channels/:name/messages":
        return listHistory(hub, url, param, headers);
      case "POST /api/channels/:name/fetch":
        return requireAuth(hub, request, headers, (caller) =>
          fetchUnread(hub, caller, param, headers),
        );
      case "POST /api/channels/:name/ack":
        return requireAuth(hub, request, headers, (caller) =>
          acknowledge(hub, caller, param, body, headers),
        );
      case "GET /api/channels/:name/context":
        return listContext(hub, url, param, headers);
      case "GET /api/channels/:name/members":
        return listMembers(hub, param, headers);
      case "GET /api/channels/:name/receipts":
        return requireAuth(hub, request, headers, (caller) =>
          listReceipts(hub, caller, param, headers),
        );
      case "GET /api/attachments/:id/content":
        return requireAuth(hub, request, headers, () => serveAttachment(hub, param, headers));
      case "GET /api/messages/:id/markdown":
        return requireHuman(hub, request, headers, "read referenced Markdown files", () =>
          serveMessageMarkdown(hub, param, url, headers),
        );
      case "POST /api/uploads":
        return requireAuthAsync(hub, request, headers, () => uploadFile(hub, request, headers));
      case "POST /api/dictation/transcribe":
        return requireHumanAsync(hub, request, headers, "use local dictation", async () =>
          (await transcribeDictation(request, hub.config.databasePath)).match({
            ok: (transcript) => jsonResponse(transcript, 200, headers),
            err: (error) => errorResponse(error, headers),
          }),
        );
      default:
        break;
    }

    if (url.pathname.startsWith("/api/")) {
      return errorResponse(notFound("Endpoint"), headers);
    }
    if (request.method !== "GET") {
      return errorResponse(notFound("Endpoint"), headers);
    }
    return serveStatic(hub, url, headers);
  };
}

// ------------------------------------------------------------------- startup

export interface RunningHub {
  hub: Hub;
  stop: () => void;
  port: number;
  /** Absent when the hub runs outside herdr: the poll path still works. */
  notifier: Notifier | null;
}

export function startHub(config: ServerConfig = loadConfig()): Result<RunningHub, Error> {
  const lock = acquireHubLock(config.databasePath);
  if (lock.isErr()) return Result.err(lock.error);

  const localControlToken = ensureLocalControlToken(config.databasePath);
  if (localControlToken.isErr()) {
    lock.value.release();
    return Result.err(localControlToken.error);
  }

  const opened = openDatabase(config.databasePath);
  if (opened.isErr()) {
    lock.value.release();
    return Result.err(opened.error);
  }

  const store = new Store(opened.value);
  store.seedLaunchers(launcherSeeds(config));
  store.seedRoles(roleSeeds(config));
  store.seedModels(modelSeeds(config));
  const hub: Hub = {
    store,
    config,
    broadcaster: new Broadcaster(),
    localControlTokenHash: hashToken(localControlToken.value),
  };

  const herdr = config.pushAvailable
    ? new CliHerdr("herdr", HERDR_TIMEOUT_MS, config.herdrSocketPath)
    : undefined;
  const herdrBroadcaster = new TopologyBroadcaster();
  hub.herdr = herdr;
  hub.herdrBroadcaster = herdrBroadcaster;
  hub.topology =
    herdr === undefined
      ? undefined
      : new HerdrTopology({
          herdr,
          store: hub.store,
          onChange: (snapshot) => herdrBroadcaster.publish(snapshot),
        });

  // Push needs a herdr instance to inject through; without one the hub still
  // serves `msgr inbox`, so agents poll instead of being told.
  const notifier = herdr === undefined
    ? null
    : new Notifier({
        store: hub.store,
        herdr,
        onTick: async () => {
          const topology = hub.topology;
          if (topology !== undefined && !topology.isWatching()) await topology.refresh();
        },
      });
  hub.notifier = notifier ?? undefined;

  const server = Bun.serve({
    hostname: HOST,
    port: config.port,
    idleTimeout: 0,
    fetch: createFetchHandler(hub),
  });

  // Configuring port 0 lets the operating system choose one. The Host check
  // compares against the configured port, so it has to learn the bound one.
  hub.config.port = server.port;

  hub.topology?.start();

  const heartbeat = setInterval(() => {
    hub.broadcaster.keepAlive();
    herdrBroadcaster.keepAlive();
  }, 25_000);

  notifier?.start();

  return Result.ok({
    hub,
    port: server.port,
    notifier,
    stop: () => {
      notifier?.stop();
      hub.topology?.stop();
      clearInterval(heartbeat);
      hub.broadcaster.closeAll();
      herdrBroadcaster.closeAll();
      server.stop(true);
      opened.value.close();
      lock.value.release();
    },
  });
}
