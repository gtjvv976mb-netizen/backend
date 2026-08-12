// _nft_sweep_sim.mjs — PROOF of the two 2026-08-12 `row.mintPending` fixes.
//
//   FIX A  eggNftHatchBlock (server.js:8883) is TIME-BOUNDED: the hatch/discard/consume freeze
//          applies only while `Date.now() - row.mintPending.at < NFT_PENDING_TTL_MS`. Before it,
//          one tap of Cancel in Phantom bricked the egg forever (the reservation is persisted
//          BEFORE the player signs).
//   FIX B  the RESERVED-BUT-UNCONFIRMED SWEEP at the tail of reconcileNftOwners (server.js:8186):
//          for rows with mintPending and no mint, older than NFT_SWEEP_GRACE_MS — read DAS for the
//          reserved address; commit if it landed, abandon ONLY on a positive `absent` past the TTL.
//
// Isolation contract (asserted, not assumed):
//   * throwaway nacl keypair -> TREASURY_SECRET; a second one -> NFT_MINT_DELEGATE_SECRET
//   * RPC_URL is a DEAD 127.0.0.1 port carrying a canary string — DAS is stubbed, nothing dials out
//   * Magic Eden: no ME_API_KEY and CHIK_EGG_MEGUARD=0, so meBookGuardOn() is false (asserted) and
//     no outbound Magic Eden read exists on any path this sim walks
//   * VERIFY_HOLDERS=false, NETWORK=devnet (a label), unique PORT, NO DATABASE_URL (memory store)
//   * the chain create seam and BOTH compose seams are stubbed and COUNTED
//   * the live backend is never contacted, by any method.
// Every assertion prints the ACTUAL measured value.
//
// Runs twice: the main pass, then a CHILD process of this same file with NFT_MINT_PAUSED=1, which
// re-proves the sweep while minting is paused (the owner has it paused on live right now).
import nacl from "tweetnacl"; import bs58 from "bs58";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROLE = String(process.env.SWEEP_ROLE || "main");
const PAUSED = ROLE === "paused";
const PORT = PAUSED ? "39928" : "39927";

const _t = nacl.sign.keyPair();                                   // THROWAWAY — never a real key
const _dele = nacl.sign.keyPair();                                // THROWAWAY mint delegate
const POOL = bs58.encode(nacl.sign.keyPair().publicKey);
const COLLECTION = "2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN";  // the live Core collection — NEVER contacted
const CANARY = "CANARY-SWEEP-RPC-NEVER-CALLED";
process.env.RPC_URL = `http://127.0.0.1:59993/${CANARY}`;
delete process.env.CLIENT_RPC;
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.ADMIN_KEY = "sweep-admin-key";
process.env.TEAM_WALLET = POOL;
process.env.CHIK_NFT_MINT = "1";
process.env.NFT_MINT_PAUSED = PAUSED ? "1" : "0";
process.env.NFT_COLLECTION = COLLECTION;
process.env.NFT_MINT_DELEGATE_SECRET = JSON.stringify(Array.from(_dele.secretKey));
process.env.NFT_META_BASE = `http://127.0.0.1:${PORT}`;
process.env.CHIK_MINT_AT_SALE = "1";       // FIX A's branch exists only under this flag
process.env.CHIK_ME_MARKET = "1";          // EGG_NFT_ON = ME_MARKET_ON && NFT_HANDOVER_ON
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_EGG_MEGUARD = "0";        // book guard OFF -> no outbound Magic Eden read, ever
delete process.env.ME_API_KEY;
// The task asked for a 2 s TTL / 1 s grace so the sim need not sleep. The server FLOORS both
// (Math.max) — this sim MEASURES what it actually gets rather than trusting the env.
process.env.NFT_PENDING_TTL_MS = "2000";
process.env.NFT_SWEEP_GRACE_MS = "1000";
delete process.env.DATABASE_URL;

