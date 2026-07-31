// physics_authority_sim.mjs — DOES THE SERVER ACTUALLY KNOW WHERE YOU ARE?
//
// Three parts, in order of how much they can be argued with:
//
//   PART 1  world_physics.js replayed against a RECORDING OF THE REAL CLIENT. dev_physdump.gd drove
//           the actual avatar through the actual voxel world (windowed Godot, Main.tscn, Jolt
//           collision) and wrote every physics frame to JSON. The module gets the SAME inputs and
//           has to end up in the same place. This is the only part that can prove "the server ends
//           where the client would" — a second copy of the arithmetic proves nothing.
//   PART 2  the REAL server booted in-process with CHIK_PHYS=1: speed hacks, dt inflation, walls,
//           teleports, the floor, and the old-client compatibility guarantee.
//   PART 3  CHIK_PHYS=0 vs the PRE-CHANGE server.js, byte for byte, on identical request sequences.
//
// Nothing here touches the live backend or any chain: throwaway nacl keypair as TREASURY_SECRET,
// dummy RPC that is never called, VERIFY_HOLDERS=false, memory store, unique port.
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59997";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = process.env.PHYSPORT || "39821";
process.env.CHIK_PHYS = "1";
process.env.CHIK_WS = "0";               // this sim is about movement, not transports
delete process.env.DATABASE_URL;

const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

// ---------------------------------------------------------------------------------------------
// PART 1 — THE MODULE AGAINST THE RECORDED CLIENT
// ---------------------------------------------------------------------------------------------
const P = await import("./world_physics.js");
const T = await import("./world_terrain.js");
const tl = T.loadTerrain();

const DUMP = path.join(process.env.HOME, "Library/Application Support/Godot/app_userdata/Chikoria (Smooth Voxel)/physdump");
const runs = {};
let meta = {};
if (fs.existsSync(DUMP)) {
  for (const f of fs.readdirSync(DUMP)) {
    if (!f.endsWith(".json")) continue;
    const j = JSON.parse(fs.readFileSync(path.join(DUMP, f), "utf8"));
    if (f === "_meta.json") meta = j; else runs[j.name] = j;
  }
}

console.log("=== physics_authority_sim ===");
console.log(`terrain: ${tl.ok ? `${tl.w}x${tl.h} from ${tl.source}` : "MISSING"}`);
console.log(`client dump: ${Object.keys(runs).length} runs from ${DUMP}`);
console.log(`client meta: ${JSON.stringify(meta)}`);
console.log("");
console.log("--- PART 1: world_physics.js vs the RECORDED REAL CLIENT (dev_physdump.gd) ---");
chk(tl.ok, `terrain loaded (${tl.ok ? tl.w + "x" + tl.h : "no"})`);
chk(Object.keys(runs).length >= 6, `client dump present: ${Object.keys(runs).length} runs`);

// The measured multiplier for each run. The dump's meta records Profile.speed_mult() at the time
// (this save: boots Lv2 x Swiftfoot Serum = 1.68 on foot); the mounted runs are read back out of the
// recording itself, because the serum lapsed mid-probe and the meta was already written.
const FOOT_MULT = Number(meta.spd_mult) || 1;
function observedMult(run, base) {
  const fr = run.frames;
  const n = Math.min(40, fr.length);
  let best = 0;
  for (let i = 1; i < n; i++) {
    const sp = Math.hypot(fr[i][1] - fr[i - 1][1], fr[i][3] - fr[i - 1][3]) * (meta.physics_tps || 60);
    if (sp > best) best = sp;
  }
  return best / base;
}

// Replay ONE recorded run through the module, frame for frame, at the client's own physics rate.
function replay(run, { mult, mode = "foot" }) {
  const dt = 1 / (meta.physics_tps || 60);
  let s = P.newState(run.start[0], run.start[1], run.start[2], 0);
  s.mult = mult; s.mode = mode; s.grounded = true;
  if (mode === "mount") s.dash = 9;
  const input = { seq: 0, dt, move: { x: run.move[0], z: run.move[1] }, jump: false, sprint: !!run.run, mode };
  const len = Math.hypot(input.move.x, input.move.z);
  if (len > 1) { input.move.x /= len; input.move.z /= len; }
  const path = [];
  for (let i = 0; i < run.frames.length; i++) {
    input.jump = !!run.jump && i < 3;             // the probe holds jump for 3 frames (an edge)
    s = P.step(s, input, dt);
    path.push([s.x, s.y, s.z]);
  }
  return { end: s, path };
}
// Worst |sim - client| inside any window of `secs` — the number POS_TOL has to clear. Both are
// re-based at the start of each window, which is exactly what reconcile() does on every accepted
// claim: the model is resynced, so its error can only ever build for one report interval.
function windowedDrift(run, opt, secs) {
  const tps = meta.physics_tps || 60, W = Math.round(secs * tps), dt = 1 / tps;
  const fr = run.frames;
  let worst = 0, at = 0;
  for (let start = 0; start + W < fr.length; start += Math.max(1, Math.round(W / 4))) {
    let s = P.newState(fr[start][1], fr[start][2], fr[start][3], 0);
    s.mult = opt.mult; s.mode = opt.mode || "foot"; s.grounded = !!fr[start][7];
    if (s.mode === "mount") s.dash = 9;
    const input = { seq: 0, dt, move: { x: run.move[0], z: run.move[1] }, jump: false, sprint: !!run.run, mode: s.mode };
    const l = Math.hypot(input.move.x, input.move.z); if (l > 1) { input.move.x /= l; input.move.z /= l; }
    for (let i = start; i < start + W; i++) {
      s = P.step(s, input, dt);
      const d = Math.hypot(s.x - fr[i][1], s.z - fr[i][3]);
      if (d > worst) { worst = d; at = fr[i][0]; }
    }
  }
  return { worst, at };
}

