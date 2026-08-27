/**
 * The hub's only contact with herdr.
 *
 * Two properties of the herdr CLI shape this file, and both are easy to get
 * wrong: it exits 0 even when it refuses a command, and it writes refusals to
 * stderr while writing results to stdout. Reading only the exit status, or only
 * stdout, makes a refusal look like a success.
 *
 * Two failure classes matter to callers and are kept apart deliberately:
 *
 *   NoAgentAtTarget is definitive. The pane is not hosting an agent, so the
 *   route is wrong and saying so is useful.
 *
 *   HerdrCallFailed carries a failure kind. A reported failure is a definitive
 *   herdr response. A timeout or unknown failure leaves the outcome unresolved,
 *   so callers must not draw a conclusion from it.
 *
 * Everything unrecognised is classified transient. Retrying a delivery costs one
 * duplicate ping at worst; concluding "definitive" from noise stops delivery
 * altogether, which is the failure the design refuses to accept.
 */

import { Result, TaggedError } from "better-result";
import { DEFAULT_AGENT_START_TIMEOUT_MS } from "./config";
import { HerdrCallFailed, herdrCallFailed, type HerdrFailureKind } from "./errors";
import { createConnection, type Socket } from "node:net";
import {
  type JsonObject,
  type JsonValue,
  arrayField,
  decodeObject,
  objectField,
  optionalBoolean,
  optionalString,
  requiredString,
} from "./json";
import type { AgentStatus } from "./types";
export type { AgentStatus } from "./types";
export { HerdrCallFailed, herdrCallFailed, type HerdrFailureKind } from "./errors";

/** Long enough for a busy socket, short enough that a tick cannot wedge. */
export const HERDR_TIMEOUT_MS = 10_000;

/** Herdr waits 30 seconds for interactive agent readiness by default. */
export const HERDR_AGENT_START_TIMEOUT_MS = DEFAULT_AGENT_START_TIMEOUT_MS;

/** Application deadline for confirming the pane after the start call returns. */
export const HERDR_CONFIRM_TIMEOUT_MS = 10_000;

/** herdr reports this when a prompt target is not currently hosting an agent. */
const AGENT_NOT_FOUND = "agent_not_found";

export interface PaneInfo {
  paneId: string;
  terminalId: string;
  /** The kind of agent occupying the pane, or null for a plain shell. */
  agent: string | null;
  agentStatus: AgentStatus;
  focused: boolean;
  /** Present when herdr supplies a pane label. */
  label?: string;
  /** Present when herdr supplies the terminal title, without its status glyph. */
  terminalTitle?: string;
  /** The current foreground working directory, when herdr supplies it. */
  cwd?: string;
  /** Present as a non-enumerable compatibility field when herdr supplies it. */
  workspaceId?: string;
  /** Present as a non-enumerable compatibility field when herdr supplies it. */
  tabId?: string;
}

export interface HerdrWorkspace {
  id: string;
  label: string | null;
}

export interface HerdrTab {
  id: string;
  workspaceId: string;
  label: string | null;
}

export interface PaneSplitOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** A lifecycle event received from a long-lived Herdr socket subscription. */
export interface HerdrEvent {
  type: string;
}

/** A live socket subscription. Closing it stops future event callbacks. */
export interface HerdrSubscription {
  close: () => void;
  readonly closed: boolean;
}

export interface HerdrSubscriptionOptions {
  onEvent: (event: HerdrEvent) => void;
  onError: (error: HerdrCallFailed) => void;
  paneIds?: readonly string[];
}

/** Definitive: the pane is not hosting an agent. */
export class NoAgentAtTarget extends TaggedError("NoAgentAtTarget")<{
  paneId: string;
  message: string;
}> {}

export interface HerdrPort {
  subscribe: (
    options: HerdrSubscriptionOptions,
  ) => Promise<Result<HerdrSubscription, HerdrCallFailed>>;
  paneList: () => Promise<Result<PaneInfo[], HerdrCallFailed>>;
  paneCurrent: () => Promise<Result<PaneInfo, HerdrCallFailed>>;
  paneSplit: (
    workspaceRootPane: string,
    options?: PaneSplitOptions,
  ) => Promise<Result<PaneInfo, HerdrCallFailed>>;
  paneClose: (paneId: string) => Promise<Result<void, HerdrCallFailed>>;
  agentStart: (
    paneId: string,
    name: string,
    kind: string,
    argv: readonly string[],
    timeoutMs?: number,
  ) => Promise<Result<void, HerdrCallFailed>>;
  workspaceList: () => Promise<Result<HerdrWorkspace[], HerdrCallFailed>>;
  workspaceCreate: (
    label?: string,
    cwd?: string,
  ) => Promise<Result<HerdrWorkspace, HerdrCallFailed>>;
  workspaceClose: (id: string) => Promise<Result<void, HerdrCallFailed>>;
  tabList: () => Promise<Result<HerdrTab[], HerdrCallFailed>>;
  tabCreate: (
    workspaceId: string,
    label?: string,
  ) => Promise<Result<HerdrTab, HerdrCallFailed>>;
  tabRename: (id: string, label: string) => Promise<Result<void, HerdrCallFailed>>;
  tabFocus: (id: string) => Promise<Result<void, HerdrCallFailed>>;
  tabClose: (id: string) => Promise<Result<void, HerdrCallFailed>>;
  agentPrompt: (
    paneId: string,
    text: string,
  ) => Promise<Result<void, NoAgentAtTarget | HerdrCallFailed>>;
}

