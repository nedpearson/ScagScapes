// ---------- multi-item shopping plans: one-stop vs cheapest vs fastest ----------
//
// The readiness screen already produces a list of missing items and the search already prices each one at each
// supplier. What was missing is the decision the crew lead actually makes at 6:40am: *where do I drive?*
//
// Item-by-item cheapest is the wrong answer often enough to matter. A $40 saving at a second store costs a
// 22-minute detour, and a four-man crew idle for 22 minutes is $49 at the tenant's own crew rate. The optimizer
// therefore prices the trip, not the basket: drive time, stop overhead, crew cost of the delay, and the risk
// that a store that is merely "posted" as in stock is not.
//
// Three plans, always, with the tradeoff shown — never one silent recommendation:
//   ONE_STOP   fewest stops that can cover the list (a partial one-stop is reported as partial, not hidden)
//   LOWEST     lowest total landed cost including the drive
//   FASTEST    earliest the truck can be loaded and moving
//
// Nothing here invents an offer. It ranks the offers search returned, and an item no supplier could price comes
// back as `unsourced` so the list is never quietly shortened.
import { STATUS } from "./core.ts";

export type Offer = {
  item: string;                      // the requirement this satisfies
  vendor_id: string | null;
  vendor_name: string;
  addr?: string | null;
  lat?: number | null;
  lng?: number | null;
  phone?: string | null;
  url?: string | null;
  unit_price: number | null;
  qty_needed: number;
  pack?: number | null;              // supplier pack size, if it forces over-buying
  extended: number | null;           // what this line actually costs at this supplier
  available: number | null;          // null = unknown, not zero
  availability_status: string;       // LIVE_VERIFIED / PROVIDER_POSTED / CALL_TO_CONFIRM / ...
  price_status: string;
  substitute?: boolean;              // true when this is an approved alternative, not the exact item
  delivery?: { available: boolean; fee: number; earliest?: string | null } | null;
  evidence?: any;
};

export type Stop = {
  vendor_id: string | null;
  vendor_name: string;
  addr?: string | null;
  phone?: string | null;
  url?: string | null;
  items: { item: string; qty: number; unit_price: number | null; extended: number | null; substitute: boolean; availability_status: string; confidence: "verified" | "posted" | "call" }[];
  subtotal: number;
  drive_minutes: number;
  drive_mi: number;
  drive_status: string;
  drive_caveat?: string;
};

export type Plan = {
  id: "ONE_STOP" | "LOWEST" | "FASTEST";
  label: string;
  stops: Stop[];
  goods: number;                 // what the materials cost
  drive_minutes: number;
  stop_overhead_minutes: number;
  crew_delay_cost: number;       // what the trip costs in idle crew
  total_landed: number;          // goods + crew delay  (the number to compare plans on)
  covered: number;               // items this plan can actually source
  total_items: number;
  partial: boolean;
  unsourced: string[];
  confidence: "verified" | "posted" | "call";   // weakest link in the plan
  why: string;
  tradeoff: string;
};

const CONF_ORDER = { verified: 3, posted: 2, call: 1 } as const;
const confOf = (s: string): "verified" | "posted" | "call" =>
  s === STATUS.LIVE ? "verified" : s === STATUS.POSTED ? "posted" : "call";
const weakest = (cs: ("verified" | "posted" | "call")[]) =>
  cs.length ? cs.reduce((a, b) => (CONF_ORDER[a] <= CONF_ORDER[b] ? a : b)) : "call";

export type PlanOpts = {
  crew_cost_per_hour: number;    // tenant setting — the real cost of the crew standing still
  crew_size?: number;
  stop_minutes?: number;         // park, counter, load, leave
  legs: Map<string, { minutes: number; miles: number; status: string; caveat?: string }>;  // vendor_id → leg from the yard
  return_leg?: boolean;          // count the drive back to the job
};

const money = (n: number) => Math.round(n * 100) / 100;

/** Cost of a route through a set of stops: out, between, and optionally back. Legs are yard→vendor, so
 *  vendor→vendor is approximated as the larger of the two yard legs — honest, and stated as such in `why`. */
