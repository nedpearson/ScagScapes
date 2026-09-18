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
//   Marketing (marketing.ts): GET /marketing/channels - measured performance per channel vs published benchmark
//                              GET/POST /marketing/spend - what was spent, by channel and period
//                              POST /webhooks/lead - attributed inbound lead (utm / gclid / LSA)
//   Ads (ads.ts):        GET /ads/platforms - what is wired, what secrets are missing, by name
//                          POST /ads/sync - pull spend from Google Ads and Meta; inert until credentials exist
//   Map (geo.ts):        POST /geo/backfill - geocode what has no position, 1 req/s, precision recorded
//                          GET /map/data - every positioned record, demand by town, what is still missing
//   Reports (reports.ts): GET /reports/funnel · /reports/sources · /reports/margin
//                          GET /billing/invoices - billed vs actually received · /billing/aging
//   Voice (voice.ts):     POST /webhooks/voice/:provider - an answered call becomes an attributed lead + text-back
//                          GET /voice/performance - calls answered, leads captured, cost per captured lead
//   Provenance (explain.ts): GET /explain - every headline metric with definition, formula and source tables
//                            GET /explain/:metric - the same, plus every row the number was computed from
//   AI layer (ai.ts): GET /ai/models · POST /ai/models · POST /ai/recommend · POST /ai/recommendations/:id/decision · GET /ai/recommendations · GET /ai/learning
//                     POST /ai/evals/run · GET /ai/evals · POST /jobs/:id/actuals · GET /estimate-accuracy · GET /export · GET /ai/audit
//   Governed by docs/PRODUCT-MANDATE.md - price() stays the only pricing authority; AI recommends, humans decide.
// Auth: header x-ss-key = ss_tenants.api_key. Tenant "demo" needs no key (public demo).
//       /export, POST /ai/models and POST /ai/evals/run additionally require SS_ADMIN_KEY on every tenant.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { VERSION, sb, CORS, json, fmt, DAYN, iso, addD, dLabel, TYPES, STAGES, price, tenantFrom, event, msg, tpl, openSlots, slotStr, book, guessType, smsIntent, payLink, integrations } from "./core.ts";
import { sourcing } from "./sourcing.ts";
import { fieldops } from "./fieldops.ts";
import { resources } from "./resources.ts";
import { ai, recommend } from "./ai.ts";
import { explain } from "./explain.ts";
import { marketing } from "./marketing.ts";
import { voice } from "./voice.ts";
import { reports } from "./reports.ts";
import { geo } from "./geo.ts";
import { ads } from "./ads.ts";
import { PRICE_RE } from "./evals.ts";

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
    if (path === "/health") return json({ ok: true, version: VERSION, time: new Date().toISOString(), integrations: integrations() });
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
      const si = smsIntent(text, slots, settings.deposit_pct ?? 30);
      if (si.intent === "book") { const s = si.pick; await book(t, lead, s); reply = `Booked — ${slotStr(s)}${lead.addr ? " at " + lead.addr : ""}. You'll get a reminder the night before. — Scag Scapes`; action = "booked"; await event(t, "Estimate booked", lead.name, slotStr(s) + " · confirmation sent.", { type: "lead", id: lead.id }); }
      else { reply = si.reply; if (si.intent === "other") { const [ty, need] = guessType(text); if (lead.need?.startsWith("Unknown")) await sb.from("ss_leads").update({ service_type: ty, need }).eq("id", lead.id); action = "offered"; } }

      // PRODUCT MANDATE 8/13: the ladder above is the baseline and it stays in charge until the numbers say
      // otherwise. settings.ai_sms: "off" (default) | "shadow" (model drafts, the ladder's reply still sends,
      // draft logged for accept/reject) | "live" (model answers). Even on "live" the model never handles a
      // booking - that has side effects - never sends a reply carrying a number, and yields to the ladder on
      // low confidence or any error. A model failure must never drop a customer's text.
      let ai_draft: any = null; const mode = settings.ai_sms ?? "off";
      if (mode !== "off") {
        try {
          const r = await recommend(t, "customer_reply", { lead_id: lead.id }, { text, slots: slots.map(slotStr), deterministic_reply: si.reply });
          const draft = typeof r.out?.recommendation === "string" ? r.out.recommendation : null;
          ai_draft = { id: r.id, reply: draft, confidence: Number(r.out?.confidence ?? 0), model: r.comp.provider + "/" + r.comp.model_id, used: false };
          if (mode === "live" && draft && si.intent !== "book" && !PRICE_RE.test(draft) && ai_draft.confidence >= (settings.ai_sms_min_confidence ?? 0.7)) { reply = draft; action = "ai_" + action; ai_draft.used = true; }
        } catch (_) { /* the customer still gets the deterministic answer */ }
      }
      await msg(t, lead.id, "sys", reply);
      await event(t, "Reply handled", lead.name, `"${text.slice(0, 60)}" → ${action} automatically.`, { type: "lead", id: lead.id });
      return json({ handled: true, lead_id: lead.id, action, reply, ai_draft });
    }

    if (path === "/quote" && req.method === "POST") {
      const st = body.service_type || "drain"; const p = price(st, body.inputs || {});
      if (!body.send) {
        // A priced quote used to vanish unless it was sent in the same minute, which is why ss_quotes sat empty
        // and "quotes out under 24h" had nothing to measure. Pricing against a real lead now saves a draft, so
        // the funnel (priced -> sent -> won) is a fact in the database rather than a memory. Pricing with no
        // lead attached is still just a calculator and saves nothing.
        if (!body.lead_id) return json({ ...p, service_type: st, saved: false, reason: "no lead attached - nothing to save a draft against" });
        const { data: draft } = await sb.from("ss_quotes").upsert({
          tenant_id: t, lead_id: body.lead_id, service_type: st, inputs: body.inputs || {}, lines: p.rows, bom: p.bom,
          summary: p.summary, total: p.total, material_cost: p.material_cost, deposit_pct: settings.deposit_pct ?? 30, status: "draft",
        }, { onConflict: "tenant_id,lead_id,service_type,status" }).select().single();
        return json({ ...p, service_type: st, saved: true, quote_id: draft?.id, status: "draft" });
      }
      const lead = body.lead_id ? (await sb.from("ss_leads").select("*").eq("id", body.lead_id).single()).data : null; if (!lead) return json({ error: "lead_id required to send" }, 400);
      const { data: quote } = await sb.from("ss_quotes").insert({ tenant_id: t, lead_id: lead.id, service_type: st, inputs: body.inputs || {}, lines: p.rows, bom: p.bom, summary: p.summary, total: p.total, material_cost: p.material_cost, deposit_pct: settings.deposit_pct ?? 30, status: "sent" }).select().single();
      const { data: job } = await sb.from("ss_jobs").insert({ tenant_id: t, lead_id: lead.id, quote_id: quote.id, name: lead.name, service_type: st, scope: p.summary, value: p.total, material_cost: p.material_cost, labor_hours: p.labor_hours, stage: 0, stage_history: [iso(new Date())] }).select().single();
      await sb.from("ss_leads").update({ status: "quoted" }).eq("id", lead.id);
      const dep = Math.round(p.total * (settings.deposit_pct ?? 30) / 100);
      const link = await payLink(t, dep, `Deposit · ${p.summary}`, "q-" + quote.id.slice(0, 6));
      await msg(t, lead.id, "sys", `Your quote is ready: ${p.summary} — ${fmt(p.total)}. ${settings.warranty ?? "1-year workmanship warranty"}. Deposit link (${settings.deposit_pct ?? 30}%): ${link}`);
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

    const xres = await explain(path, req, url, t); if (xres) return xres;
    const mres = await marketing(path, req, url, body, t); if (mres) return mres;
    const vres = await voice(path, req, url, body, t, settings); if (vres) return vres;
    const rpres = await reports(path, req, url, body, t, settings); if (rpres) return rpres;
    const gres = await geo(path, req, url, body, t); if (gres) return gres;
    const adres = await ads(path, req, url, body, t); if (adres) return adres;
    const ares = await ai(path, req, url, body, t); if (ares) return ares;
    const fres = await fieldops(path, req, url, body, t, settings); if (fres) return fres; const rres = await resources(path, req, url, body, t, settings); if (rres) return rres;
    const sres = await sourcing(path, req, url, body, t); if (sres) return sres;
    return json({ error: "not found", path }, 404);
  } catch (e) { const m = (e as Error).message; return json({ error: m }, m === "unauthorized" ? 401 : 500); }
});
