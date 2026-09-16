// deno test --allow-env --allow-net --allow-read tests.ts
Deno.env.set("SUPABASE_URL", "https://example.supabase.co"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
const { price } = await import("./core.ts");
const { rentalTotal } = await import("./sourcing.ts");
const { diagnose, scoreOptions, explainQty, readiness, loaded, estimateBreakdown, STATUS } = await import("./fieldops.ts");

Deno.test("pricing engine: drain rate stays inside published $25–60/LF", () => {
  for (const soil of [1, 1.12, 1.2]) for (const depth of [18, 24, 30]) for (const pipe of [4, 6]) { const p = price("drain", { lf: 100, depth, pipe, soil, basins: 0, pop: 0, sod: 0 }); const rate = p.rows[0][1] / 100; assert(rate >= 25 && rate <= 60, `rate ${rate}`); }
});
Deno.test("pricing engine: every service type prices and returns a BOM", () => { for (const t of ["drain", "pad", "fence", "patio", "sod", "porch"]) { const p = price(t, {}); assert(p.total > 0 && p.bom.length > 0, t); } });
Deno.test("rentalTotal: weekly cap beats 7 daily, monthly cap beats 4 weekly", () => { const rc = { day: 100, week: 300, month: 900 }; assertEquals(rentalTotal(rc, 1), 100); assertEquals(rentalTotal(rc, 4), 300); assertEquals(rentalTotal(rc, 7), 300); assertEquals(rentalTotal(rc, 10), 600); assertEquals(rentalTotal(rc, 28), 900); assertEquals(rentalTotal({ day: 0, week: 0, month: 0 }, 3), null); });
Deno.test("diagnose: hydraulic leak flags shutdown and never exceeds 0.85 confidence", () => { const d = diagnose({ symptom: "hydraulic hose leaking at boom", symptoms: ["fluid on ground"], safety_risk: false }); assert(d.should_shutdown); assert(d.likely_causes[0].component.includes("Hydraulic")); assert(d.confidence <= 0.85); assert(d.safety.some((s) => /pressurized/i.test(s))); assert(d.method.includes("no photo")); });
Deno.test("diagnose: unknown symptom is honest", () => { const d = diagnose({ symptom: "acting weird" }); assertEquals(d.likely_causes[0].component, "Unknown"); assert(d.confidence < 0.6); });
Deno.test("scoreOptions: ranks by weighted return-to-work, not sticker price; explains itself", () => {
  const opts = [{ label: "cheap tomorrow", ttr_hours: 24, total: 500 + 24 * 135, distance_mi: 5, confidence: .5, reliability: .7, cancel_flex: .6, fit: .8 }, { label: "rental in 1h", ttr_hours: 1, total: 900 + 135, distance_mi: 8, confidence: .8, reliability: .8, cancel_flex: .8, fit: .85 }];
  const r = scoreOptions(opts, { ttr: 30, cost: 25, distance: 15, availability: 10, reliability: 10, cancel: 5, fit: 5 });
  assertEquals(r[0].label, "rental in 1h"); assert(r[0].recommended); assert(r[0].score.weights.ttr === 30 && r[0].score.normalized.ttr === 1);
  const r2 = scoreOptions(opts.map((o) => ({ ...o })), { ttr: 5, cost: 5, distance: 90, availability: 0, reliability: 0, cancel: 0, fit: 0 }); assertEquals(r2[0].label, "cheap tomorrow");
});
Deno.test("explainQty: waste + pack rounding is shown", () => { const q = explainQty(286, .05, 10); assertAlmostEquals(q.required, 300.3, .01); assertEquals(q.purchasable, 310); assert(q.note.includes("5% waste")); });
Deno.test("readiness: a missing critical item is red regardless of percentage", () => { const items = [{ item: "pipe", status: "In Stock", critical: true }, { item: "excavator", status: "Needs Rental", critical: true }, { item: "gloves", status: "On Truck" }]; const r = readiness(items); assertEquals(r.state, "red"); assertEquals(r.critical_missing, ["excavator"]); const g = readiness([{ item: "a", status: "Loaded", critical: true }, { item: "b", status: "Verified" }]); assertEquals(g.state, "green"); assertEquals(g.pct, 100); });
Deno.test("loaded labor: wage → loaded → billing → customer rate is monotonic", () => { const l = loaded({ wage: 20, burden_pct: 32, overhead_pct: 18, target_margin_pct: 40 }); assertAlmostEquals(l.loaded, 26.4, .01); assert(l.internal_billing > l.loaded && l.customer_rate > l.internal_billing); });
Deno.test("estimate: discount shows exact margin impact", () => { const job = { value: 6200, labor_hours: 14, material_cost: 1090, service_type: "drain" }; const rates = [{ role: "Crew lead", wage: 26, burden_pct: 32 }, { role: "Laborer", wage: 19, burden_pct: 32 }]; const a = estimateBreakdown(job, rates, 224, {}); const b = estimateBreakdown(job, rates, 224, { discount_pct: 10 }); assertEquals(b.discount, 620); assert(b.gross_margin_pct < a.gross_margin_pct); assertEquals(b.margin_without_discount_pct, a.gross_margin_pct); assert(estimateBreakdown(job, rates, 224, { tier: "best" }).revenue > a.revenue); });
Deno.test("status vocabulary is the required set", () => { assertEquals(Object.values(STATUS).sort(), ["CALL_TO_CONFIRM", "CONNECTION_ERROR", "ESTIMATED", "LIVE_VERIFIED", "PROVIDER_POSTED", "STALE", "UNAVAILABLE"]); });
