// Advertising: what was spent, what it produced, and where the leads came from (PRODUCT MANDATE 1, 6, 14).
//
// The one thing this module refuses to do is guess. A channel's cost per lead is computed from Scag's own rows.
// The benchmark_cpl on each channel is a published market figure with its source attached, kept strictly beside
// the measured number and never inside a calculation - so "we are paying double the market" is a comparison
// Charlie can see and check, not a claim the software makes.
import { sb, json, event } from "./core.ts";

// Every platform hands over the click differently. This maps what arrives to a channel Scag recognises.
export function attribute(q: URLSearchParams | Record<string, string>): { ad_channel: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; click_id?: string } {
  const g = (k: string) => (q instanceof URLSearchParams ? q.get(k) : q[k]) ?? undefined;
  const src = (g("utm_source") || "").toLowerCase();
  const med = (g("utm_medium") || "").toLowerCase();
  const gclid = g("gclid") || g("gbraid") || g("wbraid");
  const fbclid = g("fbclid");
  const lsa = g("lsa_lead_id") || (src.includes("local") ? g("lead_id") : undefined);
  let ch = "direct";
  if (lsa) ch = "google_lsa";
  else if (gclid || src === "google" && med.includes("cpc")) ch = "google_search";
  else if (fbclid || ["facebook", "instagram", "meta", "fb", "ig"].includes(src)) ch = "meta";
  else if (med === "referral" || src === "referral") ch = "referral";
  else if (src === "google" || src === "gbp" || med === "organic") ch = "organic";
  return { ad_channel: ch, utm_source: g("utm_source"), utm_medium: g("utm_medium"),
           utm_campaign: g("utm_campaign"), utm_term: g("utm_term"), click_id: gclid || fbclid || lsa };
}

