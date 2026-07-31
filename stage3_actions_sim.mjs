// stage3_actions_sim.mjs — STAGE 3: the world adjudicates gathers, casts and strikes (CHIK_ACTIONS).
// Phase 1 boots the REAL server in-process with CHIK_ACTIONS=1 and proves: honest actions succeed,
// out-of-reach / wrong-tool / teleported / dry-land actions are refused gracefully (never consuming
// the turn), replays yield nothing, and one item per gather holds under a 6-way race.
// Phase 2 boots the PRE-CHANGE baseline and the patched server (flag off) as child processes, runs
// the identical fixed sequence and compares transcripts byte-for-byte (wall-clock fields normalised).
//   THE BASELINE IS NOT IN ANY REPO AND MUST BE REGENERATED BEFORE THIS SIM MEANS ANYTHING:
//     git -C ~/Downloads/chiki-backend-repo-FIXED show HEAD:server.js \
//       > ~/Downloads/chiki-backend/server_stage3_baseline.mjs
//   (the deploy mirror's HEAD is the last COMMITTED server, i.e. everything except this pass).
//   It is deliberately NOT mirrored — a second full copy of server.js inside the deploy repo is a
//   hazard, not a fixture. Without the file phase 2 FAILS loudly ("never came up"), it does not
//   silently skip; but a green tally quoted from a run that lacked it covered only phases 1 and 3.
// Phase 3 boots CHIK_PHYS=1 + CHIK_ACTIONS=1 and proves reach is measured against the server's OWN
// simulated position, and a lied position cannot relocate authority.
// Local only: throwaway keypair, memory store, dummy RPC. Nothing touches the live backend.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { spawn } from "node:child_process";

const _t = nacl.sign.keyPair();                                  // THROWAWAY, never a real key
process.env.RPC_URL = "http://127.0.0.1:59999";                  // dummy, never called
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39131";
process.env.CHIK_ACTIONS = "1";                                  // <— the flag under test (phase 1)
delete process.env.DATABASE_URL;

