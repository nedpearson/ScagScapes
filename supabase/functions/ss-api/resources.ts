// ---------- resources: provider-adapter interface · universal search · vendor performance · rental lifecycle · breakdown media · push · market rates ----------
// Every result carries a source-evidence block (status, source, checked_at, method, confidence, human_confirmed …). No adapter fabricates a
// price or an availability: a provider without a supported API returns CALL_TO_CONFIRM plus a deep link and a call package.
import { sb, json, fmt, event, send, dLabel, iso, addD, STATUS, pushAll } from "./core.ts";
import { miles, hdRental, rentalTotal, rokrunner } from "./sourcing.ts";

const SHOP = { lat: 30.4515, lng: -91.1871 };
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const UA = "ScagScapesCommand/1.4 (nedpearson@gmail.com)";
async function fetchT(url: string, opts: RequestInit = {}, ms = 8000) { const c = new AbortController(); const id = setTimeout(() => c.abort(), ms); try { return await fetch(url, { ...opts, signal: c.signal, headers: { "user-agent": UA, ...(opts.headers || {}) } }); } finally { clearTimeout(id); } }

// ---- evidence ----
export type Evidence = { status: string; source: string; url?: string | null; checked_at: string | null; method: string; location?: string | null; price_type: string; availability_type: string; expires_at?: string | null; confidence: number; human_confirmed: boolean; confirmed_by?: string | null; notes?: string | null; ref_no?: string | null };
export function evidence(p: Partial<Evidence> & { status: string; source: string; method: string }): Evidence {
  const ttl = p.status === STATUS.LIVE ? 4 : p.status === STATUS.POSTED ? 24 : 24 * 30;
  return { url: null, checked_at: new Date().toISOString(), location: null, price_type: "none", availability_type: "none", expires_at: p.checked_at ? new Date(new Date(p.checked_at).getTime() + ttl * 3600e3).toISOString() : new Date(Date.now() + ttl * 3600e3).toISOString(), confidence: .5, human_confirmed: false, confirmed_by: null, notes: null, ref_no: null, ...p };
}
export function staleness(e: Evidence): string { if (e.status === STATUS.ERR || e.status === STATUS.NA) return e.status; if (e.expires_at && new Date(e.expires_at).getTime() < Date.now()) return STATUS.STALE; return e.status; }

// ---- open-now from a hours string like "Mon-Fri 7am-5pm, Sat 8am-12pm" (null when unparseable) ----
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function openNow(hours: string | null | undefined, at = new Date()): boolean | null {
  if (!hours) return null; const h = hours.toLowerCase(); if (/24\s*\/\s*7|24 hours/.test(h)) return true;
  const ct = new Date(at.getTime() - 5 * 3600e3); const d = ct.getUTCDay(); const mins = ct.getUTCHours() * 60 + ct.getUTCMinutes(); // America/Chicago (CDT) approximation
  const toMin = (s: string) => { const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/); if (!m) return null; let hh = Number(m[1]); const mm = Number(m[2] || 0); if (m[3] === "pm" && hh < 12) hh += 12; if (m[3] === "am" && hh === 12) hh = 0; return hh * 60 + mm; };
  let any = false;
  for (const seg of h.split(/[,;]/)) {
    const dm = seg.match(/(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|–|to)?\s*(sun|mon|tue|wed|thu|fri|sat)?/); const tm = seg.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/);
    if (!dm || !tm) continue; any = true; const a = DOW.indexOf(dm[1]), b = dm[2] ? DOW.indexOf(dm[2]) : a; const days: number[] = []; for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (i === b) break; }
    const o = toMin(tm[1]), c = toMin(tm[2]); if (o === null || c === null) continue; if (days.includes(d) && mins >= o && mins < c) return true;
  }
  return any ? false : null;
}

// ---- provider adapter interface ----
export type Ctx = { t: string; lat: number; lng: number; days: number; radius: number; q: string; words: string[] };
export type Result = { kind: string; title: string; subtitle?: string; vendor_id?: string | null; vendor_name?: string; phone?: string | null; addr?: string | null; url?: string | null; distance_mi?: number | null; open_now?: boolean | null; hours?: string | null; price?: number | null; unit?: string | null; total?: number | null; available?: number | null; method: "RESERVE_ONLINE" | "BOOK_APPOINTMENT" | "CALL_NOW" | "DEEP_LINK" | "INTERNAL"; evidence: Evidence; provider: string; ref?: { type: string; id: string } | null; score?: number };
export interface Provider {
  id: string; name: string; kinds: string[];
  caps: { search: boolean; availability: boolean; quote: boolean; hold: boolean; reserve: boolean; book: boolean; deeplink: boolean; call: boolean };
  search(ctx: Ctx): Promise<Result[]>;
  createReservation?(t: string, body: any): Promise<{ supported: boolean; fallback?: string; how?: string; reservation?: any }>;
  createDeepLink?(r: Result): string | null;
  getCallInstructions?(r: Result): { number: string | null; script: string; ask: string[] };
}
const has = (ctx: Ctx, s: string) => { const x = (s || "").toLowerCase(); return ctx.words.some((w) => x.includes(w)); };
const callPkg = (r: Result) => ({ number: r.phone ?? null, script: `Hello, this is Scag Scapes. We need ${r.title} near ${r.addr || "Baton Rouge"}. Can you confirm availability, price, earliest pickup or delivery, deposit, and whether an appointment is required?`, ask: ["Available today? quantity", "Price + fees (delivery, damage waiver, environmental)", "Deposit / card hold", "Earliest pickup or delivery window", "Cancellation deadline", "Confirmation number"] });

