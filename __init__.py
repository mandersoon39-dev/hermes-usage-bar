"""usage-bar: status-bar cost/usage chips for Hermes Desktop.

Registers:
  * ``hermes usagebar`` CLI command (``summary``, ``--json`` for the desktop status bar);
  * ``/usagebar`` slash command with a short text summary.

The desktop UI lives in ``desktop/plugin.js`` and reads data by running
``hermes usagebar summary --json`` through the gateway's ``cli.exec`` RPC.
Everything is read-only over the local session store; no network calls.
"""

from __future__ import annotations

from . import commands


def register(ctx) -> None:
    ctx.register_command(
        "usagebar",
        handler=commands.slash_command,
        description="Today's and this month's cost/tokens for the paid API providers (usage-bar)",
        args_hint="",
    )
    ctx.register_cli_command(
        name="usagebar",
        help="Cost and token usage for the paid API providers (usage-bar plugin)",
        setup_fn=commands.setup_argparse,
        handler_fn=commands.handle_cli,
    )
