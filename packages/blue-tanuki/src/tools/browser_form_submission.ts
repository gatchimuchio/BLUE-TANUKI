import { createHash } from "node:crypto";

export interface BrowserFormGetField {
  name: string;
  value: string;
}

export interface BrowserFormGetArguments {
  action: "form_submit";
  url: string;
  action_url: string;
  form_name: string;
  fields: readonly BrowserFormGetField[];
  input_receipt_digest?: string;
  expected_form_state_digest?: string;
  max_chars?: number;
  timeout_ms?: number;
}

export interface BrowserFormInputArguments extends Omit<BrowserFormGetArguments, "action"> {
  action: "form_fill";
}

export interface BrowserLinkNavigationArguments {
  action: "click";
  url: string;
  link_name: string;
  target_url: string;
  max_chars?: number;
  timeout_ms?: number;
}

export interface BrowserDownloadArguments {
  action: "download";
  url: string;
  link_name: string;
  target_url: string;
  max_bytes?: number;
  max_chars?: number;
  timeout_ms?: number;
}

export interface BrowserSearchFormControlSnapshot {
  tag: string;
  type: string;
  name: string;
  disabled: boolean;
  required: boolean;
  read_only: boolean;
  min_length: number;
  max_length: number;
  has_pattern: boolean;
  autocomplete: string;
  has_formaction: boolean;
  has_formmethod: boolean;
  has_formenctype: boolean;
  has_formtarget: boolean;
  has_formnovalidate: boolean;
  dirname: string;
}

export interface BrowserSearchFormSnapshot {
  method: string;
  action: string;
  target: string;
  enctype: string;
  accept_charset: string;
  controls: readonly BrowserSearchFormControlSnapshot[];
  control_count: number;
  form_count: number;
  form_markup?: string;
}

const MAX_BROWSER_FORM_FIELDS = 10;
const MAX_BROWSER_FORM_VALUE_BYTES = 4_096;
const MAX_BROWSER_FORM_URL_LENGTH = 4_096;
const MAX_BROWSER_FORM_MARKUP_BYTES = 131_072;
const BROWSER_FORM_INPUT_RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_BROWSER_FORM_INPUT_RECEIPTS = 256;
const SECRET_LIKE_FIELD_NAME = /(password|passcode|token|secret|credential|cookie|session|auth|csrf|nonce|api[_-]?key|otp|one[_-]?time[_-]?code)/i;
export const BROWSER_SEARCH_FORM_EDITABLE_INPUT_TYPES = [
  "text", "search", "email", "url", "tel", "number", "date", "time", "month", "week", "datetime-local",
] as const;
const browserSearchFormEditableInputTypes = new Set<string>(BROWSER_SEARCH_FORM_EDITABLE_INPUT_TYPES);

export interface BrowserFormInputStageReceipt {
  receipt_digest: string;
  request_digest: string;
  form_state_digest: string;
  request_id_digest: string;
  actor_digest: string;
  expires_at_ms: number;
  reserved_command_id?: string;
}

const browserFormInputStageReceipts = new Map<string, BrowserFormInputStageReceipt>();

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function pruneBrowserFormInputStageReceipts(nowMs: number): void {
  for (const [key, receipt] of browserFormInputStageReceipts) {
    if (receipt.expires_at_ms <= nowMs) browserFormInputStageReceipts.delete(key);
  }
  while (browserFormInputStageReceipts.size >= MAX_BROWSER_FORM_INPUT_RECEIPTS) {
    const oldest = browserFormInputStageReceipts.keys().next().value as string | undefined;
    if (!oldest) break;
    browserFormInputStageReceipts.delete(oldest);
  }
}