function report(name, opt, tol) {
  const run = runs[name];
  if (!run) { chk(false, `${name}: run missing from the dump`); return null; }
  const fr = run.frames, last = fr[fr.length - 1];
  const { end } = replay(run, opt);
  const cd = Math.hypot(last[1] - run.start[0], last[3] - run.start[2]);
  const sd = Math.hypot(end.x - run.start[0], end.z - run.start[2]);
  const delta = Math.hypot(end.x - last[1], end.z - last[3]);
  console.log(`  [${name}] client end (${f2(last[1])}, ${f2(last[2])}, ${f2(last[3])}) dist ${f2(cd)} @ ${f2(cd / run.secs)} u/s`);
  console.log(`  [${name}] server end (${f2(end.x)}, ${f2(end.y)}, ${f2(end.z)}) dist ${f2(sd)} @ ${f2(sd / run.secs)} u/s`);
  console.log(`  [${name}] DELTA horizontal ${f3(delta)} u  |  vertical ${f3(end.y - last[2])} u  (tol ${tol})`);
  chk(delta <= tol, `${name}: sim ends within ${tol} u of the client (actual ${f3(delta)})`);
  return { run, end, last, delta };
}

// -- flat ground: the pure speed check. Nothing to collide with, so any delta here is integration.
report("flat_walk", { mult: FOOT_MULT }, 0.35);
report("flat_sprint", { mult: FOOT_MULT }, 0.35);
{
  const r = runs.flat_sprint;
  if (r) {
    const fr = r.frames, last = fr[fr.length - 1];
    const cspd = Math.hypot(last[1] - r.start[0], last[3] - r.start[2]) / r.secs;
    console.log(`  client sprint speed ${f2(cspd)} u/s = run_speed ${P.PHYS.RUN} x speed_mult ${FOOT_MULT} = ${f2(P.PHYS.RUN * FOOT_MULT)}`);
    chk(Math.abs(cspd - P.PHYS.RUN * FOOT_MULT) < 0.05, `run_speed x speed_mult reproduces the measured client speed (${f2(cspd)} vs ${f2(P.PHYS.RUN * FOOT_MULT)})`);
    chk(P.PHYS.RUN * P.MAX_MULT_FOOT > cspd, `the foot ceiling ${f2(P.PHYS.RUN * P.MAX_MULT_FOOT)} u/s is above this geared player's ${f2(cspd)} u/s`);
  }
}

// -- the jump: does it arc, and does it land ON the ground rather than through it?
{
  const r = runs.jump;
  if (r) {
    const { end, path } = replay(r, { mult: FOOT_MULT });
    const cApex = Math.max(...r.frames.map(f => f[2])), sApex = Math.max(...path.map(p => p[1]));
    const cEnd = r.frames[r.frames.length - 1], g = P.groundAt(end.x, end.z);
    console.log(`  [jump] client apex ${f3(cApex)} (rise ${f3(cApex - r.start[1])}), server apex ${f3(sApex)} (rise ${f3(sApex - r.start[1])})`);
    console.log(`  [jump] theory rise = jump^2/(2g) = ${f3(P.PHYS.JUMP * P.PHYS.JUMP / (2 * P.PHYS.GRAVITY))}`);
    console.log(`  [jump] client landed y ${f3(cEnd[2])}, server landed y ${f3(end.y)}, ground here ${f3(g)}`);
    chk(Math.abs((sApex - r.start[1]) - (cApex - r.start[1])) < 0.25, `jump apex matches the client within 0.25 u (client ${f3(cApex - r.start[1])}, server ${f3(sApex - r.start[1])})`);
    chk(Math.abs(end.y - g) < 0.01 && Math.abs(end.y - cEnd[2]) < 0.01, `jump lands exactly on the ground height (${f3(end.y)} = ground ${f3(g)} = client ${f3(cEnd[2])})`);
    chk(end.grounded === true, "the simulated jumper is grounded again at the end of the arc");
  }
}

// -- the hill: the client's capsule climbs a slope; the server climbs a heightfield. This is where
//    the two disagree most, and it is what POS_TOL is sized for.
{
  const r = report("hill", { mult: FOOT_MULT }, 13.0);
  if (r) {
    const d = windowedDrift(runs.hill, { mult: FOOT_MULT }, 0.28);
    const d2 = windowedDrift(runs.hill, { mult: FOOT_MULT }, 0.55);
    const climbed = r.last[2] - r.run.start[1];
    const cspd = Math.hypot(r.last[1] - r.run.start[0], r.last[3] - r.run.start[2]) / r.run.secs;
    console.log(`  [hill] client climbed ${f3(climbed)} u of height; server ${f3(r.end.y - r.run.start[1])} u`);
    console.log(`  [hill] THE SLOPE TAX: client ${f2(cspd)} u/s uphill vs ${f2(P.PHYS.RUN * FOOT_MULT)} u/s on the flat = ${f2(100 * cspd / (P.PHYS.RUN * FOOT_MULT))}% — the terrain is a 1-unit voxel STAIRCASE and the capsule pays for every riser`);
    console.log(`  [hill] worst open-loop drift, one report interval (0.28 s): ${f3(d.worst)} u @ t=${d.at}s`);
    console.log(`  [hill] worst open-loop drift, 0.28 s + one p95 sample age (0.55 s): ${f3(d2.worst)} u`);
    chk(Math.abs((r.end.y - r.run.start[1]) - climbed) < 2.0, `the sim climbs the same hill (client +${f3(climbed)}, server +${f3(r.end.y - r.run.start[1])})`);
    // THE POINT: the divergence is entirely in the direction of the SERVER being ahead. A symmetric
    // tolerance would fire here; the one-sided rule cannot, because the client never gains ground.
    let clientAhead = 0;
    const tps = meta.physics_tps || 60, W = Math.round(0.28 * tps), dt = 1 / tps, fr = runs.hill.frames;
    for (let start = 0; start + W < fr.length; start += W) {
      let s = P.newState(fr[start][1], fr[start][2], fr[start][3], 0);
      s.mult = FOOT_MULT; s.grounded = !!fr[start][7];
      const input = { seq: 0, dt, move: { x: runs.hill.move[0], z: runs.hill.move[1] }, jump: false, sprint: true, mode: "foot" };
      for (let i = start; i < start + W; i++) s = P.step(s, input, dt);
      const end = fr[start + W - 1];
      const claimMoved = Math.hypot(end[1] - fr[start][1], end[3] - fr[start][3]);
      const simMoved = Math.hypot(s.x - fr[start][1], s.z - fr[start][3]);
      if (claimMoved > simMoved) clientAhead++;
    }
    console.log(`  [hill] report intervals where the CLIENT gained more ground than the model: ${clientAhead} of ${Math.floor((fr.length - 1) / W)}`);
    chk(clientAhead === 0, "on a slope the client is never AHEAD of the model — the one-sided gate cannot fire on an honest climber");
    const pen = P.segmentPenetration(runs.hill.start[0], runs.hill.start[1], runs.hill.start[2], r.last[1], r.last[2], r.last[3]);
    console.log(`  [hill] terrain penetration of the client's own start->end line: ${f3(pen)} u (PEN_TOL ${P.TUNE.PEN_TOL})`);
    chk(pen <= P.TUNE.PEN_TOL, `an honest hill climb does not trip the through-terrain test (${f3(pen)} u)`);
  }
}

