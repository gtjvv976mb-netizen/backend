// _rv_physwarp_attack_sim.mjs — the ONE change that ships OUTSIDE CHIK_ACTIONS, attacked.
//
// worldMoveApply now skips the warp bank entirely for a body that claims no coordinates:
//     const _claims = b.x !== undefined || b.z !== undefined;
//     let _wbank = WARP_BANK_S;
//     if (_prev && Number.isFinite(_prev.x) && (_claims || !PHYS_ON)) { ...spend the bank... }
// That is guarded on PHYS_ON, so it is dead with CHIK_PHYS off. With CHIK_PHYS ON it means a
// pure-input ping RESETS _wbank to the full WARP_BANK_S. The attack: drain the bank with a big
// claimed jump, send one coordinate-less body to refill it for free, jump again — repeat. If the
// warp bank were the only gate that would restore the pre-fix 34,286 u/s teleport. This measures
// whether physApply's own reconcile still holds the line, and whether a gather ever settles.
// Boots the real server as a CHILD process (the flag is read at import time), unique port.
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
const _t = nacl.sign.keyPair();                              // THROWAWAY, never a real key
const PORT = 44421;
const env = { ...process.env, PORT: String(PORT), CHIK_PHYS: "1", CHIK_ACTIONS: "1",
  RPC_URL: "http://127.0.0.1:59999", TREASURY_SECRET: JSON.stringify(Array.from(_t.secretKey)),
  VERIFY_HOLDERS: "false", NETWORK: "devnet", ADMIN_KEY: "local-sim-admin" };
delete env.DATABASE_URL;
const srv = spawn("node", ["server.js"], { cwd: "/Users/michaelkennethbrillantes/Downloads/chiki-backend", env, stdio: "ignore" });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {} return { status: r.status, body: j }; };
let up = false;
for (let i = 0; i < 60 && !up; i++) { await sleep(300); try { up = (await fetch(`${B}/health`)).status === 200; } catch (e) {} }

let pass = 0, fail = 0; const findings = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const note = (m) => { findings.push(m); console.log("  FINDING:", m); };
chk(up, `CHIK_PHYS=1 CHIK_ACTIONS=1 server up on ${PORT} (up=${up})`);

const START = { x: 121, z: -259 };
const wpos = async (w) => (await post("/world/move", { wallet: w, x: START.x, z: START.z, dir: 0 })).body;

// ---- 1. the alternating attack: claimed jump, coordinate-less refill, claimed jump...
{
  const W = "godot-pw000001";
  await post("/world/move", { wallet: W, x: START.x, z: START.z, dir: 0 });
  await sleep(300);
  let x = START.x, warps = 0;
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    x += 270;                                              // just under the 275 u one-shot allowance
    const m = await post("/world/move", { wallet: W, x, z: START.z, dir: 0 });
    if (m.body && m.body.phys && (m.body.phys.corr || m.body.phys.tp)) warps++;
    // the free refill: a body that claims NOTHING
    await post("/world/move", { wallet: W, input: { seq: i + 1, dt: 0.05, move: { x: 0, z: 0 }, mode: "foot" } });
  }
  const dt = (Date.now() - t0) / 1000;
  const final = (await post("/world/move", { wallet: W, input: { seq: 999, dt: 0.05, move: { x: 0, z: 0 }, mode: "foot" } })).body;
  const reached = final && final.phys ? final.phys.x : NaN;
  const claimed = x;
  const speed = Math.abs(reached - START.x) / dt;
  chk(Math.abs(reached - claimed) > 5000,
    `40 alternating (claim 270 u -> free bank refill) rounds: CLAIMED x=${claimed.toFixed(0)}, server says x=${Number(reached).toFixed(1)} — the lie was NOT adopted (gap ${Math.abs(reached - claimed).toFixed(0)} u), corrections seen=${warps}, effective ${speed.toFixed(1)} u/s over ${dt.toFixed(2)} s`);
  note(`THE BANK REFILL IS REAL BUT physApply STILL BINDS: the coordinate-less ping does reset _wbank to WARP_BANK_S, but under CHIK_PHYS the reconcile is the stricter gate and the presence row never leaves the reach bank. Measured ${speed.toFixed(1)} u/s against a claimed ${(Math.abs(claimed - START.x) / dt).toFixed(0)} u/s.`);

  // ...and the thing that actually matters: can it bank a gather at the far end?
  const c = await post("/world/node/claim", { wallet: W, id: "gold:10920:-260", cd: 60 });
  chk(c.status !== 200 || c.body.ok !== true, `a gather at the claimed far end: ${c.status} "${c.body && c.body.error}"`);
  const near = await post("/world/node/claim", { wallet: W, id: "stone:120:-260", cd: 60 });
  chk(near.status === 403, `...and a gather where the server says it IS is also held (${near.status} "${near.body && near.body.error}") — physApply stamped warp`);
}

