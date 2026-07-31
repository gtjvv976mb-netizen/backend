#!/usr/bin/env node
// HONEST PLAY UNDER CHIK_PHYS=1 — the half that loses players if it is wrong.
// Boots the REAL server.js in-process (throwaway keypair, dummy RPC, memory store, unique port).
// NEVER touches the live backend.
//
// Every run below is either a RECORDING OF THE REAL CLIENT (dev_physdump.gd, real Jolt collision,
// real voxel world) replayed at the client's real report cadence, or a scripted honest journey at
// the real speeds. The number that matters is the CORRECTION RATE: how often the server refuses a
// position an honest player actually reached. Anything above a few percent is rubber-banding.
import { createRequire } from "module";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59975";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = process.env.AVHONPORT || "39751";
process.env.CHIK_PHYS = "1";
process.env.CHIK_WS = "0";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

const BASE = "http://127.0.0.1:" + process.env.PORT;
const SRV = await import(new URL("./server.js", import.meta.url).href);
const P = await import(new URL("./world_physics.js", import.meta.url).href);
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, a = "") => { if (c) { pass++; console.log("  ok   " + n + (a ? "  [" + a + "]" : "")); } else { fail++; fails.push(n + " — " + a); console.log("  FAIL " + n + (a ? "  [" + a + "]" : "")); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nid = (s) => "godot-" + crypto.createHash("sha1").update(s + Math.random()).digest("hex").slice(0, 8);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
for (let i = 0; i < 200; i++) { try { if ((await get("/world/roster")).status === 200) break; } catch (e) {} await sleep(100); }
console.log("=== _av_phys_honest_sim (CHIK_PHYS=1) ===");
console.log("phys: " + JSON.stringify(SRV._physStatsForTest()));

const MOVE_DT = 280;          // Net.gd MOVE_DT
const DUMP = path.join(process.env.HOME, "Library/Application Support/Godot/app_userdata/Chikoria (Smooth Voxel)/physdump");
const runs = {}; let meta = {};
for (const f of fs.readdirSync(DUMP)) {
  if (!f.endsWith(".json")) continue;
  const j = JSON.parse(fs.readFileSync(path.join(DUMP, f), "utf8"));
  if (f === "_meta.json") meta = j; else runs[j.name] = j;
}
console.log(`client dump: ${Object.keys(runs).length} recorded runs, ${meta.physics_tps} Hz, spd_mult ${meta.spd_mult}`);

// Replay ONE recorded client run through the real /world/move at the real 280 ms cadence.
// `inputs` decides whether this is the SHIPPED fleet (position only) or a prediction client.
async function replayRun(run, { mount = "", withInputs = false, mode = "foot", dropPct = 0, latencyMs = 0 } = {}) {
  const w = nid(run.name + mount + withInputs);
  const fr = run.frames;                       // [t, x, y, z, vy, grounded?]
  const tps = meta.physics_tps || 60;
  const per = Math.round((MOVE_DT / 1000) * tps);
  let reports = 0, corrections = 0, teleports = 0, lifts = 0, worstDrift = 0, seq = 1, iseq = 1;
  await post("/world/move", { wallet: w, x: fr[0][1], y: fr[0][2], z: fr[0][3], dir: 0, handle: "H", mount, seq: seq++ });
  let last = 0;
  for (let i = per; i < fr.length; i += per) {
    await sleep(MOVE_DT);
    const f = fr[i];
    const body = { wallet: w, x: f[1], y: f[2], z: f[3], dir: 0, handle: "H", mount, seq: seq++ };
    if (withInputs) {
      const inputs = [];
      for (let k = last + 1; k <= i; k++) {
        if (dropPct && Math.random() * 100 < dropPct) { iseq++; continue; }
        inputs.push({ seq: iseq++, dt: 1 / tps, move: { x: run.move[0], z: run.move[1] }, jump: false, sprint: !!run.run, mode });
      }
      // Net.gd coalesces to <= INPUT_MAX_FRAMES (16); the server slices to 16 anyway.
      body.inputs = inputs.slice(-16);
    }
    if (latencyMs) await sleep(latencyMs);
    const r = await post("/world/move", body);
    reports++;
    const st = SRV._physStateForTest(w);
    if (st.lastAction === "correct") corrections++;
    else if (st.lastAction === "teleport") teleports++;
    else if (st.lastAction === "lift") lifts++;
    const drift = Math.hypot(st.x - f[1], st.z - f[3]);
    if (drift > worstDrift) worstDrift = drift;
    last = i;
  }
  return { w, reports, corrections, teleports, lifts, worstDrift, rate: reports ? corrections / reports : 0 };
}

// =========================================================================================
console.log("\n=== B1. THE SHIPPED FLEET (position only, no inputs) across every recorded run ===");
let totR = 0, totC = 0;
for (const name of ["flat_walk", "flat_sprint", "hill", "wall", "jump", "sea", "mount_ride", "mount_dash"]) {
  const r = runs[name]; if (!r) continue;
  const mount = name.startsWith("mount") ? "horse" : "";
  const o = await replayRun(r, { mount });
  totR += o.reports; totC += o.corrections;
  console.log(`  ${name.padEnd(12)} reports=${String(o.reports).padStart(3)}  corrections=${o.corrections}  lifts=${o.lifts}  teleports=${o.teleports}  worst drift=${f2(o.worstDrift)} u`);
}
console.log(`  TOTAL: ${totC} corrections in ${totR} reports = ${f1(100 * totC / totR)}%`);
ok("shipped-fleet correction rate across all recorded terrain is under 1%", totC / totR < 0.01, `${f1(100 * totC / totR)}% (${totC}/${totR})`);

// =========================================================================================
console.log("\n=== B2. A PREDICTION CLIENT (inputs + claims) across the same runs ===");
let pR = 0, pC = 0;
for (const name of ["flat_walk", "flat_sprint", "hill", "wall", "sea", "mount_ride", "mount_dash"]) {
  const r = runs[name]; if (!r) continue;
  const mount = name.startsWith("mount") ? "horse" : "";
  const mode = name.startsWith("mount") ? "mount" : "foot";
  const o = await replayRun(r, { mount, withInputs: true, mode });
  pR += o.reports; pC += o.corrections;
  console.log(`  ${name.padEnd(12)} reports=${String(o.reports).padStart(3)}  corrections=${o.corrections}  worst drift=${f2(o.worstDrift)} u`);
}
console.log(`  TOTAL: ${pC} corrections in ${pR} reports = ${f1(100 * pC / pR)}%`);
ok("prediction-client correction rate is under 1%", pC / pR < 0.01, `${f1(100 * pC / pR)}% (${pC}/${pR})`);

// =========================================================================================
console.log("\n=== B3. 10% OF INPUT FRAMES DROPPED, and a 300 ms-latency client ===");
{
  const o = await replayRun(runs.flat_sprint, { withInputs: true, dropPct: 10 });
  console.log(`  10% frame loss: corrections=${o.corrections}/${o.reports}, worst drift=${f2(o.worstDrift)} u`);
  ok("10% input-frame loss causes no corrections", o.corrections === 0, `${o.corrections}/${o.reports}`);
  const l = await replayRun(runs.flat_sprint, { withInputs: true, latencyMs: 300 });
  console.log(`  +300 ms one-way latency: corrections=${l.corrections}/${l.reports}, worst drift=${f2(l.worstDrift)} u`);
  ok("a 300 ms-latency client is never corrected", l.corrections === 0, `${l.corrections}/${l.reports}`);
}

// =========================================================================================
console.log("\n=== B4. BURST ARRIVAL — two reports arrive back to back after a stall ===");
// This is the classic false positive: a client stalls (GC pause, tab throttle, a lost packet
// retransmitted) and its next TWO reports land milliseconds apart carrying 560 ms of real movement.
// dtWall for the second one is ~0.01 s, so the ceiling collapses while the distance does not.
{
  const w = nid("burst");
  const SP = P.PHYS.RUN * 1.68;                    // the recorded save's real sprint speed, 30.24 u/s
  // The claimed y FOLLOWS THE GROUND, as a real client's does. A first pass held y at a constant 22
  // while running +x from (-550,240) — which walks into a mountainside that climbs 22 -> 70 over
  // 210 units, so the last third of the run was a player standing inside rock, not a burst test.
  let x = -550;
  const gy = (px) => P.groundAt(px, 240);
  await post("/world/move", { wallet: w, x, y: gy(x), z: 240, dir: 0, handle: "H" });
  let corr = 0, bursts = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(560);                              // a stall: TWO report intervals of movement
    x += SP * 0.28; await post("/world/move", { wallet: w, x, y: gy(x), z: 240, dir: 0, handle: "H" });
    if (SRV._physStateForTest(w).lastAction === "correct") corr++;
    x += SP * 0.28; await post("/world/move", { wallet: w, x, y: gy(x), z: 240, dir: 0, handle: "H" });   // arrives ~1 ms later
    if (SRV._physStateForTest(w).lastAction === "correct") corr++;
    bursts++;
  }
  console.log(`  ${bursts} stalls x 2 back-to-back reports at ${f2(SP)} u/s: ${corr} corrections in ${bursts * 2} reports`);
  ok("a stalled client whose next two reports arrive together is not corrected", corr === 0, `${corr}/${bursts * 2}`);
  // TEN coalesced reports — a 2.8 s network stall flushing at once, the worst a two-lane pipeline
  // plus a mobile radio wake-up can produce.
  const w2 = nid("burst10");
  let x2 = -550;
  await post("/world/move", { wallet: w2, x: x2, y: gy(x2), z: 240, dir: 0, handle: "H" });
  await sleep(2800);
  let c2 = 0;
  for (let k = 0; k < 10; k++) { x2 += SP * 0.28; await post("/world/move", { wallet: w2, x: x2, y: gy(x2), z: 240, dir: 0, handle: "H" }); if (SRV._physStateForTest(w2).lastAction === "correct") c2++; }
  console.log(`  a 2.8 s stall flushed as 10 back-to-back reports (${f2(10 * SP * 0.28)} u): ${c2} corrections`);
  ok("ten coalesced reports after a 2.8 s stall are not corrected", c2 === 0, `${c2}/10`);
}

// =========================================================================================
console.log("\n=== B4b. SPRINTING UP THE STEEPEST HONEST CLIMB (the endpoint-sampling change) ===");
// segmentPenetration now samples its own endpoint, which is what closed the 1-unit wall climb. The
// risk it carries is false positives on a real slope, so this is the steepest sustained climb on the
// island: z=240, x -550 -> -340, ground 22 -> 70. The ledger's measured uphill client speed is
// 26.33 u/s (13% slower than flat), and a real client's y sits on the ground.
{
  const w = nid("climb");
  let x = -550, corr = 0, n = 0;
  const gy = (px) => P.groundAt(px, 240);
  await post("/world/move", { wallet: w, x, y: gy(x), z: 240, dir: 0, handle: "H" });
  while (x < -345) {
    await sleep(MOVE_DT);
    x += 26.33 * (MOVE_DT / 1000);
    await post("/world/move", { wallet: w, x, y: gy(x), z: 240, dir: 0, handle: "H" });
    n++; if (SRV._physStateForTest(w).lastAction === "correct") corr++;
  }
  console.log(`  ${n} reports climbing 48 units of altitude over 205 units of ground: ${corr} corrections`);
  ok("the steepest sustained climb on the island produces no corrections", corr === 0, `${corr}/${n}`);
}

// =========================================================================================
console.log("\n=== B5. THE BOAT AT 70 u/s — the fastest legitimate thing in the game ===");
// OPEN WATER, found by scanning the heightfield: at x=-700 the seabed is at -7 from z=-800 to z=120,
// i.e. 920 units of sea. A first pass sailed at x=24 from z=-646 and CROSSED THE COAST at report 9
// (the seabed climbs to 22 there), which is a boat driving up a beach, not a voyage — and it
// produced the finding in B9 below rather than a boat result.
{
  const w = nid("boat");
  let x = -700, z = -700;
  await post("/world/move", { wallet: w, x, y: 6.6, z, dir: 0, handle: "H" });
  let corr = 0, n = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(MOVE_DT);
    z += P.PHYS.BOAT * (MOVE_DT / 1000);
    await post("/world/move", { wallet: w, x, y: 6.6, z, dir: 0, handle: "H" });
    n++; if (SRV._physStateForTest(w).lastAction === "correct") corr++;
  }
  const st = SRV._physStateForTest(w);
  console.log(`  20 reports at 70 u/s: ${corr} corrections; server row z=${f2(st.z)} vs claim ${f2(z)}`);
  ok("a boat at full speed (position-relay client) is never corrected", corr === 0, `${corr}/${n}`);
  // the DECLARING boat client
  const w2 = nid("boat2");
  let z2 = -700;
  await post("/world/move", { wallet: w2, x, y: 6.6, z: z2, dir: 0, handle: "H" });
  let c2 = 0, iq = 1;
  for (let i = 0; i < 20; i++) {
    await sleep(MOVE_DT);
    const inputs = [];
    for (let k = 0; k < 16; k++) inputs.push({ seq: iq++, dt: 0.0175, move: { x: 0, z: 1 }, mode: "boat" });
    z2 += P.PHYS.BOAT * (MOVE_DT / 1000);
    await post("/world/move", { wallet: w2, x, y: 6.6, z: z2, dir: 0, handle: "H", inputs });
    if (SRV._physStateForTest(w2).lastAction === "correct") c2++;
  }
  console.log(`  the same voyage from a client that DECLARES mode:"boat": ${c2} corrections`);
  ok("a declaring boat client is never corrected", c2 === 0, `${c2}/20`);
}

