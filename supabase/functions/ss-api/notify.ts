// ---------- notification routing: urgency, quiet hours, acknowledgement, escalation ----------
//
// Until now `notify()` was three identical private copies (fieldops.ts, sourcing.ts, resources.ts) that wrote a
// row and fanned out a push to everyone, always, at any hour. Two consequences worth fixing:
//
//   1. A rental-return reminder woke the same phones at 2am as a machine down with a crew standing on site.
//      People who are woken by trivia stop reading the important ones. Quiet hours are not a nicety; they are
//      what keeps the critical notification credible.
//   2. Nothing ever checked that a critical notice was *read*. "Approval needed" could sit unseen while a crew
//      billed hours doing nothing. A notification no one acknowledged is not a notification, it is a log line.
//
// So: every notice carries an urgency, quiet hours defer anything below critical to the morning, critical ones
// require acknowledgement, and an unacknowledged critical escalates to the next role up on a timer.
//
// Escalation runs from GET /notifications/escalate, called on app load like /rentals/due, and is idempotent by
// the escalated_at stamp — calling it ten times in a minute escalates once.
import { sb, pushAll } from "./core.ts";

export type Urgency = "critical" | "high" | "normal" | "low";

// Which roles should see a kind of notice, and how fast it has to be acknowledged before it climbs.
export const URGENCY: Record<string, { urgency: Urgency; roles: string[]; escalate_after_min?: number; escalate_to?: string }> = {
  "breakdown.safety":    { urgency: "critical", roles: ["crew_lead", "pm", "admin"], escalate_after_min: 10, escalate_to: "admin" },
  "breakdown.filed":     { urgency: "high",     roles: ["pm", "admin"],              escalate_after_min: 30, escalate_to: "admin" },
  "approval.requested":  { urgency: "critical", roles: ["pm", "admin"],              escalate_after_min: 20, escalate_to: "admin" },
  "approval.decided":    { urgency: "high",     roles: ["crew_lead", "pm", "admin"] },
  "readiness.red":       { urgency: "high",     roles: ["crew_lead", "pm"],          escalate_after_min: 45, escalate_to: "pm" },
  "readiness.exception": { urgency: "high",     roles: ["pm", "admin"] },
  "outcome.recorded":    { urgency: "normal",   roles: ["pm", "admin"] },
  "reservation":         { urgency: "normal",   roles: ["pm", "admin"] },
  "rental.due":          { urgency: "low",      roles: ["pm", "admin"] },
  "rental.overdue":      { urgency: "high",     roles: ["pm", "admin"],              escalate_after_min: 240, escalate_to: "admin" },
};

export const DEFAULT_PREFS = {
  quiet_start: 21,          // 9pm, tenant local
  quiet_end: 6,             // 6am
  quiet_min_urgency: "critical" as Urgency,   // only this and above break quiet hours
  tz_offset: -5,            // America/Chicago, CDT. Stored per tenant so it is not a US assumption in code.
  escalation_enabled: true,
  channels: { critical: ["push", "sms", "in_app"], high: ["push", "in_app"], normal: ["in_app"], low: ["in_app"] } as Record<Urgency, string[]>,
};

const RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export function prefsFor(settings: any) {
  const p = settings?.notifications ?? {};
  return { ...DEFAULT_PREFS, ...p, channels: { ...DEFAULT_PREFS.channels, ...(p.channels ?? {}) } };
}

