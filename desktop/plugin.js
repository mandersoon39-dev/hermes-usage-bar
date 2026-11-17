import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from "react";
import { host, STATUSBAR_AREAS, useQuery, useQueryClient, useValue } from "@hermes/plugin-sdk";

/**
 * usage-bar — desktop half.
 *
 * Status-bar chips at the bottom-right of the app: today's and this month's
 * cost + tokens for the paid API providers (Claude/Anthropic, AI Studio/Google),
 * read from the profile's session store.
 *
 * Data path
 *   host.requestProfile(route, "cli.exec", { argv: ["--profile", p, "usagebar", "summary", "--json"] })
 *   -> the focused profile's Hermes CLI -> read-only SQL over state.db.
 *   Each call is a fresh process, so the plugin works without a gateway restart.
 *
 * Refresh: every turn end (busy -> idle) plus a 5-minute backstop.
 * Theme variables only — no hard-coded colours, so it follows every skin.
 */
const CLI_TIMEOUT_MS = 20_000;
const PREFIX = ["usagebar"];
const CHIP = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover)";

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
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
}

function compact(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

function shortDate(iso, kind) {
  const parts = iso.split("-").map(Number);
  const date = new Date(parts[0] || 1970, (parts[1] || 1) - 1, kind === "day" ? parts[2] || 1 : 1);
  return kind === "month"
    ? date.toLocaleString(undefined, { month: "short", year: "numeric" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric" });
}

function ProviderChip({ group, data }) {
  const p = (data && data.providers && data.providers[group]) || null;
  if (!p) return null;
  const t = p.today, m = p.month;
  if (!t || !m) return null;
  const hasAny = (t.cost_usd || 0) > 0 || (t.tokens || 0) > 0 || (m.cost_usd || 0) > 0 || (m.tokens || 0) > 0;
  if (!hasAny) return null;
  const label = group === "anthropic" ? "Claude" : "AI Studio";
  const todayLabel = shortDate(data.today, "day");
  const monthLabel = shortDate(data.month, "month");
  const topLine = m.top_model ? `Top model: ${m.top_model} (${money(m.top_model_cost_usd)})` : "";
  const tip = [
    `${p.label} — Hermes cost estimates, not provider billing`,
    `${todayLabel}: ${money(t.cost_usd)} · ${compact(t.tokens)} tokens · ${t.sessions} sessions`,
    `${monthLabel}: ${money(m.cost_usd)} · ${compact(m.tokens)} tokens · ${m.sessions} sessions`,
    topLine,
    `Updated ${new Date(data.generated_at).toLocaleTimeString()}`,
  ].filter(Boolean).join("\n");
  return _jsx("button", {
    type: "button",
    title: tip,
    "aria-label": `${label}: ${money(t.cost_usd)} today, ${money(m.cost_usd)} this month`,
    className: CHIP,
    children: _jsxs("span", {
      className: "inline-flex items-center gap-1.5 whitespace-nowrap",
      children: [
        _jsx("span", { className: "font-medium text-(--ui-text-secondary)", children: label }),
        _jsx("span", { className: "text-(--ui-text-quaternary)", children: `${money(t.cost_usd)}d  ${money(m.cost_usd)}m` }),
      ],
    }),
  });
}

function SessionChip() {
  const activeSessionId = useValue(host.state.activeSessionId);
  const { scope, key } = useScope();
  useRefreshOnTurnEnd(PREFIX);
  const sid = activeSessionId ? String(activeSessionId).trim() : "";
  const q = useQuery({
    queryKey: [...PREFIX, "session", key, sid],
    queryFn: () => profileCli(scope, "usagebar", ["session", sid]),
    enabled: !!sid,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const d = q.data;
  if (!d) return null;
  if (!d.tokens && !(d.cost_usd > 0)) return null;
  const paid = (d.cost_usd || 0) > 0;
  const value = paid ? `${money(d.cost_usd)} · ${compact(d.tokens)}` : `${compact(d.tokens)} tok`;
  const title = d.title || d.session_id;
  const tip = [
    `${title} (${d.session_id})`,
    `${compact(d.tokens)} tokens (${compact(d.input_tokens)} in · ${compact(d.output_tokens)} out · ${compact(d.cache_tokens)} cache)`,
    `Cost: ${money(d.cost_usd)} estimated (in-progress while the conversation is active)`,
    `${d.model || "?"} · ${d.messages} messages · ${d.api_calls} API calls`,
    d.models && d.models.length ? `Top model: ${d.models[0].model} (${money(d.models[0].cost_usd)})` : "",
    d.last_activity_at ? `Last activity ${new Date(d.last_activity_at * 1000).toLocaleString()}` : "",
  ].filter(Boolean).join("\n");
  return _jsx("button", {
    type: "button",
    title: tip,
    "aria-label": `Current conversation: ${value}`,
    className: CHIP,
    children: _jsxs("span", {
      className: "inline-flex items-center gap-1.5 whitespace-nowrap",
      children: [
        _jsx("span", { className: "font-medium text-(--ui-text-secondary)", children: "this chat" }),
        _jsx("span", { className: "text-(--ui-text-quaternary)", children: value }),
      ],
    }),
  });
}

function UsageBar() {
  const { scope, key } = useScope();
  useRefreshOnTurnEnd(PREFIX);
  const q = useQuery({
    queryKey: [...PREFIX, key],
    queryFn: () => profileCli(scope, "usagebar", ["summary"]),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  if (!q.data) return null; // stay invisible until we have a real number (or if the backend is off)
  return _jsxs("span", {
    className: "inline-flex items-center gap-1",
    children: [
      _jsx(SessionChip, {}),
      _jsx(ProviderChip, { group: "anthropic", data: q.data }),
      _jsx(ProviderChip, { group: "gemini", data: q.data }),
    ],
  });
}

export default {
  id: "usage-bar",
  name: "Usage Bar",
  register(ctx) {
    ctx.register({ id: "statusbar", area: STATUSBAR_AREAS.right, order: 115, render: () => _jsx(UsageBar, {}) });
  },
};
