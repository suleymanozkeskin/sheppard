/**
 * Reading an agent's harness session — the second half of bring-your-own-harness.
 *
 * A harness is not only how to spawn an agent; it is how to read what that agent
 * did. Four constraints are enforced by the shapes in this file rather than by
 * the caller's care:
 *
 *   1. WINDOWS, NOT FILES. `WindowReader` offers a size and a byte slice and no
 *      whole-file read, so a bounded read is the only read available. Measured
 *      transcripts reach 83 MB on this fleet.
 *   2. CONTENT BEATS RECENCY. Nothing here reads a file's modification time.
 *      Candidates carry a started-at taken from their own content, so recency
 *      cannot become a tiebreaker by accident.
 *   3. ENVIRONMENT DECIDES LOCATION. `locate` receives the pane's environment;
 *      this module never reads the hub's own. A harness that writes where an
 *      env var says must be read from where that env var says.
 *   4. UNKNOWN IS NOT ABSENT. A successful search that finds nothing returns an
 *      empty list; a search that could not look returns an error. They are
 *      different types, so a reader cannot report "nothing there" when it means
 *      "I could not see".
 */

import { Database } from "bun:sqlite";
import { Result, TaggedError } from "better-result";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type JsonObject, type JsonValue, decodeObject, isObject, isString } from "./json";
import type { SessionCandidateView, SessionMappingView, SessionTurnView } from "./types";

/** The harness has no transcript reader: an honest gap, not a failure. */
export class TranscriptUnsupported extends TaggedError("TranscriptUnsupported")<{
  harness: string;
  message: string;
}> {}

/** The reader could not look. Never rendered as an empty session. */
export class TranscriptUnreadable extends TaggedError("TranscriptUnreadable")<{
  reason: string;
  message: string;
}> {}

/** The wire contract is the domain contract: one definition, not two. */
export type SessionTurn = SessionTurnView;
export type SessionCandidate = SessionCandidateView;
export type MappingConfidence = SessionMappingView["confidence"];

export interface SessionMapping {
  confidence: MappingConfidence;
  chosen: SessionCandidate | null;
  /** Rendered by the picker when the ladder cannot decide. */
  candidates: SessionCandidate[];
}

/**
 * The only file access this module has. There is no whole-file read here, and
 * that absence is the windowing guarantee — a caller cannot ask for 83 MB
 * because the interface will not express it.
 *
 * `list` carries the three-way answer in its type. An error means the reader
 * could not look; `null` means the directory is not there; an array means it
 * looked and found. A caller cannot collapse "could not look" into "nothing
 * there" without deleting a branch the type forces it to write.
 */
export interface WindowReader {
  list(dir: string): Promise<Result<string[] | null, TranscriptUnreadable>>;
  size(path: string): Promise<Result<number, TranscriptUnreadable>>;
  slice(path: string, start: number, end: number): Promise<Result<string, TranscriptUnreadable>>;
}

function unreadable(reason: string, detail: string): TranscriptUnreadable {
  return new TranscriptUnreadable({ reason, message: `session ${reason}: ${detail}` });
}

interface ErrnoLike {
  code?: string;
}

/** True for the errors that mean "not there", as opposed to "could not look". */
function isMissing(cause: unknown): boolean {
  // SAFETY: node rejects a directory read with an Error carrying `code`. Any
  // other shape reads as undefined, which is treated as a failure to look
  // rather than as absence — the safe direction for this question.
  const code = (cause as ErrnoLike | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function bunWindowReader(): WindowReader {
  return {
    async list(dir) {
      const listed = await Result.tryPromise({
        try: () => readdir(dir),
        catch: (cause) => cause,
      });
      if (listed.isOk()) return Result.ok(listed.value);
      return isMissing(listed.error)
        ? Result.ok(null)
        : Result.err(unreadable("list failed", `${dir} (${String(listed.error)})`));
    },
    async size(path) {
      return Result.tryPromise({
        try: async () => (await stat(path)).size,
        catch: (cause) => unreadable("stat failed", `${path} (${String(cause)})`),
      });
    },
    async slice(path, start, end) {
      return Result.tryPromise({
        try: () => Bun.file(path).slice(start, end).text(),
        catch: (cause) => unreadable("read failed", `${path} (${String(cause)})`),
      });
    },
  };
}

/** Bytes read to identify a candidate. Bounded, and small enough to run per file. */
export const HEAD_BYTES = 16_384;
/** Bytes read for one page of turns. Grown by doubling, never unbounded. */
export const WINDOW_BYTES = 65_536;
export const MAX_WINDOW_BYTES = 1_048_576;
export const DEFAULT_TURN_LIMIT = 50;
const MAX_TOOL_SUMMARY = 200;

function summarise(value: JsonValue | undefined): string {
  const text = value !== undefined && value !== null && isString(value)
    ? value
    : JSON.stringify(value ?? "");
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_TOOL_SUMMARY ? `${flat.slice(0, MAX_TOOL_SUMMARY)}…` : flat;
}

/**
 * One JSONL line in, zero or more session lines out. An unrecognised line is a
 * SKIP — it adds no turn and no error text, because a transcript carries
 * bookkeeping the panel has no business rendering.
 */
export interface TranscriptAdapter {
  readonly harness: string;
  /**
   * Where this harness writes, resolved from the pane's environment. An empty
   * list is absence; the error is reserved for a search that could not run.
   */
  locate(
    pane: { cwd: string; env: Readonly<Record<string, string | undefined>> },
    reader: WindowReader,
  ): Promise<Result<SessionCandidate[], TranscriptUnreadable>>;
  parse(line: string): SessionTurn[];
  /** The session's own recorded cwd and start, from its head lines. */
  identify(head: string): { startedAt: string | null; cwd: string | null };
  /**
   * Join two adjacent turns when the harness streams one utterance as chunks.
   * Absent means every parsed turn stays distinct.
   */
  mergeConsecutive?(older: SessionTurn, newer: SessionTurn): SessionTurn | null;
  /**
   * Reads one window itself, for a harness that keeps sessions in a database
   * instead of one JSONL file. `before` is the cursor that this same adapter
   * returned as `nextBefore`. Absent means `readWindow` pages the file.
   */
  readSession?(
    path: string,
    reader: WindowReader,
    options: { before: number | null; limit: number },
  ): Promise<Result<SessionWindow, TranscriptUnreadable>>;
}

/**
 * One JSONL line decoded at its boundary. Anything that is not an object — a
 * blank line, a truncated line at a window edge, a bare literal — reads as
 * null, which every caller treats as a skip.
 */
function parseJsonLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(trimmed),
    catch: () => null,
  });
  return parsed.isErr() ? null : decodeObject(parsed.value).unwrapOr(null);
}

