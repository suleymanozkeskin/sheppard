import type { ReactNode } from "react"
import { Bot, Hash, MessageCircle, Paperclip, Plus, Search, SquareTerminal } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { AppController } from "@/hooks/use-app-controller"
import { AgentDetailPage, AgentsDirectoryPage } from "@/components/agent-pages"
import { WorkspaceDetailPage, WorkspacesDirectoryPage } from "@/components/workspace-pages"
import { Button } from "@/components/ui/button"
import { ShellBackLink } from "@/components/shell-back-link"
import { CreateChannelPage, DirectMessagePage, WorkspaceCreatePage, type CreationPagesController } from "@/components/creation-pages"
import { ChannelsDirectoryPage, DirectOverviewPage } from "@/components/directory-pages"
import { LaunchersPage } from "@/components/launcher-pages"
import { AttachmentsPage } from "@/components/attachments-page"
import { ModelFormPage, RoleFormPage, SpawnAgentPage, StaffingPage } from "@/components/staffing-pages"
import { shellParentRoute, shellRoutePath, type ShellRoute, type ShellRouter } from "@/shell-routing"

export interface ShellPageCopy {
  description: string
  icon: ReactNode
  placeholder: string
  title: string
  createRoute?: ShellRoute
  createLabel?: string
}

function shellPageCopy(route: ShellRoute): ShellPageCopy {
  switch (route.kind) {
    case "current":
      return {
        description: "Current conversation view",
        icon: <MessageCircle aria-hidden="true" />,
        placeholder: "Select a channel, direct conversation, or workspace from the sidebar.",
        title: "Current view",
      }
    case "search":
      return {
        description: "Message search",
        icon: <Search aria-hidden="true" />,
        placeholder: "Search messages across the channels stored by the hub.",
        title: "Search",
      }
    case "attachments":
      return {
        description: "Shared files",
        icon: <Paperclip aria-hidden="true" />,
        placeholder: "Browse files shared in visible channels.",
        title: "Attachments",
      }
    case "workspaces":
      return {
        createLabel: "Create workspace",
        createRoute: { kind: "create-workspace" },
        description: "Workspace control plane",
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "Browse open workspaces, panes, routes, lifecycle controls, and broadcast history.",
        title: "Workspaces",
      }
    case "workspace":
      return {
        description: `Workspace control plane · ${route.workspaceId}`,
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "View workspace panes, agent routes, lifecycle actions, and broadcast history.",
        title: "Workspace",
      }
    case "channels":
      return {
        createLabel: "Create channel",
        createRoute: { kind: "create-channel" },
        description: "Channel directory",
        icon: <Hash aria-hidden="true" />,
        placeholder: "Browse channel topics, members, unread counts, activity, and membership actions.",
        title: "Channels",
      }
    case "channel":
      return {
        description: `Channel detail · ${route.channel}`,
        icon: <Hash aria-hidden="true" />,
        placeholder: "Read this channel, review its members, and manage membership.",
        title: route.channel,
      }
    case "direct":
      return {
        createLabel: "Start direct message",
        createRoute: { kind: "create-direct" },
        description: "Direct conversation directory",
        icon: <MessageCircle aria-hidden="true" />,
        placeholder: "Browse direct participants, unread counts, and conversation actions.",
        title: "Direct",
      }
    case "conversation":
      return {
        description: `Direct conversation · ${route.channel}`,
        icon: <MessageCircle aria-hidden="true" />,
        placeholder: "Read this conversation and review its participants.",
        title: route.channel,
      }
    case "agents":
      return {
        createLabel: "Spawn agent",
        createRoute: { kind: "spawn-agent" },
        description: "Cross-workspace agent directory",
        icon: <Bot aria-hidden="true" />,
        placeholder: "Browse agent identity, harness, pane, status, route state, recent messages, and actions.",
        title: "Agents",
      }
    case "agent":
      return {
        description: `Agent detail · ${route.handle}`,
        icon: <Bot aria-hidden="true" />,
        placeholder: "Review agent identity, status, route state, recent messages, and actions.",
        title: route.handle,
      }
    case "create-workspace":
      return {
        description: "Workspace creation",
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "Choose a folder or enter an absolute path to create a workspace.",
        title: "Create workspace",
      }
    case "create-channel":
      return {
        description: "Channel creation",
        icon: <Hash aria-hidden="true" />,
        placeholder: "Enter a name and optional topic to create a channel.",
        title: "Create channel",
      }
    case "create-direct":
      return {
        description: "Direct-message composition",
        icon: <MessageCircle aria-hidden="true" />,
        placeholder: "Choose participants and write a message to start a conversation.",
        title: "Start direct message",
      }
    case "spawn-agent":
      return {
        description: route.workspaceId === undefined ? "Agent spawn" : `Agent spawn · ${route.workspaceId}`,
        icon: <Bot aria-hidden="true" />,
        placeholder: "Choose a workspace and agent details to start an agent.",
        title: "Spawn agent",
      }
    case "launchers":
      return {
        createLabel: "Create launcher",
        createRoute: { kind: "create-launcher" },
        description: "Registered process launchers",
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "Review registered agent kinds and command arguments.",
        title: "Launchers",
      }
    case "create-launcher":
      return {
        description: "Launcher creation",
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "Register a named launcher and its command arguments.",
        title: "Create launcher",
      }
    case "edit-launcher":
      return {
        description: `Launcher edit · ${route.name}`,
        icon: <SquareTerminal aria-hidden="true" />,
        placeholder: "Update the agent kind and command arguments for this launcher.",
        title: `Edit ${route.name}`,
      }
    case "staffing":
      return {
        createLabel: "Create role",
        createRoute: { kind: "create-role" },
        description: "Default runtime settings for agent roles",
        icon: <Bot aria-hidden="true" />,
        placeholder: "Review roles and their editable spawn defaults.",
        title: "Role presets",
      }
    case "create-role":
      return {
        description: "Role creation",
        icon: <Bot aria-hidden="true" />,
        placeholder: "Define a role briefing and its spawn defaults.",
        title: "Create role",
      }
    case "edit-role":
      return {
        description: `Role edit · ${route.name}`,
        icon: <Bot aria-hidden="true" />,
        placeholder: "Update the role briefing and spawn defaults.",
        title: `Edit ${route.name}`,
      }
    case "create-model":
      return {
        description: "Model registration",
        icon: <Bot aria-hidden="true" />,
        placeholder: "Register a model name and server-owned command suffix.",
        title: "Add model",
      }
  }
}

