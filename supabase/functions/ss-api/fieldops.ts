// ---------- field ops: equipment registry · breakdowns · recovery options · requirements/readiness · pricing · estimates · approvals · audit ----------
// Reality standard: every external figure carries a verification status. Nothing here is presented as LIVE_VERIFIED unless a provider-approved
// API confirmed it; Home Depot's undocumented endpoint is PROVIDER_POSTED; rate cards are ESTIMATED; chains are CALL_TO_CONFIRM.
import { sb, json, fmt, event, dLabel, iso, addD, price, TYPES, STATUS, pushAll } from "./core.ts";
export { STATUS };
import { miles, hdRental, rentalTotal } from "./sourcing.ts";
import { driveTimes } from "./routing.ts";
import { reliabilityMap } from "./resources.ts";
import { notify as route_notify, runEscalation, route as notifyRoute, prefsFor } from "./notify.ts";
import { buildPlans, type Offer } from "./plan.ts";
import { universalSearch } from "./resources.ts";
import { estimateLeg } from "./routing.ts";

const SHOP = { lat: 30.4515, lng: -91.1871 };
async function audit(t: string, actor: string, action: string, ref_type: string, ref_id: string | null, before: any, after: any) { await sb.from("ss_audit").insert({ tenant_id: t, actor, action, ref_type, ref_id, before, after }); }
// Routed through notify.ts so urgency, quiet hours, acknowledgement and escalation apply to every notice
// raised here. `settings` is threaded in where the caller has it; without it the tenant defaults apply.
async function notify(t: string, kind: string, title: string, body: string, ref?: { type: string; id: string }, settings?: any) { await route_notify(t, kind, title, body, ref, settings); }
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------- rule-assisted diagnosis (NOT vision AI — labeled as such in the output) ----------
export function diagnose(b: { symptom: string; symptoms?: string[]; codes?: string; can_move?: boolean; safety_risk?: boolean; notes?: string }, asset?: any) {
  const text = [b.symptom, ...(b.symptoms || []), b.codes, b.notes].filter(Boolean).join(" ").toLowerCase();
  const has = (...w: string[]) => w.some((x) => text.includes(x));
  const causes: { cause: string; component: string; p: number; safe_check?: string; part?: string }[] = [];
  if (has("hydraulic", "leak", "oil on", "boom slow", "weak", "won't lift", "wont lift", "drip")) { causes.push({ cause: "Hydraulic hose or fitting failure", component: "Hydraulic hose / cylinder", p: 0.55, safe_check: "With engine OFF and pressure relieved, look for wet hose ends and pooled fluid. Do not probe a pressurized leak by hand.", part: asset?.common_parts?.find?.((p: any) => /hose/i.test(p[0]))?.[1] }, { cause: "Low hydraulic fluid", component: "Hydraulic reservoir", p: 0.25, safe_check: "Check sight glass / dipstick on level ground, engine off." }, { cause: "Hydraulic pump or valve fault", component: "Pump / control valve", p: 0.2 }); }
  if (has("won't start", "wont start", "no start", "crank", "click", "dead", "battery")) causes.push({ cause: "Battery / connections", component: "Battery & cables", p: 0.45, safe_check: "Check terminals for corrosion and tightness; do not jump-start with visible fuel leak." }, { cause: "Fuel delivery (filter, air in system, empty)", component: "Fuel system", p: 0.35, safe_check: "Confirm fuel level; note when filter was last changed." }, { cause: "Starter / safety interlock", component: "Starter / seat switch", p: 0.2 });
  if (has("smoke", "overheat", "hot", "temperature", "steam")) causes.push({ cause: "Cooling system (radiator clogged with debris, low coolant, fan belt)", component: "Cooling system", p: 0.6, safe_check: "Shut down. Do NOT open a hot radiator cap. Look for debris packed in the radiator screen." }, { cause: "Hydraulic oil overheating", component: "Hydraulic cooler", p: 0.25 });
  if (has("track", "thrown", "derail", "tire", "flat", "puncture")) causes.push({ cause: "Track thrown / tension lost", component: "Undercarriage / track tensioner", p: 0.6, safe_check: "Do not run the machine. Check tensioner grease fitting for leak." }, { cause: "Tire puncture", component: "Tire", p: 0.4 });
  if (has("chain", "belt", "trencher", "won't dig", "wont dig", "digging chain")) causes.push({ cause: "Worn or broken chain / drive belt", component: "Digging chain / belt", p: 0.6, safe_check: "Engine off, key out. Inspect chain teeth and belt for breaks." }, { cause: "Hydrostatic drive fault", component: "Hydrostatic pump", p: 0.25 });
  if (has("code", "error", "warning", "light", "e-")) causes.push({ cause: "Fault code stored — read code from display / dealer tool", component: "Controller", p: 0.5 });
  if (!causes.length) causes.push({ cause: "Undetermined — needs mechanic diagnosis", component: "Unknown", p: 0.3 });
  const topRaw = causes[0].p; const total = causes.reduce((a, c) => a + c.p, 0); causes.forEach((c) => (c.p = Math.round(c.p / total * 100) / 100));
  const shutdown = !!b.safety_risk || has("smoke", "fire", "leak", "hydraulic", "track", "thrown", "steer", "brake", "structural", "crack");
  const needed = [];
  if (!b.codes) needed.push("Photo of any warning light or fault code on the display");
  if (!asset?.serial) needed.push("Serial-plate photo (for parts compatibility)");
  needed.push("Close-up of the failed area, wide shot of the machine, and whether fluid is on the ground");
  const confidence = Math.min(0.85, 0.3 + topRaw * 0.5 + (b.codes ? 0.1 : 0) + ((b.symptoms || []).length > 1 ? 0.05 : 0));
  return {
    method: "rule-assisted triage from reported symptoms (no photo/vision model configured)",
    observed: (b.symptoms || []).concat(b.codes ? ["Code: " + b.codes] : []),
    reported: [b.symptom].concat(b.notes ? [b.notes] : []),
    likely_causes: causes, unconfirmed: causes.slice(1).map((c) => c.cause),
    safety: shutdown ? ["Keep the unit shut down and keyed off until a qualified person inspects it.", "Do not work under an unsupported boom/bucket.", "Do not open pressurized hydraulic lines."] : ["Low apparent risk — do not operate if anything changes."],
    should_shutdown: shutdown,
    next_action: shutdown ? "Stop work on the machine, keep the crew productive on hand tasks, and compare recovery options below." : "Perform the safe checks listed, then compare recovery options.",
    needed, confidence: Math.round(confidence * 100) / 100,
    why: `Top cause "${causes[0].cause}" matched the reported symptom words; confidence is capped because no photos or codes were machine-read.`,
  };
}

