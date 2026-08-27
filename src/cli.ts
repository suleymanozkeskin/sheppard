/**
 * The `msgr` command.
 *
 * Identity comes from `MSGR_TOKEN` in the environment and nowhere else: not a
 * file on disk, not an argument, not a prompt. A spawner provisions a handle and
 * launches the agent with the token already in its process environment, so the
 * secret never appears in command text, shell history, or the pane shell.
 *
 * `read` prints before it acknowledges. If printing succeeds and the
 * acknowledgement is lost, the messages are shown again next time, which wastes a
 * little context; acknowledging first would lose them silently.
 */

import { Result } from "better-result";
import { type ClientError, HubClient, HubRefused, identityMissing } from "./client";
import {
  DEFAULT_PORT,
  HOST,
  defaultDatabasePath,
  loadConfig,
  type ServerConfig,
} from "./config";
import { readLocalControlToken } from "./control-token";
import { operatorMessage } from "./error-copy";
import {
  BODY_PREVIEW_LIMIT,
  escapeForTerminal,
  renderChannels,
  renderDirectConversations,
  renderInbox,
  renderMembers,
  renderMessages,
  renderReceipts,
  renderSearch,
} from "./format";
import { CliHerdr, type HerdrPort } from "./herdr";
import type { JsonValue } from "./json";
import { startHub } from "./server";
import type {
  AddedMember,
  Channel,
  DirectConversation,
  InboxEntry,
  Member,
  Message,
  RemovedMember,
  Route,
  SearchResult,
  ChannelReceipt,
} from "./types";

const USAGE = `msgr — a messenger for agents running inside herdr

  msgr serve                              start the hub
  msgr provision <handle> [--exact]       create an agent identity, print its token once
  msgr spawn <handle> -- <command...>     provision, then launch with the token in the child env
  msgr channels                           list channels
  msgr channels create <name> [--topic T] create a channel
  msgr join <channel>                     join, and bind this pane for delivery
  msgr send <channel> <text> [--file P]   send a message, attaching absolute paths
  msgr dm <handle>[,<handle>...] <text>    send a direct message
  msgr dms                                 list direct conversations
  msgr read <channel>                     print unread and mark it read
  msgr read --all                         the same across every joined channel
  msgr inbox                              unread summary, and how delivery stands
  msgr history <channel> [N] [--full]     recent messages, leaving unread untouched
  msgr search <query> [--channel C]       search message text
  msgr roles                              list open role presets
  msgr roles create <name> [options]      create a role from a Markdown prompt
  msgr roles update <name> [options]      update a custom role
  msgr roles preset <name> [options]      set runtime defaults for any role
  msgr harnesses                          list supported harnesses
  msgr launchers                          list launcher names and harnesses
  msgr models                             list model and effort names per harness
  msgr models refresh [launcher]          refresh device model catalogues
  msgr seen <channel>                     show member cursors and route state
  msgr members <channel>                  who is in a channel
  msgr members add <channel> <handle>     add a participant
  msgr members remove <channel> <handle>  remove a participant
  msgr participants remove <handle>       deactivate a participant

  --json                                  print raw responses instead of text

Environment: MSGR_URL, MSGR_TOKEN, MSGR_HANDLE, MSGR_PORT, MSGR_DB`;

export interface CliEnvironment {
  MSGR_URL?: string | undefined;
  MSGR_TOKEN?: string | undefined;
  MSGR_HANDLE?: string | undefined;
  HERDR_ENV?: string | undefined;
  HERDR_SOCKET_PATH?: string | undefined;
  MSGR_DB?: string | undefined;
}

export interface CliDeps {
  argv: readonly string[];
  env: CliEnvironment;
  write: (line: string) => void;
  fail: (line: string) => void;
  /** Null when not running inside herdr, so no route is reported. */
  herdr: HerdrPort | null;
  /** Injected so tests can observe a launch without starting a real agent. */
  launch?: (command: readonly string[], handle: string, token: string) => Promise<number>;
  /** The standalone launcher supplies embedded web assets on the serve path. */
  serverConfig?: ServerConfig;
  /** Local configuration capability. It is separate from participant identity. */
  localControlToken: string | null;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** Flags are separated from positionals before dispatch; `--` ends parsing. */
interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
  rest: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const rest: string[] = [];

  let afterSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (afterSeparator) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    // A flag takes the following token as its value only when that token is not
    // itself a flag, so `--full` and `--topic notes` both parse correctly.
    if (VALUED_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
      continue;
    }
    // Repeated valued flags accumulate through a separate list.
    flags.set(name, true);
  }

  return { positional, flags, rest };
}

const VALUED_FLAGS = new Set([
  "topic",
  "channel",
  "file",
  "summary",
  "prompt-file",
  "harness",
  "launcher",
  "model",
  "effort",
]);

