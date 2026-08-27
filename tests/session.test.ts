/**
 * Guards for reading an agent's harness session.
 *
 * Two of these cannot be satisfied by care alone, which is why they are here:
 * the byte count (a `limit` parameter is met by reading the whole file and
 * slicing) and the content-over-recency mapping (a fixture where the newer file
 * is the wrong one).
 */

import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { FakeHerdr } from "../src/herdr";
import {
  type SessionCandidate,
  type SessionTurn,
  type WindowReader,
  TranscriptUnreadable,
  WINDOW_BYTES,
  chooseSession,
  claudeAdapter,
  claudeConfigDir,
  codexAdapter,
  codexHome,
  glanceLine,
  readWindow,
  slugifyCwd,
} from "../src/transcripts";
import type { AgentSessionView } from "../src/types";
import { auth, provision, testHub } from "./http-support";
import type { TestHub } from "./http-support";

const CWD = "/Users/demo/Projects/app";

interface CountingReader extends WindowReader {
  bytesRead: number;
}

/**
 * A reader over in-memory files that counts the bytes each slice takes. The
 * count runs through the reader the code under test already uses, so proving a
 * read is bounded costs no second read of the file.
 */
function countingReader(files: Readonly<Record<string, string>>): CountingReader {
  const missing = (path: string) =>
    new TranscriptUnreadable({ reason: "missing", message: `session missing: ${path}` });

  const reader: CountingReader = {
    list(dir) {
      // Entries, not paths: a directory lists its own children, and a child that
      // is itself a directory appears by name.
      const prefix = `${dir}/`;
      const names = new Set(
        Object.keys(files)
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0] ?? ""),
      );
      // An absent directory is `null`, which is not the same answer as a failure.
      return Promise.resolve(Result.ok(names.size === 0 ? null : [...names]));
    },
    bytesRead: 0,
    size(path) {
      const body = files[path];
      return Promise.resolve(
        body === undefined ? Result.err(missing(path)) : Result.ok(Buffer.byteLength(body)),
      );
    },
    slice(path, start, end) {
      const body = files[path];
      if (body === undefined) return Promise.resolve(Result.err(missing(path)));
      reader.bytesRead += end - start;
      return Promise.resolve(Result.ok(Buffer.from(body).subarray(start, end).toString()));
    },
  };
  return reader;
}

/** A reader that fails every call, the way an unreadable directory does. */
function blindReader(): WindowReader {
  const blind = (path: string) =>
    Promise.resolve(
      Result.err(new TranscriptUnreadable({ reason: "denied", message: `session denied: ${path}` })),
    );
  return { list: blind, size: blind, slice: (path) => blind(path) };
}

function claudeLine(role: "user" | "assistant", text: string, at: string): string {
  return JSON.stringify({
    type: role,
    timestamp: at,
    cwd: CWD,
    message: { content: [{ type: "text", text }] },
  });
}

