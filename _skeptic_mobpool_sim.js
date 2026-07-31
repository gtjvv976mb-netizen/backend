#!/usr/bin/env node
// SKEPTIC ATTACK SIM for the shared monster pool. Adversarial only — every assertion is a REFUSAL
// the server must make, or a credit it must NOT issue. Boots the real server in-process on a private
// port with a throwaway keypair, memory store and dummy RPC. Never touches the live backend.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59981";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8823";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
delete process.env.WORLD_TICK;
delete process.env.CHIK_WORLD_TICK;
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

const BASE = "http://127.0.0.1:8823";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 100; i++) { try { if ((await get("/world/mobs")).status === 200) return; } catch (e) {} await sleep(100); } throw new Error("no server"); }

let srv;
const ess = (w) => (srv._ownFor(w) || { cred: {} }).cred["mat:essence"] || 0;

async function mkProven(x, z) {
  const kp = Keypair.generate();
  const v = await post("/verify", { ...signIn(kp), netId: "net_" + kp.publicKey.toBase58().slice(0, 10) });
  const t = { wallet: kp.publicKey.toBase58(), tok: v.json.mktToken };
  t.move = (mx, mz) => post("/world/move", { wallet: t.wallet, mktToken: t.tok, x: mx, z: mz, y: 8, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 });
  await t.move(x, z);
  return t;
}
async function mkNetId(x, z) {
  const t = { wallet: "godot-" + crypto.randomBytes(4).toString("hex") };
  t.move = (mx, mz) => post("/world/move", { wallet: t.wallet, x: mx, z: mz, y: 8, dir: 0, handle: "N", leg: 1, el: "Fire", br: 1 });
  await t.move(x, z);
  return t;
}