/** `--file` may be repeated, so it is collected in order rather than overwritten. */
function collectRepeated(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== `--${name}`) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function jsonOf(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

// ------------------------------------------------------------------- responses

interface CreatedAgent {
  handle: string;
  token: string;
}

interface JoinedChannel {
  channel: string;
  cursorId: number;
}

interface FetchedMessages {
  messages: Message[];
  throughId: number;
}

interface MessageList {
  messages: Message[];
}

interface ChannelList {
  channels: Channel[];
}

interface DirectResult {
  channel: string;
  messageId: number;
}

interface DirectList {
  conversations: DirectConversation[];
}

interface MemberList {
  members: Member[];
}

type MemberChange = AddedMember | RemovedMember;

interface ParticipantChange {
  handle: string;
}

interface InboxList {
  entries: InboxEntry[];
}

interface SearchList {
  results: SearchResult[];
}

interface RolePresetResponse {
  name: string;
  agentKind: string | null;
  native: boolean;
  summary: string;
  launcher: string | null;
  model: string | null;
  effort: string | null;
}

interface RoleListResponse {
  roles: RolePresetResponse[];
}

interface RoleDetailResponse extends RolePresetResponse {
  briefing: string;
}

interface RoleRuntimeValues {
  agentKind: string | null;
  launcher: string | null;
  model: string | null;
  effort: string | null;
}

interface CatalogueEffortResponse {
  name: string;
  description: string;
  default: boolean;
}

interface CatalogueModelResponse {
  name: string;
  label: string;
  description: string;
  default: boolean;
  efforts: CatalogueEffortResponse[];
}

interface LauncherCatalogueResponse {
  launcher: string;
  harness: string;
  status: string;
  executableAvailable: boolean | null;
  models: CatalogueModelResponse[];
  error: string | null;
}

interface ModelCatalogueResponse {
  catalogues: LauncherCatalogueResponse[];
}

interface HarnessListResponse {
  harnesses: string[];
}

// -------------------------------------------------------------------- context

interface Context {
  deps: CliDeps;
  args: ParsedArgs;
  client: HubClient;
  json: boolean;
  readBatchResults: ReadResult[] | null;
  jsonFailureReported: boolean;
}

interface ReadResult {
  channel: string;
  messages: Message[];
  throughId: number;
}

interface FailureValues {
  channel?: string;
  handle?: string;
  role?: string;
}

function valueFor(failure: HubRefused, values: FailureValues): string | undefined {
  switch (failure.cause) {
    case "ChannelExists":
    case "ChannelNotFound":
      return values.channel;
    case "HandleTaken":
    case "MembershipExists":
      return values.handle;
    case "RoleExists":
      return values.role;
    case "NotFound":
      switch (failure.operation) {
        case "addMember":
        case "removeMember":
        case "deactivateParticipant":
          return values.handle;
        case "acknowledge":
        case "attachmentContent":
        case "broadcastWorkspace":
        case "closeWorkspace":
        case "context":
        case "createAgent":
        case "createChannel":
        case "createDirect":
        case "createHuman":
        case "createWorkspace":
        case "inbox":
        case "joinChannel":
        case "listChannels":
        case "listDirect":
        case "listMembers":
        case "listModels":
        case "refreshModels":
        case "listLaunchers":
        case "listHarnesses":
        case "listReceipts":
        case "listRoles":
        case "listMessages":
        case "listParticipants":
        case "listWorkspaces":
        case "search":
        case "sendMessage":
        case "uploadFile":
          return undefined;
        case "createRole":
        case "readRole":
        case "updateRole":
        case "updateRoleRuntime":
          return values.role;
      }
    case "DirectMembershipLocked":
    case "HerdrCallFailed":
    case "HerdrNotConfigured":
    case "HerdrSessionMismatch":
    case "HerdrUnavailable":
    case "NotPreviewable":
    case "RequestRejected":
    case "Unauthorized":
    case "Undecodable":
    case "Unclassified":
    case "Unreachable":
    case "UploadStorageFailed":
    case "ValidationFailed":
      return undefined;
    case "NotAMember":
      return values.channel;
  }
}

function jsonError(error: ClientError): string {
  return error.match({
    HubUnreachable: (failure) => JSON.stringify({ error: failure.message, code: "Unreachable" }),
    HubRefused: (failure) =>
      JSON.stringify({ error: failure.detail ?? failure.message, code: failure.cause }),
    IdentityMissing: (failure) => JSON.stringify({ error: failure.message, code: "IdentityMissing" }),
    LocalControlMissing: (failure) =>
      JSON.stringify({ error: failure.message, code: "LocalControlMissing" }),
  });
}

function report(context: Context, error: ClientError, values: FailureValues = {}): number {
  if (context.json) {
    if (!context.jsonFailureReported) {
      context.deps.write(jsonError(error));
      context.jsonFailureReported = true;
    }
    return EXIT_FAILED;
  }

  const message = error.match({
    HubUnreachable: (failure) =>
      operatorMessage({
        operation: failure.operation,
        cause: "Unreachable",
        detail: undefined,
        value: undefined,
      }, "cli"),
    HubRefused: (failure) =>
      operatorMessage({
        operation: failure.operation,
        cause: failure.cause,
        detail: failure.detail,
        value: valueFor(failure, values),
      }, "cli"),
    IdentityMissing: (failure) => ({ title: failure.message, action: undefined }),
    LocalControlMissing: (failure) => ({ title: failure.message, action: undefined }),
  });
  context.deps.fail(message.title);
  if (message.action !== undefined) context.deps.fail(message.action);
  return EXIT_FAILED;
}

function emit(context: Context, lines: readonly string[]): number {
  for (const line of lines) context.deps.write(line);
  return EXIT_OK;
}

/**
 * Resolves the pane the caller is in. A failure here is not fatal: the command
 * still runs, only without refreshing where delivery should go.
 */
async function resolveRoute(herdr: HerdrPort | null): Promise<Route | null> {
  if (herdr === null) return null;
  const current = await herdr.paneCurrent();
  return current.match({
    ok: (pane) => ({
      terminalId: pane.terminalId,
      paneId: pane.paneId,
      occupantAgent: pane.agent,
    }),
    err: () => null,
  });
}

interface BoundAgentResponse {
  handle: string | null;
}

async function resolveBoundHandle(baseUrl: string, route: Route | null): Promise<string | null> {
  if (route === null) return null;
  const bootstrap = new HubClient({
    baseUrl,
    token: null,
    localControlToken: null,
    route: null,
    herdrSocketPath: null,
  });
  const identity = await bootstrap.get<BoundAgentResponse>(
    "listParticipants",
    `/api/herdr/agents/${encodeURIComponent(route.paneId)}`,
    false,
  );
  return identity.match({
    ok: (response) => response.handle,
    err: () => null,
  });
}

// ------------------------------------------------------------------- commands

async function commandServe(context: Context): Promise<number> {
  const config = context.deps.serverConfig ?? loadConfig();
  const started = startHub(config);
  if (started.isErr()) {
    context.deps.fail(started.error.message);
    return EXIT_FAILED;
  }

  const hub = started.value;
  context.deps.write(`msgr hub listening on http://${HOST}:${hub.port}`);
  context.deps.write(`database ${config.databasePath}`);
  context.deps.write(
    hub.notifier === null
      ? "push disabled (not running inside herdr); agents poll with `msgr inbox`"
      : "push enabled",
  );

  const shutdown = (): void => {
    hub.stop();
    process.exit(EXIT_OK);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Nothing further to do on this path: the server owns the process from here.
  await new Promise<void>(() => undefined);
  return EXIT_OK;
}

async function commandProvision(context: Context): Promise<number> {
  const handle = context.args.positional[1];
  if (handle === undefined) {
    context.deps.fail("Usage: msgr provision <handle> [--exact]");
    return EXIT_USAGE;
  }

  const created = await context.client.post<CreatedAgent>(
    "createAgent",
    "/api/agents",
    { handle, exact: context.args.flags.has("exact") },
    false,
  );

  return created.match({
    ok: (agent) => {
      if (context.json) return emit(context, [jsonOf({ ...agent })]);
      if (agent.handle !== handle) {
        context.deps.write(`Handle "${handle}" was taken; assigned "${agent.handle}".`);
      }
      return emit(context, [
        `handle ${agent.handle}`,
        `token  ${agent.token}`,
        "",
        "This token is shown once and cannot be reissued. Launch the agent with it:",
        `  MSGR_HANDLE=${agent.handle} MSGR_TOKEN=<token> <command>`,
        "or let msgr do it without the token touching your shell:",
        `  msgr spawn ${handle} -- <command...>`,
      ]);
    },
    err: (error) => report(context, error, { handle }),
  });
}

/**
 * Provisions and launches in one step so the token exists only in the child's
 * environment. A token supplied on stdin is reused instead, which lets a caller
 * relaunch an existing identity without minting a second one.
 */
async function commandSpawn(context: Context): Promise<number> {
  const handle = context.args.positional[1];
  const command = context.args.rest;
  if (handle === undefined || command.length === 0) {
    context.deps.fail("Usage: msgr spawn <handle> -- <command...>");
    return EXIT_USAGE;
  }

  const piped = await readPipedToken();
  const identity =
    piped === null
      ? await context.client.post<CreatedAgent>("createAgent", "/api/agents", { handle }, false)
      : Result.ok<CreatedAgent>({ handle, token: piped });

  if (identity.isErr()) return report(context, identity.error, { handle });

  const agent = identity.value;
  if (agent.handle !== handle) {
    context.deps.write(`Handle "${handle}" was taken; launching as "${agent.handle}".`);
  }

  const launch = context.deps.launch ?? launchProcess;
  return launch(command, agent.handle, agent.token);
}

/** How long to wait for a token on stdin before deciding none is coming. */
const STDIN_GRACE_MS = 200;

/**
 * Only a piped token is read; an interactive terminal is left alone. The read is
 * bounded because stdin may be an open pipe that never carries anything — a
 * launcher run inside a shell pipeline, say — and waiting forever there would
 * hang the launch instead of provisioning a fresh identity.
 */
async function readPipedToken(): Promise<string | null> {
  if (process.stdin.isTTY === true) return null;

  const read = Result.tryPromise({
    try: () => new Response(Bun.stdin.stream()).text(),
    catch: () => null,
  }).then((result) => result.unwrapOr(""));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_GRACE_MS);
  });

  try {
    const piped = await Promise.race([read, grace]);
    const trimmed = piped.trim();
    return trimmed.length === 0 ? null : trimmed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The token is placed in the child's environment and nowhere else. It is absent
 * from the argument list, so it cannot appear in a process listing.
 */
async function launchProcess(
  command: readonly string[],
  handle: string,
  token: string,
): Promise<number> {
  const child = Bun.spawn({
    cmd: [...command],
    env: { ...process.env, MSGR_HANDLE: handle, MSGR_TOKEN: token },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

async function commandChannels(context: Context): Promise<number> {
  const action = context.args.positional[1];

  if (action === "create") {
    const name = context.args.positional[2];
    if (name === undefined) {
      context.deps.fail("Usage: msgr channels create <name> [--topic <topic>]");
      return EXIT_USAGE;
    }
    const topic = context.args.flags.get("topic");
    const created = await context.client.post<Channel>(
      "createChannel",
      "/api/channels",
      { name, topic: topic === undefined || topic === true ? null : topic },
      true,
    );
    return created.match({
      ok: (channel) =>
        context.json
          ? emit(context, [jsonOf({ ...channel })])
          : emit(context, [`created #${escapeForTerminal(channel.name)}`]),
      err: (error) => report(context, error, { channel: name }),
    });
  }

  const listed = await context.client.get<ChannelList>("listChannels", "/api/channels", false);
  return listed.match({
    ok: (list) =>
      context.json
        ? emit(context, [jsonOf({ channels: list.channels })])
        : emit(context, renderChannels(list.channels)),
    err: (error) => report(context, error),
  });
}

async function commandJoin(context: Context): Promise<number> {
  const channel = context.args.positional[1];
  if (channel === undefined) {
    context.deps.fail("Usage: msgr join <channel>");
    return EXIT_USAGE;
  }

  const joined = await context.client.post<JoinedChannel>(
    "joinChannel",
    `/api/channels/${encodeURIComponent(channel)}/join`,
    {},
    true,
  );
  return joined.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf({ ...result })])
        : emit(context, [`joined #${escapeForTerminal(result.channel)}`]),
    err: (error) => report(context, error, { channel }),
  });
}

