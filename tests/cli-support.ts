/**
 * A real hub on an operating-system-assigned port, driven through the CLI.
 *
 * The CLI is the surface agents actually use, so these tests exercise it over
 * HTTP rather than calling the store. No herdr is involved: the route port is
 * injected, and a temporary database is discarded per test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config";
import { HOST } from "../src/config";
import { runCli } from "../src/cli";
import type { CliDeps, CliEnvironment } from "../src/cli";
import { openDatabase } from "../src/db";
import type { HerdrPort } from "../src/herdr";
import { createFetchHandler } from "../src/server";
import type { Hub } from "../src/server";
import { Store } from "../src/store";
import { Broadcaster } from "../src/sse";
import { hashToken } from "../src/tokens";

const TEST_CONTROL_TOKEN = "test-cli-local-control-token";

export interface RunOutcome {
  code: number;
  out: string;
  err: string;
}

export interface CliHarness {
  url: string;
  hub: Hub;
  /** Runs one command and captures everything it printed. */
  run: (
    argv: readonly string[],
    options?: {
      token?: string;
      herdr?: HerdrPort | null;
      herdrSocketPath?: string;
      launch?: CliDeps["launch"];
    },
  ) => Promise<RunOutcome>;
  stop: () => void;
}

export interface HarnessOptions {
  /** Makes every acknowledgement fail, to prove reading prints before it acks. */
  failAck?: boolean;
  herdrSocketPath?: string | null;
}

export function startCliHub(options: HarnessOptions = {}): CliHarness {
  const directory = mkdtempSync(join(tmpdir(), "msgr-cli-"));
  const databasePath = join(directory, "msgr.db");
  const database = openDatabase(databasePath).unwrap("test database must open");

  const config: ServerConfig = {
    port: 0,
    databasePath,
    allowedOrigin: `http://${HOST}:0`,
    pushAvailable: false,
    herdrSocketPath: options.herdrSocketPath ?? null,
    webRoot: join(directory, "no-web-root"),
    allowExtraHumans: false,
  };
  const hub: Hub = {
    store: new Store(database),
    config,
    broadcaster: new Broadcaster(),
    localControlTokenHash: hashToken(TEST_CONTROL_TOKEN),
  };
  const handler = createFetchHandler(hub);

  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    fetch: (request) => {
      if (options.failAck === true && new URL(request.url).pathname.endsWith("/ack")) {
        return new Response(JSON.stringify({ error: "the acknowledgement was lost" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return handler(request);
    },
  });
  config.port = server.port;

  const url = `http://${HOST}:${server.port}`;

  return {
    url,
    hub,
    run: async (argv, runOptions = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const env: CliEnvironment = {
        MSGR_URL: url,
        MSGR_TOKEN: runOptions.token,
        HERDR_SOCKET_PATH: runOptions.herdrSocketPath,
      };

      const code = await runCli({
        argv,
        env,
        write: (line) => out.push(line),
        fail: (line) => err.push(line),
        herdr: runOptions.herdr ?? null,
        launch: runOptions.launch,
        localControlToken: TEST_CONTROL_TOKEN,
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
    stop: () => {
      server.stop(true);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Provisions an agent through the CLI and returns its token. */
export async function provisionAgent(harness: CliHarness, handle: string): Promise<string> {
  const outcome = await harness.run(["provision", handle, "--json"]);
  // SAFETY: `provision --json` prints the hub's {handle, token} reply verbatim;
  // a failure prints nothing parseable and the destructure below fails the test.
  const created = JSON.parse(outcome.out) as { handle: string; token: string };
  return created.token;
}
