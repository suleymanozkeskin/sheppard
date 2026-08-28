import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliHerdr, HerdrCallFailed, NoAgentAtTarget } from "../src/herdr";
import { expectErr, expectOk } from "./support";

/**
 * A stand-in for the herdr binary. herdr exits 0 even when it refuses a
 * command, so these scripts do the same: the reply body decides, not the status.
 */
function fakeBinary(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
  const path = join(dir, "herdr-stub");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A result on stdout, the way herdr reports success. */
function emitting(json: string): string {
  return `cat <<'JSON'\n${json}\nJSON`;
}

/** A refusal on stderr, the way herdr actually reports one. */
function refusing(json: string): string {
  return `cat >&2 <<'JSON'\n${json}\nJSON`;
}

const PANE_LIST = JSON.stringify({
  id: "cli:pane:list",
  result: {
    type: "pane_list",
    panes: [
      {
        agent: "claude",
        agent_status: "idle",
        focused: false,
        pane_id: "w1H:p4",
        terminal_id: "term_6593b7c0b71d34a",
        cwd: "/workspace/projects",
        foreground_cwd: "/workspace/projects/sheppard",
        terminal_title: "✳ Raw title",
        terminal_title_stripped: "Review worker",
        tab_id: "w1H:t1",
        workspace_id: "w1H",
      },
      {
        agent_status: "unknown",
        focused: true,
        pane_id: "w1H:pA",
        terminal_id: "term_659314e709c2040",
        cwd: "/workspace/projects/raw-cwd",
        terminal_title: "Raw title",
        tab_id: "w1H:t6",
        workspace_id: "w1H",
      },
    ],
  },
});

describe("pane list", () => {
  test("decodes panes, including a plain shell with no agent", async () => {
    const stub = fakeBinary(emitting(PANE_LIST));
    try {
      const panes = expectOk(await new CliHerdr(stub.path).paneList());
      expect(panes).toEqual([
        {
          paneId: "w1H:p4",
          terminalId: "term_6593b7c0b71d34a",
          agent: "claude",
          agentStatus: "idle",
          focused: false,
          terminalTitle: "Review worker",
          cwd: "/workspace/projects/sheppard",
        },
        {
          paneId: "w1H:pA",
          terminalId: "term_659314e709c2040",
          agent: null,
          agentStatus: "unknown",
          focused: true,
          terminalTitle: "Raw title",
          cwd: "/workspace/projects/raw-cwd",
        },
      ]);
      expect(panes[0]?.tabId).toBe("w1H:t1");
    } finally {
      stub.cleanup();
    }
  });

  test("treats an unreachable socket as transient", async () => {
    const refusal = JSON.stringify({
      id: "cli:pane:list",
      error: { code: "server_not_running", message: "no herdr server is running" },
    });
    const stub = fakeBinary(refusing(refusal));
    try {
      const error = expectErr(await new CliHerdr(stub.path).paneList());
      expect(HerdrCallFailed.is(error)).toBe(true);
      expect(error.detail).toContain("no herdr server is running");
      expect(error.kind).toBe("reported");
    } finally {
      stub.cleanup();
    }
  });

  test("a refusal reported with exit status 0 is still a failure", async () => {
    const refusal = JSON.stringify({ id: "cli:pane:list", error: { code: "boom", message: "nope" } });
    const stub = fakeBinary(`${refusing(refusal)}\nexit 0`);
    try {
      expect((await new CliHerdr(stub.path).paneList()).isErr()).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("a refusal on stdout is caught too, in case the streams ever swap", async () => {
    const refusal = JSON.stringify({ id: "cli:pane:list", error: { code: "boom", message: "nope" } });
    const stub = fakeBinary(emitting(refusal));
    try {
      expect((await new CliHerdr(stub.path).paneList()).isErr()).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("ignores unrelated chatter on stderr when the result is good", async () => {
    const stub = fakeBinary(`echo 'warning: something cosmetic' >&2\n${emitting(PANE_LIST)}`);
    try {
      const panes = expectOk(await new CliHerdr(stub.path).paneList());
      expect(panes.length).toBe(2);
    } finally {
      stub.cleanup();
    }
  });

  test("treats output that is not JSON as transient", async () => {
    const stub = fakeBinary(`echo 'not json at all'`);
    try {
      const error = expectErr(await new CliHerdr(stub.path).paneList());
      expect(error.detail).toContain("not JSON");
    } finally {
      stub.cleanup();
    }
  });

  test("treats a missing binary as transient rather than crashing", async () => {
    const error = expectErr(await new CliHerdr("/nonexistent/herdr").paneList());
    expect(HerdrCallFailed.is(error)).toBe(true);
  });

  test("gives up on a command that hangs", async () => {
    const stub = fakeBinary(`sleep 10`);
    try {
      const error = expectErr(await new CliHerdr(stub.path, 200).paneList());
      expect(error.detail).toContain("timed out");
      expect(error.kind).toBe("timeout");
    } finally {
      stub.cleanup();
    }
  });

  test("maps an unrecognised status to unknown so delivery holds", async () => {
    const future = JSON.stringify({
      id: "cli:pane:list",
      result: {
        panes: [
          {
            agent: "claude",
            agent_status: "hibernating",
            focused: false,
            pane_id: "w1:p1",
            terminal_id: "term_1",
          },
        ],
      },
    });
    const stub = fakeBinary(emitting(future));
    try {
      const panes = expectOk(await new CliHerdr(stub.path).paneList());
      expect(panes[0]?.agentStatus).toBe("unknown");
    } finally {
      stub.cleanup();
    }
  });
});

describe("pane current", () => {
  test("resolves the caller's own pane and terminal", async () => {
    const current = JSON.stringify({
      id: "cli:pane:current",
      result: {
        type: "pane_current",
        pane: {
          agent: "claude",
          agent_status: "working",
          focused: true,
          pane_id: "w1H:p4",
          terminal_id: "term_6593b7c0b71d34a",
        },
      },
    });
    const stub = fakeBinary(emitting(current));
    try {
      const pane = expectOk(await new CliHerdr(stub.path).paneCurrent());
      expect(pane.paneId).toBe("w1H:p4");
      expect(pane.terminalId).toBe("term_6593b7c0b71d34a");
      expect(pane.agent).toBe("claude");
    } finally {
      stub.cleanup();
    }
  });
});

describe("pane lifecycle operations", () => {
  test("keeps an event subscription open after acknowledging it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-subscription-"));
    const apiSocketPath = join(dir, "herdr.sock");
    let requestText = "";
    const server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        requestText += String(chunk);
        if (!requestText.includes("\n")) return;
        connection.write(
          JSON.stringify({ id: "msgr:events:1", result: { type: "subscription_started" } }) +
            "\n",
        );
        setTimeout(() => {
          connection.write(
            JSON.stringify({ event: "pane.updated", data: { pane_id: "w1:p1" } }) + "\n",
          );
        }, 0);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`${dir}/herdr.sock`, resolve);
    });

    const events: string[] = [];
    let streamError = false;
    const received = new Promise<void>((resolve) => {
      const herdr = new CliHerdr("/path/that-is-not-started", 1_000, apiSocketPath);
      void herdr
        .subscribe({
          paneIds: ["w1:p1"],
          onEvent: (event) => {
            events.push(event.type);
            resolve();
          },
          onError: () => {
            streamError = true;
            resolve();
          },
        })
        .then((result) => {
          expect(result.isOk()).toBe(true);
          if (result.isOk()) {
            void received.then(() => result.value.close());
          }
        });
    });
    await Promise.race([received, Bun.sleep(500)]);
    expect(requestText).toContain('"method":"events.subscribe"');
    expect(requestText).toContain('"pane_id":"w1:p1"');
    expect(events).toEqual(["pane.updated"]);
    expect(streamError).toBe(false);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("decodes a newly split pane through the CLI", async () => {
    const response = JSON.stringify({
      id: "cli:pane:split",
      result: {
        type: "pane_split",
        pane: {
          agent_status: "unknown",
          focused: false,
          pane_id: "w1:p2",
          terminal_id: "term-2",
          workspace_id: "w1",
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
    const record = join(dir, "argv");
    const stub = fakeBinary(`printf '%s\\n' "$@" > ${record}\n${emitting(response)}`);
    try {
      const pane = expectOk(await new CliHerdr(stub.path).paneSplit("w1:p1"));
      expect(pane.paneId).toBe("w1:p2");
      expect((await Bun.file(record).text()).trimEnd().split("\n")).toEqual([
        "pane",
        "split",
        "--pane",
        "w1:p1",
        "--direction",
        "right",
        "--no-focus",
      ]);
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sends secret launch environment over the configured API socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-socket-"));
    const apiSocketPath = join(dir, "herdr.sock");
    let requestText = "";
    const server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        requestText += String(chunk);
        if (!requestText.includes("\n")) return;
        connection.end(
          JSON.stringify({
            id: "msgr:pane:split",
            result: {
              type: "pane_split",
              pane: {
                agent_status: "unknown",
                focused: false,
                pane_id: "w1:p2",
                terminal_id: "term-2",
                workspace_id: "w1",
              },
            },
          }) + "\n",
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(apiSocketPath, resolve);
    });

    try {
      const pane = expectOk(
        await new CliHerdr("/path/that-is-not-started", 1_000, apiSocketPath).paneSplit("w1:p1", {
          env: { MSGR_HANDLE: "worker", MSGR_TOKEN: "secret" },
        }),
      );
      expect(pane.paneId).toBe("w1:p2");
      expect(requestText).toContain('"method":"pane.split"');
      expect(requestText).toContain('"target_pane_id":"w1:p1"');
      expect(requestText).toContain('"MSGR_HANDLE":"worker"');
      expect(requestText).toContain('"MSGR_TOKEN":"secret"');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closes a pane and starts the fixed harness argv", async () => {
    const response = JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } });
    const stub = fakeBinary(emitting(response));
    try {
      const herdr = new CliHerdr(stub.path);
      expectOk(await herdr.paneClose("w1:p2"));
      expectOk(await herdr.agentStart("w1:p2", "worker", "codex", ["codex"]));
    } finally {
      stub.cleanup();
    }
  });

  test("uses the readiness timeout for agent start and keeps pane context", async () => {
    const stub = fakeBinary("sleep 10");
    try {
      const error = expectErr(
        await new CliHerdr(stub.path, 10_000, null, 200).agentStart(
          "w1:p2",
          "worker",
          "codex",
          ["codex"],
        ),
      );
      expect(HerdrCallFailed.is(error)).toBe(true);
      expect(error.kind).toBe("timeout");
      expect(error.paneId).toBe("w1:p2");
    } finally {
      stub.cleanup();
    }
  });

  test("passes a custom executable separately from the logical agent kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-agent-start-"));
    const record = join(dir, "argv");
    const stub = fakeBinary(`printf '%s\\n' "$@" > ${record}; printf '{"result":{}}'`);
    try {
      expectOk(
        await new CliHerdr(stub.path).agentStart(
          "w1:p2",
          "worker",
          "claude",
          ["/tmp/claude-wrapper", "--profile", "work"],
        ),
      );
      const argv = (await Bun.file(record).text()).trimEnd().split("\n");
      expect(argv).toEqual([
        "agent",
        "start",
        "worker",
        "--kind",
        "claude",
        "--pane",
        "w1:p2",
        "--executable",
        "/tmp/claude-wrapper",
        "--",
        "--profile",
        "work",
      ]);
      expect(argv).not.toContain("sh");
      expect(argv).not.toContain("-c");
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent prompt", () => {
  test("passes the target and text as separate arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
    const record = join(dir, "argv");
    const stub = fakeBinary(`printf '%s\\n' "$@" > ${record}`);
    try {
      expectOk(await new CliHerdr(stub.path).agentPrompt("w1:p1", "[msgr] 1 new message; rm -rf /"));
      const argv = (await Bun.file(record).text()).trimEnd().split("\n");
      expect(argv).toEqual(["agent", "prompt", "w1:p1", "[msgr] 1 new message; rm -rf /"]);
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats silence as success", async () => {
    const stub = fakeBinary(`exit 0`);
    try {
      expect((await new CliHerdr(stub.path).agentPrompt("w1:p1", "ping")).isOk()).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("treats silent non-zero exit as transient", async () => {
    const stub = fakeBinary(`exit 7`);
    try {
      const error = expectErr(await new CliHerdr(stub.path).agentPrompt("w1:p1", "ping"));
      expect(HerdrCallFailed.is(error)).toBe(true);
      expect(error.detail).toContain("status 7");
      expect(error.kind).toBe("reported");
      expect(error.paneId).toBe("w1:p1");
    } finally {
      stub.cleanup();
    }
  });

  test("a refusal on stderr is never read as silent success", async () => {
    const refusal = JSON.stringify({
      id: "cli:agent:prompt",
      error: { code: "agent_not_found", message: "agent target w1:p1 not found" },
    });
    // stdout is empty, exactly as the real binary leaves it on a refusal.
    const stub = fakeBinary(`${refusing(refusal)}\nexit 0`);
    try {
      const sent = await new CliHerdr(stub.path).agentPrompt("w1:p1", "ping");
      expect(sent.isOk()).toBe(false);
      expect(NoAgentAtTarget.is(expectErr(sent))).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("a pane hosting no agent is definitive", async () => {
    const refusal = JSON.stringify({
      id: "cli:agent:prompt",
      error: { code: "agent_not_found", message: "agent target w9Z:p99 not found" },
    });
    const stub = fakeBinary(refusing(refusal));
    try {
      const error = expectErr(await new CliHerdr(stub.path).agentPrompt("w9Z:p99", "ping"));
      expect(NoAgentAtTarget.is(error)).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("keeps a classified missing-agent refusal definitive on non-zero exit", async () => {
    const refusal = JSON.stringify({
      id: "cli:agent:prompt",
      error: { code: "agent_not_found", message: "agent target w9Z:p99 not found" },
    });
    const stub = fakeBinary(`${refusing(refusal)}\nexit 7`);
    try {
      const error = expectErr(await new CliHerdr(stub.path).agentPrompt("w9Z:p99", "ping"));
      expect(NoAgentAtTarget.is(error)).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("any other refusal is transient, so delivery retries", async () => {
    const refusal = JSON.stringify({
      id: "cli:agent:prompt",
      error: { code: "server_not_running", message: "no herdr server is running" },
    });
    const stub = fakeBinary(refusing(refusal));
    try {
      const error = expectErr(await new CliHerdr(stub.path).agentPrompt("w1:p1", "ping"));
      expect(HerdrCallFailed.is(error)).toBe(true);
    } finally {
      stub.cleanup();
    }
  });

  test("a timeout is transient", async () => {
    const stub = fakeBinary(`sleep 10`);
    try {
      const error = expectErr(await new CliHerdr(stub.path, 200).agentPrompt("w1:p1", "ping"));
      expect(HerdrCallFailed.is(error)).toBe(true);
      expect(error.kind).toBe("timeout");
      expect(error.paneId).toBe("w1:p1");
    } finally {
      stub.cleanup();
    }
  });
});

describe("workspace operations", () => {
  test("lists workspace ids and labels", async () => {
    const response = JSON.stringify({
      id: "cli:workspace:list",
      result: {
        type: "workspace_list",
        workspaces: [{ workspace_id: "w1", label: "Backend" }],
      },
    });
    const stub = fakeBinary(emitting(response));
    try {
      expect(expectOk(await new CliHerdr(stub.path).workspaceList())).toEqual([
        { id: "w1", label: "Backend" },
      ]);
    } finally {
      stub.cleanup();
    }
  });

  test("passes optional workspace create flags as separate argv entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
    const record = join(dir, "argv");
    const response = JSON.stringify({
      id: "cli:workspace:create",
      result: {
        type: "workspace_created",
        workspace: { workspace_id: "w2", label: "Feature" },
      },
    });
    const stub = fakeBinary(`printf '%s\\n' "$@" > ${record}\n${emitting(response)}`);
    try {
      expect(expectOk(await new CliHerdr(stub.path).workspaceCreate("Feature", "/tmp/project"))).toEqual({
        id: "w2",
        label: "Feature",
      });
      expect((await Bun.file(record).text()).trimEnd().split("\n")).toEqual([
        "workspace",
        "create",
        "--label",
        "Feature",
        "--cwd",
        "/tmp/project",
      ]);
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closes a workspace through the control operation", async () => {
    const response = JSON.stringify({ id: "cli:workspace:close", result: { type: "ok" } });
    const stub = fakeBinary(emitting(response));
    try {
      expect(expectOk(await new CliHerdr(stub.path).workspaceClose("w1"))).toBeUndefined();
    } finally {
      stub.cleanup();
    }
  });
});

describe("tab operations", () => {
  test("lists tab ids, workspace ids, and labels", async () => {
    const response = JSON.stringify({
      id: "cli:tab:list",
      result: {
        type: "tab_list",
        tabs: [
          { tab_id: "w1:t1", workspace_id: "w1", label: "Main" },
          { tab_id: "w1:t2", workspace_id: "w1", label: "" },
        ],
      },
    });
    const stub = fakeBinary(emitting(response));
    try {
      expect(expectOk(await new CliHerdr(stub.path).tabList())).toEqual([
        { id: "w1:t1", workspaceId: "w1", label: "Main" },
        { id: "w1:t2", workspaceId: "w1", label: null },
      ]);
    } finally {
      stub.cleanup();
    }
  });

  test("passes tab create options as separate argv entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
    const record = join(dir, "argv");
    const response = JSON.stringify({
      id: "cli:tab:create",
      result: {
        type: "tab_created",
        tab: { tab_id: "w1:t2", workspace_id: "w1", label: "Feature" },
      },
    });
    const stub = fakeBinary(`printf '%s\\n' "$@" > ${record}\n${emitting(response)}`);
    try {
      expect(expectOk(await new CliHerdr(stub.path).tabCreate("w1", "Feature"))).toEqual({
        id: "w1:t2",
        workspaceId: "w1",
        label: "Feature",
      });
      expect((await Bun.file(record).text()).trimEnd().split("\n")).toEqual([
        "tab",
        "create",
        "--workspace",
        "w1",
        "--label",
        "Feature",
      ]);
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses argv arrays for tab rename, focus, and close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msgr-herdr-"));
    const record = join(dir, "argv");
    const stub = fakeBinary(`printf '%s\\n' "$@" >> ${record}\nprintf '{"result":{"type":"ok"}}\\n'`);
    try {
      const herdr = new CliHerdr(stub.path);
      expectOk(await herdr.tabRename("w1:t1", "Renamed"));
      expectOk(await herdr.tabFocus("w1:t1"));
      expectOk(await herdr.tabClose("w1:t1"));
      expect((await Bun.file(record).text()).trimEnd().split("\n")).toEqual([
        "tab",
        "rename",
        "w1:t1",
        "Renamed",
        "tab",
        "focus",
        "w1:t1",
        "tab",
        "close",
        "w1:t1",
      ]);
    } finally {
      stub.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
