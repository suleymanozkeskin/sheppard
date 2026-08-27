/**
 * Database lifecycle: pragmas, schema, and forward-only migrations keyed on
 * `PRAGMA user_version`.
 */

import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_AGENT_START_TIMEOUT_MS } from "./config";
import { DatabaseOpenFailed } from "./errors";

export const IN_MEMORY = ":memory:";

interface Migration {
  readonly version: number;
  readonly up: (db: Database) => void;
}

const SCHEMA_V1 = `
CREATE TABLE participants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  handle         TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('agent','human')),
  token_hash     TEXT NOT NULL UNIQUE,
  terminal_id    TEXT NULL UNIQUE,
  pane_id        TEXT NULL,
  occupant_agent TEXT NULL,
  route_state    TEXT NOT NULL DEFAULT 'active' CHECK (route_state IN ('active','stale')),
  last_seen_at   TEXT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  topic      TEXT NULL,
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
`;

/**
 * External-content FTS5: the index carries no copy of the bodies, so
 * `messages` stays the single source of truth. `tokenchars '_'` keeps
 * snake_case identifiers searchable as one token.
 */
const SCHEMA_V1_FTS = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 tokenchars '_'"
);

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
`;

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1);
      db.exec(SCHEMA_V1_FTS);
      rebuildSearchIndex(db);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(
        `ALTER TABLE channels
           ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
           CHECK (kind IN ('chat', 'direct'))`,
      );
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE channels_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          topic      TEXT NULL,
          kind       TEXT NOT NULL DEFAULT 'chat'
                     CHECK (kind IN ('chat', 'direct', 'workspace')),
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`INSERT INTO channels_new (id, name, topic, kind, created_at)
               SELECT id, name, topic, kind, created_at FROM channels`);
      db.exec(`DROP TABLE channels`);
      db.exec(`ALTER TABLE channels_new RENAME TO channels`);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE participants_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          handle         TEXT NOT NULL UNIQUE,
          kind           TEXT NOT NULL CHECK (kind IN ('agent','human')),
          token_hash     TEXT NOT NULL UNIQUE,
          terminal_id    TEXT NULL,
          pane_id        TEXT NULL,
          occupant_agent TEXT NULL,
          route_state    TEXT NOT NULL DEFAULT 'active' CHECK (route_state IN ('active','stale')),
          last_seen_at   TEXT NULL,
          created_at     TEXT NOT NULL
        )
      `);
      db.exec(`INSERT INTO participants_new
               (id, handle, kind, token_hash, terminal_id, pane_id, occupant_agent,
                route_state, last_seen_at, created_at)
               SELECT id, handle, kind, token_hash, terminal_id, pane_id, occupant_agent,
                      route_state, last_seen_at, created_at
                 FROM participants`);
      db.exec(`DROP TABLE participants`);
      db.exec(`ALTER TABLE participants_new RENAME TO participants`);
      db.exec(`CREATE UNIQUE INDEX idx_participants_active_terminal
                 ON participants(terminal_id)
                WHERE terminal_id IS NOT NULL AND route_state = 'active'`);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE lifecycle_agents (
          pane_id        TEXT PRIMARY KEY,
          workspace_id   TEXT NOT NULL,
          participant_id INTEGER NOT NULL REFERENCES participants(id),
          role           TEXT NULL,
          harness        TEXT NOT NULL,
          active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at     TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX idx_lifecycle_agents_workspace
                 ON lifecycle_agents(workspace_id, active)`);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE lifecycle_spawn_operations (
          operation_key   TEXT PRIMARY KEY,
          requester_id    INTEGER NOT NULL REFERENCES participants(id),
          workspace_id    TEXT NOT NULL,
          harness         TEXT NOT NULL,
          role            TEXT NULL,
          requested_handle TEXT NOT NULL,
          assigned_handle TEXT NULL,
          participant_id  INTEGER NULL REFERENCES participants(id) ON DELETE SET NULL,
          pane_id         TEXT NULL,
          terminal_id     TEXT NULL,
          baseline_panes  TEXT NOT NULL DEFAULT '[]',
          status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'committed', 'failed')),
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX idx_lifecycle_spawn_operations_requester
                 ON lifecycle_spawn_operations(requester_id, created_at)`);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        CREATE TABLE human_sessions (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          token_hash     TEXT NOT NULL UNIQUE,
          created_at     TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX idx_human_sessions_participant
                 ON human_sessions(participant_id, id)`);
    },
  },
  {
    version: 8,
    up: (db) => {
      db.exec(
        `ALTER TABLE participants
           ADD COLUMN deactivated INTEGER NOT NULL DEFAULT 0
           CHECK (deactivated IN (0, 1))`,
      );
    },
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`
        CREATE TABLE launchers (
          name         TEXT PRIMARY KEY,
          agent_kind   TEXT NOT NULL,
          argv_json    TEXT NOT NULL,
          revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE launcher_seeds (
          name          TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL
        )
      `);
      db.exec(`ALTER TABLE lifecycle_spawn_operations ADD COLUMN launcher TEXT NULL`);
      db.exec(
        `ALTER TABLE lifecycle_spawn_operations
           ADD COLUMN launcher_revision INTEGER NULL CHECK (launcher_revision IS NULL OR launcher_revision > 0)`,
      );
    },
  },
  {
    version: 10,
    up: (db) => {
      db.exec(`
        CREATE TABLE auto_enrollments (
          occupant_key    TEXT PRIMARY KEY,
          workspace_id    TEXT NOT NULL,
          terminal_id     TEXT NOT NULL,
          agent_kind      TEXT NOT NULL,
          participant_id  INTEGER NOT NULL REFERENCES participants(id),
          handle          TEXT NOT NULL,
          token_path      TEXT NOT NULL,
          prompt_delivered INTEGER NOT NULL DEFAULT 0 CHECK (prompt_delivered IN (0, 1)),
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX idx_auto_enrollments_participant
                 ON auto_enrollments(participant_id)`);
    },
  },
  {
    version: 11,
    up: (db) => {
      db.exec(`
        CREATE TABLE roles (
          name         TEXT PRIMARY KEY,
          agent_kind   TEXT NOT NULL,
          summary      TEXT NOT NULL,
          briefing     TEXT NOT NULL,
          launcher     TEXT NULL,
          model        TEXT NULL,
          effort       TEXT NULL,
          revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE role_seeds (
          name          TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE models (
          harness          TEXT NOT NULL,
          name             TEXT NOT NULL,
          kind             TEXT NOT NULL CHECK (kind IN ('model', 'effort')),
          argv_suffix_json TEXT NOT NULL,
          revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          PRIMARY KEY (harness, name)
        )
      `);
      db.exec(`
        CREATE TABLE model_seeds (
          harness       TEXT NOT NULL,
          name          TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          PRIMARY KEY (harness, name)
        )
      `);
    },
  },
  {
    version: 12,
    up: (db) => {
      db.exec(`ALTER TABLE lifecycle_agents ADD COLUMN terminal_id TEXT NULL`);
      db.exec(
        `ALTER TABLE lifecycle_spawn_operations
           ADD COLUMN cleanup_outcome TEXT NULL
           CHECK (cleanup_outcome IS NULL OR cleanup_outcome IN ('closed', 'skipped', 'failed'))`,
      );
      db.exec(
        `ALTER TABLE lifecycle_spawn_operations
           ADD COLUMN cleanup_error TEXT NULL`,
      );
    },
  },
  {
    // Version 12 shipped and ran on the live database before this branch
    // merged, so session_mappings takes the next number. Reusing 12 would
    // skip this table on every database that already recorded 12 as applied.
    version: 13,
    up: (db) => {
      // Keyed on terminal_id, the identity that survives a pane move. A table
      // offering only the volatile id would be read with it, so the durable one
      // is the primary key rather than a column beside it.
      db.exec(`
        CREATE TABLE session_mappings (
          terminal_id  TEXT PRIMARY KEY,
          harness      TEXT NOT NULL,
          session_id   TEXT NOT NULL,
          session_path TEXT NOT NULL,
          confidence   TEXT NOT NULL CHECK (confidence IN ('exact', 'inferred')),
          resolved_at  TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 14,
    up: (db) => {
      db.exec(
        `ALTER TABLE launchers
           ADD COLUMN start_timeout_ms INTEGER NOT NULL DEFAULT ${DEFAULT_AGENT_START_TIMEOUT_MS}
           CHECK (start_timeout_ms > 0)`,
      );
    },
  },
  {
    version: 15,
    up: (db) => {
      db.exec(`
        CREATE TABLE roles_new (
          name         TEXT PRIMARY KEY,
          agent_kind   TEXT NULL,
          summary      TEXT NOT NULL,
          briefing     TEXT NOT NULL,
          launcher     TEXT NULL,
          model        TEXT NULL,
          effort       TEXT NULL,
          native       INTEGER NOT NULL DEFAULT 0 CHECK (native IN (0, 1)),
          revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO roles_new
          (name, agent_kind, summary, briefing, launcher, model, effort, native,
           revision, created_at, updated_at)
        SELECT name, agent_kind, summary, briefing, launcher, model, effort, 0,
               revision, created_at, updated_at
          FROM roles
      `);
      db.exec(`DROP TABLE roles`);
      db.exec(`ALTER TABLE roles_new RENAME TO roles`);
    },
  },
  {
    version: 16,
    up: (db) => {
      db.exec(
        `ALTER TABLE launchers
           ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'`,
      );
      db.exec(
        `ALTER TABLE lifecycle_agents
           ADD COLUMN launch_env_json TEXT NOT NULL DEFAULT '{}'`,
      );
      db.exec(
        `ALTER TABLE lifecycle_spawn_operations
           ADD COLUMN launch_env_json TEXT NOT NULL DEFAULT '{}'`,
      );
    },
  },
];

export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Rebuilds the FTS index from `messages`. A no-op on an empty table; the
 * migration that introduces FTS to a database that already holds messages
 * depends on it for backfill.
 */
export function rebuildSearchIndex(db: Database): void {
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
}

function currentVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get();
  return row === null ? 0 : row.user_version;
}

function databaseOpenFailed(path: string, cause: unknown): DatabaseOpenFailed {
  return DatabaseOpenFailed.is(cause)
    ? cause
    : new DatabaseOpenFailed({
        path,
        cause,
        message: `Cannot open the hub database at ${path}`,
      });
}

function migrate(db: Database, path: string): Result<void, DatabaseOpenFailed> {
  const version = Result.try({
    try: () => currentVersion(db),
    catch: (cause) => databaseOpenFailed(path, cause),
  });
  if (version.isErr()) return version;

  if (version.value > SCHEMA_VERSION) {
    const message =
      `database was written by a newer msgr build (schema v${version.value}, this build supports v${SCHEMA_VERSION})`;
    return Result.err(new DatabaseOpenFailed({
      path,
      cause: new Error(message),
      message,
    }));
  }

  return Result.try({
    try: () => {
      for (const migration of MIGRATIONS) {
        if (migration.version <= version.value) continue;
        const rebuildsForeignKeyParent = migration.version === 3 || migration.version === 4;
        if (rebuildsForeignKeyParent) db.exec("PRAGMA foreign_keys = OFF");
        const apply = db.transaction(() => {
          migration.up(db);
          // PRAGMA does not accept bound parameters; the value is a literal from
          // MIGRATIONS, never caller input.
          db.exec(`PRAGMA user_version = ${migration.version}`);
        });
        try {
          apply();
        } finally {
          if (rebuildsForeignKeyParent) db.exec("PRAGMA foreign_keys = ON");
        }
      }
    },
    catch: (cause) => databaseOpenFailed(path, cause),
  });
}

/** Owner-only permissions, extended to the WAL sidecars once they exist. */
function restrictFileMode(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${path}${suffix}`;
    if (existsSync(target)) chmodSync(target, 0o600);
  }
}

/**
 * Opens the hub database and brings it to the current schema version.
 * `foreign_keys` and `busy_timeout` are per-connection and must be set on every
 * open; `journal_mode` persists in the file.
 *
 * An unreadable path, a directory the user cannot create, or a database from a
 * newer build are all conditions the caller reports rather than crashes on.
 */
export function openDatabase(path: string): Result<Database, DatabaseOpenFailed> {
  const onDisk = path !== IN_MEMORY;
  return Result.gen(function* () {
    yield* Result.try({
      try: () => {
        if (onDisk) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      },
      catch: (cause) => databaseOpenFailed(path, cause),
    });

    const db = yield* Result.try({
      try: () => new Database(path, { create: true, strict: true }),
      catch: (cause) => databaseOpenFailed(path, cause),
    });

    yield* Result.try({
      try: () => {
        db.exec(`PRAGMA journal_mode = WAL`);
        db.exec(`PRAGMA foreign_keys = ON`);
        db.exec(`PRAGMA busy_timeout = 5000`);
      },
      catch: (cause) => databaseOpenFailed(path, cause),
    });

    yield* migrate(db, path);

    yield* Result.try({
      try: () => {
        if (onDisk) restrictFileMode(path);
      },
      catch: (cause) => databaseOpenFailed(path, cause),
    });

    return Result.ok(db);
  });
}