function shellPageName(route: ShellRoute): string {
  switch (route.kind) {
    case "workspace":
      return "workspace-detail"
    case "agent":
      return "agent-detail"
    case "create-direct":
      return "compose-direct"
    default:
      return route.kind
  }
}

export function ShellPageScaffold({ copy, navigate, route }: { copy: ShellPageCopy; navigate: ShellRouter["navigate"]; route: ShellRoute }) {
  const createRoute = copy.createRoute
  const createLabel = copy.createLabel
  return (
    <div className="flex min-h-full items-center justify-center p-6" data-page-scaffold={route.kind}>
      <div className="w-full max-w-xl rounded-xl border border-dashed bg-muted/20 p-8 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">{copy.icon}</div>
        <h2 className="mt-4 text-base font-semibold" id="shell-page-placeholder">{copy.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.placeholder}</p>
        {createRoute !== undefined && createLabel !== undefined && (
          <Button className="mt-6" onClick={() => navigate(createRoute)} type="button" variant="outline">
            {createLabel}
          </Button>
        )}
        <nav aria-label="Control-plane pages" className="mt-8 flex flex-wrap justify-center gap-2 text-xs">
          <Button data-shell-nav="workspaces" onClick={() => navigate({ kind: "workspaces" })} size="sm" variant="ghost">Workspaces</Button>
          <Button data-shell-nav="channels" onClick={() => navigate({ kind: "channels" })} size="sm" variant="ghost">Channels</Button>
          <Button data-shell-nav="direct" onClick={() => navigate({ kind: "direct" })} size="sm" variant="ghost">Direct</Button>
          <Button data-shell-nav="agents" onClick={() => navigate({ kind: "agents" })} size="sm" variant="ghost">Agents</Button>
          <Button data-shell-nav="launchers" onClick={() => navigate({ kind: "launchers" })} size="sm" variant="ghost">Launchers</Button>
        </nav>
      </div>
    </div>
  )
}

