import { describe, expect, test } from "bun:test";
import { FakeHerdr } from "../src/herdr";
import { BASE, auth, provision, testHub } from "./http-support";
import type { TestHub } from "./http-support";

const decoder = new TextDecoder();

/** Reads frames until `wanted` have arrived or the stream goes quiet. */
async function readFrames(
  stream: ReadableStream<Uint8Array>,
  wanted: number,
): Promise<string[]> {
  const reader = stream.getReader();
  const frames: string[] = [];
  let buffer = "";

  while (frames.length < wanted) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(500).then(() => null),
    ]);
    if (next === null || next.done) break;

    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.startsWith(":")) continue;
      frames.push(part);
    }
  }

  await reader.cancel();
  return frames;
}

function subscribe(hub: TestHub, headers: Record<string, string> = {}) {
  const aborter = new AbortController();
  const response = hub.handler(
    new Request(`${BASE}/api/events`, { headers, signal: aborter.signal }),
  );
  return { response, aborter };
}

async function seed(): Promise<{ hub: TestHub; alice: string; bob: string }> {
  const hub = testHub();
  const alice = await provision(hub, "alice");
  const bob = await provision(hub, "bob");
  await hub.post("/api/channels", { name: "backend" }, auth(alice));
  await hub.post("/api/channels/backend/join", {}, auth(alice));
  await hub.post("/api/channels/backend/join", {}, auth(bob));
  return { hub, alice, bob };
}

