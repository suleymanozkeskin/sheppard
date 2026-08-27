import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { FakeHerdr, herdrCallFailed, noAgentAtTarget } from "../src/herdr";
import type { AgentStatus } from "../src/herdr";
import {
  DELIVERY_CONFIRMATION_WINDOW_MS,
  Notifier,
  STALE_ROUTE_ESCALATION_PROMPT,
  formatPing,
} from "../src/notifier";
import type { NotifierOptions } from "../src/notifier";
import type { Store } from "../src/store";
import { expectOk, freshStore } from "./support";

/**
 * Two agents in one channel, with bob routed to a pane and therefore the
 * receiver under test. Alice is the sender and holds no route.
 */
function twoAgents(
  status: AgentStatus = "idle",
  notifierOptions: Pick<NotifierOptions, "now" | "workingPingCooldownMs"> = {},
) {
  const { store } = freshStore();
  const alice = expectOk(store.createAgent("alice")).participant.id;
  const bob = expectOk(store.createAgent("bob")).participant.id;
  expectOk(store.createChannel("backend", null));
  expectOk(store.join(alice, "backend"));
  expectOk(store.join(bob, "backend"));
  store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });

  const herdr = new FakeHerdr().withPane({
    terminalId: "term_bob",
    paneId: "w1:p1",
    agentStatus: status,
  });
  const notifier = new Notifier({ store, herdr, ...notifierOptions });
  return { store, herdr, notifier, alice, bob };
}

function send(store: Store, from: number, channel: string, body: string): void {
  expectOk(store.send(from, channel, body));
}

describe("quiet ticks", () => {
  test("never calls herdr when nothing is pending", async () => {
    const { herdr, notifier } = twoAgents();
    const outcome = await notifier.tick();

    expect(outcome.calledHerdr).toBe(false);
    expect(herdr.listCalls).toBe(0);
    expect(herdr.prompts).toEqual([]);
  });

  test("ignores an agent's own messages", async () => {
    const { store, herdr, notifier, bob } = twoAgents();
    send(store, bob, "backend", "talking to myself");

    await notifier.tick();
    expect(herdr.listCalls).toBe(0);
  });

  test("lists panes once however many receivers are pending", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    const carol = expectOk(store.createAgent("carol")).participant.id;
    expectOk(store.join(carol, "backend"));
    store.bindRoute(carol, { terminalId: "term_carol", paneId: "w1:p2", occupantAgent: "claude" });
    herdr.withPane({ terminalId: "term_carol", paneId: "w1:p2" });

    send(store, alice, "backend", "for both of you");

    await notifier.tick();
    expect(herdr.listCalls).toBe(1);
    expect(herdr.prompts.length).toBe(2);
  });
});