/** Reads a field only when it holds the shape asked for; otherwise null. */
function textField(row: JsonObject, field: string): string | null {
  const value = row[field];
  return value !== undefined && isString(value) ? value : null;
}

function objectField(row: JsonObject, field: string): JsonObject | null {
  const value = row[field];
  return value !== undefined && isObject(value) ? value : null;
}

/**
 * claude slugifies the working directory into one path segment; every character
 * outside [A-Za-z0-9] becomes a dash. Measured against live directories:
 * `/opt/homebrew/lib/node_modules/pyright/dist` is stored as
 * `-opt-homebrew-lib-node-modules-pyright-dist`, so `_` and `.` fold too.
 */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, "-");
}

export interface ConfigDirectory {
  dir: string;
  /** True when the environment named it, false when the default was assumed. */
  fromEnvironment: boolean;
}

/**
 * CLAUDE_CONFIG_DIR decides where claude writes. This fleet sets it, while the
 * default directory also exists and is populated — so a reader that assumes the
 * default finds a real, wrong history and looks like it worked. The environment
 * is asked first and the default is used only when the environment is silent,
 * which is the same rule the harness itself follows.
 */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): ConfigDirectory {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured.trim().length > 0) {
    return { dir: configured, fromEnvironment: true };
  }
  return { dir: join(homedir(), ".claude"), fromEnvironment: false };
}

function textFromContent(content: JsonValue | undefined): string {
  if (content === undefined || content === null) return "";
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    const text = item.text;
    if (text !== undefined && isString(text)) parts.push(text);
  }
  return parts.join("\n").trim();
}

export const claudeAdapter: TranscriptAdapter = {
  harness: "claude",

  async locate(pane, reader) {
    const { dir } = claudeConfigDir(pane.env);
    const projectDir = join(dir, "projects", slugifyCwd(pane.cwd));
    const listed = await reader.list(projectDir);
    // Three answers, three branches. A missing project directory is absence:
    // the agent has written no session for this working directory. A failed
    // read is not absence, and is never reported as one.
    if (listed.isErr()) return Result.err(listed.error);
    if (listed.value === null) return Result.ok([]);

    const candidates: SessionCandidate[] = [];
    for (const name of listed.value) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(projectDir, name);
      const sized = await reader.size(path);
      if (sized.isErr()) return Result.err(sized.error);
      const head = await reader.slice(path, 0, Math.min(HEAD_BYTES, sized.value));
      if (head.isErr()) return Result.err(head.error);
      const identity = claudeAdapter.identify(head.value);
      candidates.push({
        sessionId: name.replace(/\.jsonl$/u, ""),
        path,
        startedAt: identity.startedAt,
        sizeBytes: sized.value,
        cwd: identity.cwd,
        firstUserText: firstUserTextOf(claudeAdapter, head.value),
      });
    }
    return Result.ok(candidates);
  },

  identify(head) {
    for (const line of head.split("\n")) {
      const row = parseJsonLine(line);
      if (row === null) continue;
      const at = textField(row, "timestamp");
      const cwd = textField(row, "cwd");
      if (at !== null || cwd !== null) return { startedAt: at, cwd };
    }
    return { startedAt: null, cwd: null };
  },

  parse(line) {
    const row = parseJsonLine(line);
    if (row === null) return [];
    const at = textField(row, "timestamp");
    const sidechain = row.isSidechain === true;
    const message = objectField(row, "message");
    if (message === null) return [];

    switch (row.type) {
      case "user": {
        const out: SessionTurn[] = [];
        const content = message.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!isObject(item)) continue;
            if (item.type !== "tool_result") continue;
            out.push({
              kind: "tool",
              role: null,
              text: summarise(item.content),
              tool: { name: "result", outcome: item.is_error === true ? "error" : "ok" },
              at,
              sidechain,
            });
          }
        }
        const text = textFromContent(content);
        if (text.length > 0) {
          out.unshift({ kind: "turn", role: "user", text, tool: null, at, sidechain });
        }
        return out;
      }
      case "assistant": {
        const out: SessionTurn[] = [];
        const content = message.content;
        const text = textFromContent(content);
        if (text.length > 0) {
          out.push({ kind: "turn", role: "assistant", text, tool: null, at, sidechain });
        }
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!isObject(item)) continue;
            if (item.type !== "tool_use") continue;
            out.push({
              kind: "tool",
              role: null,
              text: summarise(item.input),
              tool: { name: textField(item, "name") ?? "tool", outcome: "unknown" },
              at,
              sidechain,
            });
          }
        }
        return out;
      }
      default:
        // Bookkeeping lines (ai-title, mode, file-history-*, …) are skipped in
        // silence: no turn, no error text.
        return [];
    }
  },
};

