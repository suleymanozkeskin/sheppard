/**
 * Managed copies for browser uploads.
 *
 * Agent path attachments do not pass through this store. Uploads are written to
 * a private directory with a content-derived name, then returned as ordinary
 * paths so the existing attachment ingestion and preview pinning stay unchanged.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Result } from "better-result";
import { defaultUploadDirectory } from "./config";
import {
  type UploadStorageFailed,
  type ValidationFailed,
  uploadStorageFailed,
  validationFailed,
} from "./errors";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_FILENAME_LENGTH = 255;

const SHA_PREFIX_LENGTH = 16;
const SPACE = 0x20;
const DELETE = 0x7f;
const C1_CONTROL_END = 0x9f;

export interface StoredUpload {
  path: string;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < SPACE || (code >= DELETE && code <= C1_CONTROL_END);
}

function sanitizeFilename(raw: string): string {
  const stripped = [...raw]
    .filter((character) => character !== "/" && character !== "\\" && !isControl(character))
    .join("");
  const fallback = stripped.length === 0 ? "upload" : stripped;
  return fallback.slice(0, MAX_UPLOAD_FILENAME_LENGTH);
}

function cleanup(path: string): void {
  Result.try({ try: () => rmSync(path, { force: true }), catch: () => undefined });
}

function closeDescriptor(descriptor: number): void {
  Result.try({ try: () => closeSync(descriptor), catch: () => undefined });
}

export class UploadStore {
  private readonly directory: string;

  constructor(directory = defaultUploadDirectory()) {
    this.directory = directory;
  }

  async save(
    body: ReadableStream<Uint8Array> | null,
    rawFilename: string,
  ): Promise<Result<StoredUpload, ValidationFailed | UploadStorageFailed>> {
    if (body === null) return Result.err(validationFailed("body", "must not be empty"));

    const ready = Result.try({
      try: () => {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        chmodSync(this.directory, 0o700);
      },
      catch: () => uploadStorageFailed(),
    });
    if (ready.isErr()) return Result.err(ready.error);

    const filename = sanitizeFilename(rawFilename);
    const temporaryPath = join(this.directory, `.upload-${randomUUID()}`);
    let descriptor: number | null = null;
    let completed = false;

    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      const hasher = new Bun.CryptoHasher("sha256");
      const reader = body.getReader();
      let size = 0;

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;

        size += chunk.value.byteLength;
        if (size > MAX_UPLOAD_BYTES) {
          void reader.cancel().catch(() => undefined);
          return Result.err(
            validationFailed("body", `must be at most ${MAX_UPLOAD_BYTES} bytes`),
          );
        }

        const written = writeSync(descriptor, chunk.value);
        if (written !== chunk.value.byteLength) throw new Error("short upload write");
        hasher.update(chunk.value);
      }

      if (size === 0) return Result.err(validationFailed("body", "must not be empty"));

      closeSync(descriptor);
      descriptor = null;

      const prefix = hasher.digest("hex").slice(0, SHA_PREFIX_LENGTH);
      const storedPath = join(this.directory, `${prefix}-${filename}`);
      if (existsSync(storedPath)) {
        cleanup(temporaryPath);
      } else {
        renameSync(temporaryPath, storedPath);
      }
      chmodSync(storedPath, 0o600);
      completed = true;
      return Result.ok({ path: realpathSync(storedPath) });
    } catch {
      return Result.err(uploadStorageFailed());
    } finally {
      if (descriptor !== null) closeDescriptor(descriptor);
      if (!completed) cleanup(temporaryPath);
    }
  }
}
