"""``hermes usagebar`` CLI command and ``/usagebar`` slash command.

The desktop half (``desktop/plugin.js``) calls
``hermes --profile <p> usagebar summary --json`` and
``hermes --profile <p> usagebar session <id> --json`` through the gateway's
``cli.exec`` RPC, so every call runs in a fresh process against the right
profile and no gateway restart is ever needed.
"""

from __future__ import annotations

import json
import sys

from . import usage_data as data

HELP = """Usage: /usagebar
Today's and this month's cost and tokens for the paid API providers
(Claude/Anthropic, AI Studio/Google), from this profile's session store.

For one conversation:  /usagebar session <session-id>"""


def _fmt(n) -> str:
    for size, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= size:
            return f"{n / size:.1f}{suffix}"
    return str(int(n or 0))


def render_text(session_id: str = None) -> str:
    s = data.summary(session_id=session_id)
    lines = [
        f"Usage - {s['today']} today, {s['month']} month "
        "(costs are Hermes estimates, not provider billing):"
    ]
    if s.get("model"):
        m = s["model"]
        lines.append(
            f"  Current model {m['name']} ({m['provider']}):"
            f" ${m['convo']['cost_usd']:.2f} convo | ${m['today']['cost_usd']:.2f} today | ${m['month']['cost_usd']:.2f} month"
        )
    for group in ("anthropic", "gemini"):
        p = s["providers"][group]
        t, mm = p["today"], p["month"]
        lines.append(
            f"  {p['label']}: ${t['cost_usd']:.2f} today - {_fmt(t['tokens'])} tok - {t['sessions']} sessions"
            f" | ${mm['cost_usd']:.2f} month - {_fmt(mm['tokens'])} tok - {mm['sessions']} sessions"
        )
    return "\n".join(lines)


def render_session_text(p: dict) -> str:
    lines = [
        f"Session {p['session_id']}" + (f" - {p['title']}" if p.get("title") else ""),
        f"  Model: {p['model'] or '?'} ({p['billing_provider'] or '?'})"
        f" - {p['messages']} messages - {p['api_calls']} API calls",
        f"  Tokens: {_fmt(p['tokens'])} total"
        f" ({_fmt(p['input_tokens'])} in, {_fmt(p['output_tokens'])} out, {_fmt(p['cache_tokens'])} cache)",
        f"  Cost: ${p['cost_usd']:.2f} (Hermes estimate, in-progress while active)",
    ]
    if p.get("models"):
        top = p["models"][0]
        lines.append(f"  Top model: {top['model']} (${top['cost_usd']:.2f})")
    return "\n".join(lines)


def slash_command(raw_args: str) -> str:
    raw = (raw_args or "").strip()
    if raw in ("help", "-h", "--help", "?"):
        return HELP
    try:
        if raw.startswith("session "):
            sid = raw.split(None, 1)[1].strip()
            if not sid:
                return HELP
            return render_session_text(data.session_usage(sid))
        return render_text()
    except data.UsageBarError as exc:
        return f"usagebar: {exc}"


def setup_argparse(subparser) -> None:
    subs = subparser.add_subparsers(dest="usagebar_command")
    p = subs.add_parser("summary", help="This conversation's, today's and this month's cost and tokens per paid provider")
    p.add_argument("--session", default=None, help="Session id to include per-provider conversation usage")
    p.add_argument("--json", action="store_true", help="Emit JSON for the desktop status bar")
    s = subs.add_parser("session", help="Usage for one conversation (session id)")
    s.add_argument("session_id", help="Session id, e.g. 20261116_224351_297c0c")
    s.add_argument("--json", action="store_true", help="Emit JSON for the desktop status bar")
    subparser.set_defaults(func=handle_cli)


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), default=str) + "\n")


def handle_cli(args) -> None:
    cmd = getattr(args, "usagebar_command", None) or "summary"
    as_json = bool(getattr(args, "json", False))
    try:
        if cmd == "summary":
            payload = data.summary(session_id=getattr(args, "session", None))
        elif cmd == "session":
            sid = (getattr(args, "session_id", None) or "").strip()
            if not sid:
                sys.stderr.write("usagebar session: missing session id\n")
                sys.exit(2)
            payload = data.session_usage(sid)
        else:
            sys.stderr.write(f"usagebar: unknown command {cmd!r}\n")
            sys.exit(2)
    except data.UsageBarError as exc:
        if as_json:
            _emit({"error": str(exc), "plugin_version": data.PLUGIN_VERSION})
        else:
            sys.stderr.write(f"usagebar: {exc}\n")
        sys.exit(1)
    if as_json:
        _emit(payload)
        return
    if cmd == "session":
        print(render_session_text(payload))
    else:
        print(render_text(getattr(args, "session", None)))
