import { createHash } from "node:crypto";
import {
  browserFormInputRequestDigest,
  gmailWriteRequestPayloadDigest,
  gmailWriteTargetIdentityDigest,
  parseBrowserFormInputArguments,
  parseBrowserFormGetArguments,
  parseBrowserLinkNavigationArguments,
  parseBrowserDownloadArguments,
} from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { normalizeGmailAddressList, type ExecuteCommand } from "@blue-tanuki/protocol";
import type {
  WebChatGmailMessageTrashContentReview,
  WebChatGmailMessageModifyContentReview,
  WebChatApprovalContentReview,
  WebChatApprovalContentReviewValidation,
  WebChatBrowserFormInputContentReview,
  WebChatBrowserFormGetContentReview,
  WebChatBrowserLinkNavigationContentReview,
} from "@blue-tanuki/channel-webchat";

const GMAIL_WRITE_ARGUMENTS = new Set([
  "operation",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "reply_to_message_id",
  "from",
  "subject",
  "body_text",
  "body",
  "attachments",
  "max_bytes",
]);

export function isBrowserFormGetReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "browser.automation" &&
    typeof command.payload.arguments.action === "string" &&
    command.payload.arguments.action.trim().toLowerCase() === "form_submit";
}

export function isBrowserFormInputReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "browser.automation" &&
    typeof command.payload.arguments.action === "string" &&
    command.payload.arguments.action.trim().toLowerCase() === "form_fill";
}

export function isBrowserLinkNavigationReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "browser.automation" &&
    typeof command.payload.arguments.action === "string" &&
    ["click", "download"].includes(command.payload.arguments.action.trim().toLowerCase());
}