/**
 * CODEX_HOME decides where codex writes, the same way CLAUDE_CONFIG_DIR does
 * for claude. It is a named helper for the same reason: a caller that needs to
 * know where the reader will look must ask, not restate the expression.
 */
export function codexHome(env: Readonly<Record<string, string | undefined>>): ConfigDirectory {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.trim().length > 0) {
    return { dir: configured, fromEnvironment: true };
  }
  return { dir: join(homedir(), ".codex"), fromEnvironment: false };
}

export const codexAdapter: TranscriptAdapter = {
  harness: "codex",

  async locate(pane, reader) {
    const { dir: home } = codexHome(pane.env);
    const root = join(home, "sessions");
    const dayDirs = await codexDayDirs(root, reader);
    if (dayDirs.isErr()) return Result.err(dayDirs.error);

    const candidates: SessionCandidate[] = [];
    for (const dayDir of dayDirs.value) {
      const listed = await reader.list(dayDir);
      if (listed.isErr()) return Result.err(listed.error);
      if (listed.value === null) continue;
      for (const name of listed.value) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const path = join(dayDir, name);
        const sized = await reader.size(path);
        if (sized.isErr()) return Result.err(sized.error);
        const head = await reader.slice(path, 0, Math.min(HEAD_BYTES, sized.value));
        if (head.isErr()) return Result.err(head.error);
        const identity = codexAdapter.identify(head.value);
        // The recorded cwd is the only honest filter: one day directory holds
        // every workspace's sessions.
        if (identity.cwd !== null && identity.cwd !== pane.cwd) continue;
        candidates.push({
          sessionId: name.replace(/^rollout-/u, "").replace(/\.jsonl$/u, ""),
          path,
          startedAt: identity.startedAt,
          sizeBytes: sized.value,
          cwd: identity.cwd,
          firstUserText: firstUserTextOf(codexAdapter, head.value),
        });
      }
    }
    return Result.ok(candidates);
  },

  identify(head) {
    for (const line of head.split("\n")) {
      const row = parseJsonLine(line);
      if (row === null) continue;
      if (row.type !== "session_meta") continue;
      const payload = objectField(row, "payload");
      if (payload === null) return { startedAt: textField(row, "timestamp"), cwd: null };
      return {
        startedAt: textField(payload, "timestamp") ?? textField(row, "timestamp"),
        cwd: textField(payload, "cwd"),
      };
    }
    return { startedAt: null, cwd: null };
  },

  parse(line) {
    const row = parseJsonLine(line);
    if (row === null) return [];
    if (row.type !== "response_item") return [];
    const at = textField(row, "timestamp");
    const payload = objectField(row, "payload");
    if (payload === null) return [];

    switch (payload.type) {
      case "message": {
        const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
        // `developer` and system roles are harness scaffolding, not the session.
        if (role === null) return [];
        const text = textFromContent(payload.content);
        if (text.length === 0) return [];
        return [{ kind: "turn", role, text, tool: null, at, sidechain: false }];
      }
      case "function_call":
      case "local_shell_call": {
        return [{
          kind: "tool",
          role: null,
          text: summarise(payload.arguments ?? payload.action),
          tool: { name: textField(payload, "name") ?? "shell", outcome: "unknown" },
          at,
          sidechain: false,
        }];
      }
      case "function_call_output": {
        return [{
          kind: "tool",
          role: null,
          text: summarise(payload.output),
          tool: { name: "result", outcome: payload.success === false ? "error" : "ok" },
          at,
          sidechain: false,
        }];
      }
      default:
        return [];
    }
  },
};

export const MAX_GROK_SESSION_GROUPS = 256;
export const MAX_GROK_SESSION_DIR_ENTRIES = 4_096;
const MAX_ENCODED_CWD_LENGTH = 255;
const MAX_GROK_CWD_MARKER_BYTES = 4_096;
const GROK_TRANSCRIPT = "updates.jsonl";
const GROK_CWD_MARKER = ".cwd";

/**
 * GROK_HOME decides where grok writes, the same way CLAUDE_CONFIG_DIR does for
 * claude. Ask this helper; do not restate the default path at a call site.
 */
export function grokHome(env: Readonly<Record<string, string | undefined>>): ConfigDirectory {
  const configured = env.GROK_HOME;
  if (configured !== undefined && configured.trim().length > 0) {
    return { dir: configured, fromEnvironment: true };
  }
  return { dir: join(homedir(), ".grok"), fromEnvironment: false };
}

export function grokEncodedCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

