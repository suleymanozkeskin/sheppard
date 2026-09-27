import { describe, expect, test } from "bun:test";
import { FakeHerdr } from "../src/herdr";
import type { AgentStatus } from "../src/herdr";
import {
  KeepAwakeWatcher,
  coordinatorWakeText,
  decideAgent,
  decideChannel,
  dialogWakeText,
  idleWakeText,
} from "../src/keep-awake";
import type { Store } from "../src/store";
import type { KeepAwakeLimits, KeepAwakePolicy, KeepAwakeState } from "../src/types";
import { validKeepAwakeLimits } from "../src/validate";
import { expectErr, expectOk, freshStore } from "./support";

const START_MS = Date.parse("2026-08-17T00:00:00.000Z");
const MINUTE = 60_000;

const QUESTION_SCREEN = `Do you prefer tabs or spaces?
❯ 1. Tabs
  2. Spaces
  3. Type something.
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

function limits(idle = 20, blocked = 30, maxWakes = 3): KeepAwakeLimits {
  return expectOk(validKeepAwakeLimits({ idleMinutes: idle, blockedMinutes: blocked, maxWakes }));
}

function policyFor(state: KeepAwakeState, maxWakes = 3): KeepAwakePolicy {
  return {
    id: 1,
    target: { kind: "agent", participantId: 1, handle: "bob" },
    limits: limits(20, 30, maxWakes),
    state,
    humanMarkId: 0,
  };
}

function watching(wakesUsed = 0): Extract<KeepAwakeState, { kind: "watching" }> {
  return {
    kind: "watching",
    wakesUsed,
    lastWake: { kind: "not-woken" },
    since: "2026-08-17T00:00:00.000Z",
  };
}

describe("decideAgent", () => {
  const state = watching();
  const policy = policyFor(state);
  const at = (minutes: number) => START_MS + minutes * MINUTE;

  test("holds a working agent", () => {
    expect(decideAgent(policy, state, { status: "working", sinceMs: START_MS }, at(90))).toEqual({
      kind: "hold",
      reason: "working",
    });
  });

  test("holds an unknown status", () => {
    expect(decideAgent(policy, state, { status: "unknown", sinceMs: START_MS }, at(90))).toEqual({
      kind: "hold",
      reason: "status-unknown",
    });
  });

  test("waits until the idle limit", () => {
    expect(decideAgent(policy, state, { status: "idle", sinceMs: START_MS }, at(19))).toEqual({
      kind: "hold",
      reason: "waiting",
    });
    expect(decideAgent(policy, state, { status: "done", sinceMs: START_MS }, at(20))).toEqual({
      kind: "wake",
    });
  });

  test("closes a dialog only after the blocked limit", () => {
    expect(decideAgent(policy, state, { status: "blocked", sinceMs: START_MS }, at(29))).toEqual({
      kind: "hold",
      reason: "waiting",
    });
    expect(decideAgent(policy, state, { status: "blocked", sinceMs: START_MS }, at(30))).toEqual({
      kind: "close-dialog",
    });
  });

  test("measures from the last wake, not only from the status change", () => {
    const woken: KeepAwakeState = {
      ...state,
      wakesUsed: 1,
      lastWake: { kind: "woken", at: new Date(at(25)).toISOString() },
    };
    const afterWake = policyFor(woken);
    expect(
      decideAgent(afterWake, { ...state, ...woken }, { status: "idle", sinceMs: START_MS }, at(40)),
    ).toEqual({ kind: "hold", reason: "waiting" });
  });

  test("reports an exhausted budget instead of waking", () => {
    const spent = watching(3);
    expect(decideAgent(policyFor(spent), spent, { status: "idle", sinceMs: START_MS }, at(90))).toEqual({
      kind: "exhausted",
    });
  });
});

describe("decideChannel", () => {
  const state = watching();
  const policy = policyFor(state);
  const idle: AgentStatus = "idle";
  const working: AgentStatus = "working";
  const blocked: AgentStatus = "blocked";
  const idleSince = { status: idle, sinceMs: START_MS };

  test("holds a channel without routed agents", () => {
    expect(decideChannel(policy, state, [], { kind: "none" }, START_MS + 90 * MINUTE)).toEqual({
      kind: "hold",
      reason: "no-routed-members",
    });
  });

  test("holds while any member works", () => {
    const members = [idleSince, { status: working, sinceMs: START_MS }];
    expect(decideChannel(policy, state, members, { kind: "none" }, START_MS + 90 * MINUTE)).toEqual({
      kind: "hold",
      reason: "working",
    });
  });

  test("a recent message keeps the channel awake", () => {
    const recent = { kind: "at" as const, at: new Date(START_MS + 80 * MINUTE).toISOString() };
    expect(decideChannel(policy, state, [idleSince], recent, START_MS + 90 * MINUTE)).toEqual({
      kind: "hold",
      reason: "waiting",
    });
  });

  test("wakes when every member is idle or blocked and the channel is quiet", () => {
    const members = [idleSince, { status: blocked, sinceMs: START_MS }];
    expect(decideChannel(policy, state, members, { kind: "none" }, START_MS + 20 * MINUTE)).toEqual({
      kind: "wake",
    });
  });
});

interface Harness {
  store: Store;
  herdr: FakeHerdr;
  watcher: KeepAwakeWatcher;
  bob: number;
  advance: (minutes: number) => void;
}

/** Bob is a routed agent in #backend; alice is the human. */
function harness(status: AgentStatus = "idle"): Harness {
  const { store } = freshStore();
  const human = expectOk(store.createHuman("alice")).participant.id;
  const bob = expectOk(store.createAgent("bob")).participant.id;
  expectOk(store.createChannel("backend", null));
  expectOk(store.join(human, "backend"));
  expectOk(store.join(bob, "backend"));
  store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
  store.markSeen(human);

  const herdr = new FakeHerdr().withPane({ terminalId: "term_bob", paneId: "w1:p1", agentStatus: status });
  let nowMs = START_MS;
  const watcher = new KeepAwakeWatcher({
    store,
    herdr,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  return { store, herdr, watcher, bob, advance: (minutes) => { nowMs += minutes * MINUTE; } };
}

function setPaneStatus(herdr: FakeHerdr, status: AgentStatus): void {
  const pane = herdr.panes[0];
  if (pane === undefined) throw new Error("fixture pane missing");
  pane.agentStatus = status;
}

function agentPolicy(store: Store, participantId: number): KeepAwakePolicy {
  const setting = store.keepAwakeForAgent(participantId);
  if (setting.kind === "off") throw new Error("expected a keep-awake policy");
  return setting.policy;
}

describe("KeepAwakeWatcher with an agent policy", () => {
  test("never calls herdr without a policy", async () => {
    const { herdr, watcher } = harness();
    const outcome = await watcher.tick();
    expect(outcome.calledHerdr).toBe(false);
    expect(herdr.listCalls).toBe(0);
  });

  test("wakes an agent idle past its limit, once per idle period", async () => {
    const { store, herdr, watcher, bob, advance } = harness();
    store.setAgentKeepAwake(bob, limits());
    await watcher.tick();
    advance(21);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([{ kind: "woke", policyId: 1, handle: "bob", wake: "idle" }]);
    expect(herdr.prompts).toEqual([{ paneId: "w1:p1", text: idleWakeText(limits().idleMinutes) }]);

    advance(5);
    await watcher.tick();
    expect(herdr.prompts).toHaveLength(1);
    const state = agentPolicy(store, bob).state;
    expect(state.kind === "watching" && state.wakesUsed).toBe(1);
  });

  test("leaves an agent with unread messages to the notifier", async () => {
    const { store, herdr, watcher, bob, advance } = harness();
    const carol = expectOk(store.createAgent("carol")).participant.id;
    expectOk(store.join(carol, "backend"));
    store.setAgentKeepAwake(bob, limits());
    await watcher.tick();
    advance(21);
    expectOk(store.send(carol, "backend", "ping"));

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([
      { kind: "held", policyId: 1, handle: "bob", reason: "unread-pending" },
    ]);
    expect(herdr.prompts).toEqual([]);
  });

  test("closes a question with Escape and explains it by prompt", async () => {
    const { store, herdr, watcher, bob, advance } = harness("blocked");
    herdr.screens.set("w1:p1", QUESTION_SCREEN);
    herdr.afterKey = () => setPaneStatus(herdr, "done");
    store.setAgentKeepAwake(bob, limits());
    await watcher.tick();
    advance(31);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([
      { kind: "closed-dialog", policyId: 1, handle: "bob", dialog: "question" },
    ]);
    expect(herdr.keys).toEqual([{ paneId: "w1:p1", key: "esc" }]);
    expect(herdr.prompts).toEqual([
      { paneId: "w1:p1", text: dialogWakeText("question", limits().blockedMinutes) },
    ]);
  });

  test("never presses a key on an unrecognized dialog", async () => {
    const { store, herdr, watcher, bob, advance } = harness("blocked");
    herdr.screens.set("w1:p1", "Yes, I trust this folder\nEnter to confirm · Esc to cancel");
    store.setAgentKeepAwake(bob, limits());
    await watcher.tick();
    advance(31);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([
      {
        kind: "needs-human",
        policyId: 1,
        cause: { kind: "dialog-unrecognized", handle: "bob", reason: "folder-trust" },
      },
    ]);
    expect(herdr.keys).toEqual([]);
    expect(agentPolicy(store, bob).state.kind).toBe("needs-human");
  });

  test("stops when the dialog stays after Escape", async () => {
    const { store, herdr, watcher, bob, advance } = harness("blocked");
    herdr.screens.set("w1:p1", QUESTION_SCREEN);
    store.setAgentKeepAwake(bob, limits());
    await watcher.tick();
    advance(31);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([
      { kind: "needs-human", policyId: 1, cause: { kind: "dialog-stuck", handle: "bob" } },
    ]);
    expect(herdr.keys).toHaveLength(1);
    expect(herdr.prompts).toEqual([]);
  });

  test("stops at the wake budget and asks for the human", async () => {
    const { store, herdr, watcher, bob, advance } = harness();
    store.setAgentKeepAwake(bob, limits(20, 30, 1));
    await watcher.tick();
    advance(21);
    await watcher.tick();
    advance(21);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([
      { kind: "needs-human", policyId: 1, cause: { kind: "wakes-exhausted" } },
    ]);
    expect(herdr.prompts).toHaveLength(1);
  });

  test("a human message resumes a stopped policy with a fresh budget", async () => {
    const { store, watcher, bob } = harness();
    const policy = store.setAgentKeepAwake(bob, limits());
    store.markKeepAwakeNeedsHuman(policy.id, { kind: "wakes-exhausted" }, "2026-08-17T00:10:00.000Z");
    const alice = store.findByHandle("alice");
    if (alice === null) throw new Error("fixture human missing");
    expectOk(store.send(alice.id, "backend", "keep going"));

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([{ kind: "resumed", policyId: policy.id }]);
    const state = agentPolicy(store, bob).state;
    expect(state.kind === "watching" && state.wakesUsed).toBe(0);
  });
});

describe("KeepAwakeWatcher with a channel policy", () => {
  function channelHarness() {
    const base = harness();
    const lead = expectOk(base.store.createAgent("lead")).participant.id;
    expectOk(base.store.join(lead, "backend"));
    base.store.bindRoute(lead, { terminalId: "term_lead", paneId: "w1:p2", occupantAgent: "claude" });
    base.herdr.withPane({ terminalId: "term_lead", paneId: "w1:p2", agentStatus: "idle" });
    const channel = base.store.findChannel("backend");
    if (channel === null) throw new Error("fixture channel missing");
    base.store.setChannelKeepAwake(channel.id, lead, limits());
    return { ...base, lead };
  }

  test("wakes the coordinator when the whole channel is quiet", async () => {
    const { herdr, watcher, advance } = channelHarness();
    await watcher.tick();
    advance(21);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([{ kind: "woke", policyId: 1, handle: "lead", wake: "coordinator" }]);
    expect(herdr.prompts).toEqual([
      { paneId: "w1:p2", text: coordinatorWakeText("backend", limits().idleMinutes) },
    ]);
  });

  test("holds while any member works", async () => {
    const { herdr, watcher, advance } = channelHarness();
    setPaneStatus(herdr, "working");
    await watcher.tick();
    advance(21);

    const outcome = await watcher.tick();
    expect(outcome.actions).toEqual([{ kind: "held", policyId: 1, handle: null, reason: "working" }]);
    expect(herdr.prompts).toEqual([]);
  });
});

describe("Store keep-awake rows", () => {
  test("replacing a policy starts a fresh watch", () => {
    const { store, bob } = harness();
    const first = store.setAgentKeepAwake(bob, limits());
    store.recordKeepAwakeWake(first.id, "2026-08-17T00:30:00.000Z");
    const second = store.setAgentKeepAwake(bob, limits(5, 10, 2));
    expect(second.limits).toEqual(limits(5, 10, 2));
    expect(second.state.kind === "watching" && second.state.wakesUsed).toBe(0);
  });

  test("an agent alert sends a direct message and pauses its policies", () => {
    const { store, bob } = harness();
    store.setAgentKeepAwake(bob, limits());
    const result = expectOk(store.alertHuman(bob, "Which database should I use?"));
    expect(result.pausedPolicies).toBe(1);
    expect(store.messageById(result.messageId)?.body).toBe("Which database should I use?");
    expect(agentPolicy(store, bob).state).toEqual({
      kind: "needs-human",
      cause: { kind: "agent-requested", handle: "bob" },
      since: "2026-08-17T00:00:00.000Z",
    });
  });

  test("an alert without any human fails", () => {
    const { store } = freshStore();
    const bob = expectOk(store.createAgent("bob")).participant.id;
    expect(expectErr(store.alertHuman(bob, "help"))._tag).toBe("NotFound");
  });
});

describe("validKeepAwakeLimits", () => {
  test("fills defaults and refuses values out of bounds", () => {
    expect(expectOk(validKeepAwakeLimits({}))).toEqual(limits(20, 30, 3));
    expect(expectErr(validKeepAwakeLimits({ idleMinutes: 0 })).field).toBe("idleMinutes");
    expect(expectErr(validKeepAwakeLimits({ maxWakes: 11 })).field).toBe("maxWakes");
    expect(expectErr(validKeepAwakeLimits({ blockedMinutes: 1.5 })).field).toBe("blockedMinutes");
  });
});
