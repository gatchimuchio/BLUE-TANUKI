export const CONTROL_CENTER_STYLE = `      :root {
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
      select,
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
        grid-template-columns: minmax(0, 1fr);
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

      .aotanu-mascot {
        display: grid;
        justify-items: center;
        gap: 9px;
        min-width: 0;
      }

      .aotanu-mascot[hidden] {
        display: none;
      }

      .aotanu-sprite {
        width: var(--mascot-sprite-size, 96px);
        height: var(--mascot-sprite-size, 96px);
        border: 1px solid rgba(102, 209, 193, 0.35);
        border-radius: 6px;
        background-color: #bdeaf4;
        background-repeat: no-repeat;
        background-size: 200% 200%;
        image-rendering: pixelated;
      }

      .aotanu-caption {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
      }

      .settings-subsection {
        display: grid;
        gap: 10px;
        min-width: 0;
        padding: 10px;
        border: 1px solid #383428;
        border-radius: 8px;
        background: var(--panel-2);
      }

      .mascot-dock {
        --mascot-sprite-size: 96px;
        position: fixed;
        bottom: 24px;
        z-index: 30;
        display: grid;
        gap: 8px;
        justify-items: center;
        width: max-content;
        max-width: min(172px, calc(100vw - 32px));
        pointer-events: none;
      }

      .mascot-dock[hidden] {
        display: none;
      }

      .mascot-dock-bottom-right {
        right: 24px;
      }

      .mascot-dock-bottom-left {
        left: 24px;
      }

      .mascot-size-small {
        --mascot-sprite-size: 80px;
      }

      .mascot-size-medium {
        --mascot-sprite-size: 96px;
      }

      .mascot-size-large {
        --mascot-sprite-size: 128px;
      }

      .mascot-toggle {
        display: grid;
        width: calc(var(--mascot-sprite-size) + 18px);
        min-width: 0;
        min-height: 0;
        padding: 8px;
        place-items: center;
        border-color: rgba(102, 209, 193, 0.45);
        border-radius: 8px;
        background: rgba(16, 23, 32, 0.92);
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.38);
        pointer-events: auto;
      }

      .mascot-toggle:hover {
        border-color: var(--accent);
      }

      .mascot-actions {
        order: -1;
        display: grid;
        gap: 6px;
        width: 168px;
        padding: 8px;
        border: 1px solid rgba(102, 209, 193, 0.45);
        border-radius: 8px;
        background: rgba(17, 17, 15, 0.96);
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
        pointer-events: auto;
      }

      .mascot-actions[hidden] {
        display: none;
      }

      .mascot-actions button {
        width: 100%;
        min-width: 0;
        padding: 7px 8px;
        text-align: left;
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

      label.policy,
      label.check {
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
      input[type="number"],
      input[type="url"],
      select,
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

        .mascot-dock {
          bottom: 12px;
          max-width: min(128px, calc(100vw - 24px));
        }

        .mascot-dock-bottom-right {
          right: 12px;
        }

        .mascot-dock-bottom-left {
          left: 12px;
        }

        .mascot-size-small {
          --mascot-sprite-size: 64px;
        }

        .mascot-size-medium {
          --mascot-sprite-size: 72px;
        }

        .mascot-size-large {
          --mascot-sprite-size: 84px;
        }

        .mascot-toggle {
          width: calc(var(--mascot-sprite-size) + 14px);
          padding: 6px;
        }

        .mascot-dock .aotanu-caption {
          display: none;
        }

        .mascot-actions {
          width: 152px;
        }
      }
`;