describe("delivery", () => {
  test("an immediate pass is scoped to one channel", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));
    expectOk(store.join(bob, "general"));
    send(store, alice, "backend", "backend message");
    send(store, alice, "general", "general message");

    const outcome = await notifier.notifyChannel("backend");

    expect(outcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.text).toContain("#backend");
    expect(herdr.prompts[0]?.text).not.toContain("#general");
    expect(store.pendingNotifications().map((row) => row.channel)).toEqual(["general"]);
  });

  test("pings an idle agent and records the batch as notified", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    send(store, alice, "backend", "one");
    send(store, alice, "backend", "two");

    const outcome = await notifier.tick();
    expect(outcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([
      {
        paneId: "w1:p1",
        text: "[msgr] 2 new messages from alice in #backend. Run: msgr read backend, then resume your interrupted task unless the messages explicitly reassign you.",
      },
    ]);

    // The batch is recorded, so a second tick with no new messages is silent.
    const second = await notifier.tick();
    expect(second.calledHerdr).toBe(false);
    expect(herdr.prompts.length).toBe(1);
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("pings a done agent as well as an idle one", async () => {
    const { store, herdr, notifier, alice } = twoAgents("done");
    send(store, alice, "backend", "one");

    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
  });

  test("pings a working agent", async () => {
    const { store, herdr, notifier, alice } = twoAgents("working");
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();

    expect(outcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts.length).toBe(1);
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("only new messages count once a batch has been pinged", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");
    await notifier.tick();
    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
    await notifier.tick();

    send(store, alice, "backend", "two");
    await notifier.tick();

    expect(herdr.prompts.map((p) => p.text)).toEqual([
      "[msgr] 1 new message from alice in #backend. Run: msgr read backend, then resume your interrupted task unless the messages explicitly reassign you.",
      "[msgr] 1 new message from alice in #backend. Run: msgr read backend, then resume your interrupted task unless the messages explicitly reassign you.",
    ]);
  });

  test("a ping carries no message content", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    send(store, alice, "backend", "the database password is hunter2");

    await notifier.tick();
    expect(herdr.prompts[0]?.text).not.toContain("hunter2");
    expect(herdr.prompts[0]?.text).not.toContain("password");
  });

  test("collapses several channels into one line", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));
    expectOk(store.join(bob, "general"));

    send(store, alice, "backend", "b1");
    send(store, alice, "backend", "b2");
    send(store, alice, "general", "g1");

    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
    expect(herdr.prompts[0]?.text).toBe(
      "[msgr] 3 new messages — #backend: 2 from alice; #general: 1 from alice. Run: msgr read --all, then resume your interrupted task unless the messages explicitly reassign you.",
    );
  });

  test("rolls back an unconfirmed ping and retries after route healing", async () => {
    let now = 0;
    const { store, herdr, notifier, alice, bob } = twoAgents("idle", { now: () => now });
    send(store, alice, "backend", "one");

    await notifier.tick();
    expect(herdr.prompts).toHaveLength(1);
    expect(store.pendingNotifications()).toEqual([]);

    now = DELIVERY_CONFIRMATION_WINDOW_MS - 1;
    await notifier.tick();
    expect(store.findByHandle("bob")?.routeState).toBe("active");
    expect(herdr.prompts).toHaveLength(1);

    now = DELIVERY_CONFIRMATION_WINDOW_MS;
    await notifier.tick();
    expect(store.findByHandle("bob")?.routeState).toBe("stale");

    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
    await notifier.tick();
    expect(herdr.prompts).toHaveLength(2);
  });

  test("drops a late reader's duplicate after it acknowledges the backlog", async () => {
    let now = 0;
    const { store, herdr, notifier, alice, bob } = twoAgents("idle", { now: () => now });
    send(store, alice, "backend", "one");

    await notifier.tick();
    now = 10_000;
    await notifier.tick();
    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
    expectOk(store.ack(bob, "backend", 1));

    await notifier.tick();
    expect(herdr.prompts).toHaveLength(1);
  });

  test("any authenticated request confirms the ping within the window", async () => {
    let now = 0;
    const { store, herdr, notifier, alice, bob } = twoAgents("idle", { now: () => now });
    send(store, alice, "backend", "one");

    await notifier.tick();
    store.markSeen(bob);
    await notifier.tick();

    send(store, alice, "backend", "two");
    await notifier.tick();
    expect(herdr.prompts).toHaveLength(2);
  });
});