function transient(
  command: string,
  detail: string,
  kind: HerdrFailureKind = "unknown",
  paneId: string | null = null,
): HerdrCallFailed {
  return new HerdrCallFailed({
    command,
    detail,
    kind,
    paneId,
    message: `herdr ${command} did not complete: ${detail}`,
  });
}

function timedOut(command: string, detail: string, paneId: string | null = null): HerdrCallFailed {
  return transient(command, detail, "timeout", paneId);
}

function reported(command: string, detail: string, paneId: string | null = null): HerdrCallFailed {
  return transient(command, detail, "reported", paneId);
}

export function noAgentAtTarget(paneId: string): NoAgentAtTarget {
  return new NoAgentAtTarget({ paneId, message: `No agent is hosted at ${paneId}` });
}

/**
 * An unrecognised status holds delivery rather than allowing it, so a herdr
 * release that adds a state cannot start injecting into panes by default.
 */
function toAgentStatus(raw: string | null): AgentStatus {
  switch (raw) {
    case "idle":
      return "idle";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

function decodePane(value: JsonValue, command: string): Result<PaneInfo, HerdrCallFailed> {
  return Result.gen(function* () {
    const pane = yield* decodeObject(value);
    const paneId = yield* requiredString(pane, "pane_id");
    const terminalId = yield* requiredString(pane, "terminal_id");
    const agent = yield* optionalString(pane, "agent");
    const status = yield* optionalString(pane, "agent_status");
    const focused = yield* optionalBoolean(pane, "focused", false);
    const label = yield* optionalString(pane, "label");
    const terminalTitle = yield* optionalString(pane, "terminal_title_stripped");
    const rawTerminalTitle = yield* optionalString(pane, "terminal_title");
    const foregroundCwd = yield* optionalString(pane, "foreground_cwd");
    const cwd = yield* optionalString(pane, "cwd");
    const workspaceId = yield* optionalString(pane, "workspace_id");
    const tabId = yield* optionalString(pane, "tab_id");
    const decoded: PaneInfo = {
      paneId,
      terminalId,
      agent,
      agentStatus: toAgentStatus(status),
      focused,
    };
    if (label !== null) decoded.label = label;
    if (terminalTitle !== null && terminalTitle.length > 0) {
      decoded.terminalTitle = terminalTitle;
    } else if (rawTerminalTitle !== null && rawTerminalTitle.length > 0) {
      decoded.terminalTitle = rawTerminalTitle;
    }
    if (foregroundCwd !== null && foregroundCwd.length > 0) {
      decoded.cwd = foregroundCwd;
    } else if (cwd !== null && cwd.length > 0) {
      decoded.cwd = cwd;
    }
    // Keep the original pane-list wire shape compatible with older callers
    // while retaining the workspace id for topology assembly.
    if (workspaceId !== null) {
      Object.defineProperty(decoded, "workspaceId", {
        configurable: true,
        value: workspaceId,
        writable: false,
      });
    }
    if (tabId !== null) {
      Object.defineProperty(decoded, "tabId", {
        configurable: true,
        value: tabId,
        writable: false,
      });
    }
    return Result.ok(decoded);
  }).mapError((error) => transient(command, error.message));
}

function decodeWorkspace(value: JsonValue, command: string): Result<HerdrWorkspace, HerdrCallFailed> {
  return Result.gen(function* () {
    const workspace = yield* decodeObject(value);
    const id = yield* requiredString(workspace, "workspace_id");
    const label = yield* optionalString(workspace, "label");
    return Result.ok({ id, label: label === "" ? null : label });
  }).mapError((error) => transient(command, error.message));
}

function decodeTab(value: JsonValue, command: string): Result<HerdrTab, HerdrCallFailed> {
  return Result.gen(function* () {
    const tab = yield* decodeObject(value);
    const id = yield* requiredString(tab, "tab_id");
    const workspaceId = yield* requiredString(tab, "workspace_id");
    const label = yield* optionalString(tab, "label");
    return Result.ok({ id, workspaceId, label: label === "" ? null : label });
  }).mapError((error) => transient(command, error.message));
}

function parseJson(text: string): JsonValue | null {
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(text),
    catch: () => null,
  });
  return parsed.unwrapOr(null);
}