// -- the wall: the steepest face on the island (surface 66 -> 76 in 4 units). The client is stopped
//    by voxel collision; the server has to be stopped by the heightfield or it tunnels straight in.
{
  const r = runs.wall;
  if (r) {
    const { end } = replay(r, { mult: FOOT_MULT });
    const last = r.frames[r.frames.length - 1];
    const cMoved = Math.hypot(last[1] - r.start[0], last[3] - r.start[2]);
    const sMoved = Math.hypot(end.x - r.start[0], end.z - r.start[2]);
    const free = P.PHYS.RUN * FOOT_MULT * r.secs;
    console.log(`  [wall] unobstructed a sprinter would cover ${f2(free)} u in ${r.secs}s`);
    console.log(`  [wall] client stopped after ${f2(cMoved)} u at x=${f2(last[1])} (ground there ${f2(P.groundAt(last[1], last[3]))})`);
    console.log(`  [wall] server stopped after ${f2(sMoved)} u at x=${f2(end.x)} (ground there ${f2(P.groundAt(end.x, end.z))})`);
    chk(sMoved < free * 0.35, `the sim is BLOCKED by the wall, not tunnelling (${f2(sMoved)} u vs ${f2(free)} u unobstructed)`);
    chk(Math.abs(sMoved - cMoved) < 6, `the sim stops within 6 u of where the client stops (${f2(sMoved)} vs ${f2(cMoved)})`);
    chk(end.y >= P.groundAt(end.x, end.z) - 1e-6, `the sim never ends up inside the hill (y ${f3(end.y)} >= ground ${f3(P.groundAt(end.x, end.z))})`);
    // and the geometric backstop: a claim that walks THROUGH the same face at a legal speed
    const honestPen = P.segmentPenetration(r.start[0], r.start[1], r.start[2], last[1], last[2], last[3]);
    const hackPen = P.segmentPenetration(r.start[0], r.start[1], r.start[2], r.start[0] - 40, r.start[1], r.start[2]);
    console.log(`  [wall] penetration of the client's own path ${f3(honestPen)} u; of a 40 u walk STRAIGHT THROUGH the face ${f3(hackPen)} u (PEN_TOL ${P.TUNE.PEN_TOL})`);
    chk(honestPen <= P.TUNE.PEN_TOL, "the honest run does not trip the through-terrain test");
    chk(hackPen > P.TUNE.PEN_TOL, `a slow wall-hack through the same face IS caught by geometry alone (${f3(hackPen)} u of rock)`);
  }
}

// -- the sea: swim, then the drowning rescue. The recording contains a REAL 548-unit client
//    teleport, which is the thing the accept path exists for.
{
  const r = runs.sea;
  if (r) {
    const fr = r.frames;
    let tpAt = -1;
    for (let i = 1; i < fr.length; i++) if (Math.hypot(fr[i][1] - fr[i - 1][1], fr[i][3] - fr[i - 1][3]) > 50) { tpAt = i; break; }
    const wet = fr.filter(f => f[8] === 1).length;
    const preTp = tpAt > 0 ? fr[tpAt - 1] : fr[fr.length - 1];
    const postTp = tpAt > 0 ? fr[tpAt] : null;
    console.log(`  [sea] client frames in water: ${wet}/${fr.length}; lowest y ${f3(Math.min(...fr.map(f => f[2])))} (water_level ${P.PHYS.WATER})`);
    // replay only up to the rescue — after it the client is 548 u away by fiat, not by physics
    const dt = 1 / (meta.physics_tps || 60);
    let s = P.newState(r.start[0], r.start[1], r.start[2], 0); s.mult = FOOT_MULT; s.grounded = true;
    const input = { seq: 0, dt, move: { x: r.move[0], z: r.move[1] }, jump: false, sprint: !!r.run, mode: "foot" };
    const n = tpAt > 0 ? tpAt - 1 : fr.length;
    for (let i = 0; i < n; i++) s = P.step(s, input, dt);
    console.log(`  [sea] at the moment of the rescue: client (${f2(preTp[1])}, ${f2(preTp[2])}, ${f2(preTp[3])}), server (${f2(s.x)}, ${f2(s.y)}, ${f2(s.z)})`);
    chk(wet > 0, `the client really did enter the water (${wet} frames with _in_water)`);
    chk(s.wet === true, "the sim knows it is swimming (y below water_level - 0.4)");
    chk(s.y > P.PHYS.WATER - P.PHYS.WATER_FLOAT - 1.0 && s.y < P.PHYS.WATER, `the sim floats at the surface rather than sinking (y ${f3(s.y)}, buoyancy target ${f3(P.PHYS.WATER - P.PHYS.WATER_FLOAT)})`);
    chk(Math.hypot(s.x - preTp[1], s.z - preTp[3]) < 12, `swimming stays with the client (${f3(Math.hypot(s.x - preTp[1], s.z - preTp[3]))} u apart after ${(n / 60).toFixed(2)}s in the sea)`);
    if (postTp) {
      const jump = Math.hypot(postTp[1] - preTp[1], postTp[3] - preTp[3]);
      const dest = P.teleportDestination(postTp[1], postTp[3]);
      console.log(`  [sea] THE RESCUE: ${f2(jump)} u in one frame, to (${f2(postTp[1])}, ${f2(postTp[2])}, ${f2(postTp[3])}) -> whitelisted "${dest ? dest.name : "NO"}"`);
      chk(!!dest, `the real drown-rescue landing is on the teleport whitelist (${dest ? dest.name : "MISSED — the server would fight the rescue"})`);
    }
  }
}

