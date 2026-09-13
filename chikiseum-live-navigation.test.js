import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ChikiseumLiveNavigation, ArenaChanged, PLAN_SHA256, PLAN_URL } from './chikiseum-live-navigation.js';

const INPUT_SHA = 'ff3dc460edd66adf1fe2b00bb8e727117f93eb9fb922692db9d12bfb8bf178d7';
const ORACLE_SHA = '7712c8ca256ed2c5fd1aea6a6ec0bb5bb973a5d2efe056a8c06b18fec32f7f56';
const inputRaw = readFileSync(new URL('./fixtures/chikiseum-full-floor-parity-input-v1.json', import.meta.url));
const oracleRaw = readFileSync(new URL('./fixtures/chikiseum-full-floor-analytic-prefix-oracle-v1.json', import.meta.url));
const fixture = JSON.parse(inputRaw), historicalOracle = JSON.parse(oracleRaw);
const plan = JSON.parse(readFileSync(PLAN_URL)), nav = new ChikiseumLiveNavigation();
const receipt = { schema: 'chikiseum.node-full-floor-navigation-qa/v1', activation_authorized: false,
  real_sol_enabled: false, plan_sha256: PLAN_SHA256, input_sha256: INPUT_SHA,
  navigation_sha256: createHash('sha256').update(readFileSync(new URL('./chikiseum-live-navigation.js', import.meta.url))).digest('hex'),
  test_sha256: createHash('sha256').update(readFileSync(new URL('./chikiseum-live-navigation.test.js', import.meta.url))).digest('hex'),
  python_reference_sha256: fixture.sources['server/chikiseum_practice/reference_arena.py'],
  historical_oracle_sha256: ORACLE_SHA, parity_checks: 0, independent_prefix_checks: 0,
  float32_endpoint_checks: 0, max_fixture_position_delta_m: 0, max_fixture_travel_delta_m: 0,
  max_independent_travel_delta_m: 0, benchmarks: {} };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const position = (x, z, y = 0) => ({ x, y, z });
const near = (actual, expected, tolerance = 1e-7, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);

// Independent expected-value oracle: full concave edges + 48-prefix clipping.
// It never imports production geometry, grid, or analytic first-contact helpers.
function pointEdge(point, a, b) {
  const v = [b[0] - a[0], b[1] - a[1]], w = [point[0] - a[0], point[1] - a[1]];
  const length = v[0] * v[0] + v[1] * v[1];
  const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, (w[0] * v[0] + w[1] * v[1]) / length));
  return (w[0] - v[0] * fraction) ** 2 + (w[1] - v[1] * fraction) ** 2;
}
function crosses(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ac = orient(a, b, c), ad = orient(a, b, d), ca = orient(c, d, a), cb = orient(c, d, b);
  if (((ac > 0 && ad < 0) || (ac < 0 && ad > 0)) && ((ca > 0 && cb < 0) || (ca < 0 && cb > 0))) return true;
  return [[ac, a, b, c], [ad, a, b, d], [ca, c, d, a], [cb, c, d, b]].some(([o, p, q, r]) =>
    Math.abs(o) <= 1e-12 && r[0] >= Math.min(p[0], q[0]) - 1e-12 && r[0] <= Math.max(p[0], q[0]) + 1e-12 &&
    r[1] >= Math.min(p[1], q[1]) - 1e-12 && r[1] <= Math.max(p[1], q[1]) + 1e-12);
}
function inside(point, points) {
  let contained = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (pointEdge(point, a, b) <= 1e-20) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < a[0] +
      (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])) contained = !contained;
  }
  return contained;
}
function distanceToPolygon(a, b, points) {
  if (inside(a, points) || inside(b, points)) return 0;
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    const c = points[i], d = points[(i + 1) % points.length];
    if (crosses(a, b, c, d)) return 0;
    nearest = Math.min(nearest, pointEdge(a, c, d), pointEdge(b, c, d), pointEdge(c, a, b), pointEdge(d, a, b));
  }
  return nearest;
}
const boxes = [...plan.cover_bases, ...plan.floor_obstacles].map(box => ({ ...box, points: [
  [box.x - box.width / 2, box.z - box.depth / 2], [box.x + box.width / 2, box.z - box.depth / 2],
  [box.x + box.width / 2, box.z + box.depth / 2], [box.x - box.width / 2, box.z + box.depth / 2]] }));
const solids = [...boxes, ...plan.solid_polygons].map(p => ({ ...p,
  minX: Math.min(...p.points.map(v => v[0])), maxX: Math.max(...p.points.map(v => v[0])),
  minZ: Math.min(...p.points.map(v => v[1])), maxZ: Math.max(...p.points.map(v => v[1])) }));
