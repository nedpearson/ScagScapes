// Answering the phone (PRODUCT MANDATE 2, 9, 10).
//
// A missed call at Scag Scapes is not a missed call - it is a lead Google already charged $59 for, attached to a
// job worth thousands. This module answers it. Vapi is the first adapter because Ned picked it, NOT because the
// design assumes it: everything below goes through VoiceProvider, the call record is stored in full in Scag's
// own table, and swapping vendor costs a mapping function rather than a rewrite.
//
// What it will not do: book, quote or promise anything on its own authority. The agent gathers, the deterministic
// code books, price() prices. An agent that can invent an appointment is an agent that can invent a wrong one.
import { sb, json, event, msg, price, openSlots, slotStr, book, guessType, tpl } from "./core.ts";
import { attribute } from "./marketing.ts";

export interface VoiceCall {
  provider_call_id: string; direction: "inbound" | "outbound";
  from_number?: string; to_number?: string; status?: string;
  started_at?: string; ended_at?: string; duration_sec?: number;
  ended_reason?: string; recording_url?: string; transcript?: string; summary?: string;
  cost?: number; raw?: any;
}
export interface VoiceProvider {
  id: string;
  verify(req: Request, secret: string | undefined): boolean;   // is this really from the provider?
  kind(body: any): string;                                     // which event is this
  parse(body: any): VoiceCall | null;                          // provider payload -> Scag's shape
}

// ---- Vapi -------------------------------------------------------------------------------------------------
// Vapi posts a `message` envelope with a `type`. The shared secret arrives as a header configured on the
// assistant's server URL; when no secret is set locally the check is skipped and the call is logged as unverified
// rather than silently trusted.
const vapi: VoiceProvider = {
  id: "vapi",
  verify(req, secret) {
    if (!secret) return false;
    const h = req.headers.get("x-vapi-secret") ?? req.headers.get("x-vapi-signature") ?? "";
    return h === secret;
  },
  kind: (b) => b?.message?.type ?? b?.type ?? "unknown",
  parse(b) {
    const m = b?.message ?? b;
    const call = m?.call ?? {};
    const id = call.id ?? m.callId;
    if (!id) return null;
    const art = m.artifact ?? {};
    const startedAt = call.startedAt ?? m.startedAt;
    const endedAt = call.endedAt ?? m.endedAt;
    const dur = startedAt && endedAt ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) : undefined;
    return {
      provider_call_id: String(id),
      direction: (call.type === "outboundPhoneCall" ? "outbound" : "inbound"),
      from_number: call.customer?.number ?? m.customer?.number,
      to_number: call.phoneNumber?.number ?? m.phoneNumber?.number,
      status: m.type === "end-of-call-report" ? "ended" : (m.status ?? call.status),
      started_at: startedAt, ended_at: endedAt, duration_sec: dur,
      ended_reason: m.endedReason ?? call.endedReason,
      recording_url: art.recording?.stereoUrl ?? art.recordingUrl ?? m.recordingUrl,
      transcript: art.transcript ?? m.transcript,
      summary: m.analysis?.summary ?? m.summary,
      cost: typeof m.cost === "number" ? m.cost : (typeof call.cost === "number" ? call.cost : undefined),
      raw: b,
    };
  },
};
export const VOICE: Record<string, VoiceProvider> = { vapi };

// What the caller actually wanted. Deterministic, and the same ladder the SMS side uses for service type, so a
// call and a text about the same problem classify identically.
export function callIntent(text: string): { intent: string; service_type: string; need: string } {
  const s = (text || "").toLowerCase();
  const [ty, need] = guessType(s);
  if (/(emerg|flood|right now|today|urgent)/.test(s)) return { intent: "emergency", service_type: ty, need };
  if (/(quote|estimate|how much|price|cost)/.test(s)) return { intent: "quote_request", service_type: ty, need };
  if (/(resched|cancel|move|change).*(appoint|visit|time)/.test(s)) return { intent: "reschedule", service_type: ty, need };
  if (/(invoice|bill|pay|balance)/.test(s)) return { intent: "billing", service_type: ty, need };
  if (/(warranty|still|again|came back|not draining)/.test(s)) return { intent: "warranty", service_type: ty, need };
  return { intent: "new_inquiry", service_type: ty, need };
}

