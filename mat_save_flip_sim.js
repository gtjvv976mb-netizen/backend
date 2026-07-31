#!/usr/bin/env node
// STEP 7 — THE ECONOMY FLIP: the save-path material bound (matSaveBaseline / matSaveEnforce).
//
// The invariant under test, per material, per pubkey wallet:
//     claimed <= base + cred + UNWITNESSED_ALLOWANCE - sold - used      (floored at 0)
// where base is the ONE-TIME grandfather offset taken on the wallet's first save-accept after the
// flip. The tests that MATTER are the false-positive ones: an honest player's normal life — gather,
// craft, sell, buy, across sessions, with a legacy stock — must NEVER trip it.
//
// No live backend, no on-chain. Throwaway keypair, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59981";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8811";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;
delete process.env.FFISH_AUTHORITY;
delete process.env.CHIK_MAT_ENFORCE;   // default: the flip is ON

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8811";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/market/list")).status === 200) return; } catch (e) {} await wait(100); } throw new Error("no server"); }
const ALLOW = 1500;      // UNWITNESSED_ALLOWANCE
const OPEN_CAP = 6200;   // OWN_OPEN_CAP
let seq = 0; const lid = () => "F" + (++seq) + "_" + crypto.randomBytes(3).toString("hex");

async function main() {
  const srv = await import("./server.js");
  await waitUp();
  srv._clearOwnBook();
  console.log("\n=== STEP 7: THE ECONOMY FLIP (save-path material bound) ===\n");

  const mkAuth = () => signIn(Keypair.generate());
  // saves are throttled at 600ms/wallet — every push waits it out
  const save = (a, mmo) => wait(700).then(() => post("/profile", { wallet: a.wallet, authMsg: a.authMsg, authSig: a.authSig, profile: { mmo } }));
  const load = (a) => get(`/profile?wallet=${a.wallet}&authMsg=${encodeURIComponent(a.authMsg)}&authSig=${encodeURIComponent(a.authSig)}`);
  const verify = (a, sid) => post("/verify", { ...a, netId: sid });
  const list = (a, sid, tok, l) => post("/market/op", { sid, op: "list", mktToken: tok, wallet: a.wallet, listing: l });
  const softBuy = (buyerSid, id) => post("/market/op", { sid: buyerSid, op: "buy", listing: { id }, buyerName: "Buddy" });

  // ---------- 1. THE HONEST LIFE: gather -> craft -> sell -> buy across 3 sessions, legacy stock ----------
  console.log("-- 1. honest life never clamps --");
  const A = mkAuth();
  const r1 = await save(A, { v: 2, mats: { wood: 900, iron: 700, stone: 400 } });   // legacy-size stock, first save = baseline
  ok("session 1: legacy stock save accepted, no clamps", r1.status === 200 && r1.json.ok === true && !r1.json.matClamps,
     `status ${r1.status} matClamps=${JSON.stringify(r1.json.matClamps || null)}`);
  // gather FOR REAL through the world routes (presence + position-authorised claims) to prove the wiring
  const vA = await verify(A, "net_A_" + A.wallet.slice(0, 6));
  const tokA = vA.json.mktToken;
  await post("/world/move", { wallet: A.wallet, mktToken: tokA, x: 40, z: 40, y: 6, dir: 0, handle: "A", leg: 1, el: "Fire", br: 1 });
  let realClaims = 0;
  for (let i = 0; i < 3; i++) {
    const rc = await post("/world/node/claim", { wallet: A.wallet, mktToken: tokA, id: `wood:${40 + i * 3}:40` });
    if (rc.status === 200 && rc.json.ok !== false) realClaims++;
    await wait(1850);   // CLAIM_MIN_MS
  }
  const bookA1 = srv._ownFor(A.wallet);
  const credWoodReal = (bookA1 && bookA1.cred["mat:wood"]) || 0;
  ok("real node claims credit the SAME book the save bound reads", realClaims > 0 && credWoodReal >= realClaims,
     `claims=${realClaims} cred[mat:wood]=${credWoodReal}`);
  // bulk gathering is CLAIM_MIN_MS-paced in real life; model the rest through the same credit fn (ownCredit)
  srv._grantOwnForTest(A.wallet, "wood", 300); srv._grantOwnForTest(A.wallet, "iron", 200);
  // craft: a CLIENT-DECLARED spend — no server event, claims simply go down (always safe)
  // sell: list 200 wood (client removes them from the bag at list time), buddy soft-buys -> ownSold
  const idA = lid();
  const rl = await list(A, "net_A_" + A.wallet.slice(0, 6), tokA, { id: idA, kind: "mat", item: "wood", qty: 200, price: 300 });
  ok("honest listing of 200 wood accepted", rl.status === 200, `status ${rl.status} ${JSON.stringify(rl.json.error || "")}`);
  const rb = await softBuy("net_buddy_1", idA);
  ok("buddy's soft buy settles (ownSold records the seller sink)", rb.status === 200, `status ${rb.status}`);
  // buy: a market purchase credits the buyer (models server.js /market/buy-onchain ownCredit(buyer,...))
  srv._grantOwnForTest(A.wallet, "iron", 250);
  await wait(1500);   // the "offline gap" — the bound is event-based, not time-based, so a gap changes nothing
  const woodNow = 900 + credWoodReal + 300 - 150 - 200;   // legacy + gathered - crafted - sold
  const r2 = await save(A, { v: 2, mats: { wood: woodNow, iron: 1150, stone: 400 } });
  ok("session 2 (after offline gap): evolved inventory saves clean", r2.status === 200 && !r2.json.matClamps,
     `wood=${woodNow} bound=${srv._matSaveBoundForTest(A.wallet, "wood")} matClamps=${JSON.stringify(r2.json.matClamps || null)}`);
  srv._grantOwnForTest(A.wallet, "wood", 100);
  const r3 = await save(A, { v: 2, mats: { wood: woodNow + 100, iron: 1150, stone: 400 } });
  ok("session 3: still clean — an honest life NEVER trips the flip", r3.status === 200 && !r3.json.matClamps,
     `wood=${woodNow + 100} bound=${srv._matSaveBoundForTest(A.wallet, "wood")}`);

  // ---------- 1b. THE PRE-FLIP SELLER: sold most of a legacy hoard BEFORE the flip ----------
  console.log("-- 1b. a pre-flip seller's remaining stock is not falsely clamped --");
  const A2 = mkAuth();
  process.env.CHIK_MAT_ENFORCE = "0";              // pre-flip world: observe-only, no baseline taken
  const p1 = await save(A2, { v: 2, mats: { wood: 3000 } });
  ok("pre-flip save (kill-switch off) takes no baseline and returns no clamps",
     p1.status === 200 && !p1.json.matClamps && !(srv._ownFor(A2.wallet) && srv._ownFor(A2.wallet).baseSrc),
     `baseSrc=${(srv._ownFor(A2.wallet) || {}).baseSrc || 0}`);
  await srv._setServerSavedAtForTest(A2.wallet, Date.parse("2026-07-01T00:00:00Z"));   // a real pre-epoch veteran
  const p2 = await save(A2, { v: 2, mats: { wood: 3000 } });                            // market opening snapshot fires
  const vA2 = await verify(A2, "net_A2_" + A2.wallet.slice(0, 6));
  const idA2 = lid();
  const rl2 = await list(A2, "net_A2_" + A2.wallet.slice(0, 6), vA2.json.mktToken, { id: idA2, kind: "mat", item: "wood", qty: 2500, price: 900 });
  ok("veteran can list 2500 of the legacy hoard (market opening balance)", rl2.status === 200, `status ${rl2.status} ${JSON.stringify(rl2.json.error || "")}`);
  const rb2 = await softBuy("net_buddy_2", idA2);
  ok("...and it sells pre-flip (sold=2500 with zero cred)", rb2.status === 200, `status ${rb2.status}`);
  process.env.CHIK_MAT_ENFORCE = "1";              // THE FLIP DEPLOYS
  const p3 = await save(A2, { v: 2, mats: { wood: 500 } });                             // first post-flip save: baseline
  const naive = 500 + 0 + ALLOW - 2500;            // what a mark-less bound would have been
  const bWood = srv._matSaveBoundForTest(A2.wallet, "wood");
  ok("first post-flip save of the REMAINING 500 wood is clean (baseline marks off pre-flip sinks)",
     p3.status === 200 && !p3.json.matClamps && bWood >= 500,
     `bound=${bWood}; a mark-less bound would have been ${naive} -> floor 0 -> FALSE CLAMP`);
  srv._grantOwnForTest(A2.wallet, "wood", 100);
  const p4 = await save(A2, { v: 2, mats: { wood: 600 } });
  ok("...and freshly gathered wood on top saves clean too", p4.status === 200 && !p4.json.matClamps,
     `wood=600 bound=${srv._matSaveBoundForTest(A2.wallet, "wood")}`);

  // ---------- 2. THE CHEAT: 5000 iron teleported into an established save ----------
  console.log("-- 2. a teleported hoard is clamped to baseline+observed+allowance exactly --");
  const B = mkAuth();
  await save(B, { v: 2, mats: { iron: 40 } });     // honest first save -> base iron = 40
  srv._grantOwnForTest(B.wallet, "iron", 10);      // gathers a little
  const rB = await save(B, { v: 2, mats: { iron: 5040 } });
  const expB = 40 + 10 + ALLOW;
  ok("5040 claimed iron is clamped in the response", rB.status === 200 && rB.json.matFlagged === true &&
     rB.json.matClamps && rB.json.matClamps.iron === expB,
     `before=5040 after=${rB.json.matClamps && rB.json.matClamps.iron} expected=${expB} (base 40 + cred 10 + allowance ${ALLOW})`);
  const lB = await load(B);
  ok("the signed blob is NOT rewritten — the store still holds the pushed 5040", Number(lB.json?.profile?.mmo?.mats?.iron) === 5040,
     `stored=${lB.json?.profile?.mmo?.mats?.iron} (corrections travel in the response; the client applies and re-signs)`);
  const st2 = srv._matFlipStateForTest();
  ok("the wallet is flagged for the operator", st2.flagged >= 1 && st2.clamps >= 1, `flagged=${st2.flagged} clamps=${st2.clamps}`);

  // ---------- 3. THE BASELINE IS WRITTEN ONCE ----------
  console.log("-- 3. an inflated FIRST save is the accepted (capped) cost; the SECOND clamps --");
  const C = mkAuth();
  const rC1 = await save(C, { v: 2, mats: { iron: 5000 } });
  ok("first post-flip save of 5000 iron IS grandfathered — stated plainly: that is the accepted cost",
     rC1.status === 200 && !rC1.json.matClamps, `matClamps=${JSON.stringify(rC1.json.matClamps || null)}`);
  const rC2 = await save(C, { v: 2, mats: { iron: 20000 } });
  ok("the SECOND inflated push clamps to base+allowance exactly (no baseline top-up)",
     rC2.json.matClamps && rC2.json.matClamps.iron === 5000 + ALLOW,
     `after=${rC2.json.matClamps && rC2.json.matClamps.iron} expected=${5000 + ALLOW}`);
  const rC3 = await save(C, { v: 2, mats: { iron: 20000 } });
  ok("...and a third push cannot ratchet it either", rC3.json.matClamps && rC3.json.matClamps.iron === 5000 + ALLOW,
     `after=${rC3.json.matClamps && rC3.json.matClamps.iron}`);
  const C2 = mkAuth();
  const rC4 = await save(C2, { v: 2, mats: { iron: 999999 } });
  ok("a hoard beyond OWN_OPEN_CAP clamps on the VERY FIRST save (grandfather is capped)",
     rC4.json.matClamps && rC4.json.matClamps.iron === OPEN_CAP + ALLOW,
     `first-save clamp=${rC4.json.matClamps && rC4.json.matClamps.iron} expected=${OPEN_CAP + ALLOW}`);

  // ---------- 4. THE HEAVY TRADER: market purchases credit the save bound ----------
  console.log("-- 4. market credits raise the bound — an honest heavy trader never clamps --");
  const D = mkAuth();
  await save(D, { v: 2, mats: {} });               // starts empty
  srv._grantOwnForTest(D.wallet, "wood", 3000);    // ownCredit — the same fn the verified on-chain settle calls (buy-onchain -> ownCredit(buyer))
  const rD1 = await save(D, { v: 2, mats: { wood: 3000 } });
  ok("3000 bought wood saves clean", rD1.status === 200 && !rD1.json.matClamps,
     `bound=${srv._matSaveBoundForTest(D.wallet, "wood")}`);
  const vD = await verify(D, "net_D_" + D.wallet.slice(0, 6));
  const idD = lid();
  await list(D, "net_D_" + D.wallet.slice(0, 6), vD.json.mktToken, { id: idD, kind: "mat", item: "wood", qty: 1000, price: 500 });
  await softBuy("net_buddy_3", idD);               // resells 1000 -> sold
  const rD2 = await save(D, { v: 2, mats: { wood: 2000 } });
  ok("after reselling 1000, the 2000 left saves clean", rD2.status === 200 && !rD2.json.matClamps,
     `bound=${srv._matSaveBoundForTest(D.wallet, "wood")}`);
  srv._grantOwnForTest(D.wallet, "wood", 500);     // buys 500 more
  const rD3 = await save(D, { v: 2, mats: { wood: 2500 } });
  ok("buy-sell-buy churn stays clean across the cycle", rD3.status === 200 && !rD3.json.matClamps,
     `bound=${srv._matSaveBoundForTest(D.wallet, "wood")}`);

  // ---------- 5. SINKS: the egg barter debits the bound and cannot be replayed ----------
  console.log("-- 5. server-authorised sinks reduce the bound; replay cannot push it negative --");
  const E = mkAuth();
  await save(E, { v: 2, mats: { wood: 100, berries: 100, essence: 100 } });   // baseline
  srv._grantOwnForTest(E.wallet, "wood", 500); srv._grantOwnForTest(E.wallet, "berries", 500); srv._grantOwnForTest(E.wallet, "essence", 500);
  const vE = await verify(E, "net_E_" + E.wallet.slice(0, 6));
  const rEgg = await post("/assets/egg/claim", { wallet: E.wallet, mktToken: vE.json.mktToken, kind: "normal" });
  ok("egg claim (recipe: 30 wood, 24 berries, 8 essence) is authorised and debits `used`", rEgg.status === 200,
     `status ${rEgg.status} used=${JSON.stringify((srv._ownFor(E.wallet) || {}).used)}`);
  const boundWoodE = srv._matSaveBoundForTest(E.wallet, "wood");
  const expWoodE = 100 + 500 + ALLOW - 30;
  ok("the wood bound dropped by exactly the recipe", boundWoodE === expWoodE, `bound=${boundWoodE} expected=${expWoodE}`);
  const rE1 = await save(E, { v: 2, mats: { wood: 570, berries: 576, essence: 592 } });
  ok("the honest post-craft inventory saves clean", rE1.status === 200 && !rE1.json.matClamps,
     `matClamps=${JSON.stringify(rE1.json.matClamps || null)}`);
  const rE2 = await save(E, { v: 2, mats: { wood: 2500 } });
  ok("claiming NOT to have paid Mithra is caught (clamped to the debited bound)",
     rE2.json.matClamps && rE2.json.matClamps.wood === expWoodE,
     `after=${rE2.json.matClamps && rE2.json.matClamps.wood} expected=${expWoodE}`);
  await wait(5200);   // EGG_CLAIM_MIN_MS
  const rEgg2 = await post("/assets/egg/claim", { wallet: E.wallet, mktToken: vE.json.mktToken, kind: "normal" });
  ok("a replayed egg claim is refused (one per kind) — `used` cannot be spun", rEgg2.status === 409,
     `status ${rEgg2.status} bound still=${srv._matSaveBoundForTest(E.wallet, "wood")}`);
  ok("the bound floors at 0, never negative", srv._matSaveBoundForTest(E.wallet, "wood") >= 0 && srv._matSaveBoundForTest(A2.wallet, "wood") >= 0,
     `E.wood=${srv._matSaveBoundForTest(E.wallet, "wood")} A2.wood=${srv._matSaveBoundForTest(A2.wallet, "wood")}`);

  // ---------- 7. THE VERSION FLOOR: stale clients keep observe-only ----------
  console.log("-- 7. only clients >= the version floor receive corrections --");
  const F = mkAuth();
  await save(F, { v: 1, mats: { iron: 20 } });     // baseline is still taken (server-side only)
  const obs0 = srv._matFlipStateForTest().observedOnly;
  const rF1 = await save(F, { v: 1, mats: { iron: 9999 } });
  const stF = srv._matFlipStateForTest();
  ok("a v1 (shipped-today) client is NEVER clamped — observe-only", rF1.status === 200 && !rF1.json.matClamps && !rF1.json.matFlagged,
     `matClamps=${JSON.stringify(rF1.json.matClamps || null)}`);
  ok("...but the exceedance IS counted and flagged for the operator", stF.observedOnly === obs0 + 1,
     `observedOnly ${obs0} -> ${stF.observedOnly}`);
  const rF2 = await save(F, { v: 2, mats: { iron: 9999 } });
  ok("the same save from a v2 client is clamped", rF2.json.matClamps && rF2.json.matClamps.iron === 20 + ALLOW,
     `after=${rF2.json.matClamps && rF2.json.matClamps.iron} expected=${20 + ALLOW}`);
  const rF3 = await save(F, { mats: { iron: 9999 } });   // hostile: version key deleted
  ok("a save with NO version stays observe-only (equivalent to ignoring corrections; the excess is inert)",
     rF3.status === 200 && !rF3.json.matClamps, `matClamps=${JSON.stringify(rF3.json.matClamps || null)}`);

  // ---------- 8. THE KILL-SWITCH ----------
  console.log("-- 8. CHIK_MAT_ENFORCE=0 reverts to observe-only instantly --");
  process.env.CHIK_MAT_ENFORCE = "0";
  const rB2 = await save(B, { v: 2, mats: { iron: 5040 } });
  ok("with the switch off, the same cheating save draws no clamps", rB2.status === 200 && !rB2.json.matClamps,
     `matClamps=${JSON.stringify(rB2.json.matClamps || null)}`);
  process.env.CHIK_MAT_ENFORCE = "1";
  const rB3 = await save(B, { v: 2, mats: { iron: 5040 } });
  ok("switch back on: enforcement resumes with the SAME baseline (nothing was lost)",
     rB3.json.matClamps && rB3.json.matClamps.iron === 40 + 10 + ALLOW,
     `after=${rB3.json.matClamps && rB3.json.matClamps.iron}`);

  // ---------- non-pubkey + restore hygiene ----------
  console.log("-- perimeter: net_ids unchanged; a restored book blob is re-validated --");
  const rN = await post("/profile", { wallet: "net_demoplayer", profile: { mmo: { v: 2, mats: { iron: 9999 } } } });
  ok("a net_id cannot reach /profile at all (unchanged behaviour)", rN.status === 400, `status ${rN.status}`);
  const G = Keypair.generate().publicKey.toBase58();
  srv.restoreOwnBook([[G, { open: {}, cred: { "mat:wood": 100 }, sold: {}, used: {},
                            openSrc: 0, baseSrc: 123,
                            base: { "mat:wood": -500, "mat:iron": 999999, "mat:../evil": 5, "ffish:golden_chikifish": 9 } }]]);
  const gRow = srv._ownFor(G);
  ok("restore keeps a legal NEGATIVE base offset", gRow && gRow.base["mat:wood"] === -500, `base wood=${gRow && gRow.base["mat:wood"]}`);
  ok("restore clamps an absurd base to OWN_OPEN_CAP", gRow && gRow.base["mat:iron"] === OPEN_CAP, `base iron=${gRow && gRow.base["mat:iron"]}`);
  ok("restore drops junk and non-mat base keys", gRow && !("mat:../evil" in gRow.base) && !("ffish:golden_chikifish" in gRow.base),
     `keys=${gRow && Object.keys(gRow.base).join(",")}`);

  const st = srv._matFlipStateForTest();
  console.log(`\nflip state: ${JSON.stringify(st)}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
