import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_UPLOAD_BYTES } from "../src/uploads";
import type { Message } from "../src/types";
import { BASE, auth, provision, testHub } from "./http-support";
import type { TestHub } from "./http-support";

async function body<T>(response: Response): Promise<T> {
  // SAFETY: each caller names the response shape required by its endpoint and
  // asserts the relevant fields immediately after decoding.
  return (await response.json()) as T;
}

async function upload(
  hub: TestHub,
  token: string,
  bytes: Uint8Array,
  filename: string,
): Promise<Response> {
  return hub.handler(
    new Request(`${BASE}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-msgr-filename": filename,
        "x-msgr-token": token,
      },
      body: bytes,
    }),
  );
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "msgr-upload-"));
}

describe("managed uploads", () => {
  test("stores a sanitized sha-named file with private permissions", async () => {
    const directory = temporaryDirectory();
    try {
      const hub = testHub({ uploadDirectory: directory });
      const token = await provision(hub, "alice");
      const bytes = new TextEncoder().encode("# uploaded\n");

      const response = await upload(hub, token, bytes, "../note.md");
      expect(response.status).toBe(201);
      const stored = await body<{ path: string }>(response);

      expect(stored.path.startsWith(`${realpathSync(directory)}/`)).toBe(true);
      expect(basename(stored.path)).toMatch(/^[0-9a-f]{16}-\.\.note\.md$/);
      expect(statSync(stored.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(stored.path)).toEqual(bytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects empty and oversized bodies", async () => {
    const directory = temporaryDirectory();
    try {
      const hub = testHub({ uploadDirectory: directory });
      const token = await provision(hub, "alice");

      expect((await upload(hub, token, new Uint8Array(), "empty.txt")).status).toBe(400);
      expect(
        (await upload(hub, token, new Uint8Array(MAX_UPLOAD_BYTES + 1), "large.bin")).status,
      ).toBe(400);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("strips C1 control characters from filenames", async () => {
    const directory = temporaryDirectory();
    try {
      const hub = testHub({ uploadDirectory: directory });
      const token = await provision(hub, "alice");
      const response = await upload(hub, token, new Uint8Array([1, 2, 3]), "a\u0080b.txt");
      expect(response.status).toBe(201);
      const stored = await body<{ path: string }>(response);
      expect(basename(stored.path)).toMatch(/^[0-9a-f]{16}-ab\.txt$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns a path accepted by the existing attachment ingestion", async () => {
    const directory = temporaryDirectory();
    try {
      const hub = testHub({ uploadDirectory: directory });
      const token = await provision(hub, "alice");
      await hub.post("/api/channels", { name: "backend" }, auth(token));
      await hub.post("/api/channels/backend/join", {}, auth(token));

      const bytes = new TextEncoder().encode("# release notes\n");
      const uploaded = await body<{ path: string }>(await upload(hub, token, bytes, "notes.md"));
      const sent = await hub.post(
        "/api/channels/backend/messages",
        { body: "See the notes", attachments: [uploaded.path] },
        auth(token),
      );

      expect(sent.status).toBe(201);
      const message = await body<Message>(sent);
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments?.[0]).toMatchObject({
        path: uploaded.path,
        mediaType: "text/markdown",
        previewEligible: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