async function main() {
  srv = await import("./server.js");
  await waitUp();
  srv._clearWorldMobs(); srv._clearOwnBook();
  console.log("\n=== SKEPTIC: adversarial attacks on the shared monster pool ===\n");

  // ---------- A1. RACE TWO (AND EIGHT) KILL REPORTS FOR THE SAME LIFE ----------
  {
    const IDX = 3;                                        // darkeet (307.3, 265.9) essence 1
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const racers = [];
    for (let i = 0; i < 8; i++) racers.push(await mkProven(ip.x + (i % 3) - 1, ip.z + Math.floor(i / 3) - 1));
    const before = racers.map(r => ess(r.wallet));
    const rs = await Promise.all(racers.map(r => post("/world/mob/hit", { wallet: r.wallet, mktToken: r.tok, idx: IDX, finish: true })));
    const killed = rs.filter(r => r.json.killed === true).length;
    const deadRefused = rs.filter(r => r.json.dead === true && r.json.killed === undefined).length;
    ok("8 simultaneous finish-claims on ONE life: exactly one is witnessed, seven refused as already-dead",
       killed === 1 && deadRefused === 7, `killed=${killed} dead-refused=${deadRefused} statuses=${rs.map(r=>r.status).join(",")}`);
    const gained = racers.map((r, i) => ess(r.wallet) - before[i]);
    const total = gained.reduce((a, b) => a + b, 0);
    ok("the race credits essence exactly ONCE across all eight racers",
       total === 1 && gained.filter(g => g > 0).length === 1, `per-wallet gains=[${gained.join(",")}] total=${total}`);
  }

  // ---------- A2. FORGED POSITION IN THE BODY ----------
  {
    const IDX = 9;                                        // hogwert (143.1, 276.7)
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const far = await mkProven(1000, 1000);               // presence row is genuinely 1000+ units away
    const r = await post("/world/mob/hit", { wallet: far.wallet, mktToken: far.tok, idx: IDX, finish: true,
                                             x: ip.x, z: ip.z, px: ip.x, pz: ip.z, pos: { x: ip.x, z: ip.z } });
    const trueDist = Math.hypot(ip.x - 1000, ip.z - 1000);
    ok("a caller-sent position cannot forge reach: the gate reads the SERVER presence row",
       r.status === 403 && /nowhere near/.test(r.json.error || ""),
       `status ${r.status} "${r.json.error}" dist=${r.json.dist} (true separation ${Math.round(trueDist)}u)`);
    ok("...and the refused claim credited nothing", ess(far.wallet) === 0, `essence=${ess(far.wallet)}`);
    const alive = srv._mobFor(IDX);
    ok("...and left the mob untouched", (alive === null || alive.dead === false), `mob=${JSON.stringify(alive)}`);
  }

  // ---------- A3. REPLAY AN OLD KILL AFTER RESPAWN ----------
  {
    const IDX = 20;                                       // shadowisp (-230.7, 58.3) essence 2
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const A = await mkProven(ip.x, ip.z);
    const body = { wallet: A.wallet, mktToken: A.tok, idx: IDX, finish: true };
    const k1 = await post("/world/mob/hit", body);
    const g1 = srv._mobFor(IDX).gen;
    const e1 = ess(A.wallet);
    // replay the IDENTICAL body while the corpse is down
    await sleep(450);
    const k2 = await post("/world/mob/hit", body);
    ok("replaying the identical kill body on the SAME life pays nothing",
       k2.json.killed === undefined && k2.json.dead === true && ess(A.wallet) === e1,
       `replay dead=${k2.json.dead} killed=${k2.json.killed} essence ${e1}->${ess(A.wallet)}`);
    // now let it respawn and replay the same body again
    srv._mobTickForTest(Date.now() + 90001);
    const g2 = srv._mobFor(IDX).gen;
    ok("the respawn advances the generation counter", g2 === g1 + 1, `gen ${g1} -> ${g2}`);
    await sleep(450);
    const k3 = await post("/world/mob/hit", body);
    const e3 = ess(A.wallet);
    // A replay after respawn is INDISTINGUISHABLE from a fresh kill of the new life, and the new life
    // is a real, separately-scarce monster — so it SHOULD pay. What must not happen is the old life's
    // credit re-opening, i.e. paying more than one life's worth.
    ok("a replay after respawn is treated as a kill of the NEW life, paying exactly one more life's worth",
       k3.json.killed === true && k3.json.gen === g2 && e3 === e1 + 2,
       `killed=${k3.json.killed} gen=${k3.json.gen} essence ${e1}->${e3} (one life = 2)`);
    ok("...and the reply's gen is the NEW generation, so a client can tell the lives apart",
       k3.json.gen === g2 && g2 !== g1, `reply gen=${k3.json.gen} old gen=${g1}`);
  }

  // ---------- A4. ANCHOR POISONING (the defect this sim found, now fixed) ----------
  // An opener may legitimately stand up to MOB_IDLE_GATE 220 from the monster while MOB_ANCHOR_R is 40,
  // and a live mob's anchor was never released — so one free net_id request pinned the fight 200 units
  // off the monster and refused every honest trainer standing ON it, forever. The anchor may now only
  // ADD reach, never subtract it.
  {
    const IDX = 4;                                        // darkeet (-313.6, -15.3)
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const OFF = 200;                                      // inside MOB_IDLE_GATE 220, far outside ANCHOR_R 40
    const G = await mkNetId(ip.x + OFF, ip.z);            // net_id: NO wallet proof needed at all
    const gh = await post("/world/mob/hit", { wallet: G.wallet, idx: IDX, dmg: 1 });
    ok("an UNPROVEN net_id can still land a 1-damage opener 200u out and set the fight anchor",
       gh.status === 200 && gh.json.hp === 169, `status ${gh.status} hp=${gh.json.hp}/${gh.json.maxhp}`);
    const H = await mkProven(ip.x, ip.z);                 // honest trainer standing ON the monster
    const hh = await post("/world/mob/hit", { wallet: H.wallet, mktToken: H.tok, idx: IDX, dmg: 20 });
    ok("the honest trainer standing at the monster's own idle point is NOT locked out by that anchor",
       hh.status === 200, `status ${hh.status} "${hh.json.error || ""}" hp=${hh.json.hp} (0u from the mob, ${OFF}u from the poisoned anchor)`);
    await sleep(450);
    const hh2 = await post("/world/mob/hit", { wallet: H.wallet, mktToken: H.tok, idx: IDX, finish: true });
    ok("...and can finish it, so 24 free requests can no longer lock the island",
       hh2.status === 200 && hh2.json.killed === true, `status ${hh2.status} killed=${hh2.json.killed} paid=${hh2.json.paid}`);
    ok("...with the credit going to the honest finisher, not the poisoner",
       ess(H.wallet) === 1 && ess(G.wallet) === 0, `H=${ess(H.wallet)} G=${ess(G.wallet)} (net_id can never be credited)`);
  }

  // ---------- A4b. THE ANCHOR STILL DOES ITS JOB: extra reach for a fight dragged off the path ----------
  {
    const IDX = 21;                                       // shadowisp (-460.2, -184.9)
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const O = await mkProven(ip.x, ip.z);                 // opener, at the mob
    const r1 = await post("/world/mob/hit", { wallet: O.wallet, mktToken: O.tok, idx: IDX, dmg: 10 });
    ok("an opener at the mob is accepted and anchors the fight", r1.status === 200, `status ${r1.status} hp=${r1.json.hp}`);
    const near = await mkProven(ip.x + 25, ip.z + 10);     // 27u away: inside ANCHOR_R, joins
    const r2 = await post("/world/mob/hit", { wallet: near.wallet, mktToken: near.tok, idx: IDX, dmg: 10 });
    ok("someone standing beside them joins the same fight", r2.status === 200, `status ${r2.status} hp=${r2.json.hp}`);
    const tourist = await mkProven(ip.x + 900, ip.z);      // 900u: outside BOTH the mob gate and the anchor
    const r3 = await post("/world/mob/hit", { wallet: tourist.wallet, mktToken: tourist.tok, idx: IDX, dmg: 10 });
    ok("someone 900u away is still refused — the fix widened reach, it did not remove it",
       r3.status === 403 && /too far from the fight/.test(r3.json.error || ""),
       `status ${r3.status} "${r3.json.error}" dist=${r3.json.dist}`);
    ok("...and the tourist was credited nothing and dealt no damage",
       ess(tourist.wallet) === 0 && srv._mobFor(IDX).hp === 190,
       `tourist essence=${ess(tourist.wallet)} mob hp=${srv._mobFor(IDX).hp}/210`);
  }

  // ---------- A4c. THE ANCHOR EXPIRES (real elapsed time, deliberately non-vacuous) ----------
  // The anchor branch can only ever grant reach in a narrow band: it is set within MOB_IDLE_GATE 220 of
  // the mob and drifts WITH it, so "within MOB_ANCHOR_R 40 of the anchor" reaches at most ~260 from the
  // monster. Testing the TTL therefore means standing IN that band — 240u out — where the anchor is the
  // only thing granting reach. Before the TTL that must be accepted; after it, refused.
  {
    const IDX = 23;                                       // shadowisp (-170.1, 45.7)
    const t0 = Date.now() / 1000;
    const ip0 = srv._mobIdlePos(IDX, t0);
    const O = await mkProven(ip0.x + 219, ip0.z);         // opener at the very edge of the 220 gate
    const r1 = await post("/world/mob/hit", { wallet: O.wallet, mktToken: O.tok, idx: IDX, dmg: 10 });
    ok("an opener at the edge of the idle gate is accepted and anchors there",
       r1.status === 200, `status ${r1.status} "${r1.json.error || ""}" hp=${r1.json.hp}`);
    // a joiner 240u from the mob: outside the 220 gate, inside 40 of the drifted anchor
    const drift = (t) => { const p = srv._mobIdlePos(IDX, t); return { dx: p.x - ip0.x, dz: p.z - ip0.z, p }; };
    const d1 = drift(Date.now() / 1000);
    const J = await mkProven(ip0.x + 240 + d1.dx, ip0.z + d1.dz);
    const jf = Math.hypot((ip0.x + 240 + d1.dx) - d1.p.x, (ip0.z + d1.dz) - d1.p.z);
    const r2 = await post("/world/mob/hit", { wallet: J.wallet, mktToken: J.tok, idx: IDX, dmg: 10 });
    ok("a joiner OUTSIDE the mob gate but inside the live anchor is accepted — the anchor adds reach",
       r2.status === 200 && jf > 220, `status ${r2.status} hp=${r2.json.hp}, they are ${Math.round(jf)}u from the mob (gate 220)`);
    // now let the fight go quiet for longer than MOB_ANCHOR_TTL
    await sleep(46000);
    const d2 = drift(Date.now() / 1000);
    await J.move(ip0.x + 240 + d2.dx, ip0.z + d2.dz);     // re-stand on the drifted anchor
    const jf2 = Math.hypot((ip0.x + 240 + d2.dx) - d2.p.x, (ip0.z + d2.dz) - d2.p.z);
    const r3 = await post("/world/mob/hit", { wallet: J.wallet, mktToken: J.tok, idx: IDX, dmg: 10 });
    ok("...but after 46s of silence the stale anchor has released and the same spot is refused",
       r3.status === 403 && /nowhere near/.test(r3.json.error || ""),
       `status ${r3.status} "${r3.json.error}" dist=${r3.json.dist}, still ${Math.round(jf2)}u from the mob`);
    const back = await mkProven(d2.p.x, d2.p.z);          // and the mob itself is always reachable
    const r4 = await post("/world/mob/hit", { wallet: back.wallet, mktToken: back.tok, idx: IDX, dmg: 10 });
    ok("...while standing on the monster re-opens the fight, so nothing is ever permanently locked",
       r4.status === 200, `status ${r4.status} "${r4.json.error || ""}" hp=${r4.json.hp}`);
  }

  // ---------- A5. DEMO / TOKENLESS PUBKEY ----------
  {
    const IDX = 12;
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const kp = Keypair.generate(); const w = kp.publicKey.toBase58();
    await post("/world/move", { wallet: w, x: ip.x, z: ip.z, y: 8, dir: 0, handle: "D", leg: 1, el: "Fire", br: 1 });
    const r = await post("/world/mob/hit", { wallet: w, idx: IDX, finish: true });
    ok("a pubkey wallet with NO proof token cannot strike even standing on the mob",
       r.status === 403 && /prove/.test(r.json.error || ""), `status ${r.status} "${r.json.error}"`);
    ok("...and nothing was credited to it", ess(w) === 0, `essence=${ess(w)}`);
  }

  // ---------- A6. STOLEN WALLET ID FROM THE ROSTER ----------
  {
    const IDX = 15;
    const ip = srv._mobIdlePos(IDX, Date.now() / 1000);
    const V = await mkProven(ip.x, ip.z);                 // the victim, genuinely present and proven
    const r = await post("/world/mob/hit", { wallet: V.wallet, idx: IDX, finish: true });  // attacker, no token
    ok("a stranger who read the victim's wallet off the roster cannot swing AS them",
       r.status === 403 && /prove/.test(r.json.error || ""), `status ${r.status} "${r.json.error}"`);
    await sleep(450);
    const own = await post("/world/mob/hit", { wallet: V.wallet, mktToken: V.tok, idx: IDX, dmg: 10 });
    ok("...and the refusal did not burn the victim's own swing budget", own.status === 200,
       `victim's own next swing status ${own.status} hp=${own.json.hp}`);
  }

  // ---------- A7. THE PUBLIC SNAPSHOT LEAKS NO PLAYER STATE ----------
  {
    const s = await get("/world/mobs");
    const blob = JSON.stringify(s.json);
    const rows = Object.values(s.json.mobs || {});
    const keys = new Set(rows.flatMap(r => Object.keys(r)));
    ok("the public mob snapshot carries only {dead,back,gen}/{hp,gen} — no wallet, anchor or hitter",
       [...keys].every(k => ["dead", "back", "gen", "hp"].includes(k)) && !/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(blob.replace(/"(mobs|tick|respawnMs|ts)"/g, "")),
       `fields=${JSON.stringify([...keys])} rows=${rows.length}`);
  }

  // ---------- A8. MALFORMED / OUT-OF-RANGE IDS ----------
  {
    const ipA = srv._mobIdlePos(0, Date.now() / 1000);
    const M = await mkProven(ipA.x, ipA.z);
    const bad = [];
    // NOTE: JSON has no NaN — JSON.stringify(NaN) is "null", so `null` covers both.
    for (const idx of [-1, 24, 1e9, "7; DROP", null, "", true, [], {}, "0x7"]) {
      await sleep(410);
      const r = await post("/world/mob/hit", { wallet: M.wallet, mktToken: M.tok, idx, finish: true });
      bad.push(`${JSON.stringify(idx)}=>${r.status}`);
    }
    // BEFORE THE FIX null/""/false/[] all coerced through Number() to 0 — a REAL monster. {idx:null}
    // answered 200 and struck spawn 0. Every one of these must now be an outright 400.
    ok("every malformed idx is refused 400 — none of them coerces into a real monster",
       bad.every(s => s.endsWith("=>400")), bad.join(" "));
    await sleep(410);
    const good = await post("/world/mob/hit", { wallet: M.wallet, mktToken: M.tok, idx: "0", dmg: 5 });
    ok("...while a genuine numeric-string idx still names its monster",
       good.status === 200, `idx:"0" => status ${good.status} hp=${good.json.hp}/${good.json.maxhp}`);
  }

  console.log(`\nSKEPTIC_MOBPOOL_DONE pass=${pass} fail=${fail}`);
  if (fails.length) for (const f of fails) console.log("  FAILED: " + f);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
