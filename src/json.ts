/**
 * Decoding for values that arrive as JSON over HTTP.
 *
 * Nothing downstream of this file inspects the representation of a request
 * value. A request body is decoded once, here, into domain types; a caller
 * either receives the type it asked for or a ValidationFailed describing the
 * field that was wrong.
 */

import { Result } from "better-result";
import { type ValidationFailed, validationFailed } from "./errors";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Discriminates by object tag rather than by operator. The tag is stable for
 * every value JSON.parse can produce, including values from other realms.
 */
function tagOf(value: JsonValue): string {
  return Object.prototype.toString.call(value);
}

export function isString(value: JsonValue): value is string {
  return tagOf(value) === "[object String]";
}

function isNumber(value: JsonValue): value is number {
  return tagOf(value) === "[object Number]";
}

export function isObject(value: JsonValue): value is JsonObject {
  return tagOf(value) === "[object Object]";
}

function isBoolean(value: JsonValue): value is boolean {
  return tagOf(value) === "[object Boolean]";
}

/** A request body must be a JSON object; arrays and bare literals are rejected. */
export function decodeObject(value: JsonValue): Result<JsonObject, ValidationFailed> {
  if (!isObject(value)) return Result.err(validationFailed("body", "expected a JSON object"));
  return Result.ok(value);
}

function present(body: JsonObject, field: string): boolean {
  const value = body[field];
  return value !== undefined && value !== null;
}

export function requiredString(body: JsonObject, field: string): Result<string, ValidationFailed> {
  if (!present(body, field)) return Result.err(validationFailed(field, "is required"));
  const value = body[field];
  if (value === undefined || !isString(value)) {
    return Result.err(validationFailed(field, "must be a string"));
  }
  return Result.ok(value);
}

export function optionalString(
  body: JsonObject,
  field: string,
): Result<string | null, ValidationFailed> {
  if (!present(body, field)) return Result.ok(null);
  return requiredString(body, field);
}

export function requiredNullableString(
  body: JsonObject,
  field: string,
): Result<string | null, ValidationFailed> {
  if (!Object.hasOwn(body, field)) return Result.err(validationFailed(field, "is required"));
  if (body[field] === null) return Result.ok(null);
  return requiredString(body, field);
}

export function requiredInteger(body: JsonObject, field: string): Result<number, ValidationFailed> {
  if (!present(body, field)) return Result.err(validationFailed(field, "is required"));
  const value = body[field];
  if (value === undefined || !isNumber(value) || !Number.isInteger(value)) {
    return Result.err(validationFailed(field, "must be an integer"));
  }
  return Result.ok(value);
}

export function optionalInteger(
  body: JsonObject,
  field: string,
  fallback: number,
): Result<number, ValidationFailed> {
  if (!present(body, field)) return Result.ok(fallback);
  return requiredInteger(body, field);
}

/** Absent and empty are both an empty list; a non-list or non-string entry is an error. */
export function optionalStringArray(
  body: JsonObject,
  field: string,
): Result<string[], ValidationFailed> {
  if (!present(body, field)) return Result.ok([]);
  const value = body[field];
  if (value === undefined || !Array.isArray(value)) {
    return Result.err(validationFailed(field, "must be an array of strings"));
  }

  const decoded: string[] = [];
  for (const entry of value) {
    if (!isString(entry)) return Result.err(validationFailed(field, "must contain only strings"));
    decoded.push(entry);
  }
  return Result.ok(decoded);
}

export function optionalBoolean(
  body: JsonObject,
  field: string,
  fallback: boolean,
): Result<boolean, ValidationFailed> {
  if (!present(body, field)) return Result.ok(fallback);
  const value = body[field];
  if (value === undefined || !isBoolean(value)) {
    return Result.err(validationFailed(field, "must be a boolean"));
  }
  return Result.ok(value);
}

/** Reads a nested object, for payloads that wrap their content in an envelope. */
export function objectField(body: JsonObject, field: string): Result<JsonObject, ValidationFailed> {
  if (!present(body, field)) return Result.err(validationFailed(field, "is required"));
  const value = body[field];
  if (value === undefined || !isObject(value)) {
    return Result.err(validationFailed(field, "must be an object"));
  }
  return Result.ok(value);
}

export function arrayField(body: JsonObject, field: string): Result<JsonValue[], ValidationFailed> {
  if (!present(body, field)) return Result.err(validationFailed(field, "is required"));
  const value = body[field];
  if (value === undefined || !Array.isArray(value)) {
    return Result.err(validationFailed(field, "must be an array"));
  }
  return Result.ok(value);
}

/** Decodes a query-string integer, which arrives as text or not at all. */
export function integerParam(
  raw: string | null,
  field: string,
  fallback: number,
): Result<number, ValidationFailed> {
  if (raw === null || raw.length === 0) return Result.ok(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return Result.err(validationFailed(field, "must be an integer"));
  return Result.ok(parsed);
}
