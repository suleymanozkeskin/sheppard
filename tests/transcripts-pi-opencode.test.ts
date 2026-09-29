import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptUnreadable,
  type WindowReader,
  adapterFor,
  bunWindowReader,
  opencodeAdapter,
  opencodeSessionPath,
  parseOpencodeSessionPath,
  piAdapter,
  piAgentDir,
  piEncodedCwd,
  readWindow,
} from "../src/transcripts";
import { expectErr, expectOk } from "./support";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "sheppard-transcripts-"));
  directories.push(directory);
  return directory;
}

const failingReader: WindowReader = {
  list: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "list failed", message: "denied" }))),
  size: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "stat failed", message: "denied" }))),
  slice: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "read failed", message: "denied" }))),
};

const CWD = "/work/app";

function jsonl(rows: readonly object[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function piSession(id: string, cwd: string): string {
  return jsonl([
    { type: "session", version: 3, id, timestamp: "2026-09-16T16:52:33.423Z", cwd },
    { type: "model_change", id: "m1", timestamp: "2026-09-16T16:52:33.476Z", provider: "p", modelId: "x" },
    {
      type: "message",
      timestamp: "2026-09-16T16:53:42.332Z",
      message: { role: "user", content: [{ type: "text", text: "You are @worker. Fix the build." }] },
    },
    {
      type: "message",
      timestamp: "2026-09-16T16:53:43.497Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Looking now." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-09-16T16:53:45.044Z",
      message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] },
    },
  ]);
}

function writePiSession(agentDir: string, cwd: string, file: string, body: string): void {
  const dir = join(agentDir, "sessions", piEncodedCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}

describe("pi session reader", () => {
  test("uses pi's own directory name for a working directory", () => {
    expect(piEncodedCwd("/Users/me/Desktop/Personal-Projects/schmart-ats")).toBe(
      "--Users-me-Desktop-Personal-Projects-schmart-ats--",
    );
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/pi-work" }).dir).toMatch(/\/pi-work$/u);
  });

  test("finds a session by its header id, start, cwd, and first user text", async () => {
    const agentDir = tempDir();
    const id = "01a0ab22-660f-7077-83e4-88b8b4168146";
    writePiSession(agentDir, CWD, `2026-09-16T16-52-33-423Z_${id}.jsonl`, piSession(id, CWD));
    writePiSession(agentDir, CWD, "notes.jsonl", jsonl([{ type: "message" }]));

    const found = expectOk(
      await piAdapter.locate({ cwd: CWD, env: { PI_CODING_AGENT_DIR: agentDir } }, bunWindowReader()),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sessionId: id,
      startedAt: "2026-09-16T16:52:33.423Z",
      cwd: CWD,
      firstUserText: "You are @worker. Fix the build.",
    });

    const window = expectOk(await readWindow(piAdapter, found[0]?.path ?? "", bunWindowReader(), { before: null, limit: 10 }));
    expect(window.turns.map((turn) => [turn.kind, turn.role, turn.tool?.name ?? null, turn.tool?.outcome ?? null])).toEqual([
      ["turn", "user", null, null],
      ["turn", "assistant", null, null],
      ["tool", null, "bash", "unknown"],
      ["tool", null, "result", "error"],
    ]);
  });

  test("skips a session recorded for another cwd that folds to the same name", async () => {
    const agentDir = tempDir();
    writePiSession(agentDir, "/work:app", "a_1.jsonl", piSession("other", "/work:app"));
    const found = expectOk(await piAdapter.locate({ cwd: CWD, env: { PI_CODING_AGENT_DIR: agentDir } }, bunWindowReader()));
    expect(found).toEqual([]);
  });

  test("an absent session directory is empty, and a failed listing is unreadable", async () => {
    const env = { PI_CODING_AGENT_DIR: tempDir() };
    expect(expectOk(await piAdapter.locate({ cwd: CWD, env }, bunWindowReader()))).toEqual([]);
    expect(expectErr(await piAdapter.locate({ cwd: CWD, env }, failingReader))._tag).toBe("TranscriptUnreadable");
  });
});

const OPENCODE_SCHEMA = [
  `CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL)`,
  `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`,
];

interface OpencodeFixture {
  dataHome: string;
  databasePath: string;
}