const B = `http://127.0.0.1:${PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j, text: t }; };
const get = async (p) => { const r = await fetch(B + p); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j, text: t }; };

// Defaults to the REAL server.js. SWEEP_TARGET exists so the same file can be pointed at a
// two-hunks-reverted snapshot to prove this sim goes RED without the fixes (red-team control).
const TARGET = process.env.SWEEP_TARGET || "./server.js";
const SRV = await import(TARGET);
await new Promise((r) => setTimeout(r, 1500));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const short = (s) => String(s || "").slice(0, 10);

let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "sw" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}

// ---- the stubbed chain -------------------------------------------------------------------------
// THREE reader answers, and the difference between the last two is the whole safety case:
//   dasMap hit        -> the asset EXISTS (Core, in our collection, owned by someone)
//   dasDown.has(addr) -> the reader is DOWN: {dasFailed:true} with NO `absent`
//   neither           -> the reader ANSWERED "no such account": {dasFailed:true, absent:true}
const dasMap = new Map();
const dasDown = new Set();
const dasReads = new Map();                       // addr -> how many times anything read it
let dasTotal = 0;
const readsOf = (a) => dasReads.get(String(a)) || 0;
SRV._setNftDasStubForTest((mint) => {
  const a = String(mint);
  dasReads.set(a, (dasReads.get(a) || 0) + 1); dasTotal++;
  if (dasDown.has(a)) return { dasFailed: true };
  const v = dasMap.get(a);
  return v || { dasFailed: true, absent: true };
});
const coreObs = (owner, collection) => ({ owner, burned: false, iface: "MplCoreAsset", collection: collection || COLLECTION });

let coreCreates = 0, composeMintOnly = 0, composeMintList = 0;
SRV._setNftCoreStubForTest(async (args) => { coreCreates++; return { address: args.assetAddr, signature: "sig" + coreCreates }; });
SRV._setMasComposeStubForTest(async () => { composeMintList++; return { ok: true, b64: "TXBYTES", ver: 0, bytes: 7 }; });
SRV._setMasMintComposeStubForTest(async () => { composeMintOnly++; return { ok: true, b64: "TXBYTES", ver: 0, bytes: 7 }; });

const reconcile = () => SRV._nftReconcileForTest();
const row_ = (id) => SRV._assetRowForTest(id);
const chainOf = (id) => (row_(id)?.chain || []).map((c) => c.what);
const countEv = (id, what) => (row_(id)?.chain || []).filter((c) => c.what === what).length;
const newAddr = () => bs58.encode(nacl.sign.keyPair().publicKey);

// A reservation made THE WAY PRODUCTION MAKES ONE: the real POST /assets/nft/mint player-paid path,
// which persists row.mintPending BEFORE handing the player a transaction to sign in Phantom. The
// player then does nothing (presses Cancel) — exactly the live failure both fixes are about.
async function reserveVia(w, id) {
  return await post("/assets/nft/mint", { wallet: w.wallet, mktToken: w.mktToken, id });
}
async function newReservedCreature(w, ageMs, sp) {
  const born = SRV._mintHatchedForTest("chikimon", w.wallet, { sp: sp || "drolax", kind: "normal", lvl: 1 });
  const r = await reserveVia(w, born.id);
  if (r.status !== 200 || !r.body.tokenMint) throw new Error(`reserve failed ${r.status} ${r.text}`);
  if (ageMs) SRV._nftAgePendingForTest(born.id, ageMs);
  return { id: born.id, addr: String(r.body.tokenMint), edition: r.body.edition, owner: w.wallet };
}

console.log(`\n=== _nft_sweep_sim (${ROLE}) port ${PORT} target ${TARGET} ===`);

// ================================================================================================
sec("0. ISOLATION — what this process is actually talking to");
{
  const h = await get("/health");
  const me = SRV._meFlagsForTest();
  const mas = SRV._masFlagsForTest();
  console.log(`  store=${h.body.store} RPC_URL=${process.env.RPC_URL} collection=${short(SRV._nftCollectionForTest())} nftOn=${SRV._nftMintOn()} mintAtSale=${mas.on} NFT_MINT_PAUSED=${process.env.NFT_MINT_PAUSED} meBookGuard=${me.bookGuard} meKey=${me.keyPresent}`);
  chk(h.body.store === "memory", `memory store, no database (actual "${h.body.store}")`);
  chk(SRV._nftMintOn() === true, `CHIK_NFT_MINT on (actual ${SRV._nftMintOn()})`);
  chk(mas.on === true, `CHIK_MINT_AT_SALE on — FIX A's branch exists (actual ${mas.on})`);
  chk(SRV._nftCollectionForTest() === COLLECTION, `collection configured (actual ${short(SRV._nftCollectionForTest())})`);
  chk(me.bookGuard === false && me.keyPresent === false, `Magic Eden book guard OFF and no key — zero outbound ME reads (bookGuard=${me.bookGuard}, keyPresent=${me.keyPresent})`);
}

