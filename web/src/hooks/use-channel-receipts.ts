import { useEffect, useRef, useState } from "react"

import type { ChannelReceipt, MsgrApi, RouteState } from "@/api/types"
import { apiCall } from "@/api/runtime"

const EMPTY_RECEIPT_UPDATES: ReadonlyMap<string, number> = new Map()
const EMPTY_ROUTE_STATES: ReadonlyMap<string, RouteState> = new Map()

interface ReceiptState {
  channel: string | undefined
  receipts: readonly ChannelReceipt[]
}

export function useChannelReceipts(
  api: MsgrApi | undefined,
  fallbackApi: MsgrApi | undefined,
  channelName: string | undefined,
  enabled: boolean,
  receiptUpdates: ReadonlyMap<string, number> = EMPTY_RECEIPT_UPDATES,
  receiptUpdatesChannel: string | undefined = undefined,
  routeStates: ReadonlyMap<string, RouteState> = EMPTY_ROUTE_STATES,
  reloadKey = 0,
): readonly ChannelReceipt[] {
  const [receiptState, setReceiptState] = useState<ReceiptState>({ channel: channelName, receipts: [] })
  const receiptUpdatesRef = useRef(receiptUpdates)
  const receiptUpdatesChannelRef = useRef(receiptUpdatesChannel)
  const routeStatesRef = useRef(routeStates)
  receiptUpdatesRef.current = receiptUpdates
  receiptUpdatesChannelRef.current = receiptUpdatesChannel
  routeStatesRef.current = routeStates

  useEffect(() => {
    if (!enabled || api === undefined || channelName === undefined) {
      setReceiptState({ channel: channelName, receipts: [] })
      return
    }

    let mounted = true
    setReceiptState({ channel: channelName, receipts: [] })
    void apiCall(api, fallbackApi, (client) => client.listReceipts(channelName)).then((result) => {
      if (!mounted) return
      result.match({
        ok: (nextReceipts) => {
          const withUpdates = applyReceiptUpdates(nextReceipts, receiptUpdatesRef.current, channelName, receiptUpdatesChannelRef.current)
          setReceiptState((current) => current.channel === channelName
            ? { channel: channelName, receipts: applyRouteStates(withUpdates, routeStatesRef.current) }
            : current)
        },
        err: () => setReceiptState((current) => current.channel === channelName ? { channel: channelName, receipts: [] } : current),
      })
    })

    return () => {
      mounted = false
    }
  }, [api, channelName, enabled, fallbackApi, reloadKey])

  useEffect(() => {
    if (!enabled || channelName === undefined || receiptUpdatesChannel !== channelName || receiptUpdates.size === 0) return
    setReceiptState((current) => current.channel !== channelName
      ? current
      : { channel: channelName, receipts: applyReceiptUpdates(current.receipts, receiptUpdates, channelName, receiptUpdatesChannel) })
  }, [channelName, enabled, receiptUpdates, receiptUpdatesChannel])

  useEffect(() => {
    if (!enabled || channelName === undefined || routeStates.size === 0) return
    setReceiptState((current) => current.channel !== channelName
      ? current
      : { channel: channelName, receipts: applyRouteStates(current.receipts, routeStates) })
  }, [channelName, enabled, routeStates])

  return enabled && receiptState.channel === channelName ? receiptState.receipts : []
}

function applyReceiptUpdates(
  receipts: readonly ChannelReceipt[],
  updates: ReadonlyMap<string, number>,
  channelName: string | undefined,
  updatesChannel: string | undefined,
): readonly ChannelReceipt[] {
  if (channelName === undefined || updatesChannel !== channelName || updates.size === 0) return receipts
  let changed = false
  const next = receipts.map((receipt) => {
    const cursorMessageId = updates.get(receipt.handle)
    if (cursorMessageId === undefined || cursorMessageId <= receipt.cursorMessageId) return receipt
    changed = true
    return { ...receipt, cursorMessageId }
  })
  return changed ? next : receipts
}

function applyRouteStates(
  receipts: readonly ChannelReceipt[],
  routeStates: ReadonlyMap<string, RouteState>,
): readonly ChannelReceipt[] {
  if (routeStates.size === 0) return receipts
  let changed = false
  const next = receipts.map((receipt) => {
    const routeState = routeStates.get(receipt.handle)
    if (routeState === undefined || routeState === receipt.routeState) return receipt
    changed = true
    return { ...receipt, routeState }
  })
  return changed ? next : receipts
}
