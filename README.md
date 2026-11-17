# usage-bar

Status-bar chips (bottom-right of Hermes Desktop) showing today's and this
month's cost + tokens for the paid API providers, from this profile's local
session store:

- **Claude** — `billing_provider = anthropic` (api.anthropic.com)
- **AI Studio** — `billing_provider = gemini` (generativelanguage.googleapis.com)

## Surfaces
- Desktop status-bar chip (this folder's `desktop/plugin.js`, published to
  `~/.hermes/desktop-plugins/usage-bar/`) for the model the focused
  conversation is running (`host.state.model`), three values in
  order Convo | Daily | Monthly:
  `claude-opus-5-5 $0.42 | $0.74 | $57.70`
  The conversation value is the app's own live usage atom
  (`host.state.focusedUsage` — same numbers the Usage panel shows, updates
  in real time); today/month come from the profile's CLI
  (`usagebar summary --model <model>`). Hover for tokens, sessions,
  context %, provider. Refreshes on every turn end, on model switch, + 30s
  backstop. Hidden when no session is focused. Local models show $0.00
  until they get a real price model.
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