/** Store only digests after an owner-approved form_fill successfully returned. */
export function recordBrowserFormInputStageReceipt(input: {
  input_command_id: string;
  input_command_digest: string;
  input_review_digest: string;
  request_digest: string;
  form_state_digest: string;
  request_id_digest: string;
  actor_digest: string;
  now_ms?: number;
}): BrowserFormInputStageReceipt {
  const nowMs = input.now_ms ?? Date.now();
  if (!input.input_command_id || !isSha256(input.input_command_digest) || !isSha256(input.input_review_digest) ||
      !isSha256(input.request_digest) || !isSha256(input.form_state_digest) ||
      !isSha256(input.request_id_digest) || !isSha256(input.actor_digest) || !Number.isSafeInteger(nowMs)) {
    throw new Error("browser_form_input_receipt_invalid");
  }
  pruneBrowserFormInputStageReceipts(nowMs);
  const receiptDigest = createHash("sha256").update(JSON.stringify({
    schema_version: "browser-form-input-stage-receipt.v1",
    input_command_id: input.input_command_id,
    input_command_digest: input.input_command_digest,
    input_review_digest: input.input_review_digest,
    request_digest: input.request_digest,
    form_state_digest: input.form_state_digest,
    request_id_digest: input.request_id_digest,
    actor_digest: input.actor_digest,
    created_at_ms: nowMs,
  }), "utf8").digest("hex");
  const receipt: BrowserFormInputStageReceipt = {
    receipt_digest: receiptDigest,
    request_digest: input.request_digest,
    form_state_digest: input.form_state_digest,
    request_id_digest: input.request_id_digest,
    actor_digest: input.actor_digest,
    expires_at_ms: nowMs + BROWSER_FORM_INPUT_RECEIPT_TTL_MS,
  };
  browserFormInputStageReceipts.set(receiptDigest, receipt);
  return { ...receipt };
}

/** Reserve a staged input for a single final-submit command; this never authorizes execution. */
export function inspectBrowserFormInputStageReceipt(input: {
  receipt_digest: string;
  request_digest: string;
  form_state_digest: string;
  request_id_digest: string;
  actor_digest: string;
  command_id?: string;
  reserve?: boolean;
  now_ms?: number;
}): BrowserFormInputStageReceipt | null {
  const nowMs = input.now_ms ?? Date.now();
  pruneBrowserFormInputStageReceipts(nowMs);
  if (!isSha256(input.receipt_digest) || !isSha256(input.request_digest) || !isSha256(input.form_state_digest) ||
      !isSha256(input.request_id_digest) || !isSha256(input.actor_digest)) return null;
  const current = browserFormInputStageReceipts.get(input.receipt_digest);
  if (!current || current.request_digest !== input.request_digest || current.form_state_digest !== input.form_state_digest ||
      current.request_id_digest !== input.request_id_digest || current.actor_digest !== input.actor_digest ||
      (current.reserved_command_id && current.reserved_command_id !== input.command_id)) return null;
  if (input.reserve) {
    if (!input.command_id) return null;
    current.reserved_command_id = input.command_id;
  }
  return { ...current };
}

/** Consume a staged input exactly once immediately before the final request is attempted. */
export function consumeBrowserFormInputStageReceipt(input: {
  receipt_digest: string;
  request_digest: string;
  form_state_digest: string;
  request_id_digest: string;
  actor_digest: string;
  command_id: string;
  now_ms?: number;
}): boolean {
  const receipt = inspectBrowserFormInputStageReceipt(input);
  if (!receipt || (receipt.reserved_command_id && receipt.reserved_command_id !== input.command_id)) return false;
  browserFormInputStageReceipts.delete(input.receipt_digest);
  return true;
}

export function browserFormInputRequestDigest(input: Pick<BrowserFormGetArguments, "url" | "action_url" | "form_name" | "fields">): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: "browser-form-input-request.v1",
    url: input.url,
    action_url: input.action_url,
    form_name: input.form_name,
    fields: input.fields.map((field) => ({ name: field.name, value: field.value })),
  }), "utf8").digest("hex");
}

export function browserFormStateDigest(form: BrowserSearchFormSnapshot): string {
  if (!form || typeof form.form_markup !== "string" || form.form_markup.length === 0 ||
      new TextEncoder().encode(form.form_markup).byteLength > MAX_BROWSER_FORM_MARKUP_BYTES) {
    throw new Error("browser_form_get_markup_unavailable");
  }
  return createHash("sha256").update(form.form_markup, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validFieldName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_.\[\]-]*$/.test(value) &&
    !SECRET_LIKE_FIELD_NAME.test(value);
}

function safeHttpUrl(value: string, code: string, requireNoQuery: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
      url.href.length > 2_048 || (requireNoQuery && (url.search || url.hash))) {
    throw new Error(code);
  }
  return url;
}

