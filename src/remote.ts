/**
 * Remote access through `tailscale serve`.
 *
 * `tailscale serve` terminates TLS on the tailnet name and forwards to the
 * loopback listener. Its proxy always sets `X-Forwarded-For`, removes any
 * client-sent `Tailscale-User-*` header before it sets its own, and marks
 * public Funnel traffic with `Tailscale-Funnel-Request`. The proxy copies the
 * client's `Host`, so `Host` never decides whether a request is remote.
 *
 * A request with `X-Forwarded-For` is therefore remote. It is admitted only
 * when remote access is on, it names the stored host over HTTPS, and it
 * carries the owner's Tailscale login. A local process can forge these
 * headers, but that only lowers it to the remote rules, which need a paired
 * session. Funnel traffic is always refused.
 */

import { Result } from "better-result";
import { type ValidationFailed, validationFailed } from "./errors";
import type { RemoteAccess } from "./types";

export const FORWARDED_FOR_HEADER = "x-forwarded-for";
export const FORWARDED_HOST_HEADER = "x-forwarded-host";
export const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const TAILSCALE_FUNNEL_HEADER = "tailscale-funnel-request";

/** A pairing code is valid for five minutes after it is created. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_CODE_LENGTH = 8;
/** Failed redeems in a row that cancel every open pairing code. */
export const MAX_PAIRING_FAILURES = 5;

const MAX_HOST_LENGTH = 253;
const MAX_LOGIN_LENGTH = 256;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** Crockford base32: no I, L, O, or U, so a code read aloud cannot be misread. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type RemoteRefusal = "funnel" | "remote-off" | "host" | "scheme" | "login";

export type RequestChannel =
  | { kind: "local" }
  | { kind: "remote"; login: string; host: string; origin: string }
  | { kind: "refused"; reason: RemoteRefusal };

/** Decides where a request came from. Reads headers only; does no I/O. */
export function classifyRequest(headers: Headers, remote: RemoteAccess): RequestChannel {
  if (headers.has(TAILSCALE_FUNNEL_HEADER)) return { kind: "refused", reason: "funnel" };
  if (!headers.has(FORWARDED_FOR_HEADER)) return { kind: "local" };

  switch (remote.kind) {
    case "off":
      return { kind: "refused", reason: "remote-off" };
    case "on": {
      if (headers.get(FORWARDED_HOST_HEADER) !== remote.host) return { kind: "refused", reason: "host" };
      if (headers.get(FORWARDED_PROTO_HEADER) !== "https") return { kind: "refused", reason: "scheme" };
      const login = headers.get(TAILSCALE_LOGIN_HEADER);
      if (login === null || login !== remote.ownerLogin) return { kind: "refused", reason: "login" };
      return { kind: "remote", login, host: remote.host, origin: remote.origin };
    }
  }
}

export function remoteRefusalMessage(reason: RemoteRefusal): string {
  switch (reason) {
    case "funnel":
      return "Public Funnel traffic is never admitted";
    case "remote-off":
      return "Remote access is off";
    case "host":
      return "The forwarded host is not the remote access host";
    case "scheme":
      return "Remote access requires HTTPS";
    case "login":
      return "The Tailscale login is not the owner of this hub";
  }
}

/** A MagicDNS name as the browser uses it: lowercase labels, no port, no scheme. */
export function validRemoteHost(value: string): Result<string, ValidationFailed> {
  const labels = value.split(".");
  if (
    value.length === 0 ||
    value.length > MAX_HOST_LENGTH ||
    labels.length < 2 ||
    !labels.every((label) => HOST_LABEL.test(label))
  ) {
    return Result.err(validationFailed("host", "must be a lowercase DNS name without a port"));
  }
  return Result.ok(value);
}

export function validOwnerLogin(value: string): Result<string, ValidationFailed> {
  const printable = [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x20 && code !== 0x7f;
  });
  if (value.length === 0 || value.length > MAX_LOGIN_LENGTH || !printable) {
    return Result.err(
      validationFailed("ownerLogin", `must be 1 to ${MAX_LOGIN_LENGTH} printable characters without spaces`),
    );
  }
  return Result.ok(value);
}

export function remoteOrigin(host: string): string {
  return `https://${host}`;
}

/** Eight random characters from the pairing alphabet. */
export function mintPairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so taking the low five bits has no bias.
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
}

/** Shows a code as two groups of four, for reading and typing. */
export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Turns typed text into the stored form. Case, spaces, and dashes are
 * ignored; the letters that Crockford base32 leaves out map to the digits
 * they look like. Anything else is refused.
 */
export function normalizePairingCode(value: string): Result<string, ValidationFailed> {
  const compact = value.toUpperCase().replace(/[\s-]/gu, "");
  const mapped = [...compact]
    .map((character) => {
      switch (character) {
        case "O":
          return "0";
        case "I":
        case "L":
          return "1";
        default:
          return character;
      }
    })
    .join("");
  if (mapped.length !== PAIRING_CODE_LENGTH || ![...mapped].every((c) => PAIRING_ALPHABET.includes(c))) {
    return Result.err(validationFailed("code", `must be ${PAIRING_CODE_LENGTH} characters`));
  }
  return Result.ok(mapped);
}