describe("event stream", () => {
  test("announces itself as an event stream that is never cached", async () => {
    const { hub } = await seed();
    const { response, aborter } = subscribe(hub);
    const stream = await response;

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.headers.get("cache-control")).toBe("no-store");
    aborter.abort();
  });

  test("delivers each new message with its id as the event id", async () => {
    const { hub, alice } = await seed();
    const { response, aborter } = subscribe(hub);
    const stream = await response;

    await hub.post("/api/channels/backend/messages", { body: "first" }, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "second" }, auth(alice));

    const frames = await readFrames(stream.body!, 2);
    expect(frames.length).toBe(2);
    expect(frames[0]).toContain("id: 1");
    expect(frames[1]).toContain("id: 2");

    // SAFETY: the data line was written by the hub's own frame encoder, so it is
    // the JSON encoding of the Message just sent.
    const payload = JSON.parse(frames[0]!.split("data: ")[1] ?? "{}") as { body: string };
    expect(payload.body).toBe("first");
    aborter.abort();
  });

  test("multiplexes the current herdr topology onto the message stream", async () => {
    const hub = testHub();
    const herdr = new FakeHerdr();
    herdr.workspaces = [{ id: "w1", label: "Backend" }];
    herdr.withPane({ paneId: "w1:p1", terminalId: "term-1" });
    hub.hub.herdr = herdr;

    const { response, aborter } = subscribe(hub);
    const stream = await response;
    const reader = stream.body!.getReader();
    const initial = await reader.read();
    const initialText = decoder.decode(initial.value);
    expect(initialText).toContain("event: topology");
    expect(initialText).toContain('"id":"w1"');

    const alice = await provision(hub, "alice");
    await hub.post("/api/channels", { name: "backend" }, auth(alice));
    await hub.post("/api/channels/backend/join", {}, auth(alice));
    await hub.post("/api/channels/backend/messages", { body: "hello" }, auth(alice));
    const message = await reader.read();
    expect(decoder.decode(message.value)).toContain("id: 1");

    await reader.cancel();
    aborter.abort();
  });

  test("keeps each message on a single data line", async () => {
    const { hub, alice } = await seed();
    const { response, aborter } = subscribe(hub);
    const stream = await response;

    await hub.post("/api/channels/backend/messages", { body: "line one\\nline two" }, auth(alice));

    const frames = await readFrames(stream.body!, 1);
    const lines = frames[0]!.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("id: 1");
    expect(lines[1]?.startsWith("data: ")).toBe(true);
    aborter.abort();
  });

  test("replays what a reconnecting client missed", async () => {
    const { hub, alice } = await seed();
    for (const text of ["one", "two", "three"]) {
      await hub.post("/api/channels/backend/messages", { body: text }, auth(alice));
    }

    const { response, aborter } = subscribe(hub, { "last-event-id": "1" });
    const stream = await response;

    const frames = await readFrames(stream.body!, 2);
    expect(frames.map((frame) => frame.split("\n")[0])).toEqual(["id: 2", "id: 3"]);
    aborter.abort();
  });

  test("replays nothing when the client is already current", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));

    const { response, aborter } = subscribe(hub, { "last-event-id": "1" });
    const stream = await response;

    expect(await readFrames(stream.body!, 1)).toEqual([]);
    aborter.abort();
  });

  test("ignores a malformed Last-Event-ID instead of failing the connection", async () => {
    const { hub, alice } = await seed();
    await hub.post("/api/channels/backend/messages", { body: "one" }, auth(alice));

    const { response, aborter } = subscribe(hub, { "last-event-id": "not-a-number" });
    const stream = await response;
    expect(stream.status).toBe(200);
    expect(await readFrames(stream.body!, 1)).toEqual([]);
    aborter.abort();
  });

  test("drops a subscriber once its connection aborts", async () => {
    const { hub } = await seed();
    const { response, aborter } = subscribe(hub);
    await response;
    expect(hub.hub.broadcaster.size).toBe(1);

    aborter.abort();
    await Bun.sleep(10);
    expect(hub.hub.broadcaster.size).toBe(0);
  });

  test("serves several subscribers at once", async () => {
    const { hub, alice } = await seed();
    const first = subscribe(hub);
    const second = subscribe(hub);
    const streams = [await first.response, await second.response];
    expect(hub.hub.broadcaster.size).toBe(2);

    await hub.post("/api/channels/backend/messages", { body: "broadcast" }, auth(alice));

    for (const stream of streams) {
      const frames = await readFrames(stream.body!, 1);
      expect(frames[0]).toContain("broadcast");
    }
    first.aborter.abort();
    second.aborter.abort();
  });

  test("delivers receipt frames only to members of the receipt channel", async () => {
    const { hub, alice, bob } = await seed();
    const outsider = await provision(hub, "outsider");
    const message = await hub.post(
      "/api/channels/backend/messages",
      { body: "receipt target" },
      auth(alice),
    );
    const messageId = Number((await message.json()).id);

    const member = subscribe(hub, auth(alice));
    const nonMember = subscribe(hub, auth(outsider));
    const memberStream = await member.response;
    const nonMemberStream = await nonMember.response;

    const ack = await hub.post("/api/channels/backend/ack", { throughId: messageId }, auth(bob));
    expect(ack.status).toBe(200);

    const memberFrames = await readFrames(memberStream.body!, 1);
    expect(memberFrames).toHaveLength(1);
    expect(memberFrames[0]).toContain('"channel":"backend"');
    expect(await readFrames(nonMemberStream.body!, 1)).toEqual([]);
    member.aborter.abort();
    nonMember.aborter.abort();
  });

  test("coalesces an ack through a backlog into one receipt frame", async () => {
    const { hub, alice, bob } = await seed();
    for (let index = 0; index < 200; index += 1) {
      await hub.post("/api/channels/backend/messages", { body: `message ${index}` }, auth(alice));
    }

    const { response, aborter } = subscribe(hub, auth(alice));
    const stream = await response;
    await hub.post("/api/channels/backend/ack", { throughId: 200 }, auth(bob));
    await hub.post("/api/channels/backend/ack", { throughId: 200 }, auth(bob));

    const frames = await readFrames(stream.body!, 2);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: receipt");
    const data = frames[0]?.split("data: ")[1];
    expect(data === undefined ? undefined : JSON.parse(data)).toEqual({
      channel: "backend",
      handle: "bob",
      cursorMessageId: 200,
    });
    aborter.abort();
  });
});
