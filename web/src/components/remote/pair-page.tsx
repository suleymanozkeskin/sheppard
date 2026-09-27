import { useEffect, useRef, useState, type FormEvent } from "react"
import { formatApiError, hubRefusal, type ApiError } from "@/api/errors"
import type { MsgrApi } from "@/api/types"
import { Button } from "@/components/ui/button"
import { pairingCodeFromHash, pairingFailureMessage, parsePairingCode } from "@/remote-access"

type PairState =
  | { status: "entering" }
  | { status: "pairing" }
  | { status: "paired" }
  | { status: "failed"; message: string }

function pairingErrorCopy(error: ApiError): string {
  const refusal = hubRefusal(error)
  return refusal.code === undefined ? formatApiError(error) : pairingFailureMessage(refusal.code, refusal.detail)
}

/** Redeems a code; on success the page reloads with the new session cookie. */
async function redeemCode(api: MsgrApi, code: string, setState: (state: PairState) => void): Promise<void> {
  setState({ status: "pairing" })
  const result = await api.redeemPairingCode({ code })
  if (result.isErr()) {
    setState({ status: "failed", message: pairingErrorCopy(result.error) })
    return
  }
  setState({ status: "paired" })
  globalThis.location.replace("/")
}

/**
 * The phone side of pairing. A code in the `#code=` fragment is taken and
 * removed from the address at once, so it does not stay in browser history.
 * Without one, the user types the code shown on the computer.
 */
export function PairPage({ api }: { api: MsgrApi }) {
  const [state, setState] = useState<PairState>({ status: "entering" })
  const [typed, setTyped] = useState("")
  // The fragment is read once, even when StrictMode mounts twice.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const fromHash = pairingCodeFromHash(globalThis.location.hash)
    if (globalThis.location.hash.length > 0) {
      globalThis.history.replaceState(null, "", globalThis.location.pathname)
    }
    switch (fromHash.kind) {
      case "absent":
        return
      case "invalid":
        setState({ status: "failed", message: fromHash.message })
        return
      case "valid":
        void redeemCode(api, fromHash.code, setState)
    }
  }, [api])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const parsed = parsePairingCode(typed)
    switch (parsed.kind) {
      case "invalid":
        setState({ status: "failed", message: parsed.message })
        return
      case "valid":
        void redeemCode(api, parsed.code, setState)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4 text-foreground" data-pair-page>
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Pair this device</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          On your computer, open Sheppard settings, choose Pair a device, and enter the code here.
        </p>
        <PairBody onChange={setTyped} onSubmit={submit} state={state} typed={typed} />
      </div>
    </main>
  )
}

interface PairBodyProps {
  state: PairState
  typed: string
  onChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function PairBody({ state, typed, onChange, onSubmit }: PairBodyProps) {
  switch (state.status) {
    case "pairing":
      return <p className="mt-4 text-sm" role="status">Pairing…</p>
    case "paired":
      return <p className="mt-4 text-sm" role="status">Paired. Opening Sheppard…</p>
    case "entering":
    case "failed":
      return (
        <form className="mt-4 space-y-3" onSubmit={onSubmit}>
          <label className="block text-sm font-medium" htmlFor="pairing-code">Pairing code</label>
          <input
            autoCapitalize="characters"
            autoComplete="one-time-code"
            className="h-12 w-full rounded-lg border bg-background px-3 text-center font-mono text-xl tracking-widest outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            id="pairing-code"
            inputMode="text"
            onChange={(event) => onChange(event.target.value)}
            placeholder="XXXX-XXXX"
            value={typed}
          />
          {state.status === "failed" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
          <Button className="w-full" type="submit">Pair</Button>
        </form>
      )
  }
}