function grokUnixToIso(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const ms = value > 1e12 ? value : value * 1_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function grokAt(row: JsonObject): string | null {
  const text = textField(row, "timestamp");
  if (text !== null) {
    const numeric = Number(text);
    return Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/u.test(text) ? grokUnixToIso(numeric) : text;
  }
  const numeric = Number(row.timestamp);
  return Number.isFinite(numeric) ? grokUnixToIso(numeric) : null;
}

function grokSessionUpdate(row: JsonObject): JsonObject | null {
  const params = objectField(row, "params");
  if (params === null) return null;
  return objectField(params, "update");
}

function grokChunkText(update: JsonObject): string {
  const content = objectField(update, "content");
  if (content === null) return "";
  return textField(content, "text") ?? "";
}

function grokToolName(update: JsonObject): string {
  const meta = objectField(update, "_meta");
  const tool = meta === null ? null : objectField(meta, "x.ai/tool");
  const named = tool === null ? null : textField(tool, "name");
  return named ?? textField(update, "title") ?? "tool";
}

function mergeGrokTurns(older: SessionTurn, newer: SessionTurn): SessionTurn | null {
  if (older.kind !== "turn" || newer.kind !== "turn") return null;
  if (older.role === null || older.role !== newer.role) return null;
  if (older.sidechain !== newer.sidechain || older.tool !== null || newer.tool !== null) return null;
  return {
    kind: "turn",
    role: older.role,
    text: `${older.text}${newer.text}`,
    tool: null,
    at: older.at,
    sidechain: older.sidechain,
  };
}

async function grokOverflowGroups(
  root: string,
  cwd: string,
  reader: WindowReader,
): Promise<Result<string[], TranscriptUnreadable>> {
  const listed = await reader.list(root);
  if (listed.isErr()) return Result.err(listed.error);
  if (listed.value === null) return Result.ok([]);
  if (listed.value.length > MAX_GROK_SESSION_DIR_ENTRIES) {
    return Result.err(
      unreadable("list bounded", `${listed.value.length} session groups exceeds ${MAX_GROK_SESSION_DIR_ENTRIES}`),
    );
  }
  const dirs: string[] = [];
  let overflowGroups = 0;
  for (const name of listed.value) {
    const group = join(root, name);
    const children = await reader.list(group);
    if (children.isErr()) return Result.err(children.error);
    if (children.value === null || !children.value.includes(GROK_CWD_MARKER)) continue;
    overflowGroups += 1;
    if (overflowGroups > MAX_GROK_SESSION_GROUPS) {
      return Result.err(
        unreadable("list bounded", `more than ${MAX_GROK_SESSION_GROUPS} overflow groups`),
      );
    }
    const marker = join(group, GROK_CWD_MARKER);
    const sized = await reader.size(marker);
    if (sized.isErr()) return Result.err(sized.error);
    const body = await reader.slice(marker, 0, Math.min(MAX_GROK_CWD_MARKER_BYTES, sized.value));
    if (body.isErr()) return Result.err(body.error);
    if (body.value.trim() === cwd) dirs.push(group);
  }
  return Result.ok(dirs);
}

async function grokGroupDirs(
  root: string,
  cwd: string,
  reader: WindowReader,
): Promise<Result<string[], TranscriptUnreadable>> {
  const encoded = grokEncodedCwd(cwd);
  if (encoded.length > MAX_ENCODED_CWD_LENGTH) return grokOverflowGroups(root, cwd, reader);
  const listed = await reader.list(join(root, encoded));
  if (listed.isErr()) return Result.err(listed.error);
  return Result.ok(listed.value === null ? [] : [join(root, encoded)]);
}

export const grokAdapter: TranscriptAdapter = {
  harness: "grok",

  async locate(pane, reader) {
    const { dir } = grokHome(pane.env);
    const groups = await grokGroupDirs(join(dir, "sessions"), pane.cwd, reader);
    if (groups.isErr()) return Result.err(groups.error);
    const candidates: SessionCandidate[] = [];
    for (const group of groups.value) {
      const listed = await reader.list(group);
      if (listed.isErr()) return Result.err(listed.error);
      if (listed.value === null) continue;
      for (const name of listed.value) {
        const sessionDir = join(group, name);
        const children = await reader.list(sessionDir);
        if (children.isErr()) return Result.err(children.error);
        if (children.value === null || !children.value.includes(GROK_TRANSCRIPT)) continue;
        const path = join(sessionDir, GROK_TRANSCRIPT);
        const sized = await reader.size(path);
        if (sized.isErr()) return Result.err(sized.error);
        const head = await reader.slice(path, 0, Math.min(HEAD_BYTES, sized.value));
        if (head.isErr()) return Result.err(head.error);
        const identity = grokAdapter.identify(head.value);
        candidates.push({
          sessionId: name,
          path,
          startedAt: identity.startedAt,
          sizeBytes: sized.value,
          cwd: pane.cwd,
          firstUserText: firstUserTextOf(grokAdapter, head.value),
        });
      }
    }
    return Result.ok(candidates);
  },

  identify(head) {
    for (const line of head.split("\n")) {
      const row = parseJsonLine(line);
      if (row === null) continue;
      const at = grokAt(row);
      if (at !== null) return { startedAt: at, cwd: null };
    }
    return { startedAt: null, cwd: null };
  },

  parse(line) {
    const row = parseJsonLine(line);
    if (row === null) return [];
    const update = grokSessionUpdate(row);
    if (update === null) return [];
    const kind = textField(update, "sessionUpdate");
    const at = grokAt(row);
    switch (kind) {
      case "user_message_chunk":
      case "agent_message_chunk": {
        const text = grokChunkText(update);
        if (text.length === 0) return [];
        return [{
          kind: "turn",
          role: kind === "user_message_chunk" ? "user" : "assistant",
          text,
          tool: null,
          at,
          sidechain: false,
        }];
      }
      case "tool_call":
        return [{
          kind: "tool",
          role: null,
          text: summarise(objectField(update, "rawInput") ?? textField(update, "title")),
          tool: { name: grokToolName(update), outcome: "unknown" },
          at,
          sidechain: false,
        }];
      default:
        return [];
    }
  },

  mergeConsecutive: mergeGrokTurns,
};

/** Session files one pi working directory may hold before the listing is refused. */
export const MAX_PI_SESSION_FILES = 4_096;

/**
 * PI_CODING_AGENT_DIR decides where pi writes, with a leading `~` expanded the
 * way pi expands it. Ask this helper; do not restate the default path.
 */
export function piAgentDir(env: Readonly<Record<string, string | undefined>>): ConfigDirectory {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured !== undefined && configured.trim().length > 0) {
    const expanded = configured === "~" || configured.startsWith("~/")
      ? join(homedir(), configured.slice(1))
      : configured;
    return { dir: expanded, fromEnvironment: true };
  }
  return { dir: join(homedir(), ".pi", "agent"), fromEnvironment: false };
}

