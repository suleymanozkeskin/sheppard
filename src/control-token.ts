/**
 * Local configuration capability shared by the hub and the `msgr` process.
 *
 * The raw token exists only in a user-owned file. The hub keeps only its hash.
 * This lets local automation configure Sheppard without a participant token.
 * It also authenticates an explicitly connected Herdr pane when the request
 * carries that pane's exact current route.
 */

import { Result, TaggedError } from "better-result";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { mintToken } from "./tokens";

export const CONTROL_TOKEN_HEADER = "x-msgr-control-token";

export class LocalControlTokenFailed extends TaggedError("LocalControlTokenFailed")<{
  path: string;
  code: string | null;
  message: string;
}> {}

interface ErrnoError extends Error {
  code?: string;
}

function errorCode(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  // SAFETY: Node file errors can carry a string code. Other errors have no code.
  return (cause as ErrnoError).code ?? null;
}

function failure(path: string, cause: unknown): LocalControlTokenFailed {
  return new LocalControlTokenFailed({
    path,
    code: errorCode(cause),
    message: `Cannot access the local Sheppard control credential at ${path}.`,
  });
}

export function localControlTokenPath(databasePath: string): string {
  return `${databasePath}.control-token`;
}

function readToken(path: string): Result<string, LocalControlTokenFailed> {
  return Result.try({
    try: () => {
      const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = fstatSync(handle);
        if (!stats.isFile()) throw new Error("the credential path is not a regular file");
        const processUid = process.getuid?.();
        if (processUid !== undefined && stats.uid !== processUid) {
          throw new Error("the credential file belongs to another user");
        }
        if ((stats.mode & 0o077) !== 0) fchmodSync(handle, 0o600);
        const token = readFileSync(handle, "utf8").trim();
        if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
          throw new Error("the credential file is invalid");
        }
        return token;
      } finally {
        closeSync(handle);
      }
    },
    catch: (cause) => failure(path, cause),
  });
}

function createToken(path: string): Result<string, LocalControlTokenFailed> {
  return Result.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const token = mintToken();
      const handle = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(handle, `${token}\n`);
        fchmodSync(handle, 0o600);
      } finally {
        closeSync(handle);
      }
      return token;
    },
    catch: (cause) => failure(path, cause),
  });
}

export function ensureLocalControlToken(
  databasePath: string,
): Result<string, LocalControlTokenFailed> {
  const path = localControlTokenPath(databasePath);
  const existing = readToken(path);
  if (existing.isOk()) return existing;
  if (existing.error.code !== "ENOENT") return existing;

  const created = createToken(path);
  if (created.isOk() || created.error.code !== "EEXIST") return created;
  return readToken(path);
}

export function readLocalControlToken(databasePath: string): string | null {
  return readToken(localControlTokenPath(databasePath)).unwrapOr(null);
}
