/**
 * The CLI's view of the hub: a thin fetch client that carries identity.
 *
 * Every authenticated request also reports the pane the caller is running in, so
 * an ordinary command repairs delivery after a restart, a pane move, or a
 * reboot. The token travels in a header and is never placed in a URL, an
 * argument, or an error message.
 *
 * The hub and this client ship together, so the response shapes are an internal
 * invariant rather than untrusted input; only the error envelope is decoded
 * defensively, because that is what a failing server is most likely to garble.
 */

import { Result, TaggedError } from "better-result";
import {
  HERDR_SOCKET_HEADER,
  OCCUPANT_HEADER,
  PANE_HEADER,
  TERMINAL_HEADER,
  TOKEN_HEADER,
} from "./config";
import { CONTROL_TOKEN_HEADER } from "./control-token";
import { type Cause, type Operation } from "./error-copy";
import { escapeForTerminal } from "./format";
import { type JsonValue, decodeObject, optionalString } from "./json";
import type { Route } from "./types";

export class HubUnreachable extends TaggedError("HubUnreachable")<{
  url: string;
  operation: Operation;
  message: string;
}> {}

export class HubRefused extends TaggedError("HubRefused")<{
  status: number;
  operation: Operation;
  cause: Cause;
  detail: string | undefined;
  body: JsonValue | null;
  message: string;
}> {}

export class IdentityMissing extends TaggedError("IdentityMissing")<{
  message: string;
}> {}

export class LocalControlMissing extends TaggedError("LocalControlMissing")<{
  message: string;
}> {}

export type ClientError = HubUnreachable | HubRefused | IdentityMissing | LocalControlMissing;

export function identityMissing(boundHandle: string | null = null): IdentityMissing {
  if (boundHandle !== null) {
    const handle = escapeForTerminal(boundHandle);
    return new IdentityMissing({
      message:
        `This pane is bound to the identity "${handle}", and this process does not hold its token. ` +
        "Tokens are issued once and cannot be reissued. Do not provision a new handle: " +
        "that mints a second identity and moves the route to it. Relaunch this pane with\n" +
        `  msgr spawn ${handle} -- <command...>, or ask the fleet lead to respawn the agent`,
    });
  }
  return new IdentityMissing({
    message:
      "No identity. Provision a handle first, then launch with MSGR_TOKEN set:\n" +
      "  msgr provision <handle>\n" +
      "  msgr spawn <handle> -- <command...>",
  });
}

function causeFromCode(code: string): Cause | null {
  switch (code) {
    case "ChannelExists":
    case "ChannelNotFound":
    case "DirectMembershipLocked":
    case "HandleTaken":
    case "MembershipExists":
    case "NotAMember":
    case "NotFound":
    case "NotPreviewable":
    case "RequestRejected":
    case "RoleExists":
    case "HerdrSessionMismatch":
    case "Unauthorized":
    case "UploadStorageFailed":
    case "HerdrNotConfigured":
    case "HerdrCallFailed":
    case "ValidationFailed":
    case "HerdrUnavailable":
    case "Unreachable":
    case "Undecodable":
    case "Unclassified":
      return code;
    default:
      return null;
  }
}

function fallback404(operation: Operation): Cause {
  switch (operation) {
    case "attachmentContent":
    case "addMember":
    case "deactivateParticipant":
    case "listWorkspaces":
    case "createWorkspace":
    case "closeWorkspace":
    case "broadcastWorkspace":
    case "listModels":
    case "refreshModels":
    case "listLaunchers":
    case "listHarnesses":
    case "listRoles":
    case "createRole":
    case "readRole":
    case "updateRole":
    case "updateRoleRuntime":
    case "spawnAgent":
      return "NotFound";
    case "joinChannel":
    case "sendMessage":
    case "acknowledge":
    case "listMessages":
    case "listMembers":
    case "listReceipts":
    case "context":
    case "removeMember":
      return "ChannelNotFound";
    case "createChannel":
    case "createDirect":
    case "createHuman":
    case "createAgent":
    case "listChannels":
    case "listDirect":
    case "listParticipants":
    case "inbox":
    case "search":
    case "uploadFile":
      return "NotFound";
  }
}

