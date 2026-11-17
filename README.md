# usage-bar

Status-bar chips (bottom-right of Hermes Desktop) showing today's and this
month's cost + tokens for the paid API providers, from this profile's local
session store:

- **Claude** — `billing_provider = anthropic` (api.anthropic.com)
- **AI Studio** — `billing_provider = gemini` (generativelanguage.googleapis.com)

## Surfaces
- Desktop status-bar chips (this folder's `desktop/plugin.js`, published to
  `~/.hermes/desktop-plugins/usage-bar/`), one per provider, three values in
  order Convo | Daily | Monthly:
  `Claude $0.42 | $0.74 | $57.70` · `AI Studio $2.11 | $5.30 | $16.57`
  — the first value is the focused conversation's usage attributed to that
  provider (`host.state.activeSessionId`). Hover for tokens, sessions, top
  model. Refreshes on every turn end, on conversation switch, + 30s backstop.
- `hermes usagebar` / `hermes usagebar summary [--session <session-id>] --json`
- `hermes usagebar session <session-id> [--json]`
- `/usagebar` and `/usagebar session <session-id>` slash commands

## Data
Read-only SQL over `~/.hermes/state.db` (`session_model_usage`), bucketed by
`first_seen` (when the provider's usage started in a session). Cost is the
stored Hermes estimate/actual, not a provider billing statement. No network,
no credentials, no telemetry.

## Notes
- The desktop half follows the same pattern as hermes-activity: it runs the
  CLI through the gateway's `cli.exec` RPC, so no gateway restart is needed
  for data; the chip works per focused profile.
- A chip is hidden when its provider has no cost/tokens in either period.
- The conversation value is an in-progress estimate: it tracks the session
  store, which updates as turns complete (not mid-turn).