// ================================================================================================
// THE PAUSED CHILD runs only this section, then reports its tally to the parent and exits.
if (PAUSED) {
  const OLD_P = 900000;                                    // 15 min — past any plausible TTL
  sec("P. THE SWEEP UNDER NFT_MINT_PAUSED=1 (recovery must work during the pause)");
  SRV._clearAssetReg();
  const A = await mkWallet();
  // ---- (P1) A NEW mint is refused while paused ---------------------------------------------------
  // The gate was `NFT_MINT_PAUSED && !row.edition`, and under CHIK_MINT_AT_SALE every row is stamped
  // with an edition at issuance — so it never fired and the pause was porous. It is now
  // `NFT_MINT_PAUSED && !row.mintPending` (server.js:10398).
  const born = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "drolax", kind: "normal", lvl: 1 });
  const edAtBirth = row_(born.id).edition;
  const prep = await post("/assets/nft/prepare", { wallet: A.wallet, mktToken: A.mktToken, id: born.id });
  const rr = await reserveVia(A, born.id);
  console.log(`  PAUSED: row.edition at birth=${edAtBirth} mintPending=${JSON.stringify(row_(born.id).mintPending || null)}; /assets/nft/prepare -> ${prep.status} "${prep.body.error || ""}"; /assets/nft/mint -> ${rr.status} "${rr.body.error || ""}"${rr.body.tokenMint ? " reserved " + short(rr.body.tokenMint) : ""}`);
  chk(prep.status === 503 && /paused/.test(String(prep.body.error || "")),
      `PAUSED CONTROL: /assets/nft/prepare answers ${prep.status} "${prep.body.error}"`);
  chk(rr.status === 503 && /paused/.test(String(rr.body.error || "")),
      `PAUSED: a NEW mint (no reservation) is REFUSED even though the row carries edition ${edAtBirth} — status ${rr.status} "${rr.body.error}"`);
  chk(!row_(born.id).mintPending && composeMintOnly === 0,
      `PAUSED: and nothing was reserved or composed for it (mintPending=${JSON.stringify(row_(born.id).mintPending || null)}, composes ${composeMintOnly})`);

  // ---- (P2) a row ALREADY mid-signature must still be able to finish ------------------------------
  // That grace is the whole reason the condition is `!row.mintPending`: a player who was already in
  // Phantom when the operator paused must not be stranded.
  const mid = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "owzard", kind: "normal", lvl: 1 });
  const midAddr = newAddr();
  row_(mid.id).mintPending = { addr: midAddr, at: Date.now() - 5000 };   // reserved BEFORE the pause
  dasMap.set(midAddr, coreObs(A.wallet));                                 // ...and their tx landed
  const midR = await reserveVia(A, mid.id);
  console.log(`  PAUSED: mid-signature row -> ${midR.status} already=${midR.body.already} mint=${short(midR.body.mint)} edition=${midR.body.edition}`);
  chk(midR.status === 200 && midR.body.mint === midAddr,
      `PAUSED: a row that ALREADY holds a reservation can still complete under the pause (status ${midR.status}, mint=${short(midR.body.mint)} == reserved ${short(midAddr)})`);
  chk(row_(mid.id).mint === midAddr && countEv(mid.id, "minted_onchain") === 1,
      `PAUSED: and it is recorded once (row.mint=${short(row_(mid.id).mint)}, minted_onchain=${countEv(mid.id, "minted_onchain")})`);
  // ...and the residual worth knowing: a reservation that has AGED OUT is abandoned and RE-reserved
  // inside the same paused request, because the pause gate is read before that branch runs.
  const stale = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "mushrow", kind: "normal", lvl: 1 });
  const staleAddr2 = newAddr();
  row_(stale.id).mintPending = { addr: staleAddr2, at: Date.now() - OLD_P };  // absent + past the TTL
  const staleR = await reserveVia(A, stale.id);
  const reReserved = row_(stale.id).mintPending && row_(stale.id).mintPending.addr !== staleAddr2;
  console.log(`  PAUSED: aged-out reservation -> ${staleR.status} ${staleR.body.tokenMint ? "NEW addr " + short(staleR.body.tokenMint) : JSON.stringify(staleR.body.error || staleR.body)}; re-reserved=${!!reReserved}`);
  chk(!!reReserved && staleR.status === 200,
      `PAUSED, RESIDUAL (measured, not a regression): an aged-out reservation is abandoned and a NEW address composed inside the same paused request (status ${staleR.status}, old ${short(staleAddr2)} -> new ${short(row_(stale.id).mintPending?.addr)}) — the pause gate is read before the abandon branch`);

  // ---- (P3) the sweep itself: COMMIT while paused -------------------------------------------------
  const landedAddr = newAddr();
  row_(born.id).mintPending = { addr: landedAddr, at: Date.now() - OLD_P };   // a pre-pause reservation
  dasMap.set(landedAddr, coreObs(A.wallet));
  await reconcile();
  console.log(`  PAUSED: landed reservation -> mint=${short(row_(born.id).mint)} mintPending=${JSON.stringify(row_(born.id).mintPending || null)}`);
  chk(row_(born.id).mint === landedAddr, `PAUSED: the sweep still COMMITS a landed mint (row.mint=${short(row_(born.id).mint)} == reserved ${short(landedAddr)})`);
  chk(countEv(born.id, "minted_onchain") === 1, `PAUSED: exactly one minted_onchain event (actual ${countEv(born.id, "minted_onchain")})`);
  // (2) ABANDON while paused
  const b2 = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "electrox", kind: "normal", lvl: 1 });
  const deadAddr = newAddr();
  row_(b2.id).mintPending = { addr: deadAddr, at: Date.now() - OLD_P };
  await reconcile();
  console.log(`  PAUSED: dead reservation -> mintPending=${JSON.stringify(row_(b2.id).mintPending || null)} chain=${JSON.stringify(chainOf(b2.id))}`);
  chk(!row_(b2.id).mintPending && countEv(b2.id, "mint_abandoned") === 1,
      `PAUSED: the sweep still ABANDONS a dead reservation (mintPending=${JSON.stringify(row_(b2.id).mintPending || null)}, mint_abandoned=${countEv(b2.id, "mint_abandoned")})`);
  // (3) an OUTAGE is still held
  const b3 = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "firix", kind: "normal", lvl: 1 });
  const downAddr = newAddr();
  row_(b3.id).mintPending = { addr: downAddr, at: Date.now() - OLD_P * 4 };
  dasDown.add(downAddr);
  await reconcile();
  chk(!!row_(b3.id).mintPending && countEv(b3.id, "mint_abandoned") === 0,
      `PAUSED: an outage is still HELD, not abandoned (mintPending=${JSON.stringify(row_(b3.id).mintPending || null)}, mint_abandoned=${countEv(b3.id, "mint_abandoned")})`);
  chk(coreCreates === 0, `PAUSED: still zero chain creates (actual ${coreCreates})`);
  console.log(`PAUSED_TALLY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

// ================================================================================================
// The whole sim keys off these two numbers, so it MEASURES them instead of restating the env.
let TTL = 0, GRACE = 0;
sec("1. THE TWO CONSTANTS, MEASURED (the env asked for TTL=2000 grace=1000)");
{
  const A = await mkWallet();
  // GRACE: with the reader DOWN nothing can change, so the only observable is whether the sweep
  // READ the reserved address at all. Binary-search the age at which the first read appears.
  let lo = 0, hi = 200000;
  while (hi - lo > 1000) {
    const mid = Math.round((lo + hi) / 2);
    const r = await newReservedCreature(A, mid);
    dasDown.add(r.addr);
    await reconcile();
    if (readsOf(r.addr) > 0) hi = mid; else lo = mid;
  }
  GRACE = hi;
  // TTL: the reader ANSWERS "absent" (the only state that may abandon). Binary-search the age at
  // which the reservation is actually cleared.
  let lo2 = GRACE, hi2 = 900000;
  while (hi2 - lo2 > 1000) {
    const mid = Math.round((lo2 + hi2) / 2);
    const r = await newReservedCreature(A, mid);
    await reconcile();
    if (!row_(r.id).mintPending) hi2 = mid; else lo2 = mid;
  }
  TTL = hi2;
  console.log(`  measured NFT_SWEEP_GRACE_MS = ${GRACE} ms   (env asked ${process.env.NFT_SWEEP_GRACE_MS})`);
  console.log(`  measured NFT_PENDING_TTL_MS = ${TTL} ms      (env asked ${process.env.NFT_PENDING_TTL_MS})`);
  chk(GRACE >= 29000 && GRACE <= 31000, `the sweep grace is a FLOOR the env cannot lower: measured ${GRACE} ms after asking for ${process.env.NFT_SWEEP_GRACE_MS} ms`);
  chk(TTL >= 59000 && TTL <= 61000, `the pending TTL is a FLOOR the env cannot lower: measured ${TTL} ms after asking for ${process.env.NFT_PENDING_TTL_MS} ms`);
  chk(TTL > GRACE, `TTL (${TTL} ms) is longer than the grace (${GRACE} ms) — a row is always read before it can be abandoned`);
}
const OLD = TTL + 15000;              // comfortably past the TTL
const YOUNG = Math.round(GRACE / 3);  // comfortably inside the grace

// ================================================================================================
sec("2. FIX A — the egg a player CANCELLED in Phantom (hatch / discard / consume)");
SRV._clearAssetReg();
{
  const H = await mkWallet(), D = await mkWallet(), C = await mkWallet();
  // D must own every steed, or discard is refused for its own honest reason ("that egg can still hatch")
  for (const sp of ["chicken", "boar", "gator", "horse", "wolf", "griffin"])
    SRV._mintAssetForTest("mount", D.wallet, { sp, kind: "mount" }, "issued");

  const eH = SRV._mintAssetForTest("egg", H.wallet, { kind: "normal", sp: "normal" }, "issued");
  const eD = SRV._mintAssetForTest("egg", D.wallet, { kind: "mount", sp: "mount" }, "issued");
  const eC = SRV._mintAssetForTest("egg", C.wallet, { kind: "normal", sp: "normal" }, "issued");
  SRV._ageAsset(eH.id, 4 * 3600e3); SRV._ageAsset(eD.id, 7 * 3600e3); SRV._ageAsset(eC.id, 4 * 3600e3);

  const rH = await reserveVia(H, eH.id), rD = await reserveVia(D, eD.id), rC = await reserveVia(C, eC.id);
  console.log(`  reservations via the REAL POST /assets/nft/mint: hatch-egg ${rH.status} mintPending=${rH.body.mintPending} addr=${short(rH.body.tokenMint)} | discard-egg ${rD.status} addr=${short(rD.body.tokenMint)} | consume-egg ${rC.status} addr=${short(rC.body.tokenMint)}`);
  chk(rH.status === 200 && rH.body.mintPending === true && !!row_(eH.id).mintPending,
      `the compose route persisted a reservation BEFORE the player signs (status ${rH.status}, row.mintPending.at=${row_(eH.id).mintPending?.at})`);
  chk(!row_(eH.id).mint, `and NOTHING is minted yet (row.mint=${JSON.stringify(row_(eH.id).mint || null)})`);

  // ---- FRESH reservation: all three MUST still be refused ---------------------------------------
  const f1 = await post("/assets/egg/hatch", { wallet: H.wallet, mktToken: H.mktToken, id: eH.id });
  const f2 = await post("/assets/egg/discard", { wallet: H.wallet, mktToken: H.mktToken, id: eH.id });
  const f3 = await post("/assets/egg/consume", { wallet: H.wallet, mktToken: H.mktToken, id: eH.id, sp: "drolax" });
  const ageNow = Date.now() - row_(eH.id).mintPending.at;
  console.log(`  FRESH (age ${ageNow} ms < TTL ${TTL}): hatch ${f1.status} nftBusy=${f1.body.nftBusy} | discard ${f2.status} nftBusy=${f2.body.nftBusy} | consume ${f3.status} nftBusy=${f3.body.nftBusy}`);
  console.log(`  refusal text: "${f1.body.error}"`);
  chk(f1.status === 409 && f1.body.nftBusy === true, `a FRESH reservation still freezes hatch (status ${f1.status}, nftBusy=${f1.body.nftBusy})`);
  chk(f2.status === 409 && f2.body.nftBusy === true, `...and discard (status ${f2.status}, nftBusy=${f2.body.nftBusy})`);
  chk(f3.status === 409 && f3.body.nftBusy === true, `...and consume (status ${f3.status}, nftBusy=${f3.body.nftBusy})`);
  chk(row_(eH.id).state === "active", `a refusal never spends the egg (state=${row_(eH.id).state})`);

  // ---- the SAME rows, aged past the TTL: all three go through ------------------------------------
  SRV._nftAgePendingForTest(eH.id, OLD); SRV._nftAgePendingForTest(eD.id, OLD); SRV._nftAgePendingForTest(eC.id, OLD);
  const aged = Date.now() - row_(eH.id).mintPending.at;
  const h = await post("/assets/egg/hatch", { wallet: H.wallet, mktToken: H.mktToken, id: eH.id });
  const d = await post("/assets/egg/discard", { wallet: D.wallet, mktToken: D.mktToken, id: eD.id });
  const c = await post("/assets/egg/consume", { wallet: C.wallet, mktToken: C.mktToken, id: eC.id, sp: "drolax" });
  console.log(`  AGED (age ${aged} ms > TTL ${TTL}): hatch ${h.status} -> ${h.body.hatched?.sp || h.body.error} | discard ${d.status} -> ${d.body.discarded ? "discarded " + short(d.body.discarded) : d.body.error} | consume ${c.status} -> ${c.body.hatched?.sp || c.body.error}`);
  chk(h.status === 200 && !!h.body.hatched, `the cancelled-Phantom egg HATCHES again (status ${h.status}, sp=${h.body.hatched?.sp})`);
  chk(d.status === 200 && d.body.discarded === eD.id, `...and DISCARDS again (status ${d.status}, discarded=${short(d.body.discarded)})`);
  chk(c.status === 200 && !!c.body.hatched, `...and CONSUMES again (status ${c.status}, sp=${c.body.hatched?.sp})`);
  chk(row_(eH.id).state === "consumed" && row_(eD.id).state === "consumed" && row_(eC.id).state === "consumed",
      `all three eggs are spent (states ${row_(eH.id).state}/${row_(eD.id).state}/${row_(eC.id).state})`);
  chk(coreCreates === 0, `and none of it submitted anything to the chain (creates ${coreCreates})`);
}

// ================================================================================================
sec("2b. FIX A DID NOT LOOSEN THE OTHER TWO FREEZES — they still bind at ANY age");
{
  const M = await mkWallet();
  const mk = (flag) => {
    const e = SRV._mintAssetForTest("egg", M.wallet, { kind: "normal", sp: "normal" }, "issued");
    SRV._ageAsset(e.id, 4 * 3600e3);
    const r = row_(e.id);
    r.mint = newAddr();                                   // a MINTED egg — the branch FIX A guards is `!row.mint`
    r.mintPending = { addr: newAddr(), at: Date.now() - OLD * 10 };   // ...and an ancient reservation on top
    Object.assign(r, flag);
    return e.id;
  };
  const listed = mk({ listedOffchain: true });
  const settling = mk({ pendingHandover: { to: newAddr(), at: Date.now() } });
  const a = await post("/assets/egg/hatch", { wallet: M.wallet, mktToken: M.mktToken, id: listed });
  const b = await post("/assets/egg/hatch", { wallet: M.wallet, mktToken: M.mktToken, id: settling });
  console.log(`  minted+listed egg (reservation ${OLD * 10} ms old): ${a.status} nftListed=${a.body.nftListed} "${a.body.error}"`);
  console.log(`  minted+settling egg (reservation ${OLD * 10} ms old): ${b.status} nftBusy=${b.body.nftBusy} "${b.body.error}"`);
  chk(a.status === 409 && a.body.nftListed === true, `a LISTED minted egg is still refused however old the reservation is (status ${a.status}, nftListed=${a.body.nftListed})`);
  chk(b.status === 409 && b.body.nftBusy === true, `a SETTLING minted egg is still refused however old the reservation is (status ${b.status}, nftBusy=${b.body.nftBusy})`);
  chk(row_(listed).state === "active" && row_(settling).state === "active", `neither egg was spent (states ${row_(listed).state}/${row_(settling).state})`);
}

// ================================================================================================
sec("3. FIX B — the sweep COMMITS a mint that landed");
SRV._clearAssetReg();
let committed = null;
{
  const A = await mkWallet();
  const r = await newReservedCreature(A, OLD);
  const edBefore = row_(r.id).edition;
  const edStateBefore = JSON.stringify(SRV._nftEditionState());
  dasMap.set(r.addr, coreObs(A.wallet));            // the transaction the player signed DID land
  const readsBefore = readsOf(r.addr);
  await reconcile();
  const row = row_(r.id);
  console.log(`  reserved addr=${short(r.addr)} ed=${edBefore} -> after one reconcile: mint=${short(row.mint)} ed=${row.edition} mintPending=${JSON.stringify(row.mintPending || null)} chain=${JSON.stringify(chainOf(r.id))}`);
  chk(row.mint === r.addr, `row.mint is the RESERVED address, not a new one (${short(row.mint)} == ${short(r.addr)})`);
  chk(!row.mintPending, `the reservation is cleared (mintPending=${JSON.stringify(row.mintPending || null)})`);
  chk(row.edition === edBefore, `the edition is UNCHANGED — no second number burned (reserved ${edBefore}, now ${row.edition})`);
  chk(JSON.stringify(SRV._nftEditionState()) === edStateBefore, `the edition counter did not advance (${JSON.stringify(SRV._nftEditionState())})`);
  chk(countEv(r.id, "minted_onchain") === 1, `exactly one minted_onchain provenance event (actual ${countEv(r.id, "minted_onchain")})`);
  chk(readsOf(r.addr) - readsBefore === 1, `it cost exactly ONE DAS read (actual ${readsOf(r.addr) - readsBefore})`);
  chk(coreCreates === 0, `the sweep submitted NOTHING to the chain (creates ${coreCreates})`);
  committed = r;
}

// ================================================================================================
sec("4. FIX B — the sweep ABANDONS a genuinely dead reservation");
{
  const A = await mkWallet();
  const r = await newReservedCreature(A, OLD);       // DAS answers absent (not in dasMap, not down)
  const edBefore = row_(r.id).edition;
  await reconcile();
  const row = row_(r.id);
  const ev = (row.chain || []).filter((c) => c.what === "mint_abandoned");
  console.log(`  addr=${short(r.addr)} age=${OLD}ms absent=true -> mintPending=${JSON.stringify(row.mintPending || null)} mint=${JSON.stringify(row.mint || null)} chain=${JSON.stringify(chainOf(r.id))}`);
  console.log(`  abandon event: ${JSON.stringify(ev[0] || null)}`);
  chk(!row.mintPending, `mintPending is cleared (actual ${JSON.stringify(row.mintPending || null)})`);
  chk(!row.mint, `row.mint is still empty — nothing was certified (actual ${JSON.stringify(row.mint || null)})`);
  chk(ev.length === 1 && ev[0].addr === r.addr, `one mint_abandoned event naming the dead address (n=${ev.length}, addr=${short(ev[0]?.addr)})`);
  chk(ev[0] && ev[0].via === "sweep", `it is labelled as the SWEEP's doing (via="${ev[0]?.via}")`);
  chk(row.edition === edBefore, `the reserved edition is kept for the retry — no hole in the series (edition ${row.edition})`);
  const before = JSON.stringify(row_(r.id));
  await reconcile();
  chk(JSON.stringify(row_(r.id)) === before, `a second pass changes nothing (mint_abandoned events still ${countEv(r.id, "mint_abandoned")})`);
}

