import { afterEach, describe, expect, test } from "bun:test";
import { FakeHerdr } from "../src/herdr";
import { type CliHarness, startCliHub } from "./cli-support";
import { expectOk } from "./support";

const SOCKET_PATH = "/tmp/msgr-recovery-test.sock";
const ROUTE = Object.freeze({
  terminalId: "term_worker", paneId: "w1:p1", occupantAgent: "codex",
});
const open: CliHarness[] = [];

/** Creates an isolated hub and one connected worker. Cleanup runs after each test. */
function fixture() {
  const harness = startCliHub({ herdrSocketPath: SOCKET_PATH });
  open.push(harness);
  const store = harness.hub.store;
  const worker = expectOk(store.createAgent("worker")).participant;
  const sender = expectOk(store.createAgent("sender")).participant;
  const channel = expectOk(store.createChannel("work", null));
  expectOk(store.join(worker.id, "work"));
  store.bindRoute(worker.id, ROUTE);
  const herdr = new FakeHerdr().withPane({ ...ROUTE, agent: ROUTE.occupantAgent });
  const options = Object.freeze({ herdr, herdrSocketPath: SOCKET_PATH });
  return { harness, store, worker, sender, channel, options };
}

afterEach(() => {
  for (const harness of open.splice(0, open.length)) harness.stop();
});

describe("pane identity recovery", () => {
  test("restores the same stale identity and preserves its unread cursor", async () => {
    const { harness, store, worker, sender, channel, options } = fixture();
    const first = expectOk(store.send(sender.id, "work", "already read"));
    expectOk(store.ack(worker.id, "work", first.id));
    const second = expectOk(store.send(sender.id, "work", "still unread"));
    store.markRouteStale(worker.id);

    const outcome = await harness.run(["read", "--all"], options);

    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe("");
    expect(outcome.out).toContain("still unread");
    expect(outcome.out).not.toContain("already read");
    expect(store.findById(worker.id)?.routeState).toBe("active");
    expect(store.inbox(worker.id)[0]?.unread).toBe(0);
    expect(store.listParticipants()).toHaveLength(2);
    expect(store.cursorFor(worker.id, channel.id)).toBe(second.id);
  });

  test("keeps an active replacement and the old unread messages separate", async () => {
    const { harness, store, worker, sender, options } = fixture();
    expectOk(store.send(sender.id, "work", "for the original worker"));
    const replacement = expectOk(store.createAgent("replacement")).participant;
    store.bindRoute(replacement.id, ROUTE);

    const outcome = await harness.run(["read", "--all"], options);

    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain("No channels joined");
    expect(outcome.out).not.toContain("Nothing new anywhere");
    expect(store.findById(worker.id)?.routeState).toBe("stale");
    expect(store.inbox(worker.id)[0]?.unread).toBe(1);
    expect(store.findById(replacement.id)?.routeState).toBe("active");
  });

  test("refuses ambiguous stale identities without changing either one", async () => {
    const { harness, store, worker, options } = fixture();
    const replacement = expectOk(store.createAgent("replacement")).participant;
    store.bindRoute(replacement.id, ROUTE);
    store.markRouteStale(replacement.id);

    const outcome = await harness.run(["inbox"], options);

    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("identity");
    expect(outcome.err).not.toContain("msgr provision");
    expect(outcome.err).not.toContain("msgr spawn");
    expect(store.findById(worker.id)?.routeState).toBe("stale");
    expect(store.findById(replacement.id)?.routeState).toBe("stale");
  });

  test.each([
    { name: "terminal", terminalId: "other_terminal", paneId: ROUTE.paneId, agent: "codex" },
    { name: "pane", terminalId: ROUTE.terminalId, paneId: "w1:p2", agent: "codex" },
    { name: "occupant", terminalId: ROUTE.terminalId, paneId: ROUTE.paneId, agent: "claude" },
  ])("refuses a stale route with a different $name", async (pane) => {
    const { harness, store, worker, options } = fixture();
    store.markRouteStale(worker.id);
    const herdr = new FakeHerdr().withPane(pane);

    const outcome = await harness.run(["inbox"], { ...options, herdr });

    expect(outcome.code).toBe(1);
    expect(outcome.err).not.toContain("msgr provision");
    expect(store.findById(worker.id)?.routeState).toBe("stale");
  });

  test("reports a failed pane lookup without advice to create an identity", async () => {
    const { harness, store, worker, options } = fixture();
    const outcome = await harness.run(["inbox"], { ...options, herdr: new FakeHerdr() });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("pane current");
    expect(outcome.err).not.toContain("msgr provision");
    expect(outcome.err).not.toContain("msgr spawn");
    expect(store.findById(worker.id)?.routeState).toBe("active");
  });

  test("preserves the read-all JSON response when no channels are joined", async () => {
    const { harness, store, worker, options } = fixture();
    expectOk(store.removeMember("work", worker.handle));
    const outcome = await harness.run(["read", "--all", "--json"], options);
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.out)).toEqual({ channels: [] });
  });

  test("reports failed pane discovery as a JSON recovery error", async () => {
    const { harness, options } = fixture();
    const outcome = await harness.run(["inbox", "--json"], { ...options, herdr: new FakeHerdr() });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe("");
    expect(JSON.parse(outcome.out)).toMatchObject({ code: "IdentityUnavailable" });
  });

  test("reports rejected pane credentials as a JSON recovery error", async () => {
    const { harness, store, worker, options } = fixture();
    expectOk(store.deactivateParticipant(worker.handle));
    const outcome = await harness.run(["inbox", "--json"], options);
    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe("");
    expect(JSON.parse(outcome.out)).toMatchObject({ code: "IdentityUnavailable" });
    expect(store.findById(worker.id)?.deactivated).toBe(true);
  });

  test("refuses recovery through a different Herdr socket", async () => {
    const { harness, store, worker, options } = fixture();
    store.markRouteStale(worker.id);
    const outcome = await harness.run(["inbox"], { ...options, herdrSocketPath: "/tmp/other-herdr.sock" });
    expect(outcome.code).toBe(1);
    expect(store.findById(worker.id)?.routeState).toBe("stale");
  });
});
