#!/usr/bin/env node
// ADVERSARIAL VERIFICATION of Step 7 (the save-path material bound / "the economy flip").
// Boots the REAL server.js in-process. Throwaway keypair, memory store, dummy RPC, unique port.
// NEVER touches the live backend.
//
// Attacks:
//   1 RACE      two/three concurrent save pushes, and spaced pushes, trying to set base twice
//   2 SELFTRADE launder between two wallets I own — is the SELLER debited? is the sum conserved?
//   3 FRESH     a zero-history wallet pushing a huge first save: what does the grandfather BUY?
//   4 REPLAY    replay a spend ack to un-spend (egg barter, sale ack, cancel)
//   5 FLOOD     can an attacker get an HONEST player flagged? can they evict their own flag?
//   6 KILLSW    CHIK_MAT_ENFORCE=0 flipped mid-session, then back
//   7 RESTART   the persisted book round-tripped through restoreOwnBook — is the bound stable?
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59983";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "39502";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;
delete process.env.CHIK_MAT_ENFORCE;

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:39502";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + " — " + e); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
const ALLOW = 1500, OPEN_CAP = 6200;

const srv = await import(new URL("./server.js", import.meta.url).href);
for (let i = 0; i < 100; i++) { try { if ((await get("/market/list")).status === 200) break; } catch (e) {} await wait(100); }
srv._clearOwnBook();

const mkAuth = () => signIn(Keypair.generate());
const rawSave = (a, mmo) => post("/profile", { wallet: a.wallet, authMsg: a.authMsg, authSig: a.authSig, profile: { mmo } });
const save = (a, mmo) => wait(700).then(() => rawSave(a, mmo));
const bound = (w, m) => srv._matSaveBoundForTest(w, m);
const book = (w) => srv._ownFor(w);
const verify = (a, sid) => post("/verify", { ...a, netId: sid });

// ================= 1. RACE THE BASELINE =================
console.log("\n=== 1. race two/three save pushes to poison the baseline twice ===");
const R = mkAuth();
// three pushes fired at once, each claiming a DIFFERENT hoard. Only one may set base.
const raced = await Promise.all([
  rawSave(R, { v: 2, mats: { wood: 50 } }),
  rawSave(R, { v: 2, mats: { wood: 5000 } }),
  rawSave(R, { v: 2, mats: { wood: 999999 } }),
]);
const accepted = raced.filter(r => r.status === 200 && !r.json.throttled).length;
const throttled = raced.filter(r => r.json.throttled).length;
const bR = book(R.wallet);
console.log(`     3 concurrent pushes -> accepted=${accepted} throttled=${throttled}  base=${JSON.stringify(bR && bR.base)}  baseSrc=${bR && bR.baseSrc ? "set" : "unset"}`);
ok("only ONE of three concurrent pushes is accepted (600ms save throttle)", accepted === 1, `accepted=${accepted} throttled=${throttled}`);
ok("exactly one baseline exists for the raced wallet", srv._matFlipStateForTest().baselines === 1, `baselines=${srv._matFlipStateForTest().baselines}`);
const baseAfterRace = (bR && bR.base["mat:wood"]) || 0;
// a SECOND, spaced push with a bigger hoard must not rewrite base
await save(R, { v: 2, mats: { wood: 999999 } });
const bR2 = book(R.wallet);
ok("a later (unthrottled) push cannot rewrite the baseline", (bR2.base["mat:wood"] || 0) === baseAfterRace,
   `base ${baseAfterRace} -> ${bR2.base["mat:wood"]}`);
ok("...and the second inflated push IS clamped", bound(R.wallet, "wood") === baseAfterRace + ALLOW,
   `bound=${bound(R.wallet, "wood")} (base ${baseAfterRace} + allow ${ALLOW})`);
const rr = await save(R, { v: 2, mats: { wood: 999999 } });
ok("...and the clamp is returned to a v>=2 client", !!(rr.json.matClamps && rr.json.matClamps.wood === bound(R.wallet, "wood")),
   `matClamps=${JSON.stringify(rr.json.matClamps)}`);

