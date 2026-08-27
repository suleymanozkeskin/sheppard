import { escapeForTerminal } from "./format";

export type Operation =
  | "createChannel"
  | "createDirect"
  | "createHuman"
  | "createAgent"
  | "joinChannel"
  | "addMember"
  | "removeMember"
  | "sendMessage"
  | "acknowledge"
  | "listChannels"
  | "listDirect"
  | "listMessages"
  | "listMembers"
  | "listParticipants"
  | "listReceipts"
  | "deactivateParticipant"
  | "context"
  | "inbox"
  | "search"
  | "listRoles"
  | "createRole"
  | "readRole"
  | "updateRole"
  | "updateRoleRuntime"
  | "listModels"
  | "refreshModels"
  | "listLaunchers"
  | "listHarnesses"
  | "attachmentContent"
  | "uploadFile"
  | "listWorkspaces"
  | "createWorkspace"
  | "closeWorkspace"
  | "broadcastWorkspace"
  | "spawnAgent";

export type Cause =
  | "ChannelExists"
  | "ChannelNotFound"
  | "DirectMembershipLocked"
  | "HandleTaken"
  | "MembershipExists"
  | "NotAMember"
  | "NotFound"
  | "NotPreviewable"
  | "RequestRejected"
  | "RoleExists"
  | "HerdrSessionMismatch"
  | "Unauthorized"
  | "UploadStorageFailed"
  | "HerdrNotConfigured"
  | "HerdrCallFailed"
  | "ValidationFailed"
  | "HerdrUnavailable"
  | "Unreachable"
  | "Undecodable"
  | "Unclassified";

export interface OperatorMessage {
  title: string;
  action: string | undefined;
}

export type Audience = "browser" | "cli";

interface CopyRow {
  browserTitle: string;
  browserAction: string | undefined;
  cliTitle: string;
  cliAction: string | undefined;
}

export interface FailureCopyInput {
  operation: Operation;
  cause: Cause;
  detail: string | undefined;
  value: string | undefined;
}

function copyRow(
  browserTitle: string,
  browserAction: string | undefined,
  cliAction: string | undefined = browserAction,
  cliTitle: string = browserTitle,
): CopyRow {
  return { browserTitle, browserAction, cliTitle, cliAction };
}

function forAudience(row: CopyRow, audience: Audience): OperatorMessage {
  switch (audience) {
    case "browser":
      return { title: row.browserTitle, action: row.browserAction };
    case "cli":
      return { title: row.cliTitle, action: row.cliAction };
  }
}

function detailCopy(detail: string | undefined): string {
  if (detail === undefined || detail.length === 0) return "The hub refused that request.";
  return escapeForTerminal(detail);
}

function sentenceDetailCopy(detail: string | undefined): string {
  const escaped = detailCopy(detail);
  return `${escaped.slice(0, 1).toUpperCase()}${escaped.slice(1)}`;
}

function valueCopy(value: string | undefined): string {
  return escapeForTerminal(value ?? "");
}

function genericCopy(detail: string | undefined): CopyRow {
  return copyRow("The hub refused that request.", detailCopy(detail));
}

function validationCopy(operation: Operation, detail: string | undefined): CopyRow {
  switch (operation) {
    case "createAgent":
    case "createHuman":
      return copyRow(
        "That name is not allowed.",
        "Use lowercase letters, digits, `-` or `_`. Start with a letter. Keep it to 32 characters.",
      );
    case "createChannel":
      return copyRow(
        "That channel name is not allowed.",
        "Use lowercase letters, digits, `-` or `_`. Start with a letter. Keep it to 32 characters.",
      );
    case "addMember":
    case "deactivateParticipant":
      return copyRow(
        "That is not a valid handle.",
        "Use lowercase letters, digits, `-` or `_`. Start with a letter.",
      );
    case "sendMessage":
      return copyRow("That message cannot be sent.", sentenceDetailCopy(detail));
    case "createDirect":
      return copyRow("That direct message cannot be sent.", sentenceDetailCopy(detail));
    case "uploadFile":
      return copyRow(
        "That file is too large.",
        "The limit is 25 MB. Send the path instead, with the paperclip.",
        "The limit is 25 MB. Send the path instead: `msgr send <channel> <text> --file /abs/path`",
      );
    case "search":
      return copyRow("That search is too long.", "Keep the query to 256 characters.");
    case "createRole":
    case "updateRole":
    case "updateRoleRuntime":
      return copyRow("That role cannot be saved.", sentenceDetailCopy(detail));
    case "refreshModels":
      return copyRow("The model catalogue cannot be refreshed.", sentenceDetailCopy(detail));
    case "closeWorkspace":
      return copyRow(
        "The name you typed does not match.",
        "Type the workspace label exactly as shown, then close it.",
      );
    case "broadcastWorkspace":
      return copyRow("That broadcast cannot be sent.", sentenceDetailCopy(detail));
    case "joinChannel":
    case "acknowledge":
    case "listChannels":
    case "listDirect":
    case "listMessages":
    case "listMembers":
    case "listModels":
    case "listLaunchers":
    case "listHarnesses":
    case "listParticipants":
    case "listReceipts":
    case "listRoles":
    case "readRole":
    case "context":
    case "inbox":
    case "attachmentContent":
    case "listWorkspaces":
    case "createWorkspace":
    case "removeMember":
    case "spawnAgent":
      return genericCopy(detail);
  }
}

