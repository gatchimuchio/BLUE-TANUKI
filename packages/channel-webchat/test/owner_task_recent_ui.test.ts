import { createHash, webcrypto } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import { renderControlCenterDocument } from "../src/control_center_document.js";
import { CONTROL_CENTER_SCRIPT } from "../src/control_center_script.js";

class UiElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  isConnected = true;
  children: UiElement[] = [];
  listeners = new Map<string, Array<() => void | Promise<void>>>();

  addEventListener(event: string, listener: () => void | Promise<void>) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  async fire(event: string) {
    for (const listener of this.listeners.get(event) ?? []) await listener();
  }
  add(node: UiElement) {
    this.children.push(node);
  }
  appendChild(node: UiElement) {
    this.add(node);
  }
  replaceChildren(...nodes: UiElement[]) {
    for (const node of this.children) node.isConnected = false;
    this.children = nodes;
  }
}

class UiOption extends UiElement {
  constructor(text: string, value: string) {
    super();
    this.textContent = text;
    this.value = value;
  }
}

function scriptBetween(from: string, to: string) {
  const start = CONTROL_CENTER_SCRIPT.indexOf(from);
  const end = CONTROL_CENTER_SCRIPT.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return CONTROL_CENTER_SCRIPT.slice(start, end);
}