const S = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js");
await new Promise((r) => setTimeout(r, 1400));
const T = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/world_terrain.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("ok:", msg); } else { fail++; console.log("FAIL:", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:39131";
async function post(base, path, body) {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
  return { status: r.status, j };
}
const move = (w, x, z) => post(BASE, "/world/move", { wallet: w, x, z, dir: 0 });
const claim = (w, id, extra = {}) => post(BASE, "/world/node/claim", { wallet: w, id, cd: 60, ...extra });
const fish = (w, extra = {}) => post(BASE, "/world/fish/report", { wallet: w, tier: 1, rod: 0, ...extra });
const hit = (w, idx, extra = {}) => post(BASE, "/world/mob/hit", { wallet: w, idx, ...extra });
let _wn = 0; const wal = () => `godot-s3${String(_wn++).padStart(6, "0")}`;

// ---- phase 1: the flag is ON ------------------------------------------------------------------
console.log("\n== PHASE 1: CHIK_ACTIONS=1 (in-process, real server.js) ==");
const st0 = S._actionsStatsForTest();
ok(st0.on === true && st0.terrain === true, `actions armed with real terrain (on=${st0.on} terrain=${st0.terrain})`);

// derive test ground FROM the server's own heightfield: a shore stance and a bone-dry stance
const SEA = T.SEA;
function minWaterDist(x, z, R) {
  let best = Infinity;
  for (let dx = -R; dx <= R; dx += 4) for (let dz = -R; dz <= R; dz += 4) {
    if (T.surfaceHeight(x + dx, z + dz) < SEA) best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
let shore = null, dry = null;
for (let x = -698; x <= 702 && !(shore && dry); x += 16) {
  for (let z = -904; z <= 496 && !(shore && dry); z += 16) {
    const h = T.surfaceHeight(x, z);
    if (h < SEA + 0.5 || h > SEA + 60) continue;               // must be standable land
    const d = minWaterDist(x, z, 84);
    if (!shore && d <= 10) shore = { x, z, h, d };
    if (!dry && d > 80) dry = { x, z, h, d: d === Infinity ? ">84" : d };
  }
}
ok(!!shore, `shore stance found at (${shore && shore.x},${shore && shore.z}) h=${shore && shore.h} waterDist=${shore && shore.d}`);
ok(!!dry, `dry stance found at (${dry && dry.x},${dry && dry.z}) h=${dry && dry.h} waterDist=${dry && dry.d}`);

// T1 honest gather — identical to today
const W1 = wal();
await move(W1, 121, -259);
let r = await claim(W1, "stone:120:-260");
ok(r.status === 200 && r.j.ok === true, `honest gather succeeds (status=${r.status} ok=${r.j && r.j.ok})`);
ok(Array.isArray(r.j.drop) && r.j.drop.length === 1 && r.j.drop[0] === "stone", `exactly ONE item, server-named (drop=${JSON.stringify(r.j && r.j.drop)})`);
ok(r.j.until > Date.now(), `cooldown is the server's (until=+${r.j.until - Date.now()}ms)`);

// T2 replayed claim yields nothing
await sleep(1900);
r = await claim(W1, "stone:120:-260");
ok(r.status === 200 && r.j.ok === false && r.j.taken === true && r.j.drop === undefined,
   `replayed claim yields nothing (ok=${r.j && r.j.ok} taken=${r.j && r.j.taken} drop=${JSON.stringify(r.j && r.j.drop)})`);

// T3 out of reach
const W2 = wal();
await move(W2, 121, -259);
r = await claim(W2, "stone:400:100");
ok(r.status === 403 && r.j.error === "out of reach", `out-of-reach claim refused (status=${r.status} error="${r.j && r.j.error}" dist=${r.j && r.j.dist})`);

// T4 a claim after a teleport is held — and the hold consumes nothing
const W3 = wal();
await move(W3, 121, -259);
await move(W3, 521, 241);                       // 640-unit jump: implausible, stamps warp
r = await claim(W3, "stone:520:240");
ok(r.status === 403 && r.j.error === "catch your breath" && r.j.retryInMs > 0,
   `teleported claim held (status=${r.status} error="${r.j && r.j.error}" retryInMs=${r.j && r.j.retryInMs})`);
await sleep(3200);
r = await claim(W3, "stone:520:240");
ok(r.status === 200 && r.j.ok === true && JSON.stringify(r.j.drop) === '["stone"]',
   `after the hold the SAME claim lands — nothing was consumed (ok=${r.j && r.j.ok} drop=${JSON.stringify(r.j && r.j.drop)})`);

// T5 tool suitability — wrong tool refused, refusal costs nothing, no-tool (old client) untouched
const W4 = wal();
await move(W4, 101, -201);
r = await claim(W4, "wood:100:-200", { tool: "rod" });
ok(r.status === 403 && r.j.error === "wrong tool" && r.j.needs === "axe",
   `rod on a tree refused (status=${r.status} error="${r.j && r.j.error}" needs="${r.j && r.j.needs}")`);
r = await claim(W4, "wood:100:-200", { tool: "axe" });      // immediately — the 403 must not have stamped the pace window
ok(r.status === 200 && r.j.ok === true && r.j.left === 2 && r.j.felled === false && JSON.stringify(r.j.drop) === '["wood"]',
   `axe claim lands IMMEDIATELY after the refusal — refusal consumed no turn (ok=${r.j && r.j.ok} left=${r.j && r.j.left} drop=${JSON.stringify(r.j && r.j.drop)})`);
await sleep(1900);
r = await claim(W4, "wood:100:-200");                        // no tool field = every shipped client
ok(r.status === 200 && r.j.ok === true && r.j.left === 1,
   `tool-less (old client) claim untouched (ok=${r.j && r.j.ok} left=${r.j && r.j.left})`);
const W5 = wal();
await move(W5, 61, -99);
r = await claim(W5, "berries:60:-100", { tool: "axe" });
ok(r.status === 403 && r.j.error === "wrong tool" && r.j.needs === "bare hands",
   `axe on berries refused (error="${r.j && r.j.error}" needs="${r.j && r.j.needs}")`);
r = await claim(W5, "berries:60:-100");
ok(r.status === 200 && r.j.ok === true && JSON.stringify(r.j.drop) === '["berries"]',
   `bare-hand berries claim lands (ok=${r.j && r.j.ok} drop=${JSON.stringify(r.j && r.j.drop)})`);

// T6 one item per gather under a 6-way race
const racers = Array.from({ length: 6 }, wal);
await Promise.all(racers.map((w) => move(w, 61, -99)));
const rr = await Promise.all(racers.map((w) => claim(w, "crystal:60:-100")));
const wins = rr.filter((q) => q.j && q.j.ok === true);
const takens = rr.filter((q) => q.j && q.j.taken === true);
ok(wins.length === 1 && takens.length === 5,
   `6-way race on one node: exactly one winner (wins=${wins.length} taken=${takens.length} statuses=${rr.map((q) => q.status).join(",")})`);
ok(wins.length === 1 && JSON.stringify(wins[0].j.drop) === '["crystal"]',
   `the one winner got exactly ONE item (drop=${JSON.stringify(wins[0] && wins[0].j.drop)})`);

// T7 honest cast — identical to today, and the cast floor still holds
const W7 = wal();
await move(W7, shore.x, shore.z);
r = await fish(W7, { tier: 2, rod: 6 });
ok(r.status === 200 && r.j.ok === true && r.j.counted === true && "legend" in r.j,
   `honest cast at the shore counts, server rolls (counted=${r.j && r.j.counted} legend=${JSON.stringify(r.j && r.j.legend)})`);
r = await fish(W7, { tier: 2, rod: 6 });
ok(r.status === 200 && r.j.counted === false, `machine-gun recast inside 800ms still counts nothing (counted=${r.j && r.j.counted})`);

// T8 a cast after a teleport is held, and the hold consumes no cast
const W8 = wal();
await move(W8, shore.x, shore.z);
await move(W8, shore.x + 500, shore.z + 500);
await move(W8, shore.x, shore.z);              // back at the water — but the warp stamp stands
r = await fish(W8);
ok(r.status === 403 && r.j.error === "catch your breath" && r.j.retryInMs > 0,
   `teleported cast held (status=${r.status} error="${r.j && r.j.error}" retryInMs=${r.j && r.j.retryInMs})`);
await sleep(200);
r = await fish(W8);
ok(r.status === 403 && r.j.error === "catch your breath", `still held 200ms later (error="${r.j && r.j.error}")`);
await sleep(3100);
r = await fish(W8);
ok(r.status === 200 && r.j.counted === true, `after the hold the cast lands and COUNTS — the refusals consumed nothing (counted=${r.j && r.j.counted})`);

// T9 a cast with no water anywhere near the server's position is not fishing
const W9 = wal();
await move(W9, dry.x, dry.z);
r = await fish(W9);
ok(r.status === 403 && r.j.error === "no water here",
   `dry-land cast refused (status=${r.status} error="${r.j && r.j.error}" at (${dry.x},${dry.z}) waterDist=${dry.d})`);

// T10 honest strike -> server-owned kill -> replay yields nothing
const ip0 = S._mobIdlePos(0, Date.now() / 1000);
const W10 = wal();
await move(W10, ip0.x + 1, ip0.z + 1);
r = await hit(W10, 0, { dmg: 7 });
ok(r.status === 200 && r.j.ok === true && r.j.killed === false && r.j.hp === r.j.maxhp - 7,
   `honest strike lands on the shared pool (hp=${r.j && r.j.hp}/${r.j && r.j.maxhp} killed=${r.j && r.j.killed})`);
await sleep(450);
r = await hit(W10, 0, { finish: true });
ok(r.status === 200 && r.j.killed === true && r.j.hp === 0,
   `finishing blow witnessed, server decides the kill (killed=${r.j && r.j.killed} hp=${r.j && r.j.hp} paid=${r.j && r.j.paid})`);
await sleep(450);
r = await hit(W10, 0, { finish: true });
ok(r.status === 200 && r.j.dead === true && r.j.killed === undefined,
   `replayed finishing blow yields nothing (dead=${r.j && r.j.dead} back=${r.j && r.j.back}ms)`);

// T11 strike from across the map refused
const ip1 = S._mobIdlePos(1, Date.now() / 1000);
const W11 = wal();
await move(W11, ip1.x + 300, ip1.z + 300);
r = await hit(W11, 1, { dmg: 5 });
ok(r.status === 403 && r.j.error === "that monster is nowhere near there" && r.j.dist > 220,
   `far strike refused against the SERVER's mob position (status=${r.status} error="${r.j && r.j.error}" dist=${r.j && r.j.dist})`);

// flag observability
const st1 = S._actionsStatsForTest();
ok(st1.toolRefusals === 2 && st1.castHolds === 2 && st1.castDry === 1,
   `counters saw exactly what happened (toolRefusals=${st1.toolRefusals} castHolds=${st1.castHolds} castDry=${st1.castDry})`);

// ---- phase 2: CHIK_ACTIONS=0 is byte-identical to the pre-change server -----------------------
console.log("\n== PHASE 2: flag off == baseline, byte-for-byte (child processes) ==");
const DIR = "/Users/michaelkennethbrillantes/Downloads/chiki-backend";
const mob0 = S._mobSpawnAt(0);
function childEnv(port, flag) {
  const e = { ...process.env, PORT: String(port) };
  delete e.DATABASE_URL; delete e.CHIK_ACTIONS;
  if (flag !== undefined) e.CHIK_ACTIONS = flag;
  return e;
}
async function bootAndDrive(file, port, flag) {
  const srv = spawn("node", [file], { cwd: DIR, env: childEnv(port, flag), stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(300);
    try { up = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200; } catch (e) {}
  }
  if (!up) { srv.kill(); return { err: `server ${file} on ${port} never came up` }; }
  const drv = spawn("node", ["stage3_flagoff_driver.mjs", String(port), String(mob0[1]), String(mob0[2])], { cwd: DIR, env: childEnv(port, flag) });
  let outBuf = "";
  drv.stdout.on("data", (d) => { outBuf += d; });
  const code = await new Promise((res) => drv.on("close", res));
  srv.kill();
  if (code !== 0) return { err: `driver exited ${code}` };
  try { return { lines: JSON.parse(outBuf.trim().split("\n").pop()) }; } catch (e) { return { err: `driver output unparseable: ${outBuf.slice(0, 200)}` }; }
}
const tBase = await bootAndDrive("server_stage3_baseline.mjs", 39132);
const tOff = await bootAndDrive("server.js", 39133);
const tOff0 = await bootAndDrive("server.js", 39134, "0");
ok(!tBase.err && !tOff.err && !tOff0.err, `three transcripts taken (base=${tBase.err || tBase.lines.length} off=${tOff.err || tOff.lines.length} off0=${tOff0.err || tOff0.lines.length} steps)`);
function diffT(a, b, name) {
  if (!a.lines || !b.lines) { ok(false, `${name}: missing transcript`); return; }
  const n = Math.max(a.lines.length, b.lines.length);
  for (let i = 0; i < n; i++) {
    if (a.lines[i] !== b.lines[i]) {
      ok(false, `${name} DIVERGES at step ${i}:\n  A: ${a.lines[i]}\n  B: ${b.lines[i]}`);
      return;
    }
  }
  ok(true, `${name}: ${n} steps, ${JSON.stringify(a.lines).length} bytes, byte-identical after wall-clock normalisation`);
}
diffT(tBase, tOff, "baseline vs patched (flag unset)");
diffT(tBase, tOff0, "baseline vs patched (CHIK_ACTIONS=0)");
// the equivalence must not be vacuous: the baseline transcript itself must show flag-off behaviour
if (tBase.lines) {
  const s6 = tBase.lines.find((l) => l.startsWith("s6.")) || "";
  const s9 = tBase.lines.find((l) => l.startsWith("s9b.")) || "";
  ok(s6.includes('"ok":true') && s6.includes('"drop":["stone"]'), `flag off IGNORES the tool field (s6=${s6.slice(0, 90)})`);
  ok(s9.includes('"counted":true'), `flag off does NOT hold a teleported cast (s9b=${s9.slice(0, 90)})`);
}

// ---- phase 3: CHIK_PHYS=1 + CHIK_ACTIONS=1 — reach against the SERVER's simulated position ----
console.log("\n== PHASE 3: CHIK_PHYS=1 + CHIK_ACTIONS=1 (child process) ==");
{
  const port = 39135;
  const e = { ...process.env, PORT: String(port), CHIK_PHYS: "1", CHIK_ACTIONS: "1" };
  delete e.DATABASE_URL;
  const srv = spawn("node", ["server.js"], { cwd: DIR, env: e, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(300); try { up = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200; } catch (er) {} }
  ok(up, `phys+actions server up on ${port} (up=${up})`);
  const B3 = `http://127.0.0.1:${port}`;
  const call = async (path, body) => {
    const q = await fetch(B3 + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = JSON.parse(await q.text()); } catch (er) {}
    return { status: q.status, j };
  };
  const WP1 = "godot-p3aa0001", WP2 = "godot-p3aa0002";
  let m = await call("/world/move", { wallet: WP1, x: 121, z: -259, dir: 0 });
  ok(m.status === 200 && m.j.phys && typeof m.j.phys === "object",
     `move reply carries the server's own phys answer (phys=${JSON.stringify(m.j.phys).slice(0, 100)})`);
  r = await call("/world/node/claim", { wallet: WP1, id: "stone:120:-260", cd: 60 });
  ok(r.status === 200 && r.j.ok === true && JSON.stringify(r.j.drop) === '["stone"]',
     `relay-client gather still lands under phys (ok=${r.j && r.j.ok} drop=${JSON.stringify(r.j && r.j.drop)})`);
  await call("/world/move", { wallet: WP2, x: 121, z: -259, dir: 0 });
  m = await call("/world/move", { wallet: WP2, input: { seq: 1, dt: 0.1, move: { x: 0, z: 0 }, mode: "foot" } });
  ok(m.status === 200 && m.j.phys && typeof m.j.phys === "object",
     `input-driven client is simulated (phys=${JSON.stringify(m.j.phys).slice(0, 100)})`);
  r = await call("/world/node/claim", { wallet: WP2, id: "stone:120:-260", cd: 60 });
  ok(r.status === 200 && r.j.taken === true,
     `second trainer told the truth: that node is spent (ok=${r.j && r.j.ok} taken=${r.j && r.j.taken})`);
  await sleep(1900);
  r = await call("/world/node/claim", { wallet: WP2, id: "stone:122:-258", cd: 60 });
  ok(r.status === 200 && r.j.ok === true,
     `gather authorised against the SERVER-SIMULATED position (ok=${r.j && r.j.ok} drop=${JSON.stringify(r.j && r.j.drop)})`);
  await sleep(1900);
  r = await call("/world/node/claim", { wallet: WP2, id: "stone:420:100", cd: 60 });
  ok(r.status === 403 && r.j.error === "out of reach",
     `far claim measured from the server's answer, refused (error="${r.j && r.j.error}" dist=${r.j && r.j.dist})`);
  m = await call("/world/move", { wallet: WP2, x: 821, z: 241, dir: 0 });    // the lie: +700 units in one ping
  const lied = m.j && m.j.phys;
  r = await call("/world/node/claim", { wallet: WP2, id: "stone:820:240", cd: 60 });
  ok(r.status === 403 && r.j.ok !== true,
     `lied position cannot relocate authority: claim at the lie refused (status=${r.status} error="${r.j && r.j.error}" phys=${JSON.stringify(lied).slice(0, 100)})`);
  srv.kill();
}

console.log(`\nSTAGE3_ACTIONS_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
