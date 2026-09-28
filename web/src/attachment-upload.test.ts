import { Result } from "better-result"
import { describe, expect, it } from "bun:test"

import { MockMsgrApi } from "@/api/mock"
import { MAX_MESSAGE_ATTACHMENTS, startUploads, type UploadSink } from "@/attachment-upload"
import { attachmentsBlocked } from "@/hooks/use-agent-workbench"

function recordingSink() {
  const events: string[] = []
  const sink: UploadSink = {
    addUploadPlaceholder: (key, label) => events.push(`add ${key} ${label}`),
    setUploadProgress: (key, progress) => events.push(`progress ${key} ${progress}`),
    completeUpload: (key, stored) => events.push(`done ${key} ${stored}`),
    markUploadError: (key, message) => events.push(`error ${key} ${message}`),
  }
  return { events, sink }
}

function apiStoring(path: string): MockMsgrApi {
  const api = new MockMsgrApi()
  api.uploadFile = async () => Result.ok({ path })
  return api
}

describe("startUploads", () => {
  it("adds a placeholder per file and completes it with the stored path", async () => {
    const { events, sink } = recordingSink()
    const start = startUploads(apiStoring("/stored/a.txt"), [new File(["a"], "a.txt")], 0, sink, () => "k1")
    expect(start).toEqual({ kind: "started", accepted: 1, skipped: 0 })
    await Bun.sleep(0)
    expect(events).toEqual(["add k1 a.txt", "done k1 /stored/a.txt"])
  })

  it("stops at the attachment cap", () => {
    const { sink } = recordingSink()
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")]
    expect(startUploads(apiStoring("/s"), files, MAX_MESSAGE_ATTACHMENTS, sink, () => "k")).toEqual({ kind: "full" })
    expect(startUploads(apiStoring("/s"), files, MAX_MESSAGE_ATTACHMENTS - 1, sink, () => "k")).toEqual({
      kind: "started",
      accepted: 1,
      skipped: 1,
    })
  })
})

describe("attachmentsBlocked", () => {
  it("blocks sending while an upload runs or after it failed", () => {
    expect(attachmentsBlocked([{ path: "/a", status: "ready" }])).toBe(false)
    expect(attachmentsBlocked([{ path: "k", status: "uploading" }])).toBe(true)
    expect(attachmentsBlocked([{ path: "k", status: "error", error: "too large" }])).toBe(true)
  })
})