/** A refusal herdr reported itself, as distinct from a call that never landed. */
interface Rejection {
  code: string;
  message: string;
}

/**
 * Extracts a refusal from either stream. Returns null when the text is not a
 * refusal, so ordinary noise on stderr cannot be mistaken for one.
 */
function rejectionIn(text: string): Rejection | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const parsed = parseJson(trimmed);
  if (parsed === null) return null;

  const envelope = decodeObject(parsed);
  if (envelope.isErr()) return null;

  const failure = envelope.value.error;
  if (failure === undefined || failure === null) return null;

  const detail = decodeObject(failure);
  if (detail.isErr()) return null;

  const code = optionalString(detail.value, "code").unwrapOr(null) ?? "unknown";
  return { code, message: optionalString(detail.value, "message").unwrapOr(null) ?? code };
}

function resultIn(stdout: string, command: string): Result<JsonObject, HerdrCallFailed> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return Result.err(transient(command, "reply was empty"));

  const parsed = parseJson(trimmed);
  if (parsed === null) return Result.err(transient(command, "reply was not JSON"));

  const envelope = decodeObject(parsed);
  if (envelope.isErr()) return Result.err(transient(command, "reply was not a JSON object"));

  const result = objectField(envelope.value, "result");
  if (result.isErr()) return Result.err(transient(command, "reply carried no result"));
  return Result.ok(result.value);
}