async function commandSend(context: Context): Promise<number> {
  const channel = context.args.positional[1];
  const text = context.args.positional.slice(2).join(" ");
  if (channel === undefined || text.length === 0) {
    context.deps.fail("Usage: msgr send <channel> <text> [--file /absolute/path]...");
    return EXIT_USAGE;
  }

  const attachments = collectRepeated(context.deps.argv, "file");
  const sent = await context.client.post<Message>(
    "sendMessage",
    `/api/channels/${encodeURIComponent(channel)}/messages`,
    { body: text, attachments },
    true,
  );
  return sent.match({
    ok: (message) =>
      context.json
        ? emit(context, [jsonOf({ ...message })])
        : emit(context, [
            `sent to #${escapeForTerminal(message.channel)} as ${escapeForTerminal(message.sender)} [${message.id}]`,
          ]),
    err: (error) => report(context, error, { channel }),
  });
}

async function commandDirectMessage(context: Context): Promise<number> {
  const rawRecipients = context.args.positional[1];
  const text = context.args.positional.slice(2).join(" ");
  if (rawRecipients === undefined || text.length === 0) {
    context.deps.fail("Usage: msgr dm <handle>[,<handle>...] <text> [--file /absolute/path]...");
    return EXIT_USAGE;
  }

  const recipients = rawRecipients.split(",").map((handle) => handle.trim());
  if (recipients.some((handle) => handle.length === 0)) {
    context.deps.fail("Usage: msgr dm <handle>[,<handle>...] <text> [--file /absolute/path]...");
    return EXIT_USAGE;
  }

  const sent = await context.client.post<DirectResult>(
    "createDirect",
    "/api/direct",
    { to: recipients, body: text, attachments: collectRepeated(context.deps.argv, "file") },
    true,
  );
  return sent.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf({ ...result })])
        : emit(context, [`sent direct to #${escapeForTerminal(result.channel)} [${result.messageId}]`]),
    err: (error) => report(context, error),
  });
}

