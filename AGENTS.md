# Agent Notes

## Project Goal

Build and maintain a browser-based agent dialogue tool backed by
`@earendil-works/pi-coding-agent` as an SDK dependency.

## Development Commands

- Install dependencies: `npm install`
- Start local app: `npm run dev`
- Typecheck and build: `npm run build`
- Production start after build: `npm start`

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

## Verification

Before handing off changes, run:

```bash
npm run build
```

For UI changes, also start `npm run dev` and verify the page in a browser.
