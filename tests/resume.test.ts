import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, herdrCallFailed } from "../src/herdr";
import { type LauncherCandidate, matchLauncher, resumableHarness, resumeArgv, sessionRoot } from "../src/resume";
import { type TestHub, operatorAuth, testHub } from "./http-support";

const CLAUDE_SESSION = join(homedir(), ".claude", "projects", "-work", "5f0c7c2e.jsonl");
const PERSONAL_ROOT = "/Users/demo/.config/claude-personal";

describe("resumeArgv", () => {
  test("uses each harness's own resume form", () => {
    expect(resumeArgv("claude", "abc")).toEqual(["--resume", "abc"]);
    expect(resumeArgv("codex", "abc")).toEqual(["resume", "abc"]);
    expect(resumeArgv("grok", "abc")).toEqual(["--resume", "abc"]);
    expect(resumeArgv("pi", "abc")).toEqual(["--session", "abc"]);
    expect(resumeArgv("opencode", "ses_abc")).toEqual(["--session", "ses_abc"]);
  });

  test("names only the five resumable harnesses", () => {
    expect(resumableHarness("claude")).toBe("claude");
    expect(resumableHarness("copilot")).toBeNull();
  });
});

describe("matchLauncher", () => {
  const launchers: LauncherCandidate[] = [
    { name: "claude", agentKind: "claude", env: {} },
    { name: "claude-personal", agentKind: "claude", env: { CLAUDE_CONFIG_DIR: PERSONAL_ROOT } },
    { name: "codex", agentKind: "codex", env: {} },
  ];

  test("keeps the launcher that started the agent", () => {
    expect(matchLauncher("claude", `${PERSONAL_ROOT}/projects/x/s.jsonl`, "claude-personal", launchers)).toEqual({
      kind: "recorded",
      launcher: "claude-personal",
    });
  });

  test("matches the one launcher whose session root holds the session", () => {
    expect(matchLauncher("claude", `${PERSONAL_ROOT}/projects/x/s.jsonl`, null, launchers)).toEqual({
      kind: "matched",
      launcher: "claude-personal",
    });
    expect(matchLauncher("claude", CLAUDE_SESSION, null, launchers)).toEqual({ kind: "matched", launcher: "claude" });
  });

  test("asks when two launchers share a root, and names none outside every root", () => {
    const shared = [...launchers, { name: "claude-wrapper", agentKind: "claude", env: {} }];
    expect(matchLauncher("claude", CLAUDE_SESSION, null, shared)).toEqual({
      kind: "choose",
      launchers: ["claude", "claude-wrapper"],
    });
    expect(matchLauncher("claude", "/elsewhere/s.jsonl", null, launchers)).toEqual({ kind: "none" });
  });

  test("a root is a folder, not a name prefix", () => {
    expect(matchLauncher("claude", `${PERSONAL_ROOT}-old/projects/s.jsonl`, null, launchers)).toEqual({ kind: "none" });
  });

  test("each harness reads its own location variable", () => {
    expect(sessionRoot("pi", { PI_CODING_AGENT_DIR: "/p" })).toBe("/p");
    expect(sessionRoot("opencode", { XDG_DATA_HOME: "/d" })).toBe("/d/opencode");
  });
});

/** An ended worker whose last terminal had an exact Claude session. */
function endedWorker(hub: TestHub) {
  const herdr = new FakeHerdr();
  herdr.workspaces = [{ id: "w1", label: "Backend" }];
  herdr.withPane({ paneId: "w1:p1", terminalId: "term-root", workspaceId: "w1", agent: null });
  hub.hub.herdr = herdr;
  const store = hub.hub.store;
  const worker = store.createAgent("worker").unwrap().participant;
  store.bindRoute(worker.id, { terminalId: "term-old", paneId: "w1:p2", occupantAgent: "claude" });
  store.markRouteStale(worker.id);
  store.saveSessionMapping({
    terminal_id: "term-old",
    harness: "claude",
    session_id: "5f0c7c2e",
    session_path: CLAUDE_SESSION,
    confidence: "exact",
    cwd: "/Users/demo/work",
  });
  return { herdr, worker };
}

describe("resume endpoint", () => {
  test("reports a resumable identity in the agent detail and the list", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    endedWorker(hub);

    const detail = await (await hub.get("/api/agents/worker", operator)).json();
    expect(detail).toMatchObject({
      resume: { kind: "resumable", harness: "claude", sessionId: "5f0c7c2e", launcher: { kind: "matched", launcher: "claude" } },
    });
    const listed = await (await hub.get("/api/resumable-agents", operator)).json();
    expect(listed).toMatchObject({ agents: [{ handle: "worker" }] });
  });

  test("starts the session again in a new pane and binds the identity to it", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const { herdr, worker } = endedWorker(hub);

    const response = await hub.post("/api/agents/worker/resume", {}, operator);
    expect(response.status).toBe(200);
    const resumed = await response.json();
    expect(resumed).toMatchObject({ handle: "worker", sessionId: "5f0c7c2e" });

    const [start] = herdr.agentStarts;
    expect(start?.argv).toEqual(["claude", "--resume", "5f0c7c2e", "--allowedTools=Bash(msgr *)"]);
    const [split] = herdr.paneSplits;
    expect(split?.options).toMatchObject({ cwd: "/Users/demo/work", env: { MSGR_HANDLE: "worker" } });
    expect(hub.hub.store.findById(worker.id)).toMatchObject({ routeState: "active", paneId: resumed.paneId });
    expect(hub.hub.store.recordedSessionFor(worker.id)).toMatchObject({ kind: "recorded", sessionId: "5f0c7c2e" });
  });

  test("closes the new pane when the harness does not start", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const { herdr, worker } = endedWorker(hub);
    herdr.agentStartFailure = herdrCallFailed("harness exited", "agent start", "reported");

    const response = await hub.post("/api/agents/worker/resume", {}, operator);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(herdr.paneCloses).toHaveLength(1);
    expect(hub.hub.store.findById(worker.id)?.routeState).toBe("stale");
  });

  test("refuses a connected identity, one without a session, and an agent caller", async () => {
    const hub = testHub();
    const operator = await operatorAuth(hub);
    const { worker } = endedWorker(hub);
    const store = hub.hub.store;
    const other = store.createAgent("other").unwrap();
    store.bindRoute(other.participant.id, { terminalId: "term-x", paneId: "w1:p3", occupantAgent: "claude" });
    store.markRouteStale(other.participant.id);

    expect((await hub.post("/api/agents/other/resume", {}, operator)).status).toBe(400);
    store.bindRoute(worker.id, { terminalId: "term-root", paneId: "w1:p1", occupantAgent: "claude" });
    expect((await hub.post("/api/agents/worker/resume", {}, operator)).status).toBe(400);
    const asAgent = await hub.post("/api/agents/other/resume", {}, { "x-msgr-token": other.token });
    expect(asAgent.status).toBe(403);
  });
});

