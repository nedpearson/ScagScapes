// ---------- drive time, and an honest answer when there is none ----------
//
// Every distance in field ops was straight-line (`miles()` in sourcing.ts). Straight-line is not wrong, it is
// *optimistic in a way that changes decisions*: recovery ranking weights distance at 15% and time-to-work at 30%,
// so the error lands on both axes and can pick the wrong vendor.
//
// How wrong: measured against OSRM over 26 real Baton Rouge destinations (`tools/measure-road-factor.py`,
// run 2026-09-21, table in docs/FIELD-OPS.md §11). Median road ÷ crow = 1.23. But the median hides the finding
// that matters for this business:
//
//   Port Allen centre      1.4 crow mi →  3.6 road mi   (2.65×)
//   Lowe's Port Allen      1.7 crow mi →  4.3 road mi   (2.49×)
//
// Anything across the Mississippi is roughly double what the crow flies, because there is one bridge. Port Allen
// is a named Scag market. Straight-line was quietly telling the crew a west-bank vendor was the closest option
// when it was not. No constant can fix that — only a real route knows where the bridge is — which is the reason
// this module exists rather than a tuned multiplier.
//
// So: route when we can, and when we cannot, say ESTIMATED and carry the caveat rather than a false precision.
import { miles } from "./sourcing.ts";
import { STATUS } from "./core.ts";

// Measured medians, n = 26, Baton Rouge metro, 2026-09-21. Reproduce with tools/measure-road-factor.py.
export const ROAD_FACTOR = 1.23;
// Speed rises with trip length (surface streets → Airline/I-10). Banded on the same sample.
const BANDS: [number, number][] = [[5, 30.5], [12, 35.7], [Infinity, 45.6]];
export const mphFor = (crowMi: number) => BANDS.find(([hi]) => crowMi < hi)![1];

export type Leg = {
  distance_mi: number;
  minutes: number;
  status: string;                 // LIVE_VERIFIED when routed, ESTIMATED when derived
  source: string;
  method: string;
  checked_at: string;
  crow_mi: number;
  caveat?: string;
};

const OSRM = "https://router.project-osrm.org";
const UA = "ScagScapesCommand/1.6 (+https://scagscapes.bridgebox.ai)";

// Rough test: does the straight line between the two points cross the Mississippi near Baton Rouge? The river
// runs about north-south through lng ≈ -91.19 to -91.21 here, so a leg whose endpoints sit on opposite sides of
// it is a bridge trip. Used ONLY to attach a caveat to an estimate — never to invent a number.
const RIVER_LNG = -91.195;
const crossesRiver = (aLng: number, bLng: number) => (aLng < RIVER_LNG) !== (bLng < RIVER_LNG);

/** Straight-line → road estimate. Always succeeds, never claims to be a route. */
export function estimateLeg(aLat: number, aLng: number, bLat: number, bLng: number): Leg {
  const crow = miles(aLat, aLng, bLat, bLng);
  const bridge = crossesRiver(aLng, bLng);
  const road = Math.round(crow * ROAD_FACTOR * 10) / 10;
  return {
    distance_mi: road,
    minutes: Math.max(1, Math.round((road / mphFor(crow)) * 60)),
    status: STATUS.EST,
    source: `straight-line × ${ROAD_FACTOR} road factor (measured, Baton Rouge, n=26)`,
    method: "haversine + banded road factor — no route was computed",
    checked_at: new Date().toISOString(),
    crow_mi: crow,
    caveat: bridge
      ? "This leg crosses the Mississippi. Measured river crossings run about 2.5× straight-line, not 1.23× — treat this distance as a floor and confirm before committing a crew."
      : undefined,
  };
}

async function fetchT(url: string, ms = 6000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal, headers: { "user-agent": UA, accept: "application/json" } }); }
  finally { clearTimeout(id); }
}

/**
 * One origin → many destinations in a single OSRM table call.
 * Returns a Leg per destination, in the order given. A destination OSRM cannot reach, or a failed/slow call,
 * degrades to estimateLeg() for that row only — every other row keeps its real route.
 */
export async function driveTimes(
  from: { lat: number; lng: number },
  to: { lat: number | null; lng: number | null }[],
): Promise<Leg[]> {
  const fallback = (): Leg[] => to.map((d) =>
    d.lat == null || d.lng == null
      ? { distance_mi: 0, minutes: 0, crow_mi: 0, status: STATUS.EST, source: "no coordinates on this vendor", method: "none", checked_at: new Date().toISOString(), caveat: "Distance unknown — this vendor has no position on record." }
      : estimateLeg(from.lat, from.lng, d.lat, d.lng));

  const usable = to.map((d, i) => ({ d, i })).filter((x) => x.d.lat != null && x.d.lng != null);
  if (!usable.length) return fallback();
  // OSRM's public demo server is rate-limited and not intended for bulk use; one table call per breakdown or
  // per search is within its policy. Anything larger stays on estimates rather than hammering someone's server.
  if (usable.length > 90) return fallback();

  const coords = [`${from.lng},${from.lat}`, ...usable.map((x) => `${x.d.lng},${x.d.lat}`)].join(";");
  const dests = usable.map((_, n) => n + 1).join(";");
  const url = `${OSRM}/table/v1/driving/${coords}?sources=0&destinations=${dests}&annotations=duration,distance`;

  try {
    const r = await fetchT(url);
    if (!r.ok) return fallback();
    const j = await r.json();
    if (j.code !== "Ok" || !j.durations?.[0] || !j.distances?.[0]) return fallback();
    const durs: (number | null)[] = j.durations[0];
    const dists: (number | null)[] = j.distances[0];
    const now = new Date().toISOString();

    const out = fallback();                                  // start from honest estimates
    usable.forEach((x, n) => {
      const sec = durs[n], m = dists[n];
      if (sec == null || m == null) return;                  // unroutable destination keeps its estimate
      out[x.i] = {
        distance_mi: Math.round((m / 1609.344) * 10) / 10,
        minutes: Math.max(1, Math.round(sec / 60)),
        status: STATUS.LIVE,
        source: "OSRM public routing (OpenStreetMap road network)",
        method: "OSRM /table/v1/driving",
        checked_at: now,
        crow_mi: miles(from.lat, from.lng, x.d.lat as number, x.d.lng as number),
      };
    });
    return out;
  } catch {
    return fallback();                                       // network/timeout → estimates, never a made-up route
  }
}

/** Convenience for a single leg. */
export async function driveTime(from: { lat: number; lng: number }, to: { lat: number | null; lng: number | null }): Promise<Leg> {
  return (await driveTimes(from, [to]))[0];
}
