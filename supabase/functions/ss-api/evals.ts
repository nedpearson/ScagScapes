// Versioned evaluation suite on REAL Scag Scapes tasks (PRODUCT MANDATE §3, §12).
// A model is promoted to production only when its measured score here justifies it - never on a vendor's word.
// Bump SUITE_VERSION whenever a fixture or scorer changes so historical rows in ss_ai_evals stay comparable.
export const SUITE_VERSION = "2026.09.4";
import { smsIntent } from "./core.ts";

export interface Fixture { id: string; task: string; input: any; context: any; images?: string[]; expect: { must_mention?: string[]; must_not_mention?: string[]; must_not_state_price?: boolean; confidence_max?: number; must_say_not_in_records?: boolean }; }

// Context blocks mirror what context() in ai.ts retrieves, frozen so the test is repeatable.
export const FIXTURES: Fixture[] = [
  { id: "scope-01", task: "scope_from_lead", input: { text: "Back yard holds water for 3 days after rain, near the fence line by the pool, about 80 feet, clay soil" },
    context: { lead: { service_type: "drain", area: "Zachary", need: "Yard holding water" }, history: { service_type: "drain", jobs: 41, hours_est_vs_actual_ratio: 1.12, callbacks_per_job: 0.07 } },
    expect: { must_mention: ["fence", "pool"], must_not_state_price: true } },
  { id: "scope-02-noinvent", task: "scope_from_lead", input: { text: "Need a quote for the drain job we talked about last week" },
    context: { lead: { service_type: "drain", area: "Central", need: "Unknown - awaiting reply" } },
    expect: { must_say_not_in_records: true, must_not_state_price: true, confidence_max: 0.5 } },
  { id: "triage-01", task: "breakdown_triage", input: { symptom: "Mini excavator lost hydraulic power, loud whine, fluid on the ground", can_move: false },
    context: { asset: { category: "Mini excavator", make: "Bobcat", model: "E35", hours: 1840 }, breakdown_history: [{ symptom: "hydraulic hose burst", actual_cost: 420, actual_downtime_hours: 5 }] },
    expect: { must_mention: ["hydraulic"], must_not_mention: ["engine rebuild"], must_not_state_price: true } },
  { id: "takeoff-01", task: "takeoff_review", input: { lf: 120, depth: 24, pipe: 4, bom: [["#57 washed gravel", "9.8 CY"], ["Perforated pipe SDR-35 4\"", "120 LF"]] },
    context: { history: { service_type: "drain", material_waste_pct_mean: 0.11 } },
    expect: { must_mention: ["gravel"], must_not_state_price: true } },
  { id: "reply-01", task: "customer_reply", input: { text: "Can y'all come Saturday? And does the price include hauling the dirt off?" },
    context: { lead: { name: "K. Landry", service_type: "drain" }, messages: [{ who: "sys", body: "Next open site visits: Thu 9/24 9:00 or Fri 9/25 1:00" }] },
    expect: { must_not_state_price: true, must_mention: ["haul"] } },
  // Vision fixture. It points at Scag's OWN storage, not a public URL: the first version of this fixture used a
  // Wikimedia link that did not resolve, and the model was scored 0 for a broken link rather than for anything it
  // said - a test that slanders the thing it measures is worse than no test. A "storage:" image is resolved to a
  // short-lived signed URL at run time, exactly as production does for breakdown photos. Until someone uploads a
  // photo to that path the fixture is SKIPPED with a reason, never scored.
  { id: "triage-photo-01", task: "breakdown_triage", input: { symptom: "Fluid on the ground under the machine, see photo" },
    images: ["storage:breakdown-media/evals/hydraulic-hose-burst.jpg"],
    context: { asset: { category: "Mini excavator", make: "Bobcat", model: "E35" } },
    expect: { must_mention: ["hose"], must_not_mention: ["engine rebuild", "transmission"], must_not_state_price: true } },
  { id: "risk-01", task: "job_risk", input: {},
    context: { job: { service_type: "drain", value: 6400, labor_hours: 24, install_date: "2026-09-29" }, actuals: null, history: { service_type: "drain", hours_est_vs_actual_ratio: 1.12, callbacks_per_job: 0.07, weather_days_lost_mean: 0.6 } },
    expect: { must_mention: ["weather"], must_not_state_price: true } },
];

export const PRICE_RE = /\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*\s?(dollars|usd)\b|\btotal\s*(is|of|:)\s*\d/i;
const txt = (o: any) => JSON.stringify(o).toLowerCase();

// Deterministic scorer: 0..1. Penalises invention hardest, because that is the failure that costs money.
export function score(f: Fixture, out: any): number {
  const s = txt(out); let pts = 0, max = 0;
  const e = f.expect;
  if (e.must_mention) for (const w of e.must_mention) { max++; if (s.includes(w.toLowerCase())) pts++; }
  if (e.must_not_mention) for (const w of e.must_not_mention) { max++; if (!s.includes(w.toLowerCase())) pts++; }
  if (e.must_not_state_price) { max += 2; if (!PRICE_RE.test(String(out?.recommendation ?? "") + " " + String(out?.reasoning ?? ""))) pts += 2; }
  if (e.must_say_not_in_records) { max += 2; if (/not in records|no record|not on file|cannot find/.test(s)) pts += 2; }
  if (e.confidence_max !== undefined) { max++; if (Number(out?.confidence ?? 1) <= e.confidence_max) pts++; }
  max++; if (Array.isArray(out?.evidence) && out.evidence.length) pts++;   // cited its evidence
  return max ? +(pts / max).toFixed(3) : 0;
}

// ---------- the baseline a model has to beat ----------
// Scored by the SAME scorer as every model, so "route SMS through the model" stops being a judgement call and
// becomes a comparison of two numbers in ss_ai_evals. Only a task with a real deterministic equivalent gets a
// baseline; inventing one for the others would make the comparison dishonest.
const BASELINE_SLOTS = [{ date: "2026-09-24", time: "9:00" }, { date: "2026-09-25", time: "1:00" }];
export function baseline(f: Fixture): any | null {
  if (f.task !== "customer_reply") return null;
  const si = smsIntent(String(f.input?.text ?? ""), BASELINE_SLOTS, 30);
  return { recommendation: si.reply, reasoning: "deterministic intent ladder (core.ts smsIntent)",
    confidence: si.intent === "other" ? 0.4 : 0.8, assumptions: [], alternatives: [], evidence: ["regex intent ladder"] };
}