describe("holds", () => {
  const holdingStatuses: AgentStatus[] = ["blocked", "unknown"];

  test("holds while the agent is blocked or unrecognised", async () => {
    for (const status of holdingStatuses) {
      const { store, herdr, notifier, alice } = twoAgents(status);
      send(store, alice, "backend", "one");

      const outcome = await notifier.tick();
      expect(`${status}: ${herdr.prompts.length}`).toBe(`${status}: 0`);
      expect(outcome.held[0]?.reason).toBe("status");
      // Holding must not consume the batch.
      expect(store.pendingNotifications().length).toBe(1);
    }
  });

  test("focused panes receive immediately by default", async () => {
    const previous = Bun.env.MSGR_FOCUSED_HOLD;
    delete Bun.env.MSGR_FOCUSED_HOLD;
    try {
      const { store, herdr, notifier, alice } = twoAgents("working");
      herdr.panes = [
        {
          terminalId: "term_bob",
          paneId: "w1:p1",
          agent: "claude",
          agentStatus: "working",
          focused: true,
        },
      ];
      send(store, alice, "backend", "one");

      const outcome = await notifier.tick();
      expect(herdr.prompts).toHaveLength(1);
      expect(outcome.delivered).toEqual(["bob"]);
      expect(outcome.held).toEqual([]);
    } finally {
      if (previous === undefined) delete Bun.env.MSGR_FOCUSED_HOLD;
      else Bun.env.MSGR_FOCUSED_HOLD = previous;
    }
  });

  test("focused panes hold when the environment enables the gate", async () => {
    const previous = Bun.env.MSGR_FOCUSED_HOLD;
    Bun.env.MSGR_FOCUSED_HOLD = "1";
    try {
      const { store, herdr, notifier, alice } = twoAgents("working");
      herdr.panes = [
        {
          terminalId: "term_bob",
          paneId: "w1:p1",
          agent: "claude",
          agentStatus: "working",
          focused: true,
        },
      ];
      send(store, alice, "backend", "one");

      const outcome = await notifier.tick();
      expect(herdr.prompts).toEqual([]);
      expect(outcome.held[0]?.reason).toBe("focused");
      expect(store.pendingNotifications()).toHaveLength(1);
    } finally {
      if (previous === undefined) delete Bun.env.MSGR_FOCUSED_HOLD;
      else Bun.env.MSGR_FOCUSED_HOLD = previous;
    }
  });

  test("working delivery has no default cooldown", async () => {
    const previous = Bun.env.MSGR_WORKING_PING_COOLDOWN;
    delete Bun.env.MSGR_WORKING_PING_COOLDOWN;
    try {
      const now = 1_000;
      const { store, herdr, notifier, alice, bob } = twoAgents("working", { now: () => now });
      send(store, alice, "backend", "one");
      await notifier.tick();
      store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
      await notifier.tick();

      send(store, alice, "backend", "two");
      const outcome = await notifier.tick();

      expect(outcome.delivered).toEqual(["bob"]);
      expect(herdr.prompts).toHaveLength(2);
      expect(store.pendingNotifications()).toEqual([]);
    } finally {
      if (previous === undefined) delete Bun.env.MSGR_WORKING_PING_COOLDOWN;
      else Bun.env.MSGR_WORKING_PING_COOLDOWN = previous;
    }
  });

  test("working delivery waits for the cooldown boundary", async () => {
    let now = 1_000;
    const { store, herdr, notifier, alice, bob } = twoAgents("working", {
      now: () => now,
      workingPingCooldownMs: 60_000,
    });
    send(store, alice, "backend", "one");
    await notifier.tick();
    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
    await notifier.tick();

    send(store, alice, "backend", "two");
    now += 59_999;
    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);

    const beforeBoundary = await notifier.tick();
    expect(beforeBoundary.held[0]?.reason).toBe("working-cooldown");
    expect(store.pendingNotifications().length).toBe(1);

    now += 1;
    const atBoundary = await notifier.tick();

    expect(atBoundary.delivered).toEqual(["bob"]);
    expect(herdr.prompts.length).toBe(2);
    expect(herdr.prompts[1]?.text).toContain("1 new message");
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("holding leaves the route active so the poll path still reports it", async () => {
    const { store, notifier, alice } = twoAgents("blocked");
    send(store, alice, "backend", "one");
    await notifier.tick();

    expect(store.findByHandle("bob")?.routeState).toBe("active");
    expect(store.inbox(store.findByHandle("bob")!.id)[0]?.unread).toBe(1);
  });
});

describe("the read that lands mid-tick", () => {
  test("cancels a ping whose messages were read after the snapshot", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");

    // The agent reads on its own between the snapshot and the injection.
    herdr.afterList = () => {
      expectOk(store.ack(bob, "backend", 1));
    };

    const outcome = await notifier.tick();
    expect(herdr.prompts).toEqual([]);
    expect(outcome.held[0]?.reason).toBe("already-read");
  });

  test("still pings when only part of the backlog was read", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));
    expectOk(store.join(bob, "general"));
    send(store, alice, "backend", "b1");
    send(store, alice, "general", "g1");

    herdr.afterList = () => {
      expectOk(store.ack(bob, "backend", 1));
    };

    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
    expect(herdr.prompts[0]?.text).toBe(
      "[msgr] 1 new message from alice in #general. Run: msgr read general, then resume your interrupted task unless the messages explicitly reassign you.",
    );
  });
});

