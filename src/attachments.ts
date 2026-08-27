/**
 * Attachments are shared as absolute paths; the hub never copies the bytes.
 *
 * Preview eligibility is decided once, when the message is sent, and recorded as
 * a content hash. Serving re-reads the file and re-hashes it, so authorisation
 * is pinned to the bytes that were actually shared rather than to a name that
 * anything on the machine could later point somewhere else.
 *
 * Two classes are previewable. Raster images must match their magic bytes, and
 * markdown must be valid UTF-8 within a size a browser can render as text. In
 * both cases the extension is only a claim; the contents decide.
 */

import { Result } from "better-result";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  type NotFound,
  type NotPreviewable,
  type ValidationFailed,
  notFound,
  notPreviewable,
  validationFailed,
} from "./errors";
import type { AttachmentInput, StoredAttachment } from "./types";

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

const IMAGE_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const MARKDOWN_TYPES = new Map<string, string>([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
]);

/** Types worth naming for display, but never served by the preview endpoint. */
const OTHER_TYPES = new Map<string, string>([
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".pdf", "application/pdf"],
  [".html", "text/html"],
  [".log", "text/plain"],
]);

function startsWithBytes(bytes: Uint8Array, expected: readonly number[], offset: number): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * An extension alone is a claim, not evidence. The leading bytes decide whether
 * a file is served with an image content type.
 */
function looksLikeImage(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    case "image/jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff], 0);
    case "image/gif":
      return startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38], 0);
    case "image/webp":
      return (
        startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46], 0) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}

/** A strict decode rejects any byte sequence a text renderer could not read. */
function isValidUtf8(bytes: Uint8Array): boolean {
  return Result.try({
    try: () => {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    },
    catch: () => false,
  }).unwrapOr(false);
}

/** What it takes to preview one class of file, and how to serve it. */
interface PreviewKind {
  /** Recorded as the attachment's media type. */
  mediaType: string;
  /** Sent as the response Content-Type, which for text carries the encoding. */
  contentType: string;
  maxBytes: number;
  verify: (bytes: Uint8Array) => boolean;
}

function previewKindFor(path: string): PreviewKind | null {
  const extension = extname(path).toLowerCase();

  const image = IMAGE_TYPES.get(extension);
  if (image !== undefined) {
    return {
      mediaType: image,
      contentType: image,
      maxBytes: MAX_IMAGE_BYTES,
      verify: (bytes) => looksLikeImage(bytes, image),
    };
  }

  const markdown = MARKDOWN_TYPES.get(extension);
  if (markdown !== undefined) {
    return {
      mediaType: markdown,
      contentType: `${markdown}; charset=utf-8`,
      maxBytes: MAX_MARKDOWN_BYTES,
      verify: isValidUtf8,
    };
  }

  return null;
}

interface ResolvedFile {
  path: string;
  byteSize: number;
  mtime: string;
}

/** Resolves symlinks and rejects anything that is not a regular file. */
function resolveRegularFile(path: string): Result<ResolvedFile, ValidationFailed> {
  return Result.try({
    try: (): ResolvedFile => {
      const resolved = realpathSync(path);
      const stats = lstatSync(resolved);
      if (!stats.isFile()) throw new Error("not a regular file");
      return {
        path: resolved,
        byteSize: stats.size,
        mtime: stats.mtime.toISOString(),
      };
    },
    catch: () => validationFailed("attachments", `must name a readable file: ${path}`),
  });
}

function hashOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Captures what the file was at send time. A file too large for its class, or
 * whose contents contradict its extension, is stored as a plain path: still
 * shareable, never previewable.
 */
export function ingestAttachment(path: string): Result<AttachmentInput, ValidationFailed> {
  return resolveRegularFile(path).andThen((file) => {
    const extension = extname(file.path).toLowerCase();
    const kind = previewKindFor(file.path);

    const base: AttachmentInput = {
      path: file.path,
      displayName: basename(file.path),
      byteSize: file.byteSize,
      mediaType: kind?.mediaType ?? OTHER_TYPES.get(extension) ?? null,
      mtime: file.mtime,
      sha256: null,
    };

    if (kind === null || file.byteSize > kind.maxBytes) return Result.ok(base);

    const bytes = Result.try({
      try: (): Uint8Array => readFileSync(file.path),
      catch: () => validationFailed("attachments", `must name a readable file: ${path}`),
    });
    if (bytes.isErr()) return Result.err(bytes.error);
    // The extension claimed a type the contents do not support, so neither the
    // media type nor a preview is offered for it.
    if (!kind.verify(bytes.value)) return Result.ok({ ...base, mediaType: null });

    return Result.ok({ ...base, sha256: hashOf(bytes.value) });
  });
}

export interface Preview {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Re-reads and re-hashes before serving. A file that changed since it was sent
 * is reported as absent rather than as a different file, so the response never
 * carries bytes nobody chose to share.
 */
export function readPreview(
  attachment: StoredAttachment,
): Result<Preview, NotFound | NotPreviewable> {
  const kind = previewKindFor(attachment.path);
  const { sha256 } = attachment;
  if (sha256 === null || kind === null) return Result.err(notPreviewable(attachment.id));

  return resolveRegularFile(attachment.path).match({
    err: () => Result.err(notFound("Attachment")),
    ok: (file) => {
      if (file.path !== attachment.path) return Result.err(notFound("Attachment"));
      if (file.byteSize > kind.maxBytes) return Result.err(notFound("Attachment"));

      const bytes = Result.try({
        try: (): Uint8Array => readFileSync(file.path),
        catch: () => notFound("Attachment"),
      });
      if (bytes.isErr()) return Result.err(bytes.error);
      if (hashOf(bytes.value) !== sha256) return Result.err(notFound("Attachment"));
      if (!kind.verify(bytes.value)) return Result.err(notFound("Attachment"));

      return Result.ok({ bytes: bytes.value, contentType: kind.contentType });
    },
  });
}
