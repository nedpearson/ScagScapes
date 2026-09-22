// ---------- tenant-scoped table proxy ----------
// PRODUCT MANDATE / going-live gap: the front end's rest()/ins()/up()/del()/upsert() helpers talked straight to
// PostgREST with the anon key, and every table's RLS policy only ever allowed tenant_id = 'demo'. That made the
// public sandbox safe but meant NO other tenant - including a real, paying Scag Scapes account - could read or
// write a single row through the running app, even with its own api_key. tenantFrom() in index.ts already proves
// which tenant a request is allowed to act as; this module is the one place that turns that proof into an actual
// table operation, using the service-role client (sb) so RLS is irrelevant here - tenant isolation is enforced in
// code, explicitly, below, not left to a policy the client's key was never going to satisfy anyway.
//
// This is deliberately NOT a generic passthrough: only the tables and columns the front end already touches this
// way are allowed, so a compromised or buggy client can move data further than a normal user could through the
// app, but can never reach another tenant's rows or write to a column nothing in the UI writes to today.
import { sb, json } from "./core.ts";

type TableRule = { key: "tenant_id" | "id"; insert: string[]; update: string[]; filter: string[]; upsertConflict?: string };

const TABLES: Record<string, TableRule> = {
  ss_leads: { key: "tenant_id", insert: ["name", "phone", "area", "addr", "source", "service_type", "need", "status", "response_seconds"], update: ["slot_date", "slot_time", "status", "notes"], filter: ["id"] },
  ss_messages: { key: "tenant_id", insert: ["lead_id", "who", "body"], update: [], filter: ["id"] },
  ss_events: { key: "tenant_id", insert: ["kind", "who", "body", "ref_type", "ref_id"], update: [], filter: ["id"] },
  ss_bookings: { key: "tenant_id", insert: ["date", "time", "kind", "label", "lead_id", "job_id"], update: [], filter: ["lead_id", "kind", "date", "time", "job_id", "id"] },
  ss_jobs: { key: "tenant_id", insert: [], update: ["install_date"], filter: ["id", "lead_id", "stage"] },
  ss_reviews: { key: "tenant_id", insert: [], update: ["reply"], filter: ["id"] },
  ss_campaigns: { key: "tenant_id", insert: [], update: [], filter: [] },
  ss_payments: { key: "tenant_id", insert: [], update: [], filter: [] },
  ss_quotes: { key: "tenant_id", insert: [], update: [], filter: [] },
  ss_automations: { key: "tenant_id", insert: [], update: ["enabled", "template"], filter: ["key"] },
  ss_forecast: { key: "tenant_id", insert: [], update: [], filter: ["day_offset"], upsertConflict: "tenant_id,day_offset" },
  ss_tenants: { key: "id", insert: [], update: ["settings"], filter: [] },
};

function parseFilters(qs: string, allowed: string[]): [string, string][] {
  if (!qs) return [];
  const out: [string, string][] = [];
  for (const part of qs.split("&")) {
    if (!part) continue;
    const [col, rest] = part.split("=");
    if (!col || !rest || !rest.startsWith("eq.")) throw new Error(`unsupported filter: ${part}`);
    if (!allowed.includes(col)) throw new Error(`filter column not allowed: ${col}`);
    out.push([col, decodeURIComponent(rest.slice(3))]);
  }
  return out;
}

export async function db(path: string, req: Request, url: URL, body: any, t: string, settings: any): Promise<Response | null> {
  const m = path.match(/^\/db\/([a-z_]+)$/);
  if (!m) return null;
  const rule = TABLES[m[1]];
  if (!rule) return json({ error: "table not exposed" }, 403);
  const table = m[1];

  try {
    if (req.method === "GET") {
      const rawSelect = url.searchParams.get("select") || "*";
      if (rawSelect.includes("(")) return json({ error: "relationship embeds not allowed here" }, 400);
      let q = sb.from(table).select(rawSelect).eq(rule.key, t);
      for (const [col, val] of url.searchParams.entries()) {
        if (col === "select" || col === "order" || col === "limit") continue;
        if (!val.startsWith("eq.")) return json({ error: `unsupported filter: ${col}=${val}` }, 400);
        if (!rule.filter.includes(col)) return json({ error: `filter column not allowed: ${col}` }, 400);
        q = q.eq(col, val.slice(3));
      }
      const order = url.searchParams.get("order");
      if (order) for (const part of order.split(",")) { const [col, dir] = part.split("."); q = q.order(col, { ascending: dir !== "desc" }); }
      const limit = url.searchParams.get("limit"); if (limit) q = q.limit(Math.min(Number(limit) || 100, 500));
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 400);
      return json(data ?? []);
    }

    if (req.method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const doUpsert = (req.headers.get("prefer") || "").includes("merge-duplicates");
      const clean = rows.map((r: any) => {
        const o: any = { [rule.key]: t };
        for (const k of rule.insert) if (r[k] !== undefined) o[k] = r[k];
        if (doUpsert) for (const k of rule.filter) if (r[k] !== undefined) o[k] = r[k]; // upsert needs its conflict-key columns too (e.g. day_offset)
        return o;
      });
      const q = doUpsert ? sb.from(table).upsert(clean, rule.upsertConflict ? { onConflict: rule.upsertConflict } : undefined) : sb.from(table).insert(clean);
      const { data, error } = await q.select();
      if (error) return json({ error: error.message }, 400);
      return json(data ?? []);
    }

    if (req.method === "PATCH" || req.method === "DELETE") {
      const filters = parseFilters(url.search.replace(/^\?/, ""), rule.filter);
      let q: any = sb.from(table);
      q = req.method === "PATCH" ? q.update((() => { const o: any = {}; for (const k of rule.update) if (body?.[k] !== undefined) o[k] = body[k]; return o; })()) : q.delete();
      q = q.eq(rule.key, t);
      for (const [col, val] of filters) q = q.eq(col, val);
      const { data, error } = await q.select();
      if (error) return json({ error: error.message }, 400);
      return json(data ?? []);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  return null;
}