async function commandDirectList(context: Context): Promise<number> {
  const listed = await context.client.get<DirectList>("listDirect", "/api/direct", true);
  return listed.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf({ conversations: result.conversations })])
        : emit(context, renderDirectConversations(result.conversations)),
    err: (error) => report(context, error),
  });
}

/** Prints first, then acknowledges exactly what was printed. */
async function readOneChannel(context: Context, channel: string): Promise<number> {
  const fetched = await context.client.post<FetchedMessages>(
    "listMessages",
    `/api/channels/${encodeURIComponent(channel)}/fetch`,
    {},
    true,
  );
  if (fetched.isErr()) return report(context, fetched.error, { channel });

  const { messages, throughId } = fetched.value;
  const result = { channel, messages, throughId };
  if (!context.json) {
    const header =
      messages.length === 0
        ? `#${escapeForTerminal(channel)}  nothing new`
        : `#${escapeForTerminal(channel)}  ${messages.length} new`;
    emit(context, renderMessages(header, messages, false));
  }

  if (messages.length === 0) {
    if (context.json) {
      if (context.readBatchResults === null) context.deps.write(jsonOf(result));
      else context.readBatchResults.push(result);
    }
    return EXIT_OK;
  }

  const acked = await context.client.post<{ cursorId: number }>(
    "acknowledge",
    `/api/channels/${encodeURIComponent(channel)}/ack`,
    { throughId },
    true,
  );
  return acked.match({
    ok: () => {
      if (context.json) {
        if (context.readBatchResults === null) context.deps.write(jsonOf(result));
        else context.readBatchResults.push(result);
      }
      return EXIT_OK;
    },
    err: (error) => report(context, error, { channel }),
  });
}

