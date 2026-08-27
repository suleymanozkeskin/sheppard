import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_START_TIMEOUT_MS } from "../src/config";
import { IN_MEMORY, SCHEMA_VERSION, openDatabase } from "../src/db";
import { hashToken, mintToken } from "../src/tokens";
import { expectOk } from "./support";

const V13_SCHEMA = `
CREATE TABLE participants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  handle         TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('agent','human')),
  token_hash     TEXT NOT NULL UNIQUE,
  terminal_id    TEXT NULL,
  pane_id        TEXT NULL,
  occupant_agent TEXT NULL,
  route_state    TEXT NOT NULL DEFAULT 'active' CHECK (route_state IN ('active','stale')),
  last_seen_at   TEXT NULL,
  created_at     TEXT NOT NULL,
  deactivated    INTEGER NOT NULL DEFAULT 0 CHECK (deactivated IN (0, 1))
);
CREATE UNIQUE INDEX idx_participants_active_terminal
  ON participants(terminal_id)
 WHERE terminal_id IS NOT NULL AND route_state = 'active';

CREATE TABLE channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  topic      TEXT NULL,
  kind       TEXT NOT NULL DEFAULT 'chat'
             CHECK (kind IN ('chat', 'direct', 'workspace')),
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  channel_id     INTEGER NOT NULL REFERENCES channels(id),
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  cursor_id      INTEGER NOT NULL DEFAULT 0 CHECK (cursor_id >= 0),
  notified_id    INTEGER NOT NULL DEFAULT 0 CHECK (notified_id >= 0),
  joined_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, participant_id)
);
CREATE INDEX idx_memberships_participant ON memberships(participant_id, channel_id);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  sender_id  INTEGER NOT NULL REFERENCES participants(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_channel ON messages(channel_id, id);

CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id),
  path         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  byte_size    INTEGER NULL,
  media_type   TEXT NULL,
  mtime        TEXT NULL,
  sha256       TEXT NULL
);
CREATE INDEX idx_attachments_path ON attachments(path);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 tokenchars '_'")
;
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TABLE lifecycle_agents (
  pane_id        TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  role           TEXT NULL,
  harness        TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT NOT NULL,
  terminal_id    TEXT NULL
);
CREATE INDEX idx_lifecycle_agents_workspace ON lifecycle_agents(workspace_id, active);

CREATE TABLE lifecycle_spawn_operations (
  operation_key    TEXT PRIMARY KEY,
  requester_id     INTEGER NOT NULL REFERENCES participants(id),
  workspace_id     TEXT NOT NULL,
  harness          TEXT NOT NULL,
  role             TEXT NULL,
  requested_handle TEXT NOT NULL,
  assigned_handle  TEXT NULL,
  participant_id   INTEGER NULL REFERENCES participants(id) ON DELETE SET NULL,
  pane_id          TEXT NULL,
  terminal_id      TEXT NULL,
  baseline_panes   TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'committed', 'failed')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  launcher         TEXT NULL,
  launcher_revision INTEGER NULL CHECK (launcher_revision IS NULL OR launcher_revision > 0),
  cleanup_outcome  TEXT NULL
                   CHECK (cleanup_outcome IS NULL OR cleanup_outcome IN ('closed', 'skipped', 'failed')),
  cleanup_error    TEXT NULL
);
CREATE INDEX idx_lifecycle_spawn_operations_requester
  ON lifecycle_spawn_operations(requester_id, created_at);

CREATE TABLE human_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_human_sessions_participant ON human_sessions(participant_id, id);

CREATE TABLE launchers (
  name         TEXT PRIMARY KEY,
  agent_kind   TEXT NOT NULL,
  argv_json    TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE launcher_seeds (
  name          TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE auto_enrollments (
  occupant_key     TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  terminal_id      TEXT NOT NULL,
  agent_kind       TEXT NOT NULL,
  participant_id   INTEGER NOT NULL REFERENCES participants(id),
  handle           TEXT NOT NULL,
  token_path       TEXT NOT NULL,
  prompt_delivered INTEGER NOT NULL DEFAULT 0 CHECK (prompt_delivered IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_auto_enrollments_participant ON auto_enrollments(participant_id);

CREATE TABLE roles (
  name       TEXT PRIMARY KEY,
  agent_kind TEXT NOT NULL,
  summary    TEXT NOT NULL,
  briefing   TEXT NOT NULL,
  launcher   TEXT NULL,
  model      TEXT NULL,
  effort     TEXT NULL,
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE role_seeds (
  name          TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE models (
  harness          TEXT NOT NULL,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('model', 'effort')),
  argv_suffix_json TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (harness, name)
);
CREATE TABLE model_seeds (
  harness       TEXT NOT NULL,
  name          TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (harness, name)
);

CREATE TABLE session_mappings (
  terminal_id  TEXT PRIMARY KEY,
  harness      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  session_path TEXT NOT NULL,
  confidence   TEXT NOT NULL CHECK (confidence IN ('exact', 'inferred')),
  resolved_at  TEXT NOT NULL
);
`;