describe("definitive failures", () => {
  test("marks the route stale when the pane is gone", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    herdr.panes = [];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.staled).toEqual(["bob"]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
    // A stale route drops out of the pending set, so no herdr call repeats.
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("marks the route stale when another kind of agent took the pane", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    herdr.panes = [{ terminalId: "term_bob", paneId: "w1:p1", agent: "codex", agentStatus: "idle", focused: false }];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.staled).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
  });

  test("marks the route stale when the recorded pane is gone", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    // The terminal itself is absent. A pane that merely renumbered is a heal,
    // not a loss, so the gone case must retire the terminal id to test itself.
    herdr.panes = [{
      terminalId: "term_other",
      paneId: "w1:p2",
      agent: "claude",
      agentStatus: "idle",
      focused: false,
    }];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.staled).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
  });

  test("marks a route with no recorded occupant stale", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: null });
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.staled).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
  });

  test("marks the route stale when herdr reports no agent at the target", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    herdr.promptFailure = (paneId) => noAgentAtTarget(paneId);
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.staled).toEqual(["bob"]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
  });

  test("never advances the batch on a definitive failure", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    herdr.promptFailure = (paneId) => noAgentAtTarget(paneId);
    send(store, alice, "backend", "one");
    await notifier.tick();

    // The unread is still unread; only push stopped.
    expect(expectOk(store.fetch(bob, "backend")).messages.length).toBe(1);
  });

  test("an ordinary command from the pane revives a stale route", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    herdr.panes = [];
    send(store, alice, "backend", "one");
    await notifier.tick();
    expect(store.findByHandle("bob")?.routeState).toBe("stale");

    // The CLI re-resolves and rebinds on its next authenticated call.
    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p7", occupantAgent: "claude" });
    herdr.withPane({ terminalId: "term_bob", paneId: "w1:p7" });

    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
    expect(herdr.prompts[0]?.paneId).toBe("w1:p7");
  });
});

describe("stale route escalation", () => {
  test("prompts an idle stale route once after two held ticks", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");
    store.markRouteStale(bob);

    const first = await notifier.tick();
    expect(first.escalated).toEqual([]);
    expect(first.held).toEqual([{ handle: "bob", reason: "stale-route" }]);

    const second = await notifier.tick();
    expect(second.escalated).toEqual(["bob"]);
    expect(herdr.prompts).toEqual([
      { paneId: "w1:p1", text: STALE_ROUTE_ESCALATION_PROMPT },
    ]);

    const third = await notifier.tick();
    expect(third.escalated).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);
  });

  test("clears the once-per-outage record when the route heals", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");
    store.markRouteStale(bob);

    await notifier.tick();
    await notifier.tick();
    expect(herdr.prompts).toHaveLength(1);

    store.bindRoute(bob, { terminalId: "term_bob", paneId: "w1:p1", occupantAgent: "claude" });
    expectOk(store.ack(bob, "backend", 1));
    await notifier.tick();

    send(store, alice, "backend", "two");
    store.markRouteStale(bob);
    await notifier.tick();
    await notifier.tick();

    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]).toEqual({
      paneId: "w1:p1",
      text: STALE_ROUTE_ESCALATION_PROMPT,
    });
  });

  test("starts a fresh idle count after stale backlog is read", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");
    store.markRouteStale(bob);

    await notifier.tick();
    expectOk(store.ack(bob, "backend", 1));
    await notifier.tick();

    send(store, alice, "backend", "two");
    await notifier.tick();
    expect(herdr.prompts).toHaveLength(0);
    await notifier.tick();
    expect(herdr.prompts).toHaveLength(1);
  });

  test("does not escalate while the bound pane is working or blocked", async () => {
    for (const status of ["working", "blocked"] as const) {
      const { store, herdr, notifier, alice, bob } = twoAgents(status);
      send(store, alice, "backend", "one");
      store.markRouteStale(bob);

      await notifier.tick();
      const second = await notifier.tick();

      expect(`${status}: ${herdr.prompts.length}`).toBe(`${status}: 0`);
      expect(second.escalated).toEqual([]);
      expect(store.stalePendingNotifications()).toHaveLength(1);
    }
  });
});