async function commandRead(context: Context): Promise<number> {
  if (context.args.flags.has("all")) {
    context.readBatchResults = context.json ? [] : null;
    const inbox = await context.client.get<InboxList>("inbox", "/api/inbox", true);
    if (inbox.isErr()) return report(context, inbox.error);

    const waiting = inbox.value.entries.filter((entry) => entry.unread > 0);
    if (waiting.length === 0) {
      return emit(context, context.json ? [jsonOf({ channels: [] })] : ["Nothing new anywhere."]);
    }

    let status = EXIT_OK;
    for (const entry of waiting) {
      const outcome = await readOneChannel(context, entry.channel);
      if (outcome !== EXIT_OK) status = outcome;
    }
    if (context.json && status === EXIT_OK) {
      emit(context, [jsonOf({ channels: context.readBatchResults ?? [] })]);
    }
    return status;
  }

  const channel = context.args.positional[1];
  if (channel === undefined) {
    context.deps.fail("Usage: msgr read <channel>   (or: msgr read --all)");
    return EXIT_USAGE;
  }
  return readOneChannel(context, channel);
}

async function commandInbox(context: Context): Promise<number> {
  const inbox = await context.client.get<InboxList>("inbox", "/api/inbox", true);
  return inbox.match({
    ok: (list) =>
      context.json
        ? emit(context, [jsonOf({ entries: list.entries })])
        : emit(context, renderInbox(list.entries)),
    err: (error) => report(context, error),
  });
}

async function commandHistory(context: Context): Promise<number> {
  const channel = context.args.positional[1];
  if (channel === undefined) {
    context.deps.fail("Usage: msgr history <channel> [count] [--full]");
    return EXIT_USAGE;
  }

  const requested = context.args.positional[2];
  const limit = requested === undefined ? null : Number(requested);
  if (limit !== null && !Number.isInteger(limit)) {
    context.deps.fail("The count must be a whole number.");
    return EXIT_USAGE;
  }

  const query = limit === null ? "" : `?limit=${limit}`;
  const listed = await context.client.get<MessageList>(
    "listMessages",
    `/api/channels/${encodeURIComponent(channel)}/messages${query}`,
    false,
  );
  return listed.match({
    ok: (list) =>
      context.json
        ? emit(context, [jsonOf({ messages: list.messages })])
        : emit(
            context,
            renderMessages(
              `#${escapeForTerminal(channel)}  ${list.messages.length} shown`,
              list.messages,
              context.args.flags.has("full"),
            ),
          ),
    err: (error) => report(context, error, { channel }),
  });
}

async function commandSearch(context: Context): Promise<number> {
  const query = context.args.positional[1];
  if (query === undefined) {
    context.deps.fail("Usage: msgr search <query> [--channel <channel>]");
    return EXIT_USAGE;
  }

  const channel = context.args.flags.get("channel");
  const scope = channel === undefined || channel === true ? "" : `&channel=${encodeURIComponent(channel)}`;
  const found = await context.client.get<SearchList>(
    "search",
    `/api/search?q=${encodeURIComponent(query)}${scope}`,
    false,
  );
  return found.match({
    ok: (list) =>
      context.json
        ? emit(context, [jsonOf({ results: list.results })])
        : emit(context, renderSearch(list.results)),
    err: (error) => report(context, error, {
      channel: channel === undefined || channel === true ? undefined : channel,
    }),
  });
}

function renderRoles(roles: readonly RolePresetResponse[]): string[] {
  if (roles.length === 0) return ["No roles available."];

  return roles.flatMap((role) => {
    const harness = role.agentKind === null ? "any" : escapeForTerminal(role.agentKind);
    const launcher = role.launcher === null ? "default" : escapeForTerminal(role.launcher);
    const model = role.model === null ? "default" : escapeForTerminal(role.model);
    const effort = role.effort === null ? "default" : escapeForTerminal(role.effort);
    return [
      `${escapeForTerminal(role.name)}  ${role.native ? "native" : "custom"}  harness ${harness}  launcher ${launcher}  model ${model}  effort ${effort}`,
      `  ${escapeForTerminal(role.summary)}`,
    ];
  });
}

function renderModels(catalogues: readonly LauncherCatalogueResponse[]): string[] {
  if (catalogues.length === 0) return ["No launcher catalogues available."];

  return catalogues.flatMap((catalogue) => {
    const heading = `${escapeForTerminal(catalogue.launcher)}  harness ${escapeForTerminal(catalogue.harness)}  ${escapeForTerminal(catalogue.status)}`;
    if (catalogue.models.length === 0) {
      return [
        heading,
        `  ${escapeForTerminal(catalogue.error ?? "No models available.")}`,
      ];
    }
    return [
      heading,
      ...catalogue.models.map((model) => {
        const efforts = model.efforts
          .map((effort) => `${escapeForTerminal(effort.name)}${effort.default ? "*" : ""}`)
          .join(", ");
        return `  ${escapeForTerminal(model.name)}${model.default ? "*" : ""}  efforts ${efforts}`;
      }),
    ];
  });
}

function roleFlag(context: Context, name: string): string | undefined | null {
  const value = context.args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) {
    context.deps.fail(`--${name} requires a value.`);
    return null;
  }
  return value;
}