export function parseBrowserFormGetArguments(value: unknown): BrowserFormGetArguments {
  if (!isRecord(value) || value.action !== "form_submit" ||
      Object.keys(value).some((key) => !["action", "url", "action_url", "form_name", "fields", "input_receipt_digest",
        "expected_form_state_digest", "max_chars", "timeout_ms"].includes(key)) ||
      typeof value.url !== "string" || typeof value.action_url !== "string" ||
      typeof value.form_name !== "string" || !Array.isArray(value.fields)) {
    throw new Error("browser_form_get_invalid_arguments");
  }
  const url = safeHttpUrl(value.url, "browser_form_get_invalid_url", true);
  const actionUrl = safeHttpUrl(value.action_url, "browser_form_get_invalid_action_url", true);
  if (actionUrl.origin !== url.origin) throw new Error("browser_form_get_cross_origin_denied");
  const formName = value.form_name.trim();
  if (formName.length === 0 || formName.length > 200 || /[\u0000-\u001f\u007f]/.test(formName) || hasUnpairedSurrogate(formName) ||
      value.fields.length === 0 || value.fields.length > MAX_BROWSER_FORM_FIELDS) {
    throw new Error("browser_form_get_invalid_arguments");
  }

  const fields: BrowserFormGetField[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const rawField of value.fields) {
    if (!isRecord(rawField) || Object.keys(rawField).some((key) => key !== "name" && key !== "value") ||
        typeof rawField.name !== "string" || typeof rawField.value !== "string") {
      throw new Error("browser_form_get_invalid_arguments");
    }
    const name = rawField.name.trim();
    const fieldValue = rawField.value;
    if (!validFieldName(name) || names.has(name) || fieldValue.length === 0 || fieldValue.length > 1_024 ||
        /[\u0000-\u001f\u007f]/.test(fieldValue) || hasUnpairedSurrogate(fieldValue)) {
      throw new Error("browser_form_get_invalid_arguments");
    }
    names.add(name);
    fields.push({ name, value: fieldValue });
    totalBytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(fieldValue).byteLength;
  }
  if (totalBytes > MAX_BROWSER_FORM_VALUE_BYTES ||
      (value.input_receipt_digest !== undefined && !isSha256(value.input_receipt_digest)) ||
      (value.expected_form_state_digest !== undefined && !isSha256(value.expected_form_state_digest)) ||
      ((value.input_receipt_digest === undefined) !== (value.expected_form_state_digest === undefined)) ||
      (value.max_chars !== undefined && (typeof value.max_chars !== "number" ||
        !Number.isSafeInteger(value.max_chars) || value.max_chars < 1 || value.max_chars > 20_000)) ||
      (value.timeout_ms !== undefined && (typeof value.timeout_ms !== "number" ||
        !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 15_000))) {
    throw new Error("browser_form_get_invalid_arguments");
  }

  return {
    action: "form_submit",
    url: url.href,
    action_url: actionUrl.href,
    form_name: formName,
    fields,
    ...(value.input_receipt_digest === undefined ? {} : { input_receipt_digest: value.input_receipt_digest as string }),
    ...(value.expected_form_state_digest === undefined ? {} : { expected_form_state_digest: value.expected_form_state_digest as string }),
    ...(value.max_chars === undefined ? {} : { max_chars: value.max_chars as number }),
    ...(value.timeout_ms === undefined ? {} : { timeout_ms: value.timeout_ms as number }),
  };
}

export function parseBrowserFormInputArguments(value: unknown): BrowserFormInputArguments {
  if (!isRecord(value) || value.action !== "form_fill" || value.input_receipt_digest !== undefined ||
      value.expected_form_state_digest !== undefined) {
    throw new Error("browser_form_input_invalid_arguments");
  }
  const parsed = parseBrowserFormGetArguments({ ...value, action: "form_submit" });
  const { action: _action, ...rest } = parsed;
  return { ...rest, action: "form_fill" };
}

