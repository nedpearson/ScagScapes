// Go-live readiness (PRODUCT MANDATE 12: no demo-as-production).
//
// The gap between "the demo is convincing" and "the product works for a paying customer" has been living in
// prose - in a chat message and a project doc, where it goes stale the day after it is written. This checks it.
// Every item is evaluated against the live system, says plainly what is wrong, and names the exact thing that
// fixes it. A check that cannot fail is not a check, so each one is derived from state, never asserted.
import { sb, json, integrations } from "./core.ts";
import { PLATFORMS } from "./ads.ts";
import { configured as aiConfigured } from "./ai.ts";

type Level = "blocker" | "warning" | "info";
interface Check { id: string; level: Level; title: string; ok: boolean; detail: string; fix?: string }

export async function readiness(path: string, req: Request, url: URL, t: string): Promise<Response | null> {
  if (path !== "/readiness" || req.method !== "GET") return null;

  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const env = (k: string) => !!Deno.env.get(k);
  const ints = integrations();

  // ---- can it actually talk to a customer? ----
  const { count: simulated } = await sb.from("ss_outbox").select("id", { count: "exact", head: true }).eq("tenant_id", t).eq("status", "simulated");
  const { count: sent } = await sb.from("ss_outbox").select("id", { count: "exact", head: true }).eq("tenant_id", t).neq("status", "simulated");
  add({ id: "sms", level: "blocker", title: "Text messages actually send", ok: ints.twilio,
    detail: ints.twilio
      ? `Twilio is configured. ${sent ?? 0} message(s) have left the system.`
      : `Twilio is NOT configured. Every one of the ${simulated ?? 0} messages on record has status "simulated" - none has ever reached a phone. The text-back that the whole pitch rests on is unproven.`,
    fix: "supabase secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=..." });

  add({ id: "payments", level: "blocker", title: "Deposit links can take money", ok: ints.stripe,
    detail: ints.stripe ? "Stripe is configured." : "Stripe is NOT configured, so a deposit link is a placeholder URL. A customer clicking it cannot pay.",
    fix: "supabase secrets set STRIPE_SECRET_KEY=..." });

  add({ id: "email", level: "warning", title: "Email can send", ok: ints.resend,
    detail: ints.resend ? "Resend is configured." : "No email provider. Quotes and receipts are text-only until one is set.",
    fix: "supabase secrets set RESEND_API_KEY=..." });

  // ---- the thing that decides whether leads survive ----
  const { data: leads } = await sb.from("ss_leads").select("response_seconds").eq("tenant_id", t);
  const total = (leads ?? []).length;
  const answered = (leads ?? []).filter((l: any) => (l.response_seconds ?? 0) > 0).length;
  const pct = total ? Math.round((answered / total) * 100) : null;
  add({ id: "answer_rate", level: "warning", title: "Leads get answered", ok: pct !== null && pct >= 90,
    detail: pct === null ? "No leads recorded yet." : `${pct}% of leads have ever received a reply (${answered} of ${total}). Every unanswered lead was paid for and thrown away.`,
    fix: "Point a phone number at the voice agent, and set VOICE_WEBHOOK_SECRET so the webhook is verified." });

  add({ id: "voice", level: "warning", title: "Inbound calls are answered", ok: env("VOICE_WEBHOOK_SECRET"),
    detail: env("VOICE_WEBHOOK_SECRET") ? "The voice webhook secret is set, so posts are verified." : "VOICE_WEBHOOK_SECRET is unset. The webhook still accepts posts but marks them unverified - fine for testing, wrong for a live number.",
    fix: "supabase secrets set VOICE_WEBHOOK_SECRET=... and put the same value in the provider's server-URL secret header." });

  // ---- the moat ----
  const { count: jobsDone } = await sb.from("ss_jobs").select("id", { count: "exact", head: true }).eq("tenant_id", t).eq("stage", 4);
  const { count: actuals } = await sb.from("ss_job_actuals").select("id", { count: "exact", head: true }).eq("tenant_id", t);
  add({ id: "actuals", level: "warning", title: "Finished jobs record what they really cost", ok: (jobsDone ?? 0) === 0 || (actuals ?? 0) >= (jobsDone ?? 0),
    detail: `${actuals ?? 0} of ${jobsDone ?? 0} completed jobs have actuals recorded. Without them every margin is an estimate and the estimating never improves.`,
    fix: "Enter actuals when a job is marked complete - the app prompts for it at stage 4." });

  // ---- AI, if it is on ----
  const ai = aiConfigured();
  const anyAi = Object.values(ai).some(Boolean);
  const { count: evals } = await sb.from("ss_ai_evals").select("id", { count: "exact", head: true }).eq("tenant_id", t);
  add({ id: "ai_evaluated", level: anyAi ? "blocker" : "info", title: "No model is trusted without a score", ok: !anyAi || (evals ?? 0) > 0,
    detail: anyAi ? `A provider is configured and ${evals ?? 0} eval rows exist.` : "No AI provider configured - the layer is inert and returns records only.",
    fix: 'POST /ai/evals/run with header x-ss-admin before enabling a model on a real tenant.' });

  const { data: tenantRow } = await sb.from("ss_tenants").select("settings").eq("id", t).maybeSingle();
  const smsMode = (tenantRow?.settings as any)?.ai_sms ?? "off";
  add({ id: "ai_sms_mode", level: smsMode === "live" ? "blocker" : "info", title: "A model is not answering customers unsupervised", ok: smsMode !== "live" || (evals ?? 0) > 0,
    detail: `settings.ai_sms is "${smsMode}".` + (smsMode === "live" ? " A model is replying to customers directly - it must have beaten the deterministic baseline first." : ""),
    fix: "Keep it on 'shadow' until reply-01 scores above the baseline and a week of drafts has been read." });

  // ---- operator hygiene ----
  add({ id: "admin_key", level: "warning", title: "Operator key is set", ok: env("SS_ADMIN_KEY"),
    detail: env("SS_ADMIN_KEY") ? "SS_ADMIN_KEY is set." : "SS_ADMIN_KEY is unset, so /ads, /ai/evals/run and the model registry are closed to everyone including the operator.",
    fix: "supabase secrets set SS_ADMIN_KEY=..." });

  add({ id: "tenant_not_demo", level: "blocker", title: "Real work is not running on the demo tenant", ok: t !== "demo",
    detail: t === "demo" ? "This request is on the 'demo' tenant, which is deliberately unauthenticated - anyone can read and write it. It is a sandbox, never a place for a real customer record." : `Running on tenant "${t}", which requires its own key.`,
    fix: "Create a real tenant with its own api_key and point the app at it with x-tenant." });

  // ---- ad spend freshness: a stale figure is worse than none ----
  const { data: spend } = await sb.from("ss_ad_spend").select("period_end").eq("tenant_id", t).order("period_end", { ascending: false }).limit(1);
  const newest = spend?.[0]?.period_end;
  const ageDays = newest ? Math.round((Date.now() - new Date(newest).getTime()) / 864e5) : null;
  const anyPlatform = Object.values(PLATFORMS).some((p) => p.configured());
  add({ id: "ad_spend_fresh", level: "info", title: "Ad spend is current", ok: anyPlatform || (ageDays !== null && ageDays <= 35),
    detail: newest ? `Newest spend record ends ${newest} (${ageDays} days ago).` + (anyPlatform ? " A platform is connected, so it refreshes itself." : " Entered by hand - it will go stale.") : "No ad spend recorded, so cost per lead cannot be computed.",
    fix: "Connect Google Ads or Meta (GET /ads/platforms lists what is missing) so POST /ads/sync keeps it current." });

  const blockers = checks.filter((c) => !c.ok && c.level === "blocker");
  const warnings = checks.filter((c) => !c.ok && c.level === "warning");
  return json({
    tenant: t,
    ready: blockers.length === 0,
    verdict: blockers.length
      ? `Not ready for a paying customer: ${blockers.length} blocker${blockers.length > 1 ? "s" : ""}.`
      : warnings.length ? `Usable, with ${warnings.length} thing${warnings.length > 1 ? "s" : ""} worth fixing first.`
      : "Ready.",
    blockers: blockers.length, warnings: warnings.length,
    checks, checked_at: new Date().toISOString(),
  });
}