function transcript(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function texts(turns: readonly SessionTurn[]): string[] {
  return turns.map((turn) => turn.text);
}

/** A refusal answers with the error envelope and no session fields at all. */
interface RefusedSession {
  code?: string;
  turns?: SessionTurn[];
}

async function sessionView(response: Response): Promise<AgentSessionView> {
  // SAFETY: every 200 from the session endpoint is built from AgentSessionView
  // by one of two helpers. A refusal never reaches here, because each caller
  // asserts the status first.
  return (await response.json()) as AgentSessionView;
}

async function refusedSession(response: Response): Promise<RefusedSession> {
  // SAFETY: a refusal carries the shared error envelope. Every field read here
  // is optional, so an unexpected shape fails the assertion rather than throws.
  return (await response.json()) as RefusedSession;
}

interface SessionSelection {
  state?: string;
  sessionId?: string;
  path?: string;
}

async function sessionSelection(response: Response): Promise<SessionSelection> {
  // SAFETY: a 200 from the selection endpoint is the typed ready success
  // shape. Refusals are checked by their callers before this helper is used.
  return (await response.json()) as SessionSelection;
}

describe("locating a session", () => {
  test("the slug folds every non-alphanumeric character, as claude writes it", () => {
    // Measured against a live directory: node_modules is stored as node-modules,
    // so `.` and `_` fold to a dash exactly as `/` does.
    expect(slugifyCwd("/opt/homebrew/lib/node_modules/pyright/dist")).toBe(
      "-opt-homebrew-lib-node-modules-pyright-dist",
    );
  });

  test("the environment decides the config directory, not the default path", () => {
    const configured = claudeConfigDir({ CLAUDE_CONFIG_DIR: "/Users/demo/.config/claude-personal" });
    expect(configured).toEqual({
      dir: "/Users/demo/.config/claude-personal",
      fromEnvironment: true,
    });
    expect(claudeConfigDir({}).fromEnvironment).toBe(false);
  });

  test("a populated default directory is not read when the environment names another", async () => {
    // The trap on this fleet: both directories exist and both hold real
    // sessions. A reader that assumes the default returns a confident wrong
    // answer instead of an empty one.
    const configured = "/Users/demo/.config/claude-personal";
    const slug = slugifyCwd(CWD);
    const reader = countingReader({
      [`${configured}/projects/${slug}/right.jsonl`]: transcript([
        claudeLine("user", "the configured session", "2026-08-19T08:00:00.000Z"),
      ]),
      [`/Users/demo/.claude/projects/${slug}/wrong.jsonl`]: transcript([
        claudeLine("user", "the default-directory session", "2026-08-19T09:00:00.000Z"),
      ]),
    });

    const located = await claudeAdapter.locate(
      { cwd: CWD, env: { CLAUDE_CONFIG_DIR: configured } },
      reader,
    );

    const candidates = located.unwrap("locate");
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["right"]);
  });

  test("a missing project directory is absence, and a blind read is an error", async () => {
    // Two different answers to two different questions. Absence says the agent
    // wrote no session here; the error says the reader could not look.
    const absent = await claudeAdapter.locate({ cwd: CWD, env: {} }, countingReader({}));
    expect(absent.isOk()).toBe(true);
    expect(absent.unwrap("locate")).toHaveLength(0);

    const blind = await claudeAdapter.locate({ cwd: CWD, env: {} }, blindReader());
    expect(blind.isErr()).toBe(true);
    if (blind.isErr()) expect(blind.error.reason).toBe("denied");
  });

  test("codex reads its identity from the first line of the rollout", async () => {
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: "9f2",
        cwd: CWD,
        timestamp: "2026-08-19T08:00:00.000Z",
        source: { subagent: false },
      },
    });
    const path = "/Users/demo/.codex/sessions/2026/08/19/rollout-2026-08-19T08-00-00-9f2.jsonl";
    const other = "/Users/demo/.codex/sessions/2026/08/19/rollout-2026-08-19T09-00-00-aa1.jsonl";
    const reader = countingReader({
      [path]: transcript([meta]),
      [other]: transcript([
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: "aa1", cwd: "/Users/demo/other", timestamp: "2026-08-19T09:00:00.000Z" },
        }),
      ]),
    });

    const located = await codexAdapter.locate({ cwd: CWD, env: { CODEX_HOME: "/Users/demo/.codex" } }, reader);

    const candidates = located.unwrap("locate");
    // One day directory holds every workspace's sessions, so the recorded cwd
    // is the only honest filter.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.startedAt).toBe("2026-08-19T08:00:00.000Z");
  });
});

