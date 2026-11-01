import { gmailWriteRequestPayloadDigest } from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { normalizeGmailAddressList, type ExecuteCommand } from "@blue-tanuki/protocol";
import type {
  WebChatApprovalContentReview,
  WebChatApprovalContentReviewValidation,
} from "@blue-tanuki/channel-webchat";

const GMAIL_WRITE_ARGUMENTS = new Set([
  "operation",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "from",
  "subject",
  "body_text",
  "body",
  "attachments",
  "max_bytes",
]);

export function isGmailWriteContentReviewCommand(
  command: ExecuteCommand,
): boolean {
  if (command.type !== "tool_call" || command.payload.tool_name !== "gmail.write" ||
      typeof command.payload.arguments.operation !== "string") return false;
  const operation = command.payload.arguments.operation.trim().toLowerCase();
  return operation === "draft.create" || operation === "message.send";
}

export function isGmailDraftSendReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "gmail.write" &&
    typeof command.payload.arguments.operation === "string" &&
    command.payload.arguments.operation.trim().toLowerCase() === "draft.send";
}

/** Project only a supported provider snapshot; raw MIME and credentials stay inside the Gmail adapter. */
export function projectGmailDraftSendContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  snapshot: {
    account_email: string;
    from: string;
    to?: string;
    cc?: string;
    bcc?: string;
    reply_to?: string;
    subject: string;
    body_text: string;
    provider_state_digest: string;
    provider_raw_digest: string;
    request_payload_digest: string;
  },
): (WebChatApprovalContentReview & { operation: "gmail.write.draft.send" }) | null {
  if (!isGmailDraftSendReviewCommand(command) || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.provider_state_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.provider_raw_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.request_payload_digest) ||
      !snapshot.account_email || !snapshot.from || typeof snapshot.subject !== "string" ||
      typeof snapshot.body_text !== "string") return null;
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.gmail-draft-content-review.v1",
    command_digest: commandDigest,
    provider_state_digest: snapshot.provider_state_digest,
    request_payload_digest: snapshot.request_payload_digest,
  });
  return {
    kind: "gmail_write_content",
    command_id: command.id,
    command_digest: commandDigest,
    review_digest: reviewDigest,
    request_payload_digest: snapshot.request_payload_digest,
    provider_state_digest: snapshot.provider_state_digest,
    provider_raw_digest: snapshot.provider_raw_digest,
    account_email: snapshot.account_email,
    operation: "gmail.write.draft.send",
    from: snapshot.from,
    to: snapshot.to ?? "(no To header)",
    ...(snapshot.cc ? { cc: snapshot.cc } : {}),
    ...(snapshot.bcc ? { bcc: snapshot.bcc } : {}),
    ...(snapshot.reply_to ? { reply_to: snapshot.reply_to } : {}),
    subject: snapshot.subject,
    body_text: snapshot.body_text,
    used_for_authority: false,
  };
}

export function validateGmailDraftSendContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  current: boolean,
  revealedDigest: string | undefined,
  submittedDigest: string | undefined,
): WebChatApprovalContentReviewValidation {
  if (!isGmailDraftSendReviewCommand(command)) return "not_required";
  if (!current || !/^[a-f0-9]{64}$/.test(commandDigest)) return "stale";
  if (!revealedDigest || !submittedDigest) return "required";
  return /^[a-f0-9]{64}$/.test(revealedDigest) && submittedDigest === revealedDigest ? "valid" : "stale";
}

