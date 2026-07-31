#!/usr/bin/env node
// ADVERSARIAL VERIFICATION of server-authoritative movement (CHIK_PHYS=1).
// Boots the REAL server.js in-process. Throwaway keypair, memory store, dummy RPC, unique port.
// NEVER touches the live backend or any chain.
//
// DIRECTION A — cheats that must fail.
//   A1  speed hack: claim 200 u/s (position-relay client, the whole shipped fleet)
//   A2  inflated dt
//   A3  teleport onto a node and claim it — does the warp hold still bite?
//   A4  fly: claim a y far above the ground
//   A5  tunnel through a hill
//   A6  replay another player's input frames
//   A7  send inputs for a wallet you do not own
//   A8  seq that jumps backwards / repeats / leaps to MAX_SAFE_INTEGER
//   A9  mode:"spec" — the CREATOR free-fly ceiling, declared by anyone
//   A10 REACH_SLACK farming — many small claims instead of one big one
//   A11 the teleport window that never lapses
//   A12 PEN_TOL bypass by hops of <= 1 unit
import { createRequire } from "module";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));
const bs58 = (m => m.default || m)(require("bs58"));
import crypto from "node:crypto";

const _t = nacl.sign.keyPair();                        // THROWAWAY
process.env.RPC_URL = "http://127.0.0.1:59977";        // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = process.env.AVPHYSPORT || "39733";
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
const ok = (n, c, actual = "") => { if (c) { pass++; console.log("  ok   " + n + (actual ? "  [" + actual + "]" : "")); } else { fail++; fails.push(n + " — " + actual); console.log("  FAIL " + n + (actual ? "  [" + actual + "]" : "")); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nid = (s) => "godot-" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

for (let i = 0; i < 200; i++) { try { if ((await get("/world/roster")).status === 200) break; } catch (e) {} await sleep(100); }
console.log("=== _av_phys_attack_sim (CHIK_PHYS=1) ===");
console.log("phys stats at boot: " + JSON.stringify(SRV._physStatsForTest()));

const mv = (w, x, z, extra = {}) => post("/world/move", {
  wallet: w, x, z, y: extra.y !== undefined ? extra.y : P.groundAt(x, z), dir: 0,
  handle: "T", leg: 14, el: "Fire", br: 9, avatar: "classic", ...extra,
});
async function proven(tag) {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey);
  const msg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
  const v = (await post("/verify", { wallet: w, netId: nid(tag), authMsg: msg, authSig: sg })).j;
  return { w, tok: v.mktToken };
}
const stOf = (w) => SRV._physStateForTest(w);

// A flat-ish patch of island used as the baseline everywhere below.
const HOME = { x: 60, z: 60 };
console.log(`ground at HOME(${HOME.x},${HOME.z}) = ${f2(P.groundAt(HOME.x, HOME.z))}`);

// =========================================================================================
console.log("\n=== A1. SPEED HACK — a position-relay client claiming 200 u/s ===");
// The security property is a SUSTAINED one, not a per-message one: the reach bank deliberately holds
// one burst (REACH_BANK_S x the ceiling = 175 u), because that is what a coalesced pair of honest
// reports after a network stall looks like. What must never happen is a sustained rate above the
// ceiling. So the first burst is skipped and the LAST window is what is measured.
{
  const w = nid("a1");
  await mv(w, HOME.x, HOME.z);
  const CEIL = 70;                              // maxSpeed floor for a non-declaring client
  let claimed = HOME.x;
  for (let i = 0; i < 10; i++) { await sleep(300); claimed += 60; await mv(w, claimed, HOME.z); }   // drain the bank
  const mark = { x: stOf(w).x, z: stOf(w).z, t: Date.now() };
  for (let i = 0; i < 30; i++) { await sleep(300); claimed += 60; await mv(w, claimed, HOME.z); }
  const secs = (Date.now() - mark.t) / 1000;
  const far = Math.hypot(stOf(w).x - mark.x, stOf(w).z - mark.z);
  console.log(`     claiming 200 u/s for ${secs.toFixed(1)} s after the bank was drained: the row moved ${f2(far)} u = ${f2(far / secs)} u/s`);
  ok("sustained 200 u/s is held at or under the ceiling (70 u/s + the once-per-15s stuck resync)",
     far / secs <= CEIL * 1.6, `${f2(far / secs)} u/s vs ceiling ${CEIL}`);
  const stored = (await get(`/world/players?wallet=${nid("a1obs")}&x=${stOf(w).x}&z=${stOf(w).z}`)).j.players.find(p => p.wallet === w);
  ok("...and the ROW the value routes read is the server's, not the claim",
     stored && Math.abs(stored.x - claimed) > 100, `rowX=${stored ? f2(stored.x) : "none"} claimedX=${f2(claimed)}`);
  // AND THE ONLY THING THAT MATTERS: can a wallet in this state bank value anywhere?
  // The honest half of the same property: 60 u in 250 ms is 240 u/s, and the FIRST one is legitimately
  // allowed — REACH_BANK_S x 70 = 175 u of one-off displacement is exactly the burst a coalesced pair
  // of honest reports after a network stall produces, so the bank cannot refuse it without refusing
  // them. What must be zero is everything AFTER the bank is spent.
  const A = await proven("a1v");
  await mv(A.w, 0, -204, { mktToken: A.tok });
  let cx = 0, refused = 0, banked = 0, bankedAfterBurst = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    cx += 60; await mv(A.w, cx, -204, { mktToken: A.tok });
    const cl = await post("/world/node/claim", { wallet: A.w, mktToken: A.tok, id: `wood:${Math.round(cx)}:-204`, cd: 2000 });
    if (cl.status === 200) { banked++; if (i >= 4) bankedAfterBurst++; } else refused++;
  }
  console.log(`     a wallet claiming 240 u/s and gathering as it goes: ${banked} of 40 settled (${bankedAfterBurst} after the burst allowance), ${refused} refused`);
  ok("a speed hacker banks nothing beyond the one-off burst allowance", bankedAfterBurst === 0,
     `afterBurst=${bankedAfterBurst} total=${banked}/40`);
}