/** Bind a link navigation to the exact same-origin destination shown for L3 review. */
export function parseBrowserLinkNavigationArguments(value: unknown): BrowserLinkNavigationArguments {
  if (!isRecord(value) || value.action !== "click" ||
      Object.keys(value).some((key) => !["action", "url", "link_name", "target_url", "max_chars", "timeout_ms"].includes(key)) ||
      typeof value.url !== "string" || typeof value.link_name !== "string" || typeof value.target_url !== "string") {
    throw new Error("browser_link_navigation_invalid_arguments");
  }
  const url = safeHttpUrl(value.url, "browser_link_navigation_invalid_url", true);
  const targetUrl = safeHttpUrl(value.target_url, "browser_link_navigation_invalid_target_url", true);
  if (targetUrl.origin !== url.origin) throw new Error("browser_link_navigation_cross_origin_denied");
  const linkName = value.link_name.trim();
  if (linkName.length === 0 || linkName.length > 200 || /[\u0000-\u001f\u007f]/.test(linkName) ||
      hasUnpairedSurrogate(linkName) ||
      (value.max_chars !== undefined && (typeof value.max_chars !== "number" ||
        !Number.isSafeInteger(value.max_chars) || value.max_chars < 1 || value.max_chars > 20_000)) ||
      (value.timeout_ms !== undefined && (typeof value.timeout_ms !== "number" ||
        !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 15_000))) {
    throw new Error("browser_link_navigation_invalid_arguments");
  }
  return {
    action: "click",
    url: url.href,
    link_name: linkName,
    target_url: targetUrl.href,
    ...(value.max_chars === undefined ? {} : { max_chars: value.max_chars as number }),
    ...(value.timeout_ms === undefined ? {} : { timeout_ms: value.timeout_ms as number }),
  };
}

/** Bind a bounded in-memory text attachment read to the exact same-origin link shown for L3 review. */
export function parseBrowserDownloadArguments(value: unknown): BrowserDownloadArguments {
  if (!isRecord(value) || value.action !== "download" ||
      Object.keys(value).some((key) => !["action", "url", "link_name", "target_url", "max_bytes", "max_chars", "timeout_ms"].includes(key)) ||
      typeof value.max_bytes !== "undefined" && (typeof value.max_bytes !== "number" ||
        !Number.isSafeInteger(value.max_bytes) || value.max_bytes < 1 || value.max_bytes > 512_000)) {
    throw new Error("browser_download_invalid_arguments");
  }
  const parsed = parseBrowserLinkNavigationArguments({
    action: "click",
    url: value.url,
    link_name: value.link_name,
    target_url: value.target_url,
    ...(value.max_chars === undefined ? {} : { max_chars: value.max_chars }),
    ...(value.timeout_ms === undefined ? {} : { timeout_ms: value.timeout_ms }),
  });
  return {
    action: "download",
    url: parsed.url,
    link_name: parsed.link_name,
    target_url: parsed.target_url,
    ...(value.max_bytes === undefined ? {} : { max_bytes: value.max_bytes as number }),
    ...(parsed.max_chars === undefined ? {} : { max_chars: parsed.max_chars }),
    ...(parsed.timeout_ms === undefined ? {} : { timeout_ms: parsed.timeout_ms }),
  };
}

