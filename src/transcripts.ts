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

const ADAPTERS: readonly TranscriptAdapter[] = [claudeAdapter, codexAdapter];

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
  /** Byte offset to page backward from, or null at the start of the file. */
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