const internal: Provider = {
  id: "internal", name: "Scag Scapes (internal)", kinds: ["equipment", "inventory", "vendor", "history"], caps: { search: true, availability: true, quote: false, hold: true, reserve: true, book: false, deeplink: false, call: false },
  async search(ctx) {
    const out: Result[] = []; const now = new Date().toISOString();
    const [eq, inv, res] = await Promise.all([sb.from("ss_equipment_assets").select("*").eq("tenant_id", ctx.t), sb.from("ss_inventory_items").select("*").eq("tenant_id", ctx.t), sb.from("ss_reservations").select("*, vendor:ss_vendors(name,phone)").eq("tenant_id", ctx.t).order("created_at", { ascending: false }).limit(50)]);
    for (const e of eq.data ?? []) if (has(ctx, `${e.asset_no} ${e.category} ${e.make} ${e.model} ${e.serial || ""}`)) out.push({ kind: "equipment", title: `${e.asset_no} · ${e.make} ${e.model}`, subtitle: `${e.category} · ${e.status}${e.crew ? " · " + e.crew : ""}`, vendor_name: "Yard", distance_mi: miles(ctx.lat, ctx.lng, SHOP.lat, SHOP.lng), available: e.status === "Available" ? 1 : 0, method: "INTERNAL", provider: "internal", ref: { type: "asset", id: e.id }, evidence: evidence({ status: STATUS.LIVE, source: "ss_equipment_assets", method: "internal record", checked_at: now, availability_type: "status", confidence: .95, human_confirmed: true, notes: e.status }) });
    for (const i of inv.data ?? []) if (has(ctx, `${i.name} ${i.category} ${i.sku || ""}`)) out.push({ kind: "inventory", title: i.name, subtitle: `${i.qty} ${i.unit} at ${i.location}`, vendor_name: i.location, distance_mi: miles(ctx.lat, ctx.lng, SHOP.lat, SHOP.lng), available: num(i.qty), price: i.unit_cost ?? null, unit: i.unit, method: "INTERNAL", provider: "internal", ref: { type: "inventory", id: i.id }, evidence: evidence({ status: STATUS.LIVE, source: "ss_inventory_items", method: "internal count", checked_at: i.updated_at || now, price_type: "internal cost", availability_type: "on hand", confidence: .9, human_confirmed: true }) });
    for (const r of res.data ?? []) if (has(ctx, `${r.item} ${r.brand}`)) out.push({ kind: "history", title: `Previous rental · ${r.item}`, subtitle: `${r.vendor?.name ?? r.brand} · ${dLabel(r.start_date)} · ${r.status} · est ${fmt(r.est_total)}`, vendor_id: r.vendor_id, vendor_name: r.vendor?.name ?? r.brand, phone: r.vendor?.phone, price: r.est_total, unit: `${r.days} d`, method: "CALL_NOW", provider: "internal", ref: { type: "reservation", id: r.id }, evidence: evidence({ status: STATUS.EST, source: "ss_reservations", method: "prior transaction", checked_at: r.created_at, price_type: "historical", confidence: .6, human_confirmed: r.status === "confirmed", ref_no: r.confirmation }) });
    return out;
  },
};
const vendorsDir: Provider = {
  id: "vendors", name: "Approved vendor directory", kinds: ["repair", "mobile_repair", "hose", "dealer", "tire", "transport", "rental", "materials", "small_engine"], caps: { search: true, availability: false, quote: false, hold: false, reserve: false, book: true, deeplink: true, call: true },
  async search(ctx) {
    const { data } = await sb.from("ss_vendors").select("*").neq("kind", "fuel"); const out: Result[] = [];
    const kindWords: Record<string, string[]> = { hose: ["hose", "hydraulic"], mobile_repair: ["mobile", "mechanic", "repair", "breakdown", "fix"], repair: ["repair", "mechanic", "shop", "service"], dealer: ["dealer", "parts", "warranty", "kubota", "bobcat", "cat", "deere", "takeuchi", "scag"], tire: ["tire", "flat", "battery"], transport: ["tow", "haul", "transport", "trailer"], rental: ["rent", "rental", "excavator", "skid", "trencher", "compactor", "lift"], materials: ["pvc", "pipe", "basin", "gravel", "sand", "sod", "paver", "fabric", "fitting", "supply", "store"], small_engine: ["mower", "blower", "trimmer", "small engine"] };
    for (const v of data ?? []) { const d = v.lat ? miles(ctx.lat, ctx.lng, v.lat, v.lng) : null; if (d !== null && d > ctx.radius) continue; const kw = kindWords[v.kind] || []; const hit = has(ctx, `${v.name} ${v.brand} ${v.kind} ${(v.meta?.services || []).join(" ")} ${(v.meta?.brands || []).join(" ")}`) || ctx.words.some((w) => kw.includes(w)); if (!hit) continue;
      out.push({ kind: v.kind, title: v.name, subtitle: `${v.kind.replace("_", " ")}${v.meta?.after_hours ? " · 24/7" : ""}${v.hours ? " · " + v.hours : ""}`, vendor_id: v.id, vendor_name: v.name, phone: v.phone, addr: v.addr, url: v.meta?.booking_url || v.meta?.url, distance_mi: d, open_now: v.meta?.after_hours ? true : openNow(v.hours), hours: v.hours, method: v.meta?.book === "online" ? "BOOK_APPOINTMENT" : "CALL_NOW", provider: "vendors", ref: { type: "vendor", id: v.id }, evidence: evidence({ status: STATUS.CALL, source: v.source || "provider website", url: v.meta?.url, method: "directory entry verified on " + (v.meta?.verified || "—"), checked_at: v.meta?.verified ? v.meta.verified + "T12:00:00Z" : v.created_at, location: v.addr, availability_type: "call", confidence: .5, notes: "no inventory or appointment API — call to confirm" }) }); }
    return out;
  },
  getCallInstructions: callPkg, createDeepLink: (r) => r.url ?? null,
};
const homeDepot: Provider = {
  id: "homedepot", name: "Home Depot Tool Rental", kinds: ["rental"], caps: { search: true, availability: true, quote: true, hold: false, reserve: false, book: false, deeplink: true, call: true },
  async search(ctx) {
    if (!ctx.words.some((w) => ["rent", "rental", "excavator", "skid", "loader", "trencher", "compactor", "sod", "trailer", "auger", "lift", "generator", "pump", "saw"].includes(w))) return [];
    const { data: cards } = await sb.from("ss_rate_cards").select("*").eq("brand", "Home Depot"); const { data: vs } = await sb.from("ss_vendors").select("*").eq("brand", "Home Depot").eq("kind", "rental"); const out: Result[] = []; const cache: Record<string, any> = {};
    for (const c of (cards ?? []).filter((c: any) => has(ctx, `${c.item} ${c.category} ${c.model || ""}`))) { let live: any = {}; let err = false; if (c.ext_cat) { const k = c.ext_cat + "/" + c.ext_sub; try { cache[k] = cache[k] || await hdRental(c.ext_cat, c.ext_sub); live = cache[k]; } catch { err = true; } }
      for (const v of vs ?? []) { const l = live[v.ext_id]; const rc = l?.day ? l : c; const d = miles(ctx.lat, ctx.lng, v.lat, v.lng); if (d > ctx.radius) continue; const st = err ? STATUS.ERR : l?.day ? (l.available > 0 ? STATUS.POSTED : STATUS.NA) : STATUS.STALE;
        out.push({ kind: "rental", title: `Rent ${c.item}${c.model ? " (" + c.model + ")" : ""}`, subtitle: v.name, vendor_id: v.id, vendor_name: v.name, phone: v.phone, addr: v.addr, url: v.meta?.url, distance_mi: d, open_now: openNow(v.hours), hours: v.hours, price: rc.day, unit: "day", total: rentalTotal(rc, ctx.days), available: l?.available ?? null, method: l?.day && l.available > 0 ? "DEEP_LINK" : "CALL_NOW", provider: "homedepot", ref: { type: "rate_card", id: c.id }, evidence: evidence({ status: st, source: "Home Depot rental inventory/pricing endpoint (undocumented, unauthenticated)", url: v.meta?.url, method: l?.day ? "provider endpoint read" : "rate card (dated)", checked_at: l?.day ? new Date().toISOString() : c.checked_at, location: v.name, price_type: l?.day ? "provider posted" : "estimated", availability_type: l?.day ? "on-hand count" : "unknown", confidence: l?.day ? (l.available > 0 ? .8 : .2) : .4, notes: "Reservation is completed on homedepot.com (no reservation API). Store on-hand count is not a hold." }) }); } }
    return out;
  },
  createDeepLink: (r) => r.url ?? null, getCallInstructions: callPkg,
  async createReservation() { return { supported: false, fallback: "DEEP_LINK", how: "Home Depot exposes no reservation API. Reserve on homedepot.com/rental (deep link) or call the store; record the confirmation number here." }; },
};
const chains: Provider = {
  id: "chains", name: "Sunbelt · United · Herc (quote request)", kinds: ["rental"], caps: { search: true, availability: false, quote: true, hold: false, reserve: false, book: false, deeplink: true, call: true },
  async search(ctx) {
    if (!ctx.words.some((w) => ["rent", "rental", "excavator", "skid", "loader", "trencher", "compactor", "sod", "trailer", "auger", "lift", "generator", "pump"].includes(w))) return [];
    const { data: cards } = await sb.from("ss_rate_cards").select("*").neq("brand", "Home Depot"); const { data: vs } = await sb.from("ss_vendors").select("*").eq("kind", "rental").neq("brand", "Home Depot"); const out: Result[] = [];
    for (const c of (cards ?? []).filter((c: any) => has(ctx, `${c.item} ${c.category} ${c.model || ""}`))) for (const v of (vs ?? []).filter((v: any) => v.brand === c.brand)) { const d = miles(ctx.lat, ctx.lng, v.lat, v.lng); if (d > ctx.radius) continue;
      out.push({ kind: "rental", title: `Rent ${c.item}`, subtitle: v.name, vendor_id: v.id, vendor_name: v.name, phone: v.phone, addr: v.addr, url: v.meta?.url, distance_mi: d, open_now: openNow(v.hours), hours: v.hours, price: c.day, unit: "day", total: rentalTotal(c, ctx.days), available: null, method: "CALL_NOW", provider: "chains", ref: { type: "rate_card", id: c.id }, evidence: evidence({ status: STATUS.CALL, source: c.source_url || "branch rate card", url: c.source_url, method: "dated rate card", checked_at: c.checked_at, location: v.name, price_type: c.verified ? "provider posted (dated)" : "estimated", availability_type: "call", confidence: c.verified ? .5 : .35, notes: "No public availability API — Request quote texts the branch; price confirmed on reply." }) }); }
    return out;
  },
  getCallInstructions: callPkg, createDeepLink: (r) => r.url ?? null,
  async createReservation(t, body) { const { data: v } = await sb.from("ss_vendors").select("*").eq("id", body.vendor_id).maybeSingle(); if (!v) return { supported: false, fallback: "CALL_NOW" }; const { data: r } = await sb.from("ss_reservations").insert({ tenant_id: t, vendor_id: v.id, job_id: body.job_id || null, brand: v.brand, item: body.item, start_date: body.start_date || iso(new Date()), days: num(body.days, 1), qty: num(body.qty, 1), est_total: num(body.est_total), contact: body.contact || "Charlie · (225) 241-3069", notes: body.notes || "", status: "requested", history: [{ at: new Date().toISOString(), by: body.actor || "app", action: "quote requested" }] }).select().single(); const st = await send(t, "sms", v.phone, `Scag Scapes LLC requesting ${body.qty || 1}× ${body.item}, ${dLabel(r.start_date)} · ${r.days} day(s). Reply with availability, rate and fees.`, { type: "reservation", id: r.id }); return { supported: false, fallback: "QUOTE_REQUEST", how: `Quote request ${st === "sent" ? "texted" : "logged (simulated — no Twilio key)"} to ${v.name}. Nothing is reserved until the branch confirms; record the confirmation number when it arrives.`, reservation: r }; },
};
const rok: Provider = {
  id: "rokrunner", name: "Rokrunner (aggregates, delivered)", kinds: ["materials"], caps: { search: true, availability: true, quote: true, hold: false, reserve: false, book: false, deeplink: true, call: false },
  async search(ctx) { if (!ctx.words.some((w) => /^(gravel|limestone|lime|#?57|#?610|sand|aggregate|rock|base|stone|fill|riprap)$/.test(w))) return []; let rows: any[] = []; let err = false; try { rows = await rokrunner(); } catch { err = true; } return rows.filter((l) => has(ctx, l.item) || ctx.words.some((w) => /gravel|57|610|sand|stone/.test(w))).slice(0, 6).map((l) => ({ kind: "materials", title: l.item, subtitle: "Rokrunner · truckload delivered, Baton Rouge", vendor_name: "Rokrunner", url: l.url, distance_mi: null, price: l.price, unit: "load", available: l.variants?.some((v: any) => v.available) ? 1 : 0, method: "DEEP_LINK", provider: "rokrunner", evidence: evidence({ status: err ? STATUS.ERR : STATUS.POSTED, source: "rokrunner.com products.json (Shopify)", url: l.url, method: "storefront feed", price_type: "provider posted", availability_type: "storefront flag", confidence: .75, notes: "Checkout on rokrunner.com; delivery window confirmed by the vendor." }) } as Result)); },
  createDeepLink: (r) => r.url ?? null,
};
const materialsDir: Provider = {
  id: "materials", name: "Material price book + stores", kinds: ["materials"], caps: { search: true, availability: false, quote: false, hold: false, reserve: false, book: false, deeplink: true, call: true },
  async search(ctx) { const { data: mats } = await sb.from("ss_material_prices").select("*"); const { data: vs } = await sb.from("ss_vendors").select("*").in("kind", ["materials", "aggregate", "readymix", "sod"]); const out: Result[] = [];
    for (const m of (mats ?? []).filter((m: any) => has(ctx, `${m.item} ${m.category} ${(m.tags || []).join(" ")}`))) { const stores = (vs ?? []).filter((v: any) => v.brand === m.brand).map((v: any) => ({ v, d: v.lat ? miles(ctx.lat, ctx.lng, v.lat, v.lng) : null })).filter((x: any) => x.d === null || x.d <= ctx.radius).sort((a: any, b: any) => (a.d ?? 99) - (b.d ?? 99)); const s = stores[0];
      out.push({ kind: "materials", title: m.item, subtitle: `${m.brand}${s ? " · " + s.v.name : ""}`, vendor_id: s?.v.id ?? null, vendor_name: s?.v.name ?? m.brand, phone: s?.v.phone ?? null, addr: s?.v.addr ?? null, url: m.url, distance_mi: s?.d ?? null, open_now: s ? openNow(s.v.hours) : null, hours: s?.v.hours ?? null, price: m.price, unit: m.unit, method: m.url ? "DEEP_LINK" : "CALL_NOW", provider: "materials", ref: { type: "material", id: m.id }, evidence: evidence({ status: m.verified ? STATUS.POSTED : STATUS.EST, source: m.url || "price book", url: m.url, method: m.verified ? "provider page read on " + (m.checked_at || "").slice(0, 10) : "estimate", checked_at: m.checked_at, location: s?.v.name ?? null, price_type: m.verified ? "provider posted (dated)" : "estimated", availability_type: "call", confidence: m.verified ? .55 : .35, notes: "Store stock is not exposed by an API — call the counter or check the product page." }) }); }
    return out; },
  createDeepLink: (r) => r.url ?? null, getCallInstructions: callPkg,
};
const osmPlaces: Provider = {
  id: "osm", name: "OpenStreetMap places", kinds: ["places"], caps: { search: true, availability: false, quote: false, hold: false, reserve: false, book: false, deeplink: true, call: true },
  async search(ctx) { const term = ctx.words.filter((w) => !["near", "nearest", "open", "now", "today", "the", "for", "this", "job", "rent", "rental", "find"].includes(w)).slice(0, 3).join(" "); if (!term) return []; const d = ctx.radius / 69; let rows: any[] = []; let err = false;
    try { rows = await fetchT(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(term)}&format=json&limit=12&bounded=1&extratags=1&viewbox=${ctx.lng - d},${ctx.lat + d},${ctx.lng + d},${ctx.lat - d}`).then((r) => r.json()); } catch { err = true; }
    if (err) return [{ kind: "places", title: "OpenStreetMap lookup failed", subtitle: "Try again or call a directory vendor", method: "CALL_NOW", provider: "osm", evidence: evidence({ status: STATUS.ERR, source: "nominatim.openstreetmap.org", method: "bounded place search", confidence: 0, notes: "connection error — nothing was fabricated" }) }];
    return rows.filter((x: any) => x.name).map((x: any) => ({ kind: "places", title: x.name, subtitle: (x.display_name || "").split(",").slice(1, 3).join(",").trim(), addr: (x.display_name || "").split(",").slice(0, 3).join(","), phone: x.extratags?.phone || x.extratags?.["contact:phone"] || null, url: x.extratags?.website || null, distance_mi: miles(ctx.lat, ctx.lng, Number(x.lat), Number(x.lon)), open_now: openNow(x.extratags?.opening_hours), hours: x.extratags?.opening_hours || null, method: "CALL_NOW", provider: "osm", evidence: evidence({ status: STATUS.CALL, source: "OpenStreetMap (Nominatim)", url: `https://www.openstreetmap.org/${x.osm_type}/${x.osm_id}`, method: "bounded place search", location: x.display_name, availability_type: "call", confidence: .3, notes: "Community-maintained listing — hours/phone may be outdated; not an approved vendor." }) } as Result)); },
  createDeepLink: (r) => r.url ?? null, getCallInstructions: callPkg,
};
export const PROVIDERS: Provider[] = [internal, vendorsDir, homeDepot, chains, rok, materialsDir, osmPlaces];

// ---- universal search ----
const STOP = new Set(["the", "and", "for", "near", "nearest", "this", "that", "job", "site", "within", "miles", "mile", "today", "tomorrow", "now", "open", "available", "inch", "inches", "schedule", "find", "get", "need", "everything", "missing", "with", "from", "our", "crew", "running", "again", "way", "cheapest", "practical", "best"]);
export function tokens(q: string) { return q.toLowerCase().replace(/[^a-z0-9#\- ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) || /^#?\d{2,3}$/.test(w) && ["57", "610", "#57", "#610"].includes(w)); }
export function intent(q: string) { const s = q.toLowerCase(); if (/missing|everything for|loadout|ready/.test(s)) return "job_missing"; if (/fuel|diesel|gas station/.test(s)) return "fuel"; if (/mechanic|repair|hose|hydraulic|tire|tow|haul|dealer|warranty|running again|fix/.test(s)) return "repair"; if (/rent|rental|excavator|skid|trencher|compactor|lift|auger/.test(s)) return "rental"; if (/pvc|pipe|basin|gravel|57|610|sand|sod|paver|fabric|fitting|concrete|lumber|cedar/.test(s)) return "material"; return "general"; }
export function rank(rows: Result[], sort: string) {
  const conf = (r: Result) => staleness(r.evidence) === STATUS.ERR ? 0 : num(r.evidence.confidence, .3);
  const key: Record<string, (r: Result) => number> = { fastest: (r) => (r.distance_mi ?? 30) + (r.open_now === false ? 40 : 0), cheapest: (r) => r.total ?? r.price ?? 1e9, closest: (r) => r.distance_mi ?? 1e3, confidence: (r) => -conf(r), reliable: (r) => -(num((r as any).reliability, .5)), recommended: (r) => -(conf(r) * .45 + (1 - Math.min(r.distance_mi ?? 30, 30) / 30) * .25 + (r.open_now ? .15 : r.open_now === null ? .07 : 0) + (r.available && r.available > 0 ? .15 : 0)) };
  const f = key[sort] || key.recommended; for (const r of rows) r.score = Math.round(-key.recommended(r) * 1000) / 1000; return rows.sort((a, b) => f(a) - f(b));
}
export async function universalSearch(t: string, body: any) {
  const q = String(body.q || "").trim(); const words = tokens(q);
  const ctx: Ctx = { t, lat: num(body.lat, SHOP.lat), lng: num(body.lng, SHOP.lng), days: Math.max(1, num(body.days, 1)), radius: num(body.radius_mi, 25), q, words };
  const it = intent(q); const want = body.providers?.length ? PROVIDERS.filter((p) => body.providers.includes(p.id)) : PROVIDERS.filter((p) => it === "material" ? p.id !== "chains" && p.id !== "homedepot" : it === "repair" ? p.id !== "materials" && p.id !== "rokrunner" && p.id !== "homedepot" && p.id !== "chains" : it === "rental" ? p.id !== "materials" && p.id !== "rokrunner" : true);
  const t0 = Date.now(); const settled = await Promise.all(want.map(async (p) => { const s = Date.now(); try { const r = await p.search(ctx); return { provider: p.id, ok: true, ms: Date.now() - s, rows: r }; } catch (e) { return { provider: p.id, ok: false, ms: Date.now() - s, error: (e as Error).message, rows: [{ kind: "error", title: `${p.name} unavailable`, method: "CALL_NOW", provider: p.id, evidence: evidence({ status: STATUS.ERR, source: p.name, method: "adapter", confidence: 0, notes: (e as Error).message }) } as Result] }; } }));
  let rows = settled.flatMap((s) => s.rows); for (const r of rows) r.evidence.status = staleness(r.evidence);
  if (body.open_now) rows = rows.filter((r) => r.open_now !== false); if (body.kinds?.length) rows = rows.filter((r) => body.kinds.includes(r.kind)); if (body.verified_only) rows = rows.filter((r) => ([STATUS.LIVE, STATUS.POSTED] as string[]).includes(r.evidence.status));
  rows = rank(rows, body.sort || "recommended");
  const extra: any = {};
  if (it === "job_missing") { const { data: jobs } = await sb.from("ss_jobs").select("id,name,scope").eq("tenant_id", t); const j = (jobs ?? []).find((j: any) => words.some((w) => (j.name + " " + (j.scope || "")).toLowerCase().includes(w))) || (body.job_id ? { id: body.job_id } : null); if (j) { const { data: items } = await sb.from("ss_job_requirements").select("*").eq("job_id", j.id); extra.job = j; extra.missing = (items ?? []).filter((i: any) => !["In Stock", "On Truck", "In Warehouse", "Reserved", "Rented", "Ready for Pickup", "Delivery Scheduled", "Loaded", "Verified", "Ordered"].includes(i.status)).map((i: any) => ({ id: i.id, item: i.item, category: i.category, qty: i.qty, unit: i.unit, status: i.status, critical: i.critical })); } }
  const health = settled.map((s) => ({ provider: s.provider, ok: s.ok, ms: s.ms, results: s.rows.length, error: s.error || null }));
  const out = { q, intent: it, count: rows.length, rows: rows.slice(0, 60), providers: health, ...extra, ms: Date.now() - t0, ref: body.ref || null };
  await sb.from("ss_research").insert({ tenant_id: t, q: "[search] " + q, lat: ctx.lat, lng: ctx.lng, results: { intent: it, count: rows.length, top: rows.slice(0, 10).map((r) => ({ title: r.title, vendor: r.vendor_name, status: r.evidence.status, price: r.price })), providers: health, ref: body.ref || null } });
  return out;
}

// ---- vendor performance from Scag's own history ----
export function performance(res: any[], opts: any[], fb: any[]) {
  const n = res.length + opts.length + fb.length; const confirmed = res.filter((r) => ["confirmed", "picked_up", "returned", "active"].includes(r.status)).length, cancelled = res.filter((r) => r.status === "cancelled").length;
  const quoted = opts.filter((o) => o.call_outcome?.quoted_price); const acc = quoted.map((o) => { const est = num(o.cost?.direct); const q = num(o.call_outcome.quoted_price); return est ? Math.abs(q - est) / est : 0; }); const accuracy = acc.length ? Math.round((1 - acc.reduce((a, b) => a + b, 0) / acc.length) * 100) : null;
  const responded = opts.filter((o) => o.call_outcome?.confirmed_at).map((o) => (new Date(o.call_outcome.confirmed_at).getTime() - new Date(o.created_at).getTime()) / 60000); const resp = responded.length ? Math.round(responded.reduce((a, b) => a + b, 0) / responded.length) : null;
  const onTime = fb.filter((f) => f.on_time !== null); const rating = fb.filter((f) => f.rating);
  return { sample: n, insufficient: n < 3, fill_rate: res.length ? Math.round(confirmed / res.length * 100) : null, cancellation_rate: res.length ? Math.round(cancelled / res.length * 100) : null, quote_accuracy_pct: accuracy, avg_response_min: resp, on_time_pct: onTime.length ? Math.round(onTime.filter((f) => f.on_time).length / onTime.length * 100) : null, rating: rating.length ? Math.round(rating.reduce((a, f) => a + f.rating, 0) / rating.length * 10) / 10 : null, issues: fb.filter((f) => f.issue).map((f) => f.issue), reliability: n < 3 ? .7 : Math.min(1, .5 + (confirmed / Math.max(1, res.length)) * .3 + ((onTime.length ? onTime.filter((f) => f.on_time).length / onTime.length : .7) * .2)) };
}

// ---- router ----
export async function resources(path: string, req: Request, url: URL, body: any, t: string, settings: any): Promise<Response | null> {
  const actor = body.actor || req.headers.get("x-actor") || "demo user";
  if (path === "/resources/search") { if (req.method === "GET") body = { ...body, q: url.searchParams.get("q"), sort: url.searchParams.get("sort"), radius_mi: url.searchParams.get("radius_mi"), lat: url.searchParams.get("lat"), lng: url.searchParams.get("lng") }; if (!body.q) return json({ error: "q required" }, 400); return json(await universalSearch(t, body)); }
  if (path === "/resources/providers") return json(PROVIDERS.map((p) => ({ id: p.id, name: p.name, kinds: p.kinds, caps: p.caps, live: p.id === "homedepot" || p.id === "rokrunner" || p.id === "internal", note: p.caps.reserve ? "reservation supported" : p.caps.book ? "appointment via provider form" : p.caps.quote ? "quote by text/call" : "call to confirm" })));
  if (path === "/resources/reserve" && req.method === "POST") { const p = PROVIDERS.find((x) => x.id === body.provider); if (!p) return json({ error: "unknown provider" }, 400); if (!p.createReservation) return json({ supported: false, fallback: p.caps.deeplink ? "DEEP_LINK" : "CALL_NOW", how: `${p.name} has no reservation API — use the deep link or call, then record the confirmation.` }); const r = await p.createReservation(t, { ...body, actor }); await sb.from("ss_audit").insert({ tenant_id: t, actor, action: "reservation.requested", ref_type: "reservation", ref_id: r.reservation?.id ?? null, after: { provider: p.id, item: body.item, supported: r.supported } }); return json(r); }
  if (path === "/resources/call-package" && req.method === "POST") { const p = PROVIDERS.find((x) => x.id === body.provider); const r: Result = body.result; const pkg = (p?.getCallInstructions || callPkg)(r); return json({ ...pkg, equipment: body.equipment || null, site: body.site || null, contact: settings.contact || "Charlie Mascagni · (225) 241-3069", record: ["available (y/n) + quantity", "quoted price + fees", "ETA / pickup window", "confirmation number", "who you spoke with"] }); }

  if (path === "/vendors" && req.method === "GET") { const lat = num(url.searchParams.get("lat"), SHOP.lat), lng = num(url.searchParams.get("lng"), SHOP.lng); const [vs, res, opts, fb] = await Promise.all([sb.from("ss_vendors").select("*").neq("kind", "fuel"), sb.from("ss_reservations").select("vendor_id,status").eq("tenant_id", t), sb.from("ss_recovery_options").select("vendor_id,cost,call_outcome,created_at").eq("tenant_id", t).not("vendor_id", "is", null), sb.from("ss_provider_feedback").select("*").eq("tenant_id", t)]);
    return json((vs.data ?? []).map((v: any) => ({ ...v, distance: v.lat ? miles(lat, lng, v.lat, v.lng) : null, open_now: v.meta?.after_hours ? true : openNow(v.hours), performance: performance((res.data ?? []).filter((r: any) => r.vendor_id === v.id), (opts.data ?? []).filter((o: any) => o.vendor_id === v.id), (fb.data ?? []).filter((f: any) => f.vendor_id === v.id)) })).sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99))); }
  const vd = path.match(/^\/vendors\/([0-9a-f-]{36})(\/feedback)?$/);
  if (vd && !vd[2]) { const { data: v } = await sb.from("ss_vendors").select("*").eq("id", vd[1]).maybeSingle(); if (!v) return json({ error: "not found" }, 404); const [res, opts, fb] = await Promise.all([sb.from("ss_reservations").select("*").eq("tenant_id", t).eq("vendor_id", v.id).order("created_at", { ascending: false }), sb.from("ss_recovery_options").select("id,breakdown_id,label,cost,total,call_outcome,created_at,availability_status,price_status").eq("tenant_id", t).eq("vendor_id", v.id).order("created_at", { ascending: false }), sb.from("ss_provider_feedback").select("*").eq("tenant_id", t).eq("vendor_id", v.id).order("created_at", { ascending: false })]); return json({ ...v, open_now: v.meta?.after_hours ? true : openNow(v.hours), performance: performance(res.data ?? [], opts.data ?? [], fb.data ?? []), reservations: res.data ?? [], options: opts.data ?? [], feedback: fb.data ?? [] }); }
  if (vd && vd[2] && req.method === "POST") { const { data } = await sb.from("ss_provider_feedback").insert({ tenant_id: t, vendor_id: vd[1], ref_type: body.ref_type || null, ref_id: body.ref_id || null, on_time: body.on_time ?? null, quote_accurate: body.quote_accurate ?? null, issue: body.issue || null, rating: body.rating ? num(body.rating) : null, note: body.note || "", reported_by: actor }).select().single(); await sb.from("ss_audit").insert({ tenant_id: t, actor, action: "provider.feedback", ref_type: "vendor", ref_id: vd[1], after: data }); return json(data); }

  // rental lifecycle
  const rs = path.match(/^\/rentals\/([0-9a-f-]{36})\/(confirm|pickup|extend|return-scheduled|returned|cancel)$/);
  if (rs && req.method === "POST") { const { data: r } = await sb.from("ss_reservations").select("*, vendor:ss_vendors(name,phone)").eq("id", rs[1]).eq("tenant_id", t).maybeSingle(); if (!r) return json({ error: "not found" }, 404); const patch: any = {}; const a = rs[2]; const now = new Date().toISOString();
    if (a === "confirm") { patch.status = "confirmed"; patch.confirmation = body.confirmation || r.confirmation; patch.end_date = body.end_date || iso(addD(new Date(r.start_date + "T12:00:00Z"), r.days)); if (body.est_total) patch.est_total = num(body.est_total); }
    if (a === "pickup") { patch.status = "active"; patch.pickup_at = now; if (!r.end_date) patch.end_date = iso(addD(new Date(r.start_date + "T12:00:00Z"), r.days)); }
    if (a === "extend") { const d = Math.max(1, num(body.days, 1)); patch.days = r.days + d; patch.end_date = iso(addD(new Date((r.end_date || r.start_date) + "T12:00:00Z"), d)); patch.status = r.status === "active" ? "active" : r.status; }
    if (a === "return-scheduled") { patch.status = "return_scheduled"; patch.end_date = body.date || r.end_date; }
    if (a === "returned") { patch.status = "returned"; patch.returned_at = now; }
    if (a === "cancel") patch.status = "cancelled";
    patch.history = [...(r.history || []), { at: now, by: actor, action: a, note: body.note || null, confirmation: body.confirmation || null }];
    const { data } = await sb.from("ss_reservations").update(patch).eq("id", r.id).select().single();
    await sb.from("ss_notifications").insert({ tenant_id: t, kind: "reservation", title: `${r.item} · ${a.replace("-", " ")}`, body: `${r.vendor?.name ?? r.brand}${patch.confirmation ? " · conf# " + patch.confirmation : ""}${patch.end_date ? " · return " + dLabel(patch.end_date) : ""}`, ref_type: "reservation", ref_id: r.id });
    await sb.from("ss_audit").insert({ tenant_id: t, actor, action: "reservation." + a, ref_type: "reservation", ref_id: r.id, before: { status: r.status, days: r.days, end_date: r.end_date }, after: patch }); await event(t, "Rental " + a.replace("-", " "), r.item, `${r.vendor?.name ?? r.brand} · ${patch.end_date ? "return " + dLabel(patch.end_date) : ""}`, { type: "reservation", id: r.id }); return json(data); }
  if (path === "/rentals/due") { const { data } = await sb.from("ss_reservations").select("*, vendor:ss_vendors(name,phone)").eq("tenant_id", t).in("status", ["active", "confirmed", "return_scheduled"]); const today = iso(new Date()), soon = iso(addD(new Date(), 1)); const due = (data ?? []).filter((r: any) => r.end_date && r.end_date <= soon).map((r: any) => ({ ...r, overdue: r.end_date < today })); for (const r of due) { const { data: ex } = await sb.from("ss_notifications").select("id").eq("ref_id", r.id).ilike("title", "%return due%").gte("created_at", today).limit(1); if (!ex?.length) await sb.from("ss_notifications").insert({ tenant_id: t, kind: "reservation", title: `Rental return due · ${r.item}`, body: `${r.vendor?.name ?? r.brand} · due ${dLabel(r.end_date)}${r.overdue ? " · OVERDUE" : ""} — extend or schedule return`, ref_type: "reservation", ref_id: r.id }); } return json(due); }

  // breakdown media (private bucket, signed URLs)
  const bm = path.match(/^\/breakdowns\/([0-9a-f-]{36})\/media$/);
  if (bm && req.method === "POST") { const { data: b } = await sb.from("ss_breakdowns").select("id,media").eq("id", bm[1]).eq("tenant_id", t).maybeSingle(); if (!b) return json({ error: "not found" }, 404); const saved: any[] = []; for (const f of (body.files || []).slice(0, 8)) { if (!f.data || !f.type) continue; const bytes = Uint8Array.from(atob(String(f.data).replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0)); if (bytes.length > 8 * 1024 * 1024) continue; const p = `${t}/${b.id}/${crypto.randomUUID()}-${String(f.name || "photo").replace(/[^a-zA-Z0-9._-]/g, "_")}`; const { error } = await sb.storage.from("breakdown-media").upload(p, bytes, { contentType: f.type, upsert: false }); if (error) { saved.push({ name: f.name, error: error.message }); continue; } saved.push({ path: p, name: f.name, type: f.type, size: bytes.length, kind: f.kind || "photo", at: new Date().toISOString(), by: actor }); } const media = [...(b.media || []), ...saved.filter((s) => s.path)]; await sb.from("ss_breakdowns").update({ media }).eq("id", b.id); await sb.from("ss_audit").insert({ tenant_id: t, actor, action: "equipment.media_added", ref_type: "breakdown", ref_id: b.id, after: { count: saved.length } }); return json({ saved, media_count: media.length }); }
  if (bm && req.method === "GET") { const { data: b } = await sb.from("ss_breakdowns").select("media").eq("id", bm[1]).eq("tenant_id", t).maybeSingle(); if (!b) return json({ error: "not found" }, 404); const out = []; for (const m of b.media || []) { const { data } = await sb.storage.from("breakdown-media").createSignedUrl(m.path, 3600); out.push({ ...m, url: data?.signedUrl ?? null, expires_in: 3600 }); } return json(out); }

  // push
  if (path === "/push/vapid") return json({ public_key: Deno.env.get("VAPID_PUBLIC_KEY") || null, configured: !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY")) });
  if (path === "/push/subscribe" && req.method === "POST") { const s = body.subscription; if (!s?.endpoint || !s?.keys) return json({ error: "subscription required" }, 400); await sb.from("ss_push_subscriptions").upsert({ tenant_id: t, endpoint: s.endpoint, keys: s.keys, ua: req.headers.get("user-agent") || "", role: body.role || null }, { onConflict: "endpoint" }); return json({ ok: true, live: !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY")) }); }
  if (path === "/push/test" && req.method === "POST") return json({ result: await pushAll(t, "Scag Scapes Command", body.body || "Push is working.") });

  // pricing: market benchmarks + equipment rates
  if (path === "/pricing/market") { const [{ data: mk }, { data: rates }] = await Promise.all([sb.from("ss_market_rates").select("*").eq("tenant_id", t).order("occupation"), sb.from("ss_labor_rates").select("*").eq("tenant_id", t).order("effective", { ascending: false })]); const latest: Record<string, any> = {}; for (const r of rates ?? []) if (!latest[r.role]) latest[r.role] = r; const map: Record<string, string[]> = { Laborer: ["37-3011", "47-2061"], "Crew lead": ["37-1012"], Operator: ["47-2073"] };
    const compare = Object.values(latest).map((r: any) => { const socs = map[r.role] || []; const rows = (mk ?? []).filter((m: any) => socs.includes(m.soc)); return { role: r.role, wage: r.wage, benchmarks: rows.map((m: any) => ({ occupation: m.occupation, soc: m.soc, typical: m.typical, delta_pct: m.typical ? Math.round((r.wage - m.typical) / m.typical * 100) : null, source: m.source, source_date: m.source_date, url: m.source_url })), recommendation: rows.length ? (rows.every((m: any) => r.wage >= m.typical) ? "At or above market mean — hold" : "Below at least one benchmark mean — review at next rate change; not applied automatically") : "No benchmark mapped" }; });
    return json({ benchmarks: mk ?? [], compare, note: "Research figures are recommendations. Rate changes are made only through POST /pricing/labor with a reason and are audited." }); }
  if (path === "/pricing/equipment") { const [{ data: assets }, { data: cards }] = await Promise.all([sb.from("ss_equipment_assets").select("id,asset_no,category,make,model,hourly_cost,daily_cost,ownership,status").eq("tenant_id", t).order("asset_no"), sb.from("ss_rate_cards").select("item,category,brand,day,week,verified,checked_at")]); return json((assets ?? []).map((a: any) => { const cat = (a.category || "").toLowerCase(); const key = cat.includes("excavator") ? "excavator" : cat.includes("skid") || cat.includes("track loader") ? "loader" : cat.includes("trencher") ? "trencher" : cat.includes("compactor") ? "compact" : cat.includes("sod") ? "sod" : cat.includes("trailer") ? "trailer" : ""; const alt = key ? (cards ?? []).filter((c: any) => c.category === key || c.item.toLowerCase().includes(key)).sort((x: any, y: any) => num(x.day) - num(y.day))[0] : null; return { ...a, rental_equivalent: alt ? { item: alt.item, brand: alt.brand, day: alt.day, week: alt.week, status: alt.verified ? STATUS.POSTED : STATUS.EST, checked_at: alt.checked_at } : null, own_vs_rent_day: alt?.day ? Math.round((num(alt.day) - num(a.daily_cost)) * 100) / 100 : null }; })); }
  return null;
}

// ---------- reliability, from Scag's own record with each vendor ----------
//
// `performance()` has computed a reliability figure per vendor since v1.4, and `scoreOptions()` has weighted
// reliability at 10% since v1.3 — but the two were never connected. Recovery ranking used a constant per option
// *kind* (.75 mobile, .85 dealer, .8 rental), so a vendor that had cancelled on Scag twice scored exactly the
// same as one that had never missed. The whole point of collecting feedback is that it changes a decision.
//
// Under three events a vendor keeps the neutral .7 that performance() already defines, so a new vendor is not
// punished for being new and a single bad day cannot blackball anyone.
export async function reliabilityMap(t: string): Promise<Map<string, number>> {
  const [res, opts, fb] = await Promise.all([
    sb.from("ss_reservations").select("vendor_id,status").eq("tenant_id", t),
    sb.from("ss_recovery_options").select("vendor_id,cost,call_outcome,created_at").eq("tenant_id", t).not("vendor_id", "is", null),
    sb.from("ss_provider_feedback").select("*").eq("tenant_id", t),
  ]);
  const ids = new Set<string>([...(res.data ?? []), ...(opts.data ?? []), ...(fb.data ?? [])].map((r: any) => r.vendor_id).filter(Boolean));
  const out = new Map<string, number>();
  for (const id of ids) {
    const p = performance(
      (res.data ?? []).filter((r: any) => r.vendor_id === id),
      (opts.data ?? []).filter((o: any) => o.vendor_id === id),
      (fb.data ?? []).filter((f: any) => f.vendor_id === id),
    );
    out.set(id, Math.round(p.reliability * 100) / 100);
  }
  return out;
}
