#!/usr/bin/env node
// THE SERVER RUNS THE WORLD. First tick: HP, death and respawn for the 24 monster spawns.
//
// The assertion that decides whether this ships is the FARM one. /world/kill/report already showed
// what an unguarded combat endpoint costs — 43,200 essence/hour on a wallet that never fought — so a
// new damage route has to be provably worse for a bot than the thing it replaces, not better.
// The second most important is that co-op actually pays BOTH trainers.
// No live backend. Throwaway keypairs, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59994";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8801";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
process.env.WORLD_TICK = "1";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8801";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/world/mobs")).status === 200) return; } catch (e) {} await sleep(100); } throw new Error("no server"); }

// mirrors of the server's own table, so a drift between client and server is caught here
const SPAWN0 = { name: "darkeet", x: 99.6, z: 344.7, hp: 170, essence: 1 };
const DARKEON = { idx: 12, x: 426.9, z: -198.1, hp: 400, essence: 3 };
const HIT_MIN_MS = 400, DMG_MAX = 120, RESPAWN_MS = 90000, HIT_R = 90;

async function main() {
  const srv = await import("./server.js");
  await waitUp();
  srv._clearWorldMobs();
  srv._clearOwnBook();
  console.log("\n=== THE WORLD TICK: shared monsters ===\n");

  const mk = async (x, z) => {
    const kp = Keypair.generate();
    const sid = "net_" + kp.publicKey.toBase58().slice(0, 10);
    const v = await post("/verify", { ...signIn(kp), netId: sid });
    const t = { kp, wallet: kp.publicKey.toBase58(), sid, tok: v.json.mktToken };
    await post("/world/move", { wallet: t.wallet, mktToken: t.tok, x, z, y: 6, dir: 0, handle: "T", leg: 1, el: "Fire", br: 1 });
    return t;
  };
  const hit = (t, idx, dmg) => post("/world/mob/hit", { wallet: t.wallet, mktToken: t.tok, idx, dmg });

  // ---------- 1. the shared world exists and starts pristine ----------
  const m0 = await get("/world/mobs");
  ok("the shared world answers", m0.status === 200 && m0.json.tick === true, `tick=${m0.json.tick}`);
  ok("...and a pristine island sends nothing (cheap common case)",
     Object.keys(m0.json.mobs || {}).length === 0, `mobs=${JSON.stringify(m0.json.mobs)}`);
  ok("...and reports the respawn window", Number(m0.json.respawnMs) === RESPAWN_MS, `respawnMs=${m0.json.respawnMs}`);

  // ---------- 2. ONE HP POOL: two trainers hitting the same monster ----------
  const a = await mk(SPAWN0.x + 10, SPAWN0.z);
  const b = await mk(SPAWN0.x - 10, SPAWN0.z + 5);
  const h1 = await hit(a, 0, 50);
  ok("trainer A lands a hit", h1.status === 200 && h1.json.ok === true, `status ${h1.status} hp=${h1.json.hp}`);
  ok("...on the mob's real HP pool", Number(h1.json.hp) === SPAWN0.hp - 50 && Number(h1.json.maxhp) === SPAWN0.hp,
     `hp=${h1.json.hp}/${h1.json.maxhp} expected ${SPAWN0.hp - 50}/${SPAWN0.hp}`);
  const h2 = await hit(b, 0, 30);
  ok("trainer B's hit lands on THE SAME pool — this is the co-op unlock",
     Number(h2.json.hp) === SPAWN0.hp - 80, `hp=${h2.json.hp} expected ${SPAWN0.hp - 80}`);
  const shared = await get("/world/mobs");
  ok("...and every other client can see it is hurt",
     shared.json.mobs && shared.json.mobs["0"] && Number(shared.json.mobs["0"].hp) === SPAWN0.hp - 80,
     JSON.stringify(shared.json.mobs));

  // ---------- 3. IT DIES ONCE, AND PAYS EVERYONE WHO FOUGHT IT ----------
  let killed = null;
  for (let i = 0; i < 12 && !killed; i++) {
    await sleep(HIT_MIN_MS + 60);
    const r = await hit(a, 0, DMG_MAX);
    if (r.json.killed) killed = r;
  }
  ok("the monster dies", killed !== null && killed.json.killed === true, killed ? `gen=${killed.json.gen}` : "never died");
  if (killed) {
    ok("...paying BOTH trainers who damaged it, not just the last hitter",
       Number(killed.json.paid) === 2, `paid=${killed.json.paid}`);
    const ba = srv._ownFor(a.wallet), bb = srv._ownFor(b.wallet);
    ok("...A was credited the mob's own essence value",
       ba && ba.cred["mat:essence"] === SPAWN0.essence, `A cred=${JSON.stringify(ba && ba.cred)}`);
    ok("...and so was B, who never landed the killing blow",
       bb && bb.cred["mat:essence"] === SPAWN0.essence, `B cred=${JSON.stringify(bb && bb.cred)}`);
  }
  const dead = await get("/world/mobs");
  ok("it is dead for EVERYONE, with a shared clock",
     dead.json.mobs["0"] && dead.json.mobs["0"].dead === 1 && Number(dead.json.mobs["0"].back) > 0,
     JSON.stringify(dead.json.mobs["0"]));

  // ---------- 4. a corpse cannot be farmed for credit ----------
  await sleep(HIT_MIN_MS + 60);
  const corpse = await hit(b, 0, DMG_MAX);
  ok("beating a corpse earns nothing and says when it returns",
     corpse.json.dead === true && !corpse.json.killed, JSON.stringify(corpse.json));
  const bb2 = srv._ownFor(b.wallet);
  ok("...B's credit did not move", bb2.cred["mat:essence"] === SPAWN0.essence, `cred=${JSON.stringify(bb2.cred)}`);

  // ---------- 5. THE RESPAWN IS THE SERVER'S, AND A NEW LIFE CANNOT REPAY THE OLD ONE ----------
  const genBefore = srv._mobFor(0).gen;
  srv._mobTickForTest(Date.now() + RESPAWN_MS + 1000);
  const rev = srv._mobFor(0);
  ok("the tick brings it back for everyone", rev.dead === false && rev.hp === SPAWN0.hp,
     `hp=${rev.hp} dead=${rev.dead}`);
  ok("...on a NEW generation, so the old kill can never be re-credited",
     rev.gen === genBefore + 1, `gen ${genBefore} -> ${rev.gen}`);
  ok("...with the contributor list cleared", rev.hitters.length === 0, `hitters=${JSON.stringify(rev.hitters)}`);

  // ---------- 5b. A SYBIL FLEET CANNOT MULTIPLY ONE KILL ----------
  // Paying every hitter in full was a 40x multiplier: hitters is capped at 40, so forty throwaway
  // wallets each landing 1 damage would have collected forty rewards for one monster.
  srv._clearWorldMobs(); srv._clearOwnBook();
  const IDX = 1, SX = 378.0, SZ = -415.0;          // darkeet, hp 170, essence 1
  const fleet = [];
  for (let i = 0; i < 8; i++) fleet.push(await mk(SX + i, SZ));
  for (const f of fleet) await hit(f, IDX, 1);     // one point each: tourists, not contributors
  const real = await mk(SX, SZ + 2);
  let fk = null;
  for (let i = 0; i < 12 && !fk; i++) {
    await sleep(HIT_MIN_MS + 60);
    const r = await hit(real, IDX, DMG_MAX);
    if (r.json.killed) fk = r;
  }
  ok("the trainer who actually fought it lands the kill", fk !== null, fk ? `paid=${fk.json.paid}` : "never died");
  if (fk) {
    ok("...and ONLY they are paid — eight one-damage tourists earn nothing",
       Number(fk.json.paid) === 1, `paid=${fk.json.paid} (fleet of ${fleet.length} poked it)`);
    const anyFleetPaid = fleet.some(f => { const bk = srv._ownFor(f.wallet); return bk && bk.cred["mat:essence"]; });
    ok("...verified against the book, not just the count", !anyFleetPaid,
       `fleet credits=${JSON.stringify(fleet.map(f => (srv._ownFor(f.wallet) || {}).cred || null))}`);
  }
  // but genuine co-op still pays everyone who did real work
  srv._clearWorldMobs(); srv._clearOwnBook();
  const c1 = await mk(SX, SZ), c2 = await mk(SX + 3, SZ);
  let ck = null;
  for (let i = 0; i < 14 && !ck; i++) {
    await sleep(HIT_MIN_MS + 60);
    const r1 = await hit(c1, IDX, 60);
    if (r1.json.killed) { ck = r1; break; }
    await sleep(HIT_MIN_MS + 60);
    const r2 = await hit(c2, IDX, 60);
    if (r2.json.killed) { ck = r2; break; }
  }
  ok("a real duo still both get paid — the share gate does not break co-op",
     ck !== null && Number(ck.json.paid) === 2, ck ? `paid=${ck.json.paid}` : "never died");

  // ---------- 6. THE FARM TEST — the one that decides whether this ships ----------
  // Compare against the standard not to repeat: /world/kill/report gives 43,200 essence/hour with no
  // movement at all. A bot here is bounded by the SERVER's respawn clock, not by its own request rate.
  const maxKillsPerHour = 24 * 3600000 / RESPAWN_MS;
  const worstEssencePerHour = maxKillsPerHour * 3;   // if every spawn were a darkeon (they are not: 6 of 24)
  ok(`the respawn clock caps the island at ${maxKillsPerHour} kills/hour, all 24 spawns combined`,
     maxKillsPerHour === 960, `${maxKillsPerHour}`);
  ok(`...so the absolute ceiling is ${worstEssencePerHour} essence/hour vs the 43,200 faucet — a ${(43200 / worstEssencePerHour).toFixed(0)}x cut`,
     worstEssencePerHour < 43200 / 10, `${worstEssencePerHour}`);

  // ---------- 6b. THE ANCHOR, which replaced a reach gate that was a coin flip ----------
  // Monsters.gd's only steering is an annulus around the island centre (447-451); there is NO leash to
  // home, and all 24 of 24 homes sit inside the unsteered 250..620 band, so a mob random-walks a
  // 370-unit ring and can sit hundreds of units from its spawn. A 90-unit gate around home would have
  // refused the honest fighter most of the time and stopped no bot. The anchor records where the fight
  // IS, taken from the first striker's own presence row.
  srv._clearWorldMobs();
  const AX = DARKEON.x + 300, AZ = DARKEON.z + 300;    // far from home: a mob really can wander here
  const opener = await mk(AX, AZ);
  const o1 = await hit(opener, DARKEON.idx, 10);
  ok("the trainer who OPENS a fight is never refused, wherever the monster wandered to",
     o1.status === 200, `status ${o1.status} ${JSON.stringify(o1.json.error || "")}`);
  const buddy = await mk(AX + 20, AZ);
  await sleep(HIT_MIN_MS + 60);
  const o2 = await hit(buddy, DARKEON.idx, 10);
  ok("...and someone standing beside them joins the SAME fight", o2.status === 200, `status ${o2.status}`);
  const tourist = await mk(AX - 900, AZ);
  await sleep(HIT_MIN_MS + 60);
  const o3 = await hit(tourist, DARKEON.idx, 10);
  ok("...but someone nowhere near it cannot claim a share",
     o3.status === 403 && String(o3.json.error) === "too far from the fight",
     `status ${o3.status} ${JSON.stringify(o3.json.error || "")} dist=${o3.json.dist}`);
  srv._clearWorldMobs();
  const liar2 = await mk(DARKEON.x + 3000, DARKEON.z + 3000);
  const o4 = await hit(liar2, DARKEON.idx, 10);
  ok("...and no fight can be anchored where a monster could never have walked",
     o4.status === 403, `status ${o4.status} ${JSON.stringify(o4.json.error || "")} dist=${o4.json.dist}`);

  srv._clearWorldMobs();
  const farAway = await mk(DARKEON.x, DARKEON.z);

  // rate limit — two swings back to back, so the second is genuinely inside the window
  await hit(farAway, DARKEON.idx, 1);
  const spam = await hit(farAway, DARKEON.idx, DMG_MAX);
  ok("a second swing inside MOB_HIT_MIN_MS is refused", spam.status === 429, `status ${spam.status} retry=${spam.json.retryInMs}`);

  // damage clamp: a modified client cannot delete a boss in one request. Measured against the mob's
  // CURRENT hp, not its max — the rate-limit test above already landed a swing on it.
  await sleep(HIT_MIN_MS + 60);
  const hpBefore = srv._mobFor(DARKEON.idx).hp;
  const nuke = await hit(farAway, DARKEON.idx, 999999999);
  ok("a one-shot is clamped to MOB_DMG_MAX, so no client can delete a boss",
     hpBefore - Number(nuke.json.hp) <= DMG_MAX && !nuke.json.killed,
     `${hpBefore} -> ${nuke.json.hp} (drop ${hpBefore - Number(nuke.json.hp)}, cap ${DMG_MAX}) killed=${nuke.json.killed}`);
  for (const junk of [NaN, -500, "abc", Infinity, null]) {
    await sleep(HIT_MIN_MS + 60);
    const before = srv._mobFor(DARKEON.idx).hp;
    const r = await hit(farAway, DARKEON.idx, junk);
    const after = srv._mobFor(DARKEON.idx).hp;
    ok(`dmg=${String(junk)} moves HP by a legal amount only`,
       after <= before && before - after <= DMG_MAX, `${before} -> ${after}`);
  }

  // ---------- 6c. AN UNPROVEN WALLET CANNOT FIGHT OR BE PAID ----------
  // This route credits sellable essence and had no proof gate, while /world/kill/report demands one.
  // Requiring proof also stops a stranger reading a wallet off /world/roster and burning that
  // trainer's swing budget from across the world.
  srv._clearWorldMobs();
  const victim = await mk(SPAWN0.x, SPAWN0.z);
  const unproven = await post("/world/mob/hit", { wallet: victim.wallet, idx: 0, dmg: DMG_MAX });   // no mktToken
  ok("a hit with no proof of the wallet is refused",
     unproven.status === 403 && String(unproven.json.error) === "prove this wallet first",
     `status ${unproven.status} ${JSON.stringify(unproven.json.error || "")}`);
  ok("...and it did NOT consume the real owner's swing budget",
     (await hit(victim, 0, 10)).status === 200, "owner can still swing immediately");

  // ---------- 7. A SELF-CHOSEN net_id EARNS NOTHING ----------
  // presenceOk returns true for any net_id with no signature, so it can create presence and swing —
  // but it is not an identity, and the acquisition bound only accepts pubkeys.
  // fresh state: the test above left a real pubkey in mob 0's contributor list, and it was correctly
  // paid — which made `paid` ambiguous here rather than wrong.
  srv._clearWorldMobs(); srv._clearOwnBook();
  const ghost = { wallet: "godot-" + crypto.randomBytes(4).toString("hex"), tok: "" };
  await post("/world/move", { wallet: ghost.wallet, x: SPAWN0.x, z: SPAWN0.z, y: 6, dir: 0, handle: "G", leg: 1, el: "Fire", br: 1 });
  let ghostKill = null;
  for (let i = 0; i < 14 && !ghostKill; i++) {
    const r = await post("/world/mob/hit", { wallet: ghost.wallet, idx: 0, dmg: DMG_MAX });
    if (r.json && r.json.killed) ghostKill = r;
    await sleep(HIT_MIN_MS + 60);
  }
  ok("a net_id CAN fight (demo players are real players)", ghostKill !== null, ghostKill ? "killed" : "never killed");
  if (ghostKill) {
    ok("...but earns nothing — a self-chosen id is not an identity",
       Number(ghostKill.json.paid) === 0, `paid=${ghostKill.json.paid}`);
    ok("...and no book row was created for it", srv._ownFor(ghost.wallet) === null, JSON.stringify(srv._ownFor(ghost.wallet)));
  }

  // ---------- 8. the flag really gates it ----------
  srv._setWorldTickForTest(false);
  const offHit = await hit(a, 1, 10);
  ok("with WORLD_TICK off the route refuses cleanly (503, not a crash)",
     offHit.status === 503 && offHit.json.tick === false, `status ${offHit.status}`);
  const offSnap = await get("/world/players?wallet=x&x=0&z=0");
  ok("...and the shared world is absent from the move reply, so an old client sees exactly today",
     offSnap.json.mobs === undefined, `mobs=${JSON.stringify(offSnap.json.mobs)}`);
  srv._setWorldTickForTest(true);

  // ---------- 9. the operator can see it. Counters are cumulative across the run but _clearWorldMobs
  // zeroes them, so land at least one fresh hit+kill here rather than trusting whatever survived. ----
  srv._clearWorldMobs();
  const opX = 99.6, opZ = 344.7;                       // spawn 0, darkeet, hp 170
  const op = await mk(opX, opZ);
  const bystander = await mk(opX + 800, opZ);          // will be refused: counts a refusal
  await hit(bystander, 0, 5);
  let opKilled = false;
  for (let i = 0; i < 12 && !opKilled; i++) {
    await sleep(HIT_MIN_MS + 60);
    const r = await hit(op, 0, DMG_MAX);
    if (r.json.killed) opKilled = true;
  }
  ok("a fresh hit/kill/refusal trio is produced for the counters", opKilled, `killed=${opKilled}`);
  const sum = await get("/assets/summary?key=" + encodeURIComponent(process.env.ADMIN_KEY));
  const wt = sum.json.worldTick || {};
  ok("the audit reports the world tick", wt.running === true, `running=${wt.running}`);
  ok("...with hits, kills and refusals all counted",
     Number(wt.hits) > 0 && Number(wt.kills) > 0 && Number(wt.hitsRefused) > 0,
     `hits=${wt.hits} kills=${wt.kills} refused=${wt.hitsRefused}`);
  ok("...and states the hard ceiling it enforces", Number(wt.maxKillsPerHour) === 960, `${wt.maxKillsPerHour}`);

  // ---------- 10. BANDWIDTH: the shared world must not cost what it saves ----------
  srv._clearWorldMobs();
  const near = await mk(SPAWN0.x, SPAWN0.z);
  for (let i = 0; i < 6; i++) { await hit(near, i % 3, 20); await sleep(HIT_MIN_MS + 60); }
  const snap = await get("/world/mobs");
  const bytes = JSON.stringify(snap.json.mobs).length;
  ok(`a busy island's shared state is ${bytes} bytes — trivial beside the 307-byte-per-player rows`,
     bytes < 600, `${bytes} bytes for ${Object.keys(snap.json.mobs).length} mobs`);

  // ---------- 11. A RESTART MUST NOT RESURRECT THE ISLAND ----------
  // worldMobs was memory-only. Render's free plan restarts on every deploy and on idle spin-down, so
  // 24 monsters came back at full health each time — a farm (kill the island, trigger a restart, kill
  // it again) and a silent undo of a death everyone watched. Node cooldowns were already persisted for
  // exactly this reason; mobs now are too.
  srv._clearWorldMobs();
  const pk = await mk(SPAWN0.x, SPAWN0.z);
  let pKilled = false;
  for (let i = 0; i < 12 && !pKilled; i++) {
    await sleep(HIT_MIN_MS + 60);
    const r = await hit(pk, 0, DMG_MAX);
    if (r.json.killed) pKilled = true;
  }
  ok("a monster is down before the simulated restart", pKilled, `killed=${pKilled}`);
  const blob = srv.serializeWorldMobs();
  ok("...and the corpse is in the persisted blob", Array.isArray(blob) && blob.length === 1,
     JSON.stringify(blob));
  const genWas = srv._mobFor(0).gen;
  srv._clearWorldMobs();                                   // the restart
  ok("...the restart really does empty the map", srv._mobFor(0) === null, JSON.stringify(srv._mobFor(0)));
  const restored = srv.restoreWorldMobs(blob);
  ok("...and the restore brings the corpse back, not the monster", restored === 1, `restored=${restored}`);
  const after = srv._mobFor(0);
  ok("...still dead, on its original generation", after && after.dead === true && after.gen === genWas,
     `dead=${after && after.dead} gen=${after && after.gen} (was ${genWas})`);
  ok("...with its contributor list closed, so that life cannot be paid twice",
     after && after.hitters.length === 0, JSON.stringify(after && after.hitters));

  // hostile / stale input
  const junkBlob = [
    ["notanumber", { deadAt: Date.now(), gen: 1 }],
    [999, { deadAt: Date.now(), gen: 1 }],                        // no such spawn
    [2, { deadAt: Date.now() + 600000, gen: 1 }],                 // died in the future
    [3, { deadAt: Date.now() - RESPAWN_MS - 5000, gen: 1 }],      // respawn already came due
    [4, { deadAt: Date.now(), gen: 2 }],                          // the one good row
  ];
  srv._clearWorldMobs();
  const kept = srv.restoreWorldMobs(junkBlob);
  ok("restore keeps ONLY the plausible row and drops the rest", kept === 1, `kept=${kept} of ${junkBlob.length}`);
  ok("...the one that survived is the real one", srv._mobFor(4) !== null && srv._mobFor(4).dead === true,
     JSON.stringify(srv._mobFor(4)));
  ok("...a monster whose respawn came due while we were down is simply alive again",
     srv._mobFor(3) === null, JSON.stringify(srv._mobFor(3)));

  // ---------- 12. THE FINISHING BLOW: how combat ACTUALLY works here ----------
  // Chikoria has no world chip damage — HIT_R is a HUD hint, and a monster is engaged into a private
  // 1v1 card battle and killed outright on a win. So a client reports a KILL, and the defence is
  // scarcity (24 spawns, 90 s respawn) rather than damage arithmetic the server cannot check.
  srv._clearWorldMobs(); srv._clearOwnBook();
  const FX = DARKEON.x, FZ = DARKEON.z;
  const winner = await mk(FX, FZ);
  const fin = await post("/world/mob/hit", { wallet: winner.wallet, mktToken: winner.tok, idx: DARKEON.idx, finish: true });
  ok("a battle win kills the monster outright, whatever its HP",
     fin.status === 200 && fin.json.killed === true && Number(fin.json.hp) === 0,
     `status ${fin.status} hp=${fin.json.hp} killed=${fin.json.killed}`);
  ok("...and pays the finisher", Number(fin.json.paid) >= 1, `paid=${fin.json.paid}`);
  const fb = srv._ownFor(winner.wallet);
  ok("...the mob's own essence value, through the acquisition bound",
     fb && fb.cred["mat:essence"] === DARKEON.essence, `cred=${JSON.stringify(fb && fb.cred)}`);

  // it is dead for EVERYONE
  const seen2 = await get("/world/mobs");
  ok("it is dead for everyone on a shared clock",
     seen2.json.mobs[String(DARKEON.idx)] && seen2.json.mobs[String(DARKEON.idx)].dead === 1,
     JSON.stringify(seen2.json.mobs[String(DARKEON.idx)]));

  // a SECOND claim on the same life earns nothing — this is the whole faucet bound
  await sleep(HIT_MIN_MS + 60);
  const again = await post("/world/mob/hit", { wallet: winner.wallet, mktToken: winner.tok, idx: DARKEON.idx, finish: true });
  ok("a second claim on the same life is refused", again.json.dead === true && !again.json.killed,
     JSON.stringify(again.json));
  const fb2 = srv._ownFor(winner.wallet);
  ok("...and credits nothing further", fb2.cred["mat:essence"] === DARKEON.essence,
     `cred=${JSON.stringify(fb2.cred)}`);

  // and a stranger cannot finish a monster they are nowhere near
  srv._clearWorldMobs();
  const tourist2 = await mk(DARKEON.x + 3000, DARKEON.z + 3000);
  const far = await post("/world/mob/hit", { wallet: tourist2.wallet, mktToken: tourist2.tok, idx: DARKEON.idx, finish: true });
  ok("a finish from across the world is refused", far.status === 403, `status ${far.status} ${JSON.stringify(far.json.error||"")}`);
  // ...and an unproven caller cannot either
  const noproof = await post("/world/mob/hit", { wallet: winner.wallet, idx: DARKEON.idx, finish: true });
  ok("...as is a finish with no proof of the wallet", noproof.status === 403, `status ${noproof.status}`);

  // THE ISLAND-WIDE CEILING: 24 spawns on a 90 s clock is the real bound on this faucet
  srv._clearWorldMobs(); srv._clearOwnBook();
  const farmer = await mk(0, 0);
  let taken = 0;
  for (let i = 0; i < srv._mobSpawnCount(); i++) {
    const sp = srv._mobSpawnAt(i);
    await post("/world/move", { wallet: farmer.wallet, mktToken: farmer.tok, x: sp[1], z: sp[2], y: 6, dir: 0, handle: "F", leg: 1, el: "Fire", br: 1 });
    await sleep(HIT_MIN_MS + 60);
    const r = await post("/world/mob/hit", { wallet: farmer.wallet, mktToken: farmer.tok, idx: i, finish: true });
    if (r.json.killed) taken++;
  }
  ok(`one wallet can clear the island but no further: ${taken} kills, then everything is on a ${RESPAWN_MS / 1000}s clock`,
     taken === srv._mobSpawnCount(), `${taken}/${srv._mobSpawnCount()}`);
  const perHour = (taken * srv._mobEssenceTotal() / taken) * (3600000 / RESPAWN_MS);
  ok("...which is an island-wide ceiling far under the 43,200/hr the old report path allowed",
     srv._mobEssenceTotal() * (3600000 / RESPAWN_MS) < 43200 / 10,
     `${Math.round(srv._mobEssenceTotal() * (3600000 / RESPAWN_MS))} essence/hr for EVERYONE combined`);

  console.log(`\nWORLD_TICK_SIM  pass=${pass} fail=${fail}`);
  if (fail) { console.log("failures:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SIM ERROR", e); process.exit(1); });