function socketQuery(
  socketPath: string,
  request: JsonObject,
  timeoutMs: number,
  command: string,
): Promise<Result<JsonObject, HerdrCallFailed>> {
  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Result<JsonObject, HerdrCallFailed>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };

    let socket: Socket | undefined;
    const opened = Result.try({
      try: () => createConnection({ path: socketPath }),
      catch: (cause) => transient(command, cause instanceof Error ? cause.message : "connect failed"),
    });
    if (opened.isErr()) {
      finish(Result.err(opened.error));
      return;
    }
    socket = opened.value;
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      try {
        socket?.write(`${JSON.stringify(request)}\n`);
      } catch (cause) {
        finish(transientResult(command, cause));
      }
    });
    socket.on("data", (chunk: string | Buffer) => {
      response += String(chunk);
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      finish(resultIn(response.slice(0, newline), command));
    });
    socket.once("end", () => {
      if (response.trim().length > 0) finish(resultIn(response, command));
      else finish(Result.err(transient(command, "reply was empty")));
    });
    socket.once("timeout", () => {
      finish(Result.err(timedOut(command, `timed out after ${timeoutMs}ms`)));
    });
    socket.once("error", (cause: Error) => {
      finish(Result.err(transient(command, cause.message)));
    });
    timer = setTimeout(() => {
      finish(Result.err(timedOut(command, `timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
  });
}

function subscriptionEventIn(text: string, command: string): Result<HerdrEvent, HerdrCallFailed> {
  const parsed = parseJson(text);
  if (parsed === null) return Result.err(transient(command, "event was not JSON"));

  return Result.gen(function* () {
    const envelope = yield* decodeObject(parsed);
    const type = yield* requiredString(envelope, "event");
    yield* objectField(envelope, "data");
    return Result.ok({ type });
  }).mapError((error) => transient(command, error.message));
}

const TOPOLOGY_EVENT_TYPES = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

function topologySubscriptions(paneIds: readonly string[]): JsonValue[] {
  return [
    ...TOPOLOGY_EVENT_TYPES.map((type) => ({ type })),
    ...paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
  ];
}

function socketSubscribe(
  socketPath: string,
  request: JsonObject,
  timeoutMs: number,
  options: HerdrSubscriptionOptions,
): Promise<Result<HerdrSubscription, HerdrCallFailed>> {
  return new Promise((resolve) => {
    const command = "events subscribe";
    let socket: Socket | undefined;
    let buffer = "";
    let started = false;
    let closed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket?.destroy();
    };

    const subscription: HerdrSubscription = {
      close,
      get closed() {
        return closed;
      },
    };

    const fail = (error: HerdrCallFailed): void => {
      if (closed) return;
      if (!started) {
        closed = true;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        resolve(Result.err(error));
        return;
      }
      closed = true;
      socket?.destroy();
      options.onError(error);
    };

    const processLine = (line: string): void => {
      if (closed || line.length === 0) return;
      if (!started) {
        const rejection = rejectionIn(line);
        if (rejection !== null) {
          fail(transient(command, rejection.message));
          return;
        }
        const ack = resultIn(line, command);
        if (ack.isErr()) {
          fail(ack.error);
          return;
        }
        const kind = optionalString(ack.value, "type").unwrapOr(null);
        if (kind !== "subscription_started") {
          fail(transient(command, "reply did not acknowledge the subscription"));
          return;
        }
        started = true;
        settled = true;
        clearTimeout(timer);
        resolve(Result.ok(subscription));
        return;
      }

      const event = subscriptionEventIn(line, command);
      if (event.isErr()) {
        fail(event.error);
        return;
      }
      options.onEvent(event.value);
    };

    const opened = Result.try({
      try: () => createConnection({ path: socketPath }),
      catch: (cause) => transient(command, cause instanceof Error ? cause.message : "connect failed"),
    });
    if (opened.isErr()) {
      settled = true;
      resolve(Result.err(opened.error));
      return;
    }

    socket = opened.value;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const written = Result.try({
        try: () => socket?.write(`${JSON.stringify(request)}\n`),
        catch: (cause) => transient(command, cause instanceof Error ? cause.message : "write failed"),
      });
      if (written.isErr()) fail(written.error);
    });
    socket.on("data", (chunk: string | Buffer) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !closed) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        processLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("end", () => {
      if (closed) return;
      if (buffer.trim().length > 0) processLine(buffer.trim());
      if (!started) {
        fail(Result.err(transient(command, "reply was empty")));
      } else if (!closed) {
        fail(transient(command, "subscription socket ended"));
      }
    });
    socket.once("error", (cause: Error) => {
      if (!closed) fail(transient(command, cause.message));
    });
    timer = setTimeout(() => {
      if (!settled) fail(timedOut(command, `timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function transientResult(command: string, cause: unknown): Result<JsonObject, HerdrCallFailed> {
  return Result.err(transient(command, cause instanceof Error ? cause.message : "write failed"));
}

interface Invocation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
}

const TIMED_OUT = Symbol("herdr-timed-out");

/** How long to keep reading after the child was signalled, before giving up. */
const DRAIN_GRACE_MS = 500;

async function invoke(
  argv: readonly string[],
  timeoutMs: number,
  displayCommand = argv.slice(1).join(" "),
): Promise<Result<Invocation, HerdrCallFailed>> {
  const command = displayCommand;
  // A missing binary throws at spawn rather than exiting non-zero.
  const spawned = Result.try({
    try: () =>
      Bun.spawn({
        cmd: [...argv],
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      }),
    catch: (cause) => transient(command, cause instanceof Error ? cause.message : "spawn failed"),
  });
  if (spawned.isErr()) return spawned;

  const child = spawned.value;
  const drained = (async (): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { stdout, stderr, exitCode: child.exitCode };
  })();

  // A grandchild can hold the output pipes open after the child is signalled, so
  // the read is raced too. Without this a wedged herdr would wedge the tick.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs + DRAIN_GRACE_MS);
  });

  try {
    const outcome = await Promise.race([drained, expiry]);
    if (outcome === TIMED_OUT) {
      child.kill("SIGKILL");
      return Result.err(timedOut(command, `timed out after ${timeoutMs}ms`));
    }
    // `killed` is true for any exited child, so the signal is what distinguishes
    // a process the timeout terminated from one that finished on its own.
    if (child.signalCode !== null) {
      return Result.err(timedOut(command, `timed out after ${timeoutMs}ms`));
    }
    return Result.ok({ ...outcome, command });
  } finally {
    clearTimeout(timer);
  }
}

/** Talks to the running herdr instance through its CLI or client socket. */
export class CliHerdr implements HerdrPort {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly agentStartTimeoutMs: number;
  private readonly apiSocketPath: string | null;

  constructor(
    binary = "herdr",
    timeoutMs = HERDR_TIMEOUT_MS,
    apiSocketPath?: string | null,
    agentStartTimeoutMs = HERDR_AGENT_START_TIMEOUT_MS,
  ) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.agentStartTimeoutMs = agentStartTimeoutMs;
    this.apiSocketPath = apiSocketPath ?? null;
  }

  /**
   * For the query commands every refusal is transient: failing to read the pane
   * table says nothing about whether any particular route is still good.
   */
  private async query(
    args: readonly string[],
    displayCommand = args.join(" "),
    timeoutMs = this.timeoutMs,
  ): Promise<Result<JsonObject, HerdrCallFailed>> {
    const invoked = await invoke([this.binary, ...args], timeoutMs, displayCommand);
    if (invoked.isErr()) return invoked;

    const { stdout, stderr, exitCode, command } = invoked.value;
    const rejection = rejectionIn(stderr) ?? rejectionIn(stdout);
    if (rejection !== null) return Result.err(reported(command, rejection.message));
    if (exitCode !== 0) {
      return Result.err(reported(command, `exited with status ${exitCode ?? "unknown"}`));
    }

    return resultIn(stdout, command);
  }

  subscribe(
    options: HerdrSubscriptionOptions,
  ): Promise<Result<HerdrSubscription, HerdrCallFailed>> {
    if (this.apiSocketPath === null) {
      return Promise.resolve(
        Result.err(transient("events subscribe", "herdr client socket is not configured")),
      );
    }

    const request: JsonObject = {
      id: `msgr:events:${Date.now()}`,
      method: "events.subscribe",
      params: { subscriptions: topologySubscriptions(options.paneIds ?? []) },
    };
    return socketSubscribe(this.apiSocketPath, request, this.timeoutMs, options);
  }

  async paneList(): Promise<Result<PaneInfo[], HerdrCallFailed>> {
    const queried = await this.query(["pane", "list"]);
    if (queried.isErr()) return queried;

    const panes = arrayField(queried.value, "panes");
    if (panes.isErr()) return Result.err(transient("pane list", "reply carried no panes"));

    const decoded: PaneInfo[] = [];
    for (const entry of panes.value) {
      const pane = decodePane(entry, "pane list");
      if (pane.isErr()) return pane;
      decoded.push(pane.value);
    }
    return Result.ok(decoded);
  }

  async paneCurrent(): Promise<Result<PaneInfo, HerdrCallFailed>> {
    const queried = await this.query(["pane", "current", "--current"]);
    if (queried.isErr()) return queried;

    const pane = objectField(queried.value, "pane");
    if (pane.isErr()) return Result.err(transient("pane current", "reply carried no pane"));
    return decodePane(pane.value, "pane current");
  }

  async paneSplit(
    workspaceRootPane: string,
    options: PaneSplitOptions = {},
  ): Promise<Result<PaneInfo, HerdrCallFailed>> {
    const args = ["pane", "split", "--pane", workspaceRootPane, "--direction", "right", "--no-focus"];
    if (options.cwd !== undefined) args.push("--cwd", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      args.push("--env", `${key}=${value}`);
    }

    const params: JsonObject = {
      target_pane_id: workspaceRootPane,
      direction: "right",
      focus: false,
      env: { ...options.env },
    };
    if (options.cwd !== undefined) params.cwd = options.cwd;
    const request: JsonObject = {
      id: "msgr:pane:split",
      method: "pane.split",
      params,
    };
    const queried =
      Object.keys(options.env ?? {}).length > 0 && this.apiSocketPath !== null
        ? await socketQuery(this.apiSocketPath, request, this.timeoutMs, "pane split")
        : Object.keys(options.env ?? {}).length > 0
          ? Result.err(transient("pane split", "herdr client socket is not configured"))
          : await this.query(args, "pane split");
    if (queried.isErr()) return queried;
    const pane = objectField(queried.value, "pane");
    if (pane.isErr()) return Result.err(transient("pane split", "reply carried no pane"));
    return decodePane(pane.value, "pane split");
  }

  async paneClose(paneId: string): Promise<Result<void, HerdrCallFailed>> {
    const queried = await this.query(["pane", "close", paneId]);
    return queried.isErr() ? queried : Result.ok();
  }

  async agentStart(
    paneId: string,
    name: string,
    kind: string,
    argv: readonly string[],
    timeoutMs = this.agentStartTimeoutMs,
  ): Promise<Result<void, HerdrCallFailed>> {
    const [executable, ...agentArgs] = argv;
    if (executable === undefined) return Result.err(transient("agent start", "harness argv was empty"));
    const args = ["agent", "start", name, "--kind", kind, "--pane", paneId];
    if (executable !== kind) args.push("--executable", executable);
    if (agentArgs.length > 0) args.push("--", ...agentArgs);
    const queried = await this.query(args, "agent start", timeoutMs);
    if (queried.isErr()) {
      const error = queried.error;
      return Result.err(herdrCallFailed(error.detail, error.command, error.kind, paneId));
    }
    return Result.ok();
  }

  async workspaceList(): Promise<Result<HerdrWorkspace[], HerdrCallFailed>> {
    const queried = await this.query(["workspace", "list"]);
    if (queried.isErr()) return queried;

    const workspaces = arrayField(queried.value, "workspaces");
    if (workspaces.isErr()) {
      return Result.err(transient("workspace list", "reply carried no workspaces"));
    }

    const decoded: HerdrWorkspace[] = [];
    for (const entry of workspaces.value) {
      const workspace = decodeWorkspace(entry, "workspace list");
      if (workspace.isErr()) return workspace;
      decoded.push(workspace.value);
    }
    return Result.ok(decoded);
  }

  async workspaceCreate(
    label?: string,
    cwd?: string,
  ): Promise<Result<HerdrWorkspace, HerdrCallFailed>> {
    const args = ["workspace", "create"];
    if (label !== undefined) args.push("--label", label);
    if (cwd !== undefined) args.push("--cwd", cwd);

    const queried = await this.query(args);
    if (queried.isErr()) return queried;
    const workspace = objectField(queried.value, "workspace");
    if (workspace.isErr()) {
      return Result.err(transient("workspace create", "reply carried no workspace"));
    }
    return decodeWorkspace(workspace.value, "workspace create");
  }

  async workspaceClose(id: string): Promise<Result<void, HerdrCallFailed>> {
    const queried = await this.query(["workspace", "close", id]);
    return queried.isErr() ? queried : Result.ok();
  }

  async tabList(): Promise<Result<HerdrTab[], HerdrCallFailed>> {
    const queried = await this.query(["tab", "list"]);
    if (queried.isErr()) return queried;

    const tabs = arrayField(queried.value, "tabs");
    if (tabs.isErr()) return Result.err(transient("tab list", "reply carried no tabs"));

    const decoded: HerdrTab[] = [];
    for (const entry of tabs.value) {
      const tab = decodeTab(entry, "tab list");
      if (tab.isErr()) return tab;
      decoded.push(tab.value);
    }
    return Result.ok(decoded);
  }

  async tabCreate(
    workspaceId: string,
    label?: string,
  ): Promise<Result<HerdrTab, HerdrCallFailed>> {
    const args = ["tab", "create", "--workspace", workspaceId];
    if (label !== undefined) args.push("--label", label);

    const queried = await this.query(args);
    if (queried.isErr()) return queried;
    const tab = objectField(queried.value, "tab");
    if (tab.isErr()) return Result.err(transient("tab create", "reply carried no tab"));
    return decodeTab(tab.value, "tab create");
  }

  async tabRename(id: string, label: string): Promise<Result<void, HerdrCallFailed>> {
    const queried = await this.query(["tab", "rename", id, label]);
    return queried.isErr() ? queried : Result.ok();
  }

  async tabFocus(id: string): Promise<Result<void, HerdrCallFailed>> {
    const queried = await this.query(["tab", "focus", id]);
    return queried.isErr() ? queried : Result.ok();
  }

  async tabClose(id: string): Promise<Result<void, HerdrCallFailed>> {
    const queried = await this.query(["tab", "close", id]);
    return queried.isErr() ? queried : Result.ok();
  }

  async agentPrompt(
    paneId: string,
    text: string,
  ): Promise<Result<void, NoAgentAtTarget | HerdrCallFailed>> {
    // The display command omits the text: prompt content is operator-authored
    // and must never reach an error body or log line another participant reads.
    const invoked = await invoke(
      [this.binary, "agent", "prompt", paneId, text],
      this.timeoutMs,
      `agent prompt ${paneId}`,
    );
    if (invoked.isErr()) {
      const error = invoked.error;
      return Result.err(herdrCallFailed(error.detail, error.command, error.kind, paneId));
    }

    const { stdout, stderr, exitCode, command } = invoked.value;
    const rejection = rejectionIn(stderr) ?? rejectionIn(stdout);
    if (rejection !== null) {
      return rejection.code === AGENT_NOT_FOUND
        ? Result.err(noAgentAtTarget(paneId))
        : Result.err(reported(command, rejection.message, paneId));
    }
    if (exitCode !== 0) {
      return Result.err(reported(command, `exited with status ${exitCode ?? "unknown"}`, paneId));
    }

    // This command reports success by saying nothing at all.
    if (stdout.trim().length === 0) return Result.ok();

    const confirmed = resultIn(stdout, command);
    return confirmed.isErr() ? Result.err(confirmed.error) : Result.ok();
  }
}

