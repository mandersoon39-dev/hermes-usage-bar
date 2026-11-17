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
 * "—" means unknown: the model has no usage rows yet, the CLI is down, or
 * the profile has no route — never a fake zero.
 *
 * Refresh: every turn end (busy -> idle, plus one delayed refetch after the
 * backend flushes), on model/profile switch, 30s backstop.
 * Theme variables only — no hard-coded colours, so it follows every skin.
 */
const CLI_TIMEOUT_MS = 20_000;
const PREFIX = ["usagebar"];
const CHIP = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover)";
const SEP = "px-0.5 text-(--ui-text-quaternary)";
const VALUE = "text-(--ui-text-secondary)";
const LABEL = "font-medium text-(--ui-text-secondary) max-w-[12rem] truncate";

// Atoms that may be absent on older app versions. Presence is static per
// app version, so the conditional subscription order is stable across renders.
const ATOMS = {
  usage: host.state && host.state.focusedUsage,
  model: host.state && host.state.model,
  session: host.state && host.state.focusedStoredSessionId,
  gateway: host.state && host.state.gateway,
};

function useSafeValue(atom, fallback) {
  if (atom) return useValue(atom);
  return fallback;
}

function scopeOf(owner) {
  const connectionId = String((owner && owner.connectionId) || "").trim();
  const profile = String((owner && owner.profile) || "").trim();
  return connectionId && profile ? { connectionId, profile } : null;
}

async function resolveRoute(scope) {
  const routes = await host.profileRoutes();
  if (scope) {
    const exact = routes.filter((r) => r.connectionId === scope.connectionId && r.profile === scope.profile);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact.find((r) => r.mode === "local") ?? exact[0];
    // A focused chat must belong to some route. Without an exact match we
    // refuse rather than silently attribute another profile's numbers.
    throw new Error(`No route for profile ${scope.profile}`);
  }
  const fallback = routes.find((r) => r.primary && r.mode === "local") ?? routes.find((r) => r.primary) ?? routes.find((r) => r.mode === "local") ?? routes[0];
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
  const res = await host.requestProfile(route, "cli.exec", { argv: ["--profile", route.targetProfile ?? route.profile, command, ...argv, "--json"], timeout: CLI_TIMEOUT_MS / 1000 }, CLI_TIMEOUT_MS + 5_000);
  if (!res) throw new Error("cli.exec returned no response");
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

/** Refetch when a turn finishes, once immediately and once after the backend has had time to flush state.db. */
function useRefreshOnTurnEnd(prefix) {
  const busy = useValue(host.state.busy);
  const qc = useQueryClient();
  const was = useRef(busy);
  useEffect(() => {
    const falling = was.current && !busy;
    was.current = busy;
    if (!falling) return;
    void qc.invalidateQueries({ queryKey: prefix });
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: prefix }), 2000);
    return () => clearTimeout(t);
  }, [busy, qc, prefix]);
}