export function buildBrowserSearchFormGetUrl(input: {
  source_url: string;
  expected_action_url: string;
  form: BrowserSearchFormSnapshot;
  fields: readonly BrowserFormGetField[];
  expected_form_state_digest?: string;
}): URL {
  const sourceUrl = safeHttpUrl(input.source_url, "browser_form_get_invalid_source_url", true);
  const expectedActionUrl = safeHttpUrl(input.expected_action_url, "browser_form_get_invalid_action_url", true);
  if (expectedActionUrl.origin !== sourceUrl.origin) throw new Error("browser_form_get_cross_origin_denied");
  const form = input.form;
  const formStateDigest = typeof form.form_markup === "string" ? browserFormStateDigest(form) : undefined;
  if (input.expected_form_state_digest !== undefined &&
      (!isSha256(input.expected_form_state_digest) || input.expected_form_state_digest !== formStateDigest)) {
    throw new Error("browser_form_get_form_changed_after_input_review");
  }
  if (!form || form.form_count !== 1 || form.control_count < 1 || form.control_count > MAX_BROWSER_FORM_FIELDS + 3 ||
      !Array.isArray(form.controls) || form.controls.length !== form.control_count ||
      typeof form.action !== "string" || typeof form.method !== "string" || typeof form.target !== "string" ||
      typeof form.enctype !== "string" || typeof form.accept_charset !== "string") {
    throw new Error("browser_form_get_form_shape_unavailable");
  }
  const method = form.method.toLowerCase();
  const target = form.target.trim().toLowerCase();
  if (method !== "get" || (target !== "" && target !== "_self") ||
      form.enctype.toLowerCase() !== "application/x-www-form-urlencoded" ||
      (form.accept_charset.trim() !== "" && form.accept_charset.trim().toLowerCase() !== "utf-8")) {
    throw new Error("browser_form_get_form_contract_denied");
  }

  const actionUrl = safeHttpUrl(form.action, "browser_form_get_action_invalid", true);
  if (actionUrl.origin !== sourceUrl.origin) throw new Error("browser_form_get_cross_origin_denied");
  if (actionUrl.href !== expectedActionUrl.href) throw new Error("browser_form_get_action_changed");

  const inputNames = new Set<string>();
  const requiredNames = new Set<string>();
  const fieldLengths = new Map<string, { min: number; max: number }>();
  const fieldControls = new Map<string, { tag: string; type: string }>();
  for (const control of form.controls) {
    if (!control || typeof control.tag !== "string" || typeof control.type !== "string" ||
        typeof control.name !== "string" || typeof control.disabled !== "boolean" ||
        typeof control.required !== "boolean" || typeof control.read_only !== "boolean" ||
        !Number.isSafeInteger(control.min_length) || control.min_length < -1 ||
        !Number.isSafeInteger(control.max_length) || control.max_length < -1 ||
        typeof control.has_pattern !== "boolean" ||
        typeof control.autocomplete !== "string" || typeof control.has_formaction !== "boolean" ||
        typeof control.has_formmethod !== "boolean" || typeof control.has_formenctype !== "boolean" ||
        typeof control.has_formtarget !== "boolean" || typeof control.has_formnovalidate !== "boolean" ||
        typeof control.dirname !== "string" || control.has_formaction || control.has_formmethod ||
        control.has_formenctype || control.has_formtarget || control.has_formnovalidate ||
        control.dirname !== "" || control.disabled) {
      throw new Error("browser_form_get_control_shape_unavailable");
    }
    const tag = control.tag.toLowerCase();
    const type = control.type.toLowerCase();
    const editable = (tag === "input" && browserSearchFormEditableInputTypes.has(type)) ||
      (tag === "textarea" && type === "");
    if (editable) {
      const autocomplete = control.autocomplete.trim().toLowerCase();
      const typeSpecificAutocomplete = (type === "email" && autocomplete === "email") ||
        (type === "url" && autocomplete === "url") || (type === "tel" && autocomplete === "tel");
      if (!validFieldName(control.name) || inputNames.has(control.name) || control.read_only || control.has_pattern ||
          (!(["", "on", "off"].includes(autocomplete)) && !typeSpecificAutocomplete) ||
          /(?:password|one-time-code|current-password|new-password)/i.test(control.autocomplete)) {
        throw new Error("browser_form_get_control_denied");
      }
      inputNames.add(control.name);
      fieldLengths.set(control.name, { min: control.min_length, max: control.max_length });
      fieldControls.set(control.name, { tag, type });
      if (control.required) requiredNames.add(control.name);
      continue;
    }
    if ((tag === "button" || tag === "input") && type === "submit" && control.name.length === 0) continue;
    throw new Error("browser_form_get_control_denied");
  }
  if (inputNames.size === 0) throw new Error("browser_form_get_controls_missing");

  const requestedNames = new Set<string>();
  for (const field of input.fields) {
    const lengthConstraints = fieldLengths.get(field.name);
    const fieldControl = fieldControls.get(field.name);
    const hasLineBreakOrTab = /[\t\r\n]/.test(field.value);
    const hasForbiddenControl = fieldControl?.tag === "textarea"
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(field.value)
      : /[\u0000-\u001f\u007f]/.test(field.value);
    if (!validFieldName(field.name) || requestedNames.has(field.name) || !inputNames.has(field.name) ||
        !lengthConstraints || !fieldControl || (hasLineBreakOrTab && fieldControl.tag !== "textarea") ||
        field.value.length === 0 || field.value.length > 1_024 ||
        (lengthConstraints.min >= 0 && field.value.length < lengthConstraints.min) ||
        (lengthConstraints.max >= 0 && field.value.length > lengthConstraints.max) ||
        hasForbiddenControl || hasUnpairedSurrogate(field.value)) {
      throw new Error("browser_form_get_field_binding_denied");
    }
    requestedNames.add(field.name);
  }
  if ([...requiredNames].some((name) => !requestedNames.has(name))) {
    throw new Error("browser_form_get_required_field_missing");
  }

  const submissionUrl = new URL(actionUrl.href);
  for (const field of input.fields) {
    const fieldControl = fieldControls.get(field.name)!;
    const value = fieldControl.tag === "textarea"
      ? field.value.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")
      : field.value;
    submissionUrl.searchParams.append(field.name, value);
  }
  if (submissionUrl.href.length > MAX_BROWSER_FORM_URL_LENGTH) throw new Error("browser_form_get_url_too_large");
  return submissionUrl;
}
