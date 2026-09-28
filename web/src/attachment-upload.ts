import { formatApiError } from "@/api/errors"
import type { MsgrApi } from "@/api/types"

/** The hub accepts at most this many attachments on one message. */
export const MAX_MESSAGE_ATTACHMENTS = 16

/** The composer state that one upload reports into. */
export interface UploadSink {
  addUploadPlaceholder: (key: string, label: string) => void
  setUploadProgress: (key: string, progress: number) => void
  completeUpload: (key: string, storedPath: string) => void
  markUploadError: (key: string, message: string) => void
}

export type UploadStart =
  | { kind: "started"; accepted: number; skipped: number }
  | { kind: "full" }

/**
 * Starts one upload per file, up to the attachment cap, and reports progress
 * and results into the sink. `nextKey` gives each upload a unique placeholder
 * key. Returns at once; the uploads finish in the background.
 */
export function startUploads(
  api: MsgrApi,
  files: readonly File[],
  attached: number,
  sink: UploadSink,
  nextKey: (file: File) => string,
): UploadStart {
  const remaining = Math.max(MAX_MESSAGE_ATTACHMENTS - attached, 0)
  if (remaining === 0) return { kind: "full" }
  const accepted = files.slice(0, remaining)
  for (const file of accepted) {
    const key = nextKey(file)
    sink.addUploadPlaceholder(key, file.name)
    void api
      .uploadFile(file, file.name, ({ loaded, total }) => {
        sink.setUploadProgress(key, total === 0 ? 0 : Math.round((loaded / total) * 100))
      })
      .then((result) => {
        result.match({
          ok: ({ path }) => sink.completeUpload(key, path),
          err: (error) => sink.markUploadError(key, formatApiError(error)),
        })
      })
  }
  return { kind: "started", accepted: accepted.length, skipped: files.length - accepted.length }
}
