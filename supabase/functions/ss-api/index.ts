// Scag Scapes Command — API (Supabase Edge Function)
// Routes (prefix /functions/v1/ss-api):
//   GET  /health                      liveness + version
//   GET  /kpis                        tenant KPIs (view ss_kpis)
//   GET  /slots?n=6                   next open estimate slots
//   POST /webhooks/call-missed        {from}                         -> lead + text-back
//   POST /webhooks/form               {name,phone,area,addr,need,service_type,source}
//   POST /webhooks/sms                {from, body}                   -> intent: slot pick / YES / question
//   POST /quote                       {lead_id?, service_type, inputs, send?} -> price + BOM (+ job if send)
//   POST /jobs/:id/advance            {dir: 1|-1}                    -> stage machine + automations
//   POST /rain/check                  {forecast?: number[], fire?: 'pre'|'post'} -> campaign
//   POST /payments/webhook            {job_id, kind, amount, method} -> ledger + stage
//   POST /reset                       reseed demo tenant
// Auth: header x-ss-key = ss_tenants.api_key. Tenant "demo" needs no key (public demo).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = "1.0.0";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ss-key, x-tenant",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const fmt = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const DAYN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addD = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const dLabel = (s: string) => { const d = new Date(s + "T12:00:00Z"); return `${DAYN[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const TYPES: Record<string, string> = { drain: "French drain", pad: "Parking pad / driveway", fence: "Cedar fence", patio: "Patio / hardscape", sod: "Sod & renovation", porch: "Screened porch" };
const STAGES = ["Quoted", "Accepted · deposit", "Materials ordered", "Scheduled", "Complete · paid"];
const COST_RATIO: Record<string, number> = { drain: 0.27, pad: 0.38, fence: 0.42, patio: 0.4, sod: 0.45, porch: 0.35 };

// ---------- pricing engine (single source of truth; the web app mirrors it) ----------
type Line = [string, number]; type Bom = [string, string, string];
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
async function tenantFrom(req: Request) {
  const key = req.headers.get("x-ss-key") || "";
  const wanted = req.headers.get("x-tenant") || "demo";
  const { data } = await sb.from("ss_tenants").select("id,name,api_key,settings").eq("id", wanted).maybeSingle();
  if (!data) throw new Error("tenant not found");
  if (data.id !== "demo" && data.api_key !== key) throw new Error("unauthorized");
  return data;
}
async function event(t: string, kind: string, who: string, body: string, ref?: { type: string; id: string }) {
  await sb.from("ss_events").insert({ tenant_id: t, kind, who, body, ref_type: ref?.type, ref_id: ref?.id });
}
async function msg(t: string, lead_id: string, who: "sys" | "cust" | "charlie", body: string) {
  await sb.from("ss_messages").insert({ tenant_id: t, lead_id, who, body });
}
async function tpl(t: string, key: string) {
  const { data } = await sb.from("ss_automations").select("enabled,template").eq("tenant_id", t).eq("key", key).maybeSingle();
  return data ?? { enabled: true, template: "" };
}
async function openSlots(t: string, n = 6) {
  const today = new Date(); const from = iso(today), to = iso(addD(today, 14));
  const { data } = await sb.from("ss_bookings").select("date,time").eq("tenant_id", t).gte("date", from).lte("date", to);
  const taken = new Set((data ?? []).map((b: any) => b.date + "|" + b.time)); const out: { date: string; time: string }[] = [];
  for (let i = 0; i < 14 && out.length < n; i++) { const d = addD(today, i); if (d.getUTCDay() === 0) continue; const ds = iso(d); for (const tm of ["7:30", "4:00", "5:30"]) if (out.length < n && !taken.has(ds + "|" + tm)) out.push({ date: ds, time: tm }); }
  return out;
}
const slotStr = (s: { date: string; time: string }) => `${dLabel(s.date)} ${s.time}`;
async function book(t: string, lead: any, s: { date: string; time: string }, kind = "est") {
  await sb.from("ss_bookings").insert({ tenant_id: t, date: s.date, time: s.time, kind, label: `Estimate · ${lead.name} · ${(lead.need || TYPES[lead.service_type] || "").toLowerCase()}`, lead_id: lead.id });
  await sb.from("ss_leads").update({ status: lead.status === "new" ? "booked" : lead.status, slot_date: s.date, slot_time: s.time }).eq("id", lead.id);
}
function guessType(text: string) {
  const s = text.toLowerCase();
  if (/(water|drain|flood|swamp|pond|soggy)/.test(s)) return ["drain", "Standing water"];
  if (/(pad|driveway|concrete|boat|rv|trailer)/.test(s)) return ["pad", "Parking pad"];
  if (/(fence|privacy|picket)/.test(s)) return ["fence", "Cedar fence"];
  if (/(patio|paver|travertine|flagstone)/.test(s)) return ["patio", "Patio"];
  if (/(sod|grass|lawn)/.test(s)) return ["sod", "Sod"];
  if (/(porch|screen)/.test(s)) return ["porch", "Screened porch"];
  return ["drain", text.slice(0, 60)];
}