function fallbackCause(operation: Operation, status: number): Cause {
  switch (status) {
    case 400:
      return "ValidationFailed";
    case 401:
      return "Unauthorized";
    case 403:
      return "RequestRejected";
    case 404:
      return fallback404(operation);
    case 409:
      switch (operation) {
        case "createChannel":
          return "ChannelExists";
        case "createRole":
          return "RoleExists";
        case "createAgent":
        case "createHuman":
          return "HandleTaken";
        case "addMember":
          return "MembershipExists";
        case "acknowledge":
        case "attachmentContent":
        case "broadcastWorkspace":
        case "closeWorkspace":
        case "context":
        case "createDirect":
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
        case "readRole":
        case "updateRole":
        case "updateRoleRuntime":
        case "listMessages":
        case "listParticipants":
        case "deactivateParticipant":
        case "listWorkspaces":
        case "removeMember":
        case "search":
        case "sendMessage":
        case "uploadFile":
        case "spawnAgent":
          return "Unclassified";
      }
    case 415:
      return "NotPreviewable";
    case 500:
      return operation === "uploadFile" ? "UploadStorageFailed" : "Unclassified";
    case 503:
      return "HerdrCallFailed";
    default:
      return "Unclassified";
  }
}

function undecodable(
  status: number,
  operation: Operation,
  body: JsonValue | null,
): HubRefused {
  return new HubRefused({
    status,
    operation,
    cause: "Undecodable",
    detail: undefined,
    body,
    message: "The hub sent a reply this app does not understand.",
  });
}

/** Reads the hub's `{error, code}` envelope, falling back for older hubs. */
function refusalFrom(status: number, text: string, operation: Operation): HubRefused {
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(text),
    catch: () => null,
  }).unwrapOr(null);

  if (parsed === null) return undecodable(status, operation, null);

  const object = decodeObject(parsed);
  if (object.isErr()) return undecodable(status, operation, parsed);

  const decodedDetail = optionalString(object.value, "error");
  if (decodedDetail.isErr() || decodedDetail.value === null) {
    return undecodable(status, operation, parsed);
  }
  const detail = decodedDetail.value;

  const decodedCode = optionalString(object.value, "code");
  if (decodedCode.isErr()) return undecodable(status, operation, parsed);
  const rawCode = decodedCode.value;

  const cause = rawCode === null ? fallbackCause(operation, status) : causeFromCode(rawCode);
  if (cause === null) return undecodable(status, operation, parsed);

  return new HubRefused({
    status,
    operation,
    cause,
    detail,
    body: parsed,
    message: detail,
  });
}

export interface HubClientOptions {
  baseUrl: string;
  token: string | null;
  localControlToken: string | null;
  /** Present only when the caller is inside a herdr pane. */
  route: Route | null;
  herdrSocketPath: string | null;
  /** Bound handle discovered from the open pane identity read, if any. */
  boundHandle?: string | null;
}

