// Ad platform ingestion (PRODUCT MANDATE 2, 6, 14).
//
// Spend currently arrives by someone typing it in. That works and it is honest, but it goes stale the week
// everyone gets busy, and a cost-per-lead computed against stale spend is worse than none. These adapters pull
// it instead.
//
// Provider-agnostic for the same reason as the AI and voice layers: AdPlatform has fetchSpend(), Google Ads and
// Meta are two implementations, and a third is a new object. Every adapter is INERT until its credentials exist
// - configured() reports what is missing by name rather than failing at 3am inside a cron.
//
// What it will not do: invent. If a platform returns nothing for a period, the period is recorded as zero-with-a
// -reason, never skipped, because a missing week silently dropped from the denominator flatters cost per lead.
import { sb, json, event } from "./core.ts";

export interface SpendRow {
  channel_key: string; period_start: string; period_end: string;
  amount: number; clicks?: number; impressions?: number; leads_reported?: number; note?: string;
}
export interface AdPlatform {
  id: string;
  label: string;
  channel_key: string;
  /** Which env vars this adapter needs. Names only - values are never read into a response. */
  requires: string[];
  configured(): boolean;
  /** Pull spend for [start, end]. Throws with a readable message; never returns a guess. */
  fetchSpend(start: string, end: string): Promise<SpendRow[]>;
}

const env = (k: string) => Deno.env.get(k) ?? "";
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---- Google Ads ---------------------------------------------------------------------------------------------
// The Google Ads API needs a developer token, an OAuth refresh token for a user with account access, and the
// customer id. Reporting is GAQL over REST. Costs come back in micros - 1,000,000 micros = $1 - and forgetting
// that division is the classic way to report a $5 campaign as $5,000,000.
const googleAds: AdPlatform = {
  id: "google_ads", label: "Google Ads", channel_key: "google_search",
  requires: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"],
  configured() { return this.requires.every((k) => !!env(k)); },
  async fetchSpend(start, end) {
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env("GOOGLE_ADS_CLIENT_ID"), client_secret: env("GOOGLE_ADS_CLIENT_SECRET"),
        refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN"), grant_type: "refresh_token" }),
    }).then((r) => r.json());
    if (!tok.access_token) throw new Error("Google OAuth refused the refresh token: " + (tok.error_description || tok.error || "no access_token returned"));

    const cid = env("GOOGLE_ADS_CUSTOMER_ID").replace(/-/g, "");
    const gaql = `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
                  FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}'`;
    const r = await fetch(`https://googleads.googleapis.com/v18/customers/${cid}/googleAds:searchStream`, {
      method: "POST",
      headers: { authorization: "Bearer " + tok.access_token, "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"), "content-type": "application/json" },
      body: JSON.stringify({ query: gaql }),
    });
    if (!r.ok) throw new Error(`Google Ads API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const batches = await r.json();
    let micros = 0, clicks = 0, impressions = 0, conv = 0;
    for (const b of Array.isArray(batches) ? batches : [batches])
      for (const row of b.results ?? []) {
        micros += Number(row.metrics?.costMicros ?? 0);
        clicks += Number(row.metrics?.clicks ?? 0);
        impressions += Number(row.metrics?.impressions ?? 0);
        conv += Number(row.metrics?.conversions ?? 0);
      }
    return [{ channel_key: this.channel_key, period_start: start, period_end: end,
      amount: Math.round((micros / 1e6) * 100) / 100,      // micros -> dollars
      clicks, impressions, leads_reported: Math.round(conv),
      note: `Pulled from Google Ads for ${start}..${end}` }];
  },
};

// ---- Meta ---------------------------------------------------------------------------------------------------
// Meta's Insights API wants a long-lived access token and an act_<id> ad account. Its "leads" live inside the
// actions array under a handful of action_type names depending on how the form was set up, so all of the
// lead-ish ones are summed rather than guessing which one this account uses.
const meta: AdPlatform = {
  id: "meta", label: "Meta (Facebook / Instagram)", channel_key: "meta",
  requires: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
  configured() { return this.requires.every((k) => !!env(k)); },
  async fetchSpend(start, end) {
    const act = env("META_AD_ACCOUNT_ID").startsWith("act_") ? env("META_AD_ACCOUNT_ID") : "act_" + env("META_AD_ACCOUNT_ID");
    const u = new URL(`https://graph.facebook.com/v21.0/${act}/insights`);
    u.searchParams.set("fields", "spend,clicks,impressions,actions");
    u.searchParams.set("time_range", JSON.stringify({ since: start, until: end }));
    u.searchParams.set("access_token", env("META_ACCESS_TOKEN"));
    const r = await fetch(u);
    const j = await r.json();
    if (j.error) throw new Error(`Meta API: ${j.error.message}${j.error.error_user_msg ? " - " + j.error.error_user_msg : ""}`);
    const rows = j.data ?? [];
    let spend = 0, clicks = 0, impressions = 0, leads = 0;
    const LEADISH = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"];
    for (const d of rows) {
      spend += Number(d.spend ?? 0); clicks += Number(d.clicks ?? 0); impressions += Number(d.impressions ?? 0);
      for (const a of d.actions ?? []) if (LEADISH.includes(a.action_type)) leads += Number(a.value ?? 0);
    }
    return [{ channel_key: this.channel_key, period_start: start, period_end: end,
      amount: Math.round(spend * 100) / 100, clicks, impressions, leads_reported: leads,
      note: `Pulled from Meta Insights for ${start}..${end}` }];
  },
};