async function readRolePrompt(context: Context, path: string): Promise<string | null> {
  const read = await Result.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => null,
  });
  if (read.isErr()) {
    context.deps.fail(`Cannot read the prompt file "${escapeForTerminal(path)}".`);
    return null;
  }
  const briefing = read.value.trim();
  if (briefing.length === 0) {
    context.deps.fail(`The prompt file "${escapeForTerminal(path)}" is empty.`);
    return null;
  }
  return briefing;
}

const ROLE_RUNTIME_FLAGS = [
  { clear: "clear-harness", field: "agentKind", value: "harness" },
  { clear: "clear-launcher", field: "launcher", value: "launcher" },
  { clear: "clear-model", field: "model", value: "model" },
  { clear: "clear-effort", field: "effort", value: "effort" },
] as const;

function hasRoleRuntimeFlags(context: Context): boolean {
  return context.args.flags.has("clear") || ROLE_RUNTIME_FLAGS.some(
    (option) => context.args.flags.has(option.value) || context.args.flags.has(option.clear),
  );
}

function roleRuntimeFromFlags(
  context: Context,
  current: RoleRuntimeValues,
): RoleRuntimeValues | null {
  const hasClearAll = context.args.flags.has("clear");
  const hasOtherRuntimeFlag = ROLE_RUNTIME_FLAGS.some(
    (option) => context.args.flags.has(option.value) || context.args.flags.has(option.clear),
  );
  if (hasClearAll && hasOtherRuntimeFlag) {
    context.deps.fail("--clear cannot be combined with another runtime preset flag.");
    return null;
  }

  const next: RoleRuntimeValues = hasClearAll
    ? { agentKind: null, effort: null, launcher: null, model: null }
    : { ...current };

  for (const option of ROLE_RUNTIME_FLAGS) {
    const value = roleFlag(context, option.value);
    if (value === null) return null;
    if (value !== undefined && context.args.flags.has(option.clear)) {
      context.deps.fail(`--${option.value} cannot be combined with --${option.clear}.`);
      return null;
    }
    if (value !== undefined) next[option.field] = value;
    if (context.args.flags.has(option.clear)) next[option.field] = null;
  }
  return next;
}

function emitChangedRole(
  context: Context,
  action: "created" | "updated",
  role: RolePresetResponse,
): number {
  return context.json
    ? emit(context, [jsonOf(role)])
    : emit(context, [`${action} ${escapeForTerminal(role.name)}`, ...renderRoles([role])]);
}

async function listRoles(context: Context): Promise<number> {
  const listed = await context.client.get<RoleListResponse>("listRoles", "/api/herdr/roles", false);
  return listed.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf({ roles: result.roles })])
        : emit(context, renderRoles(result.roles)),
    err: (error) => report(context, error),
  });
}

async function createRole(context: Context, name: string): Promise<number> {
  const summary = roleFlag(context, "summary");
  const promptPath = roleFlag(context, "prompt-file");
  if (summary === null || promptPath === null) return EXIT_USAGE;
  if (summary === undefined || promptPath === undefined) {
    context.deps.fail(
      "Usage: msgr roles create <name> --summary <text> --prompt-file <path> [runtime options]",
    );
    return EXIT_USAGE;
  }
  if (ROLE_RUNTIME_FLAGS.some((option) => context.args.flags.has(option.clear)) || context.args.flags.has("clear")) {
    context.deps.fail("Clear flags apply only to an existing role preset.");
    return EXIT_USAGE;
  }

  const briefing = await readRolePrompt(context, promptPath);
  if (briefing === null) return EXIT_FAILED;
  const runtime = roleRuntimeFromFlags(context, {
    agentKind: null,
    effort: null,
    launcher: null,
    model: null,
  });
  if (runtime === null) return EXIT_USAGE;

  const created = await context.client.controlPost<RolePresetResponse>(
    "createRole",
    "/api/herdr/roles",
    { name, summary, briefing, ...runtime },
  );
  return created.match({
    ok: (role) => emitChangedRole(context, "created", role),
    err: (error) => report(context, error, { role: name }),
  });
}

async function updateRole(context: Context, name: string): Promise<number> {
  const summary = roleFlag(context, "summary");
  const promptPath = roleFlag(context, "prompt-file");
  if (summary === null || promptPath === null) return EXIT_USAGE;
  if (summary === undefined && promptPath === undefined && !hasRoleRuntimeFlags(context)) {
    context.deps.fail(
      "Usage: msgr roles update <name> [--summary <text>] [--prompt-file <path>] [runtime options]",
    );
    return EXIT_USAGE;
  }

  const briefing = promptPath === undefined ? undefined : await readRolePrompt(context, promptPath);
  if (briefing === null) return EXIT_FAILED;
  const loaded = await context.client.controlGet<RoleDetailResponse>(
    "readRole",
    `/api/herdr/roles/${encodeURIComponent(name)}`,
  );
  if (loaded.isErr()) return report(context, loaded.error, { role: name });
  if (loaded.value.native) {
    context.deps.fail(
      "Built-in role instructions are read-only. Use `msgr roles preset` to change runtime defaults.",
    );
    return EXIT_FAILED;
  }

  const runtime = roleRuntimeFromFlags(context, loaded.value);
  if (runtime === null) return EXIT_USAGE;
  const updated = await context.client.controlPut<RolePresetResponse>(
    "updateRole",
    `/api/herdr/roles/${encodeURIComponent(name)}`,
    {
      summary: summary ?? loaded.value.summary,
      briefing: briefing ?? loaded.value.briefing,
      ...runtime,
    },
  );
  return updated.match({
    ok: (role) => emitChangedRole(context, "updated", role),
    err: (error) => report(context, error, { role: name }),
  });
}

