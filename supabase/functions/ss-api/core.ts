import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

export const VERSION = "1.6.0";
export const STATUS = { LIVE: "LIVE_VERIFIED", POSTED: "PROVIDER_POSTED", CALL: "CALL_TO_CONFIRM", EST: "ESTIMATED", NA: "UNAVAILABLE", STALE: "STALE", ERR: "CONNECTION_ERROR" } as const;
export const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ss-key, x-ss-admin, x-tenant",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
export const fmt = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
export const DAYN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addD = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
export const dLabel = (s: string) => { const d = new Date(s + "T12:00:00Z"); return `${DAYN[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export const TYPES: Record<string, string> = { drain: "French drain", pad: "Parking pad / driveway", fence: "Cedar fence", patio: "Patio / hardscape", sod: "Sod & renovation", porch: "Screened porch" };
export const STAGES = ["Quoted", "Accepted · deposit", "Materials ordered", "Scheduled", "Complete · paid"];
export const COST_RATIO: Record<string, number> = { drain: 0.27, pad: 0.38, fence: 0.42, patio: 0.4, sod: 0.45, porch: 0.35 };

// ---------- pricing engine (single source of truth; the web app mirrors it) ----------
export type Line = [string, number]; type Bom = [string, string, string];
export function price(t: string, q: Record<string, any>) {
  const rows: Line[] = [], bom: Bom[] = []; let total = 0, summary = "", per = "";
  const line = (l: string, v: number) => { rows.push([l, v]); total += v; };
  const n = (k: string, d = 0) => Number(q[k] ?? d);
  if (t === "drain") {
    const lf = n("lf", 100), depth = n("depth", 24), pipe = n("pipe", 4), soil = n("soil", 1.12), basins = n("basins", 2), pop = n("pop", 1), sod = n("sod", 1);
    let rate = (depth === 18 ? 27 : depth === 24 ? 36 : 46) + (pipe === 6 ? 7 : 0); rate = Math.min(60, Math.max(25, rate * soil));
    line(`Drain run · ${lf} LF × ${fmt(rate)}/LF`, lf * rate); line("Basins & emitters", basins * 185 + pop * 65); if (sod) line("Sod restoration", lf * 1.5 * 4.25);
    const cy = Math.ceil(lf * (depth / 12) / 27 * 1.1 * 10) / 10;
    bom.push([`Perforated pipe SDR-35 ${pipe}"`, Math.ceil(lf / 10) * 10 + " LF", "Ferguson"], ["#57 washed gravel", cy + " CY", "Southern Aggregates"], ["Non-woven geotextile 4 oz", Math.ceil(lf * 1.1) + " LF × 6 ft", "Site One"], ["Catch basins 12\" w/ grate", basins + " ea", "Site One"], ["Pop-up emitters", pop + " ea", "Site One"], ["Couplers / fittings", Math.ceil(lf / 20) + " ea", "Ferguson"]);
    if (sod) bom.push(["St. Augustine sod", Math.ceil(lf * 1.5 / 2.7) + " pcs", "Bayou Sod"]);
    summary = `${lf} LF · ${depth}" · ${pipe}" SDR-35${sod ? " + sod" : ""}`; per = `${fmt(rate)}/LF`;
  } else if (t === "pad") {
    const l = n("l", 20), w = n("w", 40), mat = q.mat ?? "c4", tear = n("tear"); const sf = l * w; const r = ({ c4: 8.5, c6: 10.75, lime: 3.25, grav: 2.9 } as any)[mat] ?? 8.5;
    line(`${l}×${w} = ${sf} SF × ${fmt(r)}/SF`, sf * r); line("Grade + 610 base + forms", sf * 1.1); if (tear) line("Tear-out & haul", sf * 1.6);
    if (String(mat).startsWith("c")) { const th = mat === "c4" ? 4 : 6; bom.push(["Ready-mix 3500 psi", (Math.ceil(sf * th / 12 / 27 * 1.08 * 10) / 10) + " CY", "BR Ready Mix"], [mat === "c4" ? "Fiber mesh + wire" : "#4 rebar 18\" OC", mat === "c4" ? Math.ceil(sf / 100) + " rolls" : Math.ceil(sf * 2 / 20) + " sticks", "Stine"], ["610 limestone base", Math.ceil(sf * 4 / 12 * 1.5 / 27 * 1.4) + " T", "Southern Aggregates"], ["Forms + stakes", (2 * (l + w)) + " LF", "Stine"]); }
    else bom.push([mat === "lime" ? "610 limestone" : "#57 gravel", Math.ceil(sf * 4 / 12 / 27 * 1.4 * 10) / 10 + " T", "Southern Aggregates"], ["Geotextile fabric", Math.ceil(sf * 1.1) + " SF", "Site One"]);
    summary = `${l}×${w} ${({ c4: '4" concrete', c6: '6" concrete', lime: "limestone", grav: "gravel" } as any)[mat]} pad`; per = `${fmt(r)}/SF`;
  } else if (t === "fence") {
    const lf = n("lf", 180), style = q.style ?? "p6", gates = n("gates", 1), tear = n("tear"); const r = ({ pk4: 32, p6: 46, p8: 58, sb6: 52 } as any)[style] ?? 46;
    line(`${lf} LF × ${fmt(r)}/LF`, lf * r); line(`Gates × ${gates}`, gates * 350); if (tear) line("Tear-out & haul", lf * 6);
    const posts = Math.ceil(lf / 8) + 1; bom.push(["Cedar posts 4×4×" + (style === "p8" ? "12" : style === "pk4" ? "8" : "10") + "'", posts + " ea", "Stine"], ['Cedar pickets 5.5"', Math.ceil(lf * 12 / 5.5 * 1.03) + " ea", "Stine"], ["2×4 cedar rails", Math.ceil(lf / 8) * (style === "pk4" ? 2 : 3) + " ea", "Stine"], ["Concrete 80 lb", posts * 2 + " bags", "Stine"], ["Gate kits", gates + " ea", "Stine"]);
    summary = `${lf} LF ${({ pk4: "4' picket", p6: "6' privacy", p8: "8' privacy", sb6: "6' shadowbox" } as any)[style]}`; per = `${fmt(r)}/LF`;
  } else if (t === "patio") {
    const sf = n("sf", 320), mat = q.mat ?? "trav", edge = n("edge", 1), steps = n("steps"); const r = ({ brick: 18, trav: 26, flag: 30, conc: 16 } as any)[mat] ?? 26;
    line(`${sf} SF × ${fmt(r)}/SF`, sf * r); if (edge) line("Soldier-course edging", Math.ceil(Math.sqrt(sf) * 4) * 9); line(`Steps × ${steps}`, steps * 425);
    bom.push([({ brick: "Clay pavers", trav: "Travertine 16×24", flag: "Flagstone", conc: "Concrete pavers" } as any)[mat], Math.ceil(sf * 1.08) + " SF", "Bayou Stone"], ["610 limestone base", Math.ceil(sf * 4 / 12 / 27 * 1.4 * 10) / 10 + " T", "Southern Aggregates"], ["Bedding sand", Math.ceil(sf / 12 / 27 * 10) / 10 + " CY", "Southern Aggregates"], ["Polymeric sand", Math.ceil(sf / 60) + " bags", "Site One"]);
    summary = `${sf} SF ${({ brick: "brick", trav: "travertine", flag: "flagstone", conc: "paver" } as any)[mat]} patio`; per = `${fmt(r)}/SF`;
  } else if (t === "sod") {
    const sf = n("sf", 1800), v = q.var ?? "sa", prep = n("prep", 1), irr = n("irr"); const r = ({ sa: .85, zoy: .98, cen: .8 } as any)[v] ?? .85;
    line(`${sf} SF × $${r.toFixed(2)}/SF`, sf * r); if (prep) line("Kill, till, grade, topsoil", sf * .28); if (irr) line("Irrigation adjust", 185);
    bom.push([({ sa: "St. Augustine", zoy: "Empire Zoysia", cen: "Centipede" } as any)[v] + " sod", Math.ceil(sf / 450) + " pallets", "Bayou Sod"], ["Topsoil", prep ? Math.ceil(sf / 12 / 27 * .5 * 10) / 10 + " CY" : "—", "Southern Aggregates"], ["Starter fertilizer", Math.ceil(sf / 5000) + " bags", "Site One"]);
    summary = `${sf} SF ${({ sa: "St. Augustine", zoy: "Zoysia", cen: "Centipede" } as any)[v]}`; per = `$${r.toFixed(2)}/SF`;
  } else if (t === "porch") {
    const sf = n("sf", 240), roof = n("roof", 1), door = n("door", 1);
    line(`${sf} SF screened × $95/SF`, sf * 95); if (roof) line("Shed roof & tie-in", 2400 + sf * 8); line(`Screen doors × ${door}`, door * 385);
    bom.push(["PT 4×4 posts", Math.ceil(Math.sqrt(sf) * 4 / 8) + 2 + " ea", "Stine"], ["Cedar 2×4 framing", Math.ceil(sf * 1.6) + " LF", "Stine"], ["Fiberglass screen 18/14", Math.ceil(Math.sqrt(sf) * 4 * 8 * 1.1) + " SF", "Stine"], ["Screen doors", door + " ea", "Stine"]); if (roof) bom.push(["Metal roofing panels", Math.ceil(sf * 1.15) + " SF", "Metal Mart"]);
    summary = `${sf} SF screened porch${roof ? " + roof" : ""}`; per = "$95/SF";
  } else throw new Error("unknown service_type");
  const material_cost = Math.round(total * (COST_RATIO[t] ?? .35));
  return { total: Math.round(total), rows, bom, summary, per, material_cost, labor_hours: Math.round(total / 320) };
}

