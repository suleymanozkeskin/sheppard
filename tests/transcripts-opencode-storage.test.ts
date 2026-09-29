import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptUnreadable,
  type WindowReader,
  bunWindowReader,
  opencodeAdapter,
  opencodeSessionPath,
  readWindow,
} from "../src/transcripts";
import { expectErr, expectOk } from "./support";

const CWD = "/work/app";
const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

function dataHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "sheppard-opencode-storage-"));
  directories.push(directory);
  mkdirSync(join(directory, "opencode"), { recursive: true });
  return directory;
}

/** Any JSON record the fixtures write. */
interface JsonRecord {
  [key: string]: JsonRecordValue;
}
type JsonRecordValue = string | number | boolean | JsonRecord | readonly JsonRecordValue[];

function writeJson(path: string, value: JsonRecord): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

interface StoredSession {
  id: string;
  directory: string;
  created: number;
  updated: number;
  parentID?: string;
  project?: string;
}

function storeSession(home: string, session: StoredSession): string {
  const file = join(home, "opencode", "storage", "session", session.project ?? "global", `${session.id}.json`);
  const record = {
    id: session.id,
    slug: "gentle-nebula",
    version: "1.1.36",
    projectID: session.project ?? "global",
    directory: session.directory,
    title: "t",
    time: { created: session.created, updated: session.updated },
  };
  writeJson(file, session.parentID === undefined ? record : { ...record, parentID: session.parentID });
  return file;
}

type StoredPart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "tool"; tool: string; state: JsonRecord }
  | { type: "step-start" };

function storeMessage(home: string, sessionId: string, id: string, role: "user" | "assistant", created: number, parts: readonly StoredPart[]): void {
  const storage = join(home, "opencode", "storage");
  writeJson(join(storage, "message", sessionId, `${id}.json`), { id, sessionID: sessionId, role, time: { created } });
  parts.forEach((part, index) => {
    const partId = `prt_${id.slice(4)}_${String(index).padStart(3, "0")}`;
    writeJson(join(storage, "part", id, `${partId}.json`), { id: partId, sessionID: sessionId, messageID: id, ...part });
  });
}

function seedConversation(home: string, sessionId: string): void {
  storeMessage(home, sessionId, "msg_001", "user", 1_790_679_377_264, [
    { type: "text", text: "context", synthetic: true },
    { type: "text", text: "You are resume-opencode. Reply OK." },
  ]);
  storeMessage(home, sessionId, "msg_002", "assistant", 1_790_679_378_000, [
    { type: "step-start" },
    { type: "text", text: "OK" },
    { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" } } },
  ]);
  storeMessage(home, sessionId, "msg_003", "user", 1_790_679_379_000, [{ type: "text", text: "Next." }]);
}

const failingReader: WindowReader = {
  list: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "list failed", message: "denied" }))),
  size: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "stat failed", message: "denied" }))),
  slice: () => Promise.resolve(Result.err(new TranscriptUnreadable({ reason: "read failed", message: "denied" }))),
};

function locate(home: string) {
  return opencodeAdapter.locate({ cwd: CWD, env: { XDG_DATA_HOME: home } }, bunWindowReader());
}

describe("opencode JSON storage reader", () => {
  test("finds a stored session with its start and first user text", async () => {
    const home = dataHome();
    const file = storeSession(home, { id: "ses_a", directory: CWD, created: 1_790_679_377_238, updated: 1_790_679_379_144 });
    seedConversation(home, "ses_a");

    const found = expectOk(await locate(home));
    expect(found).toEqual([{
      sessionId: "ses_a",
      path: opencodeSessionPath({ kind: "storage", sessionFile: file, sessionId: "ses_a" }),
      startedAt: new Date(1_790_679_377_238).toISOString(),
      sizeBytes: expect.any(Number),
      cwd: CWD,
      firstUserText: "You are resume-opencode. Reply OK.",
    }]);
  });

  test("skips sub-agent sessions and sessions of another directory", async () => {
    const home = dataHome();
    storeSession(home, { id: "ses_child", directory: CWD, created: 1, updated: 1, parentID: "ses_a" });
    storeSession(home, { id: "ses_other", directory: "/other", created: 1, updated: 1, project: "abc123" });
    expect(expectOk(await locate(home))).toEqual([]);
  });

  test("the same id in the database and in storage is one candidate from the newer store", async () => {
    const home = dataHome();
    const file = storeSession(home, { id: "ses_both", directory: CWD, created: 1_000, updated: 9_000 });
    seedConversation(home, "ses_both");
    const databasePath = join(home, "opencode", "opencode.db");
    const db = new Database(databasePath, { create: true });
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`);
    db.query("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_both", null, CWD, 1_000, 5_000);
    db.query("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_db_only", null, CWD, 2_000, 2_000);
    db.close();

    const found = expectOk(await locate(home));
    expect(found.map((candidate) => [candidate.sessionId, candidate.path]).sort()).toEqual([
      ["ses_both", file],
      ["ses_db_only", opencodeSessionPath({ kind: "database", databasePath, sessionId: "ses_db_only" })],
    ]);
  });

  test("reads stored turns newest first and pages by whole messages", async () => {
    const home = dataHome();
    const file = storeSession(home, { id: "ses_a", directory: CWD, created: 1, updated: 2 });
    seedConversation(home, "ses_a");

    const newest = expectOk(await readWindow(opencodeAdapter, file, bunWindowReader(), { before: null, limit: 3 }));
    expect(newest.turns.map((turn) => [turn.kind, turn.role, turn.text])).toEqual([
      ["turn", "assistant", "OK"],
      ["tool", null, '{"command":"ls"}'],
      ["turn", "user", "Next."],
    ]);
    expect(newest.nextBefore).toBe(1);

    const older = expectOk(await readWindow(opencodeAdapter, file, bunWindowReader(), { before: newest.nextBefore, limit: 3 }));
    expect(older.turns.map((turn) => turn.text)).toEqual(["You are resume-opencode. Reply OK."]);
    expect(older.nextBefore).toBeNull();
  });

  test("missing storage is no sessions, and a failed listing is unreadable", async () => {
    expect(expectOk(await locate(dataHome()))).toEqual([]);
    const refused = await opencodeAdapter.locate({ cwd: CWD, env: { XDG_DATA_HOME: dataHome() } }, failingReader);
    expect(expectErr(refused)._tag).toBe("TranscriptUnreadable");
  });
});
