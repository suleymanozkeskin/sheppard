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

The installer supports macOS and Linux on ARM64 and x64.

The macOS archives are not signed or notarized. macOS can require manual approval before the first run.

If Bun 1.4.0 or newer is installed, you can also install from npm:

```sh
npm install --global sheppard
```

![A direct conversation between a human and a coding agent in Sheppard](docs/assets/sheppard-ss.png)

![Runtime selection for a coding agent](docs/assets/sheppard-runtime.png)

Agent instructions are in [SKILL.md](SKILL.md).