function num(v) {
  // Number(null) is 0 — guard it so null means unknown, not a fake zero.
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs >= 100 ? abs.toFixed(0) : abs.toFixed(2)}`;
}

function compact(n) {
  const v = num(n);
  if (v === null) return "—";
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const k = v / 1000;
  if (Math.abs(k) < 999.95) return `${r1(k)}K`;
  const m = v / 1e6;
  if (Math.abs(m) < 999.95) return `${r1(m)}M`;
  return `${r1(v / 1e9)}B`;
}

function shortDate(iso, kind) {
  if (typeof iso !== "string") return "—";
  const parts = iso.split("-").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return "—";
  const date = new Date(parts[0], parts[1] - 1, kind === "day" ? parts[2] : 1);
  return kind === "month"
    ? date.toLocaleString(undefined, { month: "short", year: "numeric" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric" });
}

function shortModel(name) {
  const full = String(name || "");
  let base = full.split("/").pop();
  const cut = base.search(/[[\(]/);
  if (cut >= 0) base = base.slice(0, cut);
  base = base.trim() || full.trim();
  return base.length > 20 ? `${base.slice(0, 19)}…` : base;
}

function ModelChip({ model, convo, ranges, dayLabel, monthLabel, updated, error }) {
  const label = shortModel(model);
  const cCost = num(convo && convo.cost_usd);
  const cTokens = num(convo && convo.tokens);
  const ctxPct = num(convo && convo.context_percent);
  const t = ranges && ranges.today ? ranges.today : null;
  const m = ranges && ranges.month ? ranges.month : null;
  const hasConvo = cCost !== null;
  const hasRanges = !!(t && m);
  if (!hasConvo && !hasRanges) return null;
  const matched = hasRanges && ranges.matched !== false;
  const cCostTxt = hasConvo ? money(cCost) : "—";
  const tCost = matched ? money(t.cost_usd) : "—";
  const mCost = matched ? money(m.cost_usd) : "—";
  const convoSrc = convo && convo.source === "store" ? "store, may lag mid-turn" : "live";
  const lines = [
    `${model}${hasRanges && ranges.provider ? ` (${ranges.provider})` : ""} — conversation stats from the ${convoSrc} tracker, not provider billing`,
    hasConvo
      ? `This conversation: ${cCostTxt} · ${compact(cTokens)} tokens${ctxPct !== null ? ` · ctx ${Math.round(ctxPct)}%` : ""} (${convoSrc})`
      : "This conversation: —",
    hasRanges && matched
      ? `Today (${dayLabel}): ${tCost} · ${compact(t.tokens)} tokens · ${num(t.sessions) ?? 0} sessions`
      : `Today: —${hasRanges && !matched ? " (no usage rows for this model yet)" : ""}`,
    hasRanges && matched
      ? `Month (${monthLabel}): ${mCost} · ${compact(m.tokens)} tokens · ${num(m.sessions) ?? 0} sessions`
      : "Month: —",
  ];
  if (updated) lines.push(`Updated ${new Date(updated).toLocaleTimeString()}`);
  if (error) lines.push(`Usage bar unavailable: ${error}`);
  return _jsx("span", {
    role: "status",
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
  const rawUsage = useSafeValue(ATOMS.usage, null);
  const rawModel = useSafeValue(ATOMS.model, null);
  const rawSession = useSafeValue(ATOMS.session, null);
  const gateway = useSafeValue(ATOMS.gateway, null);
  useRefreshOnTurnEnd(PREFIX);
  const model = rawModel ? String(rawModel).trim() : "";
  const sid = rawSession ? String(rawSession).trim() : "";
  const liveCost = rawUsage && typeof rawUsage === "object" ? num(rawUsage.cost_usd) : null;
  const liveTokens = rawUsage && typeof rawUsage === "object" ? num(rawUsage.total) : null;
  const ctxPct = rawUsage && typeof rawUsage === "object" ? num(rawUsage.context_percent) : null;
  const q = useQuery({
    queryKey: [...PREFIX, key, model, sid],
    queryFn: () => profileCli(scope, "usagebar", ["summary", `--model=${model}`, ...(sid ? [`--session=${sid}`] : [])]),
    enabled: !!scope && !!model && gateway === "open",
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  if (!scope || !model) return null;
  const d = q.data;
  const ranges = d && d.model ? { today: d.model.today, month: d.model.month, provider: d.model.provider, matched: d.model.matched } : null;
  const sess = d && d.session ? d.session : null;
  // Live atom first; the store's per-conversation totals as fallback so the
  // conversation value never reads "—" while the session has known usage.
  const convo =
    liveCost !== null
      ? { cost_usd: liveCost, tokens: liveTokens, context_percent: ctxPct, source: "live" }
      : sess
        ? { cost_usd: num(sess.cost_usd), tokens: num(sess.tokens), context_percent: null, source: "store" }
        : null;
  return _jsx(ModelChip, {
    model: model,
    convo: convo,
    ranges: ranges,
    dayLabel: d ? shortDate(d.today, "day") : "—",
    monthLabel: d ? shortDate(d.month, "month") : "—",
    updated: d && d.generated_at ? d.generated_at : null,
    error: q.error ? String(q.error.message || q.error) : null,
  });
}

export default {
  id: "usage-bar",
  name: "Usage Bar",
  register(ctx) {
    ctx.register({ id: "statusbar", area: STATUSBAR_AREAS.right, order: 115, render: () => _jsx(UsageBar, {}) });
  },
};