// -- mounted: ride speed and the dash multiplier, straight off the recording
{
  const ride = runs.mount_ride, dash = runs.mount_dash;
  if (ride && dash) {
    const rl = ride.frames[ride.frames.length - 1], dl = dash.frames[dash.frames.length - 1];
    const rs = Math.hypot(rl[1] - ride.start[0], rl[3] - ride.start[2]) / ride.secs;
    const ds = Math.hypot(dl[1] - dash.start[0], dl[3] - dash.start[2]) / dash.secs;
    const mult = rs / P.PHYS.WALK;
    console.log(`  [mount] ride ${f2(rs)} u/s = walk ${P.PHYS.WALK} x mult ${f3(mult)}; dash ${f2(ds)} u/s = ride x ${f3(ds / rs)}`);
    chk(Math.abs(ds / rs - P.PHYS.MOUNT_DASH) < 0.01, `the dash multiplier is ${P.PHYS.MOUNT_DASH} as mirrored (measured ${f3(ds / rs)})`);
    const rr = report("mount_ride", { mult, mode: "mount" }, 0.35);
    chk(P.maxSpeed("mount") > ds, `the mount ceiling ${f2(P.maxSpeed("mount"))} u/s is above the measured dash ${f2(ds)} u/s`);
  }
}

// -- the ground offset, measured not assumed
{
  const offs = Object.values(runs).map(r => r.rest_offset);
  console.log(`  measured rest offsets (client y - surfaceHeight) across ${offs.length} runs: ${offs.join(", ")}`);
  chk(offs.every(o => Math.abs(o - P.PHYS.FOOT) < 1e-6), `PHYS.FOOT ${P.PHYS.FOOT} matches every measured resting offset`);
}

// ---------------------------------------------------------------------------------------------
// PART 2 — THE REAL SERVER, CHIK_PHYS=1
// ---------------------------------------------------------------------------------------------
const srv = await import("./server.js");
await sleep(1200);
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { code: r.status, body: await r.json() };
};
const move = (b) => post("/world/move", b);
const nid = () => "godot-" + Math.random().toString(36).slice(2, 12);

console.log("");
console.log("--- PART 2: the REAL server with CHIK_PHYS=1 ---");
console.log(`  ${JSON.stringify(srv._physStatsForTest())}`);
chk(srv._physStatsForTest().on === true, "CHIK_PHYS=1 is live on the booted server");

// FLAT GROUND next to the plateau the client was recorded on, so the terrain is the same terrain.
const X0 = -550, Z0 = 240, Y0 = P.groundAt(X0, Z0);

// 1. an HONEST OLD CLIENT — positions only, no inputs, walking at a normal speed. This must never
//    be corrected: it is the entire deployed fleet.
{
  const w = nid();
  let x = X0, z = Z0, moved = 0, corrected = 0;
  await move({ wallet: w, x, y: Y0, z, dir: 0 });
  for (let i = 0; i < 10; i++) {
    await sleep(280);
    z -= 18 * 1.68 * 0.28;                       // sprinting at the recorded client speed
    const r = await move({ wallet: w, x, y: Y0, z, dir: 0 });
    moved++;
    if (r.body.phys && r.body.phys.corr) corrected++;
    if (i === 9) console.log(`  honest old client: claimed (${f2(x)}, ${f2(z)}), server row (${f2(r.body.phys.x)}, ${f2(r.body.phys.z)}), corr=${r.body.phys.corr || 0}`);
  }
  chk(corrected === 0, `an honest position-only client is never corrected (${corrected}/${moved} pings)`);
  const st = srv._physStateForTest(w);
  chk(st && !st.driven, "a position-only client is not simulated at all (driven=false) — the tick leaves its row alone");
  chk(Math.abs(st.z - z) < 0.02, `the server row tracks the client exactly (server z ${f2(st.z)} vs claim ${f2(z)})`);
}