async function updateRolePreset(context: Context, name: string): Promise<number> {
  if (!hasRoleRuntimeFlags(context)) {
    context.deps.fail("Usage: msgr roles preset <name> [runtime options]");
    return EXIT_USAGE;
  }

  const loaded = await context.client.controlGet<RoleDetailResponse>(
    "readRole",
    `/api/herdr/roles/${encodeURIComponent(name)}`,
  );
  if (loaded.isErr()) return report(context, loaded.error, { role: name });
  const runtime = roleRuntimeFromFlags(context, loaded.value);
  if (runtime === null) return EXIT_USAGE;
  const updated = await context.client.controlPut<RolePresetResponse>(
    "updateRoleRuntime",
    `/api/herdr/roles/${encodeURIComponent(name)}/runtime`,
    runtime,
  );
  return updated.match({
    ok: (role) => emitChangedRole(context, "updated", role),
    err: (error) => report(context, error, { role: name }),
  });
}

async function commandRoles(context: Context): Promise<number> {
  const action = context.args.positional[1];
  if (action === undefined) return listRoles(context);

  const name = context.args.positional[2];
  if (name === undefined) {
    context.deps.fail(`Usage: msgr roles ${escapeForTerminal(action)} <name> [options]`);
    return EXIT_USAGE;
  }
  switch (action) {
    case "create":
      return createRole(context, name);
    case "update":
      return updateRole(context, name);
    case "preset":
      return updateRolePreset(context, name);
    default:
      context.deps.fail(`Unknown roles action "${escapeForTerminal(action)}".`);
      return EXIT_USAGE;
  }
}

function emitModelCatalogues(context: Context, result: ModelCatalogueResponse): number {
  return context.json
    ? emit(context, [jsonOf({ catalogues: result.catalogues })])
    : emit(context, renderModels(result.catalogues));
}

async function commandModels(context: Context): Promise<number> {
  const action = context.args.positional[1];
  if (action === undefined) {
    const listed = await context.client.get<ModelCatalogueResponse>(
      "listModels",
      "/api/herdr/model-catalogue",
      false,
    );
    return listed.match({
      ok: (result) => emitModelCatalogues(context, result),
      err: (error) => report(context, error),
    });
  }
  if (action !== "refresh") {
    context.deps.fail(`Unknown models action "${escapeForTerminal(action)}".`);
    return EXIT_USAGE;
  }

  const launcher = context.args.positional[2];
  const refreshed = await context.client.post<ModelCatalogueResponse>(
    "refreshModels",
    "/api/herdr/model-catalogue",
    launcher === undefined ? {} : { launcher },
    false,
  );
  return refreshed.match({
    ok: (result) => emitModelCatalogues(context, result),
    err: (error) => report(context, error),
  });
}

async function commandLaunchers(context: Context): Promise<number> {
  const listed = await context.client.get<ModelCatalogueResponse>(
    "listLaunchers",
    "/api/herdr/model-catalogue",
    false,
  );
  return listed.match({
    ok: (result) =>
      context.json
        ? emit(context, [
            jsonOf({
              launchers: result.catalogues.map((catalogue) => ({
                name: catalogue.launcher,
                harness: catalogue.harness,
              })),
            }),
          ])
        : emit(
            context,
            result.catalogues.length === 0
              ? ["No launchers registered."]
              : result.catalogues.map(
                  (catalogue) =>
                    `${escapeForTerminal(catalogue.launcher)}  harness ${escapeForTerminal(catalogue.harness)}`,
                ),
          ),
    err: (error) => report(context, error),
  });
}

async function commandHarnesses(context: Context): Promise<number> {
  const listed = await context.client.get<HarnessListResponse>(
    "listHarnesses",
    "/api/herdr/harnesses",
    false,
  );
  return listed.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf({ harnesses: result.harnesses })])
        : emit(
            context,
            result.harnesses.length === 0
              ? ["No harnesses supported."]
              : result.harnesses.map((harness) => escapeForTerminal(harness)),
          ),
    err: (error) => report(context, error),
  });
}

async function commandMembers(context: Context): Promise<number> {
  const action = context.args.positional[1];
  switch (action) {
    case "add":
    case "remove": {
      const channel = context.args.positional[2];
      const handle = context.args.positional[3];
      if (channel === undefined || handle === undefined) {
        context.deps.fail(`Usage: msgr members ${action} <channel> <handle>`);
        return EXIT_USAGE;
      }

      const path = `/api/channels/${encodeURIComponent(channel)}/members`;
      const changed =
        action === "add"
          ? await context.client.post<MemberChange>("addMember", path, { handle }, true)
          : await context.client.delete<MemberChange>(
              "removeMember",
              `${path}/${encodeURIComponent(handle)}`,
              true,
            );
      return changed.match({
        ok: (result) =>
          context.json
            ? emit(context, [jsonOf({ ...result })])
            : emit(
                context,
                [
                  `${action === "add" ? "added" : "removed"} ${escapeForTerminal(handle)} ${action === "add" ? "to" : "from"} #${escapeForTerminal(channel)}`,
                ],
              ),
        err: (error) => report(context, error, { channel, handle }),
      });
    }
    default:
      break;
  }

  const channel = action;
  if (channel === undefined) {
    context.deps.fail("Usage: msgr members <channel>");
    return EXIT_USAGE;
  }

  const listed = await context.client.get<MemberList>(
    "listMembers",
    `/api/channels/${encodeURIComponent(channel)}/members`,
    false,
  );
  return listed.match({
    ok: (list) =>
      context.json
        ? emit(context, [jsonOf({ members: list.members })])
        : emit(context, renderMembers(list.members)),
    err: (error) => report(context, error, { channel }),
  });
}

