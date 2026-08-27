import { Result, TaggedError } from "better-result"
import * as v from "valibot"

import type { HerdrPaneView, HerdrWorkspaceView } from "@/api/types"

export const WORKSPACE_EXPANSION_STORAGE_KEY = "msgr.workspace-expansion.v1"
export const WORKSPACE_DIRECTORY_EXPANSION_STORAGE_KEY = "msgr.workspace-directory-expansion.v2"
export const WORKSPACE_DIRECTORY_HEADER_HEIGHT_PX = 64
export const WORKSPACE_DIRECTORY_BLOCK_HEIGHT_PX = 320

const workspaceExpansionSchema = v.object({
  version: v.literal(1),
  expanded: v.array(v.string()),
})

export class WorkspaceExpansionStorageError extends TaggedError("WorkspaceExpansionStorageError")<{
  cause: unknown
  message: string
}> {}

function loadExpandedWorkspaceIdsFromKey(key: string): Result<Set<string> | undefined, WorkspaceExpansionStorageError> {
  const storageResult = Result.try<Storage | null, WorkspaceExpansionStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) => new WorkspaceExpansionStorageError({ cause, message: "Workspace expansion state is unavailable." }),
  })
  return storageResult.andThen((storage) => {
    if (storage === null) return Result.ok(undefined)
    return Result.try<string | null, WorkspaceExpansionStorageError>({
      try: () => storage.getItem(key),
      catch: (cause) => new WorkspaceExpansionStorageError({ cause, message: "Workspace expansion state could not be read." }),
    }).andThen((raw) => {
      if (raw === null) return Result.ok(undefined)
      return Result.try<unknown, WorkspaceExpansionStorageError>({
        try: () => JSON.parse(raw),
        catch: (cause) => new WorkspaceExpansionStorageError({ cause, message: "Workspace expansion state is invalid." }),
      }).andThen((candidate) => {
        const parsed = v.safeParse(workspaceExpansionSchema, candidate)
        return parsed.success
          ? Result.ok(new Set(parsed.output.expanded))
          : Result.err(new WorkspaceExpansionStorageError({ cause: parsed.issues, message: "Workspace expansion state is invalid." }))
      })
    })
  })
}

function saveExpandedWorkspaceIdsToKey(key: string, ids: ReadonlySet<string>): Result<void, WorkspaceExpansionStorageError> {
  const storageResult = Result.try<Storage | null, WorkspaceExpansionStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) => new WorkspaceExpansionStorageError({ cause, message: "Workspace expansion state is unavailable." }),
  })
  return storageResult.andThen((storage) => {
    if (storage === null) return Result.ok(undefined)
    const value = JSON.stringify({ version: 1, expanded: [...ids].toSorted() })
    return Result.try<void, WorkspaceExpansionStorageError>({
      try: () => storage.setItem(key, value),
      catch: (cause) => new WorkspaceExpansionStorageError({ cause, message: "Workspace expansion state could not be saved." }),
    })
  })
}

export function loadExpandedWorkspaceIds(): Result<Set<string> | undefined, WorkspaceExpansionStorageError> {
  return loadExpandedWorkspaceIdsFromKey(WORKSPACE_EXPANSION_STORAGE_KEY)
}

export function saveExpandedWorkspaceIds(ids: ReadonlySet<string>): Result<void, WorkspaceExpansionStorageError> {
  return saveExpandedWorkspaceIdsToKey(WORKSPACE_EXPANSION_STORAGE_KEY, ids)
}

export function loadWorkspaceDirectoryExpandedIds(): Result<Set<string> | undefined, WorkspaceExpansionStorageError> {
  return loadExpandedWorkspaceIdsFromKey(WORKSPACE_DIRECTORY_EXPANSION_STORAGE_KEY)
}

export function saveWorkspaceDirectoryExpandedIds(ids: ReadonlySet<string>): Result<void, WorkspaceExpansionStorageError> {
  return saveExpandedWorkspaceIdsToKey(WORKSPACE_DIRECTORY_EXPANSION_STORAGE_KEY, ids)
}

export function workspaceDirectoryBudget(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight)) return 1
  const bodyHeight = Math.max(viewportHeight - WORKSPACE_DIRECTORY_HEADER_HEIGHT_PX, 0)
  return Math.max(1, Math.floor((bodyHeight * 2.5) / WORKSPACE_DIRECTORY_BLOCK_HEIGHT_PX))
}

