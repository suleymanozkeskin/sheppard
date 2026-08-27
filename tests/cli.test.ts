import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "../src/herdr";
import { type CliHarness, type HarnessOptions, provisionAgent, startCliHub } from "./cli-support";

const open: CliHarness[] = [];

function hub(options: HarnessOptions = {}): CliHarness {
  const harness = startCliHub(options);
  open.push(harness);
  return harness;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.stop();
});

/** A channel with two agents joined, the arrangement most commands need. */
async function twoAgents(harness: CliHarness) {
  const alice = await provisionAgent(harness, "alice");
  const bob = await provisionAgent(harness, "bob");
  await harness.run(["channels", "create", "backend"], { token: alice });
  await harness.run(["join", "backend"], { token: alice });
  await harness.run(["join", "backend"], { token: bob });
  return { alice, bob };
}

describe("usage", () => {
  test("prints usage and fails when given no command", async () => {
    const harness = hub();
    const outcome = await harness.run([]);
    expect(outcome.code).toBe(2);
    expect(outcome.out).toContain("msgr serve");
  });

  test("prints usage successfully when asked for help", async () => {
    const harness = hub();
    const outcome = await harness.run(["help"]);
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain("msgr read --all");
  });

  test("rejects an unknown command", async () => {
    const harness = hub();
    const outcome = await harness.run(["frobnicate"]);
    expect(outcome.code).toBe(2);
    expect(outcome.err).toContain("Unknown command");
  });

  test("names the missing argument rather than failing obscurely", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");
    for (const argv of [
      ["join"],
      ["send", "backend"],
      ["dm"],
      ["members"],
      ["seen"],
      ["participants"],
      ["history"],
      ["search"],
    ]) {
      const outcome = await harness.run(argv, { token });
      expect(`${argv[0]} -> ${outcome.code}`).toBe(`${argv[0]} -> 2`);
      expect(outcome.err).toContain("Usage:");
    }
  });
});

describe("direct messages", () => {
  test("sends, lists, reads, and acknowledges a direct conversation", async () => {
    const harness = hub();
    const alice = await provisionAgent(harness, "alice");
    const bob = await provisionAgent(harness, "bob");

    const sent = await harness.run(["dm", "bob", "hello", "--json"], { token: alice });
    expect(sent.code).toBe(0);
    // SAFETY: `dm --json` returns the documented direct-message result after a successful command.
    const direct = JSON.parse(sent.out) as { channel: string; messageId: number };
    expect(direct.channel.startsWith("dm-")).toBe(true);
    expect(direct.messageId).toBeGreaterThan(0);

    const listed = await harness.run(["dms", "--json"], { token: bob });
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual({
      conversations: [
        {
          channel: direct.channel,
          participants: ["alice"],
          unread: 1,
          lastMessageAt: expect.any(String),
        },
      ],
    });

    const read = await harness.run(["read", direct.channel], { token: bob });
    expect(read.code).toBe(0);
    expect(read.out).toContain("hello");

    const cleared = await harness.run(["dms", "--json"], { token: bob });
    expect(JSON.parse(cleared.out)).toEqual({
      conversations: [
        {
          channel: direct.channel,
          participants: ["alice"],
          unread: 0,
          lastMessageAt: expect.any(String),
        },
      ],
    });
  });

  test("keeps every message word supplied as a positional", async () => {
    const harness = hub();
    const alice = await provisionAgent(harness, "alice");
    const bob = await provisionAgent(harness, "bob");

    const sent = await harness.run(["dm", "bob", "first", "second", "--json"], { token: alice });
    // SAFETY: A successful `dm --json` response is the documented direct-message shape.
    const direct = JSON.parse(sent.out) as { channel: string };
    const history = await harness.run(["history", direct.channel, "--json"], { token: bob });

    expect(sent.code).toBe(0);
    expect(JSON.parse(history.out)).toMatchObject({ messages: [{ body: "first second" }] });
  });
});

