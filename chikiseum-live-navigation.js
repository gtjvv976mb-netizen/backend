/** Hash-bound v2 full-floor authority. No art, damage, ownership or SOL writes.
 * Port of reference_arena.py: exact concave edge geometry, conservative grid
 * rejection, analytic polygon contact and 48-prefix box/fighter clipping.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PLAN_SHA256 = '4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b';
export const PLAN_URL = new URL('./chikiseum_reference_arena_v2.json', import.meta.url);
export const CLIP_INSET_M = 0.00001;
const GRID_M = 4;
const EPS = 1e-9;
const TEMPO_RULES = Object.freeze({ schema: 'chikiseum.reference-tempo/v1', overtime_turn: 9,
  standard_planning_seconds: 25, overtime_planning_seconds: 15,
  standard_base_energy_regen: 1, overtime_base_energy_regen: 2 });

export class ArenaChanged extends Error {
  constructor(message = 'Approved Chikiseum reference plan changed') {
    super(message); this.name = 'ArenaChanged'; this.code = 'arena_changed';
  }
}
const scalar = (n, low = -32, high = 32) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
const record = n => n !== null && typeof n === 'object' && !Array.isArray(n) && Object.getPrototypeOf(n) === Object.prototype;
const clone = n => structuredClone(n);
function freeze(n) { if (n && typeof n === 'object') { Object.values(n).forEach(freeze); Object.freeze(n); } return n; }
function pointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, den = dx * dx + dz * dz;
  const t = den ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / den)) : 0;
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}
function segmentCover(ax, az, bx, bz, cover) {
  const xmin = cover.x - cover.width / 2, xmax = cover.x + cover.width / 2;
  const zmin = cover.z - cover.depth / 2, zmax = cover.z + cover.depth / 2;
  let enter = 0, leave = 1, intersects = true;
  for (const [a, b, low, high] of [[ax, bx, xmin, xmax], [az, bz, zmin, zmax]]) {
    const delta = b - a;
    if (Math.abs(delta) < 1e-15) { if (a < low || a > high) { intersects = false; break; } }
    else {
      const p = (low - a) / delta, q = (high - a) / delta;
      enter = Math.max(enter, Math.min(p, q)); leave = Math.min(leave, Math.max(p, q));
      if (enter > leave) { intersects = false; break; }
    }
  }
  if (intersects) return 0;
  let nearest = Infinity;
  for (const [x, z] of [[ax, az], [bx, bz]]) nearest = Math.min(nearest,
    Math.max(xmin - x, 0, x - xmax) ** 2 + Math.max(zmin - z, 0, z - zmax) ** 2);
  for (const x of [xmin, xmax]) for (const z of [zmin, zmax]) nearest = Math.min(nearest, pointSegment(x, z, ax, az, bx, bz));
  return nearest;
}
function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const cross = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const ac = cross(ax, az, bx, bz, cx, cz), ad = cross(ax, az, bx, bz, dx, dz);
  const ca = cross(cx, cz, dx, dz, ax, az), cb = cross(cx, cz, dx, dz, bx, bz);
  if (((ac > 0 && ad < 0) || (ad > 0 && ac < 0)) && ((ca > 0 && cb < 0) || (cb > 0 && ca < 0))) return true;
  for (const [value, px, pz, qx, qz, rx, rz] of [[ac, ax, az, bx, bz, cx, cz], [ad, ax, az, bx, bz, dx, dz],
    [ca, cx, cz, dx, dz, ax, az], [cb, cx, cz, dx, dz, bx, bz]]) {
    if (Math.abs(value) <= 1e-12 && Math.min(px, qx) - 1e-12 <= rx && rx <= Math.max(px, qx) + 1e-12 &&
      Math.min(pz, qz) - 1e-12 <= rz && rz <= Math.max(pz, qz) + 1e-12) return true;
  }
  return false;
}
function pointInPolygon(x, z, points) {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (pointSegment(x, z, ...a, ...b) <= 1e-20) return true;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function segmentPolygon(ax, az, bx, bz, poly) {
  const points = poly.points;
  if (pointInPolygon(ax, az, points) || pointInPolygon(bx, bz, points)) return 0;
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (segmentsIntersect(ax, az, bx, bz, ...a, ...b)) return 0;
    nearest = Math.min(nearest, pointSegment(ax, az, ...a, ...b), pointSegment(bx, bz, ...a, ...b),
      pointSegment(...a, ax, az, bx, bz), pointSegment(...b, ax, az, bx, bz));
  }
  return nearest;
}
function edgeCapsuleFirst(ax, az, bx, bz, cx, cz, dx, dz, radius) {
  const vx = bx - ax, vz = bz - az, squared = vx * vx + vz * vz;
  if (squared === 0) return Infinity;
  let first = Infinity;
  for (const [x, z] of [[cx, cz], [dx, dz]]) {
    const ox = ax - x, oz = az - z, dot = ox * vx + oz * vz, offset = ox * ox + oz * oz - radius * radius;
    if (offset < 0) return 0;
    const discriminant = dot * dot - squared * offset;
    if (discriminant >= 0) {
      const fraction = (-dot - Math.sqrt(Math.max(0, discriminant))) / squared;
      if (fraction >= 0 && fraction <= 1) first = Math.min(first, fraction);
    }
  }
  const ex = dx - cx, ez = dz - cz, edgeSquared = ex * ex + ez * ez, velocity = vx * ez - vz * ex;
  if (edgeSquared > 0 && Math.abs(velocity) > 1e-15) {
    const initial = (ax - cx) * ez - (az - cz) * ex, band = radius * Math.sqrt(edgeSquared);
    for (const side of [-1, 1]) {
      const fraction = (side * band - initial) / velocity;
      if (fraction >= 0 && fraction <= 1) {
        const projection = ((ax + vx * fraction - cx) * ex + (az + vz * fraction - cz) * ez) / edgeSquared;
        if (projection >= 0 && projection <= 1) first = Math.min(first, fraction);
      }
    }
  }
  return first;
}
function polygonFirst(ax, az, bx, bz, poly, radius) {
  let first = Infinity;
  for (let i = 0; i < poly.points.length; i++) first = Math.min(first,
    edgeCapsuleFirst(ax, az, bx, bz, ...poly.points[i], ...poly.points[(i + 1) % poly.points.length], radius));
  return first;
}
function validatePlan(plan) {
  if (!record(plan) || plan.schema !== 'chikiseum.reference-arena/v2' || plan.real_sol_enabled !== false ||
    plan.id !== 'chikiseum-image-built-3d-v2' || plan.presentation !== 'realtime_3d_rebuilt_from_2d_reference' ||
    plan.floor_radius_m !== 24 || plan.floor_height_m !== 0 || plan.actor_radius_m !== 0.35 || plan.actor_height_m !== 1.7) {
    throw new ArenaChanged('Unsafe full-floor reference dimensions');
  }
  const ids = new Set();
  for (const [field, count] of [['cover_bases', 4], ['floor_obstacles', 2]]) {
    if (!Array.isArray(plan[field]) || plan[field].length !== count) throw new ArenaChanged('Invalid full-floor box inventory');
    for (const box of plan[field]) {
      if (!record(box) || typeof box.id !== 'string' || !box.id || ids.has(box.id) || !scalar(box.x) || !scalar(box.z) ||
        ['width', 'depth', 'height'].some(key => !scalar(box[key], 0.000001, 32))) throw new ArenaChanged('Invalid full-floor box');
      ids.add(box.id);
    }
  }
  if (!Array.isArray(plan.solid_polygons) || plan.solid_polygons.length < 1 || plan.solid_polygons.length > 1024) {
    throw new ArenaChanged('Invalid full-floor solid inventory');
  }
  let total = 0;
  for (const poly of plan.solid_polygons) {
    if (!record(poly) || typeof poly.id !== 'string' || !poly.id || ids.has(poly.id) || !scalar(poly.height, 0.000001, 32)) {
      throw new ArenaChanged('Invalid full-floor solid identity/height');
    }
    ids.add(poly.id);
    const points = poly.points;
    if (!Array.isArray(points) || points.length < 3 || points.length > 2048 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !scalar(v)))) {
      throw new ArenaChanged('Invalid full-floor solid points');
    }
    total += points.length;
    if (total > 65536 || new Set(points.map(p => `${p[0]},${p[1]}`)).size !== points.length) throw new ArenaChanged('Unbounded or duplicate full-floor solid points');
    let area = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1]; }
    if (Math.abs(area) <= 1e-10) throw new ArenaChanged('Degenerate full-floor solid');
    for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (segmentsIntersect(...points[i], ...points[(i + 1) % points.length], ...points[j], ...points[(j + 1) % points.length])) {
        throw new ArenaChanged('Self-intersecting full-floor solid');
      }
    }
  }
}

export class ChikiseumLiveNavigation {
  #plan; #boxes; #polygons; #bounds; #grid = new Map(); #groundCache = new Map(); #vertexCount;
  constructor({ planPath = PLAN_URL } = {}) {
    let raw, plan;
    try {
      raw = readFileSync(planPath);
      if (createHash('sha256').update(raw).digest('hex') !== PLAN_SHA256) throw new ArenaChanged();
      plan = JSON.parse(raw.toString('utf8'));
    } catch (error) { if (error instanceof ArenaChanged) throw error; throw new ArenaChanged('Approved Chikiseum reference plan is unavailable'); }
    validatePlan(plan);
    this.#plan = freeze(clone(plan));
    this.radius = plan.floor_radius_m; this.actor_radius = plan.actor_radius_m; this.actor_height = plan.actor_height_m;
    this.crest_radius = plan.crest_radius_m;
    this.#boxes = [...this.#plan.cover_bases, ...this.#plan.floor_obstacles]; this.#polygons = this.#plan.solid_polygons;
    this.#bounds = this.#polygons.map(poly => {
      const xs = poly.points.map(p => p[0]), zs = poly.points.map(p => p[1]);
      const low_x = Math.min(...xs), high_x = Math.max(...xs), low_z = Math.min(...zs), high_z = Math.max(...zs);
      return { x: (low_x + high_x) / 2, z: (low_z + high_z) / 2, width: high_x - low_x, depth: high_z - low_z, low_x, high_x, low_z, high_z };
    });
    this.#bounds.forEach((bounds, index) => {
      for (let x = Math.floor(bounds.low_x / GRID_M); x <= Math.floor(bounds.high_x / GRID_M); x++) {
        for (let z = Math.floor(bounds.low_z / GRID_M); z <= Math.floor(bounds.high_z / GRID_M); z++) {
          const key = `${x},${z}`; if (!this.#grid.has(key)) this.#grid.set(key, []); this.#grid.get(key).push(index);
        }
      }
    });
    this.#vertexCount = this.#polygons.reduce((n, p) => n + p.points.length, 0);
    if (!this.validPosition(plan.home_a) || !this.validPosition(plan.home_b)) throw new ArenaChanged('Reference fighter home is not walkable');
    Object.freeze(this);
  }
  #candidates(ax, az, bx, bz, radius) {
    const lowX = Math.min(ax, bx) - radius, highX = Math.max(ax, bx) + radius;
    const lowZ = Math.min(az, bz) - radius, highZ = Math.max(az, bz) + radius, indices = new Set();
    for (let x = Math.max(-8, Math.floor(lowX / GRID_M)); x <= Math.min(8, Math.floor(highX / GRID_M)); x++) {
      for (let z = Math.max(-8, Math.floor(lowZ / GRID_M)); z <= Math.min(8, Math.floor(highZ / GRID_M)); z++) {
        for (const index of this.#grid.get(`${x},${z}`) ?? []) indices.add(index);
      }
    }
    return [...indices].sort((a, b) => a - b).filter(i => {
      const b = this.#bounds[i]; return !(highX < b.low_x || lowX > b.high_x || highZ < b.low_z || lowZ > b.high_z);
    });
  }
  #reason(ax, az, bx, bz, obstacle = null, candidates = null) {
    const radius = this.actor_radius, radiusSquared = radius ** 2 - EPS;
    if (![ax, az, bx, bz].every(Number.isFinite) || Math.max(Math.hypot(ax, az), Math.hypot(bx, bz)) + radius > this.radius + EPS) return 'blocked_geometry';
    for (const box of this.#boxes) if (box.height > this.#plan.floor_height_m && segmentCover(ax, az, bx, bz, box) < radiusSquared) return 'blocked_geometry';
    for (const i of candidates ?? this.#candidates(ax, az, bx, bz, radius)) {
      if (segmentCover(ax, az, bx, bz, this.#bounds[i]) >= radiusSquared) continue;
      if (segmentPolygon(ax, az, bx, bz, this.#polygons[i]) < radiusSquared) return 'blocked_geometry';
    }
    if (obstacle !== null && pointSegment(obstacle.x, obstacle.z, ax, az, bx, bz) < (2 * radius) ** 2 - EPS) return 'fighter_collision';
    return null;
  }
  footprintHeight(x, z) {
    if (!scalar(x) || !scalar(z)) return null;
    const key = `${x},${z}`;
    if (this.#groundCache.has(key)) { const value = this.#groundCache.get(key); this.#groundCache.delete(key); this.#groundCache.set(key, value); return value; }
    const value = this.#reason(x, z, x, z) === null ? this.#plan.floor_height_m : null;
    if (this.#groundCache.size >= 64) this.#groundCache.delete(this.#groundCache.keys().next().value);
    this.#groundCache.set(key, value); return value;
  }
  validPosition(p) {
    if (!record(p) || Object.keys(p).length !== 3 || !['x', 'y', 'z'].every(key => Object.hasOwn(p, key) && scalar(p[key]))) return false;
    const height = this.footprintHeight(p.x, p.z); return height !== null && Math.abs(p.y - height) < 1e-7;
  }
  actorHome(side) { if (side !== 'A' && side !== 'B') throw new TypeError('Unknown fighter side'); return clone(this.#plan[`home_${side.toLowerCase()}`]); }
  home(side) { return this.actorHome(side); }
  onEmblem(p) { return this.validPosition(p) && Math.hypot(p.x, p.z) <= this.crest_radius + EPS; }
  sweep(start, dx, dz, distance, rivalPosition = null) {
    if (!this.validPosition(start) || !scalar(dx, -1, 1) || !scalar(dz, -1, 1) || Math.hypot(dx, dz) > 1 + EPS ||
      !scalar(distance, 0, 128) || (rivalPosition !== null && !this.validPosition(rivalPosition))) throw new TypeError('Invalid authoritative movement input');
    if (distance === 0) return { position: clone(start), travelled: 0, reason: null };
    const endX = start.x + dx * distance, endZ = start.z + dz * distance;
    const candidates = this.#candidates(start.x, start.z, endX, endZ, this.actor_radius);
    let firstPolygon = Infinity;
    for (const i of candidates) {
      if (segmentCover(start.x, start.z, endX, endZ, this.#bounds[i]) < this.actor_radius ** 2 - EPS &&
        segmentPolygon(start.x, start.z, endX, endZ, this.#polygons[i]) < this.actor_radius ** 2 - EPS) {
        firstPolygon = Math.min(firstPolygon, polygonFirst(start.x, start.z, endX, endZ, this.#polygons[i], this.actor_radius));
      }
    }
    let reason = this.#reason(start.x, start.z, endX, endZ, rivalPosition, []), travelled = distance;
    if (reason !== null) {
      let low = 0, high = distance;
      for (let i = 0; i < 48; i++) { const mid = (low + high) / 2;
        if (this.#reason(start.x, start.z, start.x + dx * mid, start.z + dz * mid, rivalPosition, []) === null) low = mid; else high = mid;
      }
      travelled = Math.max(0, low - CLIP_INSET_M);
    }
    if (firstPolygon <= 1 && distance * firstPolygon <= travelled) { travelled = Math.max(0, distance * firstPolygon - CLIP_INSET_M); reason = 'blocked_geometry'; }
    return { position: { x: start.x + dx * travelled, y: this.#plan.floor_height_m, z: start.z + dz * travelled }, travelled, reason };
  }
  sweepBetween(start, target, rivalPosition = null) {
    if (!this.validPosition(start) || !record(target) || Object.keys(target).length !== 3 ||
      !['x', 'y', 'z'].every(key => Object.hasOwn(target, key) && scalar(target[key], -128, 128))) throw new TypeError('Invalid movement target');
    const dx = target.x - start.x, dz = target.z - start.z, distance = Math.hypot(dx, dz);
    return this.sweep(start, distance ? dx / distance : 0, distance ? dz / distance : 0, distance, rivalPosition);
  }
  sweepIntent(...args) { return this.sweep(...args); }
  lineOfSight(origin, target, height = 0.9) {
    if (!this.validPosition(origin) || !this.validPosition(target) || !scalar(height, 0, this.actor_height)) return false;
    for (const box of this.#boxes) if (box.height >= this.#plan.floor_height_m + height && segmentCover(origin.x, origin.z, target.x, target.z, box) <= 1e-12) return false;
    for (const i of this.#candidates(origin.x, origin.z, target.x, target.z, 0)) {
      if (this.#polygons[i].height >= this.#plan.floor_height_m + height && segmentCover(origin.x, origin.z, target.x, target.z, this.#bounds[i]) <= 1e-12 &&
        segmentPolygon(origin.x, origin.z, target.x, target.z, this.#polygons[i]) <= 1e-12) return false;
    }
    return true;
  }
  layout() { return clone(this.#plan); }
  binding() {
    const p = this.#plan;
    return { schema: p.schema, id: p.id, arena_id: p.id, reference_plan_source: 'res://chikiseum_reference_arena_v2.json',
      reference_plan_sha256: PLAN_SHA256, reference_image_sha256: p.reference_image_sha256, presentation: p.presentation,
      geometry_authority: 'approved_reference_plan', floor_radius_m: this.radius, floor_height_m: p.floor_height_m,
      safe_radius_m: this.radius, actor_radius_m: this.actor_radius, actor_height_m: this.actor_height, max_step_m: 0,
      cover_bases: clone(p.cover_bases), home_a: this.actorHome('A'), home_b: this.actorHome('B'), crest_radius_m: this.crest_radius,
      crest_energy_bonus: p.crest_energy_bonus, emblem_energy_bonus: p.crest_energy_bonus, emblem_rule: 'flush_crest_confirmed_center_within_radius',
      tempo_rules: clone(TEMPO_RULES), real_sol_enabled: false, voxel_source_claimed: false,
      floor_obstacles: clone(p.floor_obstacles), solid_polygon_count: this.#polygons.length, solid_polygon_vertex_count: this.#vertexCount,
      solid_geometry_contract: 'actual_mesh_footprints_in_hash_bound_local_plan', solid_polygons_transmitted: false };
  }
  diagnostics() { return { ready: true, reference_plan_sha256: PLAN_SHA256, polygon_count: this.#polygons.length,
    polygon_vertex_count: this.#vertexCount, grid_cell_count: this.#grid.size, ground_cache_entries: this.#groundCache.size,
    clip_inset_m: CLIP_INSET_M, shape: 'continuous_upright_circular_footprint', real_sol_enabled: false }; }
}
export default ChikiseumLiveNavigation;
