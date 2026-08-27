/**
 * Input limits enforced before anything reaches the database.
 *
 * Handles and channel names share one narrow pattern. Everything downstream —
 * ping text, GROUP_CONCAT of sender handles, terminal output — depends on that
 * pattern holding, so it is checked once at creation and never re-derived.
 */

import { Result } from "better-result";
import { type ValidationFailed, validationFailed } from "./errors";

export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SPACE = 0x20;
const DELETE = 0x7f;
const C1_CONTROL_END = 0x9f;

/** Rejects C0 controls, C1 controls, and DEL, except layout whitespace when allowed. */
function hasControlCharacter(value: string, allowLayoutWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (allowLayoutWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code < SPACE || (code >= DELETE && code <= C1_CONTROL_END)) return true;
  }
  return false;
}

function validText(value: string, field: string, allowLayoutWhitespace: boolean): Result<string, ValidationFailed> {
  if (hasControlCharacter(value, allowLayoutWhitespace)) {
    return Result.err(validationFailed(field, "must not contain control characters"));
  }
  return Result.ok(value);
}

export const MAX_BODY_LENGTH = 65_536;
export const MAX_TOPIC_LENGTH = 256;
export const MAX_ATTACHMENTS = 16;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_LAUNCHER_ARGS = 64;
export const MAX_LAUNCHER_ARG_LENGTH = 4_096;
export const MAX_LAUNCHER_ENV_ENTRIES = 128;
export const MAX_LAUNCHER_ENV_KEY_LENGTH = 128;
export const MAX_LAUNCHER_ENV_VALUE_LENGTH = 8_192;

export const MAX_QUERY_LENGTH = 256;
export const MAX_QUERY_TERMS = 8;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_CONTEXT_SPAN = 50;
export const DEFAULT_CONTEXT_SPAN = 20;
export const MAX_REPLAY = 500;

export function validName(value: string, field: string): Result<string, ValidationFailed> {
  if (!NAME_PATTERN.test(value)) {
    return Result.err(
      validationFailed(field, "must start with a letter and use only a-z, 0-9, _ or - (max 32)"),
    );
  }
  return Result.ok(value);
}

/** Model and effort values are opaque bounded arguments from the selected launcher. */
export function validModelIdentifier(value: string, field: string): Result<string, ValidationFailed> {
  if (value.length === 0 || value.length > 192 || hasControlCharacter(value, false)) {
    return Result.err(
      validationFailed(field, "must be a non-empty model identifier without control characters (max 192)"),
    );
  }
  return Result.ok(value);
}

export function validStoredText(value: string, field: string): Result<string, ValidationFailed> {
  return validText(value, field, false);
}

export function validLauncherArgv(
  argv: string[],
): Result<string[], ValidationFailed> {
  if (argv.length === 0) return Result.err(validationFailed("argv", "must not be empty"));
  if (argv.length > MAX_LAUNCHER_ARGS) {
    return Result.err(
      validationFailed("argv", `must contain at most ${MAX_LAUNCHER_ARGS} arguments`),
    );
  }
  for (const argument of argv) {
    if (argument.length === 0) {
      return Result.err(validationFailed("argv", "must not contain empty arguments"));
    }
    if (argument.length > MAX_LAUNCHER_ARG_LENGTH) {
      return Result.err(
        validationFailed(
          "argv",
          `must not contain an argument longer than ${MAX_LAUNCHER_ARG_LENGTH} characters`,
        ),
      );
    }
    const validated = validStoredText(argument, "argv");
    if (validated.isErr()) return validated;
  }
  return Result.ok(argv);
}

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const RESERVED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "CDPATH",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
]);

function forbiddenEnvironmentKey(key: string): boolean {
  return RESERVED_ENVIRONMENT_KEYS.has(key) ||
    key === "MSGR_HANDLE" ||
    key === "MSGR_TOKEN" ||
    key.startsWith("MSGR_") ||
    key.startsWith("LD_") ||
    key.startsWith("DYLD_");
}

/** Validates launcher environment without including values in any error. */
export function validLauncherEnvironment(
  environment: Readonly<Record<string, string>>,
  field = "env",
): Result<Record<string, string>, ValidationFailed> {
  const entries = Object.entries(environment);
  if (entries.length > MAX_LAUNCHER_ENV_ENTRIES) {
    return Result.err(validationFailed(field, `must contain at most ${MAX_LAUNCHER_ENV_ENTRIES} entries`));
  }
  const validated: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_LAUNCHER_ENV_KEY_LENGTH || !ENVIRONMENT_KEY_PATTERN.test(key)) {
      return Result.err(validationFailed(field, "contains an invalid environment key"));
    }
    if (forbiddenEnvironmentKey(key)) {
      return Result.err(validationFailed(field, "contains a reserved environment key"));
    }
    if (value.length > MAX_LAUNCHER_ENV_VALUE_LENGTH) {
      return Result.err(validationFailed(field, "contains an environment value that is too long"));
    }
    if (validStoredText(value, field).isErr()) {
      return Result.err(validationFailed(field, "contains an environment value with control characters"));
    }
    validated[key] = value;
  }
  return Result.ok(validated);
}

export function validBody(value: string): Result<string, ValidationFailed> {
  if (value.length === 0) return Result.err(validationFailed("body", "must not be empty"));
  if (value.length > MAX_BODY_LENGTH) {
    return Result.err(validationFailed("body", `must be at most ${MAX_BODY_LENGTH} characters`));
  }
  return validText(value, "body", true);
}

export function validPromptText(value: string): Result<string, ValidationFailed> {
  if (value.length === 0) return Result.err(validationFailed("text", "must not be empty"));
  if (value.length > MAX_BODY_LENGTH) {
    return Result.err(validationFailed("text", `must be at most ${MAX_BODY_LENGTH} characters`));
  }
  return validText(value, "text", true);
}

export function validTopic(value: string | null): Result<string | null, ValidationFailed> {
  if (value === null) return Result.ok(null);
  if (value.length > MAX_TOPIC_LENGTH) {
    return Result.err(validationFailed("topic", `must be at most ${MAX_TOPIC_LENGTH} characters`));
  }
  return validText(value, "topic", true);
}

/** Paths are checked for form here; existence and file type are checked at ingestion. */
export function validAttachmentPaths(paths: string[]): Result<string[], ValidationFailed> {
  if (paths.length > MAX_ATTACHMENTS) {
    return Result.err(
      validationFailed("attachments", `must contain at most ${MAX_ATTACHMENTS} paths`),
    );
  }
  for (const path of paths) {
    if (!path.startsWith("/")) {
      return Result.err(validationFailed("attachments", "must contain absolute paths only"));
    }
    if (path.length > MAX_PATH_LENGTH) {
      return Result.err(validationFailed("attachments", "contains a path that is too long"));
    }
    const validated = validStoredText(path, "attachments");
    if (validated.isErr()) return validated;
  }
  return Result.ok(paths);
}

/** Clamps rather than rejects, so an oversized limit degrades instead of failing. */
export function clampLimit(requested: number, fallback: number, ceiling: number): number {
  if (requested <= 0) return fallback;
  return Math.min(requested, ceiling);
}