describe("choosing among candidates", () => {
  test("content beats recency when recency points at the other session", () => {
    // The fixture is the claim: the wrong file is both newer and later-started,
    // so anything that ranks by recency picks it.
    const briefed: SessionCandidate = {
      sessionId: "older-but-ours",
      path: "/s/older.jsonl",
      startedAt: "2026-08-19T08:00:00.000Z",
      sizeBytes: 400,
      cwd: CWD,
      firstUserText: "You are worker-tabs. Review the active workspace brief.",
    };
    const newer: SessionCandidate = {
      sessionId: "newer-not-ours",
      path: "/s/newer.jsonl",
      startedAt: "2026-08-19T09:30:00.000Z",
      sizeBytes: 900,
      cwd: CWD,
      firstUserText: "You are worker-uifix. Take the viewer batch.",
    };

    const mapping = chooseSession([newer, briefed], {
      handle: "worker-tabs",
      startedAt: "2026-08-19T07:00:00.000Z",
    });

    expect(mapping.confidence).toBe("exact");
    expect(mapping.chosen?.sessionId).toBe("older-but-ours");
  });

  test("two survivors of the start fence make a picker, never the newer one", () => {
    const first: SessionCandidate = {
      sessionId: "one",
      path: "/s/one.jsonl",
      startedAt: "2026-08-19T08:10:00.000Z",
      sizeBytes: 10,
      cwd: CWD,
      firstUserText: "explore the repo",
    };
    const second: SessionCandidate = {
      ...first,
      sessionId: "two",
      path: "/s/two.jsonl",
      startedAt: "2026-08-19T08:20:00.000Z",
    };

    const mapping = chooseSession([first, second], {
      handle: null,
      startedAt: "2026-08-19T08:00:00.000Z",
    });

    expect(mapping.confidence).toBe("ambiguous");
    expect(mapping.chosen).toBeNull();
    expect(mapping.candidates.map((candidate) => candidate.sessionId)).toEqual(["one", "two"]);
  });

  test("the start fence decides only when it leaves one survivor", () => {
    const stale: SessionCandidate = {
      sessionId: "before-the-agent",
      path: "/s/stale.jsonl",
      startedAt: "2026-08-19T06:00:00.000Z",
      sizeBytes: 10,
      cwd: CWD,
      firstUserText: "yesterday's work",
    };
    const live: SessionCandidate = {
      ...stale,
      sessionId: "after-the-agent",
      path: "/s/live.jsonl",
      startedAt: "2026-08-19T08:05:00.000Z",
    };

    const mapping = chooseSession([stale, live], { handle: null, startedAt: "2026-08-19T08:00:00.000Z" });

    expect(mapping.confidence).toBe("inferred");
    expect(mapping.chosen?.sessionId).toBe("after-the-agent");
  });
});