// 2. 200 u/s. The classic speed hack: honest cadence, impossible distance.
//    THE PROPERTY CHANGED ON 2026-08-01 AND THIS TEST CHANGED WITH IT. It used to assert that a
//    SINGLE 56 u ping is corrected, because the gate was `maxSpeed * dtWall + REACH_SLACK(6.0)` — a
//    per-MESSAGE allowance. That was wrong in both directions and both were measured:
//      * the allowance scaled with message rate, so 120 claims of 5.5 u posted as fast as HTTP
//        accepts them travelled at 3203 u/s uncorrected (_av_phys_attack_sim A10);
//      * 6.0 u is SMALLER than one honest report interval (8.47 u at the recorded client's sprint),
//        so a coalesced pair of reports — which Net.gd's two-lane pipeline produces routinely — was
//        corrected 18 times in 24 reports (_av_phys_honest_sim B4).
//    The gate is now a BANK (TUNE.REACH_BANK_S), so a single burst of up to 2.5 s x the ceiling is
//    deliberately allowed and the SUSTAINED rate is what is held down. That is the property worth
//    asserting anyway: a one-off 175 u displacement is indistinguishable from an honest stall flush,
//    while an hour of 200 u/s is not.
{
  const w = nid();
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  await sleep(280);
  const claimZ = Z0 - 200 * 0.28;                                  // 56 u in one 280 ms ping
  const r = await move({ wallet: w, x: X0, y: Y0, z: claimZ, dir: 0 });
  const burstAllow = P.maxSpeed("foot") * P.TUNE.REACH_BANK_S;
  console.log(`  claimed 200 u/s -> ${f2(Math.abs(claimZ - Z0) / 0.28)} u/s over 0.28 s; one-off bank ${f2(burstAllow)} u, ceiling ${f2(P.maxSpeed("foot"))} u/s`);
  console.log(`  claim z ${f2(claimZ)}; server kept z ${f2(r.body.phys.z)}; corr=${r.body.phys.corr || 0}`);
  chk(r.body.phys.corr !== 1, "one 56 u ping is inside the burst bank and is NOT fought (this is what stops honest rubber-banding)");
  // now SUSTAIN it: 20 more pings of 56 u at the honest cadence
  let z2 = claimZ, corrected = 0;
  const t0 = Date.now(), zStart = srv._physStateForTest(w).z;
  for (let i = 0; i < 20; i++) {
    await sleep(280);
    z2 -= 200 * 0.28;
    const rr = await move({ wallet: w, x: X0, y: Y0, z: z2, dir: 0 });
    if (rr.body.phys && rr.body.phys.corr) corrected++;
  }
  const st = srv._physStateForTest(w);
  const secs = (Date.now() - t0) / 1000;
  const rate = Math.abs(st.z - zStart) / secs;
  console.log(`  sustained: 20 more pings at 200 u/s over ${secs.toFixed(1)} s -> the row moved at ${f2(rate)} u/s (${corrected} corrected)`);
  chk(corrected >= 10, `a sustained 200 u/s claim is corrected (${corrected}/20 pings)`);
  chk(rate < P.maxSpeed("foot") * 2, `the row is held near the ceiling (${f2(rate)} u/s vs maxSpeed ${f2(P.maxSpeed("foot"))})`);
  chk(Math.abs(st.z - z2) > 100, `the server's position stands well behind the claim (${f2(st.z)} vs claimed ${f2(z2)})`);
  chk(st.rejects >= 1, `the state records the rejections (rejects=${st.rejects})`);
  // and the value routes stand down, exactly as they do after a warp
  const row = (await (await fetch(`${BASE}/world/players?wallet=${w}&x=${X0}&z=${Z0}`)).json());
  chk(!!row, "the world snapshot still answers for a corrected player (no disconnect, no kick)");
}

// 3. AN INFLATED dt BUYS NOTHING. Same wall-clock, same key held; one client claims honest 16 ms
//    frames, the other claims 1000 ms frames sixty times a second.
{
  const honest = nid(), liar = nid();
  const mk = (w) => ({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  await move(mk(honest)); await move(mk(liar));
  const inp = (seq, dt) => ({ seq, dt, move: { x: 0, z: -1 }, jump: false, sprint: true, mode: "foot" });
  const t0 = Date.now();
  let sh = 1, sl = 1;
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const frames = [];
    for (let k = 0; k < 6; k++) frames.push(inp(sh++, 1 / 60));      // 6 x 16.7 ms = 100 ms of real time
    await move({ wallet: honest, inputs: frames });                  // inputs ONLY — no claim to resync to
    const lies = [];
    for (let k = 0; k < 6; k++) lies.push(inp(sl++, 1.0));           // 6 x 1000 ms = 6 s claimed
    await move({ wallet: liar, inputs: lies });
  }
  const elapsed = (Date.now() - t0) / 1000;
  const H = srv._physStateForTest(honest), L = srv._physStateForTest(liar);
  const hd = Math.hypot(H.x - X0, H.z - Z0), ld = Math.hypot(L.x - X0, L.z - Z0);
  console.log(`  over ${f2(elapsed)} s of wall clock: honest client simulated ${f2(H.simT)} s -> ${f2(hd)} u; dt-inflating client claimed 60 s, simulated ${f2(L.simT)} s -> ${f2(ld)} u`);
  chk(L.simT <= elapsed + P.TUNE.BUDGET_MAX + 0.2, `the liar's simulated time (${f2(L.simT)} s) cannot exceed the wall clock (${f2(elapsed)} s) plus the ${P.TUNE.BUDGET_MAX} s bank`);
  chk(hd > 5, `the honest input-only client really did move (${f2(hd)} u)`);
  chk(ld < hd * 1.5, `the liar covered ${f2(ld)} u against the honest ${f2(hd)} u — inflation bought ${f2(ld - hd)} u, not the ${f2(18 * 60)} u its claimed 60 s would have paid for`);
}

// 3b. THE HONEST HILL, REPLAYED THROUGH THE SERVER. The recording of the real client climbing a
//     slope, fed to /world/move at the shipped 280 ms cadence with matching inputs. Zero
//     corrections is the whole compatibility promise: the model over-runs this player by metres and
//     must still never fight them.
{
  const r = runs.hill;
  if (r) {
    const w = nid();
    const fr = r.frames, tps = meta.physics_tps || 60, W = Math.round(0.28 * tps);
    await move({ wallet: w, x: r.start[0], y: r.start[1], z: r.start[2], dir: 0 });
    let corrections = 0, pings = 0, worstSim = 0, lastI = 0;
    for (let i = W - 1; i < fr.length; i += W) {
      lastI = i;
      await sleep(280);
      const frames = [];
      for (let k = 0; k < 6; k++) frames.push({ seq: pings * 6 + k + 1, dt: 1 / 60, move: { x: r.move[0], z: r.move[1] }, sprint: !!r.run, mode: "foot" });
      const rep = await move({ wallet: w, x: fr[i][1], y: fr[i][2], z: fr[i][3], dir: 0, inputs: frames });
      pings++;
      if (rep.body.phys && rep.body.phys.corr) corrections++;
      const st = srv._physStateForTest(w);
      const d = Math.hypot(st.x - fr[i][1], st.z - fr[i][3]);
      if (d > worstSim) worstSim = d;
    }
    const st = srv._physStateForTest(w);
    console.log(`  recorded hill climb replayed as ${pings} pings at 280 ms: corrections ${corrections}, learned mult ${f3(st.mult)} (real ${FOOT_MULT}), worst |sim-claim| after resync ${f3(worstSim)} u`);
    chk(corrections === 0, `an honestly recorded uphill sprint is corrected ZERO times (${corrections}/${pings})`);
    chk(Math.abs(st.z - fr[lastI][3]) < 0.05 && Math.abs(st.x - fr[lastI][1]) < 0.05,
      `the server ends where the client's last replayed frame was (${f2(st.x)}, ${f2(st.z)}) vs (${f2(fr[lastI][1])}, ${f2(fr[lastI][3])})`);
  }
}

// 4. INPUT-DRIVEN MOVEMENT: the server derives the position from inputs alone (no claim at all).
{
  const w = nid();
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  const st0 = srv._physStateForTest(w);
  let seq = 1;
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) {
    await sleep(100);
    const frames = [];
    for (let k = 0; k < 6; k++) frames.push({ seq: seq++, dt: 1 / 60, move: { x: 0, z: -1 }, jump: false, sprint: true, mode: "foot" });
    // NO x/y/z here at all: the client sends only inputs. worldMoveApply clamps missing coords to 0,
    // which is exactly the hostile case — the server must not follow them to the origin.
    var last = await move({ wallet: w, inputs: frames });
  }
  const st = srv._physStateForTest(w);
  const wall = (Date.now() - t0) / 1000;
  console.log(`  input-only client: ack=${last.body.phys.ack} (sent ${seq - 1} frames), simulated ${f2(st.simT)} s over ${f2(wall)} s wall`);
  console.log(`  derived position (${f2(st.x)}, ${f2(st.y)}, ${f2(st.z)}) from (${f2(X0)}, ${f2(Y0)}, ${f2(Z0)}); moved ${f2(Math.hypot(st.x - X0, st.z - Z0))} u`);
  chk(last.body.phys.ack === seq - 1, `the snapshot acks the last input seq (${last.body.phys.ack})`);
  chk(st.driven === true, "an input-sending client IS simulated (driven=true)");
  chk(Math.hypot(st.x - X0, st.z - Z0) > 5, `the server moved the player from inputs alone (${f2(Math.hypot(st.x - X0, st.z - Z0))} u)`);
  chk(Math.abs(st.y - P.groundAt(st.x, st.z)) < 0.01, `the derived position sits ON the terrain (y ${f3(st.y)} = ground ${f3(P.groundAt(st.x, st.z))})`);
  chk(st.x !== 0 && st.z !== 0, "an absent x/z in the body did NOT drag the simulated player to the origin");
}

