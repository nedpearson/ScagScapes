// Scag Scapes Command — model-agnostic AI layer (PRODUCT MANDATE §2, §3, §5, §6, §8, §9, §11, §15)
// The application never depends on one provider. Every recommendation is stored with its evidence, model and
// confidence, then closed with a human decision and an outcome. Deterministic values (prices, totals, deposits) are
// never produced here — price() in core.ts is the only authority and this file strips any price it sees.
import { sb, json, price, VERSION } from "./core.ts";
import { FIXTURES, SUITE_VERSION, score, baseline } from "./evals.ts";

export type Task = "scope_from_lead" | "breakdown_triage" | "takeoff_review" | "customer_reply" | "job_risk" | "supplier_search" | "general";
export interface ModelRow { id: string; provider: string; model_id: string; enabled: boolean; capabilities: string[]; privacy_tier: string; cost_in_per_m: number; cost_out_per_m: number; task_weights: Record<string, number>; }
export interface Completion { text: string; model_id: string; provider: string; latency_ms: number; usage?: { input?: number; output?: number }; }
export interface Provider { id: string; complete(system: string, user: string, model_id: string, images?: string[]): Promise<Completion>; embed?(texts: string[], model_id: string): Promise<{ vectors: number[][]; dims: number }>; }

const key = (k: string) => Deno.env.get(k) ?? "";
async function timed<T>(f: () => Promise<T>): Promise<[T, number]> { const t0 = Date.now(); const r = await f(); return [r, Date.now() - t0]; }

// ---------- provider adapters (swap, add, remove: nothing else in the app changes) ----------
const anthropic: Provider = { id: "anthropic", async complete(system, user, model_id, images = []) {
  const content: any[] = [...images.map((u) => ({ type: "image", source: { type: "url", url: u } })), { type: "text", text: user }];
  const [r, ms] = await timed(() => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: model_id, max_tokens: 1200, system, messages: [{ role: "user", content }] }) }).then((x) => x.json()));
  if (r.error) throw new Error(r.error.message); return { text: r.content?.map((c: any) => c.text).join("") ?? "", model_id, provider: "anthropic", latency_ms: ms, usage: { input: r.usage?.input_tokens, output: r.usage?.output_tokens } }; } };
const openai: Provider = { id: "openai", async complete(system, user, model_id, images = []) {
  const content: any[] = [{ type: "text", text: user }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))];
  const [r, ms] = await timed(() => fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key("OPENAI_API_KEY") }, body: JSON.stringify({ model: model_id, messages: [{ role: "system", content: system }, { role: "user", content }] }) }).then((x) => x.json()));
  if (r.error) throw new Error(r.error.message); return { text: r.choices?.[0]?.message?.content ?? "", model_id, provider: "openai", latency_ms: ms, usage: { input: r.usage?.prompt_tokens, output: r.usage?.completion_tokens } }; },
  async embed(texts, model_id) { const r = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key("OPENAI_API_KEY") }, body: JSON.stringify({ model: model_id, input: texts }) }).then((x) => x.json()); if (r.error) throw new Error(r.error.message); const vectors = r.data.map((d: any) => d.embedding); return { vectors, dims: vectors[0]?.length ?? 0 }; } };
const gemini: Provider = { id: "gemini", async complete(system, user, model_id, images = []) {
  const parts: any[] = [{ text: user }, ...images.map((u) => ({ file_data: { file_uri: u } }))];
  const [r, ms] = await timed(() => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model_id}:generateContent?key=${key("GEMINI_API_KEY")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts }] }) }).then((x) => x.json()));
  if (r.error) throw new Error(r.error.message); return { text: r.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "", model_id, provider: "gemini", latency_ms: ms, usage: { input: r.usageMetadata?.promptTokenCount, output: r.usageMetadata?.candidatesTokenCount } }; } };
// Honest fallback: no model configured. Returns the deterministic context only, clearly labelled. Never invents.
const none: Provider = { id: "none", async complete(_s, _u, model_id) { return { text: "", model_id, provider: "none", latency_ms: 0 }; } };
export const PROVIDERS: Record<string, Provider> = { anthropic, openai, gemini, none };
export const configured = () => ({ anthropic: !!key("ANTHROPIC_API_KEY"), openai: !!key("OPENAI_API_KEY"), gemini: !!key("GEMINI_API_KEY") });