describe("reading a window", () => {
  test("a file over a megabyte is read one window deep, counted in bytes", async () => {
    // The parameter lies: reading the whole file and slicing to `limit` passes
    // every assertion about turn counts. The byte count is what cannot be faked.
    const path = "/s/big.jsonl";
    const lines = Array.from({ length: 4_000 }, (_, index) =>
      claudeLine("assistant", `turn ${index} ${"x".repeat(200)}`, "2026-08-19T08:00:00.000Z"),
    );
    const files = { [path]: transcript(lines) };
    const totalBytes = Buffer.byteLength(files[path] ?? "");
    const reader = countingReader(files);

    const window = await readWindow(claudeAdapter, path, reader, { before: null, limit: 50 });

    expect(window.unwrap("window").turns).toHaveLength(50);
    expect(totalBytes).toBeGreaterThan(1_000_000);
    expect(reader.bytesRead).toBeLessThanOrEqual(WINDOW_BYTES);
  });

  test("paging backward loses no line at the window edge and repeats none", async () => {
    // The line a window cuts in half belongs to exactly one page. Ending the
    // next page at the window's own edge would drop it from both.
    const path = "/s/paged.jsonl";
    const lines = Array.from({ length: 600 }, (_, index) =>
      claudeLine("assistant", `line ${String(index).padStart(3, "0")} ${"y".repeat(300)}`, "2026-08-19T08:00:00.000Z"),
    );
    const reader = countingReader({ [path]: transcript(lines) });

    const seen: string[] = [];
    let before: number | null = null;
    for (let page = 0; page < 20; page += 1) {
      const window = await readWindow(claudeAdapter, path, reader, { before, limit: 40 });
      const value = window.unwrap("page");
      seen.unshift(...texts(value.turns));
      before = value.nextBefore;
      if (before === null) break;
    }

    expect(before).toBeNull();
    expect(seen).toHaveLength(600);
    expect(new Set(seen).size).toBe(600);
    expect(seen[0]).toContain("line 000");
    expect(seen[599]).toContain("line 599");
  });

  test("a partial line at the window edge is skipped, not an error", async () => {
    const path = "/s/edge.jsonl";
    const lines = Array.from({ length: 400 }, (_, index) =>
      claudeLine("assistant", `line ${index} ${"y".repeat(300)}`, "2026-08-19T08:00:00.000Z"),
    );
    const reader = countingReader({ [path]: transcript(lines) });

    const window = await readWindow(claudeAdapter, path, reader, { before: null, limit: 10 });

    const value = window.unwrap("window");
    expect(value.turns).toHaveLength(10);
    expect(value.turns.every((turn) => turn.text.startsWith("line "))).toBe(true);
    expect(value.nextBefore).not.toBeNull();
  });

  test("a short file pages to the start and stops", async () => {
    const path = "/s/short.jsonl";
    const reader = countingReader({
      [path]: transcript([
        claudeLine("user", "read the checklist", "2026-08-19T08:00:00.000Z"),
        claudeLine("assistant", "Reading it now.", "2026-08-19T08:00:01.000Z"),
      ]),
    });

    const window = await readWindow(claudeAdapter, path, reader, { before: null, limit: 50 });

    const value = window.unwrap("window");
    expect(texts(value.turns)).toEqual(["read the checklist", "Reading it now."]);
    expect(value.nextBefore).toBeNull();
  });

  test("an unrecognised line adds no turn and no error text", async () => {
    const path = "/s/mixed.jsonl";
    const reader = countingReader({
      [path]: transcript([
        JSON.stringify({ type: "ai-title", timestamp: "2026-08-19T08:00:00.000Z", title: "bookkeeping" }),
        claudeLine("user", "run the tests", "2026-08-19T08:00:01.000Z"),
        JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-08-19T08:00:02.000Z" }),
        claudeLine("assistant", "Running them now.", "2026-08-19T08:00:03.000Z"),
      ]),
    });

    const window = await readWindow(claudeAdapter, path, reader, { before: null, limit: 50 });

    const turns = window.unwrap("window").turns;
    expect(texts(turns)).toEqual(["run the tests", "Running them now."]);
    expect(JSON.stringify(turns)).not.toContain("bookkeeping");
  });

  test("the glance line is the last assistant utterance, or absent", () => {
    const at = "2026-08-19T08:00:00.000Z";
    const spoken: SessionTurn[] = [
      { kind: "turn", role: "assistant", text: "first", tool: null, at, sidechain: false },
      { kind: "turn", role: "assistant", text: "last one", tool: null, at, sidechain: false },
      { kind: "tool", role: null, text: "bun test", tool: { name: "shell", outcome: "ok" }, at, sidechain: false },
    ];

    expect(glanceLine(spoken)).toBe("last one");
    // A session that has only run tools has said nothing. No tool output is
    // promoted to stand in for an utterance.
    expect(glanceLine(spoken.slice(2))).toBeNull();
    expect(glanceLine([])).toBeNull();
  });
});

describe("session reads are operator-only", () => {
  function sessionHerdr(): FakeHerdr {
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", cwd: CWD });
    return herdr;
  }

  test("an agent token is refused with 403 and zero turns", async () => {
    // The same boundary as prompting a pane, for a stronger reason: a transcript
    // carries every tool result and every file the agent ever read.
    const hub = testHub();
    hub.hub.herdr = sessionHerdr();
    const agentToken = await provision(hub, "observer");

    const response = await hub.get("/api/herdr/agents/w1:p1/session", auth(agentToken));

    expect(response.status).toBe(403);
    const body = await refusedSession(response);
    expect(body).toMatchObject({ code: "OperatorOnly" });
    expect(body.turns ?? []).toHaveLength(0);
  });

  test("an unauthenticated read is refused and delivers zero turns", async () => {
    const hub = testHub();
    hub.hub.herdr = sessionHerdr();

    const response = await hub.get("/api/herdr/agents/w1:p1/session");

    expect(response.status).toBe(401);
    expect((await refusedSession(response)).turns ?? []).toHaveLength(0);
  });
});