/**
 * A scripted stand-in for tests. Records what was sent so a test can assert on
 * delivery without a running herdr instance.
 */
export class FakeHerdr implements HerdrPort {
  panes: PaneInfo[] = [];
  workspaces: HerdrWorkspace[] = [];
  tabs: HerdrTab[] = [];
  readonly prompts: Array<{ paneId: string; text: string }> = [];
  readonly paneSplits: Array<{ workspaceRootPane: string; options: PaneSplitOptions }> = [];
  readonly paneCloses: string[] = [];
  readonly agentStarts: Array<{
    paneId: string;
    name: string;
    kind: string;
    argv: readonly string[];
  }> = [];
  readonly agentStartTimeouts: number[] = [];
  readonly agentStartFailures: HerdrCallFailed[] = [];
  listCalls = 0;
  workspaceListCalls = 0;
  readonly workspaceCreates: Array<{ label?: string; cwd?: string }> = [];
  readonly workspaceCloses: string[] = [];
  readonly tabCreates: Array<{ workspaceId: string; label?: string }> = [];
  readonly tabRenames: Array<{ id: string; label: string }> = [];
  readonly tabFocuses: string[] = [];
  readonly tabCloses: string[] = [];
  tabListCalls = 0;
  subscribeCalls = 0;
  private readonly eventSubscribers = new Set<HerdrSubscriptionOptions>();

