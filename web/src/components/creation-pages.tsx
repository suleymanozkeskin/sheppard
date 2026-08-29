import { useRef, type FormEvent } from "react"
import { ChevronLeft, ChevronRight, Folder, FolderOpen, Paperclip, RefreshCw, X } from "lucide-react"

import type { Participant } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { DictationButton } from "@/components/dictation-button"
import { Button } from "@/components/ui/button"
import type { CreateChannelState, DirectCreateState, WorkspaceActionState, WorkspaceDirectoryPickerState } from "@/hooks/use-app-controller"
import type { AttachmentPath } from "@/hooks/use-composer-state"

export interface CreationPagesController {
  workspaceCwd: string
  workspaceLabel: string
  setWorkspaceCwd: (value: string) => void
  setWorkspaceLabel: (value: string) => void
  handleWorkspaceCreateSubmit: (event: FormEvent<HTMLFormElement>) => void
  workspaceCreateState: WorkspaceActionState
  workspaceDirectoryPickerState: WorkspaceDirectoryPickerState
  browseWorkspaceDirectory: (path?: string) => void
  chooseWorkspaceDirectory: () => void
  closeWorkspaceDirectoryPicker: () => void
  openWorkspaceDirectoryPicker: () => void
  createChannelName: string
  setCreateChannelName: (value: string) => void
  handleCreateChannelSubmit: (event: FormEvent<HTMLFormElement>) => void
  setCreateChannelTopic: (value: string) => void
  createChannelState: CreateChannelState
  createChannelTopic: string
  directAttachmentInputOpen: boolean
  directAttachmentPathInput: string
  directAttachments: AttachmentPath[]
  directBody: string
  handleDirectFiles: (files: readonly File[]) => void
  handleDirectAttachmentInputChange: (value: string) => void
  addDirectAttachmentPath: () => void
  setDirectBody: (value: string) => void
  removeDirectAttachmentPath: (path: string) => void
  toggleDirectAttachmentInput: () => void
  setDirectRecipients: (value: string) => void
  handleDirectSubmit: (event: FormEvent<HTMLFormElement>) => void
  participants: Participant[]
  directRecipients: string
  directState: DirectCreateState
}

export interface CreateChannelPageProps {
  name: string
  onClose: () => void
  onNameChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTopicChange: (value: string) => void
  state: CreateChannelState
  topic: string
}