// ================= 2. SELF-TRADE LAUNDERING =================
console.log("\n=== 2. launder by self-trading between two wallets I own ===");
const S = mkAuth(), B = mkAuth();
await save(S, { v: 2, mats: { wood: 0 } });
await save(B, { v: 2, mats: { wood: 0 } });
srv._grantOwnForTest(S.wallet, "wood", 3000);          // the SAME ownCredit a node claim calls
const sBound0 = bound(S.wallet, "wood"), bBound0 = bound(B.wallet, "wood");
const sum0 = sBound0 + bBound0;
console.log(`     before: seller bound=${sBound0}  buyer bound=${bBound0}  SUM=${sum0}`);
const vS = await verify(S, "net_S"), vB = await verify(B, "net_B");
const lr = await post("/market/op", { sid: "net_S", op: "list", mktToken: vS.json.mktToken, wallet: S.wallet,
  listing: { id: "AVL1", kind: "mat", item: "wood", qty: 200, price: 10, name: "wood" } });
ok("the seller may list only what the book saw them acquire", lr.status === 200, `list status=${lr.status} ${JSON.stringify(lr.json).slice(0, 90)}`);
const over = await post("/market/op", { sid: "net_S", op: "list", mktToken: vS.json.mktToken, wallet: S.wallet,
  listing: { id: "AVL2", kind: "mat", item: "wood", qty: 99999, price: 10, name: "wood" } });
ok("...and a listing beyond the bound is refused", over.status === 409, `status=${over.status} ${String(over.json.error || "").slice(0, 60)}`);
const bought = await post("/market/op", { sid: "net_B", op: "buy", mktToken: vB.json.mktToken, wallet: B.wallet, listing: { id: "AVL1" }, buyerName: "Me" });
ok("the self-trade settles", bought.status === 200, `status=${bought.status}`);
const sBound1 = bound(S.wallet, "wood"), bBound1 = bound(B.wallet, "wood");
console.log(`     after:  seller bound=${sBound1}  buyer bound=${bBound1}  SUM=${sBound1 + bBound1}`);
ok("THE SELLER IS DEBITED: their save bound falls by exactly the sold qty", sBound0 - sBound1 === 200, `${sBound0} -> ${sBound1} (delta ${sBound0 - sBound1})`);
ok("the soft (off-chain) buyer is NOT credited, so the pair's total bound only SHRINKS", (sBound1 + bBound1) < sum0, `sum ${sum0} -> ${sBound1 + bBound1}`);
// the on-chain settle calls exactly ownSold(seller,q) + ownCredit(buyer,q) (server.js:6143-6144).
// Model the credit half with the same exported ownCredit and show the pair is ZERO-SUM, never positive.
srv._grantOwnForTest(B.wallet, "wood", 200);
const sum2 = bound(S.wallet, "wood") + bound(B.wallet, "wood");
ok("with the on-chain credit half applied too, the pair's total is exactly conserved", sum2 === sum0, `sum ${sum0} -> ${sum2}`);
// laundering check: can the pair END with more than the honest total by bouncing goods back and forth?
let sumN = sum2;
for (let i = 0; i < 5; i++) {
  const lrx = await post("/market/op", { sid: "net_S", op: "list", mktToken: vS.json.mktToken, wallet: S.wallet,
    listing: { id: "AVLB" + i, kind: "mat", item: "wood", qty: 100, price: 5, name: "wood" } });
  if (lrx.status !== 200) break;
  await post("/market/op", { sid: "net_B", op: "buy", mktToken: vB.json.mktToken, wallet: B.wallet, listing: { id: "AVLB" + i }, buyerName: "Me" });
  srv._grantOwnForTest(B.wallet, "wood", 100);          // the on-chain credit half
  sumN = bound(S.wallet, "wood") + bound(B.wallet, "wood");
}
ok("5 more round trips never inflate the pair's total bound", sumN <= sum0, `sum ${sum0} -> ${sumN}`);