/**
 * pi's own session directory name for a working directory: the leading
 * separator dropped, every `/`, `\` and `:` folded to a dash, wrapped in `--`.
 */
export function piEncodedCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

/** The session header, the first line of every pi session file. */
interface PiHeader {
  sessionId: string;
  startedAt: string | null;
  cwd: string | null;
}

function piHeader(head: string): PiHeader | null {
  for (const line of head.split("\n")) {
    const row = parseJsonLine(line);
    if (row === null) continue;
    if (row.type !== "session") return null;
    const sessionId = textField(row, "id");
    if (sessionId === null) return null;
    return { sessionId, startedAt: textField(row, "timestamp"), cwd: textField(row, "cwd") };
  }
  return null;
}

function piToolTurns(content: JsonValue | undefined, at: string | null): SessionTurn[] {
  if (!Array.isArray(content)) return [];
  const out: SessionTurn[] = [];
  for (const item of content) {
    if (!isObject(item) || item.type !== "toolCall") continue;
    out.push({
      kind: "tool",
      role: null,
      text: summarise(item.arguments),
      tool: { name: textField(item, "name") ?? "tool", outcome: "unknown" },
      at,
      sidechain: false,
    });
  }
  return out;
}

function piMessageTurns(message: JsonObject, at: string | null): SessionTurn[] {
  switch (message.role) {
    case "user": {
      const text = textFromContent(message.content);
      return text.length === 0 ? [] : [{ kind: "turn", role: "user", text, tool: null, at, sidechain: false }];
    }
    case "assistant": {
      const text = textFromContent(message.content);
      const said: SessionTurn[] = text.length === 0
        ? []
        : [{ kind: "turn", role: "assistant", text, tool: null, at, sidechain: false }];
      return [...said, ...piToolTurns(message.content, at)];
    }
    case "toolResult":
      return [{
        kind: "tool",
        role: null,
        text: summarise(message.content),
        tool: { name: "result", outcome: message.isError === true ? "error" : "ok" },
        at,
        sidechain: false,
      }];
    default:
      return [];
  }
}

export const piAdapter: TranscriptAdapter = {
  harness: "pi",

  async locate(pane, reader) {
    const { dir } = piAgentDir(pane.env);
    const sessionDir = join(dir, "sessions", piEncodedCwd(pane.cwd));
    const listed = await reader.list(sessionDir);
    if (listed.isErr()) return Result.err(listed.error);
    if (listed.value === null) return Result.ok([]);
    if (listed.value.length > MAX_PI_SESSION_FILES) {
      return Result.err(unreadable("list bounded", `${listed.value.length} session files exceeds ${MAX_PI_SESSION_FILES}`));
    }
    const candidates: SessionCandidate[] = [];
    for (const name of listed.value) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      const sized = await reader.size(path);
      if (sized.isErr()) return Result.err(sized.error);
      const head = await reader.slice(path, 0, Math.min(HEAD_BYTES, sized.value));
      if (head.isErr()) return Result.err(head.error);
      // A file without a session header is not a pi session and is skipped.
      const header = piHeader(head.value);
      if (header === null) continue;
      // Two working directories can fold to one name; the header decides.
      if (header.cwd !== null && header.cwd !== pane.cwd) continue;
      candidates.push({
        sessionId: header.sessionId,
        path,
        startedAt: header.startedAt,
        sizeBytes: sized.value,
        cwd: header.cwd,
        firstUserText: firstUserTextOf(piAdapter, head.value),
      });
    }
    return Result.ok(candidates);
  },

  identify(head) {
    const header = piHeader(head);
    return header === null ? { startedAt: null, cwd: null } : { startedAt: header.startedAt, cwd: header.cwd };
  },

  parse(line) {
    const row = parseJsonLine(line);
    if (row === null || row.type !== "message") return [];
    const message = objectField(row, "message");
    return message === null ? [] : piMessageTurns(message, textField(row, "timestamp"));
  },
};

/** Top-level sessions one OpenCode working directory may hold before the listing is refused. */
export const MAX_OPENCODE_SESSIONS = 1_000;
/** Part rows read per query while paging a session. */
export const OPENCODE_PAGE_ROWS = 200;
/** Part rows one window read may touch in total. */
export const MAX_OPENCODE_WINDOW_ROWS = 4_000;
const OPENCODE_DATABASE = "opencode.db";
/** Separates the database path from the session id in a candidate's `path`. */
const OPENCODE_SESSION_SEPARATOR = "#";

/**
 * XDG_DATA_HOME decides where OpenCode keeps its data, the way
 * CLAUDE_CONFIG_DIR does for claude. Its sessions live in one SQLite database.
 */