async function commandSeen(context: Context): Promise<number> {
  const channel = context.args.positional[1];
  if (channel === undefined) {
    context.deps.fail("Usage: msgr seen <channel>");
    return EXIT_USAGE;
  }

  const listed = await context.client.get<ChannelReceipt[]>(
    "listReceipts",
    `/api/channels/${encodeURIComponent(channel)}/receipts`,
    true,
  );
  return listed.match({
    ok: (receipts) =>
      context.json
        ? emit(context, [jsonOf(receipts)])
        : emit(context, renderReceipts(receipts)),
    err: (error) => report(context, error, { channel }),
  });
}

async function commandParticipants(context: Context): Promise<number> {
  const action = context.args.positional[1];
  const handle = context.args.positional[2];
  if (action !== "remove" || handle === undefined) {
    context.deps.fail("Usage: msgr participants remove <handle>");
    return EXIT_USAGE;
  }

  const changed = await context.client.delete<ParticipantChange>(
    "deactivateParticipant",
    `/api/participants/${encodeURIComponent(handle)}`,
    true,
  );
  return changed.match({
    ok: (result) =>
      context.json
        ? emit(context, [jsonOf(result)])
        : emit(context, [`deactivated ${escapeForTerminal(result.handle)}`]),
    err: (error) => report(context, error, { handle }),
  });
}

// ------------------------------------------------------------------- dispatch

export async function runCli(deps: CliDeps): Promise<number> {
  const args = parseArgs(deps.argv);
  const command = args.positional[0];

  if (command === undefined || command === "help") {
    deps.write(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }

  // `serve` starts the hub in this process and needs no client of its own.
  if (command === "serve") {
    const context: Context = {
      deps,
      args,
      client: new HubClient({
        baseUrl: baseUrlFrom(deps.env),
        token: null,
        localControlToken: null,
        route: null,
        herdrSocketPath: null,
      }),
      json: args.flags.has("json"),
      readBatchResults: null,
      jsonFailureReported: false,
    };
    return commandServe(context);
  }

  const baseUrl = baseUrlFrom(deps.env);
  const token = deps.env.MSGR_TOKEN ?? null;
  const route = await resolveRoute(deps.herdr);
  const boundHandle = token === null ? await resolveBoundHandle(baseUrl, route) : null;
  const context: Context = {
    deps,
    args,
    client: new HubClient({
      baseUrl,
      token,
      localControlToken: deps.localControlToken,
      route,
      herdrSocketPath: deps.env.HERDR_SOCKET_PATH ?? null,
      boundHandle,
    }),
    json: args.flags.has("json"),
    readBatchResults: null,
    jsonFailureReported: false,
  };

  switch (command) {
    case "provision":
      return commandProvision(context);
    case "spawn":
      return commandSpawn(context);
    case "channels":
      return commandChannels(context);
    case "join":
      return commandJoin(context);
    case "send":
      return commandSend(context);
    case "dm":
      return commandDirectMessage(context);
    case "dms":
      return commandDirectList(context);
    case "read":
      return commandRead(context);
    case "inbox":
      return commandInbox(context);
    case "history":
      return commandHistory(context);
    case "search":
      return commandSearch(context);
    case "roles":
      return commandRoles(context);
    case "harnesses":
      return commandHarnesses(context);
    case "launchers":
      return commandLaunchers(context);
    case "models":
      return commandModels(context);
    case "members":
      return commandMembers(context);
    case "seen":
      return commandSeen(context);
    case "participants":
      return commandParticipants(context);
    default:
      deps.fail(`Unknown command "${escapeForTerminal(command)}".`);
      deps.fail(USAGE);
      return EXIT_USAGE;
  }
}

function baseUrlFrom(env: CliEnvironment): string {
  return env.MSGR_URL ?? `http://${HOST}:${DEFAULT_PORT}`;
}

/** The entry point used by `bin/msgr`. */
export async function main(): Promise<void> {
  const insideHerdr = Bun.env.HERDR_ENV === "1";
  const databasePath = Bun.env.MSGR_DB ?? defaultDatabasePath();
  const code = await runCli({
    argv: Bun.argv.slice(2),
    env: Bun.env,
    write: (line) => {
      console.log(line);
    },
    fail: (line) => {
      console.error(line);
    },
    herdr: insideHerdr ? new CliHerdr() : null,
    localControlToken: readLocalControlToken(databasePath),
  });
  process.exit(code);
}

export { BODY_PREVIEW_LIMIT, identityMissing };