describe("member management", () => {
  test("adds and removes a participant", async () => {
    const harness = hub();
    const alice = await provisionAgent(harness, "alice");
    await provisionAgent(harness, "bob");
    await harness.run(["channels", "create", "backend"], { token: alice });
    await harness.run(["join", "backend"], { token: alice });

    const added = await harness.run(["members", "add", "backend", "bob"], { token: alice });
    expect(added.code).toBe(0);
    expect(added.out).toContain("added bob to #backend");

    const listed = await harness.run(["members", "backend"], { token: alice });
    expect(listed.out).toContain("bob");

    const removed = await harness.run(["members", "remove", "backend", "bob"], { token: alice });
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("removed bob from #backend");
    expect((await harness.run(["members", "backend"], { token: alice })).out).not.toContain("bob");
  });
});

describe("participant management", () => {
  test("deactivates a participant and keeps attributed history", async () => {
    const harness = hub();
    const alice = await provisionAgent(harness, "alice");
    const retired = await provisionAgent(harness, "retired");
    await harness.run(["channels", "create", "backend"], { token: alice });
    await harness.run(["join", "backend"], { token: alice });
    await harness.run(["join", "backend"], { token: retired });
    await harness.run(["send", "backend", "historical post"], { token: retired });

    const removed = await harness.run(["participants", "remove", "retired"], { token: alice });
    expect(removed.code).toBe(0);
    expect(removed.out).toBe("deactivated retired");
    expect((await harness.run(["members", "backend"], { token: alice })).out).not.toContain("retired");
    expect((await harness.run(["history", "backend"], { token: alice })).out).toContain("retired");

    const rejected = await harness.run(["inbox"], { token: retired });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("Your token was rejected.");

    const repeated = await harness.run(["participants", "remove", "retired"], { token: alice });
    expect(repeated.code).toBe(1);
    expect(repeated.err).toBe('No active participant has the handle "retired".');
  });
});

describe("error copy", () => {
  test("uses the channel validation remedy", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");

    const outcome = await harness.run(["channels", "create", "BAD"], { token });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe(
      "That channel name is not allowed.\n" +
        "Use lowercase letters, digits, `-` or `_`. Start with a letter. Keep it to 32 characters.",
    );
  });

  test("uses the channel value for a missing channel", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");

    const outcome = await harness.run(["join", "ghost"], { token });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe(
      'There is no channel named "ghost".\nIt may have been created on another hub.',
    );
  });

  test("uses the member value for a missing participant", async () => {
    const harness = hub();
    const alice = await provisionAgent(harness, "alice");
    await harness.run(["channels", "create", "backend"], { token: alice });
    await harness.run(["join", "backend"], { token: alice });

    const outcome = await harness.run(["members", "add", "backend", "nobody"], { token: alice });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe(
      'No participant has the handle "nobody".\nProvision the agent first with `msgr provision nobody`.',
    );
  });

  test("names the channel in the CLI membership remedy", async () => {
    const harness = hub();
    const owner = await provisionAgent(harness, "alice");
    const token = await provisionAgent(harness, "bob");
    await harness.run(["channels", "create", "backend"], { token: owner });

    const outcome = await harness.run(["read", "backend"], { token });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe("You have not joined this channel.\nRun: `msgr join backend`");
  });
});