describe("transient failures", () => {
  test("an unreachable herdr changes nothing and retries", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    herdr.listFailure = herdrCallFailed("no herdr server is running");
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.calledHerdr).toBe(true);
    expect(outcome.staled).toEqual([]);
    expect(store.findByHandle("bob")?.routeState).toBe("active");

    herdr.listFailure = null;
    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
  });

  test("a failed injection leaves the route active and the batch intact", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    herdr.promptFailure = () => herdrCallFailed("timed out after 10000ms");
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();
    expect(outcome.held[0]?.reason).toBe("delivery-failed");
    expect(store.findByHandle("bob")?.routeState).toBe("active");
    expect(store.pendingNotifications().length).toBe(1);

    herdr.promptFailure = () => null;
    await notifier.tick();
    expect(herdr.prompts.length).toBe(1);
  });

  test("one receiver's failure does not stop another's delivery", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    const carol = expectOk(store.createAgent("carol")).participant.id;
    expectOk(store.join(carol, "backend"));
    store.bindRoute(carol, { terminalId: "term_carol", paneId: "w1:p2", occupantAgent: "claude" });
    herdr.withPane({ terminalId: "term_carol", paneId: "w1:p2" });
    herdr.promptFailure = (paneId) => (paneId === "w1:p1" ? herdrCallFailed("socket error") : null);

    send(store, alice, "backend", "for both");

    const outcome = await notifier.tick();
    expect(outcome.delivered).toEqual(["carol"]);
    expect(herdr.prompts.map((p) => p.paneId)).toEqual(["w1:p2"]);
  });
});

describe("overlapping ticks", () => {
  test("a channel pass and a tick do not overlap", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    send(store, alice, "backend", "one");

    let releaseFirst = (): void => undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      herdr.beforePrompt = () => {
        resolve();
      };
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPrompt = herdr.agentPrompt.bind(herdr);
    herdr.agentPrompt = async (paneId, text) => {
      herdr.beforePrompt(paneId);
      await gate;
      return originalPrompt(paneId, text);
    };

    const first = notifier.notifyChannel("backend");
    await firstPromptStarted;

    const second = await notifier.tick();
    expect(second.ran).toBe(false);

    releaseFirst();
    const firstOutcome = await first;
    expect(firstOutcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts).toHaveLength(1);
  });

  test("queues a channel send that arrives during an in-flight pass", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    expectOk(store.createChannel("general", null));
    expectOk(store.join(alice, "general"));
    expectOk(store.join(bob, "general"));
    send(store, alice, "backend", "backend message");
    send(store, alice, "general", "general message");

    let releaseFirst = (): void => undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      let confirmed = false;
      herdr.beforePrompt = () => {
        resolve();
        if (confirmed) return;
        confirmed = true;
        store.bindRoute(bob, {
          terminalId: "term_bob",
          paneId: "w1:p1",
          occupantAgent: "claude",
        });
      };
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPrompt = herdr.agentPrompt.bind(herdr);
    herdr.agentPrompt = async (paneId, text) => {
      herdr.beforePrompt(paneId);
      await gate;
      return originalPrompt(paneId, text);
    };

    const first = notifier.notifyChannel("backend");
    await firstPromptStarted;
    const queued = await notifier.notifyChannel("general");
    expect(queued.ran).toBe(false);

    releaseFirst();
    await first;
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]?.text).toContain("#general");
    expect(store.pendingNotifications()).toEqual([]);
  });

  test("a second tick is skipped while the first is still running", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    send(store, alice, "backend", "one");

    let releaseFirst = (): void => undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      herdr.beforePrompt = () => {
        resolve();
      };
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPrompt = herdr.agentPrompt.bind(herdr);
    herdr.agentPrompt = async (paneId, text) => {
      herdr.beforePrompt(paneId);
      await gate;
      return originalPrompt(paneId, text);
    };

    const first = notifier.tick();
    await firstPromptStarted;

    const second = await notifier.tick();
    expect(second.ran).toBe(false);

    releaseFirst();
    const firstOutcome = await first;
    expect(firstOutcome.delivered).toEqual(["bob"]);
    expect(herdr.prompts.length).toBe(1);
  });

  test("the guard clears even when a tick throws", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    send(store, alice, "backend", "one");
    herdr.agentPrompt = () => {
      throw new Error("herdr exploded");
    };

    await expect(notifier.tick()).rejects.toThrow("herdr exploded");

    herdr.agentPrompt = (paneId, text) => {
      herdr.prompts.push({ paneId, text });
      return Promise.resolve(Result.ok());
    };
    const recovered = await notifier.tick();
    expect(recovered.ran).toBe(true);
    expect(herdr.prompts.length).toBe(1);
  });
});

