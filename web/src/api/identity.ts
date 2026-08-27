import { Result, TaggedError } from "better-result"
import * as v from "valibot"

const IDENTITY_KEY = "msgr.identity.v1"

const identitySchema = v.object({
  version: v.literal(1),
  hub: v.string(),
  handle: v.string(),
})

export type StoredIdentity = v.InferOutput<typeof identitySchema>

export class IdentityStorageError extends TaggedError("IdentityStorageError")<{
  message: string
  cause: unknown
}> {}

function storage(): Result<Storage | null, IdentityStorageError> {
  return Result.try<Storage | null, IdentityStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) =>
      new IdentityStorageError({
        cause,
        message: "Browser storage is not available",
      }),
  })
}

export function loadIdentity(): Result<StoredIdentity | null, IdentityStorageError> {
  return storage().andThen((store) => {
    if (store === null) return Result.ok(null)
    const raw = Result.try<string | null, IdentityStorageError>({
      try: () => store.getItem(IDENTITY_KEY),
      catch: (cause) =>
        new IdentityStorageError({
          cause,
          message: "The stored identity could not be read",
        }),
    })
    return raw.andThen((value) => {
      if (value === null) return Result.ok(null)
      const parsed = Result.try<unknown, IdentityStorageError>({
        try: () => JSON.parse(value),
        catch: (cause) =>
          new IdentityStorageError({
            cause,
            message: "The stored identity is not valid JSON",
          }),
      })
      return parsed.andThen((candidate) => {
        const decoded = v.safeParse(identitySchema, candidate)
        return decoded.success
          ? Result.ok(decoded.output)
          : Result.err(
              new IdentityStorageError({
                cause: decoded.issues,
                message: "The stored identity does not match the local schema",
              }),
            )
      })
    })
  })
}

export function saveIdentity(identity: StoredIdentity): Result<void, IdentityStorageError> {
  return storage().andThen((store) => {
    if (store === null) return Result.ok(undefined)
    return Result.try<void, IdentityStorageError>({
      try: () => {
        store.setItem(IDENTITY_KEY, JSON.stringify(identity))
      },
      catch: (cause) =>
        new IdentityStorageError({
          cause,
          message: "The identity could not be saved in browser storage",
        }),
    })
  })
}

export function removeIdentity(): Result<void, IdentityStorageError> {
  return storage().andThen((store) => {
    if (store === null) return Result.ok(undefined)
    return Result.try<void, IdentityStorageError>({
      try: () => {
        store.removeItem(IDENTITY_KEY)
      },
      catch: (cause) =>
        new IdentityStorageError({
          cause,
          message: "The stored identity could not be removed",
        }),
    })
  })
}

export function identityForHandle(handle: string): StoredIdentity {
  return {
    version: 1,
    hub: globalThis.location?.origin ?? "http://127.0.0.1:6747",
    handle,
  }
}
