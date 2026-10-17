import { gmailWriteRequestPayloadDigest } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import type {
  WebChatApprovalContentReview,
  WebChatApprovalContentReviewValidation,
} from "@blue-tanuki/channel-webchat";

const GMAIL_SEND_ARGUMENTS = new Set([
  "operation",
  "to",
  "cc",
  "bcc",
  "from",
  "subject",
  "body_text",
  "body",
  "max_bytes",
]);

export function isGmailMessageSendCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" &&
    command.payload.tool_name === "gmail.write" &&
    typeof command.payload.arguments.operation === "string" &&
    command.payload.arguments.operation.trim().toLowerCase() === "message.send";
}

/** Build a private, explicit-review projection of the exact effective Gmail request. */
export function projectGmailMessageSendContentReview(
  command: ExecuteCommand,
  commandDigest: string,
): WebChatApprovalContentReview | null {
  if (command.type !== "tool_call" || !isGmailMessageSendCommand(command) ||
      !/^[a-f0-9]{64}$/.test(commandDigest)) return null;
  const args = command.payload.arguments;
  if (Object.keys(args).some((key) => !GMAIL_SEND_ARGUMENTS.has(key))) return null;
  if (args.max_bytes !== undefined &&
      (typeof args.max_bytes !== "number" || !Number.isInteger(args.max_bytes) || args.max_bytes <= 0)) {
    return null;
  }

  const to = nonEmptyString(args.to);
  const subject = nonEmptyString(args.subject);
  if (!to || !subject) return null;
  const cc = nonEmptyString(args.cc);
  const bcc = nonEmptyString(args.bcc);
  const from = nonEmptyString(args.from);
  const preferredBody = nonEmptyString(args.body_text);
  const alternateBody = nonEmptyString(args.body);
  if (preferredBody && alternateBody) return null;
  const bodyText = preferredBody ?? alternateBody ?? "";

  try {
    return {
      command_id: command.id,
      command_digest: commandDigest,
      request_payload_digest: gmailWriteRequestPayloadDigest(args),
      operation: "gmail.write.message.send",
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(from ? { from } : {}),
      subject,
      body_text: bodyText,
      used_for_authority: false,
    };
  } catch {
    return null;
  }
}

export function validateGmailMessageSendContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  current: boolean,
  revealedDigest: string | undefined,
  submittedDigest: string | undefined,
): WebChatApprovalContentReviewValidation {
  if (!isGmailMessageSendCommand(command)) return "not_required";
  if (!current || !/^[a-f0-9]{64}$/.test(commandDigest)) return "stale";
  if (!projectGmailMessageSendContentReview(command, commandDigest)) return "unavailable";
  if (!revealedDigest || !submittedDigest) return "required";
  return revealedDigest === commandDigest && submittedDigest === commandDigest
    ? "valid"
    : "stale";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
