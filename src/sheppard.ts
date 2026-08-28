import { DEFAULT_PORT, HOST, loadConfig, type ServerConfig } from "./config";
import { readLocalControlToken } from "./control-token";
import { runCli } from "./cli";
import {
  type DistributionOutput,
  type SheppardDistribution,
  uninstallSheppard,
  updateSheppard,
} from "./distribution";
import { CliHerdr } from "./herdr";
import { decodeObject, requiredString, type JsonValue } from "./json";
import { activeHubPid } from "./lock";
import { startHub } from "./server";
import { SHEPPARD_VERSION } from "./version";

const SHEPPARD_HELP = `Sheppard — the agent messaging and control plane for Herdr

  sheppard                       start Sheppard and open the web interface
  sheppard --no-open             start without opening a browser
  sheppard stop                  stop the running Sheppard server
  sheppard update                install the latest verified release
  sheppard --version             print the installed version
  sheppard uninstall [--yes]     remove the standalone commands and keep user data
  sheppard msgr <command...>     run an agent messaging command
  sheppard --help                show this help

Run \`msgr help\` for agent messaging commands.`;

interface HubMetadata {
  name: "sheppard";
  version: string;
}

export interface SheppardMainOptions {
  argv?: readonly string[];
  distribution?: SheppardDistribution;
  env?: Bun.Env;
  output?: DistributionOutput;
  processControl?: SheppardProcessControl;
  webAssets?: ReadonlyMap<string, string>;
}

export interface SheppardProcessControl {
  activeHubPid: (databasePath: string) => number | null;
  signal: (pid: number) => void;
  wait: (milliseconds: number) => Promise<void>;
}

const PROCESS_CONTROL: SheppardProcessControl = {
  activeHubPid,
  signal: (pid) => process.kill(pid, "SIGTERM"),
  wait: (milliseconds) => Bun.sleep(milliseconds),
};

async function stopSheppard(
  config: ServerConfig,
  output: DistributionOutput,
  processControl: SheppardProcessControl,
): Promise<number> {
  const pid = processControl.activeHubPid(config.databasePath);
  if (pid === null) {
    output.write("Sheppard is not running.");
    return 0;
  }

  try {
    processControl.signal(pid);
  } catch (cause) {
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    output.fail(`Sheppard could not stop process ${pid}.${detail}`);
    return 1;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await processControl.wait(50);
    if (processControl.activeHubPid(config.databasePath) === null) {
      output.write("Sheppard stopped.");
      return 0;
    }
  }

  output.fail(`Sheppard process ${pid} did not stop.`);
  return 1;
}

function commandArguments(argv: readonly string[], command: string): readonly string[] {
  return argv[0] === command ? argv.slice(1) : argv;
}

function onlyFlags(argv: readonly string[], allowed: ReadonlySet<string>): boolean {
  return argv.every((argument) => allowed.has(argument));
}

async function runningHub(url: string): Promise<HubMetadata | null> {
  try {
    const response = await fetch(`${url}/api/meta`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body: JsonValue = await response.json();
    const object = decodeObject(body);
    if (object.isErr()) return null;
    const name = requiredString(object.value, "name");
    const version = requiredString(object.value, "version");
    if (name.isErr() || version.isErr() || name.value !== "sheppard") return null;
    return { name: "sheppard", version: version.value };
  } catch {
    return null;
  }
}

function browserCommand(url: string): readonly string[] | null {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "linux": {
      const xdgOpen = Bun.which("xdg-open");
      if (xdgOpen !== null) return [xdgOpen, url];
      const gio = Bun.which("gio");
      return gio === null ? null : [gio, "open", url];
    }
    default:
      return null;
  }
}

function openBrowser(url: string, output: DistributionOutput): void {
  const command = browserCommand(url);
  if (command === null) {
    output.write(`Open ${url} in a browser.`);
    return;
  }
  try {
    const child = Bun.spawn({ cmd: command, stderr: "ignore", stdout: "ignore" });
    child.unref();
  } catch {
    output.write(`Open ${url} in a browser.`);
  }
}