  /** Set to make `paneList` fail the way an unreachable socket does. */
  listFailure: HerdrCallFailed | null = null;
  paneSplitFailure: HerdrCallFailed | null = null;
  paneCloseFailure: HerdrCallFailed | null = null;
  agentStartFailure: HerdrCallFailed | null = null;
  workspaceListFailure: HerdrCallFailed | null = null;
  workspaceCreateFailure: HerdrCallFailed | null = null;
  workspaceCloseFailure: HerdrCallFailed | null = null;
  tabListFailure: HerdrCallFailed | null = null;
  tabCreateFailure: HerdrCallFailed | null = null;
  tabRenameFailure: HerdrCallFailed | null = null;
  tabFocusFailure: HerdrCallFailed | null = null;
  tabCloseFailure: HerdrCallFailed | null = null;
  workspaceCreateResult: HerdrWorkspace | null = null;
  paneSplitResult: PaneInfo | null = null;

  subscribe(options: HerdrSubscriptionOptions): Promise<Result<HerdrSubscription, HerdrCallFailed>> {
    this.subscribeCalls += 1;
    this.eventSubscribers.add(options);
    let closed = false;
    return Promise.resolve(
      Result.ok({
        close: () => {
          closed = true;
          this.eventSubscribers.delete(options);
        },
        get closed() {
          return closed;
        },
      }),
    );
  }