// 5. WALKING INTO A HILL DOES NOT TUNNEL — through the server, with inputs, at the recorded wall.
{
  const w = nid();
  const WX = -254, WZ = 244, WY = P.groundAt(WX, WZ);
  await move({ wallet: w, x: WX, y: WY, z: WZ, dir: 0 });
  let seq = 1;
  // INPUTS ONLY. Sending a fixed claim alongside them would resync the model back to the start every
  // ping and prove nothing — the server has to walk this player into the mountain by itself.
  for (let i = 0; i < 14; i++) {
    await sleep(120);
    const frames = [];
    for (let k = 0; k < 7; k++) frames.push({ seq: seq++, dt: 1 / 60, move: { x: -1, z: 0 }, jump: false, sprint: true, mode: "foot" });
    await move({ wallet: w, inputs: frames });
  }
  const st = srv._physStateForTest(w);
  const freeRun = P.PHYS.RUN * 1.0 * st.simT;
  console.log(`  wall run (server-derived, ${f2(st.simT)} s simulated): x ${f2(WX)} -> ${f2(st.x)}; unobstructed that is ${f2(freeRun)} u, actual ${f2(WX - st.x)} u`);
  console.log(`  ground: ${f2(WY)} at the start, ${f2(P.groundAt(st.x, st.z))} where it stopped, ${f2(P.groundAt(WX - 20, WZ))} twenty units in`);
  chk(st.x > WX - 20, `the server did not walk into the mountain (stopped at x=${f2(st.x)}; the face starts about x=${f2(WX - 10)})`);
  chk(WX - st.x < freeRun * 0.6, `the mountain actually stopped it (${f2(WX - st.x)} u covered of ${f2(freeRun)} u unobstructed)`);
  chk(st.y >= P.groundAt(st.x, st.z) - 1e-6, `never below the terrain (y ${f3(st.y)} >= ground ${f3(P.groundAt(st.x, st.z))})`);
  chk(st.blocked === true, "the state records that the model was blocked (which disarms the ahead-of-sim gate for the next claim)");
}

// 6. THE FLOOR. A claim underneath the island is lifted onto it, not accepted.
{
  const w = nid();
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  await sleep(120);
  const r = await move({ wallet: w, x: X0, y: Y0 - 40, z: Z0, dir: 0 });   // 40 u under the plateau
  console.log(`  claimed y ${f2(Y0 - 40)} under a ground of ${f2(Y0)}; server stored y ${f2(r.body.phys.y)}`);
  chk(Math.abs(r.body.phys.y - Y0) < 0.01, `a sub-terrain claim is lifted to the surface (${f2(r.body.phys.y)})`);
}

// 7. TELEPORTS. The rescue is honoured; a silent 900-unit jump is not.
{
  const w = nid();
  const SX = 24, SZ = -700, SY = P.groundAt(SX, SZ);
  await move({ wallet: w, x: SX, y: 3.0, z: SZ, dir: 0 });
  await sleep(280);
  const resc = await move({ wallet: w, x: 105, y: 23, z: -104, dir: 0 });   // the REAL rescue landing
  const jumped = Math.hypot(105 - SX, -104 - SZ);
  console.log(`  drown rescue: ${f2(jumped)} u in one ping -> server stored (${f2(resc.body.phys.x)}, ${f2(resc.body.phys.z)}), corr=${resc.body.phys.corr || 0}`);
  chk(!resc.body.phys.corr && Math.abs(resc.body.phys.x - 105) < 0.5, "the drowning rescue is ACCEPTED (the server does not fight it)");

  const w2 = nid();
  await move({ wallet: w2, x: X0, y: Y0, z: Z0, dir: 0 });
  await sleep(280);
  const sneak = await move({ wallet: w2, x: X0 + 900, y: Y0, z: Z0, dir: 0 });
  console.log(`  silent 900 u jump: claimed x ${f2(X0 + 900)}, server kept x ${f2(sneak.body.phys.x)}, corr=${sneak.body.phys.corr || 0}`);
  chk(sneak.body.phys.corr === 1 && Math.abs(sneak.body.phys.x - X0) < 1, "a silent 900-unit jump is CORRECTED");

  // the explicit server-side accept path, for teleports the server itself performs
  const w3 = nid();
  await move({ wallet: w3, x: X0, y: Y0, z: Z0, dir: 0 });
  srv._physGrantTeleportForTest(w3, 300, P.groundAt(300, 300), 300, "arena");
  await sleep(120);
  const after = await move({ wallet: w3, x: 300, y: P.groundAt(300, 300), z: 300, dir: 0 });
  console.log(`  granted teleport to (300, 300): server stored (${f2(after.body.phys.x)}, ${f2(after.body.phys.z)}), corr=${after.body.phys.corr || 0}`);
  chk(!after.body.phys.corr && Math.abs(after.body.phys.x - 300) < 0.5, "an explicitly granted teleport is honoured");
}

