import { useState } from "react"
import Markdown from "react-markdown"
import { ChevronDown, ChevronRight, Wrench } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { AgentSession, SessionState, SessionTurn, SessionCandidate } from "@/api/types"
import { Button } from "@/components/ui/button"
import type { AgentSessionState, SessionReadState, SessionSelectionState } from "@/hooks/use-agent-session"
import { absoluteTimeLabel, relativeAgeLabel } from "@/workspace-presentation"
import { sessionRows } from "@/session-rows"

/** What each non-ready state means, in the panel's own words. */
const sessionStateCopy = {
  absent: "This harness has written no session for this working directory.",
  ambiguous: "More than one session matches this pane. None was chosen.",
  unsupported: "No session reader exists for this harness yet.",
  error: "The session could not be read.",
} satisfies Record<Exclude<SessionState, "ready">, string>

function SessionToolLine({ turn }: { turn: SessionTurn }) {
  const [open, setOpen] = useState(false)
  const name = turn.tool?.name ?? "tool"
  const failed = turn.tool?.outcome === "error"
  return (
    <li data-session-tool={name}>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
        )}
        <Wrench aria-hidden="true" className="size-3 shrink-0" />
        <span className={failed ? "font-medium text-destructive" : "font-medium text-foreground"}>{name}</span>
        <span className="min-w-0 flex-1 truncate">{turn.text}</span>
      </button>
      {open && (
        <pre
          className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-xs whitespace-pre-wrap"
          data-session-tool-body
        >
          {turn.text}
        </pre>
      )}
    </li>
  )
}