// =========================================================================================
console.log("\n=== B6. THE DROWN RESCUE — a real 600+ u teleport the client fires on its own ===");
{
  const w = nid("drown");
  await post("/world/move", { wallet: w, x: 24, y: 3.0, z: -646, dir: 0, handle: "H" });
  await sleep(MOVE_DT);
  // Player.gd:1737 puts the player at (105, surf+1.5, -104) with no server involvement at all
  const r = await post("/world/move", { wallet: w, x: 105, y: P.groundAt(105, -104) + 0.5, z: -104, dir: 0, handle: "H" });
  const st = SRV._physStateForTest(w);
  const jump = Math.hypot(105 - 24, -104 + 646);
  console.log(`  the ${f2(jump)} u rescue: action=${st.lastAction}, server row=(${f2(st.x)},${f2(st.z)})`);
  ok("the drowning rescue is accepted, not fought", st.lastAction === "teleport" && Math.abs(st.x - 105) < 1,
     `action=${st.lastAction} x=${f2(st.x)}`);
  // and the player can carry on playing normally for a minute afterwards
  let corr = 0; let x = 105;
  for (let i = 0; i < 15; i++) { await sleep(MOVE_DT); x += 5.0; await post("/world/move", { wallet: w, x, y: P.groundAt(x, -104), z: -104, dir: 0, handle: "H" }); if (SRV._physStateForTest(w).lastAction === "correct") corr++; }
  ok("...and normal running afterwards is not corrected", corr === 0, `${corr}/15`);
}

