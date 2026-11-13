import { describe, expect, it } from "vitest";
import {
  buildBrowserSearchFormGetUrl,
  parseBrowserFormGetArguments,
  type BrowserSearchFormSnapshot,
} from "../src/tools/browser_form_submission.js";

const baseArguments = {
  action: "form_submit",
  url: "https://example.test/search",
  action_url: "https://example.test/search/results",
  form_name: "Site search",
  fields: [{ name: "q", value: "blue tanuki" }],
};

const searchForm: BrowserSearchFormSnapshot = {
  method: "get",
  action: "https://example.test/search/results",
  target: "_self",
  enctype: "application/x-www-form-urlencoded",
  accept_charset: "",
  control_count: 2,
  form_count: 1,
  controls: [
    { tag: "input", type: "search", name: "q", disabled: false, required: true,
      read_only: false, min_length: -1, max_length: -1, has_pattern: false,
      autocomplete: "off", has_formaction: false, has_formmethod: false, has_formenctype: false,
      has_formtarget: false, has_formnovalidate: false, dirname: "" },
    { tag: "button", type: "submit", name: "", disabled: false, required: false,
      read_only: false, min_length: -1, max_length: -1, has_pattern: false,
      autocomplete: "", has_formaction: false, has_formmethod: false, has_formenctype: false,
      has_formtarget: false, has_formnovalidate: false, dirname: "" },
  ],
};

describe("browser form GET contract", () => {
  it("parses a bounded request and binds the same-origin target", () => {
    expect(parseBrowserFormGetArguments(baseArguments)).toMatchObject({
      ...baseArguments,
      url: "https://example.test/search",
      action_url: "https://example.test/search/results",
    });
  });

  it("builds a URL only for the reviewed same-origin GET search form", () => {
    const url = buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: searchForm,
      fields: baseArguments.fields,
    });
    expect(url.href).toBe("https://example.test/search/results?q=blue+tanuki");
  });

  it.each([
    ["POST", { ...searchForm, method: "post" }],
    ["cross-origin action", { ...searchForm, action: "https://other.test/search" }],
    ["changed action", { ...searchForm, action: "https://example.test/account/delete" }],
    ["non-self target", { ...searchForm, target: "_blank" }],
    ["hidden control", { ...searchForm, control_count: 3,
      controls: [...searchForm.controls, { tag: "input", type: "hidden", name: "csrf", disabled: false,
        required: false, read_only: false, min_length: -1, max_length: -1, has_pattern: false,
        autocomplete: "", has_formaction: false }] }],
    ["form action override", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 1 ? { ...control, has_formaction: true } : control) }],
    ["form method override", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 1 ? { ...control, has_formmethod: true } : control) }],
    ["form encoding override", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 1 ? { ...control, has_formenctype: true } : control) }],
    ["form target override", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 1 ? { ...control, has_formtarget: true } : control) }],
    ["form validation override", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 1 ? { ...control, has_formnovalidate: true } : control) }],
    ["directionality field", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 0 ? { ...control, dirname: "q.dir" } : control) }],
    ["non-UTF-8 encoding", { ...searchForm, accept_charset: "ISO-8859-1" }],
    ["unsupported autocomplete", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 0 ? { ...control, autocomplete: "email" } : control) }],
    ["pattern constraint", { ...searchForm, controls: searchForm.controls.map((control, index) =>
      index === 0 ? { ...control, has_pattern: true } : control) }],
  ])("rejects %s forms", (_label, form) => {
    expect(() => buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: form as BrowserSearchFormSnapshot,
      fields: baseArguments.fields,
    })).toThrow();
  });

  it.each([
    ["cross-origin reviewed action", { ...baseArguments, action_url: "https://other.test/search" }],
    ["query in reviewed action", { ...baseArguments, action_url: "https://example.test/search?q=unsafe" }],
    ["credential field", { ...baseArguments, fields: [{ name: "authToken", value: "secret" }] }],
    ["duplicate field", { ...baseArguments, fields: [{ name: "q", value: "a" }, { name: "q", value: "b" }] }],
    ["control character", { ...baseArguments, fields: [{ name: "q", value: "line\nbreak" }] }],
  ])("rejects %s arguments", (_label, args) => {
    expect(() => parseBrowserFormGetArguments(args)).toThrow();
  });

  it("requires every named required field and all supplied fields to exist", () => {
    const form = { ...searchForm, controls: [
      ...searchForm.controls,
      { tag: "input", type: "text", name: "category", disabled: false, required: true,
        read_only: false, min_length: -1, max_length: -1, has_pattern: false,
        autocomplete: "off", has_formaction: false, has_formmethod: false, has_formenctype: false,
        has_formtarget: false, has_formnovalidate: false, dirname: "" },
    ], control_count: 3 };
    expect(() => buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form,
      fields: baseArguments.fields,
    })).toThrow(/required_field_missing/);
    expect(() => buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: searchForm,
      fields: [{ name: "missing", value: "x" }],
    })).toThrow(/field_binding_denied/);
  });

  it("enforces required HTML length limits before constructing a GET URL", () => {
    const constrained = {
      ...searchForm,
      controls: searchForm.controls.map((control, index) => index === 0
        ? { ...control, min_length: 3, max_length: 8 }
        : control),
    };
    expect(() => buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: constrained,
      fields: [{ name: "q", value: "xy" }],
    })).toThrow(/field_binding_denied/);
    expect(() => buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: constrained,
      fields: [{ name: "q", value: "blue tanuki" }],
    })).toThrow(/field_binding_denied/);
    expect(buildBrowserSearchFormGetUrl({
      source_url: baseArguments.url,
      expected_action_url: baseArguments.action_url,
      form: constrained,
      fields: [{ name: "q", value: "blue" }],
    }).searchParams.get("q")).toBe("blue");
  });
});
