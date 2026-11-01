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
        chatReconnectToken: "",
        chatReconnectUser: "",
        chatReconnectEnabled: false,
        chatReconnectAttempt: 0,
        chatReconnectTimer: null,
        runtimeSnapshotRequestId: 0,
        approvalSnapshotRequestId: 0,
        approvalTokens: Object.create(null),
        approvalContentDigests: Object.create(null),
        goalPurposeCandidates: []
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

      function appendChat(kind, text, requestId) {
        const log = byId("chat-log");
        const item = document.createElement("article");
        const role = chatRoleForKind(kind);
        const requestRef = typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200
          ? requestId : "";
        if (requestRef) item.dataset.requestId = requestRef;
        const correlation = role === "assistant" && requestRef
          ? '<small class="chat-request-ref">依頼ID末尾: ' + escapeHtml(requestRef.slice(-12)) + '</small>'
          : "";
        item.className = "chat-item " + role;
        item.innerHTML = '<div class="chat-bubble"><div class="chat-meta">' + escapeHtml(chatLabelForRole(role, kind)) + '</div><p>' + escapeHtml(text) + '</p>' + correlation + '</div>';
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

      function disconnectChat(options) {
        if (state.chatReconnectTimer !== null) {
          clearTimeout(state.chatReconnectTimer);
          state.chatReconnectTimer = null;
        }
        if (!options || options.preserveReconnect !== true) {
          state.chatReconnectEnabled = false;
          state.chatReconnectAttempt = 0;
          state.chatReconnectToken = "";
          state.chatReconnectUser = "";
        }
        state.chatConnectionGeneration += 1;
        const socket = state.chatSocket;
        state.chatSocket = null;
        if (socket) {
          try { socket.close(); } catch (_) { /* ignore */ }
        }
        setChatStatus("WebChat disconnected", "warn");
      }

      function scheduleChatReconnect(generation) {
        const delays = [1000, 2000, 5000, 10000, 30000];
        if (!state.chatReconnectEnabled || generation !== state.chatConnectionGeneration ||
            state.chatReconnectTimer !== null || state.chatSocket) return;
        if (state.chatReconnectAttempt >= delays.length) {
          setChatStatus("WebChat disconnected; reconnect manually", "warn");
          return;
        }
        const attempt = state.chatReconnectAttempt + 1;
        const delay = delays[state.chatReconnectAttempt];
        state.chatReconnectAttempt = attempt;
        setChatStatus("WebChat reconnecting (" + attempt + "/" + delays.length + ")", "warn");
        state.chatReconnectTimer = setTimeout(function () {
          state.chatReconnectTimer = null;
          if (!state.chatReconnectEnabled || generation !== state.chatConnectionGeneration || state.chatSocket) return;
          connectChat(true).catch(function () {
            scheduleChatReconnect(state.chatConnectionGeneration);
          });
        }, delay);
      }

      async function connectChat(isAutomaticReconnect) {
        const reconnecting = isAutomaticReconnect === true;
        if (reconnecting) {
          state.chatToken = state.chatReconnectToken;
          state.chatUser = state.chatReconnectUser || state.chatUser;
        } else {
          state.chatToken = byId("chat-token").value.trim();
          state.chatUser = byId("chat-user").value.trim() || "owner";
          state.chatReconnectToken = state.chatToken;
          state.chatReconnectUser = state.chatUser;
          sessionStorage.setItem("bt.chatToken", state.chatToken);
          sessionStorage.setItem("bt.chatUser", state.chatUser);
        }
        if (!state.chatToken) throw new Error("webchat token is required");
        if (isAutomaticReconnect !== true) {
          state.chatReconnectEnabled = true;
          state.chatReconnectAttempt = 0;
        }
        disconnectChat({ preserveReconnect: true });
        const generation = state.chatConnectionGeneration;
        const ticket = await postJson("/ws-ticket", state.chatToken, { user: state.chatUser });
        if (generation !== state.chatConnectionGeneration) return;
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(protocol + "://" + window.location.host + "/ws?ticket=" + encodeURIComponent(ticket.ticket));
        state.chatSocket = ws;
        setChatStatus("WebChat connecting", "warn");
        ws.addEventListener("open", function () {
          if (state.chatSocket !== ws || generation !== state.chatConnectionGeneration) return;
          if (reconnecting) state.chatReconnectAttempt = 0;
          setChatStatus("WebChat connected", "good");
          loadRuntime("webchat-connected");
        });
        ws.addEventListener("message", function (event) {
          if (state.chatSocket !== ws || generation !== state.chatConnectionGeneration) return;
          let frame = null;
          try { frame = JSON.parse(event.data); } catch (_) { frame = { kind: "message", content: String(event.data) }; }
          if (frame.kind === "hello") {
            appendChat("system", "connected as " + (frame.user || state.chatUser));
            if (reconnecting) {
              appendChat("system", "WebChatを再接続しました。切断中のtaskは自動再送していません。返信が未着なら、保存済み依頼IDとowner tokenで状態を照会してください。");
            }
            return;
          }
          appendChat(frame.kind || "message", frame.content || compactJson(redactRuntimeValue(frame)), frame.request_id);
          if ((frame.kind === "channel_send" || frame.kind === "error") &&
              byId("runtime-token").value.trim()) {
            void loadRuntime("webchat-message");
          }
          if (frame.kind === "channel_send" && typeof frame.content === "string" &&
              frame.content.startsWith("[approval-required]") && byId("approval-token").value.trim()) {
            void loadApprovals();
          }
        });
        ws.addEventListener("close", function () {
          if (state.chatSocket === ws && generation === state.chatConnectionGeneration) {
            state.chatSocket = null;
            setChatStatus("WebChat disconnected", "warn");
            scheduleChatReconnect(generation);
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
        appendChat("accepted", result.request_id || "request accepted", result.request_id);
      }

      async function loadOwnerTaskGoals() {
        const ownerToken = byId("owner-task-token").value.trim();
        const status = byId("owner-task-status");
        if (!ownerToken) throw new Error("owner tokenを入力してください");
        const response = await fetchJson("/owner/task-goals", ownerToken, { cache: "no-store" });
        const goals = Array.isArray(response.goals) ? response.goals : [];
        const select = byId("owner-task-goal-ref");
        select.replaceChildren(new Option(goals.length ? "委任目的を選択" : "利用できる委任目的がありません", ""));
        goals.forEach(function (goal) {
          if (!isObject(goal) || typeof goal.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(goal.goal_ref) ||
              !Number.isSafeInteger(goal.purpose_version) || goal.purpose_version < 2 ||
              typeof goal.purpose_preview !== "string" || goal.purpose_preview.length > 500) return;
          const option = new Option(goal.goal_ref + " · v" + goal.purpose_version + " · " + goal.purpose_preview,
            goal.goal_ref);
          option.dataset.purposeVersion = String(goal.purpose_version);
          select.add(option);
        });
        status.textContent = goals.length ? "現在の委任目的を読み込みました" : "利用できる委任目的がありません";
        status.className = goals.length ? "badge good" : "badge warn";
      }

      let ownerTaskSubmissionIdMemory = null;
      let ownerTaskStatusSubmissionIdsMemory = [];
      const OWNER_TASK_SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const OWNER_TASK_STATUS_SUBMISSION_IDS_KEY = "blue-tanuki.owner-task-status-submission-ids.v1";

      function ownerTaskStatusSubmissionIds() {
        const ids = [];
        const add = function (value) {
          if (typeof value === "string" && OWNER_TASK_SUBMISSION_ID_PATTERN.test(value) && !ids.includes(value)) {
            ids.push(value);
          }
        };
        ownerTaskStatusSubmissionIdsMemory.forEach(add);
        try { add(sessionStorage.getItem("blue-tanuki.owner-task-submission-id.v1")); }
        catch { /* current-tab pending identifier is optional */ }
        try { add(sessionStorage.getItem("blue-tanuki.owner-task-status-submission-id.v1")); }
        catch { /* the cross-session list may still be available */ }
        try { add(localStorage.getItem("blue-tanuki.owner-task-status-submission-id.v1")); }
        catch { /* preserve the identifiers available from the list or current page */ }
        try {
          const saved = JSON.parse(localStorage.getItem(OWNER_TASK_STATUS_SUBMISSION_IDS_KEY) || "[]");
          if (Array.isArray(saved)) saved.forEach(add);
        } catch { /* cross-session recovery remains unavailable when local storage is unreadable */ }
        return ids;
      }

      function renderOwnerTaskStatusSubmissionIds(preferredId) {
        const select = byId("owner-task-status-submission-id");
        const ids = ownerTaskStatusSubmissionIds();
        select.replaceChildren(new Option("依頼IDを選択", ""));
        ids.forEach(function (id) {
          select.add(new Option("依頼ID · " + id.slice(-12), id));
        });
        const selected = ids.includes(preferredId) ? preferredId : ids[0] || "";
        select.value = selected;
        select.hidden = ids.length < 2;
        byId("check-owner-task-status").hidden = ids.length === 0;
      }

      function pendingOwnerTaskSubmissionId() {
        const storageKey = "blue-tanuki.owner-task-submission-id.v1";
        if (ownerTaskSubmissionIdMemory) return ownerTaskSubmissionIdMemory;
        try {
          const stored = sessionStorage.getItem(storageKey);
          if (typeof stored === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) {
            ownerTaskSubmissionIdMemory = stored;
            return stored;
          }
        } catch { /* keep the identifier in this page session when storage is unavailable */ }
        const recoveredSubmissionId = ownerTaskStatusSubmissionIds()[0];
        if (recoveredSubmissionId) {
          ownerTaskSubmissionIdMemory = recoveredSubmissionId;
          try { sessionStorage.setItem(storageKey, recoveredSubmissionId); }
          catch { /* the recovered identifier remains in page memory */ }
          return recoveredSubmissionId;
        }
        ownerTaskSubmissionIdMemory = crypto.randomUUID();
        try { sessionStorage.setItem(storageKey, ownerTaskSubmissionIdMemory); } catch { /* page memory remains available */ }
        return ownerTaskSubmissionIdMemory;
      }

      function ownerTaskStatusSubmissionId() {
        const select = byId("owner-task-status-submission-id");
        const selected = select && select.value;
        if (typeof selected === "string" && OWNER_TASK_SUBMISSION_ID_PATTERN.test(selected)) return selected;
        if (ownerTaskSubmissionIdMemory && OWNER_TASK_SUBMISSION_ID_PATTERN.test(ownerTaskSubmissionIdMemory)) {
          return ownerTaskSubmissionIdMemory;
        }
        return ownerTaskStatusSubmissionIds()[0] || null;
      }

      function rememberOwnerTaskStatusSubmissionId(submissionId) {
        if (typeof submissionId !== "string" || !OWNER_TASK_SUBMISSION_ID_PATTERN.test(submissionId)) return;
        ownerTaskStatusSubmissionIdsMemory = [submissionId].concat(
          ownerTaskStatusSubmissionIds().filter(function (id) { return id !== submissionId; }));
        try { sessionStorage.setItem("blue-tanuki.owner-task-status-submission-id.v1", submissionId); }
        catch { /* current page keeps the status action available */ }
        try { localStorage.setItem("blue-tanuki.owner-task-status-submission-id.v1", submissionId); }
        catch { /* cross-session status recovery is optional; never persist task content or tokens */ }
        try { localStorage.setItem(OWNER_TASK_STATUS_SUBMISSION_IDS_KEY, JSON.stringify(ownerTaskStatusSubmissionIdsMemory)); }
        catch { /* current-tab status recovery remains available when storage is full or disabled */ }
        renderOwnerTaskStatusSubmissionIds(submissionId);
      }

      function clearOwnerTaskSubmissionId() {
        ownerTaskSubmissionIdMemory = crypto.randomUUID();
        try { sessionStorage.setItem("blue-tanuki.owner-task-submission-id.v1", ownerTaskSubmissionIdMemory); }
        catch { /* page memory remains available */ }
        rememberOwnerTaskStatusSubmissionId(ownerTaskSubmissionIdMemory);
        byId("owner-task-new-submission").hidden = true;
      }

      async function postOwnerTaskCompute(token, body) {
        byId("owner-task-new-submission").hidden = true;
        rememberOwnerTaskStatusSubmissionId(body && body.submission_id);
        const response = await fetch("/owner/task-compute", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders(token)),
          body: JSON.stringify(body)
        });
        let result = null;
        try { result = await response.json(); } catch { /* use the fixed HTTP failure below */ }
        if (!response.ok) {
          const statusCode = result && typeof result.status === "string" ? result.status : "";
          const requestId = result && typeof result.request_id === "string" ? result.request_id : "";
          const knownNotDispatched = statusCode === "owner_task_submission_not_dispatched" ||
            statusCode === "owner_task_submission_already_rejected" ||
            statusCode === "delegated_task_purpose_changed" ||
            statusCode === "delegated_task_purpose_unavailable";
          if (knownNotDispatched) {
            clearOwnerTaskSubmissionId();
          }
          if (statusCode === "owner_task_submission_not_dispatched") {
            throw new Error("GatewayからHDSへは未送信です。内容を確認して再送できます。");
          }
          if (statusCode === "owner_task_submission_outcome_unknown") {
            throw new Error("依頼結果が不明です。依頼IDを保持しました。Tasks／Runtimeで状態を確認してください。新規依頼へ切り替える場合は、先行依頼の状態を確認してから専用ボタンを使ってください。参照ID: " + requestId);
          }
          if (statusCode === "submission_id_reused_with_different_input") {
            throw new Error("この依頼IDは別の内容で使用済みです。IDを保持したままにしました。先行依頼をTasks／Runtimeで確認してください。新規依頼へ切り替える場合は、状態確認後に専用ボタンを使ってください。参照ID: " + requestId);
          }
          if (statusCode === "owner_task_submission_already_rejected") {
            throw new Error("この依頼は以前に拒否されています。現在の目的を再確認してください。参照ID: " + requestId);
          }
          if (statusCode === "delegated_task_purpose_changed") {
            throw new Error("依頼中に委任目的が更新されました。目的を再読込して選び直してください。参照ID: " + requestId);
          }
          if (statusCode === "delegated_task_purpose_unavailable") {
            throw new Error("選択した委任目的は現在利用できません。目的を再読込してください。参照ID: " + requestId);
          }
          throw new Error("/owner/task-compute failed: HTTP " + response.status);
        }
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new Error("/owner/task-compute returned an invalid response");
        }
        return result;
      }

      async function checkOwnerTaskSubmissionStatus() {
        const ownerTokenInput = byId("owner-task-token");
        const button = byId("check-owner-task-status");
        const status = byId("owner-task-status");
        const submissionSelect = byId("owner-task-status-submission-id");
        const ownerToken = ownerTokenInput.value.trim();
        const submissionId = ownerTaskStatusSubmissionId();
        const isCurrentSubmission = submissionId !== null && submissionId === ownerTaskSubmissionIdMemory;
        if (!ownerToken) throw new Error("依頼状態の照会にはowner tokenを入力してください");
        if (!submissionId) throw new Error("照会できるowner task依頼IDがありません");
        const wasSubmissionSelectDisabled = submissionSelect.disabled;
        const selectionChanged = function () { return ownerTaskStatusSubmissionId() !== submissionId; };
        button.disabled = true;
        submissionSelect.disabled = true;
        byId("owner-task-new-submission").hidden = true;
        status.textContent = "依頼ID末尾: " + submissionId.slice(-12) + " のGateway受付記録を照会しています";
        status.className = "badge warn";
        try {
          const result = await postJson("/owner/task-submission-status", ownerToken, { submission_id: submissionId });
          if (selectionChanged()) return;
          if (!result || typeof result !== "object" || Array.isArray(result)) {
            throw new Error("依頼状態の応答形式が不正です");
          }
          if (result.found === false) {
            status.textContent = "依頼ID末尾: " + submissionId.slice(-12) + " の受付記録がありません。これは未送信の証明ではありません。Tasks／RuntimeとGateway状態を確認し、同じ依頼IDを維持してください。";
            status.className = "badge warn";
            if (byId("runtime-token").value.trim()) {
              await loadRuntime("owner-task-status");
              if (selectionChanged()) return;
            }
            return;
          }
          const validRequestId = typeof result.request_id === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.request_id);
          const allowedStates = ["dispatching", "handler_returned", "outcome_unknown", "rejected"];
          if (result.found !== true || !validRequestId || allowedStates.indexOf(result.state) < 0) {
            throw new Error("依頼状態の応答内容が不正です");
          }
          const stateMessage = {
            dispatching: "受付処理中です。新しい依頼を作らず、しばらくして再照会してください。",
            handler_returned: "Gateway handlerは戻りました。仕事の最終結果ではありません。Tasks／Runtimeの同じ依頼IDを確認してください。",
            outcome_unknown: "依頼結果は不明です。再送せず、Tasks／RuntimeとGateway状態を確認してください。",
            rejected: "依頼受付は拒否済みです。現在の委任目的とTasks／Runtimeを確認してください。"
          }[result.state];
          const stateSummary = "依頼ID末尾: " + submissionId.slice(-12) + "。" + stateMessage + " Gateway参照ID末尾: " + result.request_id.slice(-12);
          status.className = result.state === "rejected" ? "badge bad" : "badge warn";
          if (!byId("runtime-token").value.trim()) {
            status.textContent = stateSummary + " Runtime token未入力のためplan照合は未実施です。";
            if (isCurrentSubmission && result.state === "rejected") {
              byId("owner-task-new-submission").hidden = false;
            }
          } else {
            status.textContent = stateSummary + " Runtime planを照合しています。";
            const runtimeSnapshot = await loadRuntime("owner-task-status");
            if (selectionChanged()) return;
            const correlation = await ownerTaskRuntimeCorrelation(result.request_id, runtimeSnapshot);
            if (selectionChanged()) return;
            status.textContent = stateSummary + " " + correlation;
            if (isCurrentSubmission && result.state !== "dispatching") {
              byId("owner-task-new-submission").hidden = false;
            }
          }
        } catch (error) {
          if (selectionChanged()) return;
          throw error;
        } finally {
          if (ownerTokenInput.value.trim() === ownerToken) ownerTokenInput.value = "";
          submissionSelect.disabled = wasSubmissionSelectDisabled;
          button.disabled = false;
        }
      }

      function ownerTaskExecutionEvidenceSummary(requestId, runtimeSnapshot) {
        const execution = isObject(runtimeSnapshot) ? runtimeSnapshot.operation_core_execution : null;
        const safe = isObject(execution) && execution.schema_version === "operation-core.execution.v1" &&
          execution.used_for_authority === false && execution.adapter_result_used_for_authority === false &&
          execution.execution_history_used_for_authority === false && execution.raw_payload_exposed === false &&
          Array.isArray(execution.evidence_source) && execution.evidence_source.length > 0 &&
          execution.evidence_source.every(function (source) { return source === "INTERNAL_STATE"; }) &&
          Array.isArray(execution.latest_results) && Number.isSafeInteger(execution.displayed_count) &&
          execution.displayed_count === execution.latest_results.length && Number.isSafeInteger(execution.entries_count) &&
          execution.entries_count >= execution.displayed_count && Number.isSafeInteger(execution.skipped_count) &&
          execution.skipped_count >= 0 && typeof execution.chain_valid === "boolean";
        if (!safe) return "実行結果の安全な履歴投影は未確認です（結果本文は表示していません）。";
        if (execution.chain_valid !== true) return "実行履歴のhash chainが有効と確認できず、同一依頼の実行結果は未確認です。";

        const requestMatches = execution.latest_results.filter(function (entry) {
          return isObject(entry) && entry.request_id === requestId;
        });
        const matching = requestMatches.filter(function (entry) {
          if (!isObject(entry.command_execution_result)) return false;
          const result = entry.command_execution_result;
          return result.request_id === requestId && result.role === "command_execution_result" &&
            result.version === "operation-core.v1" && result.used_for_authority === false &&
            result.adapter_result_used_for_authority === false && result.plan_step_binding === "unbound" &&
            Array.isArray(result.evidence_source) && result.evidence_source.length === 1 &&
            result.evidence_source[0] === "INTERNAL_STATE" &&
            ["succeeded", "failed", "suspended"].includes(result.state) &&
            ["reported_success", "unknown", "not_attempted", "preview_only"].includes(result.action_outcome) &&
            typeof result.operation === "string" && /^[a-z][a-z0-9._-]{0,159}$/.test(result.operation) &&
            (result.output_digest === undefined || /^[a-f0-9]{64}$/.test(result.output_digest));
        });
        const genericMatching = requestMatches.filter(function (entry) {
          if (!isObject(entry) || matching.includes(entry) || !isObject(entry.operation_core) ||
              entry.operation_core.role !== "execution_result_projection" ||
              entry.operation_core.used_for_authority !== false ||
              entry.operation_core.adapter_result_used_for_authority !== false ||
              entry.operation_core.raw_payload_exposed !== false ||
              !Array.isArray(entry.operation_core.evidence_source) || entry.operation_core.evidence_source.length !== 1 ||
              entry.operation_core.evidence_source[0] !== "INTERNAL_STATE" ||
              !["success", "failed", "suspended", "unknown"].includes(entry.status) ||
              typeof entry.result_present !== "boolean") return false;
          const digestValid = typeof entry.result_digest === "string" && /^[a-f0-9]{64}$/.test(entry.result_digest);
          if ((entry.result_present && !digestValid) || (!entry.result_present && entry.result_digest !== null)) return false;
          const command = isObject(entry.command) ? entry.command : null;
          return !!command && typeof command.operation === "string" &&
            /^[a-z][a-z0-9._-]{0,159}$/.test(command.operation);
        });
        if (matching.length === 0 && genericMatching.length === 0) {
          if (requestMatches.length > 0) return "同一依頼IDの実行履歴はありますが、result projectionの照合条件が成立せず詳細未確認です。";
          const partial = execution.displayed_count < execution.entries_count || execution.skipped_count > 0;
          return partial
            ? "同一依頼IDの実行結果は履歴の最新表示範囲で確認できません。再送や未送信を意味しません。"
            : "同一依頼IDに結び付く実行結果記録はありません。再送や未送信を意味しません。";
        }

        const stateLabels = { succeeded: "下流が成功を報告", failed: "下流が失敗を報告", suspended: "実行停止を報告" };
        const outcomeLabels = {
          reported_success: "成功応答", unknown: "結果不明", not_attempted: "未試行", preview_only: "previewのみ",
        };
        const summaries = matching.slice(0, 3).map(function (entry) {
          const result = entry.command_execution_result;
          const digest = typeof result.output_digest === "string" ? "result digest " + shortDigest(result.output_digest) :
            "result digest未記録";
          return result.operation + "：" + stateLabels[result.state] + "／" + outcomeLabels[result.action_outcome] + "／" + digest;
        });
        const executorStatusLabels = {
          success: "executor成功報告", failed: "executor失敗報告", suspended: "executor停止報告", unknown: "executor状態不明",
        };
        const displayedCommandResultCount = Math.min(matching.length, 3);
        const displayedGenericCount = Math.min(genericMatching.length, Math.max(0, 3 - displayedCommandResultCount));
        genericMatching.slice(0, displayedGenericCount).forEach(function (entry) {
          const digest = entry.result_present ? "executor result digest " + shortDigest(entry.result_digest) : "executor result未記録";
          summaries.push(entry.command.operation + "：" + executorStatusLabels[entry.status] + "／" + digest + "（command result未確認）");
        });
        const otherValidatedCount = matching.length - displayedCommandResultCount + genericMatching.length - displayedGenericCount;
        if (otherValidatedCount > 0) summaries.push("ほか" + String(otherValidatedCount) + "件");
        const unconfirmedCount = requestMatches.length - matching.length - genericMatching.length;
        if (unconfirmedCount > 0) summaries.push("詳細未確認" + String(unconfirmedCount) + "件");
        const partial = execution.displayed_count < execution.entries_count || execution.skipped_count > 0;
        return "同一依頼IDの実行観測（非権威・本文非表示・step未結合）: " + summaries.join("；") +
          (partial ? "。履歴は最新" + String(execution.displayed_count) + "/" + String(execution.entries_count) + "件の表示範囲です。" : "。") +
          " 仕事全体の完了や画面への到達はこの記録だけでは確定しません。";
      }

      function ownerTaskExecutionIntentReceiptSummary(plan, taskIdentityDigest, executionReceipts) {
        if (!isObject(executionReceipts) || executionReceipts.used_for_authority !== false ||
            executionReceipts.execution_eligible !== false || !Array.isArray(executionReceipts.records) ||
            executionReceipts.records.length > 200) {
          return "Gateway execution receipt projectionは利用条件を確認できず、plan bindingとの照合は未確認です。";
        }
        const recordKeys = new Set(["ticket_digest", "command_digest", "execution_epoch_digest", "state", "task_identity_digest",
          "invocation_boundary", "feedback_status", "output_digest", "error_digest", "worker_id_digest", "worker_pid",
          "worker_platform", "worker_task_identity_digest", "worker_operation_plan_binding_digest", "worker_exit_observed",
          "result_delivery_digest", "result_delivery_acknowledged", "result_delivery_disposition", "result_archived_by_epoch_digest"]);
        const states = ["issued", "intent_committed", "invocation_attempted", "adapter_returned", "not_attempted", "outcome_unknown"];
        const boundaries = ["tool_adapter", "channel_adapter", "llm_adapter", "console_preview"];
        const recordsValid = executionReceipts.records.every(function (record) {
          return isObject(record) && Object.keys(record).every(function (key) { return recordKeys.has(key); }) &&
            /^[a-f0-9]{64}$/.test(record.ticket_digest || "") && /^[a-f0-9]{64}$/.test(record.command_digest || "") &&
            /^[a-f0-9]{64}$/.test(record.execution_epoch_digest || "") && states.includes(record.state) &&
            (record.task_identity_digest === undefined || /^[a-f0-9]{64}$/.test(record.task_identity_digest)) &&
            (record.invocation_boundary === undefined || boundaries.includes(record.invocation_boundary)) &&
            (record.feedback_status === undefined || ["success", "failed", "suspended"].includes(record.feedback_status)) &&
            (record.output_digest === undefined || /^[a-f0-9]{64}$/.test(record.output_digest)) &&
            (record.error_digest === undefined || /^[a-f0-9]{64}$/.test(record.error_digest)) &&
            (record.worker_id_digest === undefined || /^[a-f0-9]{64}$/.test(record.worker_id_digest)) &&
            (record.worker_pid === undefined || (Number.isSafeInteger(record.worker_pid) && record.worker_pid > 0)) &&
            (record.worker_platform === undefined || typeof record.worker_platform === "string") &&
            (record.worker_task_identity_digest === undefined || /^[a-f0-9]{64}$/.test(record.worker_task_identity_digest)) &&
            (record.worker_operation_plan_binding_digest === undefined || /^[a-f0-9]{64}$/.test(record.worker_operation_plan_binding_digest)) &&
            (record.worker_exit_observed === true || record.worker_exit_observed === false) &&
            (record.result_delivery_digest === undefined || /^[a-f0-9]{64}$/.test(record.result_delivery_digest)) &&
            (record.result_delivery_acknowledged === undefined || typeof record.result_delivery_acknowledged === "boolean") &&
            (record.result_delivery_disposition === undefined || ["reconciled", "stale_generation_evidence"].includes(record.result_delivery_disposition)) &&
            (record.result_archived_by_epoch_digest === undefined || /^[a-f0-9]{64}$/.test(record.result_archived_by_epoch_digest));
        });
        if (!recordsValid) return "Gateway execution receipt projectionの形式が不正なため、plan bindingとの照合は未確認です。";

        const planBindings = plan.steps.filter(function (step) {
          return isObject(step.binding) && /^[a-f0-9]{64}$/.test(step.binding.command_digest || "");
        }).map(function (step) {
          return { command_digest: step.binding.command_digest,
            execution_ticket_digest: /^[a-f0-9]{64}$/.test(step.binding.execution_ticket_digest || "")
              ? step.binding.execution_ticket_digest : null };
        });
        if (planBindings.length === 0) return "依頼一致planに照合可能なcommand bindingがなく、execution receiptは未確認です。";

        const counts = Object.create(null);
        for (const state of states) counts[state] = 0;
        let unobserved = 0;
        let ambiguous = 0;
        let bindingMismatch = 0;
        const ticketBindings = new Map();
        for (const binding of planBindings) {
          if (binding.execution_ticket_digest === null) { unobserved += 1; continue; }
          ticketBindings.set(binding.execution_ticket_digest, (ticketBindings.get(binding.execution_ticket_digest) || 0) + 1);
        }
        for (const [ticketDigest, bindingCount] of ticketBindings) {
          if (bindingCount !== 1) { ambiguous += 1; continue; }
          const binding = planBindings.find(function (candidate) { return candidate.execution_ticket_digest === ticketDigest; });
          if (!binding) { bindingMismatch += 1; continue; }
          const matches = executionReceipts.records.filter(function (record) {
            return record.ticket_digest === ticketDigest;
          });
          if (matches.length === 0) { unobserved += 1; continue; }
          if (matches.length !== 1) { ambiguous += 1; continue; }
          const receipt = matches[0];
          if (receipt.command_digest !== binding.command_digest || receipt.task_identity_digest !== taskIdentityDigest ||
              (receipt.worker_task_identity_digest !== undefined && receipt.worker_task_identity_digest !== taskIdentityDigest)) {
            bindingMismatch += 1;
            continue;
          }
          counts[receipt.state] += 1;
        }
        const stateLabels = {
          issued: "issued", intent_committed: "intent_committed", invocation_attempted: "invocation_attempted",
          adapter_returned: "adapter_returned", not_attempted: "not_attempted", outcome_unknown: "outcome_unknown",
        };
        const displayedStates = states.filter(function (state) { return counts[state] > 0; })
          .map(function (state) { return stateLabels[state] + " " + String(counts[state]); });
        const details = displayedStates.length > 0 ? displayedStates.join("、") : "一致receiptなし";
        return "Gateway execution intent receipt（ticket digest・command digest・task identity照合、snapshot表示範囲内・非権威）: " + details +
          "、照合不能 " + String(ambiguous) + "、plan binding不一致 " + String(bindingMismatch) + "、表示範囲で未観測 " +
          String(unobserved) + "（未実行の証明ではありません）。";
      }

      function ownerTaskPlanLineageEvidenceSummary(plan, projection, executionReceipts) {
        const taskIdentityDigest = plan.task_identity_digest;
        if (typeof taskIdentityDigest !== "string" || !/^[a-f0-9]{64}$/.test(taskIdentityDigest)) {
          return "一致planに有効なtask identity digestがなく、同一taskの計画系譜とM receipt状態は未確認です。";
        }
        const lineagePlans = projection.plans.filter(function (candidate) {
          return isObject(candidate) && candidate.task_identity_digest === taskIdentityDigest;
        });
        if (lineagePlans.length === 0) {
          return "一致planのtask identityに対応するRuntime計画がなく、M receipt状態は未確認です。";
        }
        if (!Number.isSafeInteger(plan.step_count) || plan.step_count < 0 || !Array.isArray(plan.steps) ||
            !plan.steps.every(function (step) {
              return isObject(step) && typeof step.step_id === "string" && /^[a-f0-9]{64}$/.test(step.step_id) &&
                typeof step.operation === "string" && /^[a-z][a-z0-9._-]{0,159}$/.test(step.operation) &&
                ["not_selected", "selected", "intent_committed", "outcome_unknown", "not_attempted", "verified",
                  "verification_failed", "invalidated"].includes(step.status);
            })) {
          return "一致planのstep projectionが不正なため、M receipt状態は未確認です。";
        }
        if (lineagePlans.some(function (candidate) {
          return typeof candidate.plan_id !== "string" || !/^[a-f0-9]{64}$/.test(candidate.plan_id) ||
            !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 ||
            !["awaiting_step_review", "results_verified"].includes(candidate.status);
        })) {
          return "同一task identityの計画projectionが不正なため、系譜とM receipt状態は未確認です。";
        }

        let receiptConfirmed = 0;
        let memoryCommitPending = 0;
        let notRecorded = 0;
        let bindingNotDisplayed = 0;
        for (const step of plan.steps) {
          if (step.binding === undefined) {
            bindingNotDisplayed += 1;
            continue;
          }
          if (!isObject(step.binding) || !/^[a-f0-9]{64}$/.test(step.binding.command_digest || "") ||
              (step.binding.execution_ticket_digest !== undefined && !/^[a-f0-9]{64}$/.test(step.binding.execution_ticket_digest)) ||
              (step.binding.result_digest !== undefined && !/^[a-f0-9]{64}$/.test(step.binding.result_digest)) ||
              (step.binding.delivery_digest !== undefined && !/^[a-f0-9]{64}$/.test(step.binding.delivery_digest)) ||
              !["not_recorded", "memory_commit_pending", "receipt_confirmed"].includes(step.binding.memory_status)) {
            return "一致planのM receipt projectionが不正なため、状態を表示しません。";
          }
          if (step.binding.memory_status === "receipt_confirmed") receiptConfirmed += 1;
          else if (step.binding.memory_status === "memory_commit_pending") memoryCommitPending += 1;
          else notRecorded += 1;
        }

        const displayed = Number.isSafeInteger(projection.displayed_count) ? projection.displayed_count : null;
        const total = Number.isSafeInteger(projection.plan_count) ? projection.plan_count : null;
        const lineageRangePartial = displayed !== null && total !== null && displayed < total;
        const stepRangePartial = plan.step_count > plan.steps.length;
        const lineageCount = lineagePlans.length + "件" +
          (lineageRangePartial ? "（最新" + String(displayed) + "/" + String(total) + "計画の表示範囲）" : "");
        const stepRange = stepRangePartial ? "、stepは" + String(plan.steps.length) + "/" + String(plan.step_count) + "件の表示範囲" : "";
        const executionReceiptSummary = ownerTaskExecutionIntentReceiptSummary(plan, taskIdentityDigest, executionReceipts);
        return "同一task identityの計画 " + lineageCount + "。" + executionReceiptSummary + " 依頼一致planのM receipt投影: receipt_confirmed " +
          String(receiptConfirmed) + "、memory_commit_pending " + String(memoryCommitPending) + "、not_recorded " +
          String(notRecorded) + "、binding未表示 " + String(bindingNotDisplayed) + stepRange +
          "（非権威表示で、完了や実行権限を示しません）。";
      }

      async function ownerTaskRuntimeCorrelation(requestId, runtimeSnapshot) {
        const executionEvidence = ownerTaskExecutionEvidenceSummary(requestId, runtimeSnapshot);
        const withExecutionEvidence = function (message) { return message + " " + executionEvidence; };
        const projection = isObject(runtimeSnapshot) ? runtimeSnapshot.operation_plan_status : null;
        if (!isObject(projection) || projection.schema_version !== "operation-plan.status.v1" ||
            projection.status !== "available" || projection.used_for_authority !== false ||
            projection.raw_payload_exposed !== false || !Array.isArray(projection.plans)) {
          return withExecutionEvidence("Runtime plan projectionを確認できず、受付状態との対応は未確認です。");
        }
        if (projection.recovery_refresh_status !== "ready") {
          return withExecutionEvidence("Runtimeの復元照合が未完了のため、受付状態とのplan対応は未確認です。");
        }
        if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") {
          return withExecutionEvidence("この画面で依頼IDを照合できず、plan対応は未確認です。");
        }
        let requestDigest;
        try {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("operation-request:" + requestId));
          requestDigest = Array.from(new Uint8Array(digest), function (byte) {
            return byte.toString(16).padStart(2, "0");
          }).join("");
        } catch {
          return withExecutionEvidence("依頼IDのdigest照合に失敗し、plan対応は未確認です。");
        }
        const matchingPlans = projection.plans.filter(function (plan) {
          return isObject(plan) && typeof plan.request_id_digest === "string" &&
            /^[a-f0-9]{64}$/.test(plan.request_id_digest) && plan.request_id_digest === requestDigest;
        });
        if (matchingPlans.length > 1) return withExecutionEvidence("同じ依頼IDに一致するplanが複数あり、対応を確定できません。");
        if (matchingPlans.length === 1) {
          const plan = matchingPlans[0];
          if (typeof plan.plan_id !== "string" || !/^[a-f0-9]{64}$/.test(plan.plan_id) ||
              !Number.isSafeInteger(plan.revision) || plan.revision < 1 ||
              !["awaiting_step_review", "results_verified"].includes(plan.status)) {
            return withExecutionEvidence("一致planの状態projectionが不正なため、対応を確定できません。");
          }
          const planState = plan.status === "results_verified" ? "全stepの結果検証済み表示" : "step審査待ち";
          return withExecutionEvidence("Runtime snapshotで同じ依頼IDの計画 " + shortDigest(plan.plan_id) + " を確認（revision " + String(plan.revision) + "、" +
            planState + "）。" + ownerTaskPlanLineageEvidenceSummary(plan, projection, runtimeSnapshot.execution_receipts) +
            "受付状態とは別で、仕事全体の完了を意味しません。");
        }
        const displayed = Number.isSafeInteger(projection.displayed_count) ? projection.displayed_count : null;
        const total = Number.isSafeInteger(projection.plan_count) ? projection.plan_count : null;
        const limited = displayed !== null && total !== null && displayed < total;
        return withExecutionEvidence(limited
          ? "一致planを表示範囲内で確認できません（" + String(displayed) + "/" + String(total) + "件を表示）。依頼結果は未確定です。"
          : "このRuntime snapshot内に一致planはありません。受付記録だけでは仕事の未作成・完了・失敗を判定できません。");
      }

      async function submitOwnerTask() {
        const ownerTokenInput = byId("owner-task-token");
        const ownerToken = ownerTokenInput.value.trim();
        const task = byId("owner-task-intent").value.trim();
        const goalSelect = byId("owner-task-goal-ref");
        const goalRef = goalSelect.value;
        const purposeVersion = Number(goalSelect.selectedOptions[0]?.dataset.purposeVersion);
        const replyTo = byId("chat-user").value.trim() || "owner";
        const status = byId("owner-task-status");
        if (!ownerToken) throw new Error("owner tokenを入力してください");
        if (!state.chatSocket || state.chatSocket.readyState !== WebSocket.OPEN) {
          throw new Error("返信を受け取るため、WebChatへ接続してから仕事を開始してください");
        }
        if (!task || !goalRef) throw new Error("計画する仕事の内容と現在の委任目的を指定してください");
        if (!Number.isSafeInteger(purposeVersion) || purposeVersion < 2) {
          throw new Error("委任目的を再読み込みして選び直してください");
        }
        const submissionId = pendingOwnerTaskSubmissionId();
        const result = await postOwnerTaskCompute(ownerToken, {
          user: replyTo, task, goal_ref: goalRef, purpose_version: purposeVersion,
          submission_id: submissionId
        });
        clearOwnerTaskSubmissionId();
        renderOwnerTaskStatusSubmissionIds(submissionId);
        ownerTokenInput.value = "";
        byId("owner-task-intent").value = "";
        appendChat("owner", task);
        appendChat("accepted", result.request_id || "HDSへ計画作成を依頼しました", result.request_id);
        status.textContent = result.status === "already_in_progress" || result.status === "already_accepted"
          ? "この依頼は既に受け付け済みです。重複起動していません"
          : "HDSへ依頼済み。計画候補・作用は未承認です";
        status.className = "badge good";
      }

      async function postOperationPlanControl(authToken, content, ownerAuthenticationRequired, planId, revisionDigest) {
        const payload = { user: state.chatUser, content };
        if (ownerAuthenticationRequired) {
          return postJson("/owner/inbound", authToken, { ...payload, plan_id: planId, revision_digest: revisionDigest });
        }
        return postJson("/operators/developer/invoke", authToken, payload);
      }

      async function invokeReceiptReconciliation(planId, revisionDigest, stepId, ownerAuthenticationRequired) {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = ownerAuthenticationRequired ? byId("owner-task-token") : null;
        const authToken = ownerAuthenticationRequired ? ownerTokenInput.value.trim() : state.chatToken;
        if (!authToken) throw new Error(ownerAuthenticationRequired
          ? "結果照合にはowner tokenを入力してください" : "webchat token is required");
        const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
        if (!isDigest(planId) || !isDigest(revisionDigest) || !isDigest(stepId)) {
          throw new Error("current plan and step digests are unavailable");
        }
        const content = "plan:reconcile " + JSON.stringify({ plan_id: planId, revision_digest: revisionDigest, step_id: stepId });
        let result;
        try {
          result = await postOperationPlanControl(authToken, content, ownerAuthenticationRequired, planId, revisionDigest);
        } finally {
          if (ownerTokenInput) ownerTokenInput.value = "";
        }
        appendChat("owner", content);
        appendChat("accepted", result.request_id || "read-only reconciliation accepted", result.request_id);
      }

      async function invokeOperationPlanReview(planId, revisionDigest, stepId, rawGoalPurposeBinding,
        ownerAuthenticationRequired, rawOwnerReauthenticationBinding) {
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = ownerAuthenticationRequired ? byId("owner-task-token") : null;
        const authToken = ownerAuthenticationRequired ? ownerTokenInput.value.trim() : byId("chat-token").value.trim();
        if (!authToken) throw new Error(ownerAuthenticationRequired
          ? "この計画のstep審査にはowner tokenを入力してください"
          : "webchat tokenを入力してください");
        const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
        if (!isDigest(planId) || !isDigest(revisionDigest) || !isDigest(stepId)) {
          throw new Error("current plan and step digests are unavailable");
        }
        const control = { plan_id: planId, revision_digest: revisionDigest, step_id: stepId };
        if (rawGoalPurposeBinding) {
          let binding;
          try { binding = JSON.parse(rawGoalPurposeBinding); } catch (_) { throw new Error("goal-purpose binding is invalid"); }
          if (!isObject(binding) || typeof binding.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(binding.goal_ref) ||
              !Number.isSafeInteger(binding.purpose_version) || binding.purpose_version < 1 || !isDigest(binding.purpose_digest)) {
            throw new Error("goal-purpose binding is invalid");
          }
          control.goal_purpose_binding = { goal_ref: binding.goal_ref, purpose_version: binding.purpose_version,
            purpose_digest: binding.purpose_digest };
        }
        if (rawOwnerReauthenticationBinding) {
          let binding;
          try { binding = JSON.parse(rawOwnerReauthenticationBinding); } catch (_) { throw new Error("owner reauthentication binding is invalid"); }
          if (!isObject(binding) || !isDigest(binding.owner_identity_digest) || !isDigest(binding.channel_identity_digest)) {
            throw new Error("owner reauthentication binding is invalid");
          }
          control.owner_reauthentication = { owner_identity_digest: binding.owner_identity_digest,
            channel_identity_digest: binding.channel_identity_digest };
        }
        const content = "plan:review " + JSON.stringify(control);
        let result;
        try {
          result = await postOperationPlanControl(authToken, content, ownerAuthenticationRequired, planId, revisionDigest);
        } finally {
          if (ownerTokenInput) ownerTokenInput.value = "";
        }
        appendChat("owner", content);
        appendChat("accepted", result.request_id || "J step review request accepted", result.request_id);
      }

      async function invokeOperationPlanResult(planId, revisionDigest, stepId, ownerAuthenticationRequired,
        rawOwnerReauthenticationBinding) {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = ownerAuthenticationRequired ? byId("owner-task-token") : null;
        const authToken = ownerAuthenticationRequired ? ownerTokenInput.value.trim() : state.chatToken;
        if (!authToken) throw new Error(ownerAuthenticationRequired
          ? "保存済み結果の読取にはowner tokenを入力してください"
          : "webchat token is required");
        const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
        if (!isDigest(planId) || !isDigest(revisionDigest) || !isDigest(stepId)) {
          throw new Error("current plan and step digests are unavailable");
        }
        const control = { plan_id: planId, revision_digest: revisionDigest, step_id: stepId };
        if (rawOwnerReauthenticationBinding) {
          let binding;
          try { binding = JSON.parse(rawOwnerReauthenticationBinding); } catch (_) { throw new Error("owner reauthentication binding is invalid"); }
          if (!isObject(binding) || !isDigest(binding.owner_identity_digest) || !isDigest(binding.channel_identity_digest)) {
            throw new Error("owner reauthentication binding is invalid");
          }
          control.owner_reauthentication = { owner_identity_digest: binding.owner_identity_digest,
            channel_identity_digest: binding.channel_identity_digest };
        }
        const content = "plan:result " + JSON.stringify(control);
        let result;
        try {
          result = await postOperationPlanControl(authToken, content, ownerAuthenticationRequired, planId, revisionDigest);
        } finally {
          if (ownerTokenInput) ownerTokenInput.value = "";
        }
        appendChat("owner", content);
        appendChat("accepted", result.request_id || "saved result read request accepted", result.request_id);
      }

      async function invokeOperationPlanReplan(planId, revisionDigest, stepId, rawGoalPurposeBinding, ownerSelectedFileState, recoveryEdit, rawExplicitFileEdit, selectedGmailMessageIdentityDigest) {
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = byId("owner-task-token");
        const ownerToken = ownerTokenInput.value.trim();
        if (!ownerToken) throw new Error("同一taskの再計画にはowner tokenを入力してください");
        if ((ownerSelectedFileState && recoveryEdit) || (selectedGmailMessageIdentityDigest &&
            (ownerSelectedFileState || recoveryEdit || rawExplicitFileEdit !== undefined || !/^[a-f0-9]{64}$/.test(selectedGmailMessageIdentityDigest)))) {
          throw new Error("同時に選択できないsource observationまたはmessage identityです");
        }
        let explicitFileEditTask = "";
        if (rawExplicitFileEdit !== undefined) {
          if (ownerSelectedFileState || recoveryEdit || !isObject(rawExplicitFileEdit)) {
            throw new Error("明示編集候補の入力が無効です");
          }
          const filePath = typeof rawExplicitFileEdit.path === "string" ? rawExplicitFileEdit.path.trim() : "";
          const editSearch = typeof rawExplicitFileEdit.search === "string" ? rawExplicitFileEdit.search : "";
          const editReplace = typeof rawExplicitFileEdit.replace === "string" ? rawExplicitFileEdit.replace : "";
          const expectedReplacements = rawExplicitFileEdit.expectedReplacements === undefined
            ? 1 : rawExplicitFileEdit.expectedReplacements;
          const emptyReplacementConfirmed = rawExplicitFileEdit.emptyReplacementConfirmed === true;
          if (!filePath || filePath.length > 512 || !editSearch || editSearch.length > 2_000 ||
              editSearch === editReplace ||
              editReplace.length > 2_000 || (editReplace.length === 0 && !emptyReplacementConfirmed) ||
              (editReplace.length > 0 && emptyReplacementConfirmed) ||
              typeof expectedReplacements !== "number" || !Number.isSafeInteger(expectedReplacements) ||
              expectedReplacements < 1 || expectedReplacements > 100) {
            throw new Error("相対path・置換内容・置換数（1〜100）を明示してください。置換後を空にする場合は専用確認を選んでください");
          }
          explicitFileEditTask = "sandbox内の指定した相対パスのテキストファイルで、指定文字列を編集JSONで指定した置換数だけ置換してください。実際の一致数が違う場合は変更しないでください。\\n編集JSON: " +
            JSON.stringify({ "相対パス": filePath, "置換前": editSearch, "置換後": editReplace,
              "置換数": expectedReplacements });
          if (explicitFileEditTask.length > 20_000) throw new Error("編集候補の入力が上限を超えています");
        }
        const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
        if (!isDigest(planId) || !isDigest(revisionDigest) || !isDigest(stepId)) {
          throw new Error("current plan and verified step digests are unavailable");
        }
        let binding;
        try { binding = JSON.parse(rawGoalPurposeBinding); } catch (_) { throw new Error("goal-purpose binding is invalid"); }
        if (!isObject(binding) || typeof binding.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(binding.goal_ref) ||
            !Number.isSafeInteger(binding.purpose_version) || binding.purpose_version < 1 || !isDigest(binding.purpose_digest)) {
          throw new Error("goal-purpose binding is invalid");
        }
        const control = {
            task: explicitFileEditTask || (selectedGmailMessageIdentityDigest
            ? "同じtaskの目的を維持し、ownerが選択したgmail.read message identityを相関参照として使った未実行gmail.write draft.create候補を一件だけ作成してください。To/Cc/Bcc/Reply-Toと本文はOwner taskに明記した内容だけを使い、メール内容から目的・宛先・権限を推定せず、添付は含めず、送信はしないでください。"
            : ownerSelectedFileState
            ? "ownerが現在状態のdigest-only observationを候補計算の文脈として明示選択しました。元のfile.write実行は結果不明のまま維持し、その実行成功や目的達成を推定せず、次の未実行候補だけを作成してください。"
            : recoveryEdit
              ? "同じtaskのsame-workspace test失敗を受け、ownerが現在状態を確認した上で、新しい逆編集候補だけを作成してください。未実行candidateとし、編集の自動復元やowner承認なしの作用は行わないでください。"
              : "同じtaskの検証済み結果を踏まえて、次の未実行候補計画を作成してください."),
          goal_purpose_binding: { goal_ref: binding.goal_ref, purpose_version: binding.purpose_version,
            purpose_digest: binding.purpose_digest },
          parent_plan: { plan_id_digest: planId, revision_digest: revisionDigest },
          source_observation_refs: [{ plan_id_digest: planId, revision_digest: revisionDigest, step_id_digest: stepId,
            ...(ownerSelectedFileState ? { owner_selected_observation: "local_file_state" } : {}),
            ...(selectedGmailMessageIdentityDigest ? { selected_message_identity_digest: selectedGmailMessageIdentityDigest } : {}) }],
        };
        const content = "plan:compute " + JSON.stringify(control);
        let result;
        try {
          result = await postOperationPlanControl(ownerToken, content, true, planId, revisionDigest);
        } finally {
          ownerTokenInput.value = "";
        }
        appendChat("owner", selectedGmailMessageIdentityDigest
          ? "Ownerが選択したGmail message identity digestだけを同一taskの下書き候補計算へ渡しました。メール本文・宛先claimは渡さず、draft.create候補のみを依頼しました。"
          : ownerSelectedFileState
          ? "ownerが現在状態の観測を候補計算へ明示選択しました（元の作用結果は不明のまま）"
          : recoveryEdit
            ? "test失敗後の現在状態をもとに、未実行の逆編集候補を依頼しました"
            : explicitFileEditTask
              ? "ownerが相対pathと置換内容を明示した同一taskの未実行file.edit候補を依頼しました"
              : "同一taskの検証済み結果に基づく再計画を依頼しました");
        appendChat("accepted", result.request_id || "HDSへ未実行の次候補計画を依頼しました", result.request_id);
      }

      async function invokeOperationPlanWait(planId, revisionDigest, hours) {
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = byId("owner-task-token");
        const ownerToken = ownerTokenInput.value.trim();
        if (!ownerToken) throw new Error("返信待機の登録にはowner tokenを入力してください");
        if (typeof planId !== "string" || !/^[a-f0-9]{64}$/.test(planId) ||
            typeof revisionDigest !== "string" || !/^[a-f0-9]{64}$/.test(revisionDigest)) {
          throw new Error("現在のplan revisionを確認できません");
        }
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error("返信期限は1から168時間で指定してください");
        }
        const control = { plan_id: planId, revision_digest: revisionDigest,
          deadline_at_ms: Date.now() + hours * 60 * 60 * 1000 };
        const content = "plan:wait " + JSON.stringify(control);
        let result;
        try {
          result = await postJson("/operators/developer/invoke", ownerToken, { user: state.chatUser, content });
        } finally {
          ownerTokenInput.value = "";
        }
        appendChat("owner", content);
        appendChat("accepted", result.request_id || "同一planの返信待機を登録しました", result.request_id);
      }

      async function replyToOperationPlanWait(planId, revisionDigest, content) {
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = byId("owner-task-token");
        const ownerToken = ownerTokenInput.value.trim();
        if (!ownerToken) throw new Error("待機中の仕事へ返信するにはowner tokenを入力してください");
        if (typeof planId !== "string" || !/^[a-f0-9]{64}$/.test(planId) ||
            typeof revisionDigest !== "string" || !/^[a-f0-9]{64}$/.test(revisionDigest)) {
          throw new Error("返信先のplan revisionを確認できません");
        }
        if (typeof content !== "string" || content.trim().length === 0 || content.length > 200000) {
          throw new Error("200000文字以内の返信を入力してください");
        }
        let result;
        try {
          result = await postJson("/owner/inbound", ownerToken, { user: state.chatUser,
            content: content.trim(), plan_id: planId, revision_digest: revisionDigest });
        } finally {
          ownerTokenInput.value = "";
        }
        appendChat("owner", content.trim());
        appendChat("accepted", result.request_id || "同じplanの再計画をHDSへ依頼しました", result.request_id);
      }

      async function invokeInterruptedOperationPlanWait(waitId, response, ownerAuthenticationRequired,
        rawOwnerReauthenticationBinding) {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        const ownerTokenInput = ownerAuthenticationRequired ? byId("owner-task-token") : null;
        const authToken = ownerAuthenticationRequired ? ownerTokenInput.value.trim() : state.chatToken;
        if (!authToken) throw new Error(ownerAuthenticationRequired
          ? "待機の再開にはowner tokenを入力してください"
          : "webchat token is required");
        if (typeof waitId !== "string" || !/^[a-f0-9]{64}$/.test(waitId)) {
          throw new Error("interrupted wait identity is unavailable");
        }
        if (typeof response !== "string" || response.trim().length === 0 || response.length > 200000) {
          throw new Error("enter a new response of at most 200000 characters");
        }
        const control = { wait_id: waitId, response: response.trim() };
        if (rawOwnerReauthenticationBinding) {
          let binding;
          try { binding = JSON.parse(rawOwnerReauthenticationBinding); } catch (_) { throw new Error("owner reauthentication binding is invalid"); }
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          if (!isObject(binding) || !isDigest(binding.owner_identity_digest) || !isDigest(binding.channel_identity_digest)) {
            throw new Error("owner reauthentication binding is invalid");
          }
          control.owner_reauthentication = { owner_identity_digest: binding.owner_identity_digest,
            channel_identity_digest: binding.channel_identity_digest };
        }
        const content = "plan:resume_wait " + JSON.stringify(control);
        let result;
        try {
          result = await postJson("/operators/developer/invoke", authToken, { user: state.chatUser, content });
        } finally {
          if (ownerTokenInput) ownerTokenInput.value = "";
        }
        appendChat("owner", "復旧した待機へ新しい返信を送信しました。");
        appendChat("accepted", result.request_id || "interrupted wait recovery request accepted", result.request_id);
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
                  ["time zone", item.time_zone || "host local", false],
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

      function renderDevelopmentHandoffInbox(operatorSurfaces) {
        const developer = isObject(operatorSurfaces) && isObject(operatorSurfaces.developer)
          ? operatorSurfaces.developer : {};
        const inbox = isObject(developer.development_handoff_inbox)
          ? developer.development_handoff_inbox : null;
        if (!inbox) {
          setText("development-handoff-status", "not available");
          setText("development-handoff-json", "Developer handoff inbox is not connected.");
          return;
        }
        const items = Array.isArray(inbox.items) ? inbox.items : [];
        const tone = inbox.status === "unavailable" ? "bad" : items.length > 0 ? "warn" : "good";
        setText("development-handoff-status", String(inbox.status || "unknown") + " / " + items.length + " pending");
        byId("development-handoff-status").className = "badge " + tone;
        setText("development-handoff-json", compactJson({
          status: inbox.status,
          count: items.length,
          items: items.map(function (item) {
            const candidate = isObject(item.candidate) ? item.candidate : {};
            return {
              handoff_id: item.handoff_id,
              source_record_digest: item.source_record_digest,
              source_signature_digest: item.source_signature_digest,
              source_derivation_digest: item.source_derivation_digest,
              source_state: item.source_state,
              development_status: item.development_status,
              candidate_proposals: {
                cause_hypotheses: candidate.cause_hypotheses,
                alternative_hypotheses: candidate.alternative_hypotheses,
                observation_error_hypotheses: candidate.observation_error_hypotheses,
                scope_assessment: candidate.scope_assessment,
                counterexamples: candidate.counterexamples,
                resume_conditions: candidate.resume_conditions,
                additional_observations: candidate.additional_observations,
              },
              may_promote_version: item.may_promote_version,
              used_for_authority: item.used_for_authority,
              may_execute: item.may_execute,
            };
          }),
          boundary: "candidate-only; development review required; no automatic code/P promotion or execution",
        }));
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
          if (isObject(observation) && observation.schema_version === "operation-plan-compute-source-observation.v1" &&
              observation.source === "owner_selected_gmail_message_identity" && observation.operation === "gmail.read" &&
              observation.plan_binding_status === "verified" && observation.plan_validation_status === "owner_selected_identity" &&
              /^[a-f0-9]{64}$/.test(observation.source_result_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.delivery_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.message_identity_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.owner_selection_digest || "") &&
              Number.isSafeInteger(observation.observed_at_ms) && Number.isSafeInteger(observation.expires_at_ms) &&
              observation.expires_at_ms === observation.observed_at_ms + 600000 &&
              observation.effect_observation === "identity_reference_only" &&
              observation.used_as_world_truth === false && observation.used_for_authority === false &&
              observation.may_execute === false && observation.adoption_status === "observation_only") {
            const nowMs = Date.now();
            const current = observation.observed_at_ms <= nowMs && nowMs < observation.expires_at_ms;
            return "gmail.read：Owner選択済みidentity digest=" + shortDigest(observation.message_identity_digest) +
              "（" + (current ? "期限内" : "期限切れ・Jはstep選択と実行を拒否") +
              "、本文・header claim・権限・実行可能性を含まない）";
          }
          if (isObject(observation) && observation.schema_version === "operation-plan-compute-source-observation.v1" &&
              observation.source === "owner_selected_local_file_state" && observation.operation === "file.write" &&
              /^[a-f0-9]{64}$/.test(observation.plan_id_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.revision_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.step_id_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.command_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.execution_admission_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.gateway_execution_receipt_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.gateway_execution_epoch_digest || "") &&
              ["issued", "intent_committed", "invocation_attempted", "adapter_returned", "not_attempted", "outcome_unknown"].includes(observation.gateway_execution_receipt_state) &&
              /^[a-f0-9]{64}$/.test(observation.observation_digest || "") &&
              observation.plan_binding_status === "outcome_unknown" &&
              observation.plan_validation_status === "owner_selected_observation" &&
              observation.observation_status === "matched" && observation.effect_observation === "observed_target_state" &&
              observation.used_as_world_truth === false && observation.used_for_authority === false && observation.may_execute === false &&
              observation.adoption_status === "observation_only" &&
              Number.isSafeInteger(observation.memory_revision) && observation.memory_revision > 0 &&
              /^[a-f0-9]{64}$/.test(observation.memory_receipt_digest || "") &&
              /^[a-f0-9]{64}$/.test(observation.owner_selection_digest || "")) {
            return "Gateway実行receipt=" + observation.gateway_execution_receipt_state + "（digest照合済み）とowner選択のfile.write現在状態digestのみ。元stepはoutcome_unknown、作成主体・成功・目的達成は未確認";
          }
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
        const waitCards = (Array.isArray(projection.waits) ? projection.waits : []).map(function (wait) {
          if (!isObject(wait) || !/^[a-f0-9]{64}$/.test(wait.wait_id || "") ||
              !/^[a-f0-9]{64}$/.test(wait.plan_id || "") || !/^[a-f0-9]{64}$/.test(wait.task_identity_digest || "") ||
              !/^[a-f0-9]{64}$/.test(wait.revision_digest || "") ||
              wait.used_for_authority !== false || wait.may_execute !== false ||
              !Number.isSafeInteger(wait.deadline_at_ms) || !["waiting", "resumed"].includes(wait.state)) return "";
          if (wait.recovery_hold_reason !== undefined &&
              !["held_residual", "held_unobserved", "held_unverified"].includes(wait.recovery_hold_reason)) return "";
          const outcomeLabels = {
            not_started: "返信／期限待機中",
            pending: "J再開済み・C結果未記録",
            interrupted: "C計算中断・新しい返信が必要",
            candidate_retained: "計画候補をJ台帳へ保存（採用・実行未許可）",
            candidate_rejected: "C候補はJへ保存されず",
            failed: "C計算失敗",
            not_recorded: "再開結果未記録",
          };
          if (!Object.prototype.hasOwnProperty.call(outcomeLabels, wait.compute_outcome)) return "";
          const resultDigest = wait.compute_result_digest;
          const candidateDigest = wait.candidate_plan_id;
          const resourceUse = wait.compute_resource_use;
          if ((resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(resultDigest)) ||
              (candidateDigest !== undefined && !/^[a-f0-9]{64}$/.test(candidateDigest)) ||
              (wait.compute_outcome === "interrupted" && !Number.isSafeInteger(wait.compute_interrupted_at_ms)) ||
              (wait.compute_outcome !== "interrupted" && wait.compute_interrupted_at_ms !== undefined) ||
              typeof wait.resource_review_required !== "boolean" ||
              (resourceUse !== undefined && (!isObject(resourceUse) ||
                !Number.isSafeInteger(resourceUse.charged_compute_ms) || resourceUse.charged_compute_ms < 0 ||
                !Number.isSafeInteger(resourceUse.charged_tokens) || resourceUse.charged_tokens < 0 ||
                !Number.isFinite(resourceUse.charged_cost_amount) || resourceUse.charged_cost_amount < 0 ||
                !/^[A-Z]{3}$/.test(resourceUse.currency || "") || resourceUse.used_for_authority !== false ||
                resourceUse.may_execute !== false))) return "";
          const wakeReason = wait.wake_reason === "reply" ? "返信" : wait.wake_reason === "deadline" ? "期限"
            : wait.wake_reason === "recovery" ? "ownerの新しい返信" : "未記録";
          const recoveryHoldLabels = {
            held_residual: "復元残差あり（wait再開停止中）",
            held_unobserved: "復元依存未観測（wait再開停止中）",
            held_unverified: "復元履歴未確認（wait再開停止中）",
          };
          const recoveryHold = Object.prototype.hasOwnProperty.call(recoveryHoldLabels, wait.recovery_hold_reason)
            ? recoveryHoldLabels[wait.recovery_hold_reason] : null;
          const deadlineDate = new Date(wait.deadline_at_ms);
          const deadline = Number.isNaN(deadlineDate.getTime())
            ? String(wait.deadline_at_ms) + " ms" : deadlineDate.toISOString();
          const recoveryInput = wait.compute_outcome === "interrupted" && !recoveryHold
            ? '<label>復旧後の新しい返信<textarea data-operation-plan-resume-input="true" maxlength="200000"></textarea></label>' +
              '<button type="button" class="secondary" data-operation-plan-resume-wait="true" data-wait-id="' +
              escapeHtml(wait.wait_id) + '" data-owner-authentication-required="' +
              String(wait.owner_authentication_required === true) + '" data-owner-reauthentication-binding="' +
              escapeHtml(isObject(wait.owner_reauthentication_binding) ? JSON.stringify(wait.owner_reauthentication_binding) : '') +
              '">新しい返信を送って候補計算を再開</button>' +
              '<p class="muted">以前の返信本文は保存されていません。ownerの新しい入力だけで候補計算を行います。' +
              (isObject(wait.owner_reauthentication_binding) ? '別入口のwaitはowner tokenを再入力し、元owner・channelを照合します。' : '') + '</p>'
            : '';
          const replyInput = wait.state === "waiting" && wait.owner_authentication_required === true &&
            !isObject(wait.owner_reauthentication_binding)
            ? '<label>同じ仕事への返信<textarea data-operation-plan-wait-reply-input="true" maxlength="200000"></textarea></label>' +
              '<button type="button" class="secondary" data-operation-plan-wait-reply="true" data-plan-id="' +
              escapeHtml(wait.plan_id) + '" data-revision-digest="' + escapeHtml(wait.revision_digest) + '">この仕事へ返信して再計画</button>' +
              '<p class="muted">owner tokenで送信します。plan／revision／owner／channelが一致するwaitだけが再開し、返信本文はJ状態へ保存しません。</p>'
            : '';
          return '<article class="trace-item"><div class="row"><h3>返信／期限wait ' +
            escapeHtml(shortDigest(wait.wait_id)) + '</h3>' + badge(recoveryHold || outcomeLabels[wait.compute_outcome], "review") + '</div>' +
            '<dl class="kv"><dt>task digest</dt><dd class="mono">' + escapeHtml(shortDigest(wait.task_identity_digest)) +
            '</dd><dt>元計画digest</dt><dd class="mono">' + escapeHtml(shortDigest(wait.plan_id)) +
            '</dd><dt>期限</dt><dd>' + escapeHtml(deadline) + '</dd>' +
            (wait.state === "resumed" ? '<dt>再開理由</dt><dd>' + escapeHtml(wakeReason) + '</dd>' : '') +
            (resourceUse ? '<dt>C資源消費</dt><dd>' + escapeHtml(String(resourceUse.charged_compute_ms) + ' ms / ' +
              String(resourceUse.charged_tokens) + ' tokens (' + resourceUse.tokens_usage_status + ') / ' +
              String(resourceUse.charged_cost_amount) + ' ' + resourceUse.currency + ' (' +
              resourceUse.cost_status + ', ' + resourceUse.charge_basis + ')') + '</dd>' : '') +
            (resultDigest ? '<dt>C結果digest</dt><dd class="mono">' + escapeHtml(shortDigest(resultDigest)) + '</dd>' : '') +
            (candidateDigest ? '<dt>保存候補digest</dt><dd class="mono">' + escapeHtml(shortDigest(candidateDigest)) + '</dd>' : '') +
            '</dl><p class="muted">' + (recoveryHold
              ? '復元hold中のため、このwaitからの期限起動と候補計算を停止しています。状態表示は権限ではありません。' +
                '残差を確認し、続ける場合は新しい依頼から新規計画を作成してください。'
              : wait.resource_review_required
              ? '計画候補の保存に至らず資源消費がありました。次のJ再検討で進捗を確認します。'
              : 'J状態の観測です。計画の採用、M更新、作用の実行許可を意味しません。') + '</p>' + replyInput + recoveryInput + '</article>';
        }).join("");
        if (projection.plans.length === 0) {
          setHtml("operation-plan-state-list", refreshNotice + goalPurposeGuide + waitCards +
            '<div class="trace-item muted">現在表示できるJ計画はありません。</div>');
          return;
        }
        setHtml("operation-plan-state-list", refreshNotice + goalPurposeGuide + waitCards + projection.plans.map(function (plan) {
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
          const purposeReviewBindingStatus = plan.goal_purpose_binding_status ?? (purposeBinding ? "current" : "not_configured");
          const purposeRelationAllowsStepReview = purposeBinding
            ? purposeRelation?.status === "owner_reviewed_supports"
            : !purposeRelation || purposeRelation.status === "not_required";
          const planReviewReady = !refreshPending && !recoveryHold && reconciliationPlanReady &&
            plan.status === "awaiting_step_review" && ["not_configured", "current"].includes(purposeReviewBindingStatus) &&
            purposeRelationAllowsStepReview;
          const waitRegistrationReady = !refreshPending && !recoveryHold && reconciliationPlanReady &&
            plan.status === "results_verified" && ["not_configured", "current"].includes(purposeReviewBindingStatus) &&
            plan.owner_authentication_required === true &&
            !isObject(plan.owner_reauthentication_binding);
          const waitRegistrationActions = waitRegistrationReady
            ? '<section class="approval-content-review"><label>返信期限（時間）<input type="number" min="1" max="168" step="1" value="24" data-operation-plan-wait-hours="true"></label> ' +
              '<button type="button" class="secondary" data-operation-plan-wait="true" data-plan-id="' +
              escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) + '">この仕事の返信を待つ</button>' +
              '<p class="muted">期限内の返信はこのplan revisionに相関します。返信の採用・作用は新しいJ判断とowner審査を要します。</p></section>'
            : '';
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
          const sameWorkspaceEditTestPlan = steps.length === 3 && steps[0]?.operation === "file.edit" &&
            steps[1]?.operation === "shell.exec" && steps[2]?.operation === "file.search";
          const shellTestStep = sameWorkspaceEditTestPlan ? steps[1] : null;
          const shellTestSummary = isObject(shellTestStep?.shell_exec_summary) ? shellTestStep.shell_exec_summary : null;
          const shellTestTimedOut = !!shellTestStep && shellTestStep.status === "verified" && !!shellTestSummary &&
            shellTestSummary.signal === "timeout" && shellTestSummary.timed_out === true &&
            shellTestSummary.process_tree_empty === true;
          const shellTestNonzeroExit = !!shellTestStep && shellTestStep.status === "verified" && !!shellTestSummary &&
            Number.isSafeInteger(shellTestSummary.exit_code) && shellTestSummary.exit_code > 0 &&
            shellTestSummary.signal === null && shellTestSummary.timed_out === false && shellTestSummary.process_tree_empty === true;
          const sameWorkspaceTestRequiresRecovery = shellTestTimedOut || shellTestNonzeroExit;
          return '<article class="trace-item">' +
            '<div class="row"><h3>計画 ' + escapeHtml(shortDigest(plan.plan_id)) + '</h3><span>' + badge("revision " + String(plan.revision), "review") + '</span></div>' +
            '<dl class="kv"><dt>計画digest</dt><dd class="mono">' + escapeHtml(shortDigest(plan.revision_digest)) + '</dd>' +
            '<dt>task digest</dt><dd class="mono">' + escapeHtml(shortDigest(plan.task_identity_digest)) + '</dd>' +
            '<dt>計画状態</dt><dd>' + badge(plan.status || "unknown", operationPlanStatusTone(plan.status)) + '</dd>' +
            (recoveryHold ? '<dt>復元後の選択</dt><dd>' + escapeHtml(recoveryHold) + '</dd>' +
              '<dt>復元scopeとの関係</dt><dd>' + escapeHtml(recoveryScopeRelation) + '</dd>' : '') +
            purposeBindingLabel + purposeRelationLabel +
            renderComputeSourceObservations(plan.compute_source_observations) +
            '<dt>step数</dt><dd>' + escapeHtml(String(plan.step_count ?? steps.length)) + '</dd></dl>' +
            (recoveryHold ? '<p class="muted">この計画のstep選択は停止中です。復元scopeとの関係表示はplan単位の復元やhold解除を意味しません。状態を確認後に続ける場合は、新しい依頼から新規計画を作成してください。</p>' : '') +
            purposeRelationReviewActions + waitRegistrationActions +
            steps.map(function (step, stepIndex) {
              const previousStep = stepIndex > 0 ? steps[stepIndex - 1] : null;
              const isEditVerificationCandidate = step.operation === "file.search" && previousStep?.operation === "file.edit" &&
                Array.isArray(step.preparation?.depends_on) && step.preparation.depends_on.includes(previousStep.step_id);
              const stepTitle = isEditVerificationCandidate ? "編集後確認候補（file.search）" : step.operation || "operation";
              const binding = isObject(step.binding) ? step.binding : {};
              const unknown = step.status === "outcome_unknown";
              const shellSummary = isObject(step.shell_exec_summary) ? step.shell_exec_summary : null;
              const shellExitCode = shellSummary && Number.isSafeInteger(shellSummary.exit_code) ? shellSummary.exit_code : null;
              const shellCompletedSuccessfully = shellExitCode === 0 && shellSummary?.signal === null &&
                shellSummary.timed_out === false && shellSummary.process_tree_empty === true;
              const shellCompletedWithNonzeroExit = shellExitCode !== null && shellExitCode > 0 && shellSummary?.signal === null &&
                shellSummary.timed_out === false && shellSummary.process_tree_empty === true;
              const shellCompletedWithTimeout = shellSummary?.signal === "timeout" && shellSummary.timed_out === true &&
                shellSummary.process_tree_empty === true;
              const shellSummaryDetails = shellSummary
                ? '<dt>同一Workspace test</dt><dd>' + escapeHtml(shellCompletedSuccessfully
                  ? '終了コード0（test実行結果の構造を確認済み）'
                  : shellCompletedWithNonzeroExit ? '失敗（終了コード' + String(shellExitCode) + '）'
                    : shellCompletedWithTimeout ? 'timeout（process tree終了確認済み。作用結果は要確認）'
                    : '結果不明（timeout／中断／終了コードなし）') + '</dd>'
                : '';
              const reconciliationStepReady = reconciliationPlanReady && typeof step.step_id === "string" && /^[a-f0-9]{64}$/.test(step.step_id);
              const savedResultReady = !refreshPending && !recoveryHold && reconciliationStepReady &&
                ["file.search", "file.edit", "file.write", "file.delete"].includes(step.operation) && step.status === "verified" &&
                binding.memory_status === "receipt_confirmed" && /^[a-f0-9]{64}$/.test(binding.command_digest || "") &&
                /^[a-f0-9]{64}$/.test(binding.result_digest || "") && /^[a-f0-9]{64}$/.test(binding.delivery_digest || "");
              const savedResultButton = savedResultReady
                ? '<button type="button" class="secondary" data-operation-plan-result="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) +
                  '" data-step-id="' + escapeHtml(step.step_id) + '" data-owner-authentication-required="' +
                  String(plan.owner_authentication_required === true) + '" data-owner-reauthentication-binding="' +
                  escapeHtml(isObject(plan.owner_reauthentication_binding) ? JSON.stringify(plan.owner_reauthentication_binding) : '') +
                  '">' + (step.operation === "file.edit" ? "保存済み編集結果を読む"
                    : step.operation === "file.write" ? "保存済み作成結果を読む"
                      : step.operation === "file.delete" ? "保存済み削除結果を読む" : "保存済み検索結果／限定previewを読む") + '</button>' +
                  '<p class="muted">' + (step.operation === "file.edit"
                    ? "J/M receipt確認済みの編集結果を表示します。変更後の内容や差分は再読込しません。"
                    : step.operation === "file.write"
                      ? "J/M receipt確認済みの作成結果要約を表示します。本文は返さず、現在のファイル状態も再読込しません。"
                      : step.operation === "file.delete"
                        ? "J/M receipt確認済みの削除時点の報告を表示します。現在の対象不存在は再確認しません。"
                        : "J/M receipt確認済みの保存結果を表示します。指定条件によっては指定開始行から最大5行のfile.read previewを返します。保存時点の観測であり、全内容・検索完全性・現在状態を示しません。") +
                  (isObject(plan.owner_reauthentication_binding) ? '別入口の計画ではowner tokenを再入力し、元owner・channelを照合します。' : '') + '</p>'
                : '';
              const replanSourceReady = !refreshPending && !recoveryHold && reconciliationStepReady &&
                plan.owner_authentication_required === true && purposeBinding && purposeReviewBindingStatus === "current" &&
                ["file.write", "file.edit", "file.delete", "file.search"].includes(step.operation) &&
                step.status === "verified" && binding.memory_status === "receipt_confirmed" &&
                /^[a-f0-9]{64}$/.test(binding.command_digest || "") && /^[a-f0-9]{64}$/.test(binding.result_digest || "") &&
                /^[a-f0-9]{64}$/.test(binding.delivery_digest || "");
              const localFileState = isObject(step.local_file_state_observation) ? step.local_file_state_observation : {};
              const ownerSelectedFileStateReady = !refreshPending && !recoveryHold && reconciliationStepReady &&
                plan.owner_authentication_required === true && purposeBinding && purposeReviewBindingStatus === "current" &&
                step.operation === "file.write" && step.status === "outcome_unknown" &&
                localFileState.source === "local_file_state" && localFileState.status === "matched" &&
                /^[a-f0-9]{64}$/.test(localFileState.gateway_execution_receipt_digest || "") &&
                /^[a-f0-9]{64}$/.test(localFileState.gateway_execution_epoch_digest || "") &&
                ["issued", "intent_committed", "invocation_attempted", "adapter_returned", "not_attempted", "outcome_unknown"].includes(localFileState.gateway_execution_receipt_state) &&
                localFileState.memory_status === "receipt_confirmed" && localFileState.used_for_authority === false &&
                localFileState.raw_receipt_exposed === false && /^[a-f0-9]{64}$/.test(localFileState.evidence_digest || "") &&
                /^[a-f0-9]{64}$/.test(localFileState.target_identity_digest || "");
              const explicitFileEditGroup = replanSourceReady && step.operation === "file.search"
                ? '<fieldset><legend>この結果に続くfile.edit候補（任意）</legend>' +
                  '<label>sandbox相対path<input type="text" data-operation-plan-edit-path="' + escapeHtml(step.step_id) +
                  '" maxlength="512" aria-label="編集対象のsandbox相対path"></label>' +
                  '<label>置換前の完全一致文字列<textarea data-operation-plan-edit-search="' + escapeHtml(step.step_id) +
                  '" maxlength="2000" rows="2" aria-label="置換前の完全一致文字列"></textarea></label>' +
                  '<label>置換後の文字列<textarea data-operation-plan-edit-replace="' + escapeHtml(step.step_id) +
                  '" maxlength="2000" rows="2" aria-label="置換後の文字列"></textarea></label>' +
                  '<label>置換数（1〜100）<input type="number" min="1" max="100" step="1" value="1" data-operation-plan-edit-count="' +
                  escapeHtml(step.step_id) + '" aria-label="完全一致する置換数"></label>' +
                  '<label><input type="checkbox" data-operation-plan-edit-empty-replacement="' + escapeHtml(step.step_id) +
                  '">置換後を空にする（対象文字列の削除）</label>' +
                  '<button type="button" class="secondary" data-operation-plan-explicit-file-edit="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) +
                  '" data-step-id="' + escapeHtml(step.step_id) + '" data-goal-purpose-binding="' +
                  escapeHtml(JSON.stringify({ goal_ref: purposeBinding.goal_ref,
                    purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest })) +
                  '">明示した内容で未実行file.edit候補を作成</button>' +
                  '<p class="muted">保存済み検索結果本文は自動添付しません。対象path・置換内容・一致する置換数を明示してください。実際の一致数が指定と違えば候補は実行時に拒否されます。候補は未実行で、実差分確認・L3 Approval・Broker判定が別途必要です。</p></fieldset>'
                : '';
              const replanButton = replanSourceReady || ownerSelectedFileStateReady
                ? '<button type="button" class="secondary" data-operation-plan-replan="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) +
                  '" data-step-id="' + escapeHtml(step.step_id) + '" data-goal-purpose-binding="' +
                  escapeHtml(JSON.stringify({ goal_ref: purposeBinding.goal_ref,
                    purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest })) +
                  '" data-owner-selected-file-state="' + String(ownerSelectedFileStateReady) + '">' +
                  (ownerSelectedFileStateReady ? '現在状態を明示選択して候補を再計算' : '検証済み結果から同一taskを再計画') + '</button>' +
                  '<p class="muted">' + (ownerSelectedFileStateReady
                    ? 'Gatewayの永続実行receiptをJのcommand／epoch／taskへ再照合し、digest-onlyの現在状態をownerがC候補の文脈として選びます。元のfile.writeは結果不明のままです。次候補は未実行で、選択後もJのstep審査と必要なowner Approval／Broker判定が必要です。'
                    : '現在のM receiptを持つ結果だけを参照します。次候補は未実行で、実行には新しいJ step審査とowner Approval／Broker判定が必要です。') + '</p>' +
                  explicitFileEditGroup
                : '';
              const gmailIdentityOptions = Array.isArray(step.gmail_message_identity_options)
                ? step.gmail_message_identity_options : [];
              const gmailDraftCandidateActions = !refreshPending && !recoveryHold && reconciliationStepReady &&
                plan.owner_authentication_required === true && purposeBinding && purposeReviewBindingStatus === "current" &&
                step.operation === "gmail.read" && step.status === "verified" && gmailIdentityOptions.length > 0
                ? '<fieldset><legend>Owner選択message identityから下書き候補</legend>' +
                  '<p class="muted">表示番号は直前のgmail.read結果と対応します。mailboxと人間ownerの関係は未確認です。本文、header、宛先claim、添付、raw IDはCやこのprojectionへ出しません。選択は同一taskの相関だけを結び、送信せず、draft.create候補だけを作ります。</p>' +
                  gmailIdentityOptions.map(function (option) {
                    if (!isObject(option) || !/^[a-f0-9]{64}$/.test(option.message_identity_digest || "") ||
                        !Number.isSafeInteger(option.display_index) || option.display_index < 1 ||
                        option.mailbox_owner_relationship !== "not_verified" ||
                        option.message_headers_are_untrusted !== true || option.used_for_authority !== false ||
                        option.may_execute !== false || !Number.isSafeInteger(option.expires_at_ms) || Date.now() >= option.expires_at_ms) return "";
                    const label = "message " + option.display_index + " · identity " + shortDigest(option.message_identity_digest);
                    return '<button type="button" class="secondary" data-operation-plan-gmail-draft="true" data-selected-gmail-message-identity="' +
                      escapeHtml(option.message_identity_digest) + '" data-plan-id="' + escapeHtml(plan.plan_id) +
                      '" data-revision-digest="' + escapeHtml(plan.revision_digest) + '" data-step-id="' +
                      escapeHtml(step.step_id) + '" data-goal-purpose-binding="' +
                      escapeHtml(JSON.stringify({ goal_ref: purposeBinding.goal_ref,
                        purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest })) +
                      '">' + escapeHtml(label) + ' を選択してdraft.create候補を作成</button>';
                  }).join("") + '</fieldset>'
                : '';
              const recoveryEditReady = !refreshPending && !recoveryHold && reconciliationStepReady &&
                plan.owner_authentication_required === true && purposeBinding && purposeReviewBindingStatus === "current" &&
                sameWorkspaceTestRequiresRecovery && step === steps[2] && step.operation === "file.search" && step.status === "verified" &&
                binding.memory_status === "receipt_confirmed" && /^[a-f0-9]{64}$/.test(binding.command_digest || "") &&
                /^[a-f0-9]{64}$/.test(binding.result_digest || "") && /^[a-f0-9]{64}$/.test(binding.delivery_digest || "");
              const recoveryEditButton = recoveryEditReady
                ? '<button type="button" class="secondary" data-operation-plan-replan="true" data-recovery-edit="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) +
                  '" data-step-id="' + escapeHtml(step.step_id) + '" data-goal-purpose-binding="' +
                  escapeHtml(JSON.stringify({ goal_ref: purposeBinding.goal_ref,
                    purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest })) +
                  '">失敗／timeout後の逆編集候補を作成</button><p class="muted">timeout後は作用が一部反映済みの可能性があります。保存済みfile.search結果で現在内容を確認してください。候補生成は編集しません。新しいfile.editのContent Reviewで実差分と現行版を再確認し、別途L3 Approvalを通るまで作用しません。</p>'
                : '';
              const receiptLabels = {
                not_applicable: "対象外",
                not_recorded: "Jに外部receipt観測未記録",
                matched: "local inspectionの1件がcommand/payload digest一致（成功・目標達成は未確認）",
                not_found: "local inspectionに一致なし（未送信の証明ではありません）",
                mismatch: "local inspectionのreceipt digest不一致（結果不明を維持）",
                ambiguous: "local inspectionに複数候補（結果不明を維持）",
              };
              const receiptValue = Object.prototype.hasOwnProperty.call(receiptLabels, step.external_receipt_observation)
                ? receiptLabels[step.external_receipt_observation] : "観測状態を確認できません";
              const externalReceipt = isObject(step.external_receipt) ? step.external_receipt : {};
              const externalReceiptSafe = ["local_inspection", "google_calendar_read"].includes(externalReceipt.source) &&
                externalReceipt.used_for_authority === false && externalReceipt.raw_receipt_exposed === false &&
                typeof externalReceipt.evidence_digest === "string" && /^[a-f0-9]{64}$/.test(externalReceipt.evidence_digest) &&
                Number.isInteger(externalReceipt.match_count) && externalReceipt.match_count >= 0 && externalReceipt.match_count <= 100 &&
                Number.isSafeInteger(externalReceipt.observed_at_ms) && externalReceipt.observed_at_ms >= 0 &&
                (externalReceipt.receipt_digest === undefined || (typeof externalReceipt.receipt_digest === "string" && /^[a-f0-9]{64}$/.test(externalReceipt.receipt_digest))) &&
                step.external_receipt_observation !== "not_recorded";
              const googleCalendarReceiptSafe = externalReceiptSafe && externalReceipt.source === "google_calendar_read" &&
                step.operation === "google.calendar.write" &&
                ["event.create", "event.update", "event.delete", "event.invite"].includes(externalReceipt.provider_operation) &&
                ((step.external_receipt_observation === "not_found" && externalReceipt.provider_http_status === 404) ||
                  (["matched", "mismatch"].includes(step.external_receipt_observation) && externalReceipt.provider_http_status === 200));
              const receipt = googleCalendarReceiptSafe
                ? step.external_receipt_observation === "matched"
                  ? externalReceipt.provider_operation === "event.update"
                    ? "Google Calendarの現在件名が要求値と一致（この操作が変更したことは未確認）"
                    : externalReceipt.provider_operation === "event.delete"
                      ? "Google Calendarの対象イベントは現在cancelled（この操作が削除したことは未確認）"
                      : externalReceipt.provider_operation === "event.invite"
                        ? "Google Calendarの現在参加者一覧に要求宛先を確認（招待メール到達は未確認）"
                        : "Google Calendarの対象イベントが要求状態と一致（この操作が作成したことは未確認）"
                  : step.external_receipt_observation === "not_found"
                    ? "Google Calendarが404を返しました（不存在と閲覧不能は区別できず、結果不明を維持）"
                    : "Google Calendarの現在状態が要求と一致しません（結果不明を維持）"
                : receiptValue;
              const externalReceiptDetails = externalReceiptSafe
                ? '<dt>観測source</dt><dd>' + (googleCalendarReceiptSafe ? 'Google Calendar特定event読取' : 'local inspection（合成）') + '</dd>' +
                  (googleCalendarReceiptSafe ? '<dt>読取対象操作</dt><dd>' + escapeHtml(externalReceipt.provider_operation) +
                    '</dd><dt>provider HTTP</dt><dd>' + escapeHtml(String(externalReceipt.provider_http_status)) + '</dd>' : '') +
                  '<dt>観測evidence digest</dt><dd class="mono">' +
                  escapeHtml(shortDigest(externalReceipt.evidence_digest)) + '</dd><dt>候補件数</dt><dd>' +
                  escapeHtml(String(externalReceipt.match_count)) + '</dd>' +
                  (externalReceipt.receipt_digest ? '<dt>receipt digest</dt><dd class="mono">' + escapeHtml(shortDigest(externalReceipt.receipt_digest)) + '</dd>' : '')
                : '';
              const calendarNewTaskButton = unknown && googleCalendarReceiptSafe &&
                ["event.create", "event.invite"].includes(externalReceipt.provider_operation)
                ? '<button type="button" class="secondary" data-operation-plan-calendar-new-task="true" data-calendar-operation="' +
                  escapeHtml(externalReceipt.provider_operation) + '">別のowner taskとして続ける</button>' +
                  '<p class="muted">このplanは結果不明のままです。下のボタンは別taskの入力欄を準備するだけで、送信もCalendar作用も行いません。</p>'
                : '';
              const localFileStateSafe = localFileState.source === "local_file_state" &&
                ["matched", "not_found", "mismatch"].includes(String(localFileState.status)) &&
                Number.isInteger(localFileState.match_count) && localFileState.match_count >= 0 && localFileState.match_count <= 1 &&
                typeof localFileState.evidence_digest === "string" && /^[a-f0-9]{64}$/.test(localFileState.evidence_digest) &&
                typeof localFileState.target_identity_digest === "string" && /^[a-f0-9]{64}$/.test(localFileState.target_identity_digest) &&
                Number.isSafeInteger(localFileState.observed_at_ms) && localFileState.observed_at_ms >= 0 &&
                localFileState.used_for_authority === false && localFileState.raw_receipt_exposed === false;
              const localFileStateLabels = {
                matched: "現在の対象payload digestが要求と一致（作成主体・実行成功は未確認）",
                not_found: "現在の対象なし（作用が未実行だった証明ではありません）",
                mismatch: "現在の対象payload digestは要求と不一致（結果不明を維持）",
              };
              const localFileStateDetails = localFileStateSafe
                ? '<dt>file.write現在状態</dt><dd>' + escapeHtml(localFileStateLabels[localFileState.status] || "観測状態不明") +
                  '</dd><dt>target identity digest</dt><dd class="mono">' + escapeHtml(shortDigest(localFileState.target_identity_digest)) +
                  '</dd><dt>file state digest</dt><dd class="mono">' + escapeHtml(shortDigest(localFileState.file_state_digest)) +
                  '</dd><dt>観測M receipt</dt><dd>' + escapeHtml(localFileState.memory_status || "not_recorded") +
                  '</dd><dt>観測evidence digest</dt><dd class="mono">' + escapeHtml(shortDigest(localFileState.evidence_digest)) + '</dd>'
                : '';
              const stepReviewButton = planReviewReady && step.status === "not_selected" &&
                typeof step.step_id === "string" && /^[a-f0-9]{64}$/.test(step.step_id)
                ? '<button type="button" class="secondary" data-operation-plan-review="true" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) +
                  '" data-step-id="' + escapeHtml(step.step_id) + '" data-goal-purpose-binding="' +
                  escapeHtml(purposeBinding ? JSON.stringify({ goal_ref: purposeBinding.goal_ref,
                    purpose_version: purposeBinding.purpose_version, purpose_digest: purposeBinding.purpose_digest }) : '') +
                  '" data-owner-reauthentication-binding="' +
                  escapeHtml(isObject(plan.owner_reauthentication_binding) ? JSON.stringify(plan.owner_reauthentication_binding) : '') +
                  '" data-owner-authentication-required="' + String(plan.owner_authentication_required === true) +
                  '">Jでstep審査を開始</button><p class="muted">' +
                  (plan.owner_authentication_required === true
                    ? (isObject(plan.owner_reauthentication_binding)
                      ? '別入口で作成された計画です。step審査ではTasks欄へowner tokenを再入力し、Jが元のowner・channel・revisionを照合します。必要なL3はApproval待ちです。'
                      : 'この計画はowner tokenで開始されています。step審査にもTasks欄へowner tokenを入力してください。Jが現在のrevision・依存・対象を再確認し、必要なL3はApproval待ちです。')
                    : 'Jが現在のrevision・依存・対象を再確認します。L1/L2はowner設定により実行へ進む場合があり、L3はApproval待ちです。') + '</p>'
                : '';
              return '<div class="trace-item"><div class="row"><h4>' + escapeHtml(stepTitle) + '</h4>' +
                badge(unknown ? "結果不明" : step.status || "unknown", operationPlanStatusTone(step.status)) + '</div>' +
                '<dl class="kv"><dt>step digest</dt><dd class="mono">' + escapeHtml(shortDigest(step.step_id)) + '</dd>' +
                '<dt>command digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.command_digest)) + '</dd>' +
                '<dt>実行結果digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.result_digest)) + '</dd>' +
                '<dt>J配送digest</dt><dd class="mono">' + escapeHtml(shortDigest(binding.delivery_digest)) + '</dd>' +
                '<dt>receipt照合</dt><dd>' + escapeHtml(receipt) + '</dd>' + shellSummaryDetails + externalReceiptDetails + localFileStateDetails + '</dl>' +
                 (unknown ? '<p class="muted">外部作用の結果は未確認です。照合はDeveloper入口から明示要求した場合だけ対象の読取を1回行います。event.create／event.update／event.delete／event.inviteは再実行しません。招待メールの配信結果はCalendar読取では確認できません。</p>' : '') +
                (unknown && reconciliationStepReady ? '<button type="button" class="secondary" data-operation-plan-reconcile="true" data-owner-authentication-required="' +
                  String(plan.owner_authentication_required === true) + '" data-plan-id="' +
                  escapeHtml(plan.plan_id) + '" data-revision-digest="' + escapeHtml(plan.revision_digest) + '" data-step-id="' +
                   escapeHtml(step.step_id) + '">' + (step.operation === "google.calendar.write" ? 'Google Calendarを読取照合' : 'loopbackで読取照合') + '</button>' : '') +
                 calendarNewTaskButton +
                savedResultButton +
                replanButton +
                gmailDraftCandidateActions +
                recoveryEditButton +
                stepReviewButton +
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
        renderDevelopmentHandoffInbox(body.operator_surfaces);
        renderOperationCoreExecution(body.operation_core_execution);
        renderOperationPlanStatus(body.operation_plan_status);
        const mascotState = aotanuStateFromRuntime(body);
        renderAotanuMascot(mascotState, aotanuDisplayLabelFromRuntime(body, mascotState));
      }

      function renderApprovals(body) {
        const pending = Array.isArray(body.pending_approvals) ? body.pending_approvals : Array.isArray(body.pending) ? body.pending : [];
        const previousContentDigests = state.approvalContentDigests;
        const refreshedContentDigests = Object.create(null);
        for (const item of pending) {
          if (!isObject(item) || item.content_review_required === true || typeof item.command_id !== "string") continue;
          const digest = previousContentDigests[item.command_id];
          if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) refreshedContentDigests[item.command_id] = digest;
        }
        state.approvalContentDigests = refreshedContentDigests;
        const grants = Array.isArray(body.grants) ? body.grants : [];
        const approvalHistory = Array.isArray(body.approval_history) ? body.approval_history : [];
        const activeExecutions = Array.isArray(body.active_executions) ? body.active_executions : [];
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
        const emergencyStopActive = Boolean(emergencyStop && emergencyStop.active);
        const emergencyStopStatus = emergencyStopActive
          ? emergencyStop.audit_recovery_status === "pending" ? "active · audit pending"
            : emergencyStop.audit_recovery_status === "state_unavailable" ? "active · state unavailable" : "active"
          : "clear";
        setText("approval-emergency-status", emergencyStopStatus);
        byId("approval-emergency-status").className = "badge " + (emergencyStopActive ? "bad" : "good");
        setText("approval-grant-count", grants.length);
        setText("approval-history-count", approvalHistory.length);
        setText("active-execution-count", activeExecutions.length);
        state.approvalTokens = Object.create(null);
        renderApprovalGrants(grants);
        renderApprovalHistory(approvalHistory);
        renderActiveExecutions(activeExecutions);

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
              const purposeSource = goalPurposeReview && isObject(goalPurposeReview.source_skeptical_review)
                ? goalPurposeReview.source_skeptical_review : null;
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
                    (purposeSource ? '<dt>C review digest</dt><dd class="mono">' + escapeHtml(purposeSource.review_digest) + '</dd>' +
                      '<dt>conflict criteria</dt><dd>' + escapeHtml(Array.isArray(purposeSource.conflicting_criterion_ref_digests)
                        ? purposeSource.conflicting_criterion_ref_digests.length : 0) + '</dd>' : '') +
                    '<dt>content review</dt><dd>' + escapeHtml(goalPurposeReview.review_status || "required") + '</dd>' +
                    '</dl><p class="muted">The exact purpose text is held in memory until this approval ends and is revealed only after selecting Review exact purpose. An attached C review is unverified and grants no authority.</p></section>'
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
                       meaningUpdateReview ? '候補本文を確認' : item.operation === 'tool.file.edit' ? '変更差分を確認' :
                         item.operation === 'tool.file.delete' ? '削除対象を確認' : 'Review exact content') +
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

      function renderActiveExecutions(executions) {
        const visible = executions.filter(function (item) {
          return isObject(item) && typeof item.command_id === "string" &&
            item.command_id.length > 0 && item.command_id.length <= 200 &&
            Number.isSafeInteger(item.started_at_ms) &&
            (item.cancel_requested_at_ms === null || Number.isSafeInteger(item.cancel_requested_at_ms)) &&
            typeof item.execution_signal_aborted === "boolean" &&
            (item.executor_state === "running" || item.executor_state === "cancel_requested") &&
            ["not_observed", "worker_exit_observed", "process_tree_empty_confirmed", "provider_state_unknown"]
              .includes(item.local_worker_stop) &&
            item.external_processing_stop === "unknown" && item.used_for_authority === false;
        });
        if (visible.length === 0) {
          setHtml("active-executions-list", '<div class="queue-item muted">no active executions</div>');
          return;
        }
        setHtml("active-executions-list", visible.map(function (item) {
          const cancelRequested = item.cancel_requested_at_ms !== null;
          const signalState = item.execution_signal_aborted ? "aborted" : "active";
          return '<article class="queue-item" data-active-command="' + escapeHtml(item.command_id) + '">' +
            '<div class="row"><h3>Command ' + escapeHtml(item.command_id) + '</h3>' +
            badge(cancelRequested ? "Cancel requested" : "Running", cancelRequested ? "warn" : "good") + '</div>' +
            '<dl class="kv">' +
            '<dt>started</dt><dd>' + escapeHtml(formatDate(item.started_at_ms)) + '</dd>' +
            '<dt>Executor</dt><dd>' + escapeHtml(item.executor_state) + '</dd>' +
            '<dt>execution signal</dt><dd>' + escapeHtml(signalState) + '</dd>' +
            '<dt>local worker</dt><dd>' + escapeHtml(item.local_worker_stop) + '</dd>' +
            '<dt>external processing stop</dt><dd>unknown</dd>' +
            '</dl>' +
            '<button class="danger" data-cancel-execution="' + escapeHtml(item.command_id) + '"' +
              (cancelRequested ? ' disabled' : '') + '>Cancel task</button>' +
            '</article>';
        }).join(""));
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

      function renderSettingsComputeReadiness(readiness) {
        const known = isObject(readiness) && ["ready", "blocked"].includes(readiness.status) &&
          readiness.current_window_usage_checked === false && Array.isArray(readiness.evidence_source) &&
          readiness.evidence_source.length === 1 && readiness.evidence_source[0] === "CONFIG";
        const status = known ? readiness.status : "unknown";
        const detail = known && typeof readiness.detail === "string" ? readiness.detail : "設定の判定結果を確認できません。Verify LLMを実行してください。";
        setText("settings-compute-readiness", "通常Computeの設定: " + status + ". " + detail +
          " 設定からの判定です。現在の予算消費は各仕事の実行時に照合します。");
        byId("settings-compute-readiness").className = "badge " + (status === "ready" ? "good" : "warn");
        return status;
      }

      function invalidateSettingsComputeReadiness() {
        setText("settings-compute-readiness", "LLMまたは予算設定が変わりました。Verify LLMで通常Computeの設定を再確認してください。");
        byId("settings-compute-readiness").className = "badge warn";
        setText("settings-verify-status", "設定変更・再確認が必要");
        byId("settings-verify-status").className = "badge warn";
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
        byId("settings-timeout-ms").value = llm.timeout_ms ?? "";
        byId("settings-provider-cost-profiles").value = llm.provider_cost_profiles_json || "";
        byId("settings-compute-budget-policy").value = llm.compute_budget_policy_json || "";
        renderSettingsComputeReadiness(llm.compute_readiness);
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
        if (!observation || observation.operation !== "restore") return "未観測";
        if (observation.store_key === "m_state") {
          const restoreDigest = observation.restore_backup_id_digest ?? null;
          const taskRestorePoints = observation.task_memory_restore_points;
          if (restoreDigest !== null && (typeof restoreDigest !== "string" || !/^[a-f0-9]{64}$/.test(restoreDigest))) {
            return "未確認（表示を抑止）";
          }
          const digestLabel = restoreDigest ? "復元元M backup digest " + restoreDigest.slice(0, 12) : "復元元M backup digest 未記録";
          if (taskRestorePoints === null || taskRestorePoints === undefined) {
            return digestLabel + "・task別M復元点: 未観測\\n表示は復元・承認・実行権限ではありません。保留解除はHDSの現行判定に従います。";
          }
          if (!restoreDigest || !Array.isArray(taskRestorePoints) || taskRestorePoints.length > 64) {
            return "未確認（表示を抑止）";
          }
          if (taskRestorePoints.length === 0) {
            return digestLabel + "・task別M復元点: 対象taskなし\\n表示は復元・承認・実行権限ではありません。保留解除はHDSの現行判定に従います。";
          }
          const dependencyLabels = {
            observed: "観測範囲内",
            residuals_present: "残差あり",
            unobserved: "未観測あり",
            unknown: "未確認",
          };
          const taskSeen = new Set();
          const planSeen = new Set();
          const rows = [];
          for (const point of taskRestorePoints) {
            if (!point || typeof point !== "object" || typeof point.task_identity_digest !== "string" ||
                !/^[a-f0-9]{64}$/.test(point.task_identity_digest) || taskSeen.has(point.task_identity_digest) ||
                !Object.prototype.hasOwnProperty.call(dependencyLabels, point.dependency_status) ||
                !Array.isArray(point.plan_id_digests) || point.plan_id_digests.length === 0 ||
                point.plan_id_digests.length > 64 || point.plan_id_digests.some((planIdDigest) =>
                  typeof planIdDigest !== "string" || !/^[a-f0-9]{64}$/.test(planIdDigest) || planSeen.has(planIdDigest)) ||
                new Set(point.plan_id_digests).size !== point.plan_id_digests.length) {
              return "未確認（表示を抑止）";
            }
            taskSeen.add(point.task_identity_digest);
            for (const planIdDigest of point.plan_id_digests) planSeen.add(planIdDigest);
            rows.push("タスクdigest " + point.task_identity_digest.slice(0, 12) + "・同一backup内plan数 " +
              point.plan_id_digests.length + "・M依存: " + dependencyLabels[point.dependency_status]);
          }
          return digestLabel + "・task別M復元点: 読取検査\\n" + rows.join("\\n") +
            "\\n表示は復元・承認・実行権限ではありません。保留解除はHDSの現行判定に従います。";
        }
        if (observation.store_key !== "operation_plans" ||
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

      function formatRecoveryExecutionArchiveEvidence(evidence, boundaryValid, planCorrelations, omittedPlanCorrelationCount) {
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
          const correlationInventoryValid = Array.isArray(planCorrelations) && Number.isSafeInteger(omittedPlanCorrelationCount) && omittedPlanCorrelationCount >= 0;
          const related = correlationInventoryValid
            ? planCorrelations.filter(function (correlation) { return correlation.command_key_digest === command; })
            : [];
          const planRelation = !correlationInventoryValid
            ? " / Operation Plan関連: 未確認"
            : omittedPlanCorrelationCount === 0 && related.length === 1 && related[0].binding_integrity === "verified" &&
            related[0].broker_correlation === "matched"
            ? " / Operation Plan " + related[0].plan_id_digest.slice(0, 12) + " / step " + related[0].step_id_digest.slice(0, 12) +
              " / J状態 " + related[0].status
            : omittedPlanCorrelationCount !== 0
              ? " / Operation Plan関連: 表示上限により完全照合未成立"
              : related.length > 1
                ? " / Operation Plan関連: 複数一致のため未確定"
                : related.length === 1
                  ? " / Operation Plan関連: bindingまたはBroker相関未確定"
                  : " / Operation Plan関連: 該当bindingなし";
          rows.push("ticket " + ticket.slice(0, 12) + " / command " + command.slice(0, 12) +
            " / 旧epoch " + priorEpoch.slice(0, 12) + " / 隔離先epoch " + archivedByEpoch.slice(0, 12) +
            " / 結果digest " + delivery.slice(0, 12) + planRelation);
        }
        let summary = rows.length === 0
          ? "検証済みBroker記録内に旧世代結果の隔離証拠はありません。"
          : "旧世代結果の隔離証拠（raw結果なし・digestのみ）\\n" + rows.join("\\n");
        if (evidence.omitted_record_count > 0) summary += "\\nBroker記録の検査上限による省略: " + evidence.omitted_record_count + "件";
        return summary + "\\n読み取り専用です。command-key関連付けはownerの調査補助であり、旧receiptによるJ/M更新・承認・再実行を行いません。現行対象の状態を独立に確認してください。";
      }

      function projectRecoveryUnboundExecutionEvidence(value) {
        const unavailable = {
          status: "not_verified",
          outcome_unknown_count: null,
          result_delivery_pending_count: null,
          omitted_record_count: null,
          records: []
        };
        const unverified = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        if (unverified.status === "not_verified") {
          return unverified.outcome_unknown_count === null && unverified.result_delivery_pending_count === null &&
            unverified.omitted_record_count === null && Array.isArray(unverified.records) && unverified.records.length === 0
            ? unavailable
            : null;
        }
        if (unverified.status !== "available" || !Array.isArray(unverified.records) || unverified.records.length > 200 ||
            !Number.isSafeInteger(unverified.outcome_unknown_count) || unverified.outcome_unknown_count < 0 ||
            !Number.isSafeInteger(unverified.result_delivery_pending_count) || unverified.result_delivery_pending_count < 0 ||
            !Number.isSafeInteger(unverified.omitted_record_count) || unverified.omitted_record_count < 0) return null;
        const seenTickets = new Set();
        const records = [];
        let outcomeUnknownCount = 0;
        let resultDeliveryPendingCount = 0;
        for (const item of unverified.records) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const ticket = recoveryInspectionDigest(item.ticket_digest);
          const command = recoveryInspectionDigest(item.command_key_digest);
          const state = recoveryInspectionEnum(item.state, ["intent_committed", "invocation_attempted", "outcome_unknown", "adapter_returned"]);
          const deliveryPending = item.result_delivery_pending;
          const delivery = item.result_delivery_digest === null ? null : recoveryInspectionDigest(item.result_delivery_digest);
          const stateUnknown = ["intent_committed", "invocation_attempted", "outcome_unknown"].includes(state);
          if (!ticket || !command || state === "unknown" || typeof deliveryPending !== "boolean" ||
              (item.result_delivery_digest !== null && !delivery) || (deliveryPending && !delivery) ||
              (!stateUnknown && !deliveryPending) || seenTickets.has(ticket)) return null;
          seenTickets.add(ticket);
          if (stateUnknown) outcomeUnknownCount++;
          if (deliveryPending) resultDeliveryPendingCount++;
          records.push({ ticket_digest: ticket, command_key_digest: command, state: state,
            result_delivery_pending: deliveryPending, result_delivery_digest: delivery });
        }
        if (outcomeUnknownCount !== unverified.outcome_unknown_count || resultDeliveryPendingCount !== unverified.result_delivery_pending_count) return null;
        return { status: "available", outcome_unknown_count: outcomeUnknownCount,
          result_delivery_pending_count: resultDeliveryPendingCount,
          omitted_record_count: unverified.omitted_record_count, records: records };
      }

      function formatRecoveryUnboundExecutionEvidence(evidence, boundaryValid) {
        const unverified = "未束縛Broker未決receipt: 未確認（Broker／Operation Plan台帳の完全照合が成立していません）";
        if (boundaryValid !== true || !evidence || typeof evidence !== "object" || Array.isArray(evidence)) return unverified;
        if (evidence.status === "not_verified") return unverified + "\\n読み取り専用です。再送・承認復元・状態変更を行いません。";
        if (evidence.status !== "available" || !Array.isArray(evidence.records)) return unverified;
        const rows = evidence.records.map(function (item) {
          return "ticket " + item.ticket_digest.slice(0, 12) + " / command " + item.command_key_digest.slice(0, 12) +
            " / 状態 " + item.state + (item.result_delivery_pending
              ? " / J・Mへの結果受領待ち" + (item.result_delivery_digest ? " (digest " + item.result_delivery_digest.slice(0, 12) + ")" : "")
              : " / 結果未確定");
        });
        let summary = "Operation Plan未束縛・未決receipt: " + rows.length + "件 / 結果不明 " +
          evidence.outcome_unknown_count + "件 / J・M配送待ち " + evidence.result_delivery_pending_count + "件（分類は重複する場合があります）";
        if (rows.length > 0) summary += "\\n" + rows.join("\\n");
        else if (evidence.omitted_record_count === 0) summary += "\\n照合済み範囲に未決receiptはありません。";
        if (evidence.omitted_record_count > 0) summary += "\\nBrokerの表示上限による省略: " + evidence.omitted_record_count + "件（全台帳での不在は断定しません）";
        summary += "\\n結果不明は成功・失敗へ推定せず、自動再送・承認復元・状態変更を行いません。";
        return summary;
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
        const unboundExecutionEvidence = projectRecoveryUnboundExecutionEvidence(source.unbound_execution_evidence);
        const schemaResidualSource = Array.isArray(source.operation_plan_schema_residuals) ? source.operation_plan_schema_residuals : null;
        const schemaResidualReferences = new Set();
        let schemaResidualsValid = schemaResidualSource !== null && schemaResidualSource.length <= 64;
        const operationPlanSchemaResiduals = (schemaResidualSource || []).slice(0, 64).map(function (item) {
          const value = item && typeof item === "object" ? item : {};
          const planIdDigest = value.plan_id_digest === null ? null : recoveryInspectionDigest(value.plan_id_digest);
          const recordDigest = recoveryInspectionDigest(value.record_digest);
          if ((value.plan_id_digest !== null && !planIdDigest) || !recordDigest || schemaResidualReferences.has(recordDigest)) {
            schemaResidualsValid = false;
            return null;
          }
          schemaResidualReferences.add(recordDigest);
          return { plan_id_digest: planIdDigest, record_digest: recordDigest };
        }).filter(function (item) { return item !== null; });
        if (operationPlanSchemaResiduals.length !== (schemaResidualSource || []).length) schemaResidualsValid = false;
        const omittedOperationPlanSchemaResidualCount = recoveryInspectionCount(source.omitted_operation_plan_schema_residual_count);
        const initialBoundaryOk = source.schema_version === 13 && source.surface === "recovery_inspection_operator" && source.mode === "read_only" && source.used_for_authority === false && source.may_execute === false && source.boundary_valid === true && executionArchiveEvidence !== null && unboundExecutionEvidence !== null && cronSummaryValid && cronLedgerStatus === cronStatus && source.cron_event_residual_count === cronResidualCount && documentCheckpointSummaryValid && documentCheckpointLedgerStatus === documentCheckpointStatus && source.document_organization_checkpoint_residual_count === documentCheckpointResidualCount && cronApprovalCorrelationResidualCount !== null && schemaResidualsValid && omittedOperationPlanSchemaResidualCount === 0;
        const ledgerStatuses = {
          j: recoveryInspectionLedgerStatus(ledgers.j, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          m: recoveryInspectionLedgerStatus(ledgers.m, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          broker: recoveryInspectionLedgerStatus(ledgers.broker, ["verified", "projection_mismatch", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          operation_plans: recoveryInspectionLedgerStatus(ledgers.operation_plans, ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"]),
          cron_events: cronLedgerStatus,
          document_organization_checkpoints: documentCheckpointLedgerStatus
        };
        const operationPlanSchemaResidualsConsistent =
          (operationPlanSchemaResiduals.length === 0 || ledgerStatuses.operation_plans === "residuals_present") &&
          operationPlanSchemaResiduals.every(function (residual) {
            return residual.plan_id_digest === null || planDependencyScopes.some(function (scope) {
              return scope.plan_id_digest === residual.plan_id_digest && scope.status === "residuals_present" &&
                scope.residual_dependencies.indexOf("operation_plan") >= 0;
            });
          });
        const unboundEvidenceConsistent = unboundExecutionEvidence !== null &&
          (unboundExecutionEvidence.status !== "available" ||
            (ledgerStatuses.broker === "verified" && ledgerStatuses.operation_plans === "verified" &&
              source.omitted_operation_plan_correlation_count === 0 && source.omitted_plan_dependency_scope_count === 0));
        const planCorrelations = Array.isArray(source.operation_plan_correlations)
          ? source.operation_plan_correlations.slice(0, 200).map(function (item) {
              const value = item && typeof item === "object" ? item : {};
              const planIdDigest = recoveryInspectionDigest(value.plan_id_digest);
              const stepIdDigest = recoveryInspectionDigest(value.step_id_digest);
              const commandIdDigest = recoveryInspectionDigest(value.command_id_digest);
              const commandKeyDigest = value.command_key_digest === null ? null : recoveryInspectionDigest(value.command_key_digest);
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
              if (!planIdDigest || !stepIdDigest || !commandIdDigest || (value.command_key_digest !== null && !commandKeyDigest) || (value.admission_digest !== null && !admissionDigest) || (value.memory_update_id_digest !== null && !memoryUpdateIdDigest) || bindingStatus === "unknown" || bindingIntegrity === "unknown" || brokerCorrelation === "unknown" || deliveryCorrelation === "unknown" || memoryCorrelation === "unknown" || cronApprovalCorrelation === "unknown" || cronEventCorrelation === "unknown" || (value.cron_event_delivery_state !== null && cronEventDeliveryState === "unknown") || ((cronEventCorrelation === "matched") !== (cronEventDeliveryState !== null))) return null;
              return {
                plan_id_digest: planIdDigest,
                step_id_digest: stepIdDigest,
                command_id_digest: commandIdDigest,
                command_key_digest: commandKeyDigest,
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
        const boundaryOk = initialBoundaryOk && operationPlanSchemaResidualsConsistent && unboundEvidenceConsistent && planDependencyScopesValid && requestScopeCorrelationValid;
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
          unbound_execution_evidence: boundaryOk ? unboundExecutionEvidence : {
            status: "not_verified", outcome_unknown_count: null, result_delivery_pending_count: null,
            omitted_record_count: null, records: []
          },
          operation_plan_residual_count: recoveryInspectionCount(source.operation_plan_residual_count),
          operation_plan_schema_residuals: boundaryOk ? operationPlanSchemaResiduals : [],
          omitted_operation_plan_schema_residual_count: boundaryOk ? 0 : omittedOperationPlanSchemaResidualCount,
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
          boundaryOk,
          projection.operation_plan_correlations,
          projection.omitted_operation_plan_correlation_count
        ));
        setText("recovery-unbound-execution-evidence", formatRecoveryUnboundExecutionEvidence(
          projection.unbound_execution_evidence,
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
          max_tokens: byId("settings-max-tokens").value,
          timeout_ms: byId("settings-timeout-ms").value,
          provider_cost_profiles_json: byId("settings-provider-cost-profiles").value,
          compute_budget_policy_json: byId("settings-compute-budget-policy").value
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
          renderSettingsComputeReadiness(undefined);
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
          const submitted = settingsPayload();
          const body = await postJson("/settings/llm/verify", token, submitted);
          if (JSON.stringify(submitted) !== JSON.stringify(settingsPayload())) {
            invalidateSettingsComputeReadiness();
            return;
          }
          const result = body.result || body;
          const status = result.status || "unknown";
          const computeStatus = renderSettingsComputeReadiness(result.compute_readiness);
          setText("settings-verify-status", "Provider疎通: " + status + "; 通常Computeの設定: " + computeStatus + ". " +
            (result.detail || "") + (result.next_action ? " 次の操作: " + result.next_action : ""));
          byId("settings-verify-status").className = "badge " +
            (status !== "pass" ? "bad" : computeStatus === "ready" ? "good" : "warn");
          setText("settings-json", compactJson(redactRuntimeValue(body)));
        } catch (error) {
          setText("settings-verify-status", "error");
          byId("settings-verify-status").className = "badge bad";
          renderSettingsComputeReadiness(undefined);
          setText("settings-json", error.message);
        }
      }

      async function saveSettings() {
        const token = byId("settings-token").value.trim();
        state.settingsToken = token;
        sessionStorage.setItem("bt.settingsToken", token);
        try {
          const body = await postJson("/settings/config", token, settingsPayload());
          setText("settings-json", compactJson(redactRuntimeValue(body)));
          await loadSettings();
          setText("settings-verify-status", "保存しました。通常仕事へ反映するにはGatewayを再起動してください。");
          byId("settings-verify-status").className = "badge warn";
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
          return null;
        }
        setRuntimeSnapshotObservation("refreshing" + (source === "webchat-connected" ? " after WebChat connection" : ""), "warn");
        try {
          const body = await fetchJson("/runtime/snapshot", token, { cache: "no-store" });
          if (requestId !== state.runtimeSnapshotRequestId) return null;
          renderRuntime(body);
          setRuntimeSnapshotObservation("received " + new Date().toISOString(), "good");
          return body;
        } catch (error) {
          if (requestId !== state.runtimeSnapshotRequestId) return null;
          setText("gateway-status", "unknown");
          byId("gateway-status").className = "badge warn";
          setText("runtime-json", error.message);
          setText("header-status", "runtime error");
          byId("header-status").className = "badge bad";
          setRuntimeSnapshotObservation("refresh failed; Gateway state is unknown", "bad");
          return null;
        }
      }

      async function loadApprovals() {
        const token = byId("approval-token").value.trim();
        const requestId = ++state.approvalSnapshotRequestId;
        state.approvalToken = token;
        sessionStorage.setItem("bt.approvalToken", token);
        try {
          const body = await fetchJson("/approval", token);
          if (requestId !== state.approvalSnapshotRequestId) return;
          renderApprovals(body);
        } catch (error) {
          if (requestId !== state.approvalSnapshotRequestId) return;
          setHtml("approval-list", '<div class="queue-item">' + escapeHtml(error.message) + '</div>');
          setText("approval-summary", "error");
          byId("approval-summary").className = "badge bad";
        }
      }

      async function loadGoalPurposeCandidates() {
        const ownerTokenInput = byId("goal-purpose-owner-token");
        const status = byId("goal-purpose-submit-status");
        const select = byId("goal-purpose-candidate");
        const ownerToken = ownerTokenInput.value.trim();
        status.textContent = "loading unverified C proposals";
        status.className = "badge warn";
        try {
          const body = await fetchJson("/owner/goal-purpose-change-candidates", ownerToken, { cache: "no-store" });
          if (!body || !Array.isArray(body.candidates)) throw new Error("candidate response is invalid");
          state.goalPurposeCandidates = body.candidates.filter(function (candidate) {
            return candidate && typeof candidate.source_command_id === "string" &&
              /^[A-Za-z0-9_-]{1,128}$/.test(candidate.source_command_id) &&
              typeof candidate.request_id === "string" && candidate.request_id.length <= 200 &&
              /^goal_[a-f0-9]{16,64}$/.test(candidate.goal_ref || "") &&
              typeof candidate.purpose_text === "string" && candidate.purpose_text.length > 0 &&
              /^[a-f0-9]{64}$/.test(candidate.purpose_digest || "") &&
              /^[a-f0-9]{64}$/.test(candidate.candidate_digest || "") &&
              /^[a-f0-9]{64}$/.test(candidate.source_review_digest || "") &&
              Number.isSafeInteger(candidate.prior_version) && candidate.prior_version > 0 &&
              /^[a-f0-9]{64}$/.test(candidate.prior_purpose_digest || "") &&
              Array.isArray(candidate.affected_criterion_ref_digests) &&
              candidate.affected_criterion_ref_digests.length > 0 && candidate.affected_criterion_ref_digests.length <= 32 &&
              candidate.affected_criterion_ref_digests.every(function (digest) { return /^[a-f0-9]{64}$/.test(digest); }) &&
              Array.isArray(candidate.conflicting_criterion_ref_digests) &&
              candidate.conflicting_criterion_ref_digests.length > 0 && candidate.conflicting_criterion_ref_digests.length <= 32 &&
              candidate.conflicting_criterion_ref_digests.every(function (digest) { return /^[a-f0-9]{64}$/.test(digest); }) &&
              candidate.used_for_authority === false && candidate.may_execute === false;
          });
          select.replaceChildren();
          const empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "No C proposal selected";
          select.appendChild(empty);
          state.goalPurposeCandidates.forEach(function (candidate) {
            const option = document.createElement("option");
            option.value = candidate.source_command_id;
            option.textContent = candidate.goal_ref + " | conflict criteria " +
              (Array.isArray(candidate.conflicting_criterion_ref_digests) ? candidate.conflicting_criterion_ref_digests.length : 0) +
              " | " + candidate.candidate_digest.slice(0, 12);
            select.appendChild(option);
          });
          status.textContent = state.goalPurposeCandidates.length + " unverified C proposal(s) loaded; no goal changed";
          status.className = "badge warn";
        } catch (error) {
          state.goalPurposeCandidates = [];
          select.replaceChildren();
          const empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "No C proposal selected";
          select.appendChild(empty);
          status.textContent = error && error.message ? error.message : "candidate load failed";
          status.className = "badge bad";
        } finally {
          ownerTokenInput.value = "";
        }
      }

      function selectGoalPurposeCandidate() {
        const sourceCommandId = byId("goal-purpose-candidate").value;
        const candidate = state.goalPurposeCandidates.find(function (item) {
          return item.source_command_id === sourceCommandId;
        });
        if (!candidate) return;
        byId("goal-purpose-goal-ref").value = candidate.goal_ref;
        byId("goal-purpose-text").value = candidate.purpose_text;
        const status = byId("goal-purpose-submit-status");
        status.textContent = "unverified C proposal selected; inspect exact text and conflict scope before L3 submission";
        status.className = "badge warn";
      }

      async function submitGoalPurposeChange() {
        const ownerTokenInput = byId("goal-purpose-owner-token");
        const purposeInput = byId("goal-purpose-text");
        const status = byId("goal-purpose-submit-status");
        const ownerToken = ownerTokenInput.value.trim();
        const goalRef = byId("goal-purpose-goal-ref").value.trim();
        const purposeText = purposeInput.value;
        const sourceCommandId = byId("goal-purpose-candidate").value;
        status.textContent = "submitting";
        status.className = "badge warn";
        try {
          const response = await fetch("/owner/goal-purpose-change", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders(ownerToken)
            },
            body: JSON.stringify({
              goal_ref: goalRef,
              purpose_text: purposeText,
              ...(sourceCommandId ? { source_command_id: sourceCommandId } : {})
            })
          });
          const result = await response.json().catch(function () { return null; });
          if (!response.ok || !result || result.accepted !== true) {
            status.textContent = result && (result.status || result.error) || "proposal was not accepted (HTTP " + response.status + ")";
            status.className = "badge bad";
            return;
          }
          purposeInput.value = "";
          byId("goal-purpose-candidate").value = "";
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

      async function requestTaskCancellation(commandId) {
        const token = byId("approval-token").value.trim();
        const status = byId("execution-cancel-status");
        status.textContent = "Sending cancellation request…";
        status.className = "badge warn";
        const response = await fetch("/approval/executions/" + encodeURIComponent(commandId) + "/cancel", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders(token)),
          body: JSON.stringify({})
        });
        const body = await response.json().catch(function () { return {}; });
        if (!response.ok || !body || !body.cancellation || body.cancellation.cancel_request_accepted !== true) {
          throw new Error("task cancellation failed: HTTP " + response.status + " " + (body && body.error || "invalid response"));
        }
        const cancellation = body.cancellation;
        status.textContent = "Cancel request accepted for " + cancellation.command_id + ". Executor settlement, local worker stop, and external processing stop remain separate; external stop is unknown.";
        status.className = "badge warn";
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
        if (review.kind === "file_delete_target") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          if (review.command_id !== commandId || review.operation !== "file.delete" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.target_version_digest) ||
              !isDigest(review.operation_plan_binding_digest) || typeof review.path !== "string" ||
              review.path.length === 0 || review.path.length > 512 ||
              !Number.isSafeInteger(review.size_bytes) || review.size_bytes < 0 || review.size_bytes > 1_000_000 ||
              !Number.isSafeInteger(review.max_bytes) || review.max_bytes < 1 || review.max_bytes > 1_000_000 ||
              review.size_bytes > review.max_bytes) {
            throw new Error("削除対象の確認情報がこの承認要求に結び付いていません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "削除対象（sandbox内の相対パス）";
          view.appendChild(heading);
          [
            ["対象ファイル", review.path],
            ["現在のサイズ", String(review.size_bytes) + " bytes"],
            ["削除対象上限", String(review.max_bytes) + " bytes"],
            ["対象版digest", review.target_version_digest],
            ["Operation Plan束縛digest", review.operation_plan_binding_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "本文は表示しません。この確認だけでは削除されません。承認直前・実行直前に同じ対象版を再照合し、変化があれば停止します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | target review digest: " + review.review_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "削除対象を再確認";
          return;
        }
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
          const sourceReview = review.source_skeptical_review;
          if (review.command_id !== commandId || review.operation !== "goal.governance.change" ||
              review.used_for_authority !== false || !/^[a-f0-9]{64}$/.test(review.command_digest || "") ||
              !/^[a-f0-9]{64}$/.test(review.request_payload_digest || "") ||
              review.request_payload_digest !== review.new_purpose_digest ||
              !/^[a-f0-9]{64}$/.test(review.prior_purpose_digest || "") ||
              typeof review.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(review.goal_ref) ||
              !Number.isSafeInteger(review.prior_version) || review.prior_version <= 0 ||
              typeof review.purpose_text !== "string" ||
              (sourceReview !== undefined && (!isObject(sourceReview) ||
                typeof sourceReview.source_command_id !== "string" ||
                typeof sourceReview.source_request_id !== "string" ||
                !/^[a-f0-9]{64}$/.test(sourceReview.candidate_digest || "") ||
                !/^[a-f0-9]{64}$/.test(sourceReview.review_digest || "") ||
                !Array.isArray(sourceReview.affected_criterion_ref_digests) ||
                sourceReview.affected_criterion_ref_digests.length > 32 ||
                !sourceReview.affected_criterion_ref_digests.every(function (digest) { return /^[a-f0-9]{64}$/.test(digest); }) ||
                !Array.isArray(sourceReview.conflicting_criterion_ref_digests) ||
                sourceReview.conflicting_criterion_ref_digests.length === 0 ||
                sourceReview.conflicting_criterion_ref_digests.length > 32 ||
                !sourceReview.conflicting_criterion_ref_digests.every(function (digest) { return /^[a-f0-9]{64}$/.test(digest); })))) {
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
          if (sourceReview) {
            const sourceHeading = document.createElement("strong");
            sourceHeading.textContent = "Unverified C review source scope";
            view.appendChild(sourceHeading);
            const source = document.createElement("pre");
            source.textContent = JSON.stringify({
              source_command_id: sourceReview.source_command_id,
              source_request_id: sourceReview.source_request_id,
              candidate_digest: sourceReview.candidate_digest,
              review_digest: sourceReview.review_digest,
              affected_criterion_ref_digests: sourceReview.affected_criterion_ref_digests,
              conflicting_criterion_ref_digests: sourceReview.conflicting_criterion_ref_digests
            }, null, 2);
            view.appendChild(source);
          }
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
        if (review.kind === "google_calendar_event_create") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const isEmail = function (value) { return typeof value === "string" && value.trim() === value && value.length <= 320 &&
            value.indexOf("@") > 0 && value.indexOf("@") === value.lastIndexOf("@") &&
            value.lastIndexOf(".") > value.indexOf("@") + 1; };
          const validIntervals = function (value) {
            return Array.isArray(value) && value.length <= 500 && value.every(function (interval) {
              return isObject(interval) && typeof interval.start === "string" &&
                Number.isFinite(Date.parse(interval.start)) && typeof interval.end === "string" &&
                Number.isFinite(Date.parse(interval.end)) && Date.parse(interval.end) > Date.parse(interval.start);
            });
          };
          if (review.command_id !== commandId || review.operation !== "google.calendar.write.event.create" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.source_observation_digest) ||
              !isDigest(review.availability_result_digest) || typeof review.calendar_id !== "string" ||
              review.calendar_id.length === 0 || review.calendar_id.length > 512 ||
              typeof review.start !== "string" || !Number.isFinite(Date.parse(review.start)) ||
              typeof review.end !== "string" || !Number.isFinite(Date.parse(review.end)) ||
              Date.parse(review.end) <= Date.parse(review.start) ||
              typeof review.availability_observed_at !== "string" ||
              !Number.isFinite(Date.parse(review.availability_observed_at)) ||
              typeof review.availability_window_start !== "string" ||
              !Number.isFinite(Date.parse(review.availability_window_start)) ||
              typeof review.availability_window_end !== "string" ||
              !Number.isFinite(Date.parse(review.availability_window_end)) ||
              !validIntervals(review.busy_intervals) || !validIntervals(review.overlapping_busy_intervals) ||
              !Array.isArray(review.attendees) || review.attendees.length > 20 ||
              review.attendees.some(function (email) { return !isEmail(email); }) ||
              review.invite_notifications_requested !== (review.attendees.length > 0) ||
              (review.summary !== undefined && typeof review.summary !== "string") ||
              (review.description !== undefined && typeof review.description !== "string") ||
              (review.location !== undefined && typeof review.location !== "string") ||
              (review.time_zone !== undefined && typeof review.time_zone !== "string")) {
            throw new Error("予定の内容・空き状況がこの承認要求と一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "登録するGoogle Calendar予定と直近の空き状況";
          view.appendChild(heading);
          [
            ["カレンダー", review.calendar_id],
            ["件名", review.summary || "（件名なし）"],
            ["開始", review.start],
            ["終了", review.end],
            ["タイムゾーン", review.time_zone || "RFC3339のoffset"],
            ["場所", review.location || "（なし）"],
            ["招待先", review.attendees.length > 0 ? review.attendees.join(", ") : "（なし）"],
            ["招待メール", review.invite_notifications_requested ? "上記の宛先へ送信" : "送信なし"],
            ["空き状況の再確認時刻", review.availability_observed_at],
            ["観測窓", review.availability_window_start + " – " + review.availability_window_end]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          if (review.description) {
            const descriptionLabel = document.createElement("strong");
            descriptionLabel.textContent = "説明";
            view.appendChild(descriptionLabel);
            const description = document.createElement("pre");
            description.textContent = review.description;
            view.appendChild(description);
          }
          const busyLabel = document.createElement("strong");
          busyLabel.textContent = "観測された予定";
          view.appendChild(busyLabel);
          const busy = document.createElement("pre");
          busy.textContent = review.busy_intervals.length
            ? review.busy_intervals.map(function (interval) { return interval.start + " – " + interval.end; }).join("\\n")
            : "空き状況APIはこの範囲にbusy区間を返していません";
          view.appendChild(busy);
          const overlapLabel = document.createElement("strong");
          overlapLabel.textContent = "この予定と重なるbusy区間";
          view.appendChild(overlapLabel);
          const overlap = document.createElement("pre");
          overlap.textContent = review.overlapping_busy_intervals.length
            ? review.overlapping_busy_intervals.map(function (interval) { return interval.start + " – " + interval.end; }).join("\\n")
            : "重なりなし";
          view.appendChild(overlap);
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "空き状況は参考情報で、権限や承認の根拠にはなりません。承認直前と登録直前に同じ観測結果を再照合し、変化があれば登録を止めます。この作成操作は単一の非繰返し予定のみです。招待先を指定した場合は、宛先への招待通知も同じL3確認に含みます。既存予定への招待は別操作で、現在の参加者を保って追加し、sendUpdates=allで既存参加者を含む全員へ更新通知を依頼します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | freebusy result digest: " + review.availability_result_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "予定内容と空き状況を再確認";
          return;
        }
        if (review.kind === "google_calendar_event_invite") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const isEmail = function (value) { return typeof value === "string" && value.trim() === value && value.length <= 320 &&
            value.indexOf("@") > 0 && value.indexOf("@") === value.lastIndexOf("@") &&
            value.lastIndexOf(".") > value.indexOf("@") + 1; };
          const validRecurrenceRules = Array.isArray(review.recurrence_rules) && review.recurrence_rules.length <= 64 &&
            review.recurrence_rules.every(function (rule) { return typeof rule === "string" && rule.length > 0 &&
              rule.length <= 2_048 && !/[\\u0000-\\u001f\\u007f]/.test(rule); });
          const recurrenceRulesEmpty = validRecurrenceRules && review.recurrence_rules.length === 0;
          const recurrenceRulesPresent = validRecurrenceRules && review.recurrence_rules.length > 0;
          const originalStartValid = review.original_start === null || (review.original_start &&
            typeof review.original_start.value === "string" &&
            (review.original_start.kind === "date"
              ? /^\\d{4}-\\d{2}-\\d{2}$/.test(review.original_start.value) && Number.isFinite(Date.parse(review.original_start.value + "T00:00:00Z"))
              : review.original_start.kind === "date_time" && Number.isFinite(Date.parse(review.original_start.value)) &&
                typeof review.original_start.time_zone === "string") &&
            (review.original_start.time_zone === null || typeof review.original_start.time_zone === "string"));
          const scopeIdentityValid = review.target_scope === "single_event"
            ? review.recurring_event_id === null && review.original_start === null && recurrenceRulesEmpty
            : review.target_scope === "series"
              ? review.recurring_event_id === null && review.original_start === null && recurrenceRulesPresent
              : review.target_scope === "occurrence" && typeof review.recurring_event_id === "string" &&
                review.recurring_event_id.length > 0 && review.original_start !== null;
          const validEmailList = function (values, minimum, maximum) {
            return Array.isArray(values) && values.length >= minimum && values.length <= maximum &&
              values.every(function (email) { return isEmail(email); }) &&
              new Set(values.map(function (email) { return email.toLowerCase(); })).size === values.length;
          };
          const validRetainedAttendees = validEmailList(review.retained_attendees, 0, 200);
          const validInvitees = validEmailList(review.invitees, 1, 20);
          const validNotificationRecipients = validEmailList(review.notification_recipients, 1, 200) &&
            review.invitees.every(function (email) {
              return review.notification_recipients.some(function (recipient) {
                return recipient.toLowerCase() === email.toLowerCase();
              });
            });
          if (review.command_id !== commandId || review.operation !== "google.calendar.write.event.invite" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.event_state_digest) ||
              typeof review.calendar_id !== "string" || review.calendar_id !== "primary" ||
              typeof review.event_id !== "string" || review.event_id.length === 0 || review.event_id.length > 1_024 ||
              (review.current_summary !== null && (typeof review.current_summary !== "string" || review.current_summary.length > 8_192)) ||
              typeof review.event_start !== "string" || typeof review.event_end !== "string" ||
              !Number.isFinite(Date.parse(review.event_start)) || !Number.isFinite(Date.parse(review.event_end)) ||
              (review.event_time_kind !== "date" && review.event_time_kind !== "date_time") ||
              (review.event_time_zone !== null && typeof review.event_time_zone !== "string") ||
              !validRecurrenceRules || !originalStartValid || !scopeIdentityValid || !validRetainedAttendees ||
              !validInvitees || !validNotificationRecipients ||
              review.notification_effect !== "send_calendar_update_notifications_to_all_attendees" ||
              review.organizer_self !== true || !Number.isInteger(review.other_attendee_count) ||
              review.other_attendee_count < 0 || review.other_attendee_count > 200 ||
              review.retained_attendee_count !== review.retained_attendees.length ||
              review.retained_attendee_count + review.invitees.length > 200 ||
              review.notification_recipient_count !== review.notification_recipients.length ||
              review.attendee_inventory_complete !== true || typeof review.observed_at !== "string" ||
              !Number.isFinite(Date.parse(review.observed_at))) {
            throw new Error("参加者と通知の確認内容がこの承認要求と一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "Google Calendar参加者追加と全員への更新通知";
          view.appendChild(heading);
          [
            ["カレンダー", review.calendar_id],
            ["予定", review.current_summary || "（件名なし）"],
            ["開始", review.event_start],
            ["終了", review.event_end],
            ["対象範囲", review.target_scope === "series" ? "繰返し予定全体" :
              review.target_scope === "occurrence" ? "繰返し予定の指定回" : "単一予定"],
            ["既存参加者", review.retained_attendee_count + "人を保持"],
            ["新規追加", review.invitees.length + "人"],
            ["更新通知の範囲", "現在の参加者と追加する参加者"],
            ["Calendar API", "sendUpdates=all"],
            ["再確認時刻", review.observed_at]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const inviteesLabel = document.createElement("strong");
          inviteesLabel.textContent = "保持する既存参加者";
          view.appendChild(inviteesLabel);
          const retainedAttendees = document.createElement("pre");
          retainedAttendees.textContent = review.retained_attendees.length ? review.retained_attendees.join("\\n") : "（既存参加者なし）";
          view.appendChild(retainedAttendees);
          const newInviteesLabel = document.createElement("strong");
          newInviteesLabel.textContent = "新しく追加する参加者";
          view.appendChild(newInviteesLabel);
          const newInvitees = document.createElement("pre");
          newInvitees.textContent = review.invitees.join("\\n");
          view.appendChild(newInvitees);
          const notificationRecipientsLabel = document.createElement("strong");
          notificationRecipientsLabel.textContent = "通知対象（既存参加者を含む全員）";
          view.appendChild(notificationRecipientsLabel);
          const notificationRecipients = document.createElement("pre");
          notificationRecipients.textContent = review.notification_recipients.join("\\n");
          view.appendChild(notificationRecipients);
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "Google Calendar APIのattendees配列は置換されるため、確認済みの既存参加者とRSVP等の状態を保持して新規参加者を追加します。sendUpdates=allにより既存参加者を含む一覧全員へ更新通知を依頼します。通知メールの到達自体は確認できません。系列は系列全体、occurrenceは表示した指定回だけを対象にし、承認後に予定の版が変わると停止します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | event state digest: " + review.event_state_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "参加者と招待範囲を再確認";
          return;
        }
        if (review.kind === "google_calendar_event_update") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const validRecurrenceRules = Array.isArray(review.recurrence_rules) && review.recurrence_rules.length <= 64 &&
            review.recurrence_rules.every(function (rule) { return typeof rule === "string" && rule.length > 0 &&
              rule.length <= 2_048 && !/[\\u0000-\\u001f\\u007f]/.test(rule); });
          const recurrenceRulesEmpty = validRecurrenceRules && review.recurrence_rules.length === 0;
          const recurrenceRulesPresent = validRecurrenceRules && review.recurrence_rules.length > 0;
          const originalStartValid = review.original_start === null || (review.original_start &&
            typeof review.original_start.value === "string" &&
            (review.original_start.kind === "date"
              ? /^\\d{4}-\\d{2}-\\d{2}$/.test(review.original_start.value) && Number.isFinite(Date.parse(review.original_start.value + "T00:00:00Z"))
              : review.original_start.kind === "date_time" && Number.isFinite(Date.parse(review.original_start.value)) &&
                typeof review.original_start.time_zone === "string") &&
            (review.original_start.time_zone === null || typeof review.original_start.time_zone === "string"));
          const scopeIdentityValid = review.target_scope === "single_event"
            ? review.recurring_event_id === null && review.original_start === null && recurrenceRulesEmpty
            : review.target_scope === "series"
              ? review.recurring_event_id === null && review.original_start === null && recurrenceRulesPresent
              : review.target_scope === "occurrence" && typeof review.recurring_event_id === "string" &&
                review.recurring_event_id.length > 0 && review.original_start !== null;
          if (review.command_id !== commandId || review.operation !== "google.calendar.write.event.update" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.event_state_digest) ||
              typeof review.calendar_id !== "string" || review.calendar_id !== "primary" ||
              typeof review.event_id !== "string" || review.event_id.length === 0 || review.event_id.length > 1_024 ||
              (review.current_summary !== null && (typeof review.current_summary !== "string" || review.current_summary.length > 8_192)) ||
              typeof review.new_summary !== "string" || review.new_summary.trim().length === 0 ||
              review.new_summary.length > 8_192 || typeof review.event_start !== "string" ||
              typeof review.event_end !== "string" || !Number.isFinite(Date.parse(review.event_start)) ||
              !Number.isFinite(Date.parse(review.event_end)) ||
              (review.event_time_kind !== "date" && review.event_time_kind !== "date_time") ||
              (review.event_time_zone !== null && typeof review.event_time_zone !== "string") ||
              !validRecurrenceRules || !originalStartValid || !scopeIdentityValid ||
              review.organizer_self !== true || review.other_attendee_count !== 0 ||
              review.attendee_inventory_complete !== true ||
              typeof review.observed_at !== "string" ||
              !Number.isFinite(Date.parse(review.observed_at))) {
            throw new Error("更新対象・作用範囲・新しい件名がこの承認要求と一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = review.target_scope === "series" ? "Calendar繰返し系列の件名更新" :
            review.target_scope === "occurrence" ? "Calendar繰返し予定の1回分の件名更新" : "単一Calendar予定の件名更新";
          view.appendChild(heading);
          [
            ["カレンダー", review.calendar_id],
            ["作用範囲", review.target_scope === "series" ? "系列本体（繰返し規則に従う予定）" :
              review.target_scope === "occurrence" ? "この1回分だけ" : "この単一予定だけ"],
            ["予定ID", review.event_id],
            ["日時", review.event_start + " – " + review.event_end +
              (review.event_time_zone ? " (" + review.event_time_zone + ")" : review.event_time_kind === "date" ? " (終日)" : "")],
            ["現在の件名", review.current_summary === null ? "（件名なし）" : review.current_summary],
            ["更新後の件名", review.new_summary],
            ["所有確認", "このアカウントが主催者"],
            ["他の参加者", "0人（一覧取得完了）"],
            ["対象の再読取時刻", review.observed_at]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          if (review.target_scope === "occurrence") {
            const identity = document.createElement("p");
            identity.textContent = "親系列ID: " + review.recurring_event_id + " / 元の開始日時: " +
              review.original_start.value + (review.original_start.time_zone ? " (" + review.original_start.time_zone + ")" : "");
            view.appendChild(identity);
          }
          if (review.target_scope === "series") {
            const rulesLabel = document.createElement("strong");
            rulesLabel.textContent = "繰返し規則";
            const rules = document.createElement("pre");
            rules.textContent = review.recurrence_rules.join("\\n");
            view.append(rulesLabel, rules);
          }
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = review.target_scope === "series"
            ? "繰返し系列本体の件名欄だけを更新します。繰返し規則・参加者・他の項目は要求へ含めません。例外回を個別更新する操作ではありません。対象が変化した場合は停止します。"
            : review.target_scope === "occurrence"
              ? "この1回分だけの件名を更新します。親系列や他の回の内容は変更しません。親系列IDと元の開始日時が一致しない場合は停止します。"
              : "確定済みの単一予定について件名だけを更新します。時刻・本文・場所・参加者・招待通知は変更しません。対象が変化した場合はETag条件付き更新で停止します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | event state digest: " + review.event_state_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "予定の現在値と更新後を再確認";
          return;
        }
        if (review.kind === "google_calendar_event_delete") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const validRecurrenceRules = Array.isArray(review.recurrence_rules) && review.recurrence_rules.length <= 64 &&
            review.recurrence_rules.every(function (rule) { return typeof rule === "string" && rule.length > 0 &&
              rule.length <= 2_048 && !/[\\u0000-\\u001f\\u007f]/.test(rule); });
          const originalStartValid = review.original_start === null || (review.original_start &&
            typeof review.original_start.value === "string" &&
            (review.original_start.kind === "date"
              ? /^\\d{4}-\\d{2}-\\d{2}$/.test(review.original_start.value)
              : review.original_start.kind === "date_time" && Number.isFinite(Date.parse(review.original_start.value)) &&
                typeof review.original_start.time_zone === "string") &&
            (review.original_start.time_zone === null || typeof review.original_start.time_zone === "string"));
          const scopeIdentityValid = review.target_scope === "single_event"
            ? review.recurring_event_id === null && review.original_start === null && Array.isArray(review.recurrence_rules) && review.recurrence_rules.length === 0
            : review.target_scope === "series"
              ? review.recurring_event_id === null && review.original_start === null && Array.isArray(review.recurrence_rules) && review.recurrence_rules.length > 0
              : review.target_scope === "occurrence" && typeof review.recurring_event_id === "string" &&
                review.recurring_event_id.length > 0 && review.original_start !== null;
          if (review.command_id !== commandId || review.operation !== "google.calendar.write.event.delete" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.event_state_digest) ||
              typeof review.calendar_id !== "string" || review.calendar_id !== "primary" ||
              typeof review.event_id !== "string" || review.event_id.length === 0 || review.event_id.length > 1_024 ||
              (review.current_summary !== null && (typeof review.current_summary !== "string" || review.current_summary.length > 8_192)) ||
              typeof review.event_start !== "string" || typeof review.event_end !== "string" ||
              !Number.isFinite(Date.parse(review.event_start)) || !Number.isFinite(Date.parse(review.event_end)) ||
              (review.event_time_kind !== "date" && review.event_time_kind !== "date_time") ||
              (review.event_time_zone !== null && typeof review.event_time_zone !== "string") ||
              !validRecurrenceRules || !originalStartValid || !scopeIdentityValid ||
              review.organizer_self !== true || review.other_attendee_count !== 0 ||
              review.attendee_inventory_complete !== true || typeof review.observed_at !== "string" ||
              !Number.isFinite(Date.parse(review.observed_at))) {
            throw new Error("削除対象・作用範囲・所有・参加者の確認結果がこの承認要求と一致しません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = review.target_scope === "series" ? "Calendar繰返し系列全体の削除" :
            review.target_scope === "occurrence" ? "Calendar繰返し予定の1回分の削除" : "Calendar単一予定の削除";
          view.appendChild(heading);
          [
            ["カレンダー", review.calendar_id],
            ["作用範囲", review.target_scope === "series" ? "この系列全体（規則を表示。各回は列挙していません）" :
              review.target_scope === "occurrence" ? "この1回分だけ。親系列と他の回は維持" : "この単一予定だけ"],
            ["予定ID", review.event_id],
            ["日時", review.event_start + " – " + review.event_end +
              (review.event_time_zone ? " (" + review.event_time_zone + ")" : review.event_time_kind === "date" ? " (終日)" : "")],
            ["現在の件名", review.current_summary === null ? "（件名なし）" : review.current_summary],
            ["所有確認", "このアカウントが主催者"],
            ["他の参加者", "0人（一覧取得完了）"],
            ["対象の再読取時刻", review.observed_at]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          if (review.target_scope === "occurrence") {
            const identity = document.createElement("p");
            identity.textContent = "親系列ID: " + review.recurring_event_id + " / 元の開始日時: " +
              review.original_start.value + (review.original_start.time_zone ? " (" + review.original_start.time_zone + ")" : "");
            view.appendChild(identity);
          }
          if (review.target_scope === "series") {
            const rulesLabel = document.createElement("strong");
            rulesLabel.textContent = "繰返し規則";
            const rules = document.createElement("pre");
            rules.textContent = review.recurrence_rules.join("\\n");
            view.append(rulesLabel, rules);
          }
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = review.target_scope === "series"
            ? "繰返し規則を持つ系列本体を削除する作用です。単一予定や1回分の削除とは別の作用で、規則の各回は個別列挙していません。参加者への通知は送りません。"
            : review.target_scope === "occurrence"
              ? "この1回分だけを削除し、親系列と他の回は維持します。親系列IDと元の開始日時が一致しない場合は削除を停止します。参加者への通知は送りません。"
              : "確定済みの単一予定を削除します。参加者への通知は送りません。承認後も対象の再読取とETag条件が一致しない場合は削除を停止します。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | event state digest: " + review.event_state_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "削除対象と影響範囲を再確認";
          return;
        }
        if (review.kind === "google_drive_file_create") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const validOptionalString = function (value, max) {
            return value === null || (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
          };
          const validPermissions = Array.isArray(review.permissions) && review.permissions.length > 0 &&
            review.permissions.length <= 500 && review.permissions.every(function (permission) {
              return permission && ["user", "group", "domain", "anyone"].includes(permission.type) &&
                typeof permission.role === "string" && permission.role.length > 0 && permission.role.length <= 128 &&
                validOptionalString(permission.email_address, 320) && validOptionalString(permission.domain, 320) &&
                (permission.allow_file_discovery === null || typeof permission.allow_file_discovery === "boolean") &&
                validOptionalString(permission.expiration_time, 128) && typeof permission.deleted === "boolean" &&
                Array.isArray(permission.permission_details) && permission.permission_details.length <= 32 &&
                permission.permission_details.every(function (detail) {
                  return detail && validOptionalString(detail.permission_type, 128) &&
                    validOptionalString(detail.role, 128) &&
                    (detail.inherited === null || typeof detail.inherited === "boolean") &&
                    validOptionalString(detail.inherited_from, 512);
                });
            });
          if (review.command_id !== commandId || review.operation !== "google.drive.write.file.create" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.target_version_digest) ||
              !isDigest(review.operation_plan_binding_digest) || !isDigest(review.parent_access_scope_digest) ||
              typeof review.parent_folder_id !== "string" || review.parent_folder_id.length === 0 || review.parent_folder_id.length > 512 ||
              typeof review.parent_folder_name !== "string" || review.parent_folder_name.length === 0 || review.parent_folder_name.length > 512 ||
              !validOptionalString(review.parent_folder_drive_id, 512) ||
              !validOptionalString(review.parent_folder_version, 128) ||
              !validOptionalString(review.parent_folder_modified_time, 128) ||
              (review.parent_folder_shared !== null && typeof review.parent_folder_shared !== "boolean") ||
              (review.parent_inherited_permissions_disabled !== null && typeof review.parent_inherited_permissions_disabled !== "boolean") ||
              review.parent_access_scope_complete !== true || review.target_name_absent !== true || !validPermissions ||
              typeof review.name !== "string" || review.name.length === 0 || review.name.length > 255 ||
              review.mime_type !== "text/plain" || typeof review.content !== "string" ||
              !Number.isSafeInteger(review.content_bytes) || review.content_bytes < 0 || review.content_bytes > 512_000 ||
              new TextEncoder().encode(review.content).byteLength !== review.content_bytes) {
            throw new Error("Drive作成内容または親フォルダーのアクセス範囲が、この承認要求に結び付いていません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "Google Drive 新規ファイル作成（text/plain）";
          view.appendChild(heading);
          [
            ["親フォルダー", review.parent_folder_name],
            ["親フォルダーID", review.parent_folder_id],
            ["共有ドライブID", review.parent_folder_drive_id === null ? "なし／個人Drive" : review.parent_folder_drive_id],
            ["親フォルダー版", review.parent_folder_version ?? "取得されていません"],
            ["親の更新時刻", review.parent_folder_modified_time ?? "取得されていません"],
            ["親フォルダー共有状態", review.parent_folder_shared === null ? "不明" : review.parent_folder_shared ? "共有あり" : "共有なし"],
            ["親で継承権限を無効化", review.parent_inherited_permissions_disabled === null ? "不明" : review.parent_inherited_permissions_disabled ? "はい" : "いいえ"],
            ["作成ファイル名", review.name],
            ["MIME型", review.mime_type],
            ["内容サイズ", String(review.content_bytes) + " bytes"],
            ["同名ファイル", "親フォルダー内で不存在を確認済み"],
            ["有効アクセス範囲digest", review.parent_access_scope_digest],
            ["対象版digest", review.target_version_digest],
            ["Operation Plan束縛digest", review.operation_plan_binding_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const scopeHeading = document.createElement("strong");
          scopeHeading.textContent = "親フォルダーから適用される全アクセス権限（" + review.permissions.length + "件）";
          view.appendChild(scopeHeading);
          review.permissions.forEach(function (permission) {
            const item = document.createElement("p");
            const principal = permission.type === "anyone" ? "全員（公開範囲）" :
              permission.type === "domain" ? "ドメイン " + (permission.domain || "不明") :
                permission.type === "group" ? "グループ " + (permission.email_address || "不明") :
                  "ユーザー " + (permission.email_address || "不明");
            const discoverability = permission.type === "domain" || permission.type === "anyone"
              ? " / 検索可能=" + (permission.allow_file_discovery === null ? "不明" : permission.allow_file_discovery ? "はい" : "いいえ") : "";
            const detail = permission.permission_details.map(function (entry) {
              return (entry.inherited === null ? "継承状態不明" : entry.inherited ? "親から継承" : "直接付与") +
                (entry.role ? "・" + entry.role : "") + (entry.inherited_from ? "・継承元 " + entry.inherited_from : "");
            }).join("、");
            item.textContent = principal + " / 権限=" + permission.role + discoverability +
              (permission.expiration_time ? " / 期限=" + permission.expiration_time : "") +
              (permission.deleted ? " / 削除済み権限" : "") + (detail ? " / " + detail : "");
            view.appendChild(item);
          });
          const contentHeading = document.createElement("strong");
          contentHeading.textContent = "作成する本文（そのまま表示）";
          const content = document.createElement("pre");
          content.textContent = review.content;
          view.append(contentHeading, content);
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "この確認は保存されません。親フォルダーの権限範囲と同名不存在を承認前・作用直前に再取得し、対象版、アクセス範囲、内容のいずれかが変化または不完全なら作成を停止します。同名不存在とpermission scopeの再確認はスナップショット照合であり、Drive APIの排他条件ではありません。照合とPOSTの間に他writerが同名作成・権限変更する競合は防げません。ファイル更新・共有変更・削除は含みません。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | review digest: " + review.review_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "作成内容とアクセス範囲を再確認";
          return;
        }
        if (review.kind === "google_drive_file_update") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const validOptionalString = function (value, max) {
            return value === null || (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
          };
          const validPermissions = Array.isArray(review.permissions) && review.permissions.length > 0 &&
            review.permissions.length <= 500 && review.permissions.every(function (permission) {
              return permission && ["user", "group", "domain", "anyone"].includes(permission.type) &&
                typeof permission.role === "string" && permission.role.length > 0 && permission.role.length <= 128 &&
                validOptionalString(permission.email_address, 320) && validOptionalString(permission.domain, 320) &&
                (permission.allow_file_discovery === null || typeof permission.allow_file_discovery === "boolean") &&
                validOptionalString(permission.expiration_time, 128) && typeof permission.deleted === "boolean" &&
                Array.isArray(permission.permission_details) && permission.permission_details.length <= 32 &&
                permission.permission_details.every(function (detail) {
                  return detail && validOptionalString(detail.permission_type, 128) &&
                    validOptionalString(detail.role, 128) &&
                    (detail.inherited === null || typeof detail.inherited === "boolean") &&
                    validOptionalString(detail.inherited_from, 512);
                });
            });
          const currentBytes = typeof review.current_content === "string"
            ? new TextEncoder().encode(review.current_content).byteLength : -1;
          const replacementBytes = typeof review.replacement_content === "string"
            ? new TextEncoder().encode(review.replacement_content).byteLength : -1;
          if (review.command_id !== commandId || review.operation !== "google.drive.write.file.update" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.target_version_digest) ||
              !isDigest(review.operation_plan_binding_digest) || !isDigest(review.target_access_scope_digest) ||
              !isDigest(review.current_content_digest) || typeof review.file_id !== "string" ||
              review.file_id.length === 0 || review.file_id.length > 512 ||
              typeof review.file_name !== "string" || review.file_name.length === 0 || review.file_name.length > 512 ||
              !Array.isArray(review.parent_ids) || review.parent_ids.length === 0 || review.parent_ids.length > 32 ||
              review.parent_ids.some(function (id) { return typeof id !== "string" || id.length === 0 || id.length > 512; }) ||
              !validOptionalString(review.drive_id, 512) || typeof review.file_version !== "string" ||
              review.file_version.length === 0 || review.file_version.length > 128 ||
              !validOptionalString(review.file_modified_time, 128) ||
              (review.file_shared !== null && typeof review.file_shared !== "boolean") ||
              (review.inherited_permissions_disabled !== null && typeof review.inherited_permissions_disabled !== "boolean") ||
              review.file_mime_type !== "text/plain" || review.target_access_scope_complete !== true || !validPermissions ||
              typeof review.current_content !== "string" || typeof review.replacement_content !== "string" ||
              !Number.isSafeInteger(review.current_content_bytes) || review.current_content_bytes < 0 ||
              review.current_content_bytes > 512_000 || currentBytes !== review.current_content_bytes ||
              !Number.isSafeInteger(review.replacement_content_bytes) || review.replacement_content_bytes < 0 ||
              review.replacement_content_bytes > 512_000 || replacementBytes !== review.replacement_content_bytes) {
            throw new Error("Drive更新内容または対象版がこの承認要求へ結び付いていません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "Google Drive text/plain本文の全置換";
          view.appendChild(heading);
          [
            ["対象ファイル", review.file_name],
            ["ファイルID", review.file_id],
            ["共有ドライブID", review.drive_id === null ? "なし／個人Drive" : review.drive_id],
            ["現在版", review.file_version],
            ["親フォルダーID", review.parent_ids.join(", ")],
            ["共有状態", review.file_shared === null ? "不明" : review.file_shared ? "共有あり" : "共有なし"],
            ["アクセス範囲digest", review.target_access_scope_digest],
            ["変更前本文digest", review.current_content_digest],
            ["対象版digest", review.target_version_digest],
            ["Operation Plan束縛digest", review.operation_plan_binding_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const scopeHeading = document.createElement("strong");
          scopeHeading.textContent = "対象ファイルに取得できた全アクセス権限（" + review.permissions.length + "件）";
          view.appendChild(scopeHeading);
          review.permissions.forEach(function (permission) {
            const item = document.createElement("p");
            const principal = permission.type === "anyone" ? "全員（公開範囲）" :
              permission.type === "domain" ? "ドメイン " + (permission.domain || "不明") :
                permission.type === "group" ? "グループ " + (permission.email_address || "不明") :
                  "ユーザー " + (permission.email_address || "不明");
            const discoverability = permission.type === "domain" || permission.type === "anyone"
              ? " / 検索可能=" + (permission.allow_file_discovery === null ? "不明" : permission.allow_file_discovery ? "はい" : "いいえ") : "";
            const detail = permission.permission_details.map(function (entry) {
              return (entry.inherited === null ? "継承状態不明" : entry.inherited ? "親から継承" : "直接付与") +
                (entry.role ? "・" + entry.role : "") + (entry.inherited_from ? "・継承元 " + entry.inherited_from : "");
            }).join("、");
            item.textContent = principal + " / 権限=" + permission.role + discoverability +
              (permission.expiration_time ? " / 期限=" + permission.expiration_time : "") +
              (permission.deleted ? " / 削除済み権限" : "") + (detail ? " / " + detail : "");
            view.appendChild(item);
          });
          const beforeHeading = document.createElement("strong");
          beforeHeading.textContent = "現在の本文（全置換されます）";
          const beforeContent = document.createElement("pre");
          beforeContent.textContent = review.current_content;
          view.append(beforeHeading, beforeContent);
          const replacementHeading = document.createElement("strong");
          replacementHeading.textContent = "置換後の本文";
          const replacement = document.createElement("pre");
          replacement.textContent = review.replacement_content;
          view.append(replacementHeading, replacement);
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "確認内容は保存されません。本文とアクセス範囲を承認直前・PATCH直前に再取得し、変化や不完全な読取があれば更新を停止します。再読取とPATCHはDrive側の原子的な条件付き更新ではないため、最後の照合直後に他writerが更新した場合の競合を排除できません。PATCH後に同じfile IDと本文を再読取し、不明時は自動再送しません。共有変更・削除・Google Workspace文書は対象外です。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | review digest: " + review.review_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "置換前後の本文とアクセス範囲を再確認";
          return;
        }
        if (review.kind === "google_drive_permission_create") {
          const isDigest = function (value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); };
          const validOptionalString = function (value, max) {
            return value === null || (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
          };
          const validPermissions = Array.isArray(review.permissions) && review.permissions.length > 0 &&
            review.permissions.length <= 500 && review.permissions.every(function (permission) {
              return permission && ["user", "group", "domain", "anyone"].includes(permission.type) &&
                typeof permission.role === "string" && permission.role.length > 0 && permission.role.length <= 128 &&
                validOptionalString(permission.email_address, 320) && validOptionalString(permission.domain, 320) &&
                (permission.allow_file_discovery === null || typeof permission.allow_file_discovery === "boolean") &&
                validOptionalString(permission.expiration_time, 128) && typeof permission.deleted === "boolean" &&
                Array.isArray(permission.permission_details) && permission.permission_details.length <= 32 &&
                permission.permission_details.every(function (detail) {
                  return detail && validOptionalString(detail.permission_type, 128) &&
                    validOptionalString(detail.role, 128) &&
                    (detail.inherited === null || typeof detail.inherited === "boolean") &&
                    validOptionalString(detail.inherited_from, 512);
                });
            });
          if (review.command_id !== commandId || review.operation !== "google.drive.write.permissions.create" ||
              review.used_for_authority !== false || review.may_execute !== false ||
              review.notification_email_sent !== false || review.ownership_transfer !== false ||
              !isDigest(review.command_digest) || !isDigest(review.review_digest) ||
              !isDigest(review.request_payload_digest) || !isDigest(review.target_version_digest) ||
              !isDigest(review.operation_plan_binding_digest) || !isDigest(review.target_access_scope_digest) ||
              typeof review.file_id !== "string" || review.file_id.length === 0 || review.file_id.length > 512 ||
              typeof review.file_name !== "string" || review.file_name.length === 0 || review.file_name.length > 512 ||
              !Array.isArray(review.parent_ids) || review.parent_ids.length === 0 || review.parent_ids.length > 32 ||
              review.parent_ids.some(function (id) { return typeof id !== "string" || id.length === 0 || id.length > 512; }) ||
              !validOptionalString(review.drive_id, 512) || typeof review.file_version !== "string" ||
              review.file_version.length === 0 || review.file_version.length > 128 ||
              !validOptionalString(review.file_modified_time, 128) ||
              (review.file_shared !== null && typeof review.file_shared !== "boolean") ||
              (review.inherited_permissions_disabled !== null && typeof review.inherited_permissions_disabled !== "boolean") ||
              review.file_mime_type !== "text/plain" || review.target_access_scope_complete !== true || !validPermissions ||
              typeof review.recipient_email !== "string" || review.recipient_email.length === 0 || review.recipient_email.length > 320 ||
              (review.recipient_role !== "reader" && review.recipient_role !== "writer")) {
            throw new Error("Drive共有先・権限または対象版がこの承認要求へ結び付いていません");
          }
          view.replaceChildren();
          const heading = document.createElement("strong");
          heading.textContent = "Google Driveの個別ユーザー共有（text/plain）";
          view.appendChild(heading);
          [
            ["対象ファイル", review.file_name],
            ["ファイルID", review.file_id],
            ["共有ドライブID", review.drive_id === null ? "なし／個人Drive" : review.drive_id],
            ["現在版", review.file_version],
            ["親フォルダーID", review.parent_ids.join(", ")],
            ["現在の共有状態", review.file_shared === null ? "不明" : review.file_shared ? "共有あり" : "共有なし"],
            ["付与する宛先", review.recipient_email],
            ["付与する権限", review.recipient_role === "reader" ? "閲覧者" : "編集者"],
            ["通知メール", "送信しない"],
            ["所有権移転", "しない"],
            ["アクセス範囲digest", review.target_access_scope_digest],
            ["対象版digest", review.target_version_digest],
            ["Operation Plan束縛digest", review.operation_plan_binding_digest]
          ].forEach(function (field) {
            const row = document.createElement("p");
            const label = document.createElement("strong");
            label.textContent = field[0] + ": ";
            const value = document.createElement("span");
            value.textContent = field[1];
            row.append(label, value);
            view.appendChild(row);
          });
          const scopeHeading = document.createElement("strong");
          scopeHeading.textContent = "対象ファイルに取得できた全アクセス権限（" + review.permissions.length + "件）";
          view.appendChild(scopeHeading);
          review.permissions.forEach(function (permission) {
            const item = document.createElement("p");
            const principal = permission.type === "anyone" ? "全員（公開範囲）" :
              permission.type === "domain" ? "ドメイン " + (permission.domain || "不明") :
                permission.type === "group" ? "グループ " + (permission.email_address || "不明") :
                  "ユーザー " + (permission.email_address || "不明");
            const detail = permission.permission_details.map(function (entry) {
              return (entry.inherited === null ? "継承状態不明" : entry.inherited ? "親から継承" : "直接付与") +
                (entry.role ? "・" + entry.role : "") + (entry.inherited_from ? "・継承元 " + entry.inherited_from : "");
            }).join("、");
            item.textContent = principal + " / 権限=" + permission.role +
              (permission.expiration_time ? " / 期限=" + permission.expiration_time : "") +
              (permission.deleted ? " / 削除済み権限" : "") + (detail ? " / " + detail : "");
            view.appendChild(item);
          });
          const note = document.createElement("p");
          note.className = "muted";
          note.textContent = "この操作は宛先ユーザーへDriveアクセスを付与します。承認直前と要求直前に対象・既存アクセス範囲を再取得し、読取が不完全または変化していれば停止します。Google Drive APIに同一ファイルへの並行権限変更を原子的に防ぐ条件はなく、最終照合直後の別writerとの競合は排除できません。付与要求後は応答と権限範囲を再読取し、結果不明時に自動再送しません。確認内容は保存されず、この確認表示は権限判断の代行をしません。";
          view.appendChild(note);
          const digests = document.createElement("small");
          digests.textContent = "command digest: " + review.command_digest + " | review digest: " + review.review_digest;
          view.appendChild(digests);
          state.approvalContentDigests[commandId] = review.review_digest;
          approve.disabled = false;
          button.textContent = "対象・宛先・アクセス範囲を再確認";
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
            (review.cc !== undefined && typeof review.cc !== "string") ||
            (review.bcc !== undefined && typeof review.bcc !== "string") ||
            (review.reply_to !== undefined && typeof review.reply_to !== "string") ||
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
        const attachments = document.createElement("p");
        attachments.textContent = "添付：なし（この候補経路では添付を扱いません）";
        view.appendChild(attachments);
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
        if (target.dataset.operationPlanCalendarNewTask === "true") {
          const operation = target.dataset.calendarOperation === "event.invite" ? "event.invite" : "event.create";
          const input = byId("owner-task-intent");
          input.value = [
            "新しい別taskです。前のGoogle Calendar " + operation + " は結果不明のまま停止しています。",
            "前のevent.createまたはevent.inviteを再実行・再送しないでください。保存された読取観測は非権威の参考情報で、成功・失敗や招待メール到達を証明しません。",
            "Calendar書込みや外部送信を含めず、安全な読取確認または終了方法だけを計画候補にしてください。"
          ].join("\\n");
          setActiveScreen("conversation");
          input.focus();
          appendChat("status", "別task用の文面を入力欄へ準備しました。確認・編集し、owner taskとして明示送信してください。まだ送信も作用もしていません。");
          return;
        }
        if (target.dataset.operationPlanReconcile === "true") {
          target.disabled = true;
          try {
            await invokeReceiptReconciliation(target.dataset.planId || "", target.dataset.revisionDigest || "", target.dataset.stepId || "",
              target.dataset.ownerAuthenticationRequired === "true");
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanResumeWait === "true") {
          target.disabled = true;
          const container = target.closest(".trace-item");
          const responseInput = container && container.querySelector("[data-operation-plan-resume-input]");
          try {
            await invokeInterruptedOperationPlanWait(target.dataset.waitId || "", responseInput?.value || "",
              target.dataset.ownerAuthenticationRequired === "true", target.dataset.ownerReauthenticationBinding || "");
            if (responseInput) responseInput.value = "";
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanWait === "true") {
          target.disabled = true;
          const container = target.closest(".trace-item");
          const hoursInput = container && container.querySelector("[data-operation-plan-wait-hours]");
          try {
            const hours = hoursInput instanceof HTMLInputElement ? Number(hoursInput.value) : NaN;
            await invokeOperationPlanWait(target.dataset.planId || "", target.dataset.revisionDigest || "", hours);
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanWaitReply === "true") {
          target.disabled = true;
          const container = target.closest(".trace-item");
          const responseInput = container && container.querySelector("[data-operation-plan-wait-reply-input]");
          try {
            await replyToOperationPlanWait(target.dataset.planId || "", target.dataset.revisionDigest || "",
              responseInput?.value || "");
            if (responseInput) responseInput.value = "";
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanExplicitFileEdit === "true") {
          target.disabled = true;
          const container = target.closest(".trace-item");
          const stepId = target.dataset.stepId || "";
          const findStepField = function (attribute) {
            return container
              ? Array.from(container.querySelectorAll("[" + attribute + "]"))
                .find((input) => input.getAttribute(attribute) === stepId)
              : undefined;
          };
          const pathInput = findStepField("data-operation-plan-edit-path");
          const searchInput = findStepField("data-operation-plan-edit-search");
          const replaceInput = findStepField("data-operation-plan-edit-replace");
          const countInput = findStepField("data-operation-plan-edit-count");
          const emptyReplacementInput = findStepField("data-operation-plan-edit-empty-replacement");
          const editRequest = {
            path: pathInput?.value || "",
            search: searchInput?.value || "",
            replace: replaceInput?.value || "",
            expectedReplacements: Number(countInput?.value ?? "1"),
            emptyReplacementConfirmed: emptyReplacementInput?.checked === true,
          };
          try {
            await invokeOperationPlanReplan(target.dataset.planId || "", target.dataset.revisionDigest || "",
              stepId, target.dataset.goalPurposeBinding || "", false, false, editRequest);
            if (pathInput) pathInput.value = "";
            if (searchInput) searchInput.value = "";
            if (replaceInput) replaceInput.value = "";
            if (countInput) countInput.value = "1";
            if (emptyReplacementInput) emptyReplacementInput.checked = false;
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanReplan === "true") {
          target.disabled = true;
          try {
            await invokeOperationPlanReplan(target.dataset.planId || "", target.dataset.revisionDigest || "",
              target.dataset.stepId || "", target.dataset.goalPurposeBinding || "",
              target.dataset.ownerSelectedFileState === "true", target.dataset.recoveryEdit === "true");
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanGmailDraft === "true") {
          target.disabled = true;
          try {
            await invokeOperationPlanReplan(target.dataset.planId || "", target.dataset.revisionDigest || "",
              target.dataset.stepId || "", target.dataset.goalPurposeBinding || "", false, false, undefined,
              target.dataset.selectedGmailMessageIdentity || "");
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanResult === "true") {
          target.disabled = true;
          try {
            await invokeOperationPlanResult(target.dataset.planId || "", target.dataset.revisionDigest || "",
              target.dataset.stepId || "", target.dataset.ownerAuthenticationRequired === "true",
              target.dataset.ownerReauthenticationBinding || "");
          } catch (error) {
            appendChat("error", error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
        if (target.dataset.operationPlanReview === "true") {
          target.disabled = true;
          try {
            await invokeOperationPlanReview(target.dataset.planId || "", target.dataset.revisionDigest || "",
              target.dataset.stepId || "", target.dataset.goalPurposeBinding || "",
              target.dataset.ownerAuthenticationRequired === "true", target.dataset.ownerReauthenticationBinding || "");
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
        const cancelExecutionId = target.dataset.cancelExecution;
        const reviewCommandId = target.dataset.reviewContent;
        const revokeGrantId = target.dataset.revokeGrant;
        if (cancelExecutionId) {
          target.disabled = true;
          try {
            await requestTaskCancellation(cancelExecutionId);
          } catch (error) {
            const status = byId("execution-cancel-status");
            status.textContent = error.message;
            status.className = "badge bad";
            alert(error.message);
          } finally {
            target.disabled = false;
          }
          return;
        }
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
      byId("load-owner-task-goals").addEventListener("click", function () {
        loadOwnerTaskGoals().catch(function (error) {
          const status = byId("owner-task-status");
          status.textContent = error.message || "委任目的を読み込めませんでした";
          status.className = "badge bad";
          byId("owner-task-token").value = "";
        });
      });
      byId("submit-owner-task").addEventListener("click", function () {
        submitOwnerTask().catch(function (error) {
          const status = byId("owner-task-status");
          status.textContent = error.message || "仕事を送信できませんでした";
          status.className = error.message && error.message.includes("委任目的") ? "badge warn" : "badge bad";
          byId("owner-task-token").value = "";
        });
      });
      byId("owner-task-new-submission").addEventListener("click", function () {
        const confirmed = window.confirm(
          "Tasks／Runtimeで先行依頼の状態を確認し、同じ仕事の重複実行にならないと判断した場合だけ、新しい依頼IDへ切り替えてください。続行しますか？");
        if (!confirmed) return;
        clearOwnerTaskSubmissionId();
        const status = byId("owner-task-status");
        status.textContent = "新しい依頼IDを用意しました。先行依頼との重複がないことを確認した場合だけ再送してください。";
        status.className = "badge warn";
      });
      byId("check-owner-task-status").addEventListener("click", function () {
        checkOwnerTaskSubmissionStatus().catch(function (error) {
          const status = byId("owner-task-status");
          status.textContent = error.message || "依頼状態を確認できませんでした";
          status.className = "badge bad";
        });
      });
      byId("owner-task-status-submission-id").addEventListener("change", function () {
        byId("owner-task-new-submission").hidden = true;
        const submissionId = ownerTaskStatusSubmissionId();
        if (!submissionId) return;
        const status = byId("owner-task-status");
        status.textContent = "依頼ID · " + submissionId.slice(-12) + " を選択しました。owner tokenを入力して状態を再確認してください。";
        status.className = "badge warn";
      });
      byId("owner-task-token").addEventListener("input", function () {
        byId("owner-task-new-submission").hidden = true;
      });
      byId("runtime-token").addEventListener("input", function () {
        byId("owner-task-new-submission").hidden = true;
      });
      try {
        const storedSubmissionId = sessionStorage.getItem("blue-tanuki.owner-task-submission-id.v1");
        if (typeof storedSubmissionId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedSubmissionId)) {
          ownerTaskSubmissionIdMemory = storedSubmissionId;
          byId("owner-task-new-submission").hidden = true;
          const status = byId("owner-task-status");
          status.textContent = "保存済みIDを再送防止IDとして復元しました。先にowner tokenで受付とRuntime状態を照会してください。通信結果が不明な間は同じIDを維持します。";
          status.className = "badge warn";
        } else if (ownerTaskStatusSubmissionId()) {
          ownerTaskSubmissionIdMemory = ownerTaskStatusSubmissionId();
          const status = byId("owner-task-status");
          status.textContent = "保存済みの依頼IDを再送防止IDとして復元しました。先にowner tokenで受付とRuntime状態を照会してください。task本文・結果・tokenは保存していません。";
          status.className = "badge warn";
        }
        renderOwnerTaskStatusSubmissionIds(ownerTaskStatusSubmissionId());
      } catch { /* status recovery remains available when session storage works */ }
      byId("load-goal-purpose-candidates").addEventListener("click", function () {
        loadGoalPurposeCandidates().catch(function () {
          const status = byId("goal-purpose-submit-status");
          status.textContent = "candidate load failed";
          status.className = "badge bad";
          byId("goal-purpose-owner-token").value = "";
        });
      });
      byId("goal-purpose-candidate").addEventListener("change", selectGoalPurposeCandidate);
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
      for (const id of ["settings-provider", "settings-model", "settings-endpoint", "settings-api-key",
        "settings-site-url", "settings-app-title", "settings-max-tokens", "settings-timeout-ms",
        "settings-provider-cost-profiles", "settings-compute-budget-policy"]) {
        byId(id).addEventListener("input", invalidateSettingsComputeReadiness);
        byId(id).addEventListener("change", invalidateSettingsComputeReadiness);
      }
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