export function opencodeDataDir(env: Readonly<Record<string, string | undefined>>): ConfigDirectory {
  const configured = env.XDG_DATA_HOME;
  if (configured !== undefined && configured.trim().length > 0) {
    return { dir: join(configured, "opencode"), fromEnvironment: true };
  }
  return { dir: join(homedir(), ".local", "share", "opencode"), fromEnvironment: false };
}

/** One OpenCode session: the database that holds it and its id. */
export interface OpencodeSessionRef {
  databasePath: string;
  sessionId: string;
}

/**
 * A session has no file of its own, so its stored `path` names the database
 * and the session together. `parseOpencodeSessionPath` is the only reader.
 */
export function opencodeSessionPath(ref: OpencodeSessionRef): string {
  return `${ref.databasePath}${OPENCODE_SESSION_SEPARATOR}${ref.sessionId}`;
}

export function parseOpencodeSessionPath(path: string): Result<OpencodeSessionRef, TranscriptUnreadable> {
  const at = path.lastIndexOf(OPENCODE_SESSION_SEPARATOR);
  const databasePath = at < 0 ? "" : path.slice(0, at);
  const sessionId = at < 0 ? "" : path.slice(at + 1);
  if (!databasePath.endsWith(OPENCODE_DATABASE) || sessionId.length === 0) {
    return Result.err(unreadable("path invalid", `${path} does not name an OpenCode session`));
  }
  return Result.ok({ databasePath, sessionId });
}

/** Opens the database read-only for one body. Open and query failures are "could not look". */
function withOpencodeDatabase<T>(path: string, body: (db: Database) => T): Result<T, TranscriptUnreadable> {
  return Result.try({
    try: () => {
      const db = new Database(path, { readonly: true, strict: true });
      try {
        return body(db);
      } finally {
        db.close();
      }
    },
    catch: (cause) => unreadable("database read failed", `${path} (${String(cause)})`),
  });
}