export function workspaceLabel(workspace: HerdrWorkspaceView): string {
  return workspace.label ?? workspace.id
}

function relativeAgeFromEpoch(value: number): string {
  if (!Number.isFinite(value)) return "time unavailable"
  const elapsed = Math.max(Date.now() - value, 0)
  if (elapsed < 60_000) return "just now"
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function relativeAgeLabel(timestamp: string): string {
  return relativeAgeFromEpoch(Date.parse(timestamp))
}

export function relativeEpochAgeLabel(timestamp: number): string {
  return relativeAgeFromEpoch(timestamp)
}

/**
 * The exact time, for the tooltip behind a relative label. The `datetime` attribute
 * keeps the stored ISO value — it is machine-readable and never shown — while a title
 * is read by a person, and a reader should not have to decode a timezone suffix to
 * learn the time of day.
 */
export function absoluteTimeLabel(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return "time unavailable"
  return new Date(parsed).toLocaleString()
}

export function matchedParticipantCount(workspace: HerdrWorkspaceView): number {
  return workspace.panes.reduce((count, pane) => count + (pane.participant === null ? 0 : 1), 0)
}

export function staleParticipantCount(workspace: HerdrWorkspaceView): number {
  return workspace.panes.reduce(
    (count, pane) => count + (pane.participant !== null && pane.participantRouteState === "stale" ? 1 : 0),
    0,
  )
}

export function agentPaneCount(workspace: HerdrWorkspaceView): number {
  return workspace.panes.reduce((count, pane) => count + (pane.agentKind === null ? 0 : 1), 0)
}

export function unmanagedAgentCount(workspace: HerdrWorkspaceView): number {
  return workspace.panes.reduce(
    (count, pane) => count + (pane.agentKind !== null && pane.participant === null ? 1 : 0),
    0,
  )
}

export function compareWorkspaces(left: HerdrWorkspaceView, right: HerdrWorkspaceView): number {
  return matchedParticipantCount(right) - matchedParticipantCount(left)
    || staleParticipantCount(right) - staleParticipantCount(left)
    || workspaceLabel(left).localeCompare(workspaceLabel(right))
    || left.id.localeCompare(right.id)
}

export function defaultExpandedWorkspaceIds(workspaces: readonly HerdrWorkspaceView[]): Set<string> {
  const expanded: string[] = []
  for (const workspace of workspaces) {
    if (matchedParticipantCount(workspace) > 0) expanded.push(workspace.id)
  }
  return new Set(expanded)
}

export function paneIdentity(pane: HerdrPaneView): string {
  return pane.participant ?? pane.label ?? pane.paneId
}

export function paneTitle(pane: HerdrPaneView): string | undefined {
  return pane.participant !== null && pane.label !== null && pane.participant !== pane.label
    ? pane.label
    : undefined
}

export function paneStopConfirmation(pane: HerdrPaneView): string | null {
  if (pane.agentKind === null) return pane.label
  return pane.participantRouteState === "active" ? pane.participant : pane.label
}

export function isEmptyPane(pane: HerdrPaneView): boolean {
  return pane.agentKind === null && pane.agentStatus === "unknown"
}

export function paneStatusLabel(pane: HerdrPaneView): string {
  if (isEmptyPane(pane)) return "empty pane"
  return pane.agentStatus
}

function panePriority(pane: HerdrPaneView): number {
  if (pane.participant !== null && pane.participantRouteState === "stale") return 0
  if (pane.focused) return 1
  if (pane.participant !== null) return 2
  if (pane.agentKind !== null) return 3
  return 4
}

function matchedStatusPriority(pane: HerdrPaneView): number {
  if (pane.agentStatus === "working") return 0
  if (pane.agentStatus === "blocked") return 1
  if (pane.agentStatus === "idle") return 2
  if (pane.agentStatus === "done") return 3
  return 4
}

export function comparePanes(left: HerdrPaneView, right: HerdrPaneView): number {
  const priority = panePriority(left) - panePriority(right)
  if (priority !== 0) return priority
  if (left.participant !== null && right.participant !== null) {
    const status = matchedStatusPriority(left) - matchedStatusPriority(right)
    if (status !== 0) return status
  }
  return paneIdentity(left).localeCompare(paneIdentity(right)) || left.paneId.localeCompare(right.paneId)
}
