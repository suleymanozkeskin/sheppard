/**
 * The hub's only contact with the Tailscale CLI.
 *
 * `sheppard remote` reads this machine's MagicDNS name and login from
 * `tailscale status --json`, and adds or removes one `tailscale serve` HTTPS
 * mount. It never runs `tailscale serve reset`, which would also remove mounts
 * that the user made.
 */

import { Result, TaggedError } from "better-result";
import { existsSync } from "node:fs";
import { decodeObject, objectField, optionalString, requiredString, type JsonValue } from "./json";

/** `tailscale status` answers at once; this bounds a wedged daemon. */
const STATUS_TIMEOUT_MS = 10_000;
/** `tailscale serve` can wait while the user approves HTTPS in a browser. */
const SERVE_TIMEOUT_MS = 180_000;
const MACOS_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HTTPS_PORT = "443";

export type TailscaleFailureReason = "missing" | "not-running" | "call-failed" | "reply-invalid";

export class TailscaleFailed extends TaggedError("TailscaleFailed")<{
  reason: TailscaleFailureReason;
  message: string;
}> {}

function failed(reason: TailscaleFailureReason, message: string): TailscaleFailed {
  return new TailscaleFailed({ reason, message });
}

/** This machine as the tailnet sees it. */
export interface TailscaleSelf {
  /** The MagicDNS name without the trailing dot, in lowercase. */
  host: string;
  ownerLogin: string;
}

export interface TailscalePort {
  self: () => Promise<Result<TailscaleSelf, TailscaleFailed>>;
  /** Serves `http://127.0.0.1:<port>` on HTTPS 443 in the background. */
  serveOn: (port: number) => Promise<Result<void, TailscaleFailed>>;
  /** Removes exactly the mount that `serveOn` added. */
  serveOff: (port: number) => Promise<Result<void, TailscaleFailed>>;
}

function loopbackTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Reads `tailscale status --json`. Does no I/O. */
export function parseTailscaleStatus(text: string): Result<TailscaleSelf, TailscaleFailed> {
  const parsed = Result.try({
    try: (): JsonValue => JSON.parse(text),
    catch: () => failed("reply-invalid", "tailscale status did not print JSON"),
  });
  if (parsed.isErr()) return parsed;
  return Result.gen(function* () {
    const status = yield* decodeObject(parsed.value);
    const state = yield* optionalString(status, "BackendState");
    if (state !== "Running") {
      return Result.err(failed("not-running", `Tailscale is not connected (state: ${state ?? "unknown"}). Run \`tailscale up\`.`));
    }
    const self = yield* objectField(status, "Self");
    const dnsName = yield* requiredString(self, "DNSName");
    const userId = self.UserID;
    const users = yield* objectField(status, "User");
    const user = users[String(userId)];
    if (user === undefined || user === null) {
      return Result.err(failed("reply-invalid", "tailscale status names no user for this machine"));
    }
    const ownerLogin = yield* requiredString(yield* decodeObject(user), "LoginName");
    const host = dnsName.replace(/\.$/u, "").toLowerCase();
    if (host.length === 0) {
      return Result.err(failed("reply-invalid", "This machine has no MagicDNS name. Turn on MagicDNS for the tailnet."));
    }
    return Result.ok({ host, ownerLogin });
  }).mapError((error) =>
    TailscaleFailed.is(error) ? error : failed("reply-invalid", `tailscale status: ${error.message}`),
  );
}

/** Runs the Tailscale CLI that is on PATH, or the one inside the macOS app. */
export class CliTailscale implements TailscalePort {
  private readonly binary: string | null;

  constructor(binary: string | null = CliTailscale.locate()) {
    this.binary = binary;
  }

  static locate(): string | null {
    const onPath = Bun.which("tailscale");
    if (onPath !== null) return onPath;
    return existsSync(MACOS_APP_CLI) ? MACOS_APP_CLI : null;
  }

  async self(): Promise<Result<TailscaleSelf, TailscaleFailed>> {
    const run = await this.run(["status", "--json"], STATUS_TIMEOUT_MS, "pipe");
    return run.isErr() ? run : parseTailscaleStatus(run.value);
  }

  async serveOn(port: number): Promise<Result<void, TailscaleFailed>> {
    // Output is shown, because Tailscale can print a link to approve HTTPS.
    const run = await this.run(
      ["serve", "--bg", `--https=${HTTPS_PORT}`, loopbackTarget(port)],
      SERVE_TIMEOUT_MS,
      "inherit",
    );
    return run.isErr() ? run : Result.ok();
  }

  async serveOff(port: number): Promise<Result<void, TailscaleFailed>> {
    const run = await this.run(
      ["serve", `--https=${HTTPS_PORT}`, loopbackTarget(port), "off"],
      STATUS_TIMEOUT_MS,
      "pipe",
    );
    return run.isErr() ? run : Result.ok();
  }

  private missing(): TailscaleFailed {
    return failed("missing", "The Tailscale CLI was not found. Install Tailscale and sign in.");
  }

  /** Runs a command. With "pipe" it returns standard output; with "inherit" the terminal shows it. */
  private async run(
    args: readonly string[],
    timeoutMs: number,
    output: "pipe" | "inherit",
  ): Promise<Result<string, TailscaleFailed>> {
    const binary = this.binary;
    if (binary === null) return Result.err(this.missing());
    const command = `tailscale ${args.join(" ")}`;
    const spawned = Result.try({
      try: () => Bun.spawn({ cmd: [binary, ...args], stdout: output, stderr: output, timeout: timeoutMs }),
      catch: (cause) =>
        failed("call-failed", `${command} could not start: ${cause instanceof Error ? cause.message : "spawn failed"}`),
    });
    if (spawned.isErr()) return spawned;
    const child = spawned.value;
    const [stdout, stderr] = await Promise.all([streamText(child.stdout), streamText(child.stderr)]);
    await child.exited;
    if (child.signalCode !== null) {
      return Result.err(failed("call-failed", `${command} timed out after ${timeoutMs}ms`));
    }
    if (child.exitCode !== 0) {
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
      return Result.err(
        failed("call-failed", `${command} exited with status ${child.exitCode ?? "unknown"}${detail}`),
      );
    }
    return Result.ok(stdout);
  }
}

/** An inherited stream is not readable here and reads as empty text. */
function streamText(stream: ReadableStream<Uint8Array> | number | undefined | null): Promise<string> {
  return stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("");
}