function routeMinutes(stops: { vendor_id: string | null }[], o: PlanOpts) {
  const leg = (id: string | null) => (id && o.legs.get(id)) || { minutes: 0, miles: 0, status: STATUS.EST };
  if (!stops.length) return { minutes: 0, miles: 0 };
  let minutes = 0, mi = 0;
  const ls = stops.map((s) => leg(s.vendor_id));
  minutes += ls[0].minutes; mi += ls[0].miles;
  for (let i = 1; i < ls.length; i++) { minutes += Math.max(ls[i].minutes, ls[i - 1].minutes) * 0.6; mi += Math.max(ls[i].miles, ls[i - 1].miles) * 0.6; }
  if (o.return_leg !== false) { minutes += ls[ls.length - 1].minutes; mi += ls[ls.length - 1].miles; }
  return { minutes: Math.round(minutes), miles: Math.round(mi * 10) / 10 };
}

function assemble(id: Plan["id"], label: string, chosen: Map<string, Offer>, allItems: string[], o: PlanOpts, why: string): Plan {
  const byVendor = new Map<string, Offer[]>();
  for (const off of chosen.values()) {
    const k = off.vendor_id ?? off.vendor_name;
    byVendor.set(k, [...(byVendor.get(k) ?? []), off]);
  }
  const stops: Stop[] = [...byVendor.values()].map((offs) => {
    const leg = (offs[0].vendor_id && o.legs.get(offs[0].vendor_id)) || { minutes: 0, miles: 0, status: STATUS.EST, caveat: undefined as string | undefined };
    return {
      vendor_id: offs[0].vendor_id, vendor_name: offs[0].vendor_name, addr: offs[0].addr, phone: offs[0].phone, url: offs[0].url,
      items: offs.map((f) => ({ item: f.item, qty: f.qty_needed, unit_price: f.unit_price, extended: f.extended, substitute: !!f.substitute, availability_status: f.availability_status, confidence: confOf(f.availability_status) })),
      subtotal: money(offs.reduce((a, f) => a + (f.extended ?? 0), 0)),
      drive_minutes: leg.minutes, drive_mi: leg.miles, drive_status: leg.status, drive_caveat: leg.caveat,
    };
  });

  const route = routeMinutes(stops, o);
  const stopOverhead = stops.length * (o.stop_minutes ?? 18);
  const crewHours = (route.minutes + stopOverhead) / 60;
  const crewDelay = Math.round(crewHours * o.crew_cost_per_hour);
  const goods = money(stops.reduce((a, s) => a + s.subtotal, 0));
  const unsourced = allItems.filter((i) => !chosen.has(i));

  return {
    id, label, stops, goods,
    drive_minutes: route.minutes, stop_overhead_minutes: stopOverhead,
    crew_delay_cost: crewDelay,
    total_landed: money(goods + crewDelay),
    covered: chosen.size, total_items: allItems.length,
    partial: unsourced.length > 0, unsourced,
    confidence: weakest(stops.flatMap((s) => s.items.map((i) => i.confidence))),
    why, tradeoff: "",
  };
}

/**
 * Build the three plans from the offers search returned.
 * `items` is the ordered list of missing requirement names, so an item nobody could price is still reported.
 */