describe("the session endpoint", () => {
  function paneHerdr(agent: string | null, cwd: string): FakeHerdr {
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent, cwd });
    return herdr;
  }

  async function operatorCookie(hub: TestHub): Promise<{ cookie: string }> {
    const created = await hub.post("/api/humans", { handle: "human" });
    return { cookie: (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }

  test("a harness with no reader states the gap instead of an empty session", async () => {
    const hub = testHub();
    hub.hub.herdr = paneHerdr("amp", CWD);
    const operator = await operatorCookie(hub);

    const response = await hub.get("/api/herdr/agents/w1:p1/session", operator);

    expect(response.status).toBe(200);
    const body = await sessionView(response);
    // Unsupported is its own state. Absence here would claim the agent has no
    // session, which is a different and false statement.
    expect(body.source.state).toBe("unsupported");
    expect(body.source.harness).toBe("amp");
    expect(body.turns).toHaveLength(0);
  });

  test("a reader that could not look reports an error, never an empty session", async () => {
    const hub = testHub();
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = blindReader();
    const operator = await operatorCookie(hub);

    const response = await hub.get("/api/herdr/agents/w1:p1/session", operator);

    const body = await sessionView(response);
    expect(body.source.state).toBe("error");
    expect(body.source.reason).toBe("denied");
    expect(body.turns).toHaveLength(0);
  });

  test("the mapping is stored under the terminal id, which a pane move does not change", async () => {
    const hub = testHub();
    // Resolved the way the server resolves it. Naming the default directory
    // here would pass on a machine that does not set the variable and fail on
    // one that does, which is the trap this endpoint exists to avoid.
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = countingReader({
      [`${dir}/abc.jsonl`]: transcript([
        claudeLine("user", "start the work", "2026-08-19T08:00:00.000Z"),
        claudeLine("assistant", "Starting now.", "2026-08-19T08:00:01.000Z"),
      ]),
    });
    const operator = await operatorCookie(hub);

    const first = await hub.get("/api/herdr/agents/w1:p1/session", operator);
    const body = await sessionView(first);
    expect(body.source.state).toBe("ready");
    expect(body.source.glance).toBe("Starting now.");
    expect(texts(body.turns)).toEqual(["start the work", "Starting now."]);

    // The pane moves. Its id changes; the terminal it hosts does not.
    const moved = new FakeHerdr();
    moved.workspaces = [{ id: "w2", label: "Backend" }];
    moved.withPane({ paneId: "w2:p7", terminalId: "term-1", agent: "claude", cwd: CWD });
    hub.hub.herdr = moved;

    const stored = hub.hub.store.findSessionMapping("term-1");
    expect(stored?.session_id).toBe("abc");

    const after = await hub.get("/api/herdr/agents/w2:p7/session", operator);
    const second = await sessionView(after);
    expect(second.source.state).toBe("ready");
    expect(texts(second.turns)).toEqual(["start the work", "Starting now."]);
  });

  test("heals a same-harness mapping when a fresh marked candidate appears", async () => {
    const hub = testHub();
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    const oldPath = `${dir}/old.jsonl`;
    const freshPath = `${dir}/fresh.jsonl`;
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = countingReader({
      [oldPath]: transcript([
        claudeLine("user", "old session", "2026-08-19T08:00:00.000Z"),
        claudeLine("assistant", "Old session.", "2026-08-19T08:00:01.000Z"),
      ]),
    });
    const operator = await operatorCookie(hub);

    const first = await sessionView(await hub.get("/api/herdr/agents/w1:p1/session", operator));
    expect(first.source.sessionPath).toBe(oldPath);
    expect(hub.hub.store.findSessionMapping("term-1")?.session_id).toBe("old");

    const worker = hub.hub.store.createAgent("worker").unwrap("worker fixture").participant;
    hub.hub.store.bindRoute(worker.id, {
      terminalId: "term-1",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    hub.hub.windowReader = countingReader({
      [oldPath]: transcript([
        claudeLine("user", "old session", "2026-08-19T08:00:00.000Z"),
        claudeLine("assistant", "Old session.", "2026-08-19T08:00:01.000Z"),
      ]),
      [freshPath]: transcript([
        claudeLine("user", "You are worker. Start a fresh run.", "2026-08-19T09:00:00.000Z"),
        claudeLine("assistant", "Fresh session.", "2026-08-19T09:00:01.000Z"),
      ]),
    });

    const second = await sessionView(await hub.get("/api/herdr/agents/w1:p1/session", operator));
    expect(second.source.state).toBe("ready");
    expect(second.source.sessionPath).toBe(freshPath);
    expect(second.mapping).toEqual({ confidence: "exact", candidates: [] });
    expect(texts(second.turns)).toEqual(["You are worker. Start a fresh run.", "Fresh session."]);
    expect(hub.hub.store.findSessionMapping("term-1")).toMatchObject({
      session_id: "fresh",
      session_path: freshPath,
      confidence: "exact",
    });
  });

  test("a stored mapping is not read by a harness that did not write it", async () => {
    const hub = testHub();
    // The terminal is the durable identity, which is exactly why it outlives
    // the agent inside it: stop claude, start codex, same terminal id. A
    // mapping found by terminal alone therefore points at the previous
    // harness's transcript, and the two formats share the .jsonl extension.
    const claudeDir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    const codexDir = `${codexHome(process.env).dir}/sessions/2026/08/19`;
    hub.hub.windowReader = countingReader({
      [`${claudeDir}/abc.jsonl`]: transcript([
        claudeLine("user", "start the work", "2026-08-19T08:00:00.000Z"),
        claudeLine("assistant", "Starting now.", "2026-08-19T08:00:01.000Z"),
      ]),
      [`${codexDir}/rollout-2026-08-19T09-00-00-9f2.jsonl`]: transcript([
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: "9f2", cwd: CWD, timestamp: "2026-08-19T09:00:00.000Z" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-19T09:00:01.000Z",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Codex here." }] },
        }),
      ]),
    });
    const operator = await operatorCookie(hub);

    hub.hub.herdr = paneHerdr("claude", CWD);
    const first = await sessionView(await hub.get("/api/herdr/agents/w1:p1/session", operator));
    expect(texts(first.turns)).toEqual(["start the work", "Starting now."]);
    expect(hub.hub.store.findSessionMapping("term-1")?.harness).toBe("claude");

    // Same terminal, different agent. Reading claude's file with the codex
    // adapter raises no error — every line simply parses to no turn — so the
    // failure this guards is a READY answer with an empty transcript, which
    // never self-corrects because the stored row is never revisited.
    hub.hub.herdr = paneHerdr("codex", CWD);
    const second = await sessionView(await hub.get("/api/herdr/agents/w1:p1/session", operator));

    expect(second.source.harness).toBe("codex");
    expect(second.source.state).toBe("ready");
    expect(texts(second.turns)).toEqual(["Codex here."]);
    expect(hub.hub.store.findSessionMapping("term-1")?.harness).toBe("codex");
  });
});

