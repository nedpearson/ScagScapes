// Provenance: every headline number in the app can be asked to show its work (PRODUCT MANDATE 6, 12, 14).
//
// This exists because the overview KPI strip was computing its own numbers in the browser and two of the six
// were constants: "Calls answered 100%" was the literal string "100%", and "Quotes out < 24h" was q/q, which is
// 100% by construction no matter what the business does. A number nobody can trace is decoration, and a number
// that cannot be wrong is not a measurement. Everything below is computed server-side from rows, returns the
// rows it used, and says plainly when there is not enough data to answer instead of inventing a number.
import { sb, json } from "./core.ts";

export interface Metric {
  key: string;
  label: string;
  definition: string;          // what it means, in the language Charlie would use
  formula: string;             // the arithmetic, stated so it can be checked by hand
  tables: string[];            // where the numbers live - the source of truth
  caveat?: string;             // what it does NOT account for
}

export const METRICS: Record<string, Metric> = {
  answered: { key: "answered", label: "Leads answered", tables: ["ss_leads"],
    definition: "Of every lead that has come in, the share that got a reply at all - by text-back, call or form response.",
    formula: "count(leads with response_seconds > 0) / count(all leads)",
    caveat: "A lead answered in eight hours counts here the same as one answered in eight seconds. Speed to lead is the separate metric." },
  speed: { key: "speed", label: "Speed to lead", tables: ["ss_leads"],
    definition: "Average seconds between a lead arriving and the first reply going out.",
    formula: "avg(response_seconds) over leads where response_seconds > 0",
    caveat: "Only counts leads that were answered. Unanswered leads pull down 'Leads answered', not this." },
  quotes_fast: { key: "quotes_fast", label: "Quotes out under 24h", tables: ["ss_quotes", "ss_leads"],
    definition: "Of the quotes sent, the share that went out within 24 hours of the lead arriving.",
    formula: "count(quotes where quote.created_at - lead.created_at <= 24h) / count(quotes with a lead)",
    caveat: "A quote with no lead attached cannot be timed and is excluded from both sides." },
  close_rate: { key: "close_rate", label: "Close rate", tables: ["ss_leads"],
    definition: "Of the leads that reached a decision, the share that became work.",
    formula: "count(status = 'won') / count(status in ('won','lost'))",
    caveat: "Leads still open are excluded entirely - they have not decided yet, so counting them either way would be wrong." },
  booked: { key: "booked", label: "Booked value", tables: ["ss_jobs"],
    definition: "The total contract value of every job past the quote stage.",
    formula: "sum(value) over jobs where stage > 0",
    caveat: "Contract value, not cash. What has actually arrived is 'Collected'." },
  collected: { key: "collected", label: "Collected", tables: ["ss_payments"],
    definition: "Cash actually received - deposits and balances.",
    formula: "sum(amount) over all payments",
    caveat: "Includes deposits on jobs that are not finished, so this is not the same as earned revenue." },
  outstanding: { key: "outstanding", label: "Outstanding", tables: ["ss_jobs", "ss_payments"],
    definition: "Booked work that has not been paid for yet.",
    formula: "sum(job.value for stage > 0) - sum(payments)",
    caveat: "A job mid-build legitimately sits here; it is not all overdue money." },
  reviews: { key: "reviews", label: "Reviews", tables: ["ss_reviews"],
    definition: "Count of reviews collected and their average star rating.",
    formula: "count(*) and avg(stars)",
    caveat: "Only reviews recorded in the system - it does not read Google directly." },
};

const pctOrNull = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 100));