// 8. MALFORMED FRAMES ARE DROPPED, NOT FATAL.
{
  const w = nid();
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  const before = srv._physStatsForTest().drops;
  const junk = [
    { seq: "x", dt: 0.016, move: { x: 0, z: -1 } },
    { seq: 5, dt: -3, move: { x: 0, z: -1 } },
    { seq: 6, dt: 1e9, move: { x: 0, z: -1 } },
    { seq: 7, dt: 0.016, move: { x: NaN, z: -1 } },
    { seq: 8, dt: 0.016, move: { x: 1e12, z: 1e12 } },     // over-long vector: normalised, not fatal
    { seq: 9, dt: 0.016 },                                  // no move at all
    null, 42, "hello",
  ];
  const r = await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0, inputs: junk });
  const st = srv._physStateForTest(w);
  console.log(`  ${junk.length} malformed frames -> code ${r.code}, drops ${srv._physStatsForTest().drops - before}, state x=${f2(st.x)} z=${f2(st.z)}`);
  chk(r.code === 200, "a malformed input frame does not fail the request");
  chk(Number.isFinite(st.x) && Number.isFinite(st.z) && Number.isFinite(st.y), "no NaN reached the state");
  chk(srv._physStatsForTest().drops - before >= 5, `the bad frames were dropped (${srv._physStatsForTest().drops - before})`);
  const replay = await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0, inputs: [{ seq: 1, dt: 0.016, move: { x: 0, z: -1 }, mode: "foot" }] });
  chk(replay.code === 200, "a replayed (stale) seq is dropped, not an error");
}

// 9. THE 20 Hz TICK advances a simulated player between their own reports.
{
  const w = nid();
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0 });
  await move({ wallet: w, x: X0, y: Y0, z: Z0, dir: 0, inputs: [{ seq: 1, dt: 1 / 60, move: { x: 0, z: -1 }, sprint: true, mode: "foot" }] });
  const a = { ...srv._physStateForTest(w) };
  await sleep(250);                                          // 5 ticks, and NOT one client message
  const b = srv._physStateForTest(w);
  const observer = nid();
  const snap = await move({ wallet: observer, x: X0, y: Y0, z: Z0 + 20, dir: 0 });
  const peer = (snap.body.players || []).find(p => p.wallet === w || p.w === w);
  console.log(`  between reports the tick moved the player ${f2(Math.hypot(b.x - a.x, b.z - a.z))} u (${f2(a.z)} -> ${f2(b.z)}) with no client traffic`);
  console.log(`  a peer's snapshot row for them: ${JSON.stringify(peer && { x: peer.x, y: peer.y, z: peer.z, dir: peer.dir })}`);
  chk(Math.hypot(b.x - a.x, b.z - a.z) > 1, "the 20 Hz tick advances a simulated player between their reports");
  chk(!!peer && Math.abs(peer.z - b.z) < 0.02, "the peer snapshot carries the SIMULATED position, not the last claim");
  await sleep(600);                                          // past INPUT_TTL
  const c = srv._physStateForTest(w);
  const after = { ...c };
  await sleep(300);
  const d = srv._physStateForTest(w);
  console.log(`  after INPUT_TTL (${P.TUNE.INPUT_TTL}s) of silence the tick moved them a further ${f3(Math.hypot(d.x - after.x, d.z - after.z))} u`);
  chk(Math.hypot(d.x - after.x, d.z - after.z) < 0.05, "a client that stops sending stops MOVING (held input expires)");
}

console.log(`  final: ${JSON.stringify(srv._physStatsForTest())}`);

// ---------------------------------------------------------------------------------------------
// PART 3 — CHIK_PHYS=0 IS TODAY'S SERVER, BYTE FOR BYTE
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("--- PART 3: CHIK_PHYS=0 vs the PRE-CHANGE server.js, byte for byte ---");