// ================================================================================================
sec("5. THE SAFETY CASE — a DAS OUTAGE MUST NOT ABANDON (that is how one creature gets two certificates)");
{
  const A = await mkWallet();
  const r = await newReservedCreature(A, TTL * 8);   // FAR older than the TTL
  dasDown.add(r.addr);                                // reader down: dasFailed WITHOUT absent
  const vf = SRV._nftVerifyOnchainForTest({ dasFailed: true }, A.wallet);
  const beforeJson = JSON.stringify(row_(r.id).mintPending);
  const createsBefore = coreCreates;
  await reconcile(); await reconcile(); await reconcile();
  const row = row_(r.id);
  const age = Date.now() - row.mintPending?.at;
  console.log(`  outage obs={dasFailed:true} -> verify.ok=${vf.ok} status=${vf.status}; after 3 passes at age ${age} ms (TTL ${TTL}): mintPending=${JSON.stringify(row.mintPending || null)}`);
  chk(!!row.mintPending, `the reservation SURVIVES an outage past the TTL (mintPending.addr=${short(row.mintPending?.addr)}, age ${age} ms)`);
  chk(JSON.stringify(row.mintPending) === beforeJson, `and is byte-identical — the address was not re-rolled (${JSON.stringify(row.mintPending)} vs ${beforeJson})`);
  chk(!row.mint, `nothing was committed on an unreadable answer (row.mint=${JSON.stringify(row.mint || null)})`);
  chk(countEv(r.id, "mint_abandoned") === 0, `NO mint_abandoned event (actual ${countEv(r.id, "mint_abandoned")})`);
  chk(coreCreates === createsBefore, `no create reached the chain stub during the outage (${coreCreates - createsBefore} this section, ${coreCreates} total)`);
  chk(readsOf(r.addr) >= 3, `it WAS asked on every pass — held, not ignored (reads on that address ${readsOf(r.addr)})`);
  // ...and when the reader comes back and says "absent", it finally abandons — the outage only DELAYED it
  dasDown.delete(r.addr);
  await reconcile();
  chk(!row_(r.id).mintPending && countEv(r.id, "mint_abandoned") === 1,
      `when the reader RECOVERS and answers absent it abandons then (mintPending=${JSON.stringify(row_(r.id).mintPending || null)}, events ${countEv(r.id, "mint_abandoned")})`);
}