// ---------- router: pick the best enabled model for a task from the tenant's registry ----------
export async function models(t: string): Promise<ModelRow[]> { const { data } = await sb.from("ss_ai_models").select("*").eq("tenant_id", t).order("model_id"); return (data ?? []) as ModelRow[]; }
export function pick(rows: ModelRow[], task: Task, avail = configured(), need: string[] = []): ModelRow | null {
  const ok = rows.filter((m) => m.enabled && (avail as any)[m.provider] && need.every((c) => (m.capabilities ?? []).includes(c)));
  if (!ok.length) return null;
  return ok.map((m) => ({ m, w: (m.task_weights?.[task] ?? m.task_weights?.general ?? 0.5) })).sort((a, b) => b.w - a.w || a.m.cost_out_per_m - b.m.cost_out_per_m)[0].m;
}

// ---------- knowledge-graph retrieval: the model sees Scag's own context, never an isolated prompt (§11) ----------
export async function context(t: string, ref: { lead_id?: string; job_id?: string; asset_id?: string; property_id?: string }) {
  const out: any = { retrieved_at: new Date().toISOString(), sources: [] as string[] };
  if (ref.job_id) { const { data: j } = await sb.from("ss_jobs").select("*").eq("id", ref.job_id).eq("tenant_id", t).maybeSingle(); if (j) { out.job = j; out.sources.push("ss_jobs"); ref.lead_id = ref.lead_id ?? j.lead_id;
    const { data: a } = await sb.from("ss_job_actuals").select("*").eq("job_id", j.id).maybeSingle(); if (a) { out.actuals = a; out.sources.push("ss_job_actuals"); }
    const { data: q } = j.quote_id ? await sb.from("ss_quotes").select("*").eq("id", j.quote_id).maybeSingle() : { data: null }; if (q) { out.quote = q; out.sources.push("ss_quotes"); } } }
  if (ref.lead_id) { const { data: l } = await sb.from("ss_leads").select("*").eq("id", ref.lead_id).eq("tenant_id", t).maybeSingle(); if (l) { out.lead = l; out.sources.push("ss_leads"); const { data: m } = await sb.from("ss_messages").select("who,body,created_at").eq("lead_id", l.id).order("created_at").limit(30); if (m?.length) { out.messages = m; out.sources.push("ss_messages"); } } }
  if (ref.asset_id) { const { data: a } = await sb.from("ss_equipment_assets").select("*").eq("id", ref.asset_id).eq("tenant_id", t).maybeSingle(); if (a) { out.asset = a; out.sources.push("ss_equipment_assets"); const { data: b } = await sb.from("ss_breakdowns").select("symptom,status,actual_cost,actual_downtime_hours,created_at").eq("asset_id", a.id).order("created_at", { ascending: false }).limit(10); if (b?.length) { out.breakdown_history = b; out.sources.push("ss_breakdowns"); } } }
  const pid = out.job?.property_id ?? out.lead?.property_id ?? ref.property_id; if (pid) { const { data: p } = await sb.from("ss_properties").select("*").eq("id", pid).maybeSingle(); if (p) { out.property = p; out.sources.push("ss_properties");
    const { data: pj } = await sb.from("ss_jobs").select("id,service_type,scope,value,stage,install_date").eq("property_id", pid).order("created_at", { ascending: false }).limit(10); if (pj?.length) { out.property_jobs = pj; out.sources.push("ss_jobs(property)"); } } }
  // accumulated operating knowledge: estimate-vs-actual accuracy for this service type (the moat, §4)
  const st = out.job?.service_type ?? out.lead?.service_type; if (st) { const { data: acc } = await sb.from("ss_estimate_accuracy").select("*").eq("tenant_id", t).eq("service_type", st).maybeSingle(); if (acc) { out.history = acc; out.sources.push("ss_estimate_accuracy"); } }
  return out;
}