describe("identity", () => {
  test("provision prints the handle and its token once", async () => {
    const harness = hub();
    const outcome = await harness.run(["provision", "reviewer"]);
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain("handle reviewer");
    expect(outcome.out).toContain("shown once and cannot be reissued");
  });

  test("provision says so when the handle was suffixed", async () => {
    const harness = hub();
    await harness.run(["provision", "reviewer"]);
    const second = await harness.run(["provision", "reviewer"]);
    expect(second.out).toContain('Handle "reviewer" was taken; assigned "reviewer-2"');
    expect(second.out).toContain("handle reviewer-2");
  });

  test("provision --exact refuses a taken handle", async () => {
    const harness = hub();
    await harness.run(["provision", "reviewer"]);
    const exact = await harness.run(["provision", "reviewer", "--exact"]);
    expect(exact.code).toBe(1);
    expect(exact.err).toContain('The name "reviewer" is taken.');
    expect(exact.err).toContain("Pick another name.");
  });

  test("a command needing identity explains how to get one", async () => {
    const harness = hub();
    const outcome = await harness.run(["inbox"]);
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("msgr provision");
    expect(outcome.err).toContain("msgr spawn");
  });

  test("a routed pane without a token names its bound identity", async () => {
    const herdrSocketPath = "/tmp/msgr-cli-herdr.sock";
    const harness = hub({ herdrSocketPath });
    const token = await provisionAgent(harness, "bound");
    const participant = harness.hub.store.findByToken(token);
    expect(participant).not.toBeNull();
    harness.hub.store.bindRoute(participant!.id, {
      terminalId: "term_bound",
      paneId: "w1:p1",
      occupantAgent: "claude",
    });
    const herdr = new FakeHerdr().withPane({
      terminalId: "term_bound",
      paneId: "w1:p1",
      agent: "claude",
    });

    const outcome = await harness.run(["inbox"], { herdr, herdrSocketPath });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain('bound to the identity "bound"');
    expect(outcome.err).toContain("msgr spawn bound -- <command...>");
    expect(outcome.err).not.toContain("msgr provision bound");
  });

  test("a token that was never issued is refused", async () => {
    const harness = hub();
    const outcome = await harness.run(["inbox"], { token: "not-a-real-token" });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("Your token was rejected.");
  });
});