async function serveSheppard(
  config: ServerConfig,
  shouldOpenBrowser: boolean,
  output: DistributionOutput,
): Promise<number> {
  const url = `http://${HOST}:${config.port}`;
  const existing = await runningHub(url);
  if (existing !== null) {
    output.write(`Sheppard ${existing.version} is already running at ${url}.`);
    if (shouldOpenBrowser) openBrowser(url, output);
    return 0;
  }

  let started: ReturnType<typeof startHub>;
  try {
    started = startHub(config);
  } catch (cause) {
    output.fail(cause instanceof Error ? cause.message : "Sheppard could not start.");
    return 1;
  }
  if (started.isErr()) {
    output.fail(started.error.message);
    return 1;
  }

  const hub = started.value;
  const boundUrl = `http://${HOST}:${hub.port}`;
  output.write(`Sheppard ${config.applicationVersion ?? SHEPPARD_VERSION} is running at ${boundUrl}.`);
  output.write(`Data: ${config.databasePath}`);
  output.write(hub.notifier === null
    ? "Herdr connection unavailable. Messaging works, but workspace control and push are disabled."
    : "Connected to Herdr.");
  if (shouldOpenBrowser) openBrowser(boundUrl, output);

  const shutdown = (): void => {
    hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => undefined);
  return 0;
}

async function runMsgr(
  argv: readonly string[],
  env: Bun.Env,
  config: ServerConfig,
  output: DistributionOutput,
): Promise<number> {
  const insideHerdr = env.HERDR_ENV === "1";
  return runCli({
    argv,
    env,
    fail: output.fail,
    herdr: insideHerdr ? new CliHerdr() : null,
    serverConfig: config,
    localControlToken: readLocalControlToken(config.databasePath),
    write: output.write,
  });
}

export async function runSheppard(options: SheppardMainOptions = {}): Promise<number> {
  const argv = options.argv ?? Bun.argv.slice(2);
  const env = options.env ?? Bun.env;
  const output = options.output ?? {
    fail: (line: string) => console.error(line),
    write: (line: string) => console.log(line),
  };
  const distribution = options.distribution ?? { kind: "source" };
  const processControl = options.processControl ?? PROCESS_CONTROL;
  const config: ServerConfig = {
    ...loadConfig(env),
    applicationVersion: SHEPPARD_VERSION,
    webAssets: options.webAssets,
  };
  const [command] = argv;

  switch (command) {
    case undefined:
      return serveSheppard(config, true, output);
    case "--no-open":
      return onlyFlags(argv, new Set(["--no-open"]))
        ? serveSheppard(config, false, output)
        : usageError(output);
    case "serve": {
      const args = commandArguments(argv, "serve");
      return onlyFlags(args, new Set(["--no-open"]))
        ? serveSheppard(config, !args.includes("--no-open"), output)
        : usageError(output);
    }
    case "--help":
    case "help":
      output.write(SHEPPARD_HELP);
      return 0;
    case "--version":
    case "version":
      output.write(`sheppard ${SHEPPARD_VERSION}`);
      return 0;
    case "stop":
      return argv.length === 1
        ? stopSheppard(config, output, processControl)
        : usageError(output);
    case "update":
      return argv.length === 1
        ? updateSheppard(distribution, SHEPPARD_VERSION, config, output)
        : usageError(output);
    case "uninstall": {
      const args = commandArguments(argv, "uninstall");
      return onlyFlags(args, new Set(["--yes"]))
        ? uninstallSheppard(distribution, config, args.includes("--yes"), output)
        : usageError(output);
    }
    case "msgr":
      return runMsgr(commandArguments(argv, "msgr"), env, config, output);
    default:
      output.fail(`Unknown Sheppard command: ${command}`);
      return usageError(output);
  }
}

function usageError(output: DistributionOutput): number {
  output.fail(SHEPPARD_HELP);
  return 2;
}

export async function main(options: SheppardMainOptions = {}): Promise<void> {
  const code = await runSheppard(options);
  process.exit(code);
}

export { DEFAULT_PORT, SHEPPARD_VERSION };