async function mediaUrls(t: string, ref: { breakdown_id?: string }): Promise<string[]> {
  if (!ref.breakdown_id) return []; const { data: b } = await sb.from("ss_breakdowns").select("media").eq("id", ref.breakdown_id).eq("tenant_id", t).maybeSingle();
  const out: string[] = []; for (const m of (b?.media ?? []).slice(0, 4)) { const path = typeof m === "string" ? m : m?.path; if (!path) continue; const { data } = await sb.storage.from("breakdown-media").createSignedUrl(path, 600); if (data?.signedUrl) out.push(data.signedUrl); } return out;
}
// ---------- retrieval: embeddings stay in ss_embeddings (exportable), search is a SQL function (§15) ----------
export async function embedder(t: string): Promise<{ prov: Provider; model_id: string } | null> { const rows = await models(t); const m = rows.find((r) => r.enabled && (configured() as any)[r.provider] && (r.capabilities ?? []).includes("embed")); return m && PROVIDERS[m.provider].embed ? { prov: PROVIDERS[m.provider], model_id: m.model_id } : null; }
export async function indexRecord(t: string, ref_type: string, ref_id: string, text: string) { const e = await embedder(t); if (!e || !text.trim()) return { indexed: false, reason: e ? "empty" : "no embedding model enabled (add a registry row with capability 'embed')" }; const { vectors, dims } = await e.prov.embed!([text.slice(0, 6000)], e.model_id); if (dims !== 1536) return { indexed: false, reason: `model returns ${dims} dims; table is 1536` }; await sb.from("ss_embeddings").upsert({ tenant_id: t, ref_type, ref_id, chunk: 0, text: text.slice(0, 6000), provider: e.prov.id, model_id: e.model_id, dims, embedding: JSON.stringify(vectors[0]) }, { onConflict: "tenant_id,ref_type,ref_id,chunk,provider,model_id" }); return { indexed: true }; }
export async function retrieve(t: string, q: string, k = 8, kinds: string[] | null = null) { const e = await embedder(t); if (!e) return []; const { vectors } = await e.prov.embed!([q], e.model_id); const { data } = await sb.rpc("ss_match", { t, q: JSON.stringify(vectors[0]), k, kinds }); return data ?? []; }

// ---------- guardrail: AI may recommend, never set an authoritative number (§5) ----------
const PRICE_KEYS = /^(price|total|deposit|rate|cost|amount|balance|value)$/i;
export function strip(obj: any): any {
  if (Array.isArray(obj)) return obj.map(strip);
  if (obj && typeof obj === "object") { const o: any = {}; for (const [k, v] of Object.entries(obj)) { if (PRICE_KEYS.test(k) && typeof v === "number") o["suggested_" + k] = v; else o[k] = strip(v); } return o; }
  return obj;
}
export function parseJson(text: string): any { const m = text.match(/\{[\s\S]*\}/); if (!m) return { note: text.trim() }; try { return JSON.parse(m[0]); } catch { return { note: text.trim() }; } }

// Per-task shape of "recommendation". Discovered the hard way in shadow mode: asked only for a "recommendation",
// the model returned "Confirm spoil hauling is included; offer both Friday slots" - advice for Charlie, which
// would have been texted verbatim to a homeowner had ai_sms been "live". For customer_reply the recommendation
// IS the outgoing message, and saying so is the difference between a draft and an embarrassment.
const TASK_NOTE: Partial<Record<Task, string>> = {
  customer_reply: ` For this task "recommendation" MUST be the exact words to send to the customer - a short, warm, plain-spoken text message from Scag Scapes, second person, no more than about 300 characters, no placeholders, no brackets, no instructions to staff, no meta-commentary. Write what the customer reads, not what we should do. Put your reasoning in "reasoning", never in "recommendation".`,
};
const SYSTEM = (task: Task) => TASK_NOTE[task] ? BASE_SYSTEM(task) + TASK_NOTE[task] : BASE_SYSTEM(task);
const BASE_SYSTEM = (task: Task) => `You are the operations assistant inside Scag Scapes Command, a Baton Rouge drainage contractor's own system. Task: ${task}.
Rules that are not negotiable: (1) use ONLY the context provided; if something is not in the context say "not in records" - never invent prices, availability, appointments, suppliers or addresses; (2) you recommend, the app decides - never state a final price or total, the pricing engine owns those; (3) return JSON with keys: recommendation (string), reasoning (string), confidence (0-1), assumptions (string[]), alternatives (string[]), evidence (string[] naming which context fields you relied on).`;