  emitEvent(type: string): void {
    for (const subscriber of this.eventSubscribers) subscriber.onEvent({ type });
  }

  /** Consulted per pane so a test can fail one delivery and not another. */
  promptFailure: (paneId: string) => NoAgentAtTarget | HerdrCallFailed | null = () => null;

  /**
   * Runs after the pane list is produced. This is the window in which a real
   * agent's own read can land, between the batch snapshot and the injection.
   */
  afterList: () => void = () => undefined;

  /** Runs before each prompt, for tests that need to observe delivery starting. */
  beforePrompt: (paneId: string) => void = () => undefined;
  beforePaneClose: (paneId: string) => void = () => undefined;
  /** Runs after an agent is placed in a pane, so tests can bind its route. */
  afterAgentStart: (
    paneId: string,
    name: string,
    kind: string,
    argv: readonly string[],
  ) => void | Promise<void> = () => undefined;

  withPane(pane: Partial<PaneInfo> & { terminalId: string; paneId: string }): this {
    this.panes.push({
      agent: "claude",
      agentStatus: "idle",
      focused: false,
      ...pane,
    });
    return this;
  }

  paneList(): Promise<Result<PaneInfo[], HerdrCallFailed>> {
    this.listCalls += 1;
    if (this.listFailure !== null) return Promise.resolve(Result.err(this.listFailure));
    const listed = [...this.panes];
    this.afterList();
    return Promise.resolve(Result.ok(listed));
  }

  paneCurrent(): Promise<Result<PaneInfo, HerdrCallFailed>> {
    const first = this.panes[0];
    if (first === undefined) {
      return Promise.resolve(Result.err(transient("pane current", "no panes")));
    }
    return Promise.resolve(Result.ok(first));
  }

  paneSplit(
    workspaceRootPane: string,
    options: PaneSplitOptions = {},
  ): Promise<Result<PaneInfo, HerdrCallFailed>> {
    this.paneSplits.push({ workspaceRootPane, options: { ...options, env: { ...options.env } } });
    if (this.paneSplitFailure !== null) return Promise.resolve(Result.err(this.paneSplitFailure));

    const workspaceId = workspaceRootPane.split(":")[0] ?? workspaceRootPane;
    const created = this.paneSplitResult ?? {
      paneId: `${workspaceId}:spawned-${this.panes.length + 1}`,
      terminalId: `term-spawned-${this.panes.length + 1}`,
      agent: null,
      agentStatus: "unknown" as const,
      focused: false,
      workspaceId,
    };
    this.paneSplitResult = null;
    if (!this.panes.some((pane) => pane.paneId === created.paneId)) this.panes.push({ ...created });
    return Promise.resolve(Result.ok({ ...created }));
  }

  paneClose(paneId: string): Promise<Result<void, HerdrCallFailed>> {
    this.beforePaneClose(paneId);
    this.paneCloses.push(paneId);
    if (this.paneCloseFailure !== null) return Promise.resolve(Result.err(this.paneCloseFailure));
    this.panes = this.panes.filter((pane) => pane.paneId !== paneId);
    return Promise.resolve(Result.ok());
  }

