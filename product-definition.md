# Sheppard product definition

This document defines the target product and its required behavior. It is not
an implementation-status report.

## 1. Purpose

Sheppard is a browser control plane and durable communication hub for coding
agents that run in Herdr. It lets one human manage many projects, harnesses,
agent sessions, and collaboration groups from one browser tab.

The repository uses the technical name `sheppard`. The command-line client uses
`msgr`. Herdr supplies workspaces, tabs, panes, process lifecycle, agent
detection, and live status. Sheppard supplies participant accounts, staffing,
messages, notifications, search, and project-level control.

## 2. Product promise

A user can create a project workspace, start a lead, give it a goal, and watch
the lead staff and coordinate the project. The lead and its workers communicate
through `msgr`. Their communication stays durable, searchable, and separate
from their harness conversations.

Every agent started by Sheppard must start able to use `msgr`. A human can also
connect an agent that is already running in Herdr. The agent must not complete
its own connection setup through an injected prompt, a token-file command, or a
manual enrollment step.

## 3. System model

```text
Human
  | browser
  v
Sheppard hub
  |-- project and workspace control
  |-- agent staffing and lifecycle
  |-- roles, models, and launchers
  |-- channels, direct messages, and history
  `-- search, unread state, and session views
          |
          | Herdr APIs
          v
Herdr workspaces, tabs, panes, and harness processes
          |
          | msgr
          v
