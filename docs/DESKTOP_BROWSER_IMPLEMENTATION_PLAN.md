# Desktop Browser Implementation Plan

## Goal

Replace the current desktop `iframe` browser with a real browser session backed by Patchright in the sandbox runtime, so Entropic can:

- browse modern sites reliably
- interact with pages through the desktop UI
- share browser state with the agent
- inspect local development apps on `localhost` and related host aliases

## Current State

### What exists

- Patchright/Chromium is being added to the runtime image.
- The `patchright-browser` skill exists in `../entropic-skills`.
- The runtime already carries browser-related env vars such as:
  - `PLAYWRIGHT_BROWSERS_PATH`
  - `ENTROPIC_BROWSER_PROFILE`
- The app exposes a `Browser automation` capability in settings and agent state.

### What does not exist

- No persistent browser service in the runtime.
- No Tauri command surface for browser control.
- No shared browser session model between the desktop app and Chat.
- No desktop browser UI that talks to Patchright.
- The current desktop browser in `src/pages/Files.tsx` is still just an `iframe`.

### Important constraint

The current `patchright-browser` skill provides stealth `search` and `fetch`, but not a full interactive browser session API. It is useful as a building block, but insufficient on its own for a desktop browser.

## Desired End State

The desktop Browser window should:

- open and render real pages via Patchright
- maintain session state across navigation, clicks, and typing
- support back, forward, reload, and screenshots
- support `localhost`, `127.0.0.1`, and `host.docker.internal`
- expose the same session to Chat for agent-driven browsing
- surface page errors, load failures, and relevant browser diagnostics

## Architecture

### 1. Runtime browser service

Add a small persistent browser service inside the sandbox runtime.

Responsibilities:

- own the Patchright browser instance
- manage one or more browser sessions
- keep context/profile state alive between actions
- execute actions like `navigate`, `click`, `type`, `snapshot`, `screenshot`
- return structured results to the desktop app

Recommended shape:

- one lightweight Node service started in the runtime container
- HTTP or line-delimited JSON RPC over a local port/socket inside the container
- one browser context per Entropic browser session

### 2. Tauri bridge

Expose a thin Rust command layer that forwards browser actions into the runtime container.

Recommended commands:

- `browser_session_create`
- `browser_session_close`
- `browser_navigate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`
- `browser_get_logs`

Rust should not implement browser logic itself. It should only:

- validate arguments
- ensure the runtime/container is available
- call the browser service
- normalize errors for the frontend

### 3. Frontend browser model

Replace the current `iframe`-based Browser window with a controlled browser view.

Frontend state should track:

- session id
- current URL
- page title
- loading status
- back/forward availability
- current snapshot
- last screenshot image
- last action error

Recommended render model:

- screenshot-first rendering for reliability
- optional DOM/text snapshot panel for selection/debugging
- click overlays or element list for interaction

## Local Development Support

The browser must be able to inspect local apps during development.

### Required targets

- `http://localhost:<port>`
- `http://127.0.0.1:<port>`
- `http://host.docker.internal:<port>`

### Implementation notes

- The runtime container should use `host.docker.internal` for host services when needed.
- The frontend can accept `localhost`, but the Tauri/runtime layer should normalize or translate to a reachable host alias where appropriate.
- Localhost behavior must be tested in both:
  - `tauri dev`
  - packaged app

### Dev-specific workflows

The browser should support:

- opening a local app
- refreshing after code changes
- capturing screenshots after interactions
- extracting visible text
- collecting console and network errors

## Session Model

### Recommended choice

Persistent session per browser window.

This is required for:

- cookies
- auth flows
- local storage
- multi-step forms
- browsing continuity between desktop and Chat

### Session sharing

The same browser session should optionally be usable from:

- the Browser desktop window
- Chat agent actions

That enables workflows like:

- open page in desktop browser
- ask Chat to inspect or operate it
- return to desktop browser and continue manually

## API Contract

### Example command request

```json
{
  "sessionId": "browser-123",
  "url": "https://example.com"
}
```

### Example snapshot response

