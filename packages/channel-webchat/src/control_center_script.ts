export const CONTROL_CENTER_SCRIPT = `      const state = {
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
        activeScreen: sessionStorage.getItem("bt.activeScreen") || "home",
        chatSocket: null,
        approvalTokens: Object.create(null)
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

      function authHeaders(token) {
        return token ? { Authorization: "Bearer " + token } : {};
      }

      function setActiveScreen(screen) {
        const selected = screen || "home";
        state.activeScreen = selected;
        sessionStorage.setItem("bt.activeScreen", selected);
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

      async function fetchJson(path, token) {
        const response = await fetch(path, { headers: authHeaders(token) });
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

      function appendChat(kind, text) {
        const log = byId("chat-log");
        const item = document.createElement("article");
        item.className = "chat-item";
        item.innerHTML = '<div class="row"><h3>' + escapeHtml(kind) + '</h3><span class="badge good">WebChat</span></div><p>' + escapeHtml(text) + '</p>';
        if (log.querySelector(".muted")) log.innerHTML = "";
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
      }

      function setChatStatus(value, tone) {
        setText("chat-status", value);
        byId("chat-status").className = "badge " + (tone || "warn");
      }

      function disconnectChat() {
        if (state.chatSocket) {
          try { state.chatSocket.close(); } catch (_) { /* ignore */ }
        }
        state.chatSocket = null;
        setChatStatus("not connected", "warn");
      }

      async function connectChat() {
        state.chatToken = byId("chat-token").value.trim();
        state.chatUser = byId("chat-user").value.trim() || "owner";
        sessionStorage.setItem("bt.chatToken", state.chatToken);
        sessionStorage.setItem("bt.chatUser", state.chatUser);
        if (!state.chatToken) throw new Error("webchat token is required");
        disconnectChat();
        const ticket = await postJson("/ws-ticket", state.chatToken, { user: state.chatUser });
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(protocol + "://" + window.location.host + "/ws?ticket=" + encodeURIComponent(ticket.ticket));
        state.chatSocket = ws;
        setChatStatus("connecting", "warn");
        ws.addEventListener("open", function () {
          setChatStatus("connected", "good");
        });
        ws.addEventListener("message", function (event) {
          let frame = null;
          try { frame = JSON.parse(event.data); } catch (_) { frame = { kind: "message", content: String(event.data) }; }
          if (frame.kind === "hello") {
            appendChat("system", "connected as " + (frame.user || state.chatUser));
            return;
          }
          appendChat(frame.kind || "message", frame.content || compactJson(redactRuntimeValue(frame)));
        });
        ws.addEventListener("close", function () {
          if (state.chatSocket === ws) {
            state.chatSocket = null;
            setChatStatus("closed", "warn");
          }
        });
        ws.addEventListener("error", function () {
          setChatStatus("socket error", "bad");
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
        appendChat("owner", content);
        const result = await postJson("/inbound", state.chatToken, { user: state.chatUser, content });
        byId("chat-content").value = "";
        appendChat("accepted", result.request_id || "request accepted");
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

      function renderRuntime(body) {
        const invariantOk = body.hds_invariants_ok ?? body.hds?.invariants?.process_policy_enforced;
        const auditOk = body.audit_chain_valid ?? body.hds?.audit?.chain_valid;
        setText("gateway-status", body.gateway_status || "unknown");
        setText("runtime-invariant", labelForBoolean(invariantOk));
        setText("runtime-audit", labelForBoolean(auditOk));
        setText("first-run-next-action", body.next_recommended_action || "none");
        setText("doctor-runtime-status", body.gateway_status || "unknown");
        setText("doctor-webchat-ready", labelForBoolean(body.webchat_ready));
        setText("doctor-audit-status", labelForBoolean(auditOk));
        setText("doctor-next-action", body.next_recommended_action || "none");
        setText("doctor-installer-mode", body.webchat_ready ? "runtime ready" : "setup incomplete");
        setText("runtime-json", compactJson(redactRuntimeValue(body)));
        setText("header-status", body.gateway_status || "loaded");
        byId("header-status").className = "badge " + (body.gateway_status === "ready" ? "good" : "warn");
        updatePermanentUseStatus(body);
        renderSchedules(body);
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
              if (item.command_id && item.approval_token) {
                state.approvalTokens[item.command_id] = item.approval_token;
              }
              return '<article class="queue-item" data-command="' + escapeHtml(item.command_id || "") + '">' +
                '<div class="row"><h3>' + escapeHtml(item.operation || "unknown operation") + '</h3><span>' + finalBadge + '</span></div>' +
                '<dl class="kv">' +
                '<dt>command</dt><dd class="mono">' + escapeHtml(item.command_id || "unknown") + '</dd>' +
                '<dt>request</dt><dd class="mono">' + escapeHtml(item.request_id || "unknown") + '</dd>' +
                '<dt>risk</dt><dd>' + badge(item.risk || "unknown", riskTone) + '</dd>' +
              '<dt>ApprovalLevel</dt><dd>' + badge(level, level === "L3_final_review" ? "review" : "good") + '</dd>' +
                '<dt>expires</dt><dd>' + escapeHtml(formatDate(item.approval_token_expires_at_ms)) + '</dd>' +
                '<dt>reason</dt><dd>' + escapeHtml(item.reason || "not recorded") + '</dd>' +
                '</dl>' +
                '<pre>' + escapeHtml(authority) + '</pre>' +
                '<div class="action-row">' +
                '<button class="primary" data-verdict="approve" data-command="' + escapeHtml(item.command_id || "") + '">Approve</button>' +
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
                ["reason", entry.reason || "none"],
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
        setText("history-authority-use", authorityUsed ? "unsafe" : "display only");
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
                const authorityBadge = safe.used_for_authority === false ? badge("false", "good") : badge("unsafe", "bad");
                return '<article class="history-item"><dl class="kv">' +
                  '<dt>kind</dt><dd>' + escapeHtml(safe.kind || "unknown") + '</dd>' +
                  '<dt>request</dt><dd class="mono">' + escapeHtml(safe.request_id || "none") + '</dd>' +
                  '<dt>command</dt><dd class="mono">' + escapeHtml(safe.command_id || "none") + '</dd>' +
                  '<dt>actor</dt><dd>' + escapeHtml(safe.actor || "unknown") + '</dd>' +
                  '<dt>source</dt><dd>' + escapeHtml(safe.source || "unknown") + '</dd>' +
                  '<dt>payload</dt><dd class="mono">' + escapeHtml(safe.payload_digest || "not recorded") + '</dd>' +
                  '<dt>entry</dt><dd class="mono">' + escapeHtml(safe.entry_hash || "not recorded") + '</dd>' +
                  '<dt>authority</dt><dd>' + authorityBadge + '</dd>' +
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
        setText("evidence-authority-status", authorityOk ? "display only" : "unsafe");
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
        setText("composio-authority-status", composio.used_for_authority === true ? "unsafe" : "not authority");
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
        setText("about-authority", authority.hds_brain_owns_authority ? "HDS-BRAIN owns authority" : "unknown");
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
        setText("update-authority-status", authority.used_for_authority === true ? "unsafe" : "display only");
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

      function renderRecoverySnapshot(snapshot) {
        const envFile = snapshot.env_file || {};
        const packs = snapshot.recovery_backups || {};
        const restore = snapshot.restore || {};
        const authority = snapshot.authority_boundary || {};
        const paths = snapshot.runtime_paths || {};
        setText("recovery-env-file-status", envFile.exists ? "present" : envFile.configured ? "missing" : "not configured");
        setText("recovery-env-backup-count", envFile.backup_count ?? 0);
        setText("recovery-pack-count", packs.backup_count ?? 0);
        setText("recovery-latest-backup", packs.latest_backup_id || envFile.latest_backup_path || "none");
        if (packs.latest_backup_id) byId("recovery-backup-id").placeholder = packs.latest_backup_id;
        setText("recovery-restore-status", restore.execution_available ? "available" : "blocked");
        setText("recovery-factory-reset-status", restore.factory_reset_available ? "available" : "blocked");
        setText("recovery-authority-status", authority.used_for_authority === true ? "unsafe" : "display only");
        setText("recovery-next-action", snapshot.next_safe_action || "review recovery readiness");
        setText("recovery-boundary-status", snapshot.mode || "read only");
        byId("recovery-boundary-status").className = "badge " + (snapshot.mode === "control_available" ? "review" : "good");
        byId("recovery-restore-status").className = "badge " + (restore.execution_available ? "review" : "warn");
        byId("recovery-factory-reset-status").className = "badge " + (restore.factory_reset_available ? "review" : "warn");
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
        setText("recovery-action-status", result.action ? result.action + " completed" : "completed");
        byId("recovery-action-status").className = "badge review";
        setText("recovery-json", compactJson(redactRuntimeValue(result)));
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
        if (!window.confirm("Restore from the selected recovery backup?")) return;
        const backupId = byId("recovery-backup-id").value.trim();
        const body = { confirm: "RESTORE" };
        if (backupId) body.backup_id = backupId;
        await runRecoveryAction("/recovery/restore", body);
      }

      async function resetRecoveryProvider() {
        if (!window.confirm("Reset provider configuration to stub mode?")) return;
        await runRecoveryAction("/recovery/reset-provider", { confirm: "RESET_PROVIDER" });
      }

      async function resetRecoveryConnector() {
        if (!window.confirm("Reset connector credentials and live execution settings?")) return;
        await runRecoveryAction("/recovery/reset-connector", { confirm: "RESET_CONNECTOR" });
      }

      async function factoryResetRecovery() {
        if (!window.confirm("Factory reset local runtime state while preserving audit and backups?")) return;
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

      async function loadRuntime() {
        const token = byId("runtime-token").value.trim();
        state.runtimeToken = token;
        sessionStorage.setItem("bt.runtimeToken", token);
        try {
          const body = await fetchJson("/runtime/snapshot", token);
          renderRuntime(body);
        } catch (error) {
          setText("runtime-json", error.message);
          setText("header-status", "runtime error");
          byId("header-status").className = "badge bad";
        }
      }

      async function loadApprovals() {
        const token = byId("approval-token").value.trim();
        state.approvalToken = token;
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
          body: JSON.stringify({ verdict: verdict, approval_token: approvalToken })
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error("approval failed: HTTP " + response.status + " " + text);
        }
        await loadApprovals();
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
        const verdict = target.dataset.verdict;
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
          setChatStatus("error", "bad");
          appendChat("error", error.message);
        });
      });
      byId("send-chat").addEventListener("click", function () {
        sendChat().catch(function (error) {
          setChatStatus("error", "bad");
          appendChat("error", error.message);
        });
      });
      byId("disconnect-chat").addEventListener("click", disconnectChat);

      syncInputs();
      setActiveScreen(state.activeScreen);
`;