describe("session mapping selection", () => {
  function paneHerdr(agent: string | null, cwd: string): FakeHerdr {
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1", agent, cwd });
    return herdr;
  }

  async function operatorCookie(hub: TestHub): Promise<{ cookie: string }> {
    const created = await hub.post("/api/humans", { handle: "human" });
    return { cookie: (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }

  test("an agent cannot select another session", async () => {
    const hub = testHub();
    hub.hub.herdr = paneHerdr("claude", CWD);
    const token = await provision(hub, "observer");

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc" },
      auth(token),
    );

    expect(response.status).toBe(403);
    expect(await refusedSession(response)).toMatchObject({ code: "OperatorOnly" });
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("an unauthenticated caller cannot select a session", async () => {
    const hub = testHub();
    hub.hub.herdr = paneHerdr("claude", CWD);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc" },
    );

    expect(response.status).toBe(401);
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("accepts only sessionId and never a client path", async () => {
    const hub = testHub();
    hub.hub.herdr = paneHerdr("claude", CWD);
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc", path: "/tmp/operator-supplied.jsonl" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).code).toBe("ValidationFailed");
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("rejects an unknown candidate and leaves no mapping", async () => {
    const hub = testHub();
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = countingReader({
      [`${dir}/abc.jsonl`]: transcript([
        claudeLine("user", "start the work", "2026-08-19T08:00:00.000Z"),
      ]),
      [`${dir}/def.jsonl`]: transcript([
        claudeLine("user", "continue the work", "2026-08-19T08:01:00.000Z"),
      ]),
    });
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "missing" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).error).toContain("current candidate");
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("rejects a pane with no occupant or unsupported harness", async () => {
    const operatorHub = testHub();
    operatorHub.hub.herdr = paneHerdr(null, CWD);
    const operator = await operatorCookie(operatorHub);

    const empty = await operatorHub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc" },
      operator,
    );
    expect(empty.status).toBe(400);
    expect((await refusedSession(empty)).error).toContain("agent occupant");

    const unsupportedHub = testHub();
    unsupportedHub.hub.herdr = paneHerdr("amp", CWD);
    const unsupportedOperator = await operatorCookie(unsupportedHub);
    const unsupported = await unsupportedHub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc" },
      unsupportedOperator,
    );
    expect(unsupported.status).toBe(400);
    expect((await refusedSession(unsupported)).error).toContain("supported session reader");
  });

  test("rejects a pane with no current working directory", async () => {
    const hub = testHub();
    const herdr = paneHerdr("claude", CWD);
    const pane = herdr.panes[0];
    if (pane === undefined) throw new Error("pane fixture is missing");
    herdr.panes[0] = { ...pane, cwd: undefined };
    hub.hub.herdr = herdr;
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "abc" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).error).toContain("working directory");
  });

  test("re-runs the mapping with the current pane participant marker", async () => {
    const hub = testHub();
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    const worker = hub.hub.store.createAgent("worker").unwrap("worker fixture").participant;
    hub.hub.store.bindRoute(worker.id, {
      terminalId: "term-1",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = countingReader({
      [`${dir}/marked.jsonl`]: transcript([
        claudeLine("user", "You are worker. Start the work.", "2026-08-19T08:00:00.000Z"),
      ]),
      [`${dir}/other.jsonl`]: transcript([
        claudeLine("user", "You are a different agent.", "2026-08-19T08:01:00.000Z"),
      ]),
    });
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "marked" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).error).toContain("only be selected when");
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("rejects a terminal change after locating candidates", async () => {
    const hub = testHub();
    const herdr = paneHerdr("claude", CWD);
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    hub.hub.herdr = herdr;
    hub.hub.windowReader = countingReader({
      [`${dir}/one.jsonl`]: transcript([
        claudeLine("user", "one", "2026-08-19T08:00:00.000Z"),
      ]),
      [`${dir}/two.jsonl`]: transcript([
        claudeLine("user", "two", "2026-08-19T08:01:00.000Z"),
      ]),
    });
    let lists = 0;
    herdr.afterList = () => {
      lists += 1;
      if (lists === 1 && herdr.panes[0] !== undefined) {
        herdr.panes[0] = { ...herdr.panes[0], terminalId: "term-2" };
      }
    };
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "one" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).error).toContain("terminalId");
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });

  test("rejects a pane identity change after locating candidates", async () => {
    const changes: Array<{ name: string; field: "agent" | "cwd"; value: string }> = [
      { name: "agent", field: "agent", value: "codex" },
      { name: "cwd", field: "cwd", value: "/Users/demo/Projects/other" },
    ];
    for (const change of changes) {
      const hub = testHub();
      const herdr = paneHerdr("claude", CWD);
      const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
      hub.hub.herdr = herdr;
      hub.hub.windowReader = countingReader({
        [`${dir}/one.jsonl`]: transcript([
          claudeLine("user", "one", "2026-08-19T08:00:00.000Z"),
        ]),
        [`${dir}/two.jsonl`]: transcript([
          claudeLine("user", "two", "2026-08-19T08:01:00.000Z"),
        ]),
      });
      let lists = 0;
      herdr.afterList = () => {
        lists += 1;
        if (lists === 1 && herdr.panes[0] !== undefined) {
          herdr.panes[0] = { ...herdr.panes[0], [change.field]: change.value };
        }
      };
      const operator = await operatorCookie(hub);

      const response = await hub.post(
        "/api/herdr/agents/w1:p1/session/select",
        { sessionId: "one" },
        operator,
      );

      expect(response.status).toBe(400);
      expect((await refusedSession(response)).error).toContain(change.field);
      expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
    }
  });

  test("uses the current pane harness and cwd when it selects", async () => {
    const hub = testHub();
    const claudeDir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    const codexDir = `${codexHome(process.env).dir}/sessions/2026/08/19`;
    hub.hub.herdr = paneHerdr("codex", CWD);
    hub.hub.windowReader = countingReader({
      [`${claudeDir}/claude-session.jsonl`]: transcript([
        claudeLine("user", "Claude session", "2026-08-19T08:00:00.000Z"),
      ]),
      [`${codexDir}/rollout-2026-08-19T09-00-00-codex.jsonl`]: transcript([
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: "codex", cwd: CWD, timestamp: "2026-08-19T09:00:00.000Z" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-19T09:00:01.000Z",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Codex session." }] },
        }),
      ]),
      [`${codexDir}/rollout-2026-08-19T09-01-00-second.jsonl`]: transcript([
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: "second", cwd: CWD, timestamp: "2026-08-19T09:01:00.000Z" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T09:01:00.000Z",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Second session." }] },
        }),
      ]),
    });
    const operator = await operatorCookie(hub);

    const wrongHarness = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "claude-session" },
      operator,
    );
    expect(wrongHarness.status).toBe(400);
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();

    const selected = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "2026-08-19T09-00-00-codex" },
      operator,
    );
    expect(selected.status).toBe(200);
    expect(await sessionSelection(selected)).toEqual({
      state: "ready",
      sessionId: "2026-08-19T09-00-00-codex",
    });
    expect(hub.hub.store.findSessionMapping("term-1")).toMatchObject({
      harness: "codex",
      session_id: "2026-08-19T09-00-00-codex",
      session_path: `${codexDir}/rollout-2026-08-19T09-00-00-codex.jsonl`,
      confidence: "exact",
    });

    const next = await sessionView(
      await hub.get("/api/herdr/agents/w1:p1/session", operator),
    );
    expect(next.source.state).toBe("ready");
    expect(next.source.harness).toBe("codex");
    expect(next.source.sessionPath).toBe(`${codexDir}/rollout-2026-08-19T09-00-00-codex.jsonl`);
    expect(next.mapping).toEqual({ confidence: "exact", candidates: [] });
    expect(texts(next.turns)).toEqual(["Codex session."]);
  });

  test("rejects a session id that occurs more than once in the current locator", async () => {
    const hub = testHub();
    const dir = `${claudeConfigDir(process.env).dir}/projects/${slugifyCwd(CWD)}`;
    const path = `${dir}/duplicate.jsonl`;
    const base = countingReader({
      [path]: transcript([
        claudeLine("user", "duplicate session", "2026-08-19T08:00:00.000Z"),
      ]),
    });
    hub.hub.herdr = paneHerdr("claude", CWD);
    hub.hub.windowReader = {
      list: (candidate) => candidate === dir
        ? Promise.resolve(Result.ok(["duplicate.jsonl", "duplicate.jsonl"]))
        : base.list(candidate),
      size: base.size,
      slice: base.slice,
    };
    const operator = await operatorCookie(hub);

    const response = await hub.post(
      "/api/herdr/agents/w1:p1/session/select",
      { sessionId: "duplicate" },
      operator,
    );

    expect(response.status).toBe(400);
    expect((await refusedSession(response)).error).toContain("more than one");
    expect(hub.hub.store.findSessionMapping("term-1")).toBeNull();
  });
});