  async agentStart(
    paneId: string,
    name: string,
    kind: string,
    argv: readonly string[],
    timeoutMs = HERDR_AGENT_START_TIMEOUT_MS,
  ): Promise<Result<void, HerdrCallFailed>> {
    this.agentStartTimeouts.push(timeoutMs);
    this.agentStarts.push({ paneId, name, kind, argv: [...argv] });
    const failure = this.agentStartFailures.shift() ?? this.agentStartFailure;
    if (failure !== null && failure !== undefined) return Result.err(failure);
    const pane = this.panes.find((candidate) => candidate.paneId === paneId);
    if (pane !== undefined) {
      pane.agent = kind;
      pane.agentStatus = "idle";
      pane.label = name;
    }
    await this.afterAgentStart(paneId, name, kind, argv);
    return Result.ok();
  }

  workspaceList(): Promise<Result<HerdrWorkspace[], HerdrCallFailed>> {
    this.workspaceListCalls += 1;
    if (this.workspaceListFailure !== null) {
      return Promise.resolve(Result.err(this.workspaceListFailure));
    }
    return Promise.resolve(Result.ok(this.workspaces.map((workspace) => ({ ...workspace }))));
  }

  workspaceCreate(
    label?: string,
    cwd?: string,
  ): Promise<Result<HerdrWorkspace, HerdrCallFailed>> {
    this.workspaceCreates.push({ label, cwd });
    if (this.workspaceCreateFailure !== null) {
      return Promise.resolve(Result.err(this.workspaceCreateFailure));
    }

    const created = this.workspaceCreateResult ?? {
      id: `w${this.workspaces.length + 1}`,
      label: label === undefined || label.length === 0 ? null : label,
    };
    if (!this.workspaces.some((workspace) => workspace.id === created.id)) {
      this.workspaces.push({ ...created });
    }
    return Promise.resolve(Result.ok({ ...created }));
  }

  workspaceClose(id: string): Promise<Result<void, HerdrCallFailed>> {
    this.workspaceCloses.push(id);
    if (this.workspaceCloseFailure !== null) {
      return Promise.resolve(Result.err(this.workspaceCloseFailure));
    }
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== id);
    this.panes = this.panes.filter((pane) => {
      const workspaceId = pane.workspaceId ?? pane.paneId.split(":")[0];
      return workspaceId !== id;
    });
    this.tabs = this.tabs.filter((tab) => tab.workspaceId !== id);
    return Promise.resolve(Result.ok());
  }

  tabList(): Promise<Result<HerdrTab[], HerdrCallFailed>> {
    this.tabListCalls += 1;
    if (this.tabListFailure !== null) return Promise.resolve(Result.err(this.tabListFailure));
    return Promise.resolve(Result.ok(this.tabs.map((tab) => ({ ...tab }))));
  }

  tabCreate(
    workspaceId: string,
    label?: string,
  ): Promise<Result<HerdrTab, HerdrCallFailed>> {
    this.tabCreates.push({ workspaceId, label });
    if (this.tabCreateFailure !== null) return Promise.resolve(Result.err(this.tabCreateFailure));

    const created = {
      id: `${workspaceId}:t${this.tabs.length + 1}`,
      workspaceId,
      label: label === undefined || label.length === 0 ? null : label,
    };
    this.tabs.push(created);
    return Promise.resolve(Result.ok({ ...created }));
  }

  tabRename(id: string, label: string): Promise<Result<void, HerdrCallFailed>> {
    this.tabRenames.push({ id, label });
    if (this.tabRenameFailure !== null) return Promise.resolve(Result.err(this.tabRenameFailure));
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (tab !== undefined) tab.label = label.length === 0 ? null : label;
    return Promise.resolve(Result.ok());
  }

  tabFocus(id: string): Promise<Result<void, HerdrCallFailed>> {
    this.tabFocuses.push(id);
    if (this.tabFocusFailure !== null) return Promise.resolve(Result.err(this.tabFocusFailure));
    return Promise.resolve(Result.ok());
  }

  tabClose(id: string): Promise<Result<void, HerdrCallFailed>> {
    this.tabCloses.push(id);
    if (this.tabCloseFailure !== null) return Promise.resolve(Result.err(this.tabCloseFailure));
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    this.panes = this.panes.filter((pane) => pane.tabId !== id);
    return Promise.resolve(Result.ok());
  }

  agentPrompt(
    paneId: string,
    text: string,
  ): Promise<Result<void, NoAgentAtTarget | HerdrCallFailed>> {
    this.beforePrompt(paneId);
    const failure = this.promptFailure(paneId);
    if (failure !== null) return Promise.resolve(Result.err(failure));
    this.prompts.push({ paneId, text });
    return Promise.resolve(Result.ok());
  }
}
