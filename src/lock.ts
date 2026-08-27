/**
 * One hub per database.
 *
 * Two hubs sharing a database would each run a notifier loop, both would find
 * the same pending rows, and every agent would be pinged twice. The lock makes
 * that arrangement fail at startup with an explanation instead of appearing to
 * work.
 *
 * Only an existing lock file means contention. Every other failure — a directory
 * that cannot be created, a path that is not writable — is reported as itself,
 * because telling someone another hub holds the database when none does sends
 * them looking for a process that was never there.
 */

import { Result, TaggedError } from "better-result";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { IN_MEMORY } from "./db";

/** A lock file already exists and the process named in it is alive. */
export class HubAlreadyRunning extends TaggedError("HubAlreadyRunning")<{
  path: string;
  pid: number;
  message: string;
}> {}

/** The lock could not be established for a reason unrelated to contention. */
export class HubLockFailed extends TaggedError("HubLockFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export type HubLockError = HubAlreadyRunning | HubLockFailed;

export interface HubLock {
  release: () => void;
}

interface ErrnoError extends Error {
  code?: string;
}

function errnoCode(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  // SAFETY: the filesystem errors this module can raise carry a string `code`.
  // Anything without one yields null and is treated as unclassified.
  const errno = cause as ErrnoError;
  return errno.code ?? null;
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown error";
}

function holderPid(path: string): number | null {
  const read = Result.try({
    try: () => Number(readFileSync(path, "utf8").trim()),
    catch: () => null,
  }).unwrapOr(Number.NaN);
  return Number.isInteger(read) && read > 0 ? read : null;
}

/** Signal 0 performs the permission and existence checks without delivering anything. */
function processAlive(pid: number): boolean {
  return Result.try({
    try: () => {
      process.kill(pid, 0);
      return true;
    },
    catch: () => false,
  }).unwrapOr(false);
}

/** Returns the live hub process for a database, or null when no hub owns it. */
export function activeHubPid(databasePath: string): number | null {
  if (databasePath === IN_MEMORY) return null;
  const pid = holderPid(`${databasePath}.lock`);
  return pid !== null && processAlive(pid) ? pid : null;
}

function alreadyRunning(path: string, pid: number | null): HubAlreadyRunning {
  const owner = pid === null ? "another process" : `process ${pid}`;
  return new HubAlreadyRunning({
    path,
    pid: pid ?? 0,
    message:
      `Another msgr hub (${owner}) is already using this database.\n` +
      `Stop it, or set MSGR_DB to a different path. Lock file: ${path}`,
  });
}

/**
 * `wx` fails when the file exists, which is the whole mechanism: creating the
 * lock and finding it already there are one atomic step.
 */
function write(path: string): Result<HubLock, HubLockError> {
  return Result.try({
    try: (): HubLock => {
      const handle = openSync(path, "wx");
      writeSync(handle, String(process.pid));
      closeSync(handle);
      return { release: () => remove(path) };
    },
    catch: (cause) =>
      errnoCode(cause) === "EEXIST"
        ? alreadyRunning(path, holderPid(path))
        : new HubLockFailed({
            path,
            cause,
            message: `Cannot create the hub lock at ${path}: ${detailOf(cause)}`,
          }),
  });
}

function remove(path: string): void {
  // A lock already cleaned up by another shutdown path is not a problem.
  Result.try({ try: () => rmSync(path, { force: true }), catch: () => null });
}

function ensureDirectory(path: string): Result<void, HubLockFailed> {
  return Result.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    },
    catch: (cause) =>
      new HubLockFailed({
        path,
        cause,
        message: `Cannot create the directory for ${path}: ${detailOf(cause)}`,
      }),
  });
}

/**
 * A lock file left behind by a crash names a process that no longer exists, so it
 * is reclaimed rather than requiring manual cleanup.
 *
 * An in-memory database is private to this process, so there is nothing for a
 * second hub to collide with and no lock file is created.
 */
export function acquireHubLock(databasePath: string): Result<HubLock, HubLockError> {
  if (databasePath === IN_MEMORY) return Result.ok({ release: () => undefined });

  const path = `${databasePath}.lock`;
  const prepared = ensureDirectory(path);
  if (prepared.isErr()) return prepared;

  const first = write(path);
  if (first.isOk()) return first;
  // Only contention is worth a second look; anything else is already the answer.
  if (!HubAlreadyRunning.is(first.error)) return first;

  const pid = holderPid(path);
  if (pid !== null && processAlive(pid)) return first;

  remove(path);
  return write(path);
}
