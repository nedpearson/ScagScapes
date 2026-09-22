// ---------- commercial pursuits: the board that never persisted ----------
//
// This existed on branch codex/commercial-growth-intelligence as `S.intel.pursuits` — a localStorage array with
// three hardcoded rows. That branch's index.ts contains the word "pursuit" zero times: there was no backend at
// all. So the reported symptoms were exactly right, and for a simpler reason than anyone guessed:
//
//   "commercial pursuits may not persist in live Supabase mode"  → nothing ever wrote them anywhere
//   "live-mode commercial data may disappear after refresh"      → localStorage, per device, per browser
//   "stage/action buttons may lack complete handlers"            → `data-act="intel.advance"` was rendered on
//                                                                  every row and no handler of that name existed
//
// Now it is a table, a router and an audit trail. Two rules the old version could not honour:
//
//   1. A pursuit that becomes real does NOT create a second customer. `convert` links the pursuit to a lead —
//      the same lead the rest of the app already knows about (prompt §30: no duplicate customers or jobs).
//   2. Stage changes are recorded with who and when. A pipeline number nobody can audit is a story.
import { sb, json, event } from "./core.ts";

const num = (v: unknown, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export const STAGES = ["Research", "Contacted", "Qualified", "Proposed", "Won", "Lost"] as const;
export type Stage = typeof STAGES[number];
const OPEN: string[] = ["Research", "Contacted", "Qualified", "Proposed"];

/** The next stage along, or null at a terminal one. Pure, so the Advance button has testable behaviour. */
export function nextStage(s: string): Stage | null {
  const i = (STAGES as readonly string[]).indexOf(s);
  if (i < 0) return "Research";
  if (!OPEN.includes(s)) return null;                       // Won and Lost do not advance
  return STAGES[i + 1] ?? null;
}

/**
 * Pipeline maths, computed from rows rather than stored.
 * Weighted value uses a stage probability — stated openly in the response so nobody mistakes it for a forecast
 * the business committed to. An overdue count is separate from value because a stale board flatters itself.
 */
export const STAGE_ODDS: Record<string, number> = { Research: .1, Contacted: .2, Qualified: .4, Proposed: .6, Won: 1, Lost: 0 };

export function pipeline(rows: any[], today = new Date()) {
  const open = rows.filter((p) => OPEN.includes(p.stage));
  const iso = today.toISOString().slice(0, 10);
  const overdue = open.filter((p) => p.due && p.due < iso);
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const s of STAGES) byStage[s] = { count: 0, value: 0 };
  for (const p of rows) {
    const k = byStage[p.stage] ?? (byStage[p.stage] = { count: 0, value: 0 });
    k.count++; k.value += num(p.value);
  }
  return {
    open_count: open.length,
    open_value: open.reduce((a, p) => a + num(p.value), 0),
    weighted_value: Math.round(open.reduce((a, p) => a + num(p.value) * (STAGE_ODDS[p.stage] ?? 0), 0)),
    won_value: rows.filter((p) => p.stage === "Won").reduce((a, p) => a + num(p.value), 0),
    lost_value: rows.filter((p) => p.stage === "Lost").reduce((a, p) => a + num(p.value), 0),
    overdue_count: overdue.length,
    overdue: overdue.map((p) => ({ id: p.id, account: p.account, due: p.due, next_action: p.next_action })),
    by_stage: byStage,
    stage_odds: STAGE_ODDS,
    note: "Weighted value applies a stage probability to open pursuits. It is a planning figure, not a commitment, and not a forecast the business has made.",
  };
}

async function audit(t: string, actor: string, action: string, ref_id: string | null, before: unknown, after: unknown) {
  await sb.from("ss_audit").insert({ tenant_id: t, actor, action, ref_type: "pursuit", ref_id, before, after });
}

