/**
 * Recognises the dialog on a blocked agent's screen.
 *
 * The hub closes a dialog only when it can name it. The close key is Escape,
 * and Escape is safe only on dialogs where it declines: a question (the agent
 * reads "User declined to answer questions") and a permission request (the
 * action does not run). On the folder-trust dialog Escape exits the agent, and
 * on an unknown dialog its effect is unknown, so both are `unrecognized` and
 * the hub alerts the human instead of pressing anything.
 *
 * Every marker must hold at once, and the footer must be the last non-empty
 * line. A match on older conversation text above the live dialog cannot pass
 * that anchor.
 */

/** How many screen lines the hub reads from a blocked pane. */
export const DIALOG_SCREEN_LINES = 40;

export type UnrecognizedReason = "harness-unsupported" | "folder-trust" | "no-known-dialog";

export type BlockedDialog =
  | { kind: "question" }
  | { kind: "permission" }
  | { kind: "unrecognized"; reason: UnrecognizedReason };

/** Harnesses whose dialogs were tested against the Escape rule. */
export type TestedHarness = "claude";

const ESCAPE_FOOTER = /\bEsc to cancel\b/u;
const FOLDER_TRUST = /\btrust this folder\b/u;
const QUESTION_FREE_TEXT = /^\s*(?:❯\s*)?\d+\.\s+Type something\.?\s*$/mu;
const QUESTION_CHAT = /^\s*(?:❯\s*)?\d+\.\s+Chat about this\s*$/mu;
const PERMISSION_PROMPT = /^\s*Do you want to .+\?\s*$/mu;
const PERMISSION_DENY = /^\s*(?:❯\s*)?\d+\.\s+No\b/mu;

function testedHarness(harness: string | null): TestedHarness | null {
  switch (harness) {
    case "claude":
      return "claude";
    default:
      return null;
  }
}

function lastNonEmptyLine(screen: string): string {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0) return line;
  }
  return "";
}

function classifyClaude(screen: string): BlockedDialog {
  if (FOLDER_TRUST.test(screen)) return { kind: "unrecognized", reason: "folder-trust" };
  if (!ESCAPE_FOOTER.test(lastNonEmptyLine(screen))) {
    return { kind: "unrecognized", reason: "no-known-dialog" };
  }
  if (QUESTION_FREE_TEXT.test(screen) && QUESTION_CHAT.test(screen)) return { kind: "question" };
  if (PERMISSION_PROMPT.test(screen) && PERMISSION_DENY.test(screen)) return { kind: "permission" };
  return { kind: "unrecognized", reason: "no-known-dialog" };
}

/**
 * Names the dialog on the visible screen of a blocked pane. `harness` is the
 * agent kind herdr reports for the pane. Does no I/O.
 */
export function classifyBlockedScreen(harness: string | null, screen: string): BlockedDialog {
  const tested = testedHarness(harness);
  if (tested === null) return { kind: "unrecognized", reason: "harness-unsupported" };
  switch (tested) {
    case "claude":
      return classifyClaude(screen);
  }
}