// ================================================================================================
sec("6. THE GRACE WINDOW — a young reservation is not even READ");
{
  const A = await mkWallet();
  const young = await newReservedCreature(A, YOUNG);
  const old = await newReservedCreature(A, OLD);
  dasDown.add(old.addr);                              // hold it, so this section changes nothing else
  const t0 = dasTotal;
  await reconcile();
  console.log(`  young age ${YOUNG} ms (< grace ${GRACE}) reads=${readsOf(young.addr)} | old age ${OLD} ms reads=${readsOf(old.addr)} | total DAS reads this pass ${dasTotal - t0}`);
  chk(readsOf(young.addr) === 0, `the young reservation cost ZERO DAS reads (actual ${readsOf(young.addr)})`);
  chk(readsOf(old.addr) >= 1, `the old one in the same pass WAS read (actual ${readsOf(old.addr)}) — so the 0 above is the grace, not a dead sweep`);
  chk(!!row_(young.id).mintPending, `and the young row is untouched (mintPending.addr=${short(row_(young.id).mintPending?.addr)})`);
  SRV._nftAgePendingForTest(young.id, GRACE + 2000);
  dasDown.add(young.addr);
  await reconcile();
  chk(readsOf(young.addr) === 1, `once past the grace the SAME row is read exactly once per pass (actual ${readsOf(young.addr)})`);
}