describe("ping wording", () => {
  test("uses the singular for one message", () => {
    const line = formatPing([
      {
        participantId: 1,
        handle: "bob",
        terminalId: "t",
        paneId: "p",
        occupantAgent: "claude",
        channelId: 1,
        channel: "backend",
        throughId: 1,
        count: 1,
        senders: ["alice"],
      },
    ]);
    expect(line).toBe(
      "[msgr] 1 new message from alice in #backend. Run: msgr read backend, then resume your interrupted task unless the messages explicitly reassign you.",
    );
  });

  test("names every distinct sender", () => {
    const line = formatPing([
      {
        participantId: 1,
        handle: "bob",
        terminalId: "t",
        paneId: "p",
        occupantAgent: "claude",
        channelId: 1,
        channel: "backend",
        throughId: 4,
        count: 4,
        senders: ["codex1", "opus21"],
      },
    ]);
    expect(line).toBe(
      "[msgr] 4 new messages from codex1, opus21 in #backend. Run: msgr read backend, then resume your interrupted task unless the messages explicitly reassign you.",
    );
  });
});

/**
 * herdr pane ids are compact public ids: closing one pane renumbers the rest.
 * The route stores the durable terminal id for exactly that reason, so a
 * renumbered pane is a route to follow rather than a route to abandon. These
 * hold both directions — the heal, and the losses that must still be losses.
 */
describe("route healing", () => {
  test("follows a renumbered pane and writes the new pane id back", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    expect(store.findByHandle("bob")?.paneId).toBe("w1:p1");
    expect(store.findByHandle("bob")?.routeState).toBe("active");
    const seenBeforeHeal = store.findById(bob)?.lastSeenAt ?? null;

    // A sibling pane closed, so herdr renumbered this one. Same terminal.
    herdr.panes = [{
      terminalId: "term_bob",
      paneId: "w1:p1-renumbered",
      agent: "claude",
      agentStatus: "idle",
      focused: false,
    }];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();

    expect(outcome.staled).toEqual([]);
    expect(outcome.delivered).toEqual(["bob"]);
    expect(store.findByHandle("bob")?.routeState).toBe("active");
    expect(store.findByHandle("bob")?.paneId).toBe("w1:p1-renumbered");
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.paneId).toBe("w1:p1-renumbered");
    // Following a pane is not the participant making a request, so the signal
    // that confirms delivery must not move.
    expect(store.findById(bob)?.lastSeenAt).toBe(seenBeforeHeal);
  });

  test("marks the route stale when no pane carries the terminal", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    expect(store.findByHandle("bob")?.routeState).toBe("active");

    herdr.panes = [{
      terminalId: "term_someone_else",
      paneId: "w1:p1",
      agent: "claude",
      agentStatus: "idle",
      focused: false,
    }];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();

    expect(outcome.staled).toEqual(["bob"]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
    expect(herdr.prompts).toEqual([]);
  });

  test("marks the route stale when a renumbered pane changed occupant", async () => {
    const { store, herdr, notifier, alice } = twoAgents();
    expect(store.findByHandle("bob")?.routeState).toBe("active");

    herdr.panes = [{
      terminalId: "term_bob",
      paneId: "w1:p1-renumbered",
      agent: "codex",
      agentStatus: "idle",
      focused: false,
    }];
    send(store, alice, "backend", "one");

    const outcome = await notifier.tick();

    expect(outcome.staled).toEqual(["bob"]);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");
    expect(herdr.prompts).toEqual([]);
  });

  test("bounds escalation prompts while a route stays stale", async () => {
    const { store, herdr, notifier, alice, bob } = twoAgents();
    send(store, alice, "backend", "one");
    store.markRouteStale(bob);
    expect(store.findByHandle("bob")?.routeState).toBe("stale");

    // The pane renumbers while stale: the healing prompt must reach the new id.
    herdr.panes = [{
      terminalId: "term_bob",
      paneId: "w1:p1-renumbered",
      agent: "claude",
      agentStatus: "idle",
      focused: false,
    }];

    for (let tick = 0; tick < 6; tick += 1) await notifier.tick();

    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]?.paneId).toBe("w1:p1-renumbered");
    expect(herdr.prompts[0]?.text).toBe(STALE_ROUTE_ESCALATION_PROMPT);
    expect(store.findByHandle("bob")?.paneId).toBe("w1:p1-renumbered");
  });
});
