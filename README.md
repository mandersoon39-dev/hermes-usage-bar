# usage-bar

Status-bar chips (bottom-right of Hermes Desktop) showing today's and this
month's cost + tokens for the paid API providers, from this profile's local
session store:

- **Claude** — `billing_provider = anthropic` (api.anthropic.com)
- **AI Studio** — `billing_provider = gemini` (generativelanguage.googleapis.com)

## Surfaces
- Desktop status-bar chips (this folder's `desktop/plugin.js`, published to
  `~/.hermes/desktop-plugins/usage-bar/`):
  `this chat 3.0M tok` · `Claude $0.74d $57.70m` · `AI Studio $5.30d $16.57m`
  — hover for full details. The `this chat` chip follows
  `host.state.activeSessionId` (the conversation you're looking at), refreshes
  on every turn end + 30s; provider chips refresh on every turn end + 5 min.
- `hermes usagebar` / `hermes usagebar summary --json`
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
- The `this chat` chip is an in-progress estimate for the active conversation:
  it tracks the session store, which updates as turns complete (not mid-turn).