export function buildPlans(items: string[], offers: Offer[], o: PlanOpts): { plans: Plan[]; recommended: Plan["id"]; unsourced: string[]; note: string } {
  const priced = offers.filter((f) => f.extended != null && f.extended >= 0);
  const forItem = (i: string) => priced.filter((f) => f.item === i);
  const inStock = (f: Offer) => f.available == null || f.available >= f.qty_needed;

  // ---- LOWEST: cheapest supplier per item, wherever it is ----
  const lowest = new Map<string, Offer>();
  for (const i of items) {
    const c = forItem(i).filter(inStock).sort((a, b) => (a.extended! - b.extended!) || CONF_ORDER[confOf(b.availability_status)] - CONF_ORDER[confOf(a.availability_status)])[0];
    if (c) lowest.set(i, c);
  }

  // ---- ONE_STOP: the single vendor covering the most items, then fill the remainder cheaply ----
  const coverage = new Map<string, number>();
  for (const f of priced.filter(inStock)) {
    const k = f.vendor_id ?? f.vendor_name;
    if (!coverage.has(k)) coverage.set(k, 0);
    coverage.set(k, coverage.get(k)! + 1);
  }
  const best = [...coverage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const oneStop = new Map<string, Offer>();
  if (best) {
    for (const i of items) {
      const here = forItem(i).filter(inStock).filter((f) => (f.vendor_id ?? f.vendor_name) === best).sort((a, b) => a.extended! - b.extended!)[0];
      if (here) oneStop.set(i, here);
    }
    // a true one-stop may not cover everything; fill the rest rather than pretending it did
    for (const i of items) if (!oneStop.has(i) && lowest.has(i)) oneStop.set(i, lowest.get(i)!);
  }

  // ---- FASTEST: prefer verified stock and the nearest stops, cost second ----
  const fastest = new Map<string, Offer>();
  for (const i of items) {
    const c = forItem(i).filter(inStock).sort((a, b) => {
      const ca = CONF_ORDER[confOf(a.availability_status)], cb = CONF_ORDER[confOf(b.availability_status)];
      if (ca !== cb) return cb - ca;                                   // verified stock first
      const la = (a.vendor_id ? o.legs.get(a.vendor_id)?.minutes : undefined) ?? 999;
      const lb = (b.vendor_id ? o.legs.get(b.vendor_id)?.minutes : undefined) ?? 999;
      if (la !== lb) return la - lb;                                   // then nearest
      return a.extended! - b.extended!;
    })[0];
    if (c) fastest.set(i, c);
  }
  // collapse fastest onto vendors it is already visiting — a second item at a stop you are making is free
  const visiting = new Set([...fastest.values()].map((f) => f.vendor_id ?? f.vendor_name));
  for (const i of items) {
    const cur = fastest.get(i); if (!cur) continue;
    const here = forItem(i).filter(inStock).filter((f) => visiting.has(f.vendor_id ?? f.vendor_name) && confOf(f.availability_status) === confOf(cur.availability_status));
    const cheapestHere = here.sort((a, b) => a.extended! - b.extended!)[0];
    if (cheapestHere) fastest.set(i, cheapestHere);
  }

  const plans = [
    assemble("ONE_STOP", "One stop", oneStop, items, o, best ? `${[...oneStop.values()].filter((f) => (f.vendor_id ?? f.vendor_name) === best).length} of ${items.length} items at a single supplier; the rest added only because that supplier cannot cover them.` : "No supplier could price more than one item."),
    assemble("LOWEST", "Lowest total cost", lowest, items, o, "Cheapest priced supplier for each item, then the drive between them costed at the crew rate."),
    assemble("FASTEST", "Fastest to loaded", fastest, items, o, "Verified stock first, then nearest supplier — cost only breaks ties."),
  ].filter((p) => p.stops.length);

  // de-duplicate identical plans so the crew is not shown the same trip three times
  const seen = new Set<string>();
  const unique = plans.filter((p) => {
    const sig = p.stops.map((s) => s.vendor_name + ":" + s.items.map((i) => i.item).sort().join("|")).sort().join("//");
    if (seen.has(sig)) return false; seen.add(sig); return true;
  });

  // recommend on landed cost, but never recommend a plan that covers less of the list than another
  const maxCover = Math.max(0, ...unique.map((p) => p.covered));
  const eligible = unique.filter((p) => p.covered === maxCover);
  const rec = eligible.sort((a, b) => a.total_landed - b.total_landed || a.drive_minutes - b.drive_minutes)[0];

  const cheapestGoods = Math.min(...unique.map((p) => p.goods));
  for (const p of unique) {
    const dGoods = money(p.goods - cheapestGoods);
    const dTime = p.drive_minutes + p.stop_overhead_minutes;
    p.tradeoff = dGoods > 0
      ? `$${dGoods.toFixed(2)} more in materials, ${dTime} min of crew time, ${p.stops.length} stop${p.stops.length > 1 ? "s" : ""}.`
      : `Cheapest materials on the board; ${dTime} min of crew time across ${p.stops.length} stop${p.stops.length > 1 ? "s" : ""}.`;
    if (p.id === rec?.id) p.tradeoff += " Recommended on total landed cost.";
  }

  const allUnsourced = items.filter((i) => !priced.some((f) => f.item === i));
  return {
    plans: unique,
    recommended: rec?.id ?? "LOWEST",
    unsourced: allUnsourced,
    note: [
      "Landed cost = materials + crew time (drive + stops) at the tenant's own crew rate. It is not a quote.",
      allUnsourced.length ? `${allUnsourced.length} item(s) no supplier could price — call, or mark a substitute.` : null,
      "Stop-to-stop legs are approximated from each vendor's leg from the yard; only the first and last legs are routed.",
    ].filter(Boolean).join(" "),
  };
}
