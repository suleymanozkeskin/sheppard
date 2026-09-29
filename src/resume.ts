/**
 * Resuming an agent's harness session after its terminal ended.
 *
 * A restart gives every Herdr terminal a new id and ends every route. An
 * identity whose last terminal had an exact session mapping (the briefing
 * named its handle, or the human chose the session) can start again in a new
 * pane with the harness's own resume argument. The conversation continues and
 * the identity keeps its channels, direct messages, and unread state.
 *
 * Everything here is pure: harness arguments, session storage roots, and the
 * choice of launcher. The server does the I/O.
 */

import { sep } from "node:path";
import { claudeConfigDir, codexHome, grokHome, opencodeDataDir, piAgentDir } from "./transcripts";

/** The harnesses that can resume a session by its id. */
export type ResumableHarness = "claude" | "codex" | "grok" | "pi" | "opencode";

export function resumableHarness(kind: string): ResumableHarness | null {
  switch (kind) {
    case "claude":
    case "codex":
    case "grok":
    case "pi":
    case "opencode":
      return kind;
    default:
      return null;
  }
}

/**
 * The arguments that continue one session, appended after the launcher's own
 * arguments. Codex takes a subcommand; the others take an option.
 */
export function resumeArgv(harness: ResumableHarness, sessionId: string): readonly string[] {
  switch (harness) {
    case "claude":
      return ["--resume", sessionId];
    case "codex":
      return ["resume", sessionId];
    case "grok":
      return ["--resume", sessionId];
    case "pi":
      return ["--session", sessionId];
    case "opencode":
      return ["--session", sessionId];
  }
}

/**
 * The folder under which a harness writes its sessions for one launch
 * environment. The session readers own these locations; this is the same
 * rule, not a copy of it.
 */
export function sessionRoot(harness: ResumableHarness, env: Readonly<Record<string, string | undefined>>): string {
  switch (harness) {
    case "claude":
      return claudeConfigDir(env).dir;
    case "codex":
      return codexHome(env).dir;
    case "grok":
      return grokHome(env).dir;
    case "pi":
      return piAgentDir(env).dir;
    case "opencode":
      return opencodeDataDir(env).dir;
  }
}

/** A registered launcher, as far as the launcher choice needs it. */
export interface LauncherCandidate {
  name: string;
  agentKind: string;
  env: Readonly<Record<string, string>>;
}

/**
 * Which launcher starts the resumed session.
 * - `recorded`: the launcher that started the agent, still registered.
 * - `matched`: the one launcher of this harness whose session root holds the
 *   session file.
 * - `choose`: two or more launchers fit; the human picks one of `launchers`.
 * - `none`: no registered launcher of this harness holds the session.
 */
export type LauncherMatch =
  | { kind: "recorded"; launcher: string }
  | { kind: "matched"; launcher: string }
  | { kind: "choose"; launchers: readonly string[] }
  | { kind: "none" };

function insideRoot(path: string, root: string): boolean {
  const withSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(withSeparator);
}

/** Decides the launcher for a session. Does no I/O. */
export function matchLauncher(
  harness: ResumableHarness,
  sessionPath: string,
  recorded: string | null,
  launchers: readonly LauncherCandidate[],
): LauncherMatch {
  const ofHarness = launchers.filter((launcher) => launcher.agentKind === harness);
  if (recorded !== null && ofHarness.some((launcher) => launcher.name === recorded)) {
    return { kind: "recorded", launcher: recorded };
  }
  const holding = ofHarness.filter((launcher) => insideRoot(sessionPath, sessionRoot(harness, launcher.env)));
  const [only] = holding;
  if (holding.length === 1 && only !== undefined) return { kind: "matched", launcher: only.name };
  if (holding.length > 1) return { kind: "choose", launchers: holding.map((launcher) => launcher.name) };
  return { kind: "none" };
}
