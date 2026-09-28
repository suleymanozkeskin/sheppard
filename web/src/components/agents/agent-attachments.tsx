import { useRef } from "react"
import { FolderOpen, Paperclip, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ComposerController } from "@/hooks/use-composer-state"

/** The attachment state and file intake of one agent composer. */
export interface AgentAttachmentModel {
  attachments: ComposerController
  attachFiles: (files: readonly File[]) => void
}

/** Toggles the attach row. Sits next to the dictation and send controls. */
export function AgentAttachButton({ model, disabled }: { model: AgentAttachmentModel; disabled: boolean }) {
  return (
    <Button
      aria-expanded={model.attachments.attachmentInputOpen}
      aria-label="Attach files or paths"
      disabled={disabled}
      onClick={model.attachments.toggleAttachmentInput}
      size="icon-sm"
      title="Attach files or paths"
      type="button"
      variant="outline"
    >
      <Paperclip aria-hidden="true" />
    </Button>
  )
}

/**
 * Shows the files attached to the next message, with upload progress and
 * errors, and the attach row: an absolute path on this computer, or Browse to
 * upload a file from this device.
 */
export function AgentAttachmentTray({ model, disabled }: { model: AgentAttachmentModel; disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { attachments } = model
  return (
    <>
      {attachments.attachments.length > 0 && (
        <ul aria-label="Message attachments" className="agent-message-attachments">
          {attachments.attachments.map((attachment) => (
            <li aria-busy={attachment.status === "uploading"} key={attachment.path}>
              <span title={attachment.path}>
                {attachment.status === "uploading" ? attachment.label ?? attachment.path : attachment.path}
              </span>
              {attachment.status === "uploading" && <span>{attachment.progress ?? 0}%</span>}
              <button
                aria-label={`Remove attachment ${attachment.path}`}
                onClick={() => attachments.removeAttachmentPath(attachment.path)}
                type="button"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
              {attachment.error !== undefined && <span role="alert">{attachment.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {attachments.attachmentInputOpen && (
        <div className="agent-message-attach-row">
          <label className="sr-only" htmlFor="agent-attachment-path">
            Absolute attachment path
          </label>
          <input
            disabled={disabled}
            id="agent-attachment-path"
            onChange={(event) => attachments.handleAttachmentInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              attachments.addAttachmentPath()
            }}
            placeholder="/absolute/path/to/file"
            value={attachments.attachmentPathInput}
          />
          <input
            className="sr-only"
            multiple
            onChange={(event) => {
              model.attachFiles(Array.from(event.target.files ?? []))
              event.target.value = ""
            }}
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
          />
          <Button disabled={disabled} onClick={() => fileInputRef.current?.click()} size="sm" type="button" variant="outline">
            <FolderOpen aria-hidden="true" />
            Browse
          </Button>
          <Button disabled={disabled} onClick={attachments.addAttachmentPath} size="sm" type="button">
            Add
          </Button>
        </div>
      )}
    </>
  )
}