function opencodeAt(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function opencodePartTurns(role: string | null, at: string | null, part: JsonObject): SessionTurn[] {
  switch (part.type) {
    case "text": {
      // Synthetic parts are text the harness added, not what was said.
      if (part.synthetic === true) return [];
      const text = (textField(part, "text") ?? "").trim();
      const speaker = role === "user" ? "user" : role === "assistant" ? "assistant" : null;
      if (text.length === 0 || speaker === null) return [];
      return [{ kind: "turn", role: speaker, text, tool: null, at, sidechain: false }];
    }
    case "tool": {
      const state = objectField(part, "state");
      const status = state === null ? null : textField(state, "status");
      const outcome = status === "completed" ? "ok" : status === "error" ? "error" : "unknown";
      return [{
        kind: "tool",
        role: null,
        text: summarise(state?.input),
        tool: { name: textField(part, "tool") ?? "tool", outcome },
        at,
        sidechain: false,
      }];
    }
    default:
      return [];
  }
}

interface OpencodeSessionRow {
  id: string;
  time_created: number;
  size_bytes: number;
}

function opencodeFirstUserText(db: Database, sessionId: string): string | null {
  const row = db
    .query<{ text: string | null }, { sessionId: string }>(
      `SELECT json_extract(p.data, '$.text') AS text
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = $sessionId
          AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
          AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
        ORDER BY p.rowid
        LIMIT 1`,
    )
    .get({ sessionId });
  return row === null || row.text === null ? null : row.text.trim();
}

function opencodeCandidates(
  db: Database,
  databasePath: string,
  cwd: string,
): Result<SessionCandidate[], TranscriptUnreadable> {
  const rows = db
    .query<OpencodeSessionRow, { cwd: string; limit: number }>(
      `SELECT s.id, s.time_created,
              (SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p WHERE p.session_id = s.id) AS size_bytes
         FROM session s
        WHERE s.directory = $cwd AND s.parent_id IS NULL
        ORDER BY s.time_created DESC
        LIMIT $limit`,
    )
    .all({ cwd, limit: MAX_OPENCODE_SESSIONS + 1 });
  if (rows.length > MAX_OPENCODE_SESSIONS) {
    return Result.err(unreadable("list bounded", `more than ${MAX_OPENCODE_SESSIONS} sessions for ${cwd}`));
  }
  return Result.ok(rows.map((row) => ({
    sessionId: row.id,
    path: opencodeSessionPath({ databasePath, sessionId: row.id }),
    startedAt: opencodeAt(row.time_created),
    sizeBytes: row.size_bytes,
    cwd,
    firstUserText: opencodeFirstUserText(db, row.id),
  })));
}

interface OpencodePartRow {
  seq: number;
  time_created: number;
  role: string | null;
  data: string;
}

function opencodePartRows(db: Database, sessionId: string, before: number): OpencodePartRow[] {
  return db
    .query<OpencodePartRow, { sessionId: string; before: number; limit: number }>(
      `SELECT p.rowid AS seq, p.time_created, json_extract(m.data, '$.role') AS role, p.data
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = $sessionId AND p.rowid < $before
        ORDER BY p.rowid DESC
        LIMIT $limit`,
    )
    .all({ sessionId, before, limit: OPENCODE_PAGE_ROWS });
}

function opencodeRowTurns(row: OpencodePartRow): SessionTurn[] {
  const part = parseJsonLine(row.data);
  return part === null ? [] : opencodePartTurns(row.role, opencodeAt(row.time_created), part);
}

/**
 * Turns newest first, whole part rows only, until `limit` turns or the row
 * bound. The cursor is the part rowid, which never changes for a stored part.
 */
function opencodePage(db: Database, sessionId: string, before: number | null, limit: number): SessionWindow {
  const picked: SessionTurn[][] = [];
  let counted = 0;
  let cursor = before ?? Number.MAX_SAFE_INTEGER;
  let rowsRead = 0;
  let bytesRead = 0;
  scan: while (rowsRead < MAX_OPENCODE_WINDOW_ROWS) {
    const rows = opencodePartRows(db, sessionId, cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      const turns = opencodeRowTurns(row);
      if (turns.length > 0 && counted > 0 && counted + turns.length > limit) break scan;
      rowsRead += 1;
      bytesRead += row.data.length;
      cursor = row.seq;
      if (turns.length === 0) continue;
      picked.unshift(turns);
      counted += turns.length;
      if (counted >= limit) break scan;
    }
  }
  const older = db
    .query<{ one: number }, { sessionId: string; cursor: number }>(
      `SELECT 1 AS one FROM part WHERE session_id = $sessionId AND rowid < $cursor LIMIT 1`,
    )
    .get({ sessionId, cursor });
  return { turns: picked.flat(), nextBefore: older === null ? null : cursor, bytesRead };
}

export const opencodeAdapter: TranscriptAdapter = {
  harness: "opencode",

  async locate(pane, reader) {
    const { dir } = opencodeDataDir(pane.env);
    const listed = await reader.list(dir);
    if (listed.isErr()) return Result.err(listed.error);
    if (listed.value === null || !listed.value.includes(OPENCODE_DATABASE)) return Result.ok([]);
    const databasePath = join(dir, OPENCODE_DATABASE);
    const found = withOpencodeDatabase(databasePath, (db) => opencodeCandidates(db, databasePath, pane.cwd));
    return found.isErr() ? Result.err(found.error) : found.value;
  },

  identify(head) {
    for (const line of head.split("\n")) {
      const row = parseJsonLine(line);
      if (row === null) continue;
      return { startedAt: textField(row, "at"), cwd: null };
    }
    return { startedAt: null, cwd: null };
  },

  /** One line is `{"role", "at", "part"}`: a part row joined with its message role. */
  parse(line) {
    const row = parseJsonLine(line);
    if (row === null) return [];
    const part = objectField(row, "part");
    return part === null ? [] : opencodePartTurns(textField(row, "role"), textField(row, "at"), part);
  },

  async readSession(path, reader, options) {
    const ref = parseOpencodeSessionPath(path);
    if (ref.isErr()) return Result.err(ref.error);
    const sized = await reader.size(ref.value.databasePath);
    if (sized.isErr()) return Result.err(sized.error);
    return withOpencodeDatabase(ref.value.databasePath, (db) =>
      opencodePage(db, ref.value.sessionId, options.before, options.limit));
  },
};

async function codexDayDirs(
  root: string,
  reader: WindowReader,
): Promise<Result<string[], TranscriptUnreadable>> {
  const years = await reader.list(root);
  if (years.isErr()) return Result.err(years.error);
  if (years.value === null) return Result.ok([]);
  const dirs: string[] = [];
  for (const year of years.value.filter((name) => /^\d{4}$/u.test(name))) {
    const months = await reader.list(join(root, year));
    if (months.isErr()) return Result.err(months.error);
    if (months.value === null) continue;
    for (const month of months.value.filter((name) => /^\d{2}$/u.test(name))) {
      const days = await reader.list(join(root, year, month));
      if (days.isErr()) return Result.err(days.error);
      if (days.value === null) continue;
      for (const day of days.value.filter((name) => /^\d{2}$/u.test(name))) {
        dirs.push(join(root, year, month, day));
      }
    }
  }
  // Newest day directories first by NAME (their own dates), never by mtime.
  return Result.ok(dirs.sort().reverse().slice(0, 3));
}

function firstUserTextOf(adapter: TranscriptAdapter, head: string): string | null {
  for (const line of head.split("\n")) {
    for (const turn of adapter.parse(line)) {
      if (turn.kind === "turn" && turn.role === "user") return turn.text;
    }
  }
  return null;
}

const ADAPTERS: readonly TranscriptAdapter[] = [claudeAdapter, codexAdapter, grokAdapter, piAdapter, opencodeAdapter];

export function adapterFor(harness: string | null): Result<TranscriptAdapter, TranscriptUnsupported> {
  const found = ADAPTERS.find((adapter) => adapter.harness === harness);
  return found === undefined
    ? Result.err(
        new TranscriptUnsupported({
          harness: harness ?? "unknown",
          message: "No session reader for this harness.",
        }),
      )
    : Result.ok(found);
}

/**
 * The mapping ladder. Rung 1 is a CONTENT match on the injected briefing, which
 * carries the agent's unique handle; it runs first and is never demoted to a
 * tiebreaker, because the cheap rung below it would otherwise decide. Rung 2
 * fences by start time and requires exactly one survivor. Anything else is
 * ambiguous and says so: a guess that happens to be right is still a guess.
 */
export function chooseSession(
  candidates: readonly SessionCandidate[],
  agent: { handle: string | null; startedAt: string | null },
): SessionMapping {
  if (candidates.length === 0) return { confidence: "ambiguous", chosen: null, candidates: [] };

  const { handle, startedAt } = agent;
  if (handle !== null) {
    const marked = candidates.filter((candidate) => candidate.firstUserText?.includes(handle) === true);
    if (marked.length === 1) {
      return { confidence: "exact", chosen: marked[0] ?? null, candidates: [] };
    }
  }

  const fenced = startedAt === null
    ? [...candidates]
    : candidates.filter(
        (candidate) => candidate.startedAt !== null && candidate.startedAt >= startedAt,
      );
  if (fenced.length === 1) {
    return { confidence: "inferred", chosen: fenced[0] ?? null, candidates: [] };
  }

  const ambiguous = fenced.length > 1 ? fenced : [...candidates];
  return { confidence: "ambiguous", chosen: null, candidates: ambiguous };
}

export interface SessionWindow {
  turns: SessionTurn[];
  /**
   * Where to page backward from, or null at the start of the session: a byte
   * offset for a file-based adapter, the adapter's own cursor for `readSession`.
   */
  nextBefore: number | null;
  bytesRead: number;
}

interface Page {
  turns: SessionTurn[];
  nextBefore: number | null;
}

/**
 * Turns taken from the newest line backward, whole lines only.
 *
 * The page boundary is the byte offset of the OLDEST LINE INCLUDED, not the
 * window's own edge. Those two differ, and the difference is a hole: a boundary
 * at the window edge skips every turn between the edge and the first turn the
 * page returns, and drops the line the edge cuts in half from both pages.
 */
function pageFrom(adapter: TranscriptAdapter, chunk: string, start: number, limit: number): Page {
  // A window that does not begin at byte zero opens inside a line. That partial
  // line is dropped, which is a skip and never an error.
  const cut = start === 0 ? -1 : chunk.indexOf("\n");
  if (start > 0 && cut < 0) return { turns: [], nextBefore: start };
  const body = start === 0 ? chunk : chunk.slice(cut + 1);
  const first = start === 0 ? 0 : start + Buffer.byteLength(chunk.slice(0, cut + 1));

  const lines = body.split("\n");
  const offsets: number[] = [];
  let cursor = first;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(line) + 1;
  }

  if (adapter.mergeConsecutive === undefined) {
    return pageDistinctTurns(adapter, lines, offsets, first, limit);
  }
  return pageMergedTurns(adapter, lines, offsets, first, limit);
}

