import type { ChannelReceipt, Message } from "@/api/types"

export interface MessageReceiptState {
  hasRecipients: boolean
  requiredRecipientsSeen: boolean
  seenHandles: string[]
  notYetHandles: string[]
  cannotReceiveHandles: string[]
}

export interface ReceiptSummary {
  notYet: string | undefined
  cannotReceive: string | undefined
  seen: boolean
}

const RECEIPT_HANDLE_LIMIT = 5

interface CappedHandles {
  visible: string[]
  remaining: number
}

export function latestOwnMessageId(messages: readonly Message[], selfHandle: string | undefined): number | undefined {
  if (selfHandle === undefined) return undefined
  return messages.reduce<number | undefined>((latest, message) => {
    if (message.sender !== selfHandle) return latest
    return latest === undefined ? message.id : Math.max(latest, message.id)
  }, undefined)
}

export function deriveMessageReceiptState(
  receipts: readonly ChannelReceipt[],
  messageId: number,
  selfHandle: string | undefined,
): MessageReceiptState {
  const recipients = receipts.filter((receipt) => receipt.handle !== selfHandle)
  const seenHandles: string[] = []
  const notYetHandles: string[] = []
  const cannotReceiveHandles: string[] = []

  for (const receipt of recipients) {
    if (receipt.cursorMessageId >= messageId) {
      seenHandles.push(receipt.handle)
    } else if (receipt.routeState === "stale") {
      cannotReceiveHandles.push(receipt.handle)
    } else {
      notYetHandles.push(receipt.handle)
    }
  }

  const sortHandles = (handles: string[]): void => {
    handles.sort((left, right) => left.localeCompare(right))
  }
  sortHandles(seenHandles)
  sortHandles(notYetHandles)
  sortHandles(cannotReceiveHandles)

  return {
    cannotReceiveHandles,
    hasRecipients: recipients.length > 0,
    notYetHandles,
    requiredRecipientsSeen: recipients.length > 0 && seenHandles.length === recipients.length,
    seenHandles,
  }
}

function cappedHandles(handles: readonly string[]): CappedHandles {
  return {
    remaining: Math.max(handles.length - RECEIPT_HANDLE_LIMIT, 0),
    visible: handles.slice(0, RECEIPT_HANDLE_LIMIT),
  }
}

export function formatReceiptSummary(state: MessageReceiptState): ReceiptSummary {
  const notYet = cappedHandles(state.notYetHandles)
  const cannotReceive = cappedHandles(state.cannotReceiveHandles)
  const notYetText = notYet.visible.length === 0
    ? undefined
    : `Not yet seen by ${state.notYetHandles.length}: ${notYet.visible.join(", ")}${notYet.remaining > 0 ? ` · and ${notYet.remaining} more` : ""}`
  const cannotReceiveSubject = cannotReceive.visible.join(", ")
  const cannotReceiveText = cannotReceive.visible.length === 0
    ? undefined
    : `${cannotReceiveSubject} ${state.cannotReceiveHandles.length === 1 ? "is" : "are"} not running${cannotReceive.remaining > 0 ? ` · and ${cannotReceive.remaining} more` : ""}`

  return {
    cannotReceive: cannotReceiveText,
    notYet: notYetText,
    seen: state.requiredRecipientsSeen,
  }
}