function fullReason(a, b, rival = null, closed = false) {
  const r = plan.actor_radius_m;
  if (Math.max(Math.hypot(...a), Math.hypot(...b)) + r > plan.floor_radius_m + 1e-9) return 'blocked_geometry';
  for (const p of solids) {
    if (Math.max(a[0], b[0]) + r < p.minX || Math.min(a[0], b[0]) - r > p.maxX ||
      Math.max(a[1], b[1]) + r < p.minZ || Math.min(a[1], b[1]) - r > p.maxZ) continue;
    const squared = distanceToPolygon(a, b, p.points);
    if (closed ? squared <= r * r + 1e-9 : squared < r * r - 1e-9) return 'blocked_geometry';
  }
  if (rival && pointEdge([rival.x, rival.z], a, b) < (r * 2) ** 2 - 1e-9) return 'fighter_collision';
  return null;
}
function prefixOracle(start, target, rival = null) {
  const a = [start.x, start.z], b = [target.x, target.z], delta = [b[0] - a[0], b[1] - a[1]];
  const distance = Math.hypot(...delta), direction = distance ? delta.map(n => n / distance) : [0, 0];
  const reason = fullReason(a, b, rival);
  let travelled = distance;
  if (reason !== null) {
    let low = 0, high = distance;
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2, end = [a[0] + direction[0] * mid, a[1] + direction[1] * mid];
      if (fullReason(a, end, rival) === null) low = mid; else high = mid;
    }
    travelled = Math.max(0, low - 0.00001);
  }
  return { position: position(a[0] + direction[0] * travelled, a[1] + direction[1] * travelled), travelled, reason };
}
// Godot uses float32 Vector2 storage AND float32 vector arithmetic, while scalar
// coordinate/ray comparisons are double. Test the actual ground predicate rather
// than pretending only the incoming JSON coordinates change precision.
const f32 = Math.fround;
const vector = p => p.map(f32);
const sub32 = (a, b) => [f32(a[0] - b[0]), f32(a[1] - b[1])];
const dot32 = (a, b) => f32(f32(a[0] * b[0]) + f32(a[1] * b[1]));
function godotPointEdge(p, a, b) {
  const delta = sub32(b, a), length = dot32(delta, delta);
  const ratio = length > 1e-9 ? Math.max(0, Math.min(1, dot32(sub32(p, a), delta) / length)) : 0;
  const target = [f32(a[0] + f32(delta[0] * f32(ratio))), f32(a[1] + f32(delta[1] * f32(ratio)))];
  const difference = sub32(p, target); return dot32(difference, difference);
}
const godotPolygons = plan.solid_polygons.map(poly => poly.points.map(vector));
const godotBoxes = boxes.map(box => ({ low: vector([box.minX ?? box.x - box.width / 2, box.minZ ?? box.z - box.depth / 2]),
  high: vector([box.maxX ?? box.x + box.width / 2, box.maxZ ?? box.z + box.depth / 2]) }));
function godotGroundClear(p) {
  if (p[0] * p[0] + p[1] * p[1] > (plan.floor_radius_m - plan.actor_radius_m) ** 2) return false;
  const threshold = plan.actor_radius_m ** 2 + 1e-9;
  for (const { low, high } of godotBoxes) {
    const closest = [f32(Math.max(low[0], Math.min(high[0], p[0]))), f32(Math.max(low[1], Math.min(high[1], p[1])))];
    const diff = sub32(p, closest); if (dot32(diff, diff) <= threshold) return false;
  }
  for (const points of godotPolygons) {
    let contained = false, nearest = Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      nearest = Math.min(nearest, godotPointEdge(p, a, b));
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
    }
    if (contained || nearest <= threshold) return false;
  }
  return true;
}

