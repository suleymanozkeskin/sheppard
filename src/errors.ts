/**
 * Expected failures, returned as values rather than thrown. Each carries the
 * data a caller needs to decide what to do, so no layer has to re-derive
 * context by parsing a message string. Broken invariants use `panic` instead
 * and never appear in a Result.
 */

import { TaggedError } from "better-result";

export class HandleTaken extends TaggedError("HandleTaken")<{
  handle: string;
  message: string;
}> {}

export class ChannelNotFound extends TaggedError("ChannelNotFound")<{
  channel: string;
  message: string;
}> {}

export class ChannelExists extends TaggedError("ChannelExists")<{
  channel: string;
  message: string;
}> {}

export class ChannelNotDeletable extends TaggedError("ChannelNotDeletable")<{
  channel: string;
  kind: "workspace";
  message: string;
}> {}

export class LauncherExists extends TaggedError("LauncherExists")<{
  name: string;
  message: string;
}> {}

export class RoleExists extends TaggedError("RoleExists")<{
  name: string;
  message: string;
}> {}

export class ModelExists extends TaggedError("ModelExists")<{
  harness: string;
  name: string;
  message: string;
}> {}

export class MembershipExists extends TaggedError("MembershipExists")<{
  channel: string;
  handle: string;
  message: string;
}> {}

export class DirectMembershipLocked extends TaggedError("DirectMembershipLocked")<{
  channel: string;
  message: string;
}> {}

export class NotAMember extends TaggedError("NotAMember")<{
  channel: string;
  participantId: number;
  message: string;
}> {}

export class DatabaseOpenFailed extends TaggedError("DatabaseOpenFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

/** A request the server refuses to interpret: wrong type, wrong shape, out of range. */
export class ValidationFailed extends TaggedError("ValidationFailed")<{
  field: string;
  message: string;
}> {}

/** No usable credential was presented. */
export class Unauthorized extends TaggedError("Unauthorized")<{
  message: string;
}> {}

/**
 * The caller is authenticated but the capability is reserved for the
 * operator's human identity. An agent driving another agent's terminal over
 * HTTP would bypass the never-run-another's-token rule, so the refusal is by
 * identity kind, not by credential.
 */
export class OperatorOnly extends TaggedError("OperatorOnly")<{
  message: string;
}> {}

export function operatorOnly(capability: string): OperatorOnly {
  return new OperatorOnly({ message: `Only the operator may ${capability}` });
}

export class HerdrSessionMismatch extends TaggedError("HerdrSessionMismatch")<{
  message: string;
}> {}

export type HerdrFailureKind = "timeout" | "reported" | "unknown";

export class HerdrCallFailed extends TaggedError("HerdrCallFailed")<{
  command: string;
  detail: string;
  kind: HerdrFailureKind;
  paneId: string | null;
  message: string;
}> {}

export class HerdrNotConfigured extends TaggedError("HerdrNotConfigured")<{
  message: string;
}> {}

/** The request named something that does not exist, or that the caller may not see. */
export class NotFound extends TaggedError("NotFound")<{
  message: string;
}> {}

/** The attachment exists but was never eligible for preview. */
export class NotPreviewable extends TaggedError("NotPreviewable")<{
  attachmentId: number;
  message: string;
}> {}

export class UploadStorageFailed extends TaggedError("UploadStorageFailed")<{
  message: string;
}> {}

export type DictationFailureReason =
  | "compile_failed"
  | "local_recognition_unavailable"
  | "locale_unsupported"
  | "no_speech"
  | "permission_denied"
  | "recognition_failed"
  | "timeout"
  | "unsupported_os";

export class DictationUnavailable extends TaggedError("DictationUnavailable")<{
  reason: DictationFailureReason;
  message: string;
}> {}

/** A request rejected before any handler ran, by the checks that keep browsers out. */
export class RequestRejected extends TaggedError("RequestRejected")<{
  reason: "host" | "origin" | "content_type";
  message: string;
}> {}

export function handleTaken(handle: string): HandleTaken {
  return new HandleTaken({ handle, message: `Handle "${handle}" is already taken` });
}

export function channelNotFound(channel: string): ChannelNotFound {
  return new ChannelNotFound({ channel, message: `No channel named "${channel}"` });
}

export function channelExists(channel: string): ChannelExists {
  return new ChannelExists({ channel, message: `Channel "${channel}" already exists` });
}

export function channelNotDeletable(
  channel: string,
  kind: "workspace",
): ChannelNotDeletable {
  return new ChannelNotDeletable({
    channel,
    kind,
    message: `${kind} channels cannot be deleted`,
  });
}

export function launcherExists(name: string): LauncherExists {
  return new LauncherExists({ name, message: `Launcher "${name}" already exists` });
}

export function roleExists(name: string): RoleExists {
  return new RoleExists({ name, message: `Role "${name}" already exists` });
}

export function modelExists(harness: string, name: string): ModelExists {
  return new ModelExists({
    harness,
    name,
    message: `Model "${name}" already exists for harness "${harness}"`,
  });
}

export function membershipExists(channel: string, handle: string): MembershipExists {
  return new MembershipExists({
    channel,
    handle,
    message: `Participant "${handle}" is already a member of "${channel}"`,
  });
}

export function directMembershipLocked(channel: string): DirectMembershipLocked {
  return new DirectMembershipLocked({
    channel,
    message: `Direct conversation "${channel}" has a fixed membership`,
  });
}

export function notAMember(channel: string, participantId: number): NotAMember {
  return new NotAMember({
    channel,
    participantId,
    message: `Not a member of "${channel}"`,
  });
}

export function validationFailed(field: string, problem: string): ValidationFailed {
  return new ValidationFailed({ field, message: `${field} ${problem}` });
}

export function unauthorized(): Unauthorized {
  return new Unauthorized({ message: "A valid token is required" });
}

export function herdrSessionMismatch(): HerdrSessionMismatch {
  return new HerdrSessionMismatch({ message: "The request belongs to another herdr session" });
}

export function herdrCallFailed(
  detail: string,
  command = "agent prompt",
  kind: HerdrFailureKind = "unknown",
  paneId: string | null = null,
): HerdrCallFailed {
  return new HerdrCallFailed({
    command,
    detail,
    kind,
    paneId,
    message: `herdr ${command} did not complete: ${detail}`,
  });
}

export function herdrNotConfigured(): HerdrNotConfigured {
  return new HerdrNotConfigured({ message: "This hub is not attached to herdr" });
}

export function notFound(what: string): NotFound {
  return new NotFound({ message: `${what} not found` });
}

export function notPreviewable(attachmentId: number): NotPreviewable {
  return new NotPreviewable({
    attachmentId,
    message: "This attachment is not an image captured for preview",
  });
}

export function uploadStorageFailed(): UploadStorageFailed {
  return new UploadStorageFailed({ message: "The upload could not be stored" });
}

export function dictationUnavailable(
  reason: DictationFailureReason,
  message: string,
): DictationUnavailable {
  return new DictationUnavailable({ reason, message });
}