/** Is `at` inside the tenant's quiet window? Handles a window that crosses midnight. */
export function inQuietHours(at: Date, prefs: { quiet_start: number; quiet_end: number; tz_offset: number }) {
  const local = new Date(at.getTime() + prefs.tz_offset * 3600_000);
  const h = local.getUTCHours();
  const { quiet_start: s, quiet_end: e } = prefs;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/** When a deferred notice should surface: the next quiet_end, tenant local. */
export function deferUntil(at: Date, prefs: { quiet_end: number; tz_offset: number }) {
  const local = new Date(at.getTime() + prefs.tz_offset * 3600_000);
  const out = new Date(local);
  out.setUTCHours(prefs.quiet_end, 0, 0, 0);
  if (out <= local) out.setUTCDate(out.getUTCDate() + 1);
  return new Date(out.getTime() - prefs.tz_offset * 3600_000);
}

/** The single decision: does this go out now, and on what channels. Pure, so it is testable. */
export function route(kind: string, at: Date, settings: any) {
  const spec = URGENCY[kind] ?? { urgency: "normal" as Urgency, roles: ["pm", "admin"] };
  const prefs = prefsFor(settings);
  const quiet = inQuietHours(at, prefs);
  const breaks = RANK[spec.urgency] >= RANK[prefs.quiet_min_urgency as Urgency];
  const deferred = quiet && !breaks;
  return {
    urgency: spec.urgency,
    roles: spec.roles,
    channels: deferred ? ["in_app"] : (prefs.channels[spec.urgency] ?? ["in_app"]),
    deferred,
    deferred_to: deferred ? deferUntil(at, prefs).toISOString() : null,
    needs_ack: spec.urgency === "critical",
    escalate_after_min: prefs.escalation_enabled ? (spec.escalate_after_min ?? null) : null,
    escalate_to: spec.escalate_to ?? null,
    why: deferred
      ? `Quiet hours ${prefs.quiet_start}:00–${prefs.quiet_end}:00; ${spec.urgency} is below the ${prefs.quiet_min_urgency} threshold, so it waits in the app until morning.`
      : quiet ? `Quiet hours, but ${spec.urgency} breaks through.` : `Sent on ${(prefs.channels[spec.urgency] ?? ["in_app"]).join(", ")}.`,
  };
}

/** Write the notice and fan out according to the routing decision. Replaces the three private notify() copies. */
export async function notify(
  t: string, kind: string, title: string, body: string,
  ref?: { type: string; id: string },
  settings?: any,
) {
  const now = new Date();
  const r = route(kind, now, settings);
  const { data } = await sb.from("ss_notifications").insert({
    tenant_id: t, kind, title, body, ref_type: ref?.type, ref_id: ref?.id,
    urgency: r.urgency, roles: r.roles, channels: r.channels,
    deferred_to: r.deferred_to, needs_ack: r.needs_ack,
    escalate_after_min: r.escalate_after_min, escalate_to: r.escalate_to,
  }).select().maybeSingle();

  if (!r.deferred && r.channels.includes("push")) pushAll(t, title, body, ref).catch(() => {});
  return { ...data, routing: r };
}

/**
 * Climb anything critical that nobody acknowledged in time, and release anything quiet hours held back.
 * Idempotent: a row is escalated at most once (escalated_at), and a released row simply clears deferred_to.
 */
export async function runEscalation(t: string, settings?: any) {
  const now = new Date(), nowIso = now.toISOString();
  const released: any[] = [], escalated: any[] = [];

  // 1. quiet hours are over for these
  const { data: due } = await sb.from("ss_notifications").select("*")
    .eq("tenant_id", t).not("deferred_to", "is", null).lte("deferred_to", nowIso);
  for (const n of due ?? []) {
    await sb.from("ss_notifications").update({ deferred_to: null }).eq("id", n.id);
    if ((n.channels ?? []).includes("push")) pushAll(t, n.title, n.body, n.ref_type ? { type: n.ref_type, id: n.ref_id } : undefined).catch(() => {});
    released.push({ id: n.id, title: n.title });
  }

  // 2. unacknowledged criticals past their window
  const { data: open } = await sb.from("ss_notifications").select("*")
    .eq("tenant_id", t).eq("needs_ack", true).is("ack_at", null).is("escalated_at", null)
    .not("escalate_after_min", "is", null);
  for (const n of open ?? []) {
    const ageMin = (now.getTime() - new Date(n.created_at).getTime()) / 60000;
    if (ageMin < n.escalate_after_min) continue;
    await sb.from("ss_notifications").update({ escalated_at: nowIso }).eq("id", n.id);
    const title = `ESCALATED · ${n.title}`;
    const body = `No acknowledgement in ${n.escalate_after_min} min. ${n.body}`;
    await sb.from("ss_notifications").insert({
      tenant_id: t, kind: n.kind, title, body, ref_type: n.ref_type, ref_id: n.ref_id,
      urgency: "critical", roles: [n.escalate_to ?? "admin"], channels: ["push", "sms", "in_app"],
      needs_ack: true, escalated_from: n.id,
    });
    pushAll(t, title, body, n.ref_type ? { type: n.ref_type, id: n.ref_id } : undefined).catch(() => {});
    escalated.push({ id: n.id, title: n.title, waited_min: Math.round(ageMin), to: n.escalate_to ?? "admin" });
  }

  return {
    released, escalated,
    checked_at: nowIso,
    note: escalated.length
      ? `${escalated.length} critical notice(s) went unacknowledged and were escalated.`
      : "Nothing overdue.",
  };
}