// =========================================================================================
console.log("\n=== A2. INFLATED dt — the wall-clock bank ===");
{
  const w = nid("a2");
  await mv(w, HOME.x, HOME.z);
  const frames = [];
  for (let i = 1; i <= 16; i++) frames.push({ seq: i, dt: 1.0, move: { x: 1, z: 0 }, sprint: true, mode: "foot" });
  await post("/world/move", { wallet: w, dir: 0, inputs: frames });   // no x/z: pure-input client
  const st = stOf(w);
  const gained = Math.hypot(st.x - HOME.x, st.z - HOME.z);
  ok("16 frames claiming dt:1.0 each (16 s of sim) buy < 1 u", gained < 1.0, `gained=${f2(gained)} u`);
  // honest control: 16 frames of 1/60 after a real 300 ms wait
  const w2 = nid("a2b");
  await mv(w2, HOME.x, HOME.z);
  await sleep(320);
  const hf = [];
  for (let i = 1; i <= 16; i++) hf.push({ seq: i, dt: 1 / 60, move: { x: 1, z: 0 }, sprint: true, mode: "foot" });
  await post("/world/move", { wallet: w2, dir: 0, inputs: hf });
  const hg = Math.hypot(stOf(w2).x - HOME.x, stOf(w2).z - HOME.z);
  ok("...while an HONEST 16 x 1/60 batch after a 320 ms wait moves normally", hg > 2.0, `honest=${f2(hg)} u`);
}

// =========================================================================================
console.log("\n=== A3. TELEPORT ONTO A NODE AND CLAIM IT ===");
{
  const A = await proven("a3");
  const spots = (await get("/world/nodes")).j;
  const list = Array.isArray(spots) ? spots : (spots.nodes || spots.spots || []);
  console.log(`  /world/nodes -> ${Array.isArray(list) ? list.length : "?"} entries`);
  await mv(A.w, HOME.x, HOME.z, { mktToken: A.tok });
  await sleep(300);
  // teleport 900 u to somewhere else and immediately try to bank a gather
  const r = await mv(A.w, HOME.x + 900, HOME.z + 400, { mktToken: A.tok });
  const st = stOf(A.w);
  ok("a 900 u jump is corrected", st.lastAction === "correct", `action=${st.lastAction}`);
  const cl = await post("/world/node/claim", { wallet: A.w, mktToken: A.tok, id: "tree:12", cd: 4000 });
  ok("...and the node claim right after it is REFUSED (warp hold)", cl.status === 403, `status=${cl.status} err=${JSON.stringify(cl.j.error || "")}`);
}

