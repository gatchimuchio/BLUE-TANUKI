import { createHash, webcrypto } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderControlCenterDocument } from "../src/control_center_document.js";
import { CONTROL_CENTER_SCRIPT } from "../src/control_center_script.js";

class UiElement {
  value = "";
  hidden = false;
  disabled = false;
  isConnected = true;
  textContent = "";
  children: UiElement[] = [];
  dataset: Record<string, string> = {};
  actions = new Map<string, () => unknown>();

  get selectedOptions() { return this.children.filter((option) => option.value === this.value); }
  add(node: UiElement) { this.children.push(node); }
  appendChild(node: UiElement) { this.add(node); }
  replaceChildren(...nodes: UiElement[]) { this.children = nodes; this.textContent = ""; this.value = ""; }
  addEventListener(event: string, action: () => unknown) { this.actions.set(event, action); }
  fire(event: string) { return this.actions.get(event)?.(); }
}

class UiOption extends UiElement {
  constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; }
}

function scriptBetween(first: string, last: string): string {
  const start = CONTROL_CENTER_SCRIPT.indexOf(first);
  const end = CONTROL_CENTER_SCRIPT.indexOf(last, start + first.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return CONTROL_CENTER_SCRIPT.slice(start, end);
}

function harness() {
  const elements = new Map<string, UiElement>();
  function byId(id: string) {
    if (!elements.has(id)) elements.set(id, new UiElement());
    return elements.get(id)!;
  }
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const responses = new Map<string, Response | Promise<Response>>();
  const context = {
    state: { approvalContentDigests: {} },
    byId,
    setText: (id: string, text: string) => { byId(id).textContent = text; },
    Option: UiOption,
    AbortController,
    crypto: webcrypto,
    TextEncoder,
    isObject: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    formatInterval: (value: number) => String(value) + " ms",
    hasNoStore: (response: Response) => response.headers.get("cache-control") === "no-store",
    isLocalCredentialControlCenter: () => true,
    authHeaders: (token: string) => ({ Authorization: "Bearer " + token }),
    fetch: async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      const reply = responses.get(path);
      responses.delete(path);
      if (!reply) throw new Error("unexpected path");
      return reply;
    },
  };
  return { byId, context, calls, responses };
}

const respond = (body: object, status = 200, noStore = true) =>
  Response.json(body, { status, ...(noStore ? { headers: { "cache-control": "no-store" } } : {}) });
const goalRef = "goal_0123456789abcdef";
const revision = "a".repeat(64);