// ================= 3. FRESH WALLET, HUGE FIRST SAVE =================
console.log("\n=== 3. a fresh wallet with zero history pushing a huge first save ===");
const F = mkAuth();
const f1 = await save(F, { v: 2, mats: { iron: 999999, crystal: 999999 } });
const bF = book(F.wallet);
console.log(`     first save: status=${f1.status} matClamps=${JSON.stringify(f1.json.matClamps || null)} base=${JSON.stringify(bF.base)}`);
ok("the first save IS grandfathered but the baseline is capped at OWN_OPEN_CAP", (bF.base["mat:iron"] || 0) === OPEN_CAP, `base[iron]=${bF.base["mat:iron"]}`);
ok("...so the save bound is OWN_OPEN_CAP + allowance, not 999999", bound(F.wallet, "iron") === OPEN_CAP + ALLOW, `bound=${bound(F.wallet, "iron")}`);
const f2 = await save(F, { v: 2, mats: { iron: 999999, crystal: 999999 } });
ok("the SECOND push is clamped and cannot ratchet", !!(f2.json.matClamps && f2.json.matClamps.iron === OPEN_CAP + ALLOW), `matClamps=${JSON.stringify(f2.json.matClamps)}`);
// WHAT DOES THE GRANDFATHER ACTUALLY BUY? The market bound (ownAvailable) reads open+cred, NOT base.
const availF = srv._ownAvailFor(F.wallet, "mat", "iron");
console.log(`     market-sellable for this fresh wallet: ${availF}  (save bound is ${bound(F.wallet, "iron")})`);
ok("the SAVE grandfather grants NO selling rights — the market bound is the bare allowance", availF === ALLOW, `ownAvailable=${availF}`);
const vF = await verify(F, "net_F");
const fList = await post("/market/op", { sid: "net_F", op: "list", mktToken: vF.json.mktToken, wallet: F.wallet,
  listing: { id: "AVF1", kind: "mat", item: "iron", qty: 3000, price: 10, name: "iron" } });
ok("...proven end-to-end: listing 3000 of the grandfathered iron is refused", fList.status === 409, `status=${fList.status} avail=${fList.json.available}`);
// and the pre-existing one-time OPENING balance (which DOES grant selling rights) is unreachable
ok("the market's own grandfather (openSrc) was NOT taken for a fresh wallet", !bF.openSrc, `openSrc=${bF.openSrc}`);

// ================= 4. REPLAY A SPEND ACK TO UN-SPEND =================
console.log("\n=== 4. replay a spend ack to un-spend ===");
const E = mkAuth();
await save(E, { v: 2, mats: { wood: 0 } });
for (const [m, n] of [["wood", 200], ["berries", 200], ["essence", 200]]) srv._grantOwnForTest(E.wallet, m, n);
const boundW0 = bound(E.wallet, "wood");
const vE = await verify(E, "net_E");
const claim1 = await post("/assets/egg/claim", { wallet: E.wallet, mktToken: vE.json.mktToken, sid: "net_E", kind: "normal" });
const usedAfter = (book(E.wallet).used || {})["mat:wood"] || 0;
ok("the egg barter DEBITS wood (used) exactly once", claim1.status === 200 && usedAfter === 30, `status=${claim1.status} used[wood]=${usedAfter}`);
const boundW1 = bound(E.wallet, "wood");
ok("...and the save bound falls by exactly the recipe cost", boundW0 - boundW1 === 30, `${boundW0} -> ${boundW1}`);
for (let i = 0; i < 4; i++) await post("/assets/egg/claim", { wallet: E.wallet, mktToken: vE.json.mktToken, sid: "net_E", kind: "normal" });
const usedReplay = (book(E.wallet).used || {})["mat:wood"] || 0;
ok("4 replays of the claim neither double-debit nor un-debit", usedReplay === 30 && bound(E.wallet, "wood") === boundW1,
   `used=${usedReplay} bound=${bound(E.wallet, "wood")}`);
// sale acks and cancels are the other "ack" surfaces — replay them at the book
const soldBefore = (book(S.wallet).sold || {})["mat:wood"] || 0;
for (let i = 0; i < 5; i++) {
  await post("/market/op", { sid: "net_S", op: "sales-ack", mktToken: vS.json.mktToken, wallet: S.wallet, ids: ["AVL1"] });
  await post("/market/op", { sid: "net_S", op: "cancel", mktToken: vS.json.mktToken, wallet: S.wallet, listing: { id: "AVL1" } });
}
const soldAfter = (book(S.wallet).sold || {})["mat:wood"] || 0;
ok("replaying sales-ack + cancel on a settled listing never reduces `sold`", soldAfter === soldBefore, `sold ${soldBefore} -> ${soldAfter}`);

// ================= 5. FLAG FLOOD =================
console.log("\n=== 5. flag flood ===");
const HONEST = mkAuth(), ATTACKER = mkAuth();
// (a) can an attacker flag someone else?
const forge1 = await post("/profile", { wallet: HONEST.wallet, authMsg: ATTACKER.authMsg, authSig: ATTACKER.authSig, profile: { mmo: { v: 2, mats: { wood: 999999 } } } });
const forge2 = await post("/profile", { wallet: HONEST.wallet, profile: { mmo: { v: 2, mats: { wood: 999999 } } } });
ok("an attacker cannot push (and so cannot flag) another wallet's save", forge1.status === 401 && forge2.status === 401,
   `signed-by-other=${forge1.status} unsigned=${forge2.status}`);