export async function marketing(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {
  // measured performance beside the market benchmark - never blended together
  if (path === "/marketing/channels" && req.method === "GET") {
    const { data: perf } = await sb.from("ss_channel_performance").select("*").eq("tenant_id", t);
    const { data: chans } = await sb.from("ss_ad_channels").select("*").eq("tenant_id", t).order("key");
    const byKey = new Map((perf ?? []).map((p: any) => [p.channel_key, p]));
    const rows = (chans ?? []).map((c: any) => {
      const p: any = byKey.get(c.key) ?? {};
      const cpl = p.cost_per_lead === undefined || p.cost_per_lead === null ? null : Number(p.cost_per_lead);
      return { key: c.key, label: c.label, billing: c.billing, active: c.active, notes: c.notes,
        leads: Number(p.leads ?? 0), quoted: Number(p.quoted ?? 0), won: Number(p.won ?? 0),
        disputed: Number(p.disputed ?? 0), avg_response_seconds: p.avg_response_seconds ?? null,
        booked_value: Number(p.booked_value ?? 0), spend: Number(p.spend ?? 0),
        cost_per_lead: cpl, cost_per_booked_job: p.cost_per_booked_job === null || p.cost_per_booked_job === undefined ? null : Number(p.cost_per_booked_job),
        roas: p.roas === null || p.roas === undefined ? null : Number(p.roas),
        lead_to_won_pct: p.lead_to_won_pct === null || p.lead_to_won_pct === undefined ? null : Number(p.lead_to_won_pct),
        benchmark: c.benchmark_cpl === null ? null : { cpl: Number(c.benchmark_cpl), cpc: c.benchmark_cpc === null ? null : Number(c.benchmark_cpc), source: c.benchmark_source },
        // the comparison stated, not implied - and only when both sides exist
        vs_benchmark: (cpl !== null && c.benchmark_cpl) ? (cpl <= Number(c.benchmark_cpl)
            ? `$${cpl} per lead against a market figure of $${c.benchmark_cpl} - below market`
            : `$${cpl} per lead against a market figure of $${c.benchmark_cpl} - above market`) : null };
    });
    // channels carrying leads that are not in the registry still have to show up
    for (const p of perf ?? []) if (!rows.some((r) => r.key === (p as any).channel_key))
      rows.push({ key: (p as any).channel_key, label: (p as any).channel_key, billing: "unknown", active: true, notes: null,
        leads: Number((p as any).leads ?? 0), quoted: Number((p as any).quoted ?? 0), won: Number((p as any).won ?? 0), disputed: 0,
        avg_response_seconds: (p as any).avg_response_seconds ?? null, booked_value: Number((p as any).booked_value ?? 0),
        spend: Number((p as any).spend ?? 0), cost_per_lead: null, cost_per_booked_job: null, roas: null, lead_to_won_pct: null,
        benchmark: null, vs_benchmark: null } as any);
    return json({ channels: rows, source: "ss_channel_performance (view) + ss_ad_channels", computed_at: new Date().toISOString() });
  }

  if (path === "/marketing/spend" && req.method === "GET") {
    const { data } = await sb.from("ss_ad_spend").select("*").eq("tenant_id", t).order("period_start", { ascending: false }).limit(200);
    return json(data ?? []);
  }
  if (path === "/marketing/spend" && req.method === "POST") {
    if (!body.channel_key || !body.period_start || !body.period_end || body.amount === undefined)
      return json({ error: "channel_key, period_start, period_end and amount are required" }, 400);
    const row = { tenant_id: t, channel_key: body.channel_key, period_start: body.period_start, period_end: body.period_end,
      amount: Number(body.amount), clicks: body.clicks ?? null, impressions: body.impressions ?? null,
      leads_reported: body.leads_reported ?? null, entered_by: body.entered_by ?? "app", note: body.note ?? null };
    const { data, error } = await sb.from("ss_ad_spend").upsert(row, { onConflict: "tenant_id,channel_key,period_start,period_end" }).select().single();
    if (error) return json({ error: error.message }, 400);
    await event(t, "Ad spend recorded", body.channel_key, `$${Number(body.amount).toLocaleString()} for ${body.period_start} to ${body.period_end}. Cost per lead and return update from this.`);
    return json(data);
  }

  // An inbound lead that arrives carrying its own attribution. The landing page forwards the query string; the
  // platform's own identifiers (gclid, fbclid, LSA lead id) are what make the channel provable rather than guessed.
  if (path === "/webhooks/lead" && req.method === "POST") {
    const a = attribute(body.query ?? body);
    const { data, error } = await sb.from("ss_leads").insert({
      tenant_id: t, name: body.name ?? body.phone ?? "Web lead", phone: body.phone ?? null, area: body.area ?? "—",
      addr: body.addr ?? null, source: body.source ?? a.ad_channel, service_type: body.service_type ?? "drain",
      need: body.need ?? "Unknown - awaiting reply", status: "new", response_seconds: body.response_seconds ?? 0,
      ad_channel: a.ad_channel, utm_source: a.utm_source, utm_medium: a.utm_medium, utm_campaign: a.utm_campaign,
      utm_term: a.utm_term, click_id: a.click_id, lead_cost: body.lead_cost ?? null,
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    await event(t, "Lead captured", data.name, `${a.ad_channel}${a.utm_campaign ? " · " + a.utm_campaign : ""}${a.utm_term ? " · \"" + a.utm_term + "\"" : ""}`, { type: "lead", id: data.id });
    return json({ lead_id: data.id, attributed: a });
  }

  // LSA credit request. Disputed leads come off the cost per lead once Google credits them - roughly 6-7% of
  // spend is recoverable, and a contractor who never disputes is overpaying by that much.
  const dis = path.match(/^\/marketing\/leads\/([0-9a-f-]{36})\/dispute$/);
  if (dis && req.method === "POST") {
    const { data, error } = await sb.from("ss_leads").update({ disputed: true, notes: body.reason ?? "Disputed - not a valid lead" })
      .eq("id", dis[1]).eq("tenant_id", t).select().single();
    if (error) return json({ error: error.message }, 400);
    await event(t, "Lead disputed", data.name, body.reason ?? "Marked for credit request.", { type: "lead", id: data.id });
    return json(data);
  }
  return null;
}
