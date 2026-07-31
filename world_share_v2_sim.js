#!/usr/bin/env node
// ONE SHARED MONSTER POOL, end to end — the tick is ON BY DEFAULT now, and the client consumes it.
// Proves, with two simulated clients against the REAL in-process server:
//   1. the tick defaults ON with no env set (and CHIK_WORLD_TICK=0 still kills it, in a child proc)
//   2. server idle path == client idle path: worst deviation across 24 spawns x 24 sampled hours,
//      judged against values printed by the REAL Monsters.gd functions (dev_mobidle_dump.gd)
//   3. A kills mob 7 -> B's next /world/move snapshot shows 7 dead with a respawn stamp
//   4. B's kill on the corpse is refused idempotently; essence is credited ONCE (A only)
//   5. the respawn expires -> both see it alive again
//   6. the per-wallet swing rate bound trips (429)
//   7. distance refusals: an unproven wallet cannot hit at all; a proven one cannot open a fight
//      from across the map (the idle-path gate — prints the distance)
// No live backend. Throwaway keypair, memory store, dummy RPC, local port.
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59991";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8807";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
delete process.env.WORLD_TICK;        // THE POINT: no env at all -> the tick must be ON
delete process.env.CHIK_WORLD_TICK;
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

const CLIENT_DUMP = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/mob_idle_client.json";

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8807";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/world/mobs")).status === 200) return; } catch (e) {} await sleep(100); } throw new Error("no server"); }

