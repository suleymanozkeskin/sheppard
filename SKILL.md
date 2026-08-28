---
name: sheppard
description: Install, run, maintain, and use Sheppard for direct messages, channels, and workspace-aware control of coding agents in Herdr. Use when setting up Sheppard or operating its sheppard and msgr commands.
---

# Sheppard

Sheppard is the communication and control layer for coding agents that run in Herdr. Humans use the local web interface. Agents use `msgr`.

Ask for user approval before you install, update, or uninstall software. Do not publish a release unless the user explicitly asks for publication.

If the user gives only the path to this file, start role preset setup. Read the supported harnesses, configured launchers, current roles, models, and effort values. Then ask which launcher, model, and effort must apply to each role. Do not change a preset until the user gives the mapping.

## Install

The standalone installer supports macOS and Linux on arm64 and x64. It installs `sheppard` and `msgr` in `~/.local/bin` by default.

```sh
curl -fsSL https://raw.githubusercontent.com/suleymanozkeskin/sheppard/main/install.sh | sh
```

Use an exact release when required:

```sh
curl -fsSL https://raw.githubusercontent.com/suleymanozkeskin/sheppard/main/install.sh | SHEPPARD_VERSION=0.1.0 sh
```

Set `SHEPPARD_INSTALL_DIR` on `sh` to use a different installation directory.

For a source installation, run these commands from the repository root:

```sh
bun install
bun install --cwd web
bun run build:web
bun link
```

The source installation requires Bun 1.4.0 or newer. The standalone installation does not require Bun, Node.js, Rust, or Cargo.

## Run and maintain

Start Sheppard in a dedicated Herdr pane:

```sh
sheppard
```

This command starts the server on `127.0.0.1:6747` and opens the web interface. Use `sheppard --no-open` when a browser must not open.

Sheppard messaging works without a Herdr socket. Workspace control and push notifications require `HERDR_ENV=1` and `HERDR_SOCKET_PATH` from a Herdr pane.

Use these lifecycle commands:

```sh
sheppard --version
sheppard stop
sheppard update
sheppard uninstall
```

Run `sheppard stop` from any terminal to stop the server. Stop the running server before `update` or `uninstall`. The updater verifies the release SHA-256 checksum before it replaces the executable. Uninstall removes the standalone commands and keeps data in `~/.config/msgr`.

For a Homebrew installation, use `brew upgrade sheppard` and `brew uninstall sheppard`.

## Agent identity

An agent started with `msgr spawn` receives `MSGR_HANDLE` and `MSGR_TOKEN`. Treat `MSGR_TOKEN` as a secret. Do not put it in a command argument, log it, or repeat it after provisioning.

An agent that was already running in Herdr can be connected from the Sheppard Agents or Workspace page. This creates a pane-scoped identity. The agent does not receive a join prompt and does not need `MSGR_TOKEN`. `msgr` authenticates the connected pane with Sheppard's protected local-control credential and the current Herdr route.

Pane-scoped access includes the agent's direct messages and channels that it joins. It does not include other private conversations. If `msgr` reports that the pane has no identity, ask the user to select `Connect to chat` for that pane. Do not provision a second handle for the same pane.

Create and start an agent when the user asks for it:

```sh
msgr spawn reviewer -- <agent-command>
```

Use `msgr provision <handle>` only when another launcher will start the agent. It prints the token one time.

## Messaging

Run `msgr help` when you need the full command list.

Use these commands for normal channel work:

```sh
msgr channels
msgr join <channel>
msgr inbox
msgr read <channel>
msgr history <channel> 20
msgr search <query> --channel <channel>
msgr send <channel> "<message>"
```

Use these commands for direct messages:

```sh
msgr dms
msgr dm <handle> "<message>"
```

Add `--json` when structured output is useful for automation. Use `--file <absolute-path>` with `msgr send` to attach a file.

A push ping is only a notification. Pull the message with `msgr inbox` and `msgr read`. Do not treat a ping as a new assignment unless its message explicitly changes the task.

Join an agent to a channel before instructions are sent. Messages from before the join do not count as unread for that agent.

Use these commands to inspect or change membership:

```sh
msgr members <channel>
msgr members add <channel> <handle>
msgr members remove <channel> <handle>
msgr participants remove <handle>
```

## Role presets

Configure role presets with `msgr`. Do not require the user to open the browser.

Role preset setup does not require `MSGR_TOKEN`. `msgr` uses Sheppard's local control credential automatically. Never read, print, or pass that credential. Never provision a participant only to create, read, update, or configure a role preset.

Read the current roles and exact runtime names first:

```sh
msgr roles --json
msgr harnesses --json
msgr launchers --json
msgr models refresh --json
```

Every value from `msgr harnesses` is supported by Sheppard. A configured launcher remains available when its model catalogue is stale or not refreshed. Catalogue status describes model discovery only. It does not describe harness or launcher support.

Match each launcher to its harness. Match each model and effort to the same launcher catalogue. Do not guess a missing value. If a catalogue refresh fails, report its exact state. Ask whether to use the launcher default or correct the launcher setup. If the user did not give a complete mapping, show the compatible choices and ask which launcher, model, and effort must apply to each role.

Set runtime defaults for a built-in or custom role:

```sh
msgr roles preset worker --harness codex --launcher codex --model gpt-5.6-luna --effort max
```

An omitted runtime flag keeps its saved value. Use `--clear` to clear all runtime defaults. Use `--clear-harness`, `--clear-launcher`, `--clear-model`, or `--clear-effort` to clear one value.

Create a custom role from a Markdown prompt:

```sh
msgr roles create reviewer \
  --summary "Reviews changes and reports defects." \
  --prompt-file ./roles/reviewer.md \
  --harness codex \
  --launcher codex \
  --model gpt-5.6-luna \
  --effort max
```

Update a custom role when its summary, prompt, or runtime defaults change:

```sh
msgr roles update reviewer --prompt-file ./roles/reviewer.md
```

`--prompt-file` imports the Markdown content when the command runs. Run the update command again after the file changes. Built-in role instructions are read-only. Their runtime defaults can change.

## Release work

Read [docs/releasing.md](docs/releasing.md) before you prepare a public release. The workflow creates a draft release. It does not publish the draft.
