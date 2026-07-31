#!/usr/bin/env node
// THE WARP STAMP, BEFORE AND AFTER — run against TWO BUILDS, not one.
//
// The finding: the deployed warp detector is `jump > WARP_MAX_UPS(110) * max(0.05, dt) + WARP_SLACK(60)`,
// a per-MESSAGE allowance. Nothing rate-limits POST /world/move, so the whole stamp is bypassed by
// sending more messages: hops of <= 65 u never stamp, however fast they arrive. That takes the
// stand-down away from /world/node/claim, /world/mob/hit and the raid gate — the three routes that
// turn a presence row into value.
//
// This runs the SAME attack against the pre-change server.js (scratchpad/phys_baseline) and the
// current one, both with CHIK_PHYS OFF (the deployed configuration), in child processes on separate
// ports. Attributing a defect to a diff without that control is the ledger's own rule.
// Throwaway keypair, dummy RPC, memory store, unique ports. Never touches the live backend.
import { createRequire } from "module";
const require = createRequire(new URL("./package.json", import.meta.url));
const nacl = (m => m.default || m)(require("tweetnacl"));
const bs58 = (m => m.default || m)(require("bs58"));
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const SCRATCH = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad";
const BASELINE = path.join(SCRATCH, "phys_baseline");     // server.js as it was before this pass
const CURRENT = path.join(SCRATCH, "phys_preexist_cur");  // a snapshot of the dev tree right now
const _t = nacl.sign.keyPair();
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, a = "") => { if (c) { pass++; console.log("  ok   " + n + (a ? "  [" + a + "]" : "")); } else { fail++; fails.push(n + " — " + a); console.log("  FAIL " + n + (a ? "  [" + a + "]" : "")); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

// The server resolves ./cup-live.js relative to its own module, so a copy must live beside every
// local import target (ledger: a scratchpad copy dies with ERR_MODULE_NOT_FOUND).
fs.rmSync(CURRENT, { recursive: true, force: true });
fs.mkdirSync(CURRENT, { recursive: true });
for (const f of ["server.js", "cup-live.js", "cup-resolver.js", "pvp-engine.js", "package.json", "world_terrain.js", "world_physics.js"]) {
  if (fs.existsSync("./" + f)) fs.copyFileSync("./" + f, path.join(CURRENT, f));
}
fs.copyFileSync("./_av_ws_boot.mjs", path.join(CURRENT, "boot.mjs"));
fs.copyFileSync("./_av_ws_boot.mjs", path.join(BASELINE, "boot.mjs"));
try { fs.symlinkSync("/Users/michaelkennethbrillantes/Downloads/chiki-backend/node_modules", path.join(CURRENT, "node_modules")); } catch {}

function boot(dir, port) {
  return spawn(process.execPath, ["boot.mjs"], {
    cwd: dir,
    env: {
      ...process.env, AVPORT: String(port), PORT: String(port), CHIK_PHYS: "", CHIK_WS: "0",
      RPC_URL: "http://127.0.0.1:59969", TREASURY_SECRET: JSON.stringify(Array.from(_t.secretKey)),
      VERIFY_HOLDERS: "false", NETWORK: "devnet", DATABASE_URL: "", MARKET_ONCHAIN: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}
const P_BASE = 39771, P_CUR = 39772;
const cb = boot(BASELINE, P_BASE), cc = boot(CURRENT, P_CUR);
const api = (port) => ({
  post: (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) })),
  get: (p) => fetch(`http://127.0.0.1:${port}${p}`).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) })),
});
for (let i = 0; i < 200; i++) {
  try { const a = await api(P_BASE).get("/world/roster"), b = await api(P_CUR).get("/world/roster"); if (a.status === 200 && b.status === 200) break; } catch (e) {}
  await sleep(150);
}
console.log("=== _av_phys_preexist_sim — the warp stamp, pre-change vs current, CHIK_PHYS OFF ===");
console.log(`  baseline server.js ${fs.statSync(path.join(BASELINE, "server.js")).size} B   current ${fs.statSync(path.join(CURRENT, "server.js")).size} B`);

async function proven(A, tag) {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey);
  const msg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const sg = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
  const nid = "godot-" + crypto.createHash("sha1").update(tag + Math.random()).digest("hex").slice(0, 8);
  const v = (await A.post("/verify", { wallet: w, netId: nid, authMsg: msg, authSig: sg })).j;
  return { w, tok: v.mktToken };
}
const mv = (A, w, tok, x, z) => A.post("/world/move", { wallet: w, mktToken: tok, x, z, y: 20, dir: 0, handle: "T", leg: 14, el: "Fire", br: 9, avatar: "classic" });

