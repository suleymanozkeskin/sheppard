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