describe("Control Center recent owner requests", () => {
  it("restores a recent request in a blank tab with owner-only read actions and discards stale reads", async () => {
    const requestId = "00000000-0000-4000-8000-000000000099";
    const legacyId = "00000000-0000-4000-8000-000000000001";
    const resultRef = "a".repeat(64);
    const content = "保存された工程結果";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const flags = { used_for_authority: false, may_execute: false };
    const recentBody = { submissions: [{ request_id: requestId, state: "handler_returned", created_at_ms: 0 }], ...flags };
    const statusBody = { found: true, request_id: requestId, state: "handler_returned",
      plan_steps: { status: "available", steps: [{ index: 1, status: "adapter_returned", feedback_status: "success",
        verification: "result_and_memory_confirmed", result_ref: resultRef }], ...flags },
      result: { status: "not_ready", ...flags } };
    const resultBody = { status: "available", result_ref: resultRef, content_sha256: contentHash, content, ...flags };
    const recentPath = "/owner/task-submissions/recent";
    const statusPath = "/owner/task-submission-status";
    const resultPath = "/owner/task-submission-result";
    const respond = (body: object, noStore = true) =>
      Response.json(body, noStore ? { headers: { "cache-control": "no-store" } } : undefined);

    const html = renderControlCenterDocument();
    expect(html).toContain('id="load-owner-task-recent" type="button">最近の依頼を読み込む');
    expect(html).toContain('id="owner-task-recent-request-id"');
    expect(html).toContain('id="check-owner-task-recent-status" type="button" hidden disabled');

    const nodes = new Map<string, UiElement>();
    function byId(id: string): UiElement {
      if (!nodes.has(id)) nodes.set(id, new UiElement());
      return nodes.get(id)!;
    }
    const browserWindow = new UiElement();
    const storedValues = new Map<string, string>();
    const storageWrites: Array<[string, string]> = [];
    const storage = { getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageWrites.push([key, value]); } };
    const calls: Array<{ path: string; options: RequestInit }> = [];
    const responses = new Map<string, Response | Promise<Response>>();
    const legacyCalls: object[] = [];
    const controls = new Script([
      scriptBetween("let ownerTaskSubmissionIdMemory = null;", "async function postOwnerTaskCompute("),
      scriptBetween("function ownerTaskSubmissionOutcomeSummary(", "function ownerTaskExecutionEvidenceSummary("),
      scriptBetween("function hasNoStore(", "function chatRoleForKind("),
      scriptBetween('byId("check-owner-task-status").addEventListener', 'byId("runtime-token").addEventListener'),
    ].join("\n") + "\n({ renderOwnerTaskStatusSubmissionIds, cancelOwnerTaskSubmission, ownerTaskStatusSubmissionId })").runInNewContext({
      AbortController, TextEncoder, crypto: webcrypto, byId, localStorage: storage, sessionStorage: storage, window: browserWindow,
      Option: UiOption, document: { createElement: () => new UiElement() },
      formatDate: (ms: number) => new Date(ms).toISOString(),
      isObject: (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value),
      authHeaders: (token: string) => ({ Authorization: "Bearer " + token }),
      fetch: async (path: string, options: RequestInit) => {
        calls.push({ path, options });
        const response = responses.get(path);
        if (!response) throw new Error("unexpected network path: " + path);
        responses.delete(path);
        return response;
      },
      postJson: async (_path: string, _token: string, body: object) => { legacyCalls.push(body); return { found: false }; },
    });

    controls.renderOwnerTaskStatusSubmissionIds();
    const token = byId("owner-task-token");
    const load = byId("load-owner-task-recent");
    const select = byId("owner-task-recent-request-id");
    const check = byId("check-owner-task-recent-status");
    const badge = byId("owner-task-status");
    const legacyCancel = byId("cancel-owner-task-submission");
    const actions = byId("owner-task-saved-result-actions");
    const saved = byId("owner-task-saved-result");
    expect(calls).toEqual([]);
    await load.fire("click");
    expect(calls).toEqual([]);

    token.value = "owner-token";
    responses.set(recentPath, respond(recentBody));
    await load.fire("click");
    expect(select.children[1]?.textContent).toBe("1970-01-01T00:00:00.000Z · 受付処理終了 · 000000000099");
    expect(select.value).toBe("");
    expect(check.disabled).toBe(true);
    expect(token.value).toBe("");

    select.value = requestId;
    await select.fire("change");
    expect(check.disabled).toBe(false);
    token.value = "owner-token";
    responses.set(statusPath, new Response("private-fixture", { headers: { "cache-control": "no-store" } }));
    await check.fire("click");
    expect(badge.textContent).toContain("依頼の受付記録を照会できませんでした");
    expect(badge.textContent).not.toContain("private-fixture");
    token.value = "owner-token";
    responses.set(statusPath, respond({ ...statusBody, request_id: legacyId }));
    await check.fire("click");
    expect(badge.textContent).toContain("応答内容が不正");
    expect(actions.children).toHaveLength(0);

    token.value = "owner-token";
    responses.set(statusPath, respond(statusBody));
    await check.fire("click");
    expect(badge.textContent).toContain("結果とM受領票を確認済み");
    expect(controls.ownerTaskStatusSubmissionId()).toBeNull();
    expect(byId("owner-task-new-submission").hidden).toBe(true);

    token.value = "owner-token";
    await token.fire("input");
    responses.set(resultPath, respond(resultBody));
    await actions.children[0]!.fire("click");
    expect(saved.textContent).toBe(content);
    expect(token.value).toBe("");
    expect(calls.map(({ path, options }) => [path, JSON.parse(String(options.body))])).toEqual([
      [recentPath, {}], [statusPath, { request_id: requestId }], [statusPath, { request_id: requestId }],
      [statusPath, { request_id: requestId }],
      [resultPath, { request_id: requestId, step_index: 1, result_ref: resultRef }],
    ]);
    for (const { options } of calls) {
      expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "error",
        headers: { Authorization: "Bearer owner-token" } });
    }

    storedValues.set("blue-tanuki.owner-task-status-submission-id.v1", legacyId);
    controls.renderOwnerTaskStatusSubmissionIds(legacyId);
    expect(byId("owner-task-status-submission-id").value).toBe(legacyId);
    expect(select.value).toBe(requestId);
    expect(legacyCancel.hidden).toBe(true);
    token.value = "owner-token";
    await controls.cancelOwnerTaskSubmission();
    expect(calls).toHaveLength(5);
    await byId("check-owner-task-status").fire("click");
    expect(legacyCancel.hidden).toBe(false);
    expect(select.value).toBe("");
    expect(legacyCalls).toEqual([{ submission_id: legacyId }]);
    expect(saved.hidden).toBe(true);
    expect(storageWrites).toEqual([]);

    token.value = "owner-token";
    responses.set(recentPath, respond(recentBody, false));
    await load.fire("click");
    expect(select.hidden).toBe(true);
    expect(select.children).toHaveLength(1);
    expect(byId("owner-task-recent-status").textContent).toContain("読み込めませんでした");

    token.value = "owner-token";
    let finish!: (response: Response) => void;
    responses.set(recentPath, new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = load.fire("click");
    await browserWindow.fire("pagehide");
    finish(respond(recentBody));
    await pending;
    expect(calls.at(-1)?.options.signal?.aborted).toBe(true);
    expect(select.hidden).toBe(true);
    expect(select.children).toHaveLength(1);
    expect(load.disabled).toBe(false);
    expect(token.value).toBe("");
    expect(storageWrites).toEqual([]);
  });
});