/** Build a private, explicit-review projection of the exact effective Gmail write request. */
export function projectGmailWriteContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  verifiedSnapshot?: {
    kind: "gmail_write_content";
    command_digest: string;
    request_payload_digest: string;
    review_digest: string;
    attachments?: readonly { filename: string; mime_type: string; size_bytes: number; content_sha256: string;
      used_for_authority: false }[];
    used_for_authority: false;
    may_execute: false;
  },
): (WebChatApprovalContentReview & {
  operation: "gmail.write.draft.create" | "gmail.write.message.send";
}) | null {
  if (command.type !== "tool_call" || !isGmailWriteContentReviewCommand(command) ||
      !/^[a-f0-9]{64}$/.test(commandDigest)) return null;
  const args = command.payload.arguments;
  if (Object.keys(args).some((key) => !GMAIL_WRITE_ARGUMENTS.has(key))) return null;
  if (args.max_bytes !== undefined &&
      (typeof args.max_bytes !== "number" || !Number.isInteger(args.max_bytes) || args.max_bytes <= 0)) {
    return null;
  }

  if (typeof args.operation !== "string") return null;
  const operation = args.operation.trim().toLowerCase() as "draft.create" | "message.send";
  const to = normalizeGmailAddressList(args.to);
  const subject = nonEmptyString(args.subject);
  if (!to || !subject) return null;
  const cc = args.cc === undefined ? undefined : normalizeGmailAddressList(args.cc);
  const bcc = args.bcc === undefined ? undefined : normalizeGmailAddressList(args.bcc);
  const replyTo = args.reply_to === undefined ? undefined : normalizeGmailAddressList(args.reply_to);
  if ((args.cc !== undefined && !cc) || (args.bcc !== undefined && !bcc) ||
      (args.reply_to !== undefined && !replyTo)) return null;
  const from = nonEmptyString(args.from);
  const preferredBody = nonEmptyString(args.body_text);
  const alternateBody = nonEmptyString(args.body);
  if (preferredBody && alternateBody) return null;
  const bodyText = preferredBody ?? alternateBody ?? "";

  try {
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const attachmentReferences = Array.isArray(args.attachments) ? args.attachments : [];
    let attachmentProjection: {
      kind?: "gmail_write_content";
      review_digest?: string;
      attachments?: readonly { filename: string; mime_type: string; size_bytes: number; content_sha256: string;
        used_for_authority: false }[];
    } = {};
    if (attachmentReferences.length > 0) {
      if (!verifiedSnapshot || verifiedSnapshot.kind !== "gmail_write_content" ||
          verifiedSnapshot.command_digest !== commandDigest || verifiedSnapshot.request_payload_digest !== requestPayloadDigest ||
          verifiedSnapshot.used_for_authority !== false || verifiedSnapshot.may_execute !== false ||
          !/^[a-f0-9]{64}$/.test(verifiedSnapshot.review_digest) ||
          !Array.isArray(verifiedSnapshot.attachments) || verifiedSnapshot.attachments.length !== attachmentReferences.length) return null;
      const refs = attachmentReferences as Record<string, unknown>[];
      const sameExactAttachments = verifiedSnapshot.attachments.every((attachment, index) => {
        const ref = refs[index];
        return ref && attachment.filename === ref.filename && attachment.mime_type === ref.mime_type &&
          attachment.size_bytes === ref.size_bytes && attachment.content_sha256 === ref.content_sha256 &&
          attachment.used_for_authority === false;
      });
      if (!sameExactAttachments) return null;
      attachmentProjection = { kind: "gmail_write_content", review_digest: verifiedSnapshot.review_digest,
        attachments: verifiedSnapshot.attachments };
    }
    return {
      command_id: command.id,
      command_digest: commandDigest,
      ...attachmentProjection,
      request_payload_digest: requestPayloadDigest,
      operation: operation === "draft.create" ? "gmail.write.draft.create" : "gmail.write.message.send",
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(from ? { from } : {}),
      subject,
      body_text: bodyText,
      used_for_authority: false,
    };
  } catch {
    return null;
  }
}

export function validateGmailWriteContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  current: boolean,
  revealedDigest: string | undefined,
  submittedDigest: string | undefined,
  verifiedSnapshot?: Parameters<typeof projectGmailWriteContentReview>[2],
): WebChatApprovalContentReviewValidation {
  if (!isGmailWriteContentReviewCommand(command)) return "not_required";
  if (!current || !/^[a-f0-9]{64}$/.test(commandDigest)) return "stale";
  const projection = projectGmailWriteContentReview(command, commandDigest, verifiedSnapshot);
  if (!projection) return "unavailable";
  if (!revealedDigest || !submittedDigest) return "required";
  const expectedDigest = projection.review_digest ?? commandDigest;
  return revealedDigest === expectedDigest && submittedDigest === expectedDigest
    ? "valid"
    : "stale";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
