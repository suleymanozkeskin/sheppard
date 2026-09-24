import type { ShellRoute } from "@/shell-routing"

import { commandChoice, commandEntry, type CommandEntry, type CommandGlyph, type SpawnLocation } from "./types"

const PAGES: readonly {
  readonly title: string
  readonly description: string
  readonly glyph: CommandGlyph
  readonly route: ShellRoute
}[] = [
  {
    title: "Search messages",
    description: "Find decisions, reports, and earlier messages",
    glyph: "search",
    route: { kind: "search", query: "", scope: "all" },
  },
  {
    title: "All agents",
    description: "Running agents and their chat connections",
    glyph: "agent",
    route: { kind: "agents" },
  },
  { title: "All channels", description: "Browse shared conversations", glyph: "channel", route: { kind: "channels" } },
  {
    title: "All workspaces",
    description: "Projects, panes, and agent status",
    glyph: "workspace",
    route: { kind: "workspaces" },
  },
  {
    title: "Direct conversations",
    description: "Your direct and group messages",
    glyph: "message",
    route: { kind: "direct" },
  },
  {
    title: "Attachments",
    description: "Find shared files and images",
    glyph: "file",
    route: { kind: "attachments", scope: "all", attachmentKind: "all" },
  },
  {
    title: "Role presets",
    description: "Jobs, briefings, and saved runtime settings",
    glyph: "role",
    route: { kind: "staffing" },
  },
  {
    title: "Launchers",
    description: "Harnesses, accounts, and process settings",
    glyph: "terminal",
    route: { kind: "launchers" },
  },
]

export function defaultCommands(location: SpawnLocation): readonly CommandEntry[] {
  const choices = [
    commandChoice(
      "action:message",
      "Send a message…",
      "Choose an agent or channel, then write",
      "message",
      { kind: "recipients" },
      "action",
      "send dm chat message",
    ),
    commandChoice(
      "action:spawn",
      "Spawn agent…",
      "Choose a role, runtime, and goal",
      "spawn",
      { kind: "spawn", location },
      "action",
      "new start create hire worker lead reporter",
    ),
    commandChoice(
      "action:inbox",
      "Open inbox",
      "Unread work across your conversations",
      "inbox",
      { kind: "shell", name: "inbox" },
      "action",
      "unread attention notifications",
    ),
    commandChoice(
      "action:create-channel",
      "Create channel…",
      "Start a shared collaboration space",
      "plus",
      { kind: "shell", name: "create-channel" },
      "action",
      "new channel",
    ),
    commandChoice(
      "action:create-workspace",
      "Create workspace…",
      "Open a local project in Herdr",
      "workspace",
      { kind: "shell", name: "create-workspace" },
      "action",
      "new project folder",
    ),
    ...PAGES.map((page) =>
      commandChoice(
        `page:${page.route.kind}`,
        page.title,
        page.description,
        page.glyph,
        { kind: "navigate", route: page.route },
        "page",
      ),
    ),
    commandChoice(
      "action:settings",
      "Settings",
      "Theme and keyboard shortcuts",
      "settings",
      { kind: "shell", name: "settings" },
      "action",
      "preferences configure",
    ),
    commandChoice(
      "action:help",
      "Keyboard shortcuts",
      "Learn and use Sheppard's shortcuts",
      "keyboard",
      { kind: "shell", name: "help" },
      "action",
      "help keys",
    ),
    commandChoice("theme:light", "Use light theme", "A light appearance", "theme", { kind: "theme", mode: "light" }),
    commandChoice("theme:dark", "Use dark theme", "A dark appearance", "theme", { kind: "theme", mode: "dark" }),
    commandChoice("theme:system", "Use system theme", "Follow your device appearance", "theme", {
      kind: "theme",
      mode: "system",
    }),
  ]
  return Object.freeze(choices.map((choice) => commandEntry(choice)))
}