// ---------- recovery options + transparent scoring ----------
export function scoreOptions(opts: any[], weights: Record<string, number>) {
  const W = { ttr: 30, cost: 25, distance: 15, availability: 10, reliability: 10, cancel: 5, fit: 5, ...(weights || {}) }; const sumW = Object.values(W).reduce((a, b) => a + b, 0);
  const lo = (k: string) => Math.min(...opts.map((o) => num(o[k], 0))), hi = (k: string) => Math.max(...opts.map((o) => num(o[k], 0)));
  const norm = (v: number, k: string, lowerBetter: boolean) => { const a = lo(k), b = hi(k); if (b === a) return 1; const x = (v - a) / (b - a); return lowerBetter ? 1 - x : x; };
  for (const o of opts) {
    const s = { ttr: norm(num(o.ttr_hours), "ttr_hours", true), cost: norm(num(o.total), "total", true), distance: norm(num(o.distance_mi), "distance_mi", true), availability: num(o.confidence, .5), reliability: num(o.reliability, .7), cancel: num(o.cancel_flex, .6), fit: num(o.fit, .8) };
    const final = Object.entries(s).reduce((a, [k, v]) => a + v * (W as any)[k], 0) / sumW;
    o.score = { inputs: { ttr_hours: o.ttr_hours, total: o.total, distance_mi: o.distance_mi, confidence: o.confidence, reliability: o.reliability, cancel_flex: o.cancel_flex, fit: o.fit }, normalized: s, weights: W, final: Math.round(final * 1000) / 1000 };
  }
  opts.sort((a, b) => b.score.final - a.score.final); if (opts[0]) opts[0].recommended = true; return opts;
}
function method(v: any, live?: any) { if (live && live.available > 0) return "RESERVE_ONLINE"; if (v?.meta?.book === "online") return "BOOK_APPOINTMENT"; return "CALL_NOW"; }
async function buildOptions(t: string, b: any, asset: any, settings: any) {
  const lat = b.lat || SHOP.lat, lng = b.lng || SHOP.lng; const crewCost = num(settings.crew_cost_per_hour, 135); const dt = (h: number) => Math.round(h * crewCost);
  const { data: vendors } = await sb.from("ss_vendors").select("*").in("kind", ["hose", "mobile_repair", "repair", "dealer", "tire", "transport", "rental"]);
  // Drive time on the real road network, and reliability from Scag's own record with each vendor rather than a
  // constant per option kind. Both degrade honestly: an unroutable vendor keeps a calibrated straight-line
  // estimate (flagged ESTIMATED), and a vendor with fewer than three recorded events keeps the neutral .7.
  const [legs, rel] = await Promise.all([
    driveTimes({ lat, lng }, (vendors ?? []).map((v: any) => ({ lat: v.lat ?? null, lng: v.lng ?? null }))),
    reliabilityMap(t),
  ]);
  const V = (vendors ?? []).map((v: any, i: number) => {
    const leg = legs[i];
    const routed = leg && leg.distance_mi > 0;
    return { ...v, leg,
      distance: routed ? leg.distance_mi : (v.lat ? miles(lat, lng, v.lat, v.lng) : 20),
      drive_hours: routed ? leg.minutes / 60 : (v.lat ? miles(lat, lng, v.lat, v.lng) / 31 : 0.65),
      reliability: rel.get(v.id) ?? .7 };
  });
  const hyd = /hydraulic|hose|leak/i.test(b.symptom + " " + (b.symptoms || []).join(" ")); const tire = /tire|flat/i.test(b.symptom); const cat = (asset?.category || "").toLowerCase();
  const opts: any[] = [];
  // 1. internal spare
  const { data: spares } = asset ? await sb.from("ss_equipment_assets").select("*").eq("tenant_id", t).eq("category", asset.category).neq("id", asset.id).eq("status", "Available") : { data: [] };
  for (const s of spares ?? []) opts.push({ kind: "internal_spare", label: `Use ${s.asset_no} · ${s.make} ${s.model} (in yard)`, vendor_name: "Scag Scapes yard", ttr_hours: 1.5, distance_mi: miles(lat, lng, SHOP.lat, SHOP.lng), open_now: true, cost: { direct: 0, transport: 60, fees: 0 }, total: 60 + dt(1.5), downtime_cost: dt(1.5), availability_status: STATUS.LIVE, price_status: STATUS.LIVE, confidence: .95, reliability: .95, cancel_flex: 1, fit: 1, method: "RESERVE_ONLINE", evidence: { source: "ss_equipment_assets", checked_at: new Date().toISOString(), note: "internal record — allocate and go" } });
  // 2. mobile hose / mobile mechanic
  for (const v of V.filter((v: any) => (hyd && v.kind === "hose") || v.kind === "mobile_repair" || (tire && v.kind === "tire")).slice(0, 4)) { const eta = Math.round(((v.meta?.after_hours ? 0.5 : 1.75) + v.drive_hours) * 10) / 10, repair = hyd ? 1.5 : 3; const direct = hyd ? 385 : 150 + 125 * repair + 220; opts.push({ kind: v.kind === "hose" ? "mobile_hose" : "mobile_mechanic", label: `${v.kind === "hose" ? "Mobile hose service" : "Mobile mechanic"} · ${v.name}`, vendor_id: v.id, vendor_name: v.name, phone: v.phone, url: v.meta?.url, ttr_hours: eta + repair, distance_mi: v.distance, open_now: true, after_hours: !!v.meta?.after_hours, cost: { direct, service_call: hyd ? 95 : 150, labor_rate: 125, parts_est: hyd ? 180 : 220, fees: 0 }, total: direct + dt(eta + repair), downtime_cost: dt(eta + repair), availability_status: STATUS.CALL, price_status: STATUS.EST, confidence: v.meta?.after_hours ? .6 : .5, reliability: v.reliability, cancel_flex: .7, fit: .95, method: method(v), evidence: { source: v.meta?.url, checked_at: v.meta?.verified, distance: { miles: v.distance, minutes: v.leg?.minutes ?? null, status: v.leg?.status, source: v.leg?.source, caveat: v.leg?.caveat }, note: "hours/services from provider page; price is a planning estimate — confirm on the call" } }); }
  // 3. dealer service (brand match first)
  const brand = (asset?.make || "").toLowerCase();
  for (const v of V.filter((v: any) => v.kind === "dealer").sort((a: any, b2: any) => ((b2.meta?.brands || []).some((x: string) => x.toLowerCase() === brand) ? 1 : 0) - ((a.meta?.brands || []).some((x: string) => x.toLowerCase() === brand) ? 1 : 0) || a.distance - b2.distance).slice(0, 2)) { const match = (v.meta?.brands || []).some((x: string) => x.toLowerCase() === brand); const tow = b.can_move === false ? 350 : 0; const ttr = 30 + (tow ? 4 : 2); opts.push({ kind: "dealer", label: `Dealer service · ${v.name}${match ? " (brand match)" : ""}`, vendor_id: v.id, vendor_name: v.name, phone: v.phone, url: v.meta?.booking_url || v.meta?.url, ttr_hours: ttr, distance_mi: v.distance, open_now: true, after_hours: false, cost: { direct: 165 + 140 * 3 + 260, diagnostic: 165, labor_rate: 140, parts_est: 260, transport: tow }, total: 165 + 420 + 260 + tow + dt(8), downtime_cost: dt(8), availability_status: STATUS.CALL, price_status: STATUS.EST, confidence: .55, reliability: v.reliability, cancel_flex: .6, fit: match ? .9 : .7, method: method(v), warranty: asset?.warranty_until && asset.warranty_until >= iso(new Date()) ? "In warranty — dealer path may be covered" : null, evidence: { source: v.meta?.url, checked_at: v.meta?.verified, note: v.meta?.book === "online" ? "online service request form verified" : "phone/form only" } }); }
  // 4. rental replacement (live HD + chains) — downtime counts only until the rental arrives
  const item = cat.includes("excavator") ? "excavator" : cat.includes("skid") ? "loader" : cat.includes("trencher") ? "trencher" : cat.includes("compactor") ? "compact" : cat.includes("sod") ? "sod" : cat.includes("trailer") ? "trailer" : "";
  if (item) { const days = Math.max(1, Math.ceil(num(b.downtime_est_hours, 8) / 8)); const { data: cards } = await sb.from("ss_rate_cards").select("*"); const cache: Record<string, any> = {};
    for (const c of (cards ?? []).filter((c: any) => c.category === item || c.item.toLowerCase().includes(item)).slice(0, 6)) { for (const v of V.filter((v: any) => v.kind === "rental" && v.brand === c.brand)) { let live: any = null; if (c.brand === "Home Depot" && c.ext_cat) { const k = c.ext_cat + "/" + c.ext_sub; cache[k] = cache[k] || await hdRental(c.ext_cat, c.ext_sub); live = cache[k][v.ext_id]; if (live && live.available === undefined) live.available = 0; } const rc = live?.day ? live : c; const tot = rentalTotal(rc, days) ?? 0; const eta = Math.round((1 + v.drive_hours) * 10) / 10; opts.push({ kind: "rental", label: `Rent ${c.item} · ${v.name}`, vendor_id: v.id, vendor_name: v.name, phone: v.phone, url: v.meta?.url, ttr_hours: Math.round(eta * 10) / 10, distance_mi: v.distance, open_now: true, cost: { direct: tot, day: rc.day, week: rc.week, deposit: rc.deposit ?? c.deposit ?? 0, delivery: 0, fees: Math.round(tot * .12) }, total: tot + Math.round(tot * .12) + dt(eta), downtime_cost: dt(eta), availability_status: live?.day ? (live.available > 0 ? STATUS.POSTED : STATUS.NA) : STATUS.CALL, price_status: live?.day ? STATUS.POSTED : (c.verified ? STATUS.POSTED : STATUS.EST), confidence: live?.day ? (live.available > 0 ? .8 : .1) : .45, reliability: v.reliability, cancel_flex: .8, fit: .85, method: method(v, live), available: live?.available ?? null, evidence: { source: c.source_url, checked_at: live?.day ? new Date().toISOString() : c.checked_at, method: live?.day ? "Home Depot rental pricing/inventory endpoint (undocumented)" : "rate card", store: v.ext_id } }); } } }
  // 5. transport to shop (pairs with dealer) and 6. reschedule
  const tow = V.filter((v: any) => v.kind === "transport").sort((a: any, b2: any) => a.distance - b2.distance)[0];
  if (tow && b.can_move === false) opts.push({ kind: "transport", label: `Haul to shop · ${tow.name}`, vendor_id: tow.id, vendor_name: tow.name, phone: tow.phone, url: tow.meta?.url, ttr_hours: 26, distance_mi: tow.distance, open_now: true, after_hours: !!tow.meta?.after_hours, cost: { direct: 350, transport: 350 }, total: 350 + dt(8), downtime_cost: dt(8), availability_status: STATUS.CALL, price_status: STATUS.EST, confidence: .5, reliability: tow.reliability, cancel_flex: .7, fit: .5, method: "CALL_NOW", evidence: { source: tow.meta?.url, checked_at: tow.meta?.verified } });
  opts.push({ kind: "reschedule", label: "Redeploy crew to hand work / next job; repair tomorrow", vendor_name: "Internal", ttr_hours: 24, distance_mi: 0, open_now: true, cost: { direct: 0 }, total: dt(num(b.downtime_est_hours, 8)), downtime_cost: dt(num(b.downtime_est_hours, 8)), availability_status: STATUS.LIVE, price_status: STATUS.EST, confidence: .9, reliability: .9, cancel_flex: 1, fit: .3, method: "RESERVE_ONLINE", evidence: { note: "no external dependency; cost is lost crew production" } });
  return scoreOptions(opts, settings.recovery_weights || {});
}

