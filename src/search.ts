/**
 * Turns a user's search text into an FTS5 expression that means exactly what it
 * says. Every term is quoted, so operators the user typed (`OR`, `NEAR`, `*`,
 * `-`, `:`) are matched as text instead of being executed as query syntax.
 */

import { Result } from "better-result";
import { type ValidationFailed, validationFailed } from "./errors";
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS } from "./validate";

/**
 * A term that survives quoting but contains no token the index can match makes
 * FTS5 reject the whole expression, so terms are kept only when they carry at
 * least one alphanumeric character.
 */
const MATCHABLE = /[\p{L}\p{N}]/u;

export function literalQuery(raw: string): Result<string, ValidationFailed> {
  if (raw.length > MAX_QUERY_LENGTH) {
    return Result.err(validationFailed("q", `must be at most ${MAX_QUERY_LENGTH} characters`));
  }

  const terms = raw
    .split(/\s+/u)
    .filter((term) => MATCHABLE.test(term))
    .slice(0, MAX_QUERY_TERMS);

  if (terms.length === 0) {
    return Result.err(validationFailed("q", "must contain at least one letter or digit"));
  }

  const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
  return Result.ok(quoted.join(" AND "));
}