test('all frozen Python/Godot parity inputs: 3,323 checks', () => {
  assert.equal(sha(inputRaw), INPUT_SHA); receipt.parity_checks++;
  assert.equal(sha(readFileSync(PLAN_URL)), PLAN_SHA256); receipt.parity_checks++;
  assert.equal(nav.binding().solid_polygon_count, fixture.polygon_count); receipt.parity_checks++;
  assert.equal(nav.binding().solid_polygon_vertex_count, fixture.vertex_count); receipt.parity_checks++;
  for (const [i, g] of fixture.ground.entries()) { assert.equal(nav.validPosition(g.at), g.valid, `ground ${i}`); receipt.parity_checks++; }
  for (const [i, s] of fixture.sweeps.entries()) {
    const actual = nav.sweepBetween(s.start, s.target);
    const delta = Math.hypot(actual.position.x - s.position.x, actual.position.y - s.position.y, actual.position.z - s.position.z);
    receipt.max_fixture_position_delta_m = Math.max(receipt.max_fixture_position_delta_m, delta);
    receipt.max_fixture_travel_delta_m = Math.max(receipt.max_fixture_travel_delta_m, Math.abs(actual.travelled - s.travelled));
    assert.ok(delta <= 1e-7, `sweep ${i} stop delta ${delta}`); receipt.parity_checks++;
    near(actual.travelled, s.travelled, 1e-7, `sweep ${i} travel`); receipt.parity_checks++;
    assert.equal(actual.reason, s.reason, `sweep ${i} reason`); receipt.parity_checks++;
  }
  for (const [i, los] of fixture.los.entries()) { assert.equal(nav.lineOfSight(los.a, los.b), los.clear, `LOS ${i}`); receipt.parity_checks++; }
  assert.equal(receipt.parity_checks, 3323);
});
test('independent original 48-prefix oracle rejects polygon-contact regressions', () => {
  assert.equal(sha(oracleRaw), ORACLE_SHA); assert.deepEqual(historicalOracle.failures, []);
  assert.equal(historicalOracle.input_sha256, INPUT_SHA); assert.equal(historicalOracle.sweep_count, 124);
  for (const [i, s] of fixture.sweeps.entries()) {
    const expected = prefixOracle(s.start, s.target), actual = nav.sweepBetween(s.start, s.target);
    const delta = Math.abs(actual.travelled - expected.travelled);
    receipt.max_independent_travel_delta_m = Math.max(receipt.max_independent_travel_delta_m, delta);
    near(actual.travelled, expected.travelled, 1e-7, `independent ${i} travel`); receipt.independent_prefix_checks++;
    assert.ok(Math.hypot(actual.position.x - expected.position.x, actual.position.z - expected.position.z) <= 1e-7, `independent ${i} stop`); receipt.independent_prefix_checks++;
    assert.equal(actual.reason, expected.reason, `independent ${i} reason`); receipt.independent_prefix_checks++;
  }
  assert.equal(receipt.independent_prefix_checks, 372);
});
test('all 124 accepted endpoints remain clear after Godot float32 conversion', () => {
  for (const [i, s] of fixture.sweeps.entries()) {
    const p = nav.sweepBetween(s.start, s.target).position;
    const roundTrip = position(Math.fround(p.x), Math.fround(p.z), Math.fround(p.y));
    assert.equal(nav.validPosition(roundTrip), true, `float32 server ${i}`);
    assert.equal(fullReason([roundTrip.x, roundTrip.z], [roundTrip.x, roundTrip.z], null, true), null, `float32 Godot closed contact ${i}`);
    assert.equal(godotGroundClear([roundTrip.x, roundTrip.z]), true, `float32 Godot geometry/vector arithmetic ${i}`);
    receipt.float32_endpoint_checks++;
  }
});
test('source-bound homes, crest, complete metadata and defensive copies', () => {
  assert.deepEqual(nav.actorHome('A'), position(-5, 0)); assert.deepEqual(nav.actorHome('B'), position(5, 0));
  assert.equal(nav.onEmblem(position(0, 0)), true); assert.equal(nav.onEmblem(position(2.6, 0)), true);
  assert.equal(nav.onEmblem(position(2.61, 0)), false);
  const before = nav.binding(), copy = nav.binding(), layout = nav.layout();
  copy.cover_bases[0].x = 0; copy.home_a.x = 0; copy.tempo_rules.overtime_turn = 0;
  layout.solid_polygons[0].points[0][0] = 0; layout.floor_radius_m = 99;
  assert.deepEqual(nav.binding(), before); assert.equal(nav.layout().floor_radius_m, 24);
  assert.throws(() => { nav.actor_radius = 0; }, TypeError); assert.throws(() => nav.actorHome('C'), TypeError);
  assert.equal(before.real_sol_enabled, false); assert.equal(before.voxel_source_claimed, false);
  assert.equal(before.solid_polygons_transmitted, false); assert.equal(Object.hasOwn(before, 'solid_polygons'), false);
  assert.equal(before.floor_obstacles.length, 2); assert.equal(before.actor_height_m, 1.7);
  for (let i = 0; i < 100; i++) nav.footprintHeight(i / 10, 0);
  assert.ok(nav.diagnostics().ground_cache_entries <= 64);
});
test('fighter exclusion, connected outer routes, wall and floor clipping', () => {
  const cases = [
    [position(-5, 0), position(5, 0), position(0, 0)],
    [position(-5, 1), position(5, 1), position(0, 1.4)],
    [position(-5, 0), position(-5, 4), position(-5, 3)],
  ];
  for (const [from, to, rival] of cases) {
    const actual = nav.sweepBetween(from, to, rival), expected = prefixOracle(from, to, rival);
    assert.equal(actual.reason, 'fighter_collision'); near(actual.travelled, expected.travelled);
    assert.equal(nav.validPosition(actual.position), true);
    assert.ok(Math.hypot(actual.position.x - rival.x, actual.position.z - rival.z) > 0.7);
    const dx = to.x - from.x, dz = to.z - from.z, distance = Math.hypot(dx, dz);
    assert.deepEqual(nav.sweepIntent(from, dx / distance, dz / distance, distance, rival), actual);
  }
  for (const sign of [-1, 1]) {
    const route = [position(sign * 5, 0), position(sign * 5, 12), position(sign * 18, 12), position(sign * 18, 8.7)];
    for (let i = 1; i < route.length; i++) assert.deepEqual(nav.sweepBetween(route[i - 1], route[i]).position, route[i]);
    const blocked = nav.sweepBetween(route.at(-1), position(sign * 22, 8.7));
    assert.equal(blocked.reason, 'blocked_geometry'); near(blocked.position.x, sign * 19.44999, 1e-7);
  }
  const edge = nav.sweepBetween(position(0, 18), position(0, 30));
  near(edge.position.z, 23.64999, 1e-7); assert.equal(edge.reason, 'blocked_geometry');
});
test('strict finite movement inputs and unavailable or changed plan fail closed', () => {
  for (const bad of [null, [], true, '0', position(NaN, 0), position(Infinity, 0), { x: 0, z: 0 }, { x: 0, y: 0, z: 0, extra: 1 }, position(0, 0, true)]) {
    assert.equal(nav.validPosition(bad), false); assert.equal(nav.onEmblem(bad), false);
    assert.equal(nav.lineOfSight(bad, nav.actorHome('B')), false);
  }
  for (const value of [true, '1', NaN, Infinity, null]) {
    assert.throws(() => nav.sweep(nav.actorHome('A'), value, 0, 1), TypeError);
    assert.throws(() => nav.sweep(nav.actorHome('A'), 1, 0, value), TypeError);
  }
  for (const args of [[1, 1, 1], [1.1, 0, 1], [1, 0, -1], [1, 0, 129]]) assert.throws(() => nav.sweep(nav.actorHome('A'), ...args), TypeError);
  assert.throws(() => nav.sweep(nav.actorHome('A'), 1, 0, 1, position(99, 0)), TypeError);
  assert.deepEqual(nav.sweep(nav.actorHome('A'), 0, 0, 0), { position: nav.actorHome('A'), travelled: 0, reason: null });
  const folder = mkdtempSync(join(tmpdir(), 'chikiseum-node-nav-test-'));
  try {
    const changed = join(folder, 'changed-plan.json');
    writeFileSync(changed, JSON.stringify({ ...plan, floor_radius_m: 25 }));
    assert.throws(() => new ChikiseumLiveNavigation({ planPath: changed }), error => error instanceof ArenaChanged && error.code === 'arena_changed');
    assert.throws(() => new ChikiseumLiveNavigation({ planPath: join(folder, 'missing.json') }), ArenaChanged);
  } finally { rmSync(folder, { recursive: true }); }
});
test('bounded authority work: measured clear, cover, concave-wall and cached idle', () => {
  function bench(name, fn, count = 200) {
    for (let i = 0; i < 10; i++) fn();
    const durations = [];
    for (let i = 0; i < count; i++) { const at = performance.now(); fn(); durations.push(performance.now() - at); }
    durations.sort((a, b) => a - b);
    const mean = durations.reduce((n, x) => n + x, 0) / count, p95 = durations[Math.floor(count * 0.95)];
    receipt.benchmarks[name] = { iterations: count, mean_ms: mean, p95_ms: p95, max_ms: durations.at(-1) };
    assert.ok(mean < 10 && p95 < 20, `${name} exceeds bounded single-process authority budget`);
  }
  bench('clear_18m', () => nav.sweepBetween(position(-5, 0), position(-5, 18.05)));
  bench('outer_cover', () => nav.sweepBetween(position(-18, 8.7), position(-22, 8.7)));
  bench('concave_wall', () => nav.sweepBetween(position(-5, 0), position(-5, -17.48)));
  bench('cached_idle', () => nav.validPosition(position(-5, 0)), 1000);
  console.log('CHIKISEUM_NODE_NAVIGATION_QA_JSON ' + JSON.stringify(receipt));
});
