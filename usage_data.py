"""usage-bar data layer: read-only cost and token aggregates over the profile's ``state.db``.

* The database is opened with SQLite's ``mode=ro`` URI, so this module can never write.
* Provider rows come from ``session_model_usage`` (one row per session x model) and are
  bucketed by ``first_seen`` -- when that provider's usage started in a session. Same
  day-attribution rule the Activity plugin uses.
* Cost is the stored Hermes estimate/actual, not a provider-wide billing statement.

No network calls, no credentials: this only reads the local session store.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

PLUGIN_VERSION = "1.2.0"

#: ``billing_provider`` values (lower-cased) that map to a named display group.
NAMED_GROUPS = {
    "anthropic": "anthropic",   # Claude / Anthropic API
    "gemini": "gemini",         # Google AI Studio (Gemini API)
}
GROUP_LABELS = {
    "anthropic": "Claude (Anthropic API)",
    "gemini": "AI Studio (Google)",
    "other": "Everything else",
}
OTHER = "other"


class UsageBarError(Exception):
    """User-facing failure (missing store, unexpected schema)."""


def db_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "state.db"


def _connect() -> sqlite3.Connection:
    path = db_path()
    if not path.exists():
        raise UsageBarError("no session store yet (state.db missing)")
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _group_case_sql() -> str:
    """SQL CASE that maps a raw billing_provider to a display group."""
    return (
        "CASE WHEN LOWER(billing_provider) = 'anthropic' THEN 'anthropic'"
        " WHEN LOWER(billing_provider) = 'gemini' THEN 'gemini' ELSE 'other' END"
    )


def _empty_bucket() -> dict:
    return {
        "cost_usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_tokens": 0,
        "tokens": 0,
        "sessions": 0,
        "top_model": None,
        "top_model_cost_usd": 0.0,
    }


def _totals(conn: sqlite3.Connection, where: str, params: tuple) -> dict:
    """Flat cost/token totals for rows matching ``where`` (no grouping)."""
    row = conn.execute(
        f"""
        SELECT COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS i,
               COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS o,
               COALESCE(SUM(COALESCE(cache_read_tokens, 0)
                 + COALESCE(cache_write_tokens, 0)), 0) AS cr,
               COALESCE(SUM(COALESCE(estimated_cost_usd, 0)
                 + COALESCE(actual_cost_usd, 0)), 0) AS cost,
               COUNT(DISTINCT session_id) AS sessions
        FROM session_model_usage
        WHERE {where}
        """,
        params,
    ).fetchone()
    tokens = int(row["i"]) + int(row["o"]) + int(row["cr"])
    return {
        "cost_usd": round(float(row["cost"]), 4),
        "input_tokens": int(row["i"]),
        "output_tokens": int(row["o"]),
        "cache_tokens": int(row["cr"]),
        "tokens": tokens,
        "sessions": int(row["sessions"]),
    }


def _bucket(conn: sqlite3.Connection, start_ts: float = None, session_id: str = None) -> dict:
    """Per-group aggregates.

    With ``session_id``: rows for that one conversation (no date filter).
    Without: rows whose usage started at/after ``start_ts``.
    """
    group_sql = _group_case_sql()
    cost_sql = "SUM(COALESCE(estimated_cost_usd, 0) + COALESCE(actual_cost_usd, 0))"
    if session_id:
        where, params = "session_id = ?", (session_id,)
    else:
        where, params = "COALESCE(first_seen, last_seen) >= ?", (start_ts,)

    by_model = conn.execute(
        f"""
        SELECT {group_sql} AS grp,
               model,
               SUM(COALESCE(input_tokens, 0))      AS i,
               SUM(COALESCE(output_tokens, 0))     AS o,
               SUM(COALESCE(cache_read_tokens, 0)
                 + COALESCE(cache_write_tokens, 0)) AS cr,
               {cost_sql}                           AS cost
        FROM session_model_usage
        WHERE {where}
        GROUP BY grp, model
        """,
        params,
    ).fetchall()
    sessions = conn.execute(
        f"""
        SELECT {group_sql} AS grp,
               COUNT(DISTINCT session_id) AS sessions
        FROM session_model_usage
        WHERE {where}
        GROUP BY grp
        """,
        params,
    ).fetchall()

    buckets = {group: _empty_bucket() for group in ("anthropic", "gemini", OTHER)}
    for r in by_model:
        b = buckets[r["grp"]]
        cost = float(r["cost"] or 0.0)
        b["cost_usd"] += cost
        b["input_tokens"] += int(r["i"] or 0)
        b["output_tokens"] += int(r["o"] or 0)
        b["cache_tokens"] += int(r["cr"] or 0)
        if cost > b["top_model_cost_usd"]:
            b["top_model"] = r["model"]
            b["top_model_cost_usd"] = cost
    for r in sessions:
        buckets[r["grp"]]["sessions"] = int(r["sessions"] or 0)
    for b in buckets.values():
        b["tokens"] = b["input_tokens"] + b["output_tokens"] + b["cache_tokens"]
        b["cost_usd"] = round(b["cost_usd"], 4)
    return buckets


def session_usage(session_id: str) -> dict:
    """Usage for one conversation: session totals plus a per-model breakdown.

    Cost is the stored Hermes estimate/actual (in-progress while the
    conversation is active), not a billing statement.
    """
    sid = (session_id or "").strip()
    if not sid:
        raise UsageBarError("no session id given")
    with _connect() as conn:
        s_row = conn.execute(
            """
            SELECT id, title, model, billing_provider, started_at, last_activity_at,
                   message_count, api_call_count,
                   COALESCE(input_tokens, 0)    AS i,
                   COALESCE(output_tokens, 0)   AS o,
                   COALESCE(cache_read_tokens, 0)
                 + COALESCE(cache_write_tokens, 0) AS cr,
                   COALESCE(estimated_cost_usd, 0)
                 + COALESCE(actual_cost_usd, 0)    AS cost
            FROM sessions WHERE id = ?
            """,
            (sid,),
        ).fetchone()
        if s_row is None:
            raise UsageBarError(f"session {sid} not found in this profile's store")
        models = conn.execute(
            """
            SELECT model,
                   SUM(COALESCE(estimated_cost_usd, 0)
                     + COALESCE(actual_cost_usd, 0)) AS cost,
                   SUM(COALESCE(input_tokens, 0))    AS i,
                   SUM(COALESCE(output_tokens, 0))   AS o
            FROM session_model_usage WHERE session_id = ?
            GROUP BY model ORDER BY cost DESC
            """,
            (sid,),
        ).fetchall()
    tokens = int(s_row["i"]) + int(s_row["o"]) + int(s_row["cr"])
    return {
        "session_id": sid,
        "title": s_row["title"],
        "model": s_row["model"],
        "billing_provider": s_row["billing_provider"],
        "cost_usd": round(float(s_row["cost"] or 0.0), 4),
        "input_tokens": int(s_row["i"]),
        "output_tokens": int(s_row["o"]),
        "cache_tokens": int(s_row["cr"]),
        "tokens": tokens,
        "messages": int(s_row["message_count"] or 0),
        "api_calls": int(s_row["api_call_count"] or 0),
        "started_at": s_row["started_at"],
        "last_activity_at": s_row["last_activity_at"],
        "models": [
            {
                "model": m["model"],
                "cost_usd": round(float(m["cost"] or 0.0), 4),
                "tokens": int(m["i"] or 0) + int(m["o"] or 0),
            }
            for m in models
        ],
    }


def summary(session_id: str = None) -> dict:
    """Per display group: this conversation (when given), today, this calendar month."""
    now = datetime.now()
    today_ts = datetime(now.year, now.month, now.day).timestamp()
    month_ts = datetime(now.year, now.month, 1).timestamp()
    sid = (session_id or "").strip() or None
    with _connect() as conn:
        today_b = _bucket(conn, start_ts=today_ts)
        month_b = _bucket(conn, start_ts=month_ts)
        convo_b = _bucket(conn, session_id=sid) if sid else {}
    current = None
    if sid:
        srow = conn.execute(
            "SELECT model, billing_provider FROM sessions WHERE id = ?", (sid,)
        ).fetchone()
        if srow and srow["model"]:
            m = srow["model"]
            current = {
                "name": m,
                "provider": srow["billing_provider"],
                "convo": _totals(conn, "session_id = ? AND model = ?", (sid, m)),
                "today": _totals(conn, "model = ? AND COALESCE(first_seen, last_seen) >= ?", (m, today_ts)),
                "month": _totals(conn, "model = ? AND COALESCE(first_seen, last_seen) >= ?", (m, month_ts)),
            }
    providers = {}
    for group in ("anthropic", "gemini", OTHER):
        providers[group] = {
            "label": GROUP_LABELS[group],
            "convo": (convo_b.get(group) or _empty_bucket()) if sid else None,
            "today": today_b.get(group) or _empty_bucket(),
            "month": month_b.get(group) or _empty_bucket(),
        }
    return {
        "plugin_version": PLUGIN_VERSION,
        "generated_at": now.isoformat(timespec="seconds"),
        "today": now.strftime("%Y-%m-%d"),
        "month": now.strftime("%Y-%m"),
        "session_id": sid,
        "model": current,
        "providers": providers,
    }
