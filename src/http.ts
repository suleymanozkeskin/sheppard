/**
 * Request admission and response shaping.
 *
 * Every request passes the same three checks before any handler sees it: the
 * Host it claims, the Origin it carries, and the Content-Type it writes with.
 * Together they keep a page in an ordinary browser from reaching this API even
 * though the API listens with no password on the loopback interface.
 */

import { Result } from "better-result";
import {
  type ChannelExists,
  type ChannelNotDeletable,
  type ChannelNotFound,
  type DirectMembershipLocked,
  type HandleTaken,
  type LauncherExists,
  type RoleExists,
  type ModelExists,
  type HerdrCallFailed,
  type HerdrNotConfigured,
  type MembershipExists,
  type NotAMember,
  type NotFound,
  type NotPreviewable,
  type OperatorOnly,
  type RequestRejected,
  type HerdrSessionMismatch,
  type Unauthorized,
  type UploadStorageFailed,
  type ValidationFailed,
  RequestRejected as RequestRejectedError,
  herdrSessionMismatch,
  unauthorized,
  validationFailed,
} from "./errors";
import type { ServerConfig } from "./config";
import {
  HERDR_SOCKET_HEADER,
  HOST,
  OCCUPANT_HEADER,
  PANE_HEADER,
  TERMINAL_HEADER,
  TOKEN_COOKIE,
  TOKEN_HEADER,
} from "./config";
import type { Store } from "./store";
import type { Participant, Route } from "./types";
import { validStoredText } from "./validate";

export type ApiError =
  | ChannelExists
  | ChannelNotDeletable
  | ChannelNotFound
  | DirectMembershipLocked
  | HandleTaken
  | LauncherExists
  | RoleExists
  | ModelExists
  | HerdrCallFailed
  | MembershipExists
  | NotAMember
  | NotFound
  | NotPreviewable
  | OperatorOnly
  | RequestRejected
  | HerdrSessionMismatch
  | HerdrNotConfigured
  | Unauthorized
  | UploadStorageFailed
  | ValidationFailed;

/**
 * A non-member is told what is wrong rather than that the channel is missing:
 * the channel is readable through the public surface, so hiding it would be
 * both false and unhelpful.
 */
export function statusFor(error: ApiError): number {
  return error.match({
    ValidationFailed: () => 400,
    NotAMember: () => 400,
    DirectMembershipLocked: () => 403,
    Unauthorized: () => 401,
    RequestRejected: () => 403,
    NotFound: () => 404,
    OperatorOnly: () => 403,
    ChannelNotFound: () => 404,
    HandleTaken: () => 409,
    LauncherExists: () => 409,
    RoleExists: () => 409,
    ModelExists: () => 409,
    ChannelExists: () => 409,
    ChannelNotDeletable: () => 409,
    MembershipExists: () => 409,
    NotPreviewable: () => 415,
    UploadStorageFailed: () => 500,
    HerdrSessionMismatch: () => 403,
    HerdrCallFailed: () => 503,
    HerdrNotConfigured: () => 503,
  });
}

export function jsonResponse<T>(body: T, status: number, headers: Headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: ApiError, headers?: Headers): Response {
  return jsonResponse(
    { error: error.message, code: error._tag },
    statusFor(error),
    headers ?? new Headers(),
  );
}

/**
 * A Host the server does not answer to means the request reached it through a
 * name that resolves here, which is how a remote page tries to become
 * same-origin with a loopback service.
 */
function hostAllowed(request: Request, config: ServerConfig): boolean {
  const url = new URL(request.url);
  const claimed = request.headers.get("host") ?? url.host;
  return claimed === `${HOST}:${config.port}` || claimed === `localhost:${config.port}`;
}

/** Keep the browser UI and its cookie on the canonical loopback host. */
export function canonicalHostRedirect(request: Request, config: ServerConfig): Response | null {
  const url = new URL(request.url);
  const isApiPath = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (request.method !== "GET" || isApiPath) return null;

  const claimed = request.headers.get("host") ?? url.host;
  if (claimed !== `localhost:${config.port}`) return null;

  url.protocol = "http:";
  url.hostname = HOST;
  url.port = String(config.port);
  return new Response(null, {
    status: 302,
    headers: { location: url.toString() },
  });
}

/** Requests without an Origin are not from a page; the CLI is the usual source. */
function originAllowed(request: Request, config: ServerConfig): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === config.allowedOrigin;
}

function contentTypeAllowed(request: Request): boolean {
  const hasJsonBody =
    request.method === "POST" ||
    request.method === "PUT" ||
    (request.method === "DELETE" && request.body !== null);
  if (!hasJsonBody) return true;
  const declared = request.headers.get("content-type");
  if (declared === null) return false;
  const essence = declared.split(";")[0]?.trim().toLowerCase();
  if (new URL(request.url).pathname === "/api/uploads") {
    return essence === "application/octet-stream";
  }
  return essence === "application/json";
}