describe("spawn", () => {
  test("puts the token in the child environment and never in its arguments", async () => {
    const harness = hub();
    const launched: Array<{ command: readonly string[]; handle: string; token: string }> = [];

    const outcome = await harness.run(["spawn", "worker", "--", "claude", "--model", "opus"], {
      launch: (command, handle, token) => {
        launched.push({ command, handle, token });
        return Promise.resolve(0);
      },
    });

    expect(outcome.code).toBe(0);
    const launch = launched[0];
    expect(launch?.command).toEqual(["claude", "--model", "opus"]);
    expect(launch?.handle).toBe("worker");
    expect(launch?.token.length).toBeGreaterThan(20);
    // The secret must not be reachable from a process listing.
    expect(launch?.command.join(" ")).not.toContain(launch?.token ?? "");
  });

  test("reports the assigned handle when the requested one was taken", async () => {
    const harness = hub();
    await provisionAgent(harness, "worker");

    const outcome = await harness.run(["spawn", "worker", "--", "true"], {
      launch: (_command, handle) => {
        expect(handle).toBe("worker-2");
        return Promise.resolve(0);
      },
    });
    expect(outcome.out).toContain('launching as "worker-2"');
  });

  test("passes the child's exit code back", async () => {
    const harness = hub();
    const outcome = await harness.run(["spawn", "worker", "--", "false"], {
      launch: () => Promise.resolve(3),
    });
    expect(outcome.code).toBe(3);
  });

  test("requires a command after the separator", async () => {
    const harness = hub();
    const outcome = await harness.run(["spawn", "worker"]);
    expect(outcome.code).toBe(2);
    expect(outcome.err).toContain("Usage: msgr spawn");
  });

  test("the launched process really receives the token in its environment", async () => {
    const harness = hub();
    const directory = mkdtempSync(join(tmpdir(), "msgr-spawn-"));
    const record = join(directory, "env");
    try {
      // Exercises the real launch path rather than the injected one.
      const outcome = await harness.run([
        "spawn",
        "worker",
        "--",
        "sh",
        "-c",
        `printf '%s\\n%s\\n' "$MSGR_HANDLE" "$MSGR_TOKEN" > ${record}`,
      ]);
      expect(outcome.code).toBe(0);

      const [handle, token] = readFileSync(record, "utf8").trim().split("\n");
      expect(handle).toBe("worker");
      expect(token?.length).toBeGreaterThan(20);
      expect(harness.hub.store.findByToken(token ?? "")?.handle).toBe("worker");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("read", () => {
  test("prints unread and then marks it read", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });
    await harness.run(["send", "backend", "two"], { token: alice });

    const first = await harness.run(["read", "backend"], { token: bob });
    expect(first.code).toBe(0);
    expect(first.out).toContain("2 new");
    expect(first.out).toContain("one");
    expect(first.out).toContain("two");

    const second = await harness.run(["read", "backend"], { token: bob });
    expect(second.out).toContain("nothing new");
  });

  test("prints the messages even when the acknowledgement fails", async () => {
    const harness = hub({ failAck: true });
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "important finding"], { token: alice });

    const attempt = await harness.run(["read", "backend"], { token: bob });
    // Printing happens first, so the content survives a failed acknowledgement.
    expect(attempt.out).toContain("important finding");
    expect(attempt.code).toBe(1);
    expect(attempt.err).toContain("acknowledgement was lost");

    // And because the cursor never moved, nothing was lost.
    const retry = await harness.run(["read", "backend"], { token: bob });
    expect(retry.out).toContain("important finding");
  });

  test("does not acknowledge when there was nothing to read", async () => {
    const harness = hub({ failAck: true });
    const { bob } = await twoAgents(harness);

    const outcome = await harness.run(["read", "backend"], { token: bob });
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain("nothing new");
  });

  test("truncates a long body and says where to find the rest", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "x".repeat(3000)], { token: alice });

    const outcome = await harness.run(["read", "backend"], { token: bob });
    expect(outcome.out).toContain("[truncated — msgr history backend 1 --full]");
    expect(outcome.out.length).toBeLessThan(3000);
  });

  test("--all drains every channel that has something waiting", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["channels", "create", "general"], { token: alice });
    await harness.run(["join", "general"], { token: alice });
    await harness.run(["join", "general"], { token: bob });
    await harness.run(["send", "backend", "from backend"], { token: alice });
    await harness.run(["send", "general", "from general"], { token: alice });

    const outcome = await harness.run(["read", "--all"], { token: bob });
    expect(outcome.out).toContain("from backend");
    expect(outcome.out).toContain("from general");

    const again = await harness.run(["read", "--all"], { token: bob });
    expect(again.out).toContain("Nothing new anywhere.");
  });

  test("names the sender's harness when it is known", async () => {
    const herdrSocketPath = "/tmp/msgr-cli-herdr.sock";
    const harness = hub({ herdrSocketPath });
    const { alice, bob } = await twoAgents(harness);
    const herdr = new FakeHerdr().withPane({
      terminalId: "term_alice",
      paneId: "w1:p1",
      agent: "codex",
    });
    await harness.run(["inbox"], { token: alice, herdr, herdrSocketPath });
    await harness.run(["send", "backend", "from a codex agent"], {
      token: alice,
      herdr,
      herdrSocketPath,
    });

    const outcome = await harness.run(["read", "backend"], { token: bob });
    expect(outcome.out).toContain("alice (codex)");
  });

  test("sends the herdr session path with a routed request", async () => {
    const herdrSocketPath = "/tmp/msgr-cli-herdr.sock";
    const harness = hub({ herdrSocketPath });
    const alice = await provisionAgent(harness, "alice");
    const herdr = new FakeHerdr().withPane({
      terminalId: "term_alice",
      paneId: "w1:p1",
      agent: "codex",
    });

    const outcome = await harness.run(["inbox"], {
      token: alice,
      herdr,
      herdrSocketPath,
    });

    expect(outcome.code).toBe(0);
    expect(harness.hub.store.findByHandle("alice")?.paneId).toBe("w1:p1");
  });
});

