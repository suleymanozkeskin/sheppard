import { describe, expect, test } from "bun:test";
import {
  PAIRING_CODE_LENGTH,
  classifyRequest,
  displayPairingCode,
  mintPairingCode,
  normalizePairingCode,
  validOwnerLogin,
  validRemoteHost,
} from "../src/remote";
import type { RemoteAccess } from "../src/types";
import { expectErr, expectOk } from "./support";

const HOST = "mac.tail1234.ts.net";
const ON: RemoteAccess = {
  kind: "on",
  host: HOST,
  origin: `https://${HOST}`,
  ownerLogin: "owner@example.com",
  enabledAt: "2026-08-17T00:00:00.000Z",
};

/** A proxied request's headers. A null override removes that header. */
function forwarded(overrides: Readonly<Record<string, string | null>> = {}): Headers {
  const headers = new Headers({
    "x-forwarded-for": "100.64.0.2",
    "x-forwarded-host": HOST,
    "x-forwarded-proto": "https",
    "tailscale-user-login": "owner@example.com",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

describe("classifyRequest", () => {
  test("a request without a proxy header is local", () => {
    expect(classifyRequest(new Headers(), ON)).toEqual({ kind: "local" });
  });

  test("admits the owner through the stored host over HTTPS", () => {
    expect(classifyRequest(forwarded(), ON)).toEqual({
      kind: "remote",
      login: "owner@example.com",
      host: HOST,
      origin: `https://${HOST}`,
    });
  });

  test("refuses Funnel traffic even without a proxy header", () => {
    const headers = new Headers({ "tailscale-funnel-request": "?1" });
    expect(classifyRequest(headers, ON)).toEqual({ kind: "refused", reason: "funnel" });
  });

  test("refuses a proxied request while remote access is off", () => {
    expect(classifyRequest(forwarded(), { kind: "off" })).toEqual({ kind: "refused", reason: "remote-off" });
  });

  test("refuses another host, plain HTTP, another login, and a tagged device", () => {
    expect(classifyRequest(forwarded({ "x-forwarded-host": "other.ts.net" }), ON).kind).toBe("refused");
    expect(classifyRequest(forwarded({ "x-forwarded-proto": null }), ON)).toEqual({
      kind: "refused",
      reason: "scheme",
    });
    expect(classifyRequest(forwarded({ "tailscale-user-login": "guest@example.com" }), ON)).toEqual({
      kind: "refused",
      reason: "login",
    });
    expect(classifyRequest(forwarded({ "tailscale-user-login": null }), ON)).toEqual({
      kind: "refused",
      reason: "login",
    });
  });
});

describe("pairing codes", () => {
  test("a minted code has the fixed length and survives display and typing", () => {
    const code = mintPairingCode();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(expectOk(normalizePairingCode(displayPairingCode(code).toLowerCase()))).toBe(code);
  });

  test("maps look-alike letters and refuses other text", () => {
    expect(expectOk(normalizePairingCode("abcd-efOI"))).toBe("ABCDEF01");
    expect(expectErr(normalizePairingCode("ABC")).field).toBe("code");
    expect(expectErr(normalizePairingCode("ABCD-EFG!")).field).toBe("code");
  });
});

describe("remote settings", () => {
  test("accepts a MagicDNS name and refuses a port, a scheme, or one label", () => {
    expect(expectOk(validRemoteHost(HOST))).toBe(HOST);
    expect(validRemoteHost(`${HOST}:443`).isErr()).toBe(true);
    expect(validRemoteHost(`https://${HOST}`).isErr()).toBe(true);
    expect(validRemoteHost("localhost").isErr()).toBe(true);
    expect(validRemoteHost("Mac.ts.net").isErr()).toBe(true);
  });

  test("accepts a login and refuses spaces", () => {
    expect(expectOk(validOwnerLogin("owner@example.com"))).toBe("owner@example.com");
    expect(validOwnerLogin("owner name").isErr()).toBe(true);
    expect(validOwnerLogin("").isErr()).toBe(true);
  });
});