export function admit(request: Request, config: ServerConfig): Result<Request, RequestRejected> {
  if (!hostAllowed(request, config)) {
    return Result.err(
      new RequestRejectedError({ reason: "host", message: "Unrecognised Host header" }),
    );
  }
  if (!originAllowed(request, config)) {
    return Result.err(
      new RequestRejectedError({ reason: "origin", message: "Origin is not allowed" }),
    );
  }
  if (!contentTypeAllowed(request)) {
    return Result.err(
      new RequestRejectedError({
        reason: "content_type",
        message: "Content-Type must be application/json",
      }),
    );
  }
  return Result.ok(request);
}

/**
 * Sent only to the one allowed origin. Answering a preflight for any other
 * origin would hand a page exactly the permission the Origin check refuses.
 */
export function corsHeaders(request: Request, config: ServerConfig): Headers {
  const headers = new Headers();
  if (request.headers.get("origin") !== config.allowedOrigin) return headers;
  headers.set("access-control-allow-origin", config.allowedOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    `Content-Type, Accept, ${TOKEN_HEADER}, X-Msgr-Filename`,
  );
  headers.set("vary", "Origin");
  return headers;
}

function cookieValue(request: Request, name: string): Result<string | null, ValidationFailed> {
  const header = request.headers.get("cookie");
  if (header === null) return Result.ok(null);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return Result.try({
      try: (): string => decodeURIComponent(part.slice(separator + 1).trim()),
      catch: () => validationFailed("cookie", "must use valid URL encoding"),
    });
  }
  return Result.ok(null);
}

export function presentedToken(request: Request): Result<string | null, ValidationFailed> {
  const header = request.headers.get(TOKEN_HEADER);
  return header === null ? cookieValue(request, TOKEN_COOKIE) : Result.ok(header);
}

/** Present only on CLI requests, which is why a browser participant holds no route. */
export function routeFromHeaders(request: Request): Result<Route | null, ValidationFailed> {
  const terminalId = request.headers.get(TERMINAL_HEADER);
  const paneId = request.headers.get(PANE_HEADER);
  if (terminalId === null || paneId === null) return Result.ok(null);

  return Result.gen(function* () {
    const validTerminalId = yield* validStoredText(terminalId, TERMINAL_HEADER);
    const validPaneId = yield* validStoredText(paneId, PANE_HEADER);
    const rawOccupant = request.headers.get(OCCUPANT_HEADER);
    let occupantAgent: string | null = null;
    if (rawOccupant !== null) occupantAgent = yield* validStoredText(rawOccupant, OCCUPANT_HEADER);
    return Result.ok({ terminalId: validTerminalId, paneId: validPaneId, occupantAgent });
  });
}

/**
 * Authenticates and, for a caller running inside a pane, re-binds its route.
 * Doing it on every authenticated request is what lets one ordinary command
 * repair delivery after a restart, a pane move, or a reboot.
 */
export function authenticate(
  request: Request,
  store: Store,
  herdrSocketPath: string | null,
  allowPaneIdentity = false,
): Result<Participant, Unauthorized | HerdrSessionMismatch | ValidationFailed> {
  const token = presentedToken(request);
  if (token.isErr()) return Result.err(token.error);
  if (token.value === null) {
    if (!allowPaneIdentity) return Result.err(unauthorized());
    const route = routeFromHeaders(request);
    if (route.isErr()) return Result.err(route.error);
    if (route.value === null) return Result.err(unauthorized());
    if (herdrSocketPath === null || request.headers.get(HERDR_SOCKET_HEADER) !== herdrSocketPath) {
      return Result.err(herdrSessionMismatch());
    }
    const participant = store.findActiveAgentByTerminal(route.value.terminalId);
    if (
      participant === null ||
      participant.paneId !== route.value.paneId ||
      participant.occupantAgent === null ||
      participant.occupantAgent !== route.value.occupantAgent
    ) {
      return Result.err(unauthorized());
    }
    store.markSeen(participant.id);
    return Result.ok(participant);
  }

  const participant = store.findByToken(token.value);
  if (participant === null) return Result.err(unauthorized());

  const route = routeFromHeaders(request);
  if (route.isErr()) return Result.err(route.error);
  if (route.value !== null && participant.kind === "agent") {
    if (herdrSocketPath === null || request.headers.get(HERDR_SOCKET_HEADER) !== herdrSocketPath) {
      return Result.err(herdrSessionMismatch());
    }
    store.bindRoute(participant.id, route.value);
    const rebound = store.findByHandle(participant.handle);
    if (rebound !== null) return Result.ok(rebound);
  }
  store.markSeen(participant.id);
  return Result.ok(participant);
}

export function setTokenCookie(headers: Headers, token: string): void {
  headers.append(
    "set-cookie",
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
  );
}