ok("...and the honest wallet has no book row at all from those attempts", book(HONEST.wallet) === null, `row=${JSON.stringify(book(HONEST.wallet))}`);
// (b) the attacker earns a flag, then floods to evict it from the operator's view
await save(ATTACKER, { v: 2, mats: { wood: 100 } });
await save(ATTACKER, { v: 2, mats: { wood: 99999 } });
const flaggedBefore = srv._matFlipStateForTest().flagged;
ok("the attacker is flagged", flaggedBefore >= 1, `flagged=${flaggedBefore}`);
console.log("     flooding 5400 throwaway wallets with one flagged save each ...");
const t0 = Date.now();
for (let i = 0; i < 5400; i++) {
  const w = mkAuth();
  await rawSave(w, { v: 2, mats: { wood: 999999 } });   // first save = baseline (capped) ... no flag yet
  await rawSave(w, { v: 2, mats: { wood: 999999 } });   // ... second save exceeds -> FLAG (throttled? see below)
}
const st = srv._matFlipStateForTest();
console.log(`     flood took ${((Date.now() - t0) / 1000).toFixed(1)}s -> flagged=${st.flagged} baselines=${st.baselines}`);
const summary = await get(`/assets/summary?key=${process.env.ADMIN_KEY}`);
const worst = (summary.json?.matSaveFlip?.worst) || [];
const attackerStillListed = worst.some(f => f.short === ATTACKER.wallet.slice(0, 8));
console.log(`     _matFlags size=${st.flagged} (cap 5000, sheds 250 oldest)  attacker still in worst[]=${attackerStillListed}`);
ok("the flag map is capped, so a flood evicts the OLDEST flags", st.flagged <= 5000, `flagged=${st.flagged}`);
ok("FLOOD RESULT: the attacker's own (oldest) flag is evicted by the flood", attackerStillListed === false,
   `attacker in worst[]=${attackerStillListed}`);
// no env vars in the admin response
const sJson = JSON.stringify(summary.json || {});
ok("no RPC_URL / TREASURY_SECRET / ADMIN_KEY anywhere in /assets/summary", !/RPC_URL|TREASURY_SECRET|ADMIN_KEY|helius|59983/i.test(sJson), `len=${sJson.length}`);

// ================= 6. KILL SWITCH MID-SESSION =================
console.log("\n=== 6. CHIK_MAT_ENFORCE=0 mid-session ===");
const K = mkAuth();
await save(K, { v: 2, mats: { gold: 100 } });
const kBase = book(K.wallet).base["mat:gold"];
process.env.CHIK_MAT_ENFORCE = "0";
const koff = await save(K, { v: 2, mats: { gold: 999999 } });
ok("with the kill-switch OFF a v2 save gets no clamps", !koff.json.matClamps, `matClamps=${JSON.stringify(koff.json.matClamps || null)}`);
// a wallet that FIRST appears while the switch is off must not silently grandfather
const K2 = mkAuth();
await save(K2, { v: 2, mats: { gold: 999999 } });
ok("...and a brand-new wallet takes NO baseline while off", book(K2.wallet) === null || !book(K2.wallet).baseSrc,
   `row=${book(K2.wallet) ? "baseSrc=" + book(K2.wallet).baseSrc : "none"}`);
process.env.CHIK_MAT_ENFORCE = "1";
const kon = await save(K, { v: 2, mats: { gold: 999999 } });
ok("switching back ON resumes the SAME baseline (no re-grandfather)", book(K.wallet).base["mat:gold"] === kBase, `base ${kBase} -> ${book(K.wallet).base["mat:gold"]}`);
ok("...and the inflated save is clamped again", !!(kon.json.matClamps && kon.json.matClamps.gold === kBase + ALLOW), `matClamps=${JSON.stringify(kon.json.matClamps)}`);
// THE COST, stated: the wallet that first saved during the off window grandfathers when it comes back
await save(K2, { v: 2, mats: { gold: 999999 } });
console.log(`     wallet that first saved during the OFF window now grandfathers at base=${book(K2.wallet).base["mat:gold"]} (cap ${OPEN_CAP})`);
ok("...bounded by OWN_OPEN_CAP, not unbounded", book(K2.wallet).base["mat:gold"] === OPEN_CAP, `base=${book(K2.wallet).base["mat:gold"]}`);