// ---------- requirements / readiness ----------
const TEMPL: Record<string, { tools: string[]; equipment: string[]; consumables: string[]; ppe: string[]; logistics: string[]; docs: string[]; critical: string[] }> = {
  drain: { tools: ["Rotary laser level + grade rod", "Trenching shovels ×4", "Tamper", "PVC saw", "Tape / wheel"], equipment: ["Mini excavator", "Dump trailer", "Plate compactor"], consumables: ["Marking paint", "Diesel 15 gal", "PVC primer/cement", "Zip ties"], ppe: ["Cones ×8", "Hi-vis vests", "Gloves", "Eye protection", "First-aid kit"], logistics: ["Spoils haul-off (1 load)", "Gravel delivery or pickup", "Water access for compaction"], docs: ["LA 811 locate ticket (48 h)", "Moasure elevation map", "Customer selections / discharge point", "Warranty letter"], critical: ["Perforated pipe", "washed gravel", "Mini excavator", "LA 811"] },
  pad: { tools: ["Screed board", "Bull float", "Edger", "Rebar cutter", "Laser level"], equipment: ["Skid steer / CTL", "Plate compactor", "Dump trailer"], consumables: ["Form stakes", "Form oil", "Diesel 10 gal", "Marking paint"], ppe: ["Cones ×8", "Hi-vis vests", "Gloves", "Eye protection", "Rubber boots"], logistics: ["Ready-mix delivery window", "Base delivery", "Spoils haul-off"], docs: ["LA 811 locate ticket", "Pour plan / thickness", "Customer approval of layout"], critical: ["Ready-mix", "Skid steer", "LA 811"] },
  fence: { tools: ["Post-hole digger / auger", "String line", "Levels", "Circular saw", "Impact driver"], equipment: ["One-man auger", "Dump trailer"], consumables: ["Screws / nails", "Concrete bags", "Marking paint"], ppe: ["Gloves", "Eye protection", "Hearing protection"], logistics: ["Lumber delivery", "Old fence haul-off"], docs: ["LA 811 locate ticket", "Property line confirmation", "HOA approval if applicable"], critical: ["Cedar posts", "LA 811"] },
  patio: { tools: ["Plate compactor", "Wet saw", "Screed pipes", "Rubber mallet", "Levels"], equipment: ["Skid steer / CTL", "Plate compactor", "Dump trailer"], consumables: ["Diamond blade", "Polymeric sand", "Marking paint"], ppe: ["Gloves", "Eye protection", "Hearing protection", "Knee pads"], logistics: ["Paver delivery", "Base delivery", "Spoils haul-off"], docs: ["Layout drawing", "Customer material selection"], critical: ["pavers", "610 limestone base"] },
  sod: { tools: ["Sod cutter", "Rakes", "Roller", "Wheelbarrows"], equipment: ["Sod cutter", "Dump trailer"], consumables: ["Starter fertilizer", "Marking paint"], ppe: ["Gloves", "Sun protection"], logistics: ["Sod delivery (same day)", "Old turf haul-off", "Irrigation on for 2 weeks"], docs: ["Watering instructions for customer"], critical: ["sod"] },
  porch: { tools: ["Circular saw", "Miter saw", "Drill / impact", "Levels", "Staple gun"], equipment: [], consumables: ["Screws", "Spline", "Sealant"], ppe: ["Gloves", "Eye protection", "Fall protection if roof"], logistics: ["Lumber delivery", "Debris haul-off"], docs: ["Permit if roof tie-in", "Customer screen/door selections"], critical: ["Permit if roof tie-in"] },
};
export function explainQty(base: number, waste: number, unitPack: number) { const req = base * (1 + waste); const buy = Math.ceil(req / unitPack) * unitPack; return { base, waste_factor: waste, required: Math.round(req * 100) / 100, purchasable: buy, pack: unitPack, note: `${base} × (1 + ${Math.round(waste * 100)}% waste) = ${Math.round(req * 100) / 100}; rounded to pack of ${unitPack} → ${buy}` }; }
const FULFILLED = new Set(["In Stock", "On Truck", "In Warehouse", "Reserved", "Rented", "Ready for Pickup", "Delivery Scheduled", "Loaded", "Verified", "Ordered"]);
export function readiness(items: any[]) { const n = items.length || 1; const ok = items.filter((i) => FULFILLED.has(i.status)).length; const critMissing = items.filter((i) => i.critical && !FULFILLED.has(i.status)); const pct = Math.round(ok / n * 100); return { pct, ok, total: items.length, critical_missing: critMissing.map((i) => i.item), state: critMissing.length ? "red" : pct >= 90 ? "green" : "yellow" }; }
async function generateRequirements(t: string, job: any) {
  const q = job.quote_id ? (await sb.from("ss_quotes").select("inputs").eq("id", job.quote_id).maybeSingle()).data : null;
  let bom: any[] = []; try { bom = price(job.service_type, q?.inputs ?? {}).bom; } catch { bom = job.materials || []; }
  const tpl = TEMPL[job.service_type] || TEMPL.drain; const rows: any[] = [];
  const parseQty = (s: string) => { const m = String(s).match(/([\d.]+)\s*(\w+)/); return m ? { n: Number(m[1]), u: m[2] } : { n: 1, u: "ea" }; };
  for (const b of bom) { const { n, u } = parseQty(b[1]); const calc = explainQty(n, /pipe|fabric|sod|paver/i.test(b[0]) ? .05 : .1, /pipe/i.test(b[0]) ? 10 : 1); rows.push({ category: "materials", item: b[0], qty: calc.purchasable, unit: u, calc: { ...calc, supplier: b[2], from: "pricing engine BOM" }, critical: tpl.critical.some((c) => b[0].toLowerCase().includes(c.toLowerCase())), source: "ai", confidence: q ? .75 : .55 }); }
  const add = (cat: string, list: string[], conf = .8) => list.forEach((it) => rows.push({ category: cat, item: it, qty: 1, unit: "ea", calc: { from: "service template " + job.service_type }, critical: tpl.critical.some((c) => it.toLowerCase().includes(c.toLowerCase())), source: "template", confidence: conf }));
  add("tools", tpl.tools); add("equipment", tpl.equipment); add("consumables", tpl.consumables); add("ppe", tpl.ppe); add("logistics", tpl.logistics); add("docs", tpl.docs);
  // inventory + equipment matching
  const { data: inv } = await sb.from("ss_inventory_items").select("*").eq("tenant_id", t); const { data: eq } = await sb.from("ss_equipment_assets").select("*").eq("tenant_id", t); const { data: busy } = await sb.from("ss_job_requirements").select("allocated_asset_id, job_id").eq("tenant_id", t).not("allocated_asset_id", "is", null).neq("job_id", job.id);
  const busyIds = new Set((busy ?? []).map((b: any) => b.allocated_asset_id));
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9# ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const sim = (a: string, b: string) => { const A = words(a), B = new Set(words(b)); return A.filter((w) => B.has(w)).length / Math.max(1, Math.min(A.length, B.size)); };
  for (const r of rows) {
    if (r.category === "materials" || r.category === "tools" || r.category === "consumables" || r.category === "ppe") { const m = (inv ?? []).map((i: any) => ({ i, s: sim(r.item, i.name) })).filter((x) => x.s >= .5).sort((a, b) => b.s - a.s)[0]; if (m) { const have = num(m.i.qty); r.status = have >= r.qty ? (/truck/i.test(m.i.location) ? "On Truck" : "In Stock") : "Needs Purchase"; r.notes = `${have} ${m.i.unit} at ${m.i.location}${have < r.qty ? ` — short ${Math.round((r.qty - have) * 100) / 100}` : ""}`; } else r.status = r.category === "materials" ? "Needs Purchase" : "Needed"; }
    if (r.category === "equipment") { const cand = (eq ?? []).filter((e: any) => sim(r.item, e.category) >= .5 || r.item.toLowerCase().includes(e.category.toLowerCase().split(" ")[0])); const free = cand.find((e: any) => e.status === "Available" && !busyIds.has(e.id)); if (free) { r.status = "Reserved"; r.allocated_asset_id = free.id; r.notes = `${free.asset_no} · ${free.make} ${free.model}`; } else if (cand.length) { r.status = "Needs Rental"; r.notes = cand.map((e: any) => `${e.asset_no} ${busyIds.has(e.id) ? "allocated to another job" : e.status.toLowerCase()}`).join("; "); } else r.status = "Needs Rental"; }
    if (r.category === "logistics" || r.category === "docs") r.status = "Needed";
  }
  return rows;
}