// ---------- data helpers ----------
export async function tenantFrom(req: Request) {
  const key = req.headers.get("x-ss-key") || "";
  const wanted = req.headers.get("x-tenant") || "demo";
  const { data } = await sb.from("ss_tenants").select("id,name,api_key,settings").eq("id", wanted).maybeSingle();
  if (!data) throw new Error("tenant not found");
  if (data.id !== "demo" && data.api_key !== key) throw new Error("unauthorized");
  return data;
}
export async function event(t: string, kind: string, who: string, body: string, ref?: { type: string; id: string }) {
  await sb.from("ss_events").insert({ tenant_id: t, kind, who, body, ref_type: ref?.type, ref_id: ref?.id });
}
export const integrations = () => ({
  twilio: !!(Deno.env.get("TWILIO_ACCOUNT_SID") && Deno.env.get("TWILIO_AUTH_TOKEN") && Deno.env.get("TWILIO_FROM")),
  stripe: !!Deno.env.get("STRIPE_SECRET_KEY"),
  brave: !!Deno.env.get("BRAVE_API_KEY"),
  resend: !!Deno.env.get("RESEND_API_KEY"),
  push: !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY")),
});
// Outbound message: real Twilio/Resend when secrets exist, otherwise logged as "simulated" so the demo shows exactly what would go out.
export async function send(t: string, channel: "sms" | "email" | "push", to: string, body: string, ref?: { type: string; id: string }) {
  const row: any = { tenant_id: t, channel, to, body, status: "simulated", ref_type: ref?.type, ref_id: ref?.id };
  try {
    if (channel === "sms" && integrations().twilio) {
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!, tok = Deno.env.get("TWILIO_AUTH_TOKEN")!, from = Deno.env.get("TWILIO_FROM")!;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + btoa(sid + ":" + tok), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: to.replace(/[^\d+]/g, "").replace(/^(\d{10})$/, "+1$1"), From: from, Body: body }) });
      const j = await r.json(); if (r.ok) { row.status = "sent"; row.provider = "twilio"; row.provider_id = j.sid; } else { row.status = "failed"; row.provider = "twilio"; row.error = j.message; }
    } else if (channel === "email" && integrations().resend) {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "content-type": "application/json" }, body: JSON.stringify({ from: "Scag Scapes <charlie@scagscapes.com>", to: [to], subject: body.split("\n")[0].slice(0, 80), text: body }) });
      const j = await r.json(); if (r.ok) { row.status = "sent"; row.provider = "resend"; row.provider_id = j.id; } else { row.status = "failed"; row.provider = "resend"; row.error = JSON.stringify(j).slice(0, 200); }
    }
  } catch (e) { row.status = "failed"; row.error = (e as Error).message; }
  await sb.from("ss_outbox").insert(row); return row.status;
}
// Deposit / balance link: real Stripe Checkout when a key exists, else a labeled placeholder.
export async function payLink(t: string, amount: number, label: string, ref: string) {
  if (!integrations().stripe) return `pay.scagscapes.com/${ref}`;
  try { const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: "Bearer " + Deno.env.get("STRIPE_SECRET_KEY"), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ mode: "payment", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][product_data][name]": label, "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)), "line_items[0][quantity]": "1", success_url: "https://scagscapes.bridgebox.ai/?paid=" + ref, cancel_url: "https://scagscapes.bridgebox.ai/", "metadata[ref]": ref, "metadata[tenant]": t }) }); const j = await r.json(); return j.url || `pay.scagscapes.com/${ref}`; } catch { return `pay.scagscapes.com/${ref}`; }
}
export async function msg(t: string, lead_id: string, who: "sys" | "cust" | "charlie", body: string) {
  await sb.from("ss_messages").insert({ tenant_id: t, lead_id, who, body });
  if (who !== "cust") { const { data: l } = await sb.from("ss_leads").select("phone").eq("id", lead_id).maybeSingle(); if (l?.phone && /\d{3}/.test(l.phone)) await send(t, "sms", l.phone, body, { type: "lead", id: lead_id }); }
}
export async function tpl(t: string, key: string) {
  const { data } = await sb.from("ss_automations").select("enabled,template").eq("tenant_id", t).eq("key", key).maybeSingle();
  return data ?? { enabled: true, template: "" };
}
export async function openSlots(t: string, n = 6) {
  const today = new Date(); const from = iso(today), to = iso(addD(today, 14));
  const { data } = await sb.from("ss_bookings").select("date,time").eq("tenant_id", t).gte("date", from).lte("date", to);
  const taken = new Set((data ?? []).map((b: any) => b.date + "|" + b.time)); const out: { date: string; time: string }[] = [];
  for (let i = 0; i < 14 && out.length < n; i++) { const d = addD(today, i); if (d.getUTCDay() === 0) continue; const ds = iso(d); for (const tm of ["7:30", "4:00", "5:30"]) if (out.length < n && !taken.has(ds + "|" + tm)) out.push({ date: ds, time: tm }); }
  return out;
}
export const slotStr = (s: { date: string; time: string }) => `${dLabel(s.date)} ${s.time}`;
export async function book(t: string, lead: any, s: { date: string; time: string }, kind = "est") {
  await sb.from("ss_bookings").insert({ tenant_id: t, date: s.date, time: s.time, kind, label: `Estimate · ${lead.name} · ${(lead.need || TYPES[lead.service_type] || "").toLowerCase()}`, lead_id: lead.id });
  await sb.from("ss_leads").update({ status: lead.status === "new" ? "booked" : lead.status, slot_date: s.date, slot_time: s.time }).eq("id", lead.id);
}
// The deterministic SMS intent ladder. Pure - no DB, no side effects - for two reasons: index.ts runs it in
// production, and evals.ts scores THE SAME CODE as the baseline a model must beat before it is allowed to
// answer a customer (PRODUCT MANDATE 13: never let a model replace working logic on a vendor's word).
export function smsIntent(text: string, slots: any[], depositPct = 30) {
  const pick = slots.find((s: any) => new RegExp(dLabel(s.date).split(" ")[0] + "|" + s.time.replace(":", "\\:"), "i").test(text));
  if (/^(yes|y|yeah|yep|sure|ok)/i.test(text) || pick) return { intent: "book", pick: pick ?? slots[0], reply: "" };
  if (/(deposit|how much|cost|price)/i.test(text)) return { intent: "price", pick: null, reply: `${depositPct}% deposit locks the date, balance when we're done and you're happy. Charlie maps the yard first so the price is exact.` };
  if (/(haul|dirt|spoil)/i.test(text)) return { intent: "haul", pick: null, reply: "It does — spoils hauled, trench line restored." };
  if (/(neighbor|friend|referral)/i.test(text)) return { intent: "referral", pick: null, reply: "Love it — send me their number and I'll text them. $200 off your balance for the referral." };
  return { intent: "other", pick: null, reply: `Got it. Charlie does 3D elevation mapping so the fix actually works. Next open site visits: ${slots.map(slotStr).join(" or ")} — which works? Or book: scagscapes.com/book` };
}
export function guessType(text: string) {
  const s = text.toLowerCase();
  if (/(water|drain|flood|swamp|pond|soggy)/.test(s)) return ["drain", "Standing water"];
  if (/(pad|driveway|concrete|boat|rv|trailer)/.test(s)) return ["pad", "Parking pad"];
  if (/(fence|privacy|picket)/.test(s)) return ["fence", "Cedar fence"];
  if (/(patio|paver|travertine|flagstone)/.test(s)) return ["patio", "Patio"];
  if (/(sod|grass|lawn)/.test(s)) return ["sod", "Sod"];
  if (/(porch|screen)/.test(s)) return ["porch", "Screened porch"];
  return ["drain", text.slice(0, 60)];
}


// Web Push (VAPID) — real only when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets exist; otherwise in-app notifications only.
export async function pushAll(t: string, title: string, body: string, ref?: { type: string; id: string }) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY"); if (!pub || !priv) return "not configured";
  const { data: subs } = await sb.from("ss_push_subscriptions").select("*").eq("tenant_id", t); if (!subs?.length) return "no subscribers";
  try { const wp: any = await import("npm:web-push@3.6.7"); const lib = wp.default || wp; lib.setVapidDetails("mailto:nedpearson@gmail.com", pub, priv); let sent = 0; for (const s of subs) { try { await lib.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, ref })); sent++; } catch (e) { if ((e as any).statusCode === 410 || (e as any).statusCode === 404) await sb.from("ss_push_subscriptions").delete().eq("id", s.id); } } return `sent ${sent}`; } catch (e) { return "error: " + (e as Error).message; }
}
