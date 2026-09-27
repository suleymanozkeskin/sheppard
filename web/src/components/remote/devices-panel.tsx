import { useCallback, useEffect, useState } from "react"
import { Smartphone } from "lucide-react"
import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { MsgrApi, PairingCode, RemoteAccessStatus, RemoteSession } from "@/api/types"
import { Button } from "@/components/ui/button"
import { pairingCountdown } from "@/remote-access"
import { QrCode } from "./qr-code"

const COUNTDOWN_TICK_MS = 1_000

type LoadState =
  | { status: "loading" }
  | { status: "ready"; remote: RemoteAccessStatus }
  | { status: "error"; message: string }

type PairingState =
  | { status: "none" }
  | { status: "creating" }
  | { status: "open"; pairing: PairingCode }
  | { status: "failed"; message: string }

type RevokeState =
  | { status: "idle" }
  | { status: "working"; id: number }
  | { status: "failed"; message: string }

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function lastSeenLabel(session: RemoteSession): string {
  switch (session.lastSeen.kind) {
    case "seen":
      return `last seen ${formatTime(session.lastSeen.at)}`
    case "not-seen":
      return "not seen yet"
  }
}

/** Shows remote access, pairs a new device with a QR code, and revokes devices. */
export function DevicesPanel({ api }: { api: MsgrApi }) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" })
  const [pairing, setPairing] = useState<PairingState>({ status: "none" })
  const [revoke, setRevoke] = useState<RevokeState>({ status: "idle" })
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let active = true
    void apiCall(api, undefined, (client) => client.getRemoteAccess()).then((result) => {
      if (!active) return
      setLoad(result.isOk()
        ? { status: "ready", remote: result.value }
        : { status: "error", message: formatApiError(result.error) })
    })
    return () => {
      active = false
    }
  }, [api, reloadKey])

  const createCode = async (): Promise<void> => {
    setPairing({ status: "creating" })
    const result = await apiCall(api, undefined, (client) => client.createPairingCode())
    setPairing(result.isOk()
      ? { status: "open", pairing: result.value }
      : { status: "failed", message: formatApiError(result.error) })
  }

  const revokeSession = async (id: number): Promise<void> => {
    setRevoke({ status: "working", id })
    const result = await apiCall(api, undefined, (client) => client.revokeRemoteSession(id))
    if (result.isErr()) {
      setRevoke({ status: "failed", message: formatApiError(result.error) })
      return
    }
    setRevoke({ status: "idle" })
    reload()
  }

  return (
    <section aria-labelledby="settings-devices-title" className="rounded-xl border p-4" data-devices-panel>
      <h3 className="inline-flex items-center gap-2 text-sm font-semibold" id="settings-devices-title">
        <Smartphone aria-hidden="true" className="size-4" />
        Devices
      </h3>
      <DevicesBody
        load={load}
        onCreateCode={() => void createCode()}
        onPaired={reload}
        onRetry={reload}
        onRevoke={(id) => void revokeSession(id)}
        pairing={pairing}
        revoke={revoke}
      />
    </section>
  )
}

interface DevicesBodyProps {
  load: LoadState
  pairing: PairingState
  revoke: RevokeState
  onCreateCode: () => void
  onPaired: () => void
  onRetry: () => void
  onRevoke: (id: number) => void
}

function DevicesBody({ load, pairing, revoke, onCreateCode, onPaired, onRetry, onRevoke }: DevicesBodyProps) {
  switch (load.status) {
    case "loading":
      return <p className="mt-2 text-sm text-muted-foreground" role="status">Loading remote access…</p>
    case "error":
      return (
        <div className="mt-2 text-sm">
          <p className="text-destructive" role="alert">{load.message}</p>
          <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">Retry</Button>
        </div>
      )
    case "ready":
      break
  }
  const { access, sessions } = load.remote
  switch (access.kind) {
    case "off":
      return (
        <p className="mt-2 text-sm text-muted-foreground" data-remote-access="off">
          Remote access is off. Run <code>sheppard remote enable</code> on this computer.
        </p>
      )
    case "on":
      return (
        <div className="mt-2 space-y-3 text-sm" data-remote-access="on">
          <p className="text-muted-foreground">
            Open <span className="font-medium text-foreground">{access.origin}</span> on a device signed in to Tailscale as{" "}
            <span className="font-medium text-foreground">{access.ownerLogin}</span>.
          </p>
          <PairingArea onCreateCode={onCreateCode} onPaired={onPaired} pairing={pairing} />
          <PairedDevices onRevoke={onRevoke} revoke={revoke} sessions={sessions} />
        </div>
      )
  }
}

function PairingArea({ pairing, onCreateCode, onPaired }: { pairing: PairingState; onCreateCode: () => void; onPaired: () => void }) {
  switch (pairing.status) {
    case "none":
      return <Button onClick={onCreateCode} size="sm">Pair a device</Button>
    case "creating":
      return <Button disabled size="sm">Creating a code…</Button>
    case "failed":
      return (
        <div>
          <p className="text-destructive" role="alert">{pairing.message}</p>
          <Button className="mt-2" onClick={onCreateCode} size="sm" variant="outline">Try again</Button>
        </div>
      )
    case "open":
      return <OpenPairing onCreateCode={onCreateCode} onPaired={onPaired} pairing={pairing.pairing} />
  }
}

/** The QR code and typed code, with a countdown. Expiry offers a new code. */
function OpenPairing({ pairing, onCreateCode, onPaired }: { pairing: PairingCode; onCreateCode: () => void; onPaired: () => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const countdown = pairingCountdown(pairing.expiresAt, nowMs)
  switch (countdown.kind) {
    case "expired":
      return (
        <div data-pairing="expired">
          <p className="text-muted-foreground">Code expired.</p>
          <Button className="mt-2" onClick={onCreateCode} size="sm">New code</Button>
        </div>
      )
    case "open":
      return (
        <div className="flex flex-wrap items-start gap-4" data-pairing="open">
          <QrCode label="Pairing link for a new device" value={pairing.url} />
          <div className="space-y-2">
            <p className="text-muted-foreground">Scan with the phone camera, or open the address and type:</p>
            <p className="font-mono text-2xl font-semibold tracking-widest" data-pairing-code>{pairing.code}</p>
            <p className="text-muted-foreground">Works once. Expires in {countdown.label}.</p>
            <Button onClick={onPaired} size="sm" variant="outline">Refresh device list</Button>
          </div>
        </div>
      )
  }
}

function PairedDevices({ sessions, revoke, onRevoke }: { sessions: readonly RemoteSession[]; revoke: RevokeState; onRevoke: (id: number) => void }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">Paired devices</h4>
      {sessions.length === 0 ? (
        <p className="mt-1 text-muted-foreground">No device is paired.</p>
      ) : (
        <ul className="mt-1 divide-y" aria-label="Paired devices">
          {sessions.map((session) => (
            <li className="flex items-center justify-between gap-3 py-2" data-remote-session={session.id} key={session.id}>
              <span>
                <span className="font-medium">@{session.handle}</span>{" "}
                <span className="text-muted-foreground">paired {formatTime(session.createdAt)}, {lastSeenLabel(session)}</span>
              </span>
              <Button
                disabled={revoke.status === "working" && revoke.id === session.id}
                onClick={() => onRevoke(session.id)}
                size="sm"
                variant="outline"
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.status === "failed" && <p className="mt-1 text-destructive" role="alert">{revoke.message}</p>}
    </div>
  )
}