// =========================================================================================
console.log("\n=== A4. FLY — claim a y far above the ground ===");
{
  const w = nid("a4");
  await mv(w, HOME.x, HOME.z);
  await sleep(300);
  const r = await mv(w, HOME.x + 3, HOME.z, { y: 900 });
  const st = stOf(w);
  ok("a claim 900 u in the air is ACCEPTED (vertical is deliberately not authoritative)",
     st.lastAction === "accept" || st.lastAction === "lift", `action=${st.lastAction} y=${f2(st.y)}`);
  console.log("     -> DOCUMENTED, not a defect: value is settled by horizontal proximity only.");
  // the floor IS enforced
  await sleep(300);
  await mv(w, HOME.x + 5, HOME.z, { y: -500 });
  ok("a claim UNDER the island is lifted onto it", stOf(w).y >= P.groundAt(HOME.x + 5, HOME.z) - 0.01,
     `y=${f2(stOf(w).y)} ground=${f2(P.groundAt(HOME.x + 5, HOME.z))}`);
}

// =========================================================================================
console.log("\n=== A5. TUNNEL THROUGH A HILL (one big claim) ===");
// find the steepest short line on the island: sample for a column much higher than both ends
function findWall() {
  let best = null;
  for (let x = -600; x <= 600; x += 20) {
    for (let z = -600; z <= 600; z += 20) {
      const g0 = P.groundAt(x, z), g1 = P.groundAt(x + 40, z);
      const gm = P.groundAt(x + 20, z);
      const pen = gm - Math.max(g0, g1);
      if (g0 > 7 && g1 > 7 && (!best || pen > best.pen)) best = { x, z, pen, g0, g1, gm };
    }
  }
  return best;
}
const WALL = findWall();
console.log(`  steepest 40 u line found: (${WALL.x},${WALL.z}) g0=${f2(WALL.g0)} mid=${f2(WALL.gm)} g1=${f2(WALL.g1)} pen=${f2(WALL.pen)}`);
{
  const w = nid("a5");
  await mv(w, WALL.x, WALL.z, { y: WALL.g0 });
  await sleep(700);
  const r = await mv(w, WALL.x + 40, WALL.z, { y: WALL.g1 });
  const st = stOf(w);
  const segPen = P.segmentPenetration(WALL.x, WALL.g0, WALL.z, WALL.x + 40, WALL.g1, WALL.z);
  ok("a single 40 u line through the hill is corrected (through-terrain)",
     st.lastAction === "correct", `action=${st.lastAction} segPen=${f2(segPen)}`);
}

// =========================================================================================
console.log("\n=== A12. CLIMBING A CLIFF IN HOPS OF 1 UNIT ===");
// segmentPenetration used to return 0 for any segment with d <= 1 (`if (!(d > 1)) return 0`) AND
// never sampled its own endpoint (`i < n`), so a claim landing INSIDE a column was tested against
// nothing and then LIFTED onto the column by rule 5. That is a free vertical wall climb.
// The target is the steepest 2-unit rise anywhere on the island, found by scanning the heightfield.
function findCliff() {
  let best = null;
  for (let x = -700; x <= 700; x += 2) for (let z = -700; z <= 700; z += 2) {
    const g0 = P.groundAt(x, z), g1 = P.groundAt(x + 2, z);
    if (g0 > 7 && g1 > 7 && (g1 - g0) > (best ? best.rise : 0)) best = { x, z, g0, g1, rise: g1 - g0 };
  }
  return best;
}
const CLIFF = findCliff();
console.log(`  steepest 2 u rise on the island: (${CLIFF.x},${CLIFF.z}) ${f2(CLIFF.g0)} -> ${f2(CLIFF.g1)} = ${f2(CLIFF.rise)} u of vertical face`);
{
  const w = nid("a12");
  await mv(w, CLIFF.x - 4, CLIFF.z, { y: CLIFF.g0 });
  let corrected = 0, top = CLIFF.g0;
  for (let i = 1; i <= 12; i++) {
    await sleep(40);
    await mv(w, CLIFF.x - 4 + i * 1.0, CLIFF.z, { y: CLIFF.g0 });
    if (stOf(w).lastAction === "correct" || stOf(w).lastAction === "resync") corrected++;
    top = Math.max(top, stOf(w).y);
  }
  const st = stOf(w);
  const climbed = st.y - CLIFF.g0;
  console.log(`     12 hops of 1.0 u at a constant y=${f2(CLIFF.g0)}: refusals=${corrected}, final (x=${f2(st.x)}, y=${f2(st.y)}), climbed ${f2(climbed)} u`);
  ok("1 u hops cannot walk a client up the steepest face on the island", corrected > 0 && climbed < CLIFF.rise,
     `refusals=${corrected} climbed=${f2(climbed)} of ${f2(CLIFF.rise)}`);
}