// ---- 2. the honest side of the same guard: a pure-input client must NOT be permanently held
{
  const W = "godot-pw000002";
  await post("/world/move", { wallet: W, x: 121, z: -259, dir: 0 });
  await sleep(300);
  let held = 0, granted = 0; const why = [];
  for (let i = 0; i < 8; i++) {
    await post("/world/move", { wallet: W, input: { seq: i + 1, dt: 0.1, move: { x: 0, z: 0 }, mode: "foot" } });
    const c = await post("/world/node/claim", { wallet: W, id: `stone:${120 + i}:${-260}`, cd: 60 });   // all within CLAIM_RADIUS 14 of (121,-259)
    if (c.status === 200 && c.body.ok === true) granted++; else { why.push(`${c.status} ${JSON.stringify(c.body)}`); if (c.body && c.body.error === "catch your breath") held++; }
    await sleep(1900);
  }
  chk(held === 0 && granted === 8,
    `an HONEST pure-input CHIK_PHYS client gathers ${granted}/8 with ${held} "catch your breath" holds — the trap the guard was written for stays closed${why.length ? " | " + why.join(" | ") : ""}`);
}

// ---- 3. flag-off equivalence of the guard: with CHIK_PHYS OFF the branch condition is unchanged
{
  const P2 = 44422;
  const e2 = { ...env, PORT: String(P2) }; delete e2.CHIK_PHYS; delete e2.CHIK_ACTIONS;
  const s2 = spawn("node", ["server.js"], { cwd: "/Users/michaelkennethbrillantes/Downloads/chiki-backend", env: e2, stdio: "ignore" });
  let u2 = false;
  for (let i = 0; i < 60 && !u2; i++) { await sleep(300); try { u2 = (await fetch(`http://127.0.0.1:${P2}/health`)).status === 200; } catch (er) {} }
  const p2 = async (p, b) => { const r = await fetch(`http://127.0.0.1:${P2}` + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = JSON.parse(await r.text()); } catch (er) {} return { status: r.status, body: j }; };
  const W = "godot-pw000003";
  await p2("/world/move", { wallet: W, x: 500, z: 500, dir: 0 });
  // a coordinate-less body with the flags OFF still means "you moved to 0,0" — the pre-change rule
  await p2("/world/move", { wallet: W, dir: 0 });
  const c = await p2("/world/node/claim", { wallet: W, id: "stone:120:-260", cd: 60 });
  chk(c.status === 403 && c.body.error === "catch your breath",
    `flags OFF: a coordinate-less body is STILL measured as a jump to the origin and still stamps warp (${c.status} "${c.body && c.body.error}") — byte-identical to the pre-change rule`);
  s2.kill();
}

srv.kill();
console.log(`\nRV_PHYSWARP_DONE pass=${pass} fail=${fail} findings=${findings.length}`);
findings.forEach((f, i) => console.log(`  F${i + 1}. ${f}`));
process.exit(fail ? 1 : 0);