Lead agents and worker agents
```

Sheppard uses Herdr as the source of live terminal topology. Sheppard does not
replace Herdr or copy its process-management responsibilities.

## 4. Product objects

| Object | Meaning |
|---|---|
| workspace | A project context and process boundary in Herdr. |
| tab | A subcontext inside a workspace. It is not a message boundary. |
| pane | A terminal process host. A pane can contain an agent or a plain shell. |
| participant | A durable Sheppard account with a handle and message history. |
| agent | A harness session in a Herdr pane that acts as a participant. |
| lead | A product-defined agent role that coordinates one workspace. |
| role | A reusable job preset with a summary, briefing, and staffing defaults. |
| launcher | A user-owned process-start definition for one harness kind, including its fixed argv and private environment. |
| model | A model reported by one launcher. |
| effort | A reasoning-effort value reported for one model by one launcher. |
| channel | A durable, named collaboration space with explicit membership. |
| direct conversation | A durable conversation with fixed participants. |
| workspace broadcast | A message to the currently routed agents in one workspace. |

These objects are independent where their jobs differ. A workspace is not a
channel. A channel is not owned by one workspace. A role is not a permission
level.

## 5. Human control flow

1. The human opens Sheppard in a browser.
2. Sheppard shows every Herdr workspace, tab, pane, and detected agent.
3. The human creates or selects a project workspace.
4. The human selects a lead role, launcher, model, effort, handle, and goal.
5. Sheppard provisions the lead before the harness starts.
6. Herdr starts the lead with working `msgr` access.
7. The human watches the lead through its status, messages, route, and session view.
8. The human can create, focus, stop, or inspect workspaces, tabs, panes, and agents.

The browser is the control surface for the whole fleet. The rail shows the
objects that need attention. Directory pages show complete object families.
Detail pages provide all controls for one object.

## 6. Lead and staffing flow

Each workspace has at most one active native lead. The lead uses an ordinary
agent participant account. Its role does not give it a separate permission
level.

The native lead receives a product-owned coordination briefing and the human's
project goal. The human chooses the lead's launcher and model when the lead
starts.

The lead can use `msgr` to:

- list available roles;
- list launchers, models, and launcher-specific effort choices;
- start agents in its workspace with a selected role and goal;
- create or use collaboration channels;
- add the required participants to a channel;
- send assignments and receive progress or completion messages;
- search and refer to earlier messages.

The lead coordinates agents through roles, goals, and messages. It does not type
into another agent's terminal. A role briefing gives the new agent its stable
job instructions. A goal gives it the current task.

## 7. Agent startup and access

Automatic `msgr` access is a startup invariant for every agent that Sheppard
starts. An existing Herdr agent can use a separate, explicit pane connection.

Herdr must provide one pre-start integration point for starts from the
Sheppard browser, the Herdr UI, the Herdr CLI, and supported harness adapters.
Sheppard uses this point to provision the identity before the harness process
exists. A supported managed-agent start must not continue if this provisioning
fails.

Before the harness process starts, the platform must:

1. provision or select the participant account;
2. assign the final handle;
3. provide `MSGR_URL`, `MSGR_HANDLE`, and `MSGR_TOKEN` to the process environment.

After Herdr confirms the harness start, the platform must bind the participant
route to the durable terminal. This must finish without an action from the
agent. The participant must then be available to staffing and channel controls.

Topology discovery is read-only. It reports occupied panes and reconciles known
stale routes. It never provisions participants, writes token files, joins
channels, or prompts agents. The human can select `Connect to chat` for an
occupied agent pane. This action provisions a participant and binds it to the
current durable terminal without prompting or restarting the agent.

The token is process state. It must not appear in command arguments, prompt
text, terminal output, logs, topology events, or browser responses. The agent
must not read a token file to activate itself.

Connection setup and channel membership are separate operations. Automatic
access does not add an agent to every channel. A human, a lead, or the agent
selects channel membership as part of collaboration.

An agent that did not use the pre-start integration point starts as an
unconnected agent. Sheppard must show this state and provide the human-only
connection action. It must not ask the running agent to repair the setup
through its conversation.

## 8. Channels and communication

A channel is a persistent collaboration space for any required group of
participants. A project can use many channels. A channel can include agents
from different workspaces when the work requires it.

Typical channel scopes include:

- project coordination;
- one feature or implementation lane;
- review and verification;
- incident response;
- research or design;
- progress reporting.

Channel membership is explicit. A new member's unread cursor starts at the
channel high-water mark. Earlier messages stay available through history and
search, but they do not become new unread work.

Messages have stable senders, channel names, and message identifiers. Agents
can refer to earlier decisions without copying a full conversation into their
harness session. Attachments and message context remain available through the
hub.

Direct conversations use the same durable message model with fixed membership.
Workspace broadcasts use an internal workspace channel and target the agents
that are currently routed in that workspace. A broadcast does not replace named
collaboration channels.

## 9. Pull-based delivery

Message content stays in Sheppard. An agent pulls content with `msgr inbox`,
`msgr read`, `msgr history`, or `msgr search`.

Herdr prompt injection is only a notification path. A notification contains the
unread count, sender handles, channel names, and a pull command. It does not
contain message bodies, goals, file paths, or hidden instructions.

A ping is an interruption, not a reassignment. The agent reads the referenced
messages and changes work only when a message explicitly changes its assignment.
Delivery can occur more than once, but the unread cursor is the source of truth.

## 10. Roles, models, and launchers

A role answers what job an agent performs. A launcher alias is user-owned and
answers how its canonical harness process starts. Users can create multiple
aliases for one harness. Each alias has a name, canonical harness, structured
arguments, a private environment, and an optional account profile. Alias names
are registry values, never shell expansion.

The launcher environment is part of the launcher identity. Catalogue discovery
and spawn use the same account environment. The default UI offers folder
presets for Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Pi
`PI_CODING_AGENT_DIR`, and OpenCode `XDG_CONFIG_HOME` plus `XDG_DATA_HOME`.
The general environment editor remains an advanced control. Public launcher
reads return environment key names only, never values.

The logical harness kind remains the lifecycle and pane identity. A launcher
can use a different executable, which Herdr receives as a separate field with
the structured argument list. Shell expansion and shell command strings are
not accepted. Canonical launchers keep the old Herdr start form for backward
compatibility.

Sheppard ships these native roles: `lead`, `reporter`, `planner`,
`web-searcher`, `tester`, `ui-ux-designer`, and `worker`. Native role
identity (`name`, `summary`) and briefing are product-owned and read-only. The
local runtime policy is user-editable. All seven native roles are
harness-neutral. The user or lead chooses an installed supported launcher and
one of that launcher's available models when it starts an agent. Reporter keeps
its special one-per-workspace and read-only observer behavior, but it does not
require a harness.

Sheppard supports `codex`, `claude`, `pi`, and `opencode` by default. The
selected launcher is the authority for its device model catalogue. Two
launchers for one harness can report different models because they can use
different accounts, settings, providers, or policies. A catalogue entry must
state when that launcher is unavailable or cannot report its models. Sheppard
must not show an invented or stale static model list as an available device
catalogue.

Model and effort selection is dependent data. The selected role limits the
compatible launchers. The selected launcher supplies its current device
models. Each model supplies only the effort values that the same launcher
reports for that model. A client must clear a selected model or effort when an
earlier selection makes it invalid. A global effort list is not permitted.

The agent creation page uses searchable, keyboard-accessible selection controls
for workspaces, roles, harnesses, models, and effort values. Each native role
has a product-owned icon. Each supported harness uses its product icon. The
page must distinguish loading, stale, unavailable, unsupported, default-only,
and empty catalogue states. A discovery failure must include a retry action and
must not be shown as an empty model result.

Product invariant: The workspace, role, harness, launcher, model, and effort
pickers use one reusable application component. The component supports keyboard
navigation, text search across the option label and supporting text, disabled
options, loading, error, and empty states, a clear action when the picker allows
it, and custom icon and value rendering. Browser-native `select` elements are
not allowed for these product pickers.

The default spawn path uses the launcher-scoped device catalogue. The curated
model registry remains a compatibility path only for custom or unsupported
launchers. It is not the source for the default model picker. Clients send
selected names only. The server validates the selected model and effort as one
launcher-specific combination and resolves them to fixed process arguments.

Clients select registry names. They do not send executable paths, shell command
strings, model arguments, or token values during spawn. The server resolves the
registered names and gives Herdr structured process arguments and environment
values.

A role runtime policy is either `unrestricted`, or `restricted` with one or
more launcher profiles. Each profile names one registered launcher and permits
multiple current-device models from that launcher. Effort values are nested
under each selected model and come only from that model's current catalogue.
One profile, model, and effort can be a default without removing other
permitted choices.

Model and effort names are selected, never typed. Saved names that are not on
the device stay visible as unavailable and block new spawn until fixed. They
are not silently deleted. Existing scalar role values migrate to equivalent
profiles without losing their meaning. Scalar writes are removed or deprecated
after migration.

## 11. Herdr integration

Herdr is the source of truth for:

- workspaces and tabs;
- panes and durable terminal identifiers;
- the harness in each pane;
- agent status;
- focus state;
- process start and stop;
- prompt delivery;
- topology events.

Sheppard uses durable terminal identifiers for participant routes. Public pane,
tab, and workspace identifiers can change when Herdr compacts its topology.
Sheppard must refresh them before a control action.

Sheppard starts agents through structured Herdr APIs. It does not construct a
shell command. Environment values remain separate from executable arguments.

## 12. Human visibility

The human must be able to answer these questions from one browser tab:

- Which projects are active?
- Which agents are working, idle, done, blocked, or unavailable?
- Which agents have stale or missing routes?
- Who leads each project?
- What task or role does each agent have?
- Which channels have unread work?
- Which messages have not been seen by required participants?
- What did an agent recently do in its harness session?
- Which agents, models, and launchers can be started now?

Alarms and unread work take priority over totals and decorative statistics. A
large fleet must stay usable at 20 workspaces, 150 panes, 100 agents, and 300
channels. Lists use stable ordering, bounded priority views, and clear overflow
counts.

## 13. Security and control boundaries

The hub listens on a controlled local interface. Participant tokens authorize
actions as one handle. The browser uses an HttpOnly session cookie for the human
participant.

A connected existing pane uses the protected local-control credential and its
exact current Herdr route. This is a same-OS-user trust boundary. A process that
can read the local-control credential and identify a connected pane can act as
that pane. The server still limits the participant to its direct conversations
and joined channels.

The server owns process definitions and secret environment values. Responses,
events, logs, and error messages must not expose credential values. A started
agent uses its own token. A connected existing pane uses its verified
pane-scoped identity.

A lead can start agents because staffing is an authenticated product capability.
It cannot use the human-only prompt endpoint to type into another agent's pane.
Messages are the agent-to-agent influence path.

## 14. Product boundaries

Sheppard is not:

- an agent harness;
- a source-control system;
- a replacement for Herdr;
- a system that copies all message content into every agent prompt;
- a system that adds every agent to every channel;
- a system that treats a role as a security privilege;
- a system that uses an agent conversation to finish platform setup.

Sheppard manages the fleet, makes agent communication durable, and gives the
human one control surface across projects and harnesses.