export function CreateChannelPage({
  name,
  onClose,
  onNameChange,
  onSubmit,
  onTopicChange,
  state,
  topic,
}: CreateChannelPageProps) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6" data-creation-page="channel">
      <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold" id="create-channel-title">Create channel</h2>
        <p className="mt-1 text-sm text-muted-foreground">Create a channel and join it as the current identity.</p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium" htmlFor="channel-name">Name</label>
            <input
              className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              id="channel-name"
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="release"
              value={name}
            />
            <p className="mt-1 text-xs text-muted-foreground">Use lowercase letters, digits, <code>-</code> or <code>_</code>. Start with a letter. Maximum 32 characters.</p>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="channel-topic">Topic (optional)</label>
            <input
              className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              id="channel-topic"
              onChange={(event) => onTopicChange(event.target.value)}
              placeholder="Deployments and hand-offs"
              value={topic}
            />
          </div>
          {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="ghost">Cancel</Button>
            <Button disabled={state.status === "creating"} type="submit">
              {state.status === "creating" ? "Creating…" : "Create channel"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export interface WorkspaceCreatePageProps {
  browseDirectory: (path?: string) => void
  chooseDirectory: () => void
  cwd: string
  directoryPickerState: WorkspaceDirectoryPickerState
  label: string
  onCloseDirectoryPicker: () => void
  onClose: () => void
  onCwdChange: (value: string) => void
  onLabelChange: (value: string) => void
  onOpenDirectoryPicker: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  state: WorkspaceActionState
}

export function WorkspaceCreatePage({
  browseDirectory,
  chooseDirectory,
  cwd,
  directoryPickerState,
  label,
  onCloseDirectoryPicker,
  onClose,
  onCwdChange,
  onLabelChange,
  onOpenDirectoryPicker,
  onSubmit,
  state,
}: WorkspaceCreatePageProps) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6" data-creation-page="workspace">
      <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold" id="workspace-create-title">Create workspace</h2>
        <p className="mt-1 text-sm text-muted-foreground">Start a workspace with an optional label and working directory.</p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div><label className="text-sm font-medium" htmlFor="workspace-label">Label (optional)</label><input autoComplete="off" className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="workspace-label" name="workspace-label" onChange={(event) => onLabelChange(event.target.value)} placeholder="project" value={label} /></div>
          <div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="workspace-cwd">Working directory (optional)</label>
              <Button aria-expanded={directoryPickerState.status !== "closed"} onClick={onOpenDirectoryPicker} size="sm" type="button" variant="outline">
                <FolderOpen aria-hidden="true" />
                Choose folder
              </Button>
            </div>
            <div className="mt-2 flex gap-2">
              <input autoComplete="off" className="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="workspace-cwd" name="workspace-cwd" onChange={(event) => onCwdChange(event.target.value)} placeholder="/absolute/path (or choose a folder)" spellCheck={false} value={cwd} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Choose a folder on this device, or paste an absolute path.</p>
          </div>
          {directoryPickerState.status !== "closed" && (
            <section aria-labelledby="workspace-directory-picker-title" className="rounded-lg border bg-background/60 p-3" data-workspace-directory-picker="true">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" id="workspace-directory-picker-title">Choose working directory</h3>
                  {directoryPickerState.status === "ready" && <code className="mt-1 block truncate text-xs" title={directoryPickerState.listing.currentPath}>{directoryPickerState.listing.currentPath}</code>}
                </div>
                <Button aria-label="Close folder picker" onClick={onCloseDirectoryPicker} size="icon-xs" type="button" variant="ghost"><X aria-hidden="true" /></Button>
              </div>
              {directoryPickerState.status === "loading" && <p className="mt-3 text-sm text-muted-foreground" role="status">Loading folders…</p>}
              {directoryPickerState.status === "error" && (
                <div className="mt-3 flex items-center justify-between gap-3" role="alert">
                  <p className="text-sm text-destructive">{directoryPickerState.message}</p>
                  <Button onClick={() => browseDirectory(directoryPickerState.path)} size="sm" type="button" variant="outline"><RefreshCw aria-hidden="true" /> Retry</Button>
                </div>
              )}
              {directoryPickerState.status === "ready" && (
                <>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Button disabled={directoryPickerState.listing.parentPath === null} onClick={() => browseDirectory(directoryPickerState.listing.parentPath ?? undefined)} size="sm" type="button" variant="ghost"><ChevronLeft aria-hidden="true" /> Up</Button>
                    <Button onClick={chooseDirectory} size="sm" type="button">Use this folder</Button>
                  </div>
                  <div className="mt-2 overflow-hidden rounded-md border" data-workspace-directory-list="true">
                    <div className="max-h-56 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                      {directoryPickerState.listing.directories.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">No child folders.</p>}
                      {directoryPickerState.listing.directories.length > 0 && (
                        <ul aria-label="Child folders" className="divide-y">
                          {directoryPickerState.listing.directories.map((directory) => (
                            <li key={directory.path}>
                              <button className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" onClick={() => browseDirectory(directory.path)} type="button">
                                <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {directoryPickerState.listing.truncated && <p className="mt-2 text-xs text-muted-foreground">Only the first 500 folders are shown. Use the path field for a deeper location.</p>}
                </>
              )}
            </section>
          )}
          {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
          <div className="flex justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={state.status === "working"} type="submit">{state.status === "working" ? "Creating…" : "Create workspace"}</Button></div>
        </form>
      </div>
    </div>
  )
}

export interface DirectMessagePageProps {
  attachmentInputOpen: boolean
  attachmentPathInput: string
  attachments: AttachmentPath[]
  body: string
  onAttachmentInputChange: (value: string) => void
  onAttachmentInputSubmit: () => void
  onBodyChange: (value: string) => void
  onClose: () => void
  onRemoveAttachment: (path: string) => void
  onSelectFiles: (files: readonly File[]) => void
  onToggleAttachmentInput: () => void
  participants: Participant[]
  onRecipientsChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  recipients: string
  state: DirectCreateState
}

export function DirectMessagePage({
  attachmentInputOpen,
  attachmentPathInput,
  attachments,
  body,
  onAttachmentInputChange,
  onAttachmentInputSubmit,
  onBodyChange,
  onClose,
  onRemoveAttachment,
  onSelectFiles,
  onToggleAttachmentInput,
  participants,
  onRecipientsChange,
  onSubmit,
  recipients,
  state,
}: DirectMessagePageProps) {
  const attachmentBlocked = attachments.some((attachment) => attachment.status === "uploading" || attachment.status === "error" || attachment.error !== undefined)
  const messageRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6" data-creation-page="direct">
      <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold" id="direct-message-title">Start direct message</h2>
        <p className="mt-1 text-sm text-muted-foreground">The conversation member set is fixed after the first message.</p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium" htmlFor="direct-recipients">Recipients</label>
            <input
              className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              id="direct-recipients"
              onChange={(event) => onRecipientsChange(event.target.value)}
              placeholder="handle or handle,handle-2"
              value={recipients}
            />
          </div>
          <section aria-labelledby="direct-picker-title" className="rounded-lg border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" id="direct-picker-title">Participants</h3>
            <p className="mt-1 text-xs text-muted-foreground">Running agents appear first. Agents that are not running remain available for stored messages.</p>
            <div className="mt-2 grid max-h-36 gap-1 overflow-y-auto">
              {participants
                .toSorted((left, right) => participantSort(left, right))
                .map((participant) => (
                  <button className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted" key={participant.handle} onClick={() => onRecipientsChange(addRecipient(recipients, participant.handle))} type="button">
                    <ParticipantMark participant={participant} />
                    <span className="min-w-0 flex-1 truncate">{participant.handle}</span>
                    <span className={participant.routeState === "active" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>{participant.routeState === "active" ? participant.kind === "agent" ? "running" : "human" : "poll-only"}</span>
                  </button>
                ))}
            </div>
          </section>
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Attachments</span>
              <Button onClick={onToggleAttachmentInput} size="sm" type="button" variant="outline"><Paperclip aria-hidden="true" /> Attach path</Button>
            </div>
            {attachmentInputOpen && (
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="sr-only" htmlFor="direct-attachment-path">Absolute attachment path</label>
                <input className="h-9 min-w-52 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="direct-attachment-path" onChange={(event) => onAttachmentInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onAttachmentInputSubmit() } }} placeholder="/absolute/path/to/file" value={attachmentPathInput} />
                <input className="sr-only" multiple onChange={(event) => { onSelectFiles(Array.from(event.target.files ?? [])); event.target.value = "" }} ref={fileInputRef} tabIndex={-1} type="file" />
                <Button onClick={() => fileInputRef.current?.click()} size="sm" type="button" variant="outline"><FolderOpen aria-hidden="true" /> Browse</Button>
                <Button onClick={onAttachmentInputSubmit} size="sm" type="button">Add</Button>
              </div>
            )}
            {attachments.length > 0 && <ul aria-label="Direct message attachments" className="mt-2 flex flex-wrap gap-2">{attachments.map((attachment) => <li className="flex items-center gap-1 rounded border px-2 py-1 text-xs" key={attachment.path}><span className="max-w-56 truncate">{attachment.path}</span><button aria-label={`Remove attachment ${attachment.path}`} className="rounded p-0.5 hover:bg-muted" onClick={() => onRemoveAttachment(attachment.path)} type="button"><X aria-hidden="true" className="size-3" /></button>{attachment.error !== undefined && <span className="text-destructive">{attachment.error}</span>}</li>)}</ul>}
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="direct-body">Message</label>
            <div className="mt-2 flex items-end gap-2">
              <textarea
                className="min-h-28 min-w-0 flex-1 resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                id="direct-body"
                onChange={(event) => onBodyChange(event.target.value)}
                placeholder="Write the first direct message"
                ref={messageRef}
                value={body}
              />
              <DictationButton disabled={state.status === "creating"} inputRef={messageRef} onChange={onBodyChange} value={body} />
            </div>
          </div>
          {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} type="button" variant="ghost">Cancel</Button>
            <Button disabled={state.status === "creating" || attachmentBlocked} title={attachmentBlocked ? "Fix attachment errors before sending" : undefined} type="submit">
              {state.status === "creating" ? "Sending…" : "Send direct message"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ParticipantMark({ participant }: { participant: Participant }) {
  return participant.kind === "agent" ? (
    <AgentAvatar agentKind={participant.agentKind} />
  ) : (
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
      {participant.handle.slice(0, 1).toUpperCase()}
    </span>
  )
}

function participantSort(left: Participant, right: Participant): number {
  const rank = (participant: Participant): number => participant.routeState === "active" && participant.kind === "agent" ? 0 : participant.kind === "human" ? 1 : 2
  return rank(left) - rank(right) || left.handle.localeCompare(right.handle)
}

function addRecipient(current: string, handle: string): string {
  const recipients = current.split(",").map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 0)
  return recipients.includes(handle) ? current : [...recipients, handle].join(", ")
}
