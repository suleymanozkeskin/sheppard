import { useState } from "react"
import { RotateCcw } from "lucide-react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { ResumeState } from "@/api/types"
import { RESUME_EXPLANATION, resumeNote, resumeRequest } from "@/agent-resume"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import type { AppController } from "@/hooks/use-app-controller"

type ResumeRun = { status: "idle" } | { status: "resuming" } | { status: "failed"; message: string }

/**
 * Resume or explain, for an identity whose route ended. A resumable session
 * gets a button, with a launcher picker when two launchers fit; the other
 * states get one line that says why there is no button.
 */
export function AgentResumePanel({
  controller,
  handle,
  onResumed,
  resume,
}: {
  controller: AppController
  handle: string
  onResumed: () => void
  resume: ResumeState
}) {
  const note = resumeNote(resume)
  const [chosen, setChosen] = useState<string | null>(null)
  const [run, setRun] = useState<ResumeRun>({ status: "idle" })
  const launcherOptions: ComboboxOption[] = note.kind === "action" && note.launcher.kind === "choose"
    ? note.launcher.launchers.map((launcher) => ({ value: launcher, label: launcher }))
    : []

  switch (note.kind) {
    case "none":
      return null
    case "hint":
      return <p className="agent-workbench-offline" data-agent-resume="hint">{note.text}</p>
    case "action":
      break
  }

  const draft = resumeRequest(note.launcher, chosen)
  const start = () => {
    if (draft.kind !== "ready") return
    setRun({ status: "resuming" })
    void apiCall(controller.api, undefined, (client) => client.resumeAgent(handle, draft.request)).then((result) => {
      if (result.isErr()) {
        setRun({ status: "failed", message: formatApiError(result.error) })
        return
      }
      setRun({ status: "idle" })
      controller.workspaceData.reloadWorkspaces()
      onResumed()
    })
  }
  return (
    <div className="agent-resume" data-agent-resume="action">
      <p className="agent-workbench-offline">{RESUME_EXPLANATION}</p>
      <div className="agent-resume-controls">
        {note.launcher.kind === "choose" && (
          <Combobox
            disabled={run.status === "resuming"}
            id={`resume-launcher-${handle}`}
            label="Launcher"
            onValueChange={(value) => setChosen(value)}
            options={launcherOptions}
            placeholder="Choose the launcher for this session"
            required
            showAllOption={false}
            value={chosen}
          />
        )}
        <Button
          data-agent-resume-start
          disabled={controller.identity === null || run.status === "resuming" || draft.kind !== "ready"}
          onClick={start}
          size="sm"
          type="button"
        >
          <RotateCcw aria-hidden="true" />
          {run.status === "resuming" ? "Resuming…" : "Resume session"}
        </Button>
      </div>
      {run.status === "failed" && <p className="agent-workbench-offline text-destructive" role="alert">{run.message}</p>}
    </div>
  )
}
