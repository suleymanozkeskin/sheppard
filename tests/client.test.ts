import { afterEach, describe, expect, test } from "bun:test";
import { HubClient, HubRefused } from "../src/client";

const servers: Bun.Server[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});
function start(response: Response): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => response,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function client(baseUrl: string): HubClient {
  return new HubClient({
    baseUrl,
    token: null,
    localControlToken: null,
    route: null,
    herdrSocketPath: null,
  });
}

describe("hub client failures", () => {
  test("carries the operation and coded cause", async () => {
    const url = start(
      new Response(JSON.stringify({ error: "Channel backend already exists", code: "ChannelExists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await client(url).get("createChannel", "/api/channels", false);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(HubRefused.is(result.error)).toBe(true);
      expect(result.error).toMatchObject({
        operation: "createChannel",
        cause: "ChannelExists",
        detail: "Channel backend already exists",
      });
    }
  });

  test("turns malformed successful JSON into an undecodable failure", async () => {
    const url = start(new Response("not-json", { status: 200 }));

    const result = await client(url).get("inbox", "/api/inbox", false);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        operation: "inbox",
        cause: "Undecodable",
      });
    }
  });
});

describe("pane-scoped hub client identity", () => {
  test("uses the local control credential with the exact Herdr route", async () => {
    let received: Headers | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        received = request.headers;
        return Response.json({ inbox: [] });
      },
    });
    servers.push(server);
    const paneClient = new HubClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: null,
      localControlToken: "local-control",
      route: {
        terminalId: "term-1",
        paneId: "w1:p1",
        occupantAgent: "codex",
      },
      herdrSocketPath: "/tmp/herdr.sock",
      boundHandle: "lead-2",
    });

    expect(paneClient.hasIdentity).toBe(true);
    expect((await paneClient.get("inbox", "/api/inbox", true)).isOk()).toBe(true);
    expect(received?.get("x-msgr-control-token")).toBe("local-control");
    expect(received?.get("x-msgr-token")).toBeNull();
    expect(received?.get("x-msgr-terminal-id")).toBe("term-1");
    expect(received?.get("x-msgr-pane-id")).toBe("w1:p1");
    expect(received?.get("x-msgr-occupant")).toBe("codex");
    expect(received?.get("x-msgr-herdr-socket-path")).toBe("/tmp/herdr.sock");
  });

  test("does not claim a pane identity when any required value is absent", () => {
    const options = {
      baseUrl: "http://127.0.0.1:6747",
      token: null,
      localControlToken: "local-control",
      route: {
        terminalId: "term-1",
        paneId: "w1:p1",
        occupantAgent: "codex",
      },
      herdrSocketPath: "/tmp/herdr.sock",
      boundHandle: "lead-2",
    };

    expect(new HubClient({ ...options, localControlToken: null }).hasIdentity).toBe(false);
    expect(new HubClient({ ...options, route: null }).hasIdentity).toBe(false);
    expect(new HubClient({ ...options, herdrSocketPath: null }).hasIdentity).toBe(false);
    expect(new HubClient({ ...options, boundHandle: null }).hasIdentity).toBe(false);
  });
});