export async function voice(path: string, req: Request, url: URL, body: any, t: string, settings: any): Promise<Response | null> {
  // ---- the webhook every provider posts into ----
  const w = path.match(/^\/webhooks\/voice\/([a-z]+)$/);
  if (w && req.method === "POST") {
    const prov = VOICE[w[1]];
    if (!prov) return json({ error: "unknown voice provider", known: Object.keys(VOICE) }, 404);
    const secret = Deno.env.get("VOICE_WEBHOOK_SECRET");
    const verified = prov.verify(req, secret);
    if (secret && !verified) return json({ error: "signature check failed" }, 401);

    const kind = prov.kind(body);
    const c = prov.parse(body);
    if (!c) return json({ ok: true, ignored: kind, reason: "no call id in payload" });

    // upsert the call record first - the transcript is Scag's, whatever happens next
    const row: any = { tenant_id: t, provider: prov.id, provider_call_id: c.provider_call_id, direction: c.direction,
      from_number: c.from_number, to_number: c.to_number, status: c.status ?? "in-progress",
      ended_at: c.ended_at ?? null, duration_sec: c.duration_sec ?? null, ended_reason: c.ended_reason ?? null,
      recording_url: c.recording_url ?? null, transcript: c.transcript ?? null, summary: c.summary ?? null,
      cost: c.cost ?? null, raw: verified ? c.raw : { ...c.raw, _unverified: true } };
    if (c.started_at) row.started_at = c.started_at;
    const { data: saved } = await sb.from("ss_voice_calls").upsert(row, { onConflict: "tenant_id,provider,provider_call_id" }).select().single();

    // only act on a finished call - acting mid-call means acting on half a sentence
    if (kind !== "end-of-call-report" && c.status !== "ended") return json({ ok: true, call_id: saved?.id, stage: kind });

    const text = [c.summary, c.transcript].filter(Boolean).join(" ");
    const cls = callIntent(text);
    let lead = null as any;
    if (c.from_number) {
      const { data: found } = await sb.from("ss_leads").select("*").eq("tenant_id", t).eq("phone", c.from_number)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      lead = found;
      if (!lead) {
        const a = attribute({ utm_source: "phone", utm_medium: "call" });
        const { data: made } = await sb.from("ss_leads").insert({
          tenant_id: t, name: c.from_number, phone: c.from_number, area: "—", source: "Answered call",
          service_type: cls.service_type, need: cls.need, status: "new",
          response_seconds: 0,                       // answered live: the wait was zero
          ad_channel: "voice_agent", utm_source: a.utm_source, utm_medium: a.utm_medium,
        }).select().single();
        lead = made;
      }
    }

    const handoff = cls.intent === "emergency" || cls.intent === "warranty" || cls.intent === "billing";
    await sb.from("ss_voice_calls").update({ status: "ended", intent: cls.intent, lead_id: lead?.id ?? null, handoff }).eq("id", saved!.id);

    if (lead) {
      if (c.transcript) await msg(t, lead.id, "cust", `[call] ${String(c.transcript).slice(0, 900)}`);
      // The agent never books. It offers the same slots the rest of the system would, and a human or a reply confirms.
      const slots = await openSlots(t, 2);
      const reply = handoff
        ? `Thanks for calling Scag Scapes — Charlie will call you back personally about this shortly.`
        : `Thanks for calling Scag Scapes. Next open site visits: ${slots.map(slotStr).join(" or ")} — reply with the one that works and I'll lock it in.`;
      await msg(t, lead.id, "sys", reply);
      await event(t, handoff ? "Call answered - needs Charlie" : "Call answered", lead.name,
        `${cls.intent.replace(/_/g, " ")}${c.duration_sec ? ` · ${c.duration_sec}s` : ""}${c.cost ? ` · $${c.cost.toFixed(2)}` : ""}. Text-back sent with two slots.`,
        { type: "lead", id: lead.id });
    }
    return json({ ok: true, call_id: saved?.id, lead_id: lead?.id ?? null, intent: cls.intent, handoff, verified });
  }

  // ---- what the answering layer is doing, measured ----
  if (path === "/voice/performance" && req.method === "GET") {
    const { data: perf } = await sb.from("ss_voice_performance").select("*").eq("tenant_id", t).maybeSingle();
    const { data: recent } = await sb.from("ss_voice_calls").select("id,started_at,from_number,duration_sec,intent,handoff,booked,cost,summary,lead_id,status")
      .eq("tenant_id", t).order("started_at", { ascending: false }).limit(50);
    const configured = !!Deno.env.get("VOICE_WEBHOOK_SECRET");
    return json({
      configured, providers: Object.keys(VOICE),
      // Built from SUPABASE_URL, not from the request: behind the edge proxy url.origin comes back as http and
      // the /functions/v1 prefix is stripped, so the address printed here was one nobody could paste anywhere.
      webhook_url: `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/ss-api/webhooks/voice/vapi`,
      performance: perf ?? { calls: 0, became_lead: 0, total_cost: 0 },
      note: configured ? undefined : "No VOICE_WEBHOOK_SECRET is set, so the webhook accepts unverified posts and marks them so. Set the secret before pointing a real phone number at it.",
      calls: recent ?? [],
    });
  }

  if (path === "/voice/calls" && req.method === "GET") {
    const { data } = await sb.from("ss_voice_calls").select("*").eq("tenant_id", t).order("started_at", { ascending: false }).limit(200);
    return json(data ?? []);
  }
  return null;
}