// ================= 7. RESTART: THE PERSISTED BOOK ROUND-TRIP =================
console.log("\n=== 7. an honest veteran's bound across a server restart (serialize -> restoreOwnBook) ===");
// The shape a veteran really has: a big legacy stock AND a long trading history. `sold` is LIFETIME.
const V = mkAuth();
await save(V, { v: 2, mats: { wood: 0 } });
srv._grantOwnForTest(V.wallet, "wood", 4000);
const vV = await verify(V, "net_V");
// sell 3000 wood for real through the market (5 listings, LIST_QTY_MAX-friendly)
let soldQty = 0;
for (let i = 0; i < 6; i++) {
  const l = await post("/market/op", { sid: "net_V", op: "list", mktToken: vV.json.mktToken, wallet: V.wallet,
    listing: { id: "AVV" + i, kind: "mat", item: "wood", qty: 500, price: 5, name: "wood" } });
  if (l.status !== 200) { console.log(`     (listing ${i} refused: ${String(l.json.error || "").slice(0, 70)})`); break; }
  const bgt = await post("/market/op", { sid: "net_VB", op: "buy", listing: { id: "AVV" + i }, buyerName: "X" });
  if (bgt.status === 200) soldQty += 500;
}
srv._grantOwnForTest(V.wallet, "wood", 6200);        // then grinds a fresh legitimate stock
await save(V, { v: 2, mats: { wood: 100 } });        // (baseline was already taken above)
const rowV = book(V.wallet);
const boundLive = bound(V.wallet, "wood");
console.log(`     live book: base=${rowV.base["mat:wood"]} cred=${rowV.cred["mat:wood"]} sold=${rowV.sold["mat:wood"]} used=${rowV.used["mat:wood"] || 0} -> bound=${boundLive}`);
// serializeOwnBook() emits exactly {open,cred,sold,used,openSrc,base,baseSrc} — feed that back in
const blob = [[V.wallet, { open: rowV.open, cred: rowV.cred, sold: rowV.sold, used: rowV.used, openSrc: rowV.openSrc || 0, base: rowV.base, baseSrc: rowV.baseSrc }]];
srv.restoreOwnBook(blob);
const rowV2 = book(V.wallet);
const boundRestored = bound(V.wallet, "wood");
console.log(`     after restore: base=${rowV2.base["mat:wood"]} -> bound=${boundRestored}`);
ok("A RESTART MUST NOT MOVE AN HONEST WALLET'S BOUND", boundRestored === boundLive,
   `bound ${boundLive} -> ${boundRestored} (lost ${boundLive - boundRestored})`);
ok("...and the baseline offset itself survives the round trip", rowV2.base["mat:wood"] === rowV.base["mat:wood"],
   `base ${rowV.base["mat:wood"]} -> ${rowV2.base["mat:wood"]}`);
// a CORRUPT blob must still not smuggle in a bigger grandfather than the honest ceiling
srv.restoreOwnBook([[V.wallet, { open: {}, cred: {}, sold: {}, used: {}, openSrc: 0, base: { "mat:wood": 9e15, "junk:x": 5, "mat:notamat": 7 }, baseSrc: 1 }]]);
const corrupt = book(V.wallet);
console.log(`     corrupt blob restored as base=${JSON.stringify(corrupt.base)} -> bound=${bound(V.wallet, "wood")}`);
ok("a corrupt blob cannot restore a base above the honest ceiling", bound(V.wallet, "wood") <= OPEN_CAP + ALLOW,
   `bound=${bound(V.wallet, "wood")} ceiling=${OPEN_CAP + ALLOW}`);
ok("...and non-material / junk base keys are dropped", !corrupt.base["junk:x"] && !corrupt.base["mat:notamat"], `base=${JSON.stringify(corrupt.base)}`);

// ================= 8. THE VETERAN WITH A PRE-CUTOVER OPENING BALANCE =================
// Case 7 could not move `base` above OWN_OPEN_CAP because a wallet with no opening balance can only
// ever sell cred+allowance, so sold-cred <= 1500. The population that CAN is the one the grandfather
// exists for: a pre-epoch veteran whose one-time opening balance (ownSnapshotOpening -> r.open) gives
// them selling rights the book never credited. `base` is a NET OFFSET and legitimately exceeds
// OWN_OPEN_CAP for them — so what does a restart do to it?
console.log("\n=== 8. a pre-cutover veteran (opening balance) across a restart ===");
const P = mkAuth();
// seed the row the way a real restart does: a veteran whose opening balance was taken pre-epoch.
// This is exactly the shape serializeOwnBook writes for such a wallet.
srv.restoreOwnBook([[P.wallet, { open: { "mat:wood": OPEN_CAP }, cred: {}, sold: {}, used: {},
                                 openSrc: Date.parse("2026-07-20T00:00:00Z"), base: {}, baseSrc: 0 }]]);