function notFoundCopy(
  operation: Operation,
  detail: string | undefined,
  value: string | undefined,
): CopyRow {
  switch (operation) {
    case "addMember":
      return copyRow(
        `No participant has the handle "${valueCopy(value)}".`,
        `Provision the agent first with \`msgr provision ${valueCopy(value)}\`.`,
      );
    case "removeMember":
      return copyRow(`${valueCopy(value)} is not a member of this channel.`, undefined);
    case "deactivateParticipant":
      return copyRow(`No active participant has the handle "${valueCopy(value)}".`, undefined);
    case "attachmentContent":
      return copyRow(
        "This file changed after it was sent.",
        "The preview is pinned to the file as sent. Ask the sender to send it again.",
      );
    case "context":
      return copyRow("That message is no longer in this channel.", "Search again to get a current result.");
    case "joinChannel":
    case "acknowledge":
    case "listChannels":
    case "listDirect":
    case "listMessages":
    case "listMembers":
    case "listModels":
    case "refreshModels":
    case "listLaunchers":
    case "listHarnesses":
    case "listParticipants":
    case "listReceipts":
    case "listRoles":
    case "createRole":
    case "readRole":
    case "updateRole":
    case "updateRoleRuntime":
    case "inbox":
    case "createChannel":
    case "createDirect":
    case "createHuman":
    case "createAgent":
    case "sendMessage":
    case "search":
    case "uploadFile":
    case "listWorkspaces":
    case "createWorkspace":
    case "closeWorkspace":
    case "broadcastWorkspace":
    case "spawnAgent":
      return copyRow("That is not on this hub.", detailCopy(detail));
  }
}

function paneFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const marker = "while starting pane ";
  const markerIndex = detail.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const pane = detail.slice(markerIndex + marker.length).trim();
  return pane.length === 0 ? undefined : pane;
}

function cleanupPaneFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const marker = "while cleaning up pane ";
  const markerIndex = detail.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const pane = detail.slice(markerIndex + marker.length).split(";")[0]?.trim() ?? "";
  return pane.length === 0 ? undefined : pane;
}

function spawnFailureCopy(detail: string | undefined): CopyRow {
  if (detail?.includes("cleanup state is unresolved") === true) {
    const pane = cleanupPaneFromDetail(detail);
    return pane === undefined
      ? copyRow(
          "The spawn failed and cleanup is unresolved.",
          "The pane state is unknown. Check for a leftover pane before you retry.",
        )
      : copyRow(
          "The spawn failed and cleanup is unresolved.",
          `Pane ${valueCopy(pane)} may still be open. Check it before you retry.`,
        );
  }
  const pane = paneFromDetail(detail);
  if (detail?.includes("timed out while starting pane ") === true && pane !== undefined) {
    return copyRow(
      "herdr did not answer in time while starting the agent.",
      `Pane ${valueCopy(pane)} was opened first. If no agent appears in it, close it. Do not retry until the pane is resolved.`,
    );
  }
  if (pane !== undefined) {
    return copyRow(
      "herdr could not confirm the spawn.",
      `Pane ${valueCopy(pane)} was opened first. Inspect it and close it if no agent appears.`,
    );
  }
  return copyRow("The spawn failed.", "Nothing was created. The pane from the partial spawn was closed.");
}

function workspaceNotFoundCopy(): CopyRow {
  return copyRow("That workspace is no longer open.", "Reload the workspace list.");
}

