// w2fix_a_censusfix.mjs — verifies the CENSUS-CLAMP fix for the w2v_a_backfill §A breach.
// Boots the REAL server.js in-process (throwaway keys, memory store, dead RPC). Never live.
//
// The breach: regAdoptChikimonPerUid minted cap-EXEMPT registry rows from CLIENT-DECLARED ledger
// units, and buildCensus counted registry rows IN FULL — so 12 forged clean 'alon' units became 12
// full-census rows (1 -> 13, cap 10) and honest hatchers got SUPPLY_EXHAUSTED. The fix: such rows
// carry `clamped: true`, the census keeps them under LEDGER_CLEAN_QUOTA exactly as their evidence
// was pre-backfill, and the cap binds at MINT (regClampedSupplyGate) instead of at backfill.
//
// NOTE ON THE LENS SIM'S RESIDUAL FAIL: w2v_a_backfill.mjs measures `aBefore` BEFORE its own
// control mint (line 60) mints a REAL 'issued' alon row to an honest wallet. That control adds a
// legitimate +1, so its "before == after" check compares 1 vs 2 and can never pass under ANY
// correct fix. This sim replays the exact scenario with the measurement taken AFTER the control
// mint and attributes every unit of the delta, printing actual values throughout.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59996"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39288";
process.env.CHIK_REG_ALL = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n===== ${s} =====`);
const mkW = () => bs58.encode(nacl.sign.keyPair().publicKey);
const PRE_EPOCH = Date.UTC(2026, 5, 1);
const cen = (t, s) => SRV._trueIssued(t, s);
const rows = (w, t) => SRV._regOwnedForTest(w, t);
const row = (id) => SRV._assetRowForTest(id);
const elig = (r, w) => SRV._nftEligibilityForTest(r, w);
// any registry mutation invalidates the census; mintPending set by hand does not, so poke it via a
// throwaway uncapped mint (mintAsset -> censusInvalidate) — a seam, not a behaviour under test
const junk = mkW();
const poke = () => SRV._mintAssetForTest("chikimon", junk, { sp: "drolax", kind: "normal", lvl: 1 }, "legacy");

// ---------------------------------------------------------------------------------------------
sec("A. THE EXACT §A SCENARIO, measured correctly: census identical before/after backfill");
const F = mkW();
SRV._setWalletFirstSeenForTest(F, PRE_EPOCH);
const forged = {};
for (let i = 1; i <= 12; i++) forged["u" + i] = { species: "alon", kind: "meme", level: 40 };
SRV._auditAssetsForTest(F, { onboarded: true, units: forged, mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
const a0 = cen("chikimon", "alon");
console.log(`  census alon (forged units only):        count=${a0.count} flagged=${a0.flagged}`);
// the lens sim's control mint, replayed HERE — BEFORE the before-measurement
const honest1 = mkW();
let ctl = null;
try { ctl = SRV._mintAssetForTest("chikimon", honest1, { sp: "alon", kind: "meme", lvl: 1 }, "issued") ? "MINTED" : "null"; }
catch (e) { ctl = e.code || e.message; }
const aBefore = cen("chikimon", "alon");
console.log(`  CONTROL honest issuing mint: ${ctl}`);
console.log(`  census alon BEFORE backfill (post-control): count=${aBefore.count} flagged=${aBefore.flagged}`);
chk(a0.count === 1 && aBefore.count === 2, `attribution: forged wallet contributes 1, control adds 1 (${a0.count} -> ${aBefore.count}) — the lens sim's residual FAIL is its own control row`);
const tF = SRV._regBackfillForTest(F, null);
const aAfter = cen("chikimon", "alon");
console.log(`  backfill minted ${tF.chikimon.length} rows; census alon AFTER: count=${aAfter.count} flagged=${aAfter.flagged}`);
chk(aAfter.count === aBefore.count, `MANDATE: census IDENTICAL before/after backfill (${aBefore.count} -> ${aAfter.count})`);
chk(aAfter.flagged === aBefore.flagged, `flagged identical too (${aBefore.flagged} -> ${aAfter.flagged})`);
// harm control: honest issuance still works after the backfill
const honest2 = mkW();
let harm = null;
try { harm = SRV._mintAssetForTest("chikimon", honest2, { sp: "alon", kind: "meme", lvl: 1 }, "issued") ? "MINTED" : "null"; }
catch (e) { harm = e.code || e.message; }
chk(harm === "MINTED", `HARM control: honest issuing mint post-backfill: ${harm} (was SUPPLY_EXHAUSTED pre-fix)`);

// ---------------------------------------------------------------------------------------------
sec("B. GRANDFATHERING: the rows are real property — present, active, clamped, verdict verbatim");
const fRows = rows(F, "chikimon").filter(r => r.sp === "alon");
console.log(`  forged wallet rows: ${fRows.length}; states=[${[...new Set(fRows.map(r => row(r.id).state))].join(",")}]; origins=[${[...new Set(fRows.map(r => r.origin))].join(",")}]; clamped=${fRows.filter(r => row(r.id).clamped === true).length}/${fRows.length}`);
chk(fRows.length === 12, `all 12 holdings have rows (${fRows.length}) — nothing refused, nothing deleted`);
chk(fRows.every(r => row(r.id).clamped === true), `every client-claimed row carries the census-clamp marker`);
chk(fRows.every(r => row(r.id).state === "active" && r.origin === "legacy"), `rows active, ledger verdict 'legacy' verbatim`);