// ================================================================================================
sec("7. IDEMPOTENCY — reconcile twice more over the committed row");
{
  const id = committed.id;
  const before = { mint: row_(id).mint, ed: row_(id).edition, n: countEv(id, "minted_onchain") };
  await reconcile(); await reconcile();
  const after = { mint: row_(id).mint, ed: row_(id).edition, n: countEv(id, "minted_onchain") };
  console.log(`  before ${JSON.stringify({ mint: short(before.mint), ed: before.ed, mintedEvents: before.n })} -> after two more passes ${JSON.stringify({ mint: short(after.mint), ed: after.ed, mintedEvents: after.n })}`);
  chk(after.n === 1, `exactly ONE minted_onchain event after three total passes (actual ${after.n})`);
  chk(after.mint === before.mint, `one address, unchanged (${short(after.mint)})`);
  chk(after.ed === before.ed, `one edition, unchanged (${after.ed})`);
  chk(!row_(id).mintPending, `no reservation reappeared (mintPending=${JSON.stringify(row_(id).mintPending || null)})`);
}

// ================================================================================================
sec("8. REGRESSION — the sweep skips rows that already have a mint, and no-ops on an empty registry");
{
  const A = await mkWallet();
  // A row carrying BOTH a mint and a stale reservation: the pre-existing loop owns it, the sweep must not.
  const r = await newReservedCreature(A, OLD);
  const staleAddr = r.addr;
  const realMint = newAddr();
  row_(r.id).mint = realMint;                          // as if the old path had recorded it
  dasMap.set(realMint, coreObs(A.wallet));
  // CONTROL, so "0 reads" below means SKIPPED and not "the sweep did nothing this pass"
  const ctrl = await newReservedCreature(A, OLD);
  dasDown.add(ctrl.addr);
  const pendingBefore = JSON.stringify(row_(r.id).mintPending);
  const evBefore = chainOf(r.id).length;
  const staleReadsBefore = readsOf(staleAddr);
  await reconcile();
  chk(readsOf(ctrl.addr) === 1, `CONTROL: an equally old row WITHOUT a mint was read in this same pass (actual ${readsOf(ctrl.addr)})`);
  console.log(`  row with mint=${short(row_(r.id).mint)} + stale mintPending=${JSON.stringify(row_(r.id).mintPending || null)} -> chain ${JSON.stringify(chainOf(r.id))}`);
  chk(row_(r.id).mint === realMint, `its mint is untouched (${short(row_(r.id).mint)})`);
  chk(JSON.stringify(row_(r.id).mintPending) === pendingBefore, `its stale reservation is untouched — the sweep skipped the row (${JSON.stringify(row_(r.id).mintPending)})`);
  chk(countEv(r.id, "mint_abandoned") === 0 && chainOf(r.id).length === evBefore, `no event was written to it (events ${chainOf(r.id).length}, was ${evBefore})`);
  chk(readsOf(staleAddr) === staleReadsBefore, `and its RESERVED address was never read (reads ${readsOf(staleAddr)}, was ${staleReadsBefore})`);

  SRV._clearAssetReg();
  const t0 = dasTotal;
  const ok = await reconcile().then(() => true).catch((e) => String(e));
  console.log(`  empty registry: reconcile resolved=${ok} DAS reads=${dasTotal - t0}`);
  chk(ok === true && dasTotal - t0 === 0, `a pass with no rows at all is a clean no-op (resolved=${ok}, reads ${dasTotal - t0})`);

  // MALFORMED reservations must neither crash the pass nor be settled on
  const bad = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "jellox", kind: "normal", lvl: 1 });
  row_(bad.id).mintPending = { addr: "", at: Date.now() - OLD };            // no address at all
  const noAt = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "healix", kind: "normal", lvl: 1 });
  const noAtAddr = newAddr();
  row_(noAt.id).mintPending = { addr: noAtAddr };                           // no timestamp at all
  const t1 = dasTotal;
  const ok2 = await reconcile().then(() => true).catch((e) => String(e));
  await reconcile();                                    // twice — a hold must survive repetition
  console.log(`  malformed: {addr:""} -> mintPending=${JSON.stringify(row_(bad.id).mintPending || null)} | {no at} -> mintPending=${JSON.stringify(row_(noAt.id).mintPending || null)} chain=${JSON.stringify(chainOf(noAt.id))} reads on the timestampless addr=${readsOf(noAtAddr)} | reads over both passes=${dasTotal - t1}`);
  chk(ok2 === true, `the pass survives a malformed reservation (resolved=${ok2})`);
  chk(!!row_(bad.id).mintPending && countEv(bad.id, "mint_abandoned") === 0, `an addressless reservation is skipped, never abandoned (mintPending=${JSON.stringify(row_(bad.id).mintPending)}, events ${countEv(bad.id, "mint_abandoned")})`);
  // 2026-08-12 fix (`if (!pAddr || !pAt) continue`): a missing `at` used to fall back to 0, read as
  // infinitely old, and be abandoned on its FIRST pass. Holding costs one skipped row; abandoning
  // could cost a second certificate.
  chk(!!row_(noAt.id).mintPending && countEv(noAt.id, "mint_abandoned") === 0,
      `a reservation with NO timestamp is HELD across two passes, never abandoned (mintPending=${JSON.stringify(row_(noAt.id).mintPending || null)}, mint_abandoned=${countEv(noAt.id, "mint_abandoned")})`);
  chk(readsOf(noAtAddr) === 0, `...and it is held BEFORE the read, so it costs no DAS call either (reads ${readsOf(noAtAddr)})`);
}