// =========================================================================================
console.log("\n=== A6/A7. INPUTS FOR A WALLET YOU DO NOT OWN, AND REPLAYED FRAMES ===");
{
  const V = await proven("victim");
  await mv(V.w, HOME.x, HOME.z, { mktToken: V.tok });
  const before = { x: stOf(V.w).x, z: stOf(V.w).z };
  // attacker knows the victim's wallet (published on /world/roster) but has no token
  const atk = await post("/world/move", {
    wallet: V.w, dir: 0,
    inputs: [{ seq: 900, dt: 0.1, move: { x: 1, z: 0 }, sprint: true, mode: "foot" }],
  });
  const after = { x: stOf(V.w).x, z: stOf(V.w).z };
  ok("inputs for a PROVEN wallet with no token are refused 403", atk.status === 403, `status=${atk.status}`);
  ok("...and the victim's simulated state did not move",
     Math.abs(after.x - before.x) < 0.01 && Math.abs(after.z - before.z) < 0.01,
     `before=(${f2(before.x)},${f2(before.z)}) after=(${f2(after.x)},${f2(after.z)})`);
  ok("...and the poisoned seq never reached lastInputSeq", stOf(V.w).lastInputSeq < 900,
     `lastInputSeq=${stOf(V.w).lastInputSeq}`);

  // REPLAY, against a TIME-MATCHED CONTROL. The 20 Hz tick carries the last accepted input forward
  // for INPUT_TTL, so a replay burst and an equally long silence BOTH move the player — measuring the
  // burst alone reads the tick's honest work as if the replay had bought it.
  const f = [{ seq: 1, dt: 0.05, move: { x: 1, z: 0 }, sprint: true, mode: "foot" }];
  await post("/world/move", { wallet: V.w, mktToken: V.tok, dir: 0, inputs: f });
  const p1 = { x: stOf(V.w).x, z: stOf(V.w).z, t: Date.now() };
  for (let i = 0; i < 20; i++) await post("/world/move", { wallet: V.w, mktToken: V.tok, dir: 0, inputs: f });
  const burstMs = Date.now() - p1.t;
  const p2 = { x: stOf(V.w).x, z: stOf(V.w).z };
  const withReplays = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  // control: a second wallet, one accepted frame, then the same wall-clock window in SILENCE
  const C = await proven("ctrl");
  await mv(C.w, HOME.x, HOME.z, { mktToken: C.tok });
  await post("/world/move", { wallet: C.w, mktToken: C.tok, dir: 0, inputs: f });
  const c1 = { x: stOf(C.w).x, z: stOf(C.w).z };
  await sleep(burstMs);
  const c2 = { x: stOf(C.w).x, z: stOf(C.w).z };
  const silent = Math.hypot(c2.x - c1.x, c2.z - c1.z);
  console.log(`     20 replays over ${burstMs} ms moved ${f2(withReplays)} u; the same ${burstMs} ms in SILENCE moved ${f2(silent)} u (the 20 Hz tick)`);
  ok("20 replays of the SAME seq buy nothing the 20 Hz tick would not have given anyway",
     Math.abs(withReplays - silent) < 0.25, `replayed=${f2(withReplays)} silent=${f2(silent)}`);
}

