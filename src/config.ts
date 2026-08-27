/**
 * Server configuration, read once at startup.
 *
 * The hub listens on the loopback interface only. `allowedOrigin` is the origin
 * the web UI is served from; a browser request carrying any other Origin is
 * refused. Overriding it is how a separate dev server is granted access
 * deliberately, rather than by loosening the check for everyone.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { validationFailed } from "./errors";
import {
  type JsonValue,
  decodeObject,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./json";
import { validModelIdentifier } from "./validate";

export const DEFAULT_PORT = 6747;
export const HOST = "127.0.0.1";
export const TOKEN_HEADER = "x-msgr-token";
export const TOKEN_COOKIE = "msgr_token";
/** Default readiness budget for a harness that does not set its own budget. */
export const DEFAULT_AGENT_START_TIMEOUT_MS = 35_000;
/** Herdr refuses larger interactive-agent readiness budgets. */
export const MAX_AGENT_START_TIMEOUT_MS = 300_000;

/**
 * Route headers on an authenticated request. The CLI resolves the caller's pane
 * and sends it; browsers never do, which is why humans hold no route.
 */
export const TERMINAL_HEADER = "x-msgr-terminal-id";
export const PANE_HEADER = "x-msgr-pane-id";
export const OCCUPANT_HEADER = "x-msgr-occupant";
export const HERDR_SOCKET_HEADER = "x-msgr-herdr-socket-path";

export interface HarnessConfig {
  name: string;
  /** The fixed executable argv selected by the hub, never by a request. */
  argv: readonly string[];
  /** Maximum time the hub waits for this harness to become ready. */
  startTimeoutMs: number;
}

export interface RoleConfig {
  name: string;
  /** Null means the operator chooses the harness at spawn time. */
  agentKind: string | null;
  summary: string;
  briefing: string;
  /** Product-owned roles carry their shipped protocol and can be marked native. */
  native?: boolean;
  /** Default launcher name; null lets the operator pick at spawn. */
  launcher?: string | null;
  /** Default model catalogue name; null uses the harness default. */
  model?: string | null;
  /** Default effort catalogue name; null uses the harness default. */
  effort?: string | null;
}

export interface ModelConfig {
  harness: string;
  name: string;
  kind: "model" | "effort";
  /** Appended to the launcher argv by the hub; never sent by a client. */
  argvSuffix: readonly string[];
}

export interface ServerConfig {
  port: number;
  databasePath: string;
  allowedOrigin: string;
  pushAvailable: boolean;
  /** Captured when the hub starts inside herdr; null means no herdr session. */
  herdrSocketPath: string | null;
  webRoot: string;
  /** Embedded release assets keyed by their absolute URL path. */
  webAssets?: ReadonlyMap<string, string>;
  /** The build version exposed by the local metadata endpoint. */
  applicationVersion?: string;
  uploadDirectory?: string;
  /** Optional for test configurations; startup fills the production default. */
  harnesses?: readonly HarnessConfig[];
  /** Optional for test configurations; startup fills the production default. */
  roles?: readonly RoleConfig[];
  /** Seed entries for the model catalogue; empty by default. */
  models?: readonly ModelConfig[];
  /** Test-only escape hatch for creating more than the operator identity. */
  allowExtraHumans: boolean;
}

function integerFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function defaultDatabasePath(): string {
  return join(homedir(), ".config", "msgr", "msgr.db");
}

export function defaultUploadDirectory(): string {
  return join(homedir(), ".config", "msgr", "files");
}

const HARNESS_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

const REPORTER_BRIEFING =
  "Observe git, herdr topology, and msgr. Synthesize operator-language updates and post them to the progress channel. Never mutate files, never change memberships, never spawn or stop agents, and never take engineering work. This is an operational instruction, not a permission boundary.";
const REPORTER_SUMMARY =
  "Read-only operational observer. Runs continuously and posts synthesized progress updates.";

/** The native lead protocol. Each heading is a stable content anchor. */
export const LEAD_BRIEFING = [
  "MISSION: Coordinate this workspace's agents toward the operator's goal. The goal arrives with this briefing and is the project charter.",
  "COMMUNICATION: Use msgr for all coordination and send completion reports to the workspace channel. A ping is an interruption, not a reassignment. NEVER run another participant's token; message that pane instead.",
  "ASSIGNMENT: Name the assignee, the deliverable, and the authority text in one message. The assignment message is the authorization event. Expect a scope confirmation before the first edit.",
  "CRITERIA FIRST: Do not start a build before its acceptance criteria exist. Write the criteria or have them written, and cite them in the assignment.",
  "VERIFICATION: Give every branch two independent checks: an adversarial read and an execution. A builder's read of its own branch is a report, not a verdict. Reproduce before claiming. Prove a guard by going red on the defect it forbids, then return it to green.",
  "NUMBERS: State every number with its conditions: tree, runtime, and tool. A suite count is a named set, not a running total. Predict counts before the runs that confirm them.",
  "SHARED RESOURCES: Use one browser suite on the machine at a time. Announce claims and releases. The holder grants windows. A guard refusal is information; never route around it.",
  "ESCALATION: A refusal that names a control is a TRADE for whoever owns the risk. Surface it with the cost stated; never spend it silently. Send capability changes to the operator.",
  "STAFFING: Use the roles read and spawn endpoint to staff work per task. Spawn by role per the operator's instructions or freely. You may never prompt a pane. Influence agents by message and by goal.",
].join("\n\n");

