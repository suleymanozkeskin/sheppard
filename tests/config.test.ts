import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("configuration", () => {
  test("enables extra human identities only for the exact QA flag", () => {
    expect(loadConfig({ MSGR_ALLOW_EXTRA_HUMANS: "1" }).allowExtraHumans).toBe(true);
    expect(loadConfig({ MSGR_ALLOW_EXTRA_HUMANS: "0" }).allowExtraHumans).toBe(false);
    expect(loadConfig({ MSGR_ALLOW_EXTRA_HUMANS: "yes" }).allowExtraHumans).toBe(false);
  });

  test("accepts provider-qualified model seeds and filters invalid identifiers", () => {
    const config = loadConfig({
      MSGR_MODELS: JSON.stringify([
        {
          harness: "codex",
          name: "openai/gpt-5.6",
          kind: "model",
          argvSuffix: ["-m", "openai/gpt-5.6"],
        },
        { harness: "codex", name: "bad\nmodel", kind: "model" },
        { harness: "codex", name: "$(uname)", kind: "model" },
      ]),
    });

    expect(config.models).toEqual([
      {
        harness: "codex",
        name: "openai/gpt-5.6",
        kind: "model",
        argvSuffix: ["-m", "openai/gpt-5.6"],
      },
      { harness: "codex", name: "$(uname)", kind: "model", argvSuffix: [] },
    ]);
  });
});