export class HubClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly localControlToken: string | null;
  private readonly route: Route | null;
  private readonly herdrSocketPath: string | null;
  private readonly boundHandle: string | null;

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token;
    this.localControlToken = options.localControlToken;
    this.route = options.route;
    this.herdrSocketPath = options.herdrSocketPath;
    this.boundHandle = options.boundHandle ?? null;
  }

  get hasIdentity(): boolean {
    return this.token !== null;
  }

  private headers(authenticated: boolean): Result<Headers, IdentityMissing> {
    const headers = new Headers({ accept: "application/json" });
    if (!authenticated) return Result.ok(headers);

    if (this.token === null) return Result.err(identityMissing(this.boundHandle));
    headers.set(TOKEN_HEADER, this.token);

    if (this.route !== null) {
      headers.set(TERMINAL_HEADER, this.route.terminalId);
      headers.set(PANE_HEADER, this.route.paneId);
      if (this.herdrSocketPath !== null) {
        headers.set(HERDR_SOCKET_HEADER, this.herdrSocketPath);
      }
      if (this.route.occupantAgent !== null) {
        headers.set(OCCUPANT_HEADER, this.route.occupantAgent);
      }
    }
    return Result.ok(headers);
  }

  private localControlHeaders(): Result<Headers, LocalControlMissing> {
    if (this.localControlToken === null) {
      return Result.err(
        new LocalControlMissing({
          message:
            "The local Sheppard control credential is unavailable. Start or restart Sheppard, then retry.",
        }),
      );
    }
    const headers = new Headers({ accept: "application/json" });
    headers.set(CONTROL_TOKEN_HEADER, this.localControlToken);
    return Result.ok(headers);
  }

  private async send<T>(
    operation: Operation,
    path: string,
    init: RequestInit,
    headers: Headers,
  ): Promise<Result<T, ClientError>> {
    const url = `${this.baseUrl}${path}`;
    const responded = await Result.tryPromise({
      try: () => fetch(url, { ...init, headers }),
      catch: () =>
        new HubUnreachable({
          url: this.baseUrl,
          operation,
          message: `Cannot reach the hub at ${this.baseUrl}. Is \`msgr serve\` running?`,
        }),
    });
    if (responded.isErr()) return responded;

    const response = responded.value;
    if (!response.ok) return Result.err(refusalFrom(response.status, await response.text(), operation));

    // `json()` is untyped at the boundary; the caller names the contracted shape.
    return Result.tryPromise({
      // SAFETY: Each successful request is decoded into the operation's response type by its caller.
      try: () => response.json() as Promise<T>,
      catch: () => undecodable(response.status, operation, null),
    });
  }

  async get<T>(
    operation: Operation,
    path: string,
    authenticated: boolean,
  ): Promise<Result<T, ClientError>> {
    const headers = this.headers(authenticated);
    if (headers.isErr()) return headers;
    return this.send<T>(operation, path, { method: "GET" }, headers.value);
  }

  async controlGet<T>(
    operation: Operation,
    path: string,
  ): Promise<Result<T, ClientError>> {
    const headers = this.localControlHeaders();
    if (headers.isErr()) return headers;
    return this.send<T>(operation, path, { method: "GET" }, headers.value);
  }

  async post<T>(
    operation: Operation,
    path: string,
    body: JsonValue,
    authenticated: boolean,
  ): Promise<Result<T, ClientError>> {
    const headers = this.headers(authenticated);
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    return this.send<T>(
      operation,
      path,
      { method: "POST", body: JSON.stringify(body) },
      headers.value,
    );
  }

  async controlPost<T>(
    operation: Operation,
    path: string,
    body: JsonValue,
  ): Promise<Result<T, ClientError>> {
    const headers = this.localControlHeaders();
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    return this.send<T>(
      operation,
      path,
      { method: "POST", body: JSON.stringify(body) },
      headers.value,
    );
  }

  async put<T>(
    operation: Operation,
    path: string,
    body: JsonValue,
    authenticated: boolean,
  ): Promise<Result<T, ClientError>> {
    const headers = this.headers(authenticated);
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    return this.send<T>(
      operation,
      path,
      { method: "PUT", body: JSON.stringify(body) },
      headers.value,
    );
  }

  async controlPut<T>(
    operation: Operation,
    path: string,
    body: JsonValue,
  ): Promise<Result<T, ClientError>> {
    const headers = this.localControlHeaders();
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    return this.send<T>(
      operation,
      path,
      { method: "PUT", body: JSON.stringify(body) },
      headers.value,
    );
  }

  async delete<T>(
    operation: Operation,
    path: string,
    authenticated: boolean,
  ): Promise<Result<T, ClientError>> {
    const headers = this.headers(authenticated);
    if (headers.isErr()) return headers;
    return this.send<T>(operation, path, { method: "DELETE" }, headers.value);
  }
}