/** Product-owned briefings for the default role catalogue. */
export const PLANNER_BRIEFING = [
  "MISSION: Turn the assigned workspace goal into an executable plan. Inspect the relevant repository and msgr context before you propose work.",
  "SCOPE: Produce ordered tasks, acceptance criteria, dependencies, risks, and verification steps. Keep the plan within the assigned goal and report unknowns instead of guessing.",
  "COMMUNICATION: Use msgr for the plan, decisions, assignments, and status. Post the current plan to the workspace channel and update it when scope changes.",
  "CONSTRAINTS: Do not edit product files or claim implementation unless the operator assigns that work. Do not prompt another pane. A plan is not proof that work is complete.",
].join("\n\n");

export const WEB_SEARCHER_BRIEFING = [
  "MISSION: Research external information that the assigned workspace task requires. Search the web with the available tools and use primary sources for technical or time-sensitive claims.",
  "SCOPE: Return only evidence that answers the assigned question. Record source titles, URLs, dates, and the conditions that limit each conclusion. Separate facts from open questions.",
  "COMMUNICATION: Use msgr to share the research request, interim findings, and final evidence. Post a concise result to the workspace channel so other agents can refer to it.",
  "CONSTRAINTS: Do not present an unverified search result as fact. Do not edit product files, change configuration, or widen the research scope without an explicit assignment.",
].join("\n\n");

export const TESTER_BRIEFING = [
  "MISSION: Verify the assigned behavior against its acceptance criteria. Read the relevant code and test setup before you run a check.",
  "SCOPE: Use focused tests, adversarial cases, and an execution that exercises the changed path. Report the exact command, tree or fixture conditions, result, and any reproducible defect.",
  "COMMUNICATION: Use msgr for test claims, failures, retests, and release status. Send the final verification report to the workspace channel with evidence that another agent can repeat.",
  "CONSTRAINTS: Do not treat a builder's report as a test result. Do not change product behavior to make a test pass unless that implementation work is explicitly assigned. Keep test changes within the stated scope.",
].join("\n\n");

export const UI_UX_DESIGNER_BRIEFING = [
  "MISSION: Design and review the user experience for the assigned Sheppard workflow. Use the product definition, approved page contracts, and the complete user task as the design context.",
  "SCOPE: Check information hierarchy, interaction flow, keyboard use, accessibility, responsive behavior, visual consistency, loading states, errors, and recovery. State the user impact of each finding.",
  "COMMUNICATION: Use msgr to share design decisions, screenshots or references, open questions, and review results. Keep the workspace channel as the durable record for the design handoff.",
  "CONSTRAINTS: Do not replace a required control with a decorative change. Do not hide data or actions to fit a layout. Do not edit implementation files unless the operator assigns that work after the design review.",
].join("\n\n");

export const WORKER_BRIEFING = [
  "MISSION: Implement the assigned engineering task in the workspace. Read the task, product definition, existing code, and acceptance criteria before you edit.",
  "SCOPE: Make the smallest complete change that satisfies the assignment. Preserve unrelated work, state assumptions, and stop when the stated scope is complete.",
  "COMMUNICATION: Use msgr for the implementation plan, blockers, handoff, and completion report. Include changed surfaces, verification commands, and any remaining risk in the workspace channel.",
  "CONSTRAINTS: Do not prompt another pane, spend an unassigned control, or silently change the contract. Run independent checks before claiming completion and report failures with their conditions.",
].join("\n\n");

export const DEFAULT_HARNESSES: readonly HarnessConfig[] = Object.freeze(
  ["claude", "codex", "pi", "opencode"].map((name) =>
    Object.freeze({
      name,
      argv: Object.freeze([name]),
      startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
    }),
  ),
);

function parseHarnesses(raw: string | undefined): readonly HarnessConfig[] {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_HARNESSES;

  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => HARNESS_NAME.test(name));
  const unique = [...new Set(names)].sort();
  return unique.length === 0
    ? DEFAULT_HARNESSES
    : unique.map((name) =>
        Object.freeze({
          name,
          argv: Object.freeze([name]),
          startTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
        }),
      );
}