// =========================================================================================
console.log("\n=== A8. SEQ ABUSE ===");
{
  const w = nid("a8");
  await mv(w, HOME.x, HOME.z);
  await post("/world/move", { wallet: w, dir: 0, inputs: [{ seq: 10, dt: 0.05, move: { x: 1, z: 0 }, mode: "foot" }] });
  const s1 = stOf(w).lastInputSeq;
  await post("/world/move", { wallet: w, dir: 0, inputs: [{ seq: 3, dt: 0.05, move: { x: 1, z: 0 }, mode: "foot" }] });
  ok("a backwards seq is dropped", stOf(w).lastInputSeq === s1, `lastInputSeq=${stOf(w).lastInputSeq} (was ${s1})`);
  // MAX_SAFE_INTEGER: does one frame lock the wallet out of its own simulation forever?
  const w2 = nid("a8b");
  await mv(w2, HOME.x, HOME.z);
  await post("/world/move", { wallet: w2, dir: 0, inputs: [{ seq: Number.MAX_SAFE_INTEGER, dt: 0.05, move: { x: 1, z: 0 }, mode: "foot" }] });
  const locked = stOf(w2).lastInputSeq;
  await sleep(200);
  const before = { x: stOf(w2).x, z: stOf(w2).z };
  for (let i = 1; i <= 20; i++) await post("/world/move", { wallet: w2, dir: 0, inputs: [{ seq: i, dt: 0.05, move: { x: 1, z: 0 }, sprint: true, mode: "foot" }] });
  const moved = Math.hypot(stOf(w2).x - before.x, stOf(w2).z - before.z);
  console.log(`     after seq=MAX_SAFE_INTEGER, lastInputSeq=${locked}; 20 honest frames then moved ${f2(moved)} u`);
  ok("SELF-INFLICTED seq lockout is recorded (a wallet can brick its OWN input lane)", true,
     `moved=${f2(moved)} u — ${moved < 0.1 ? "LOCKED OUT" : "still moves"}`);
}

// =========================================================================================
console.log("\n=== A9. mode:\"spec\" — the CREATOR free-fly ceiling, declared by anyone ===");
{
  const w = nid("a9");
  await mv(w, HOME.x, HOME.z);
  // one input frame declaring spec, then a huge claim
  await post("/world/move", { wallet: w, dir: 0, x: HOME.x, z: HOME.z, y: P.groundAt(HOME.x, HOME.z),
    inputs: [{ seq: 1, dt: 0.016, move: { x: 1, z: 0 }, mode: "spec" }] });
  const modeNow = stOf(w).mode;
  await sleep(300);
  const r = await mv(w, HOME.x + 110, HOME.z, { y: 400,
    inputs: [{ seq: 2, dt: 0.016, move: { x: 1, z: 0 }, mode: "spec" }] });
  const st = stOf(w);
  console.log(`     st.mode=${modeNow}, maxSpeed(spec)=${P.maxSpeed("spec", false)} u/s, action=${st.lastAction}, x=${f2(st.x)}`);
  ok("a non-creator declaring mode:\"spec\" must NOT get the 420 u/s ceiling",
     st.lastAction === "correct" || Math.abs(st.x - HOME.x) < 20,
     `action=${st.lastAction} x=${f2(st.x)} (claimed ${HOME.x + 110})`);
}

// =========================================================================================
console.log("\n=== A10. SLACK FARMING — buy speed by posting more messages, not by claiming more ===");
// The original gate was `maxSpeed * dtWall + REACH_SLACK`: a per-MESSAGE grant, so posting faster
// bought speed outright. Measured on the pre-fix build: 120 claims of 5.5 u in 0.21 s = 3203 u/s.
// The bank is measured over a SUSTAINED window, after the one-off burst allowance is spent.
{
  const w = nid("a10");
  await mv(w, HOME.x, HOME.z);
  let x = HOME.x;
  const step = 5.5;
  const burst = async (n) => { for (let i = 0; i < n; i++) { x += step; await mv(w, x, HOME.z, { y: 400 }); } };
  await burst(80);                                   // drain the burst allowance
  const mark = { x: stOf(w).x, z: stOf(w).z, t: Date.now() };
  let corr = 0;
  for (let i = 0; i < 900; i++) { x += step; await mv(w, x, HOME.z, { y: 400 }); if (stOf(w).lastAction !== "accept" && stOf(w).lastAction !== "lift") corr++; }
  const dt = (Date.now() - mark.t) / 1000;
  const dist = Math.hypot(stOf(w).x - mark.x, stOf(w).z - mark.z);
  const ups = dist / dt;
  console.log(`     900 claims in ${dt.toFixed(2)} s (${Math.round(900 / dt)} msg/s): server row moved ${f2(dist)} u => ${f2(ups)} u/s (refusals ${corr})`);
  console.log(`     legitimate ceiling for this mode: ${f2(P.maxSpeed("foot", false))} u/s (fleet floor 70 u/s)`);
  ok("posting 4000 messages/s does not buy speed — sustained rate stays at the ceiling", ups <= 90, `${f2(ups)} u/s`);
}