// Returns { value, display, rows[], n, d, ... } - rows are the exact records the number was built from, each
// carrying the id the UI needs to drill through to that record's own drawer.
export async function compute(t: string, key: string) {
  const m = METRICS[key];
  if (!m) return null;
  const meta = { ...m, tenant: t, computed_at: new Date().toISOString() };

  if (key === "answered" || key === "speed") {
    const { data } = await sb.from("ss_leads").select("id,name,source,status,response_seconds,created_at").eq("tenant_id", t).order("created_at", { ascending: false });
    const all = data ?? [];
    const answered = all.filter((l) => (l.response_seconds ?? 0) > 0);
    if (key === "answered") {
      const v = pctOrNull(answered.length, all.length);
      return { ...meta, value: v, display: v === null ? "—" : v + "%", n: answered.length, d: all.length,
        no_data: all.length === 0 ? "No leads recorded yet." : undefined,
        rows: all.map((l) => ({ id: l.id, kind: "lead", title: l.name, detail: `${l.source} · ${l.status}`,
          contributes: (l.response_seconds ?? 0) > 0 ? "answered" : "NOT answered", value: l.response_seconds ?? 0 })) };
    }
    const avg = answered.length ? Math.round(answered.reduce((a, l) => a + l.response_seconds, 0) / answered.length) : null;
    return { ...meta, value: avg, display: avg === null ? "—" : avg + "s", n: answered.length, d: answered.length,
      no_data: answered.length === 0 ? "No lead has been answered yet, so there is nothing to average." : undefined,
      rows: answered.map((l) => ({ id: l.id, kind: "lead", title: l.name, detail: `${l.source} · ${l.status}`,
        contributes: l.response_seconds + "s", value: l.response_seconds })) };
  }

  if (key === "quotes_fast") {
    const { data: qs } = await sb.from("ss_quotes").select("id,lead_id,total,summary,created_at,status").eq("tenant_id", t);
    const quotes = qs ?? [];
    const ids = [...new Set(quotes.map((q) => q.lead_id).filter(Boolean))];
    const { data: ls } = ids.length ? await sb.from("ss_leads").select("id,name,created_at").in("id", ids) : { data: [] };
    const leadById = new Map((ls ?? []).map((l) => [l.id, l]));
    const timed = quotes.filter((q) => q.lead_id && leadById.has(q.lead_id));
    const fast = timed.filter((q) => (new Date(q.created_at).getTime() - new Date(leadById.get(q.lead_id)!.created_at).getTime()) <= 864e5);
    const v = pctOrNull(fast.length, timed.length);
    return { ...meta, value: v, display: v === null ? "—" : v + "%", n: fast.length, d: timed.length,
      no_data: quotes.length === 0 ? "No quotes have been saved yet, so there is nothing to time. This reads '—' rather than 100% on purpose."
             : timed.length === 0 ? "Quotes exist but none is attached to a lead, so none can be timed." : undefined,
      rows: timed.map((q) => {
        const hrs = (new Date(q.created_at).getTime() - new Date(leadById.get(q.lead_id)!.created_at).getTime()) / 36e5;
        return { id: q.id, kind: "quote", title: leadById.get(q.lead_id)!.name, detail: q.summary ?? q.status,
          contributes: hrs <= 24 ? `${hrs.toFixed(1)}h - under 24` : `${hrs.toFixed(1)}h - OVER 24`, value: Math.round(hrs * 10) / 10 };
      }) };
  }

  if (key === "close_rate") {
    const { data } = await sb.from("ss_leads").select("id,name,source,status,created_at").eq("tenant_id", t).in("status", ["won", "lost"]);
    const dec = data ?? [];
    const won = dec.filter((l) => l.status === "won");
    const v = pctOrNull(won.length, dec.length);
    return { ...meta, value: v, display: v === null ? "—" : v + "%", n: won.length, d: dec.length,
      no_data: dec.length === 0 ? "No lead has been won or lost yet, so there is no close rate to report." : undefined,
      rows: dec.map((l) => ({ id: l.id, kind: "lead", title: l.name, detail: l.source,
        contributes: l.status === "won" ? "won" : "lost", value: l.status === "won" ? 1 : 0 })) };
  }

  if (key === "booked" || key === "outstanding") {
    const { data: js } = await sb.from("ss_jobs").select("id,name,scope,value,stage,install_date").eq("tenant_id", t).gt("stage", 0);
    const jobs = js ?? [];
    const booked = jobs.reduce((a, j) => a + Number(j.value ?? 0), 0);
    if (key === "booked") {
      return { ...meta, value: booked, display: "$" + Math.round(booked).toLocaleString(), n: jobs.length, d: jobs.length,
        no_data: jobs.length === 0 ? "No job has moved past the quote stage yet." : undefined,
        rows: jobs.map((j) => ({ id: j.id, kind: "job", title: j.name, detail: j.scope,
          contributes: "$" + Math.round(Number(j.value)).toLocaleString(), value: Number(j.value) })) };
    }
    const { data: ps } = await sb.from("ss_payments").select("job_id,amount").eq("tenant_id", t);
    const paid = new Map<string, number>();
    for (const p of ps ?? []) paid.set(p.job_id, (paid.get(p.job_id) ?? 0) + Number(p.amount ?? 0));
    const rows = jobs.map((j) => {
      const owe = Number(j.value ?? 0) - (paid.get(j.id) ?? 0);
      return { id: j.id, kind: "job", title: j.name, detail: `${j.scope} · billed $${Math.round(Number(j.value)).toLocaleString()}, paid $${Math.round(paid.get(j.id) ?? 0).toLocaleString()}`,
        contributes: "$" + Math.round(owe).toLocaleString() + " outstanding", value: owe };
    }).filter((r) => Math.abs(r.value) > 0.5);
    const total = rows.reduce((a, r) => a + r.value, 0);
    return { ...meta, value: total, display: "$" + Math.round(total).toLocaleString(), n: rows.length, d: jobs.length,
      no_data: jobs.length === 0 ? "No booked work yet." : undefined, rows };
  }

  if (key === "collected") {
    const { data: ps } = await sb.from("ss_payments").select("id,job_id,kind,amount,method,created_at").eq("tenant_id", t).order("created_at", { ascending: false });
    const pay = ps ?? [];
    const ids = [...new Set(pay.map((p) => p.job_id).filter(Boolean))];
    const { data: js } = ids.length ? await sb.from("ss_jobs").select("id,name").in("id", ids) : { data: [] };
    const nameById = new Map((js ?? []).map((j) => [j.id, j.name]));
    const total = pay.reduce((a, p) => a + Number(p.amount ?? 0), 0);
    return { ...meta, value: total, display: "$" + Math.round(total).toLocaleString(), n: pay.length, d: pay.length,
      no_data: pay.length === 0 ? "No payment has been recorded yet." : undefined,
      rows: pay.map((p) => ({ id: p.job_id, kind: "job", title: nameById.get(p.job_id) ?? "(job not found)",
        detail: `${p.kind} · ${p.method} · ${new Date(p.created_at).toLocaleDateString()}`,
        contributes: "$" + Math.round(Number(p.amount)).toLocaleString(), value: Number(p.amount) })) };
  }

  if (key === "reviews") {
    const { data } = await sb.from("ss_reviews").select("id,job_id,who,stars,body,created_at").eq("tenant_id", t).order("created_at", { ascending: false });
    const rv = data ?? [];
    const avg = rv.length ? Math.round((rv.reduce((a, r) => a + r.stars, 0) / rv.length) * 10) / 10 : null;
    return { ...meta, value: avg, display: rv.length ? `${rv.length} · ${avg}★` : "—", n: rv.length, d: rv.length,
      no_data: rv.length === 0 ? "No reviews recorded yet." : undefined,
      rows: rv.map((r) => ({ id: r.job_id, kind: "job", title: r.who, detail: (r.body ?? "").slice(0, 90),
        contributes: r.stars + "★", value: r.stars })) };
  }
  return null;
}

export async function explain(path: string, req: Request, url: URL, t: string): Promise<Response | null> {
  // the whole strip, computed server-side - the browser stops doing its own arithmetic
  if (path === "/explain" && req.method === "GET") {
    const keys = (url.searchParams.get("keys") || Object.keys(METRICS).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    const out: any[] = [];
    for (const k of keys) { const r = await compute(t, k); if (r) out.push({ ...r, rows: undefined, row_count: r.rows?.length ?? 0 }); }
    return json({ metrics: out });
  }
  const one = path.match(/^\/explain\/([a-z_]+)$/);
  if (one && req.method === "GET") {
    const r = await compute(t, one[1]);
    if (!r) return json({ error: "unknown metric", known: Object.keys(METRICS) }, 404);
    return json(r);
  }
  return null;
}