function pageDistinctTurns(
  adapter: TranscriptAdapter,
  lines: readonly string[],
  offsets: readonly number[],
  first: number,
  limit: number,
): Page {
  const picked: SessionTurn[][] = [];
  let counted = 0;
  let oldest = first;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = adapter.parse(lines[index] ?? "");
    if (parsed.length === 0) continue;
    // A line is taken whole or not at all, so no turn is ever cut away from the
    // line that carries its page boundary. One line richer than the whole limit
    // is still shown, because the alternative is showing nothing.
    if (counted > 0 && counted + parsed.length > limit) break;
    picked.unshift(parsed);
    counted += parsed.length;
    oldest = offsets[index] ?? first;
    if (counted >= limit) break;
  }
  return { turns: picked.flat(), nextBefore: oldest <= 0 ? null : oldest };
}

function pageMergedTurns(
  adapter: TranscriptAdapter,
  lines: readonly string[],
  offsets: readonly number[],
  first: number,
  limit: number,
): Page {
  const merge = adapter.mergeConsecutive;
  if (merge === undefined) return { turns: [], nextBefore: first <= 0 ? null : first };
  const newestFirst: SessionTurn[] = [];
  let counted = 0;
  let oldest = first;
  outer: for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = adapter.parse(lines[index] ?? "");
    if (parsed.length === 0) continue;
    for (let inner = parsed.length - 1; inner >= 0; inner -= 1) {
      const turn = parsed[inner];
      if (turn === undefined) continue;
      const currentOldest = newestFirst[newestFirst.length - 1];
      const merged = currentOldest === undefined ? null : merge(turn, currentOldest);
      if (merged !== null) {
        newestFirst[newestFirst.length - 1] = merged;
        oldest = offsets[index] ?? first;
        continue;
      }
      if (counted > 0 && counted >= limit) break outer;
      newestFirst.push(turn);
      counted += 1;
      oldest = offsets[index] ?? first;
    }
  }
  return { turns: newestFirst.reverse(), nextBefore: oldest <= 0 ? null : oldest };
}

/**
 * Reads backward from `before` (or the end of the file) until `limit` turns are
 * collected or the window cap is reached, doubling the span each attempt.
 */
export async function readWindow(
  adapter: TranscriptAdapter,
  path: string,
  reader: WindowReader,
  options: { before: number | null; limit: number },
): Promise<Result<SessionWindow, TranscriptUnreadable>> {
  if (adapter.readSession !== undefined) return adapter.readSession(path, reader, options);
  const sized = await reader.size(path);
  if (sized.isErr()) return Result.err(sized.error);
  const end = Math.min(options.before ?? sized.value, sized.value);

  let span = WINDOW_BYTES;
  let bytesRead = 0;
  let page: Page = { turns: [], nextBefore: null };

  while (true) {
    const start = Math.max(0, end - span);
    const chunk = await reader.slice(path, start, end);
    if (chunk.isErr()) return Result.err(chunk.error);
    bytesRead += end - start;
    page = pageFrom(adapter, chunk.value, start, options.limit);

    if (page.turns.length >= options.limit || start === 0 || span >= MAX_WINDOW_BYTES) break;
    span = Math.min(span * 2, MAX_WINDOW_BYTES);
  }

  return Result.ok({ ...page, bytesRead });
}

/** The one-line answer to "what is it doing": the last assistant utterance. */
export function glanceLine(turns: readonly SessionTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.kind === "turn" && turn.role === "assistant" && turn.text.length > 0) {
      return turn.text;
    }
  }
  return null;
}
