import { CONTROL_CENTER_SCRIPT } from "./control_center_script.js";
import { CONTROL_CENTER_STYLE } from "./control_center_style.js";

export function renderControlCenterDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BLUE-TANUKI Control Center</title>
    <style>
${CONTROL_CENTER_STYLE}    </style>
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
      <button class="screen-tab" data-screen="conversation" aria-selected="false" title="Conversation / WebChat">Chat</button>
      <button class="screen-tab" data-screen="tasks" aria-selected="false">Tasks</button>
      <button class="screen-tab" data-screen="approvals" aria-selected="false">Approvals</button>
      <button class="screen-tab" data-screen="activity" aria-selected="false" title="Activity / Audit">Audit</button>
      <button class="screen-tab" data-screen="memory" aria-selected="false">Memory</button>
      <button class="screen-tab" data-screen="skills" aria-selected="false">Skills</button>
      <button class="screen-tab" data-screen="channels" aria-selected="false">Channels</button>
      <button class="screen-tab" data-screen="connectors" aria-selected="false">Connectors</button>
      <button class="screen-tab" data-screen="doctor" aria-selected="false">Doctor</button>
      <button class="screen-tab" data-screen="settings" aria-selected="false">Settings</button>
      <button class="screen-tab" data-screen="about" aria-selected="false">About</button>
      <button class="screen-tab" data-screen="update" aria-selected="false">Update</button>
      <button class="screen-tab" data-screen="recovery" aria-selected="false" title="Backup / Restore">Backup</button>
      <button class="screen-tab" data-screen="developer" aria-selected="false" title="Developer / Evidence">Evidence</button>
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
            <span class="badge good">HDS-BRAIN authority path intact</span>
            <h2 class="hero-title">Tanuki Dashboard</h2>
            <p class="muted">A clean resident console for decisions, approvals, audit evidence, recovery hints, channels, memory, and operator surfaces. UI state is display and intent only; it never becomes authority.</p>
            <div class="policy-row">
              <span class="badge readonly-note">UI state is not authority</span>
              <span class="badge readonly-note">LLM output is not authority</span>
              <span class="badge readonly-note">Memory is not authority</span>
              <span class="badge readonly-note">Channel metadata is not authority</span>
            </div>
          </div>
        </section>

        <section class="card" data-screen-group="conversation">
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

        <section class="card" data-screen-group="developer">
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

        <section class="card" data-screen-group="skills developer">
          <div class="row">
            <h2>Operation Core Plan</h2>
            <span id="operation-core-status" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Surfaces</span><span id="operation-core-surface-count">not loaded</span></div>
            <div class="metric"><span>Steps</span><span id="operation-core-step-count">not loaded</span></div>
            <div class="metric"><span>Adapters</span><span id="operation-core-adapters">not loaded</span></div>
            <div class="metric"><span>Adapter Registry</span><span id="operation-core-adapter-registry">not loaded</span></div>
            <div class="metric"><span>Default runtime</span><span id="operation-core-default-runtime">not loaded</span></div>
            <div class="metric"><span>Execution results</span><span id="operation-core-execution-results">not loaded</span></div>
            <div class="metric"><span>Latest result</span><span id="operation-core-latest-result">not loaded</span></div>
            <div class="metric"><span>Rollback</span><span id="operation-core-rollback">not loaded</span></div>
            <div class="metric"><span>Authority</span><span id="operation-core-authority">display only</span></div>
          </div>
          <div id="operation-core-list" class="trace-list">
            <div class="trace-item muted">no Operation Core projection loaded</div>
          </div>
          <div id="operation-core-execution-list" class="trace-list">
            <div class="trace-item muted">no Operation Core execution result loaded</div>
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

        <section class="card" data-screen-group="connectors">
          <div class="row">
            <h2>Connectors</h2>
            <span class="badge review">downstream only</span>
          </div>
          <div class="status-grid">
            <input id="connectors-token" type="password" autocomplete="current-password" placeholder="settings token" />
            <input id="composio-api-key" type="password" autocomplete="new-password" placeholder="Composio API key unchanged" />
            <input id="composio-user-id" type="text" autocomplete="off" placeholder="Composio user id" />
            <input id="composio-allowed-toolkits" type="text" autocomplete="off" placeholder="github,gmail,calendar" />
            <input id="composio-allowed-actions" type="text" autocomplete="off" placeholder="github:GITHUB_CREATE_AN_ISSUE" />
            <input id="composio-revoked-actions" type="text" autocomplete="off" placeholder="revoked action scopes" />
            <input id="composio-api-base-url" type="url" autocomplete="off" placeholder="https://backend.composio.dev" />
            <select id="composio-dry-run" aria-label="Composio dry-run">
              <option value="true">dry-run true</option>
              <option value="false">dry-run false</option>
            </select>
            <select id="composio-live-execution" aria-label="Composio live execution">
              <option value="false">live execution disabled</option>
              <option value="true">live execution enabled</option>
            </select>
            <label class="check"><input id="composio-clear-api-key" type="checkbox" /> clear Composio API key</label>
          </div>
          <div class="action-row">
            <button id="load-connectors" class="primary" type="button">Load Connectors</button>
            <button id="save-connectors" class="primary" type="button">Save Composio</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Composio</span><span id="composio-configured-status">not loaded</span></div>
            <div class="metric"><span>Dry-run</span><span id="composio-dry-run-status">not loaded</span></div>
            <div class="metric"><span>Live opt-in</span><span id="composio-live-opt-in-status">not loaded</span></div>
            <div class="metric"><span>Live execution</span><span id="composio-live-status">not loaded</span></div>
            <div class="metric"><span>Authority</span><span id="composio-authority-status">not authority</span></div>
            <div class="metric"><span>Toolkits</span><span id="composio-toolkits-status">not loaded</span></div>
            <div class="metric"><span>Actions</span><span id="composio-actions-status">not loaded</span></div>
            <div class="metric"><span>Revoked</span><span id="composio-revoked-status">not loaded</span></div>
            <div class="metric"><span>User</span><span id="composio-user-status">not loaded</span></div>
            <div class="metric"><span>Disconnect</span><span id="composio-disconnect-status">not loaded</span></div>
            <div class="metric"><span>Save</span><span id="composio-save-status">not saved</span></div>
          </div>
          <pre id="connectors-json">not loaded</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>Live Boundary</h3><p class="muted">Composio live execution opens only when dry-run is disabled, live execution is enabled, user id exists, and toolkit/action allowlists pass HDS approval.</p></div>
            <div class="screen-card"><h3>Allowlist</h3><p class="muted">Toolkits are explicit operator configuration, not permission escalation or authority.</p></div>
            <div class="screen-card"><h3>Secret Update</h3><p class="muted">Leave the API key blank to keep the existing secret; enter a new key only when rotating it.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">Connected account metadata, toolkit discovery, and tool results remain evidence only.</p></div>
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
          <div class="status-grid">
            <input id="settings-token" type="password" autocomplete="current-password" placeholder="settings token" />
            <select id="settings-provider" aria-label="LLM provider">
              <option value="stub">stub</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="openai-compatible">openai-compatible</option>
              <option value="openrouter">openrouter</option>
            </select>
            <input id="settings-model" type="text" autocomplete="off" placeholder="model" />
            <input id="settings-endpoint" type="text" autocomplete="off" placeholder="endpoint" />
            <input id="settings-api-key" type="password" autocomplete="new-password" placeholder="API key unchanged" />
            <input id="settings-site-url" type="text" autocomplete="off" placeholder="OpenRouter site URL" />
            <input id="settings-app-title" type="text" autocomplete="off" placeholder="OpenRouter app title" />
            <input id="settings-max-tokens" type="number" min="1" step="1" placeholder="max tokens" />
            <select id="settings-approval-mode" aria-label="Approval mode">
              <option value="ask_every_time">ask_every_time</option>
              <option value="remember_this_decision">remember_this_decision</option>
              <option value="full_access">full_access</option>
            </select>
          </div>
          <div class="action-row">
            <button id="load-settings" class="primary" type="button">Load Settings</button>
            <button id="verify-llm-settings" type="button">Verify LLM</button>
            <button id="save-settings" class="primary" type="button">Save Settings</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Provider</span><span id="settings-provider-status">not loaded</span></div>
            <div class="metric"><span>Model</span><span id="settings-model-status">not loaded</span></div>
            <div class="metric"><span>Writable</span><span id="settings-writable-status">not loaded</span></div>
            <div class="metric"><span>LLM key</span><span id="settings-key-status">not loaded</span></div>
            <div class="metric"><span>Approval mode</span><span id="settings-approval-mode-status">not loaded</span></div>
            <div class="metric"><span>OpenRouter</span><span id="settings-openrouter-status">not loaded</span></div>
            <div class="metric"><span>Verify</span><span id="settings-verify-status">not run</span></div>
          </div>
          <section class="settings-subsection" aria-labelledby="mascot-settings-title">
            <div class="row">
              <h3 id="mascot-settings-title">Mascot</h3>
              <span id="mascot-settings-status" class="badge good">on</span>
            </div>
            <div class="status-grid">
              <label class="check"><input id="mascot-enabled" type="checkbox" /> Mascot</label>
              <select id="mascot-character" aria-label="Mascot character">
                <option value="aotanu">Aotanu / default</option>
                <option value="none">None</option>
                <option value="custom" disabled>Custom image</option>
              </select>
              <select id="mascot-size" aria-label="Mascot size">
                <option value="small">small</option>
                <option value="medium">medium</option>
                <option value="large">large</option>
              </select>
              <select id="mascot-position" aria-label="Mascot position">
                <option value="bottom-right">bottom-right</option>
                <option value="bottom-left">bottom-left</option>
              </select>
            </div>
            <div class="action-row">
              <button id="reset-mascot-settings" type="button">Reset mascot settings</button>
            </div>
          </section>
          <pre id="settings-json">not loaded</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>LLM Provider</h3><p class="muted">Provider verification is non-mutating unless explicit save is requested through the settings surface.</p></div>
            <div class="screen-card"><h3>OpenRouter</h3><p class="muted">Optional model provider adapter; native/direct providers remain canonical.</p></div>
            <div class="screen-card"><h3>Composio</h3><p class="muted">Optional external tool connector; live execution stays gated by opt-in, allowlists, and HDS approval.</p></div>
            <div class="screen-card"><h3>Approval Mode</h3><p class="muted">Full access may allow L1/L2, but never L3 final-review operations.</p></div>
            <div class="screen-card"><h3>Memory Policy</h3><p class="muted">Policy changes are sensitive and must not be inferred from UI state.</p></div>
            <div class="screen-card"><h3>Credential Handling</h3><p class="muted">Tokens are not displayed, copied into history, or saved by mock UI state.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="about">
          <div class="row">
            <h2>About</h2>
            <span id="about-release-status" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <input id="about-token" type="password" autocomplete="off" placeholder="webchat token" />
            <button id="load-about" class="primary" type="button">Load About</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Product</span><span id="about-product-name">not loaded</span></div>
            <div class="metric"><span>Version</span><span id="about-version">not loaded</span></div>
            <div class="metric"><span>License</span><span id="about-license">not loaded</span></div>
            <div class="metric"><span>Owner GO</span><span id="about-owner-go">not loaded</span></div>
            <div class="metric"><span>Public claim</span><span id="about-public-claim">not loaded</span></div>
            <div class="metric"><span>Signed installer</span><span id="about-signed-installer">not loaded</span></div>
            <div class="metric"><span>Automatic updater</span><span id="about-automatic-updater">not loaded</span></div>
            <div class="metric"><span>Authority</span><span id="about-authority">HDS-BRAIN</span></div>
          </div>
          <pre id="about-json">not loaded</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>Release Boundary</h3><p class="muted">RC remains pre-GO until owner decision and validate:ga permit public claim activation.</p></div>
            <div class="screen-card"><h3>Claim Boundary</h3><p class="muted">This panel displays claim metadata; it is not release approval or authority.</p></div>
            <div class="screen-card"><h3>Distribution Boundary</h3><p class="muted">Unsigned installer and automatic updater status are shown from claim metadata.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">HDS-BRAIN remains the only authority owner; UI state and claims are evidence only.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="update">
          <div class="row">
            <h2>Update</h2>
            <span id="update-boundary-status" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <input id="update-token" type="password" autocomplete="off" placeholder="maintenance token" />
            <button id="load-update" class="primary" type="button">Load Update</button>
            <button id="verify-update" type="button">Verify Bundle</button>
            <button id="prepare-update" type="button">Prepare Update</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Current version</span><span id="update-current-version">not loaded</span></div>
            <div class="metric"><span>Candidate</span><span id="update-candidate-status">not loaded</span></div>
            <div class="metric"><span>Candidate version</span><span id="update-candidate-version">not loaded</span></div>
            <div class="metric"><span>SHA256</span><span id="update-sha-status">not loaded</span></div>
            <div class="metric"><span>Manifest</span><span id="update-manifest-status">not loaded</span></div>
            <div class="metric"><span>Compatibility</span><span id="update-compatibility-status">not loaded</span></div>
            <div class="metric"><span>Rollback plan</span><span id="update-rollback-status">not loaded</span></div>
            <div class="metric"><span>Automatic updater</span><span id="update-auto-status">not shipped</span></div>
            <div class="metric"><span>Authority</span><span id="update-authority-status">display only</span></div>
            <div class="metric"><span>Last action</span><span id="update-action-status">not run</span></div>
            <div class="metric"><span>Next safe action</span><span id="update-next-action-status">not loaded</span></div>
          </div>
          <pre id="update-json">not loaded</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>Manual Update</h3><p class="muted">The runtime verifies release sidecars and prepares rollback evidence; it does not replace app files automatically.</p></div>
            <div class="screen-card"><h3>Pre-update Backup</h3><p class="muted">Prepare Update creates a recovery backup and rollback plan before manual replacement.</p></div>
            <div class="screen-card"><h3>Compatibility</h3><p class="muted">Manifest schema and release boundaries must match before update is treated as ready.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">Update metadata cannot approve commands, alter HDS policy, or bypass final review.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="recovery">
          <div class="row">
            <h2>Backup / Restore</h2>
            <span id="recovery-boundary-status" class="badge warn">not loaded</span>
          </div>
          <div class="status-grid">
            <input id="recovery-token" type="password" autocomplete="off" placeholder="maintenance token" />
            <button id="load-recovery" class="primary" type="button">Load Recovery</button>
          </div>
          <div class="status-grid">
            <input id="recovery-backup-id" type="text" autocomplete="off" placeholder="backup id or latest" />
            <button id="create-recovery-backup" type="button">Backup Now</button>
            <button id="restore-recovery-backup" type="button">Restore</button>
            <button id="reset-recovery-provider" type="button">Reset Provider</button>
            <button id="reset-recovery-connector" type="button">Reset Connector</button>
            <button id="factory-reset-recovery" type="button">Factory Reset</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Env file</span><span id="recovery-env-file-status">not loaded</span></div>
            <div class="metric"><span>Env backups</span><span id="recovery-env-backup-count">not loaded</span></div>
            <div class="metric"><span>Recovery packs</span><span id="recovery-pack-count">not loaded</span></div>
            <div class="metric"><span>Latest backup</span><span id="recovery-latest-backup">not loaded</span></div>
            <div class="metric"><span>Restore</span><span id="recovery-restore-status">not loaded</span></div>
            <div class="metric"><span>Factory reset</span><span id="recovery-factory-reset-status">not loaded</span></div>
            <div class="metric"><span>Last action</span><span id="recovery-action-status">not run</span></div>
            <div class="metric"><span>Authority</span><span id="recovery-authority-status">display only</span></div>
            <div class="metric"><span>Next action</span><span id="recovery-next-action">not loaded</span></div>
          </div>
          <div id="recovery-path-list" class="status-grid"></div>
          <pre id="recovery-json">not loaded</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>Control Path</h3><p class="muted">Backup, restore, and reset operations are token-gated local recovery controls, not command approval or authority.</p></div>
            <div class="screen-card"><h3>Secret-bearing</h3><p class="muted">Env files and env backups may contain credentials. Only paths and counts are displayed here.</p></div>
            <div class="screen-card"><h3>P10 Boundary</h3><p class="muted">Destructive repair remains blocked. Factory reset preserves audit and recovery backup roots.</p></div>
            <div class="screen-card"><h3>Authority Guard</h3><p class="muted">Recovery metadata is evidence only and cannot approve, resume, or execute commands.</p></div>
          </div>
        </section>

        <section class="card" data-screen-group="developer">
          <div class="row">
            <h2>Developer / Evidence</h2>
            <span id="evidence-export-status" class="badge warn">not exported</span>
          </div>
          <div class="status-grid">
            <input id="evidence-token" type="password" autocomplete="off" placeholder="webchat token" />
            <button id="export-evidence" class="primary" type="button">Export Evidence</button>
          </div>
          <div class="status-grid">
            <div class="metric"><span>Pack</span><span id="evidence-pack-path">not exported</span></div>
            <div class="metric"><span>Audit chain</span><span id="evidence-audit-chain">not exported</span></div>
            <div class="metric"><span>History chain</span><span id="evidence-history-chain">not exported</span></div>
            <div class="metric"><span>Redaction</span><span id="evidence-redaction-status">not exported</span></div>
            <div class="metric"><span>Authority</span><span id="evidence-authority-status">display only</span></div>
          </div>
          <pre id="evidence-json">not exported</pre>
          <div class="screen-grid">
            <div class="screen-card"><h3>Repo Health</h3><p class="muted">Import graph and release-path purity checks protect production runtime boundaries.</p></div>
            <div class="screen-card"><h3>Conformance</h3><p class="muted">Negative tests prove metadata, memory, UI state, and LLM output cannot create authority.</p></div>
            <div class="screen-card"><h3>Release Gates</h3><p class="muted">GA requires technical validation plus explicit owner GO; pre-GO public claim remains false.</p></div>
            <div class="screen-card"><h3>Evidence Source</h3><p class="muted">CONFIG, INTERNAL_STATE, LIVE_RUNTIME, EXTERNAL_EVIDENCE, and FIXTURE must not be conflated.</p></div>
          </div>
        </section>

        <section class="log" data-screen-group="developer" aria-live="polite">
          <article class="msg system">
            <h2>System</h2>
            <p class="muted">Resident status, approval gates, schedule state, authority trace, and audit chain are surfaced without command content or credential values.</p>
          </article>
          <article class="msg">
            <h2>Approval Model</h2>
            <p class="muted">L3 and final-review work remains a one-time operator decision. The console only submits explicit approve, reject, or block verdicts.</p>
          </article>
        </section>

        <section class="card" data-screen-group="activity">
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
            <div class="metric"><span>Emergency stop</span><span id="approval-emergency-status">not loaded</span></div>
            <div class="metric"><span>Reusable grants</span><span id="approval-grant-count">not loaded</span></div>
            <div class="metric"><span>History</span><span id="approval-history-count">not loaded</span></div>
          </div>
          <input id="approval-token" type="password" autocomplete="off" placeholder="resume token" />
          <input id="approval-emergency-reason" type="text" autocomplete="off" placeholder="emergency stop reason" />
          <div class="action-row">
            <button id="load-approvals" class="primary">Load</button>
            <button id="activate-emergency-stop" class="danger" type="button">Emergency Stop</button>
            <button id="clear-emergency-stop" type="button">Clear Stop</button>
          </div>
          <div id="approval-list" class="queue-list"></div>
          <h2>Reusable Grants</h2>
          <div id="approval-grant-list" class="queue-list"></div>
          <h2>Approval History</h2>
          <div id="approval-history-list" class="history-list"></div>
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

    <div id="mascot-dock" class="mascot-dock mascot-dock-bottom-right mascot-size-medium" aria-label="Mascot dock">
      <button id="mascot-toggle" class="mascot-toggle" type="button" aria-expanded="false" aria-controls="mascot-actions">
        <span id="aotanu-mascot" class="aotanu-mascot" role="img" aria-label="アオタヌ 状態: 休憩中" data-state="idle">
          <span id="aotanu-sprite" class="aotanu-sprite" aria-hidden="true"></span>
          <span class="aotanu-caption">
            <span class="badge readonly-note">アオタヌ</span>
            <span id="aotanu-state-label" class="badge good">休憩中</span>
          </span>
        </span>
      </button>
      <div id="mascot-actions" class="mascot-actions" hidden>
        <button type="button" data-mascot-action="conversation">会話を開始</button>
        <button type="button" data-mascot-action="doctor">セットアップ診断</button>
        <button type="button" data-mascot-action="activity">ログを見る</button>
        <button type="button" data-mascot-action="settings">設定を開く</button>
      </div>
    </div>

    <script>
${CONTROL_CENTER_SCRIPT}    </script>
  </body>
</html>`;
}
