// Reports and billing, computed from rows (PRODUCT MANDATE 6, 14).
//
// Billing previously showed a "Balance" column calculated as job.value x settings.deposit_pct - an assumption
// about what a customer *should* have paid, displayed in the same typeface as fact. The payment ledger was
// sitting right there. Money owed is now the difference between what was billed and what actually arrived, per
// job, and every figure carries the payment rows that produced it.
import { sb, json } from "./core.ts";

const money = (n: number) => Math.round(n * 100) / 100;
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5);

export async function reports(path: string, req: Request, url: URL, body: any, t: string, settings: any): Promise<Response | null> {

  // ---- the funnel, with the leads behind each step ----
  if (path === "/reports/funnel" && req.method === "GET") {
    const { data } = await sb.from("ss_leads").select("id,name,source,status,ad_channel,response_seconds,created_at").eq("tenant_id", t);
    const L = data ?? [];
    const step = (label: string, pred: (l: any) => boolean, why: string) => {
      const rows = L.filter(pred);
      return { label, why, n: rows.length, leads: rows.map((l) => ({ id: l.id, kind: "lead", title: l.name, detail: `${l.source} · ${l.status}` })) };
    };
    const steps = [
      step("Leads", () => true, "Every lead recorded, whatever the source."),
      step("Answered", (l) => (l.response_seconds ?? 0) > 0, "Got a reply at all. An unanswered lead cannot convert."),
      step("Estimate booked", (l) => ["booked", "quoted", "won"].includes(l.status), "Reached a scheduled site visit."),
      step("Quoted", (l) => ["quoted", "won"].includes(l.status), "A price went out."),
      step("Won", (l) => l.status === "won", "Became work."),
    ];
    const withRates = steps.map((s, i) => ({ ...s,
      pct_of_start: steps[0].n ? Math.round((s.n / steps[0].n) * 1000) / 10 : null,
      pct_of_prev: i === 0 ? null : (steps[i - 1].n ? Math.round((s.n / steps[i - 1].n) * 1000) / 10 : null) }));
    // the biggest single drop is the thing worth fixing, so name it rather than leaving it to be spotted
    let worst: any = null;
    for (let i = 1; i < withRates.length; i++) {
      const lost = withRates[i - 1].n - withRates[i].n;
      if (lost > 0 && (!worst || lost > worst.lost)) worst = { from: withRates[i - 1].label, to: withRates[i].label, lost, pct: withRates[i].pct_of_prev };
    }
    // A funnel step can never be larger than the one above it. When it is, the data is inconsistent and the
    // conversion rates below that point are meaningless - so say so rather than drawing a confident chart over it.
    const anomalies: any[] = [];
    for (let i = 1; i < withRates.length; i++) if (withRates[i].n > withRates[i - 1].n)
      anomalies.push({ step: withRates[i].label, above: withRates[i - 1].label, n: withRates[i].n, above_n: withRates[i - 1].n,
        meaning: `${withRates[i].n} leads reached "${withRates[i].label}" but only ${withRates[i - 1].n} passed "${withRates[i - 1].label}". Records are missing - most often a lead that was booked by hand without its first-response time being recorded.` });
    return json({ steps: withRates, biggest_drop: worst, anomalies,
      integrity: anomalies.length ? "inconsistent - see anomalies" : "consistent",
      source: "ss_leads", computed_at: new Date().toISOString() });
  }

  // ---- what each source is worth, by the lead's own source field (distinct from paid ad_channel) ----
  if (path === "/reports/sources" && req.method === "GET") {
    const { data: L } = await sb.from("ss_leads").select("id,name,source,status,ad_channel").eq("tenant_id", t);
    const { data: J } = await sb.from("ss_jobs").select("id,lead_id,value,stage").eq("tenant_id", t);
    const jobsByLead = new Map<string, any[]>();
    for (const j of J ?? []) { const a = jobsByLead.get(j.lead_id) ?? []; a.push(j); jobsByLead.set(j.lead_id, a); }
    const by: Record<string, any> = {};
    for (const l of L ?? []) {
      const k = l.source || "—";
      by[k] = by[k] ?? { source: k, leads: 0, won: 0, value: 0, lead_ids: [] as string[] };
      by[k].leads++; by[k].lead_ids.push(l.id);
      if (l.status === "won") { by[k].won++; by[k].value += (jobsByLead.get(l.id) ?? []).filter((j) => j.stage > 0).reduce((a, j) => a + Number(j.value ?? 0), 0); }
    }
    const rows = Object.values(by).map((r: any) => ({ ...r, win_pct: r.leads ? Math.round((r.won / r.leads) * 1000) / 10 : null,
      value_per_lead: r.leads ? money(r.value / r.leads) : null })).sort((a: any, b: any) => b.value - a.value);
    return json({ sources: rows, source: "ss_leads + ss_jobs", note: "'Source' is how the lead said it found Scag. Paid attribution lives on the Marketing page under ad_channel - the two answer different questions." });
  }

  // ---- margin per job, with actuals where they exist ----
  if (path === "/reports/margin" && req.method === "GET") {
    const { data: J } = await sb.from("ss_jobs").select("id,name,scope,service_type,value,material_cost,labor_hours,stage").eq("tenant_id", t).gt("stage", 0);
    const ids = (J ?? []).map((j) => j.id);
    const { data: A } = ids.length ? await sb.from("ss_job_actuals").select("*").in("job_id", ids) : { data: [] };
    const actByJob = new Map((A ?? []).map((a: any) => [a.job_id, a]));
    const rate = Number(settings?.labor_rate ?? 85);
    const rows = (J ?? []).map((j: any) => {
      const act: any = actByJob.get(j.id);
      const estMat = Number(j.material_cost ?? 0), estHrs = Number(j.labor_hours ?? 0);
      const useMat = act?.material_cost_actual ?? estMat;
      const useHrs = act?.labor_hours_actual ?? estHrs;
      const gp = Number(j.value ?? 0) - useMat - useHrs * rate;
      return { id: j.id, kind: "job", name: j.name, scope: j.scope, service_type: j.service_type,
        value: Number(j.value ?? 0), material_cost: useMat, labor_hours: useHrs, labor_rate: rate,
        gross_profit: money(gp), margin_pct: j.value ? Math.round((gp / Number(j.value)) * 1000) / 10 : null,
        basis: act ? "actuals" : "estimate",
        warn: j.service_type === "drain" && j.value && gp / Number(j.value) < 0.45 ? "drain job under 45%" : null };
    }).sort((a, b) => (a.margin_pct ?? 999) - (b.margin_pct ?? 999));
    return json({ jobs: rows, labor_rate: rate, with_actuals: rows.filter((r) => r.basis === "actuals").length,
      source: "ss_jobs + ss_job_actuals", note: "Jobs with recorded actuals use them. The rest are the estimate, and are labelled as such - an estimated margin is a hope, not a result." });
  }

  // ---- invoices: billed, actually paid, actually owed ----
  if (path === "/billing/invoices" && req.method === "GET") {
    const { data: J } = await sb.from("ss_jobs").select("id,name,scope,value,stage,install_date,paid_at,created_at").eq("tenant_id", t).gt("stage", 0).order("created_at", { ascending: false });
    const ids = (J ?? []).map((j) => j.id);
    const { data: P } = ids.length ? await sb.from("ss_payments").select("*").in("job_id", ids).order("created_at") : { data: [] };
    const payByJob = new Map<string, any[]>();
    for (const p of P ?? []) { const a = payByJob.get(p.job_id) ?? []; a.push(p); payByJob.set(p.job_id, a); }
    const depPct = Number(settings?.deposit_pct ?? 30);
    const rows = (J ?? []).map((j: any) => {
      const pays = payByJob.get(j.id) ?? [];
      const paid = pays.reduce((a, p) => a + Number(p.amount ?? 0), 0);
      const value = Number(j.value ?? 0);
      const balance = money(value - paid);
      const depositDue = money(value * depPct / 100);
      const firstPay = pays[0]?.created_at;
      return { id: j.id, kind: "job", name: j.name, scope: j.scope, stage: j.stage, value,
        deposit_due: depositDue, paid: money(paid), balance,
        // status comes from money that moved, not from the stage a person clicked
        status: balance <= 0.5 ? "paid in full" : paid <= 0.5 ? "nothing received" : paid + 0.5 >= depositDue ? "deposit received" : "part paid",
        days_outstanding: balance > 0.5 ? days(j.created_at, new Date().toISOString()) : null,
        days_to_first_payment: firstPay ? days(j.created_at, firstPay) : null,
        payments: pays.map((p: any) => ({ id: p.id, kind: p.kind, amount: Number(p.amount), method: p.method, at: p.created_at })) };
    });
    const outstanding = rows.reduce((a, r) => a + Math.max(r.balance, 0), 0);
    return json({ invoices: rows, outstanding: money(outstanding), deposit_pct: depPct,
      source: "ss_jobs + ss_payments",
      note: "Balance is billed minus received, from the payment ledger. It is not value x deposit% - that would be an assumption about what should have been paid, not a record of what was." });
  }

  // ---- how old the money is ----
  if (path === "/billing/aging" && req.method === "GET") {
    const inv = await (await reports("/billing/invoices", req, url, body, t, settings))!.json();
    const buckets = [["Current (0-14 days)", 0, 14], ["15-30 days", 15, 30], ["31-60 days", 31, 60], ["Over 60 days", 61, 100000]] as const;
    const out = buckets.map(([label, lo, hi]) => {
      const rows = inv.invoices.filter((r: any) => r.balance > 0.5 && (r.days_outstanding ?? 0) >= lo && (r.days_outstanding ?? 0) <= hi);
      return { label, n: rows.length, amount: money(rows.reduce((a: number, r: any) => a + r.balance, 0)),
        jobs: rows.map((r: any) => ({ id: r.id, kind: "job", title: r.name, detail: `${r.days_outstanding} days · ${r.status}`, contributes: "$" + Math.round(r.balance).toLocaleString() })) };
    });
    return json({ buckets: out, total: inv.outstanding, source: "ss_jobs + ss_payments" });
  }
  return null;
}