// =========================================================================================
console.log("\n=== B7. A PHONE AT 30 fps SENDING SPARSE INPUTS ===");
{
  const w = nid("phone");
  let x = -550, z = 240, iq = 1, corr = 0;
  await post("/world/move", { wallet: w, x, y: 22, z, dir: 0, handle: "H" });
  for (let i = 0; i < 20; i++) {
    await sleep(MOVE_DT);
    const inputs = [];
    for (let k = 0; k < 8; k++) inputs.push({ seq: iq++, dt: 1 / 30, move: { x: 0, z: -1 }, sprint: true, mode: "foot" });
    z -= P.PHYS.RUN * 1.68 * (MOVE_DT / 1000);
    await post("/world/move", { wallet: w, x, y: 22, z, dir: 0, handle: "H", inputs });
    if (SRV._physStateForTest(w).lastAction === "correct") corr++;
  }
  console.log(`  30 fps (8 frames of dt 1/30 per report), 20 reports: ${corr} corrections`);
  ok("a 30 fps phone is never corrected", corr === 0, `${corr}/20`);
}

// =========================================================================================
console.log("\n=== B8. A MOUNT AT FULL SPEED WITH THE BEST GEAR IN THE GAME ===");
{
  // walk 9 x (boots 1.98 + griffin 1.40) x proud 1.03 x navigator 1.18 x serum 1.40 x dash 1.85
  const top = P.PHYS.WALK * P.MAX_MULT_MOUNT * P.PHYS.MOUNT_DASH_WOLF;
  const w = nid("mount");
  let x = -550, z = 240, corr = 0;
  await post("/world/move", { wallet: w, x, y: 22, z, dir: 0, handle: "H", mount: "wolf" });
  for (let i = 0; i < 20; i++) {
    await sleep(MOVE_DT);
    z -= top * (MOVE_DT / 1000);
    await post("/world/move", { wallet: w, x, y: 22, z, dir: 0, handle: "H", mount: "wolf" });
    if (SRV._physStateForTest(w).lastAction === "correct") corr++;
  }
  console.log(`  a dashing Direwolf at the theoretical maximum ${f2(top)} u/s: ${corr} corrections in 20 reports`);
  ok("the fastest possible mount is never corrected", corr === 0, `${corr}/20`);
}