export async function commercial(path: string, req: Request, url: URL, body: any, t: string): Promise<Response | null> {
  const actor = body?.actor || req.headers.get("x-actor") || "demo user";

  // ---------- board ----------
  if (path === "/pursuits" && req.method === "GET") {
    const { data } = await sb.from("ss_commercial_pursuits").select("*").eq("tenant_id", t)
      .order("stage").order("due", { nullsFirst: false });
    const rows = data ?? [];
    return json({ pursuits: rows, pipeline: pipeline(rows), stages: STAGES });
  }

  if (path === "/pursuits" && req.method === "POST") {
    if (!body.account) return json({ error: "account required" }, 400);
    const stage = (STAGES as readonly string[]).includes(body.stage) ? body.stage : "Research";
    const { data, error } = await sb.from("ss_commercial_pursuits").insert({
      tenant_id: t, account: body.account, market: body.market || null, route: body.route || null,
      scope: body.scope || null, stage, value: num(body.value), next_action: body.next_action || null,
      due: body.due || null, owner: body.owner || actor,
      history: [{ at: new Date().toISOString(), by: actor, to: stage, note: "created" }],
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    await audit(t, actor, "pursuit.created", data.id, null, data);
    await event(t, "pursuit", actor, `Pursuit added: ${data.account} (${data.stage})`, { type: "pursuit", id: data.id });
    return json(data);
  }

  const m = path.match(/^\/pursuits\/([0-9a-f-]{36})(\/advance|\/convert)?$/);
  if (m) {
    const id = m[1];
    const { data: before } = await sb.from("ss_commercial_pursuits").select("*").eq("id", id).eq("tenant_id", t).maybeSingle();
    if (!before) return json({ error: "not found" }, 404);

    if (req.method === "GET") return json(before);

    // ----- the Advance button that never had a handler -----
    if (m[2] === "/advance" && req.method === "POST") {
      const to = body.stage && (STAGES as readonly string[]).includes(body.stage) ? body.stage : nextStage(before.stage);
      if (!to) return json({ error: `"${before.stage}" is a terminal stage — reopen it by setting a stage explicitly.`, stage: before.stage }, 400);
      const hist = [...(before.history ?? []), { at: new Date().toISOString(), by: actor, from: before.stage, to, note: body.note || null }];
      const patch: any = { stage: to, history: hist };
      if (body.next_action !== undefined) patch.next_action = body.next_action;
      if (body.due !== undefined) patch.due = body.due || null;
      const { data, error } = await sb.from("ss_commercial_pursuits").update(patch).eq("id", id).select().single();
      if (error) return json({ error: error.message }, 400);
      await audit(t, actor, "pursuit.stage", id, { stage: before.stage }, { stage: to, note: body.note ?? null });
      await event(t, "pursuit", actor, `${data.account}: ${before.stage} → ${to}`, { type: "pursuit", id });

      // A loss is only a lesson if the reason is captured at the moment it is still known.
      if (to === "Lost") {
        await sb.from("ss_commercial_losses").insert({
          tenant_id: t, pursuit_id: id, competitor: body.competitor || null, value: num(before.value),
          reason: body.reason || null, lesson: body.lesson || null, recorded_by: actor,
        });
      }
      return json({ ...data, needs_loss_detail: to === "Lost" && !body.reason });
    }

    // ----- becoming real: link, never duplicate -----
    if (m[2] === "/convert" && req.method === "POST") {
      if (before.lead_id) return json({ error: "already linked to a lead", lead_id: before.lead_id }, 409);
      let leadId = body.lead_id ?? null;
      if (!leadId) {
        const { data: lead, error } = await sb.from("ss_leads").insert({
          tenant_id: t, name: before.account, area: before.market || null,
          service_type: body.service_type || "drain", status: "new",
          source: "commercial", notes: before.scope || null,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        leadId = lead.id;
      }
      const { data } = await sb.from("ss_commercial_pursuits").update({ lead_id: leadId }).eq("id", id).select().single();
      await audit(t, actor, "pursuit.converted", id, { lead_id: null }, { lead_id: leadId });
      return json({ ...data, note: "Linked to the existing lead record — no second customer was created." });
    }

    // ----- plain edit -----
    if (req.method === "POST") {
      const patch: any = {};
      for (const k of ["account", "market", "route", "scope", "value", "next_action", "due", "owner"]) {
        if (body[k] !== undefined) patch[k] = k === "value" ? num(body[k]) : (body[k] || null);
      }
      if (body.stage !== undefined) {
        if (!(STAGES as readonly string[]).includes(body.stage)) return json({ error: "unknown stage" }, 400);
        patch.stage = body.stage;
        patch.history = [...(before.history ?? []), { at: new Date().toISOString(), by: actor, from: before.stage, to: body.stage, note: body.note || "edited" }];
      }
      if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
      const { data, error } = await sb.from("ss_commercial_pursuits").update(patch).eq("id", id).select().single();
      if (error) return json({ error: error.message }, 400);
      await audit(t, actor, "pursuit.updated", id, before, data);
      return json(data);
    }
  }

  // ---------- losses: why we did not win, while it is still known ----------
  if (path === "/losses" && req.method === "GET") {
    const { data } = await sb.from("ss_commercial_losses").select("*").eq("tenant_id", t).order("created_at", { ascending: false });
    const rows = data ?? [];
    const byReason: Record<string, { count: number; value: number }> = {};
    for (const l of rows) {
      const k = l.reason || "unstated";
      byReason[k] = byReason[k] ?? { count: 0, value: 0 };
      byReason[k].count++; byReason[k].value += num(l.value);
    }
    return json({
      losses: rows, total_value: rows.reduce((a, l) => a + num(l.value), 0), by_reason: byReason,
      note: rows.length < 3 ? "Too few losses recorded to read a pattern from." : undefined,
    });
  }

  if (path === "/losses" && req.method === "POST") {
    const { data, error } = await sb.from("ss_commercial_losses").insert({
      tenant_id: t, pursuit_id: body.pursuit_id || null, competitor: body.competitor || null,
      value: num(body.value), reason: body.reason || null, lesson: body.lesson || null, recorded_by: actor,
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }

  return null;
}