ok("the veteran's one-time opening balance restored", (book(P.wallet).open["mat:wood"] || 0) === OPEN_CAP, `open=${book(P.wallet).open["mat:wood"]}`);
const vP = await verify(P, "net_P");
// they sell their whole entitlement over time (open 6200 + allowance 1500 = 7700), refilling the bag
// from unwitnessed sources (chests / tasks / crafting outputs) — none of which credit the book.
let pSold = 0;
for (let i = 0; i < 20; i++) {
  const l = await post("/market/op", { sid: "net_P", op: "list", mktToken: vP.json.mktToken, wallet: P.wallet,
    listing: { id: "AVP" + i, kind: "mat", item: "wood", qty: 385, price: 5, name: "wood" } });
  if (l.status !== 200) break;
  const bg = await post("/market/op", { sid: "net_PB", op: "buy", listing: { id: "AVP" + i }, buyerName: "X" });
  if (bg.status === 200) pSold += 385;
}
console.log(`     lifetime sold=${pSold}  cred=${book(P.wallet).cred["mat:wood"] || 0}  (sold-cred = ${pSold - (book(P.wallet).cred["mat:wood"] || 0)})`);
// NOW the flip's first save lands, and they still hold a full bag
const p1 = await save(P, { v: 2, mats: { wood: OPEN_CAP } });
const rowP = book(P.wallet);
const pLive = bound(P.wallet, "wood");
console.log(`     live book: base=${rowP.base["mat:wood"]} cred=${rowP.cred["mat:wood"] || 0} sold=${rowP.sold["mat:wood"]} -> bound=${pLive}`);
ok("the baseline offset legitimately EXCEEDS OWN_OPEN_CAP for this veteran", (rowP.base["mat:wood"] || 0) > OPEN_CAP,
   `base=${rowP.base["mat:wood"]} cap=${OPEN_CAP}`);
ok("...and while live, their honest 6200 wood is NOT clamped", !p1.json.matClamps && pLive >= OPEN_CAP,
   `matClamps=${JSON.stringify(p1.json.matClamps || null)} bound=${pLive}`);
// the server restarts (Render redeploys daily): serialize -> restore
const blobP = [[P.wallet, { open: rowP.open, cred: rowP.cred, sold: rowP.sold, used: rowP.used, openSrc: rowP.openSrc || 0, base: rowP.base, baseSrc: rowP.baseSrc }]];
srv.restoreOwnBook(blobP);
const pRestored = bound(P.wallet, "wood");
console.log(`     after restart: base=${book(P.wallet).base["mat:wood"]} -> bound=${pRestored}  (LOST ${pLive - pRestored})`);
ok("A RESTART MUST NOT MOVE THE VETERAN'S BOUND", pRestored === pLive, `bound ${pLive} -> ${pRestored} (lost ${pLive - pRestored})`);
const p2 = await save(P, { v: 2, mats: { wood: OPEN_CAP } });
ok("...and the same honest save is still accepted uncorrected after the restart", !p2.json.matClamps,
   `matClamps=${JSON.stringify(p2.json.matClamps || null)} (would destroy ${OPEN_CAP - pRestored} wood)`);
// the anti-corruption property the clamp was there for must still hold
srv.restoreOwnBook([[P.wallet, { open: {}, cred: {}, sold: {}, used: {}, openSrc: 0, base: { "mat:wood": 9e15 }, baseSrc: 1 }]]);
ok("a corrupt blob with NO sinks still cannot exceed the honest ceiling", bound(P.wallet, "wood") <= OPEN_CAP + ALLOW,
   `bound=${bound(P.wallet, "wood")} ceiling=${OPEN_CAP + ALLOW}`);
srv.restoreOwnBook([[P.wallet, { open: {}, cred: {}, sold: { "mat:wood": 1000 }, used: { "mat:wood": 500 }, openSrc: 0, base: { "mat:wood": 9e15 }, baseSrc: 1 }]]);
ok("...and a corrupt blob that also forges sinks cannot use them to raise the ceiling",
   bound(P.wallet, "wood") <= OPEN_CAP + ALLOW, `bound=${bound(P.wallet, "wood")} ceiling=${OPEN_CAP + ALLOW}`);

console.log("");
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
console.log(`FLIP_ATTACK_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