// ============ THE ATTACK ============
// Node ids are "kind:x:z" and must sit within 1000 u of (2,-204). Start 1200 u from the target and
// cover the distance in hops of 65 u — one unit under 110*0.05 + 60, the widest hop the old rule
// could never stamp — then bank a gather at the far end.
async function hopAttack(A, tag) {
  const START = { x: -600, z: -204 }, NODE = { x: 600, z: -204 };
  const P = await proven(A, tag);
  await mv(A, P.w, P.tok, START.x, START.z);
  const t0 = Date.now();
  let x = START.x;
  for (let i = 0; i < 19; i++) { x = Math.min(NODE.x, x + 65); await mv(A, P.w, P.tok, x, START.z); }
  const dt = (Date.now() - t0) / 1000;
  const cl = await A.post("/world/node/claim", { wallet: P.w, mktToken: P.tok, id: `wood:${NODE.x}:${NODE.z}`, cd: 4000 });
  return { dt, ups: 1200 / dt, status: cl.status, err: cl.j.error || "", drop: cl.j.drop || null };
}
// the HONEST control on the same build: a boat sailing at 70 u/s must never be stamped
async function honestBoat(A, tag) {
  const P = await proven(A, tag);
  let z = -700;
  await mv(A, P.w, P.tok, -700, z);
  let refused = 0, n = 0;
  for (let i = 0; i < 18; i++) {
    await sleep(280);
    z += 70 * 0.28;
    await mv(A, P.w, P.tok, -700, z);
    const cl = await A.post("/world/node/claim", { wallet: P.w, mktToken: P.tok, id: `wood:${Math.round(-700 + 0)}:${Math.round(z)}`, cd: 2000 });
    n++;
    if (cl.status === 403 && /breath/.test(String(cl.j.error || ""))) refused++;
  }
  return { n, refused };
}

const A_BASE = api(P_BASE), A_CUR = api(P_CUR);
console.log("\n--- 1. THE ATTACK: 1200 u in hops of 65 u, then gather at the far end ---");
const rb = await hopAttack(A_BASE, "base");
const rc = await hopAttack(A_CUR, "cur");
console.log(`  PRE-CHANGE build : ${f2(rb.ups)} u/s, node claim -> ${rb.status} ${JSON.stringify(rb.drop || rb.err)}`);
console.log(`  CURRENT build    : ${f2(rc.ups)} u/s, node claim -> ${rc.status} ${JSON.stringify(rc.drop || rc.err)}`);
ok("the defect is REAL and PRE-EXISTING: the pre-change build banks the gather 1200 u away", rb.status === 200,
   `baseline status=${rb.status}`);
ok("the current build refuses it (the stand-down arms)", rc.status === 403 && /breath/.test(String(rc.err)),
   `current status=${rc.status} err=${JSON.stringify(rc.err)}`);

console.log("\n--- 2. THE HONEST CONTROL: a boat at 70 u/s must never be stood down, on EITHER build ---");
const hb = await honestBoat(A_BASE, "hbase");
const hc = await honestBoat(A_CUR, "hcur");
console.log(`  PRE-CHANGE build : ${hb.refused} of ${hb.n} reports stood the gather down`);
console.log(`  CURRENT build    : ${hc.refused} of ${hc.n} reports stood the gather down`);
ok("the fix costs an honest 70 u/s sailor nothing", hc.refused === 0, `refused=${hc.refused}/${hc.n}`);
ok("...and the pre-change build did not stand them down either (so this is a like-for-like comparison)",
   hb.refused === 0, `refused=${hb.refused}/${hb.n}`);

console.log("\n--- 3. THE SINGLE BIG JUMP the stamp was written for still stamps on both ---");
for (const [name, A] of [["PRE-CHANGE", A_BASE], ["CURRENT", A_CUR]]) {
  const P = await proven(A, "big" + name);
  await mv(A, P.w, P.tok, 60, 60);
  await sleep(300);
  await mv(A, P.w, P.tok, 960, 460);
  const cl = await A.post("/world/node/claim", { wallet: P.w, mktToken: P.tok, id: "wood:600:-204", cd: 4000 });
  ok(`${name}: a 900 u jump still stands the value routes down`, cl.status === 403, `status=${cl.status}`);
}

cb.kill("SIGKILL"); cc.kill("SIGKILL");
console.log(`\nAV_PHYS_PREEXIST_DONE pass=${pass} fail=${fail}`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(0);