// One recommendation: retrieve context, pick a model, call it, strip any number it invented, log the row.
// Exported so an in-process caller (the SMS webhook in shadow mode) goes through this exact guarded path
// rather than a second, unguarded one.
export async function recommend(t: string, task: Task, ref: any, input: any) {
  const ctx = await context(t, ref ?? {});
  const images = await mediaUrls(t, ref ?? {});
  const q = input?.text ?? input?.symptom ?? "";
  if (q) { try { const hits = await retrieve(t, String(q), 6); if (hits.length) { ctx.retrieved = hits; ctx.sources.push("ss_embeddings"); } } catch (_) { /* retrieval is optional */ } }
  const rows = await models(t); const m = pick(rows, task, configured(), images.length ? ["vision"] : []); const prov = m ? PROVIDERS[m.provider] : none;
  let out: any, comp: Completion, err: string | null = null;
  if (!m) { comp = await none.complete("", "", "none"); out = { recommendation: null, note: "No AI model is enabled for this tenant. Showing the retrieved records only.", confidence: 0, evidence: ctx.sources }; }
  else { try { comp = await prov.complete(SYSTEM(task), JSON.stringify({ input: input ?? {}, context: ctx }), m.model_id, images); out = strip(parseJson(comp.text)); out.authoritative = false; } catch (e) { err = (e as Error).message; comp = { text: "", model_id: m.model_id, provider: m.provider, latency_ms: 0 }; out = { recommendation: null, note: "Model call failed: " + err, confidence: 0, evidence: ctx.sources }; } }
  const rec = { tenant_id: t, task, ref: ref ?? {}, input: input ?? {}, context_sources: ctx.sources, media: images.length ? images.map(() => "breakdown-media (signed, 10 min)") : [], model_id: comp.model_id, provider: comp.provider, output: out, confidence: Number(out.confidence ?? 0), latency_ms: comp.latency_ms, usage: comp.usage ?? null, error: err, app_version: VERSION };
  const { data } = await sb.from("ss_ai_recommendations").insert(rec).select().single();
  return { id: data?.id as string | undefined, out, comp, ctx };
}

// ---------- routes ----------
// Security sweep 2026-09-17: the demo tenant is deliberately open (it is a sandbox with /reset), but the two
// classes of route that are bulk or billable are gated regardless of tenant: /export moves every record in one
// call, and /ai/evals/run + POST /ai/models spend provider credits and decide which model handles real work.
// Set with: supabase secrets set SS_ADMIN_KEY=...   Unset => these routes are closed to everyone.
const guard = (req: Request) => { const k = Deno.env.get("SS_ADMIN_KEY"); return !!k && req.headers.get("x-ss-key") === k; };
const denied = () => json({ error: "key required", detail: "send header x-ss-key; this route is gated even on the demo tenant" }, 401);