export function projectBrowserFormInputContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  operationPlanBindingDigest: string,
): WebChatBrowserFormInputContentReview | null {
  if (!isBrowserFormInputReviewCommand(command) || command.type !== "tool_call" ||
      !/^[a-f0-9]{64}$/.test(commandDigest) || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) return null;
  try {
    const request = parseBrowserFormInputArguments(command.payload.arguments);
    const parsedUrl = new URL(request.url);
    const parsedActionUrl = new URL(request.action_url);
    if (parsedUrl.origin !== parsedActionUrl.origin) return null;
    const requestPayloadDigest = browserFormInputRequestDigest(request);
    const reviewDigest = operationPlanDigest({
      schema_version: "blue-tanuki.browser-form-input-review.v1",
      command_digest: commandDigest,
      request_payload_digest: requestPayloadDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      external_effect_class: "page_read_unclassified",
      input_effect: "ephemeral_dom_fill_only",
      final_submit: false,
    });
    return {
      kind: "browser_form_input",
      command_id: command.id,
      command_digest: commandDigest,
      review_digest: reviewDigest,
      request_payload_digest: requestPayloadDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      operation: "browser.automation.form_fill",
      url: `${parsedUrl.origin}${parsedUrl.pathname}`,
      action_url: request.action_url,
      origin: parsedUrl.origin,
      form_name: request.form_name,
      fields: request.fields.map((field) => ({ ...field })),
      source_method: "GET",
      input_effect: "ephemeral_dom_fill_only",
      external_effect_class: "page_read_unclassified",
      same_origin_only: true,
      javascript_enabled: false,
      credentials_reused: false,
      downloads_enabled: false,
      final_submit: false,
      no_store: true,
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return null;
  }
}

export function projectBrowserLinkNavigationContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  operationPlanBindingDigest: string,
): WebChatBrowserLinkNavigationContentReview | null {
  if (!isBrowserLinkNavigationReviewCommand(command) || command.type !== "tool_call" ||
      !/^[a-f0-9]{64}$/.test(commandDigest) || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) return null;
  try {
    const action = command.payload.arguments.action;
    if (typeof action !== "string") return null;
    const request = action.trim().toLowerCase() === "download"
      ? parseBrowserDownloadArguments(command.payload.arguments)
      : parseBrowserLinkNavigationArguments(command.payload.arguments);
    const parsedUrl = new URL(request.url);
    const parsedTargetUrl = new URL(request.target_url);
    const requestPayloadDigest = request.action === "download"
      ? operationPlanDigest({
          schema_version: "blue-tanuki.browser-link-download-request.v1",
          page_url: request.url,
          link_name: request.link_name,
          target_url: request.target_url,
          max_bytes: request.max_bytes ?? 64_000,
          max_chars: request.max_chars ?? 8_000,
          content_types: "text/plain, text/csv, JSON, XML",
          same_origin_only: true,
          redirects_allowed: false,
          content_returned_to_agent: true,
          saved_locally: false,
          used_for_authority: false,
          may_execute: false,
        })
      : operationPlanDigest({
          schema_version: "blue-tanuki.browser-link-navigation-request.v1",
          page_url: request.url,
          link_name: request.link_name,
          target_url: request.target_url,
        });
    const reviewBase = {
      kind: "browser_link_navigation" as const,
      command_id: command.id,
      command_digest: commandDigest,
      request_payload_digest: requestPayloadDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      operation: request.action === "download"
        ? "browser.automation.download" as const : "browser.automation.click" as const,
      action: request.action === "download"
        ? "download_text_attachment" as const : "navigate" as const,
      page_url: request.url,
      target_url: request.target_url,
      origin: parsedUrl.origin,
      link_name: request.link_name,
      method: "GET" as const,
      external_effect_class: request.action === "download"
        ? "download_read_unclassified" as const : "navigation_unclassified" as const,
      same_origin_only: true as const,
      javascript_enabled: false as const,
      credentials_reused: false as const,
      downloads_enabled: false as const,
      ...(request.action === "download" ? { download_mode: {
        content_types: "text/plain, text/csv, JSON, XML" as const,
        max_bytes: request.max_bytes ?? 64_000,
        max_chars: request.max_chars ?? 8_000,
        same_origin_only: true as const,
        redirects_allowed: false as const,
        content_returned_to_agent: true as const,
        saved_locally: false as const,
        used_for_authority: false as const,
        may_execute: false as const,
      } } : {}),
      no_store: true as const,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    if (parsedTargetUrl.origin !== parsedUrl.origin) return null;
    return {
      ...reviewBase,
      review_digest: operationPlanDigest({
        schema_version: request.action === "download" ? "blue-tanuki.browser-link-download-review.v1" :
          "blue-tanuki.browser-link-navigation-review.v1",
        command_digest: commandDigest,
        request_payload_digest: requestPayloadDigest,
        operation_plan_binding_digest: operationPlanBindingDigest,
        external_effect_class: request.action === "download" ? "download_read_unclassified" : "navigation_unclassified",
      }),
    };
  } catch {
    return null;
  }
}

export function projectBrowserFormGetContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  operationPlanBindingDigest: string,
): WebChatBrowserFormGetContentReview | null {
  if (!isBrowserFormGetReviewCommand(command) || command.type !== "tool_call" ||
      !/^[a-f0-9]{64}$/.test(commandDigest) || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) return null;
  try {
    const request = parseBrowserFormGetArguments(command.payload.arguments);
    const parsedUrl = new URL(request.url);
    const requestPayloadDigest = operationPlanDigest({
      schema_version: "blue-tanuki.browser-form-get-request.v1",
      url: request.url,
      action_url: request.action_url,
      form_name: request.form_name,
      fields: request.fields,
      input_receipt_digest: request.input_receipt_digest ?? null,
      expected_form_state_digest: request.expected_form_state_digest ?? null,
    });
    const reviewDigest = operationPlanDigest({
      schema_version: "blue-tanuki.browser-form-get-review.v2",
      command_digest: commandDigest,
      request_payload_digest: requestPayloadDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      external_effect_class: "form_submission_unclassified",
    });
    return {
      kind: "browser_form_get",
      command_id: command.id,
      command_digest: commandDigest,
      review_digest: reviewDigest,
      request_payload_digest: requestPayloadDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      operation: "browser.automation.form_get",
      url: `${parsedUrl.origin}${parsedUrl.pathname}`,
      action_url: request.action_url,
      origin: parsedUrl.origin,
      form_name: request.form_name,
      fields: request.fields.map((field) => ({ ...field })),
      ...(request.input_receipt_digest ? { input_receipt_digest: request.input_receipt_digest } : {}),
      ...(request.expected_form_state_digest ? { expected_form_state_digest: request.expected_form_state_digest } : {}),
      method: "GET",
      external_effect_class: "form_submission_unclassified",
      same_origin_only: true,
      javascript_enabled: false,
      credentials_reused: false,
      downloads_enabled: false,
      no_store: true,
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return null;
  }
}

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

export function isGmailMessageSendReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "gmail.write" &&
    typeof command.payload.arguments.operation === "string" &&
    command.payload.arguments.operation.trim().toLowerCase() === "message.send";
}