// ---------------------------------------------------------------------------------------------
sec("C. CAPS BIND AT MINT: at-cap clamped row refused; counted holding stays census-neutral mintable");
// fill alon to its cap of 10 with honest issued mints (currently at 3: forged 1 + 2 controls)
let filled = 0;
for (let i = 0; i < 20 && cen("chikimon", "alon").count < 10; i++) {
  try { SRV._mintAssetForTest("chikimon", mkW(), { sp: "alon", kind: "meme", lvl: 1 }, "issued"); filled++; } catch (e) { break; }
}
console.log(`  filled ${filled} honest mints; census alon now count=${cen("chikimon", "alon").count} (cap 10)`);
chk(cen("chikimon", "alon").count === 10, `alon at cap: ${cen("chikimon", "alon").count}/10`);
const eF = elig(row(fRows[0].id), F);
console.log(`  eligibility(forged clamped row, at cap) = ${JSON.stringify(eF)}`);
chk(eF.code === "supply" && eF.status === 409, `clamped-OUT row refused at mint with code=supply (${eF.code}/${eF.status}) — the cap binds at mint, not at backfill`);
// an honest single holding: its clamped row is ALREADY the wallet's counted quota — census-neutral
const H = mkW();
SRV._setWalletFirstSeenForTest(H, PRE_EPOCH);
SRV._auditAssetsForTest(H, { onboarded: true, units: { u1: { species: "alon", kind: "meme", level: 9 } }, mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
const hPre = cen("chikimon", "alon").count;
SRV._regBackfillForTest(H, null);
const hRow = rows(H, "chikimon").find(r => r.sp === "alon");
const eH = elig(row(hRow.id), H);
console.log(`  honest 1-holding wallet: census ${hPre} -> ${cen("chikimon", "alon").count} across backfill; eligibility=${JSON.stringify(eH)}`);
chk(cen("chikimon", "alon").count === hPre, `single honest holding: backfill census-neutral (${hPre} -> ${cen("chikimon", "alon").count})`);
chk(eH.code === "ok", `counted clamped holding IS mintable even at cap (delta 0, census-neutral): code=${eH.code}`);

// ---------------------------------------------------------------------------------------------
sec("D. HARDENING ARITHMETIC: a clamped row counts FULL once it carries mintPending/mint");
const D = mkW();
SRV._setWalletFirstSeenForTest(D, PRE_EPOCH);
SRV._auditAssetsForTest(D, { onboarded: true, units: {
  u1: { species: "doge", kind: "meme", level: 5 }, u2: { species: "doge", kind: "meme", level: 6 }, u3: { species: "doge", kind: "meme", level: 7 },
}, mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
SRV._regBackfillForTest(D, null);
const dRows = rows(D, "chikimon").filter(r => r.sp === "doge");
const d0 = cen("chikimon", "doge").count;
console.log(`  3 claimed doge -> ${dRows.length} clamped rows, census count=${d0} (quota ${1})`);
chk(dRows.length === 3 && d0 === 1, `3 claims = 3 rows but census 1 (rows=${dRows.length}, count=${d0})`);
const eD = elig(row(dRows[0].id), D);
chk(eD.code === "ok", `under-cap clamped-out row passes the mint gate (room exists): code=${eD.code} (doge ${d0}/15)`);
row(dRows[0].id).mintPending = { addr: junk, at: Date.now() }; poke();   // simulate the reserved mint
const d1 = cen("chikimon", "doge").count;
chk(d1 === d0 + 1, `hardened row (mintPending) counts FULL: census ${d0} -> ${d1}`);
delete row(dRows[0].id).mintPending; poke();                              // abandon -> soft again
const d2 = cen("chikimon", "doge").count;
chk(d2 === d0, `abandoned reservation softens back: census ${d1} -> ${d2}`);

// ---------------------------------------------------------------------------------------------
sec("E. RESTART: marker + census survive serialize -> clear -> restore");
const blob = SRV.serializeAssetReg();
const preAlon = cen("chikimon", "alon").count, preDoge = cen("chikimon", "doge").count;
SRV._clearAssetReg();
const n = SRV.restoreAssetReg(JSON.parse(JSON.stringify(blob)));
const postAlon = cen("chikimon", "alon").count, postDoge = cen("chikimon", "doge").count;
console.log(`  restored ${n} rows; alon ${preAlon} -> ${postAlon}; doge ${preDoge} -> ${postDoge}`);
chk(postAlon === preAlon && postDoge === preDoge, `census identical across restart (alon ${preAlon}->${postAlon}, doge ${preDoge}->${postDoge})`);
const fRows2 = rows(F, "chikimon").filter(r => r.sp === "alon");
chk(fRows2.length === 12 && fRows2.every(r => row(r.id).clamped === true), `all 12 rows restored WITH the marker (${fRows2.filter(r => row(r.id).clamped === true).length}/12) — a reboot cannot harden a client claim`);
const eF2 = elig(row(fRows2[0].id), F);
chk(eF2.code === "supply", `mint gate still refuses at cap after restart: code=${eF2.code}`);

// ---------------------------------------------------------------------------------------------
sec("F. UNCAPPED SPECIES UNTOUCHED: clamped rows of an uncapped kind mint freely");
const U = mkW();
SRV._setWalletFirstSeenForTest(U, PRE_EPOCH);
SRV._auditAssetsForTest(U, { onboarded: true, units: { u1: { species: "grovador", kind: "legendary", level: 30 } }, mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
SRV._regBackfillForTest(U, null);
const uRow = rows(U, "chikimon").find(r => r.sp === "grovador");
const eU = elig(row(uRow.id), U);
console.log(`  grovador (uncapped) clamped row eligibility = ${JSON.stringify(eU)}`);
chk(row(uRow.id).clamped === true && eU.code === "ok", `uncapped clamped row is mintable (code=${eU.code}) — the gate only ever refuses where a cap exists`);

console.log("\nflags:", JSON.stringify(SRV._regAllFlagsForTest()));
console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