describe("send", () => {
  test("attaches absolute paths and reports what was stored", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);
    const directory = mkdtempSync(join(tmpdir(), "msgr-send-"));
    try {
      const notes = join(directory, "notes.md");
      writeFileSync(notes, "# Findings\n");

      const outcome = await harness.run(["send", "backend", "see notes", "--file", notes], {
        token: alice,
      });
      expect(outcome.code).toBe(0);
      expect(outcome.out).toContain("sent to #backend as alice");

      const history = await harness.run(["history", "backend"]);
      expect(history.out).toContain(notes);
      expect(history.out).toContain("previewable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("attaches several files in the order given", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);
    const directory = mkdtempSync(join(tmpdir(), "msgr-send-"));
    try {
      const first = join(directory, "one.md");
      const second = join(directory, "two.md");
      writeFileSync(first, "# One\n");
      writeFileSync(second, "# Two\n");

      await harness.run(["send", "backend", "both", "--file", first, "--file", second], {
        token: alice,
      });

      const history = await harness.run(["history", "backend", "1"]);
      expect(history.out.indexOf("one.md")).toBeLessThan(history.out.indexOf("two.md"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports a path that names no file", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);
    const outcome = await harness.run(
      ["send", "backend", "x", "--file", "/tmp/definitely-absent-99999.md"],
      { token: alice },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("readable file");
  });
});

describe("listings", () => {
  test("inbox summarises unread and how delivery stands", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });

    const outcome = await harness.run(["inbox"], { token: bob });
    expect(outcome.out).toContain("#backend: 1 unread from alice");
    expect(outcome.out).toContain("poll only");
    expect(outcome.out).toContain("Run: msgr read --all");
  });

  test("inbox says plainly when no channels are joined", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "loner");
    const outcome = await harness.run(["inbox"], { token });
    expect(outcome.out).toContain("No channels joined");
  });

  test("history leaves unread untouched", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });

    await harness.run(["history", "backend"]);
    const inbox = await harness.run(["inbox"], { token: bob });
    expect(inbox.out).toContain("1 unread");
  });

  test("history --full keeps a long body whole", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);
    await harness.run(["send", "backend", "y".repeat(3000)], { token: alice });

    const truncated = await harness.run(["history", "backend", "1"]);
    expect(truncated.out).toContain("[truncated");

    const full = await harness.run(["history", "backend", "1", "--full"]);
    expect(full.out).not.toContain("[truncated");
    expect(full.out).toContain("y".repeat(3000));
  });

  test("history rejects a count that is not a number", async () => {
    const harness = hub();
    await twoAgents(harness);
    const outcome = await harness.run(["history", "backend", "lots"]);
    expect(outcome.code).toBe(2);
    expect(outcome.err).toContain("whole number");
  });

  test("channels lists what exists and members lists who is in one", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);

    const channels = await harness.run(["channels"]);
    expect(channels.out).toContain("#backend");
    expect(channels.out).toContain("2 members");

    const members = await harness.run(["members", "backend"], { token: alice });
    expect(members.out).toContain("alice");
    expect(members.out).toContain("bob");
  });

  test("channels create accepts a topic", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");
    const created = await harness.run(["channels", "create", "design", "--topic", "layout work"], {
      token,
    });
    expect(created.out).toContain("created #design");

    const listed = await harness.run(["channels"]);
    expect(listed.out).toContain("layout work");
  });

  test("search finds text and can be scoped to a channel", async () => {
    const harness = hub();
    const { alice } = await twoAgents(harness);
    await harness.run(["channels", "create", "general"], { token: alice });
    await harness.run(["send", "backend", "the deploy pipeline is green"], { token: alice });
    await harness.run(["send", "general", "deploy notes posted"], { token: alice });

    const all = await harness.run(["search", "deploy"]);
    expect(all.out).toContain("#backend");
    expect(all.out).toContain("#general");

    const scoped = await harness.run(["search", "deploy", "--channel", "backend"]);
    expect(scoped.out).toContain("#backend");
    expect(scoped.out).not.toContain("#general");
  });

  test("search reports plainly when nothing matches", async () => {
    const harness = hub();
    await twoAgents(harness);
    const outcome = await harness.run(["search", "nonexistentterm"]);
    expect(outcome.out).toContain("No matches.");
  });
});