export function isGmailMessageTrashReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "gmail.write" &&
    typeof command.payload.arguments.operation === "string" &&
    command.payload.arguments.operation.trim().toLowerCase() === "message.trash";
}

export function projectGmailMessageTrashContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  snapshot: {
    kind: "gmail_message_trash";
    operation: "gmail.write.message.trash";
    account_email: string;
    message_id: string;
    thread_id: string;
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    date?: string;
    internal_date: string;
    size_estimate: number;
    label_ids: readonly string[];
    target_identity_digest: string;
    request_payload_digest: string;
    provider_state_digest: string;
    command_digest: string;
    review_digest: string;
    used_for_authority: false;
    may_execute: false;
  },
): WebChatGmailMessageTrashContentReview | null {
  if (!isGmailMessageTrashReviewCommand(command) || command.type !== "tool_call" ||
      !/^[a-f0-9]{64}$/.test(commandDigest)) return null;
  const args = command.payload.arguments;
  if (Object.keys(args).some((key) => !["operation", "message_id"].includes(key)) ||
      typeof args.message_id !== "string" || args.message_id !== snapshot.message_id ||
      snapshot.kind !== "gmail_message_trash" || snapshot.operation !== "gmail.write.message.trash" ||
      snapshot.command_digest !== commandDigest || snapshot.used_for_authority !== false || snapshot.may_execute !== false ||
      !snapshot.account_email.trim() || snapshot.account_email.length > 320 ||
      !snapshot.thread_id.trim() || snapshot.thread_id.length > 512 ||
      !/^[a-f0-9]{64}$/.test(snapshot.target_identity_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.request_payload_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.provider_state_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.review_digest) ||
      !/^\d{1,16}$/.test(snapshot.internal_date) || !Number.isSafeInteger(Number(snapshot.internal_date)) ||
      !Number.isSafeInteger(snapshot.size_estimate) || snapshot.size_estimate < 0 ||
      !Array.isArray(snapshot.label_ids) || snapshot.label_ids.length > 100 ||
      snapshot.label_ids.some((label) => typeof label !== "string" || !label.trim() || label.length > 256 ||
        /[\r\n\u0000-\u001f\u007f]/.test(label)) || snapshot.label_ids.includes("TRASH") ||
      [snapshot.account_email, snapshot.message_id, snapshot.thread_id, snapshot.from, snapshot.to,
        snapshot.cc, snapshot.subject, snapshot.date].some((value) => value !== undefined &&
          (typeof value !== "string" || value.length > 4_096 || /[\r\n\u0000-\u001f\u007f]/.test(value)))) return null;
  try {
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const targetIdentityDigest = gmailWriteTargetIdentityDigest(args);
    const expectedReviewDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-message-trash-review.v1",
      command_digest: commandDigest, target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest, provider_state_digest: snapshot.provider_state_digest });
    if (snapshot.request_payload_digest !== requestPayloadDigest ||
        snapshot.target_identity_digest !== targetIdentityDigest || snapshot.review_digest !== expectedReviewDigest) return null;
    return {
      kind: "gmail_message_trash",
      command_id: command.id,
      command_digest: commandDigest,
      review_digest: expectedReviewDigest,
      target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest,
      provider_state_digest: snapshot.provider_state_digest,
      operation: "gmail.write.message.trash",
      account_email: snapshot.account_email,
      message_id: snapshot.message_id,
      thread_id: snapshot.thread_id,
      ...(snapshot.from ? { from: snapshot.from } : {}),
      ...(snapshot.to ? { to: snapshot.to } : {}),
      ...(snapshot.cc ? { cc: snapshot.cc } : {}),
      ...(snapshot.subject ? { subject: snapshot.subject } : {}),
      ...(snapshot.date ? { date: snapshot.date } : {}),
      internal_date: snapshot.internal_date,
      size_estimate: snapshot.size_estimate,
      label_ids: [...snapshot.label_ids],
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return null;
  }
}