// ================================================================================================
sec("9. COST PER PASS — what a stuck reservation costs, every 5 minutes, forever");
{
  SRV._clearAssetReg();
  const A = await mkWallet();
  const stuck = [];
  for (let i = 0; i < 12; i++) { const r = await newReservedCreature(A, OLD); dasDown.add(r.addr); stuck.push(r); }
  const t0 = dasTotal;
  await reconcile();
  const p1 = dasTotal - t0;
  await reconcile(); await reconcile();
  const p3 = dasTotal - t0;
  console.log(`  ${stuck.length} unreadable reservations: pass 1 = ${p1} DAS reads, three passes = ${p3} reads (serial, inside the reconcile lock)`);
  chk(p1 === stuck.length, `one read per pending row per pass (actual ${p1} for ${stuck.length} rows)`);
  chk(p3 === stuck.length * 3, `and it repeats every pass with no back-off (actual ${p3} over 3 passes)`);
}

// ================================================================================================
sec("9b. THE PER-PASS READ CAP (NFT_SWEEP_MAX_READS, shipped default 40)");
{
  SRV._clearAssetReg();
  const A = await mkWallet();
  const N = 60;                                        // deliberately more pending rows than the cap
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(await newReservedCreature(A, OLD));   // all answer absent -> all can settle
  const t0 = dasTotal; await reconcile(); const p1 = dasTotal - t0;
  const settled1 = rows.filter((r) => !row_(r.id).mintPending).length;
  const t1 = dasTotal; await reconcile(); const p2 = dasTotal - t1;
  const settled2 = rows.filter((r) => !row_(r.id).mintPending).length;
  console.log(`  ${N} pending rows -> pass 1 = ${p1} DAS reads (${settled1} settled), pass 2 = ${p2} reads (${settled2}/${N} settled)`);
  chk(p1 === 40, `one pass spends EXACTLY the shipped cap of DAS reads, not one per row (measured ${p1} reads for ${N} pending rows)`);
  chk(settled1 === p1, `and exactly that many rows were settled in that pass (actual ${settled1})`);
  chk(p2 === N - p1, `the next pass spends exactly the remainder (${p2} reads for the ${N - p1} rows left)`);
  chk(settled2 === N, `every row was reached within 2 passes — the remainder is deferred, not skipped (actual ${settled2}/${N})`);

  // ...and the bound that comes with a `break` over insertion order and NO cursor: a stuck HEAD
  // bigger than the cap starves the tail for as long as it stays stuck.
  SRV._clearAssetReg();
  const head = [], tail = [];
  for (let i = 0; i < 40; i++) { const r = await newReservedCreature(A, OLD); dasDown.add(r.addr); head.push(r); }
  for (let i = 0; i < 5; i++) tail.push(await newReservedCreature(A, OLD));
  await reconcile(); await reconcile(); await reconcile();
  const tailReads = tail.reduce((n, r) => n + readsOf(r.addr), 0);
  const headReads = head.reduce((n, r) => n + readsOf(r.addr), 0);
  console.log(`  ${head.length} UNREADABLE rows ahead of ${tail.length} settleable ones, 3 passes: head reads=${headReads} tail reads=${tailReads}`);
  chk(tailReads === 0 && headReads === head.length * 3,
      `KNOWN LIMIT: the cap is a break over insertion order with no cursor, so a stuck head at or above the cap starves the tail (head ${headReads} reads, tail ${tailReads} over 3 passes)`);
  for (const r of head) dasDown.delete(r.addr);        // the reader recovers: the head settles...
  await reconcile();
  const tailAfterHeadSettles = tail.reduce((n, r) => n + readsOf(r.addr), 0);
  await reconcile();                                    // ...and the very next pass reaches the tail
  const tailReads2 = tail.reduce((n, r) => n + readsOf(r.addr), 0);
  console.log(`  after the head becomes readable: tail reads ${tailAfterHeadSettles} on the settling pass, ${tailReads2} on the next`);
  chk(tailReads2 === tail.length && tail.every((r) => !row_(r.id).mintPending),
      `the starvation is not permanent — once the head settles the tail is swept on the next pass (tail reads ${tailReads2}, all settled=${tail.every((r) => !row_(r.id).mintPending)})`);
}