// =========================================================================================
console.log("\n=== B9. A PERSISTENT CORRECTION MUST NOT BRICK A PLAYER ===");
// Found by accident: a boat driven up a beach put the claim below terrain the heightfield calls
// solid, and every subsequent report was refused "through-terrain" — 12 in a row, with the presence
// row stranded 235 u behind and NO path back, because the base every check measures from is frozen
// at the last accepted claim. Every value route reads that row, so a stuck correction does not
// rubber-band a player, it takes their gathering away until they relog. This is the escape hatch.
{
  const w = nid("stuck");
  let x = 24, z = -646;
  await post("/world/move", { wallet: w, x, y: 6.6, z, dir: 0, handle: "H" });
  let corr = 0, resync = 0, n = 0, followed = 0;
  for (let i = 0; i < 26; i++) {
    await sleep(MOVE_DT);
    z += 70 * (MOVE_DT / 1000);                  // sails onto the beach and keeps going inland
    await post("/world/move", { wallet: w, x, y: 6.6, z, dir: 0, handle: "H" });
    const a = SRV._physStateForTest(w).lastAction;
    n++;
    if (a === "correct") corr++; else if (a === "resync") resync++;
    if (Math.abs(SRV._physStateForTest(w).z - z) < 1) followed++;
  }
  const st = SRV._physStateForTest(w);
  console.log(`  ${n} reports: ${corr} corrections, ${resync} resyncs; server row z=${f2(st.z)} vs claim ${f2(z)} (${followed} reports where the row was with the player)`);
  ok("a player whose claims are persistently refused is resynced, not frozen", resync >= 1, `resyncs=${resync}`);
  ok("...and the presence row ends up with the player, not stranded", Math.abs(st.z - z) < 200, `gap=${f2(Math.abs(st.z - z))} u`);
  // and the resync must NOT be a free gather
  const gate = await post("/world/node/claim", { wallet: w, x, z, id: `wood:0:-204`, cd: 2000 });
  console.log(`  a gather immediately after the resync: ${gate.status} ${JSON.stringify(gate.j.error || gate.j.drop || "")}`);
  ok("a resync hands back the POSITION and withholds the PAYOUT", gate.status === 403, `status=${gate.status}`);
}