export function validateGmailMessageTrashContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  current: boolean,
  revealedDigest: string | undefined,
  submittedDigest: string | undefined,
  snapshot: Parameters<typeof projectGmailMessageTrashContentReview>[2],
): WebChatApprovalContentReviewValidation {
  if (!isGmailMessageTrashReviewCommand(command)) return "not_required";
  if (!current || !/^[a-f0-9]{64}$/.test(commandDigest)) return "stale";
  const projection = projectGmailMessageTrashContentReview(command, commandDigest, snapshot);
  if (!projection) return "unavailable";
  if (!revealedDigest || !submittedDigest) return "required";
  return revealedDigest === projection.review_digest && submittedDigest === projection.review_digest
    ? "valid" : "stale";
}

export function isGmailMessageModifyReviewCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "gmail.write" &&
    typeof command.payload.arguments.operation === "string" &&
    command.payload.arguments.operation.trim().toLowerCase() === "message.modify";
}

export function projectGmailMessageModifyContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  snapshot: {
    kind: "gmail_message_modify";
    operation: "gmail.write.message.modify";
    account_email: string;
    message_id: string;
    thread_id: string;
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    date?: string;
    current_labels: readonly { id: string; name: string; type: "system" | "user" }[];
    add_labels: readonly { id: string; name: string; type: "user" }[];
    remove_labels: readonly { id: string; name: string; type: "user" }[];
    target_identity_digest: string;
    request_payload_digest: string;
    provider_state_digest: string;
    command_digest: string;
    review_digest: string;
    used_for_authority: false;
    may_execute: false;
  },
): WebChatGmailMessageModifyContentReview | null {
  if (!isGmailMessageModifyReviewCommand(command) || command.type !== "tool_call" ||
      !/^[a-f0-9]{64}$/.test(commandDigest)) return null;
  const args = command.payload.arguments;
  const isLabel = (label: { id: string; name: string; type: "system" | "user" }, types: readonly string[]) =>
    !!label && typeof label.id === "string" && label.id.length > 0 && label.id.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(label.id) && typeof label.name === "string" && label.name.length > 0 &&
    label.name.length <= 512 && !/[\r\n\u0000-\u001f\u007f]/.test(label.name) && types.includes(label.type);
  if (Object.keys(args).some((key) => !["operation", "message_id", "add_label_ids", "remove_label_ids"].includes(key)) ||
      typeof args.message_id !== "string" || args.message_id !== snapshot.message_id ||
      snapshot.kind !== "gmail_message_modify" || snapshot.operation !== "gmail.write.message.modify" ||
      snapshot.command_digest !== commandDigest || snapshot.used_for_authority !== false || snapshot.may_execute !== false ||
      !snapshot.account_email.trim() || snapshot.account_email.length > 320 ||
      !snapshot.thread_id.trim() || snapshot.thread_id.length > 512 ||
      !/^[a-f0-9]{64}$/.test(snapshot.target_identity_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.request_payload_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.provider_state_digest) ||
      !/^[a-f0-9]{64}$/.test(snapshot.review_digest) ||
      !Array.isArray(snapshot.current_labels) || snapshot.current_labels.length > 100 ||
      !snapshot.current_labels.every((label) => isLabel(label, ["system", "user"])) ||
      !Array.isArray(snapshot.add_labels) || snapshot.add_labels.length > 20 ||
      !snapshot.add_labels.every((label) => isLabel(label, ["user"])) ||
      !Array.isArray(snapshot.remove_labels) || snapshot.remove_labels.length > 20 ||
      !snapshot.remove_labels.every((label) => isLabel(label, ["user"])) ||
      new Set(snapshot.current_labels.map((label) => label.id)).size !== snapshot.current_labels.length ||
      [snapshot.account_email, snapshot.message_id, snapshot.thread_id, snapshot.from, snapshot.to,
        snapshot.cc, snapshot.subject, snapshot.date].some((value) => value !== undefined &&
          (typeof value !== "string" || value.length > 4_096 || /[\r\n\u0000-\u001f\u007f]/.test(value)))) return null;
  try {
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const targetIdentityDigest = gmailWriteTargetIdentityDigest(args);
    const addIds = Array.isArray(args.add_label_ids) ? [...args.add_label_ids as string[]].sort() : [];
    const removeIds = Array.isArray(args.remove_label_ids) ? [...args.remove_label_ids as string[]].sort() : [];
    const expectedReviewDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-message-modify-review.v1",
      command_digest: commandDigest, target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest, provider_state_digest: snapshot.provider_state_digest });
    if (snapshot.request_payload_digest !== requestPayloadDigest ||
        snapshot.target_identity_digest !== targetIdentityDigest || snapshot.review_digest !== expectedReviewDigest ||
        JSON.stringify(snapshot.add_labels.map((label) => label.id).sort()) !== JSON.stringify(addIds) ||
        JSON.stringify(snapshot.remove_labels.map((label) => label.id).sort()) !== JSON.stringify(removeIds)) return null;
    return {
      kind: "gmail_message_modify",
      command_id: command.id,
      command_digest: commandDigest,
      review_digest: expectedReviewDigest,
      target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest,
      provider_state_digest: snapshot.provider_state_digest,
      operation: "gmail.write.message.modify",
      account_email: snapshot.account_email,
      message_id: snapshot.message_id,
      thread_id: snapshot.thread_id,
      ...(snapshot.from ? { from: snapshot.from } : {}),
      ...(snapshot.to ? { to: snapshot.to } : {}),
      ...(snapshot.cc ? { cc: snapshot.cc } : {}),
      ...(snapshot.subject ? { subject: snapshot.subject } : {}),
      ...(snapshot.date ? { date: snapshot.date } : {}),
      current_labels: [...snapshot.current_labels],
      add_labels: [...snapshot.add_labels],
      remove_labels: [...snapshot.remove_labels],
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return null;
  }
}