export async function ai(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {
  if (path === "/ai/models" && req.method === "GET") return json({ configured: configured(), models: await models(t), suite_version: SUITE_VERSION });
  if (path === "/ai/models" && req.method === "POST") { if (!guard(req)) return denied(); const row = { tenant_id: t, provider: body.provider, model_id: body.model_id, enabled: body.enabled ?? true, capabilities: body.capabilities ?? ["text"], privacy_tier: body.privacy_tier ?? "vendor-processed", cost_in_per_m: Number(body.cost_in_per_m ?? 0), cost_out_per_m: Number(body.cost_out_per_m ?? 0), task_weights: body.task_weights ?? { general: 0.5 } }; const { data, error } = await sb.from("ss_ai_models").upsert(row, { onConflict: "tenant_id,provider,model_id" }).select().single(); if (error) return json({ error: error.message }, 400); return json(data); }

  if (path === "/ai/recommend" && req.method === "POST") {
    const r = await recommend(t, body.task ?? "general", body.ref ?? {}, body.input ?? {});
    return json({ id: r.id, ...r.out, model: { provider: r.comp.provider, model_id: r.comp.model_id, latency_ms: r.comp.latency_ms }, context: r.ctx });
  }
  // (that body now lives in recommend(), below, so in-process callers use the identical guarded path)
  const dec = path.match(/^\/ai\/recommendations\/([0-9a-f-]{36})\/decision$/);
  if (dec && req.method === "POST") { const d = ["accepted", "modified", "rejected"].includes(body.decision) ? body.decision : null; if (!d) return json({ error: "decision must be accepted | modified | rejected" }, 400); const { data } = await sb.from("ss_ai_recommendations").update({ decision: d, decided_by: body.by ?? null, decided_at: new Date().toISOString(), final_value: body.final_value ?? null, outcome: body.outcome ?? null, kpi: body.kpi ?? null }).eq("id", dec[1]).eq("tenant_id", t).select().single(); return json(data); }
  if (path === "/ai/recommendations" && req.method === "GET") { const { data } = await sb.from("ss_ai_recommendations").select("id,task,model_id,provider,confidence,decision,outcome,kpi,latency_ms,created_at").eq("tenant_id", t).order("created_at", { ascending: false }).limit(200); return json(data ?? []); }
  if (path === "/ai/learning" && req.method === "GET") { const { data } = await sb.from("ss_ai_learning").select("*").eq("tenant_id", t); return json(data ?? []); }

  // A fixture image lives in Scag's own bucket; resolve it to a signed URL the way production does. Returns null
  // when the object is not there, so the caller skips the fixture instead of scoring a model on a broken link.
  // (declared here so the eval route below can use it)
  // deno-lint-ignore no-inner-declarations
  async function fixtureImages(imgs: string[] | undefined): Promise<{ urls: string[]; missing: string | null }> {
    if (!imgs?.length) return { urls: [], missing: null };
    const urls: string[] = [];
    for (const ref of imgs) {
      if (!ref.startsWith("storage:")) { urls.push(ref); continue; }
      const [bucket, ...rest] = ref.slice("storage:".length).split("/");
      const path = rest.join("/");
      const { data } = await sb.storage.from(bucket).createSignedUrl(path, 600);
      if (!data?.signedUrl) return { urls: [], missing: `${bucket}/${path}` };
      urls.push(data.signedUrl);
    }
    return { urls, missing: null };
  }

  // versioned evaluation suite on real Scag tasks - promote a model only when this says so (§3, §12)
  if (path === "/ai/evals/run" && req.method === "POST") {
    if (!guard(req)) return denied();
    const rows = (await models(t)).filter((m) => m.enabled && (configured() as any)[m.provider]); if (!rows.length) return json({ error: "no enabled model with a configured key" }, 400);
    const results: any[] = []; const skipped: any[] = [];
    for (const m of rows) for (const f of FIXTURES) { let s = 0, ms = 0, e: string | null = null, text = "";
      if (f.images?.length && !(m.capabilities ?? []).includes("vision")) continue;   // a text-only model is not scored on a vision fixture
      const img = await fixtureImages(f.images);
      if (img.missing) { skipped.push({ fixture_id: f.id, reason: `fixture image not found at ${img.missing} - upload one there to activate this test` }); continue; }
      try { const c = await PROVIDERS[m.provider].complete(SYSTEM(f.task as Task), JSON.stringify({ input: f.input, context: f.context }), m.model_id, img.urls); text = c.text; ms = c.latency_ms; s = score(f, strip(parseJson(c.text))); } catch (x) { e = (x as Error).message; }
      const row = { tenant_id: t, suite_version: SUITE_VERSION, task: f.task, fixture_id: f.id, provider: m.provider, model_id: m.model_id, score: s, latency_ms: ms, error: e, output: text.slice(0, 4000) };
      await sb.from("ss_ai_evals").insert(row); results.push(row); }
    // the deterministic path, scored identically - this is the number a model has to beat (13)
    for (const f of FIXTURES) { const b = baseline(f); if (!b) continue;
      const row = { tenant_id: t, suite_version: SUITE_VERSION, task: f.task, fixture_id: f.id, provider: "baseline", model_id: "deterministic", score: score(f, b), latency_ms: 0, error: null, output: JSON.stringify(b).slice(0, 4000) };
      await sb.from("ss_ai_evals").insert(row); results.push(row); }
    // An errored call is a MISSING measurement, not a zero. Averaging it in would score a model for a network
    // failure or a bad fixture, which is how an eval suite quietly starts lying. Errors are counted separately.
    const by: Record<string, { n: number; score: number; ms: number; errors: number }> = {};
    for (const r of results) { const k = r.provider + ":" + r.model_id; by[k] = by[k] ?? { n: 0, score: 0, ms: 0, errors: 0 };
      if (r.error) { by[k].errors++; continue; } by[k].n++; by[k].score += r.score; by[k].ms += r.latency_ms; }
    const summary = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { scored: v.n, errors: v.errors, mean_score: v.n ? +(v.score / v.n).toFixed(3) : null, mean_latency_ms: v.n ? Math.round(v.ms / v.n) : null }]));
    const bl = summary["baseline:deterministic"]?.mean_score ?? null;
    return json({ suite_version: SUITE_VERSION, fixtures: FIXTURES.length, baseline_mean: bl,
      note: bl === null ? undefined : "A model may answer customers only where it beats the baseline on the same fixture - see reply-01 in results.",
      summary, skipped, results });
  }
  if (path === "/ai/evals" && req.method === "GET") { const { data } = await sb.from("ss_ai_evals").select("suite_version,task,provider,model_id,score,latency_ms,error,ran_at").eq("tenant_id", t).order("ran_at", { ascending: false }).limit(500); return json(data ?? []); }

  // estimate vs actual - every finished job makes the system better (§4, §14)
  const act = path.match(/^\/jobs\/([0-9a-f-]{36})\/actuals$/);
  if (act && req.method === "POST") { const { data: job } = await sb.from("ss_jobs").select("id,tenant_id").eq("id", act[1]).eq("tenant_id", t).maybeSingle(); if (!job) return json({ error: "job not found" }, 404);
    const row = { tenant_id: t, job_id: job.id, labor_hours_actual: num(body.labor_hours_actual), material_cost_actual: num(body.material_cost_actual), crew_days: num(body.crew_days), lf_installed: num(body.lf_installed), callbacks: num(body.callbacks), change_orders_value: num(body.change_orders_value), weather_days_lost: num(body.weather_days_lost), equipment_downtime_hours: num(body.equipment_downtime_hours), material_waste_pct: num(body.material_waste_pct), customer_rating: body.customer_rating ?? null, notes: body.notes ?? null, closed_at: new Date().toISOString() };
    const { data, error } = await sb.from("ss_job_actuals").upsert(row, { onConflict: "job_id" }).select().single(); if (error) return json({ error: error.message }, 400); return json(data); }
  if (path === "/estimate-accuracy" && req.method === "GET") { const { data } = await sb.from("ss_estimate_accuracy").select("*").eq("tenant_id", t); return json(data ?? []); }

  // §11 properties
  if (path === "/properties" && req.method === "GET") { const { data } = await sb.from("ss_properties").select("*").eq("tenant_id", t).order("created_at", { ascending: false }).limit(500); return json(data ?? []); }
  const prop = path.match(/^\/properties\/([0-9a-f-]{36})$/);
  if (prop && req.method === "POST") { const allowed = ["lot_sqft", "soil", "drainage_notes", "elevation_scan", "photos", "lat", "lng", "area"]; const patch: any = {}; for (const k of allowed) if (k in body) patch[k] = body[k]; const { data, error } = await sb.from("ss_properties").update(patch).eq("id", prop[1]).eq("tenant_id", t).select().single(); if (error) return json({ error: error.message }, 400); return json(data); }
  // §15 retrieval index - build it from Scag's own records; nothing leaves except the text being embedded
  if (path === "/ai/index" && req.method === "POST") {
    const n = Math.min(Number(body.limit ?? 200), 500); let done = 0, skipped = 0; const reasons: string[] = [];
    const { data: leads } = await sb.from("ss_leads").select("id,name,area,addr,need,service_type").eq("tenant_id", t).limit(n);
    for (const l of leads ?? []) { const r = await indexRecord(t, "lead", l.id, `${l.name} ${l.area} ${l.addr ?? ""} ${l.service_type} ${l.need}`); r.indexed ? done++ : (skipped++, reasons.push(r.reason!)); if (!r.indexed && /no embedding model/.test(r.reason!)) break; }
    const { data: jobs } = await sb.from("ss_jobs").select("id,name,service_type,scope").eq("tenant_id", t).limit(n);
    for (const j of jobs ?? []) { const r = await indexRecord(t, "job", j.id, `${j.name} ${j.service_type} ${j.scope}`); r.indexed ? done++ : skipped++; if (!r.indexed && /no embedding model/.test(r.reason!)) break; }
    const { data: bds } = await sb.from("ss_breakdowns").select("id,symptom,site_addr,diagnosis").eq("tenant_id", t).limit(n);
    for (const b of bds ?? []) { const r = await indexRecord(t, "breakdown", b.id, `${b.symptom} ${b.site_addr ?? ""} ${JSON.stringify(b.diagnosis ?? {})}`); r.indexed ? done++ : skipped++; if (!r.indexed && /no embedding model/.test(r.reason!)) break; }
    return json({ indexed: done, skipped, reason: reasons[0] ?? null });
  }
  if (path === "/ai/search" && req.method === "GET") { const q = url.searchParams.get("q") ?? ""; if (!q) return json({ error: "q required" }, 400); return json({ q, hits: await retrieve(t, q, Number(url.searchParams.get("k") ?? 8)) }); }
  // portability: everything Scag owns, exportable in one call (§1, §15)
  if (path === "/export" && req.method === "GET") {
    if (!guard(req)) return denied();
    const tables = ["ss_leads", "ss_messages", "ss_quotes", "ss_jobs", "ss_job_actuals", "ss_payments", "ss_bookings", "ss_campaigns", "ss_events", "ss_automations", "ss_vendors", "ss_rate_cards", "ss_reservations", "ss_equipment_assets", "ss_equipment_events", "ss_breakdowns", "ss_job_requirements", "ss_labor_rates", "ss_estimate_versions", "ss_provider_feedback", "ss_market_rates", "ss_ai_models", "ss_ai_recommendations", "ss_ai_evals", "ss_properties", "ss_embeddings"];
    const out: Record<string, any> = { exported_at: new Date().toISOString(), tenant: t, app_version: VERSION, suite_version: SUITE_VERSION, tables: {} };
    for (const tb of tables) { const { data, error } = await sb.from(tb).select("*").eq("tenant_id", t); out.tables[tb] = error ? { error: error.message } : data; }
    out.pricing_rules_version = VERSION; out.prompts = { system: SYSTEM("general") }; out.eval_fixtures = FIXTURES;
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="scagscapes-${t}-${out.exported_at.slice(0, 10)}.json"`, "Access-Control-Allow-Origin": "*" } });
  }
  // the mandate self-check, machine-readable (§13, non-negotiable audit)
  if (path === "/ai/audit" && req.method === "GET") return json({ version: VERSION, suite_version: SUITE_VERSION, configured: configured(), checks: AUDIT });
  return null;
}
const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));

export const AUDIT = [
  { q: "Creates or captures proprietary Scag Scapes knowledge?", where: "ss_job_actuals, ss_estimate_accuracy, ss_ai_recommendations.outcome, ss_provider_feedback, breakdown outcomes" },
  { q: "Gets better when future models improve?", where: "ss_ai_models registry + pick(); promotion gated by /ai/evals/run" },
  { q: "Provider replaceable?", where: "PROVIDERS map; add an adapter, insert a registry row, nothing else changes" },
  { q: "Real-world claims verified, not hallucinated?", where: "STATUS vocabulary on every sourcing row; SYSTEM prompt forbids invention; context() supplies records; strip() removes numbers" },
  { q: "Deterministic logic separated from AI judgment?", where: "price() in core.ts is the only price authority; strip() renames any AI number to suggested_*; authoritative:false on every recommendation" },
  { q: "Outcome feeds back?", where: "/ai/recommendations/:id/decision + ss_ai_learning view; /jobs/:id/actuals" },
  { q: "Measurable KPI?", where: "ss_estimate_accuracy (hours, material, LF/day, callbacks); recommendations carry kpi; ss_kpis view" },
  { q: "Accommodates substantially better technology?", where: "Provider interface (complete + embed, images optional); capability tags on registry rows (text, vision, embed) drive routing; ss_embeddings stores dims per row so models can be swapped" },
];
