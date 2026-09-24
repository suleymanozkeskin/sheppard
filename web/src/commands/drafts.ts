import { Result, TaggedError } from "better-result"

import { COMMAND_MESSAGE_LIMIT, messageTargetKey, type MessageTarget } from "./types"

export const COMMAND_DRAFT_LIMIT = 8
export type CommandDraftTarget =
  Readonly<{ kind: "message"; recipient: MessageTarget }> | Readonly<{ kind: "terminal"; handle: string }>
export interface CommandDraft {
  readonly target: CommandDraftTarget
  readonly body: string
  readonly delivery: "editable" | "sending" | "uncertain"
}
export type CommandDrafts = ReadonlyMap<string, CommandDraft>

export class CommandDraftLimit extends TaggedError("CommandDraftLimit")<{
  readonly message: string
}> {}

export function commandDraftKey(target: CommandDraftTarget): string {
  return target.kind === "message" ? messageTargetKey(target.recipient) : `prompt:${target.handle}`
}

/** Creates a bounded in-memory draft collection. No text is written to storage.
 * Failure leaves all drafts unchanged. Clear a draft or shorten the text to retry.
 * Editing never clears an uncertain delivery result.
 */
export function updateCommandDraft(
  drafts: CommandDrafts,
  target: CommandDraftTarget,
  body: string,
): Result<CommandDrafts, CommandDraftLimit> {
  const key = commandDraftKey(target)
  if (body.length > COMMAND_MESSAGE_LIMIT)
    return Result.err(
      new CommandDraftLimit({
        message: `A draft can contain at most ${COMMAND_MESSAGE_LIMIT} characters. Shorten the text.`,
      }),
    )
  if (!drafts.has(key) && body.length > 0 && drafts.size >= COMMAND_DRAFT_LIMIT)
    return Result.err(
      new CommandDraftLimit({ message: "Eight drafts are already open. Send or clear one before you add another." }),
    )
  const next = new Map(drafts)
  if (body.length === 0 && drafts.get(key)?.delivery !== "uncertain") next.delete(key)
  else next.set(key, Object.freeze({ target, body, delivery: drafts.get(key)?.delivery ?? "editable" }))
  return Result.ok(next)
}

/** A submitted draft already has a slot. Marking its result never adds a slot. */
export function setDraftDelivery(
  drafts: CommandDrafts,
  key: string,
  delivery: CommandDraft["delivery"],
): CommandDrafts {
  const draft = drafts.get(key)
  if (draft === undefined) return drafts
  const next = new Map(drafts)
  if (delivery === "editable" && draft.body.length === 0) {
    next.delete(key)
    return next
  }
  next.set(key, Object.freeze({ ...draft, delivery }))
  return next
}
