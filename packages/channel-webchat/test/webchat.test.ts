import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { Script } from "node:vm";
import { WebSocket } from "ws";
import type { InboundRequest } from "@blue-tanuki/protocol";
import type { SendMeta } from "@blue-tanuki/channel-base";
import { CONTROL_CENTER_SCRIPT } from "../src/control_center_script.js";
import {
  WebChatChannel,
  MemoryTicketStore,
  type TicketStore,
  type WebChatRateLimits,
  type WebChatApprovalSurface,
  type WebChatAuditSurface,
  type WebChatAuthoritySurface,
  type WebChatNotificationSurface,
  type WebChatHistorySurface,
  type WebChatEvidenceSurface,
  type WebChatAboutSurface,
  type WebChatUpdateSurface,
  type WebChatRecoverySurface,
  type WebChatOperatorSurfaces,
  type WebChatRuntimeSurface,
  type WebChatSettingsSurface,
  AOTANU_ASSET_ROUTE_PREFIX,
  AOTANU_SPRITE_SPECS,
  mapRuntimeSnapshotToAotanuMascotState,
} from "../src/index.js";

async function allocateTestPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("failed to allocate test port"));
      });
    });
  });
}

const TOKEN = "test-token-1234";
const RESUME_TOKEN = "resume-token-1234";
const OWNER_TOKEN = "owner-token-1234567890";
const SETTINGS_TOKEN = "settings-token-1234";
const WEBHOOK_TOKEN = "webhook-token-1234";
const MAINTENANCE_TOKEN = "maintenance-token-1234";

interface Ctx {
  ch: WebChatChannel;
  port: number;
  received: InboundRequest[];
}

async function setup(
  opts: Partial<
    Ctx & {
      onResume?: (id: string, v: string, ctx: { actor: string; token_kind: "resume" }) => Promise<unknown>;
      onGoalPurposeChangeProposal?: (input: { goal_ref: string; purpose_text: string; actor: string }) => Promise<{
        accepted: boolean;
        status: string;
        goal_ref?: string;
        prior_version?: number;
        prior_purpose_digest?: string;
        new_purpose_digest?: string;
        request_id?: string;
        command_id?: string;
      }>;
      onGoalPurposeRelationReviewProposal?: (input: {
        plan_id_digest: string;
        revision_digest: string;
        outcome: "supports" | "conflicts" | "unknown";
        actor: string;
      }) => Promise<{
        accepted: boolean;
        status: string;
        plan_id_digest?: string;
        outcome?: "supports" | "conflicts" | "unknown";
        request_id?: string;
        command_id?: string;
      }>;
      resume_token?: string;
      owner_token?: string;
      webhook_token?: string;
      maintenance_token?: string;
      resume_approval_tokens?: false;
      resume_approval_token_ttl_ms?: number;
      ws_ticket_ttl_ms?: number;
      ticket_store?: TicketStore;
      rate_limits?: WebChatRateLimits | false;
      settings?: WebChatSettingsSurface;
      runtime?: WebChatRuntimeSurface;
      approval?: WebChatApprovalSurface;
      audit?: WebChatAuditSurface;
      authority?: WebChatAuthoritySurface;
      notifications?: WebChatNotificationSurface;
      history?: WebChatHistorySurface;
      evidence?: WebChatEvidenceSurface;
      about?: WebChatAboutSurface;
      update?: WebChatUpdateSurface;
      recovery?: WebChatRecoverySurface;
      operators?: WebChatOperatorSurfaces;
    }
  > = {},
): Promise<Ctx & { teardown: () => Promise<void> }> {
  const p = opts.port ?? await allocateTestPort();
  const received: InboundRequest[] = [];
  const ch = new WebChatChannel({
    port: p,
    token: TOKEN,
    resume_token: opts.resume_token ?? RESUME_TOKEN,
    owner_token: opts.owner_token,
    webhook_token: opts.webhook_token,
    maintenance_token: opts.maintenance_token ?? (opts.update || opts.recovery ? MAINTENANCE_TOKEN : undefined),
    host: "127.0.0.1",
    onResume: opts.onResume as never,
    onGoalPurposeChangeProposal: opts.onGoalPurposeChangeProposal,
    onGoalPurposeRelationReviewProposal: opts.onGoalPurposeRelationReviewProposal,
    resume_approval_tokens: opts.resume_approval_tokens,
    resume_approval_token_ttl_ms: opts.resume_approval_token_ttl_ms,
    ws_ticket_ttl_ms: opts.ws_ticket_ttl_ms,
    ticket_store: opts.ticket_store,
    settings: opts.settings,
    runtime: opts.runtime,
    approval: opts.approval,
    audit: opts.audit,
    authority: opts.authority,
    notifications: opts.notifications,
    history: opts.history,
    evidence: opts.evidence,
    about: opts.about,
    update: opts.update,
    recovery: opts.recovery,
    operators: opts.operators,
    // Default: disable rate limiting in legacy tests so existing flows
    // keep working without thinking about bursts. Rate-limit behavior is
    // covered by its own describe() block below.
    rate_limits: opts.rate_limits === undefined ? false : opts.rate_limits,
  });
  return {
    ch,
    port: p,
    received,
    teardown: async () => {
      await ch.stop();
    },
  };
}

