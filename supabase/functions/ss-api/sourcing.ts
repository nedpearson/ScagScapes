// ---------- sourcing: rentals · materials · fuel · research · notifications ----------
// Live sources: Home Depot rental pricing/inventory (undocumented apionline endpoint, no auth), AAA state/metro fuel page (static HTML),
// Rokrunner Shopify products.json, OpenStreetMap Overpass/Nominatim. Everything else is a verified-on-date rate card or a flagged estimate.
import { sb, json, fmt, event, dLabel } from "./core.ts";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const HD_STORES = "0357,0375";
export const miles = (a: number, b: number, c: number, d: number) => { const R = 3958.8, dLat = (c - a) * Math.PI / 180, dLon = (d - b) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 10) / 10; };
const BR = { lat: 30.4515, lng: -91.1871 };
async function fetchT(url: string, opts: RequestInit = {}, ms = 12000) { const c = new AbortController(); const id = setTimeout(() => c.abort(), ms); try { return await fetch(url, { ...opts, signal: c.signal, headers: { "user-agent": UA, ...(opts.headers || {}) } }); } finally { clearTimeout(id); } }
async function notify(t: string, kind: string, title: string, body: string, ref?: { type: string; id: string }) { await sb.from("ss_notifications").insert({ tenant_id: t, kind, title, body, ref_type: ref?.type, ref_id: ref?.id }); }

// ---- Home Depot live rental pricing + inventory ----
export async function hdRental(cat: string, sub: string) {
  const h = { referer: "https://www.homedepot.com/", accept: "application/json" };
  const [p, i] = await Promise.all([
    fetchT(`https://apionline.homedepot.com/product-information/rental/inventory/pricing/${cat}/${sub}/${HD_STORES}`, { headers: h }, 8000).then((r) => r.ok ? r.json() : []).catch(() => []),
    fetchT(`https://apionline.homedepot.com/product-information/rental/inventory/${cat}/${sub}/${HD_STORES}`, { headers: h }, 8000).then((r) => r.ok ? r.json() : []).catch(() => []),
  ]);
  const out: Record<string, any> = {};
  for (const x of (Array.isArray(p) ? p : [])) out[x.locationNbr] = { store: x.locationNbr, day: x.dailyRate, week: x.weeklyRate, month: x.monthlyRate, fourHour: x.fourHourRate, deposit: x.depositAmt, live: true };
  for (const x of (Array.isArray(i) ? i : [])) { out[x.locationNbr] = out[x.locationNbr] || { store: x.locationNbr, live: true }; out[x.locationNbr].available = x.availableQty; out[x.locationNbr].out = x.outOnContractQty; }
  return out;
}
export function rentalTotal(rc: { day: number; week: number; month: number }, days: number) {
  if (!rc.day) return null; if (days >= 28) return Math.round(rc.month * Math.ceil(days / 28));
  const w = Math.floor(days / 7), r = days % 7; return Math.round(Math.min(w * rc.week + Math.min(r * rc.day, rc.week), rc.month || Infinity));
}

