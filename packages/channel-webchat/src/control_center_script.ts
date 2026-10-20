import { AOTANU_SPRITE_SPECS } from "./aotanu_mascot.js";
import { OPERATION_ADAPTER_REGISTRY } from "@blue-tanuki/protocol";

const AOTANU_SPRITE_SPECS_JSON = JSON.stringify(AOTANU_SPRITE_SPECS);
const OPERATION_ADAPTER_REGISTRY_JSON = JSON.stringify(OPERATION_ADAPTER_REGISTRY);

export const CONTROL_CENTER_SCRIPT = `      const AOTANU_SPRITE_SPECS = ${AOTANU_SPRITE_SPECS_JSON};
      const OPERATION_ADAPTER_REGISTRY = ${OPERATION_ADAPTER_REGISTRY_JSON};
      const MASCOT_PREFS_STORAGE_KEY = "bt.mascotPrefs";
      const DEFAULT_MASCOT_PREFS = {
        enabled: true,
        character: "aotanu",
        size: "medium",
        position: "bottom-right"
      };
      const MASCOT_STATE_LABELS = {
        idle: "休憩中",
        walk: "起動中",
        working: "診断中",
        happy: "休憩中",
        error: "エラー"
      };
      const aotanuAnimation = {
        timer: null,
        state: "idle",
        frame: 0
      };
      const storedActiveScreen = sessionStorage.getItem("bt.activeScreen");

      const state = {
        runtimeToken: sessionStorage.getItem("bt.runtimeToken") || "",
        approvalToken: sessionStorage.getItem("bt.approvalToken") || "",
        auditToken: sessionStorage.getItem("bt.auditToken") || "",
        authorityToken: sessionStorage.getItem("bt.authorityToken") || "",
        notificationsToken: sessionStorage.getItem("bt.notificationsToken") || "",
        historyToken: sessionStorage.getItem("bt.historyToken") || "",
        historyKind: sessionStorage.getItem("bt.historyKind") || "",
        evidenceToken: sessionStorage.getItem("bt.evidenceToken") || "",
        settingsToken: sessionStorage.getItem("bt.settingsToken") || "",
        connectorsToken: sessionStorage.getItem("bt.connectorsToken") || "",
        aboutToken: sessionStorage.getItem("bt.aboutToken") || "",
        updateToken: sessionStorage.getItem("bt.updateToken") || "",
        recoveryToken: sessionStorage.getItem("bt.recoveryToken") || "",
        chatToken: sessionStorage.getItem("bt.chatToken") || "",
        chatUser: sessionStorage.getItem("bt.chatUser") || "owner",
        activeScreen: storedActiveScreen && storedActiveScreen !== "home" ? storedActiveScreen : "conversation",
        mascotPreferences: loadMascotPreferences(),
        mascotActionsOpen: false,
        lastMascotState: "idle",
        lastMascotLabel: "休憩中",
        chatSocket: null,
        chatConnectionGeneration: 0,
        runtimeSnapshotRequestId: 0,
        approvalTokens: Object.create(null),
        approvalContentDigests: Object.create(null)
      };

      const redactKeyParts = ["token", "secret", "authorization", "cookie", "content", "credential", "password"];

      function byId(id) {
        return document.getElementById(id);
      }

      function setText(id, value) {
        const node = byId(id);
        if (node) node.textContent = String(value);
      }

      function setHtml(id, value) {
        const node = byId(id);
        if (node) node.innerHTML = value;
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function badge(value, tone) {
        const safeTone = tone ? " " + tone : "";
        return '<span class="badge' + safeTone + '">' + escapeHtml(value) + '</span>';
      }

      function toneForBoolean(value) {
        if (value === true) return "good";
        if (value === false) return "bad";
        return "warn";
      }

      function labelForBoolean(value) {
        if (value === true) return "ok";
        if (value === false) return "blocked";
        return "unknown";
      }

      function compactJson(value) {
        return JSON.stringify(value, null, 2);
      }

      function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
      }

      function redactRuntimeValue(value) {
        if (Array.isArray(value)) {
          return value.map(redactRuntimeValue);
        }
        if (!isObject(value)) {
          return value;
        }
        const output = {};
        for (const key of Object.keys(value)) {
          const lower = key.toLowerCase();
          const shouldRedact = redactKeyParts.some((part) => lower.includes(part));
          output[key] = shouldRedact ? "[redacted]" : redactRuntimeValue(value[key]);
        }
        return output;
      }

      function formatDate(ms) {
        if (typeof ms !== "number" || !Number.isFinite(ms)) return "not set";
        return new Date(ms).toLocaleString();
      }

      function formatInterval(ms) {
        if (typeof ms !== "number" || !Number.isFinite(ms)) return "not set";
        if (ms < 1000) return String(ms) + " ms";
        if (ms < 60000) return String(Math.round(ms / 1000)) + " sec";
        if (ms < 3600000) return String(Math.round(ms / 60000)) + " min";
        return String(Math.round(ms / 3600000)) + " hr";
      }

      function lowerStatus(value) {
        return typeof value === "string" ? value.trim().toLowerCase() : "";
      }

      function numberValue(value) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim() !== "") {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) return parsed;
        }
        return 0;
      }

      function includesAny(value, needles) {
        return needles.some(function (needle) {
          return value.includes(needle);
        });
      }

      function aotanuStateFromRuntime(body) {
        const gatewayStatus = lowerStatus(body.gateway_status);
        const workflowStatus = [
          body.status,
          body.runtime_status,
          body.task_status,
          body.state,
          body.phase
        ].map(lowerStatus).filter(Boolean).join(" ");
        const nextAction = lowerStatus(body.next_recommended_action);
        const pendingApprovals = numberValue(body.pending_approvals_count);
        const pendingSchedules = numberValue(body.pending_schedule_approvals_count);
        if (
          ["degraded", "error", "failed", "blocked", "warning", "disconnected"].includes(gatewayStatus) ||
          includesAny(workflowStatus, ["error", "failed", "blocked", "warning", "permission_denied", "disconnected", "suspended"]) ||
          body.hds_invariants_ok === false ||
          body.audit_chain_valid === false ||
          body.webchat_ready === false
        ) {
          return "error";
        }
        if (
          ["starting", "connecting", "launching", "loading"].includes(gatewayStatus) ||
          includesAny(workflowStatus, ["connecting", "launching", "navigating", "switching", "loading_route", "loading"])
        ) {
          return "walk";
        }
        if (
          pendingApprovals > 0 ||
          pendingSchedules > 0 ||
          includesAny(workflowStatus, ["running", "processing", "installing", "updating", "diagnosing", "setup_doctor", "syncing", "indexing", "waiting_approval"])
        ) {
          return "working";
        }
        if (
          includesAny(workflowStatus, ["success", "completed", "passed", "done", "recovered"]) ||
          (
            gatewayStatus === "running" &&
            body.hds_invariants_ok === true &&
            body.audit_chain_valid === true &&
            body.webchat_ready !== false &&
            nextAction.length === 0
          )
        ) {
          return "happy";
        }
        return "idle";
      }

      function normalizeMascotPreferences(value) {
        const source = isObject(value) ? value : {};
        const allowedCharacters = ["aotanu", "none"];
        const allowedSizes = ["small", "medium", "large"];
        const allowedPositions = ["bottom-right"];
        return {
          enabled: source.enabled !== false,
          character: allowedCharacters.includes(source.character) ? source.character : DEFAULT_MASCOT_PREFS.character,
          size: allowedSizes.includes(source.size) ? source.size : DEFAULT_MASCOT_PREFS.size,
          position: allowedPositions.includes(source.position) ? source.position : DEFAULT_MASCOT_PREFS.position
        };
      }

      function loadMascotPreferences() {
        try {
          const raw = window.localStorage.getItem(MASCOT_PREFS_STORAGE_KEY);
          return raw ? normalizeMascotPreferences(JSON.parse(raw)) : Object.assign({}, DEFAULT_MASCOT_PREFS);
        } catch (_) {
          return Object.assign({}, DEFAULT_MASCOT_PREFS);
        }
      }

      function saveMascotPreferences() {
        try {
          window.localStorage.setItem(MASCOT_PREFS_STORAGE_KEY, JSON.stringify(state.mascotPreferences));
        } catch (_) {
          /* preference persistence is best-effort browser UI state */
        }
      }

      function aotanuDisplayLabelFromRuntime(body, mascotState) {
        const workflowStatus = [
          body.status,
          body.runtime_status,
          body.task_status,
          body.state,
          body.phase
        ].map(lowerStatus).filter(Boolean).join(" ");
        const pendingApprovals = numberValue(body.pending_approvals_count);
        const pendingSchedules = numberValue(body.pending_schedule_approvals_count);
        if (mascotState === "error") return "エラー";
        if (pendingApprovals > 0 || pendingSchedules > 0 || includesAny(workflowStatus, ["waiting_approval", "approval_required"])) {
          return "要確認";
        }
        return MASCOT_STATE_LABELS[mascotState] || MASCOT_STATE_LABELS.idle;
      }

      function mascotTone(mascotState, displayLabel) {
        if (mascotState === "error") return "bad";
        if (displayLabel === "要確認" || mascotState === "working" || mascotState === "walk") return "review";
        return "good";
      }

      function aotanuReducedMotion() {
        return Boolean(
          window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
      }

      function setAotanuFrame(frame) {
        const sprite = byId("aotanu-sprite");
        const spec = AOTANU_SPRITE_SPECS[aotanuAnimation.state] || AOTANU_SPRITE_SPECS.idle;
        const safeFrame = frame % spec.frame_count;
        const col = safeFrame % spec.columns;
        const row = Math.floor(safeFrame / spec.columns);
        const x = spec.columns === 1 ? 0 : (col / (spec.columns - 1)) * 100;
        const y = spec.rows === 1 ? 0 : (row / (spec.rows - 1)) * 100;
        aotanuAnimation.frame = safeFrame;
        if (sprite) {
          sprite.style.backgroundPosition = x + "% " + y + "%";
        }
      }

      function updateMascotSettingsStatus() {
        const prefs = state.mascotPreferences;
        const status = byId("mascot-settings-status");
        if (!status) return;
        const visible = prefs.enabled !== false && prefs.character !== "none";
        status.textContent = visible ? "on" : "off";
        status.className = "badge " + (visible ? "good" : "warn");
      }

      function syncMascotSettingsInputs() {
        const prefs = state.mascotPreferences;
        const enabled = byId("mascot-enabled");
        const character = byId("mascot-character");
        const size = byId("mascot-size");
        if (enabled) enabled.checked = prefs.enabled !== false;
        if (character) character.value = prefs.character;
        if (size) size.value = prefs.size;
        updateMascotSettingsStatus();
      }

      function setMascotActionsOpen(open) {
        state.mascotActionsOpen = Boolean(open);
        const actions = byId("mascot-actions");
        const toggle = byId("mascot-toggle");
        if (actions) actions.hidden = !state.mascotActionsOpen;
        if (toggle) toggle.setAttribute("aria-expanded", state.mascotActionsOpen ? "true" : "false");
      }

      function setMascotPreferences(next) {
        state.mascotPreferences = normalizeMascotPreferences(Object.assign({}, state.mascotPreferences, next));
        saveMascotPreferences();
        syncMascotSettingsInputs();
        renderAotanuMascot(state.lastMascotState, state.lastMascotLabel);
      }

      function runMascotAction(action) {
        setMascotActionsOpen(false);
        if (action === "conversation") {
          setActiveScreen("conversation");
          const input = byId("chat-content");
          if (input) input.focus();
          return;
        }
        if (action === "doctor") {
          setActiveScreen("doctor");
          const input = byId("runtime-token");
          if (input) input.focus();
          return;
        }
        if (action === "activity") {
          setActiveScreen("activity");
          const input = byId("audit-token");
          if (input) input.focus();
          return;
        }
        if (action === "settings") {
          setActiveScreen("settings");
          const input = byId("mascot-enabled");
          if (input) input.focus();
        }
      }

      function bindMascotControls() {
        const enabled = byId("mascot-enabled");
        const character = byId("mascot-character");
        const size = byId("mascot-size");
        const reset = byId("reset-mascot-settings");
        const toggle = byId("mascot-toggle");
        if (enabled) {
          enabled.addEventListener("change", function () {
            setMascotPreferences({ enabled: enabled.checked });
          });
        }
        if (character) {
          character.addEventListener("change", function () {
            setMascotPreferences({ character: character.value });
          });
        }
        if (size) {
          size.addEventListener("change", function () {
            setMascotPreferences({ size: size.value });
          });
        }
        if (reset) {
          reset.addEventListener("click", function () {
            setMascotPreferences(DEFAULT_MASCOT_PREFS);
          });
        }
        if (toggle) {
          toggle.addEventListener("click", function () {
            setMascotActionsOpen(!state.mascotActionsOpen);
          });
        }
      }

      function renderAotanuMascot(mascotState, displayLabel) {
        const dock = byId("mascot-dock");
        const panel = byId("aotanu-mascot");
        const sprite = byId("aotanu-sprite");
        const label = byId("aotanu-state-label");
        if (aotanuAnimation.timer) {
          window.clearInterval(aotanuAnimation.timer);
          aotanuAnimation.timer = null;
        }
        const nextState = AOTANU_SPRITE_SPECS[mascotState] ? mascotState : "idle";
        const spec = AOTANU_SPRITE_SPECS[nextState];
        const prefs = state.mascotPreferences;
        const labelText = displayLabel || MASCOT_STATE_LABELS[nextState] || spec.label;
        state.lastMascotState = nextState;
        state.lastMascotLabel = labelText;
        if (dock) {
          dock.classList.remove(
            "mascot-dock-bottom-right",
            "mascot-size-small",
            "mascot-size-medium",
            "mascot-size-large"
          );
          dock.classList.add("mascot-dock-bottom-right", "mascot-size-" + prefs.size);
          dock.hidden = prefs.enabled === false || prefs.character === "none";
          if (dock.hidden) setMascotActionsOpen(false);
        }
        updateMascotSettingsStatus();
        if (!panel || !sprite || !label || (dock && dock.hidden)) return;
        aotanuAnimation.state = nextState;
        panel.dataset.state = nextState;
        panel.hidden = false;
        panel.setAttribute("aria-label", "アオタヌ 状態: " + labelText);
        sprite.style.backgroundImage = "url('" + spec.asset_path + "')";
        sprite.style.backgroundSize = String(spec.columns * 100) + "% " + String(spec.rows * 100) + "%";
        label.textContent = labelText;
        label.className = "badge " + mascotTone(nextState, labelText);
        setAotanuFrame(0);
        if (!aotanuReducedMotion() && spec.fps > 0) {
          aotanuAnimation.timer = window.setInterval(function () {
            setAotanuFrame(aotanuAnimation.frame + 1);
          }, Math.max(250, Math.round(1000 / spec.fps)));
        }
      }

      function authHeaders(token) {
        return token ? { Authorization: "Bearer " + token } : {};
      }

      function setActiveScreen(screen) {
        const selected = screen || "conversation";
        state.activeScreen = selected;
        sessionStorage.setItem("bt.activeScreen", selected);
        document.body.dataset.activeScreen = selected;
        document.querySelectorAll("[data-screen-group]").forEach(function (node) {
          const groups = String(node.getAttribute("data-screen-group") || "").split(/\\s+/);
          node.hidden = !groups.includes(selected);
        });
        document.querySelectorAll("button.screen-tab").forEach(function (button) {
          const active = button.getAttribute("data-screen") === selected;
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", active ? "true" : "false");
        });
      }

      async function fetchJson(path, token, options) {
        const response = await fetch(path, Object.assign({ headers: authHeaders(token) }, options || {}));
        if (!response.ok) throw new Error(path + " failed: HTTP " + response.status);
        return response.json();
      }

      async function postJson(path, token, body) {
        const response = await fetch(path, {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders(token)),
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(path + " failed: HTTP " + response.status);
        return response.json();
      }

      function chatRoleForKind(kind) {
        const normalized = String(kind || "").toLowerCase();
        if (normalized === "owner" || normalized === "user") return "owner";
        if (normalized === "channel_send" || normalized === "assistant" || normalized === "message") return "assistant";
        if (normalized === "error") return "error";
        return "system";
      }

      function chatLabelForRole(role, kind) {
        if (role === "owner") return "You";
        if (role === "assistant") return "BLUE-TANUKI";
        if (role === "error") return "Error";
        return String(kind || "System");
      }

      function appendChat(kind, text) {
        const log = byId("chat-log");
        const item = document.createElement("article");
        const role = chatRoleForKind(kind);
        item.className = "chat-item " + role;
        item.innerHTML = '<div class="chat-bubble"><div class="chat-meta">' + escapeHtml(chatLabelForRole(role, kind)) + '</div><p>' + escapeHtml(text) + '</p></div>';
        if (log.querySelector(".chat-item.system .chat-bubble p")?.textContent === "Ready.") log.innerHTML = "";
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
      }

      function setChatStatus(value, tone) {
        setText("chat-status", value);
        byId("chat-status").className = "badge " + (tone || "warn");
      }

      function isDirectToolShortcutInput(value) {
        const trimmed = String(value || "").trim();
        return /^tool:[A-Za-z0-9_.-]+/.test(trimmed) ||
          trimmed === "/tool" ||
          (trimmed.startsWith("/tool") && /\\s/.test(trimmed.charAt(5)));
      }

      function disconnectChat() {
        state.chatConnectionGeneration += 1;
        const socket = state.chatSocket;
        state.chatSocket = null;
        if (socket) {
          try { socket.close(); } catch (_) { /* ignore */ }
        }
        setChatStatus("WebChat disconnected", "warn");
      }

      async function connectChat() {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        sessionStorage.setItem("bt.chatToken", state.chatToken);
        sessionStorage.setItem("bt.chatUser", state.chatUser);
        if (!state.chatToken) throw new Error("webchat token is required");
        disconnectChat();
        const generation = state.chatConnectionGeneration;
        const ticket = await postJson("/ws-ticket", state.chatToken, { user: state.chatUser });
        if (generation !== state.chatConnectionGeneration) return;
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(protocol + "://" + window.location.host + "/ws?ticket=" + encodeURIComponent(ticket.ticket));
        state.chatSocket = ws;
        setChatStatus("WebChat connecting", "warn");
        ws.addEventListener("open", function () {
          if (state.chatSocket !== ws || generation !== state.chatConnectionGeneration) return;
          setChatStatus("WebChat connected", "good");
          loadRuntime("webchat-connected");
        });
        ws.addEventListener("message", function (event) {
          if (state.chatSocket !== ws || generation !== state.chatConnectionGeneration) return;
          let frame = null;
          try { frame = JSON.parse(event.data); } catch (_) { frame = { kind: "message", content: String(event.data) }; }
          if (frame.kind === "hello") {
            appendChat("system", "connected as " + (frame.user || state.chatUser));
            return;
          }
          appendChat(frame.kind || "message", frame.content || compactJson(redactRuntimeValue(frame)));
        });
        ws.addEventListener("close", function () {
          if (state.chatSocket === ws && generation === state.chatConnectionGeneration) {
            state.chatSocket = null;
            setChatStatus("WebChat disconnected", "warn");
          }
        });
        ws.addEventListener("error", function () {
          if (state.chatSocket !== ws || generation !== state.chatConnectionGeneration) return;
          setChatStatus("WebChat socket error", "bad");
        });
      }

      async function sendChat() {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const content = byId("chat-content").value.trim();
        sessionStorage.setItem("bt.chatToken", state.chatToken);
        sessionStorage.setItem("bt.chatUser", state.chatUser);
        if (!state.chatToken) throw new Error("webchat token is required");
        if (!content) throw new Error("message is required");
        if (isDirectToolShortcutInput(content)) {
          throw new Error("tool shortcut is not available from normal Conversation. Use an Operator surface or developer recovery entrypoint.");
        }
        appendChat("owner", content);
        const result = await postJson("/inbound", state.chatToken, { user: state.chatUser, content });
        byId("chat-content").value = "";
        appendChat("accepted", result.request_id || "request accepted");
      }

      async function invokeReceiptReconciliation(planId, revisionDigest, stepId) {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        if (!state.chatToken) throw new Error("webchat token is required");
        const content = "plan:reconcile " + JSON.stringify({ plan_id: planId, revision_digest: revisionDigest, step_id: stepId });
        const result = await postJson("/operators/developer/invoke", state.chatToken, { user: state.chatUser, content });
        appendChat("owner", content);
        appendChat("accepted", result.request_id || "read-only reconciliation accepted");
      }

      function syncInputs() {
        byId("runtime-token").value = state.runtimeToken;
        byId("approval-token").value = state.approvalToken;
        byId("audit-token").value = state.auditToken;
        byId("authority-token").value = state.authorityToken;
        byId("notifications-token").value = state.notificationsToken;
        byId("history-token").value = state.historyToken;
        byId("history-kind").value = state.historyKind;
        byId("evidence-token").value = state.evidenceToken || state.chatToken;
        byId("settings-token").value = state.settingsToken;
        byId("connectors-token").value = state.connectorsToken || state.settingsToken;
        byId("about-token").value = state.aboutToken || state.chatToken;
        byId("update-token").value = state.updateToken || state.chatToken;
        byId("recovery-token").value = state.recoveryToken || state.chatToken;
        byId("chat-token").value = state.chatToken;
        byId("chat-user").value = state.chatUser;
        syncMascotSettingsInputs();
      }

      function severityTone(severity) {
        if (severity === "critical") return "bad";
        if (severity === "warning" || severity === "action_required") return "review";
        return "good";
      }

      function updatePermanentUseStatus(body) {
        const pendingApprovals = Number(body.pending_approvals_count ?? 0);
        const pendingSchedules = Number(body.pending_schedule_approvals_count ?? 0);
        const items = [
          ["Gateway", body.gateway_status || "unknown", body.gateway_status === "ready" ? "good" : "warn"],
          ["HDS", labelForBoolean(body.hds_invariants_ok), toneForBoolean(body.hds_invariants_ok)],
          ["Audit", labelForBoolean(body.audit_chain_valid), toneForBoolean(body.audit_chain_valid)],
          ["WebChat", labelForBoolean(body.webchat_ready), toneForBoolean(body.webchat_ready)],
          ["Approvals", String(pendingApprovals), pendingApprovals === 0 ? "good" : "review"],
          ["Schedules", String(pendingSchedules), pendingSchedules === 0 ? "good" : "review"],
          ["Telegram", body.telegram_configured ? "configured" : "optional", body.telegram_configured ? "good" : "warn"],
          ["Runtime", body.runtime_schedules_count ?? "0", "good"]
        ];
        setHtml(
          "permanent-use-status",
          items
            .map(function (item) {
              return '<div class="state-row"><span>' + escapeHtml(item[0]) + '</span><span>' + badge(item[1], item[2]) + '</span></div>';
            })
            .join("")
        );
      }

      function renderSchedules(body) {
        const runtimeSchedules = Array.isArray(body.runtime_schedules) ? body.runtime_schedules : [];
        const configuredTasks = Array.isArray(body.scheduled_tasks) ? body.scheduled_tasks : [];
        const activeCount = runtimeSchedules.filter((item) => item.status === "active" || item.enabled === true).length;
        const pendingCount = runtimeSchedules.filter((item) => item.status === "pending" || Boolean(item.pending_operation)).length;
        const displayActive = body.runtime_schedules_count ?? activeCount;
        const displayPending = body.pending_schedule_approvals_count ?? pendingCount;

        setText("schedule-count", configuredTasks.length);
        setText("schedule-active-count", displayActive);
        setText("schedule-pending-count", displayPending);
        setText("schedule-summary", String(displayActive) + " active / " + String(displayPending) + " pending");
        byId("schedule-summary").className = "badge " + (displayPending > 0 ? "review" : "good");

        const rows = runtimeSchedules.length > 0 ? runtimeSchedules : configuredTasks;
        if (rows.length === 0) {
          setHtml("runtime-schedule-list", '<div class="schedule-item muted">no runtime schedules</div>');
        } else {
          setHtml(
            "runtime-schedule-list",
            rows
              .map(function (item) {
                const status = item.status || (item.enabled === false ? "disabled" : "active");
                const tone = status === "active" ? "good" : status === "pending" ? "review" : status === "rejected" ? "bad" : "warn";
                const pending = item.pending_operation ? badge(item.pending_operation, "review") : badge("none", "good");
                const fields = [
                  ["id", item.id || item.schedule_id || "unknown", false],
                  ["status", badge(status, tone), true],
                  ["channel", item.channel || "unknown", false],
                  ["target", item.target || "unknown", false],
                  ["time", item.time || "not set", false],
                  ["interval", formatInterval(item.interval_ms), false],
                  ["pending", pending, true],
                  ["approval", item.pending_command_id || "none", false],
                  ["expires", formatDate(item.approval_expires_at_ms), false],
                  ["payload", item.payload_hash || "not recorded", false]
                ];
                return '<article class="schedule-item"><dl class="kv">' +
                  fields
                    .map(function (field) {
                      const value = field[2] ? field[1] : escapeHtml(field[1]);
                      return '<dt>' + escapeHtml(field[0]) + '</dt><dd>' + value + '</dd>';
                    })
                    .join("") +
                  "</dl></article>";
              })
              .join("")
          );
        }

        setText("schedule-json", compactJson(redactRuntimeValue({ runtime_schedules: runtimeSchedules, scheduled_tasks: configuredTasks })));
      }

      function operationCoreRiskTone(risk) {
        if (risk === "high") return "bad";
        if (risk === "medium") return "warn";
        if (risk === "low") return "good";
        return "review";
      }

      function operationCoreAdapterDescriptor(adapter) {
        const key = typeof adapter === "string" && adapter ? adapter : "none";
        return OPERATION_ADAPTER_REGISTRY[key] || null;
      }

      function operationCoreAdapterCommandExpected(descriptor) {
        return descriptor && descriptor.command_generation_location === "execution_adapter_only";
      }

      function operationCoreAdapterLabel(descriptor, fallback) {
        if (!descriptor) return fallback || "unknown adapter";
        return descriptor.display_name + " / " + descriptor.runtime_boundary;
      }

      function collectOperationCoreProjections(operatorSurfaces) {
        if (!isObject(operatorSurfaces)) return [];
        return Object.keys(operatorSurfaces)
          .map(function (key) {
            const surface = operatorSurfaces[key];
            return isObject(surface) && isObject(surface.operation_core_projection)
              ? surface.operation_core_projection
              : null;
          })
          .filter(Boolean);
      }

      function renderOperationCoreProjections(operatorSurfaces) {
        const projections = collectOperationCoreProjections(operatorSurfaces);
        const steps = projections.flatMap(function (projection) {
          return Array.isArray(projection.steps)
            ? projection.steps.map(function (step) {
              return { projection: projection, step: step };
            })
            : [];
        });
        const adapters = Array.from(new Set(steps.map(function (entry) {
          return entry.step.adapter || "none";
        }))).sort();
        const registryOk =
          OPERATION_ADAPTER_REGISTRY.internal_runtime &&
          OPERATION_ADAPTER_REGISTRY.internal_runtime.default_runtime === true &&
          OPERATION_ADAPTER_REGISTRY.shell &&
          OPERATION_ADAPTER_REGISTRY.shell.default_runtime === false &&
          steps.every(function (entry) {
            const step = entry.step || {};
            const descriptor = operationCoreAdapterDescriptor(step.adapter);
            const expectedCommandGeneratedByAdapterOnly = operationCoreAdapterCommandExpected(descriptor);
            return descriptor !== null &&
              descriptor.adapter_is_authority === false &&
              descriptor.adapter_result_used_for_authority === false &&
              step.adapter_is_authority === false &&
              step.command_generated_by_adapter_only === expectedCommandGeneratedByAdapterOnly;
          });
        const authorityOk =
          projections.every(function (projection) {
            return projection.hds_brain_authority_required === true &&
              projection.planner_output_used_for_authority === false &&
              projection.ui_projection_used_for_authority === false &&
              projection.adapter_result_used_for_authority === false &&
              projection.raw_command_policy &&
              projection.raw_command_policy.raw_command_is_core_operation === false;
          }) &&
          steps.every(function (entry) {
            return entry.step.adapter_is_authority === false;
          }) &&
          registryOk;

        setText("operation-core-surface-count", projections.length);
        setText("operation-core-step-count", steps.length);
        setText("operation-core-adapters", adapters.length > 0 ? adapters.join(", ") : "none");
        setText("operation-core-adapter-registry", registryOk ? "validated display" : "unsafe");
        setText("operation-core-default-runtime", OPERATION_ADAPTER_REGISTRY.internal_runtime.default_runtime === true ? "internal_runtime" : "unsafe");
        setText("operation-core-authority", authorityOk ? "HDS path" : "unsafe");
        setText("operation-core-status", steps.length > 0 ? (authorityOk ? "loaded" : "unsafe") : "not loaded");
        if (byId("operation-core-status")) {
          byId("operation-core-status").className = "badge " + (steps.length === 0 ? "warn" : authorityOk ? "good" : "bad");
        }
        if (byId("operation-core-authority")) {
          byId("operation-core-authority").className = "badge " + (authorityOk ? "good" : "bad");
        }
        if (byId("operation-core-adapter-registry")) {
          byId("operation-core-adapter-registry").className = "badge " + (registryOk ? "good" : "bad");
        }
        if (byId("operation-core-default-runtime")) {
          byId("operation-core-default-runtime").className = "badge " + (OPERATION_ADAPTER_REGISTRY.internal_runtime.default_runtime === true ? "good" : "bad");
        }

        if (steps.length === 0) {
          setHtml("operation-core-list", '<div class="trace-item muted">no Operation Core projection loaded</div>');
          return;
        }

        setHtml(
          "operation-core-list",
          steps
            .map(function (entry) {
              const step = entry.step || {};
              const projection = entry.projection || {};
              const target = step.target || {};
              const permission = step.permission || {};
              const descriptor = operationCoreAdapterDescriptor(step.adapter);
              const effects = Array.isArray(step.effects) ? step.effects.join(", ") : "none";
              const level = permission.approval_level || "unknown";
              const approvalTone = level === "L3_final_review" ? "review" : "good";
              const risk = permission.risk || "unknown";
              const gate = permission.approval_gate_required === true ? badge("Approval Gate", "review") : badge("bounded", "good");
              const adapterTone = descriptor && descriptor.default_runtime === true ? "good" : "review";
              const commandExpected = operationCoreAdapterCommandExpected(descriptor);
              const commandOk = step.command_generated_by_adapter_only === commandExpected;
              const command = step.command_generated_by_adapter_only === true ? badge("adapter-generated", "review") : badge("no raw command", "good");
              return '<article class="trace-item">' +
                '<div class="row"><h3>' + escapeHtml(projection.source_surface || "surface") + ": " + escapeHtml(step.operation || "operation") + '</h3><span>' + badge(step.state || "planned", "good") + '</span></div>' +
                '<dl class="kv">' +
                '<dt>target</dt><dd>' + escapeHtml((target.kind || "unknown") + " / " + (target.display_name || target.id || "unknown")) + '</dd>' +
                '<dt>effects</dt><dd>' + escapeHtml(effects) + '</dd>' +
                '<dt>risk</dt><dd>' + badge(risk, operationCoreRiskTone(risk)) + '</dd>' +
                '<dt>ApprovalLevel</dt><dd>' + badge(level, approvalTone) + '</dd>' +
                '<dt>gate</dt><dd>' + gate + '</dd>' +
                '<dt>adapter</dt><dd>' + badge(step.adapter || "none", step.adapter_is_authority === false ? "good" : "bad") + '</dd>' +
                '<dt>registry</dt><dd>' + badge(operationCoreAdapterLabel(descriptor, step.adapter), descriptor ? adapterTone : "bad") + '</dd>' +
                '<dt>command</dt><dd>' + command + " " + badge(commandOk ? "registry match" : "registry mismatch", commandOk ? "good" : "bad") + '</dd>' +
                '<dt>boundary</dt><dd>' + badge(step.adapter_is_authority === false ? "HDS path" : "unsafe", step.adapter_is_authority === false ? "good" : "bad") + '</dd>' +
                '</dl></article>';
            })
            .join("")
        );
      }

      function operationCoreExecutionStatusTone(status) {
        if (status === "success") return "good";
        if (status === "failed" || status === "error") return "bad";
        if (status === "suspended" || status === "approval_required") return "review";
        return "warn";
      }

      function renderOperationCoreExecution(execution) {
        const projection = isObject(execution) ? execution : {};
        const latest = Array.isArray(projection.latest_results) ? projection.latest_results : [];
        const authorityOk =
          projection.used_for_authority === false &&
          projection.adapter_result_used_for_authority === false &&
          projection.execution_history_used_for_authority === false &&
          projection.raw_payload_exposed === false;
        const chainOk = projection.chain_valid === true;
        const rollbackAvailable = latest.some(function (entry) {
          return isObject(entry.rollback) && entry.rollback.available === true;
        });
        const latestStatus = latest.length > 0 ? latest[0].status || "unknown" : "none";

        setText("operation-core-execution-results", projection.displayed_count ?? latest.length);
        setText("operation-core-latest-result", latestStatus);
        setText("operation-core-rollback", rollbackAvailable ? "available" : "not recorded");
        if (byId("operation-core-execution-results")) {
          byId("operation-core-execution-results").className = "badge " + (authorityOk && chainOk ? "good" : "bad");
        }
        if (byId("operation-core-latest-result")) {
          byId("operation-core-latest-result").className = "badge " + operationCoreExecutionStatusTone(latestStatus);
        }
        if (byId("operation-core-rollback")) {
          byId("operation-core-rollback").className = "badge " + (rollbackAvailable ? "good" : "warn");
        }

        if (latest.length === 0) {
          setHtml("operation-core-execution-list", '<div class="trace-item muted">no Operation Core execution result loaded</div>');
          return;
        }

        setHtml(
          "operation-core-execution-list",
          latest
            .map(function (entry) {
              const command = isObject(entry.command) ? entry.command : {};
              const metrics = isObject(entry.metrics) ? entry.metrics : {};
              const diff = isObject(entry.diff) ? entry.diff : {};
              const rollback = isObject(entry.rollback) ? entry.rollback : {};
              const op = isObject(entry.operation_core) ? entry.operation_core : {};
              const trace = isObject(entry.execution_trace) ? entry.execution_trace : {};
              const commandResult = isObject(entry.command_execution_result) ? entry.command_execution_result : {};
              const planner = isObject(entry.planner_output) ? entry.planner_output : {};
              const preparation = isObject(planner.preparation) ? planner.preparation : {};
              const permission = isObject(trace.permission) ? trace.permission : {};
              const resultDigest = entry.result_digest || "not recorded";
              const errorDigest = entry.error_digest || "none";
              const commandId = entry.command_id || "none";
              const requestId = entry.request_id || "none";
              const duration = typeof metrics.duration_ms === "number" ? String(metrics.duration_ms) + " ms" : "not recorded";
              const rawSafe =
                op.used_for_authority === false &&
                op.adapter_result_used_for_authority === false &&
                op.raw_payload_exposed === false;
              return '<article class="trace-item">' +
                '<div class="row"><h3>' + escapeHtml(command.operation || "execution result") + '</h3><span>' + badge(entry.status || "unknown", operationCoreExecutionStatusTone(entry.status)) + '</span></div>' +
                '<dl class="kv">' +
                '<dt>request</dt><dd class="mono">' + escapeHtml(requestId) + '</dd>' +
                '<dt>command</dt><dd class="mono">' + escapeHtml(commandId) + '</dd>' +
                '<dt>観測結果ID</dt><dd class="mono">' + escapeHtml(commandResult.result_id || "未記録") + '</dd>' +
                '<dt>実行口</dt><dd>' + escapeHtml(commandResult.execution_boundary === "tool_adapter" ? "tool呼出し" : commandResult.execution_boundary === "channel_adapter" ? "channel呼出し" : commandResult.execution_boundary === "console_preview" ? "console表示のみ" : commandResult.execution_boundary === "not_invoked" ? "未呼出し" : "未記録") + '</dd>' +
                '<dt>作用結果</dt><dd>' + escapeHtml(commandResult.action_outcome === "reported_success" ? "下流が成功を報告" : commandResult.action_outcome === "unknown" ? "作用結果不明・自動再実行不可" : commandResult.action_outcome === "not_attempted" ? "作用未試行" : commandResult.action_outcome === "preview_only" ? "表示のみ・配送の証拠なし" : "未記録") + '</dd>' +
                '<dt>type</dt><dd>' + escapeHtml(command.type || "unknown") + '</dd>' +
                '<dt>origin</dt><dd>' + escapeHtml(entry.origin_channel || "unknown") + '</dd>' +
                '<dt>adapter</dt><dd>' + badge(trace.adapter || "not recorded", trace.adapter_is_authority === false ? "good" : "warn") + '</dd>' +
                '<dt>runtime</dt><dd>' + escapeHtml(trace.runtime_boundary || "not recorded") + '</dd>' +
                '<dt>effect</dt><dd>' + escapeHtml(Array.isArray(trace.effects) ? trace.effects.join(", ") : "not recorded") + '</dd>' +
                '<dt>ApprovalLevel</dt><dd>' + badge(permission.approval_level || "not recorded", permission.final_review_required === true ? "review" : "good") + '</dd>' +
                '<dt>plan</dt><dd class="mono">' + escapeHtml(planner.plan_id || "not recorded") + '</dd>' +
                '<dt>plan steps</dt><dd>' + escapeHtml(typeof planner.steps_count === "number" ? String(planner.steps_count) : "not recorded") + '</dd>' +
                '<dt>準備状態</dt><dd>' + escapeHtml(!planner.plan_id ? "対象planなし" : preparation.status === "ready" ? "準備済み候補・未承認" : "準備未完・依存結果または前提を確認") + '</dd>' +
                '<dt>result digest</dt><dd class="mono">' + escapeHtml(resultDigest) + '</dd>' +
                '<dt>error digest</dt><dd class="mono">' + escapeHtml(errorDigest) + '</dd>' +
                '<dt>duration</dt><dd>' + escapeHtml(duration) + '</dd>' +
                '<dt>diff</dt><dd>' + badge(diff.available === true ? "available" : "not recorded", diff.available === true ? "good" : "warn") + '</dd>' +
                '<dt>rollback</dt><dd>' + badge(rollback.available === true ? "available" : "not recorded", rollback.available === true ? "good" : "warn") + '</dd>' +
                '<dt>boundary</dt><dd>' + badge(rawSafe ? "HDS path" : "unsafe", rawSafe ? "good" : "bad") + '</dd>' +
                '</dl></article>';
            })
            .join("")
        );
      }

      function operationPlanStatusTone(status) {
        if (status === "verified" || status === "results_verified") return "good";
        if (status === "outcome_unknown" || status === "verification_failed") return "warn";
        if (status === "invalidated") return "bad";
        return "review";
      }

      function shortDigest(value) {
        return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 12) : "未記録";
      }

      function renderComputeSourceObservations(value) {
        if (!Array.isArray(value) || value.length === 0) return "";
        const summaries = value.slice(0, 8).map(function (observation) {
          const commonSafe = isObject(observation) &&
            observation.schema_version === "operation-plan-compute-source-observation.v1" &&
            observation.effect_observation === "reported_success" && /^[a-f0-9]{64}$/.test(observation.record_digest || "") &&
            Number.isSafeInteger(observation.memory_revision) && observation.memory_revision > 0 &&
            /^[a-f0-9]{64}$/.test(observation.memory_receipt_digest || "") &&
            Number.isSafeInteger(observation.observed_at_ms) && observation.observed_at_ms >= 0 &&
            observation.adoption_status === "observation_only" && observation.used_as_world_truth === false &&
            observation.used_for_authority === false && observation.may_execute === false;
          if (!commonSafe) return "照合不能な記録（Jはstep選択と実行を拒否）";
          if (observation.source === "verified_shell_exec_result" && observation.operation === "shell.exec" &&
              /^[a-f0-9]{64}$/.test(observation.command_id_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.request_id_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.upstream_commit_hash_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.command_payload_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.result_id_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.result_contract_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.result_digest || "") &&
              observation.execution_status === "succeeded" && observation.execution_boundary === "tool_adapter" &&
              observation.action_outcome === "reported_success") {
            return "shell.exec：adapter成功報告と結果digestのみ（raw出力・終了状態・目的達成は未確認）";
          }
          const planBindingSafe = /^[a-f0-9]{64}$/.test(observation.plan_id_digest || "") &&
            /^[a-f0-9]{64}$/.test(observation.revision_digest || "") &&
            /^[a-f0-9]{64}$/.test(observation.step_id_digest || "") &&
            observation.plan_binding_status === "verified" && observation.plan_validation_status === "matched";
          if (!planBindingSafe) return "照合不能な記録（Jはstep選択と実行を拒否）";
          if (observation.source === "verified_file_search_result" && observation.operation === "file.search" &&
              Number.isSafeInteger(observation.expires_at_ms) && observation.expires_at_ms === observation.observed_at_ms + 600000 &&
              Number.isSafeInteger(observation.match_count) && observation.match_count >= 0 &&
              Number.isSafeInteger(observation.visited_files) && observation.visited_files >= 0 &&
              observation.search_completeness === "unknown") {
            const nowMs = Date.now();
            const current = observation.observed_at_ms <= nowMs && nowMs < observation.expires_at_ms;
            return "file.search：" + (current ? "期限内（観測のみ）" : "期限切れ・照合不能（Jはstep選択と実行を拒否）") +
              "、一致候補 " + observation.match_count + "件、訪問 " + observation.visited_files + "件、検索完全性=unknown";
          }
          if (observation.source === "verified_file_write_result" && observation.operation === "file.write") {
            return "file.write：結果観測のみ（権限・実行を与えません）";
          }
          return "照合不能な記録（Jはstep選択と実行を拒否）";
        });
        return '<dt>計算元の結果観測</dt><dd>' + summaries.map(escapeHtml).join("<br>") +
          '<br><span class="muted">観測は世界の真実・意味上の適合・実行権限を確立しません。</span></dd>';
      }

      function renderOperationPlanStatus(value) {
        const projection = isObject(value) ? value : {};
        const safe = projection.schema_version === "operation-plan.status.v1" &&
          projection.status === "available" && projection.used_for_authority === false &&
          projection.raw_payload_exposed === false && ["ready", "pending"].includes(projection.recovery_refresh_status) &&
          Array.isArray(projection.plans);
        const refreshPending = safe && projection.recovery_refresh_status === "pending";
        const summary = !safe ? "利用不可" : refreshPending ? "復元照合中" :
          String(projection.displayed_count) + " / " + String(projection.plan_count) + " 件";
        setText("operation-plan-state-summary", summary);
        if (byId("operation-plan-state-summary")) {
          byId("operation-plan-state-summary").className = "badge " + (refreshPending ? "warn" : safe ? "good" : "bad");
        }
        if (!safe) {
          setHtml("operation-plan-state-list", '<div class="trace-item muted">J計画snapshotの非権威・payload非露出条件を確認できないため表示しません。</div>');
          return;
        }
        const goalPurposeOptions = Array.isArray(projection.goal_purpose_options) ? projection.goal_purpose_options : [];
        const goalPurposeGuide = goalPurposeOptions.length === 0 ? '' : '<details class="trace-item"><summary>作業目的版の選択候補（digestのみ）</summary>' +
          '<p class="muted">plan:reviewのgoal_purpose_bindingへ以下のgoal_ref・purpose_version・purpose_digestを明示します。これは版の同一性を結ぶ記録で、意味上の適合や実行許可を判定しません。</p>' +
          goalPurposeOptions.map(function (option) {
            if (!isObject(option) || typeof option.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(option.goal_ref) ||
                !Number.isSafeInteger(option.purpose_version) || typeof option.purpose_digest !== "string" ||
                !/^[a-f0-9]{64}$/.test(option.purpose_digest)) return '';
            const alignment = option.parent_alignment_status === "requires_review" ? "親目的の再確認が必要" : "版を選択可能";
            return '<div class="trace-item"><code>' + escapeHtml(JSON.stringify({ goal_ref: option.goal_ref,
              purpose_version: option.purpose_version, purpose_digest: option.purpose_digest })) + '</code><p class="muted">' +
              escapeHtml(String(option.goal_kind || "goal")) + '・' + escapeHtml(alignment) + '</p></div>';
          }).join('') + '</details>';
        const refreshNotice = refreshPending
          ? '<div class="trace-item muted">選択したOperation Plan storeの復元結果が未確認です。step選択を停止しています。復元処理完了後にGatewayを再起動して復旧状態を点検してください。</div>'
          : "";
        if (projection.plans.length === 0) {
          setHtml("operation-plan-state-list", refreshNotice + goalPurposeGuide + '<div class="trace-item muted">現在表示できるJ計画はありません。</div>');
          return;
        }
        setHtml("operation-plan-state-list", refreshNotice + goalPurposeGuide + projection.plans.map(function (plan) {
          const steps = Array.isArray(plan.steps) ? plan.steps : [];
          const recoveryHoldLabels = {
            held_residual: "復元残差あり（step選択停止中）",
            held_unobserved: "復元依存未観測（step選択停止中）",
            held_unverified: "復元履歴未確認（step選択停止中）",
          };
          const recoveryScopeRelationLabels = {
            requested: "L3要求で指定された計画",
            collateral: "選択store内の巻き添え計画",
            unknown: "L3要求との関係は未確認",
          };
          const recoveryHold = Object.prototype.hasOwnProperty.call(recoveryHoldLabels, plan.recovery_hold_reason)
            ? recoveryHoldLabels[plan.recovery_hold_reason] : null;
          const recoveryScopeRelation = recoveryHold
            ? (Object.prototype.hasOwnProperty.call(recoveryScopeRelationLabels, plan.recovery_hold_scope_relation)
              ? recoveryScopeRelationLabels[plan.recovery_hold_scope_relation] : recoveryScopeRelationLabels.unknown)
            : null;
          const reconciliationPlanReady = typeof plan.plan_id === "string" && /^[a-f0-9]{64}$/.test(plan.plan_id) &&
            typeof plan.revision_digest === "string" && /^[a-f0-9]{64}$/.test(plan.revision_digest);
          const purposeBinding = isObject(plan.goal_purpose_binding) ? plan.goal_purpose_binding : null;
          const purposeBindingStatusLabels = {
            not_configured: "目的版管理なし",
            required: "未選択（step reviewを停止）",
            current: "現行版",
            stale: "陳腐化または照合不能（step実行を停止）",
          };
          const purposeBindingStatus = Object.prototype.hasOwnProperty.call(purposeBindingStatusLabels, plan.goal_purpose_binding_status)
            ? purposeBindingStatusLabels[plan.goal_purpose_binding_status] : "目的版状態を確認できません";
          const purposeBindingLabel = purposeBinding && typeof purposeBinding.goal_ref === "string" &&
            Number.isSafeInteger(purposeBinding.purpose_version) && typeof purposeBinding.purpose_digest === "string"
            ? '<dt>選択した作業目的版</dt><dd><code>' + escapeHtml(JSON.stringify({ goal_ref: purposeBinding.goal_ref,
              purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest })) + '</code><br>' +
              escapeHtml(purposeBindingStatus) + '</dd>'
            : plan.goal_purpose_binding_status === "required" ? '<dt>作業目的版</dt><dd>' + escapeHtml(purposeBindingStatus) + '</dd>' : '';
          const purposeRelation = isObject(plan.goal_purpose_relation) ? plan.goal_purpose_relation : null;
          const purposeRelationStatusLabels = {
            not_required: "作業目的版未選択のためrelation未記録",
            unavailable: "C候補のrelation記録なし（step確認を停止）",
            stale: "task・計画・目的版との対応が古い（step確認を停止）",
            unverified: "C候補は非権威。明示確認までstep選択を停止",
            conflicts: "確認結果は作業目的と競合（step選択を停止）",
            owner_reviewed_supports: "owner-token holderがtask・plan・目的版を確認済み（Jのplan審査へ進行可能）",
            owner_reviewed_unknown: "確認結果は不明（step選択を停止）",
          };
          const purposeRelationDetail = purposeRelation && ["unverified", "conflicts", "owner_reviewed_supports", "owner_reviewed_unknown"].includes(purposeRelation.status)
            ? '<br>' + escapeHtml([
              "候補=" + String(purposeRelation.candidate_outcome || "unknown"),
              "引用照合=" + String(purposeRelation.evidence_status || "not_provided"),
              "引用数=" + String(purposeRelation.evidence_count ?? 0),
              "意味評価=" + String(purposeRelation.semantic_assessment_status || "not_assessed"),
              "owner確認=" + String(purposeRelation.owner_review_outcome || purposeRelation.owner_review_status || "not_reviewed"),
            ].join("・")) : "";
          const purposeRelationLabel = purposeRelation && Object.prototype.hasOwnProperty.call(purposeRelationStatusLabels, purposeRelation.status)
            ? '<dt>taskと作業目的の関係</dt><dd>' + escapeHtml(purposeRelationStatusLabels[purposeRelation.status]) + purposeRelationDetail + '</dd>'
            : '';
          const purposeRelationReviewReady = purposeRelation && purposeBinding &&
            ["unverified", "conflicts", "owner_reviewed_supports", "owner_reviewed_unknown"].includes(purposeRelation.status) &&
            purposeBinding.goal_ref && Number.isSafeInteger(purposeBinding.purpose_version) &&
            /^[a-f0-9]{64}$/.test(purposeBinding.purpose_digest || "") && reconciliationPlanReady && !recoveryHold;
          const purposeRelationReviewActions = purposeRelationReviewReady
            ? '<section class="approval-content-review"><label>task・plan・目的版の関係を選択 ' +
              '<select data-purpose-relation-outcome="true"><option value="supports">目的に沿う</option>' +
              '<option value="conflicts">目的と競合</option><option value="unknown">不明・保留</option></select></label> ' +
              '<button type="button" class="secondary" data-purpose-relation-review="true" data-plan-id="' +
              escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) + '">内容を確認してL3審査へ</button>' +
              '<span class="badge" data-purpose-relation-status="true" aria-live="polite"></span>' +
              '<p class="muted">申請後、承認キューでtask・目的本文・planを再確認します。承認結果はこのplan revisionにだけ結び付きます。</p></section>'
            : '';
          return '<article class="trace-item">' +
            '<div class="row"><h3>計画 ' + escapeHtml(shortDigest(plan.plan_id)) + '</h3><span>' + badge("revision " + String(plan.revision), "review") + '</span></div>' +
            '<dl class="kv"><dt>計画digest</dt><dd class="mono">' + escapeHtml(shortDigest(plan.revision_digest)) + '</dd>' +
            '<dt>計画状態</dt><dd>' + badge(plan.status || "unknown", operationPlanStatusTone(plan.status)) + '</dd>' +
            (recoveryHold ? '<dt>復元後の選択</dt><dd>' + escapeHtml(recoveryHold) + '</dd>' +
              '<dt>復元scopeとの関係</dt><dd>' + escapeHtml(recoveryScopeRelation) + '</dd>' : '') +
            purposeBindingLabel + purposeRelationLabel +
            renderComputeSourceObservations(plan.compute_source_observations) +
            '<dt>step数</dt><dd>' + escapeHtml(String(plan.step_count ?? steps.length)) + '</dd></dl>' +
            (recoveryHold ? '<p class="muted">この計画のstep選択は停止中です。復元scopeとの関係表示はplan単位の復元やhold解除を意味しません。状態を確認後に続ける場合は、新しい依頼から新規計画を作成してください。</p>' : '') +
            purposeRelationReviewActions +
            steps.map(function (step) {
              const binding = isObject(step.binding) ? step.binding : {};
              const unknown = step.status === "outcome_unknown";
              const reconciliationStepReady = reconciliationPlanReady && typeof step.step_id === "string" && /^[a-f0-9]{64}$/.test(step.step_id);
              const receiptLabels = {
                not_applicable: "対象外",
                not_recorded: "Jに外部receipt観測未記録",
                matched: "local inspectionの1件がcommand/payload digest一致（成功・目標達成は未確認）",
                not_found: "local inspectionに一致なし（未送信の証明ではありません）",
                mismatch: "local inspectionのreceipt digest不一致（結果不明を維持）",
                ambiguous: "local inspectionに複数候補（結果不明を維持）",
              };
              const receipt = Object.prototype.hasOwnProperty.call(receiptLabels, step.external_receipt_observation)
                ? receiptLabels[step.external_receipt_observation] : "観測状態を確認できません";
              const externalReceipt = isObject(step.external_receipt) ? step.external_receipt : {};
              const externalReceiptSafe = externalReceipt.source === "local_inspection" &&
                externalReceipt.used_for_authority === false && externalReceipt.raw_receipt_exposed === false &&
                typeof externalReceipt.evidence_digest === "string" && /^[a-f0-9]{64}$/.test(externalReceipt.evidence_digest) &&
                Number.isInteger(externalReceipt.match_count) && externalReceipt.match_count >= 0 && externalReceipt.match_count <= 100 &&
                Number.isSafeInteger(externalReceipt.observed_at_ms) && externalReceipt.observed_at_ms >= 0 &&
                (externalReceipt.receipt_digest === undefined || (typeof externalReceipt.receipt_digest === "string" && /^[a-f0-9]{64}$/.test(externalReceipt.receipt_digest))) &&
                step.external_receipt_observation !== "not_recorded";
              const externalReceiptDetails = externalReceiptSafe
                ? '<dt>観測source</dt><dd>local inspection（合成）</dd><dt>観測evidence digest</dt><dd class="mono">' +
                  escapeHtml(shortDigest(externalReceipt.evidence_digest)) + '</dd><dt>候補件数</dt><dd>' +
                  escapeHtml(String(externalReceipt.match_count)) + '</dd>' +
                  (externalReceipt.receipt_digest ? '<dt>receipt digest</dt><dd class="mono">' + escapeHtml(shortDigest(externalReceipt.receipt_digest)) + '</dd>' : '')
                : '';
              return '<div class="trace-item"><div class="row"><h4>' + escapeHtml(step.operation || "operation") + '</h4>' +
                badge(unknown ? "結果不明" : step.status || "unknown", operationPlanStatusTone(step.status)) + '</div>' +
                '<dl class="kv"><dt>step digest</dt><dd class="mono">' + escapeHtml(shortDigest(step.step_id)) + '</dd>' +
                '<dt>command digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.command_digest)) + '</dd>' +
                '<dt>実行結果digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.result_digest)) + '</dd>' +
                '<dt>J配送digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.delivery_digest)) + '</dd>' +
                '<dt>receipt照合</dt><dd>' + escapeHtml(receipt) + '</dd>' + externalReceiptDetails + '</dl>' +
                (unknown ? '<p class="muted">外部作用の結果は未確認です。照合はDeveloper入口から明示要求した場合だけloopbackへ1回GETし、作用は再送しません。</p>' : '') +
                (unknown && reconciliationStepReady ? '<button type="button" class="secondary" data-operation-plan-reconcile="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) + '" data-step-id="' +
                  escapeHtml(step.step_id) + '">loopbackで読取照合</button>' : '') +
                '</div>';
            }).join("") +
            '</article>';
        }).join(""));
      }

      function renderRuntime(body) {
        const invariantOk = body.hds_invariants_ok ?? body.hds?.invariants?.process_policy_enforced;
        const auditOk = body.audit_chain_valid ?? body.hds?.audit?.chain_valid;
        const gatewayStatus = body.gateway_status || "unknown";
        const gatewayTone = gatewayStatus === "degraded" || invariantOk === false || auditOk === false
          ? "bad"
          : gatewayStatus === "running" && invariantOk === true && auditOk === true
            ? "good"
            : "warn";
        setText("gateway-status", gatewayStatus);
        byId("gateway-status").className = "badge " + gatewayTone;
        setText("runtime-invariant", labelForBoolean(invariantOk));
        setText("runtime-audit", labelForBoolean(auditOk));
        setText("first-run-next-action", body.next_recommended_action || "none");
        setText("doctor-runtime-status", body.gateway_status || "unknown");
        setText("doctor-webchat-ready", labelForBoolean(body.webchat_ready));
        setText("doctor-audit-status", labelForBoolean(auditOk));
        setText("doctor-next-action", body.next_recommended_action || "none");
        setText("doctor-installer-mode", body.webchat_ready ? "runtime ready" : "setup incomplete");
        setText("runtime-json", compactJson(redactRuntimeValue(body)));
        setText("header-status", gatewayStatus);
        byId("header-status").className = "badge " + gatewayTone;
        updatePermanentUseStatus(body);
        renderSchedules(body);
        renderOperationCoreProjections(body.operator_surfaces);
        renderOperationCoreExecution(body.operation_core_execution);
        renderOperationPlanStatus(body.operation_plan_status);
        const mascotState = aotanuStateFromRuntime(body);
        renderAotanuMascot(mascotState, aotanuDisplayLabelFromRuntime(body, mascotState));
      }

      function renderApprovals(body) {
        const pending = Array.isArray(body.pending_approvals) ? body.pending_approvals : Array.isArray(body.pending) ? body.pending : [];
        const grants = Array.isArray(body.grants) ? body.grants : [];
        const approvalHistory = Array.isArray(body.approval_history) ? body.approval_history : [];
        const emergencyStop = body.emergency_stop || null;
        const finalReviewCount = pending.filter((item) => item.final_review_required).length;
        const levels = Array.from(new Set(pending.map((item) => item.approval_level || "unknown")));
        const expiries = pending
          .map((item) => item.approval_token_expires_at_ms)
          .filter((value) => typeof value === "number")
          .sort((left, right) => left - right);

        setText("approval-count", pending.length);
        setText("approval-final-review-count", finalReviewCount);
        setText("approval-level-scope", levels.length > 0 ? levels.join(", ") : "none");
        setText("approval-token-expiry", expiries.length > 0 ? formatDate(expiries[0]) : "not set");
        setText("approval-summary", String(pending.length) + " pending");
        byId("approval-summary").className = "badge " + (pending.length > 0 ? "review" : "good");
        setText("approval-emergency-status", emergencyStop && emergencyStop.active ? "active" : "clear");
        byId("approval-emergency-status").className = "badge " + (emergencyStop && emergencyStop.active ? "bad" : "good");
        setText("approval-grant-count", grants.length);
        setText("approval-history-count", approvalHistory.length);
        state.approvalTokens = Object.create(null);
        state.approvalContentDigests = Object.create(null);
        renderApprovalGrants(grants);
        renderApprovalHistory(approvalHistory);

        if (pending.length === 0) {
          setHtml("approval-list", '<div class="queue-item muted">no pending approvals</div>');
          return;
        }

        setHtml(
          "approval-list",
          pending
            .map(function (item) {
              const level = item.approval_level || "unknown";
              const finalBadge = item.final_review_required ? badge("Final Review", "review") : badge("one-time", "good");
              const riskTone = item.risk === "high" || item.risk === "critical" ? "bad" : item.risk === "medium" ? "warn" : "good";
              const authority = item.authority_trace ? compactJson(redactRuntimeValue(item.authority_trace)) : "not recorded";
              const trace = isObject(item.operation_core) ? item.operation_core : {};
              const cronReview = isObject(item.cron_no_replay_review) && item.cron_no_replay_review.kind === "cron_no_replay"
                ? item.cron_no_replay_review
                : null;
              const goalPurposeReview = isObject(item.goal_purpose_change_review) && item.goal_purpose_change_review.kind === "goal_purpose_change"
                ? item.goal_purpose_change_review
                : null;
              const goalPurposeRelationReview = isObject(item.goal_purpose_relation_review) &&
                item.goal_purpose_relation_review.kind === "task_purpose_relation" ? item.goal_purpose_relation_review : null;
              const meaningUpdateReview = isObject(item.meaning_update_review) &&
                item.meaning_update_review.kind === "meaning_update_adoption" ? item.meaning_update_review : null;
              const requiresContentReview = item.content_review_required === true;
              const approveBlocked = requiresContentReview || Boolean(cronReview && cronReview.eligible !== true) ||
                Boolean(meaningUpdateReview && meaningUpdateReview.review_status === "stale");
              if (item.command_id && item.approval_token) {
                state.approvalTokens[item.command_id] = item.approval_token;
              }
              return '<article class="queue-item" data-command="' + escapeHtml(item.command_id || "") + '"' +
                 (meaningUpdateReview ? ' data-proposal-digest="' + escapeHtml(meaningUpdateReview.proposal_digest) +
                   '" data-candidate-digest="' + escapeHtml(meaningUpdateReview.candidate_digest) +
                   '" data-target-record-id="' + escapeHtml(meaningUpdateReview.target_record_id) +
                   '" data-target-version="' + escapeHtml(meaningUpdateReview.target_version) + '"' : '') +
                 (goalPurposeRelationReview ? ' data-plan-id-digest="' + escapeHtml(goalPurposeRelationReview.plan_id_digest) +
                  '" data-task-digest="' + escapeHtml(goalPurposeRelationReview.task_digest) +
                  '" data-revision-digest="' + escapeHtml(goalPurposeRelationReview.revision_digest) +
                  '" data-goal-ref="' + escapeHtml(goalPurposeRelationReview.goal_ref) +
                  '" data-purpose-version="' + escapeHtml(goalPurposeRelationReview.purpose_version) +
                  '" data-purpose-digest="' + escapeHtml(goalPurposeRelationReview.purpose_digest) +
                  '" data-relation-outcome="' + escapeHtml(goalPurposeRelationReview.outcome) + '"' : '') + '>' +
                '<div class="row"><h3>' + escapeHtml(item.operation || "unknown operation") + '</h3><span>' + finalBadge + '</span></div>' +
                '<dl class="kv">' +
                '<dt>command</dt><dd class="mono">' + escapeHtml(item.command_id || "unknown") + '</dd>' +
                '<dt>request</dt><dd class="mono">' + escapeHtml(item.request_id || "unknown") + '</dd>' +
                (item.target ? '<dt>target</dt><dd>' + escapeHtml(item.target) + '</dd>' : '') +
                '<dt>risk</dt><dd>' + badge(item.risk || "unknown", riskTone) + '</dd>' +
              '<dt>ApprovalLevel</dt><dd>' + badge(level, level === "L3_final_review" ? "review" : "good") + '</dd>' +
                '<dt>adapter</dt><dd>' + badge(trace.adapter || "not recorded", trace.adapter_is_authority === false ? "good" : "warn") + '</dd>' +
                '<dt>runtime</dt><dd>' + escapeHtml(trace.runtime_boundary || "not recorded") + '</dd>' +
                '<dt>effect</dt><dd>' + escapeHtml(Array.isArray(trace.effects) ? trace.effects.join(", ") : "not recorded") + '</dd>' +
                '<dt>expires</dt><dd>' + escapeHtml(formatDate(item.approval_token_expires_at_ms)) + '</dd>' +
                '<dt>reason</dt><dd>' + escapeHtml(item.reason || "not recorded") + '</dd>' +
                '</dl>' +
                '<pre>' + escapeHtml(authority) + '</pre>' +
                (cronReview
                  ? '<section class="approval-content-review"><strong>Exact Cron event reviewed before approval</strong><dl class="kv">' +
                    (cronReview.event_id ? '<dt>event ID</dt><dd class="mono">' + escapeHtml(cronReview.event_id) + '</dd>' : '') +
                    (cronReview.payload_digest ? '<dt>payload digest</dt><dd class="mono">' + escapeHtml(cronReview.payload_digest) + '</dd>' : '') +
                    (cronReview.delivery_state ? '<dt>cursor state</dt><dd>' + escapeHtml(cronReview.delivery_state) + '</dd>' : '') +
                    '<dt>disposition</dt><dd>acknowledge no replay</dd>' +
                    '<dt>external outcome</dt><dd>unknown</dd>' +
                    '<dt>approval readiness</dt><dd>' + escapeHtml(cronReview.status || "unknown") + '</dd>' +
                    '</dl><p class="muted">Approval allows the next Cron event to proceed; it does not confirm this delivery. The event identity and in-flight state are checked again before recording.</p></section>'
                  : '') +
                (goalPurposeReview
                  ? '<section class="approval-content-review"><strong>Delegated goal purpose change</strong><dl class="kv">' +
                    '<dt>goal reference</dt><dd class="mono">' + escapeHtml(goalPurposeReview.goal_ref) + '</dd>' +
                    '<dt>current version</dt><dd>' + escapeHtml(goalPurposeReview.prior_version) + '</dd>' +
                    '<dt>current purpose digest</dt><dd class="mono">' + escapeHtml(goalPurposeReview.prior_purpose_digest) + '</dd>' +
                    '<dt>proposed purpose digest</dt><dd class="mono">' + escapeHtml(goalPurposeReview.new_purpose_digest) + '</dd>' +
                    '<dt>content review</dt><dd>' + escapeHtml(goalPurposeReview.review_status || "required") + '</dd>' +
                    '</dl><p class="muted">The exact purpose text is held in memory until this approval ends and is revealed only after selecting Review exact purpose.</p></section>'
                  : '') +
                (goalPurposeRelationReview
                  ? '<section class="approval-content-review"><strong>taskと作業目的の関係確認</strong><dl class="kv">' +
                    '<dt>plan digest</dt><dd class="mono">' + escapeHtml(shortDigest(goalPurposeRelationReview.plan_id_digest)) + '</dd>' +
                    '<dt>revision digest</dt><dd class="mono">' + escapeHtml(shortDigest(goalPurposeRelationReview.revision_digest)) + '</dd>' +
                    '<dt>目的版</dt><dd>' + escapeHtml(goalPurposeRelationReview.goal_ref) + ' v' + escapeHtml(goalPurposeRelationReview.purpose_version) + '</dd>' +
                    '<dt>選択した関係</dt><dd>' + escapeHtml(goalPurposeRelationReview.outcome) + '</dd>' +
                    '<dt>内容確認</dt><dd>' + escapeHtml(goalPurposeRelationReview.review_status || "required") + '</dd>' +
                    '</dl><p class="muted">task・目的本文・planはプロセス内だけに保持し、「task・目的の内容を確認」を選んだ後に表示します。承認はこのrevisionへの関係記録だけを行い、実行権限を与えません。</p></section>'
                  : '') +
                (meaningUpdateReview
                  ? '<section class="approval-content-review"><strong>意味更新候補のowner L3確認</strong><dl class="kv">' +
                    '<dt>proposal digest</dt><dd class="mono">' + escapeHtml(meaningUpdateReview.proposal_digest) + '</dd>' +
                    '<dt>candidate digest</dt><dd class="mono">' + escapeHtml(meaningUpdateReview.candidate_digest) + '</dd>' +
                    '<dt>対象記録</dt><dd class="mono">' + escapeHtml(meaningUpdateReview.target_record_id) + '</dd>' +
                    '<dt>対象版</dt><dd class="mono">' + escapeHtml(meaningUpdateReview.target_version) + '</dd>' +
                    '<dt>内容確認</dt><dd>' + escapeHtml(meaningUpdateReview.review_status || "required") + '</dd>' +
                    '<dt>意味関係</dt><dd>not_assessed</dd><dt>採用状態</dt><dd>not_adopted</dd>' +
                    '<dt>実行可能性</dt><dd>false</dd><dt>権限への利用</dt><dd>false</dd>' +
                    '</dl><p class="muted">候補本文は「候補本文を確認」を選ぶまで表示されません。承認前に参照証拠と適用範囲を確認してください。</p></section>'
                  : '') +
                (requiresContentReview
                  ? '<section class="approval-content-review"><button data-review-content="' + escapeHtml(item.command_id || "") + '">' +
                     (goalPurposeReview ? 'Review exact purpose' : goalPurposeRelationReview ? 'task・目的の内容を確認' :
                       meaningUpdateReview ? '候補本文を確認' : item.operation === 'tool.file.edit' ? '変更差分を確認' : 'Review exact content') +
                    '</button><div data-content-review-view aria-live="polite">Content has not been revealed.</div></section>'
                  : '') +
                '<div class="action-row">' +
                '<button class="primary" data-verdict="approve" data-command="' + escapeHtml(item.command_id || "") + '"' + (approveBlocked ? ' disabled' : '') + '>Approve</button>' +
                '<button data-verdict="reject" data-command="' + escapeHtml(item.command_id || "") + '">Reject</button>' +
                '<button class="danger" data-verdict="block" data-command="' + escapeHtml(item.command_id || "") + '">Block</button>' +
                '</div>' +
                '</article>';
            })
            .join("")
        );
      }

      function renderApprovalGrants(grants) {
        if (!Array.isArray(grants) || grants.length === 0) {
          setHtml("approval-grant-list", '<div class="queue-item muted">no reusable grants</div>');
          return;
        }
        setHtml(
          "approval-grant-list",
          grants
            .map(function (grant) {
              const revocable = grant.revocable === true;
              const revokeButton = revocable
                ? '<button class="danger" data-revoke-grant="' + escapeHtml(grant.id || "") + '">Revoke</button>'
                : badge("system", "good");
              const fields = [
                ["id", grant.id || "unknown"],
                ["mode", grant.mode || "unknown"],
                ["decision", grant.decision || "unknown"],
                ["operation", grant.operation || "unknown"],
                ["scope", grant.target_scope || "unknown"],
                ["target", grant.target || grant.path_pattern || grant.channel || "any"],
                ["risk", grant.risk || "unknown"],
                ["actor", grant.actor || "unknown"],
                ["created_by", grant.created_by || "unknown"],
                ["expires", formatDate(grant.expires_at)]
              ];
              return '<article class="queue-item">' +
                '<div class="row"><h3>' + escapeHtml(grant.operation || "approval grant") + '</h3><span>' + (revocable ? badge("revocable", "review") : badge("fixed", "good")) + '</span></div>' +
                '<dl class="kv">' +
                fields
                  .map(function (field) {
                    return '<dt>' + escapeHtml(field[0]) + '</dt><dd>' + escapeHtml(field[1]) + '</dd>';
                  })
                  .join("") +
                '</dl><div class="action-row">' + revokeButton + '</div></article>';
            })
            .join("")
        );
      }

      function renderApprovalHistory(history) {
        if (!Array.isArray(history) || history.length === 0) {
          setHtml("approval-history-list", '<div class="history-item muted">no approval history</div>');
          return;
        }
        setHtml(
          "approval-history-list",
          history
            .slice(-12)
            .reverse()
            .map(function (entry) {
              const trace = isObject(entry.operation_core) ? entry.operation_core : {};
              const fields = [
                ["event", entry.event || "unknown"],
                ["request", entry.request_id || "none"],
                ["command", entry.command_id || "none"],
                ["grant", entry.grant_id || "none"],
                ["actor", entry.actor || "unknown"],
                ["decision", entry.decision || "none"],
                ["operation", entry.operation || "none"],
                ["risk", entry.risk || "none"],
                ["ApprovalLevel", entry.approval_level || "none"],
                ["adapter", trace.adapter || "not recorded"],
                ["runtime", trace.runtime_boundary || "not recorded"],
                ["effect", Array.isArray(trace.effects) ? trace.effects.join(", ") : "not recorded"],
                ["reason", entry.reason || "none"],
                ["content review", entry.content_review_digest || "not recorded"],
                ["payload", entry.payload_digest || "not recorded"],
                ["authority", entry.used_for_authority === false ? "false" : "unsafe"],
                ["time", formatDate(entry.timestamp)]
              ];
              return '<article class="history-item"><dl class="kv">' +
                fields
                  .map(function (field) {
                    return '<dt>' + escapeHtml(field[0]) + '</dt><dd>' + escapeHtml(field[1]) + '</dd>';
                  })
                  .join("") +
                '</dl></article>';
            })
            .join("")
        );
      }

      function renderNotifications(body) {
        const notifications = Array.isArray(body.notifications) ? body.notifications : [];
        setText("notification-summary", String(notifications.length) + " active");
        byId("notification-summary").className = "badge " + (notifications.length > 0 ? "review" : "good");

        if (notifications.length === 0) {
          setHtml("notification-list", '<div class="notification-item muted">no resident notifications</div>');
          return;
        }

        setHtml(
          "notification-list",
          notifications
            .map(function (item) {
              const fields = [
                ["kind", item.kind || "unknown"],
                ["severity", badge(item.severity || "info", severityTone(item.severity))],
                ["source", item.source || "unknown"],
                ["request", item.request_id || "none"],
                ["command", item.command_id || "none"],
                ["schedule", item.schedule_id || "none"],
                ["ApprovalLevel", item.approval_level || "none"],
                ["risk", item.risk || "none"],
                ["payload", item.payload_hash || "not recorded"],
                ["next", item.next_action || "none"],
                ["authority", item.authority || "display_only"]
              ];
              if (item.result_correlation_status) {
                fields.push(["result correlation", item.result_correlation_status]);
              }
              if (item.result_memory_status) {
                fields.push(["result memory", item.result_memory_status]);
              }
              if (item.external_receipt_observation_status) {
                fields.push(["receipt observation", item.external_receipt_observation_status]);
              }
              if (item.external_receipt_observation_source) {
                fields.push(["receipt source", item.external_receipt_observation_source]);
              }
              if (item.cron_resolution_state) {
                fields.push(["Cron resolution", item.cron_resolution_state]);
              }
              return '<article class="notification-item">' +
                '<div class="row"><h3>' + escapeHtml(item.title || "Notification") + '</h3>' + badge("read only", "good") + '</div>' +
                '<p class="muted">' + escapeHtml(item.message || "") + '</p>' +
                '<dl class="kv">' +
                fields
                  .map(function (field) {
                    const value = field[0] === "severity" ? field[1] : escapeHtml(field[1]);
                    return '<dt>' + escapeHtml(field[0]) + '</dt><dd>' + value + '</dd>';
                  })
                  .join("") +
                '</dl>' +
                '</article>';
            })
            .join("")
        );
      }

      function renderAudit(body) {
        const chainValid = body.chain_valid ?? body.valid ?? body.audit_chain_valid;
        const entries = Array.isArray(body.entries) ? body.entries : Array.isArray(body.audit_log) ? body.audit_log : [];
        setText("audit-chain-valid", labelForBoolean(chainValid));
        setText("audit-entry-count", entries.length);
        setText("audit-status", chainValid === true ? "valid" : chainValid === false ? "invalid" : "unknown");
        byId("audit-status").className = "badge " + toneForBoolean(chainValid);

        if (entries.length === 0) {
          setHtml("audit-list", '<div class="audit-item muted">no audit entries in response</div>');
          return;
        }

        setHtml(
          "audit-list",
          entries
            .slice(-6)
            .reverse()
            .map(function (entry) {
              const safe = redactRuntimeValue(entry);
              const event = safe.event || safe.kind || "audit";
              const actor = safe.actor || safe.channel || "unknown";
              const hash = safe.payload_hash || safe.hash || "not recorded";
              return '<article class="audit-item"><dl class="kv">' +
                '<dt>event</dt><dd>' + escapeHtml(event) + '</dd>' +
                '<dt>actor</dt><dd>' + escapeHtml(actor) + '</dd>' +
                '<dt>hash</dt><dd class="mono">' + escapeHtml(hash) + '</dd>' +
                '<dt>time</dt><dd>' + escapeHtml(safe.timestamp || safe.timestamp_ms || "not recorded") + '</dd>' +
                '</dl></article>';
            })
            .join("")
        );
      }

      function renderAuthorityTrace(body) {
        const trace = Array.isArray(body.authority_trace) ? body.authority_trace : Array.isArray(body.trace) ? body.trace : [];
        setText("authority-summary", String(trace.length) + " events");
        byId("authority-summary").className = "badge " + (trace.length > 0 ? "good" : "warn");

        if (trace.length === 0) {
          setHtml("authority-trace-list", '<div class="trace-item muted">no authority trace events</div>');
        } else {
          setHtml(
            "authority-trace-list",
            trace
              .slice(-10)
              .reverse()
              .map(function (entry) {
                const safe = redactRuntimeValue(entry);
                return '<article class="trace-item"><dl class="kv">' +
                  '<dt>event</dt><dd>' + escapeHtml(safe.event || safe.kind || "unknown") + '</dd>' +
                  '<dt>request</dt><dd class="mono">' + escapeHtml(safe.request_id || "none") + '</dd>' +
                  '<dt>command</dt><dd class="mono">' + escapeHtml(safe.command_id || "none") + '</dd>' +
                  '<dt>operation</dt><dd>' + escapeHtml(safe.operation || "none") + '</dd>' +
                  '<dt>risk</dt><dd>' + escapeHtml(safe.risk || "unknown") + '</dd>' +
                  '<dt>ApprovalLevel</dt><dd>' + escapeHtml(safe.approval_level || "unknown") + '</dd>' +
                  '<dt>schedule</dt><dd class="mono">' + escapeHtml(safe.schedule_id || "none") + '</dd>' +
                  '<dt>hash</dt><dd class="mono">' + escapeHtml(safe.payload_hash || "not recorded") + '</dd>' +
                  '</dl></article>';
              })
              .join("")
          );
        }

        setText("authority-json", compactJson(redactRuntimeValue(body)));
      }

      function renderHistory(body) {
        const history = body.history || body;
        const entries = Array.isArray(history.entries) ? history.entries : [];
        const chainValid = history.chain_valid === true;
        const authorityUsed = history.complete_history_used_for_authority === true;

        setText("history-entry-count", history.entries_count ?? entries.length);
        setText("history-chain-valid", labelForBoolean(chainValid));
        setText("history-authority-use", authorityUsed ? "unsafe" : "digest only");
        setText("history-skipped-count", history.skipped_count ?? 0);
        setText("history-summary", String(entries.length) + " replay entries");
        byId("history-summary").className = "badge " + (chainValid && !authorityUsed ? "good" : "bad");

        if (entries.length === 0) {
          setHtml("history-list", '<div class="history-item muted">no replay entries</div>');
        } else {
          setHtml(
            "history-list",
            entries
              .slice(-12)
              .reverse()
              .map(function (entry) {
                const safe = redactRuntimeValue(entry);
                const boundaryBadge = safe.used_for_authority === false ? badge("digest only", "good") : badge("unsafe", "bad");
                return '<article class="history-item"><dl class="kv">' +
                  '<dt>kind</dt><dd>' + escapeHtml(safe.kind || "unknown") + '</dd>' +
                  '<dt>request</dt><dd class="mono">' + escapeHtml(safe.request_id || "none") + '</dd>' +
                  '<dt>command</dt><dd class="mono">' + escapeHtml(safe.command_id || "none") + '</dd>' +
                  '<dt>actor</dt><dd>' + escapeHtml(safe.actor || "unknown") + '</dd>' +
                  '<dt>source</dt><dd>' + escapeHtml(safe.source || "unknown") + '</dd>' +
                  '<dt>payload</dt><dd class="mono">' + escapeHtml(safe.payload_digest || "not recorded") + '</dd>' +
                  '<dt>entry</dt><dd class="mono">' + escapeHtml(safe.entry_hash || "not recorded") + '</dd>' +
                  '<dt>boundary</dt><dd>' + boundaryBadge + '</dd>' +
                  '<dt>time</dt><dd>' + escapeHtml(formatDate(safe.timestamp)) + '</dd>' +
                  '</dl></article>';
              })
              .join("")
          );
        }

        setText("history-json", compactJson(redactRuntimeValue(history)));
      }

      function renderEvidenceExport(body) {
        const evidence = body.evidence || body;
        const redaction = evidence.secret_redaction || {};
        const manifestFiles = evidence.manifest && Array.isArray(evidence.manifest.files)
          ? evidence.manifest.files.map(function (file) { return file.path; })
          : evidence.files || [];
        const auditOk = evidence.audit_chain_valid === true;
        const historyOk = evidence.complete_history_chain_valid === true;
        const redactionOk = redaction.scan_ok === true;
        const authorityOk = evidence.used_for_authority === false && evidence.hds_brain_remains_authority === true;

        setText("evidence-pack-path", evidence.pack_dir || "not exported");
        setText("evidence-audit-chain", labelForBoolean(auditOk));
        setText("evidence-history-chain", labelForBoolean(historyOk));
        setText("evidence-redaction-status", redactionOk ? "redacted" : "review");
        setText("evidence-authority-status", authorityOk ? "HDS path" : "unsafe");
        setText("evidence-export-status", manifestFiles.length + " files");
        byId("evidence-export-status").className = "badge " + (auditOk && historyOk && redactionOk && authorityOk ? "good" : "bad");
        setText("evidence-json", compactJson(redactRuntimeValue({
          pack_dir: evidence.pack_dir,
          files: manifestFiles,
          audit_chain_valid: evidence.audit_chain_valid,
          complete_history_chain_valid: evidence.complete_history_chain_valid,
          retention: evidence.retention,
          secret_redaction: evidence.secret_redaction,
          used_for_authority: evidence.used_for_authority,
          hds_brain_remains_authority: evidence.hds_brain_remains_authority
        })));
      }

      function renderSettingsSnapshot(snapshot) {
        const llm = snapshot.llm || {};
        const openrouter = snapshot.integrations && snapshot.integrations.openrouter ? snapshot.integrations.openrouter : {};
        const composio = snapshot.integrations && snapshot.integrations.composio ? snapshot.integrations.composio : {};
        const toolkits = Array.isArray(composio.allowed_toolkits) ? composio.allowed_toolkits : [];
        const actions = Array.isArray(composio.allowed_actions) ? composio.allowed_actions : [];
        const revoked = Array.isArray(composio.revoked_actions) ? composio.revoked_actions : [];
        byId("settings-provider").value = llm.provider || "stub";
        byId("settings-model").value = llm.model || "";
        byId("settings-endpoint").value = llm.endpoint || "";
        byId("settings-api-key").value = "";
        byId("settings-api-key").placeholder = llm.api_key_set ? "configured" : "not set";
        byId("settings-site-url").value = llm.site_url || "";
        byId("settings-app-title").value = llm.app_title || "";
        byId("settings-max-tokens").value = llm.max_tokens || "";
        byId("settings-approval-mode").value = (snapshot.approval && snapshot.approval.mode) || "full_access";
        setText("settings-provider-status", llm.provider || "stub");
        setText("settings-model-status", llm.model || "(provider default)");
        setText("settings-writable-status", snapshot.writable ? "writable" : "read only");
        setText("settings-key-status", llm.api_key_set ? "set" : "missing");
        setText("settings-approval-mode-status", (snapshot.approval && snapshot.approval.mode) || "full_access");
        setText("settings-openrouter-status", openrouter.configured ? "configured" : "not configured");
        setText("settings-json", compactJson(redactRuntimeValue(snapshot)));
        byId("composio-api-key").value = "";
        byId("composio-api-key").placeholder = composio.configured ? "configured" : "not set";
        byId("composio-user-id").value = "";
        byId("composio-user-id").placeholder = composio.user_id_set ? "configured" : "not set";
        byId("composio-allowed-toolkits").value = toolkits.join(",");
        byId("composio-allowed-actions").value = actions.join(",");
        byId("composio-revoked-actions").value = revoked.join(",");
        byId("composio-api-base-url").value = composio.api_base_url || "";
        byId("composio-dry-run").value = String(composio.dry_run !== false);
        byId("composio-live-execution").value = String(composio.live_execution_enabled === true);
        byId("composio-clear-api-key").checked = false;
        setText("composio-configured-status", composio.configured ? "configured" : "not configured");
        setText("composio-dry-run-status", composio.dry_run === false ? "false" : "true");
        setText("composio-live-opt-in-status", composio.live_execution_enabled ? "enabled" : "disabled");
        setText("composio-live-status", composio.live_execution_available ? "available" : "blocked");
        setText("composio-authority-status", composio.used_for_authority === true ? "unsafe" : "HDS gated");
        setText("composio-toolkits-status", toolkits.length > 0 ? toolkits.join(", ") : "none");
        setText("composio-actions-status", actions.length > 0 ? actions.join(", ") : "none");
        setText("composio-revoked-status", revoked.length > 0 ? revoked.join(", ") : "none");
        setText("composio-user-status", composio.user_id_set ? "configured" : "missing");
        setText("composio-disconnect-status", composio.connection_revoke_available ? "available" : "not configured");
        setText("connectors-json", compactJson(redactRuntimeValue({
          native_first: snapshot.integrations ? snapshot.integrations.native_first : true,
          composio
        })));
      }

      function renderAboutSnapshot(snapshot) {
        const release = snapshot.release || {};
        const claim = snapshot.claim_boundary || {};
        const authority = snapshot.authority_boundary || {};
        const pkg = snapshot.package || {};
        setText("about-product-name", snapshot.product_name || "BLUE-TANUKI");
        setText("about-version", pkg.version || "unknown");
        setText("about-license", pkg.license || "unknown");
        setText("about-owner-go", release.owner_go || "unknown");
        setText("about-public-claim", release.public_claim_allowed ? "allowed" : "blocked");
        setText("about-signed-installer", claim.signed_native_installer || "unknown");
        setText("about-automatic-updater", claim.automatic_updater || "unknown");
        setText("about-authority", authority.hds_brain_owns_authority ? "HDS-BRAIN" : "unknown");
        setText("about-release-status", release.stage || "unknown");
        byId("about-release-status").className = "badge " + (release.public_claim_allowed ? "good" : "warn");
        setText("about-json", compactJson(redactRuntimeValue(snapshot)));
      }

      function renderUpdateSnapshot(snapshot) {
        const candidate = snapshot.candidate || {};
        const compat = snapshot.compatibility || {};
        const rollback = snapshot.rollback || {};
        const dist = snapshot.distribution_boundary || {};
        const authority = snapshot.authority_boundary || {};
        const pkg = snapshot.package || {};
        setText("update-current-version", pkg.current_version || "unknown");
        setText("update-candidate-status", candidate.verification_status || "unknown");
        setText("update-candidate-version", candidate.version || "unknown");
        setText("update-sha-status", candidate.sha256_matches ? "match" : candidate.sha256_exists ? "mismatch" : "missing");
        setText("update-manifest-status", candidate.manifest_matches ? "match" : candidate.manifest_exists ? "mismatch" : "missing");
        setText("update-compatibility-status", compat.status || "unknown");
        setText("update-rollback-status", rollback.latest_plan_id || "not prepared");
        setText("update-auto-status", dist.automatic_updater_shipped ? "shipped" : "not shipped");
        setText("update-authority-status", authority.used_for_authority === true ? "unsafe" : "HDS gated");
        setText("update-next-action-status", snapshot.next_safe_action || "not loaded");
        setText("update-boundary-status", snapshot.mode || "manual");
        byId("update-boundary-status").className = "badge " + (candidate.verification_status === "pass" ? "good" : "warn");
        byId("update-candidate-status").className = "badge " + (candidate.verification_status === "pass" ? "good" : candidate.verification_status === "fail" ? "bad" : "warn");
        byId("update-sha-status").className = "badge " + (candidate.sha256_matches ? "good" : "warn");
        byId("update-manifest-status").className = "badge " + (candidate.manifest_matches ? "good" : "warn");
        byId("update-compatibility-status").className = "badge " + (compat.status === "pass" ? "good" : compat.status === "blocked" ? "bad" : "warn");
        byId("update-auto-status").className = "badge " + (dist.automatic_updater_shipped ? "bad" : "good");
        byId("update-authority-status").className = "badge " + (authority.used_for_authority === true ? "bad" : "good");
        setText("update-json", compactJson(redactRuntimeValue(snapshot)));
      }

      function renderUpdateActionResult(body) {
        const result = body.result || body;
        setText("update-action-status", result.action ? result.action + " completed" : "completed");
        setText("update-next-action-status", result.next_safe_action || "not loaded");
        byId("update-action-status").className = "badge review";
        setText("update-json", compactJson(redactRuntimeValue(result)));
      }

      function formatRecoveryPostActionPlanResiduals(observation) {
        if (!observation || observation.operation !== "restore" || observation.store_key !== "operation_plans" ||
            !Array.isArray(observation.plan_residuals) || observation.plan_residuals.length > 64) return "未観測";
        const categories = ["operation_plan", "broker", "delivery", "memory", "cron_approval"];
        const seen = new Set();
        const rows = [];
        for (const item of observation.plan_residuals) {
          if (!item || typeof item !== "object" || typeof item.plan_id_digest !== "string" ||
              !/^[a-f0-9]{64}$/.test(item.plan_id_digest) ||
              !["verified", "residuals_present"].includes(item.status) ||
              !Number.isSafeInteger(item.binding_count) || item.binding_count < 0 ||
              !Number.isSafeInteger(item.residual_binding_count) || item.residual_binding_count < 0 ||
              !Number.isSafeInteger(item.omitted_binding_count) || item.omitted_binding_count < 0 ||
              item.residual_binding_count > item.binding_count || item.omitted_binding_count > item.binding_count ||
              seen.has(item.plan_id_digest)) return "未確認（表示を抑止）";
          seen.add(item.plan_id_digest);
          rows.push("計画digest " + item.plan_id_digest.slice(0, 12) + "・計画内検査: " +
            (item.status === "verified" ? "検証済み" : "残差あり") + "・binding " + item.binding_count +
            "・残差binding " + item.residual_binding_count + "・未表示binding " + item.omitted_binding_count);
        }
        const restoreDigest = observation.restore_backup_id_digest;
        const restorePoints = observation.plan_restore_points;
        if (restoreDigest !== null && (typeof restoreDigest !== "string" || !/^[a-f0-9]{64}$/.test(restoreDigest))) {
          return "未確認（表示を抑止）";
        }
        if (restorePoints !== null) {
          if (!restoreDigest || !Array.isArray(restorePoints) || restorePoints.length !== rows.length || restorePoints.length > 64) {
            return "未確認（表示を抑止）";
          }
          const pointSeen = new Set();
          const statusLabels = { matched: "一意に一致", not_found: "記録なし", ambiguous: "複数または不定", unverified: "未確認" };
          const dependencyLabels = { observed: "観測範囲内", residuals_present: "残差あり", unobserved: "未観測あり", unknown: "未確認" };
          for (let index = 0; index < restorePoints.length; index += 1) {
            const point = restorePoints[index];
            const backupPlanStatus = point && point.backup_plan_record_status;
            const backupPlanIntegrity = point && point.backup_plan_integrity;
            const backupPlanRecordCount = point && point.backup_plan_record_count;
            const dependencyStatus = point && point.dependency_status;
            const residualDependencies = point && point.residual_dependencies;
            const unobservedDependencies = point && point.unobserved_dependencies;
            if (!point || typeof point !== "object" || point.plan_id_digest !== observation.plan_residuals[index].plan_id_digest ||
                !/^[a-f0-9]{64}$/.test(point.plan_id_digest) || pointSeen.has(point.plan_id_digest) ||
                !Object.prototype.hasOwnProperty.call(statusLabels, backupPlanStatus) ||
                ![null, "verified", "residuals_present"].includes(backupPlanIntegrity) ||
                !(backupPlanRecordCount === null ||
                  (Number.isSafeInteger(backupPlanRecordCount) && backupPlanRecordCount >= 0)) ||
                !Object.prototype.hasOwnProperty.call(dependencyLabels, dependencyStatus) ||
                !Array.isArray(residualDependencies) || !Array.isArray(unobservedDependencies) ||
                residualDependencies.some((category) => !categories.includes(category)) ||
                unobservedDependencies.some((category) => !categories.includes(category)) ||
                new Set(residualDependencies).size !== residualDependencies.length ||
                new Set(unobservedDependencies).size !== unobservedDependencies.length ||
                (backupPlanStatus === "matched" && (backupPlanIntegrity === null || backupPlanRecordCount !== 1)) ||
                (backupPlanStatus === "not_found" && (backupPlanIntegrity !== null || backupPlanRecordCount !== null)) ||
                (backupPlanStatus === "unverified" && (backupPlanIntegrity !== null || backupPlanRecordCount !== null)) ||
                (backupPlanStatus === "ambiguous" && backupPlanRecordCount === 1) ||
                (dependencyStatus === "observed" && (residualDependencies.length > 0 || unobservedDependencies.length > 0)) ||
                (dependencyStatus === "residuals_present" && residualDependencies.length === 0) ||
                (dependencyStatus === "unobserved" && unobservedDependencies.length === 0) ||
                (dependencyStatus === "unknown" && (residualDependencies.length > 0 || unobservedDependencies.length > 0))) {
              return "未確認（表示を抑止）";
            }
            pointSeen.add(point.plan_id_digest);
            rows[index] += "・同一backup内計画記録: " + statusLabels[point.backup_plan_record_status] +
              "・backup内計画検査: " + (backupPlanIntegrity === null ? "未確認" :
                backupPlanIntegrity === "verified" ? "検証済み" : "残差あり") +
              "・依存: " + dependencyLabels[dependencyStatus] +
              "（残差 " + residualDependencies.join("・") + "／未観測 " + unobservedDependencies.join("・") + "）";
          }
        }
        const digestLabel = restoreDigest ? "復元元backup digest " + restoreDigest.slice(0, 12) : "復元元backup digest 未記録";
        const associationLabel = restorePoints === null ? "計画別backup相関: 未観測" : "計画別backup相関: 読取検査";
        return digestLabel + "・" + associationLabel + "\\n" + (rows.length > 0 ? rows.join("\\n") : "対象計画なし");
      }

      function renderRecoverySnapshot(snapshot) {
        const envFile = snapshot.env_file || {};
        const packs = snapshot.recovery_backups || {};
        const restore = snapshot.restore || {};
        const authority = snapshot.authority_boundary || {};
        const paths = snapshot.runtime_paths || {};
        const observation = snapshot.post_action_observation || {};
        const operationLabels = {
          restore: "復元",
          provider_reset: "プロバイダー設定リセット",
          connector_reset: "接続設定リセット",
          factory_reset: "工場リセット",
        };
        const storeLabels = {
          j_control: "J制御台帳",
          m_state: "M状態台帳",
          broker: "Broker台帳",
          operation_plans: "Operation Plan台帳",
          cron_events: "Cron台帳",
        };
        const storeLedgerStatusLabels = {
          verified: "検証済み",
          residuals_present: "残差あり",
          projection_mismatch: "投影不一致",
          corrupt: "破損",
          schema_mismatch: "schema不一致",
          unavailable: "利用不可",
          unverified: "未確認",
        };
        const operationLabel = Object.prototype.hasOwnProperty.call(operationLabels, observation.operation)
          ? operationLabels[observation.operation]
          : "復旧操作";
        const storeLabel = Object.prototype.hasOwnProperty.call(storeLabels, observation.store_key)
          ? storeLabels[observation.store_key]
          : null;
        let observationLabel = "未確認";
        let observationTone = "warn";
        if (observation.operation === "restore" && observation.status === "matched" && storeLabel) {
          observationLabel = storeLabel + "・復元直後の状態と一致";
          observationTone = "good";
        } else if (observation.operation === "restore" && observation.status === "changed" && storeLabel) {
          observationLabel = storeLabel + "・復元後に状態変更を観測";
          observationTone = "warn";
        } else if (observation.operation === "restore" && observation.status === "mismatch" && storeLabel) {
          observationLabel = storeLabel + "・復元状態と不一致";
          observationTone = "bad";
        } else if (observation.operation === "restore" && observation.status === "unverified") {
          observationLabel = storeLabel ? storeLabel + "・再起動後の状態は未確認" : "復元操作・未確認";
        } else if (observation.status === "changed") {
          observationLabel = operationLabel + "・設定変更済み";
          observationTone = "good";
        } else if (observation.status === "failed") {
          observationLabel = operationLabel + "・操作失敗、現状態は未確認";
          observationTone = "bad";
        } else if (observation.status === "no_record") {
          observationLabel = "実行記録なし・未確認";
        } else if (observation.status === "unverified" && observation.operation) {
          observationLabel = observation.configuration_state === "provider_connector_dry_run"
            ? "工場リセット・設定変更確認、全体は未確認"
            : operationLabel + "・未確認";
        }
        if (observation.operation === "restore" && storeLabel &&
            Object.prototype.hasOwnProperty.call(storeLedgerStatusLabels, observation.store_ledger_status)) {
          const ledgerStatusLabel = storeLedgerStatusLabels[observation.store_ledger_status];
          const residualCount = Number.isSafeInteger(observation.store_ledger_residual_count) &&
            observation.store_ledger_residual_count >= 0
            ? observation.store_ledger_residual_count
            : "未観測";
          observationLabel += "・台帳検査: " + ledgerStatusLabel + "（残件 " + residualCount + "）";
        }
        setText("recovery-post-action-observation", observationLabel);
        byId("recovery-post-action-observation").className = "badge " + observationTone;
        setText("recovery-post-action-plan-residuals", formatRecoveryPostActionPlanResiduals(observation));
        setText("recovery-env-file-status", envFile.exists ? "present" : envFile.configured ? "missing" : "not configured");
        setText("recovery-env-backup-count", envFile.backup_count ?? 0);
        setText("recovery-pack-count", packs.backup_count ?? 0);
        setText("recovery-latest-backup", packs.latest_backup_id || envFile.latest_backup_path || "none");
        if (packs.latest_backup_id) byId("recovery-backup-id").placeholder = packs.latest_backup_id;
        const restoreReviewAvailable = restore.restore_review_request_available === true;
        const providerReviewAvailable = restore.provider_reset_review_request_available === true;
        const connectorReviewAvailable = restore.connector_reset_review_request_available === true;
        const factoryReviewAvailable = restore.factory_reset_review_request_available === true;
        setText("recovery-restore-status", restoreReviewAvailable ? "owner review required" : "unavailable");
        setText("recovery-factory-reset-status", factoryReviewAvailable ? "owner review required" : "unavailable");
        setText("recovery-action-guard", restore.blocked_reason === "owner_l3_review_required"
          ? "Submitting a request only queues the exact action for owner L3 review. No recovery change runs until the owner approves it in the approval queue."
          : "Recovery mutation status is unavailable.");
        byId("restore-recovery-backup").disabled = !restoreReviewAvailable;
        byId("recovery-restore-store").setAttribute("data-review-available", restoreReviewAvailable ? "true" : "false");
        byId("restore-recovery-store").disabled = !restoreReviewAvailable || !byId("recovery-restore-store").value;
        byId("reset-recovery-provider").disabled = !providerReviewAvailable;
        byId("reset-recovery-connector").disabled = !connectorReviewAvailable;
        byId("factory-reset-recovery").disabled = !factoryReviewAvailable;
        setText("recovery-authority-status", authority.used_for_authority === true
          ? "unsafe"
          : restore.blocked_reason === "owner_l3_review_required" ? "HDS L3 required" : "HDS gated");
        setText("recovery-next-action", snapshot.next_safe_action || "review recovery readiness");
        setText("recovery-boundary-status", snapshot.mode || "read only");
        byId("recovery-boundary-status").className = "badge " + (snapshot.mode === "control_available" ? "review" : "good");
        byId("recovery-restore-status").className = "badge " + (restoreReviewAvailable ? "review" : "warn");
        byId("recovery-factory-reset-status").className = "badge " + (factoryReviewAvailable ? "review" : "warn");
        byId("recovery-authority-status").className = "badge " + (authority.used_for_authority === true ? "bad" : "good");
        setHtml(
          "recovery-path-list",
          Object.keys(paths)
            .map(function (key) {
              const item = paths[key] || {};
              const state = item.exists ? item.kind || "present" : item.configured ? "missing" : "unset";
              const tone = item.exists ? "good" : item.configured ? "warn" : "warn";
              return '<div class="metric"><span>' + escapeHtml(key) + '</span><span>' + badge(state, tone) + '</span></div>';
            })
            .join("")
        );
        setText("recovery-json", compactJson(redactRuntimeValue(snapshot)));
      }

      function renderRecoveryActionResult(body) {
        const result = body.result || body;
        const queued = result.status === "approval_required" && result.executed === false;
        const label = queued ? "queued for owner review" : result.status === "blocked_authority" ? "blocked" : "not executed";
        setText("recovery-action-status", label);
        byId("recovery-action-status").className = "badge " + (queued ? "review" : "warn");
        setText("recovery-json", compactJson(redactRuntimeValue(result)));
      }

      function recoveryInspectionEnum(value, allowed) {
        return allowed.indexOf(value) >= 0 ? value : "unknown";
      }

      function recoveryInspectionCount(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
      }

      function recoveryInspectionDigest(value) {
        return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
      }

      function recoveryBackupStoreStatuses(value) {
        const expectedKeys = ["j_control", "m_state", "broker", "operation_plans", "cron_events"];
        const allowedStatuses = ["verified", "captured_unverified", "snapshot_failed", "not_present"];
        if (!Array.isArray(value)) return null;
        if (value.length === 0) return [];
        if (value.length !== expectedKeys.length) return null;
        const seen = new Set();
        const projected = [];
        for (let index = 0; index < value.length; index += 1) {
          const item = value[index];
          if (!item || typeof item !== "object" || Array.isArray(item) ||
              item.store_key !== expectedKeys[index] || !allowedStatuses.includes(item.status) || seen.has(item.store_key)) return null;
          seen.add(item.store_key);
          projected.push({ store_key: item.store_key, status: item.status });
        }
        return seen.size === expectedKeys.length ? projected : null;
      }

      function recoveryBackupOperationPlanInventory(value) {
        const statuses = ["not_included", "not_present", "snapshot_unverified", "verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"];
        const reasons = [null, "checkpoint_missing", "checkpoint_integrity_mismatch", "binding_mismatch", "cross_ledger_unverified", "store_unavailable", "schema_mismatch", "snapshot_unverified"];
        if (!value || typeof value !== "object" || Array.isArray(value) || !statuses.includes(value.status) ||
            !reasons.includes(value.reason) || value.cross_ledger_correlation !== "not_performed" ||
            value.used_for_authority !== false || value.may_execute !== false || !Array.isArray(value.plan_scopes) || value.plan_scopes.length > 64) return null;
        const countKeys = ["plan_scope_count", "plan_count", "plan_integrity_residual_count", "binding_count", "verified_binding_count",
          "residual_binding_count", "unverified_memory_link_count", "omitted_binding_count", "omitted_plan_scope_count"];
        const countValues = countKeys.map(function (key) { return value[key]; });
        const rows = [];
        const seen = new Set();
        for (const item of value.plan_scopes) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const planDigest = recoveryInspectionDigest(item.plan_id_digest);
          const requestDigest = item.request_scope_digest === null ? null : recoveryInspectionDigest(item.request_scope_digest);
          const integrity = recoveryInspectionEnum(item.integrity, ["verified", "residuals_present"]);
          const planRecordCount = item.plan_record_count;
          const bindingCount = item.binding_count;
          const residualBindingCount = item.residual_binding_count;
          const omittedBindingCount = item.omitted_binding_count;
          if (!planDigest || (item.request_scope_digest !== null && !requestDigest) || integrity === "unknown" || seen.has(planDigest) ||
              !Number.isSafeInteger(planRecordCount) || planRecordCount < 1 || !Number.isSafeInteger(bindingCount) || bindingCount < 0 ||
              !Number.isSafeInteger(residualBindingCount) || residualBindingCount < 0 || residualBindingCount > bindingCount ||
              !Number.isSafeInteger(omittedBindingCount) || omittedBindingCount < 0 || omittedBindingCount > bindingCount) return null;
          seen.add(planDigest);
          rows.push({ plan_id_digest: planDigest, request_scope_digest: requestDigest, integrity,
            plan_record_count: planRecordCount, binding_count: bindingCount,
            residual_binding_count: residualBindingCount, omitted_binding_count: omittedBindingCount });
        }
        const projection = { status: value.status, reason: value.reason, plan_scope_count: value.plan_scope_count,
          plan_count: value.plan_count, plan_integrity_residual_count: value.plan_integrity_residual_count,
          binding_count: value.binding_count, verified_binding_count: value.verified_binding_count,
          residual_binding_count: value.residual_binding_count, unverified_memory_link_count: value.unverified_memory_link_count,
          omitted_binding_count: value.omitted_binding_count, omitted_plan_scope_count: value.omitted_plan_scope_count,
          plan_scopes: rows, cross_ledger_correlation: "not_performed", used_for_authority: false, may_execute: false };
        if (["verified", "residuals_present"].includes(value.status)) {
          if (!countValues.every(function (count) { return Number.isSafeInteger(count) && count >= 0; }) ||
              value.plan_scope_count < rows.length || value.plan_scope_count - rows.length !== value.omitted_plan_scope_count ||
              value.plan_scope_count > value.plan_count || value.plan_integrity_residual_count > value.plan_count ||
              value.binding_count !== value.verified_binding_count + value.residual_binding_count ||
              value.unverified_memory_link_count > value.binding_count || value.omitted_binding_count > value.binding_count ||
              rows.reduce(function (sum, item) { return sum + item.plan_record_count; }, 0) > value.plan_count ||
              rows.reduce(function (sum, item) { return sum + item.binding_count; }, 0) > value.binding_count ||
              rows.reduce(function (sum, item) { return sum + item.residual_binding_count; }, 0) > value.residual_binding_count ||
              rows.reduce(function (sum, item) { return sum + item.omitted_binding_count; }, 0) > value.omitted_binding_count) return null;
          if (value.omitted_plan_scope_count === 0 &&
              (rows.reduce(function (sum, item) { return sum + item.plan_record_count; }, 0) !== value.plan_count ||
               rows.reduce(function (sum, item) { return sum + item.binding_count; }, 0) !== value.binding_count ||
               rows.reduce(function (sum, item) { return sum + item.residual_binding_count; }, 0) !== value.residual_binding_count ||
               rows.reduce(function (sum, item) { return sum + item.omitted_binding_count; }, 0) !== value.omitted_binding_count)) return null;
          if (value.status === "verified" && (value.plan_integrity_residual_count !== 0 || value.residual_binding_count !== 0 ||
              value.unverified_memory_link_count !== 0 || rows.some(function (item) { return item.integrity !== "verified"; }))) return null;
          if (value.status === "residuals_present" && value.plan_integrity_residual_count === 0 &&
              value.residual_binding_count === 0 && value.unverified_memory_link_count === 0) return null;
        } else if (countValues.some(function (count) { return count !== null; }) || rows.length !== 0) return null;
        return projection;
      }

      function recoveryBackupOperationPlanDependencyInventory(value) {
        const statuses = ["not_included", "not_present", "snapshot_unverified", "unavailable", "no_plan_scopes",
          "correlated", "residuals_present", "unobserved"];
        const reasons = [null, "snapshot_unverified", "operation_plan_unavailable"];
        const categories = ["operation_plan", "broker", "delivery", "memory", "cron_approval"];
        if (!value || typeof value !== "object" || Array.isArray(value) || !statuses.includes(value.status) ||
            !reasons.includes(value.reason) || !Array.isArray(value.plan_scopes) || value.plan_scopes.length > 64 ||
            value.external_backup_restore_point !== "not_examined" || value.used_for_authority !== false || value.may_execute !== false) return null;
        const included = value.status !== "not_included";
        if (value.cross_store_consistency !== (included ? "independent_sqlite_online_snapshots" : "not_included") ||
            value.cross_store_atomic !== (included ? false : null)) return null;
        if ((value.status === "snapshot_unverified" && value.reason !== "snapshot_unverified") ||
            (value.status === "unavailable" && value.reason !== "operation_plan_unavailable") ||
            (!["snapshot_unverified", "unavailable"].includes(value.status) && value.reason !== null)) return null;

        const countKeys = ["plan_scope_count", "residual_plan_scope_count", "unobserved_plan_scope_count", "omitted_plan_scope_count"];
        const countValues = countKeys.map(function (key) { return value[key]; });
        const rows = [];
        const seen = new Set();
        for (const item of value.plan_scopes) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const planDigest = recoveryInspectionDigest(item.plan_id_digest);
          const status = recoveryInspectionEnum(item.status, ["observed", "residuals_present", "unobserved"]);
          if (!planDigest || status === "unknown" || seen.has(planDigest) || !Array.isArray(item.residual_dependencies) ||
              !Array.isArray(item.unobserved_dependencies)) return null;
          const residual = [];
          const unobserved = [];
          for (const category of item.residual_dependencies) {
            const projected = recoveryInspectionEnum(category, categories);
            if (projected === "unknown" || residual.includes(projected)) return null;
            residual.push(projected);
          }
          for (const category of item.unobserved_dependencies) {
            const projected = recoveryInspectionEnum(category, categories);
            if (projected === "unknown" || unobserved.includes(projected) || residual.includes(projected)) return null;
            unobserved.push(projected);
          }
          if ((status === "observed" && (residual.length !== 0 || unobserved.length !== 0)) ||
              (status === "residuals_present" && residual.length === 0) ||
              (status === "unobserved" && (residual.length !== 0 || unobserved.length === 0))) return null;
          seen.add(planDigest);
          rows.push({ plan_id_digest: planDigest, status, residual_dependencies: residual, unobserved_dependencies: unobserved });
        }

        if (["not_included", "not_present", "snapshot_unverified", "unavailable"].includes(value.status)) {
          if (countValues.some(function (count) { return count !== null; }) || rows.length !== 0) return null;
        } else {
          if (!countValues.every(function (count) { return Number.isSafeInteger(count) && count >= 0; }) ||
              value.plan_scope_count < rows.length || value.plan_scope_count - rows.length !== value.omitted_plan_scope_count ||
              value.residual_plan_scope_count > value.plan_scope_count || value.unobserved_plan_scope_count > value.plan_scope_count ||
              rows.filter(function (item) { return item.status === "residuals_present"; }).length > value.residual_plan_scope_count ||
              rows.filter(function (item) { return item.status === "unobserved"; }).length > value.unobserved_plan_scope_count) return null;
          if (value.status === "no_plan_scopes" && (value.plan_scope_count !== 0 || value.residual_plan_scope_count !== 0 || value.unobserved_plan_scope_count !== 0) ||
              value.status === "correlated" && (value.plan_scope_count === 0 || value.residual_plan_scope_count !== 0 || value.unobserved_plan_scope_count !== 0) ||
              value.status === "residuals_present" && value.residual_plan_scope_count === 0 ||
              value.status === "unobserved" && (value.residual_plan_scope_count !== 0 || value.unobserved_plan_scope_count === 0)) return null;
        }
        return {
          status: value.status, reason: value.reason, plan_scope_count: value.plan_scope_count,
          residual_plan_scope_count: value.residual_plan_scope_count,
          unobserved_plan_scope_count: value.unobserved_plan_scope_count,
          omitted_plan_scope_count: value.omitted_plan_scope_count,
          plan_scopes: rows, cross_store_consistency: value.cross_store_consistency,
          cross_store_atomic: value.cross_store_atomic, external_backup_restore_point: "not_examined",
          used_for_authority: false, may_execute: false,
        };
      }

      function formatRecoveryBackupPlanScopes(inventory, overallStatus) {
        if (overallStatus === "not_found") return "backupがありません";
        if (overallStatus !== "verified" || !inventory) return "未確認";
        const labels = { not_included: "このbackupに未収録", not_present: "backup時に未存在",
          snapshot_unverified: "J計画snapshot未検証", verified: "検査済み", residuals_present: "残差あり",
          corrupt: "checkpoint破損", unavailable: "未確認", schema_mismatch: "schema不一致" };
        const label = labels[inventory.status] || "未確認";
        if (inventory.status !== "verified" && inventory.status !== "residuals_present") return "backup内Operation Plan: " + label;
        const rows = inventory.plan_scopes.map(function (item) {
          const requestScope = item.request_scope_digest ? item.request_scope_digest.slice(0, 12) : "未確認";
          return "計画digest " + item.plan_id_digest.slice(0, 12) + " / 要求scope digest " + requestScope + " / " +
            (item.integrity === "verified" ? "整合" : "残差") + " / 計画記録 " + item.plan_record_count +
            " / 結果binding " + item.binding_count + " / 残差binding " + item.residual_binding_count +
            " / 省略binding " + item.omitted_binding_count;
        });
        return ["backup内J計画台帳: " + label + " / 計画scope " + inventory.plan_scope_count +
          " / 計画記録 " + inventory.plan_count + " / 結果binding " + inventory.binding_count +
          " / 残差binding " + inventory.residual_binding_count + " / M照合未確認 " + inventory.unverified_memory_link_count +
          " / 省略scope " + inventory.omitted_plan_scope_count,
          ...rows, "要求scope digestはInboundRequest由来の診断相関です。仕事ID・復元点・復元許可ではなく、J以外の台帳との相関は未実施です。"].join("\\n");
      }

      function formatRecoveryBackupPlanDependencies(inventory, overallStatus) {
        if (overallStatus === "not_found") return "backupがありません";
        if (overallStatus !== "verified" || !inventory) return "未確認";
        const statusLabels = { not_included: "snapshot未収録", not_present: "Operation Plan台帳なし",
          snapshot_unverified: "snapshot未検証", unavailable: "J計画検査不能", no_plan_scopes: "計画scopeなし",
          correlated: "観測範囲内で残差なし", residuals_present: "残差あり", unobserved: "未観測あり" };
        const dependencyLabels = { operation_plan: "J計画", broker: "Broker", delivery: "結果配送",
          memory: "J/M記憶", cron_approval: "Cron承認", cron_event: "Cron仕事配送状態" };
        const rows = inventory.plan_scopes.map(function (item) {
          const residual = item.residual_dependencies.map(function (category) { return dependencyLabels[category]; });
          const unobserved = item.unobserved_dependencies.map(function (category) { return dependencyLabels[category]; });
          return "計画digest " + item.plan_id_digest.slice(0, 12) + " / " +
            (residual.length ? "残差: " + residual.join("・") : "残差なし") + " / " +
            (unobserved.length ? "未観測: " + unobserved.join("・") : "未観測なし");
        });
        const summary = "backup内計画依存scope: " + statusLabels[inventory.status] +
          (inventory.plan_scope_count === null ? "" : " / scope " + inventory.plan_scope_count +
            " / 残差scope " + inventory.residual_plan_scope_count + " / 未観測scope " + inventory.unobserved_plan_scope_count +
            " / 省略scope " + inventory.omitted_plan_scope_count);
        return [summary, ...rows,
          "相関はstore別に独立取得したbackup内診断です。job identity・同時点atomicity・restore point・復元／再開許可ではありません。"].join("\\n");
      }

      function renderRecoveryBackupStoreStatuses(value, coverage, overallStatus) {
        const expectedKeys = ["j_control", "m_state", "broker", "operation_plans", "cron_events"];
        const safeRows = recoveryBackupStoreStatuses(value);
        const statusLabels = {
          verified: "アーカイブ検査済み",
          captured_unverified: "取得済み・未検証",
          snapshot_failed: "取得失敗",
          not_present: "backup時に未存在"
        };
        const hasVerifiedRows = overallStatus === "verified" && safeRows !== null && safeRows.length === expectedKeys.length;
        const unavailableLabel = overallStatus === "verified" && coverage === "not_included"
          ? "このbackupに未収録"
          : "未確認";
        for (const key of expectedKeys) {
          const row = hasVerifiedRows ? safeRows.find((item) => item.store_key === key) : null;
          setText("recovery-backup-store-" + key, row ? statusLabels[row.status] : unavailableLabel);
        }
      }

      function recoveryInspectionLedgerStatus(value, allowed) {
        const status = typeof value === "string" ? value : value && typeof value === "object" ? value.status : null;
        return recoveryInspectionEnum(status, allowed);
      }

      function recoveryInspectionLedgerBoundary(value, enabled, status, hasRevision) {
        const unknown = { reason: "unknown", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null };
        if (!enabled || !value || typeof value !== "object") return unknown;
        const reason = value.reason === null ? null : recoveryInspectionEnum(value.reason, ["disk_full", "write_failed", "sync_failed", "schema_mismatch", "ledger_corrupt", "projection_mismatch", "store_unavailable", "outbox_mismatch", "unknown"]);
        const readCount = function (item) { return item === null ? null : Number.isSafeInteger(item) && item >= 0 ? item : undefined; };
        const verified = readCount(value.verified_event_count);
        const unverified = readCount(value.unverified_event_count);
        const first = value.first_unverified_ordinal === null ? null : Number.isSafeInteger(value.first_unverified_ordinal) && value.first_unverified_ordinal > 0 ? value.first_unverified_ordinal : undefined;
        const revision = readCount(value.last_verified_revision);
        if (["unavailable", "schema_mismatch"].includes(status)) return { ...unknown, reason };
        if (!["verified", "projection_mismatch", "residuals_present", "corrupt"].includes(status)) return unknown;
        if (verified === null && unverified === null) return { ...unknown, reason };
        if (verified === undefined || unverified === undefined || first === undefined || revision === undefined ||
            !Number.isSafeInteger(verified + unverified) ||
            (unverified === 0 && first !== null) ||
            (unverified > 0 && first !== verified + 1) ||
            (status === "verified" && unverified > 0) ||
            (hasRevision && revision === null) ||
            (!hasRevision && revision !== null)) return { ...unknown, reason: reason === "unknown" ? "unknown" : reason };
        return { reason, verified_event_count: verified, unverified_event_count: unverified, first_unverified_ordinal: first, last_verified_revision: revision };
      }

      function formatRecoveryPlanDependencyScopes(scopes, boundaryValid, inspectionStatus, omittedCount, operationPlanStatus) {
        const statusLabels = {
          observed: "観測範囲内で残差なし",
          residuals_present: "残差あり",
          unobserved: "未観測"
        };
        const categoryLabels = {
          operation_plan: "Operation Plan",
          broker: "Broker",
          delivery: "結果配送",
          memory: "J/M記憶連結",
          cron_approval: "Cron承認handoff",
          cron_event: "Cron仕事配送状態"
        };
        const allowedCategories = Object.keys(categoryLabels);
        const safeOmittedCount = Number.isSafeInteger(omittedCount) && omittedCount >= 0 ? omittedCount : null;
        const omittedLabel = safeOmittedCount === null ? "省略scope件数: 未確認" :
          safeOmittedCount > 0 ? "省略scope件数: " + safeOmittedCount : "";
        const unverified = function (reason) {
          return ["依存scope: 未確認（" + reason + "）", omittedLabel].filter(Boolean).join("\\n");
        };
        if (boundaryValid !== true || !["verified", "residuals_present"].includes(inspectionStatus) ||
            !["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"].includes(operationPlanStatus) ||
            !Array.isArray(scopes) || scopes.length > 64 || safeOmittedCount === null) {
          return unverified("検査境界または件数を検証できません");
        }
        if (!["verified", "residuals_present"].includes(operationPlanStatus)) {
          return unverified("Operation Plan台帳を検証できません");
        }
        const rows = [];
        const seenDigests = new Set();
        const seenPrefixes = new Set();
        for (const item of scopes) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return unverified("scope形式が不正です");
          const digest = recoveryInspectionDigest(item.plan_id_digest);
          const requestScopeDigest = item.request_scope_digest === null ? null : recoveryInspectionDigest(item.request_scope_digest);
          const integrity = recoveryInspectionEnum(item.integrity, ["verified", "residuals_present"]);
          const status = recoveryInspectionEnum(item.status, Object.keys(statusLabels));
          const planRecordCount = item.plan_record_count;
          const bindingCount = item.binding_count;
          const inspectedBindingCount = item.inspected_binding_count;
          const omittedBindingCount = item.omitted_binding_count;
          const residualBindingCount = item.residual_binding_count;
          const readCategories = function (value) {
            if (!Array.isArray(value)) return null;
            const entries = value.map(function (entry) { return recoveryInspectionEnum(entry, allowedCategories); });
            return entries.some(function (entry) { return entry === "unknown"; }) || new Set(entries).size !== entries.length ? null : entries;
          };
          const residuals = readCategories(item.residual_dependencies);
          const unobserved = readCategories(item.unobserved_dependencies);
          const digestPrefix = digest ? digest.slice(0, 12) : null;
          const countsValid = Number.isSafeInteger(planRecordCount) && planRecordCount >= 1 &&
            Number.isSafeInteger(bindingCount) && bindingCount >= 0 &&
            Number.isSafeInteger(inspectedBindingCount) && inspectedBindingCount >= 0 &&
            Number.isSafeInteger(omittedBindingCount) && omittedBindingCount >= 0 &&
            Number.isSafeInteger(residualBindingCount) && residualBindingCount >= 0 &&
            residualBindingCount <= bindingCount && omittedBindingCount <= bindingCount &&
            inspectedBindingCount + omittedBindingCount === bindingCount;
          const expectedStatus = residuals && residuals.length > 0 ? "residuals_present" :
            (unobserved && unobserved.length > 0) || omittedBindingCount > 0 ? "unobserved" : "observed";
          if (!digest || (item.request_scope_digest !== null && !requestScopeDigest) || integrity === "unknown" ||
              status === "unknown" || !countsValid || residuals === null || unobserved === null ||
              status !== expectedStatus || seenDigests.has(digest) || seenPrefixes.has(digestPrefix) ||
              (integrity === "residuals_present" && (!residuals || residuals.indexOf("operation_plan") < 0)) ||
              (residualBindingCount > 0 && residuals.indexOf("operation_plan") < 0)) {
            return unverified("scopeの状態・分類・件数を検証できません");
          }
          seenDigests.add(digest);
          seenPrefixes.add(digestPrefix);
          const categories = function (values) { return values.length ? values.map(function (value) { return categoryLabels[value]; }).join("、") : "なし"; };
          rows.push("Plan " + digestPrefix + " — " + statusLabels[status] +
            "（計画記録 " + planRecordCount + "件、依存関連付け " + bindingCount + "件: 検査 " + inspectedBindingCount +
            "件／省略 " + omittedBindingCount + "件／残差 " + residualBindingCount + "件）" +
            "\\n  残差依存: " + categories(residuals) + "／未観測依存: " + categories(unobserved));
        }
        let summary;
        if (rows.length === 0 && safeOmittedCount === 0 && operationPlanStatus === "verified") {
          summary = "該当するOperation Planはありません（台帳検査済み）";
        } else if (rows.length === 0 && safeOmittedCount === 0) {
          summary = "依存scopeは未確認（Operation Plan台帳に残差があります）";
        } else if (rows.length === 0) {
          summary = "依存scope: 未確認（scopeが省略されています）";
        } else {
          summary = "現行台帳で観測したOperation Plan依存scope（仕事ID・backup復旧点ではありません）\\n" + rows.join("\\n");
        }
        if (safeOmittedCount > 0) summary += "\\n省略scope件数: " + safeOmittedCount;
        summary += "\\n読み取り専用の診断です。復旧可能性・復元・再開許可を示しません。Cron配送状態は現行cursorの観測であり、過去イベントの不存在や仕事の成功を示しません。";
        return summary;
      }

      function projectRecoveryExecutionArchiveEvidence(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.records)) return null;
        const status = recoveryInspectionEnum(value.status, ["available", "not_verified"]);
        if (status === "unknown") return null;
        if (status === "not_verified") {
          return value.records.length === 0 && value.omitted_record_count === null
            ? { status: status, records: [], omitted_record_count: null }
            : null;
        }
        if (value.records.length > 200 || !Number.isSafeInteger(value.omitted_record_count) || value.omitted_record_count < 0) return null;
        const seenTickets = new Set();
        const records = [];
        for (const item of value.records) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const ticket = recoveryInspectionDigest(item.ticket_digest);
          const command = recoveryInspectionDigest(item.command_key_digest);
          const priorEpoch = recoveryInspectionDigest(item.prior_execution_epoch_digest);
          const archivedByEpoch = recoveryInspectionDigest(item.archived_by_execution_epoch_digest);
          const delivery = recoveryInspectionDigest(item.delivery_digest);
          if (!ticket || !command || !priorEpoch || !archivedByEpoch || !delivery ||
              item.disposition !== "stale_generation_evidence" || priorEpoch === archivedByEpoch || seenTickets.has(ticket)) return null;
          seenTickets.add(ticket);
          records.push({ ticket_digest: ticket, command_key_digest: command, prior_execution_epoch_digest: priorEpoch,
            archived_by_execution_epoch_digest: archivedByEpoch, delivery_digest: delivery,
            disposition: "stale_generation_evidence" });
        }
        return { status: status, records: records, omitted_record_count: value.omitted_record_count };
      }

      function formatRecoveryExecutionArchiveEvidence(evidence, boundaryValid) {
        const unverified = "旧世代結果の隔離証拠: 未確認（読み取り検査またはBroker台帳境界を検証できません）";
        if (boundaryValid !== true || !evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
            !["available", "not_verified"].includes(evidence.status) || !Array.isArray(evidence.records)) return unverified;
        if (evidence.status === "not_verified") {
          return evidence.records.length === 0 && evidence.omitted_record_count === null
            ? unverified + "\\n読み取り専用です。作用・承認・再実行を行いません。"
            : unverified;
        }
        if (evidence.records.length > 200 || !Number.isSafeInteger(evidence.omitted_record_count) || evidence.omitted_record_count < 0) return unverified;
        const seenTickets = new Set();
        const rows = [];
        for (const item of evidence.records) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return unverified;
          const ticket = recoveryInspectionDigest(item.ticket_digest);
          const command = recoveryInspectionDigest(item.command_key_digest);
          const priorEpoch = recoveryInspectionDigest(item.prior_execution_epoch_digest);
          const archivedByEpoch = recoveryInspectionDigest(item.archived_by_execution_epoch_digest);
          const delivery = recoveryInspectionDigest(item.delivery_digest);
          if (!ticket || !command || !priorEpoch || !archivedByEpoch || !delivery ||
              item.disposition !== "stale_generation_evidence" || priorEpoch === archivedByEpoch || seenTickets.has(ticket)) return unverified;
          seenTickets.add(ticket);
          rows.push("ticket " + ticket.slice(0, 12) + " / command " + command.slice(0, 12) +
            " / 旧epoch " + priorEpoch.slice(0, 12) + " / 隔離先epoch " + archivedByEpoch.slice(0, 12) +
            " / 結果digest " + delivery.slice(0, 12));
        }
        let summary = rows.length === 0
          ? "検証済みBroker記録内に旧世代結果の隔離証拠はありません。"
          : "旧世代結果の隔離証拠（raw結果なし・digestのみ）\\n" + rows.join("\\n");
        if (evidence.omitted_record_count > 0) summary += "\\nBroker記録の検査上限による省略: " + evidence.omitted_record_count + "件";
        return summary + "\\n読み取り専用です。作用・承認・再実行を行いません。";
      }

      function renderRecoveryInspection(report) {
        const source = report && typeof report === "object" ? report : {};
        const ledgers = source.ledgers && typeof source.ledgers === "object" ? source.ledgers : {};
        const cronSource = source.cron_event_summary && typeof source.cron_event_summary === "object" ? source.cron_event_summary : {};
        const documentCheckpointSource = source.document_organization_checkpoint_summary && typeof source.document_organization_checkpoint_summary === "object" ? source.document_organization_checkpoint_summary : {};
        const cronStatus = recoveryInspectionEnum(cronSource.status, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]);
        const cronReason = cronSource.reason === null ? null : recoveryInspectionEnum(cronSource.reason, ["store_unavailable", "schema_mismatch", "ledger_corrupt", "outbox_mismatch"]);
        const cronCountKeys = ["cursor_count", "verified_cursor_count", "unverified_cursor_count", "omitted_cursor_count", "unresolved_cursor_count", "orphan_outbox_count", "approval_handoff_count", "verified_approval_handoff_count", "unverified_approval_handoff_count", "omitted_approval_handoff_count", "pending_approval_handoff_count", "interrupted_approval_handoff_count"];
        const cronCounts = {};
        let cronCountsValid = true;
        cronCountKeys.forEach(function (key) {
          const value = cronSource[key];
          if (value === null || (Number.isSafeInteger(value) && value >= 0)) cronCounts[key] = value;
          else cronCountsValid = false;
        });
        const cronResidualCount = recoveryInspectionCount(cronSource.residual_count);
        const cronUnavailable = ["unavailable", "schema_mismatch", "corrupt"].includes(cronStatus);
        const cronExpectedUnavailableReason = cronStatus === "unavailable" ? "store_unavailable" : cronStatus === "schema_mismatch" ? "schema_mismatch" : "ledger_corrupt";
        const cronCountsUnknown = cronCountKeys.every(function (key) { return cronCounts[key] === null; });
        const cronCountsNumeric = cronCountKeys.every(function (key) { return Number.isSafeInteger(cronCounts[key]) && cronCounts[key] >= 0; });
        const cronExpectedResiduals = cronCounts.unverified_cursor_count + cronCounts.omitted_cursor_count + cronCounts.unresolved_cursor_count + cronCounts.orphan_outbox_count + cronCounts.unverified_approval_handoff_count + cronCounts.omitted_approval_handoff_count + cronCounts.pending_approval_handoff_count + cronCounts.interrupted_approval_handoff_count;
        const cronSummaryValid = cronStatus !== "unknown" && cronCountsValid && Number.isSafeInteger(cronSource.residual_count) && cronSource.residual_count >= 0 &&
          (cronUnavailable
            ? cronCountsUnknown && cronResidualCount > 0 && cronReason === cronExpectedUnavailableReason
            : cronCountsNumeric && cronCounts.verified_cursor_count + cronCounts.unverified_cursor_count + cronCounts.omitted_cursor_count === cronCounts.cursor_count &&
              cronCounts.verified_approval_handoff_count + cronCounts.unverified_approval_handoff_count + cronCounts.omitted_approval_handoff_count === cronCounts.approval_handoff_count &&
              cronExpectedResiduals === cronResidualCount && (cronStatus === "verified" ? cronResidualCount === 0 : cronResidualCount > 0) &&
              (cronStatus !== "verified" || cronReason === null) &&
              (cronStatus !== "residuals_present" || cronReason === null || cronReason === "ledger_corrupt" || cronReason === "outbox_mismatch") &&
              (cronReason !== "ledger_corrupt" || cronCounts.unverified_cursor_count + cronCounts.unverified_approval_handoff_count > 0) &&
              (cronReason !== "outbox_mismatch" || cronCounts.orphan_outbox_count > 0));
        const cronLedgerStatus = recoveryInspectionLedgerStatus(ledgers.cron_events, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]);
        const documentCheckpointStatus = recoveryInspectionEnum(documentCheckpointSource.status, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]);
        const documentCheckpointReason = documentCheckpointSource.reason === null ? null : recoveryInspectionEnum(documentCheckpointSource.reason, ["store_unavailable", "schema_mismatch", "ledger_corrupt", "row_limit_reached", "unfinished_checkpoints"]);
        const documentCheckpointCountKeys = ["checkpoint_count", "verified_checkpoint_count", "residual_checkpoint_count", "omitted_checkpoint_count", "unresolved_checkpoint_count"];
        const documentCheckpointCounts = {};
        let documentCheckpointCountsValid = true;
        documentCheckpointCountKeys.forEach(function (key) {
          const value = documentCheckpointSource[key];
          if (value === null || (Number.isSafeInteger(value) && value >= 0)) documentCheckpointCounts[key] = value;
          else documentCheckpointCountsValid = false;
        });
        const documentCheckpointSourceRecords = Array.isArray(documentCheckpointSource.records) ? documentCheckpointSource.records : null;
        const documentCheckpointReferences = new Set();
        let documentCheckpointRecordsValid = documentCheckpointSourceRecords !== null && documentCheckpointSourceRecords.length <= 128;
        const documentCheckpointRecords = (documentCheckpointSourceRecords || []).slice(0, 128).map(function (item) {
              const value = item && typeof item === "object" ? item : {};
              const reference = value.checkpoint_ref_digest === null ? null : recoveryInspectionDigest(value.checkpoint_ref_digest);
              const requestScopeDigest = value.request_scope_digest === null ? null : recoveryInspectionDigest(value.request_scope_digest);
              const integrity = recoveryInspectionEnum(value.integrity, ["verified", "residuals_present"]);
              const reason = value.reason === null ? null : recoveryInspectionEnum(value.reason, ["row_shape_invalid", "checkpoint_digest_mismatch", "checkpoint_json_invalid", "checkpoint_shape_invalid", "checkpoint_identity_mismatch"]);
              const checkpointStatus = value.checkpoint_status === null ? null : recoveryInspectionEnum(value.checkpoint_status, ["ready", "continuing", "completed", "held"]);
              if ((value.checkpoint_ref_digest !== null && !reference) ||
                  (value.request_scope_digest !== null && !requestScopeDigest) || integrity === "unknown" ||
                  (requestScopeDigest !== null && (integrity !== "verified" || reason !== null)) ||
                  (value.reason !== null && reason === "unknown") ||
                  (value.checkpoint_status !== null && checkpointStatus === "unknown") ||
                  (integrity === "verified" && (reason !== null || checkpointStatus === null || reference === null)) ||
                  (integrity === "residuals_present" && reason === null) ||
                  (reference !== null && documentCheckpointReferences.has(reference))) {
                documentCheckpointRecordsValid = false;
                return null;
              }
              if (reference !== null) documentCheckpointReferences.add(reference);
              return { checkpoint_ref_digest: reference, request_scope_digest: requestScopeDigest, integrity: integrity, reason: reason, checkpoint_status: checkpointStatus };
            }).filter(function (item) { return item !== null; });
        if (documentCheckpointRecords.length !== (documentCheckpointSourceRecords || []).length) documentCheckpointRecordsValid = false;
        const documentCheckpointResidualCount = documentCheckpointSource.residual_count;
        const documentCheckpointUnavailable = ["unavailable", "schema_mismatch", "corrupt"].includes(documentCheckpointStatus);
        const documentCheckpointCountsUnknown = documentCheckpointCountKeys.every(function (key) { return documentCheckpointCounts[key] === null; });
        const documentCheckpointCountsNumeric = documentCheckpointCountKeys.every(function (key) { return Number.isSafeInteger(documentCheckpointCounts[key]) && documentCheckpointCounts[key] >= 0; });
        const documentCheckpointVerifiedRows = documentCheckpointRecords.filter(function (item) { return item.integrity === "verified"; }).length;
        const documentCheckpointResidualRows = documentCheckpointRecords.filter(function (item) { return item.integrity === "residuals_present"; }).length;
        const documentCheckpointUnresolvedRows = documentCheckpointRecords.filter(function (item) { return item.integrity === "verified" && item.checkpoint_status !== "completed"; }).length;
        const expectedDocumentCheckpointResiduals = documentCheckpointCounts.residual_checkpoint_count + documentCheckpointCounts.omitted_checkpoint_count + documentCheckpointCounts.unresolved_checkpoint_count;
        const expectedDocumentCheckpointReason = documentCheckpointResidualRows > 0 ? "ledger_corrupt" : documentCheckpointCounts.omitted_checkpoint_count > 0 ? "row_limit_reached" :
          documentCheckpointCounts.unresolved_checkpoint_count > 0 ? "unfinished_checkpoints" : null;
        const documentCheckpointSummaryValid = documentCheckpointStatus !== "unknown" && documentCheckpointCountsValid &&
          documentCheckpointRecordsValid &&
          Number.isSafeInteger(documentCheckpointResidualCount) && documentCheckpointResidualCount >= 0 &&
          (documentCheckpointUnavailable
            ? documentCheckpointCountsUnknown && documentCheckpointRecords.length === 0 && documentCheckpointResidualCount > 0 &&
              documentCheckpointReason === (documentCheckpointStatus === "unavailable" ? "store_unavailable" : documentCheckpointStatus === "schema_mismatch" ? "schema_mismatch" : "ledger_corrupt")
            : documentCheckpointCountsNumeric &&
              documentCheckpointCounts.verified_checkpoint_count === documentCheckpointVerifiedRows &&
              documentCheckpointCounts.residual_checkpoint_count === documentCheckpointResidualRows &&
              documentCheckpointCounts.checkpoint_count === documentCheckpointCounts.verified_checkpoint_count + documentCheckpointCounts.residual_checkpoint_count + documentCheckpointCounts.omitted_checkpoint_count &&
              documentCheckpointRecords.length === documentCheckpointCounts.verified_checkpoint_count + documentCheckpointCounts.residual_checkpoint_count &&
              documentCheckpointCounts.unresolved_checkpoint_count === documentCheckpointUnresolvedRows &&
              expectedDocumentCheckpointResiduals === documentCheckpointResidualCount &&
              (documentCheckpointStatus === "verified" ? documentCheckpointResidualCount === 0 && documentCheckpointReason === null :
                documentCheckpointResidualCount > 0 && documentCheckpointReason === expectedDocumentCheckpointReason));
        const documentCheckpointLedgerStatus = recoveryInspectionLedgerStatus(ledgers.document_organization_checkpoints, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]);
        const cronApprovalCorrelationResidualCount = recoveryInspectionCount(source.cron_approval_correlation_residual_count);
        const executionArchiveEvidence = projectRecoveryExecutionArchiveEvidence(source.execution_archive_evidence);
        const initialBoundaryOk = source.schema_version === 10 && source.surface === "recovery_inspection_operator" && source.mode === "read_only" && source.used_for_authority === false && source.may_execute === false && source.boundary_valid === true && executionArchiveEvidence !== null && cronSummaryValid && cronLedgerStatus === cronStatus && source.cron_event_residual_count === cronResidualCount && documentCheckpointSummaryValid && documentCheckpointLedgerStatus === documentCheckpointStatus && source.document_organization_checkpoint_residual_count === documentCheckpointResidualCount && cronApprovalCorrelationResidualCount !== null;
        const ledgerStatuses = {
          j: recoveryInspectionLedgerStatus(ledgers.j, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          m: recoveryInspectionLedgerStatus(ledgers.m, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          broker: recoveryInspectionLedgerStatus(ledgers.broker, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          operation_plans: recoveryInspectionLedgerStatus(ledgers.operation_plans, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          cron_events: cronLedgerStatus,
          document_organization_checkpoints: documentCheckpointLedgerStatus
        };
        const planCorrelations = Array.isArray(source.operation_plan_correlations)
          ? source.operation_plan_correlations.slice(0, 200).map(function (item) {
              const value = item && typeof item === "object" ? item : {};
              const planIdDigest = recoveryInspectionDigest(value.plan_id_digest);
              const stepIdDigest = recoveryInspectionDigest(value.step_id_digest);
              const commandIdDigest = recoveryInspectionDigest(value.command_id_digest);
              const admissionDigest = value.admission_digest === null ? null : recoveryInspectionDigest(value.admission_digest);
              const bindingStatus = recoveryInspectionEnum(value.status, ["selected", "intent_committed", "verified", "outcome_unknown", "verification_failed", "not_attempted", "invalidated"]);
              const bindingIntegrity = recoveryInspectionEnum(value.binding_integrity, ["verified", "residuals_present"]);
              const brokerCorrelation = recoveryInspectionEnum(value.broker_correlation, ["matched", "not_admitted", "admission_missing", "not_found", "not_observed_due_to_limit", "ambiguous", "broker_unverified", "j_binding_unverified"]);
              const deliveryCorrelation = recoveryInspectionEnum(value.delivery_correlation, ["matched", "not_recorded", "j_not_recorded", "broker_not_recorded", "mismatch", "not_observed"]);
              const memoryUpdateIdDigest = value.memory_update_id_digest === null ? null : recoveryInspectionDigest(value.memory_update_id_digest);
              const memoryCorrelation = recoveryInspectionEnum(value.memory_correlation, ["not_recorded", "missing_plan_memory_link", "binding_unverified", "j_state_unverified", "m_state_unverified", "missing_verified_j_link", "missing_verified_m_link", "pending_m_commit", "pending_j_receipt", "blocked_j", "m_present_for_blocked_j", "content_mismatch", "event_identity_mismatch", "revision_mismatch", "receipt_mismatch", "ambiguous", "matched"]);
              const cronApprovalCorrelation = recoveryInspectionEnum(value.cron_approval_correlation, ["not_recorded", "pending", "interrupted", "resolved", "ambiguous", "not_observed_due_to_limit", "cron_unverified", "plan_binding_unverified"]);
              const cronEventCorrelation = recoveryInspectionEnum(value.cron_event_correlation, ["not_applicable", "matched", "not_in_current_cursor", "not_observed_due_to_limit", "ambiguous", "cron_unverified", "plan_binding_unverified"]);
              const cronEventDeliveryState = value.cron_event_delivery_state === null ? null : recoveryInspectionEnum(value.cron_event_delivery_state, ["dispatching", "handler_returned", "outcome_unknown"]);
              if (!planIdDigest || !stepIdDigest || !commandIdDigest || (value.admission_digest !== null && !admissionDigest) || (value.memory_update_id_digest !== null && !memoryUpdateIdDigest) || bindingStatus === "unknown" || bindingIntegrity === "unknown" || brokerCorrelation === "unknown" || deliveryCorrelation === "unknown" || memoryCorrelation === "unknown" || cronApprovalCorrelation === "unknown" || cronEventCorrelation === "unknown" || (value.cron_event_delivery_state !== null && cronEventDeliveryState === "unknown") || ((cronEventCorrelation === "matched") !== (cronEventDeliveryState !== null))) return null;
              return {
                plan_id_digest: planIdDigest,
                step_id_digest: stepIdDigest,
                command_id_digest: commandIdDigest,
                status: bindingStatus,
                binding_integrity: bindingIntegrity,
                admission_digest: admissionDigest,
                broker_correlation: brokerCorrelation,
                delivery_correlation: deliveryCorrelation,
                memory_update_id_digest: memoryUpdateIdDigest,
                memory_correlation: memoryCorrelation,
                cron_approval_correlation: cronApprovalCorrelation,
                cron_event_correlation: cronEventCorrelation,
                cron_event_delivery_state: cronEventDeliveryState
              };
            }).filter(function (item) { return item !== null; })
          : [];
        const dependencyCategories = ["operation_plan", "broker", "delivery", "memory", "cron_approval"];
        let planDependencyScopesValid = Array.isArray(source.plan_dependency_scopes) && source.plan_dependency_scopes.length <= 64 &&
          source.omitted_plan_dependency_scope_count === 0;
        const planDependencyScopes = Array.isArray(source.plan_dependency_scopes)
          ? source.plan_dependency_scopes.slice(0, 64).map(function (item) {
              const value = item && typeof item === "object" ? item : {};
              const planIdDigest = recoveryInspectionDigest(value.plan_id_digest);
              const requestScopeDigest = value.request_scope_digest === null ? null : recoveryInspectionDigest(value.request_scope_digest);
              const planIntegrity = recoveryInspectionEnum(value.integrity, ["verified", "residuals_present"]);
              const scopeStatus = recoveryInspectionEnum(value.status, ["observed", "residuals_present", "unobserved"]);
              const planRecordCount = value.plan_record_count;
              const bindingCount = value.binding_count;
              const inspectedBindingCount = value.inspected_binding_count;
              const omittedBindingCount = value.omitted_binding_count;
              const residualBindingCount = value.residual_binding_count;
              const readCategories = function (items) {
                if (!Array.isArray(items)) return null;
                const safe = items.map(function (entry) { return recoveryInspectionEnum(entry, dependencyCategories); });
                if (safe.some(function (entry) { return entry === "unknown"; }) || new Set(safe).size !== safe.length) return null;
                return dependencyCategories.filter(function (entry) { return safe.indexOf(entry) >= 0; });
              };
              const residualDependencies = readCategories(value.residual_dependencies);
              const unobservedDependencies = readCategories(value.unobserved_dependencies);
              const countsValid = Number.isSafeInteger(planRecordCount) && planRecordCount >= 1 &&
                Number.isSafeInteger(bindingCount) && bindingCount >= 0 &&
                Number.isSafeInteger(inspectedBindingCount) && inspectedBindingCount >= 0 &&
                Number.isSafeInteger(omittedBindingCount) && omittedBindingCount >= 0 &&
                Number.isSafeInteger(residualBindingCount) && residualBindingCount >= 0 &&
                residualBindingCount <= bindingCount && omittedBindingCount <= bindingCount &&
                inspectedBindingCount + omittedBindingCount === bindingCount;
              const expectedStatus = residualDependencies && residualDependencies.length > 0 ? "residuals_present" :
                (unobservedDependencies && unobservedDependencies.length > 0) || omittedBindingCount > 0 ? "unobserved" : "observed";
              const valid = planIdDigest && (value.request_scope_digest === null || requestScopeDigest) && planIntegrity !== "unknown" && scopeStatus !== "unknown" && countsValid &&
                residualDependencies !== null && unobservedDependencies !== null && scopeStatus === expectedStatus &&
                (planIntegrity !== "residuals_present" || residualDependencies.indexOf("operation_plan") >= 0) &&
                (residualBindingCount === 0 || residualDependencies.indexOf("operation_plan") >= 0);
              if (!valid) {
                planDependencyScopesValid = false;
                return null;
              }
              return {
                plan_id_digest: planIdDigest,
                request_scope_digest: requestScopeDigest,
                integrity: planIntegrity,
                plan_record_count: planRecordCount,
                binding_count: bindingCount,
                inspected_binding_count: inspectedBindingCount,
                omitted_binding_count: omittedBindingCount,
                residual_binding_count: residualBindingCount,
                status: scopeStatus,
                residual_dependencies: residualDependencies,
                unobserved_dependencies: unobservedDependencies
              };
            }).filter(function (item) { return item !== null; })
          : [];
        const scopedCorrelationCount = planDependencyScopes.reduce(function (sum, item) {
          return sum + planCorrelations.filter(function (correlation) { return correlation.plan_id_digest === item.plan_id_digest; }).length;
        }, 0);
        const inspectedBindingCountsMatch = planDependencyScopes.every(function (item) {
          return planCorrelations.filter(function (correlation) { return correlation.plan_id_digest === item.plan_id_digest; }).length === item.inspected_binding_count;
        });
        const planScopeDigests = planDependencyScopes.map(function (item) { return item.plan_id_digest; });
        if (scopedCorrelationCount !== planCorrelations.length || !inspectedBindingCountsMatch ||
            new Set(planScopeDigests).size !== planScopeDigests.length) {
          planDependencyScopesValid = false;
        }
        const requestScopeGroups = new Map();
        let unlinkedOperationPlanScopeCount = 0;
        let unlinkedDocumentCheckpointCount = 0;
        const requestScopeGroup = function (digest) {
          let group = requestScopeGroups.get(digest);
          if (!group) {
            group = { planScopes: [], verifiedCheckpoints: 0, unresolvedCheckpoints: 0 };
            requestScopeGroups.set(digest, group);
          }
          return group;
        };
        planDependencyScopes.forEach(function (item) {
          if (item.request_scope_digest === null) unlinkedOperationPlanScopeCount += 1;
          else requestScopeGroup(item.request_scope_digest).planScopes.push(item);
        });
        documentCheckpointRecords.forEach(function (item) {
          if (item.integrity !== "verified" || item.request_scope_digest === null) {
            unlinkedDocumentCheckpointCount += 1;
            return;
          }
          const group = requestScopeGroup(item.request_scope_digest);
          group.verifiedCheckpoints += 1;
          if (item.checkpoint_status !== "completed") group.unresolvedCheckpoints += 1;
        });
        const operationPlanInventoryComplete = ["verified", "residuals_present"].includes(ledgerStatuses.operation_plans) &&
          source.omitted_plan_dependency_scope_count === 0;
        const documentCheckpointInventoryComplete = ["verified", "residuals_present"].includes(documentCheckpointStatus) &&
          documentCheckpointCounts.omitted_checkpoint_count === 0;
        const requestScopeEntries = Array.from(requestScopeGroups.entries()).map(function (entry) {
          const digest = entry[0];
          const group = entry[1];
          const operationPlanScopeCount = group.planScopes.length;
          const residualOperationPlanScopeCount = group.planScopes.filter(function (item) { return item.status === "residuals_present"; }).length;
          const unobservedOperationPlanScopeCount = group.planScopes.filter(function (item) { return item.status === "unobserved"; }).length;
          const hasPlans = operationPlanScopeCount > 0;
          const hasCheckpoints = group.verifiedCheckpoints > 0;
          const relationship = hasPlans && hasCheckpoints ? "both_ledgers" :
            hasPlans && documentCheckpointInventoryComplete && unlinkedDocumentCheckpointCount === 0 ? "operation_plan_only" :
            !hasPlans && hasCheckpoints && operationPlanInventoryComplete && unlinkedOperationPlanScopeCount === 0 ? "document_checkpoint_only" :
            "counterpart_unresolved";
          const status = residualOperationPlanScopeCount > 0 || group.unresolvedCheckpoints > 0 ? "residuals_present" :
            relationship === "counterpart_unresolved" || unobservedOperationPlanScopeCount > 0 ? "unobserved" : "observed";
          return {
            request_scope_digest: digest,
            relationship: relationship,
            status: status,
            operation_plan_scope_count: operationPlanScopeCount,
            residual_operation_plan_scope_count: residualOperationPlanScopeCount,
            unobserved_operation_plan_scope_count: unobservedOperationPlanScopeCount,
            verified_document_checkpoint_count: group.verifiedCheckpoints,
            unresolved_document_checkpoint_count: group.unresolvedCheckpoints
          };
        }).sort(function (left, right) { return left.request_scope_digest < right.request_scope_digest ? -1 : left.request_scope_digest > right.request_scope_digest ? 1 : 0; });
        const expectedRequestScopeCorrelation = {
          status: "available",
          entries: requestScopeEntries,
          matched_scope_count: requestScopeEntries.filter(function (item) { return item.relationship === "both_ledgers"; }).length,
          operation_plan_only_scope_count: requestScopeEntries.filter(function (item) { return item.relationship === "operation_plan_only"; }).length,
          document_checkpoint_only_scope_count: requestScopeEntries.filter(function (item) { return item.relationship === "document_checkpoint_only"; }).length,
          counterpart_unresolved_scope_count: requestScopeEntries.filter(function (item) { return item.relationship === "counterpart_unresolved"; }).length,
          unlinked_operation_plan_scope_count: operationPlanInventoryComplete ? unlinkedOperationPlanScopeCount : null,
          unlinked_document_checkpoint_count: documentCheckpointInventoryComplete ? unlinkedDocumentCheckpointCount : null
        };
        const requestScopeCorrelationValid = source.request_scope_correlation && typeof source.request_scope_correlation === "object" &&
          JSON.stringify(source.request_scope_correlation) === JSON.stringify(expectedRequestScopeCorrelation);
        const boundaryOk = initialBoundaryOk && planDependencyScopesValid && requestScopeCorrelationValid;
        const status = boundaryOk
          ? recoveryInspectionEnum(source.status, ["verified", "residuals_present", "invalid_report"])
          : "invalid_report";
        const updateResiduals = Array.isArray(source.update_residuals)
          ? source.update_residuals.slice(0, 200).map(function (item) {
              const value = item && typeof item === "object" ? item : {};
              const updateIdDigest = recoveryInspectionDigest(value.update_id_digest);
              const disposition = recoveryInspectionEnum(value.disposition, ["paired", "pending_m_commit", "pending_j_receipt", "missing_verified_j_link", "missing_verified_m_link", "content_mismatch", "event_identity_mismatch", "revision_mismatch", "receipt_mismatch", "m_present_for_blocked_j", "blocked_j", "m_state_unverified", "j_state_unverified"]);
              return updateIdDigest && disposition !== "unknown" ? { update_id_digest: updateIdDigest, disposition: disposition } : null;
            }).filter(function (item) { return item !== null; })
          : [];
        const projection = {
          mode: recoveryInspectionEnum(source.mode, ["read_only"]),
          status,
          ledgers: ledgerStatuses,
          ledger_boundaries: {
            j: recoveryInspectionLedgerBoundary(source.ledger_boundaries && source.ledger_boundaries.j, boundaryOk, ledgerStatuses.j, true),
            m: recoveryInspectionLedgerBoundary(source.ledger_boundaries && source.ledger_boundaries.m, boundaryOk, ledgerStatuses.m, true),
            broker: recoveryInspectionLedgerBoundary(source.ledger_boundaries && source.ledger_boundaries.broker, boundaryOk, ledgerStatuses.broker, false)
          },
          replay_checkpoint: source.replay_checkpoint === "verified_replay_checkpoint_not_backup"
            ? "verified_replay_checkpoint_not_backup"
            : "not_verified",
          isolated_update_count: recoveryInspectionCount(source.isolated_update_count),
          execution_residual_count: recoveryInspectionCount(source.execution_residual_count),
          execution_archive_evidence: boundaryOk ? executionArchiveEvidence : { status: "not_verified", records: [], omitted_record_count: null },
          operation_plan_residual_count: recoveryInspectionCount(source.operation_plan_residual_count),
          cron_event_residual_count: recoveryInspectionCount(source.cron_event_residual_count),
          cron_approval_correlation_residual_count: cronApprovalCorrelationResidualCount,
          document_organization_checkpoint_residual_count: recoveryInspectionCount(source.document_organization_checkpoint_residual_count),
          cron_event_summary: {
            status: cronStatus,
            reason: cronReason,
            ...cronCounts,
            residual_count: cronResidualCount
          },
          document_organization_checkpoint_summary: {
            status: documentCheckpointStatus,
            reason: documentCheckpointReason,
            ...documentCheckpointCounts,
            residual_count: documentCheckpointResidualCount,
            records: documentCheckpointRecords
          },
          operation_plan_correlations: planCorrelations,
          omitted_operation_plan_correlation_count: recoveryInspectionCount(source.omitted_operation_plan_correlation_count),
          plan_dependency_scopes: planDependencyScopes,
          omitted_plan_dependency_scope_count: recoveryInspectionCount(source.omitted_plan_dependency_scope_count),
          request_scope_correlation: boundaryOk ? expectedRequestScopeCorrelation : {
            status: "not_verified",
            entries: [],
            matched_scope_count: null,
            operation_plan_only_scope_count: null,
            document_checkpoint_only_scope_count: null,
            counterpart_unresolved_scope_count: null,
            unlinked_operation_plan_scope_count: null,
            unlinked_document_checkpoint_count: null
          },
          update_residuals: updateResiduals,
          omitted_update_residual_count: recoveryInspectionCount(source.omitted_update_residual_count),
          external_backup_restore_point: recoveryInspectionEnum(source.external_backup_restore_point, ["not_examined"]),
          boundary_valid: boundaryOk,
          used_for_authority: false,
          may_execute: false
        };
        setText("recovery-inspection-status", status);
        byId("recovery-inspection-status").className = "badge " + (status === "verified" ? "review" : "warn");
        setText("recovery-inspection-json", compactJson(projection));
        setText("recovery-execution-archive-evidence", formatRecoveryExecutionArchiveEvidence(
          projection.execution_archive_evidence,
          boundaryOk
        ));
        setText("recovery-plan-dependency-scopes", formatRecoveryPlanDependencyScopes(
          projection.plan_dependency_scopes,
          boundaryOk,
          status,
          source.omitted_plan_dependency_scope_count,
          ledgerStatuses.operation_plans
        ));
      }

      function renderRecoveryBackupInspection(report) {
        const source = report && typeof report === "object" ? report : {};
        const boundaryOk = source.schema_version === 1 &&
          source.surface === "recovery_backup_inspection" &&
          source.mode === "read_only" &&
          source.used_for_authority === false &&
          source.may_execute === false;
        const rawStatus = recoveryInspectionEnum(source.status, ["verified", "not_found", "invalid"]);
        const status = boundaryOk ? rawStatus : "invalid_report";
        const digest = source.backup_id_digest === null ? null : recoveryInspectionDigest(source.backup_id_digest);
        const coverage = recoveryInspectionEnum(source.coverage, ["complete_for_configured_targets", "partial", "none_configured", "unknown"]);
        const canonicalCoverage = recoveryInspectionEnum(source.canonical_state_coverage,
          ["not_included", "complete", "partial", "none_present", "unknown"]);
        const count = function (value) {
          return Number.isSafeInteger(value) && value >= 0 ? value : null;
        };
        let configured = count(source.configured_required_item_count);
        let copied = count(source.copied_required_item_count);
        let missing = count(source.missing_required_item_count);
        let canonicalExpected = count(source.canonical_state_expected_store_count);
        let canonicalCaptured = count(source.canonical_state_snapshot_count);
        let canonicalVerified = count(source.canonical_state_verified_store_count);
        let canonicalMissing = count(source.canonical_state_missing_store_count);
        let canonicalUnverified = count(source.canonical_state_unverified_store_count);
        const canonicalStores = recoveryBackupStoreStatuses(source.canonical_state_stores);
        let operationPlanInventory = recoveryBackupOperationPlanInventory(source.operation_plan_archive_inventory);
        let operationPlanDependencies = recoveryBackupOperationPlanDependencyInventory(source.operation_plan_archive_dependencies);
        const canonicalStoreCountsMatch = canonicalStores !== null && canonicalStores.length === 5 &&
          canonicalStores.filter((item) => item.status === "verified").length === canonicalVerified &&
          canonicalStores.filter((item) => item.status === "not_present").length === canonicalMissing &&
          canonicalStores.filter((item) => item.status === "snapshot_failed" || item.status === "captured_unverified").length === canonicalUnverified &&
          canonicalStores.filter((item) => item.status === "verified" || item.status === "captured_unverified").length === canonicalCaptured;
        let canonicalConsistency = recoveryInspectionEnum(source.canonical_state_store_consistency,
          ["independent_sqlite_online_snapshots", "not_included"]);
        let canonicalCrossStoreAtomic = source.canonical_state_cross_store_atomic === null ? null : source.canonical_state_cross_store_atomic;
        let safeStatus = status;
        let safeCoverage = coverage;
        if (status === "verified" && (!digest || configured === null || copied === null || missing === null ||
            copied > configured || missing !== configured - copied || coverage === "unknown" ||
            (configured === 0 && coverage !== "none_configured") ||
            (configured > 0 && missing === 0 && coverage !== "complete_for_configured_targets") ||
            (missing > 0 && coverage !== "partial") || canonicalCoverage === "unknown" ||
            !operationPlanInventory || !operationPlanDependencies)) {
          safeStatus = "invalid_report";
        }
        const canonicalNotIncluded = canonicalCoverage === "not_included" && canonicalExpected === null &&
          canonicalCaptured === null && canonicalVerified === null && canonicalMissing === null &&
          canonicalUnverified === null && canonicalConsistency === "not_included" && canonicalCrossStoreAtomic === null &&
          canonicalStores !== null && canonicalStores.length === 0;
        const canonicalIncluded = canonicalCoverage !== "not_included" && canonicalCoverage !== "unknown" &&
          canonicalExpected === 5 && canonicalCaptured !== null && canonicalVerified !== null &&
          canonicalMissing !== null && canonicalUnverified !== null && canonicalConsistency === "independent_sqlite_online_snapshots" &&
          canonicalCrossStoreAtomic === false && canonicalCaptured <= canonicalExpected &&
          canonicalVerified <= canonicalCaptured && canonicalMissing <= canonicalExpected &&
          canonicalUnverified <= canonicalExpected && canonicalVerified + canonicalMissing + canonicalUnverified === canonicalExpected &&
          canonicalStoreCountsMatch &&
          ((canonicalCoverage === "complete" && canonicalVerified === canonicalExpected && canonicalCaptured === canonicalExpected &&
            canonicalMissing === 0 && canonicalUnverified === 0) ||
           (canonicalCoverage === "none_present" && canonicalCaptured === 0 && canonicalVerified === 0 &&
            canonicalMissing === canonicalExpected && canonicalUnverified === 0) ||
           (canonicalCoverage === "partial" && canonicalVerified < canonicalExpected && canonicalMissing < canonicalExpected));
        if (status === "verified" && !canonicalNotIncluded && !canonicalIncluded) safeStatus = "invalid_report";
        if (status === "verified" && operationPlanInventory && operationPlanDependencies &&
            ((operationPlanInventory.status === "not_included") !== (operationPlanDependencies.status === "not_included") ||
             (operationPlanInventory.status === "not_present") !== (operationPlanDependencies.status === "not_present"))) {
          safeStatus = "invalid_report";
        }
        if (status === "not_found" && (digest !== null || configured !== null || copied !== null || missing !== null || !canonicalNotIncluded)) {
          safeStatus = "invalid_report";
        }
        if (status === "not_found" && (operationPlanInventory?.status !== "not_included" || operationPlanDependencies?.status !== "not_included")) safeStatus = "invalid_report";
        if (safeStatus !== "verified") {
          configured = null;
          copied = null;
          missing = null;
          safeCoverage = "unknown";
          canonicalExpected = null;
          canonicalCaptured = null;
          canonicalVerified = null;
          canonicalMissing = null;
          canonicalUnverified = null;
          canonicalConsistency = "not_included";
          canonicalCrossStoreAtomic = null;
        }
        if (safeStatus === "invalid_report") operationPlanInventory = {
          status: "snapshot_unverified", reason: "snapshot_unverified", plan_scope_count: null, plan_count: null,
          plan_integrity_residual_count: null, binding_count: null, verified_binding_count: null,
          residual_binding_count: null, unverified_memory_link_count: null, omitted_binding_count: null,
          omitted_plan_scope_count: null, plan_scopes: [], cross_ledger_correlation: "not_performed",
          used_for_authority: false, may_execute: false,
        };
        if (safeStatus === "invalid_report") operationPlanDependencies = {
          status: "snapshot_unverified", reason: "snapshot_unverified", plan_scope_count: null,
          residual_plan_scope_count: null, unobserved_plan_scope_count: null, omitted_plan_scope_count: null,
          plan_scopes: [], cross_store_consistency: "independent_sqlite_online_snapshots", cross_store_atomic: false,
          external_backup_restore_point: "not_examined", used_for_authority: false, may_execute: false,
        };
        const projection = {
          mode: boundaryOk ? "read_only" : "invalid_report",
          status: safeStatus,
          backup_id_digest: safeStatus === "not_found" ? null : digest,
          coverage: safeCoverage,
          configured_required_item_count: configured,
          copied_required_item_count: copied,
          missing_required_item_count: missing,
          canonical_state_coverage: safeStatus === "verified" ? canonicalCoverage : safeStatus === "not_found" ? "not_included" : "unknown",
          canonical_state_expected_store_count: canonicalExpected,
          canonical_state_snapshot_count: canonicalCaptured,
          canonical_state_verified_store_count: canonicalVerified,
          canonical_state_missing_store_count: canonicalMissing,
          canonical_state_unverified_store_count: canonicalUnverified,
          canonical_state_store_consistency: canonicalConsistency,
          canonical_state_cross_store_atomic: canonicalCrossStoreAtomic,
          canonical_state_stores: safeStatus === "verified" ? canonicalStores : [],
          operation_plan_archive_inventory: operationPlanInventory,
          operation_plan_archive_dependencies: operationPlanDependencies,
          used_for_authority: false,
          may_execute: false
        };
        setText("recovery-backup-inspection-status", safeStatus);
        byId("recovery-backup-inspection-status").className = "badge " + (safeStatus === "verified" ? "review" : "warn");
        renderRecoveryBackupStoreStatuses(
          safeStatus === "verified" ? canonicalStores : [],
          safeStatus === "verified" ? canonicalCoverage : "unknown",
          safeStatus,
        );
        setText("recovery-backup-plan-scopes", formatRecoveryBackupPlanScopes(
          operationPlanInventory,
          safeStatus,
        ));
        setText("recovery-backup-plan-dependencies", formatRecoveryBackupPlanDependencies(
          operationPlanDependencies,
          safeStatus,
        ));
        setText("recovery-backup-inspection-json", compactJson(projection));
      }

      function renderRecoveryScopeApplicability(report) {
        const source = report && typeof report === "object" ? report : {};
        const digest = function (value) { return value === null ? null : recoveryInspectionDigest(value); };
        const count = function (value) { return value === null || (Number.isSafeInteger(value) && value >= 0) ? value : undefined; };
        const categories = ["operation_plan", "broker", "delivery", "memory", "cron_approval"];
        const storeKeys = ["j_control", "m_state", "broker", "operation_plans", "cron_events"];
        const dependenciesByStore = {
          j_control: [], m_state: ["memory"], broker: ["broker", "delivery"],
          operation_plans: ["operation_plan"], cron_events: ["cron_approval"]
        };
        const reasons = ["invalid_request", "backup_not_found", "backup_unverified", "scope_not_found", "scope_ambiguous",
          "dependency_unverified", "dependency_not_mapped", "store_unverified"];
        const snapshotStatuses = ["verified", "captured_unverified", "snapshot_failed", "not_present", "unknown"];
        const dependencyStatuses = ["residuals_present", "unobserved", "no_residual_recorded", "not_mapped", "unknown"];
        const rawStatus = recoveryInspectionEnum(source.status, ["matched", "unverified"]);
        const scopeKind = source.scope_kind === null ? null : recoveryInspectionEnum(source.scope_kind, ["request_scope", "operation_plan"]);
        const scopeDigest = digest(source.scope_digest);
        const backupDigest = digest(source.backup_id_digest);
        const planDigest = digest(source.matched_plan_id_digest);
        const reason = source.reason === null ? null : recoveryInspectionEnum(source.reason, reasons);
        const matchedPlanCount = count(source.matched_plan_scope_count);
        const storeCount = count(source.store_candidate_count);
        const verifiedStoreCount = count(source.verified_store_candidate_count);
        const dependencyScopeStatus = recoveryInspectionEnum(source.dependency_scope_status,
          ["observed", "residuals_present", "unobserved", "unknown"]);
        const readCategories = function (value) {
          if (!Array.isArray(value) || value.length > categories.length) return null;
          const rows = value.map(function (item) { return recoveryInspectionEnum(item, categories); });
          return rows.every(Boolean) && new Set(rows).size === rows.length ? rows : null;
        };
        const residualDependencies = readCategories(source.residual_dependencies);
        const unobservedDependencies = readCategories(source.unobserved_dependencies);
        let valid = source.schema_version === 1 && source.surface === "recovery_scope_applicability" && source.mode === "read_only" &&
          rawStatus !== null && (source.reason === null || reason !== null) &&
          (source.scope_kind === null || scopeKind !== null) && (source.scope_digest === null || scopeDigest !== null) &&
          (source.backup_id_digest === null || backupDigest !== null) && (source.matched_plan_id_digest === null || planDigest !== null) &&
          matchedPlanCount !== undefined && storeCount !== undefined && verifiedStoreCount !== undefined &&
          dependencyScopeStatus !== null && residualDependencies !== null && unobservedDependencies !== null &&
          (source.cross_store_atomic === false || source.cross_store_atomic === null);
        if (source.used_for_authority !== false || source.may_execute !== false || source.external_backup_restore_point !== "not_examined") valid = false;
        const storeRows = [];
        if (!Array.isArray(source.store_candidates) || source.store_candidates.length > 5) valid = false;
        else {
          const seen = new Set();
          for (const item of source.store_candidates) {
            const row = item && typeof item === "object" ? item : {};
            const key = recoveryInspectionEnum(row.store_key, storeKeys);
            const snapshotStatus = recoveryInspectionEnum(row.snapshot_status, snapshotStatuses);
            const dependencyStatus = recoveryInspectionEnum(row.dependency_status, dependencyStatuses);
            const related = readCategories(row.related_dependencies);
            if (!key || !snapshotStatus || !dependencyStatus || !related || seen.has(key) ||
                JSON.stringify(related) !== JSON.stringify(dependenciesByStore[key])) { valid = false; continue; }
            seen.add(key);
            storeRows.push({ store_key: key, snapshot_status: snapshotStatus,
              dependency_status: dependencyStatus, related_dependencies: related });
          }
        }
        if (rawStatus === "matched" && (reason !== null || !scopeKind || !scopeDigest || !backupDigest || !planDigest ||
            matchedPlanCount !== 1 || storeCount === null || storeCount < 1 || storeCount > 5 ||
            verifiedStoreCount !== storeCount || storeRows.length !== storeCount || !dependencyScopeStatus ||
            storeRows.some(function (row) { return row.snapshot_status !== "verified" ||
              ["unobserved", "not_mapped", "unknown"].includes(row.dependency_status); }))) valid = false;
        const status = valid ? rawStatus : "invalid_report";
        const projection = valid ? {
          schema_version: 1,
          surface: "recovery_scope_applicability",
          mode: "read_only",
          status: rawStatus,
          reason,
          scope_kind: scopeKind,
          scope_digest: scopeDigest,
          backup_id_digest: backupDigest,
          matched_plan_id_digest: planDigest,
          matched_plan_scope_count: matchedPlanCount,
          store_candidate_count: storeCount,
          verified_store_candidate_count: verifiedStoreCount,
          dependency_scope_status: dependencyScopeStatus,
          residual_dependencies: residualDependencies,
          unobserved_dependencies: unobservedDependencies,
          store_candidates: storeRows,
          cross_store_atomic: source.cross_store_atomic,
          external_backup_restore_point: "not_examined",
          used_for_authority: false,
          may_execute: false
        } : {
          schema_version: 1,
          surface: "recovery_scope_applicability",
          mode: "read_only",
          status: "unverified",
          reason: "invalid_request",
          scope_kind: null,
          scope_digest: null,
          backup_id_digest: null,
          matched_plan_id_digest: null,
          matched_plan_scope_count: null,
          store_candidate_count: null,
          verified_store_candidate_count: null,
          dependency_scope_status: "unknown",
          residual_dependencies: [],
          unobserved_dependencies: [],
          store_candidates: [],
          cross_store_atomic: null,
          external_backup_restore_point: "not_examined",
          used_for_authority: false,
          may_execute: false
        };
        setText("recovery-scope-applicability-status", status === "matched" ? "照合成立（復旧可否は未判定）" : "未確認");
        byId("recovery-scope-applicability-status").className = "badge " + (status === "matched" ? "review" : "warn");
        const rowsText = storeRows.map(function (row) {
          return row.store_key + " / snapshot=" + row.snapshot_status + " / dependency=" + row.dependency_status +
            (row.related_dependencies.length ? " (" + row.related_dependencies.join(",") + ")" : "");
        });
        setText("recovery-scope-applicability-json", compactJson(projection) +
          (rowsText.length ? "\\n" + rowsText.join("\\n") : ""));
      }

      function settingsPayload() {
        const llm = {
          provider: byId("settings-provider").value,
          model: byId("settings-model").value,
          endpoint: byId("settings-endpoint").value,
          site_url: byId("settings-site-url").value,
          app_title: byId("settings-app-title").value,
          max_tokens: byId("settings-max-tokens").value
        };
        const apiKey = byId("settings-api-key").value.trim();
        if (apiKey) llm.api_key = apiKey;
        return { llm, approval: { mode: byId("settings-approval-mode").value } };
      }

      function connectorsPayload() {
        const composio = {
          user_id: byId("composio-user-id").value,
          allowed_toolkits: byId("composio-allowed-toolkits").value,
          allowed_actions: byId("composio-allowed-actions").value,
          revoked_actions: byId("composio-revoked-actions").value,
          api_base_url: byId("composio-api-base-url").value,
          dry_run: byId("composio-dry-run").value,
          live_execution: byId("composio-live-execution").value
        };
        if (byId("composio-clear-api-key").checked) composio.clear_api_key = true;
        const apiKey = byId("composio-api-key").value.trim();
        if (apiKey) composio.api_key = apiKey;
        return { composio };
      }

      async function loadSettings() {
        const token = byId("settings-token").value.trim();
        state.settingsToken = token;
        sessionStorage.setItem("bt.settingsToken", token);
        try {
          const body = await fetchJson("/settings/config", token);
          renderSettingsSnapshot(body);
          setText("settings-verify-status", "not run");
        } catch (error) {
          setText("settings-json", error.message);
          setText("settings-verify-status", "error");
          byId("settings-verify-status").className = "badge bad";
        }
      }

      async function loadConnectors(options) {
        const preserveSaveStatus = options && options.preserveSaveStatus === true;
        const token = byId("connectors-token").value.trim();
        state.connectorsToken = token;
        sessionStorage.setItem("bt.connectorsToken", token);
        try {
          const body = await fetchJson("/settings/config", token);
          renderSettingsSnapshot(body);
          if (!preserveSaveStatus) {
            setText("composio-save-status", "not saved");
            byId("composio-save-status").className = "badge warn";
          }
        } catch (error) {
          setText("connectors-json", error.message);
          setText("composio-save-status", "error");
          byId("composio-save-status").className = "badge bad";
        }
      }

      async function loadAbout() {
        const token = byId("about-token").value.trim();
        state.aboutToken = token;
        sessionStorage.setItem("bt.aboutToken", token);
        try {
          const body = await fetchJson("/app/about", token);
          renderAboutSnapshot(body);
        } catch (error) {
          setText("about-release-status", "error");
          byId("about-release-status").className = "badge bad";
          setText("about-json", error.message);
        }
      }

      async function loadUpdate() {
        const token = byId("update-token").value.trim();
        state.updateToken = token;
        sessionStorage.setItem("bt.updateToken", token);
        try {
          const body = await fetchJson("/update/snapshot", token);
          renderUpdateSnapshot(body);
        } catch (error) {
          setText("update-boundary-status", "error");
          byId("update-boundary-status").className = "badge bad";
          setText("update-json", error.message);
        }
      }

      async function runUpdateAction(route, body) {
        const token = byId("update-token").value.trim();
        state.updateToken = token;
        sessionStorage.setItem("bt.updateToken", token);
        try {
          const result = await postJson(route, token, body || {});
          await loadUpdate();
          renderUpdateActionResult(result);
        } catch (error) {
          setText("update-action-status", "error");
          byId("update-action-status").className = "badge bad";
          setText("update-json", error.message);
        }
      }

      async function verifyUpdate() {
        await runUpdateAction("/update/verify", {});
      }

      async function prepareUpdate() {
        if (!window.confirm("Create a pre-update backup and rollback plan?")) return;
        await runUpdateAction("/update/prepare", { confirm: "PRE_UPDATE_BACKUP" });
      }

      async function loadRecovery() {
        const token = byId("recovery-token").value.trim();
        state.recoveryToken = token;
        sessionStorage.setItem("bt.recoveryToken", token);
        try {
          const body = await fetchJson("/recovery/snapshot", token);
          renderRecoverySnapshot(body);
        } catch (error) {
          setText("recovery-boundary-status", "error");
          byId("recovery-boundary-status").className = "badge bad";
          setText("recovery-json", error.message);
        }
      }

      async function inspectRecoveryLedgers() {
        const token = byId("recovery-token").value.trim();
        state.recoveryToken = token;
        sessionStorage.setItem("bt.recoveryToken", token);
        try {
          const report = await fetchJson("/recovery/inspection", token);
          renderRecoveryInspection(report);
        } catch {
          setText("recovery-inspection-status", "取得失敗");
          byId("recovery-inspection-status").className = "badge bad";
          setText("recovery-inspection-json", "診断を取得できません。Gatewayの状態とmaintenance tokenを確認してください。");
        }
      }

      async function inspectRecoveryBackup() {
        const token = byId("recovery-token").value.trim();
        state.recoveryToken = token;
        sessionStorage.setItem("bt.recoveryToken", token);
        try {
          const report = await fetchJson("/recovery/backup-inspection", token);
          renderRecoveryBackupInspection(report);
          const backupDigest = report && report.status === "verified" ? recoveryInspectionDigest(report.backup_id_digest) : null;
          if (backupDigest) byId("recovery-scope-backup-digest").value = backupDigest;
        } catch {
          setText("recovery-backup-inspection-status", "取得失敗");
          byId("recovery-backup-inspection-status").className = "badge bad";
          setText("recovery-backup-inspection-json", "検査結果を取得できません。Gatewayの状態とmaintenance tokenを確認してください。");
        }
      }

      async function inspectRecoveryScopeApplicability() {
        const token = byId("recovery-token").value.trim();
        state.recoveryToken = token;
        sessionStorage.setItem("bt.recoveryToken", token);
        const storeCandidates = Array.from(document.querySelectorAll("[data-recovery-scope-store]:checked"))
          .map(function (input) { return input.getAttribute("data-recovery-scope-store"); });
        const request = {
          backup_id_digest: byId("recovery-scope-backup-digest").value.trim(),
          scope_kind: byId("recovery-scope-kind").value,
          scope_digest: byId("recovery-scope-digest").value.trim(),
          store_candidates: storeCandidates
        };
        try {
          const report = await postJson("/recovery/scope-applicability", token, request);
          renderRecoveryScopeApplicability(report);
        } catch {
          setText("recovery-scope-applicability-status", "取得失敗");
          byId("recovery-scope-applicability-status").className = "badge bad";
          setText("recovery-scope-applicability-json", "照合結果を取得できません。backup検査、scope digest、store候補、Gatewayの状態を確認してください。");
        }
      }

      async function runRecoveryAction(route, body) {
        const token = byId("recovery-token").value.trim();
        state.recoveryToken = token;
        sessionStorage.setItem("bt.recoveryToken", token);
        try {
          const result = await postJson(route, token, body || {});
          await loadRecovery();
          renderRecoveryActionResult(result);
        } catch (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        }
      }

      async function createRecoveryBackup() {
        await runRecoveryAction("/recovery/backup", {});
      }

      async function restoreRecoveryBackup() {
        if (!window.confirm("Submit a full configured-files restore request for owner L3 review? No recovery change runs until the owner approves it.")) return;
        const backupId = byId("recovery-backup-id").value.trim();
        const body = { confirm: "RESTORE" };
        if (backupId) body.backup_id = backupId;
        await runRecoveryAction("/recovery/restore", body);
      }

      async function restoreRecoveryStore() {
        const storeKey = byId("recovery-restore-store").value;
        const labels = {
          j_control: "J control ledger",
          m_state: "M state ledger",
          broker: "Broker execution ledger",
          operation_plans: "Operation Plan ledger",
          cron_events: "Cron event ledger"
        };
        if (!Object.prototype.hasOwnProperty.call(labels, storeKey)) {
          setText("recovery-action-status", "select one verified store");
          return;
        }
        const scopeKind = byId("recovery-scope-kind").value;
        const scopeDigest = byId("recovery-scope-digest").value.trim();
        if (storeKey === "operation_plans" &&
            (scopeKind !== "operation_plan" || !/^[a-f0-9]{64}$/i.test(scopeDigest))) {
          setText("recovery-action-status", "Operation Plan digestを指定してください");
          return;
        }
        const backupId = byId("recovery-backup-id").value.trim();
        const backupLabel = backupId || "latest backup";
        const scopePrompt = storeKey === "operation_plans"
          ? " Plan digest " + scopeDigest.toLowerCase() + " is bound to review; the effect replaces the entire selected Operation Plan store."
          : "";
        if (!window.confirm("Submit " + labels[storeKey] + " from " + backupLabel + " for owner L3 review? Only this store will be selected; no change runs until approval and a pre-action backup." + scopePrompt)) return;
        const body = { confirm: "RESTORE", store_key: storeKey };
        if (backupId) body.backup_id = backupId;
        if (storeKey === "operation_plans") {
          body.scope_kind = "operation_plan";
          body.scope_digest = scopeDigest.toLowerCase();
        }
        await runRecoveryAction("/recovery/restore", body);
      }

      async function resetRecoveryProvider() {
        if (!window.confirm("Submit a provider reset request for owner L3 review? No configuration changes until the owner approves it.")) return;
        await runRecoveryAction("/recovery/reset-provider", { confirm: "RESET_PROVIDER" });
      }

      async function resetRecoveryConnector() {
        if (!window.confirm("Submit a connector reset request for owner L3 review? No configuration changes until the owner approves it.")) return;
        await runRecoveryAction("/recovery/reset-connector", { confirm: "RESET_CONNECTOR" });
      }

      async function factoryResetRecovery() {
        if (!window.confirm("Submit a factory reset request for owner L3 review? No state changes until the owner approves it.")) return;
        await runRecoveryAction("/recovery/factory-reset", { confirm: "FACTORY_RESET" });
      }

      async function exportEvidence() {
        const token = byId("evidence-token").value.trim();
        state.evidenceToken = token;
        sessionStorage.setItem("bt.evidenceToken", token);
        try {
          const body = await postJson("/evidence/export", token, { actor: state.chatUser || "owner" });
          renderEvidenceExport(body);
        } catch (error) {
          setText("evidence-export-status", "error");
          byId("evidence-export-status").className = "badge bad";
          setText("evidence-json", error.message);
        }
      }

      async function saveConnectors() {
        const token = byId("connectors-token").value.trim();
        state.connectorsToken = token;
        sessionStorage.setItem("bt.connectorsToken", token);
        try {
          const body = await postJson("/settings/config", token, connectorsPayload());
          setText("connectors-json", compactJson(redactRuntimeValue(body)));
          await loadConnectors({ preserveSaveStatus: true });
          setText("composio-save-status", "saved; restart required");
          byId("composio-save-status").className = "badge warn";
        } catch (error) {
          setText("composio-save-status", "error");
          byId("composio-save-status").className = "badge bad";
          setText("connectors-json", error.message);
        }
      }

      async function verifyLlmSettings() {
        const token = byId("settings-token").value.trim();
        state.settingsToken = token;
        sessionStorage.setItem("bt.settingsToken", token);
        try {
          const body = await postJson("/settings/llm/verify", token, settingsPayload());
          const result = body.result || body;
          const status = result.status || "unknown";
          setText("settings-verify-status", status + ": " + (result.detail || result.next_action || "done"));
          byId("settings-verify-status").className = "badge " + (status === "pass" ? "good" : "bad");
          setText("settings-json", compactJson(redactRuntimeValue(body)));
        } catch (error) {
          setText("settings-verify-status", "error");
          byId("settings-verify-status").className = "badge bad";
          setText("settings-json", error.message);
        }
      }

      async function saveSettings() {
        const token = byId("settings-token").value.trim();
        state.settingsToken = token;
        sessionStorage.setItem("bt.settingsToken", token);
        try {
          const body = await postJson("/settings/config", token, settingsPayload());
          setText("settings-verify-status", "saved; restart required");
          byId("settings-verify-status").className = "badge warn";
          setText("settings-json", compactJson(redactRuntimeValue(body)));
          await loadSettings();
        } catch (error) {
          setText("settings-verify-status", "error");
          byId("settings-verify-status").className = "badge bad";
          setText("settings-json", error.message);
        }
      }

      function setRuntimeSnapshotObservation(value, tone) {
        const status = byId("runtime-snapshot-observed");
        if (!status) return;
        status.textContent = String(value);
        status.className = "badge " + (tone || "warn");
      }

      async function loadRuntime(source) {
        const token = byId("runtime-token").value.trim();
        state.runtimeToken = token;
        sessionStorage.setItem("bt.runtimeToken", token);
        const requestId = ++state.runtimeSnapshotRequestId;
        if (!token) {
          setText("gateway-status", "unknown");
          byId("gateway-status").className = "badge warn";
          setText("header-status", "snapshot not refreshed");
          byId("header-status").className = "badge warn";
          setText("runtime-json", "not refreshed: runtime token required");
          setRuntimeSnapshotObservation("not refreshed: runtime token required", "warn");
          return;
        }
        setRuntimeSnapshotObservation("refreshing" + (source === "webchat-connected" ? " after WebChat connection" : ""), "warn");
        try {
          const body = await fetchJson("/runtime/snapshot", token, { cache: "no-store" });
          if (requestId !== state.runtimeSnapshotRequestId) return;
          renderRuntime(body);
          setRuntimeSnapshotObservation("received " + new Date().toISOString(), "good");
        } catch (error) {
          if (requestId !== state.runtimeSnapshotRequestId) return;
          setText("gateway-status", "unknown");
          byId("gateway-status").className = "badge warn";
          setText("runtime-json", error.message);
          setText("header-status", "runtime error");
          byId("header-status").className = "badge bad";
          setRuntimeSnapshotObservation("refresh failed; Gateway state is unknown", "bad");
        }
      }

      async function loadApprovals() {
        const token = byId("approval-token").value.trim();
        state.approvalToken = token;
        state.approvalContentDigests = Object.create(null);
        sessionStorage.setItem("bt.approvalToken", token);
        try {
          const body = await fetchJson("/approval", token);
          renderApprovals(body);
        } catch (error) {
          setHtml("approval-list", '<div class="queue-item">' + escapeHtml(error.message) + '</div>');
          setText("approval-summary", "error");
          byId("approval-summary").className = "badge bad";
        }
      }

      async function submitGoalPurposeChange() {
        const ownerTokenInput = byId("goal-purpose-owner-token");
        const purposeInput = byId("goal-purpose-text");
        const status = byId("goal-purpose-submit-status");
        const ownerToken = ownerTokenInput.value.trim();
        const goalRef = byId("goal-purpose-goal-ref").value.trim();
        const purposeText = purposeInput.value;
        status.textContent = "submitting";
        status.className = "badge warn";
        try {
          const response = await fetch("/owner/goal-purpose-change", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders(ownerToken)
            },
            body: JSON.stringify({ goal_ref: goalRef, purpose_text: purposeText })
          });
          const result = await response.json().catch(function () { return null; });
          if (!response.ok || !result || result.accepted !== true) {
            status.textContent = result && (result.status || result.error) || "proposal was not accepted (HTTP " + response.status + ")";
            status.className = "badge bad";
            return;
          }
          purposeInput.value = "";
          status.textContent = "L3 review queued: " + (result.command_id || "command id unavailable") +
            " | goal " + result.goal_ref + " v" + result.prior_version + " | purpose digest " + result.new_purpose_digest;
          status.className = "badge good";
          await loadApprovals();
        } catch (error) {
          status.textContent = error && error.message ? error.message : "proposal request failed";
          status.className = "badge bad";
        } finally {
          ownerTokenInput.value = "";
        }
      }

      async function loadNotifications() {
        const token = byId("notifications-token").value.trim();
        state.notificationsToken = token;
        sessionStorage.setItem("bt.notificationsToken", token);
        try {
          const body = await fetchJson("/notifications", token);
          renderNotifications(body);
        } catch (error) {
          setHtml("notification-list", '<div class="notification-item">' + escapeHtml(error.message) + '</div>');
          setText("notification-summary", "error");
          byId("notification-summary").className = "badge bad";
        }
      }

      async function submitApproval(commandId, verdict, approvalToken) {
        const token = byId("approval-token").value.trim();
        const response = await fetch("/approval/" + encodeURIComponent(commandId), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(token)
          },
          body: JSON.stringify({
            verdict: verdict,
            approval_token: approvalToken,
            ...(state.approvalContentDigests[commandId]
              ? { content_review_digest: state.approvalContentDigests[commandId] }
              : {})
          })
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error("approval failed: HTTP " + response.status + " " + text);
        }
        await loadApprovals();
      }

      async function reviewApprovalContent(commandId, button) {
        const token = byId("approval-token").value.trim();
        delete state.approvalContentDigests[commandId];
        const card = Array.from(document.querySelectorAll(".queue-item[data-command]"))
          .find(function (item) { return item.getAttribute("data-command") === commandId; });
        if (!card) throw new Error("approval is no longer shown; reload pending approvals");
        const view = card.querySelector("[data-content-review-view]");
        const approve = card.querySelector('[data-verdict="approve"]');
        if (!view || !approve) throw new Error("content review panel is unavailable");
        view.textContent = "Refreshing exact content…";
        approve.disabled = true;
        const response = await fetch("/approval/" + encodeURIComponent(commandId) + "/content", {
          method: "POST",
          headers: authHeaders(token)
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error("content review failed: HTTP " + response.status + " " + text);
        }
        const review = await response.json();
        if (review.kind === "file_edit_diff") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          if (review.command_id !== commandId || review.operation !== "file.edit" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.before_content_digest) ||
              !isDigest(review.after_content_digest) || !isDigest(review.target_version_digest) ||
              !isDigest(review.operation_plan_binding_digest) || typeof review.path !== "string" ||
              review.path.length === 0 || review.path.length > 512 ||
              !Number.isSafeInteger(review.replacement_count) || review.replacement_count < 1 ||
              review.replacement_count > 100 || typeof review.diff !== "string" || review.diff.length === 0 ||
              new TextEncoder().encode(review.diff).byteLength > 128000) {
            throw new Error("変更差分の内容がこの承認要求に結び付いていません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "目的に結び付いたファイル変更差分（適用前）";
          view.appendChild(heading);
          [
            ["対象", review.path],
            ["置換数", String(review.replacement_count)],
            ["変更前digest", review.before_content_digest],
            ["変更後digest", review.after_content_digest],
            ["対象版digest", review.target_version_digest],
            ["Operation Plan目的束縛digest", review.operation_plan_binding_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const diff = document.createElement("pre");
          diff.className = "mono";
          diff.textContent = review.diff;
          view.appendChild(diff);
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "この差分確認は権限を作らず、承認直前と適用直前に対象版を再照合します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | diff review digest: " + review.review_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "変更差分を再確認";
          return;
        }
        if (review.kind === "goal_purpose_change") {
          if (review.command_id !== commandId || review.operation !== "goal.governance.change" ||
              review.used_for_authority !== false || !/^[a-f0-9]{64}$/.test(review.command_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.request_payload_digest || "") ||
              review.request_payload_digest !== review.new_purpose_digest ||
              !/^[a-f0-9]{64}$/.test(review.prior_purpose_digest || "") ||
              typeof review.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(review.goal_ref) ||
              !Number.isSafeInteger(review.prior_version) || review.prior_version <= 0 ||
              typeof review.purpose_text !== "string") {
            throw new Error("purpose review response is not bound to this approval");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "Exact delegated goal purpose proposed for change";
          view.appendChild(heading);
          [
            ["Goal reference", review.goal_ref],
            ["Current version", String(review.prior_version)],
            ["Current purpose digest", review.prior_purpose_digest],
            ["Proposed purpose digest", review.new_purpose_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const purposeLabel = document.createElement("strong");
          purposeLabel.textContent = "Exact proposed purpose";
          view.appendChild(purposeLabel);
          const purpose = document.createElement("pre");
          purpose.textContent = review.purpose_text;
          view.appendChild(purpose);
          const digests = document.createElement("small");
          digests.textContent = "Command digest: " + review.command_digest + " | Purpose digest: " + review.request_payload_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.command_digest;
          approve.disabled = false;
          button.textContent = "Refresh exact purpose";
          return;
        }
        if (review.kind === "goal_purpose_relation") {
          if (review.command_id !== commandId || review.operation !== "goal.governance.review_task_purpose" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !/^[a-f0-9]{64}$/.test(review.command_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.request_payload_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.plan_id_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.task_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.revision_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.purpose_digest || "") ||
              typeof review.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(review.goal_ref) ||
              !Number.isSafeInteger(review.purpose_version) || review.purpose_version <= 0 ||
              !["supports", "conflicts", "unknown"].includes(review.outcome) ||
              typeof review.task !== "string" || typeof review.purpose_text !== "string" || !isObject(review.plan) ||
              review.plan_id_digest !== card.dataset.planIdDigest || review.task_digest !== card.dataset.taskDigest ||
              review.revision_digest !== card.dataset.revisionDigest || review.goal_ref !== card.dataset.goalRef ||
              String(review.purpose_version) !== card.dataset.purposeVersion ||
              review.purpose_digest !== card.dataset.purposeDigest || review.outcome !== card.dataset.relationOutcome ||
              !["supports", "conflicts", "unknown"].includes(review.candidate_outcome) ||
              !["present", "missing", "invalid"].includes(review.candidate_status) ||
              !["exact_spans_present", "not_provided", "citation_mismatch", "purpose_unavailable"].includes(review.evidence_status) ||
              !Number.isSafeInteger(review.evidence_count) || review.evidence_count < 0) {
            throw new Error("task・目的確認の内容がこの承認要求と一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "正確なtask・委任目的・操作計画";
          view.appendChild(heading);
          [
            ["L3確認に選択した関係", review.outcome],
            ["plan digest", review.plan_id_digest],
            ["revision digest", review.revision_digest],
            ["task digest", review.task_digest],
            ["作業目的", review.goal_ref + " v" + String(review.purpose_version)],
            ["目的digest", review.purpose_digest],
            ["C候補", String(review.candidate_outcome) + " / " + String(review.candidate_status)],
            ["引用照合", String(review.evidence_status) + " / " + String(review.evidence_count)]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          [["正確なtask", review.task], ["正確な委任目的", review.purpose_text]].forEach(function (field) {
            const label = document.createElement("strong");
            label.textContent = field[0];
            view.appendChild(label);
            const content = document.createElement("pre");
            content.textContent = field[1];
            view.appendChild(content);
          });
          const planLabel = document.createElement("strong");
          planLabel.textContent = "正確な操作計画";
          view.appendChild(planLabel);
          const plan = document.createElement("pre");
          plan.textContent = JSON.stringify(review.plan, null, 2);
          view.appendChild(plan);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | 審査payload digest: " + review.request_payload_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.command_digest;
          approve.disabled = false;
          button.textContent = "task・目的の内容を再確認";
          return;
        }
        if (review.kind === "meaning_update_adoption") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const isEvidence = function (value) {
            return Array.isArray(value) && value.every(function (entry) {
              return isObject(entry) && typeof entry.reference === "string" && entry.reference.length > 0 &&
                isDigest(entry.digest);
            });
          };
          if (review.command_id !== commandId || review.operation !== "memory.meaning.adopt" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              review.semantic_relation_status !== "not_assessed" || review.adoption_status !== "not_adopted" ||
              !isDigest(review.command_digest) || !isDigest(review.request_payload_digest) ||
              !isDigest(review.proposal_digest) || !isDigest(review.candidate_digest) ||
              review.request_payload_digest !== review.proposal_digest ||
              review.proposal_digest !== card.dataset.proposalDigest ||
              review.candidate_digest !== card.dataset.candidateDigest ||
              review.target_record_id !== card.dataset.targetRecordId ||
              review.target_version !== card.dataset.targetVersion || !isDigest(review.target_version) ||
              typeof review.proposal_ref !== "string" || review.proposal_ref.length === 0 ||
              typeof review.candidate_ref !== "string" || review.candidate_ref.length === 0 ||
              typeof review.candidate_meaning !== "string" || review.candidate_meaning.length === 0 ||
              typeof review.target_record_id !== "string" || review.target_record_id.length === 0 ||
              typeof review.prior_version_ref !== "string" || review.prior_version_ref.length === 0 ||
              !isEvidence(review.supporting_evidence) || !isEvidence(review.counterevidence_review?.references) ||
              !isObject(review.counterevidence_review?.review_scope) ||
              typeof review.counterevidence_review.review_scope.reference !== "string" ||
              !isDigest(review.counterevidence_review.review_scope.digest) ||
              !["reviewed_with_references", "reviewed_none_found"].includes(review.counterevidence_review.status) ||
              !isObject(review.applicability_scope) || typeof review.applicability_scope.reference !== "string" ||
              !isDigest(review.applicability_scope.digest) || typeof review.reflection_target_ref !== "string" ||
              review.reflection_target_ref.length === 0 ||
              !["prior_version_unverified", "counterevidence_absence_unverified"].includes(review.reference_review_status)) {
            throw new Error("意味更新候補の内容がこの承認要求と一致しません");
          }
          const candidateDigestBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(review.candidate_meaning));
          const candidateDigest = Array.from(new Uint8Array(candidateDigestBuffer))
            .map(function (value) { return value.toString(16).padStart(2, "0"); }).join("");
          if (candidateDigest !== review.candidate_digest) {
            throw new Error("意味更新候補本文のdigestが一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "正確な意味更新候補（採用はこのL3承認の後に実施）";
          view.appendChild(heading);
          [
            ["proposal reference", review.proposal_ref], ["candidate reference", review.candidate_ref],
            ["proposal digest", review.proposal_digest], ["candidate digest", review.candidate_digest],
            ["対象記録", review.target_record_id], ["対象版", review.target_version],
            ["参照照合", review.reference_review_status], ["prior version reference", review.prior_version_ref],
            ["適用範囲", review.applicability_scope.reference + " / " + review.applicability_scope.digest],
            ["反映先 reference", review.reflection_target_ref],
            ["反証確認", review.counterevidence_review.status + " / " + review.counterevidence_review.review_scope.reference],
            ["意味関係", review.semantic_relation_status], ["採用状態", review.adoption_status],
            ["実行可能性", String(review.may_execute)], ["権限への利用", String(review.used_for_authority)]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const meaningLabel = document.createElement("strong");
          meaningLabel.textContent = "正確な候補本文";
          view.appendChild(meaningLabel);
          const meaning = document.createElement("pre");
          meaning.textContent = review.candidate_meaning;
          view.appendChild(meaning);
          [["支持証拠", review.supporting_evidence], ["反証参照", review.counterevidence_review.references]].forEach(function (section) {
            const label = document.createElement("strong");
            label.textContent = section[0];
            view.appendChild(label);
            const refs = document.createElement("pre");
            refs.textContent = JSON.stringify(section[1], null, 2);
            view.appendChild(refs);
          });
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | proposal digest: " + review.proposal_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.command_digest;
          approve.disabled = false;
          button.textContent = "候補本文を再確認";
          return;
        }
        if (review.command_id !== commandId ||
            (review.operation !== "gmail.write.message.send" && review.operation !== "gmail.write.draft.create" &&
              review.operation !== "gmail.write.draft.send") ||
            review.used_for_authority !== false || !/^[a-f0-9]{64}$/.test(review.command_digest || "") ||
            !/^[a-f0-9]{64}$/.test(review.request_payload_digest || "") ||
            (review.review_digest !== undefined && !/^[a-f0-9]{64}$/.test(review.review_digest)) ||
            (review.provider_state_digest !== undefined && !/^[a-f0-9]{64}$/.test(review.provider_state_digest)) ||
            (review.provider_raw_digest !== undefined && !/^[a-f0-9]{64}$/.test(review.provider_raw_digest)) ||
            typeof review.to !== "string" || typeof review.subject !== "string" ||
            typeof review.body_text !== "string") {
          throw new Error("content review response is not bound to this approval");
        }
        view.replaceChildren();
        const heading = document.createElement("strong");
        heading.textContent = review.operation === "gmail.write.draft.create"
          ? "Exact Gmail draft to be created (not sent)"
          : review.operation === "gmail.write.draft.send"
            ? "Exact existing Gmail draft to be sent"
            : "Exact outgoing message";
        view.appendChild(heading);
        if (review.account_email) {
          const account = document.createElement("p");
          account.textContent = "Authenticated Gmail account: " + review.account_email;
          view.appendChild(account);
        }
        [["To", review.to], ["Cc", review.cc], ["Bcc", review.bcc], ["From", review.from], ["Subject", review.subject]]
          .forEach(function (field) {
            if (field[1] === undefined) return;
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
        if (review.reply_to) {
          const replyTo = document.createElement("p");
          replyTo.textContent = "Reply-To: " + review.reply_to;
          view.appendChild(replyTo);
        }
        const bodyLabel = document.createElement("strong");
        bodyLabel.textContent = "Body";
        view.appendChild(bodyLabel);
        const body = document.createElement("pre");
        body.textContent = review.body_text;
        view.appendChild(body);
        const digests = document.createElement("small");
        digests.textContent = "Command digest: " + review.command_digest +
          " | Provider state digest: " + (review.provider_state_digest || "not applicable") +
          " | Request payload digest: " + review.request_payload_digest;
        view.appendChild(digests);
        state.approvalContentDigests[commandId] = review.review_digest || review.command_digest;
        approve.disabled = false;
        button.textContent = review.operation === "gmail.write.draft.send"
          ? "Refresh existing draft content" : "Refresh exact content";
      }

      async function revokeApprovalGrant(grantId) {
        const token = byId("approval-token").value.trim();
        const reason = byId("approval-emergency-reason").value.trim() || "operator revoked reusable grant";
        const response = await fetch("/approval/grants/" + encodeURIComponent(grantId) + "/revoke", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(token)
          },
          body: JSON.stringify({ actor: "webchat-human", reason: reason })
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error("grant revoke failed: HTTP " + response.status + " " + text);
        }
        await loadApprovals();
      }

      async function setEmergencyStop(action) {
        const token = byId("approval-token").value.trim();
        const reason = byId("approval-emergency-reason").value.trim() || (action === "activate" ? "owner emergency stop" : "owner emergency stop cleared");
        const response = await fetch("/approval/emergency-stop", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(token)
          },
          body: JSON.stringify({ action: action, actor: "webchat-human", reason: reason })
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error("emergency stop failed: HTTP " + response.status + " " + text);
        }
        await loadApprovals();
      }

      async function loadAuditText() {
        const token = byId("audit-token").value.trim();
        state.auditToken = token;
        sessionStorage.setItem("bt.auditToken", token);
        try {
          const response = await fetch("/audit/dump", { headers: authHeaders(token) });
          if (!response.ok) throw new Error("audit dump failed: HTTP " + response.status);
          const text = await response.text();
          setText("audit-text", text);
        } catch (error) {
          setText("audit-text", error.message);
          setText("audit-status", "error");
          byId("audit-status").className = "badge bad";
        }
      }

      async function verifyAudit() {
        const token = byId("audit-token").value.trim();
        state.auditToken = token;
        sessionStorage.setItem("bt.auditToken", token);
        try {
          const body = await fetchJson("/audit/dump?format=json", token);
          renderAudit(body);
          setText("audit-text", compactJson(redactRuntimeValue({
            chain_valid: body.chain_valid ?? body.valid ?? body.audit_chain_valid,
            entry_count: Array.isArray(body.entries) ? body.entries.length : Array.isArray(body.audit_log) ? body.audit_log.length : 0,
            failure: body.failure || body.error || null
          })));
        } catch (error) {
          setText("audit-text", error.message);
          setText("audit-status", "error");
          byId("audit-status").className = "badge bad";
        }
      }

      async function loadAuthorityTrace() {
        const token = byId("authority-token").value.trim();
        state.authorityToken = token;
        sessionStorage.setItem("bt.authorityToken", token);
        try {
          const body = await fetchJson("/authority/trace", token);
          renderAuthorityTrace(body);
        } catch (error) {
          setText("authority-json", error.message);
          setHtml("authority-trace-list", '<div class="trace-item">' + escapeHtml(error.message) + '</div>');
          setText("authority-summary", "error");
          byId("authority-summary").className = "badge bad";
        }
      }

      async function loadHistory() {
        const token = byId("history-token").value.trim();
        const kind = byId("history-kind").value.trim();
        state.historyToken = token;
        state.historyKind = kind;
        sessionStorage.setItem("bt.historyToken", token);
        sessionStorage.setItem("bt.historyKind", kind);
        const params = new URLSearchParams({ limit: "50" });
        if (kind) params.set("kind", kind);
        try {
          const body = await fetchJson("/history/replay?" + params.toString(), token);
          renderHistory(body);
        } catch (error) {
          setText("history-json", error.message);
          setHtml("history-list", '<div class="history-item">' + escapeHtml(error.message) + '</div>');
          setText("history-summary", "error");
          byId("history-summary").className = "badge bad";
        }
      }

      document.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement)) return;
        const screen = target.dataset.screen;
        if (screen) {
          setActiveScreen(screen);
          return;
        }
        const mascotAction = target.dataset.mascotAction;
        if (mascotAction) {
          runMascotAction(mascotAction);
          return;
        }
        if (target.dataset.operationPlanReconcile === "true") {
          target.disabled = true;
          try {
            await invokeReceiptReconciliation(target.dataset.planId || "", target.dataset.revisionDigest || "", target.dataset.stepId || "");
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.purposeRelationReview === "true") {
          target.disabled = true;
          const container = target.closest(".trace-item");
          const outcome = container && container.querySelector("[data-purpose-relation-outcome]");
          const status = container && container.querySelector("[data-purpose-relation-status]");
          const ownerTokenInput = byId("purpose-relation-owner-token");
          const ownerToken = ownerTokenInput.value.trim();
          if (status) {
            status.textContent = "送信中";
            status.className = "badge warn";
          }
          try {
            if (!(outcome instanceof HTMLSelectElement) || !["supports", "conflicts", "unknown"].includes(outcome.value)) {
              throw new Error("確認結果を選択してください");
            }
            const response = await fetch("/owner/goal-purpose-relation-review", {
              method: "POST",
              headers: { "content-type": "application/json", ...authHeaders(ownerToken) },
              body: JSON.stringify({
                plan_id_digest: target.dataset.planId || "",
                revision_digest: target.dataset.revisionDigest || "",
                outcome: outcome.value
              })
            });
            const result = await response.json().catch(function () { return null; });
            if (!response.ok || !result || result.accepted !== true) {
              throw new Error(result && (result.status || result.error) || "L3審査依頼を受け付けませんでした (HTTP " + response.status + ")");
            }
            if (status) {
              status.textContent = "L3審査キューへ登録: " + (result.command_id || "command id unavailable");
              status.className = "badge good";
            }
            await loadApprovals();
            await loadRuntime();
          } catch (error) {
            if (status) {
              status.textContent = error && error.message ? error.message : "審査依頼に失敗しました";
              status.className = "badge bad";
            }
          } finally {
            ownerTokenInput.value = "";
            target.disabled = false;
          }
          return;
        }
        const verdict = target.dataset.verdict;
        const reviewCommandId = target.dataset.reviewContent;
        const revokeGrantId = target.dataset.revokeGrant;
        if (revokeGrantId) {
          target.disabled = true;
          try {
            await revokeApprovalGrant(revokeGrantId);
          } catch (error) {
            alert(error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (reviewCommandId) {
          target.disabled = true;
          try {
            await reviewApprovalContent(reviewCommandId, target);
          } catch (error) {
            alert(error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (!verdict) return;
        target.disabled = true;
        try {
          const commandId = target.dataset.command || "";
          await submitApproval(commandId, verdict, state.approvalTokens[commandId] || "");
        } catch (error) {
          alert(error.message);
        } finally {
          target.disabled = false;
        }
      });

      byId("load-runtime").addEventListener("click", loadRuntime);
      byId("load-notifications").addEventListener("click", loadNotifications);
      byId("load-approvals").addEventListener("click", loadApprovals);
      byId("submit-goal-purpose-change").addEventListener("click", function () {
        submitGoalPurposeChange().catch(function () {
          const status = byId("goal-purpose-submit-status");
          status.textContent = "proposal request failed";
          status.className = "badge bad";
          byId("goal-purpose-owner-token").value = "";
        });
      });
      byId("activate-emergency-stop").addEventListener("click", function () {
        setEmergencyStop("activate").catch(function (error) {
          alert(error.message);
        });
      });
      byId("clear-emergency-stop").addEventListener("click", function () {
        setEmergencyStop("clear").catch(function (error) {
          alert(error.message);
        });
      });
      byId("load-audit").addEventListener("click", loadAuditText);
      byId("verify-audit").addEventListener("click", verifyAudit);
      byId("load-authority").addEventListener("click", loadAuthorityTrace);
      byId("load-history").addEventListener("click", loadHistory);
      byId("export-evidence").addEventListener("click", exportEvidence);
      byId("load-settings").addEventListener("click", loadSettings);
      byId("load-connectors").addEventListener("click", loadConnectors);
      byId("save-connectors").addEventListener("click", saveConnectors);
      byId("load-about").addEventListener("click", loadAbout);
      byId("load-update").addEventListener("click", loadUpdate);
      byId("verify-update").addEventListener("click", function () {
        verifyUpdate().catch(function (error) {
          setText("update-action-status", "error");
          byId("update-action-status").className = "badge bad";
          setText("update-json", error.message);
        });
      });
      byId("prepare-update").addEventListener("click", function () {
        prepareUpdate().catch(function (error) {
          setText("update-action-status", "error");
          byId("update-action-status").className = "badge bad";
          setText("update-json", error.message);
        });
      });
      byId("load-recovery").addEventListener("click", loadRecovery);
      byId("inspect-recovery-ledgers").addEventListener("click", function () {
        inspectRecoveryLedgers().catch(function () {
          setText("recovery-inspection-status", "取得失敗");
          byId("recovery-inspection-status").className = "badge bad";
          setText("recovery-inspection-json", "診断を取得できません。Gatewayの状態とmaintenance tokenを確認してください。");
        });
      });
      byId("inspect-recovery-backup").addEventListener("click", function () {
        inspectRecoveryBackup().catch(function () {
          setText("recovery-backup-inspection-status", "取得失敗");
          byId("recovery-backup-inspection-status").className = "badge bad";
          setText("recovery-backup-inspection-json", "検査結果を取得できません。Gatewayの状態とmaintenance tokenを確認してください。");
        });
      });
      byId("inspect-recovery-scope-applicability").addEventListener("click", function () {
        inspectRecoveryScopeApplicability().catch(function () {
          setText("recovery-scope-applicability-status", "取得失敗");
          byId("recovery-scope-applicability-status").className = "badge bad";
          setText("recovery-scope-applicability-json", "照合結果を取得できません。指定内容とGatewayの状態を確認してください。");
        });
      });
      byId("create-recovery-backup").addEventListener("click", function () {
        createRecoveryBackup().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("restore-recovery-backup").addEventListener("click", function () {
        restoreRecoveryBackup().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("recovery-restore-store").addEventListener("change", function () {
        byId("restore-recovery-store").disabled =
          byId("recovery-restore-store").getAttribute("data-review-available") !== "true" ||
          !byId("recovery-restore-store").value;
      });
      byId("restore-recovery-store").addEventListener("click", function () {
        restoreRecoveryStore().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("reset-recovery-provider").addEventListener("click", function () {
        resetRecoveryProvider().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("reset-recovery-connector").addEventListener("click", function () {
        resetRecoveryConnector().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("factory-reset-recovery").addEventListener("click", function () {
        factoryResetRecovery().catch(function (error) {
          setText("recovery-action-status", "error");
          byId("recovery-action-status").className = "badge bad";
          setText("recovery-json", error.message);
        });
      });
      byId("verify-llm-settings").addEventListener("click", verifyLlmSettings);
      byId("save-settings").addEventListener("click", saveSettings);
      byId("connect-chat").addEventListener("click", function () {
        connectChat().catch(function (error) {
          setChatStatus("WebChat error", "bad");
          appendChat("error", error.message);
        });
      });
      byId("send-chat").addEventListener("click", function () {
        sendChat().catch(function (error) {
          setChatStatus("WebChat error", "bad");
          appendChat("error", error.message);
        });
      });
      byId("chat-content").addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sendChat().catch(function (error) {
            setChatStatus("WebChat error", "bad");
            appendChat("error", error.message);
          });
        }
      });
      byId("disconnect-chat").addEventListener("click", disconnectChat);

      bindMascotControls();
      syncInputs();
      setActiveScreen(state.activeScreen);
      renderAotanuMascot("idle");
`;
