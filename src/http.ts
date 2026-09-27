/**
 * Request admission and response shaping.
 *
 * Every request passes the same three checks before any handler sees it: the
 * Host it claims, the Origin it carries, and the Content-Type it writes with.
 * Together they keep a page in an ordinary browser from reaching this API even
 * though the API listens with no password on the loopback interface.
 */

import { Result, panic } from "better-result";
import {
  type ChannelExists,
  type ChannelNotDeletable,
  type ChannelNotFound,
  type DirectMembershipLocked,
  type DictationUnavailable,
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
  type PairingRefused,
  type RemoteAccessOff,
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
import { type RequestChannel, remoteRefusalMessage } from "./remote";

export type ApiError =
  | ChannelExists
  | ChannelNotDeletable
  | ChannelNotFound
  | DirectMembershipLocked
  | DictationUnavailable
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
  | PairingRefused
  | RemoteAccessOff
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
    PairingRefused: () => 401,
    RemoteAccessOff: () => 409,
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
    DictationUnavailable: ({ reason }) => {
      switch (reason) {
        case "permission_denied":
          return 403;
        case "no_speech":
          return 422;
        case "compile_failed":
        case "dictation_disabled":
        case "local_recognition_unavailable":
        case "locale_unsupported":
        case "recognition_failed":
        case "timeout":
        case "unsupported_os":
          return 503;
      }
    },
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
function originAllowed(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === allowedOrigin;
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
  if (new URL(request.url).pathname === "/api/dictation/transcribe") {
    return essence === "audio/wav";
  }
  return essence === "application/json";
}

export function admit(
  request: Request,
  config: ServerConfig,
  channel: RequestChannel,
): Result<Request, RequestRejected> {
  switch (channel.kind) {
    case "refused":
      return Result.err(
        new RequestRejectedError({ reason: "remote", message: remoteRefusalMessage(channel.reason) }),
      );
    case "local":
      if (!hostAllowed(request, config)) {
        return Result.err(
          new RequestRejectedError({ reason: "host", message: "Unrecognised Host header" }),
        );
      }
      if (!originAllowed(request, config.allowedOrigin)) {
        return Result.err(
          new RequestRejectedError({ reason: "origin", message: "Origin is not allowed" }),
        );
      }
      break;
    case "remote": {
      // The proxy copies the client's Host, so it must name the remote host too.
      const claimed = request.headers.get("host") ?? new URL(request.url).host;
      if (claimed !== channel.host) {
        return Result.err(
          new RequestRejectedError({ reason: "host", message: "Unrecognised Host header" }),
        );
      }
      if (!originAllowed(request, channel.origin)) {
        return Result.err(
          new RequestRejectedError({ reason: "origin", message: "Origin is not allowed" }),
        );
      }
      break;
    }
  }
  if (!contentTypeAllowed(request)) {
    return Result.err(
      new RequestRejectedError({
        reason: "content_type",
        message: "Content-Type is not allowed",
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
    `Content-Type, Accept, ${TOKEN_HEADER}, X-Msgr-Filename, X-Sheppard-Dictation-Locale`,
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
 * A token or the local control credential with an exact route identifies the
 * caller. Pane recovery requires one identity and does not transfer membership
 * or cursors. Failed authentication changes nothing; retry requires valid
 * credentials and a matching route.
 */
export function authenticate(
  request: Request,
  store: Store,
  herdrSocketPath: string | null,
  allowPaneIdentity: boolean,
  channel: RequestChannel,
): Result<Participant, Unauthorized | HerdrSessionMismatch | ValidationFailed> {
  switch (channel.kind) {
    case "refused":
      return Result.err(unauthorized());
    case "remote":
      return authenticateRemote(request, store);
    case "local":
      break;
  }
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
    const identity = store.identityForRoute(route.value);
    switch (identity.kind) {
      case "missing":
      case "ambiguous":
      case "mismatch":
        return Result.err(unauthorized());
      case "matched": {
        store.bindRoute(identity.participant.id, route.value);
        const rebound = store.findById(identity.participant.id);
        if (rebound === null) panic("Authenticated pane identity disappeared during route binding");
        return Result.ok(rebound);
      }
      default:
        return panic(`Unexpected pane identity: ${JSON.stringify(identity satisfies never)}`);
    }
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

/** The remote session cookie is sent over HTTPS only. */
export function setRemoteSessionCookie(headers: Headers, token: string): void {
  headers.append(
    "set-cookie",
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
  );
}

export function setTokenCookie(headers: Headers, token: string): void {
  headers.append(
    "set-cookie",
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
  );
}

/**
 * A remote request authenticates only with a session created by pairing. Agent
 * tokens, loopback human sessions, and pane identities are not accepted, so a
 * credential that leaves the machine is not enough on its own.
 */
function authenticateRemote(
  request: Request,
  store: Store,
): Result<Participant, Unauthorized | ValidationFailed> {
  const token = cookieValue(request, TOKEN_COOKIE);
  if (token.isErr()) return Result.err(token.error);
  if (token.value === null) return Result.err(unauthorized());
  const participant = store.findByRemoteSession(token.value);
  return participant === null ? Result.err(unauthorized()) : Result.ok(participant);
}