// ---------- stage machine ----------
async function advance(t: string, job: any, dir: number, settings: any) {
  const ns = job.stage + dir; if (ns < 0 || ns > 4) throw new Error("stage out of range");
  const hist = Array.isArray(job.stage_history) ? [...job.stage_history] : []; const patch: any = { stage: ns };
  const lead = job.lead_id ? (await sb.from("ss_leads").select("*").eq("id", job.lead_id).maybeSingle()).data : null;
  if (dir > 0) {
    hist[ns] = iso(new Date()); patch.stage_history = hist;
    if (ns === 1) {
      let mats = Array.isArray(job.materials) && job.materials.length ? job.materials : null;
      if (!mats) { const q = job.quote_id ? (await sb.from("ss_quotes").select("inputs").eq("id", job.quote_id).maybeSingle()).data : null; try { mats = price(job.service_type, q?.inputs ?? {}).bom.map((b) => [...b, "queued"]); } catch { mats = []; } }
      patch.materials = mats;
      if (!job.install_date) { const { data } = await sb.from("ss_bookings").select("date").eq("tenant_id", t).eq("kind", "job").gte("date", iso(new Date())); const taken = new Set((data ?? []).map((b: any) => b.date)); let d = addD(new Date(), 2); while (d.getUTCDay() === 0 || taken.has(iso(d))) d = addD(d, 1); patch.install_date = iso(d); await sb.from("ss_bookings").insert({ tenant_id: t, date: iso(d), time: "9:00–3:00", kind: "job", label: `Install · ${job.name} · ${job.scope}`, job_id: job.id, lead_id: job.lead_id }); }
      const dep = Math.round(job.value * (settings.deposit_pct ?? 30) / 100);
      await sb.from("ss_payments").insert({ tenant_id: t, job_id: job.id, kind: "deposit", amount: dep, method: "card" });
      if (lead) { await sb.from("ss_leads").update({ status: "won" }).eq("id", lead.id); await msg(t, lead.id, "sys", `Got it — thank you! You're on the board for ${dLabel(patch.install_date ?? job.install_date)}. Materials are ordered; you'll get a reminder the night before.`); }
      await event(t, "Deposit received", job.name, `${fmt(dep)} via text link. Install locked for ${dLabel(patch.install_date ?? job.install_date)}. POs queued.`, { type: "job", id: job.id });
    }
    if (ns === 2) { patch.materials = (job.materials ?? []).map((m: any) => [m[0], m[1], m[2], "ordered"]); await event(t, "Materials ordered", job.name, "POs sent to suppliers. Delivery matched to install day.", { type: "job", id: job.id }); }
    if (ns === 3) { patch.materials = (job.materials ?? []).map((m: any) => [m[0], m[1], m[2], "delivered"]); await event(t, "Scheduled", job.name, "Crew day blocked, customer confirmation text, reminder 24h before.", { type: "job", id: job.id }); if (lead) await msg(t, lead.id, "sys", `Install confirmed for ${dLabel(job.install_date)}. Crew arrives ~9:00. — Scag Scapes`); }
    if (ns === 4) {
      patch.paid_at = new Date().toISOString(); const bal = Math.round(job.value * (1 - (settings.deposit_pct ?? 30) / 100));
      await sb.from("ss_payments").insert({ tenant_id: t, job_id: job.id, kind: "balance", amount: bal, method: "ach" });
      const r = await tpl(t, "review"); if (lead && r.enabled) await msg(t, lead.id, "sys", r.template || "Thank you!");
      await event(t, "Paid in full", job.name, `Balance ${fmt(bal)} paid. Review ask fires in 24h. 30-day check scheduled.`, { type: "job", id: job.id });
    }
  } else await event(t, "Stepped back", job.name, `Moved to ${STAGES[ns]}. No customer message sent.`, { type: "job", id: job.id });
  const { data } = await sb.from("ss_jobs").update(patch).eq("id", job.id).select().single();
  return data;
}

