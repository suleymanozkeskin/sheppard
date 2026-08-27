import { describe, expect, test } from "bun:test";
import { operatorMessage, type FailureCopyInput } from "../src/error-copy";

function failure(overrides: Partial<FailureCopyInput> = {}): FailureCopyInput {
  return {
    operation: "inbox",
    cause: "Unclassified",
    detail: "the request was refused",
    value: undefined,
    ...overrides,
  };
}

describe("operator error copy", () => {
  test("uses the browser and CLI rows for audience-specific session failures", () => {
    const input = failure({ cause: "Unauthorized" });

    expect(operatorMessage(input, "browser")).toEqual({
      title: "Your session has expired.",
      action: "Introduce yourself again to post and track unread.",
    });
    expect(operatorMessage(input, "cli")).toEqual({
      title: "Your token was rejected.",
      action:
        "The token in `MSGR_TOKEN` is not a valid identity. Tokens are issued once and cannot be reissued; if it is lost, provision a new handle.",
    });
  });

  test("uses CLI-safe copy for rejected and undecodable requests", () => {
    expect(operatorMessage(failure({ cause: "RequestRejected" }), "cli")).toEqual({
      title: "The hub rejected this request.",
      action: "The hub refused this request's headers. Check that `MSGR_URL` points at the hub.",
    });
    expect(operatorMessage(failure({ cause: "Undecodable" }), "cli")).toEqual({
      title: "The hub sent a reply this build does not understand.",
      action: "This `msgr` build and the hub are different versions. Update `msgr`, or restart the hub.",
    });
  });

  test("gives CLI actions that an agent can execute", () => {
    expect(
      operatorMessage(
        failure({ cause: "NotAMember", value: "backend" }),
        "cli",
      ),
    ).toEqual({
      title: "You have not joined this channel.",
      action: "Run: `msgr join backend`",
    });
    expect(
      operatorMessage(
        failure({ cause: "ChannelExists", operation: "createChannel", value: "backend" }),
        "cli",
      ),
    ).toEqual({
      title: 'A channel named "backend" already exists.',
      action: "Use it: `msgr send backend <text>`",
    });
    expect(
      operatorMessage(failure({ cause: "ValidationFailed", operation: "uploadFile" }), "cli"),
    ).toEqual({
      title: "That file is too large.",
      action: "The limit is 25 MB. Send the path instead: `msgr send <channel> <text> --file /abs/path`",
    });
    expect(operatorMessage(failure({ cause: "NotPreviewable" }), "cli")).toEqual({
      title: "This file type has no preview.",
      action: "Read the file at its path directly.",
    });
  });

  test("keeps audience-neutral rows identical", () => {
    const input = failure({ cause: "HerdrCallFailed" });
    expect(operatorMessage(input, "cli")).toEqual(operatorMessage(input, "browser"));
  });

  test("names the leftover pane after a spawn timeout", () => {
    expect(
      operatorMessage(
        failure({
          operation: "spawnAgent",
          cause: "HerdrCallFailed",
          detail: "herdr agent start did not complete: timed out while starting pane w1:spawned-2",
        }),
        "browser",
      ),
    ).toEqual({
      title: "herdr did not answer in time while starting the agent.",
      action:
        "Pane w1:spawned-2 was opened first. If no agent appears in it, close it. Do not retry until the pane is resolved.",
    });
  });

  test("states the cleanup result for a reported spawn failure", () => {
    expect(
      operatorMessage(
        failure({ operation: "spawnAgent", cause: "HerdrCallFailed", detail: "agent start failed" }),
        "cli",
      ),
    ).toEqual({
      title: "The spawn failed.",
      action: "Nothing was created. The pane from the partial spawn was closed.",
    });
  });

  test("names the leftover pane after an unreachable spawn", () => {
    const copy = operatorMessage(
      failure({
        operation: "spawnAgent",
        cause: "HerdrCallFailed",
        detail: "herdr agent start did not complete: agent start failed while starting pane w1:spawned-2",
      }),
      "browser",
    );
    expect(copy.title).toBe("herdr could not confirm the spawn.");
    expect(copy.action).toContain("w1:spawned-2");
  });

  test("does not claim an unresolved cleanup was closed", () => {
    const withPane = operatorMessage(
      failure({
        operation: "spawnAgent",
        cause: "HerdrCallFailed",
        detail: "spawn cleanup pane close failed while cleaning up pane w1:spawned-2; cleanup state is unresolved",
      }),
      "browser",
    );
    expect(withPane.title).toContain("cleanup is unresolved");
    expect(withPane.action).toContain("w1:spawned-2");
    expect(withPane.action).not.toContain("closed");

    const withoutPane = operatorMessage(
      failure({
        operation: "spawnAgent",
        cause: "HerdrCallFailed",
        detail: "pane split timed out; pane identity is unknown; cleanup state is unresolved",
      }),
      "cli",
    );
    expect(withoutPane.action).toContain("unknown");
    expect(withoutPane.action).not.toContain("closed");
  });
});
