export function renderControlCenterHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BLUE-TANUKI Control Center</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #11110f;
        --panel: #181715;
        --panel-2: #211f1a;
        --panel-3: #2a281f;
        --line: #464135;
        --text: #f7f3ea;
        --muted: #b5ad9d;
        --good: #54d79b;
        --warn: #f2bf5d;
        --bad: #ff766f;
        --review: #caa6ff;
        --accent: #66d1c1;
        --accent-2: #f0a94a;
        --ink: #0f1210;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family:
          Inter,
          ui-sans-serif,
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        font-size: 14px;
        letter-spacing: 0;
        line-height: 1.45;
      }

      button,
      input,
      textarea {
        font: inherit;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 20px;
        border-bottom: 1px solid var(--line);
        background: #15130f;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .tanuki-mark {
        width: 42px;
        height: 42px;
        flex: 0 0 auto;
      }

      .screen-tabs {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 8px;
        min-width: 0;
        padding: 10px 14px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
        background: #15130f;
        overflow: visible;
      }

      button.screen-tab {
        min-width: 0;
        min-height: 32px;
        padding: 6px 10px;
        border-radius: 8px;
        color: var(--muted);
      }

      button.screen-tab.active,
      button.screen-tab[aria-selected="true"] {
        border-color: rgba(102, 209, 193, 0.65);
        background: #19302c;
        color: var(--accent);
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 18px;
        font-weight: 760;
      }

      h2 {
        font-size: 14px;
        font-weight: 720;
      }

      h3 {
        font-size: 13px;
        font-weight: 700;
      }

      .muted {
        color: var(--muted);
      }

      .mono {
        font-family:
          "SFMono-Regular",
          Consolas,
          "Liberation Mono",
          monospace;
      }

      .shell {
        display: grid;
        grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(320px, 430px);
        min-height: calc(100vh - 110px);
      }

      nav,
      aside {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
        padding: 14px;
        border-right: 1px solid var(--line);
        background: #101720;
        overflow-y: auto;
      }

      aside {
        border-right: 0;
        border-left: 1px solid var(--line);
      }

      main {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 14px;
        padding: 18px;
        overflow-y: auto;
      }

      .card {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      [data-screen-group][hidden] {
        display: none;
      }

      .dashboard-hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
        gap: 12px;
        align-items: stretch;
      }

      .hero-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        justify-content: center;
        gap: 10px;
      }

      .hero-title {
        font-size: 24px;
        line-height: 1.18;
      }

      .tanuki-panel {
        display: grid;
        min-height: 170px;
        place-items: center;
        border: 1px solid #5a4d35;
        border-radius: 8px;
        background:
          linear-gradient(135deg, rgba(84, 215, 155, 0.14), rgba(240, 169, 74, 0.12)),
          #17150f;
      }

      .tanuki-panel svg {
        width: min(180px, 72%);
        height: auto;
      }

      .screen-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .screen-card {
        display: grid;
        gap: 8px;
        min-width: 0;
        padding: 10px;
        border: 1px solid #383428;
        border-radius: 8px;
        background: var(--panel-2);
      }

      .lane-board {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      .lane {
        display: grid;
        gap: 8px;
        min-height: 126px;
        padding: 10px;
        border: 1px solid #383428;
        border-radius: 8px;
        background: #141813;
      }

      .map-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 8px;
      }

      .map-node {
        min-width: 0;
        padding: 9px;
        border: 1px solid #3a4538;
        border-radius: 8px;
        background: #151d17;
        text-align: center;
        overflow-wrap: anywhere;
      }

      .readonly-note {
        border-color: rgba(84, 215, 155, 0.45);
        color: var(--good);
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }

      .metric,
      .state-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
        padding: 8px 9px;
        border: 1px solid #273444;
        border-radius: 8px;
        background: var(--panel-2);
      }

      .metric span:first-child,
      .state-row span:first-child {
        min-width: 0;
        color: var(--muted);
      }

      .metric span:last-child,
      .state-row span:last-child {
        min-width: 0;
        overflow-wrap: anywhere;
        text-align: right;
        font-weight: 650;
      }

      .status-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        max-width: 100%;
        padding: 3px 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel-3);
        color: var(--text);
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .badge.good {
        border-color: rgba(95, 224, 165, 0.5);
        color: var(--good);
      }

      .badge.warn {
        border-color: rgba(255, 209, 102, 0.5);
        color: var(--warn);
      }

      .badge.bad {
        border-color: rgba(255, 111, 125, 0.5);
        color: var(--bad);
      }

      .badge.review {
        border-color: rgba(215, 167, 255, 0.6);
        color: var(--review);
      }

      .policy-row,
      .action-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      label.policy {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 142px;
        flex: 1;
        padding: 9px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-2);
      }

      input[type="password"],
      input[type="text"],
      textarea {
        width: 100%;
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #0e141c;
        color: var(--text);
        padding: 8px 10px;
      }

      textarea {
        min-height: 74px;
        resize: vertical;
      }

      button {
        min-height: 34px;
        min-width: 74px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-3);
        color: var(--text);
        cursor: pointer;
      }

      button.primary {
        border-color: rgba(116, 185, 255, 0.55);
        color: var(--accent);
      }

      button.danger {
        border-color: rgba(255, 111, 125, 0.55);
        color: var(--bad);
      }

      button:hover {
        border-color: var(--accent);
      }

      .log {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .msg {
        max-width: 860px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      .msg.system {
        border-color: rgba(116, 185, 255, 0.5);
      }

      .queue-list,
      .chat-log,
      .notification-list,
      .schedule-list,
      .history-list,
      .trace-list,
      .audit-list {
        display: grid;
        gap: 8px;
      }

      .queue-item,
      .chat-item,
      .notification-item,
      .schedule-item,
      .history-item,
      .trace-item,
      .audit-item {
        display: grid;
        gap: 8px;
        min-width: 0;
        padding: 10px;
        border: 1px solid #2b394a;
        border-radius: 8px;
        background: #111923;
      }

      .chat-log {
        max-height: 360px;
        overflow: auto;
      }

      .kv {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        gap: 6px 10px;
        min-width: 0;
      }

      .kv dt {
        color: var(--muted);
      }

      .kv dd {
        margin: 0;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      pre {
        max-height: 240px;
        min-height: 44px;
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 10px;
        border: 1px solid #273444;
        border-radius: 8px;
        background: #0e141c;
        color: #dce6f2;
        font-size: 12px;
      }

      @media (max-width: 1120px) {
        .shell {
          grid-template-columns: minmax(210px, 270px) minmax(0, 1fr);
        }

        .dashboard-hero,
        .lane-board {
          grid-template-columns: 1fr;
        }

        aside {
          grid-column: 1 / -1;
          border-left: 0;
          border-top: 1px solid var(--line);
        }
      }

      @media (max-width: 760px) {
        header,
        .shell,
        .shell > nav,
        main,
        aside {
          display: block;
        }

        header {
          padding: 12px;
        }

        .shell > nav,
        main,
        aside {
          padding: 12px;
          border-left: 0;
          border-right: 0;
        }

        .screen-tabs {
          display: flex;
        }

        .shell > nav,
        main {
          border-bottom: 1px solid var(--line);
        }

        .status-grid {
          grid-template-columns: 1fr;
        }

        .screen-grid,
        .map-grid {
          grid-template-columns: 1fr;
        }

        .kv {
          grid-template-columns: 92px minmax(0, 1fr);
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <svg class="tanuki-mark" viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="62" r="42" fill="#d6a35b" />
          <path d="M25 40 L42 13 L55 39 Z" fill="#7a5330" />
          <path d="M95 40 L78 13 L65 39 Z" fill="#7a5330" />
          <ellipse cx="42" cy="58" rx="17" ry="14" fill="#2c2117" />
          <ellipse cx="78" cy="58" rx="17" ry="14" fill="#2c2117" />
          <circle cx="45" cy="56" r="5" fill="#f7f3ea" />
          <circle cx="75" cy="56" r="5" fill="#f7f3ea" />
          <ellipse cx="60" cy="73" rx="12" ry="9" fill="#2c2117" />
          <path d="M48 88 Q60 98 72 88" fill="none" stroke="#2c2117" stroke-width="5" stroke-linecap="round" />
        </svg>
        <div>
          <h1>BLUE-TANUKI Control Center</h1>
          <p class="muted">owner-facing resident AI operations console</p>
        </div>
        <span id="header-status" class="badge warn">not loaded</span>
      </div>
      <span class="badge">HDS-BRAIN owns authority</span>
    </header>

    <nav class="screen-tabs" aria-label="Owner operation screens">
      <button class="screen-tab active" data-screen="home" aria-selected="true">Home</button>
      <button class="screen-tab" data-screen="conversation" aria-selected="false">Conversation / WebChat</button>
      <button class="screen-tab" data-screen="tasks" aria-selected="false">Tasks</button>
      <button class="screen-tab" data-screen="approvals" aria-selected="false">Approvals</button>
      <button class="screen-tab" data-screen="activity" aria-selected="false">Activity / Audit</button>
      <button class="screen-tab" data-screen="memory" aria-selected="false">Memory</button>
      <button class="screen-tab" data-screen="skills" aria-selected="false">Skills</button>
      <button class="screen-tab" data-screen="channels" aria-selected="false">Channels</button>
      <button class="screen-tab" data-screen="doctor" aria-selected="false">Doctor</button>
      <button class="screen-tab" data-screen="settings" aria-selected="false">Settings</button>
      <button class="screen-tab" data-screen="developer" aria-selected="false">Developer / Evidence</button>
    </nav>

    <div class="shell">
      <nav aria-label="Control Center status">
        <section class="card">
          <h2>Permanent-Use Status</h2>
          <div id="permanent-use-status" class="status-grid">
            <div class="state-row"><span>Gateway</span><span>not loaded</span></div>
            <div class="state-row"><span>HDS</span><span>not loaded</span></div>
            <div class="state-row"><span>Audit</span><span>not loaded</span></div>
            <div class="state-row"><span>Approvals</span><span>not loaded</span></div>
          </div>
        </section>

        <section class="card">
          <h2>First-Run Next Action</h2>
          <div class="metric">
            <span>Next</span>
            <span id="first-run-next-action">not loaded</span>
          </div>
        </section>

        <section class="card">
          <h2>Approval Policy</h2>
          <div class="policy-row">
            <label class="policy"><input type="radio" name="policy" checked /> suggest</label>
            <label class="policy"><input type="radio" name="policy" /> review-only</label>
          </div>
          <div class="metric">
            <span>Final Review</span>
            <span id="policy-final-review">required</span>
          </div>
        </section>

        <section class="card">
          <h2>Runtime Snapshot</h2>
          <div class="metric"><span>Gateway</span><span id="gateway-status">not loaded</span></div>
          <div class="metric"><span>HDS Invariants</span><span id="runtime-invariant">not loaded</span></div>
          <div class="metric"><span>Audit Chain</span><span id="runtime-audit">not loaded</span></div>
          <input id="runtime-token" type="password" autocomplete="off" placeholder="webchat token" />
          <button id="load-runtime" class="primary">Load</button>
        </section>

        <section class="card">
          <h2>Scheduled Tasks / Runtime Schedules</h2>
          <div class="metric"><span>Configured</span><span id="schedule-count">not loaded</span></div>
          <div class="metric"><span>Active</span><span id="schedule-active-count">not loaded</span></div>
          <div class="metric"><span>Pending</span><span id="schedule-pending-count">not loaded</span></div>
        </section>
      </nav>

      <main>
        <section class="card dashboard-hero" data-screen-group="home">
          <div class="hero-copy">
            <span class="badge good">GUI Shell responsibility substrate mapped to BLUE-TANUKI</span>
            <h2 class="hero-title">Tanuki Dashboard</h2>
            <p class="muted">This console turns HDS-BRAIN decisions, approvals, audit evidence, recovery hints, channels, memory, and operator surfaces into owner-visible state. UI state is display and intent only; it never becomes authority.</p>
            <div class="policy-row">
              <span class="badge readonly-note">UI state is not authority</span>
              <span class="badge readonly-note">LLM output is not authority</span>
              <span class="badge readonly-note">Memory is not authority</span>
              <span class="badge readonly-note">Channel metadata is not authority</span>
            </div>
          </div>
          <div class="tanuki-panel" aria-label="BLUE-TANUKI mascot panel">
            <svg viewBox="0 0 240 190" role="img" aria-label="BLUE-TANUKI operations mascot">
              <rect x="16" y="116" width="212" height="42" rx="8" fill="#252116" />
              <circle cx="120" cy="82" r="58" fill="#d9a95f" />
              <path d="M60 48 L83 10 L103 55 Z" fill="#7b542e" />
              <path d="M180 48 L157 10 L137 55 Z" fill="#7b542e" />
              <ellipse cx="91" cy="76" rx="29" ry="21" fill="#2a2118" />
              <ellipse cx="149" cy="76" rx="29" ry="21" fill="#2a2118" />
              <circle cx="96" cy="72" r="8" fill="#f7f3ea" />
              <circle cx="144" cy="72" r="8" fill="#f7f3ea" />
              <ellipse cx="120" cy="99" rx="18" ry="13" fill="#2a2118" />
              <path d="M101 121 Q120 136 139 121" fill="none" stroke="#2a2118" stroke-width="8" stroke-linecap="round" />
              <path d="M52 154 H188" stroke="#66d1c1" stroke-width="7" stroke-linecap="round" />
              <circle cx="64" cy="154" r="6" fill="#54d79b" />
              <circle cx="120" cy="154" r="6" fill="#f2bf5d" />
              <circle cx="176" cy="154" r="6" fill="#caa6ff" />
            </svg>
          </div>
        </section>

        <section class="card" data-screen-group="home conversation">
          <div class="row">
            <h2>Conversation / WebChat</h2>
            <span id="chat-status" class="badge warn">not connected</span>
          </div>
          <div class="status-grid">
            <input id="chat-token" type="password" autocomplete="off" placeholder="webchat token" />
            <input id="chat-user" type="text" autocomplete="off" placeholder="user" />
          </div>
          <textarea id="chat-content" autocomplete="off" placeholder="message"></textarea>
          <div class="action-row">
            <button id="connect-chat" class="primary">Connect</button>
            <button id="send-chat" class="primary">Send</button>
            <button id="disconnect-chat">Disconnect</button>
          </div>
          <div id="chat-log" class="chat-log">
            <article class="chat-item muted">no conversation messages yet</article>
          </div>
        </section>

        <section class="card" data-screen-group="home developer">
          <h2>Responsibility Map</h2>
          <div class="map-grid">
            <div class="map-node">Runtime</div>
            <div class="map-node">Capability</div>
            <div class="map-node">Approval</div>
            <div class="map-node">Audit</div>
            <div class="map-node">Recovery</div>
          </div>
          <p class="muted">Sensitive actions must remain mapped across capability, approval state, audit event, and recovery action before execution.</p>
        </section>

        <section class="card" data-screen-group="tasks">
          <div class="row">
            <h2>Tasks</h2>
            <span class="badge review">state model</span>
          </div>
          <div class="lane-board">
            <div class="lane"><h3>Pending / Waiting Approval</h3><p class="muted">Commands waiting for owner review, schedule approval, or final-review confirmation.</p><span class="badge review">approval-gated</span></div>
            <div class="lane"><h3>Running / Blocked</h3><p class="muted">Runtime work that is executing, suspended, failed, or waiting on recovery preconditions.</p><span class="badge warn">observed only</span></div>
            <div class="lane"><h3>Completed / Audited</h3><p class="muted">Finished work is shown with digest, command id, audit state, and replay metadata.</p><span class="badge good">evidence only</span></div>
          </div>
        </section>

        <section class="card" data-screen-group="memory">
          <div class="row">
            <h2>Memory</h2>
            <span class="badge good">reference only</span>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>Long-term Memory</h3><p class="muted">Preferences, summaries, and F-reference hints may be displayed as context, not authority.</p></div>
            <div class="screen-card"><h3>Complete History</h3><p class="muted">Replay entries expose digests and metadata only. Raw payloads and rendered output are not projected.</p></div>
            <div class="screen-card"><h3>Deletion / Forgetting</h3><p class="muted">Future deletion operations are sensitive and must pass policy, approval, audit, and recovery mapping.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">Memory hits cannot grant permission, infer consent, or resume suspended work.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="skills">
          <div class="row">
            <h2>Skills</h2>
            <span class="badge warn">review-gated</span>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>Installed</h3><p class="muted">Bundled operator surfaces load only after manifest and Plugin Review Gate checks.</p></div>
            <div class="screen-card"><h3>Under Review</h3><p class="muted">Third-party Layer B submissions require declared capabilities, conformance evidence, and no authority bypass.</p></div>
            <div class="screen-card"><h3>Disabled / Quarantined</h3><p class="muted">Unsafe or incomplete surfaces remain preview, disabled, or rejected.</p></div>
            <div class="screen-card"><h3>Forbidden Shortcut</h3><p class="muted">Skill metadata cannot become authority or silently widen permissions.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="channels">
          <div class="row">
            <h2>Channels</h2>
            <span class="badge good">input/output surfaces</span>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>First-party</h3><p class="muted">WebChat and Telegram are selected owner-operation channels.</p></div>
            <div class="screen-card"><h3>Preview</h3><p class="muted">Slack, Discord, Teams, and LINE require owner evidence before promotion.</p></div>
            <div class="screen-card"><h3>Reserved Third-party</h3><p class="muted">WhatsApp remains outside first-party core.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">Channel metadata is normalized and cannot escalate permission.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="doctor">
          <div class="row">
            <h2>Doctor</h2>
            <span class="badge warn">next-action loop</span>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Runtime</span><span id="doctor-runtime-status">not loaded</span></div>
            <div class="metric"><span>WebChat</span><span id="doctor-webchat-ready">not loaded</span></div>
            <div class="metric"><span>LLM backend</span><span id="doctor-llm-backend">stub available</span></div>
            <div class="metric"><span>Audit</span><span id="doctor-audit-status">not loaded</span></div>
            <div class="metric"><span>Installer mode</span><span id="doctor-installer-mode">source or package</span></div>
            <div class="metric"><span>Next action</span><span id="doctor-next-action">not loaded</span></div>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>Setup Checks</h3><p class="muted">Node, pnpm, tokens, ports, provider config, channel credentials, and root paths are checked by doctor.</p></div>
            <div class="screen-card"><h3>Safe Failure</h3><p class="muted">Required credential errors are not safe to ignore. Missing optional preview credentials remain warnings.</p></div>
            <div class="screen-card"><h3>Recovery</h3><p class="muted">Each failure should answer what failed, why, safety impact, next action, retryability, and changed state.</p></div>
            <div class="screen-card"><h3>Evidence Scope</h3><p class="muted">Doctor output is diagnostic evidence, not release readiness by itself.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="settings">
          <div class="row">
            <h2>Settings</h2>
            <span class="badge review">mutation requires gate</span>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>LLM Provider</h3><p class="muted">Provider verification is non-mutating unless explicit save is requested through the settings surface.</p></div>
            <div class="screen-card"><h3>Approval Mode</h3><p class="muted">Full access may allow L1/L2, but never L3 final-review operations.</p></div>
            <div class="screen-card"><h3>Memory Policy</h3><p class="muted">Policy changes are sensitive and must not be inferred from UI state.</p></div>
            <div class="screen-card"><h3>Credential Handling</h3><p class="muted">Tokens are not displayed, copied into history, or saved by mock UI state.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="developer">
          <div class="row">
            <h2>Developer / Evidence</h2>
            <span class="badge good">validation surface</span>
          </div>
          <div class="screen-grid">
            <div class="screen-card"><h3>Repo Health</h3><p class="muted">Import graph and release-path purity checks protect production runtime boundaries.</p></div>
            <div class="screen-card"><h3>Conformance</h3><p class="muted">Negative tests prove metadata, memory, UI state, and LLM output cannot create authority.</p></div>
            <div class="screen-card"><h3>Release Gates</h3><p class="muted">GA requires technical validation plus explicit owner GO; pre-GO public claim remains false.</p></div>
            <div class="screen-card"><h3>Evidence Source</h3><p class="muted">CONFIG, INTERNAL_STATE, LIVE_RUNTIME, EXTERNAL_EVIDENCE, and FIXTURE must not be conflated.</p></div>
          </div>
        </section>

        <section class="log" data-screen-group="home" aria-live="polite">
          <article class="msg system">
            <h2>System</h2>
            <p class="muted">Resident status, approval gates, schedule state, authority trace, and audit chain are surfaced without command content or credential values.</p>
          </article>
          <article class="msg">
            <h2>Approval Model</h2>
            <p class="muted">L3 and final-review work remains a one-time operator decision. The console only submits explicit approve, reject, or block verdicts.</p>
          </article>
        </section>

        <section class="card" data-screen-group="home">
          <div class="row">
            <h2>Notification Center</h2>
            <span id="notification-summary" class="badge warn">not loaded</span>
          </div>
          <input id="notifications-token" type="password" autocomplete="off" placeholder="webchat token" />
          <button id="load-notifications" class="primary">Load</button>
          <div id="notification-list" class="notification-list"></div>
        </section>

        <section class="card" data-screen-group="approvals">
          <div class="row">
            <h2>Approval Queue</h2>
            <span id="approval-summary" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Pending</span><span id="approval-count">not loaded</span></div>
            <div class="metric"><span>Final Review</span><span id="approval-final-review-count">not loaded</span></div>
            <div class="metric"><span>ApprovalLevel</span><span id="approval-level-scope">not loaded</span></div>
            <div class="metric"><span>Token expiry</span><span id="approval-token-expiry">not loaded</span></div>
          </div>
          <input id="approval-token" type="password" autocomplete="off" placeholder="resume token" />
          <button id="load-approvals" class="primary">Load</button>
          <div id="approval-list" class="queue-list"></div>
        </section>

        <section class="card" data-screen-group="tasks">
          <div class="row">
            <h2>Runtime Schedules</h2>
            <span id="schedule-summary" class="badge warn">not loaded</span>
          </div>
          <div id="runtime-schedule-list" class="schedule-list"></div>
        </section>

        <section class="card" data-screen-group="activity memory">
          <div class="row">
            <h2>Complete History / Replay</h2>
            <span id="history-summary" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Entries</span><span id="history-entry-count">not loaded</span></div>
            <div class="metric"><span>Chain Valid</span><span id="history-chain-valid">not loaded</span></div>
            <div class="metric"><span>Authority</span><span id="history-authority-use">not loaded</span></div>
            <div class="metric"><span>Skipped</span><span id="history-skipped-count">not loaded</span></div>
          </div>
          <input id="history-token" type="password" autocomplete="off" placeholder="webchat token" />
          <div class="action-row">
            <input id="history-kind" type="text" autocomplete="off" placeholder="kind filter" />
            <button id="load-history" class="primary">Load</button>
          </div>
          <div id="history-list" class="history-list"></div>
          <pre id="history-json">not loaded</pre>
        </section>

        <section class="card" data-screen-group="developer activity">
          <div class="row">
            <h2>Authority Trace</h2>
            <span id="authority-summary" class="badge warn">not loaded</span>
          </div>
          <input id="authority-token" type="password" autocomplete="off" placeholder="webchat token" />
          <button id="load-authority" class="primary">Load</button>
          <div id="authority-trace-list" class="trace-list"></div>
          <pre id="authority-json">not loaded</pre>
        </section>
      </main>

      <aside>
        <section class="card">
          <div class="row">
            <h2>Authority Audit</h2>
            <span id="audit-status" class="badge warn">not loaded</span>
          </div>
          <div class="metric"><span>Chain Valid</span><span id="audit-chain-valid">not loaded</span></div>
          <div class="metric"><span>Entries</span><span id="audit-entry-count">not loaded</span></div>
          <input id="audit-token" type="password" autocomplete="off" placeholder="webchat token" />
          <div class="action-row">
            <button id="load-audit" class="primary">Load Audit</button>
            <button id="verify-audit">Verify Chain</button>
          </div>
          <div id="audit-list" class="audit-list"></div>
          <pre id="audit-text">not loaded</pre>
        </section>

        <section class="card">
          <h2>Runtime Snapshot JSON</h2>
          <pre id="runtime-json">not loaded</pre>
        </section>

        <section class="card">
          <h2>Schedule Snapshot JSON</h2>
          <pre id="schedule-json">not loaded</pre>
        </section>

        <section class="card">
          <h2>Scope</h2>
          <div class="metric"><span>Gateway</span><span>telemetry only</span></div>
          <div class="metric"><span>Executor</span><span>not embedded</span></div>
          <div class="metric"><span>Memory</span><span>HDS only</span></div>
        </section>

        <section class="card">
          <h2>Final Review Remains</h2>
          <div class="metric"><span>L3</span><span>one-time gate</span></div>
          <div class="metric"><span>Full access</span><span>manual only</span></div>
        </section>

        <section class="card">
          <h2>HDS Memory Rule</h2>
          <div class="metric"><span>Allowed</span><span>mode / task / summary</span></div>
          <div class="metric"><span>Forbidden</span><span>credentials / secrets / raw content</span></div>
        </section>
      </aside>
    </div>

    <script>
      const state = {
        runtimeToken: sessionStorage.getItem("bt.runtimeToken") || "",
        approvalToken: sessionStorage.getItem("bt.approvalToken") || "",
        auditToken: sessionStorage.getItem("bt.auditToken") || "",
        authorityToken: sessionStorage.getItem("bt.authorityToken") || "",
        notificationsToken: sessionStorage.getItem("bt.notificationsToken") || "",
        historyToken: sessionStorage.getItem("bt.historyToken") || "",
        historyKind: sessionStorage.getItem("bt.historyKind") || "",
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
        const pending = Array.isArray(body.pending) ? body.pending : [];
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
        state.approvalTokens = Object.create(null);

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
      byId("load-audit").addEventListener("click", loadAuditText);
      byId("verify-audit").addEventListener("click", verifyAudit);
      byId("load-authority").addEventListener("click", loadAuthorityTrace);
      byId("load-history").addEventListener("click", loadHistory);
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
    </script>
  </body>
</html>`;
}
