/**
 * A hub wired to an in-memory database and driven through its fetch handler.
 * No port is bound and no herdr instance is involved.
 */

import { IN_MEMORY, openDatabase } from "../src/db";
import { DEFAULT_HARNESSES, DEFAULT_PORT, DEFAULT_ROLES, HOST } from "../src/config";
import { CONTROL_TOKEN_HEADER } from "../src/control-token";
import type { ServerConfig } from "../src/config";
import type { JsonValue } from "../src/json";
import { createFetchHandler } from "../src/server";
import type { Hub } from "../src/server";
import { Store } from "../src/store";
import { Broadcaster } from "../src/sse";
import { hashToken } from "../src/tokens";

export const BASE = `http://${HOST}:${DEFAULT_PORT}`;
export const ALLOWED_ORIGIN = BASE;
export const TEST_HERDR_SOCKET_PATH = "/tmp/msgr-test-herdr.sock";
export const TEST_CONTROL_TOKEN = "test-local-control-token";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: DEFAULT_PORT,
    databasePath: IN_MEMORY,
    allowedOrigin: ALLOWED_ORIGIN,
    pushAvailable: true,
    herdrSocketPath: TEST_HERDR_SOCKET_PATH,
    webRoot: "/nonexistent-web-root",
    allowExtraHumans: false,
    ...overrides,
  };
}

/** Header maps are built by hand in tests, so the value type is always string. */
export type RequestHeaders = Record<string, string>;

export interface TestHub {
  hub: Hub;
  handler: (request: Request) => Promise<Response>;
  get: (path: string, headers?: RequestHeaders) => Promise<Response>;
  post: (path: string, body?: JsonValue, headers?: RequestHeaders) => Promise<Response>;
  put: (path: string, body?: JsonValue, headers?: RequestHeaders) => Promise<Response>;
  delete: (path: string, headers?: RequestHeaders) => Promise<Response>;
}

export function testHub(overrides: Partial<ServerConfig> = {}): TestHub {
  const db = openDatabase(IN_MEMORY).unwrap("in-memory database must open");
  const config = testConfig(overrides);
  const store = new Store(db);
  store.seedLaunchers(
    (config.harnesses ?? DEFAULT_HARNESSES).map((harness) => ({
      name: harness.name,
      agentKind: harness.name,
      argv: [...harness.argv],
      env: {},
      startTimeoutMs: harness.startTimeoutMs,
    })),
  );
  store.seedRoles(config.roles ?? DEFAULT_ROLES);
  store.seedModels(config.models ?? []);
  const hub: Hub = {
    store,
    config,
    broadcaster: new Broadcaster(),
    localControlTokenHash: hashToken(TEST_CONTROL_TOKEN),
  };
  const handler = createFetchHandler(hub);

  return {
    hub,
    handler,
    get: (path, headers = {}) => handler(new Request(`${BASE}${path}`, { headers })),
    delete: (path, headers = {}) =>
      handler(new Request(`${BASE}${path}`, { method: "DELETE", headers })),
    post: (path, body = {}, headers = {}) =>
      handler(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      ),
    put: (path, body = {}, headers = {}) =>
      handler(
        new Request(`${BASE}${path}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      ),
  };
}

export function controlAuth() {
  return { [CONTROL_TOKEN_HEADER]: TEST_CONTROL_TOKEN };
}

export function auth(token: string) {
  return { "x-msgr-token": token };
}

export async function operatorAuth(hub: TestHub, handle = "human"): Promise<RequestHeaders> {
  const response = await hub.post("/api/humans", { handle });
  if (response.status !== 201) {
    throw new Error(`human fixture creation failed with status ${response.status}`);
  }
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (cookie.length === 0) throw new Error("human fixture did not return a session cookie");
  return { cookie };
}

/** Creates an agent and returns the token it will never be shown again. */
export async function provision(hub: TestHub, handle: string): Promise<string> {
  const response = await hub.post("/api/agents", { handle });
  // SAFETY: a 201 from POST /api/agents carries {handle, token}. If the call
  // failed instead, `token` is undefined and every test using it fails.
  const created = (await response.json()) as { token: string };
  return created.token;
}