// ---------- pricing / estimates ----------
export function loaded(rate: any) { const w = num(rate.wage); const l = w * (1 + num(rate.burden_pct) / 100); return { wage: w, loaded: Math.round(l * 100) / 100, internal_billing: Math.round(l * (1 + num(rate.overhead_pct) / 100) * 100) / 100, customer_rate: Math.round(l * (1 + num(rate.overhead_pct) / 100) / (1 - num(rate.target_margin_pct) / 100) * 100) / 100 }; }
export function estimateBreakdown(job: any, rates: any[], equipDaily: number, opts: { tier?: string; discount_pct?: number; days?: number } = {}) {
  const hours = num(job.labor_hours, Math.round(num(job.value) / 320)); const days = opts.days ?? Math.max(1, Math.ceil(hours / 16)); const lead = rates.find((r) => /lead/i.test(r.role)) || rates[0], lab = rates.find((r) => /labor/i.test(r.role)) || rates[0];
  const laborCost = hours / 2 * loaded(lead).loaded + hours / 2 * loaded(lab).loaded; const materials = num(job.material_cost, num(job.value) * .3); const equipment = equipDaily * days; const mobilization = 150 * days; const disposal = /drain|pad|patio/.test(job.service_type) ? 180 : 60; const direct = laborCost + materials + equipment + mobilization + disposal; const overhead = direct * .18; const contingency = direct * .05;
  const tierMult = opts.tier === "good" ? .82 : opts.tier === "best" ? 1.28 : 1; const price = Math.round(num(job.value) * tierMult); const discount = Math.round(price * num(opts.discount_pct) / 100); const revenue = price - discount; const gp = revenue - direct - overhead - contingency;
  return { tier: opts.tier || "better", hours, days, revenue, list_price: price, discount, labor_cost: Math.round(laborCost), material_cost: Math.round(materials), equipment_cost: Math.round(equipment), mobilization, disposal, direct_cost: Math.round(direct), overhead: Math.round(overhead), contingency: Math.round(contingency), gross_profit: Math.round(gp), gross_margin_pct: revenue ? Math.round(gp / revenue * 1000) / 10 : 0, margin_without_discount_pct: price ? Math.round((price - direct - overhead - contingency) / price * 1000) / 10 : 0 };
}
const INCL: Record<string, string[]> = { drain: ["Moasure 3D elevation survey and drainage design", "Trenching to designed fall (≥1%)", "Perforated SDR-35 pipe, washed gravel, non-woven fabric", "Catch basins and pop-up emitter at discharge", "Backfill, compaction and trench-line restoration", "Spoils hauled off; site cleaned", "Flow test after install", "1-year workmanship warranty"], pad: ["Layout and LA 811 locate", "Excavation and 610 limestone base, compacted", "Forms, reinforcement and 3500 psi concrete", "Finish, control joints, edge", "Spoils hauled off; site cleaned"], fence: ["Layout on confirmed property line", "Cedar posts set in concrete", "Rails, pickets, gates and hardware", "Old fence removed and hauled off"], patio: ["Excavation and compacted base", "Bedding sand, pavers, edge restraint", "Polymeric sand and compaction", "Spoils hauled off; site cleaned"], sod: ["Old turf removed", "Grade and topsoil prep", "Fresh sod laid and rolled", "Starter fertilizer and watering plan"], porch: ["Framing, screen and doors", "Roof tie-in where selected", "Debris hauled off"] };
const EXCL = ["Repair of unmarked private utilities (irrigation, dog fence, lighting) not disclosed before work", "Rock, buried concrete or debris requiring extra excavation (change order at hourly rate)", "Permits or HOA fees unless listed", "Landscape plantings unless listed"];
const ASSUME = ["Access for a mini excavator and dump trailer (36\" gate or better)", "Utilities located by LA 811 before start", "Normal soil conditions (Baton Rouge clay)", "Customer provides water and a staging area"];

