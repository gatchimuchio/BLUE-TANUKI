export const CONTROL_CENTER_STYLE = `      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --surface: rgba(255, 255, 255, 0.9);
        --surface-strong: #ffffff;
        --surface-soft: #eef3f8;
        --surface-inset: #f8fafc;
        --line: #d7e0ea;
        --line-strong: #b9c5d3;
        --text: #101828;
        --muted: #667085;
        --good: #057a55;
        --warn: #b54708;
        --bad: #c2413f;
        --review: #5b5bd6;
        --accent: #0a84ff;
        --accent-2: #14a37f;
        --ink: #0b1220;
        --shadow-soft: 0 10px 28px rgba(15, 23, 42, 0.08);
        --shadow-tight: 0 2px 8px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      html {
        min-height: 100%;
        background: var(--bg);
      }

      body {
        margin: 0;
        min-height: 100dvh;
        overflow-y: auto;
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

      body > header {
        z-index: 40;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 54px;
        padding: 8px 16px;
        border-bottom: 1px solid rgba(215, 224, 234, 0.82);
        background: rgba(248, 250, 252, 0.86);
        backdrop-filter: blur(20px);
        box-shadow: var(--shadow-tight);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .brand > div {
        min-width: 0;
      }

      .tanuki-mark {
        width: 38px;
        height: 38px;
        flex: 0 0 auto;
        filter: drop-shadow(0 6px 10px rgba(15, 23, 42, 0.14));
      }

      .screen-tabs {
        z-index: 35;
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: repeat(15, minmax(0, 1fr));
        gap: 6px;
        min-width: 0;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(215, 224, 234, 0.82);
        background: rgba(244, 247, 251, 0.9);
        backdrop-filter: blur(20px);
        overflow: hidden;
      }

      button.screen-tab {
        min-width: 0;
        min-height: 30px;
        padding: 6px 7px;
        border-color: transparent;
        border-radius: 8px;
        background: transparent;
        color: #475467;
        font-size: 12px;
        font-weight: 680;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      button.screen-tab:hover {
        border-color: rgba(10, 132, 255, 0.3);
        background: rgba(255, 255, 255, 0.72);
      }

      button.screen-tab.active,
      button.screen-tab[aria-selected="true"] {
        border-color: rgba(10, 132, 255, 0.4);
        background: var(--accent);
        color: #ffffff;
        box-shadow: 0 5px 14px rgba(10, 132, 255, 0.22);
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        color: var(--ink);
        font-size: 17px;
        font-weight: 760;
        line-height: 1.15;
      }

      h2 {
        color: var(--ink);
        font-size: 14px;
        font-weight: 740;
        line-height: 1.25;
      }

      h3 {
        color: var(--ink);
        font-size: 13px;
        font-weight: 720;
        line-height: 1.3;
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
        grid-template-columns: minmax(220px, 270px) minmax(0, 1fr) minmax(320px, 390px);
        gap: 10px;
        min-height: calc(100dvh - 106px);
        padding: 10px;
        align-items: stretch;
      }

      .shell > nav,
      .shell > aside {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        max-height: calc(100dvh - 126px);
        overflow-y: auto;
      }

      main {
        display: flex;
        min-width: 0;
        min-height: calc(100dvh - 126px);
        flex-direction: column;
        gap: 10px;
        overflow: visible;
      }

      body[data-active-screen="conversation"] .shell {
        grid-template-columns: minmax(0, 1040px);
        justify-content: center;
      }

      body[data-active-screen="conversation"] .shell > nav,
      body[data-active-screen="conversation"] .shell > aside {
        display: none;
      }

      body[data-active-screen="conversation"] main {
        width: 100%;
      }

      .card {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border: 1px solid rgba(215, 224, 234, 0.94);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow-soft);
      }

      [data-screen-group][hidden] {
        display: none;
      }

      .dashboard-hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        align-items: stretch;
        min-height: clamp(360px, calc(100dvh - 126px), 720px);
        border-color: rgba(13, 20, 33, 0.84);
        background: #111827;
        color: #f8fafc;
      }

      .dashboard-hero h2,
      .dashboard-hero h3 {
        color: #f8fafc;
      }

      .dashboard-hero .muted {
        color: #cbd5e1;
      }

      .dashboard-hero .badge {
        border-color: rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.08);
        color: #e2e8f0;
      }

      .dashboard-hero .badge.good {
        border-color: rgba(20, 163, 127, 0.46);
        color: #7ee2c3;
      }

      .dashboard-hero .readonly-note {
        border-color: rgba(148, 163, 184, 0.35);
        color: #dbeafe;
      }

      .chat-screen {
        gap: 0;
        min-height: calc(100dvh - 126px);
        padding: 0;
        overflow: hidden;
        background: #ffffff;
      }

      .chat-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(215, 224, 234, 0.82);
        background: rgba(255, 255, 255, 0.92);
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
        line-height: 1.16;
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
        border: 1px solid rgba(10, 132, 255, 0.22);
        border-radius: 8px;
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
        gap: 8px;
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      .mascot-dock {
        --mascot-sprite-size: 96px;
        position: fixed;
        bottom: 18px;
        z-index: 30;
        display: grid;
        gap: 8px;
        justify-items: center;
        width: max-content;
        max-width: min(128px, calc(100vw - 24px));
        pointer-events: none;
      }

      .mascot-dock[hidden] {
        display: none;
      }

      .mascot-dock-bottom-right {
        right: 18px;
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
        border-color: transparent;
        border-radius: 8px;
        background: transparent;
        box-shadow: none;
        pointer-events: auto;
      }

      .mascot-dock .aotanu-caption {
        display: none;
      }

      .mascot-toggle:hover {
        border-color: rgba(10, 132, 255, 0.28);
      }

      .mascot-actions {
        order: -1;
        display: grid;
        gap: 6px;
        width: 188px;
        padding: 8px;
        border: 1px solid rgba(10, 132, 255, 0.22);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 16px 38px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(18px);
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
        gap: 8px;
      }

      .screen-card {
        display: grid;
        gap: 6px;
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      .lane-board {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      .lane {
        display: grid;
        gap: 6px;
        min-height: 0;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      .map-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 6px;
      }

      .map-node {
        min-width: 0;
        padding: 9px;
        border: 1px solid rgba(20, 163, 127, 0.22);
        border-radius: 8px;
        background: #edf8f4;
        color: #0f513f;
        text-align: center;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .readonly-note {
        border-color: rgba(5, 122, 85, 0.28);
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
        gap: 8px;
        min-width: 0;
      }

      .metric,
      .state-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        padding: 6px 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      .technical-boundary {
        display: none;
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
        gap: 6px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        max-width: 100%;
        padding: 2px 7px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-soft);
        color: var(--text);
        font-size: 12px;
        font-weight: 740;
        overflow-wrap: anywhere;
      }

      .badge.good {
        border-color: rgba(5, 122, 85, 0.24);
        background: #e7f6ef;
        color: var(--good);
      }

      .badge.warn {
        border-color: rgba(181, 71, 8, 0.24);
        background: #fff4e6;
        color: var(--warn);
      }

      .badge.bad {
        border-color: rgba(194, 65, 63, 0.26);
        background: #ffeceb;
        color: var(--bad);
      }

      .badge.review {
        border-color: rgba(91, 91, 214, 0.26);
        background: #eeeeff;
        color: var(--review);
      }

      .policy-row,
      .action-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      label.policy,
      label.check {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 142px;
        flex: 1;
        padding: 7px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      input[type="password"],
      input[type="text"],
      input[type="number"],
      input[type="url"],
      select,
      textarea {
        width: 100%;
        min-height: 32px;
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        background: #ffffff;
        color: var(--text);
        padding: 6px 8px;
        box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.04);
      }

      input:focus,
      select:focus,
      textarea:focus,
      button:focus-visible {
        outline: 2px solid rgba(10, 132, 255, 0.34);
        outline-offset: 2px;
      }

      textarea {
        min-height: 64px;
        resize: vertical;
      }

      button {
        min-height: 32px;
        min-width: 74px;
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        background: #ffffff;
        color: var(--ink);
        cursor: pointer;
        font-weight: 700;
        box-shadow: var(--shadow-tight);
      }

      button.primary {
        border-color: rgba(10, 132, 255, 0.55);
        background: var(--accent);
        color: #ffffff;
      }

      button.danger {
        border-color: rgba(194, 65, 63, 0.36);
        background: #fff5f5;
        color: var(--bad);
      }

      button:hover {
        border-color: rgba(10, 132, 255, 0.62);
      }

      button.primary:hover {
        background: #0071e3;
      }

      .log {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .msg {
        max-width: 860px;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow-tight);
      }

      .msg.system {
        border-color: rgba(10, 132, 255, 0.24);
      }

      .queue-list,
      .chat-log,
      .notification-list,
      .schedule-list,
      .history-list,
      .trace-list,
      .audit-list {
        display: grid;
        gap: 6px;
      }

      .queue-item,
      .chat-item,
      .notification-item,
      .schedule-item,
      .history-item,
      .trace-item,
      .audit-item {
        display: grid;
        gap: 6px;
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-inset);
      }

      .chat-log {
        display: flex;
        min-height: 0;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 14px;
        max-height: none;
        overflow: auto;
        padding: 18px 16px;
        background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
      }

      .chat-log .chat-item {
        display: flex;
        min-width: 0;
        padding: 0;
        border: 0;
        background: transparent;
      }

      .chat-item.owner {
        justify-content: flex-end;
      }

      .chat-item.assistant,
      .chat-item.system,
      .chat-item.error {
        justify-content: flex-start;
      }

      .chat-bubble {
        max-width: min(720px, 78%);
        padding: 10px 12px;
        border: 1px solid rgba(215, 224, 234, 0.95);
        border-radius: 8px;
        background: #ffffff;
        box-shadow: var(--shadow-tight);
      }

      .chat-item.owner .chat-bubble {
        border-color: rgba(10, 132, 255, 0.22);
        background: #eaf3ff;
      }

      .chat-item.system .chat-bubble {
        background: #f5f7fb;
        color: var(--muted);
      }

      .chat-item.error .chat-bubble {
        border-color: rgba(194, 65, 63, 0.3);
        background: #fff5f5;
        color: var(--bad);
      }

      .chat-meta {
        margin-bottom: 4px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 760;
      }

      .chat-bubble p {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .chat-composer {
        display: grid;
        gap: 8px;
        padding: 10px 16px 14px;
        border-top: 1px solid rgba(215, 224, 234, 0.82);
        background: rgba(255, 255, 255, 0.96);
      }

      .chat-identity-row,
      .chat-input-row {
        display: grid;
        gap: 8px;
      }

      .chat-identity-row {
        grid-template-columns: minmax(0, 1fr) minmax(120px, 180px) auto auto;
      }

      .chat-input-row {
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
      }

      .chat-input-row textarea {
        min-height: 54px;
        max-height: 150px;
        resize: vertical;
        border-radius: 8px;
        font-size: 14px;
        line-height: 1.45;
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
        flex: 1 1 auto;
        max-height: 260px;
        min-height: 44px;
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 8px;
        border: 1px solid #1f2937;
        border-radius: 8px;
        background: #0b1220;
        color: #dbeafe;
        font-size: 12px;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #0d1117;
          --surface: rgba(22, 27, 34, 0.9);
          --surface-strong: #161b22;
          --surface-soft: #1f2937;
          --surface-inset: #111827;
          --line: #303b4b;
          --line-strong: #46556a;
          --text: #eef4ff;
          --muted: #a7b1c2;
          --good: #6ee7b7;
          --warn: #f7bd6b;
          --bad: #ff8b8b;
          --review: #b7a4ff;
          --accent: #0a84ff;
          --accent-2: #36d6a3;
          --ink: #f8fafc;
          --shadow-soft: 0 10px 28px rgba(0, 0, 0, 0.26);
          --shadow-tight: 0 2px 8px rgba(0, 0, 0, 0.22);
        }

        body > header {
          border-bottom-color: rgba(48, 59, 75, 0.82);
          background: rgba(13, 17, 23, 0.86);
        }

        .screen-tabs {
          border-bottom-color: rgba(48, 59, 75, 0.82);
          background: rgba(13, 17, 23, 0.9);
        }

        button.screen-tab {
          color: #c9d4e5;
        }

        button.screen-tab:hover {
          background: rgba(31, 41, 55, 0.72);
        }

        .dashboard-hero {
          border-color: rgba(148, 163, 184, 0.2);
          background: #111827;
        }

        .chat-screen {
          background: #0d1117;
        }

        .chat-topbar,
        .chat-composer {
          border-color: rgba(48, 59, 75, 0.82);
          background: rgba(13, 17, 23, 0.94);
        }

        .chat-log {
          background: linear-gradient(180deg, #0d1117 0%, #111827 100%);
        }

        .chat-bubble {
          border-color: rgba(48, 59, 75, 0.9);
          background: #161b22;
        }

        .chat-item.owner .chat-bubble {
          border-color: rgba(10, 132, 255, 0.42);
          background: rgba(10, 132, 255, 0.18);
        }

        .chat-item.system .chat-bubble {
          background: #111827;
        }

        .chat-item.error .chat-bubble {
          border-color: rgba(255, 139, 139, 0.42);
          background: rgba(194, 65, 63, 0.18);
        }

        .map-node {
          background: rgba(20, 163, 127, 0.12);
          color: #9ff2d2;
        }

        input[type="password"],
        input[type="text"],
        input[type="number"],
        input[type="url"],
        select,
        textarea,
        button,
        .mascot-toggle,
        .mascot-actions {
          background: var(--surface-strong);
          color: var(--text);
        }

        .badge.good {
          background: rgba(5, 122, 85, 0.17);
        }

        .badge.warn {
          background: rgba(181, 71, 8, 0.17);
        }

        .badge.bad {
          background: rgba(194, 65, 63, 0.17);
        }

        .badge.review {
          background: rgba(91, 91, 214, 0.2);
        }
      }

      @media (max-width: 1120px) {
        .shell {
          grid-template-columns: minmax(210px, 270px) minmax(0, 1fr);
        }

        .dashboard-hero,
        .lane-board {
          grid-template-columns: 1fr;
        }

        .chat-identity-row {
          grid-template-columns: minmax(0, 1fr) minmax(110px, 150px);
        }

        .chat-identity-row button {
          min-width: 0;
        }

        .shell > aside {
          display: none;
        }
      }

      @media (max-width: 760px) {
        body > header {
          align-items: center;
          flex-direction: row;
          min-height: 48px;
          padding: 6px 10px;
        }

        .brand {
          width: auto;
        }

        .screen-tabs {
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 4px;
          padding: 6px 8px;
        }

        .shell {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          min-height: auto;
          padding: 8px;
        }

        .shell > nav,
        .shell > aside {
          display: none;
        }

        main {
          display: flex;
          min-height: auto;
        }

        .status-grid {
          grid-template-columns: 1fr;
        }

        .screen-grid,
        .map-grid {
          grid-template-columns: 1fr;
        }

        .chat-screen {
          min-height: calc(100dvh - 120px);
        }

        .chat-topbar {
          padding: 10px 12px;
        }

        .chat-log {
          padding: 14px 10px;
        }

        .chat-bubble {
          max-width: 92%;
        }

        .chat-composer {
          padding: 8px 10px 10px;
        }

        .chat-identity-row,
        .chat-input-row {
          grid-template-columns: 1fr;
        }

        .kv {
          grid-template-columns: 92px minmax(0, 1fr);
        }

        .hero-title {
          font-size: 22px;
        }

        .mascot-dock {
          bottom: 12px;
          max-width: min(104px, calc(100vw - 20px));
        }

        .mascot-dock-bottom-right {
          right: 12px;
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

        .mascot-actions {
          width: 152px;
        }
      }
`;
