/**
 * Test fixtures. Every test runs against its own in-memory database, so no
 * herdr instance and no filesystem state are involved.
 */

import type { Result } from "better-result";
import { IN_MEMORY, openDatabase } from "../src/db";
import { Store } from "../src/store";

/** A fixed clock keeps timestamps deterministic; message ids carry ordering. */
export function fixedClock(): () => string {
  return () => "2026-08-17T00:00:00.000Z";
}

export function freshStore() {
  const db = openDatabase(IN_MEMORY).unwrap("in-memory database must open");
  return { db, store: new Store(db, { now: fixedClock() }) };
}

/** Unwraps an expected-Ok Result in a test, failing loudly when it is an Err. */
export function expectOk<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw new Error(`expected Ok, received Err: ${JSON.stringify(error)}`);
    },
  });
}

/** Returns the error of an expected-Err Result. */
export function expectErr<T, E>(result: Result<T, E>): E {
  return result.match({
    ok: (value) => {
      throw new Error(`expected Err, received Ok: ${JSON.stringify(value)}`);
    },
    err: (error) => error,
  });
}
