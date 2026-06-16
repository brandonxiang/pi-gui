# Agent Notes

## Project Goal

Build and maintain a browser-based agent dialogue tool backed by
`@earendil-works/pi-coding-agent` as an SDK dependency.

## Development Commands

- Install dependencies: `pnpm install`
- Start local dev server (rolldown watch + node --watch): `pnpm run dev`
- Run tests: `pnpm run test`
- Typecheck (client + server): `pnpm run typecheck`
- Build client + server: `pnpm run build`
- Production start after build: `pnpm start`

## Key Files

- `dev.mjs` — Dev server launcher (rolldown --watch + node --watch)
- `rolldown.server.config.mjs` — rolldown configuration for server bundling

## Implementation Rules

- Keep API keys on the server. Do not expose model provider keys in frontend code.
- Server auth should read local Pi credentials from `~/.pi/agent/auth.json` by default,
  with `.env` provider keys as runtime overrides.
- Use `@earendil-works/pi-coding-agent` for agent sessions; do not replace it with
  direct provider calls unless the user explicitly asks.
- Default online sessions should not enable shell or file mutation tools.
- If enabling tools later, add explicit authentication, workspace isolation, and
  permission prompts first.
- Preserve streaming behavior over `/api/chat`; the UI should show deltas while
  the agent is responding.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses default label names (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one CONTEXT.md + docs/adr/ at the repo root. See `docs/agents/domain.md`.

## Verification

Before handing off changes, run:

```bash
npm run build
```

For UI changes, also start `npm run dev` and verify the page in a browser.
