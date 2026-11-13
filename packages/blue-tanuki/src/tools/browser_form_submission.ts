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
  max_chars?: number;
  timeout_ms?: number;
}

export interface BrowserLinkNavigationArguments {
  action: "click";
  url: string;
  link_name: string;
  target_url: string;
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
}

const MAX_BROWSER_FORM_FIELDS = 10;
const MAX_BROWSER_FORM_VALUE_BYTES = 4_096;
const MAX_BROWSER_FORM_URL_LENGTH = 4_096;
const SECRET_LIKE_FIELD_NAME = /(password|passcode|token|secret|credential|cookie|session|auth|csrf|nonce|api[_-]?key|otp|one[_-]?time[_-]?code)/i;

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
      Object.keys(value).some((key) => !["action", "url", "action_url", "form_name", "fields", "max_chars", "timeout_ms"].includes(key)) ||
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
    ...(value.max_chars === undefined ? {} : { max_chars: value.max_chars as number }),
    ...(value.timeout_ms === undefined ? {} : { timeout_ms: value.timeout_ms as number }),
  };
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

export function buildBrowserSearchFormGetUrl(input: {
  source_url: string;
  expected_action_url: string;
  form: BrowserSearchFormSnapshot;
  fields: readonly BrowserFormGetField[];
}): URL {
  const sourceUrl = safeHttpUrl(input.source_url, "browser_form_get_invalid_source_url", true);
  const expectedActionUrl = safeHttpUrl(input.expected_action_url, "browser_form_get_invalid_action_url", true);
  if (expectedActionUrl.origin !== sourceUrl.origin) throw new Error("browser_form_get_cross_origin_denied");
  const form = input.form;
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
    if (tag === "input" && (type === "text" || type === "search")) {
      if (!validFieldName(control.name) || inputNames.has(control.name) || control.read_only || control.has_pattern ||
          !["", "on", "off"].includes(control.autocomplete.trim().toLowerCase()) ||
          /(?:password|one-time-code|current-password|new-password)/i.test(control.autocomplete)) {
        throw new Error("browser_form_get_control_denied");
      }
      inputNames.add(control.name);
      fieldLengths.set(control.name, { min: control.min_length, max: control.max_length });
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
    if (!validFieldName(field.name) || requestedNames.has(field.name) || !inputNames.has(field.name) ||
        !lengthConstraints || field.value.length === 0 || field.value.length > 1_024 ||
        (lengthConstraints.min >= 0 && field.value.length < lengthConstraints.min) ||
        (lengthConstraints.max >= 0 && field.value.length > lengthConstraints.max) ||
        /[\u0000-\u001f\u007f]/.test(field.value) || hasUnpairedSurrogate(field.value)) {
      throw new Error("browser_form_get_field_binding_denied");
    }
    requestedNames.add(field.name);
  }
  if ([...requiredNames].some((name) => !requestedNames.has(name))) {
    throw new Error("browser_form_get_required_field_missing");
  }

  const submissionUrl = new URL(actionUrl.href);
  for (const field of input.fields) submissionUrl.searchParams.append(field.name, field.value);
  if (submissionUrl.href.length > MAX_BROWSER_FORM_URL_LENGTH) throw new Error("browser_form_get_url_too_large");
  return submissionUrl;
}