function SessionTurnLine({ turn }: { turn: SessionTurn }) {
  const mine = turn.role === "user"
  return (
    <li className="rounded-lg border bg-card px-3 py-2" data-session-turn={turn.role ?? "unknown"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{mine ? "Operator" : "Agent"}</span>
        {turn.at !== null && (
          <time className="text-muted-foreground" dateTime={turn.at} title={absoluteTimeLabel(turn.at)}>
            {relativeAgeLabel(turn.at)}
          </time>
        )}
      </div>
      <div className="agent-session-text md-view">
        <Markdown>{turn.text}</Markdown>
      </div>
    </li>
  )
}

function SessionCandidatePicker({
  canSelect,
  candidates,
  onSelect,
  selectionState,
}: {
  canSelect: boolean
  candidates: SessionCandidate[]
  onSelect: (sessionId: string) => void
  selectionState: SessionSelectionState
}) {
  const selecting = selectionState.status === "working"
  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-3" data-session-picker>
      <p className="text-sm font-medium">Candidate sessions</p>
      <p className="mt-1 text-xs text-muted-foreground">Choose the session that belongs to this pane.</p>
      {selectionState.status === "working" && (
        <p className="mt-2 text-sm text-muted-foreground" data-session-selection-state="working" role="status">
          Selecting session {selectionState.sessionId}…
        </p>
      )}
      {selectionState.status === "error" && (
        <p className="mt-2 text-sm text-destructive" data-session-selection-state="error" role="alert">
          {selectionState.message}
        </p>
      )}
      <ol aria-label="Session candidates" className="mt-3 space-y-2" role="list">
        {candidates.map((candidate) => (
          <li
            className="rounded-md border bg-card p-3"
            data-session-candidate={candidate.sessionId}
            key={candidate.sessionId}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <code className="text-xs font-medium" data-session-candidate-id>
                {candidate.sessionId}
              </code>
              <span className="text-xs text-muted-foreground" data-session-candidate-size>
                {candidate.sizeBytes} bytes
              </span>
            </div>
            {candidate.startedAt !== null && (
              <time
                className="mt-1 block text-xs text-muted-foreground"
                dateTime={candidate.startedAt}
                title={absoluteTimeLabel(candidate.startedAt)}
                data-session-candidate-started
              >
                {relativeAgeLabel(candidate.startedAt)}
              </time>
            )}
            {candidate.cwd !== null && (
              <p
                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                data-session-candidate-cwd
                title={candidate.cwd}
              >
                {candidate.cwd}
              </p>
            )}
            {candidate.firstUserText !== null && (
              <p className="mt-2 line-clamp-2 text-sm" data-session-candidate-prompt title={candidate.firstUserText}>
                {candidate.firstUserText}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p
                className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                data-session-candidate-path
                title={candidate.path}
              >
                {candidate.path}
              </p>
              <Button
                aria-label={`Select session ${candidate.sessionId}`}
                data-session-select={candidate.sessionId}
                disabled={!canSelect || selecting}
                onClick={() => onSelect(candidate.sessionId)}
                size="sm"
                title={canSelect ? `Use session ${candidate.sessionId}` : NOT_CONNECTED_REASON}
                type="button"
                variant="outline"
              >
                {selectionState.status === "working" && selectionState.sessionId === candidate.sessionId
                  ? "Selecting…"
                  : "Select"}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

interface SessionPanelProps {
  canSelect: boolean
  onLoadOlder: () => void
  onSelectSession: (sessionId: string) => void
  paneId: string | null
  selectionState: SessionSelectionState
  readState: SessionReadState
  state: AgentSessionState
}

export function AgentSessionPanel(props: SessionPanelProps) {
  const { state, readState, paneId } = props
  return (
    <section
      aria-labelledby="agent-session-heading"
      className="agent-session-panel"
      data-agent-session={paneId ?? "none"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" id="agent-session-heading">
          Harness session
        </h2>
        {state.status === "ready" && state.session.source.harness !== null && (
          <span className="text-xs text-muted-foreground">{state.session.source.harness}</span>
        )}
      </div>
      <div className="mt-4">
        {readState.kind === "failed" && (
          <p className="text-sm text-destructive" role="alert">
            {readState.message}
          </p>
        )}
        <SessionContent {...props} />
      </div>
    </section>
  )
}

function SessionContent(props: SessionPanelProps) {
  const { paneId, state } = props
  if (paneId === null)
    return <p className="text-sm text-muted-foreground">This agent has no active pane, so it has no session to read.</p>
  switch (state.status) {
    case "loading":
      return (
        <p className="text-sm text-muted-foreground" role="status">
          Loading session…
        </p>
      )
    case "error":
      return (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )
    case "ready":
      return <ReadySessionContent {...props} session={state.session} />
  }
}

function ReadySessionContent({
  session,
  canSelect,
  onSelectSession,
  selectionState,
  onLoadOlder,
  readState,
}: SessionPanelProps & { session: AgentSession }) {
  switch (session.source.state) {
    case "ready":
      return <SessionTranscript session={session} onLoadOlder={onLoadOlder} readState={readState} />
    case "absent":
    case "unsupported":
    case "error":
    case "ambiguous":
      return (
        <>
          <p className="text-sm text-muted-foreground" data-session-state={session.source.state}>
            {sessionStateCopy[session.source.state]}
            {session.source.reason !== null && <span className="ml-1 text-xs">({session.source.reason})</span>}
          </p>
          {session.source.state === "ambiguous" &&
            session.mapping !== null &&
            session.mapping.candidates.length > 0 && (
              <SessionCandidatePicker
                canSelect={canSelect}
                candidates={session.mapping.candidates}
                onSelect={onSelectSession}
                selectionState={selectionState}
              />
            )}
        </>
      )
  }
}

function SessionTranscript({
  session,
  onLoadOlder,
  readState,
}: {
  session: AgentSession
  onLoadOlder: () => void
  readState: SessionReadState
}) {
  return (
    <>
      {session.nextBefore !== null && (
        <Button
          className="mb-3"
          disabled={readState.kind === "loading"}
          onClick={onLoadOlder}
          size="sm"
          type="button"
          variant="ghost"
        >
          Load older turns
        </Button>
      )}
      <ul aria-label="Session transcript" className="space-y-2" role="list">
        {sessionRows(session.turns).map(({ turn, key }) =>
          turn.kind === "tool" ? <SessionToolLine key={key} turn={turn} /> : <SessionTurnLine key={key} turn={turn} />,
        )}
      </ul>
      {session.turns.length === 0 && (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">This session has no turns yet.</p>
      )}
    </>
  )
}
