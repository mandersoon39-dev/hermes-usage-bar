import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from "react";
import { host, STATUSBAR_AREAS, useQuery, useQueryClient, useValue } from "@hermes/plugin-sdk";

/**
 * usage-bar — desktop half.
 *
 * One status-bar chip at the bottom-right of the app, for the model the
 * focused conversation is running:
 *
 *   claude-opus-5-5 $0.42 | $0.74 | $57.70
 *
 * Three values in order: this conversation | today | this calendar month.
 * The conversation value is the app's own live usage atom
 * (host.state.focusedUsage — same numbers the app's Usage panel shows);
 * today/month come from the focused profile's CLI
 * (usagebar summary --model <model>), i.e. read-only SQL over state.db.
 *
 * Refresh: every turn end (busy -> idle), on model switch, 30s backstop.
 * Theme variables only — no hard-coded colours, so it follows every skin.
 */
const CLI_TIMEOUT_MS = 20_000;
const PREFIX = ["usagebar"];
const CHIP = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover)";
const SEP = "px-0.5 text-(--ui-text-quaternary)";
const VALUE = "text-(--ui-text-quaternary)";
const LABEL = "font-medium text-(--ui-text-secondary) max-w-[12rem] truncate";

function scopeOf(owner) {
  const connectionId = String((owner && owner.connectionId) || "").trim();
  const profile = String((owner && owner.profile) || "").trim();
  return connectionId && profile ? { connectionId, profile } : null;
}

async function resolveRoute(scope) {
  const routes = await host.profileRoutes();
  const exact = scope ? routes.filter((r) => r.connectionId === scope.connectionId && r.profile === scope.profile) : [];
  if (exact.length === 1) return exact[0];
  // No focused chat (or ambiguous): fall back to the desktop's primary local route.
  const fallback = routes.find((r) => r.primary) ?? routes.find((r) => r.mode === "local") ?? routes[0];
  if (!fallback) throw new Error("No Hermes profile route available");
  return fallback;
}

/** cli.exec joins stdout+stderr; pick the last line that parses as a JSON object. */
function parseCliJson(output) {
  const lines = (output || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  throw new Error((output || "").trim().split("\n").slice(-3).join(" ") || "empty output from hermes usagebar");
}

async function profileCli(scope, command, argv) {
  const route = await resolveRoute(scope);
  const res = await host.requestProfile(route, "cli.exec", { argv: ["--profile", route.targetProfile, command, ...argv, "--json"], timeout: CLI_TIMEOUT_MS / 1000 }, CLI_TIMEOUT_MS + 5_000);
  if (res.blocked) throw new Error(res.hint || "cli.exec blocked");
  const payload = parseCliJson(res.output || "");
  if (payload.error) throw new Error(payload.error);
  return payload;
}

function useScope() {
  const owner = useValue(host.state.focusedSessionOwner);
  const scope = scopeOf(owner);
  return { scope, key: scope ? `${scope.connectionId}::${scope.profile}` : "primary" };
}

/** Invalidate our queries when a turn finishes, so numbers stay current without polling. */
function useRefreshOnTurnEnd(prefix) {
  const busy = useValue(host.state.busy);
  const qc = useQueryClient();
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy) void qc.invalidateQueries({ queryKey: prefix });
    was.current = busy;
  }, [busy, qc, prefix]);
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}K`;
  if (v < 1e9) return `${(v / 1e6).toFixed(1)}M`;
  return `${(v / 1e9).toFixed(1)}B`;
}

function shortDate(iso, kind) {
  const parts = iso.split("-").map(Number);
  const date = new Date(parts[0] || 1970, (parts[1] || 1) - 1, kind === "day" ? parts[2] || 1 : 1);
  return kind === "month"
    ? date.toLocaleString(undefined, { month: "short", year: "numeric" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric" });
}

function shortModel(name) {
  let base = String(name || "").split("/").pop().split("[").split("(")[0].trim();
  return base.length > 20 ? `${base.slice(0, 19)}…` : base;
}

function ModelChip({ model, convo, ranges, dayLabel, monthLabel, updated }) {
  const label = shortModel(model);
  const hasLive = convo && Number.isFinite(convo.cost_usd);
  const hasRanges = !!(ranges && ranges.today && ranges.month);
  if (!hasLive && !hasRanges) return null;
  const cCost = hasLive ? money(convo.cost_usd) : "—";
  const tCost = hasRanges ? money(ranges.today.cost_usd) : "—";
  const mCost = hasRanges ? money(ranges.month.cost_usd) : "—";
  const lines = [
    `${model}${hasRanges && ranges.provider ? ` (${ranges.provider})` : ""} — ${hasLive ? "live" : "estimated"} conversation stats, not provider billing`,
    hasLive
      ? `This conversation: ${cCost} · ${compact(convo.tokens)} tokens${Number.isFinite(convo.context_percent) ? ` · ctx ${Math.round(convo.context_percent)}%` : ""}`
      : "This conversation: —",
    hasRanges
      ? `Today (${dayLabel}): ${tCost} · ${compact(ranges.today.tokens)} tokens · ${ranges.today.sessions} sessions`
      : "Today: —",
    hasRanges
      ? `Month (${monthLabel}): ${mCost} · ${compact(ranges.month.tokens)} tokens · ${ranges.month.sessions} sessions`
      : "Month: —",
  ];
  if (updated) lines.push(`Updated ${new Date(updated).toLocaleTimeString()}`);
  return _jsx("button", {
    type: "button",
    title: lines.join("\n"),
    "aria-label": `${label}: ${cCost} this conversation, ${tCost} today, ${mCost} this month`,
    className: CHIP,
    children: _jsxs("span", {
      className: "inline-flex items-center gap-1 whitespace-nowrap",
      children: [
        _jsx("span", { className: LABEL, children: label }),
        _jsx("span", { className: VALUE, children: cCost }),
        _jsx("span", { className: SEP, children: "|" }),
        _jsx("span", { className: VALUE, children: tCost }),
        _jsx("span", { className: SEP, children: "|" }),
        _jsx("span", { className: VALUE, children: mCost }),
      ],
    }),
  });
}

function UsageBar() {
  const { scope, key } = useScope();
  const rawUsage = useValue(host.state.focusedUsage);
  const rawModel = useValue(host.state.model);
  useRefreshOnTurnEnd(PREFIX);
  const model = rawModel ? String(rawModel).trim() : "";
  const convo = rawUsage && typeof rawUsage === "object"
    ? { cost_usd: rawUsage.cost_usd, tokens: rawUsage.total, context_percent: rawUsage.context_percent }
    : null;
  const q = useQuery({
    queryKey: [...PREFIX, key, model],
    queryFn: () => profileCli(scope, "usagebar", ["summary", "--model", model]),
    enabled: !!model,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  if (!model) return null;
  const d = q.data;
  const ranges = d && d.model ? { today: d.model.today, month: d.model.month, provider: d.model.provider } : null;
  return _jsx(ModelChip, {
    model: model,
    convo: convo,
    ranges: ranges,
    dayLabel: d ? shortDate(d.today, "day") : "—",
    monthLabel: d ? shortDate(d.month, "month") : "—",
    updated: d && d.generated_at ? d.generated_at : null,
  });
}

export default {
  id: "usage-bar",
  name: "Usage Bar",
  register(ctx) {
    ctx.register({ id: "statusbar", area: STATUSBAR_AREAS.right, order: 115, render: () => _jsx(UsageBar, {}) });
  },
};