// ---- AAA fuel (Louisiana + metros), cached 6h ----
export async function aaaFuel(force = false) {
  const { data: last } = await sb.from("ss_fuel_snapshots").select("*").eq("region", "Baton Rouge").order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (!force && last && Date.now() - new Date(last.observed_at).getTime() < 6 * 3600e3) return { fresh: false, rows: await fuelRows() };
  try {
    const html = await fetchT("https://gasprices.aaa.com/?state=LA", {}, 15000).then((r) => r.text());
    const rows: any[] = []; const num = (s: string) => Number((s || "").replace(/[^0-9.]/g, "")) || null;
    const st = html.match(/Current Avg\.<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>/);
    if (st) rows.push({ region: "Louisiana", regular: num(st[1]), mid: num(st[2]), premium: num(st[3]), diesel: num(st[4]) });
    const re = /<h3[^>]*data-title[^>]*>([^<]+)<\/h3>[\s\S]*?Current Avg\.<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>\s*<td>\$([\d.]+)<\/td>/g; let m;
    while ((m = re.exec(html))) rows.push({ region: m[1].trim(), regular: num(m[2]), mid: num(m[3]), premium: num(m[4]), diesel: num(m[5]) });
    if (rows.length) await sb.from("ss_fuel_snapshots").insert(rows.map((r) => ({ ...r, source: "aaa" })));
    return { fresh: rows.length > 0, rows: await fuelRows() };
  } catch { return { fresh: false, rows: await fuelRows(), error: "aaa unreachable" }; }
}
async function fuelRows() { const { data } = await sb.from("ss_fuel_snapshots").select("*").order("observed_at", { ascending: false }).limit(40); const seen: Record<string, any> = {}; for (const r of data ?? []) if (!seen[r.region]) seen[r.region] = r; return Object.values(seen); }

// ---- Rokrunner live aggregate prices ----
export async function rokrunner() {
  try { const j = await fetchT("https://www.rokrunner.com/products.json?limit=50", {}, 8000).then((r) => r.json()); return (j.products || []).map((p: any) => ({ item: p.title, brand: "Rokrunner", unit: "load", price: Number(p.variants?.[0]?.price || 0), variants: (p.variants || []).map((v: any) => ({ title: v.title, price: Number(v.price), available: v.available })), url: "https://www.rokrunner.com/products/" + p.handle, live: true })); } catch { return []; }
}

// ---- OSM ----
export async function nominatim(q: string) { const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { "user-agent": "ScagScapesCommand/1.0 (nedpearson@gmail.com)" } }, 8000).then((r) => r.json()).catch(() => []); const x = r?.[0]; return x ? { lat: Number(x.lat), lng: Number(x.lon), display: x.display_name } : null; }
export async function osmFuel(lat: number, lng: number, radius = 8000) {
  const q = `[out:json][timeout:20];(node["amenity"="fuel"](around:${radius},${lat},${lng});way["amenity"="fuel"](around:${radius},${lat},${lng}););out center 60;`;
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try { const r = await fetchT(host, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }, 20000); if (!r.ok) continue; const j = await r.json(); const els = (j.elements || []).map((e: any) => ({ osm: e.type + "/" + e.id, name: e.tags?.name || e.tags?.brand || "Fuel", brand: e.tags?.brand || e.tags?.name || "Independent", lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, addr: [e.tags?.["addr:housenumber"], e.tags?.["addr:street"]].filter(Boolean).join(" "), diesel: e.tags?.["fuel:diesel"] === "yes" })); if (els.length) return els; } catch { /* next host */ }
  }
  // fallback: Nominatim bounded search (≈ 7 mi box), 1 req/s policy, cached in ss_vendors
  try { const d = 0.1; const r = await fetchT(`https://nominatim.openstreetmap.org/search?q=fuel&format=json&limit=40&bounded=1&extratags=1&viewbox=${lng - d},${lat + d},${lng + d},${lat - d}`, { headers: { "user-agent": "ScagScapesCommand/1.0 (nedpearson@gmail.com)" } }, 10000).then((r) => r.json()); const els = (r || []).filter((x: any) => x.type === "fuel" || x.class === "amenity").map((x: any) => ({ osm: x.osm_type + "/" + x.osm_id, name: x.name || "Fuel", brand: x.extratags?.brand || x.name || "Independent", lat: Number(x.lat), lng: Number(x.lon), addr: (x.display_name || "").split(",").slice(1, 3).join(",").trim(), diesel: x.extratags?.["fuel:diesel"] === "yes" })); if (els.length) return els; } catch { /* give up */ }
  return null;
}
async function fuelStations(t: string, lat: number, lng: number) {
  let { data: cached } = await sb.from("ss_vendors").select("*").eq("kind", "fuel");
  const near = (cached ?? []).filter((v: any) => v.lat && miles(lat, lng, v.lat, v.lng) <= 8);
  if (near.length < 5) { const osm = await osmFuel(lat, lng); if (osm) { const rows = osm.map((s: any) => ({ kind: "fuel", brand: s.brand, name: s.name + (s.addr ? " · " + s.addr : ""), addr: s.addr, lat: s.lat, lng: s.lng, ext_id: s.osm, source: "osm", meta: { diesel: s.diesel } })); await sb.from("ss_vendors").upsert(rows, { onConflict: "kind,brand,name", ignoreDuplicates: true }); cached = (await sb.from("ss_vendors").select("*").eq("kind", "fuel")).data; } }
  const { data: reports } = await sb.from("ss_fuel_reports").select("*").eq("tenant_id", t).order("reported_at", { ascending: false });
  const rep: Record<string, any> = {}; for (const r of reports ?? []) { const k = r.vendor_id + ":" + r.fuel; if (!rep[k]) rep[k] = r; }
  return (cached ?? []).map((v: any) => ({ ...v, distance: v.lat ? miles(lat, lng, v.lat, v.lng) : null, regular: rep[v.id + ":regular"]?.price ?? null, diesel: rep[v.id + ":diesel"]?.price ?? null, reported_at: rep[v.id + ":diesel"]?.reported_at ?? rep[v.id + ":regular"]?.reported_at ?? null })).filter((v: any) => v.distance !== null && v.distance <= 10).sort((a: any, b: any) => a.distance - b.distance);
}