function routePageContent({ controller, copy, creation, navigate, route }: { controller: AppController; copy: ShellPageCopy; creation: CreationPagesController; navigate: ShellRouter["navigate"]; route: ShellRoute }): ReactNode {
  switch (route.kind) {
    case "workspaces":
      return <WorkspacesDirectoryPage controller={controller} navigate={navigate} route={route} />
    case "workspace":
      return <WorkspaceDetailPage controller={controller} navigate={navigate} workspaceId={route.workspaceId} />
    case "channels":
      return <ChannelsDirectoryPage controller={controller} navigate={navigate} route={route} />
    case "direct":
      return <DirectOverviewPage controller={controller} navigate={navigate} />
    case "agents":
      return <AgentsDirectoryPage controller={controller} navigate={navigate} />
    case "agent":
      return <AgentDetailPage controller={controller} handle={route.handle} navigate={navigate} />
    case "attachments": {
      const availableChannels = [
        ...(controller.channelState.status === "ready" ? controller.channelState.channels.map((channel) => channel.name) : []),
        ...controller.directConversations.map((conversation) => conversation.channel),
        ...controller.workspaceData.workspaceChannels.map((channel) => channel.name),
      ]
      return (
        <AttachmentsPage
          api={controller.api}
          attachmentKind={route.attachmentKind}
          availableChannels={availableChannels}
          canWrite={controller.identity !== null}
          canPreview={controller.identity !== null}
          fallbackApi={controller.fallbackApi}
          navigate={navigate}
          scope={route.scope}
        />
      )
    }
    case "create-workspace":
      return (
        <WorkspaceCreatePage
          browseDirectory={creation.browseWorkspaceDirectory}
          chooseDirectory={creation.chooseWorkspaceDirectory}
          cwd={creation.workspaceCwd}
          directoryPickerState={creation.workspaceDirectoryPickerState}
          label={creation.workspaceLabel}
          onCloseDirectoryPicker={creation.closeWorkspaceDirectoryPicker}
          onClose={() => navigate({ kind: "workspaces" })}
          onCwdChange={creation.setWorkspaceCwd}
          onLabelChange={creation.setWorkspaceLabel}
          onOpenDirectoryPicker={creation.openWorkspaceDirectoryPicker}
          onSubmit={creation.handleWorkspaceCreateSubmit}
          state={creation.workspaceCreateState}
        />
      )
    case "create-channel":
      return (
        <CreateChannelPage
          name={creation.createChannelName}
          onClose={() => navigate({ kind: "channels" })}
          onNameChange={creation.setCreateChannelName}
          onSubmit={creation.handleCreateChannelSubmit}
          onTopicChange={creation.setCreateChannelTopic}
          state={creation.createChannelState}
          topic={creation.createChannelTopic}
        />
      )
    case "create-direct":
      return (
        <DirectMessagePage
          attachmentInputOpen={creation.directAttachmentInputOpen}
          attachmentPathInput={creation.directAttachmentPathInput}
          attachments={creation.directAttachments}
          body={creation.directBody}
          onAttachmentInputChange={creation.handleDirectAttachmentInputChange}
          onAttachmentInputSubmit={creation.addDirectAttachmentPath}
          onBodyChange={creation.setDirectBody}
          onClose={() => navigate({ kind: "direct" })}
          onRemoveAttachment={creation.removeDirectAttachmentPath}
          onToggleAttachmentInput={creation.toggleDirectAttachmentInput}
          onRecipientsChange={creation.setDirectRecipients}
          onSubmit={creation.handleDirectSubmit}
          participants={creation.participants}
          recipients={creation.directRecipients}
          state={creation.directState}
        />
      )
    case "launchers":
      return <LaunchersPage controller={controller} navigate={navigate} mode="list" />
    case "create-launcher":
      return <LaunchersPage controller={controller} navigate={navigate} mode="create" />
    case "edit-launcher":
      return <LaunchersPage controller={controller} launcherName={route.name} navigate={navigate} mode="edit" />
    case "staffing":
      return <StaffingPage controller={controller} navigate={navigate} />
    case "create-role":
      return <RoleFormPage controller={controller} navigate={navigate} />
    case "edit-role":
      return <RoleFormPage controller={controller} name={route.name} navigate={navigate} />
    case "create-model":
      return <ModelFormPage controller={controller} navigate={navigate} />
    case "spawn-agent":
      return <SpawnAgentPage controller={controller} mode={route.mode} navigate={navigate} roleName={route.role} workspaceId={route.workspaceId} />
    default:
      return <ShellPageScaffold copy={copy} navigate={navigate} route={route} />
  }
}

function shellBackLabel(destination: ShellRoute | undefined): string {
  switch (destination?.kind) {
    case "workspaces":
      return "Back to Workspaces"
    case "channels":
      return "Back to Channels"
    case "direct":
      return "Back to Direct"
    case "agents":
      return "Back to Agents"
    case "launchers":
      return "Back to Launchers"
    case "staffing":
      return "Back to Role presets"
    default:
      return "Back to Current View"
  }
}

export function ShellPageMain({ controller, creation, navigate, route }: { controller: AppController; creation: CreationPagesController; navigate: ShellRouter["navigate"]; route: ShellRoute }) {
  const copy = shellPageCopy(route)
  const createRoute = copy.createRoute
  const createLabel = copy.createLabel
  const backDestination = shellParentRoute(route)
  const backLabel = shellBackLabel(backDestination)
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-shell-page={shellPageName(route)}
      data-shell-route={shellRoutePath(route)}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4">
        <ShellBackLink
          destination={backDestination}
          label={backLabel}
          navigate={(destination, replace) => {
            if (route.kind === "spawn-agent") controller.restoreSpawnAgentFocus()
            navigate(destination, replace)
          }}
        />
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{copy.title}</h1>
          {route.kind !== "workspaces" && route.kind !== "channels" && route.kind !== "staffing" && <p className="truncate text-xs text-muted-foreground">{copy.description}</p>}
        </div>
        {createRoute !== undefined && createLabel !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-2" data-page-header-actions>
            <Button data-page-create={route.kind} disabled={controller.identity === null} onClick={() => navigate(createRoute)} size="sm" title={controller.identity === null ? NOT_CONNECTED_REASON : createLabel} type="button" variant="outline">
              <Plus aria-hidden="true" />
              <span className="hidden sm:inline">{createLabel}</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        )}
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto" data-page-content={route.kind}>
        {routePageContent({ controller, copy, creation, navigate, route })}
      </section>
    </main>
  )
}