```json
{
  "sessionId": "browser-123",
  "url": "https://example.com",
  "title": "Example Domain",
  "html": null,
  "text": "Example Domain ...",
  "elements": [
    {
      "id": "el-1",
      "tag": "a",
      "text": "More information...",
      "role": "link",
      "selector": "a[href]"
    }
  ],
  "screenshotPath": "/data/browser/screens/browser-123.png",
  "canGoBack": false,
  "canGoForward": false
}
```

### Frontend rendering rule

The frontend should never attempt to interpret raw arbitrary page HTML as trusted UI. Render screenshots, extracted text, and explicit element metadata instead.

## Phased Rollout

### Phase 1: Minimal viable desktop browser

Deliver:

- browser service process in runtime
- Tauri commands:
  - `browser_session_create`
  - `browser_navigate`
  - `browser_snapshot`
  - `browser_screenshot`
  - `browser_reload`
  - `browser_close`
- frontend browser window backed by session + screenshot/text snapshot
- localhost navigation support

Acceptance:

- open `https://example.com`
- open a local Vite app
- refresh and view updated page
- take screenshot successfully

### Phase 2: Interactive controls

Deliver:

- `browser_click`
- `browser_type`
- `browser_press`
- `browser_wait_for`
- back/forward support
- selectable/clickable element model in UI

Acceptance:

- click links and buttons
- type into forms
- submit a search box
- navigate a SPA reliably

### Phase 3: Shared Chat + browser workflows

Deliver:

- attach browser session to Chat context
- agent can operate the visible desktop browser session
- browser actions reflected in desktop browser state

Acceptance:

- desktop opens local app
- Chat clicks a control
- desktop reflects updated page state

### Phase 4: Diagnostics and polish

Deliver:

- console log capture
- network error capture
- better action/error reporting
- screenshots on failure
- optional browser history/session persistence rules

Acceptance:

- failed page loads and console errors are visible in the app
- browser debugging is practical for local app development

## File-Level Implementation Plan

### Runtime

- `openclaw-runtime/`
  - add persistent browser service entrypoint
  - ensure Patchright and Chromium are installed and reachable
  - persist profile and screenshot paths under `/data/browser`

### Rust / Tauri

- `src-tauri/src/commands.rs`
  - add browser session/action commands
  - add runtime-to-browser-service request helpers
  - normalize localhost handling
- `src-tauri/src/lib.rs`
  - register browser commands

### Frontend

- `src/pages/Files.tsx`
  - replace `iframe` browser implementation
  - add browser session state and action handlers
  - add render model for snapshot/screenshot
- optional extraction later:
  - `src/components/DesktopBrowser.tsx`
  - `src/lib/browser.ts`

## Risks

### 1. Treating Patchright skill as a full browser service

Risk:

- current skill only supports one-shot search/fetch

Mitigation:

- build a persistent runtime browser service instead of overloading the current skill scripts

### 2. Localhost reachability mismatch

Risk:

- app and runtime container may not resolve local addresses the same way

Mitigation:

- centralize address normalization in Rust
- test `localhost`, `127.0.0.1`, and `host.docker.internal`

### 3. Session/state desync between Chat and desktop

Risk:

- browser actions from Chat and desktop can conflict

Mitigation:

- explicit session ownership and action queue
- always fetch a fresh snapshot after each action

### 4. Over-rendering or unsafe rendering in frontend

Risk:

- trying to render arbitrary page HTML inside the app reintroduces the same iframe-class problems

Mitigation:

- render screenshot + extracted metadata, not raw page HTML

## Open Questions

- Should there be one shared browser session for the whole app, or one per window?
- Should Chat always operate the active desktop browser session, or only when explicitly attached?
- Do we want downloads in Phase 2 or leave them for later?
- Should browser screenshots be transient or persisted in workspace/browser history?

## Recommended Next Step

Implement Phase 1 only:

- persistent browser service
- minimal Tauri command layer
- replace the desktop `iframe`
- verify local development app inspection works

This is the smallest slice that validates the architecture without overcommitting to the full interactive model.
