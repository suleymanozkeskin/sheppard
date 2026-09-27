import { describe, expect, test } from "bun:test";
import { auth, operatorAuth, provision, testHub } from "./http-support";

async function channelWithMembers() {
  const hub = testHub();
  const human = await operatorAuth(hub);
  const lead = await provision(hub, "lead");
  await provision(hub, "outsider");
  await hub.post("/api/channels", { name: "backend" }, auth(lead));
  await hub.post("/api/channels/backend/join", {}, auth(lead));
  return { hub, human, lead };
}

describe("agent keep-awake routes", () => {
  test("a human sets, reads, and removes an agent policy", async () => {
    const hub = testHub();
    const human = await operatorAuth(hub);
    await provision(hub, "bob");

    const off = await hub.get("/api/keep-awake/agents/bob", human);
    expect(await off.json()).toEqual({ setting: { kind: "off" } });

    const set = await hub.put("/api/keep-awake/agents/bob", { idleMinutes: 15 }, human);
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      setting: {
        kind: "on",
        policy: {
          target: { kind: "agent", handle: "bob" },
          limits: { idleMinutes: 15, blockedMinutes: 30, maxWakes: 3 },
          state: { kind: "watching", wakesUsed: 0, lastWake: { kind: "not-woken" } },
        },
      },
    });

    const listed = await hub.get("/api/keep-awake", human);
    expect(await listed.json()).toMatchObject({ policies: [{ target: { handle: "bob" } }] });

    const removed = await hub.delete("/api/keep-awake/agents/bob", human);
    expect(await removed.json()).toEqual({ setting: { kind: "off" } });
  });

  test("an agent cannot set keep-awake", async () => {
    const hub = testHub();
    const bob = await provision(hub, "bob");
    const refused = await hub.put("/api/keep-awake/agents/bob", {}, auth(bob));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "OperatorOnly" });
  });

  test("refuses a limit out of bounds and an unknown agent", async () => {
    const hub = testHub();
    const human = await operatorAuth(hub);
    await provision(hub, "bob");

    const bounded = await hub.put("/api/keep-awake/agents/bob", { maxWakes: 99 }, human);
    expect(bounded.status).toBe(400);
    expect(await bounded.json()).toMatchObject({ code: "ValidationFailed" });

    const missing = await hub.put("/api/keep-awake/agents/nobody", {}, human);
    expect(missing.status).toBe(404);
  });
});

describe("channel keep-awake routes", () => {
  test("a human sets a channel policy with a member coordinator", async () => {
    const { hub, human } = await channelWithMembers();
    const set = await hub.put("/api/keep-awake/channels/backend", { coordinator: "lead" }, human);
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      setting: { kind: "on", policy: { target: { kind: "channel", channel: "backend", coordinator: "lead" } } },
    });
  });

  test("refuses a coordinator who is not a channel member", async () => {
    const { hub, human } = await channelWithMembers();
    const refused = await hub.put("/api/keep-awake/channels/backend", { coordinator: "outsider" }, human);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "NotAMember" });
  });

  test("refuses a direct conversation", async () => {
    const { hub, human, lead } = await channelWithMembers();
    const sent = await hub.post("/api/direct", { to: ["outsider"], body: "hi" }, auth(lead));
    // SAFETY: a 201 from POST /api/direct carries the documented direct-send result.
    const direct = (await sent.json()) as { channel: string };
    const refused = await hub.put(`/api/keep-awake/channels/${direct.channel}`, { coordinator: "lead" }, human);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "ValidationFailed" });
  });
});

describe("alert-human route", () => {
  test("refuses a human caller", async () => {
    const hub = testHub();
    const human = await operatorAuth(hub);
    const refused = await hub.post("/api/alert-human", { text: "hello" }, human);
    expect(refused.status).toBe(400);
  });

  test("delivers an agent's alert as a direct message", async () => {
    const hub = testHub();
    await operatorAuth(hub);
    const bob = await provision(hub, "bob");
    const sent = await hub.post("/api/alert-human", { text: "Need a decision" }, auth(bob));
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ pausedPolicies: 0 });
  });
});