export function operatorMessage(input: FailureCopyInput, audience: Audience): OperatorMessage {
  switch (input.cause) {
    case "Unreachable":
      return forAudience(copyRow("The hub is not answering.", "Start it with `msgr serve`, then retry."), audience);
    case "Undecodable":
      return forAudience(
        copyRow(
          "The hub sent a reply this app does not understand.",
          "The hub and this page are probably different versions. Reload the page.",
          "This `msgr` build and the hub are different versions. Update `msgr`, or restart the hub.",
          "The hub sent a reply this build does not understand.",
        ),
        audience,
      );
    case "Unclassified":
      return forAudience(genericCopy(input.detail), audience);
    case "Unauthorized":
      if (
        input.operation === "createRole" ||
        input.operation === "readRole" ||
        input.operation === "updateRole" ||
        input.operation === "updateRoleRuntime"
      ) {
        return forAudience(
          copyRow(
            "Your session has expired.",
            "Introduce yourself again to manage role presets.",
            "Restart Sheppard, then retry.",
            "The local Sheppard control credential was rejected.",
          ),
          audience,
        );
      }
      return forAudience(
        copyRow(
          "Your session has expired.",
          "Introduce yourself again to post and track unread.",
          "The token in `MSGR_TOKEN` is not a valid identity. Tokens are issued once and cannot be reissued; if it is lost, provision a new handle.",
          "Your token was rejected.",
        ),
        audience,
      );
    case "RequestRejected":
      return forAudience(
        copyRow(
          "This page was not served by the hub.",
          "Open Sheppard from the hub address, `127.0.0.1:6747`.",
          "The hub refused this request's headers. Check that `MSGR_URL` points at the hub.",
          "The hub rejected this request.",
        ),
        audience,
      );
    case "HerdrSessionMismatch":
      return forAudience(
        copyRow("This hub belongs to another herdr session.", "Use the hub started by the session you are working in."),
        audience,
      );
    case "DirectMembershipLocked":
      return forAudience(copyRow("A direct conversation has fixed members.", "Create a channel if you need to add people."), audience);
    case "ValidationFailed":
      return forAudience(validationCopy(input.operation, input.detail), audience);
    case "NotAMember":
      return forAudience(
        copyRow("You have not joined this channel.", "Join it to track unread and post.", `Run: \`msgr join ${valueCopy(input.value)}\``),
        audience,
      );
    case "NotFound":
      if (input.operation === "closeWorkspace" || input.operation === "broadcastWorkspace") {
        return forAudience(workspaceNotFoundCopy(), audience);
      }
      return forAudience(notFoundCopy(input.operation, input.detail, input.value), audience);
    case "ChannelNotFound":
      return forAudience(
        copyRow(`There is no channel named "${valueCopy(input.value)}".`, "It may have been created on another hub."),
        audience,
      );
    case "HandleTaken":
      return forAudience(copyRow(`The name "${valueCopy(input.value)}" is taken.`, "Pick another name."), audience);
    case "ChannelExists":
      return forAudience(
        copyRow(
          `A channel named "${valueCopy(input.value)}" already exists.`,
          "Open it from the sidebar, or pick another name.",
          `Use it: \`msgr send ${valueCopy(input.value)} <text>\``,
        ),
        audience,
      );
    case "MembershipExists":
      return forAudience(copyRow(`${valueCopy(input.value)} is already a member.`, undefined), audience);
    case "RoleExists":
      return forAudience(
        copyRow(
          `A role named "${valueCopy(input.value)}" already exists.`,
          "Use another name, or update the existing role.",
        ),
        audience,
      );
    case "NotPreviewable":
      return forAudience(
        copyRow("This file type has no preview.", "Copy the path and open it in your editor.", "Read the file at its path directly."),
        audience,
      );
    case "UploadStorageFailed":
      return forAudience(copyRow("The hub could not store that file.", "Check free space, then retry."), audience);
    case "HerdrNotConfigured":
      return forAudience(
        copyRow("This hub is not attached to herdr.", "Workspaces are unavailable. Restart the hub from inside herdr to control panes."),
        audience,
      );
    case "HerdrCallFailed":
      return forAudience(
        input.operation === "spawnAgent"
          ? spawnFailureCopy(input.detail)
          : copyRow("herdr did not answer in time.", "Retry. Channels and messages are unaffected."),
        audience,
      );
    case "HerdrUnavailable":
      return forAudience(copyRow("herdr is not answering.", "Workspaces are unavailable. Channels and messages are unaffected."), audience);
  }
}