// ---------- router ----------
export async function fieldops(path: string, req: Request, url: URL, body: any, t: string, settings: any): Promise<Response | null> {
  const actor = body.actor || req.headers.get("x-actor") || "demo user"; const role = body.role || req.headers.get("x-role") || "crew_lead";
  if (path === "/equipment" && req.method === "GET") { const { data } = await sb.from("ss_equipment_assets").select("*").eq("tenant_id", t).order("asset_no"); return json(data ?? []); }
  if (path === "/equipment" && req.method === "POST") { const { data, error } = await sb.from("ss_equipment_assets").insert({ tenant_id: t, ...body.asset, qr_code: body.asset?.qr_code || "SS-" + body.asset?.asset_no }).select().single(); if (error) return json({ error: error.message }, 400); await audit(t, actor, "equipment.created", "asset", data.id, null, data); return json(data); }
  const eq = path.match(/^\/equipment\/([0-9a-f-]{36})(\/status)?$/);
  if (eq && !eq[2]) { const { data: a } = await sb.from("ss_equipment_assets").select("*").eq("id", eq[1]).eq("tenant_id", t).maybeSingle(); if (!a) return json({ error: "not found" }, 404); const { data: ev } = await sb.from("ss_equipment_events").select("*").eq("asset_id", a.id).order("created_at", { ascending: false }).limit(30); const { data: bd } = await sb.from("ss_breakdowns").select("id,symptom,status,created_at,actual_cost,actual_downtime_hours").eq("asset_id", a.id).order("created_at", { ascending: false }); return json({ ...a, events: ev ?? [], breakdowns: bd ?? [] }); }
  if (eq && eq[2] && req.method === "POST") { const { data: before } = await sb.from("ss_equipment_assets").select("status").eq("id", eq[1]).maybeSingle(); const { data } = await sb.from("ss_equipment_assets").update({ status: body.status }).eq("id", eq[1]).eq("tenant_id", t).select().single(); await sb.from("ss_equipment_events").insert({ tenant_id: t, asset_id: eq[1], kind: "status", body: `${before?.status} → ${body.status}${body.note ? " · " + body.note : ""}` }); await audit(t, actor, "equipment.status", "asset", eq[1], before, { status: body.status }); return json(data); }
  const qr = path.match(/^\/equipment\/qr\/(.+)$/); if (qr) { const { data: a } = await sb.from("ss_equipment_assets").select("*").eq("tenant_id", t).eq("qr_code", decodeURIComponent(qr[1])).maybeSingle(); return json(a || { error: "unknown QR" }, a ? 200 : 404); }

  if (path === "/breakdowns" && req.method === "GET") { const { data } = await sb.from("ss_breakdowns").select("*, asset:ss_equipment_assets(asset_no,make,model,category), job:ss_jobs(name,scope)").eq("tenant_id", t).order("created_at", { ascending: false }); return json(data ?? []); }
  if (path === "/breakdowns" && req.method === "POST") {
    if (body.client_id) { const { data: dup } = await sb.from("ss_breakdowns").select("id").eq("tenant_id", t).eq("client_id", body.client_id).maybeSingle(); if (dup) return json({ id: dup.id, deduplicated: true }); }
    const asset = body.asset_id ? (await sb.from("ss_equipment_assets").select("*").eq("id", body.asset_id).maybeSingle()).data : null;
    const diag = diagnose(body, asset);
    const { data: b, error } = await sb.from("ss_breakdowns").insert({ tenant_id: t, asset_id: asset?.id ?? null, job_id: body.job_id || null, client_id: body.client_id || null, reporter: body.reporter || actor, lat: body.lat, lng: body.lng, site_addr: body.site_addr, symptom: body.symptom || "Equipment down", symptoms: body.symptoms || [], codes: body.codes || null, can_move: body.can_move !== false, transportable: body.transportable !== false, safety_risk: !!body.safety_risk, photos: body.photos || [], notes: body.notes || "", crew_affected: num(body.crew_affected, 2), downtime_est_hours: num(body.downtime_est_hours, 4), work_in_progress: body.work_in_progress || "", status: "diagnosed", diagnosis: diag }).select().single();
    if (error) return json({ error: error.message }, 400);
    if (asset) { await sb.from("ss_equipment_assets").update({ status: diag.should_shutdown ? "Down" : "Limited Use" }).eq("id", asset.id); await sb.from("ss_equipment_events").insert({ tenant_id: t, asset_id: asset.id, kind: "breakdown", body: body.symptom, hours: asset.hours, ref_id: b.id }); }
    const opts = await buildOptions(t, b, asset, settings); const per = num(settings.approval?.per_txn, 1500);
    const rows = opts.map((o) => ({ tenant_id: t, breakdown_id: b.id, kind: o.kind, label: o.label, vendor_id: o.vendor_id || null, vendor_name: o.vendor_name, phone: o.phone || null, url: o.url || null, ttr_hours: o.ttr_hours, distance_mi: o.distance_mi, open_now: o.open_now ?? null, after_hours: o.after_hours ?? null, cost: o.cost, total: o.total, downtime_cost: o.downtime_cost, availability_status: o.availability_status, price_status: o.price_status, confidence: o.confidence, method: o.method, score: o.score, recommended: !!o.recommended, requires_approval: num(o.cost?.direct) > per, evidence: { ...o.evidence, warranty: o.warranty || null, available: o.available ?? null } }));
    const { data: saved } = await sb.from("ss_recovery_options").insert(rows).select();
    await sb.from("ss_breakdowns").update({ status: "options" }).eq("id", b.id);
    await event(t, "Breakdown reported", asset ? `${asset.asset_no} · ${asset.make} ${asset.model}` : "Equipment", `${body.symptom}. ${diag.should_shutdown ? "Shutdown flagged. " : ""}${opts.length} recovery options ranked; top: ${opts[0]?.label}.`, { type: "breakdown", id: b.id });
    await notify(t, diag.should_shutdown ? "safety" : "breakdown", (diag.should_shutdown ? "SAFETY SHUTDOWN · " : "Breakdown · ") + (asset ? asset.asset_no : "equipment"), `${body.symptom} at ${body.site_addr || "jobsite"}. Recommended: ${opts[0]?.label} (~${opts[0]?.ttr_hours} h, ${fmt(opts[0]?.total)} incl. downtime).`, { type: "breakdown", id: b.id });
    await audit(t, actor, "equipment.failure_reported", "breakdown", b.id, null, { symptom: body.symptom, asset: asset?.asset_no });
    return json({ ...b, status: "options", diagnosis: diag, options: saved ?? [] });
  }
  const bd = path.match(/^\/breakdowns\/([0-9a-f-]{36})(?:\/(choose|approve|call-outcome|resolve))?$/);
  if (bd && !bd[2] && req.method === "GET") { const { data: b } = await sb.from("ss_breakdowns").select("*, asset:ss_equipment_assets(*), job:ss_jobs(name,scope,install_date)").eq("id", bd[1]).eq("tenant_id", t).maybeSingle(); if (!b) return json({ error: "not found" }, 404); const { data: o } = await sb.from("ss_recovery_options").select("*").eq("breakdown_id", b.id); const { data: ap } = await sb.from("ss_approvals").select("*").eq("ref_id", b.id); return json({ ...b, options: (o ?? []).sort((a: any, c: any) => num(c.score?.final) - num(a.score?.final)), approvals: ap ?? [] }); }
  if (bd && bd[2] === "choose" && req.method === "POST") {
    const { data: o } = await sb.from("ss_recovery_options").select("*").eq("id", body.option_id).eq("breakdown_id", bd[1]).maybeSingle(); if (!o) return json({ error: "option not found" }, 404);
    const limits = settings.approval || {}; const roleLimit = num(limits.roles?.[role], 0); const direct = num(o.cost?.direct); const needs = direct > roleLimit || direct > num(limits.per_txn, 1500);
    await sb.from("ss_recovery_options").update({ chosen: true }).eq("id", o.id); await sb.from("ss_recovery_options").update({ chosen: false }).eq("breakdown_id", bd[1]).neq("id", o.id);
    let approval = null; if (needs) { approval = (await sb.from("ss_approvals").insert({ tenant_id: t, kind: "recovery", ref_type: "breakdown", ref_id: bd[1], amount: direct, limit_applied: Math.min(roleLimit || Infinity, num(limits.per_txn, 1500)), reason: `${o.label} · ${role} limit ${fmt(roleLimit)}`, requested_by: actor }).select().single()).data; await notify(t, "approval", `Approval needed · ${fmt(direct)}`, `${o.label} for breakdown — ${role} limit is ${fmt(roleLimit)}.`, { type: "breakdown", id: bd[1] }); }
    await sb.from("ss_breakdowns").update({ status: needs ? "awaiting_approval" : "approved", chosen_option_id: o.id }).eq("id", bd[1]);
    await audit(t, actor, needs ? "purchase.approval_requested" : "equipment.recovery_approved", "breakdown", bd[1], null, { option: o.label, direct, role });
    return json({ chosen: o, requires_approval: needs, approval, next: needs ? "WAIT_FOR_APPROVAL" : o.method });
  }
  if (bd && bd[2] === "approve" && req.method === "POST") { const { data: ap } = await sb.from("ss_approvals").update({ status: body.decision === "reject" ? "rejected" : "approved", decided_by: actor, decision_note: body.note || "", decided_at: new Date().toISOString() }).eq("ref_id", bd[1]).eq("status", "requested").select(); await sb.from("ss_breakdowns").update({ status: body.decision === "reject" ? "options" : "approved" }).eq("id", bd[1]); await notify(t, "approval", body.decision === "reject" ? "Recovery option rejected" : "Recovery option approved", body.note || "", { type: "breakdown", id: bd[1] }); await audit(t, actor, "approval." + (body.decision === "reject" ? "rejected" : "approved"), "breakdown", bd[1], null, body); return json({ ok: true, approvals: ap }); }
  if (bd && bd[2] === "call-outcome" && req.method === "POST") { const outcome = { ...body.outcome, confirmed_by: actor, confirmed_at: new Date().toISOString() }; const patch: any = { call_outcome: outcome }; if (body.outcome?.quoted_price) { patch.price_status = STATUS.LIVE; patch.total = num(body.outcome.quoted_price) + num(body.outcome.downtime_cost, 0); } if (body.outcome?.available !== undefined) patch.availability_status = body.outcome.available ? STATUS.LIVE : STATUS.NA; const { data } = await sb.from("ss_recovery_options").update(patch).eq("id", body.option_id).select().single(); await sb.from("ss_breakdowns").update({ status: "in_recovery" }).eq("id", bd[1]); await event(t, "Provider confirmed", data?.vendor_name || "", `${outcome.confirmation || ""} ETA ${outcome.eta || "—"} · ${outcome.quoted_price ? fmt(outcome.quoted_price) : "no price"} · by ${actor}`, { type: "breakdown", id: bd[1] }); await notify(t, "reservation", `Confirmed · ${data?.label}`, `Conf# ${outcome.confirmation || "—"} · ETA ${outcome.eta || "—"} · ${outcome.quoted_price ? fmt(outcome.quoted_price) : "price pending"}`, { type: "breakdown", id: bd[1] }); await audit(t, actor, "reservation.confirmed", "recovery_option", body.option_id, null, outcome); return json(data); }
  if (bd && bd[2] === "resolve" && req.method === "POST") { const { data: b } = await sb.from("ss_breakdowns").update({ status: "resolved", actual_cost: num(body.actual_cost), actual_downtime_hours: num(body.actual_downtime_hours) }).eq("id", bd[1]).select().single(); if (b?.asset_id) { await sb.from("ss_equipment_assets").update({ status: "Available" }).eq("id", b.asset_id); await sb.from("ss_equipment_events").insert({ tenant_id: t, asset_id: b.asset_id, kind: "repair", body: `Resolved: ${body.note || ""} · ${num(body.actual_downtime_hours)} h down`, cost: num(body.actual_cost), ref_id: b.id }); } await notify(t, "breakdown", "Incident closed", `${fmt(body.actual_cost)} · ${body.actual_downtime_hours} h downtime`, { type: "breakdown", id: bd[1] }); await audit(t, actor, "equipment.incident_closed", "breakdown", bd[1], null, body); return json(b); }

  const jr = path.match(/^\/jobs\/([0-9a-f-]{36})\/(requirements|readiness|estimates)(\/generate)?$/);
  if (jr) { const { data: job } = await sb.from("ss_jobs").select("*").eq("id", jr[1]).eq("tenant_id", t).maybeSingle(); if (!job) return json({ error: "job not found" }, 404);
    if (jr[2] === "requirements" && jr[3] && req.method === "POST") { await sb.from("ss_job_requirements").delete().eq("job_id", job.id).eq("approved", false); const rows = await generateRequirements(t, job); const { data } = await sb.from("ss_job_requirements").insert(rows.map((r) => ({ tenant_id: t, job_id: job.id, ...r }))).select(); await event(t, "Requirements generated", job.name, `${rows.length} items · ${rows.filter((r) => FULFILLED.has(r.status)).length} on hand`, { type: "job", id: job.id }); await audit(t, actor, "job.requirements_generated", "job", job.id, null, { count: rows.length }); return json({ items: data ?? [], readiness: readiness(data ?? []) }); }
    if (jr[2] === "requirements") { const { data } = await sb.from("ss_job_requirements").select("*").eq("job_id", job.id).order("category").order("item"); return json({ items: data ?? [], readiness: readiness(data ?? []) }); }
    if (jr[2] === "readiness") { const { data } = await sb.from("ss_job_requirements").select("*").eq("job_id", job.id); const r = readiness(data ?? []); return json({ ...r, lists: { purchase: (data ?? []).filter((i: any) => i.status === "Needs Purchase").map((i: any) => i.item), rental: (data ?? []).filter((i: any) => i.status === "Needs Rental").map((i: any) => i.item), missing: (data ?? []).filter((i: any) => !FULFILLED.has(i.status)).map((i: any) => i.item) } }); }
    if (jr[2] === "estimates" && req.method === "GET") { const { data } = await sb.from("ss_estimate_versions").select("*").eq("job_id", job.id).order("version", { ascending: false }); return json(data ?? []); }
    if (jr[2] === "estimates" && req.method === "POST") { const { data: rates } = await sb.from("ss_labor_rates").select("*").eq("tenant_id", t).order("effective", { ascending: false }); const latest: Record<string, any> = {}; for (const r of rates ?? []) if (!latest[r.role]) latest[r.role] = r; const { data: reqs } = await sb.from("ss_job_requirements").select("allocated_asset_id").eq("job_id", job.id).not("allocated_asset_id", "is", null); const ids = (reqs ?? []).map((r: any) => r.allocated_asset_id); const { data: assets } = ids.length ? await sb.from("ss_equipment_assets").select("daily_cost").in("id", ids) : { data: [] }; const equipDaily = (assets ?? []).reduce((a: number, e: any) => a + num(e.daily_cost), 0) || 224; const bd2 = estimateBreakdown(job, Object.values(latest), equipDaily, { tier: body.tier, discount_pct: body.discount_pct }); const { data: prev } = await sb.from("ss_estimate_versions").select("version").eq("job_id", job.id).order("version", { ascending: false }).limit(1).maybeSingle(); const version = (prev?.version || 0) + 1; const display = body.labor_display || "included"; const customer_view = { option: bd2.tier, price: bd2.revenue, problem: job.scope, included: INCL[job.service_type] || INCL.drain, labor: display === "included" ? "Labor included in project price" : display === "hours" ? `${bd2.hours} crew hours` : display === "rate" ? `${bd2.hours} h at ${fmt(loaded(Object.values(latest)[0] || { wage: 26, burden_pct: 32, overhead_pct: 18, target_margin_pct: 40 }).customer_rate)}/h` : "Time & materials", duration: `${bd2.days} working day${bd2.days > 1 ? "s" : ""}`, warranty: settings.warranty || "1-year workmanship", payment: `${settings.deposit_pct ?? 30}% deposit to schedule, balance on completion`, expires: iso(addD(new Date(), 30)), exclusions: EXCL, assumptions: ASSUME, change_orders: "Written change order with price before extra work begins" }; const { data } = await sb.from("ss_estimate_versions").insert({ tenant_id: t, job_id: job.id, version, tier: bd2.tier, breakdown: bd2, inclusions: customer_view.included, exclusions: EXCL, assumptions: ASSUME, customer_view, created_by: actor, note: body.note || "" }).select().single(); await audit(t, actor, "estimate.version_created", "job", job.id, null, { version, tier: bd2.tier, margin: bd2.gross_margin_pct }); return json(data); }
  }

  // ---------- where do we actually drive? (multi-item shopping plan) ----------
  // Readiness already knows what is missing and search already prices each item at each supplier. This is the
  // step between them: the trip. Item-by-item cheapest routinely loses to a single stop once the crew's idle
  // time is priced, so all three plans are shown with the tradeoff rather than one silent winner.
  const sp = path.match(/^\/jobs\/([0-9a-f-]{36})\/shopping-plan$/);
  if (sp) {
    const { data: job } = await sb.from("ss_jobs").select("*").eq("id", sp[1]).eq("tenant_id", t).maybeSingle();
    if (!job) return json({ error: "job not found" }, 404);
    const { data: reqs } = await sb.from("ss_job_requirements").select("*").eq("job_id", job.id);
    const missing = (reqs ?? []).filter((i: any) => !FULFILLED.has(i.status) && i.status !== "Needs Rental");
    if (!missing.length) return json({ plans: [], recommended: null, unsourced: [], note: "Nothing to buy — every requirement is already sourced.", items: [] });

    const lat = num(body.lat ?? url.searchParams.get("lat"), SHOP.lat), lng = num(body.lng ?? url.searchParams.get("lng"), SHOP.lng);
    const names = missing.map((i: any) => i.item);

    // one search per item, in parallel; a provider that fails returns a CONNECTION_ERROR row and is dropped here
    const searches = await Promise.all(names.slice(0, 12).map(async (item: string) => {
      try { const r = await universalSearch(t, { q: item, lat, lng, radius_mi: num(body.radius_mi, 30) }); return { item, rows: (r as any).rows ?? [] }; }
      catch { return { item, rows: [] as any[] }; }
    }));

    const offers: Offer[] = [];
    for (const { item, rows } of searches) {
      const need = num(missing.find((m: any) => m.item === item)?.qty, 1);
      for (const r of rows as any[]) {
        if (r.kind === "error" || r.price == null) continue;
        if (([STATUS.NA, STATUS.ERR] as string[]).includes(r.evidence?.status)) continue;
        offers.push({
          item, vendor_id: r.vendor_id ?? null, vendor_name: r.vendor_name || r.title, addr: r.addr ?? null,
          phone: r.phone ?? null, url: r.url ?? null,
          unit_price: r.price, qty_needed: need,
          extended: Math.round(r.price * need * 100) / 100,
          available: r.available ?? null,
          availability_status: r.evidence?.status ?? STATUS.CALL,
          price_status: r.evidence?.status ?? STATUS.EST,
          evidence: r.evidence,
        });
      }
    }

    // real legs for vendors we have coordinates for; a calibrated estimate for everyone else
    const vids = [...new Set(offers.map((f) => f.vendor_id).filter(Boolean))] as string[];
    const { data: vrows } = vids.length ? await sb.from("ss_vendors").select("id,lat,lng").in("id", vids) : { data: [] as any[] };
    const coords = new Map((vrows ?? []).map((v: any) => [v.id, v]));
    const ordered = vids.map((id) => coords.get(id) ?? { lat: null, lng: null });
    const vlegs = await driveTimes({ lat, lng }, ordered.map((v: any) => ({ lat: v.lat ?? null, lng: v.lng ?? null })));
    const legs = new Map<string, { minutes: number; miles: number; status: string; caveat?: string }>();
    vids.forEach((id, i) => {
      const l = vlegs[i];
      legs.set(id, l && l.distance_mi > 0
        ? { minutes: l.minutes, miles: l.distance_mi, status: l.status, caveat: l.caveat }
        : { minutes: 25, miles: 12, status: STATUS.EST, caveat: "No coordinates for this supplier — 25 min placeholder, confirm before relying on it." });
    });

    const out = buildPlans(names, offers, {
      crew_cost_per_hour: num(settings.crew_cost_per_hour, 135),
      stop_minutes: num(settings.stop_minutes, 18),
      legs,
    });
    return json({ ...out, job: { id: job.id, name: job.name }, items: names, offers_considered: offers.length, searched_at: new Date().toISOString() });
  }

  // ---------- notifications: acknowledge, and climb what nobody acknowledged ----------
  if (path === "/notifications/escalate") return json(await runEscalation(t, settings));
  if (path === "/notifications/routing" && req.method === "GET") {
    const kind = url.searchParams.get("kind") || "breakdown.filed";
    return json({ kind, now: notifyRoute(kind, new Date(), settings), prefs: prefsFor(settings) });
  }
  const nack = path.match(/^\/notifications\/([0-9a-f-]{36})\/ack$/);
  if (nack && req.method === "POST") {
    const { data } = await sb.from("ss_notifications").update({ ack_at: new Date().toISOString(), ack_by: actor, read: true }).eq("id", nack[1]).eq("tenant_id", t).select().maybeSingle();
    if (!data) return json({ error: "not found" }, 404);
    await audit(t, actor, "notification.ack", "notification", nack[1], null, { title: data.title });
    return json(data);
  }

  const rq = path.match(/^\/requirements\/([0-9a-f-]{36})$/);
  if (rq && req.method === "POST") { const { data: before } = await sb.from("ss_job_requirements").select("*").eq("id", rq[1]).maybeSingle(); if (!before) return json({ error: "not found" }, 404); const patch: any = {}; for (const k of ["status", "qty", "approved", "notes", "critical", "allocated_asset_id"]) if (body[k] !== undefined) patch[k] = body[k]; if (body.status) { patch.verified_by = actor; patch.verified_at = new Date().toISOString(); } if (patch.allocated_asset_id) { const { data: clash } = await sb.from("ss_job_requirements").select("job_id").eq("allocated_asset_id", patch.allocated_asset_id).neq("job_id", before.job_id); if (clash?.length) return json({ error: "asset already allocated to another job" }, 409); } const { data } = await sb.from("ss_job_requirements").update(patch).eq("id", rq[1]).select().single(); await audit(t, actor, "job.requirement_updated", "requirement", rq[1], { status: before.status }, patch); const { data: all } = await sb.from("ss_job_requirements").select("*").eq("job_id", before.job_id); const r = readiness(all ?? []); if (r.state === "green" && !FULFILLED.has(before.status) && FULFILLED.has(patch.status)) await notify(t, "readiness", "Job ready for departure", `${r.ok}/${r.total} items verified`, { type: "job", id: before.job_id }); return json({ item: data, readiness: r }); }

  // A crew departing a job that is not "green" over a manager's stated reason. Previously the front end called a
  // route that did not exist and swallowed the 404, so the toast said "allowed by exception" while nothing was
  // ever recorded anywhere - no audit row, no approval, nothing a real manager could be held to later. Every
  // other override in this app leaves a trail (ss_audit at minimum); this one now does too, in ss_approvals,
  // the table the app already reads for /approvals.
  const rqx = path.match(/^\/jobs\/([0-9a-f-]{36})\/readiness\/exception$/);
  if (rqx && req.method === "POST") {
    if (!body.reason || !String(body.reason).trim()) return json({ error: "reason required" }, 400);
    const { data: job } = await sb.from("ss_jobs").select("id,name,scope").eq("id", rqx[1]).eq("tenant_id", t).maybeSingle();
    if (!job) return json({ error: "not found" }, 404);
    const { data: all } = await sb.from("ss_job_requirements").select("*").eq("job_id", job.id);
    const r = readiness(all ?? []);
    const now = new Date().toISOString();
    const { data: appr } = await sb.from("ss_approvals").insert({ tenant_id: t, kind: "departure_exception", ref_type: "job", ref_id: job.id, reason: body.reason, status: "approved", requested_by: actor, decided_by: actor, decided_at: now }).select().single();
    await audit(t, actor, "job.departure_exception", "job", job.id, { readiness_state: r.state, critical_missing: r.critical_missing }, { reason: body.reason });
    await notify(t, "readiness", "Departed by manager exception", `${job.name} · ${r.ok}/${r.total} verified (${r.critical_missing.length} critical open) · ${actor}: ${body.reason}`, { type: "job", id: job.id });
    return json({ approval: appr, readiness: r });
  }

  if (path === "/pricing/labor" && req.method === "GET") { const { data } = await sb.from("ss_labor_rates").select("*").eq("tenant_id", t).order("role").order("effective", { ascending: false }); return json((data ?? []).map((r: any) => ({ ...r, computed: loaded(r) }))); }
  if (path === "/pricing/labor" && req.method === "POST") { const { data: prev } = await sb.from("ss_labor_rates").select("*").eq("tenant_id", t).eq("role", body.role).order("effective", { ascending: false }).limit(1).maybeSingle(); if (!body.reason) return json({ error: "reason required" }, 400); const { data } = await sb.from("ss_labor_rates").insert({ tenant_id: t, role: body.role, wage: num(body.wage, prev?.wage), burden_pct: num(body.burden_pct, prev?.burden_pct ?? 32), overhead_pct: num(body.overhead_pct, prev?.overhead_pct ?? 18), target_margin_pct: num(body.target_margin_pct, prev?.target_margin_pct ?? 40), effective: body.effective || iso(new Date()), changed_by: actor, reason: body.reason, previous: prev ? { wage: prev.wage, burden_pct: prev.burden_pct, overhead_pct: prev.overhead_pct, target_margin_pct: prev.target_margin_pct } : null }).select().single(); await audit(t, actor, "estimate.rate_changed", "labor_rate", data.id, prev, data); return json({ ...data, computed: loaded(data) }); }
  if (path === "/approvals" && req.method === "GET") { const { data } = await sb.from("ss_approvals").select("*").eq("tenant_id", t).order("created_at", { ascending: false }); return json(data ?? []); }
  if (path === "/audit" && req.method === "GET") { const { data } = await sb.from("ss_audit").select("*").eq("tenant_id", t).order("created_at", { ascending: false }).limit(50); return json(data ?? []); }
  if (path === "/inventory" && req.method === "GET") { const { data } = await sb.from("ss_inventory_items").select("*").eq("tenant_id", t).order("category").order("name"); return json(data ?? []); }
  return null;
}