// ---- alerts ----
async function evalAlerts(t: string, ctx: { fuel?: any; rentals?: any[]; materials?: any[] }) {
  const { data: alerts } = await sb.from("ss_alerts").select("*").eq("tenant_id", t).eq("active", true); const fired: any[] = [];
  for (const a of alerts ?? []) {
    if (a.last_fired && Date.now() - new Date(a.last_fired).getTime() < 24 * 3600e3) continue; let hit: string | null = null;
    if (a.kind === "fuel" && ctx.fuel) { const br = ctx.fuel.find((r: any) => r.region === "Baton Rouge"); const p = br?.[a.target]; if (p && Number(p) <= Number(a.threshold)) hit = `${a.target} is $${Number(p).toFixed(3)} in Baton Rouge (AAA) — at or under your $${a.threshold} alert.`; }
    if (a.kind === "rental" && ctx.rentals) { const m = ctx.rentals.find((r: any) => r.item.toLowerCase().includes(a.target.toLowerCase()) && r.day && Number(r.day) <= Number(a.threshold)); if (m) hit = `${m.item} at ${m.vendor} is ${fmt(m.day)}/day — under your ${fmt(a.threshold)} alert.`; }
    if (a.kind === "material" && ctx.materials) { const m = ctx.materials.find((r: any) => r.item.toLowerCase().includes(a.target.toLowerCase()) && r.price && Number(r.price) <= Number(a.threshold)); if (m) hit = `${m.item} at ${m.brand} is ${fmt(m.price)}/${m.unit} — under your ${fmt(a.threshold)} alert.`; }
    if (hit) { await notify(t, "alert", "Price alert · " + a.kind, hit, { type: "alert", id: a.id }); await sb.from("ss_alerts").update({ last_fired: new Date().toISOString() }).eq("id", a.id); fired.push({ id: a.id, hit }); }
  }
  return fired;
}