describe("Control Center runtime schedule deletion", () => {
  it("makes a no-store owner proposal only for the explicitly selected current runtime row and purpose version", async () => {
    expect(() => new Script(CONTROL_CENTER_SCRIPT)).not.toThrow();
    const html = renderControlCenterDocument();
    expect(html).toContain('id="prepare-runtime-schedule-delete"');
    expect(html).toContain('id="runtime-schedule-delete-review-owner-token" type="password"');

    const { byId, context, calls, responses } = harness();
    const window = new UiElement();
    const ui = new Script([
      scriptBetween("function renderOwnerTaskGoalOptions(", "async function loadOwnerTaskGoals("),
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "async function submitDailyBriefRead("),
      scriptBetween('byId("runtime-schedule-delete-id").addEventListener', 'byId("hide-goal-purpose-repair-handoff").addEventListener'),
    ].join("\n") + "\n({ renderRuntimeScheduleDeleteOptions })").runInNewContext({ ...context, window });
    const row = { id: "local-reminder", origin: "runtime", status: "active", enabled: true, time: "08:20",
      time_zone: "Asia/Tokyo", delete_revision_digest: revision };
    ui.renderRuntimeScheduleDeleteOptions([
      row, { ...row, id: "boot-row", origin: "boot" }, { ...row, id: "disabled", enabled: false },
      { ...row, id: "already-pending", pending_operation: "update" },
    ]);
    const schedules = byId("runtime-schedule-delete-id");
    const goals = byId("runtime-schedule-delete-goal");
    const credential = byId("runtime-schedule-delete-owner-token");
    const proposal = byId("prepare-runtime-schedule-delete");
    const next = byId("open-runtime-schedule-delete-plan");
    const status = byId("runtime-schedule-delete-status");
    const load = byId("load-runtime-schedule-delete-goals");
    expect(schedules.children.map((option) => option.value)).toEqual(["", row.id]);
    expect(proposal.disabled).toBe(true);
    expect(calls).toHaveLength(0);
    schedules.value = row.id;
    schedules.fire("change");
    credential.value = "owner-secret";
    responses.set("/owner/task-goals", respond({ goals: [{ goal_ref: goalRef, purpose_version: 2, purpose_preview: "予定を管理する" }] }));
    await load.fire("click");
    expect(calls[0]).toMatchObject({ path: "/owner/task-goals", options: { method: "GET", cache: "no-store",
      headers: { Authorization: "Bearer owner-secret" } } });
    expect(credential.value).toBe("");
    goals.value = goalRef;
    goals.fire("change");
    expect(proposal.disabled).toBe(false);
    await proposal.fire("click");
    expect(calls).toHaveLength(1);
    expect(status.textContent).toContain("owner token");

    const candidate = { accepted: true, status: "candidate_ready", request_id: "bounded-request",
      plan_id_digest: "b".repeat(64), used_for_authority: false, may_execute: false };
    const proposalPath = "/owner/runtime-schedule-delete-proposal";
    credential.value = "owner-secret";
    responses.set(proposalPath, respond(candidate, 202, false));
    await proposal.fire("click");
    expect(next.hidden).toBe(true);
    expect(status.textContent).toContain("受付を確認できません");

    credential.value = "owner-secret";
    responses.set(proposalPath, respond(candidate, 202));
    await proposal.fire("click");
    expect(calls.at(-1)).toMatchObject({ path: proposalPath, options: { method: "POST", cache: "no-store",
      mode: "same-origin", redirect: "error", headers: { Authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, expected_revision_digest: revision, goal_ref: goalRef, purpose_version: 2 }) } });
    expect(next.hidden).toBe(false);
    expect(credential.value).toBe("");
    expect(status.textContent).toContain("計画画面で目的との関係と削除対象を確認");
    expect(calls).toHaveLength(3);

    credential.value = "owner-secret";
    let release!: (response: Response) => void;
    responses.set(proposalPath, new Promise<Response>((resolve) => { release = resolve; }));
    const inFlight = proposal.fire("click");
    ui.renderRuntimeScheduleDeleteOptions([{ ...row, delete_revision_digest: "c".repeat(64) }]);
    expect(schedules.value).toBe("");
    release(respond(candidate, 202));
    await inFlight;
    expect(calls.at(-1)?.options.signal?.aborted).toBe(true);
    expect(next.hidden).toBe(true);
    expect(status.textContent).toContain("前の削除案の受付は未確認");
    window.fire("pagehide");
    expect(goals.children.map((option) => option.value)).toEqual([""]);
    expect(byId("runtime-schedule-delete-request").hidden).toBe(true);
  });

  it("requires both credentials and current exact no-store review before the ordinary approval verdict", async () => {
    const { byId, context, calls, responses } = harness();
    const content = new UiElement();
    const approve = new UiElement();
    const reviewButton = new UiElement();
    const commandId = "delete-sched";
    const card = {
      isConnected: true,
      getAttribute: (attribute: string) => attribute === "data-command" ? commandId
        : attribute === "data-runtime-schedule-delete" ? "" : null,
      querySelector: (selector: string) => selector === "[data-content-review-view]" ? content : approve,
    };
    const ui = new Script([
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "function currentRuntimeScheduleDeleteRow("),
      scriptBetween("function clearRuntimeScheduleDeleteReviews(", "async function requestTaskCancellation("),
      scriptBetween("async function renderRuntimeScheduleDeleteReview(", '        if ((card.getAttribute("data-goal-purpose-adoption")'),
      "}",
    ].join("\n") + "\n({ reviewApprovalContent, submitApproval, clearRuntimeScheduleDeleteReviews })").runInNewContext({
      ...context, document: { querySelectorAll: () => [card], createElement: () => new UiElement() }, loadApprovals: () => {},
    });
    const body = { kind: "schedule_delete", operation: "schedule.delete", command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64), schedule_id: "local-reminder", revision_digest: revision,
      channel: "webchat", target: "<owner>", time: "08:20", payload_hash: "c".repeat(64), goal_ref: goalRef, purpose_version: 2,
      no_store: true, used_for_authority: false, may_execute: false };
    const keys = Object.keys(body).sort((a, b) => a.localeCompare(b));
    const reviewDigest = createHash("sha256").update(JSON.stringify(body, keys)).digest("hex");
    const review = { ...body, command_id: commandId, review_digest: reviewDigest };
    const contentPath = "/approval/delete-sched/content";
    const verdictPath = "/approval/delete-sched";
    byId("approval-token").value = "resume-secret";
    const owner = byId("runtime-schedule-delete-review-owner-token");
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("owner token");
    expect(calls).toHaveLength(0);
    owner.value = "owner-secret";
    responses.set(contentPath, respond(review, 200, false));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("予定削除");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond({ ...review, time: "09:00" }));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("審査");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond(review));
    await ui.reviewApprovalContent(commandId, reviewButton);
    expect(calls.at(-1)).toMatchObject({ path: contentPath, options: { mode: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer resume-secret", "x-blue-tanuki-owner-token": "owner-secret" } } });
    expect(approve.disabled).toBe(false);
    expect(content.children.map((node) => node.textContent)).toContain("送信先　webchat / <owner>");
    responses.set(verdictPath, respond({ ok: true, result: { approval: "approve", executed: true } }));
    await ui.submitApproval(commandId, "approve", "one-use");
    expect(calls.at(-1)).toMatchObject({ path: verdictPath, options: { mode: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer resume-secret", "x-blue-tanuki-owner-token": "owner-secret" },
      body: JSON.stringify({ verdict: "approve", approval_token: "one-use", content_review_digest: reviewDigest }) } });
    expect(owner.value).toBe("");
    expect(approve.disabled).toBe(true);
    expect(Object.keys(context.state.approvalContentDigests)).toHaveLength(0);
  });
});