export const PLATFORMS: Record<string, AdPlatform> = { google_ads: googleAds, meta };

export async function ads(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {

  // what is wired and what is missing, by name - so setting it up is a checklist, not a guess
  if (path === "/ads/platforms" && req.method === "GET") {
    return json({
      platforms: Object.values(PLATFORMS).map((p) => ({
        id: p.id, label: p.label, channel_key: p.channel_key,
        configured: p.configured(),
        missing: p.requires.filter((k) => !env(k)),        // names only, never values
      })),
      note: "An unconfigured platform is inert: it is never called and never invents a figure. Set its secrets with `supabase secrets set` and it starts working on the next sync.",
    });
  }

  // pull and record. Every period that returns nothing is written as zero WITH a reason rather than skipped,
  // because a missing week quietly dropped from the denominator makes cost per lead look better than it is.
  if (path === "/ads/sync" && req.method === "POST") {
    const end = body.period_end ?? iso(new Date());
    const start = body.period_start ?? iso(new Date(Date.now() - 29 * 864e5));
    const only: string[] | null = body.platforms ?? null;
    const results: any[] = [];
    for (const p of Object.values(PLATFORMS)) {
      if (only && !only.includes(p.id)) continue;
      if (!p.configured()) { results.push({ platform: p.id, status: "not configured", missing: p.requires.filter((k) => !env(k)) }); continue; }
      try {
        const rows = await p.fetchSpend(start, end);
        for (const row of rows) {
          const { error } = await sb.from("ss_ad_spend").upsert({
            tenant_id: t, channel_key: row.channel_key, period_start: row.period_start, period_end: row.period_end,
            amount: row.amount, clicks: row.clicks ?? null, impressions: row.impressions ?? null,
            leads_reported: row.leads_reported ?? null, entered_by: p.id, note: row.note ?? null,
          }, { onConflict: "tenant_id,channel_key,period_start,period_end" });
          if (error) throw new Error(error.message);
        }
        const total = rows.reduce((a, r) => a + r.amount, 0);
        await event(t, "Ad spend synced", p.label, `$${total.toLocaleString()} for ${start} to ${end}. Cost per lead and return recomputed from it.`);
        results.push({ platform: p.id, status: "ok", rows: rows.length, amount: total, period: [start, end] });
      } catch (e) {
        // A failed pull is reported, never papered over with the last known figure.
        results.push({ platform: p.id, status: "error", error: (e as Error).message, period: [start, end] });
      }
    }
    return json({ period: [start, end], results,
      any_configured: Object.values(PLATFORMS).some((p) => p.configured()) });
  }
  return null;
}