export function validateGmailMessageModifyContentReview(
  command: ExecuteCommand,
  commandDigest: string,
  current: boolean,
  revealedDigest: string | undefined,
  submittedDigest: string | undefined,
  snapshot: Parameters<typeof projectGmailMessageModifyContentReview>[2],
): WebChatApprovalContentReviewValidation {
  if (!isGmailMessageModifyReviewCommand(command)) return "not_required";
  if (!current || !/^[a-f0-9]{64}$/.test(commandDigest)) return "stale";
  const projection = projectGmailMessageModifyContentReview(command, commandDigest, snapshot);
  if (!projection) return "unavailable";
  if (!revealedDigest || !submittedDigest) return "required";
  return revealedDigest === projection.review_digest && submittedDigest === projection.review_digest
    ? "valid" : "stale";
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
    attachments?: readonly {
      filename: string;
      mime_type: string;
      size_bytes: number;
      content_sha256: string;
      used_for_authority: false;
    }[];
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
  const attachments = snapshot.attachments ?? [];
  let totalAttachmentBytes = 0;
  if (!Array.isArray(attachments) || attachments.length > 5 || attachments.some((attachment) => {
    if (!attachment || typeof attachment.filename !== "string" || !attachment.filename ||
        attachment.filename.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(attachment.filename) ||
        typeof attachment.mime_type !== "string" || attachment.mime_type.length > 200 ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mime_type) ||
        !Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 0 ||
        attachment.size_bytes > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(attachment.content_sha256) ||
        attachment.used_for_authority !== false) return true;
    totalAttachmentBytes += attachment.size_bytes;
    return totalAttachmentBytes > 8 * 1024 * 1024;
  })) return null;
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.gmail-draft-content-review.v2",
    command_digest: commandDigest,
    provider_state_digest: snapshot.provider_state_digest,
    provider_raw_digest: snapshot.provider_raw_digest,
    request_payload_digest: snapshot.request_payload_digest,
    attachments: attachments.map(({ filename, mime_type, size_bytes, content_sha256 }) => ({
      filename, mime_type, size_bytes, content_sha256,
    })),
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
    ...(attachments.length > 0 ? { attachments } : {}),
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
    account_email?: string;
    account_identity_digest?: string;
    attachments?: readonly { filename: string; mime_type: string; size_bytes: number; content_sha256: string;
      used_for_authority: false }[];
    reply_source?: { message_id: string; thread_id: string; from?: string; subject: string;
      provider_state_digest: string; used_for_authority: false };
    provider_state_digest?: string;
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
      account_email?: string;
      account_identity_digest?: string;
      attachments?: readonly { filename: string; mime_type: string; size_bytes: number; content_sha256: string;
        used_for_authority: false }[];
      reply_source?: { message_id: string; thread_id: string; from?: string; subject: string;
        provider_state_digest: string; used_for_authority: false };
      provider_state_digest?: string;
    } = {};
    if (operation === "message.send") {
      const accountEmail = verifiedSnapshot?.account_email;
      const accountIdentityDigest = verifiedSnapshot?.account_identity_digest;
      const providerStateDigest = verifiedSnapshot?.provider_state_digest;
      if (!verifiedSnapshot || verifiedSnapshot.kind !== "gmail_write_content" ||
          verifiedSnapshot.command_digest !== commandDigest ||
          verifiedSnapshot.request_payload_digest !== requestPayloadDigest ||
          verifiedSnapshot.used_for_authority !== false || verifiedSnapshot.may_execute !== false ||
          typeof accountEmail !== "string" || !accountEmail.trim() || accountEmail.length > 320 ||
          /[\r\n\u0000-\u001f\u007f]/.test(accountEmail) ||
          !/^[a-f0-9]{64}$/.test(accountIdentityDigest ?? "") || providerStateDigest !== accountIdentityDigest ||
          !/^[a-f0-9]{64}$/.test(verifiedSnapshot.review_digest)) return null;
      const expectedAccountIdentityDigest = createHash("sha256").update(accountEmail.trim().toLowerCase(), "utf8").digest("hex");
      const attachmentDigests = (verifiedSnapshot.attachments ?? []).map((attachment) => attachment.content_sha256);
      if (attachmentReferences.length === 0 && (verifiedSnapshot.attachments?.length ?? 0) !== 0) return null;
      const expectedReviewDigest = operationPlanDigest({
        schema_version: "blue-tanuki.gmail-message-send-content-review.v1",
        command_digest: commandDigest,
        target_identity_digest: gmailWriteTargetIdentityDigest(args),
        request_payload_digest: requestPayloadDigest,
        account_identity_digest: accountIdentityDigest,
        provider_state_digest: providerStateDigest,
        attachment_content_digests: attachmentDigests,
      });
      if (expectedAccountIdentityDigest !== accountIdentityDigest || verifiedSnapshot.review_digest !== expectedReviewDigest) return null;
      attachmentProjection = { kind: "gmail_write_content", review_digest: verifiedSnapshot.review_digest,
        account_email: accountEmail.trim(), account_identity_digest: accountIdentityDigest,
        provider_state_digest: providerStateDigest,
        ...(verifiedSnapshot.attachments && verifiedSnapshot.attachments.length > 0
          ? { attachments: verifiedSnapshot.attachments } : {}) };
    }
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
      attachmentProjection = { ...attachmentProjection, kind: "gmail_write_content",
        review_digest: verifiedSnapshot.review_digest, attachments: verifiedSnapshot.attachments };
    }
    const replySourceMessageId = args.reply_to_message_id;
    if (replySourceMessageId !== undefined) {
      const source = verifiedSnapshot?.reply_source;
      if (operation !== "draft.create" || typeof replySourceMessageId !== "string" || !source ||
          source.message_id !== replySourceMessageId || source.used_for_authority !== false ||
          source.provider_state_digest !== verifiedSnapshot.provider_state_digest ||
          !/^[A-Za-z0-9_-]{1,512}$/.test(source.thread_id) || typeof source.subject !== "string" ||
          source.subject !== subject || !/^[a-f0-9]{64}$/.test(source.provider_state_digest) ||
          !/^[a-f0-9]{64}$/.test(verifiedSnapshot.review_digest)) return null;
      attachmentProjection = {
        ...attachmentProjection,
        kind: "gmail_write_content",
        reply_source: source,
        provider_state_digest: source.provider_state_digest,
        review_digest: verifiedSnapshot.review_digest,
      };
    } else if (operation === "draft.create" &&
        (verifiedSnapshot?.reply_source !== undefined || verifiedSnapshot?.provider_state_digest !== undefined)) {
      return null;
    }
    return {
      command_id: command.id,
      command_digest: commandDigest,
      ...attachmentProjection,
      request_payload_digest: requestPayloadDigest,
      operation: operation === "draft.create" ? "gmail.write.draft.create" : "gmail.write.message.send",
      ...(attachmentProjection.account_email ? { account_email: attachmentProjection.account_email } : {}),
      ...(attachmentProjection.account_identity_digest ? { account_identity_digest: attachmentProjection.account_identity_digest } : {}),
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