const SCRATCH = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/phys_baseline";
function bootChild(dir, port, env = {}) {
  const child = spawn(process.execPath, ["boot.mjs"], {
    cwd: dir,
    env: { ...process.env, AVPORT: String(port), PORT: String(port), CHIK_PHYS: "", CHIK_WS: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { const s = String(d); if (/Error|error/.test(s)) console.log("    child stderr:", s.trim().slice(0, 200)); });
  return child;
}
if (!fs.existsSync(path.join(SCRATCH, "server.js"))) {
  chk(false, `baseline server.js missing at ${SCRATCH} — cannot run the byte comparison`);
} else {
  fs.copyFileSync("./_av_ws_boot.mjs", path.join(SCRATCH, "boot.mjs"));
  const HERE = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/phys_current";
  fs.rmSync(HERE, { recursive: true, force: true });
  fs.mkdirSync(HERE, { recursive: true });
  for (const f of ["server.js", "cup-live.js", "cup-resolver.js", "pvp-engine.js", "package.json", "world_terrain.js", "world_physics.js", "_av_ws_boot.mjs"]) {
    if (fs.existsSync("./" + f)) fs.copyFileSync("./" + f, path.join(HERE, f));
  }
  fs.copyFileSync("./_av_ws_boot.mjs", path.join(HERE, "boot.mjs"));
  try { fs.symlinkSync("/Users/michaelkennethbrillantes/Downloads/chiki-backend/node_modules", path.join(HERE, "node_modules")); } catch {}

  const PB = 39831, PC = 39832;
  const cb = bootChild(SCRATCH, PB), cc = bootChild(HERE, PC);
  await sleep(2600);
  const hit = async (port, p, b) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { code: r.status, text: await r.text() };
  };
  // The SAME wallets, the SAME bodies, in the SAME order, against both servers. `a` (age in ms) is
  // the only genuinely live field in a reply and is excluded — the ws_transport ledger entry burned
  // a rerun on exactly that.
  const norm = (s) => s.replace(/"a":\d+/g, '"a":0').replace(/"ts":\d+/g, '"ts":0').replace(/"t":\d{10,}/g, '"t":0');
  const W1 = "godot-cmp-aaaaaaa", W2 = "godot-cmp-bbbbbbb";
  const bodies = [
    { wallet: W1, x: X0, y: Y0, z: Z0, dir: 0.5, handle: "Cmp", avatar: "classic", comp: "chikimon", party: "a,b,c", mount: "", act: "", eggs: "normal", spr: false, leg: 3, el: "Fire", br: 7 },
    { wallet: W2, x: X0 + 5, y: Y0, z: Z0 + 5, dir: 1.5, handle: "Cmp2", avatar: "electro", comp: "x", mount: "horse", act: "chop:axe", eggs: "meme,mount", spr: true, leg: 4, el: "Water", br: 9 },
    { wallet: W1, x: X0, y: Y0, z: Z0 - 3, dir: 0.7, handle: "Cmp", avatar: "classic", comp: "chikimon", party: "a,b,c", mount: "", act: "", eggs: "normal", spr: false, leg: 3, el: "Fire", br: 7 },
    { wallet: W1, x: X0 + 900, y: Y0, z: Z0, dir: 0.7, handle: "Cmp" },                       // a teleport — must relay, uncorrected
    { wallet: W2, x: X0 + 5, y: Y0 - 50, z: Z0 + 5, dir: 1.5, handle: "Cmp2", mount: "horse" }, // under the terrain — must relay
    { wallet: W1, x: X0, y: Y0, z: Z0, dir: 0.7, handle: "Cmp", inputs: [{ seq: 1, dt: 0.016, move: { x: 0, z: -1 }, mode: "foot" }] },  // inputs an old server never saw
  ];
  let same = 0, diff = 0, firstDiff = null;
  for (const b of bodies) {
    const rb = await hit(PB, "/world/move", b);
    const rc = await hit(PC, "/world/move", b);
    const nb = norm(rb.text), nc = norm(rc.text);
    if (rb.code === rc.code && nb === nc) same++;
    else { diff++; if (!firstDiff) firstDiff = { b: JSON.stringify(b).slice(0, 90), base: nb.slice(0, 260), cur: nc.slice(0, 260) }; }
  }
  console.log(`  ${bodies.length} identical request bodies: ${same} byte-identical replies, ${diff} different`);
  if (firstDiff) { console.log(`    first difference on ${firstDiff.b}`); console.log(`      baseline: ${firstDiff.base}`); console.log(`      current : ${firstDiff.cur}`); }
  chk(diff === 0, `with CHIK_PHYS unset the current server is byte-identical to the pre-change server (${same}/${bodies.length})`);
  const gb = await (await fetch(`http://127.0.0.1:${PB}/world/players?wallet=${W1}&x=${X0}&z=${Z0}`)).text();
  const gc = await (await fetch(`http://127.0.0.1:${PC}/world/players?wallet=${W1}&x=${X0}&z=${Z0}`)).text();
  chk(norm(gb) === norm(gc), "GET /world/players is byte-identical too");
  const anyPhys = (await hit(PC, "/world/move", bodies[0])).text.includes('"phys"');
  console.log(`  reply from the flag-off server contains a "phys" key: ${anyPhys}`);
  chk(anyPhys === false, 'no "phys" field exists anywhere in a CHIK_PHYS=0 reply');
  cb.kill("SIGKILL"); cc.kill("SIGKILL");
}

// ---------------------------------------------------------------------------------------------
// PART 4 — CHIK_PHYS=1 WITH NO ISLAND FILE MUST NOT "HALF WORK"
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("--- PART 4: CHIK_PHYS=1 without island_data.bin refuses to start ---");
{
  const HERE = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/phys_current";
  if (fs.existsSync(HERE)) {
    const PN = 39833;
    const child = spawn(process.execPath, ["boot.mjs"], {
      cwd: HERE,
      // point the island lookup at a path that does not exist AND clear HOME, so the module's
      // fallback to ~/Downloads/ChikoriaSmooth cannot rescue it
      env: { ...process.env, AVPORT: String(PN), PORT: String(PN), CHIK_PHYS: "1", CHIK_WS: "0", CHIK_ISLAND_BIN: "/nope/island_data.bin", HOME: "/nope" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += String(d); });
    child.stderr.on("data", () => {});
    await sleep(2600);
    const r = await fetch(`http://127.0.0.1:${PN}/world/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: "godot-noterrain", x: X0, y: Y0 - 40, z: Z0, dir: 0 }) });
    const body = await r.json();
    const refused = /REFUSED TO START/.test(log);
    console.log(`  boot log says refused: ${refused}`);
    console.log(`  a sub-terrain claim with no island file: stored y ${body.players !== undefined ? "(reply ok)" : "?"}, phys field present: ${body.phys !== undefined}`);
    chk(refused, "CHIK_PHYS=1 with no island_data.bin logs a refusal instead of running on a fake floor");
    chk(body.phys === undefined, "and behaves exactly like the flag-off relay (no phys field, no lift)");
    child.kill("SIGKILL");
  } else chk(false, "part 4 needs the copied server dir from part 3");
}

console.log("");
console.log(`PHYSICS_AUTHORITY_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