function opencodeFixture(): OpencodeFixture {
  const dataHome = tempDir();
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const databasePath = join(dataHome, "opencode", "opencode.db");
  const db = new Database(databasePath, { create: true });
  for (const statement of OPENCODE_SCHEMA) db.exec(statement);
  const session = db.query("INSERT INTO session VALUES (?, ?, ?, ?)");
  session.run("ses_top", null, CWD, 1_786_126_531_435);
  session.run("ses_child", "ses_top", CWD, 1_786_126_532_000);
  session.run("ses_elsewhere", null, "/other", 1_786_126_533_000);
  const message = db.query("INSERT INTO message VALUES (?, ?, ?, ?)");
  message.run("msg_u", "ses_top", 1_786_126_531_454, JSON.stringify({ role: "user" }));
  message.run("msg_a", "ses_top", 1_786_126_531_470, JSON.stringify({ role: "assistant" }));
  const part = db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  part.run("p1", "msg_u", "ses_top", 1_786_126_531_460, JSON.stringify({ type: "text", text: "context", synthetic: true }));
  part.run("p2", "msg_u", "ses_top", 1_786_126_531_461, JSON.stringify({ type: "text", text: "You are @worker. Review it." }));
  part.run("p3", "msg_a", "ses_top", 1_786_126_533_537, JSON.stringify({ type: "step-start" }));
  part.run("p4", "msg_a", "ses_top", 1_786_126_533_600, JSON.stringify({ type: "text", text: "Reading the diff." }));
  part.run("p5", "msg_a", "ses_top", 1_786_126_533_700, JSON.stringify({
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command: "git log" }, output: "ok" },
  }));
  db.close();
  return { dataHome, databasePath };
}

describe("opencode session reader", () => {
  test("finds the top-level session of the cwd and skips sub-agent and other-directory sessions", async () => {
    const { dataHome, databasePath } = opencodeFixture();
    const found = expectOk(
      await opencodeAdapter.locate({ cwd: CWD, env: { XDG_DATA_HOME: dataHome } }, bunWindowReader()),
    );
    expect(found.map((candidate) => candidate.sessionId)).toEqual(["ses_top"]);
    expect(found[0]).toMatchObject({
      path: opencodeSessionPath({ databasePath, sessionId: "ses_top" }),
      startedAt: new Date(1_786_126_531_435).toISOString(),
      cwd: CWD,
      firstUserText: "You are @worker. Review it.",
    });
    expect(found[0]?.sizeBytes).toBeGreaterThan(0);
  });

  test("reads turns newest first and pages by the part cursor without overlap", async () => {
    const { databasePath } = opencodeFixture();
    const path = opencodeSessionPath({ databasePath, sessionId: "ses_top" });

    const newest = expectOk(await readWindow(opencodeAdapter, path, bunWindowReader(), { before: null, limit: 2 }));
    expect(newest.turns.map((turn) => [turn.kind, turn.role, turn.tool?.outcome ?? null])).toEqual([
      ["turn", "assistant", null],
      ["tool", null, "ok"],
    ]);
    expect(newest.nextBefore).not.toBeNull();

    const older = expectOk(await readWindow(opencodeAdapter, path, bunWindowReader(), { before: newest.nextBefore, limit: 10 }));
    expect(older.turns.map((turn) => turn.text)).toEqual(["You are @worker. Review it."]);
    expect(older.nextBefore).toBeNull();
  });

  test("no database is empty, and a database that cannot be opened is unreadable", async () => {
    const empty = tempDir();
    expect(expectOk(await opencodeAdapter.locate({ cwd: CWD, env: { XDG_DATA_HOME: empty } }, bunWindowReader()))).toEqual([]);

    const broken = tempDir();
    mkdirSync(join(broken, "opencode"), { recursive: true });
    writeFileSync(join(broken, "opencode", "opencode.db"), "not a database");
    const refused = await opencodeAdapter.locate({ cwd: CWD, env: { XDG_DATA_HOME: broken } }, bunWindowReader());
    expect(expectErr(refused)._tag).toBe("TranscriptUnreadable");
  });

  test("a stored path must name the database and a session", () => {
    expect(expectOk(parseOpencodeSessionPath("/data/opencode/opencode.db#ses_1"))).toEqual({
      databasePath: "/data/opencode/opencode.db",
      sessionId: "ses_1",
    });
    expect(parseOpencodeSessionPath("/data/opencode/opencode.db").isErr()).toBe(true);
    expect(parseOpencodeSessionPath("/data/other.db#ses_1").isErr()).toBe(true);
  });
});

describe("reader registry", () => {
  test("has a reader for every supported harness", () => {
    for (const harness of ["claude", "codex", "grok", "pi", "opencode"]) {
      expect(adapterFor(harness).isOk()).toBe(true);
    }
  });
});