// ---------- router ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url); const path = url.pathname.replace(/^.*\/ss-api/, "") || "/";
  try {
    if (path === "/health") return json({ ok: true, version: VERSION, time: new Date().toISOString() });
    const tenant = await tenantFrom(req); const t = tenant.id; const settings = tenant.settings ?? {};
    const body = req.method === "POST" ? (await req.json().catch(() => ({}))) : {};

    if (path === "/kpis" && req.method === "GET") { const { data } = await sb.from("ss_kpis").select("*").eq("tenant_id", t).single(); return json(data); }
    if (path === "/slots") return json(await openSlots(t, Number(url.searchParams.get("n") || 6)));

    if (path === "/webhooks/call-missed" && req.method === "POST") {
      const from = body.from || "(225) 555-0" + (100 + Math.floor(Math.random() * 900)); const t0 = Date.now();
      const a = await tpl(t, "textback"); if (!a.enabled) return json({ handled: false, reason: "textback automation off" });
      const { data: lead } = await sb.from("ss_leads").insert({ tenant_id: t, name: from, phone: from, area: "—", source: "Missed call", service_type: "drain", need: "Unknown — awaiting reply", status: "new", response_seconds: 0 }).select().single();
      await msg(t, lead.id, "sys", a.template);
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000)); await sb.from("ss_leads").update({ response_seconds: secs }).eq("id", lead.id);
      await event(t, "Text-back", from, `Missed call → replied in ${secs}s. Waiting on the customer's first word.`, { type: "lead", id: lead.id });
      return json({ handled: true, lead_id: lead.id, sms: a.template, response_seconds: secs });
    }

    if (path === "/webhooks/form" && req.method === "POST") {
      const a = await tpl(t, "formreply"); const slots = await openSlots(t, 2); const [ty, need0] = guessType(body.need || body.service_type || "");
      const { data: lead } = await sb.from("ss_leads").insert({ tenant_id: t, name: body.name || "Web lead", phone: body.phone || "", area: body.area || "Baton Rouge", addr: body.addr || "", source: body.source || "Web form", service_type: TYPES[body.service_type] ? body.service_type : ty, need: body.need || need0, status: "new", response_seconds: 1 }).select().single();
      const sms = (a.template || "").replace("{slots}", slots.map(slotStr).join(" or "));
      if (a.enabled) await msg(t, lead.id, "sys", sms);
      await event(t, "Form auto-reply", `${lead.name} · ${lead.area}`, `Form → replied in 1s. Need: ${lead.need}. Offered ${slots.map(slotStr).join(" / ")}.`, { type: "lead", id: lead.id });
      return json({ handled: true, lead_id: lead.id, sms, offered: slots });
    }

    if (path === "/webhooks/sms" && req.method === "POST") {
      const from = body.from, text = String(body.body || "").trim(); if (!from) return json({ error: "from required" }, 400);
      let { data: lead } = await sb.from("ss_leads").select("*").eq("tenant_id", t).eq("phone", from).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!lead) { const [ty, need] = guessType(text); lead = (await sb.from("ss_leads").insert({ tenant_id: t, name: from, phone: from, area: "—", source: "Text", service_type: ty, need, status: "new", response_seconds: 1 }).select().single()).data; }
      await msg(t, lead.id, "cust", text);
      const slots = await openSlots(t, 2); let reply = ""; let action = "answered";
      const pick = slots.find((s) => new RegExp(dLabel(s.date).split(" ")[0] + "|" + s.time.replace(":", "\\:"), "i").test(text));
      if (/^(yes|y|yeah|yep|sure|ok)/i.test(text) || pick) { const s = pick ?? slots[0]; await book(t, lead, s); reply = `Booked — ${slotStr(s)}${lead.addr ? " at " + lead.addr : ""}. You'll get a reminder the night before. — Scag Scapes`; action = "booked"; await event(t, "Estimate booked", lead.name, slotStr(s) + " · confirmation sent.", { type: "lead", id: lead.id }); }
      else if (/(deposit|how much|cost|price)/i.test(text)) reply = `${settings.deposit_pct ?? 30}% deposit locks the date, balance when we're done and you're happy. Charlie maps the yard first so the price is exact.`;
      else if (/(haul|dirt|spoil)/i.test(text)) reply = "It does — spoils hauled, trench line restored.";
      else if (/(neighbor|friend|referral)/i.test(text)) reply = "Love it — send me their number and I'll text them. $200 off your balance for the referral.";
      else { const [ty, need] = guessType(text); if (lead.need?.startsWith("Unknown")) await sb.from("ss_leads").update({ service_type: ty, need }).eq("id", lead.id); reply = `Got it. Charlie does 3D elevation mapping so the fix actually works. Next open site visits: ${slots.map(slotStr).join(" or ")} — which works? Or book: scagscapes.com/book`; action = "offered"; }
      await msg(t, lead.id, "sys", reply);
      await event(t, "Reply handled", lead.name, `"${text.slice(0, 60)}" → ${action} automatically.`, { type: "lead", id: lead.id });
      return json({ handled: true, lead_id: lead.id, action, reply });
    }

    if (path === "/quote" && req.method === "POST") {
      const st = body.service_type || "drain"; const p = price(st, body.inputs || {});
      if (!body.send) return json({ ...p, service_type: st });
      const lead = body.lead_id ? (await sb.from("ss_leads").select("*").eq("id", body.lead_id).single()).data : null; if (!lead) return json({ error: "lead_id required to send" }, 400);
      const { data: quote } = await sb.from("ss_quotes").insert({ tenant_id: t, lead_id: lead.id, service_type: st, inputs: body.inputs || {}, lines: p.rows, bom: p.bom, summary: p.summary, total: p.total, material_cost: p.material_cost, deposit_pct: settings.deposit_pct ?? 30, status: "sent" }).select().single();
      const { data: job } = await sb.from("ss_jobs").insert({ tenant_id: t, lead_id: lead.id, quote_id: quote.id, name: lead.name, service_type: st, scope: p.summary, value: p.total, material_cost: p.material_cost, labor_hours: p.labor_hours, stage: 0, stage_history: [iso(new Date())] }).select().single();
      await sb.from("ss_leads").update({ status: "quoted" }).eq("id", lead.id);
      const dep = Math.round(p.total * (settings.deposit_pct ?? 30) / 100);
      await msg(t, lead.id, "sys", `Your quote is ready: ${p.summary} — ${fmt(p.total)}. ${settings.warranty ?? "1-year workmanship warranty"}. Deposit link (${settings.deposit_pct ?? 30}%): pay.scagscapes.com/q-${quote.id.slice(0, 6)}`);
      await event(t, "Quote sent", `${lead.name} · ${lead.area}`, `${p.summary} → ${fmt(p.total)}. Deposit link ${fmt(dep)}. Follow-ups scheduled day 2 · 5 · 12.`, { type: "job", id: job.id });
      return json({ ...p, quote_id: quote.id, job_id: job.id, deposit: dep });
    }

    const adv = path.match(/^\/jobs\/([0-9a-f-]{36})\/advance$/);
    if (adv && req.method === "POST") { const { data: job } = await sb.from("ss_jobs").select("*").eq("id", adv[1]).eq("tenant_id", t).single(); if (!job) return json({ error: "job not found" }, 404); const j = await advance(t, job, Number(body.dir ?? 1), settings); return json(j); }

    if (path === "/rain/check" && req.method === "POST") {
      let forecast: number[] = body.forecast; if (!Array.isArray(forecast)) { const { data } = await sb.from("ss_forecast").select("day_offset,inches").eq("tenant_id", t).order("day_offset"); forecast = (data ?? []).map((r: any) => Number(r.inches)); }
      else await Promise.all(forecast.map((v, i) => sb.from("ss_forecast").upsert({ tenant_id: t, day_offset: i, inches: v })));
      const th = Number(settings.rain_threshold_in ?? 1.5); const hot = forecast.findIndex((v) => v >= th);
      const { data: leads } = await sb.from("ss_leads").select("id,name,status").eq("tenant_id", t);
      const quoted = (leads ?? []).filter((l: any) => l.status === "quoted").length + 15, never = (leads ?? []).filter((l: any) => ["new", "booked"].includes(l.status)).length + 8, past = (leads ?? []).filter((l: any) => l.status === "won").length + 2;
      const audience = { quoted, never, past, total: quoted + never + past };
      if (!body.fire) return json({ threshold: th, forecast, trigger_day: hot >= 0 ? hot : null, would_fire: hot >= 0, audience });
      const kind = body.fire === "pre" ? "pre" : "post"; const a = await tpl(t, kind === "pre" ? "rainpre" : "rainpost"); if (!a.enabled) return json({ fired: false, reason: "automation off" });
      const sent = kind === "post" ? audience.total : audience.quoted; const replied = Math.round(sent * (0.15 + Math.random() * 0.15));
      const { data: held } = await sb.from("ss_bookings").select("id,date,time").eq("tenant_id", t).eq("kind", "held").gte("date", iso(new Date()));
      const booked = Math.min(Math.max(held?.length ?? 0, 2), Math.ceil(replied / 3)); const inches = Math.max(...forecast);
      for (let i = 0; i < booked; i++) {
        const nm = ["P. Dupuis", "N. Alvarez", "J. Melancon", "C. Richard", "B. Landry"][i % 5], ar = ["Zachary", "Central", "Prairieville", "Gonzales", "Baker"][i % 5];
        const { data: lead } = await sb.from("ss_leads").insert({ tenant_id: t, name: nm, phone: "(225) 555-0" + (100 + Math.floor(Math.random() * 900)), area: ar, source: "Rain campaign", service_type: "drain", need: `Yard holding water after ${inches}"`, status: "new", response_seconds: 1 }).select().single();
        await msg(t, lead.id, "sys", (a.template || "").replace("{inches}", String(inches)).replace("{slots}", String(booked)).replace("{day}", DAYN[addD(new Date(), Math.max(0, hot)).getUTCDay()])); await msg(t, lead.id, "cust", "YES. Whole back yard is underwater.");
        const h = held?.[i]; if (h) { await sb.from("ss_bookings").update({ kind: "est", label: `Site visit · ${nm} · post-rain`, lead_id: lead.id }).eq("id", h.id); await sb.from("ss_leads").update({ status: "booked", slot_date: h.date, slot_time: h.time }).eq("id", lead.id); }
        else { const s = (await openSlots(t, 1))[0]; if (s) await book(t, lead, s); }
      }
      const { data: camp } = await sb.from("ss_campaigns").insert({ tenant_id: t, kind, inches, sent, replied, booked }).select().single();
      await event(t, kind === "post" ? "Post-rain campaign" : "Pre-rain campaign", `${sent} contacts`, `${inches}" event. ${replied} replies, ${booked} site visits booked.`, { type: "campaign", id: camp.id });
      return json({ fired: true, campaign: camp, audience });
    }

    if (path === "/payments/webhook" && req.method === "POST") {
      const { data: job } = await sb.from("ss_jobs").select("*").eq("id", body.job_id).eq("tenant_id", t).single(); if (!job) return json({ error: "job not found" }, 404);
      if (body.kind === "deposit" && job.stage === 0) return json(await advance(t, job, 1, settings));
      if (body.kind === "balance" && job.stage === 3) return json(await advance(t, job, 1, settings));
      await sb.from("ss_payments").insert({ tenant_id: t, job_id: job.id, kind: body.kind || "deposit", amount: Number(body.amount || 0), method: body.method || "card" }); return json({ recorded: true });
    }

    if (path === "/reset" && req.method === "POST") { if (t !== "demo") return json({ error: "reset is demo-only" }, 403); await sb.rpc("ss_reset_demo"); return json({ reset: true }); }

    return json({ error: "not found", path }, 404);
  } catch (e) { const m = (e as Error).message; return json({ error: m }, m === "unauthorized" ? 401 : 500); }
});