async function main() {
  const srv = await import("./server.js");
  await waitUp();
  srv._clearWorldMobs();
  srv._clearOwnBook();
  console.log("\n=== WORLD SHARE v2: one pool, tick ON, client-consumed ===\n");

  // ---------- 1. THE TICK IS ON BY DEFAULT ----------
  const m0 = await get("/world/mobs");
  ok("with NO env set, the shared world is LIVE by default", m0.status === 200 && m0.json.tick === true,
     `tick=${m0.json.tick}`);

  // ---------- 2. SERVER IDLE PATH == CLIENT IDLE PATH (real GDScript values) ----------
  const dump = JSON.parse(fs.readFileSync(CLIENT_DUMP, "utf8"));
  ok("client dump present (dev_mobidle_dump.gd ran the REAL Monsters.gd functions)",
     dump.spawns.length === srv._mobSpawnCount() && dump.samples.length === dump.spawns.length * 24,
     `spawns=${dump.spawns.length}/${srv._mobSpawnCount()} samples=${dump.samples.length}`);
  let tableOk = true;
  for (let i = 0; i < dump.spawns.length; i++) {
    const [nm, x, z] = dump.spawns[i]; const sp = srv._mobSpawnAt(i);
    if (!sp || sp[0] !== nm || Math.abs(sp[1] - x) > 1e-6 || Math.abs(sp[2] - z) > 1e-6) { tableOk = false; console.log(`    table mismatch idx ${i}: client ${nm}@${x},${z} vs server ${sp}`); }
  }
  ok("the 24-spawn table matches ordinal-for-ordinal (the shared key really is the index)", tableOk);
  let worst = 0, worstAt = null;
  for (const [idx, t, cx, cz] of dump.samples) {
    const sp2 = srv._mobIdlePos(idx, t);
    const d = Math.hypot(sp2.x - cx, sp2.z - cz);
    if (d > worst) { worst = d; worstAt = `idx ${idx} t ${t}`; }
  }
  ok("server-evaluated idle path agrees with the client within 1 unit over 24 spawns x 24 hours",
     worst < 1.0, `worst deviation ${worst.toExponential(3)} units at ${worstAt}`);

  // ---------- helpers: two proven trainers standing AT mob 7's evaluated position ----------
  const IDX = 7;                                     // hogwert (202.3, 51.5), hp 260, essence 2
  const ipNow = () => srv._mobIdlePos(IDX, Date.now() / 1000);
  const mk = async (x, z) => {
    const kp = Keypair.generate();
    const v = await post("/verify", { ...signIn(kp), netId: "net_" + kp.publicKey.toBase58().slice(0, 10) });
    const t = { kp, wallet: kp.publicKey.toBase58(), tok: v.json.mktToken };
    t.move = (mx, mz) => post("/world/move", { wallet: t.wallet, mktToken: t.tok, x: mx, z: mz, y: 8, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 });
    await t.move(x, z);
    return t;
  };
  const ip0 = ipNow();
  const A = await mk(ip0.x + 2, ip0.z);
  const B = await mk(ip0.x - 2, ip0.z + 3);

  // ---------- 3. A KILLS 7 -> B'S NEXT SNAPSHOT SHOWS IT DEAD, WITH A STAMP ----------
  const kA = await post("/world/mob/hit", { wallet: A.wallet, mktToken: A.tok, idx: IDX, finish: true });
  ok("A's finishing blow is witnessed", kA.status === 200 && kA.json.killed === true,
     `status ${kA.status} killed=${kA.json.killed} paid=${kA.json.paid}`);
  const snapB = await B.move(ip0.x - 2, ip0.z + 3);
  const rowB = (snapB.json.mobs || {})[String(IDX)];
  ok("B's next /world/move reply carries mob 7 DEAD with a respawn stamp",
     !!rowB && rowB.dead === 1 && rowB.back > 0 && rowB.back <= 90000,
     `mobs["7"]=${JSON.stringify(rowB)}`);

  // ---------- 4. B'S KILL ON THE CORPSE: REFUSED IDEMPOTENTLY, NO SECOND ESSENCE ----------
  const kB = await post("/world/mob/hit", { wallet: B.wallet, mktToken: B.tok, idx: IDX, finish: true });
  ok("B's claim on the SAME life answers already-dead (ok:true dead:true), never killed:true",
     kB.status === 200 && kB.json.ok === true && kB.json.dead === true && kB.json.killed === undefined,
     `dead=${kB.json.dead} back=${kB.json.back}`);
  const credA = (srv._ownFor(A.wallet) || { cred: {} }).cred["mat:essence"] || 0;
  const credB = (srv._ownFor(B.wallet) || { cred: {} }).cred["mat:essence"] || 0;
  ok("essence was credited ONCE: A (the witnessed finisher) has 2, B has 0",
     credA === 2 && credB === 0, `A=${credA} B=${credB}`);
  const kA2 = await sleep(450).then(() => post("/world/mob/hit", { wallet: A.wallet, mktToken: A.tok, idx: IDX, finish: true }));
  const credA2 = (srv._ownFor(A.wallet) || { cred: {} }).cred["mat:essence"] || 0;
  ok("even the finisher cannot double-claim their own kill", kA2.json.dead === true && credA2 === 2,
     `second claim dead=${kA2.json.dead}, A's essence still ${credA2}`);

  // ---------- 5. THE RESPAWN EXPIRES FOR EVERYONE AT ONCE ----------
  srv._mobTickForTest(Date.now() + 90001);           // advance the server's clock past MOB_RESPAWN_MS
  const aliveA = await A.move(ip0.x + 2, ip0.z);
  const aliveB = await B.move(ip0.x - 2, ip0.z + 3);
  ok("after the stamp expires BOTH clients' snapshots show 7 alive (absent from the dead-set)",
     (aliveA.json.mobs || {})[String(IDX)] === undefined && (aliveB.json.mobs || {})[String(IDX)] === undefined,
     `A sees ${JSON.stringify(aliveA.json.mobs)} B sees ${JSON.stringify(aliveB.json.mobs)}`);

  // ---------- 6. THE SWING RATE BOUND ----------
  const ip7b = ipNow();
  await A.move(ip7b.x, ip7b.z);
  await sleep(450);
  const h1 = await post("/world/mob/hit", { wallet: A.wallet, mktToken: A.tok, idx: IDX, dmg: 40 });
  const h2 = await post("/world/mob/hit", { wallet: A.wallet, mktToken: A.tok, idx: IDX, dmg: 40 });
  ok("a second swing inside 400ms is refused 429", h1.status === 200 && h2.status === 429 && h2.json.retryInMs > 0,
     `first hp=${h1.json.hp}, second status=${h2.status} retryInMs=${h2.json.retryInMs}`);

  // ---------- 7. DISTANCE: THE IDLE-PATH GATE ----------
  const FAR = 17;                                    // darkeon at (-436.9, -397.5) — across the map
  const ipFar = srv._mobIdlePos(FAR, Date.now() / 1000);
  await sleep(450);                                  // clear A's own swing cooldown — we want the DISTANCE refusal
  const kFar = await post("/world/mob/hit", { wallet: A.wallet, mktToken: A.tok, idx: FAR, finish: true });
  const trueDist = Math.hypot(ipFar.x - (ip7b.x), ipFar.z - (ip7b.z));
  ok("a proven wallet standing at mob 7 cannot OPEN a fight on mob 17 across the map",
     kFar.status === 403 && /nowhere near/.test(kFar.json.error || ""),
     `refused at dist=${kFar.json.dist} (true separation ${Math.round(trueDist)}u, gate 220)`);
  const ghost = Keypair.generate().publicKey.toBase58();
  await post("/world/move", { wallet: ghost, x: ipFar.x, z: ipFar.z, y: 8, dir: 0, handle: "G", leg: 1, el: "Fire", br: 1 });
  const kGhost = await post("/world/mob/hit", { wallet: ghost, idx: FAR, finish: true });
  ok("an UNPROVEN wallet cannot kill at all, even standing on the mob",
     kGhost.status === 403 && /prove/.test(kGhost.json.error || ""), `status ${kGhost.status} "${kGhost.json.error}"`);

  // ---------- 8. THE KILL-SWITCH STILL KILLS (child process, CHIK_WORLD_TICK=0) ----------
  const kidPort = 8808;
  const kid = spawn(process.execPath, ["--input-type=module", "-e", "import('./server.js')"], {
    cwd: process.cwd(),
    env: { ...process.env, CHIK_WORLD_TICK: "0", PORT: String(kidPort), RPC_URL: "http://127.0.0.1:59990" },
    stdio: "ignore",
  });
  let kidTick = null;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${kidPort}/world/mobs`); if (r.status === 200) { kidTick = (await r.json()).tick; break; } } catch (e) {}
    await sleep(100);
  }
  kid.kill("SIGKILL");
  ok("CHIK_WORLD_TICK=0 still forces the shared world OFF", kidTick === false, `child tick=${kidTick}`);

  console.log(`\nworld_share_v2: pass=${pass} fail=${fail}`);
  if (fails.length) for (const f of fails) console.log("  FAILED: " + f);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
