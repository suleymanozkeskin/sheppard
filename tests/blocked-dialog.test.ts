import { describe, expect, test } from "bun:test";
import { classifyBlockedScreen } from "../src/blocked-dialog";

// Visible screens captured from Claude Code v2.1.283 in herdr.

const QUESTION = `❯ Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces.
────────────────────────────────────────────────────────────
 ☐ Indentation

Do you prefer tabs or spaces for indentation?

❯ 1. Tabs
     Use tab characters for indentation
  2. Spaces
     Use spaces for indentation
  3. Type something.
────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const MULTI_QUESTION = `────────────────────────────────────────────────────────────
←  ☐ Indentation  ☐ Theme  ✔ Submit  →

Do you prefer tabs or spaces for indentation?

❯ 1. Tabs
     Use tab characters for indentation
  2. Spaces
     Use spaces for indentation
  3. Type something.
────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const BASH_PERMISSION = `⏺ Creating a file named probe-file.txt
────────────────────────────────────────────────────────────
 Bash command

   touch probe-file.txt
   Create a file named probe-file.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/probe from this project
   3. No

 Esc to cancel · Tab to amend
`;

const EDIT_PERMISSION = `────────────────────────────────────────────────────────────
 Edit file
 memory/keep-awake-feature.md

 Do you want to make this edit to keep-awake-feature.md?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
`;

const FOLDER_TRUST = `────────────────────────────────────────────────────────────
 Accessing workspace:

 /tmp/probe

 Quick safety check: Is this a project you created or one you trust?

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const IDLE_PROMPT = `⏺ Do you want to proceed? I can run the tests next.
  1. No rush
────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
   Haiku 4.5   HEAD   probe
`;

describe("classifyBlockedScreen", () => {
  test("names a single question dialog", () => {
    expect(classifyBlockedScreen("claude", QUESTION)).toEqual({ kind: "question" });
  });

  test("names a dialog with several questions", () => {
    expect(classifyBlockedScreen("claude", MULTI_QUESTION)).toEqual({ kind: "question" });
  });

  test("names a command permission dialog", () => {
    expect(classifyBlockedScreen("claude", BASH_PERMISSION)).toEqual({ kind: "permission" });
  });

  test("names a file edit permission dialog", () => {
    expect(classifyBlockedScreen("claude", EDIT_PERMISSION)).toEqual({ kind: "permission" });
  });

  test("refuses the folder-trust dialog, where Escape exits the agent", () => {
    expect(classifyBlockedScreen("claude", FOLDER_TRUST)).toEqual({
      kind: "unrecognized",
      reason: "folder-trust",
    });
  });

  test("refuses dialog words that are not anchored by the live footer", () => {
    expect(classifyBlockedScreen("claude", IDLE_PROMPT)).toEqual({
      kind: "unrecognized",
      reason: "no-known-dialog",
    });
  });

  test("refuses an untested harness even on a matching screen", () => {
    expect(classifyBlockedScreen("codex", QUESTION)).toEqual({
      kind: "unrecognized",
      reason: "harness-unsupported",
    });
    expect(classifyBlockedScreen(null, QUESTION)).toEqual({
      kind: "unrecognized",
      reason: "harness-unsupported",
    });
  });
});