function createV13Database(path: string): void {
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec(V13_SCHEMA);
    database.exec("PRAGMA user_version = 13");
  } finally {
    database.close();
  }
}

describe("schema", () => {
  test("migrates a fresh database to the current version", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    const row = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get();
    expect(row?.user_version).toBe(SCHEMA_VERSION);
    const channel = db
      .query<{ kind: string }, []>(`INSERT INTO channels (name, topic, created_at) VALUES ('chat', NULL, 'x') RETURNING kind`)
      .get();
    expect(channel?.kind).toBe("chat");
  });

  test("gives migrated launchers the default start budget", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    db.query(
      `INSERT INTO launchers (name, agent_kind, argv_json, created_at, updated_at)
       VALUES ('claude', 'claude', '["claude"]', 'x', 'x')`,
    ).run();
    const launcher = db
      .query<{ start_timeout_ms: number }, []>(
        `SELECT start_timeout_ms FROM launchers WHERE name = 'claude'`,
      )
      .get();
    expect(launcher?.start_timeout_ms).toBe(DEFAULT_AGENT_START_TIMEOUT_MS);
  });

  test("migrates a real v13 database through v14 and keeps existing launchers", () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-test-"));
    const path = join(dir, "msgr.db");
    try {
      createV13Database(path);
      const legacy = new Database(path, { strict: true });
      legacy.query(
        `INSERT INTO launchers
           (name, agent_kind, argv_json, created_at, updated_at)
         VALUES ('legacy', 'claude', '["claude"]', 'x', 'x')`,
      ).run();
      legacy.close();

      const migrated = expectOk(openDatabase(path));
      const launcher = migrated
        .query<{ start_timeout_ms: number; argv_json: string }, { name: string }>(
          `SELECT start_timeout_ms, argv_json FROM launchers WHERE name = $name`,
        )
        .get({ name: "legacy" });
      expect(launcher).toEqual({
        start_timeout_ms: DEFAULT_AGENT_START_TIMEOUT_MS,
        argv_json: '["claude"]',
      });
      const version = migrated.query<{ user_version: number }, []>(`PRAGMA user_version`).get();
      expect(version?.user_version).toBe(SCHEMA_VERSION);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enables foreign keys on every hub connection", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    const row = db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get();
    expect(row?.foreign_keys).toBe(1);
  });

  test("re-opening an existing database applies no further migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-test-"));
    const path = join(dir, "msgr.db");
    try {
      const first = expectOk(openDatabase(path));
      first.query(`INSERT INTO channels (name, topic, created_at) VALUES ('backend', NULL, 'x')`).run();
      first.close();

      const second = expectOk(openDatabase(path));
      const row = second.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM channels`).get();
      expect(row?.count).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a database stamped with a future schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-test-"));
    const path = join(dir, "msgr.db");
    const futureVersion = SCHEMA_VERSION + 1;
    try {
      const db = expectOk(openDatabase(path));
      db.exec(`PRAGMA user_version = ${futureVersion}`);
      db.close();

      const result = openDatabase(path);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          `database was written by a newer msgr build (schema v${futureVersion}, this build supports v${SCHEMA_VERSION})`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restricts the database file to the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-test-"));
    const path = join(dir, "msgr.db");
    try {
      const db = expectOk(openDatabase(path));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an unopenable path instead of throwing", () => {
    const result = openDatabase("/proc/nonexistent-directory/msgr.db");
    expect(result.isErr()).toBe(true);
  });

  test("enforces the kind check constraint", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    expect(() =>
      db
        .query(
          `INSERT INTO participants (handle, kind, token_hash, created_at)
           VALUES ('bot', 'robot', 'h', 'x')`,
        )
        .run(),
    ).toThrow();
  });

  test("allows many participants without a route but only one active route per terminal", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    const insert = db.query<never, [string, string, string | null]>(
      `INSERT INTO participants (handle, kind, token_hash, terminal_id, created_at)
       VALUES (?, 'agent', ?, ?, 'x')`,
    );
    insert.run("a", "h1", null);
    insert.run("b", "h2", null);
    insert.run("c", "h3", "term_1");
    expect(() => insert.run("d", "h4", "term_1")).toThrow();

    db.query(`UPDATE participants SET route_state = 'stale' WHERE handle = 'c'`).run();
    insert.run("d", "h4", "term_1");
    expect(() => insert.run("e", "h5", "term_1")).toThrow();
  });
});

describe("full-text search index", () => {
  test("stays in sync with messages through insert, update, and delete", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    db.query(`INSERT INTO channels (name, topic, created_at) VALUES ('backend', NULL, 'x')`).run();
    db.query(
      `INSERT INTO participants (handle, kind, token_hash, created_at) VALUES ('opus21', 'agent', 'h', 'x')`,
    ).run();
    const insert = db.query<{ id: number }, [string]>(
      `INSERT INTO messages (channel_id, sender_id, body, created_at)
       VALUES (1, 1, ?, 'x') RETURNING id`,
    );

    const matches = (term: string): number[] =>
      db
        .query<{ rowid: number }, [string]>(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
        .all(term)
        .map((row) => row.rowid);

    const first = insert.get("the deploy pipeline is green");
    expect(matches(`"deploy"`)).toEqual([first!.id]);

    db.query<never, [string, number]>(`UPDATE messages SET body = ? WHERE id = ?`).run(
      "the deploy pipeline is red",
      first!.id,
    );
    expect(matches(`"green"`)).toEqual([]);
    expect(matches(`"red"`)).toEqual([first!.id]);

    db.query<never, [number]>(`DELETE FROM messages WHERE id = ?`).run(first!.id);
    expect(matches(`"red"`)).toEqual([]);
  });

  test("keeps snake_case identifiers as a single token", () => {
    const db = expectOk(openDatabase(IN_MEMORY));
    db.query(`INSERT INTO channels (name, topic, created_at) VALUES ('backend', NULL, 'x')`).run();
    db.query(
      `INSERT INTO participants (handle, kind, token_hash, created_at) VALUES ('opus21', 'agent', 'h', 'x')`,
    ).run();
    db.query<never, [string]>(
      `INSERT INTO messages (channel_id, sender_id, body, created_at) VALUES (1, 1, ?, 'x')`,
    ).run("call resolve_route before delivery");

    const hits = db
      .query<{ rowid: number }, [string]>(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
      .all(`"resolve_route"`);
    expect(hits.length).toBe(1);
  });
});

describe("tokens", () => {
  test("mints distinct 256-bit tokens", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => mintToken()));
    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(Buffer.from(token, "base64url").length).toBe(32);
    }
  });

  test("hashes deterministically and differs per token", () => {
    const token = mintToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(mintToken()));
    expect(hashToken(token)).not.toBe(token);
  });
});
