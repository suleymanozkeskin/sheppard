import { Result } from "better-result"

import {
  commandDraftKey,
  setDraftDelivery,
  updateCommandDraft,
  type CommandDraft,
  type CommandDrafts,
  type CommandDraftTarget,
} from "./drafts"

export type DraftFailure =
  | Readonly<{ kind: "missing"; message: string }>
  | Readonly<{ kind: "sending"; message: string }>
  | Readonly<{ kind: "uncertain"; message: string }>
  | Readonly<{ kind: "limit"; message: string }>

const DRAFT_SUBSCRIBER_LIMIT = 32

/** One store belongs to one app instance. It never uses browser storage.
 * Start locks a draft synchronously across views. Only a confirmed send clears
 * it. A failed write leaves text intact; uncertain completion blocks a repeat.
 */
export class CommandDraftStore {
  private drafts: CommandDrafts = new Map()
  private readonly listeners = new Set<() => void>()

  readonly snapshot = (): CommandDrafts => this.drafts

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= DRAFT_SUBSCRIBER_LIMIT)
      throw new Error("CommandDraftStore exceeded its view subscriber limit")
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(drafts: CommandDrafts): void {
    this.drafts = drafts
    for (const listener of this.listeners) listener()
  }

  write(target: CommandDraftTarget, body: string): Result<void, DraftFailure> {
    if (this.drafts.get(commandDraftKey(target))?.delivery === "sending")
      return Result.err({
        kind: "sending",
        message: "This draft is being sent. Wait for the result before editing it.",
      })
    return updateCommandDraft(this.drafts, target, body)
      .mapError((error): DraftFailure => ({ kind: "limit", message: error.message }))
      .map((drafts) => this.publish(drafts))
  }

  start(key: string): Result<CommandDraft, DraftFailure> {
    const draft = this.drafts.get(key)
    if (draft === undefined)
      return Result.err({ kind: "missing", message: "Write a message before sending. Nothing was sent." })
    switch (draft.delivery) {
      case "sending":
        return Result.err({ kind: "sending", message: "This draft is already being sent. Wait for its result." })
      case "uncertain":
        return Result.err({
          kind: "uncertain",
          message: "The last send was not confirmed. Check the target before sending again.",
        })
      case "editable":
        this.publish(setDraftDelivery(this.drafts, key, "sending"))
        return Result.ok(draft)
    }
  }

  settle(key: string, delivery: "editable" | "uncertain"): void {
    this.publish(setDraftDelivery(this.drafts, key, delivery))
  }

  complete(key: string): void {
    const next = new Map(this.drafts)
    next.delete(key)
    this.publish(next)
  }
}
