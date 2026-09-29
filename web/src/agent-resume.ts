import type { ResumableAgent, ResumeAgentRequest, ResumeLauncher, ResumeState } from "@/api/types"

/**
 * What the agent page shows about resuming.
 * - `none`: the identity is connected; nothing to show.
 * - `action`: a Resume button, with a launcher picker when `choose` is set.
 * - `hint`: one line that says why there is no Resume button.
 */
export type ResumeNote =
  | { kind: "none" }
  | { kind: "action"; launcher: ResumeLauncher }
  | { kind: "hint"; text: string }

export const RESUME_EXPLANATION = "The session continues in a new pane in its folder. Channels and messages stay."

export function resumeNote(resume: ResumeState): ResumeNote {
  switch (resume.kind) {
    case "connected":
      return { kind: "none" }
    case "resumable":
      return { kind: "action", launcher: resume.launcher }
    case "no-session":
      return { kind: "hint", text: "No recorded session. Reconnect the pane, or confirm its session on the Session tab." }
    case "no-launcher":
      return { kind: "hint", text: `No registered ${resume.harness} launcher holds this session. Add a launcher for its profile.` }
    case "unsupported":
      return {
        kind: "hint",
        text: resume.harness === null
          ? "This agent's harness is unknown, so its session cannot resume."
          : `${resume.harness} cannot resume a session by id.`,
      }
  }
}

/** The request body, or the need for a launcher pick first. */
export type ResumeRequestDraft =
  | { kind: "ready"; request: ResumeAgentRequest }
  | { kind: "needs-launcher"; launchers: string[] }

export function resumeRequest(launcher: ResumeLauncher, chosen: string | null): ResumeRequestDraft {
  switch (launcher.kind) {
    case "recorded":
    case "matched":
      return { kind: "ready", request: {} }
    case "choose":
      return chosen !== null && launcher.launchers.includes(chosen)
        ? { kind: "ready", request: { launcher: chosen } }
        : { kind: "needs-launcher", launchers: launcher.launchers }
  }
}

/** "Resume all" starts the agents with a known launcher and links the others. */
export interface ResumePlan {
  automatic: string[]
  needsLauncher: string[]
}

export function planResumeAll(agents: readonly ResumableAgent[]): ResumePlan {
  const plan: ResumePlan = { automatic: [], needsLauncher: [] }
  for (const agent of agents) {
    switch (agent.resume.kind) {
      case "resumable":
        if (agent.resume.launcher.kind === "choose") plan.needsLauncher.push(agent.handle)
        else plan.automatic.push(agent.handle)
        break
      case "connected":
      case "no-session":
      case "no-launcher":
      case "unsupported":
        break
    }
  }
  return plan
}

export function resumeAllLabel(count: number): string {
  return count === 1 ? "Resume 1 agent" : `Resume ${count} agents`
}