async function waitForConnectionCount(
  ch: WebChatChannel,
  user: string,
  expected: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ch.connectionCount(user) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(ch.connectionCount(user)).toBe(expected);
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  const txt = await res.text();
  try {
    parsed = txt ? JSON.parse(txt) : null;
  } catch {
    parsed = txt;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function getRaw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function getTicket(port: number, user: string): Promise<string> {
  const r = await postJson(
    port,
    "/ws-ticket",
    { user },
    { authorization: `Bearer ${TOKEN}` },
  );
  if (r.status !== 200) {
    throw new Error(`ws-ticket failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return (r.body as { ticket: string }).ticket;
}

function openWsWithTicket(port: number, ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("ws open/hello timeout"));
    }, 2000);
    ws.once("message", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function readWsMessage(ws: WebSocket, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws msg timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

describe("WebChatChannel — construction", () => {
  it("rejects missing/short token", () => {
    expect(() => new WebChatChannel({ port: 1234, token: "" })).toThrow();
    expect(() => new WebChatChannel({ port: 1234, token: "short" })).toThrow();
  });

  it("rejects invalid resume token configuration", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          onResume: async () => ({ ok: true }),
        }),
    ).toThrow(/resume_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: TOKEN,
        }),
    ).toThrow(/differ/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: "short",
        }),
    ).toThrow(/resume_token/);
  });

  it("rejects invalid webhook token configuration", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          webhook_token: "short",
        }),
    ).toThrow(/webhook_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          webhook_token: TOKEN,
        }),
    ).toThrow(/webhook_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          webhook_token: RESUME_TOKEN,
        }),
    ).toThrow(/webhook_token/);
  });

  it("requires the owner ingress credential to be separate and sufficiently long", () => {
    expect(() => new WebChatChannel({ port: 1234, token: TOKEN, owner_token: "short" })).toThrow(/owner_token/);
    expect(() => new WebChatChannel({ port: 1234, token: TOKEN, owner_token: TOKEN })).toThrow(/owner_token/);
    expect(() => new WebChatChannel({ port: 1234, token: TOKEN, resume_token: RESUME_TOKEN, owner_token: RESUME_TOKEN })).toThrow(/owner_token/);
  });

  it("rejects bad port", () => {
    expect(() => new WebChatChannel({ port: 0, token: "x".repeat(10) })).toThrow();
    expect(
      () => new WebChatChannel({ port: 99999, token: "x".repeat(10) }),
    ).toThrow();
  });

  it("rejects ws_ticket_ttl_ms below 1000", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: "x".repeat(10),
          ws_ticket_ttl_ms: 100,
        }),
    ).toThrow();
  });

  it("rejects resume_approval_token_ttl_ms below 1000", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: "x".repeat(10),
          resume_approval_token_ttl_ms: 100,
        }),
    ).toThrow();
  });

  it("rejects settings token reuse", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          settings: {
            token: TOKEN,
            html: "<!doctype html>",
            getSnapshot: async () => ({}),
          },
        }),
    ).toThrow(/settings.token/);
  });

  it("requires a dedicated maintenance token for update and recovery surfaces", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          update: { getSnapshot: async () => ({}) },
        }),
    ).toThrow(/maintenance_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          maintenance_token: TOKEN,
          recovery: { getSnapshot: async () => ({}) },
        }),
    ).toThrow(/maintenance_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          maintenance_token: MAINTENANCE_TOKEN,
          settings: {
            token: MAINTENANCE_TOKEN,
            html: "<!doctype html>",
            getSnapshot: async () => ({}),
          },
          update: { getSnapshot: async () => ({}) },
        }),
    ).toThrow(/settings.token/);
  });
});

describe("WebChatChannel — Control Center shell", () => {
  it("renders only bounded Operation Plan digests, fixed statuses, and residual counts after selected-store restore", () => {
    const start = CONTROL_CENTER_SCRIPT.indexOf("function formatRecoveryPostActionPlanResiduals(");
    const next = CONTROL_CENTER_SCRIPT.indexOf("\n      function ", start + 1);
    const end = next < 0 ? CONTROL_CENTER_SCRIPT.length : next;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const formatter = CONTROL_CENTER_SCRIPT.slice(start, end).trim();
    const evaluate = (observation: unknown) => new Script(`${formatter}\nformatRecoveryPostActionPlanResiduals(observation)`)
      .runInNewContext({ observation }) as string;
    const observation = {
      operation: "restore",
      store_key: "operation_plans",
      restore_backup_id_digest: "c".repeat(64),
      plan_residuals: [
        { plan_id_digest: "a".repeat(64), status: "verified", binding_count: 1, residual_binding_count: 0, omitted_binding_count: 0 },
        { plan_id_digest: "b".repeat(64), status: "residuals_present", binding_count: 3, residual_binding_count: 2, omitted_binding_count: 1 },
      ],
      plan_restore_points: [
        { plan_id_digest: "a".repeat(64), backup_plan_record_status: "matched", backup_plan_integrity: "verified",
          backup_plan_record_count: 1, dependency_status: "observed", residual_dependencies: [], unobserved_dependencies: [] },
        { plan_id_digest: "b".repeat(64), backup_plan_record_status: "matched", backup_plan_integrity: "residuals_present",
          backup_plan_record_count: 1, dependency_status: "residuals_present", residual_dependencies: ["broker"], unobserved_dependencies: ["delivery"] },
      ],
    };
    const text = evaluate(observation);
    expect(text).toContain("復元元backup digest cccccccccccc・計画別backup相関: 読取検査");
    expect(text).toContain("計画digest aaaaaaaaaaaa・計画内検査: 検証済み・binding 1・残差binding 0・未表示binding 0");
    expect(text).toContain("backup内計画検査: 検証済み・依存: 観測範囲内");
    expect(text).toContain("計画digest bbbbbbbbbbbb・計画内検査: 残差あり・binding 3・残差binding 2・未表示binding 1");
    expect(text).toContain("依存: 残差あり（残差 broker／未観測 delivery）");
    expect(text.split("\n")).toHaveLength(3);
    expect(evaluate({ ...observation, store_key: "broker" })).toBe("未観測");
    expect(evaluate({ ...observation, plan_residuals: [{ ...observation.plan_residuals[0], plan_id_digest: "raw-plan-id" }] }))
      .toBe("未確認（表示を抑止）");
    expect(evaluate({ ...observation, plan_restore_points: [{ ...observation.plan_restore_points[0], plan_id_digest: "d".repeat(64) }, observation.plan_restore_points[1]] }))
      .toBe("未確認（表示を抑止）");
  });

  it("renders a verified result plan beside a held residual plan in one snapshot", () => {
    const helperStart = CONTROL_CENTER_SCRIPT.indexOf("function byId(");
    const helperEnd = CONTROL_CENTER_SCRIPT.indexOf("\n      function toneForBoolean(", helperStart + 1);
    const objectHelperStart = CONTROL_CENTER_SCRIPT.indexOf("function isObject(");
    const objectHelperEnd = CONTROL_CENTER_SCRIPT.indexOf("\n      function ", objectHelperStart + 1);
    const rendererStart = CONTROL_CENTER_SCRIPT.indexOf("function operationPlanStatusTone(");
    const rendererEnd = CONTROL_CENTER_SCRIPT.indexOf("\n      function renderRuntime(", rendererStart + 1);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(objectHelperStart).toBeGreaterThanOrEqual(0);
    expect(objectHelperEnd).toBeGreaterThan(objectHelperStart);
    expect(rendererStart).toBeGreaterThanOrEqual(0);
    expect(rendererEnd).toBeGreaterThan(rendererStart);

    const nodes: Record<string, { textContent?: string; className?: string; innerHTML?: string }> = {
      "operation-plan-state-summary": { textContent: "", className: "" },
      "operation-plan-state-list": { textContent: "", className: "", innerHTML: "" },
    };
    const document = { getElementById: (id: string) => nodes[id] ?? null };
    const nowMs = Date.now();
    const sourceObservation = (observedAtMs: number, expiresAtMs: number, privatePath: string) => ({
      schema_version: "operation-plan-compute-source-observation.v1",
      source: "verified_file_search_result", operation: "file.search",
      plan_id_digest: "1".repeat(64), revision_digest: "2".repeat(64), step_id_digest: "3".repeat(64),
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      record_digest: "4".repeat(64), memory_revision: 1, memory_receipt_digest: "5".repeat(64),
      observed_at_ms: observedAtMs, expires_at_ms: expiresAtMs, match_count: 2, visited_files: 7,
      search_completeness: "unknown", adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false, private_path: privatePath, private_query: "hidden query",
    });
    const observation = {
      schema_version: "operation-plan.status.v1",
      status: "available",
      used_for_authority: false,
      raw_payload_exposed: false,
      recovery_refresh_status: "ready",
      displayed_count: 2,
      plan_count: 2,
      goal_purpose_options: [{ goal_ref: "goal_0123456789abcdef", goal_kind: "delegated", purpose_version: 2,
        purpose_digest: "c".repeat(64), parent_alignment_status: "not_applicable" }],
      private_search_line: "SYNTHETIC PRIVATE SEARCH LINE MUST NOT RENDER",
      plans: [
        {
          plan_id: "a".repeat(64), revision: 3, revision_digest: "b".repeat(64),
          goal_purpose_binding: { goal_ref: "goal_0123456789abcdef", purpose_version: 2, purpose_digest: "c".repeat(64) },
          goal_purpose_binding_status: "current",
          status: "results_verified", step_count: 2,
          compute_source_observations: [sourceObservation(nowMs, nowMs + 600_000, "SYNTHETIC PRIVATE SOURCE PATH MUST NOT RENDER")],
          steps: [
            { step_id: "c".repeat(64), operation: "file.search", status: "verified",
              binding: { command_digest: "d".repeat(64), result_digest: "e".repeat(64), delivery_digest: "f".repeat(64) } },
            { step_id: "1".repeat(64), operation: "file.search", status: "verified",
              binding: { command_digest: "2".repeat(64), result_digest: "3".repeat(64), delivery_digest: "4".repeat(64) } },
          ],
        },
        {
          plan_id: "5".repeat(64), revision: 1, revision_digest: "6".repeat(64),
          goal_purpose_binding: { goal_ref: "goal_0123456789abcdef", purpose_version: 1, purpose_digest: "d".repeat(64) },
          goal_purpose_binding_status: "stale",
          goal_purpose_relation: { status: "unverified", candidate_outcome: "supports", candidate_status: "present",
            evidence_status: "exact_spans_present", evidence_count: 1, semantic_assessment_status: "not_assessed",
            record_digest: "5".repeat(64), used_for_authority: false, may_execute: false },
          status: "held_residual", step_count: 1,
          compute_source_observations: [sourceObservation(nowMs - 600_001, nowMs - 1, "EXPIRED PRIVATE SOURCE PATH MUST NOT RENDER")],
          recovery_hold_reason: "held_residual", recovery_hold_scope_relation: "collateral",
          steps: [{ step_id: "7".repeat(64), operation: "file.search", status: "outcome_unknown",
            external_receipt_observation: "not_recorded",
            binding: { command_digest: "8".repeat(64), result_digest: "9".repeat(64), delivery_digest: "a".repeat(64) } }],
        },
      ],
    };
    const script = [
      CONTROL_CENTER_SCRIPT.slice(helperStart, helperEnd),
      CONTROL_CENTER_SCRIPT.slice(objectHelperStart, objectHelperEnd),
      CONTROL_CENTER_SCRIPT.slice(rendererStart, rendererEnd),
      "renderOperationPlanStatus(observation);",
    ].join("\n");
    new Script(script).runInNewContext({ document, observation });

    expect(nodes["operation-plan-state-summary"]?.textContent).toBe("2 / 2 件");
    expect(nodes["operation-plan-state-summary"]?.className).toBe("badge good");
    const rendered = nodes["operation-plan-state-list"]?.innerHTML ?? "";
    expect(rendered).toContain('<span class="badge good">results_verified</span>');
    expect(rendered).toContain('<span class="badge review">held_residual</span>');
    expect(rendered).toContain("復元残差あり（step選択停止中）");
    expect(rendered).toContain("新しい依頼から新規計画を作成してください。");
    expect(rendered).toContain("実行結果digest");
    expect(rendered).toContain("J配送digest");
    expect(rendered).toContain("作業目的版の選択候補（digestのみ）");
    expect(rendered).toContain("意味上の適合や実行許可を判定しません。");
    expect(rendered).toContain("C候補は非権威。明示確認までstep選択を停止");
    expect(rendered).toContain("引用照合=exact_spans_present");
    expect(rendered).toContain("\u0026quot;purpose_version\u0026quot;:2");
    expect(rendered).toContain("陳腐化または照合不能（step実行を停止）");
    expect(rendered).toContain("期限内（観測のみ）");
    expect(rendered).toContain("期限切れ・照合不能（Jはstep選択と実行を拒否）");
    expect(rendered).toContain("一致候補 2件、訪問 7件、検索完全性=unknown");
    expect(rendered).not.toContain("SYNTHETIC PRIVATE SOURCE PATH MUST NOT RENDER");
    expect(rendered).not.toContain("EXPIRED PRIVATE SOURCE PATH MUST NOT RENDER");
    expect(rendered).not.toContain("SYNTHETIC PRIVATE SEARCH LINE MUST NOT RENDER");
  });

  it("shows digest-only goal change metadata and reveals the exact reviewed purpose as text", async () => {
    const renderStart = CONTROL_CENTER_SCRIPT.indexOf("function renderApprovals(body)");
    const renderEnd = CONTROL_CENTER_SCRIPT.indexOf("\n      function renderApprovalGrants(", renderStart + 1);
    expect(renderStart).toBeGreaterThanOrEqual(0);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const queueNodes: Record<string, { textContent: string; className: string; innerHTML: string }> = Object.create(null);
    const queueState = { approvalTokens: Object.create(null), approvalContentDigests: Object.create(null) };
    const queueRender = new Script(`
      const state = queueState;
      function byId(id) { return queueNodes[id] || (queueNodes[id] = { textContent: "", className: "", innerHTML: "" }); }
      function setText(id, value) { byId(id).textContent = String(value); }
      function setHtml(id, value) { byId(id).innerHTML = value; }
      function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
      function badge(value, tone) { return '<span class="badge ' + (tone || '') + '">' + escapeHtml(value) + '</span>'; }
      function formatDate(value) { return String(value ?? "not set"); }
      function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
      function compactJson(value) { return JSON.stringify(value); }
      function redactRuntimeValue(value) { return value; }
      function renderApprovalGrants() {}
      function renderApprovalHistory() {}
      ${CONTROL_CENTER_SCRIPT.slice(renderStart, renderEnd)}
      renderApprovals(queueBody);
    `);
    const commandDigest = "d".repeat(64);
    const priorDigest = "a".repeat(64);
    const purposeDigest = "b".repeat(64);
    queueRender.runInNewContext({
      queueState,
      queueNodes,
      queueBody: {
        pending_approvals: [{
          command_id: "goal-purpose-command",
          request_id: "goal-purpose-request",
          operation: "tool.call",
          target: "goal.governance.change:goal_0000000000000001:1:" + priorDigest + ":" + purposeDigest,
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
          reason: "no_matching_approval_grant",
          content_review_required: true,
          approval_token: "opaque-test-token",
          approval_token_expires_at_ms: 100,
          goal_purpose_change_review: {
            kind: "goal_purpose_change",
            goal_ref: "goal_0000000000000001",
            prior_version: 1,
            prior_purpose_digest: priorDigest,
            new_purpose_digest: purposeDigest,
            review_status: "required",
            used_for_authority: false,
          },
        }],
        grants: [],
        approval_history: [],
        emergency_stop: { active: false },
      },
    });
    const queueHtml = queueNodes["approval-list"]?.innerHTML ?? "";
    expect(queueHtml).toContain("Delegated goal purpose change");
    expect(queueHtml).toContain(priorDigest);
    expect(queueHtml).toContain(purposeDigest);
    expect(queueHtml).toContain("Review exact purpose");
    expect(queueHtml).toContain("data-verdict=\"approve\" data-command=\"goal-purpose-command\" disabled");
    expect(queueHtml).not.toContain("raw proposal text");

    const purposeText = '<img src=x onerror="alert(1)"> exact purpose';
    const review = {
      kind: "goal_purpose_change",
      command_id: "goal-purpose-command",
      command_digest: commandDigest,
      request_payload_digest: purposeDigest,
      operation: "goal.governance.change",
      goal_ref: "goal_0000000000000001",
      prior_version: 1,
      prior_purpose_digest: priorDigest,
      new_purpose_digest: purposeDigest,
      purpose_text: purposeText,
      used_for_authority: false,
    };
    const makeNode = (tagName: string) => ({
      tagName,
      textContent: "",
      children: [] as Array<Record<string, unknown>>,
      replaceChildren() { this.children = []; },
      appendChild(child: Record<string, unknown>) { this.children.push(child); return child; },
      append(...children: Array<Record<string, unknown>>) { this.children.push(...children); },
    });
    const view = makeNode("section");
    const approve = { disabled: true };
    const card = {
      getAttribute: (name: string) => name === "data-command" ? "goal-purpose-command" : null,
      querySelector: (selector: string) => selector === "[data-content-review-view]" ? view : selector === '[data-verdict="approve"]' ? approve : null,
    };
    const button = { textContent: "Review exact purpose" };
    const state = { approvalContentDigests: Object.create(null) as Record<string, string> };
    const functionStart = CONTROL_CENTER_SCRIPT.indexOf("async function reviewApprovalContent(");
    const functionEnd = CONTROL_CENTER_SCRIPT.indexOf("\n      async function revokeApprovalGrant(", functionStart + 1);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const reviewFunction = new Script(`
      async function run() {
        const state = reviewState;
        function byId(id) { return id === "approval-token" ? { value: "resume-token" } : null; }
        function authHeaders(value) { return { authorization: "Bearer " + value }; }
        const document = {
          querySelectorAll() { return [reviewCard]; },
          createElement(tagName) { return makeNode(tagName); },
        };
        const fetch = async () => ({ ok: true, json: async () => reviewData });
        ${CONTROL_CENTER_SCRIPT.slice(functionStart, functionEnd)}
        await reviewApprovalContent("goal-purpose-command", reviewButton);
      }
      run();
    `);
    await reviewFunction.runInNewContext({ reviewState: state, reviewCard: card, makeNode, reviewButton: button, reviewData: review });
    const purposePre = view.children.find((child) => child.tagName === "pre");
    expect(purposePre?.textContent).toBe(purposeText);
    expect(state.approvalContentDigests["goal-purpose-command"]).toBe(commandDigest);
    expect(approve.disabled).toBe(false);
  });

  it("renders task-purpose relation review against its queued digests without treating it as execution authority", async () => {
    const commandId = "relation-command";
    const commandDigest = "c".repeat(64);
    const review = {
      kind: "goal_purpose_relation",
      command_id: commandId,
      command_digest: commandDigest,
      request_payload_digest: "d".repeat(64),
      operation: "goal.governance.review_task_purpose",
      plan_id_digest: "a".repeat(64),
      task_digest: "b".repeat(64),
      revision_digest: "e".repeat(64),
      goal_ref: "goal_0000000000000001",
      purpose_version: 3,
      purpose_digest: "f".repeat(64),
      outcome: "supports",
      task: '<img src=x onerror="alert(1)"> task text',
      purpose_text: "Exact purpose text",
      plan: { version: "operation-core.v1", plan_id: "fixture-plan", request_id: "fixture-request", steps: [] },
      candidate_outcome: "conflicts",
      candidate_status: "present",
      evidence_status: "exact_spans_present",
      evidence_count: 2,
      used_for_authority: false,
      may_execute: false,
    };
    const makeNode = (tagName: string) => ({
      tagName,
      textContent: "",
      children: [] as Array<Record<string, unknown>>,
      replaceChildren() { this.children = []; },
      appendChild(child: Record<string, unknown>) { this.children.push(child); return child; },
      append(...children: Array<Record<string, unknown>>) { this.children.push(...children); },
    });
    const view = makeNode("section");
    const approve = { disabled: true };
    const card = {
      dataset: {
        planIdDigest: review.plan_id_digest,
        taskDigest: review.task_digest,
        revisionDigest: review.revision_digest,
        goalRef: review.goal_ref,
        purposeVersion: String(review.purpose_version),
        purposeDigest: review.purpose_digest,
        relationOutcome: review.outcome,
      },
      getAttribute: (name: string) => name === "data-command" ? commandId : null,
      querySelector: (selector: string) => selector === "[data-content-review-view]" ? view :
        selector === '[data-verdict="approve"]' ? approve : null,
    };
    const state = { approvalContentDigests: Object.create(null) as Record<string, string> };
    const start = CONTROL_CENTER_SCRIPT.indexOf("async function reviewApprovalContent(");
    const end = CONTROL_CENTER_SCRIPT.indexOf("\n      async function revokeApprovalGrant(", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const run = new Script(`
      async function runReview() {
        const state = reviewState;
        function byId(id) { return id === "approval-token" ? { value: "resume-token" } : null; }
        function authHeaders(value) { return { authorization: "Bearer " + value }; }
        function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
        const document = {
          querySelectorAll() { return [reviewCard]; },
          createElement(tagName) { return makeNode(tagName); },
        };
        const fetch = async () => ({ ok: true, json: async () => reviewData });
        ${CONTROL_CENTER_SCRIPT.slice(start, end)}
        await reviewApprovalContent("${commandId}", { textContent: "Review exact task-purpose relation" });
      }
      runReview();
    `);
    await run.runInNewContext({ reviewState: state, reviewCard: card, reviewData: review, makeNode });
    const values = view.children.filter((child) => child.tagName === "pre").map((child) => child.textContent);
    expect(values).toContain(review.task);
    expect(values).toContain(review.purpose_text);
    expect(values.some((value) => value?.includes('"plan_id": "fixture-plan"'))).toBe(true);
    expect(state.approvalContentDigests[commandId]).toBe(commandDigest);
    expect(approve.disabled).toBe(false);
  });

  it("projects only verified scope-applicability enums and digest fields", () => {
    const functionSource = (name: string): string => {
      const start = CONTROL_CENTER_SCRIPT.indexOf(`function ${name}(`);
      const next = CONTROL_CENTER_SCRIPT.indexOf("\n      function ", start + 1);
      const end = next < 0 ? CONTROL_CENTER_SCRIPT.length : next;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return CONTROL_CENTER_SCRIPT.slice(start, end).trim();
    };
    const helpers = [functionSource("recoveryInspectionEnum"), functionSource("recoveryInspectionDigest")].join("\n");
    const render = functionSource("renderRecoveryScopeApplicability");
    const evaluate = (report: unknown) => JSON.parse(new Script(`
      const output = {};
      function setText(key, value) { output[key] = value; }
      function byId(key) { return output[key] || (output[key] = { className: "" }); }
      function compactJson(value) { return JSON.stringify(value); }
      ${helpers}
      ${render}
      renderRecoveryScopeApplicability(report);
      JSON.stringify({ status: output["recovery-scope-applicability-status"], body: output["recovery-scope-applicability-json"] });
    `).runInNewContext({ report })) as { status: string; body: string };
    const report = {
      schema_version: 1,
      surface: "recovery_scope_applicability",
      mode: "read_only",
      status: "matched",
      reason: null,
      scope_kind: "operation_plan",
      scope_digest: "a".repeat(64),
      backup_id_digest: "b".repeat(64),
      matched_plan_id_digest: "c".repeat(64),
      matched_plan_scope_count: 1,
      store_candidate_count: 1,
      verified_store_candidate_count: 1,
      dependency_scope_status: "observed",
      residual_dependencies: [],
      unobserved_dependencies: [],
      store_candidates: [{
        store_key: "operation_plans",
        snapshot_status: "verified",
        dependency_status: "no_residual_recorded",
        related_dependencies: ["operation_plan"],
      }],
      cross_store_atomic: false,
      external_backup_restore_point: "not_examined",
      used_for_authority: false,
      may_execute: false,
    };
    expect(evaluate(report)).toMatchObject({ status: "照合成立（復旧可否は未判定）" });
    expect(evaluate({ ...report, store_candidates: [{ ...report.store_candidates[0], related_dependencies: ["memory"] }] }))
      .toMatchObject({ status: "未確認" });
  });

  it("projects only the five ordered canonical store statuses and rejects malformed rows", () => {
    const functionSource = (name: string): string => {
      const start = CONTROL_CENTER_SCRIPT.indexOf(`function ${name}(`);
      const next = CONTROL_CENTER_SCRIPT.indexOf("\n      function ", start + 1);
      const end = next < 0 ? CONTROL_CENTER_SCRIPT.length : next;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return CONTROL_CENTER_SCRIPT.slice(start, end).trim();
    };
    const helpers = [
      functionSource("recoveryInspectionEnum"),
      functionSource("recoveryInspectionCount"),
      functionSource("recoveryInspectionDigest"),
      functionSource("recoveryBackupStoreStatuses"),
      functionSource("recoveryBackupOperationPlanInventory"),
      functionSource("recoveryBackupOperationPlanDependencyInventory"),
      functionSource("formatRecoveryBackupPlanScopes"),
      functionSource("formatRecoveryBackupPlanDependencies"),
      functionSource("renderRecoveryBackupStoreStatuses"),
    ].join("\n");
    const render = functionSource("renderRecoveryBackupInspection");
    const evaluate = (rows: unknown, counts: Record<string, unknown> = {}) => new Script(`
      const output = {};
      function setText(key, value) { output[key] = value; }
      function byId() { return { className: "" }; }
      function compactJson(value) { return JSON.stringify(value); }
      ${helpers}
      ${render}
      renderRecoveryBackupInspection(report);
      JSON.stringify({
        projection: JSON.parse(output["recovery-backup-inspection-json"]),
        backupPlanText: output["recovery-backup-plan-scopes"],
        backupPlanDependencyText: output["recovery-backup-plan-dependencies"],
        storeStatus: Object.fromEntries(["j_control", "m_state", "broker", "operation_plans", "cron_events"].map((key) =>
          [key, output["recovery-backup-store-" + key]])),
      });
    `).runInNewContext({ report: {
      schema_version: 1,
      surface: "recovery_backup_inspection",
      mode: "read_only",
      status: "verified",
      backup_id_digest: "a".repeat(64),
      coverage: "complete_for_configured_targets",
      configured_required_item_count: 1,
      copied_required_item_count: 1,
      missing_required_item_count: 0,
      canonical_state_coverage: "complete",
      canonical_state_expected_store_count: 5,
      canonical_state_snapshot_count: 5,
      canonical_state_verified_store_count: 5,
      canonical_state_missing_store_count: 0,
      canonical_state_unverified_store_count: 0,
      canonical_state_store_consistency: "independent_sqlite_online_snapshots",
      canonical_state_cross_store_atomic: false,
      canonical_state_stores: rows,
      operation_plan_archive_inventory: {
        status: "verified", reason: null, plan_scope_count: 1, plan_count: 1, plan_integrity_residual_count: 0,
        binding_count: 2, verified_binding_count: 2, residual_binding_count: 0, unverified_memory_link_count: 0,
        omitted_binding_count: 0, omitted_plan_scope_count: 0,
        plan_scopes: [{ plan_id_digest: "b".repeat(64), request_scope_digest: "c".repeat(64), integrity: "verified",
          plan_record_count: 1, binding_count: 2, residual_binding_count: 0, omitted_binding_count: 0 }],
        cross_ledger_correlation: "not_performed", used_for_authority: false, may_execute: false,
      },
      operation_plan_archive_dependencies: {
        status: "correlated", reason: null, plan_scope_count: 1, residual_plan_scope_count: 0,
        unobserved_plan_scope_count: 0, omitted_plan_scope_count: 0,
        plan_scopes: [{ plan_id_digest: "d".repeat(64), status: "observed", residual_dependencies: [], unobserved_dependencies: [] }],
        cross_store_consistency: "independent_sqlite_online_snapshots", cross_store_atomic: false,
        external_backup_restore_point: "not_examined", used_for_authority: false, may_execute: false,
      },
      used_for_authority: false,
      may_execute: false,
      ...counts,
    } }) as string;
    const rows = [
      { store_key: "j_control", status: "verified" },
      { store_key: "m_state", status: "captured_unverified" },
      { store_key: "broker", status: "snapshot_failed" },
      { store_key: "operation_plans", status: "not_present" },
      { store_key: "cron_events", status: "verified" },
    ];
    const validate = new Script(`(${functionSource("recoveryBackupStoreStatuses")})`).runInNewContext() as
      (value: unknown) => unknown;
    expect(validate(rows)).toEqual(rows);
    expect(validate([])).toEqual([]);
    expect(validate(rows.slice(1))).toBeNull();
    expect(validate([{ ...rows[0] }, { ...rows[1], store_key: "j_control" }, ...rows.slice(2)])).toBeNull();
    expect(validate([{ ...rows[0], status: "unknown" }, ...rows.slice(1)])).toBeNull();
    const partial = JSON.parse(evaluate(rows, {
      canonical_state_coverage: "partial",
      canonical_state_snapshot_count: 3,
      canonical_state_verified_store_count: 2,
      canonical_state_missing_store_count: 1,
      canonical_state_unverified_store_count: 2,
    })) as { projection: { status: string }; storeStatus: Record<string, string> };
    expect(partial.projection.status).toBe("verified");
    expect(partial.storeStatus).toEqual({
      j_control: "アーカイブ検査済み",
      m_state: "取得済み・未検証",
      broker: "取得失敗",
      operation_plans: "backup時に未存在",
      cron_events: "アーカイブ検査済み",
    });
    const completeRows = [
      { store_key: "j_control", status: "verified" },
      { store_key: "m_state", status: "verified" },
      { store_key: "broker", status: "verified" },
      { store_key: "operation_plans", status: "verified" },
      { store_key: "cron_events", status: "verified" },
    ];
    const valid = JSON.parse(evaluate(completeRows)) as { projection: { canonical_state_stores: unknown }; storeStatus: Record<string, string> };
    expect(valid.projection.canonical_state_stores).toEqual(completeRows);
    expect(valid.storeStatus).toEqual({
      j_control: "アーカイブ検査済み",
      m_state: "アーカイブ検査済み",
      broker: "アーカイブ検査済み",
      operation_plans: "アーカイブ検査済み",
      cron_events: "アーカイブ検査済み",
    });
    const planInventory = JSON.parse(evaluate(completeRows)) as { projection: { operation_plan_archive_inventory: { plan_scopes: Array<Record<string, unknown>> } }; backupPlanText: string };
    expect(planInventory.projection.operation_plan_archive_inventory.plan_scopes).toMatchObject([
      { plan_id_digest: "b".repeat(64), request_scope_digest: "c".repeat(64), integrity: "verified" },
    ]);
    expect(planInventory.backupPlanText).toContain("計画digest bbbbbbbbbbbb / 要求scope digest cccccccccccc");
    expect(planInventory.backupPlanText).toContain("仕事ID・復元点・復元許可ではなく");
    expect(planInventory.backupPlanText).toContain("J以外の台帳との相関は未実施");

    const dependencies = JSON.parse(evaluate(completeRows)) as {
      projection: { operation_plan_archive_dependencies: { status: string; plan_scopes: Array<Record<string, unknown>> } };
      backupPlanDependencyText: string;
    };
    expect(dependencies.projection.operation_plan_archive_dependencies.status).toBe("correlated");
    expect(dependencies.projection.operation_plan_archive_dependencies.plan_scopes).toMatchObject([
      { plan_id_digest: "d".repeat(64), status: "observed", residual_dependencies: [], unobserved_dependencies: [] },
    ]);
    expect(dependencies.backupPlanDependencyText).toContain("観測範囲内で残差なし");
    expect(dependencies.backupPlanDependencyText).toContain("同時点atomicity");
    expect(dependencies.backupPlanDependencyText).not.toContain("d".repeat(64));

    const residualAndUnobserved = JSON.parse(evaluate(completeRows, { operation_plan_archive_dependencies: {
      status: "residuals_present", reason: null, plan_scope_count: 1, residual_plan_scope_count: 1,
      unobserved_plan_scope_count: 1, omitted_plan_scope_count: 0,
      plan_scopes: [{ plan_id_digest: "d".repeat(64), status: "residuals_present",
        residual_dependencies: ["broker"], unobserved_dependencies: ["cron_approval"] }],
      cross_store_consistency: "independent_sqlite_online_snapshots", cross_store_atomic: false,
      external_backup_restore_point: "not_examined", used_for_authority: false, may_execute: false,
    } })) as { projection: { operation_plan_archive_dependencies: { plan_scopes: Array<Record<string, unknown>> } }; backupPlanDependencyText: string };
    expect(residualAndUnobserved.projection.operation_plan_archive_dependencies.plan_scopes).toMatchObject([
      { residual_dependencies: ["broker"], unobserved_dependencies: ["cron_approval"] },
    ]);
    expect(residualAndUnobserved.backupPlanDependencyText).toContain("残差: Broker");
    expect(residualAndUnobserved.backupPlanDependencyText).toContain("未観測: Cron承認");

    const invalidDependencyCounts = JSON.parse(evaluate(completeRows, { operation_plan_archive_dependencies: {
      status: "correlated", reason: null, plan_scope_count: 1, residual_plan_scope_count: 1,
      unobserved_plan_scope_count: 0, omitted_plan_scope_count: 0,
      plan_scopes: [{ plan_id_digest: "d".repeat(64), status: "observed", residual_dependencies: [], unobserved_dependencies: [] }],
      cross_store_consistency: "independent_sqlite_online_snapshots", cross_store_atomic: false,
      external_backup_restore_point: "not_examined", used_for_authority: false, may_execute: false,
    } })) as { projection: { status: string; operation_plan_archive_dependencies: { status: string; plan_scopes: unknown[] } }; backupPlanDependencyText: string };
    expect(invalidDependencyCounts.projection.status).toBe("invalid_report");
    expect(invalidDependencyCounts.projection.operation_plan_archive_dependencies.status).toBe("snapshot_unverified");
    expect(invalidDependencyCounts.projection.operation_plan_archive_dependencies.plan_scopes).toEqual([]);
    expect(invalidDependencyCounts.backupPlanDependencyText).toBe("未確認");

    const residual = JSON.parse(evaluate(completeRows, { operation_plan_archive_inventory: {
      status: "residuals_present", reason: "binding_mismatch", plan_scope_count: 1, plan_count: 1,
      plan_integrity_residual_count: 1, binding_count: 2, verified_binding_count: 1,
      residual_binding_count: 1, unverified_memory_link_count: 0, omitted_binding_count: 0, omitted_plan_scope_count: 0,
      plan_scopes: [{ plan_id_digest: "b".repeat(64), request_scope_digest: null, integrity: "residuals_present",
        plan_record_count: 1, binding_count: 2, residual_binding_count: 1, omitted_binding_count: 0 }],
      cross_ledger_correlation: "not_performed", used_for_authority: false, may_execute: false,
    } })) as { projection: { operation_plan_archive_inventory: { status: string; plan_scopes: unknown[] } }; backupPlanText: string };
    expect(residual.projection.operation_plan_archive_inventory.status).toBe("residuals_present");
    expect(residual.projection.operation_plan_archive_inventory.plan_scopes).toMatchObject([{ integrity: "residuals_present" }]);
    expect(residual.backupPlanText).toContain("残差あり");

    const forgedPlanCount = JSON.parse(evaluate(completeRows, { operation_plan_archive_inventory: {
      status: "verified", reason: null, plan_scope_count: 1, plan_count: 2, plan_integrity_residual_count: 0,
      binding_count: 2, verified_binding_count: 2, residual_binding_count: 0, unverified_memory_link_count: 0,
      omitted_binding_count: 0, omitted_plan_scope_count: 0,
      plan_scopes: [{ plan_id_digest: "b".repeat(64), request_scope_digest: "c".repeat(64), integrity: "verified",
        plan_record_count: 1, binding_count: 2, residual_binding_count: 0, omitted_binding_count: 0 }],
      cross_ledger_correlation: "not_performed", used_for_authority: false, may_execute: false,
    } })) as { projection: { status: string; operation_plan_archive_inventory: { plan_scopes: unknown[] } }; backupPlanText: string; storeStatus: Record<string, string> };
    expect(forgedPlanCount.projection.status).toBe("invalid_report");
    expect(forgedPlanCount.projection.operation_plan_archive_inventory.plan_scopes).toEqual([]);
    expect(forgedPlanCount.backupPlanText).toBe("未確認");
    expect(Object.values(forgedPlanCount.storeStatus)).toEqual(["未確認", "未確認", "未確認", "未確認", "未確認"]);
    const mismatched = evaluate(completeRows, { canonical_state_verified_store_count: 4 });
    const invalid = JSON.parse(mismatched) as { projection: { status: string; canonical_state_stores: unknown[] }; storeStatus: Record<string, string> };
    expect(invalid.projection.status).toBe("invalid_report");
    expect(invalid.projection.canonical_state_stores).toEqual([]);
    expect(Object.values(invalid.storeStatus)).toEqual(["未確認", "未確認", "未確認", "未確認", "未確認"]);
    const noCanonicalSnapshot = JSON.parse(evaluate([], {
      canonical_state_coverage: "not_included",
      canonical_state_expected_store_count: null,
      canonical_state_snapshot_count: null,
      canonical_state_verified_store_count: null,
      canonical_state_missing_store_count: null,
      canonical_state_unverified_store_count: null,
      canonical_state_store_consistency: "not_included",
      canonical_state_cross_store_atomic: null,
    })) as { projection: { status: string }; storeStatus: Record<string, string> };
    expect(noCanonicalSnapshot.projection.status).toBe("verified");
    expect(Object.values(noCanonicalSnapshot.storeStatus)).toEqual([
      "このbackupに未収録",
      "このbackupに未収録",
      "このbackupに未収録",
      "このbackupに未収録",
      "このbackupに未収録",
    ]);
    expect(CONTROL_CENTER_SCRIPT).toContain('canonical_state_stores: safeStatus === "verified" ? canonicalStores : []');
  });

  it("renders only verified Operation Plan dependency scopes with fixed labels and counts", () => {
    const functionSource = (name: string): string => {
      const start = CONTROL_CENTER_SCRIPT.indexOf(`function ${name}(`);
      const next = CONTROL_CENTER_SCRIPT.indexOf("\n      function ", start + 1);
      const end = next < 0 ? CONTROL_CENTER_SCRIPT.length : next;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return CONTROL_CENTER_SCRIPT.slice(start, end).trim();
    };
    const helper = [functionSource("recoveryInspectionEnum"), functionSource("recoveryInspectionDigest"),
      functionSource("formatRecoveryPlanDependencyScopes")].join("\n");
    const evaluate = (scopes: unknown, boundary = true, inspectionStatus = "verified", omittedCount = 0, ledgerStatus = "verified") =>
      new Script(`${helper}\nformatRecoveryPlanDependencyScopes(scopes, boundary, inspectionStatus, omittedCount, ledgerStatus)`)
        .runInNewContext({ scopes, boundary, inspectionStatus, omittedCount, ledgerStatus }) as string;
    const scopes = [
      {
        plan_id_digest: "a".repeat(64), request_scope_digest: "9".repeat(64), integrity: "verified",
        plan_record_count: 1, binding_count: 2, inspected_binding_count: 2, omitted_binding_count: 0,
        residual_binding_count: 0, status: "observed", residual_dependencies: [], unobserved_dependencies: [],
      },
      {
        plan_id_digest: "b".repeat(64), request_scope_digest: null, integrity: "residuals_present",
        plan_record_count: 2, binding_count: 3, inspected_binding_count: 3, omitted_binding_count: 0,
        residual_binding_count: 1, status: "residuals_present", residual_dependencies: ["operation_plan", "broker"],
        unobserved_dependencies: ["delivery"],
      },
      {
        plan_id_digest: "c".repeat(64), request_scope_digest: null, integrity: "verified",
        plan_record_count: 1, binding_count: 1, inspected_binding_count: 1, omitted_binding_count: 0,
        residual_binding_count: 0, status: "unobserved", residual_dependencies: [],
        unobserved_dependencies: ["memory", "cron_approval"],
      },
    ];
    const rendered = evaluate(scopes);
    expect(rendered).toContain("Plan aaaaaaaaaaaa — 観測範囲内で残差なし");
    expect(rendered).toContain("Plan bbbbbbbbbbbb — 残差あり");
    expect(rendered).toContain("Plan cccccccccccc — 未観測");
    expect(rendered).toContain("Operation Plan、Broker");
    expect(rendered).toContain("結果配送");
    expect(rendered).toContain("J/M記憶連結、Cron承認handoff");
    expect(rendered).toContain("依存関連付け 3件: 検査 3件／省略 0件／残差 1件");
    expect(rendered).not.toContain("a".repeat(64));
    expect(rendered).not.toContain("9".repeat(64));
    expect(rendered).toContain("復旧可能性・復元・再開許可を示しません");

    const invalidBoundary = evaluate(scopes, false, "verified", 2);
    expect(invalidBoundary).toContain("依存scope: 未確認");
    expect(invalidBoundary).toContain("省略scope件数: 2");
    expect(invalidBoundary).not.toContain("Plan aaaaaaaaaaaa");
    expect(evaluate(scopes, true, "verified", 0, "unavailable")).toContain("Operation Plan台帳を検証できません");
    expect(evaluate([], true, "verified", 0, "verified")).toContain("該当するOperation Planはありません（台帳検査済み）");
    expect(evaluate([], true, "verified", 0, "unavailable")).toContain("依存scope: 未確認");

    const unknownStatus = evaluate([{ ...scopes[0] as object, status: "approved" }]);
    expect(unknownStatus).toContain("依存scope: 未確認");
    expect(unknownStatus).not.toContain("Plan aaaaaaaaaaaa");
    const unknownCategory = evaluate([{ ...scopes[0] as object, unobserved_dependencies: ["filesystem"] }]);
    expect(unknownCategory).toContain("依存scope: 未確認");
    const inconsistentCounts = evaluate([{ ...scopes[0] as object, inspected_binding_count: 1 }]);
    expect(inconsistentCounts).toContain("依存scope: 未確認");
    const prefixCollision = evaluate([
      scopes[0],
      { ...scopes[0] as object, plan_id_digest: "a".repeat(12) + "f".repeat(52) },
    ]);
    expect(prefixCollision).toContain("依存scope: 未確認");
    expect(prefixCollision).not.toContain("Plan aaaaaaaaaaaa");
  });

  it("serves the local resident app shell at /app", async () => {
    const ctx = await setup();
    try {
      await ctx.ch.start(async () => undefined);
      const r = await fetch(`http://127.0.0.1:${ctx.port}/app`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("BLUE-TANUKI Control Center");
      expect(html).toContain("Tanuki Dashboard");
      expect(html).toContain("Owner operation screens");
      expect(html).toContain('<body data-active-screen="conversation">');
      expect(html).toContain('class="screen-tab active" data-screen="conversation" aria-selected="true"');
      expect(html).toContain('data-screen="home" aria-selected="false">Console</button>');
      expect(html).toContain("document.body.dataset.activeScreen = selected");
      expect(html).toContain('body[data-active-screen="conversation"] .shell');
      expect(html).toContain('activeScreen: storedActiveScreen && storedActiveScreen !== "home" ? storedActiveScreen : "conversation"');
      expect(html).toContain("min-height: 100dvh");
      expect(html).toContain("overflow-y: auto");
      expect(html).toContain("grid-template-columns: repeat(15");
      expect(html).toContain('title="Conversation / WebChat"');
      expect(html).toContain("Conversation / WebChat");
      expect(html).toContain("chat-screen");
      expect(html).toContain("chat-topbar");
      expect(html).toContain("WebChatの切断やこの画面を閉じる操作は、チャット接続だけを閉じます。Gatewayサービスの停止を意味しません。");
      expect(html).toContain("runtime-snapshot-observed");
      expect(html).toContain('loadRuntime("webchat-connected")');
      expect(html).toContain('cache: "no-store"');
      expect(html).toContain("chatConnectionGeneration");
      expect(html).toContain("chat-log");
      expect(html).toContain("chat-bubble");
      expect(html).toContain("chat-composer");
      expect(html).toContain("data-operation-plan-reconcile");
      expect(html).toContain("/operators/developer/invoke");
      expect(html).toContain("照合はDeveloper入口から明示要求");
      expect(html).toContain("chat-identity-row");
      expect(html).toContain("chat-input-row");
      expect(html).toContain("Message BLUE-TANUKI");
      expect(html).toContain("chatRoleForKind");
      expect(html).toContain("chatLabelForRole");
      expect(html).toContain("Tasks");
      expect(html).toContain("Activity / Audit");
      expect(html).toContain("Memory");
      expect(html).toContain("Skills");
      expect(html).toContain("Operation Core Plan");
      expect(html).toContain("operation-core-status");
      expect(html).toContain("operation-core-list");
      expect(html).toContain("operation-core-adapter-registry");
      expect(html).toContain("operation-core-default-runtime");
      expect(html).toContain("operation-core-execution-results");
      expect(html).toContain("operation-core-execution-list");
      expect(html).toContain("operation-plan-state-summary");
      expect(html).toContain("operation-plan-state-list");
      expect(html).toContain("recovery_refresh_status");
      expect(html).toContain("復元照合中");
      expect(html).toContain("step選択を停止しています。復元処理完了後にGatewayを再起動して復旧状態を点検してください。");
      expect(html).toContain("renderOperationCoreProjections");
      expect(html).toContain("renderOperationCoreExecution");
      expect(html).toContain("renderOperationPlanStatus");
      expect(html).toContain("復元残差あり（step選択停止中）");
      expect(html).toContain("復元依存未観測（step選択停止中）");
      expect(html).toContain("L3要求で指定された計画");
      expect(html).toContain("選択store内の巻き添え計画");
      expect(html).toContain("L3要求との関係は未確認");
      expect(html).toContain("復元scopeとの関係表示はplan単位の復元やhold解除を意味しません。");
      expect(html).toContain("状態を確認後に続ける場合は、新しい依頼から新規計画を作成してください。");
      expect(html).toContain("loopbackで読取照合");
      expect(html).toContain("照合はDeveloper入口から明示要求した場合だけloopbackへ1回GETし");
      expect(html).toContain("local inspectionの1件がcommand/payload digest一致");
      expect(html).toContain("成功・目標達成は未確認");
      expect(html).toContain("operation_core_projection");
      expect(html).toContain("OPERATION_ADAPTER_REGISTRY");
      expect(html).toContain("adapter-generated");
      expect(html).toContain("registry match");
      expect(html).toContain("runtime_boundary");
      expect(html).toContain("Channels");
      expect(html).toContain("Connectors");
      expect(html).toContain("Doctor");
      expect(html).toContain("Settings");
      expect(html).toContain("About");
      expect(html).toContain("Update");
      expect(html).toContain("Backup / Restore");
      expect(html).toContain('id="restore-recovery-backup" type="button" disabled');
      expect(html).toContain("Recovery changes require owner L3 review. Backup and read-only inspection remain available.");
      expect(html).toContain("Request full restore review");
      expect(html).toContain('id="recovery-restore-store"');
      expect(html).toContain('option value="operation_plans"');
      expect(html).toContain("Request selected-store restore review");
      expect(html).toContain("restoreRecoveryStore");
      expect(html).toContain("item.target");
      expect(html).toContain("OpenRouter");
      expect(html).toContain("Composio");
      expect(html).toContain("connectors-token");
      expect(html).toContain("composio-api-key");
      expect(html).toContain("composio-user-id");
      expect(html).toContain("composio-allowed-toolkits");
      expect(html).toContain("composio-allowed-actions");
      expect(html).toContain("composio-revoked-actions");
      expect(html).toContain("composio-api-base-url");
      expect(html).toContain("composio-dry-run");
      expect(html).toContain("composio-live-execution");
      expect(html).toContain("composio-clear-api-key");
      expect(html).toContain("load-connectors");
      expect(html).toContain("save-connectors");
      expect(html).toContain("settings-token");
      expect(html).toContain("settings-provider");
      expect(html).toContain("load-settings");
      expect(html).toContain("verify-llm-settings");
      expect(html).toContain("save-settings");
      expect(html).toContain("about-token");
      expect(html).toContain("load-about");
      expect(html).toContain("/app/about");
      expect(html).toContain("public claim");
      expect(html).toContain("update-token");
      expect(html).toContain("maintenance token");
      expect(html).toContain("load-update");
      expect(html).toContain("update-next-action-status");
      expect(html).toContain("/update/snapshot");
      expect(html).toContain("/update/verify");
      expect(html).toContain("/update/prepare");
      expect(html).toContain("bt.updateToken");
      expect(html).toContain("recovery-token");
      expect(html).toContain("load-recovery");
      expect(html).toContain("recovery-post-action-observation");
      expect(html).toContain("recovery-post-action-plan-residuals");
      expect(html).toContain("選択store内の計画別台帳検査");
      expect(html).toContain("復元直後の状態と一致");
      expect(html).toContain("復元後に状態変更を観測");
      expect(html).toContain("復元状態と不一致");
      expect(html).toContain("storeLedgerStatusLabels");
      expect(html).toContain('verified: "検証済み"');
      expect(html).toContain('residuals_present: "残差あり"');
      expect(html).toContain('schema_mismatch: "schema不一致"');
      expect(html).toContain('observation.store_ledger_residual_count >= 0');
      expect(html).toContain("/recovery/snapshot");
      expect(html).toContain("inspect-recovery-ledgers");
      expect(html).toContain("/recovery/inspection");
      expect(html).toContain("recovery-inspection-json");
      expect(html).toContain("recovery-plan-dependency-scopes");
      expect(html).toContain("Operation Plan依存scope（現行台帳検査）");
      expect(html).toContain("復元・再開許可を行いません");
      expect(html).toContain("ledger_boundaries");
      expect(html).toContain("verified_event_count");
      expect(html).toContain("最初の未検証位置");
      expect(html).toContain("operation_plan_correlations");
      expect(html).toContain("memory_update_id_digest");
      expect(html).toContain("memory_correlation");
      expect(html).toContain("update_residuals");
      expect(html).toContain("仕事ごとの参照はdigestと固定状態だけ");
      expect(html).toContain("仕事単位の復旧点は確立しません");
      expect(html).toContain("inspect-recovery-backup");
      expect(html).toContain("/recovery/backup-inspection");
      expect(html).toContain("recovery-backup-inspection-json");
      expect(html).toContain("指定scopeとbackup store候補の照合");
      expect(html).toContain("recovery-scope-applicability");
      expect(html).toContain("/recovery/scope-applicability");
      expect(html).toContain("ownerが指定したscope digest");
      expect(html).toContain("canonical_state_coverage");
      expect(html).toContain("function recoveryBackupStoreStatuses");
      expect(html).toContain("canonical_state_stores");
      expect(html).toContain("recovery-backup-store-j_control");
      expect(html).toContain("台帳別snapshot検査");
      expect(html).toContain("bt.recoveryToken");
      expect(html).toContain("/settings/config");
      expect(html).toContain("/settings/llm/verify");
      expect(html).toContain("bt.settingsToken");
      expect(html).toContain("Developer / Evidence");
      expect(html).toContain("evidence-token");
      expect(html).toContain("export-evidence");
      expect(html).toContain("/evidence/export");
      expect(html).toContain("local resident console");
      expect(html).not.toContain("UI state is not authority");
      expect(html).not.toContain("LLM output is not authority");
      expect(html).not.toContain("Memory is not authority");
      expect(html).not.toContain("Channel metadata is not authority");
      expect(html).not.toContain("not authority");
      expect(html).toContain("Responsibility Map");
      expect(html).toContain("Runtime");
      expect(html).toContain("Capability");
      expect(html).toContain("Recovery");
      expect(html).toContain("Approval Policy");
      expect(html).toContain("Verify Chain");
      expect(html).toContain("Authority Trace");
      expect(html).toContain("Scheduled Tasks");
      expect(html).toContain("Permanent-Use Status");
      expect(html).toContain("First-Run Next Action");
      expect(html).toContain("chat-token");
      expect(html).toContain("connect-chat");
      expect(html).toContain("send-chat");
      expect(html).toContain("doctor-runtime-status");
      expect(html).toContain("doctor-webchat-ready");
      expect(html).toContain("doctor-next-action");
      expect(html).toContain("ApprovalLevel");
      expect(html).toContain("Final Review");
      expect(html).toContain("Notification Center");
      expect(html).toContain("load-notifications");
      expect(html).toContain('fields.push(["result correlation", item.result_correlation_status])');
      expect(html).toContain('fields.push(["receipt observation", item.external_receipt_observation_status])');
      expect(html).toContain('fields.push(["receipt source", item.external_receipt_observation_source])');
      expect(html).toContain("Complete History / Replay");
      expect(html).toContain("load-history");
      expect(html).toContain("history-list");
      expect(html).toContain("runtime-schedule-list");
      expect(html).toContain("authority-trace-list");
      expect(html).toContain("redactRuntimeValue");
      expect(html).toContain("brand-mascot");
      expect(html).not.toContain("tanuki-mark");
      expect(html).not.toContain("<svg");
      expect(html).toContain("aotanu-mascot");
      expect(html).toContain("aotanu-sprite");
      expect(html).toContain("アオタヌ");
      expect(html).toContain("mascot-dock");
      expect(html).toContain("mascot-dock-bottom-right");
      expect(html).toContain("mascot-size-medium");
      expect(html).toContain("mascot-toggle");
      expect(html).toContain("mascot-actions");
      expect(html).toContain("mascot-enabled");
      expect(html).toContain("mascot-character");
      expect(html).toContain("mascot-size");
      expect(html).not.toContain("mascot-position");
      expect(html).not.toContain("mascot-dock-bottom-left");
      expect(html).toContain("reset-mascot-settings");
      expect(html).toContain("bt.mascotPrefs");
      expect(html).toContain("localStorage");
      expect(html).toContain("position: fixed");
      expect(html).toContain("pointer-events: none");
      expect(html).not.toContain("tanuki-panel");
      expect(html).toContain("aotanuStateFromRuntime");
      expect(html).toContain("aotanuDisplayLabelFromRuntime");
      expect(html).toContain("要確認");
      expect(html).toContain("エラー");
      expect(html).toContain("image-rendering: pixelated");
      expect(html).toContain(AOTANU_SPRITE_SPECS.idle.asset_path);
      expect(html).toContain(AOTANU_SPRITE_SPECS.walk.asset_path);
      expect(html).toContain(AOTANU_SPRITE_SPECS.working.asset_path);
      expect(html).toContain(AOTANU_SPRITE_SPECS.happy.asset_path);
      expect(html).toContain(AOTANU_SPRITE_SPECS.error.asset_path);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (match) => match[1] ?? "",
      );
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(() => new Script(script)).not.toThrow();
      }
    } finally {
      await ctx.teardown();
    }
  });

  it("submits exactly one fixed canonical store for owner L3 review", async () => {
    const start = CONTROL_CENTER_SCRIPT.indexOf("async function restoreRecoveryStore(");
    const end = CONTROL_CENTER_SCRIPT.indexOf("\n      async function resetRecoveryProvider", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const functionSource = CONTROL_CENTER_SCRIPT.slice(start, end).trim();

    const run = async (storeKey: string, scopeKind = "operation_plan", scopeDigest = "a".repeat(64)) => {
      const raw = await new Script(`
        const elements = {
          "recovery-restore-store": { value: ${JSON.stringify(storeKey)} },
          "recovery-backup-id": { value: "backup-2026-10-18" },
          "recovery-scope-kind": { value: ${JSON.stringify(scopeKind)} },
          "recovery-scope-digest": { value: ${JSON.stringify(scopeDigest)} },
          "recovery-action-status": { textContent: "" },
        };
        let request = null;
        const prompts = [];
        const window = { confirm(message) { prompts.push(message); return true; } };
        function byId(id) { return elements[id]; }
        function setText(id, value) { elements[id].textContent = value; }
        async function runRecoveryAction(path, body) { request = { path, body }; }
        ${functionSource}
        restoreRecoveryStore().then(() => JSON.stringify({ request, prompts, status: elements["recovery-action-status"].textContent }));
      `).runInNewContext() as Promise<string>;
      return JSON.parse(raw) as {
        request: { path: string; body: Record<string, unknown> } | null;
        prompts: string[];
        status: string;
      };
    };

    const valid = await run("operation_plans");
    expect(valid).toMatchObject({
      request: {
        path: "/recovery/restore",
        body: {
          confirm: "RESTORE",
          store_key: "operation_plans",
          backup_id: "backup-2026-10-18",
          scope_kind: "operation_plan",
          scope_digest: "a".repeat(64),
        },
      },
    });
    expect(valid.prompts[0]).toContain("owner L3 review");
    expect(valid.prompts[0]).toContain("Only this store will be selected");
    expect(valid.prompts[0]).toContain("pre-action backup");
    expect(valid.prompts[0]).toContain("Operation Plan ledger");
    expect(valid.prompts[0]).toContain("entire selected Operation Plan store");
    expect(await run("operation_plans", "request_scope", "a".repeat(64))).toMatchObject({
      request: null,
      status: "Operation Plan digestを指定してください",
    });
    expect(await run("operation_plans", "operation_plan", "invalid")).toMatchObject({
      request: null,
      status: "Operation Plan digestを指定してください",
    });
    expect(await run("unknown_store")).toMatchObject({
      request: null,
      status: "select one verified store",
    });
  });

  it("serves only the bundled Aotanu spritesheet assets", async () => {
    const ctx = await setup();
    try {
      await ctx.ch.start(async () => undefined);
      const ok = await fetch(
        `http://127.0.0.1:${ctx.port}${AOTANU_SPRITE_SPECS.idle.asset_path}`,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("image/png");
      expect(Number(ok.headers.get("content-length"))).toBeGreaterThan(1000000);
      await ok.arrayBuffer();

      const unknown = await fetch(
        `http://127.0.0.1:${ctx.port}${AOTANU_ASSET_ROUTE_PREFIX}unknown.png`,
      );
      expect(unknown.status).toBe(404);

      const traversal = await fetch(
        `http://127.0.0.1:${ctx.port}${AOTANU_ASSET_ROUTE_PREFIX}..%2Fsecret.png`,
      );
      expect(traversal.status).toBe(404);

      const post = await postJson(
        ctx.port,
        AOTANU_SPRITE_SPECS.idle.asset_path,
        {},
      );
      expect(post.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("Aotanu mascot runtime mapper", () => {
  it("maps runtime snapshots to display-only mascot states", () => {
    expect(mapRuntimeSnapshotToAotanuMascotState({
      gateway_status: "starting",
      hds_invariants_ok: true,
      audit_chain_valid: true,
      webchat_ready: true,
    })).toBe("walk");
    expect(mapRuntimeSnapshotToAotanuMascotState({
      gateway_status: "running",
      hds_invariants_ok: true,
      audit_chain_valid: true,
      webchat_ready: true,
      pending_approvals_count: 1,
    })).toBe("working");
    expect(mapRuntimeSnapshotToAotanuMascotState({
      gateway_status: "running",
      hds_invariants_ok: true,
      audit_chain_valid: true,
      webchat_ready: true,
      next_recommended_action: null,
    })).toBe("happy");
    expect(mapRuntimeSnapshotToAotanuMascotState({
      gateway_status: "running",
      hds_invariants_ok: true,
      audit_chain_valid: true,
      webchat_ready: true,
      next_recommended_action: "Configure TELEGRAM_BOT_TOKEN to enable Telegram",
    })).toBe("idle");
    expect(mapRuntimeSnapshotToAotanuMascotState({
      gateway_status: "degraded",
      hds_invariants_ok: false,
      audit_chain_valid: true,
      webchat_ready: true,
    })).toBe("error");
  });
});

describe("WebChatChannel — Recovery surface", () => {
  it("serves maintenance-token-gated recovery readiness and control actions with non-authority metadata", async () => {
    expect(() => new Function(CONTROL_CENTER_SCRIPT)).not.toThrow();
    const actions: string[] = [];
    let inspectionReads = 0;
    let backupInspectionReads = 0;
    let scopeApplicabilityReads = 0;
    const ctx = await setup({
      recovery: {
        getSnapshot: async () => ({
          schema_version: 1,
          surface: "recovery",
          mode: "control_available",
          env_file: {
            configured: true,
            path: "/tmp/product.env",
            exists: true,
            backup_count: 2,
            latest_backup_path: "/tmp/product.env.2026.settings.bak",
            backup_pattern: "/tmp/product.env.*.bak",
            secret_material: true,
          },
          recovery_backups: {
            configured: true,
            path: "/tmp/recovery",
            exists: true,
            backup_count: 1,
            latest_backup_id: "2026-06-14T00-00-00-000Z.backup.fixture",
            latest_manifest_path: "/tmp/recovery/2026-06-14T00-00-00-000Z.backup.fixture/manifest.json",
            backup_pattern: "/tmp/recovery/*/manifest.json",
            secret_material: true,
          },
          runtime_paths: {
            audit_dir: {
              configured: true,
              path: "/tmp/audit",
              exists: true,
              kind: "directory",
              backup_required: true,
            },
          },
          restore: {
            execution_available: false,
            restore_review_request_available: true,
            backup_available: true,
            latest_backup_id: "2026-06-14T00-00-00-000Z.backup.fixture",
            factory_reset_review_request_available: true,
            provider_reset_review_request_available: true,
            connector_reset_review_request_available: true,
            factory_reset_available: false,
            provider_reset_available: false,
            connector_reset_available: false,
            blocked_reason: "owner_l3_review_required",
            destructive_repair_available: false,
            confirmation_required: true,
          },
          authority_boundary: {
            ui_used_for_authority: false,
            recovery_metadata_used_for_authority: false,
            recovery_action_used_for_authority: false,
            used_for_authority: false,
          },
          post_action_observation: {
            status: "changed",
            operation: "provider_reset",
            operation_digest: "c".repeat(64),
            result_digest: "d".repeat(64),
            configuration_state: "provider_stub",
            evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
            used_for_authority: false,
            may_execute: false,
          },
          next_safe_action: "Review backup inventory.",
          evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
        }),
        inspectLedgerState: async () => {
          inspectionReads += 1;
          return {
            schema_version: 8,
            surface: "recovery_inspection_operator",
            mode: "read_only",
            status: "residuals_present",
            ledgers: {
              j: "verified",
              m: "unavailable",
              broker: "verified",
              operation_plans: "residuals_present",
              cron_events: "unavailable",
              document_organization_checkpoints: "unavailable",
            },
            cron_event_summary: {
              status: "unavailable",
              reason: "store_unavailable",
              cursor_count: null,
              verified_cursor_count: null,
              unverified_cursor_count: null,
              omitted_cursor_count: null,
              unresolved_cursor_count: null,
              orphan_outbox_count: null,
              approval_handoff_count: null,
              verified_approval_handoff_count: null,
              unverified_approval_handoff_count: null,
              omitted_approval_handoff_count: null,
              pending_approval_handoff_count: null,
              interrupted_approval_handoff_count: null,
              residual_count: 1,
            },
            document_organization_checkpoint_summary: {
              status: "unavailable",
              reason: "store_unavailable",
              checkpoint_count: null,
              verified_checkpoint_count: null,
              residual_checkpoint_count: null,
              omitted_checkpoint_count: null,
              unresolved_checkpoint_count: null,
              residual_count: 1,
              records: [],
            },
            ledger_boundaries: {
              j: { reason: null, verified_event_count: 3, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: 3 },
              m: { reason: "store_unavailable", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
              broker: { reason: null, verified_event_count: 2, unverified_event_count: 1, first_unverified_ordinal: 3, last_verified_revision: null },
            },
            replay_checkpoint: "not_verified",
            operation_plan_correlations: [{
              plan_id_digest: "a".repeat(64),
              step_id_digest: "b".repeat(64),
              command_id_digest: "c".repeat(64),
              status: "outcome_unknown",
              binding_integrity: "residuals_present",
              admission_digest: "d".repeat(64),
              broker_correlation: "not_found",
              delivery_correlation: "not_observed",
              memory_update_id_digest: "f".repeat(64),
              memory_correlation: "m_state_unverified",
              cron_approval_correlation: "cron_unverified",
            }],
            omitted_operation_plan_correlation_count: 0,
            plan_dependency_scopes: [{
              plan_id_digest: "a".repeat(64),
              request_scope_digest: "9".repeat(64),
              integrity: "residuals_present",
              plan_record_count: 1,
              binding_count: 1,
              inspected_binding_count: 1,
              omitted_binding_count: 0,
              residual_binding_count: 1,
              status: "residuals_present",
              residual_dependencies: ["operation_plan", "broker"],
              unobserved_dependencies: ["delivery", "memory", "cron_approval"],
            }],
            omitted_plan_dependency_scope_count: 0,
            request_scope_correlation: {
              status: "available",
              entries: [{
                request_scope_digest: "9".repeat(64),
                relationship: "counterpart_unresolved",
                status: "residuals_present",
                operation_plan_scope_count: 1,
                residual_operation_plan_scope_count: 1,
                unobserved_operation_plan_scope_count: 0,
                verified_document_checkpoint_count: 0,
                unresolved_document_checkpoint_count: 0,
              }],
              matched_scope_count: 0,
              operation_plan_only_scope_count: 0,
              document_checkpoint_only_scope_count: 0,
              counterpart_unresolved_scope_count: 1,
              unlinked_operation_plan_scope_count: 0,
              unlinked_document_checkpoint_count: null,
            },
            update_residuals: [{ update_id_digest: "e".repeat(64), disposition: "content_mismatch" }],
            omitted_update_residual_count: 0,
            isolated_update_count: 0,
            execution_residual_count: 0,
            operation_plan_residual_count: 1,
            cron_event_residual_count: 1,
            cron_approval_correlation_residual_count: 1,
            document_organization_checkpoint_residual_count: 1,
            external_backup_restore_point: "not_examined",
            boundary_valid: true,
            used_for_authority: false,
            may_execute: false,
            next_safe_action: "Preserve the stores.",
          };
        },
        inspectBackup: async () => {
          backupInspectionReads += 1;
          return {
            schema_version: 1,
            surface: "recovery_backup_inspection",
            mode: "read_only",
            status: "verified",
            backup_id_digest: "a".repeat(64),
            coverage: "complete_for_configured_targets",
            configured_required_item_count: 4,
            copied_required_item_count: 4,
            missing_required_item_count: 0,
            canonical_state_coverage: "complete",
            canonical_state_expected_store_count: 5,
            canonical_state_snapshot_count: 5,
            canonical_state_verified_store_count: 5,
            canonical_state_missing_store_count: 0,
            canonical_state_unverified_store_count: 0,
            canonical_state_store_consistency: "independent_sqlite_online_snapshots",
            canonical_state_cross_store_atomic: false,
            canonical_state_stores: [
              { store_key: "j_control", status: "verified" },
              { store_key: "m_state", status: "verified" },
              { store_key: "broker", status: "verified" },
              { store_key: "operation_plans", status: "verified" },
              { store_key: "cron_events", status: "verified" },
            ],
            used_for_authority: false,
            may_execute: false,
          };
        },
        inspectScopeApplicability: async (body) => {
          scopeApplicabilityReads += 1;
          return {
            schema_version: 1,
            surface: "recovery_scope_applicability",
            mode: "read_only",
            status: "unverified",
            reason: body.scope_digest === "e".repeat(64) ? "scope_not_found" : "invalid_request",
            used_for_authority: false,
            may_execute: false,
          };
        },
        createBackup: async () => {
          actions.push("backup");
          return { action: "backup", used_for_authority: false };
        },
        restoreBackup: async (body) => {
          actions.push(`restore:${String(body.confirm)}`);
          return { status: "approval_required", executed: false, operation: "recovery.restore", backup_id: body.backup_id, used_for_authority: false };
        },
        resetProvider: async (body) => {
          actions.push(`provider:${String(body.confirm)}`);
          return { status: "approval_required", executed: false, operation: "recovery.reset_provider", used_for_authority: false };
        },
        resetConnector: async (body) => {
          actions.push(`connector:${String(body.confirm)}`);
          return { status: "approval_required", executed: false, operation: "recovery.reset_connector", used_for_authority: false };
        },
        factoryReset: async (body) => {
          actions.push(`factory:${String(body.confirm)}`);
          return { status: "approval_required", executed: false, operation: "recovery.factory_reset", used_for_authority: false };
        },
      },
    });
    try {
      await ctx.ch.start(async () => {});

      expect((await getRaw(ctx.port, "/recovery/snapshot")).status).toBe(401);
      expect((await getRaw(ctx.port, "/recovery/snapshot", {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);

      expect((await getRaw(ctx.port, "/recovery/inspection")).status).toBe(401);
      expect((await getRaw(ctx.port, "/recovery/inspection", {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const inspection = await getRaw(ctx.port, "/recovery/inspection", {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(inspection.status).toBe(200);
      expect(inspection.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(inspection.text)).toMatchObject({
        surface: "recovery_inspection_operator",
        mode: "read_only",
        status: "residuals_present",
        ledger_boundaries: {
          j: { verified_event_count: 3, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: 3 },
          m: { reason: "store_unavailable", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
          broker: { verified_event_count: 2, unverified_event_count: 1, first_unverified_ordinal: 3, last_verified_revision: null },
        },
        operation_plan_residual_count: 1,
        cron_event_residual_count: 1,
        cron_approval_correlation_residual_count: 1,
        document_organization_checkpoint_residual_count: 1,
        cron_event_summary: { status: "unavailable", residual_count: 1, cursor_count: null, pending_approval_handoff_count: null },
        document_organization_checkpoint_summary: { status: "unavailable", residual_count: 1, checkpoint_count: null, unresolved_checkpoint_count: null },
        plan_dependency_scopes: [{ request_scope_digest: "9".repeat(64) }],
        request_scope_correlation: {
          status: "available",
          matched_scope_count: 0,
          operation_plan_only_scope_count: 0,
          document_checkpoint_only_scope_count: 0,
          counterpart_unresolved_scope_count: 1,
          unlinked_operation_plan_scope_count: 0,
          unlinked_document_checkpoint_count: null,
          entries: [{
            request_scope_digest: "9".repeat(64),
            relationship: "counterpart_unresolved",
            status: "residuals_present",
            operation_plan_scope_count: 1,
            residual_operation_plan_scope_count: 1,
            unobserved_operation_plan_scope_count: 0,
            verified_document_checkpoint_count: 0,
            unresolved_document_checkpoint_count: 0,
          }],
        },
        operation_plan_correlations: [{
          memory_update_id_digest: "f".repeat(64),
          memory_correlation: "m_state_unverified",
          cron_approval_correlation: "cron_unverified",
        }],
        external_backup_restore_point: "not_examined",
        used_for_authority: false,
        may_execute: false,
      });
      expect(inspectionReads).toBe(1);
      expect(actions).toEqual([]);

      expect((await getRaw(ctx.port, "/recovery/backup-inspection")).status).toBe(401);
      expect((await getRaw(ctx.port, "/recovery/backup-inspection", {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const backupInspection = await getRaw(ctx.port, "/recovery/backup-inspection", {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(backupInspection.status).toBe(200);
      expect(backupInspection.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(backupInspection.text)).toMatchObject({
        surface: "recovery_backup_inspection",
        mode: "read_only",
        status: "verified",
        coverage: "complete_for_configured_targets",
        canonical_state_coverage: "complete",
        canonical_state_expected_store_count: 5,
        canonical_state_snapshot_count: 5,
        canonical_state_verified_store_count: 5,
        canonical_state_missing_store_count: 0,
        canonical_state_unverified_store_count: 0,
        canonical_state_store_consistency: "independent_sqlite_online_snapshots",
        canonical_state_cross_store_atomic: false,
        canonical_state_stores: [
          { store_key: "j_control", status: "verified" },
          { store_key: "m_state", status: "verified" },
          { store_key: "broker", status: "verified" },
          { store_key: "operation_plans", status: "verified" },
          { store_key: "cron_events", status: "verified" },
        ],
        used_for_authority: false,
        may_execute: false,
      });
      expect(backupInspectionReads).toBe(1);
      expect(actions).toEqual([]);
      expect((await postJson(ctx.port, "/recovery/backup-inspection", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      })).status).toBe(405);
      expect(backupInspectionReads).toBe(1);
      expect((await postJson(ctx.port, "/recovery/scope-applicability", { scope_digest: "e".repeat(64) })).status).toBe(401);
      expect((await postJson(ctx.port, "/recovery/scope-applicability", { scope_digest: "e".repeat(64) }, {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const scopeApplicability = await postJson(ctx.port, "/recovery/scope-applicability", {
        scope_digest: "e".repeat(64),
        scope_kind: "request_scope",
        store_candidates: ["operation_plans"],
      }, { authorization: `Bearer ${MAINTENANCE_TOKEN}` });
      expect(scopeApplicability.status).toBe(200);
      expect(scopeApplicability.headers.get("cache-control")).toBe("no-store");
      expect(scopeApplicability.body).toMatchObject({
        surface: "recovery_scope_applicability",
        mode: "read_only",
        status: "unverified",
        reason: "scope_not_found",
        used_for_authority: false,
        may_execute: false,
      });
      expect(scopeApplicabilityReads).toBe(1);
      expect((await getRaw(ctx.port, "/recovery/scope-applicability", {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      })).status).toBe(405);
      expect(scopeApplicabilityReads).toBe(1);
      expect((await postJson(ctx.port, "/recovery/inspection", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      })).status).toBe(405);
      expect(inspectionReads).toBe(1);

      const ok = await getRaw(ctx.port, "/recovery/snapshot", {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toMatchObject({
        surface: "recovery",
        mode: "control_available",
        env_file: {
          exists: true,
          backup_count: 2,
          secret_material: true,
        },
        recovery_backups: {
          backup_count: 1,
          latest_backup_id: "2026-06-14T00-00-00-000Z.backup.fixture",
        },
        restore: {
          execution_available: false,
          restore_review_request_available: true,
          factory_reset_review_request_available: true,
          provider_reset_review_request_available: true,
          connector_reset_review_request_available: true,
          factory_reset_available: false,
          provider_reset_available: false,
          connector_reset_available: false,
          blocked_reason: "owner_l3_review_required",
          destructive_repair_available: false,
        },
        authority_boundary: {
          ui_used_for_authority: false,
          recovery_metadata_used_for_authority: false,
          recovery_action_used_for_authority: false,
          used_for_authority: false,
        },
        post_action_observation: {
          status: "changed",
          operation: "provider_reset",
          configuration_state: "provider_stub",
          used_for_authority: false,
          may_execute: false,
        },
      });

      const post = await postJson(ctx.port, "/recovery/snapshot", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(post.status).toBe(405);

      expect((await postJson(ctx.port, "/recovery/backup", {})).status).toBe(401);
      expect((await postJson(ctx.port, "/recovery/backup", {}, {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const backup = await postJson(ctx.port, "/recovery/backup", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(backup.status).toBe(200);
      expect(backup.body).toMatchObject({ ok: true, result: { action: "backup", used_for_authority: false } });

      const restore = await postJson(ctx.port, "/recovery/restore", {
        backup_id: "2026-06-14T00-00-00-000Z.backup.fixture",
        confirm: "RESTORE",
      }, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(restore.status).toBe(202);
      expect(restore.body).toMatchObject({
        ok: true,
        result: { status: "approval_required", executed: false },
      });

      const providerReset = await postJson(ctx.port, "/recovery/reset-provider", { confirm: "RESET_PROVIDER" }, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      const connectorReset = await postJson(ctx.port, "/recovery/reset-connector", { confirm: "RESET_CONNECTOR" }, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      const factoryReset = await postJson(ctx.port, "/recovery/factory-reset", { confirm: "FACTORY_RESET" }, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(providerReset.status).toBe(202);
      expect(connectorReset.status).toBe(202);
      expect(factoryReset.status).toBe(202);
      expect(providerReset.body.result).toMatchObject({ status: "approval_required", executed: false });
      expect(connectorReset.body.result).toMatchObject({ status: "approval_required", executed: false });
      expect(factoryReset.body.result).toMatchObject({ status: "approval_required", executed: false });
      expect(actions).toEqual(["backup", "restore:RESTORE", "provider:RESET_PROVIDER", "connector:RESET_CONNECTOR", "factory:FACTORY_RESET"]);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — About surface", () => {
  it("serves read-only About metadata only with the inbound token", async () => {
    const ctx = await setup({
      about: {
        getSnapshot: async () => ({
          schema_version: 1,
          product_name: "BLUE-TANUKI",
          package: {
            name: "blue-tanuki-workspace",
            version: "1.0.0-rc.1",
            license: "Apache-2.0",
            private: true,
          },
          release: {
            stage: "rc",
            owner_go: "pending",
            public_claim_allowed: false,
            validate_ga_remains_required: true,
          },
          authority_boundary: {
            hds_brain_owns_authority: true,
            ui_used_for_authority: false,
            claim_metadata_used_for_authority: false,
            used_for_authority: false,
          },
        }),
      },
    });
    await ctx.ch.start(async () => {});

    expect((await getRaw(ctx.port, "/app/about")).status).toBe(401);

    const ok = await getRaw(ctx.port, "/app/about", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({
      product_name: "BLUE-TANUKI",
      package: { version: "1.0.0-rc.1", license: "Apache-2.0" },
      release: { owner_go: "pending", public_claim_allowed: false },
      authority_boundary: {
        hds_brain_owns_authority: true,
        ui_used_for_authority: false,
        claim_metadata_used_for_authority: false,
        used_for_authority: false,
      },
    });

    const post = await postJson(ctx.port, "/app/about", {}, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(post.status).toBe(405);
    await ctx.teardown();
  });
});

describe("WebChatChannel — Update surface", () => {
  it("serves manual update readiness and prepare controls only with the maintenance token", async () => {
    const actions: string[] = [];
    const ctx = await setup({
      update: {
        getSnapshot: async () => ({
          schema_version: 1,
          surface: "update",
          mode: "manual_control",
          package: {
            current_version: "1.0.0-rc.1",
            current_git_head: "0".repeat(40),
          },
          candidate: {
            configured: true,
            archive_path: "/tmp/release/blue-tanuki.tar.gz",
            exists: true,
            sha256_path: "/tmp/release/blue-tanuki.sha256",
            sha256_exists: true,
            manifest_path: "/tmp/release/blue-tanuki.manifest.json",
            manifest_exists: true,
            archive_sha256: "a".repeat(64),
            sha256_matches: true,
            manifest_matches: true,
            version: "1.0.0-rc.1",
            verification_status: "pass",
            failure_reason: null,
            secret_material: false,
          },
          compatibility: {
            current_data_schema_version: 1,
            minimum_supported_data_schema_version: 1,
            candidate_manifest_schema_version: 1,
            migration_required: false,
            migration_supported: true,
            status: "pass",
          },
          rollback: {
            pre_update_backup_available: true,
            latest_plan_path: null,
            latest_plan_id: null,
            rollback_requires_manual_app_restore: true,
          },
          distribution_boundary: {
            signed_native_installer_shipped: false,
            automatic_updater_shipped: false,
            runtime_auto_apply_available: false,
            manual_update_only: true,
          },
          authority_boundary: {
            ui_used_for_authority: false,
            update_metadata_used_for_authority: false,
            rollback_plan_used_for_authority: false,
            recovery_backup_used_for_authority: false,
            used_for_authority: false,
          },
          next_safe_action: "Create a pre-update backup.",
          evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
        }),
        verifyCandidate: async () => {
          actions.push("verify");
          return { action: "verify_candidate", used_for_authority: false };
        },
        prepareUpdate: async (body) => {
          actions.push(`prepare:${String(body.confirm)}`);
          return {
            action: "prepare_update",
            pre_update_backup_id: "backup-fixture",
            rollback_plan_id: "rollback-fixture",
            used_for_authority: false,
          };
        },
      },
    });
    try {
      await ctx.ch.start(async () => {});

      expect((await getRaw(ctx.port, "/update/snapshot")).status).toBe(401);
      expect((await getRaw(ctx.port, "/update/snapshot", {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);

      const ok = await getRaw(ctx.port, "/update/snapshot", {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toMatchObject({
        surface: "update",
        mode: "manual_control",
        candidate: {
          verification_status: "pass",
          sha256_matches: true,
          manifest_matches: true,
          secret_material: false,
        },
        distribution_boundary: {
          automatic_updater_shipped: false,
          runtime_auto_apply_available: false,
          manual_update_only: true,
        },
        authority_boundary: {
          update_metadata_used_for_authority: false,
          rollback_plan_used_for_authority: false,
          used_for_authority: false,
        },
      });

      const snapshotPost = await postJson(ctx.port, "/update/snapshot", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(snapshotPost.status).toBe(405);

      expect((await postJson(ctx.port, "/update/verify", {})).status).toBe(401);
      expect((await postJson(ctx.port, "/update/verify", {}, {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const verify = await postJson(ctx.port, "/update/verify", {}, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({ ok: true, result: { action: "verify_candidate", used_for_authority: false } });

      const prepare = await postJson(ctx.port, "/update/prepare", { confirm: "PRE_UPDATE_BACKUP" }, {
        authorization: `Bearer ${MAINTENANCE_TOKEN}`,
      });
      expect(prepare.status).toBe(200);
      expect(prepare.body).toMatchObject({
        ok: true,
        result: {
          action: "prepare_update",
          pre_update_backup_id: "backup-fixture",
          rollback_plan_id: "rollback-fixture",
          used_for_authority: false,
        },
      });
      expect(actions).toEqual(["verify", "prepare:PRE_UPDATE_BACKUP"]);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — HTTP inbound", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects POST /inbound without auth", async () => {
    const r = await postJson(ctx.port, "/inbound", {
      user: "u1",
      content: "hi",
    });
    expect(r.status).toBe(401);
  });

  it("rejects POST /inbound with resume token", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "hi" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(401);
  });

  it("rejects bearer values with prefix, middle, suffix, or length differences", async () => {
    const middle = Math.floor(TOKEN.length / 2);
    const candidates = [
      `x${TOKEN.slice(1)}`,
      `${TOKEN.slice(0, middle)}x${TOKEN.slice(middle + 1)}`,
      `${TOKEN.slice(0, -1)}x`,
      TOKEN.slice(1),
      `${TOKEN}x`,
    ];
    for (const candidate of candidates) {
      const response = await postJson(
        ctx.port,
        "/inbound",
        { user: "u1", content: "hello" },
        { authorization: `Bearer ${candidate}` },
      );
      expect(response.status).toBe(401);
    }
    expect(ctx.received).toHaveLength(0);
  });

  it("accepts POST /inbound with valid auth and separates credential actor from reply destination", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "hello" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.received).toHaveLength(1);
    const got = ctx.received[0]!;
    expect(got.user).toBe("webchat-inbound-token-holder");
    expect(got.metadata?.reply_to).toBe("u1");
  });

  it("does not accept a caller-selected actor label on authenticated inbound", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "forged-owner", actor: "owner", content: "hello" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.user).toBe("webchat-inbound-token-holder");
    expect(ctx.received[0]?.metadata?.reply_to).toBe("forged-owner");
    expect(ctx.received[0]?.metadata).not.toHaveProperty("actor");
  });

  it("rejects direct tool shortcuts from normal WebChat inbound", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: 'tool:shell.exec {"cmd":"git","args":["status"],"cwd":"."}' },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      accepted: false,
      error: "tool_shortcut_not_allowed_on_webchat_inbound",
      operation_core_required: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.received).toHaveLength(0);
  });

  it("keeps owner ingress disabled without a dedicated credential", async () => {
    const r = await postJson(
      ctx.port,
      "/owner/inbound",
      { user: "owner-ui", content: "Review this task" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: "owner_inbound_not_configured" });
    expect(ctx.received).toHaveLength(0);
  });

  it("routes dedicated owner credential input to HDS as a credential-holder class", async () => {
    const ownerCtx = await setup({ owner_token: OWNER_TOKEN });
    try {
      await ownerCtx.ch.start(async (req) => {
        ownerCtx.received.push(req);
      });
      for (const token of [TOKEN, RESUME_TOKEN]) {
        const rejected = await postJson(
          ownerCtx.port,
          "/owner/inbound",
          { user: "owner-ui", content: "Review this task" },
          { authorization: `Bearer ${token}` },
        );
        expect(rejected.status).toBe(401);
      }
      const accepted = await postJson(
        ownerCtx.port,
        "/owner/inbound",
        {
          user: "owner-ui",
          content: "Review this task",
          actor: "owner",
          metadata: { trust_level: "owner", authority: "bypass" },
        },
        { authorization: `Bearer ${OWNER_TOKEN}` },
      );
      expect(accepted.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(ownerCtx.received).toHaveLength(1);
      expect(ownerCtx.received[0]).toMatchObject({
        channel: "webchat",
        user: "webchat-owner-token-holder",
        content: "Review this task",
        metadata: { reply_to: "owner-ui" },
      });
      expect(ownerCtx.received[0]?.metadata).not.toHaveProperty("actor");
      expect(ownerCtx.received[0]?.metadata).not.toHaveProperty("trust_level");
    } finally {
      await ownerCtx.teardown();
    }
  });

  it("routes a bounded delegated-purpose proposal only through the dedicated owner credential", async () => {
    const proposalText = "Exact purpose proposal: retain the delegated objective and record uncertainty.";
    const proposals: Array<{ goal_ref: string; purpose_text: string; actor: string }> = [];
    const ownerCtx = await setup({
      owner_token: OWNER_TOKEN,
      onGoalPurposeChangeProposal: async (input) => {
        proposals.push(input);
        return {
          accepted: true,
          status: "approval_required",
          goal_ref: input.goal_ref,
          prior_version: 4,
          prior_purpose_digest: "a".repeat(64),
          new_purpose_digest: "b".repeat(64),
          request_id: "safe-request-id",
          command_id: "safe-command-id",
        };
      },
    });
    try {
      await ownerCtx.ch.start(async () => undefined);
      const input = { goal_ref: "goal_0000000000000001", purpose_text: proposalText, actor: "forged" };
      expect((await postJson(ownerCtx.port, "/owner/goal-purpose-change", input, {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      expect((await postJson(ownerCtx.port, "/owner/goal-purpose-change", input, {
        authorization: `Bearer ${OWNER_TOKEN}`,
      })).status).toBe(202);
      expect(proposals).toEqual([{
        goal_ref: input.goal_ref,
        purpose_text: proposalText,
        actor: "webchat-owner-token-holder",
      }]);
      const oversized = await postJson(ownerCtx.port, "/owner/goal-purpose-change", {
        goal_ref: input.goal_ref,
        purpose_text: "x".repeat(16 * 1024 + 1),
      }, { authorization: `Bearer ${OWNER_TOKEN}` });
      expect(oversized.status).toBe(413);
      expect(proposals).toHaveLength(1);
      const malformedUnicode = await postJson(ownerCtx.port, "/owner/goal-purpose-change", {
        goal_ref: input.goal_ref,
        purpose_text: "\uD800",
      }, { authorization: `Bearer ${OWNER_TOKEN}` });
      expect(malformedUnicode.status).toBe(400);
      expect(proposals).toHaveLength(1);
    } finally {
      await ownerCtx.teardown();
    }
  });

  it("routes a task-purpose relation review only through the dedicated owner credential", async () => {
    const proposals: Array<{ plan_id_digest: string; revision_digest: string; outcome: string; actor: string }> = [];
    const ownerCtx = await setup({
      owner_token: OWNER_TOKEN,
      onGoalPurposeRelationReviewProposal: async (input) => {
        proposals.push(input);
        return {
          accepted: true,
          status: "approval_required",
          plan_id_digest: input.plan_id_digest,
          outcome: input.outcome,
          request_id: "relation-request-id",
          command_id: "relation-command-id",
        };
      },
    });
    try {
      await ownerCtx.ch.start(async () => undefined);
      const input = {
        plan_id_digest: "a".repeat(64),
        revision_digest: "b".repeat(64),
        outcome: "supports",
        actor: "forged",
      };
      expect((await postJson(ownerCtx.port, "/owner/goal-purpose-relation-review", input, {
        authorization: `Bearer ${TOKEN}`,
      })).status).toBe(401);
      const accepted = await postJson(ownerCtx.port, "/owner/goal-purpose-relation-review", input, {
        authorization: `Bearer ${OWNER_TOKEN}`,
      });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({
        accepted: true,
        status: "approval_required",
        command_id: "relation-command-id",
      });
      expect(proposals).toEqual([{
        plan_id_digest: input.plan_id_digest,
        revision_digest: input.revision_digest,
        outcome: "supports",
        actor: "webchat-owner-token-holder",
      }]);
      expect((await postJson(ownerCtx.port, "/owner/goal-purpose-relation-review", {
        ...input, outcome: "APPROVE",
      }, { authorization: `Bearer ${OWNER_TOKEN}` })).status).toBe(400);
      expect((await postJson(ownerCtx.port, "/owner/goal-purpose-relation-review", {
        ...input, plan_id_digest: "not-a-digest",
      }, { authorization: `Bearer ${OWNER_TOKEN}` })).status).toBe(400);
      expect(proposals).toHaveLength(1);
    } finally {
      await ownerCtx.teardown();
    }
  });

  it("/healthz needs no auth", async () => {
    const r = await getRaw(ctx.port, "/healthz");
    expect(r.status).toBe(200);
  });
});

describe("WebChatChannel - HTTP webhook inbound", () => {
  it("keeps /webhook disabled unless a dedicated token is configured", async () => {
    const ctx = await setup();
    try {
      await ctx.ch.start(async () => undefined);
      const r = await postJson(
        ctx.port,
        "/webhook",
        { content: "ci event" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: "webhook_not_configured" });
    } finally {
      await ctx.teardown();
    }
  });

  it("rejects /webhook without the webhook token", async () => {
    const ctx = await setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async () => undefined);
      expect((await postJson(ctx.port, "/webhook", { content: "x" })).status).toBe(401);
      expect(
        (
          await postJson(
            ctx.port,
            "/webhook",
            { content: "x" },
            { authorization: `Bearer ${TOKEN}` },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await postJson(
            ctx.port,
            "/webhook",
            { content: "x" },
            { authorization: `Bearer ${RESUME_TOKEN}` },
          )
        ).status,
      ).toBe(401);
    } finally {
      await ctx.teardown();
    }
  });

  it("normalizes webhook content without accepting authority metadata", async () => {
    const ctx = await setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async (req) => {
        ctx.received.push(req);
      });
      const r = await postJson(
        ctx.port,
        "/webhook",
        {
          user: "ci-bot",
          source: "github-actions",
          reply_to: "ops",
          content: "deploy finished",
          metadata: {
            actor: "admin",
            trust: "full",
            authority_context: "bypass",
          },
        },
        { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      const got = ctx.received[0]!;
      expect(got.channel).toBe("webchat");
      expect(got.user).toBe("webchat-webhook-token-holder");
      expect(got.content).toBe("deploy finished");
      expect(got.metadata).toEqual({
        reply_to: "ops",
        webhook_source: "github-actions",
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("can turn a JSON event into canonical inbound content", async () => {
    const ctx = await setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async (req) => {
        ctx.received.push(req);
      });
      const r = await postJson(
        ctx.port,
        "/webhook",
        { event: { kind: "build", status: "green" } },
        { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received[0]?.user).toBe("webchat-webhook-token-holder");
      expect(ctx.received[0]?.content).toBe('{"kind":"build","status":"green"}');
      expect(ctx.received[0]?.metadata).toEqual({
        reply_to: "webhook",
        webhook_source: "generic",
      });
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — /ws-ticket", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects /ws-ticket without auth", async () => {
    const r = await postJson(ctx.port, "/ws-ticket", { user: "alice" });
    expect(r.status).toBe(401);
  });

  it("rejects /ws-ticket with resume token", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "alice" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(401);
  });

  it("rejects /ws-ticket with missing user", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      {},
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(400);
  });

  it("issues a fresh, base64url-shaped ticket bound to the requested user", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "alice" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ticket: string; expires_in_sec: number };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThanOrEqual(40);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.expires_in_sec).toBeGreaterThan(0);
  });

  it("each /ws-ticket call yields a distinct ticket", async () => {
    const t1 = await getTicket(ctx.port, "alice");
    const t2 = await getTicket(ctx.port, "alice");
    expect(t1).not.toBe(t2);
  });
});

describe("WebChatChannel — settings surface", () => {
  it("serves /settings without exposing config JSON", async () => {
    const ctx = await setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html><title>Settings</title>",
        getSnapshot: async () => ({ ok: true }),
      },
    });
    await ctx.ch.start(async () => {});
    const r = await getRaw(ctx.port, "/settings");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Settings");
    await ctx.teardown();
  });

  it("requires the dedicated settings token for /settings/config", async () => {
    const ctx = await setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ provider: "stub" }),
      },
    });
    await ctx.ch.start(async () => {});

    expect((await getRaw(ctx.port, "/settings/config")).status).toBe(401);
    expect(
      (await getRaw(ctx.port, "/settings/config", {
        authorization: `Bearer ${TOKEN}`,
      })).status,
    ).toBe(401);
    const ok = await getRaw(ctx.port, "/settings/config", {
      authorization: `Bearer ${SETTINGS_TOKEN}`,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ provider: "stub" });
    await ctx.teardown();
  });

  it("routes POST /settings/config to the settings update handler", async () => {
    const updates: unknown[] = [];
    const ctx = await setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ ok: true }),
        update: async (body) => {
          updates.push(body);
          return { restart_required: true };
        },
      },
    });
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/settings/config",
      { llm: { provider: "stub" } },
      { authorization: `Bearer ${SETTINGS_TOKEN}` },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      result: { restart_required: true },
    });
    expect(updates).toEqual([{ llm: { provider: "stub" } }]);
    await ctx.teardown();
  });

  it("routes POST /settings/llm/verify to the non-mutating verify handler", async () => {
    const verifyBodies: unknown[] = [];
    const ctx = await setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ ok: true }),
        verifyLlm: async (body) => {
          verifyBodies.push(body);
          return { status: "pass", changed: false };
        },
      },
    });
    await ctx.ch.start(async () => {});
    expect((await postJson(ctx.port, "/settings/llm/verify", {}, {
      authorization: `Bearer ${TOKEN}`,
    })).status).toBe(401);

    const r = await postJson(
      ctx.port,
      "/settings/llm/verify",
      { llm: { provider: "stub" } },
      { authorization: `Bearer ${SETTINGS_TOKEN}` },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      result: { status: "pass", changed: false },
    });
    expect(verifyBodies).toEqual([{ llm: { provider: "stub" } }]);
    await ctx.teardown();
  });
});

describe("WebChatChannel — audit dump API", () => {
  it("serves read-only audit dump only with the inbound token", async () => {
    const ctx = await setup({
      audit: {
        dump: async (format) => ({
          content_type:
            format === "text"
              ? "text/plain; charset=utf-8"
              : "application/json",
          body:
            format === "text"
              ? "blue-tanuki audit-dump — OK"
              : JSON.stringify({ status: "ok", entry_count: 1 }),
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/audit/dump")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/audit/dump", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const json = await getRaw(ctx.port, "/audit/dump", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(json.status).toBe(200);
      expect(JSON.parse(json.text)).toEqual({ status: "ok", entry_count: 1 });

      const text = await getRaw(ctx.port, "/audit/dump?format=text", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(text.status).toBe(200);
      expect(text.text).toContain("blue-tanuki audit-dump");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /audit/dump", async () => {
    const ctx = await setup({
      audit: {
        dump: async () => ({
          content_type: "application/json",
          body: JSON.stringify({ status: "ok" }),
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/audit/dump",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — runtime snapshot API", () => {
  it("serves safe first-run status only with the inbound token", async () => {
    const ctx = await setup({
      runtime: {
        getSnapshot: async () => ({
          gateway_status: "running",
          hds_invariants_ok: true,
          webchat_ready: true,
          telegram_configured: false,
          pending_approvals_count: 1,
          runtime_schedules_count: 2,
          pending_schedule_approvals_count: 1,
          audit_chain_valid: true,
          next_recommended_action: "Review pending approvals in Control Center",
          scheduled_tasks: [{ id: "safe", payload_hash: "abc123" }],
          operation_plan_status: {
            schema_version: "operation-plan.status.v1",
            evidence_source: ["INTERNAL_STATE"],
            used_for_authority: false,
            raw_payload_exposed: false,
            status: "available",
            plan_count: 1,
            displayed_count: 1,
            plans: [{ plan_id: "a".repeat(64), revision: 2, revision_digest: "b".repeat(64),
              status: "awaiting_step_review", step_count: 1,
              steps: [{ step_id: "c".repeat(64), operation: "gmail.write", status: "outcome_unknown",
                external_receipt_observation: "not_recorded", binding: { command_digest: "d".repeat(64),
                  result_digest: "e".repeat(64), delivery_digest: "f".repeat(64), memory_status: "not_recorded" } }] }],
          },
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/runtime/snapshot")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/runtime/snapshot", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/runtime/snapshot", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body).toMatchObject({
        gateway_status: "running",
        hds_invariants_ok: true,
        webchat_ready: true,
        telegram_configured: false,
        pending_approvals_count: 1,
        runtime_schedules_count: 2,
        pending_schedule_approvals_count: 1,
        audit_chain_valid: true,
        operation_plan_status: { status: "available", used_for_authority: false, raw_payload_exposed: false,
          plans: [{ steps: [{ status: "outcome_unknown", external_receipt_observation: "not_recorded" }] }] },
      });
      expect(JSON.stringify(body)).not.toContain("private schedule content");
      expect(JSON.stringify(body)).not.toContain(RESUME_TOKEN);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /runtime/snapshot", async () => {
    const ctx = await setup({
      runtime: {
        getSnapshot: async () => ({ gateway_status: "running" }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/runtime/snapshot",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — authority trace API", () => {
  it("serves read-only authority trace only with the inbound token", async () => {
    const ctx = await setup({
      authority: {
        trace: async () => [
          {
            index: 3,
            entry_hash: "abc123",
            kind: "authority_event",
            event: "approval_allowed",
            request_id: "req-1",
            command_id: "cmd-1",
            actor: "alice",
            operation: "tool.file.write",
            risk: "medium",
            reason: "default_full_access_without_final_review_exception",
            timestamp: 12345,
          },
          {
            index: 4,
            entry_hash: "def456",
            kind: "memory_citation_review",
            event: "memory.citation_review",
            request_id: "req-2",
            command_id: "cmd-2",
            search_plan_id: "a".repeat(64),
            application_scope_id: "b".repeat(64),
            status: "accepted",
            candidate_count: 2,
            candidate_references: [
              { record_id: "F:source-a", version: "c".repeat(64) },
              { record_id: "F:source-b", version: "d".repeat(64) },
            ],
            projection_records: [
              {
                reference: { record_id: "F:source-a", version: "c".repeat(64) },
                disposition: "adopted",
                reason: "accepted_citation",
              },
              {
                reference: { record_id: "F:source-b", version: "d".repeat(64) },
                disposition: "adopted",
                reason: "accepted_citation",
              },
              {
                reference: { record_id: "F:source-c", version: "2".repeat(64) },
                disposition: "excluded_from_context",
                reason: "explicit_reference_scope",
              },
            ],
            accepted_citations: [{
              claim_digest: "e".repeat(64),
              supporting: { record_id: "F:source-a", version: "c".repeat(64) },
              counterevidence: { record_id: "F:source-b", version: "d".repeat(64) },
            }],
            rejected_proposal_count: 0,
            rejection_reasons: [],
            source_result_digest: "f".repeat(64),
            reviewed_content_digest: "1".repeat(64),
            used_for_authority: false,
            timestamp: 12346,
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/authority/trace")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/authority/trace", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/authority/trace", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.authority_trace).toHaveLength(2);
      expect(body.authority_trace[0]).toMatchObject({
        kind: "authority_event",
        event: "approval_allowed",
        request_id: "req-1",
        command_id: "cmd-1",
        actor: "alice",
      });
      expect(body.authority_trace[1]).toMatchObject({
        kind: "memory_citation_review",
        event: "memory.citation_review",
        request_id: "req-2",
        command_id: "cmd-2",
        status: "accepted",
        candidate_count: 2,
        used_for_authority: false,
      });
      expect(body.authority_trace[1].projection_records).toContainEqual(expect.objectContaining({
        reference: { record_id: "F:source-c", version: "2".repeat(64) },
        disposition: "excluded_from_context",
      }));
      expect(body.authority_trace[1]).not.toHaveProperty("claim");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /authority/trace", async () => {
    const ctx = await setup({
      authority: {
        trace: async () => [],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/authority/trace",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — approval API", () => {
  it("reveals pending content only through the explicit resume-authenticated review route", async () => {
    let reviewCalls = 0;
    const ctx = await setup({
      approval: {
        list: async () => [{
          command_id: "cmd-content",
          request_id: "req-content",
          operation: "gmail.write",
          risk: "high",
          final_review_required: true,
          reason: "final_review_required",
          content_review_required: true,
        }],
        reviewContent: async (command_id) => {
          reviewCalls += 1;
          return command_id === "cmd-content" ? {
            command_id,
            command_digest: "a".repeat(64),
            request_payload_digest: "b".repeat(64),
            operation: "gmail.write.message.send",
            to: "owner@example.test",
            subject: "synthetic subject",
            body_text: "synthetic body",
            used_for_authority: false,
          } : null;
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await postJson(ctx.port, "/approval/cmd-content/content", {})).status).toBe(401);
      expect(reviewCalls).toBe(0);

      const response = await fetch(`http://127.0.0.1:${ctx.port}/approval/cmd-content/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toMatchObject({
        command_id: "cmd-content",
        command_digest: "a".repeat(64),
        to: "owner@example.test",
        subject: "synthetic subject",
        body_text: "synthetic body",
        used_for_authority: false,
      });

      const queue = await getRaw(ctx.port, "/approval", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(queue.text).not.toContain("synthetic body");
      expect(reviewCalls).toBe(1);
    } finally {
      await ctx.teardown();
    }
  });

  it("reveals exact draft.create content only through the explicit review route", async () => {
    const draftBody = "synthetic draft body";
    const digest = "d".repeat(64);
    const ctx = await setup({
      approval: {
        list: async () => [{
          command_id: "cmd-draft-review",
          request_id: "req-draft-review",
          operation: "gmail.write.draft.create",
          risk: "high",
          final_review_required: true,
          reason: "final_review_required",
          content_review_required: true,
        }],
        reviewContent: async (command_id) => command_id === "cmd-draft-review" ? {
          command_id,
          command_digest: digest,
          request_payload_digest: "e".repeat(64),
          operation: "gmail.write.draft.create",
          to: "recipient@example.test",
          subject: "synthetic draft subject",
          body_text: draftBody,
          used_for_authority: false,
        } : null,
        validateContentReview: async (_command_id, submitted) => submitted === digest ? "valid" : "required",
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const queue = await getRaw(ctx.port, "/approval", { authorization: `Bearer ${RESUME_TOKEN}` });
      expect(queue.text).not.toContain(draftBody);
      expect(queue.text).toContain("gmail.write.draft.create");

      const response = await fetch(`http://127.0.0.1:${ctx.port}/approval/cmd-draft-review/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        operation: "gmail.write.draft.create",
        to: "recipient@example.test",
        subject: "synthetic draft subject",
        body_text: draftBody,
        used_for_authority: false,
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("reveals existing draft.send content and provider digests through resume-authenticated no-store review", async () => {
    const draftBody = "synthetic existing draft body";
    const commandDigest = "f".repeat(64);
    const reviewDigest = "1".repeat(64);
    const calls: unknown[] = [];
    const ctx = await setup({
      approval: {
        list: async () => [{
          command_id: "cmd-existing-draft-send",
          request_id: "req-existing-draft-send",
          operation: "gmail.write.draft.send",
          risk: "high",
          final_review_required: true,
          reason: "final_review_required",
          content_review_required: true,
        }],
        reviewContent: async (command_id) => command_id === "cmd-existing-draft-send" ? {
          kind: "gmail_write_content",
          command_id,
          command_digest: commandDigest,
          review_digest: reviewDigest,
          request_payload_digest: "2".repeat(64),
          provider_state_digest: "3".repeat(64),
          provider_raw_digest: "4".repeat(64),
          account_email: "owner@example.test",
          operation: "gmail.write.draft.send",
          from: "sender@example.test",
          to: "recipient@example.test",
          cc: "copy@example.test",
          bcc: "hidden@example.test",
          reply_to: "replies@example.test",
          subject: "synthetic existing subject",
          body_text: draftBody,
          used_for_authority: false,
        } : null,
        validateContentReview: async (_command_id, submitted) => submitted === reviewDigest ? "valid" : "required",
      },
      onResume: async (id, verdict, resumeCtx) => { calls.push({ id, verdict, resumeCtx }); return { handled: true }; },
    });
    await ctx.ch.start(async () => {});
    try {
      const queue = await getRaw(ctx.port, "/approval", { authorization: `Bearer ${RESUME_TOKEN}` });
      expect(queue.text).not.toContain(draftBody);

      const review = await fetch(`http://127.0.0.1:${ctx.port}/approval/cmd-existing-draft-send/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(review.status).toBe(200);
      expect(review.headers.get("cache-control")).toBe("no-store");
      expect(await review.json()).toMatchObject({
        operation: "gmail.write.draft.send",
        account_email: "owner@example.test",
        from: "sender@example.test",
        to: "recipient@example.test",
        cc: "copy@example.test",
        bcc: "hidden@example.test",
        reply_to: "replies@example.test",
        subject: "synthetic existing subject",
        body_text: draftBody,
        provider_state_digest: "3".repeat(64),
        provider_raw_digest: "4".repeat(64),
        used_for_authority: false,
      });

      const issued = await ctx.ch.issueResumeApprovalToken("cmd-existing-draft-send");
      const approved = await postJson(ctx.port, "/approval/cmd-existing-draft-send", {
        verdict: "approve", approval_token: issued?.token, content_review_digest: reviewDigest,
      }, { authorization: `Bearer ${RESUME_TOKEN}` });
      expect(approved.status).toBe(200);
      expect(calls).toMatchObject([{ id: "cmd-existing-draft-send", verdict: "approve",
        resumeCtx: { content_review_digest: reviewDigest, actor: "webchat-resume-token-holder" } }]);
    } finally {
      await ctx.teardown();
    }
  });

  it("validates content binding before consuming the one-time approval token", async () => {
    const calls: unknown[] = [];
    const digest = "c".repeat(64);
    let revealedDigest: string | undefined;
    const ctx = await setup({
      approval: {
        list: async () => [],
        reviewContent: async (id) => {
          if (id !== "cmd-content-approve") return null;
          revealedDigest = digest;
          return {
            command_id: id,
            command_digest: digest,
            request_payload_digest: "b".repeat(64),
            operation: "gmail.write.message.send",
            to: "owner@example.test",
            subject: "synthetic subject",
            body_text: "synthetic body",
            used_for_authority: false,
          };
        },
        validateContentReview: async (_id, submitted) => {
          if (!revealedDigest || !submitted) return "required";
          return submitted === revealedDigest ? "valid" : "stale";
        },
      },
      onResume: async (id, verdict, resumeCtx) => {
        calls.push({ id, verdict, resumeCtx });
        return { handled: true };
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const issued = await ctx.ch.issueResumeApprovalToken("cmd-content-approve");
      const missing = await postJson(
        ctx.port,
        "/approval/cmd-content-approve",
        { verdict: "approve", approval_token: issued?.token },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(missing.status).toBe(409);
      expect(missing.body).toEqual({ error: "approval_content_review_required" });

      const guessed = await postJson(
        ctx.port,
        "/approval/cmd-content-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
          content_review_digest: digest,
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(guessed.status).toBe(409);

      const review = await postJson(
        ctx.port,
        "/approval/cmd-content-approve/content",
        {},
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(review.status).toBe(200);

      const approved = await postJson(
        ctx.port,
        "/approval/cmd-content-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
          content_review_digest: digest,
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(approved.status).toBe(200);
      expect(calls).toEqual([{
        id: "cmd-content-approve",
        verdict: "approve",
        resumeCtx: {
          actor: "webchat-resume-token-holder",
          token_kind: "resume",
          content_review_digest: digest,
          approval: undefined,
        },
      }]);
    } finally {
      await ctx.teardown();
    }
  });

  it("lists pending approvals only with the resume token", async () => {
    const ctx = await setup({
      approval: {
        list: async () => [
          {
            command_id: "cmd-1",
            request_id: "req-1",
            operation: "tool.shell.exec",
            risk: "high",
            final_review_required: true,
            reason: "final_review_required",
            approval_token: "one-time-token",
            approval_token_expires_at_ms: 12345,
            authority_trace: { black_box_boundary: "none_in_hds_authority_path" },
            operation_core: {
              version: "operation-core.v1",
              role: "approval_gate_trace",
              operation: "tool.shell.exec",
              state: "awaiting_permission",
              target: {
                kind: "runtime",
                id: "tool:shell.exec",
                scope: "shell_adapter",
              },
              effects: ["process_spawn"],
              permission: {
                risk: "high",
                approval_level: "L3_final_review",
                final_review_required: true,
                hds_brain_authority_required: true,
                approval_gate_required: true,
              },
              adapter: "shell",
              runtime_boundary: "shell_adapter",
              adapter_is_authority: false,
              command_generated_by_adapter_only: true,
              raw_command_is_core_operation: false,
              adapter_result_used_for_authority: false,
              approval_trace_used_for_authority: false,
              hds_brain_authority_required: true,
              evidence_source: ["INTERNAL_STATE"],
            },
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/approval")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/approval", {
          authorization: `Bearer ${TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/approval", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.pending_approvals).toHaveLength(1);
      expect(body.pending_approvals[0]).toMatchObject({
        command_id: "cmd-1",
        request_id: "req-1",
        operation: "tool.shell.exec",
        risk: "high",
        operation_core: {
          role: "approval_gate_trace",
          adapter: "shell",
          runtime_boundary: "shell_adapter",
          approval_trace_used_for_authority: false,
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("returns exact no-replay event identity and eligibility in the approval queue", async () => {
    const ctx = await setup({
      approval: {
        list: async () => [{
          command_id: "cmd-cron-resolution",
          request_id: "req-cron-resolution",
          operation: "schedule.resolve_event",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
          reason: "final_review_required",
          approval_token: "one-time-token",
          cron_no_replay_review: {
            kind: "cron_no_replay",
            status: "eligible",
            event_id: `cron-${"a".repeat(64)}`,
            payload_digest: "b".repeat(64),
            delivery_state: "outcome_unknown",
            disposition: "acknowledge_no_replay",
            original_outcome: "unknown",
            eligible: true,
          },
        }],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const response = await getRaw(ctx.port, "/approval", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).pending_approvals[0]).toMatchObject({
        operation: "schedule.resolve_event",
        cron_no_replay_review: {
          kind: "cron_no_replay",
          event_id: `cron-${"a".repeat(64)}`,
          payload_digest: "b".repeat(64),
          delivery_state: "outcome_unknown",
          disposition: "acknowledge_no_replay",
          original_outcome: "unknown",
          eligible: true,
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("routes POST /approval/:id through the same one-time resume approval gate", async () => {
    const calls: unknown[] = [];
    const ctx = await setup({
      onResume: async (id, verdict, resumeCtx) => {
        calls.push({ id, verdict, resumeCtx });
        return { handled: true };
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const issued = await ctx.ch.issueResumeApprovalToken("cmd-approve");
      const r = await postJson(
        ctx.port,
        "/approval/cmd-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
          actor: "forged-owner",
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, result: { handled: true } });
      expect(calls).toEqual([
        {
          id: "cmd-approve",
          verdict: "approve",
          resumeCtx: {
            actor: "webchat-resume-token-holder",
            token_kind: "resume",
            approval: undefined,
          },
        },
      ]);

      const replay = await postJson(
        ctx.port,
        "/approval/cmd-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(replay.status).toBe(403);
    } finally {
      await ctx.teardown();
    }
  });

  it("exposes grants, approval history, and emergency stop through the resume-token gate", async () => {
    const calls: unknown[] = [];
    const ctx = await setup({
      approval: {
        list: async () => [],
        grants: async () => [
          {
            id: "grant-1",
            mode: "remember_this_decision",
            decision: "allow",
            operation: "tool.file.write",
            target_scope: "file",
            target: "docs/a.md",
            risk: "medium",
            actor: "alice",
            created_by: "alice",
            created_at: 1,
            expires_at: null,
            revocable: true,
          },
        ],
        revokeGrant: async (grant_id, controlCtx) => {
          calls.push({ kind: "revoke", grant_id, controlCtx });
          return { revoked: true };
        },
        history: async () => [
          {
            index: 1,
            event: "grant_revoked",
            request_id: null,
            command_id: null,
            grant_id: "grant-1",
            actor: "alice",
            decision: "allow",
            operation: "tool.file.write",
            risk: "medium",
            approval_level: "L2_operate",
            final_review_required: false,
            reason: "test",
            timestamp: 2,
            payload_digest: "digest",
            used_for_authority: false,
          },
        ],
        emergencyStop: {
          getSnapshot: async () => ({
            active: false,
            activated_at: null,
            activated_by: null,
            reason: null,
            cleared_at: null,
            cleared_by: null,
            clear_reason: null,
            execution_blocked: false,
            hds_brain_remains_authority: true,
            used_for_authority: false,
            evidence_source: ["INTERNAL_STATE", "LIVE_RUNTIME"],
          }),
          activate: async (controlCtx) => {
            calls.push({ kind: "activate", controlCtx });
            return { active: true };
          },
          clear: async (controlCtx) => {
            calls.push({ kind: "clear", controlCtx });
            return { active: false };
          },
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const root = await getRaw(ctx.port, "/approval", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(root.status).toBe(200);
      const rootBody = JSON.parse(root.text);
      expect(rootBody.grants).toHaveLength(1);
      expect(rootBody.approval_history).toHaveLength(1);
      expect(rootBody.emergency_stop).toMatchObject({
        active: false,
        used_for_authority: false,
      });

      const grants = await getRaw(ctx.port, "/approval/grants", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(grants.status).toBe(200);
      expect(JSON.parse(grants.text).grants[0].id).toBe("grant-1");

      const revoke = await postJson(
        ctx.port,
        "/approval/grants/grant-1/revoke",
        { actor: "alice", reason: "not needed" },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(revoke.status).toBe(200);

      const stop = await postJson(
        ctx.port,
        "/approval/emergency-stop",
        { action: "activate", actor: "alice", reason: "stop now" },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(stop.status).toBe(200);

      const clear = await postJson(
        ctx.port,
        "/approval/emergency-stop",
        { action: "clear", actor: "alice", reason: "reviewed" },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(clear.status).toBe(200);

      expect(calls).toEqual([
        {
          kind: "revoke",
          grant_id: "grant-1",
          controlCtx: {
            actor: "alice",
            token_kind: "resume",
            reason: "not needed",
          },
        },
        {
          kind: "activate",
          controlCtx: {
            actor: "alice",
            token_kind: "resume",
            reason: "stop now",
          },
        },
        {
          kind: "clear",
          controlCtx: {
            actor: "alice",
            token_kind: "resume",
            reason: "reviewed",
          },
        },
      ]);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — WS upgrade with ticket", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects WS upgrade without ticket", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
        ws.once("error", () => resolve());
        ws.once("open", () => {
          ws.close();
          reject(new Error("expected upgrade rejection"));
        });
        setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects WS upgrade with unknown ticket", async () => {
    await expect(
      openWsWithTicket(ctx.port, "totally-bogus-ticket"),
    ).rejects.toThrow();
  });

  it("accepts WS upgrade with valid ticket and pushes hello bound to that user", async () => {
    const ticket = await getTicket(ctx.port, "alice");
    const ws = await openWsWithTicket(ctx.port, ticket);
    // openWsWithTicket already drained the hello frame.
    expect(ctx.ch.connectionCount("alice")).toBe(1);
    ws.close();
    await waitForConnectionCount(ctx.ch, "alice", 0);
  });

  it("ticket is single-use: second WS attempt with same ticket fails", async () => {
    const ticket = await getTicket(ctx.port, "alice");
    const ws1 = await openWsWithTicket(ctx.port, ticket);
    await expect(openWsWithTicket(ctx.port, ticket)).rejects.toThrow();
    ws1.close();
  });

  it("expired ticket is rejected", async () => {
    const shortCtx = await setup({ ws_ticket_ttl_ms: 1000 });
    await shortCtx.ch.start(async () => {});
    const ticket = await getTicket(shortCtx.port, "alice");
    // Wait for expiry.
    await new Promise((r) => setTimeout(r, 1100));
    await expect(openWsWithTicket(shortCtx.port, ticket)).rejects.toThrow();
    await shortCtx.teardown();
  });

  it("legacy ?token=&user= form is no longer accepted", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${ctx.port}/ws?token=${TOKEN}&user=alice`,
        );
        ws.once("error", () => resolve());
        ws.once("open", () => {
          ws.close();
          reject(new Error("legacy form should not connect"));
        });
        setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ).resolves.toBeUndefined();
  });
});

describe("WebChatChannel — outbound over WS", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("send() pushes channel_send frames to all conns of target user", async () => {
    const t1 = await getTicket(ctx.port, "u1");
    const ws1 = await openWsWithTicket(ctx.port, t1);
    const t2 = await getTicket(ctx.port, "u1");
    const ws2 = await openWsWithTicket(ctx.port, t2);

    const p1 = readWsMessage(ws1);
    const p2 = readWsMessage(ws2);

    const meta: SendMeta = {
      command_id: "cmd-X",
      upstream_commit_hash: "hash-Y",
    };
    const result = await ctx.ch.send(
      { channel: "webchat", target: "u1", content: "hi from server" },
      meta,
    );
    expect(result.delivered).toBe(true);

    const m1 = (await p1) as { kind: string; content: string };
    const m2 = (await p2) as { kind: string; content: string };
    expect(m1.kind).toBe("channel_send");
    expect(m1.content).toBe("hi from server");
    expect(m2.content).toBe("hi from server");

    ws1.close();
    ws2.close();
  });

  it("send() returns delivered=false when target has no connections", async () => {
    const result = await ctx.ch.send(
      { channel: "webchat", target: "ghost", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(result.delivered).toBe(false);
    expect(result.error).toBe("no_active_connection");
  });
});

describe("WebChatChannel — POST /resume", () => {
  it("returns 501 when onResume not configured", async () => {
    const ctx = await setup();
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/resume",
      { request_id: "x", verdict: "approve" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(501);
    await ctx.teardown();
  });

  it("rejects /resume with inbound token", async () => {
    const ctx = await setup({
      onResume: async () => ({ ok: true }),
    });
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(401);
    await ctx.teardown();
  });

  it("forwards to onResume and echoes result", async () => {
    const calls: Array<{ id: string; v: string; actor: string; token_kind: string }> = [];
    const ctx = await setup({
      onResume: async (id, v, resumeCtx) => {
        calls.push({ id, v, actor: resumeCtx.actor, token_kind: resumeCtx.token_kind });
        return { decision: v === "approve" ? "ASSERT" : "FAIL" };
      },
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    const r = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rA",
        verdict: "approve",
        actor: "forged-owner",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; result: { decision: string } };
    expect(body.ok).toBe(true);
    expect(body.result.decision).toBe("ASSERT");
    expect(calls).toEqual([
      { id: "rA", v: "approve", actor: "webchat-resume-token-holder", token_kind: "resume" },
    ]);
    await ctx.teardown();
  });

  it("requires a request-bound one-time approval token", async () => {
    const calls: string[] = [];
    const ctx = await setup({
      onResume: async (id) => {
        calls.push(id);
        return { ok: true };
      },
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");

    const missing = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(missing.status).toBe(400);

    const wrongRequest = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rB",
        verdict: "approve",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(wrongRequest.status).toBe(403);

    const burned = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rA",
        verdict: "approve",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(burned.status).toBe(403);
    expect(calls).toEqual([]);
    await ctx.teardown();
  });

  it("consumes approval tokens exactly once", async () => {
    const ctx = await setup({
      onResume: async () => ({ ok: true }),
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    const body = {
      request_id: "rA",
      verdict: "approve",
      approval_token: issued?.token,
    };
    const first = await postJson(ctx.port, "/resume", body, {
      authorization: `Bearer ${RESUME_TOKEN}`,
    });
    const second = await postJson(ctx.port, "/resume", body, {
      authorization: `Bearer ${RESUME_TOKEN}`,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    await ctx.teardown();
  });
});

describe("WebChatChannel — rate limiting", () => {
  it("/inbound returns 429 with Retry-After when capacity is exceeded", async () => {
    const ctx = await setup({
      rate_limits: {
        // capacity 2, refill very slow → 3rd call gets 429 deterministically.
        inbound: { capacity: 2, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });

    const auth = { authorization: `Bearer ${TOKEN}` };
    const r1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "a" },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "b" },
      auth,
    );
    const r3 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "c" },
      auth,
    );
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(429);
    const body = r3.body as { error: string; retry_after_ms: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after_ms).toBeGreaterThan(0);
    await ctx.teardown();
  });

  it("/inbound rate limit is per-user (independent buckets)", async () => {
    const ctx = await setup({
      rate_limits: {
        inbound: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const a1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "alice", content: "x" },
      auth,
    );
    const b1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "bob", content: "y" },
      auth,
    );
    const a2 = await postJson(
      ctx.port,
      "/inbound",
      { user: "alice", content: "x2" },
      auth,
    );
    expect(a1.status).toBe(202);
    expect(b1.status).toBe(202); // bob's bucket independent
    expect(a2.status).toBe(429); // alice's bucket exhausted
    await ctx.teardown();
  });

  it("/ws-ticket returns 429 when capacity is exceeded", async () => {
    const ctx = await setup({
      rate_limits: {
        ws_ticket: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    const r1 = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "u" },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "u" },
      auth,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    await ctx.teardown();
  });

  it("/resume rate-limit uses a single global bucket", async () => {
    const ctx = await setup({
      onResume: async () => ({ ok: true }),
      rate_limits: {
        resume: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${RESUME_TOKEN}` };
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    // Two distinct request_ids — should still share one bucket (global key).
    const r1 = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve", approval_token: issued?.token },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rB", verdict: "approve" },
      auth,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    await ctx.teardown();
  });

  it("rate_limits: false fully disables limiting", async () => {
    const ctx = await setup({ rate_limits: false });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    // Hammer /ws-ticket far above any default capacity.
    for (let i = 0; i < 50; i++) {
      const r = await postJson(
        ctx.port,
        "/ws-ticket",
        { user: "u" },
        auth,
      );
      expect(r.status).toBe(200);
    }
    await ctx.teardown();
  });

  it("Retry-After header is present and positive on 429", async () => {
    const ctx = await setup({
      rate_limits: {
        ws_ticket: { capacity: 1, refill_per_sec: 0.5 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    await postJson(ctx.port, "/ws-ticket", { user: "u" }, auth);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ user: "u" }),
    });
    expect(res.status).toBe(429);
    const ra = res.headers.get("retry-after");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThanOrEqual(1);
    await ctx.teardown();
  });
});

describe("WebChatChannel — TicketStore injection", () => {
  it("uses an injected ticket store for issue/consume", async () => {
    const inner = new MemoryTicketStore({ cap: 5 });
    let issueCalls = 0;
    let consumeCalls = 0;
    const wrapped: TicketStore = {
      issue: async (u, ttl) => {
        issueCalls += 1;
        return inner.issue(u, ttl);
      },
      consume: async (t) => {
        consumeCalls += 1;
        return inner.consume(t);
      },
      size: () => inner.size(),
    };
    const ctx = await setup({ ticket_store: wrapped });
    await ctx.ch.start(async () => {});

    const ticket = await getTicket(ctx.port, "alice");
    expect(issueCalls).toBe(1);
    const ws = await openWsWithTicket(ctx.port, ticket);
    expect(consumeCalls).toBeGreaterThanOrEqual(1);
    expect(ctx.ch.connectionCount("alice")).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await ctx.teardown();
  });
});

describe("WebChatChannel — rate-limit prune", () => {
  it("periodically drops idle full buckets", async () => {
    const p = await allocateTestPort();
    const ch = new WebChatChannel({
      port: p,
      token: TOKEN,
      host: "127.0.0.1",
      // Generous capacity & high refill so a single consume re-fills
      // immediately and the entry becomes prune-eligible by the next sweep.
      rate_limits: {
        inbound: { capacity: 100, refill_per_sec: 1000 },
        resume: { capacity: 100, refill_per_sec: 1000 },
        ws_ticket: { capacity: 100, refill_per_sec: 1000 },
      },
      // Prune very frequently for the test, with a tiny idle threshold.
      rate_limit_prune_interval_ms: 30,
      rate_limit_prune_idle_ms: 10,
    });
    await ch.start(async () => {});
    try {
      // Issue a few tickets for distinct users to populate the ws_ticket bucket.
      for (const u of ["a", "b", "c"]) {
        const r = await postJson(p, "/ws-ticket", { user: u }, {
          authorization: `Bearer ${TOKEN}`,
        });
        expect(r.status).toBe(200);
      }
      // Wait long enough for at least 2 prune sweeps + idle threshold.
      await new Promise((r) => setTimeout(r, 120));
      // After prune, ws_ticket bucket should have dropped the per-user
      // entries (each is conceptually full again after one consume +
      // 1000 refill/sec for >10ms).
      // We verify by reaching into the bucket via a fresh post to
      // confirm no errors and that handling continues normally.
      const r = await postJson(p, "/ws-ticket", { user: "d" }, {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(r.status).toBe(200);
    } finally {
      await ch.stop();
    }
  });

  it("does not start a prune timer when interval is 0", async () => {
    const p = await allocateTestPort();
    const ch = new WebChatChannel({
      port: p,
      token: TOKEN,
      host: "127.0.0.1",
      rate_limit_prune_interval_ms: 0,
    });
    await ch.start(async () => {});
    // No assertion on internal state; this test exists primarily to
    // ensure no unhandled error surfaces when interval=0 is configured.
    await ch.stop();
  });
});

describe("WebChatChannel - resident notifications API", () => {
  it("serves display-only notifications only with the inbound token", async () => {
    const ctx = await setup({
      notifications: {
        list: async () => [
          {
            id: "approval:cmd-1",
            kind: "approval_required",
            severity: "action_required",
            title: "Approval required",
            message: "tool.shell.exec is waiting for owner review.",
            timestamp: 12345,
            source: "approval_queue",
            read_only: true,
            authority: "display_only",
            request_id: "req-1",
            command_id: "cmd-1",
            approval_level: "L3_final_review",
            risk: "high",
            next_action: "Open Approval Queue.",
          },
          {
            id: "schedule-delivery-unsettled:cron-event-42",
            kind: "schedule_delivery_unknown",
            severity: "warning",
            title: "Schedule delivery result is unsettled",
            message: "Cron event sequence 42 remains outcome_unknown.",
            timestamp: 12346,
            source: "cron_event_cursor",
            read_only: true,
            authority: "display_only",
            request_id: "cron-event-42",
            payload_hash: "b".repeat(64),
            result_correlation_status: "saved_result_linked",
            result_memory_status: "receipt_confirmed",
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/notifications")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/notifications", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/notifications", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.notifications).toHaveLength(2);
      expect(body.notifications[0]).toMatchObject({
        kind: "approval_required",
        severity: "action_required",
        read_only: true,
        authority: "display_only",
        command_id: "cmd-1",
      });
      expect(body.notifications[1]).toMatchObject({
        kind: "schedule_delivery_unknown",
        severity: "warning",
        read_only: true,
        authority: "display_only",
        request_id: "cron-event-42",
        payload_hash: "b".repeat(64),
        result_correlation_status: "saved_result_linked",
        result_memory_status: "receipt_confirmed",
      });
      expect(JSON.stringify(body)).not.toContain("approval_token");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /notifications", async () => {
    const ctx = await setup({
      notifications: {
        list: async () => [],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/notifications",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - complete history replay API", () => {
  it("serves read-only replay metadata only with the inbound token", async () => {
    const filters: unknown[] = [];
    const ctx = await setup({
      history: {
        replay: async (filter) => {
          filters.push(filter);
          return {
            schema_version: "phase12-s2-complete-history-v1",
            entries_count: 1,
            skipped_count: 0,
            chain_valid: true,
            complete_history_used_for_authority: false,
            replay_filter: filter,
            entries: [
              {
                schema_version: "phase12-s2-complete-history-v1",
                index: 0,
                id: "hist-1",
                kind: "approval_history",
                request_id: "req-1",
                command_id: "cmd-1",
                actor: "alice",
                source: "gateway",
                payload_digest: "payload-hash",
                used_for_authority: false,
                timestamp: 12345,
                prev_hash: "GENESIS",
                entry_hash: "entry-hash",
                payload: "secret raw payload",
              } as never,
            ],
          };
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/history/replay")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/history/replay", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/history/replay?kind=approval_history&limit=10", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.history).toMatchObject({
        entries_count: 1,
        skipped_count: 0,
        chain_valid: true,
        complete_history_used_for_authority: false,
      });
      expect(body.history.entries[0]).toMatchObject({
        kind: "approval_history",
        request_id: "req-1",
        command_id: "cmd-1",
        payload_digest: "payload-hash",
        used_for_authority: false,
      });
      expect(filters).toEqual([{ kind: "approval_history", limit: 10 }]);
      expect(ok.text).not.toContain("secret raw payload");
      expect(ok.text).not.toContain("\"payload\"");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /history/replay", async () => {
    const ctx = await setup({
      history: {
        replay: async () => ({
          entries_count: 0,
          skipped_count: 0,
          chain_valid: true,
          complete_history_used_for_authority: false,
          entries: [],
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/history/replay",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - evidence export API", () => {
  it("exports sanitized evidence only through the inbound token gate", async () => {
    const calls: unknown[] = [];
    const ctx = await setup({
      evidence: {
        exportPack: async (controlCtx) => {
          calls.push(controlCtx);
          return {
            schema_version: 1,
            pack_dir: "/tmp/blue-tanuki/evidence/evidence-test",
            files: ["summary.json", "report.txt"],
            used_for_authority: false,
            hds_brain_remains_authority: true,
            secret_redaction: {
              applied: true,
              scan_ok: true,
              findings: [],
            },
          };
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await postJson(ctx.port, "/evidence/export", {})).status).toBe(401);
      expect(
        (await postJson(
          ctx.port,
          "/evidence/export",
          {},
          { authorization: `Bearer ${RESUME_TOKEN}` },
        )).status,
      ).toBe(401);

      const get = await getRaw(ctx.port, "/evidence/export", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(get.status).toBe(405);

      const ok = await postJson(
        ctx.port,
        "/evidence/export",
        { actor: "alice", path: "/not/accepted" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        ok: true,
        evidence: {
          used_for_authority: false,
          hds_brain_remains_authority: true,
          secret_redaction: {
            applied: true,
            scan_ok: true,
          },
        },
      });
      expect(calls).toEqual([{ actor: "alice", token_kind: "inbound" }]);
      expect(JSON.stringify(ok.body)).not.toContain("/not/accepted");
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Writing Operator API", () => {
  it("serves Writing Operator snapshot only with the inbound token", async () => {
    const ctx = await setup({
      operators: {
        writing: {
          getSnapshot: async () => ({
            surface: "writing",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/writing")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/writing", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/writing", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "writing",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Writing Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = await setup({
      operators: {
        writing: {
          getSnapshot: async () => ({ surface: "writing" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/writing/invoke",
        { user: "writer", content: "draft this" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "writer",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "writing",
        "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.projection_id": "operator:writing:operation-core",
        "blue_tanuki.operation_core.source_interface": "gui",
        "blue_tanuki.operation_core.used_for_authority": false,
        "blue_tanuki.operation_core.planner_output_used_for_authority": false,
        "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
      });
      expect(ctx.received[0]?.metadata?.["blue_tanuki.operation_core.request_id"]).toBe(
        `operation-request:${ctx.received[0]?.id}`,
      );
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Daily Operator API", () => {
  it("serves Daily Operator snapshot only with the inbound token", async () => {
    const ctx = await setup({
      operators: {
        daily: {
          getSnapshot: async () => ({
            surface: "daily",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/daily")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/daily", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/daily", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "daily",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Daily Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = await setup({
      operators: {
        daily: {
          getSnapshot: async () => ({ surface: "daily" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/daily/invoke",
        { user: "daily-user", content: "show daily brief status" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "daily-user",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "daily",
        "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.projection_id": "operator:daily:operation-core",
        "blue_tanuki.operation_core.source_interface": "gui",
        "blue_tanuki.operation_core.used_for_authority": false,
        "blue_tanuki.operation_core.planner_output_used_for_authority": false,
        "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
      });
      expect(ctx.received[0]?.metadata?.["blue_tanuki.operation_core.request_id"]).toBe(
        `operation-request:${ctx.received[0]?.id}`,
      );
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Developer Operator API", () => {
  it("serves Developer Operator snapshot only with the inbound token", async () => {
    const ctx = await setup({
      operators: {
        developer: {
          getSnapshot: async () => ({
            surface: "developer",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/developer")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/developer", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/developer", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "developer",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Developer Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = await setup({
      operators: {
        developer: {
          getSnapshot: async () => ({ surface: "developer" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/developer/invoke",
        { user: "developer-user", content: "inspect failing test" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "developer-user",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.projection_id": "operator:developer:operation-core",
        "blue_tanuki.operation_core.source_interface": "gui",
        "blue_tanuki.operation_core.used_for_authority": false,
        "blue_tanuki.operation_core.planner_output_used_for_authority": false,
        "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
      });
      expect(ctx.received[0]?.metadata?.["blue_tanuki.operation_core.request_id"]).toBe(
        `operation-request:${ctx.received[0]?.id}`,
      );
    } finally {
      await ctx.teardown();
    }
  });
});
