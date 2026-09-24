import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { formatApiError } from "@/api/errors"
import type { AgentSession, MsgrApi } from "@/api/types"

export type AgentSessionState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; session: AgentSession }>
  | Readonly<{ status: "error"; message: string }>

export type SessionSelectionState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "working"; sessionId: string }>
  | Readonly<{ status: "error"; message: string }>

type SessionPage = Readonly<{ kind: "latest" }> | Readonly<{ kind: "older"; before: number }>
interface SessionReadRequest {
  readonly page: SessionPage
  readonly revision: number
}
interface SessionOwner {
  readonly handle: string
  readonly paneId: string | null
  readonly revision: number
}
export type SessionReadState =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "loading" }> | Readonly<{ kind: "failed"; message: string }>
const SESSION_TURN_LIMIT = 2_000

interface SessionReadOptions {
  api: MsgrApi
  handle: string
  paneId: string | null
  request: SessionReadRequest
  owner: RefObject<SessionOwner>
  selection: RefObject<SessionSelectionState>
  setSelection: (state: SessionSelectionState) => void
  reading: RefObject<boolean>
}

function useSessionRead({ api, handle, paneId, request, owner, selection, setSelection, reading }: SessionReadOptions) {
  const [state, setState] = useState<AgentSessionState>({ status: "loading" })
  const [readState, setReadState] = useState<SessionReadState>({ kind: "idle" })
  const stateRef = useRef(state)
  const previousPane = useRef<string | null>(null)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    if (paneId === null) return
    let current = true
    const expected = owner.current
    const query = request.page.kind === "latest" ? {} : { before: request.page.before }
    reading.current = true
    setReadState({ kind: "loading" })
    if (previousPane.current !== paneId) setState({ status: "loading" })
    previousPane.current = paneId
    void api.getAgentSession(paneId, query).then((result) => {
      if (!current || owner.current !== expected) return
      reading.current = false
      setReadState({ kind: "idle" })
      result.match({
        ok: (session) => {
          selection.current = { status: "idle" }
          setSelection({ status: "idle" })
          const previous = stateRef.current
          if (request.page.kind === "latest" || previous.status !== "ready") {
            setState({ status: "ready", session })
            return
          }
          const turns = [...session.turns, ...previous.session.turns]
          if (turns.length > SESSION_TURN_LIMIT) {
            setReadState({
              kind: "failed",
              message: "The session view reached 2,000 turns. Refresh to return to the latest turns.",
            })
            return
          }
          setState({ status: "ready", session: { ...previous.session, turns, nextBefore: session.nextBefore } })
        },
        err: (error) => {
          const message = formatApiError(error)
          if (selection.current.status === "working") {
            const failure: SessionSelectionState = { status: "error", message }
            selection.current = failure
            setSelection(failure)
          } else if (stateRef.current.status === "ready") setReadState({ kind: "failed", message })
          else setState({ status: "error", message })
        },
      })
    })
    return () => {
      current = false
    }
  }, [api, handle, paneId, request, owner, selection, setSelection, reading])
  return { state, readState }
}

/** Session reads and selections share an owner revision. Old replies never replace
 * another pane's session. Selection failure keeps the candidate list available.
 */
export function useAgentSession(api: MsgrApi, handle: string, paneId: string | null) {
  const [request, setRequest] = useState<SessionReadRequest>({ page: { kind: "latest" }, revision: 0 })
  const [selectionState, setSelectionState] = useState<SessionSelectionState>({ status: "idle" })
  const selection = useRef<SessionSelectionState>({ status: "idle" })
  const owner = useRef<SessionOwner>({ handle, paneId, revision: 0 })
  const mounted = useRef(true)
  const reading = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    owner.current = { handle, paneId, revision: owner.current.revision + 1 }
    selection.current = { status: "idle" }
    reading.current = false
    setSelectionState({ status: "idle" })
    setRequest((current) => ({ page: { kind: "latest" }, revision: current.revision + 1 }))
    return () => {
      mounted.current = false
    }
  }, [handle, paneId])
  const { state, readState } = useSessionRead({
    api,
    handle,
    paneId,
    request,
    owner,
    selection,
    setSelection: setSelectionState,
    reading,
  })
  const refresh = useCallback(() => {
    reading.current = true
    setRequest((current) => ({ page: { kind: "latest" }, revision: current.revision + 1 }))
  }, [])
  const loadOlder = () => {
    if (
      state.status !== "ready" ||
      state.session.nextBefore === null ||
      selection.current.status === "working" ||
      reading.current
    )
      return
    const before = state.session.nextBefore
    reading.current = true
    setRequest((current) => ({ page: { kind: "older", before }, revision: current.revision + 1 }))
  }
  const selectSession = async (sessionId: string): Promise<void> => {
    if (paneId === null || selection.current.status === "working") return
    const expected: SessionOwner = { handle, paneId, revision: owner.current.revision + 1 }
    owner.current = expected
    selection.current = { status: "working", sessionId }
    setSelectionState(selection.current)
    const result = await api.selectAgentSession(paneId, { sessionId })
    if (!mounted.current || owner.current !== expected) return
    result.match({
      ok: refresh,
      err: (error) => {
        const failure: SessionSelectionState = { status: "error", message: formatApiError(error) }
        selection.current = failure
        setSelectionState(failure)
      },
    })
  }
  return { state, readState, selectionState, refresh, loadOlder, selectSession }
}