export const DEFAULT_ROLES: readonly RoleConfig[] = Object.freeze([
  Object.freeze({
    name: "lead",
    agentKind: null,
    native: true,
    summary: "Coordinates this workspace's agents toward the operator's goal.",
    briefing: LEAD_BRIEFING,
  }),
  Object.freeze({
    name: "reporter",
    agentKind: null,
    native: true,
    summary: REPORTER_SUMMARY,
    briefing: REPORTER_BRIEFING,
  }),
  Object.freeze({
    name: "planner",
    agentKind: null,
    native: true,
    summary: "Turns a workspace goal into an executable plan with criteria and dependencies.",
    briefing: PLANNER_BRIEFING,
  }),
  Object.freeze({
    name: "web-searcher",
    agentKind: null,
    native: true,
    summary: "Researches external sources and returns verified evidence with references.",
    briefing: WEB_SEARCHER_BRIEFING,
  }),
  Object.freeze({
    name: "tester",
    agentKind: null,
    native: true,
    summary: "Verifies assigned behavior with reproducible checks and reports defects.",
    briefing: TESTER_BRIEFING,
  }),
  Object.freeze({
    name: "ui-ux-designer",
    agentKind: null,
    native: true,
    summary: "Designs and reviews usable, accessible, and consistent user workflows.",
    briefing: UI_UX_DESIGNER_BRIEFING,
  }),
  Object.freeze({
    name: "worker",
    agentKind: null,
    native: true,
    summary: "Implements assigned engineering work and verifies the result.",
    briefing: WORKER_BRIEFING,
  }),
]);

/**
 * Seed parsers accept JSON arrays because a role or model has too many fields
 * for a comma list. A malformed value falls back to the default rather than
 * failing startup: seeds are conveniences, not requirements.
 */
function parseJsonArray(raw: string | undefined): readonly JsonValue[] | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(raw),
    catch: () => null,
  });
  if (parsed.isErr() || !Array.isArray(parsed.value)) return null;
  return parsed.value;
}

function decodeRoleSeed(entry: JsonValue): RoleConfig | null {
  return decodeObject(entry)
    .andThen((object) =>
      Result.gen(function* () {
        const name = yield* requiredString(object, "name");
        if (!HARNESS_NAME.test(name)) yield* validationFailed("name", "is not a valid name");
        const agentKind = yield* optionalString(object, "agentKind");
        const summary = yield* requiredString(object, "summary");
        const briefing = yield* requiredString(object, "briefing");
        const native = yield* optionalBoolean(object, "native", false);
        const launcher = yield* optionalString(object, "launcher");
        const model = yield* optionalString(object, "model");
        const effort = yield* optionalString(object, "effort");
        return Result.ok({ name, agentKind, native, summary, briefing, launcher, model, effort });
      }),
    )
    .match({ ok: (role) => role, err: () => null });
}

function decodeModelSeed(entry: JsonValue): ModelConfig | null {
  return decodeObject(entry)
    .andThen((object) =>
      Result.gen(function* () {
        const harness = yield* requiredString(object, "harness");
        const name = yield* requiredString(object, "name");
        yield* validModelIdentifier(name, "name");
        const kind = yield* requiredString(object, "kind");
        if (kind !== "model" && kind !== "effort") {
          return Result.err(validationFailed("kind", "must be model or effort"));
        }
        const argvSuffix = yield* optionalStringArray(object, "argvSuffix");
        return Result.ok({ harness, name, kind, argvSuffix });
      }),
    )
    .match({ ok: (model) => model, err: () => null });
}

function parseRoleSeeds(raw: string | undefined): readonly RoleConfig[] {
  const entries = parseJsonArray(raw);
  if (entries === null) return DEFAULT_ROLES;
  const roles = entries
    .map(decodeRoleSeed)
    .filter((role): role is RoleConfig => role !== null);
  return roles.length === 0 ? DEFAULT_ROLES : Object.freeze(roles);
}

function parseModelSeeds(raw: string | undefined): readonly ModelConfig[] {
  const entries = parseJsonArray(raw);
  if (entries === null) return [];
  return Object.freeze(
    entries.map(decodeModelSeed).filter((model): model is ModelConfig => model !== null),
  );
}

export function loadConfig(env: Bun.Env = Bun.env): ServerConfig {
  const port = integerFromEnv(env.MSGR_PORT, DEFAULT_PORT);
  return {
    port,
    databasePath: env.MSGR_DB ?? defaultDatabasePath(),
    allowedOrigin: env.MSGR_ORIGIN ?? `http://${HOST}:${port}`,
    // Push needs herdr; without it the hub still serves the poll path.
    pushAvailable: env.HERDR_ENV === "1",
    herdrSocketPath: env.HERDR_SOCKET_PATH ?? null,
    webRoot: env.MSGR_WEB_ROOT ?? join(import.meta.dir, "..", "web", "dist"),
    uploadDirectory: env.MSGR_UPLOAD_DIR ?? defaultUploadDirectory(),
    harnesses: parseHarnesses(env.MSGR_HARNESSES),
    roles: parseRoleSeeds(env.MSGR_ROLES),
    models: parseModelSeeds(env.MSGR_MODELS),
    allowExtraHumans: env.MSGR_ALLOW_EXTRA_HUMANS === "1",
  };
}
