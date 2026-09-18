// Where the work is (PRODUCT MANDATE 6, 11).
//
// The honesty problem with a map: a pin says "the job is here". Most Scag leads carry a town and no street
// address, so geocoding them lands on a town centroid. Drawn as a precise pin that is a lie; drawn as a soft
// area marker it is genuinely useful for seeing where demand clusters. Every point therefore carries its
// precision, and the front end draws 'address' and 'area' differently rather than flattening them together.
import { sb, json } from "./core.ts";
import { nominatim } from "./sourcing.ts";

const LA = ", Louisiana, USA";

export async function geo(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {

  // ---- fill in what is missing, politely ----
  // Nominatim's usage policy is one request per second with an identifying user-agent. This walks a small batch
  // per call rather than hammering it, and reports what is left so the caller can come back.
  if (path === "/geo/backfill" && req.method === "POST") {
    const limit = Math.min(Number(body.limit ?? 12), 25);
    const done: any[] = []; const failed: any[] = [];

    const { data: leads } = await sb.from("ss_leads").select("id,name,addr,area").eq("tenant_id", t).is("lat", null).limit(limit);
    for (const l of leads ?? []) {
      const precise = !!(l.addr && String(l.addr).trim());
      const q = precise ? `${l.addr}${LA}` : (l.area && l.area !== "—" ? `${l.area}${LA}` : null);
      if (!q) { failed.push({ id: l.id, name: l.name, reason: "no address and no area - nothing to geocode" }); continue; }
      const g = await nominatim(q);
      if (!g?.lat) { failed.push({ id: l.id, name: l.name, reason: `Nominatim had no match for "${q}"` }); }
      else {
        await sb.from("ss_leads").update({ lat: Number(g.lat), lng: Number(g.lng), geo_precision: precise ? "address" : "area", geocoded_at: new Date().toISOString() }).eq("id", l.id);
        done.push({ id: l.id, name: l.name, precision: precise ? "address" : "area", query: q });
      }
      await new Promise((r) => setTimeout(r, 1100));   // the published rate limit, respected
    }

    const left = Math.max(0, limit - (leads?.length ?? 0));
    if (left > 0) {
      const { data: props } = await sb.from("ss_properties").select("id,addr,area").eq("tenant_id", t).is("lat", null).limit(left);
      for (const p of props ?? []) {
        const precise = !!(p.addr && String(p.addr).trim());
        const q = precise ? `${p.addr}${LA}` : (p.area ? `${p.area}${LA}` : null);
        if (!q) { failed.push({ id: p.id, name: p.addr, reason: "no address and no area" }); continue; }
        const g = await nominatim(q);
        if (!g?.lat) failed.push({ id: p.id, name: p.addr, reason: `Nominatim had no match for "${q}"` });
        else {
          await sb.from("ss_properties").update({ lat: Number(g.lat), lng: Number(g.lng), geo_precision: precise ? "address" : "area", geocoded_at: new Date().toISOString() }).eq("id", p.id);
          done.push({ id: p.id, name: p.addr, precision: precise ? "address" : "area", query: q });
        }
        await new Promise((r) => setTimeout(r, 1100));
      }
    }

    const { count: leadsLeft } = await sb.from("ss_leads").select("id", { count: "exact", head: true }).eq("tenant_id", t).is("lat", null);
    const { count: propsLeft } = await sb.from("ss_properties").select("id", { count: "exact", head: true }).eq("tenant_id", t).is("lat", null);
    return json({ geocoded: done.length, failed, done, remaining: { leads: leadsLeft ?? 0, properties: propsLeft ?? 0 },
      provider: "OpenStreetMap Nominatim", rate_limit: "1 request per second, observed",
      note: "A record with only a town is placed on the town centroid and marked precision 'area'. That is where demand is, not where the customer lives." });
  }

  // ---- everything with a position, plus what is still missing ----
  if (path === "/map/data" && req.method === "GET") {
    const { data: leads } = await sb.from("ss_leads").select("id,name,area,addr,status,service_type,ad_channel,lat,lng,geo_precision,created_at").eq("tenant_id", t);
    const { data: jobs } = await sb.from("ss_jobs").select("id,lead_id,name,scope,value,stage,install_date,property_id").eq("tenant_id", t);
    const { data: props } = await sb.from("ss_properties").select("id,addr,area,soil,lat,lng,geo_precision").eq("tenant_id", t);
    const jobsByLead = new Map<string, any[]>();
    for (const j of jobs ?? []) { const a = jobsByLead.get(j.lead_id) ?? []; a.push(j); jobsByLead.set(j.lead_id, a); }

    const points = (leads ?? []).filter((l) => l.lat != null).map((l) => {
      const js = jobsByLead.get(l.id) ?? [];
      return { id: l.id, kind: "lead", title: l.name, lat: Number(l.lat), lng: Number(l.lng),
        precision: l.geo_precision ?? "area", status: l.status, service_type: l.service_type,
        area: l.area, addr: l.addr, channel: l.ad_channel,
        value: js.filter((j) => j.stage > 0).reduce((a, j) => a + Number(j.value ?? 0), 0),
        jobs: js.length };
    });
    const propPoints = (props ?? []).filter((p) => p.lat != null).map((p) => ({
      id: p.id, kind: "property", title: p.addr, lat: Number(p.lat), lng: Number(p.lng),
      precision: p.geo_precision ?? "area", area: p.area, soil: p.soil }));

    // demand by town, which works with or without a single coordinate
    const byArea: Record<string, any> = {};
    for (const l of leads ?? []) {
      const k = l.area || "—";
      byArea[k] = byArea[k] ?? { area: k, leads: 0, won: 0, value: 0 };
      byArea[k].leads++;
      if (l.status === "won") { byArea[k].won++; byArea[k].value += (jobsByLead.get(l.id) ?? []).filter((j) => j.stage > 0).reduce((a, j) => a + Number(j.value ?? 0), 0); }
    }
    const areas = Object.values(byArea).map((a: any) => ({ ...a, win_pct: a.leads ? Math.round((a.won / a.leads) * 1000) / 10 : null }))
      .sort((a: any, b: any) => b.value - a.value || b.leads - a.leads);

    const missing = (leads ?? []).filter((l) => l.lat == null).length + (props ?? []).filter((p) => p.lat == null).length;
    const lats = [...points, ...propPoints].map((p) => p.lat), lngs = [...points, ...propPoints].map((p) => p.lng);
    const bounds = lats.length ? { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) } : null;
    return json({ points, properties: propPoints, areas, bounds, missing,
      precision_counts: { address: [...points, ...propPoints].filter((p) => p.precision === "address").length,
                          area: [...points, ...propPoints].filter((p) => p.precision === "area").length },
      source: "ss_leads + ss_jobs + ss_properties",
      note: missing ? `${missing} records have no position yet. Run the backfill.` : undefined });
  }
  return null;
}