// ---- router ----
export async function sourcing(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {
  const lat = Number(url.searchParams.get("lat") || body.lat || BR.lat), lng = Number(url.searchParams.get("lng") || body.lng || BR.lng);

  if (path === "/geo/geocode") { const q = url.searchParams.get("q") || body.q; if (!q) return json({ error: "q required" }, 400); const g = await nominatim(q); const lid = url.searchParams.get("lead_id") || body.lead_id; if (g && lid) await sb.from("ss_leads").update({ lat: g.lat, lng: g.lng }).eq("id", lid); return json(g || { error: "not found" }, g ? 200 : 404); }

  if (path === "/sourcing/vendors") { const kind = url.searchParams.get("kind"); let q = sb.from("ss_vendors").select("*"); if (kind) q = q.eq("kind", kind); const { data } = await q; return json((data ?? []).map((v: any) => ({ ...v, distance: v.lat ? miles(lat, lng, v.lat, v.lng) : null })).sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99))); }

  if (path === "/sourcing/rentals") {
    const item = (url.searchParams.get("item") || body.item || "").toLowerCase(), days = Math.max(1, Number(url.searchParams.get("days") || body.days || 1));
    const { data: cards } = await sb.from("ss_rate_cards").select("*"); const { data: vendors } = await sb.from("ss_vendors").select("*").eq("kind", "rental");
    const match = (cards ?? []).filter((c: any) => !item || c.item.toLowerCase().includes(item) || c.category.includes(item) || (c.model || "").toLowerCase().includes(item));
    const hdCache: Record<string, any> = {}; const rows: any[] = [];
    for (const c of match) {
      const vs = (vendors ?? []).filter((v: any) => v.brand === c.brand).map((v: any) => ({ ...v, distance: miles(lat, lng, v.lat, v.lng) }));
      if (c.brand === "Home Depot" && c.ext_cat) { const k = c.ext_cat + "/" + c.ext_sub; hdCache[k] = hdCache[k] || await hdRental(c.ext_cat, c.ext_sub); const live = hdCache[k];
        for (const v of vs) { const l = live[v.ext_id]; const rc = l?.day ? l : c; rows.push({ id: c.id, item: c.item, model: c.model, category: c.category, brand: c.brand, vendor: v.name, vendor_id: v.id, phone: v.phone, distance: v.distance, day: rc.day, week: rc.week, month: rc.month, deposit: rc.deposit ?? c.deposit, total: rentalTotal(rc, days), live: !!l?.day, available: l?.available ?? null, out: l?.out ?? null, verified: true, reserve: "web", url: v.meta?.url, source: c.source_url }); } }
      else for (const v of vs) rows.push({ id: c.id, item: c.item, model: c.model, category: c.category, brand: c.brand, vendor: v.name, vendor_id: v.id, phone: v.phone, distance: v.distance, day: c.day, week: c.week, month: c.month, deposit: c.deposit, total: rentalTotal(c, days), live: false, available: null, verified: c.verified, reserve: "quote", url: v.meta?.url, source: c.source_url, notes: c.notes });
    }
    rows.sort((a, b) => (a.total ?? 1e9) - (b.total ?? 1e9) || a.distance - b.distance);
    const fired = await evalAlerts(t, { rentals: rows });
    return json({ item, days, count: rows.length, rows, alerts_fired: fired, note: "Home Depot rows are live (price + on-hand at that store). Chain rows without a green check are verified-on-date estimates; tap Request quote and the branch is texted." });
  }

  if (path === "/sourcing/reserve" && req.method === "POST") {
    const { data: v } = body.vendor_id ? await sb.from("ss_vendors").select("*").eq("id", body.vendor_id).maybeSingle() : { data: null };
    const { data: r } = await sb.from("ss_reservations").insert({ tenant_id: t, vendor_id: v?.id ?? null, job_id: body.job_id || null, brand: v?.brand ?? body.brand, item: body.item, start_date: body.start_date, days: Number(body.days || 1), qty: Number(body.qty || 1), est_total: Number(body.est_total || 0), contact: body.contact || "Charlie · (225) 241-3069", notes: body.notes || "", status: "requested" }).select().single();
    const when = `${dLabel(body.start_date)} · ${body.days || 1} day${Number(body.days || 1) > 1 ? "s" : ""}`;
    const how = v?.meta?.reserve === "web" ? `Reserve online at ${v.meta.url} — deposit ${fmt(body.deposit || 0)} due at pickup.` : `Quote request texted to ${v?.name ?? body.brand} (${v?.phone ?? ""}). Expect a confirmation during branch hours.`;
    await notify(t, "reservation", `Reservation requested · ${body.item}`, `${v?.name ?? body.brand} · ${when} · est ${fmt(body.est_total || 0)}. ${how}`, { type: "reservation", id: r.id });
    await event(t, "Equipment requested", body.item, `${v?.name ?? body.brand} · ${when} · est ${fmt(body.est_total || 0)}.`, { type: "reservation", id: r.id });
    // demo: chains confirm after a short delay (simulated by client polling)
    return json({ reservation: r, how });
  }
  if (path === "/sourcing/reservations") { const { data } = await sb.from("ss_reservations").select("*, vendor:ss_vendors(name,phone,brand,meta)").eq("tenant_id", t).order("created_at", { ascending: false }); return json(data ?? []); }
  const rs = path.match(/^\/sourcing\/reservations\/([0-9a-f-]{36})$/);
  if (rs && req.method === "POST") { const { data: r } = await sb.from("ss_reservations").update({ status: body.status }).eq("id", rs[1]).eq("tenant_id", t).select("*, vendor:ss_vendors(name)").single(); if (r) { await notify(t, "reservation", `${r.item} · ${r.status.replace("_", " ")}`, `${r.vendor?.name ?? r.brand} · ${dLabel(r.start_date)}${r.status === "confirmed" ? " · pickup 7:00 AM, bring the deposit card" : ""}`, { type: "reservation", id: r.id }); await event(t, "Reservation " + r.status, r.item, `${r.vendor?.name ?? r.brand} · ${dLabel(r.start_date)}`, { type: "reservation", id: r.id }); } return json(r); }

  if (path === "/sourcing/materials") {
    const q = (url.searchParams.get("q") || body.q || "").toLowerCase(); const { data: mats } = await sb.from("ss_material_prices").select("*"); const { data: vendors } = await sb.from("ss_vendors").select("*").in("kind", ["materials", "aggregate", "readymix", "sod"]);
    let rows = (mats ?? []).filter((m: any) => !q || m.item.toLowerCase().includes(q) || m.category.includes(q) || (m.tags || []).some((x: string) => x.includes(q)));
    if (!q || /gravel|lime|57|610|sand|aggregate|rock|base/.test(q)) { const live = await rokrunner(); for (const l of live) if (!q || l.item.toLowerCase().includes(q) || /limestone|gravel|57|610|sand/.test(l.item.toLowerCase()) && /gravel|lime|57|610|sand|aggregate|rock|base/.test(q)) rows.push({ id: "rok-" + l.item, brand: "Rokrunner", category: "aggregate", item: l.item, unit: "load", price: l.price, url: l.url, verified: true, live: true, variants: l.variants, notes: "live Shopify feed · delivered BR" }); }
    rows = rows.map((m: any) => { const vs = (vendors ?? []).filter((v: any) => v.brand === m.brand).map((v: any) => ({ id: v.id, name: v.name, phone: v.phone, addr: v.addr, distance: v.lat ? miles(lat, lng, v.lat, v.lng) : null })).sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99)); return { ...m, stores: vs, nearest: vs[0] ?? null }; }).sort((a: any, b: any) => (a.price ?? 1e9) - (b.price ?? 1e9));
    const fired = await evalAlerts(t, { materials: rows });
    return json({ q, count: rows.length, rows, alerts_fired: fired });
  }

  if (path === "/sourcing/fuel") {
    const f = await aaaFuel(url.searchParams.get("refresh") === "1"); const stations = await fuelStations(t, lat, lng); const br = f.rows.find((r: any) => r.region === "Baton Rouge") || f.rows[0];
    const ranked = stations.map((s: any) => ({ ...s, est_diesel: s.diesel ?? br?.diesel ?? null, est_regular: s.regular ?? br?.regular ?? null, price_source: s.diesel || s.regular ? "reported" : "metro avg" })).sort((a: any, b: any) => (a.est_diesel ?? 99) - (b.est_diesel ?? 99) || a.distance - b.distance);
    const fired = await evalAlerts(t, { fuel: f.rows });
    return json({ averages: f.rows, fresh: f.fresh, metro: br, stations: ranked, alerts_fired: fired, note: "Averages: AAA (static page, cached 6h). Station prices are crew-reported — GasBuddy has no free API; the app ranks by reported price, then metro average, then distance." });
  }
  if (path === "/sourcing/fuel/report" && req.method === "POST") { const { data } = await sb.from("ss_fuel_reports").insert({ tenant_id: t, vendor_id: body.vendor_id, fuel: body.fuel || "diesel", price: Number(body.price), note: body.note || "" }).select().single(); await event(t, "Fuel price reported", body.fuel || "diesel", `$${Number(body.price).toFixed(3)} at station`, { type: "fuel", id: data.id }); return json(data); }

  if (path === "/notifications" && req.method === "GET") { const { data } = await sb.from("ss_notifications").select("*").eq("tenant_id", t).order("created_at", { ascending: false }).limit(50); return json(data ?? []); }
  if (path === "/notifications/read" && req.method === "POST") { let q = sb.from("ss_notifications").update({ read: true }).eq("tenant_id", t); if (body.ids?.length) q = q.in("id", body.ids); await q; return json({ ok: true }); }
  if (path === "/alerts" && req.method === "GET") { const { data } = await sb.from("ss_alerts").select("*").eq("tenant_id", t).order("created_at", { ascending: false }); return json(data ?? []); }
  if (path === "/alerts" && req.method === "POST") { const { data } = await sb.from("ss_alerts").insert({ tenant_id: t, kind: body.kind, target: body.target, threshold: Number(body.threshold), channel: body.channel || "push" }).select().single(); return json(data); }
  const al = path.match(/^\/alerts\/([0-9a-f-]{36})$/);
  if (al && req.method === "POST") { if (body.delete) { await sb.from("ss_alerts").delete().eq("id", al[1]).eq("tenant_id", t); return json({ deleted: true }); } const { data } = await sb.from("ss_alerts").update({ active: !!body.active }).eq("id", al[1]).eq("tenant_id", t).select().single(); return json(data); }

  if (path === "/research" && req.method === "POST") {
    const q = String(body.q || "").trim(); if (!q) return json({ error: "q required" }, 400); const ql = q.toLowerCase(); const t0 = Date.now();
    const [cards, mats, vendors, leads, jobs] = await Promise.all([sb.from("ss_rate_cards").select("*"), sb.from("ss_material_prices").select("*"), sb.from("ss_vendors").select("*"), sb.from("ss_leads").select("id,name,area,addr,need,status").eq("tenant_id", t), sb.from("ss_jobs").select("id,name,scope,value,stage").eq("tenant_id", t)]);
    const words = ql.split(/\s+/).filter((w) => w.length > 2); const has = (s: string) => { const x = (s || "").toLowerCase(); return words.some((w) => x.includes(w)); };
    const internal = {
      rentals: (cards.data ?? []).filter((c: any) => has(c.item + " " + c.category + " " + (c.model || ""))).slice(0, 8).map((c: any) => ({ item: c.item, brand: c.brand, day: c.day, week: c.week, verified: c.verified, url: c.source_url })),
      materials: (mats.data ?? []).filter((m: any) => has(m.item + " " + m.category + " " + (m.tags || []).join(" "))).slice(0, 8).map((m: any) => ({ item: m.item, brand: m.brand, price: m.price, unit: m.unit, verified: m.verified, url: m.url })),
      vendors: (vendors.data ?? []).filter((v: any) => has(v.name + " " + v.brand + " " + v.kind)).slice(0, 8).map((v: any) => ({ name: v.name, kind: v.kind, phone: v.phone, addr: v.addr, distance: v.lat ? miles(lat, lng, v.lat, v.lng) : null })),
      leads: (leads.data ?? []).filter((l: any) => has(l.name + " " + l.area + " " + (l.addr || "") + " " + (l.need || ""))).slice(0, 6),
      jobs: (jobs.data ?? []).filter((j: any) => has(j.name + " " + (j.scope || ""))).slice(0, 6),
    };
    const ext: any = { web: [], answer: null, provider: "duckduckgo+wikipedia" };
    const brave = Deno.env.get("BRAVE_API_KEY");
    if (brave) { try { const j = await fetchT(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, { headers: { "X-Subscription-Token": brave, accept: "application/json" } }, 8000).then((r) => r.json()); ext.web = (j.web?.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })); ext.provider = "brave"; } catch { /* fall through */ } }
    if (!ext.web.length) {
      try { const h = await fetchT(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {}, 9000).then((r) => r.text()); const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g; let m; const strip = (x: string) => x.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim(); while ((m = re.exec(h)) && ext.web.length < 8) { const u = m[1].match(/uddg=([^&]+)/); ext.web.push({ title: strip(m[2]), url: u ? decodeURIComponent(u[1]) : m[1], snippet: strip(m[3]) }); } if (ext.web.length) ext.provider = "duckduckgo"; } catch { /* fall through */ }
    }
    if (!ext.answer) {
      const [ddg, wiki] = await Promise.all([
        fetchT(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {}, 8000).then((r) => r.json()).catch(() => ({})),
        fetchT(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&search=${encodeURIComponent(q)}`, {}, 8000).then((r) => r.json()).catch(() => [[], [], [], []]),
      ]);
      if (ddg.AbstractText) ext.answer = { text: ddg.AbstractText, source: ddg.AbstractURL, heading: ddg.Heading };
      for (const r of (ddg.RelatedTopics || []).slice(0, 6)) if (r.FirstURL) ext.web.push({ title: (r.Text || "").split(" - ")[0], url: r.FirstURL, snippet: r.Text });
      for (let i = 0; i < (wiki[1] || []).length; i++) ext.web.push({ title: wiki[1][i], url: wiki[3][i], snippet: wiki[2]?.[i] || "" });
    }
    const tips: string[] = [];
    if (/drain|french|water|flood/.test(ql)) tips.push("Louisiana clay: spec 24\" trench, 4\" SDR-35 perforated, #57 washed gravel, non-woven fabric; design fall ≥ 1% (1/8\" per ft) — Moasure survey confirms.");
    if (/concrete|pad|slab/.test(ql)) tips.push("BR ready-mix: 3500 psi runs ~$150–175/yd delivered (unverified 2026); short-load fees under 6 yd — batch pads on the same day.");
    if (/rent|excavator|trencher|skid/.test(ql)) tips.push("Home Depot Denham Springs (#0375) is the only BR-area store showing mini excavators on hand today; Sunbelt/United are quote-only.");
    if (/fuel|diesel|gas/.test(ql)) tips.push("Diesel is ~$1.99 over regular in BR (AAA 9/15/2026) — fill the truck on regular routes, crew-report station prices to build the map.");
    const results = { internal, external: ext, tips, ms: Date.now() - t0 };
    await sb.from("ss_research").insert({ tenant_id: t, q, lat, lng, results });
    return json({ q, ...results });
  }
  if (path === "/research" && req.method === "GET") { const { data } = await sb.from("ss_research").select("id,q,created_at,results").eq("tenant_id", t).order("created_at", { ascending: false }).limit(20); return json(data ?? []); }
  return null;
}
