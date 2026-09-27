/**
 * `sheppard remote enable | disable | status`.
 *
 * The hub reads the remote setting from the database on every request, so
 * this command writes the database directly and works whether the hub runs or
 * not. `enable` adds the Tailscale mount before it stores the setting, and
 * removes the mount again when the store step fails. `disable` stores the off
 * state first, so remote requests stop even when Tailscale cannot be reached.
 */

import type { ServerConfig } from "./config";
import { openDatabase } from "./db";
import type { DistributionOutput } from "./distribution";
import { validOwnerLogin, validRemoteHost } from "./remote";
import { Store } from "./store";
import type { TailscalePort } from "./tailscale";

export const REMOTE_HELP = `sheppard remote enable     serve Sheppard to your tailnet and allow pairing
sheppard remote disable    stop serving and sign out every paired device
sheppard remote status     show the remote address and paired devices`;

type StoreUse<T> = { kind: "done"; value: T } | { kind: "unavailable" };

/** Opens the hub database for one body and closes it again. */
function withStore<T>(config: ServerConfig, output: DistributionOutput, body: (store: Store) => T): StoreUse<T> {
  const opened = openDatabase(config.databasePath);
  if (opened.isErr()) {
    output.fail(opened.error.message);
    return { kind: "unavailable" };
  }
  try {
    return { kind: "done", value: body(new Store(opened.value)) };
  } finally {
    opened.value.close();
  }
}

async function enable(config: ServerConfig, tailscale: TailscalePort, output: DistributionOutput): Promise<number> {
  const self = await tailscale.self();
  if (self.isErr()) {
    output.fail(self.error.message);
    return 1;
  }
  const host = validRemoteHost(self.value.host);
  const login = validOwnerLogin(self.value.ownerLogin);
  if (host.isErr() || login.isErr()) {
    output.fail(`Tailscale reported a name or login that Sheppard cannot use: ${self.value.host}, ${self.value.ownerLogin}`);
    return 1;
  }

  const served = await tailscale.serveOn(config.port);
  if (served.isErr()) {
    output.fail(served.error.message);
    return 1;
  }

  const stored = withStore(config, output, (store) => store.enableRemoteAccess(host.value, login.value));
  if (stored.kind === "unavailable") {
    const undone = await tailscale.serveOff(config.port);
    if (undone.isErr()) output.fail(`The Tailscale mount could not be removed: ${undone.error.message}`);
    return 1;
  }
  const access = stored.value;
  switch (access.kind) {
    case "off":
      output.fail("Remote access did not turn on.");
      return 1;
    case "on":
      output.write(`Remote access is on at ${access.origin}.`);
      output.write(`Only the Tailscale login ${access.ownerLogin} is admitted.`);
      output.write("Pair a device from the Sheppard web interface on this computer.");
      return 0;
  }
}

async function disable(config: ServerConfig, tailscale: TailscalePort, output: DistributionOutput): Promise<number> {
  const stored = withStore(config, output, (store) => store.disableRemoteAccess());
  if (stored.kind === "unavailable") return 1;
  const { revokedSessions } = stored.value;
  output.write(`Remote access is off. ${revokedSessions} paired ${revokedSessions === 1 ? "device was" : "devices were"} signed out.`);

  const unserved = await tailscale.serveOff(config.port);
  if (unserved.isErr()) {
    output.fail(`Sheppard refuses remote requests now, but the Tailscale mount remains: ${unserved.error.message}`);
    return 1;
  }
  output.write("The Tailscale mount was removed.");
  return 0;
}

function status(config: ServerConfig, output: DistributionOutput): number {
  const stored = withStore(config, output, (store) => ({
    access: store.remoteAccess(),
    sessions: store.listRemoteSessions(),
  }));
  if (stored.kind === "unavailable") return 1;
  const { access, sessions } = stored.value;
  switch (access.kind) {
    case "off":
      output.write("Remote access is off.");
      return 0;
    case "on": {
      output.write(`Remote access is on at ${access.origin} for ${access.ownerLogin}.`);
      output.write(sessions.length === 0 ? "No device is paired." : `Paired devices: ${sessions.length}`);
      for (const session of sessions) {
        const seen = session.lastSeen.kind === "seen" ? `last seen ${session.lastSeen.at}` : "not seen yet";
        output.write(`  #${session.id} ${session.handle}, paired ${session.createdAt}, ${seen}`);
      }
      return 0;
    }
  }
}

export function runRemote(
  argv: readonly string[],
  config: ServerConfig,
  tailscale: TailscalePort,
  output: DistributionOutput,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (rest.length > 0) {
    output.fail(REMOTE_HELP);
    return Promise.resolve(2);
  }
  switch (subcommand) {
    case "enable":
      return enable(config, tailscale, output);
    case "disable":
      return disable(config, tailscale, output);
    case "status":
      return Promise.resolve(status(config, output));
    default:
      output.fail(REMOTE_HELP);
      return Promise.resolve(2);
  }
}