// ================================================================================================
sec("10. RISK PROBES — measured behaviour, asserted so a future fix breaks this loudly");
{
  // (a) the player's Phantom transaction lands AFTER the (now unfrozen) egg has already hatched
  SRV._clearAssetReg();
  const A = await mkWallet();
  const egg = SRV._mintAssetForTest("egg", A.wallet, { kind: "normal", sp: "normal" }, "issued");
  SRV._ageAsset(egg.id, 4 * 3600e3);
  const rr = await reserveVia(A, egg.id);
  SRV._nftAgePendingForTest(egg.id, OLD);
  const h = await post("/assets/egg/hatch", { wallet: A.wallet, mktToken: A.mktToken, id: egg.id });
  console.log(`  (a) egg hatched ${h.status} -> ${h.body.hatched?.sp}; row.state=${row_(egg.id).state} mintPending STILL=${JSON.stringify(row_(egg.id).mintPending || null)}`);
  chk(h.status === 200 && !!row_(egg.id).mintPending,
      `KNOWN: hatching does NOT clear the reservation — a spent egg keeps mintPending (state=${row_(egg.id).state}, addr=${short(row_(egg.id).mintPending?.addr)})`);
  // Markers planted so "cleared" below is a real check and not a vacuous one — a spent egg that was
  // listed/settling when the tx landed is exactly the case eggNftRetire exists for.
  row_(egg.id).listedOffchain = true;
  row_(egg.id).pendingHandover = { to: newAddr(), at: Date.now() };
  dasMap.set(String(rr.body.tokenMint), coreObs(A.wallet));     // the late transaction lands
  await reconcile();
  const spent = row_(egg.id);
  console.log(`  (a) after the late tx lands + one sweep: state=${spent.state} mint=${short(spent.mint)} nftRetired=${JSON.stringify(spent.nftRetired || null)} listedOffchain=${spent.listedOffchain} pendingHandover=${JSON.stringify(spent.pendingHandover || null)} chain=${JSON.stringify(chainOf(egg.id))}`);
  // 2026-08-12 fix: `if (row.type === "egg" && row.state !== "active") eggNftRetire(row, null)` right
  // after the commit. The asset is REAL and must still be recorded — losing it is what the sweep
  // exists to prevent — but recorded SPENT, exactly as an egg hatched through the normal path is.
  chk(spent.mint === String(rr.body.tokenMint) && spent.state === "consumed",
      `a late-landing tx for an already-hatched egg is still RECORDED, never lost (mint=${short(spent.mint)} on a state=${spent.state} row)`);
  chk(!!spent.nftRetired && Number(spent.nftRetired.at) > 0,
      `...and it is recorded RETIRED, not live (nftRetired=${JSON.stringify(spent.nftRetired || null)})`);
  chk(spent.listedOffchain === false && !spent.pendingHandover,
      `...with the listing and transfer markers cleared (listedOffchain=${spent.listedOffchain}, pendingHandover=${JSON.stringify(spent.pendingHandover || null)})`);
  chk(chainOf(egg.id).includes("nft_retired"), `...and a nft_retired provenance event exists (chain ${JSON.stringify(chainOf(egg.id))})`);
  chk(SRV._nftEligibilityForTest(spent, A.wallet).code === "not-active",
      `the retired egg can never be re-minted or listed (eligibility code "${SRV._nftEligibilityForTest(spent, A.wallet).code}")`);

  // (b) a reservation whose row changed hands before the sweep sees it
  SRV._clearAssetReg();
  const S = await mkWallet(), Bw = await mkWallet();
  const r2 = await newReservedCreature(S, OLD);
  SRV._transferAssetForTest(r2.id, S.wallet, Bw.wallet, "sim-handover");
  dasMap.set(r2.addr, coreObs(S.wallet));            // the tx lands; the on-chain owner is the SELLER
  await reconcile(); await reconcile();
  const row2 = row_(r2.id);
  console.log(`  (b) reserved by ${short(S.wallet)}, row now owned by ${short(row2.owner)}, chain says ${short(S.wallet)} -> mint=${JSON.stringify(row2.mint || null)} mintPending=${JSON.stringify(row2.mintPending || null)} reads=${readsOf(r2.addr)}`);
  chk(!row2.mint && !!row2.mintPending,
      `RISK (measured): a reservation that lands after a hand-off can never settle — verify runs against row.owner (${short(row2.owner)}), not the reserver (${short(S.wallet)}), so it is held forever and re-read every pass (reads so far ${readsOf(r2.addr)})`);
}

// ================================================================================================
sec("11. THE TOTALS — nothing was ever submitted anywhere");
{
  console.log(`  chain creates=${coreCreates}  compose(mint-only)=${composeMintOnly}  compose(mint+list)=${composeMintList}  DAS reads=${dasTotal}`);
  chk(coreCreates === 0, `ZERO Metaplex Core creates reached the stubbed chain across the whole run (actual ${coreCreates})`);
  chk(composeMintList === 0, `ZERO mint+list compositions (actual ${composeMintList})`);
  chk(composeMintOnly > 0, `every reservation came from the REAL compose route, ${composeMintOnly} of them`);
}

// ================================================================================================
sec("12. NFT_MINT_PAUSED=1 — recovery must still work while the owner has minting paused");
{
  const self = fileURLToPath(import.meta.url);
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [self], {
      env: Object.assign({}, process.env, { SWEEP_ROLE: "paused", PORT: "39928", NFT_MINT_PAUSED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    ch.stdout.on("data", (d) => { buf += d; });
    ch.stderr.on("data", (d) => { buf += d; });
    ch.on("close", (code) => resolve({ buf, code }));
  });
  for (const ln of out.buf.split("\n")) if (/PAUSED/.test(ln)) console.log("  child |", ln.trim());
  const m = out.buf.match(/PAUSED_TALLY pass=(\d+) fail=(\d+)/);
  if (m) {
    console.log(`  child exit=${out.code}; folding in pass=${m[1]} fail=${m[2]} (its 5 isolation assertions included)`);
    pass += Number(m[1]); fail += Number(m[2]);
  } else {
    fail++; console.log(`  FAIL: the paused child never reported a tally (exit ${out.code}); tail: ${out.buf.slice(-500)}`);
  }
}

console.log(`\nNFT_SWEEP_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