describe("--json", () => {
  test("prints the hub's own shapes for machine use", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });

    const inbox = await harness.run(["inbox", "--json"], { token: bob });
    // SAFETY: --json prints the hub's {entries} reply verbatim; any other shape
    // fails the expectation below.
    const parsed = JSON.parse(inbox.out) as { entries: Array<{ channel: string; unread: number }> };
    expect(parsed.entries[0]).toMatchObject({ channel: "backend", unread: 1 });

    const read = await harness.run(["read", "backend", "--json"], { token: bob });
    expect(JSON.parse(read.out)).toMatchObject({ channel: "backend", throughId: 1 });
  });

  test("still advances the cursor", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });

    await harness.run(["read", "backend", "--json"], { token: bob });
    const after = await harness.run(["inbox"], { token: bob });
    expect(after.out).toContain("nothing new");
  });

  test("keeps read-all output as one stable JSON envelope", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["channels", "create", "general"], { token: alice });
    await harness.run(["join", "general"], { token: alice });
    await harness.run(["join", "general"], { token: bob });
    await harness.run(["send", "backend", "from backend"], { token: alice });
    await harness.run(["send", "general", "from general"], { token: alice });

    const outcome = await harness.run(["read", "--all", "--json"], { token: bob });
    // SAFETY: A successful `read --all --json` response is the stable channels envelope.
    const result = JSON.parse(outcome.out) as { channels: Array<{ channel: string }> };

    expect(outcome.code).toBe(0);
    expect(result.channels.map((channel) => channel.channel)).toEqual(["backend", "general"]);
  });

  test("writes the server error envelope with its cause to stdout", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");
    const outcome = await harness.run(["channels", "create", "BAD", "--json"], { token });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe("");
    expect(JSON.parse(outcome.out)).toMatchObject({
      code: "ValidationFailed",
      error: "name must start with a letter and use only a-z, 0-9, _ or - (max 32)",
    });
  });

  test("does not mix a read result with an acknowledgement error", async () => {
    const harness = hub({ failAck: true });
    const { alice, bob } = await twoAgents(harness);
    await harness.run(["send", "backend", "one"], { token: alice });

    const outcome = await harness.run(["read", "backend", "--json"], { token: bob });

    expect(outcome.code).toBe(1);
    expect(outcome.err).toBe("");
    expect(JSON.parse(outcome.out)).toMatchObject({ code: "Unclassified" });
  });
});

describe("seen receipts", () => {
  test("prints cursor watermarks and preserves a stale route", async () => {
    const harness = hub();
    const { alice, bob } = await twoAgents(harness);

    await harness.run(["send", "backend", "first"], { token: alice });
    await harness.run(["read", "backend"], { token: bob });
    await harness.run(["send", "backend", "second"], { token: alice });

    const bobParticipant = harness.hub.store.findByHandle("bob");
    if (bobParticipant === null) throw new Error("bob fixture is missing");
    harness.hub.store.markRouteStale(bobParticipant.id);

    const text = await harness.run(["seen", "backend"], { token: alice });
    expect(text.code).toBe(0);
    expect(text.out).toContain("alice  cursor 2  route active");
    expect(text.out).toContain("bob  cursor 1  route stale");

    const json = await harness.run(["seen", "backend", "--json"], { token: alice });
    expect(JSON.parse(json.out)).toEqual([
      { handle: "alice", cursorMessageId: 2, routeState: "active" },
      { handle: "bob", cursorMessageId: 1, routeState: "stale" },
    ]);
  });
});

describe("an unreachable hub", () => {
  test("says so instead of failing obscurely", async () => {
    const harness = hub();
    const token = await provisionAgent(harness, "alice");
    harness.stop();
    open.length = 0;

    const outcome = await harness.run(["inbox"], { token });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("msgr serve");
  });
});
