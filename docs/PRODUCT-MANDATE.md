# MASTER PRODUCT MANDATE — SCAG SCAPES COMMAND

Treat this as a permanent, load-bearing requirement for every architecture, feature, database, workflow, integration, and UI decision.

The objective is not to build software that attempts to be "smarter than AI." Build a proprietary operating system for Scag Scapes that becomes more valuable as AI improves.

1. **Own the data; rent the intelligence.** All proprietary business data must remain in Scag Scapes-controlled systems: customers, leads, properties, measurements, photos, scans, estimates, actual job costs, labor hours, materials, equipment, suppliers, pricing, margins, schedules, crews, callbacks, warranty issues, communications, reviews, weather impacts and job outcomes. Never make an AI provider the system of record.
2. **Maintain a model-agnostic AI layer.** Do not tightly couple core workflows to Claude, OpenAI, Gemini or any single model/provider. Create an abstraction/router allowing models to be added, removed, compared and upgraded without rewriting the application. Route tasks to the best available model based on capability, accuracy, latency, privacy and cost.
3. **Continuously evaluate models.** Build a versioned evaluation suite using real Scag Scapes tasks. Test models against estimating, photo interpretation, scope generation, material takeoffs, scheduling, routing, equipment troubleshooting, supplier searches, customer communication, job-risk detection and other AI workflows. Never upgrade a production model merely because a provider says it is better. Promote it only when measured results justify the change.
4. **Create the proprietary data moat.** Every completed job should make the system better. Preserve estimate vs. actual cost, predicted vs. actual labor, material usage/waste, equipment failures, supplier performance, weather, property conditions, change orders, margin, callbacks and customer outcomes. Build structured feedback loops from these results.
5. **Separate deterministic business logic from probabilistic AI.** Pricing rules, accounting math, permissions, inventory transactions, contractual values and other deterministic operations must not depend on an LLM guessing the answer. AI may analyze and recommend; authoritative calculations use validated application logic.
6. **AI recommendations require evidence.** Where practical, show the data/source behind recommendations, confidence, assumptions and alternatives. Never fabricate real-time prices, inventory, rental availability, appointments, supplier information or geographic information. Real-time claims require verified live sources.
7. **Build universal real-time search.** Search should intelligently combine internal Scag Scapes data with authorized external sources for suppliers, materials, equipment rentals, repairs, replacement equipment, availability, pricing, travel time and other operational requirements. Optimize recommendations across total cost, distance, availability, job delay and convenience — not merely cheapest advertised price.
8. **Build closed-loop learning.** Capture whether AI recommendations were accepted, modified or rejected and what actually happened. Use outcomes to improve prompts, retrieval, rules, models and future recommendations. Maintain evaluation history rather than allowing uncontrolled self-modification.
9. **Preserve human control.** AI can recommend and automate low-risk work, but consequential actions must have appropriate authorization, audit trails, rollback/idempotency and clear ownership.
10. **Design for future capabilities that do not exist yet.** Use modular interfaces for AI models, computer vision, voice, mapping, robotics, drones, autonomous equipment, IoT/sensors and external agents so substantially better technology can be integrated rather than forcing a rewrite.
11. **Build an operational knowledge graph.** Connect Customer → Property → Lead → Estimate → Scope → Job → Crew → Materials → Equipment → Supplier → Cost → Revenue → Margin → Outcome. AI should retrieve this business context rather than operate from isolated prompts.
12. **Never confuse an AI demo with a production feature.** Every AI feature requires measurable acceptance criteria covering accuracy, hallucination/failure behavior, latency, cost, security, offline/degraded behavior where applicable, auditability and human fallback.
13. **Continuously identify obsolescence risk.** Whenever implementing or auditing the product, identify functionality that a new foundation model, agent, robotics system or external platform could commoditize. Do not merely duplicate commodity AI capability. Move product value toward proprietary data, workflows, integrations, execution and accumulated operational knowledge.
14. **Measure the business outcome.** Track whether each major capability improves metrics such as lead conversion, quote turnaround, gross margin, labor utilization, drive time, material waste, equipment downtime, callbacks, customer satisfaction and revenue per employee.
15. **Protect portability.** Proprietary business data, embeddings/indexes where practical, prompts, evaluations, workflow definitions and business rules must be exportable and documented. Avoid architectural decisions that unnecessarily lock Scag Scapes into one AI vendor.

## NON-NEGOTIABLE AUDIT

Before declaring any feature complete, ask:

1. Does this create or capture proprietary Scag Scapes knowledge?
2. Does it become better when future AI models improve?
3. Can the underlying AI provider be replaced?
4. Are real-world claims verified rather than hallucinated?
5. Is deterministic logic separated from AI judgment?
6. Does the outcome feed back into the system?
7. Is there a measurable business KPI?
8. Does the architecture accommodate technology substantially better than today's?

If any answer is no, address the architectural gap before considering the feature production-ready.

Do not simply assert these requirements are satisfied. Inspect the implementation and prove them: for every requirement report `Implemented / Partial / Missing`, cite the exact implementation evidence, identify the gap, and make the necessary changes. Do not replace working functionality unnecessarily.

The machine-readable self-check is served at `GET /ai/audit`. The latest human audit is `docs/MANDATE-AUDIT.md`.
