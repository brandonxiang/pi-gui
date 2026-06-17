# pi-workspace

`pi-workspace` is a browser-based agent console built on the
`@earendil-works/pi-coding-agent` SDK. It provides a desktop-like workspace UI
where you can chat with Pi agents, browse past Pi sessions, and open a live
terminal — all in one page.

## Features

### 对话模式 (Chat Mode)

The default view. The right panel shows a conversational chat interface with
streaming assistant responses, multi‑turn conversations, image attachment, and
model selection. Pi session history from your local `~/.pi/agent/sessions/` is
available in the sidebar — click any session to browse its full message history
and continue the conversation from the chat panel.

- Streaming assistant responses over Server-Sent Events
- Model selector for OpenAI, Anthropic, Google, Mistral, and Command Code models
- Editable system prompt
- Image attachment for vision-capable models
- Local conversation transcript persistence
- Pi session browsing, creation, and continuation

### 终端模式 (Terminal Mode)

Switch to a full web terminal (xterm.js) in the right panel. A shell starts in
the selected Pi session's project directory, and the `pi` CLI launches
automatically — pointed directly at that session.

- xterm.js with VS Code‑inspired dark theme
- Auto‑fit to panel size
- Server‑side PTY via `node-pty` with WebSocket transport
- `pi` CLI launched automatically into the selected Pi session

Switch modes in **Settings → 模式 → 对话模式 / 终端模式**.

## Quick Start

```bash
npm install
npm exec -- pi-workspace
```

If you already use Pi locally, the server reads your existing Pi auth from
`~/.pi/agent/auth.json` and custom models from `~/.pi/agent/models.json`.
It also detects Command Code CLI login credentials from
`~/.commandcode/auth.json`.

When Command Code auth is present, the server fetches live models from
`https://api.commandcode.ai/provider/v1/models` and registers them under the
`commandcode` provider.

To customize the server port, create a local `.env` from `.env.example`
and change `PORT`.

```bash
npm exec -- pi-workspace        # start the built service
npm exec -- pi-workspace build  # build client + server bundles
npm exec -- pi-workspace --help # show all options
```

Open <http://127.0.0.1:8787>.

## Development

```bash
pnpm run dev     # starts the dev server with hot‑reload
pnpm run build   # typecheck + build client + server
pnpm start       # production start after build
```

## Architecture

- `client/` — React (Vite) UI with Ant Design X components.
- `server/index.ts` — Fastify server that owns the Pi Coding Agent SDK
  integration.
- The frontend sends only the latest user prompt and session metadata.
- The backend keeps a per-browser-session `AgentSession` in memory and streams
  `message_update` deltas back to the browser.
- `AuthStorage.create()` and `ModelRegistry.create()` load the same local auth
  and model registry that the Pi CLI uses.

By default the server starts Pi sessions with `noTools: "all"` so the online
chat cannot execute shell or file mutation tools. Add a deliberate tool allowlist
only after adding authentication and permission controls.

## npm Packaging

The package ships as a CLI that bundles both the API server and the frontend:

- `npm publish` runs `prepack`, which builds `dist/client` and `dist-server`
- the published tarball includes only the CLI entrypoint and built runtime assets
- `pi-workspace` starts the bundled production server directly from
  `dist-server/index.mjs`

## Attribution

This project is customized from the public Pi ecosystem by Earendil Works:
<https://github.com/earendil-works/pi>.
