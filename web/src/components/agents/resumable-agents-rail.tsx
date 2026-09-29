import { useEffect, useState } from "react"
import { RotateCcw } from "lucide-react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { ResumableAgent } from "@/api/types"
import { planResumeAll, resumeAllLabel } from "@/agent-resume"
import type { AppController } from "@/hooks/use-app-controller"
import type { ShellRouter } from "@/shell-routing"

type ListState =
  | { status: "loading" }
  | { status: "ready"; agents: ResumableAgent[] }
  | { status: "error"; message: string }

/** One agent's result in a "Resume all" run. */
type AgentResult = { status: "resuming" } | { status: "resumed" } | { status: "failed"; message: string }

/** What one row shows: before a run, whether it needs a launcher; during and after, its result. */
type RowState = { status: "waiting" } | { status: "needs-launcher" } | AgentResult

/**
 * The rail entry after a restart: how many ended identities can continue their
 * session, "Resume all" for those with a known launcher, and a link for each
 * one that needs a launcher choice.
 */
export function ResumableAgentsRail({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const [list, setList] = useState<ListState>({ status: "loading" })
  const [results, setResults] = useState<ReadonlyMap<string, AgentResult>>(new Map())
  const [running, setRunning] = useState(false)
  const revision = controller.metadataRevision("participants")
  useEffect(() => {
    let active = true
    void apiCall(controller.api, undefined, (client) => client.listResumableAgents()).then((result) => {
      if (!active) return
      setList(result.isOk() ? { status: "ready", agents: result.value.agents } : { status: "error", message: formatApiError(result.error) })
    })
    return () => {
      active = false
    }
  }, [controller.api, revision])

  if (list.status !== "ready" || list.agents.length === 0) return null
  const plan = planResumeAll(list.agents)
  const resumeAll = async () => {
    setRunning(true)
    for (const handle of plan.automatic) {
      setResults((current) => new Map(current).set(handle, { status: "resuming" }))
      const result = await apiCall(controller.api, undefined, (client) => client.resumeAgent(handle, {}))
      const outcome: AgentResult = result.isOk() ? { status: "resumed" } : { status: "failed", message: formatApiError(result.error) }
      setResults((current) => new Map(current).set(handle, outcome))
    }
    setRunning(false)
    controller.workspaceData.reloadWorkspaces()
  }
  return (
    <section aria-label="Resumable agents" className="shrink-0 border-b bg-sky-50 px-2 py-1.5 dark:bg-sky-950/30" data-resumable-agents={list.agents.length}>
      <div className="flex items-center gap-2 px-1.5 py-1 text-xs text-sky-900 dark:text-sky-200">
        <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{resumeAllLabel(list.agents.length)}</span>
        {plan.automatic.length > 0 && (
          <button
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50 dark:hover:bg-sky-900/40"
            data-resume-all
            disabled={running || controller.identity === null}
            onClick={() => void resumeAll()}
            title="Continue each session in a new pane in its folder"
            type="button"
          >
            {running ? "Resuming…" : "Resume all"}
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {list.agents.map((agent) => (
          <li key={agent.handle}>
            <button
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[11px] text-sky-900/80 hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sky-200/80 dark:hover:bg-sky-900/40"
              data-resumable-agent={agent.handle}
              onClick={() => router.navigate({ kind: "agent", handle: agent.handle })}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">@{agent.handle}</span>
              <span className="shrink-0">{rowText(rowState(agent.handle, results, plan.needsLauncher))}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function rowState(handle: string, results: ReadonlyMap<string, AgentResult>, needsLauncher: readonly string[]): RowState {
  const result = results.get(handle)
  if (result !== undefined) return result
  return needsLauncher.includes(handle) ? { status: "needs-launcher" } : { status: "waiting" }
}

function rowText(state: RowState): string {
  switch (state.status) {
    case "waiting":
      return ""
    case "needs-launcher":
      return "choose launcher"
    case "resuming":
      return "resuming…"
    case "resumed":
      return "resumed"
    case "failed":
      return `failed: ${state.message}`
  }
}