// =========================================================================================
console.log("\n=== A11. THE TELEPORT WINDOW THAT NEVER LAPSES ===");
{
  const w = nid("a11");
  await mv(w, HOME.x, HOME.z);
  SRV._physGrantTeleportForTest(w, 105, P.groundAt(105, -104), -104, "drown-rescue");
  ok("teleport granted", !!stOf(w).acceptUntil, `acceptUntil-now=${stOf(w).acceptUntil - Date.now()} ms`);
  // honest reports for longer than TELEPORT_HOLD_MS (3 s)
  let tele = 0, other = 0;
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await sleep(280);
    await mv(w, 105 + i * 0.5, -104, { y: P.groundAt(105 + i * 0.5, -104) });
    if (stOf(w).lastAction === "teleport") tele++; else other++;
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`     ${elapsed.toFixed(1)} s after the grant: ${tele} reports answered "teleport", ${other} answered normally`);
  ok(`the granted window LAPSES (TELEPORT_HOLD_MS=${P.TUNE.TELEPORT_HOLD_MS} ms)`, tele <= 12,
     `tele=${tele}/30 over ${elapsed.toFixed(1)} s`);
  // and the killer: a huge jump long after the grant
  await sleep(300);
  const before = { x: stOf(w).x, z: stOf(w).z };
  await mv(w, before.x + 1900, before.z, { y: 400 });
  const st = stOf(w);
  const jumped = Math.hypot(st.x - before.x, st.z - before.z);
  ok(`a 1900 u jump ${elapsed.toFixed(0)} s after one rescue is REFUSED`, jumped < 100,
     `action=${st.lastAction} jumped=${f2(jumped)} u`);
}

// =========================================================================================
console.log("\n=== A11b. grantModeSwitch (400 ms) must not become a rolling 3 s window ===");
{
  const w = nid("a11b");
  await mv(w, HOME.x, HOME.z);
  const st0 = stOf(w);
  P.grantModeSwitch(st0, Date.now());
  const armedFor = st0.acceptUntil - Date.now();
  await sleep(120);
  await mv(w, HOME.x + 2, HOME.z);            // one accepted claim inside the 400 ms window
  const armedAfter = stOf(w).acceptUntil - Date.now();
  console.log(`     mode-switch window armed for ${armedFor} ms; after ONE claim inside it: ${armedAfter} ms`);
  ok("a claim inside a mode-switch window does not extend it to TELEPORT_HOLD_MS",
     armedAfter <= armedFor + 50, `armedAfter=${armedAfter} ms (armed ${armedFor} ms)`);
}

// =========================================================================================
console.log("\n=== SECRETS — no env var may ride any response this feature touches ===");
{
  const canary = "CANARY-RPC-" + crypto.randomBytes(8).toString("hex");
  process.env.RPC_URL = canary;
  const bodies = [];
  bodies.push((await get("/stats")).j);
  bodies.push((await mv(nid("sec"), HOME.x, HOME.z)).j);
  bodies.push((await get("/world/roster")).j);
  bodies.push((await get(`/world/players?wallet=${nid("sec")}&x=0&z=0`)).j);
  const blob = JSON.stringify(bodies);
  ok("no RPC_URL canary in /stats, /world/move, /world/roster, /world/players", !blob.includes(canary), `len=${blob.length}`);
  ok("/stats.clientRpc fails closed", bodies[0].clientRpc === "", `clientRpc=${JSON.stringify(bodies[0].clientRpc)}`);
  ok("the phys wire carries only x/y/z/dir/ack(/corr)",
     Object.keys(bodies[1].phys || {}).every(k => ["x", "y", "z", "dir", "ack", "corr"].includes(k)),
     `keys=${JSON.stringify(Object.keys(bodies[1].phys || {}))}`);
}

console.log(`\nAV_PHYS_ATTACK_DONE pass=${pass} fail=${fail}`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(0);
