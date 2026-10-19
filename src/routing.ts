import type { Coordinate } from './types';

export const ROUTER_URL = 'https://valhalla1.openstreetmap.de/route';

export function haversineKm(a: Coordinate, b: Coordinate) {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const la1 = (a.latitude * Math.PI) / 180;
  const la2 = (b.latitude * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Valhalla's default encoded shape is polyline6. Decode without an extra package.
export function decodePolyline6(encoded: string): Coordinate[] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: Coordinate[] = [];
  const factor = 1e6;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return coordinates;
}

// ---------------------------------------------------------------------------
// Circular routes
//
// Valhalla has no round-trip mode, so a loop is built by placing a few waypoints on a rough polygon that passes
// through the start, then routing start → waypoints → start. Few waypoints means long, straight legs. Several
// candidates are routed in different directions and the one with the fewest turns (and least doubling back) wins;
// the rest are kept for Shuffle.

export type LoopRoute = {
  targetKm: number;
  distanceKm: number;
  durationMin: number;
  geometry: Coordinate[];
  waypoints: Coordinate[];
  /** Left/right/sharp/U-turns in the walking directions; slight bends and "keep left/right" aren't counted. */
  turns: number;
  /** Share of the distance that walks back over streets already used (0–1). */
  retrace: number;
  /** Compass direction the loop heads out in, so Shuffle can try somewhere new. */
  bearing: number;
};

export const LOOP_TOLERANCE = 0.12;
// Walking distance over straight-line distance in a typical street network. Recalibrated per area after the first try.
const ROAD_FACTOR_GUESS = 1.35;
const TURN_TYPES = new Set([10, 11, 12, 13, 14, 15]); // right, sharp right, U-turn ×2, sharp left, left
const REQUEST_TIMEOUT_MS = 25000;

function destination(origin: Coordinate, bearingDeg: number, km: number): Coordinate {
  const d = km / 6371;
  const b = (bearingDeg * Math.PI) / 180;
  const la1 = (origin.latitude * Math.PI) / 180;
  const lo1 = (origin.longitude * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { latitude: (la2 * 180) / Math.PI, longitude: ((((lo2 * 180) / Math.PI) + 540) % 360) - 180 };
}

function angleBetween(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** A random bearing as far as possible from the ones already tried. */
function freshBearing(used: number[]) {
  if (!used.length) return Math.random() * 360;
  let best = 0;
  let bestGap = -1;
  for (let i = 0; i < 16; i++) {
    const candidate = Math.random() * 360;
    const gap = Math.min(...used.map((u) => angleBetween(u, candidate)));
    if (gap > bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

type Plan = { bearing: number; waypoints: Coordinate[]; straightKm: number };

function planLoop(start: Coordinate, targetKm: number, bearing: number, roadFactor: number): Plan {
  // Triangles and squares: the fewest corners that still make a loop rather than an out-and-back.
  const corners = Math.random() < 0.5 ? 3 : 4;
  const perimeterPerRadius = 2 * corners * Math.sin(Math.PI / corners);
  const radius = targetKm / (roadFactor * perimeterPerRadius);
  const center = destination(start, bearing, radius);
  const direction = Math.random() < 0.5 ? 1 : -1;
  const jitter = (range: number) => (Math.random() * 2 - 1) * range;

  const waypoints: Coordinate[] = [];
  for (let k = 1; k < corners; k++) {
    const angle = bearing + 180 + direction * (k * (360 / corners) + jitter(12));
    waypoints.push(destination(center, angle, radius * (1 + jitter(0.1))));
  }
  const ring = [start, ...waypoints, start];
  let straightKm = 0;
  for (let i = 1; i < ring.length; i++) straightKm += haversineKm(ring[i - 1], ring[i]);
  return { bearing, waypoints, straightKm };
}

/** Share of the walk that goes back over ground covered more than 250 m earlier, sampled every ~20 m. */
function retraceShare(geometry: Coordinate[]) {
  const cellDeg = 0.00025; // ≈ 28 m of latitude
  const seen = new Map<string, number>();
  let along = 0;
  let total = 0;
  let retraced = 0;
  const visit = (p: Coordinate, stepKm: number) => {
    const lonCell = cellDeg / Math.max(0.2, Math.cos((p.latitude * Math.PI) / 180));
    const key = `${Math.round(p.latitude / cellDeg)}:${Math.round(p.longitude / lonCell)}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, along);
    else if (along - first > 0.25) retraced += stepKm;
  };
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const segKm = haversineKm(a, b);
    const steps = Math.max(1, Math.ceil(segKm / 0.02));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      along += segKm / steps;
      visit({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t }, segKm / steps);
    }
    total += segKm;
  }
  return total > 0 ? retraced / total : 0;
}

async function routePlan(start: Coordinate, targetKm: number, plan: Plan): Promise<LoopRoute | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        locations: [
          { lat: start.latitude, lon: start.longitude },
          // "through" points don't split the route or allow a U-turn there, so the loop flows past each corner.
          ...plan.waypoints.map((w) => ({ lat: w.latitude, lon: w.longitude, type: 'through' })),
          { lat: start.latitude, lon: start.longitude },
        ],
        costing: 'pedestrian',
        directions_type: 'maneuvers',
        units: 'kilometers',
        shape_format: 'polyline6',
      }),
    });
    // 400s mean no walkable path for this shape (water, private land…); another direction may work.
    if (response.status >= 400 && response.status < 500) return null;
    if (!response.ok) throw new Error(`Routing service returned ${response.status}.`);
    const data = await response.json();
    const legs: any[] = data.trip?.legs ?? [];
    if (!legs.length) return null;

    const geometry: Coordinate[] = [];
    let turns = 0;
    legs.forEach((leg, index) => {
      const decoded = decodePolyline6(leg.shape);
      geometry.push(...(index ? decoded.slice(1) : decoded));
      for (const m of leg.maneuvers ?? []) if (TURN_TYPES.has(m.type)) turns++;
    });
    return {
      targetKm,
      distanceKm: Number(data.trip.summary?.length ?? 0),
      durationMin: Number(data.trip.summary?.time ?? 0) / 60,
      geometry,
      waypoints: plan.waypoints,
      turns,
      retrace: retraceShare(geometry),
      bearing: plan.bearing,
    };
  } finally {
    clearTimeout(timer);
  }
}

function distanceError(route: LoopRoute) {
  return Math.abs(route.distanceKm - route.targetKm) / route.targetKm;
}

function score(route: LoopRoute) {
  // Fewest turns first; doubling back and missing the distance make a loop worse.
  return (route.turns + 1) * (1 + 2 * route.retrace) * (1 + distanceError(route));
}

/**
 * Find circular walks of about `targetKm` that start and end at `start`, best first.
 * `usedBearings` is updated with every direction tried so later calls (Shuffle) explore new ones.
 */
export async function findLoops(start: Coordinate, targetKm: number, usedBearings: number[]): Promise<LoopRoute[]> {
  const found: LoopRoute[] = [];
  const straightKm = new Map<LoopRoute, number>();
  const attempt = async (bearing: number, roadFactor: number) => {
    usedBearings.push(bearing);
    const plan = planLoop(start, targetKm, bearing, roadFactor);
    const route = await routePlan(start, targetKm, plan);
    if (route) {
      found.push(route);
      straightKm.set(route, plan.straightKm);
    }
    return { route, plan };
  };
  const observedFactor = (route: LoopRoute) => Math.min(3, Math.max(1.05, route.distanceKm / straightKm.get(route)!));

  // 1. One loop to learn how winding the streets are here.
  let roadFactor = ROAD_FACTOR_GUESS;
  let first = await attempt(freshBearing(usedBearings), roadFactor);
  if (!first.route) first = await attempt(freshBearing(usedBearings), roadFactor);
  if (first.route) roadFactor = observedFactor(first.route);

  // 2. A few more directions at the corrected size, in parallel, to pick the simplest.
  const bearings: number[] = [];
  for (let i = 0; i < 3; i++) bearings.push(freshBearing([...usedBearings, ...bearings]));
  if (first.route && distanceError(first.route) > LOOP_TOLERANCE) bearings.push(first.route.bearing);
  await Promise.all(bearings.map((b) => attempt(b, roadFactor)));

  // 3. Nothing close enough yet: rescale the nearest one and try again.
  if (found.length && !found.some((r) => distanceError(r) <= LOOP_TOLERANCE)) {
    const nearest = [...found].sort((a, b) => distanceError(a) - distanceError(b))[0];
    const factor = observedFactor(nearest);
    await Promise.all([attempt(nearest.bearing, factor), attempt(freshBearing(usedBearings), factor)]);
  }

  const close = found.filter((r) => distanceError(r) <= LOOP_TOLERANCE);
  if (close.length) return close.sort((a, b) => score(a) - score(b));
  return found.sort((a, b) => distanceError(a) - distanceError(b)).slice(0, 1);
}