// =========================================================================================
console.log("\n=== B10. THE THREE MINE LANDMARKS — the one place a heightfield can be wrong ===");
// The through-terrain rule is the only test that can persistently refuse a player who is genuinely
// where they say they are: a heightfield has no interiors. The three mines (Gather.gd:347-349) are
// the only authored openings in the island, so they are where the risk lives. Measured, not assumed.
{
  const MINES = [["gold", -232, 360], ["iron", -388, 340], ["crystal_mine", -332, 224]];
  let worst = 0, worstAt = "";
  for (const [name, mx, mz] of MINES) {
    const y = P.groundAt(mx, mz);
    for (const [dx, dz, lbl] of [[1, 0, "+x"], [-1, 0, "-x"], [0, 1, "+z"], [0, -1, "-z"]]) {
      const pen = P.segmentPenetration(mx, y, mz, mx + dx * 24, y, mz + dz * 24);
      if (pen > worst) { worst = pen; worstAt = `${name} ${lbl}`; }
    }
    console.log(`  ${name.padEnd(13)} groundAt=${f2(P.groundAt(mx, mz))}  worst 24 u traverse pen=${f2(Math.max(...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => P.segmentPenetration(mx, y, mz, mx + dx * 24, y, mz + dz * 24))))}`);
  }
  console.log(`  worst of all 12 traverses: ${f2(worst)} u at ${worstAt}, against PEN_TOL ${P.TUNE.PEN_TOL}`);
  ok("walking 24 u in any direction at any mine mouth stays inside PEN_TOL", worst <= P.TUNE.PEN_TOL,
     `worst=${f2(worst)} at ${worstAt} (margin ${f2(P.TUNE.PEN_TOL - worst)} u)`);
}

console.log(`\nAV_PHYS_HONEST_DONE pass=${pass} fail=${fail}`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(0);
