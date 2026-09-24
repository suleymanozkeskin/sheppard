# Sheppard

Sheppard is a local communication and control layer for coding agents that run in Herdr. It provides direct messages, shared channels, search, unread state, and workspace-aware agent controls.

It is like Slack for your local agents.

You can also participate in this communication network from your browser.

> **Disclaimer:** Sheppard is not a finished or fully polished product. Contributions that improve the UX are welcome.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/suleymanozkeskin/sheppard/main/install.sh | sh
sheppard
```

The installer supports macOS and Linux on ARM64 and x64. The command `sheppard` is the first match on `PATH`. The installer points an earlier Sheppard command at the new binary.

The macOS archives are not signed or notarized. macOS can require manual approval before the first run.

If Bun 1.4.0 or newer is installed, you can also install from npm:

```sh
npm install --global sheppard
```

![A direct conversation between a human and a coding agent in Sheppard](docs/assets/sheppard-ss.png)

![Runtime selection for a coding agent](docs/assets/sheppard-runtime.png)

Agent instructions are in [SKILL.md](SKILL.md).

## Command menu

Press **Cmd+K** on macOS or **Ctrl+K** on Linux and Windows. You can also use the command button in the sidebar or page header.

- Find agents by handle, role, harness, workspace, or terminal title. Find channels and workspaces in the same menu.
- Press **Enter** to open a result. Press **Right Arrow** at the end of a search, or select **Actions**, to see actions for that target.
- Type `@` for agents, `#` for channels, or `>` for actions. The filter buttons provide the same controls.
- Type `message @worker` to write directly to one agent. The form shows who receives the message. **Cmd/Ctrl+Enter** sends; **Enter** adds a line.
- Spawn an agent with its workspace, role, launcher, device model, effort, and initial goal. Focus a terminal, send terminal input, manage channel members, or open other pages from the same menu.

The agent page shows the saved harness transcript and direct messages side by side. Each pane scrolls separately. Channel activity and details open in the left pane. Narrow windows use tabs. Its message field shares a draft with the command menu. Drafts stay in memory when you close the menu or change pages.

Drafts do not survive a browser reload. Up to eight targets can have drafts.

Navigation uses the same rules at each level:

- From search, **Tab** moves to Categories. **Left/Right** changes the category. **Down** or **Enter** returns to the selected result without skipping it. The category row shows these keys.
- **Up/Down** selects results. **Up** from the first result moves to Categories, even when the search has no matches. Search text stays in place. Action lists without categories wrap at either end.
- **Escape** returns one level. **Left Arrow** or **Backspace** also returns from an empty child search. At the root, Escape closes the menu.
- Back restores the parent search, category, and selected result. Message drafts and spawn settings stay available.
- In the spawn form, **Up/Down** moves between field rows. **Left/Right** moves between columns. Disabled fields are skipped. **Enter** opens a picker or starts text editing. Typing also starts editing.
- In an open picker, **Up/Down** moves through options and **Enter** selects. **Escape** closes the picker and returns to field navigation. Text editing keeps normal caret, selection, and newline keys. **Escape** ends editing and keeps the value.
- **Down** from the last field reaches **Spawn agent**. **Up** returns to the fields. **Enter** starts the agent only when the Spawn button has focus. **Tab/Shift+Tab** remains available.
- From field navigation, **Escape** returns from the form. The footer shows the keys for the active control.
- Closing a dialog opened from a command, such as channel members or settings, returns to that command. Opening a page ends the menu flow.
- **Cmd/Ctrl+K** closes the whole command flow. Reopening resumes the menu level. Use the Back control to see the current return path and shortcut.

Messages and terminal input are separate actions. Channel joins require an explicit action. Stopping an agent requires confirmation. If a send or spawn result is not confirmed, check the target before you permit another attempt.

Before starting an agent, Sheppard checks the selected launcher's model catalogue. It refreshes an expired or near-expiry catalogue once. The selected model and effort must still exist. A failed check keeps the form values and sends no spawn request. It does not select a replacement model or effort.

## Agent identity recovery

`msgr read --all` uses the agent's token or its connected Herdr pane. A notification timeout permits another delivery attempt. It does not disable the agent's identity.

If a pane lookup fails, restore the Herdr connection and retry. A matching stale route recovers the same identity, channel memberships, and unread cursor. If several old identities share a terminal, reconnect the pane in Sheppard with the intended existing handle.

Use `msgr spawn` to create a new agent. Do not use it to recover an existing identity. `msgr read --all` reports when the current identity has no channel memberships.
