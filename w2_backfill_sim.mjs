// w2_backfill_sim.mjs — W2 REGISTRY COMPLETENESS: the lazy per-individual backfill (CHIK_REG_ALL=1).
// Boots the REAL server.js in-process: throwaway keypairs, memory store, dead RPC. Never live.
// Proves, with PRINTED ACTUAL VALUES:
//   S1 a legacy-rich wallet (profile.chikis + ledger units + mounts + avatars) backfills to an EXACT
//      per-individual row count, and the census for every capped kind is IDENTICAL before/after;
//   S2 repeat + concurrent logins mint nothing twice (idempotence + the claim-before-work rate gate);
//   S3 a pure-MMO wallet (no profile.chikis — the legacy trap) is fully covered, census unchanged;
//   S4 an existing species-collapsed row COEXISTS: only the surplus individuals mint;
//   S5 a server-hatched row ABSORBS its client unit — no duplicate row for a witnessed birth;
//   S6 uid churn (wiped/re-imported save) mints nothing — the stale-luid row absorbs;
//   S7 a handed-over (NFT-sold) species is never re-adopted;
//   S8 the ledger's "unverified" verdict rides along verbatim — flagged, HELD, never counted.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59998"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39281";
process.env.CHIK_REG_ALL = "1";                        // the flag under test — ON
process.env.CHIK_NFT_HANDOVER = "1";                   // S7 only: lets a settled hand-off be simulated
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let _n = 0;
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { wallet, authMsg, authSig, kp };
}
async function mkWallet() {
  const k = mkKeys();
  const v = await post("/verify", { wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg: k.authMsg, authSig: k.authSig });
  return { ...k, mktToken: v.body.mktToken };
}
const PRE_EPOCH = Date.UTC(2026, 5, 1);                // before LEDGER_EPOCH (2026-07-28) => preExisting
const cnt = (t, s) => SRV._trueIssued(t, s);
const rowsOf = (w, t) => SRV._regOwnedForTest(w, t);
const luidsOf = (w) => rowsOf(w, "chikimon").map(r => r.luid).filter(Boolean).sort();

// ---------------------------------------------------------------------------
sec("S1 legacy-rich wallet: ledger units + mounts + avatars + profile.chikis");
const A = await mkWallet();
SRV._setWalletFirstSeenForTest(A.wallet, PRE_EPOCH);
const A_MMO = {
  onboarded: true,
  units: { u1: { species: "drolax", kind: "normal", level: 4 }, u2: { species: "drolax", kind: "normal", level: 7 },
           u3: { species: "drolax", kind: "normal", level: 9 }, u4: { species: "galador", kind: "legendary", level: 12 } },
  mounts: ["horse"], avatars: ["fire"], avatar: "classic", eggs: [],
};
// the old game's record: sp0=drolax (ledger-covered -> skipped), sp3=forestle (old-record only), sp10=galador (ledger-covered)
const A_CHIKIS = [{ sp: 0, level: 5 }, { sp: 3, level: 2 }, { sp: 10, level: 9, isLegend: true }];
SRV._auditAssetsForTest(A.wallet, A_MMO, PRE_EPOCH);   // the login save's audit half, seeded directly
const before = { drolax: cnt("chikimon", "drolax").count, galador: cnt("chikimon", "galador").count,
                 forestle: cnt("chikimon", "forestle").count, horse: cnt("mount", "horse").count,
                 fire: cnt("avatar", "fire").count, classic: cnt("avatar", "classic").count };
console.log("  census BEFORE backfill:", JSON.stringify(before));
const t1 = SRV._regBackfillForTest(A.wallet, A_CHIKIS);
console.log("  backfill tallies:", JSON.stringify(t1));
chk(t1 && t1.chikimon.length === 4, `per-uid chikimon rows minted = ${t1 && t1.chikimon.length} (expect 4: u1-u4)`);
chk(t1 && t1.mounts.length === 1 && t1.mounts[0] === "horse", `mount rows minted = ${t1 && t1.mounts.join(",")} (expect horse)`);
// the widened auditAssets heal (MINT_AT_SALE_ON || REG_ALL_ON) already minted the avatar rows at the
// audit — the backfill's own avatar pass finding nothing to add IS the double-writer dedup proof
const aAv = rowsOf(A.wallet, "avatar").map(r => `${r.sp}:${r.luid}:${r.origin}`).sort();
chk(t1 && t1.avatars.length === 0 && aAv.join(" ") === "classic:classic:legacy fire:fire:legacy",
    `avatar rows exist from the audit heal, backfill adds none (${aAv.join(" ")}; backfill ${t1 && t1.avatars.length})`);
chk(t1 && t1.oldRecord.length === 1 && t1.oldRecord[0] === "forestle", `old-record rows minted = ${t1 && t1.oldRecord.join(",")} (expect forestle only — ledger species skipped)`);
const aRows = rowsOf(A.wallet, "chikimon");
console.log("  A chikimon rows:", aRows.map(r => `${r.sp}:${r.luid}:${r.origin}`).join(" "));
chk(aRows.length === 5, `A holds ${aRows.length} chikimon rows (expect 5 = 4 individuals + 1 old-record)`);
chk(luidsOf(A.wallet).join(",") === "p3,u1,u2,u3,u4", `luids exact = ${luidsOf(A.wallet).join(",")}`);
chk(aRows.every(r => r.origin === "legacy"), `every backfilled origin is the ledger's own verdict ("legacy"): ${[...new Set(aRows.map(r => r.origin))].join(",")}`);
const after = { drolax: cnt("chikimon", "drolax").count, galador: cnt("chikimon", "galador").count,
                forestle: cnt("chikimon", "forestle").count, horse: cnt("mount", "horse").count,
                fire: cnt("avatar", "fire").count, classic: cnt("avatar", "classic").count };
console.log("  census AFTER backfill: ", JSON.stringify(after));
chk(after.drolax === before.drolax, `drolax census identical: ${before.drolax} -> ${after.drolax}`);
chk(after.galador === before.galador, `galador census identical: ${before.galador} -> ${after.galador}`);
chk(after.horse === before.horse, `horse (CAPPED) census identical: ${before.horse} -> ${after.horse}`);
chk(after.fire === before.fire, `fire avatar (CAPPED) census identical: ${before.fire} -> ${after.fire}`);
chk(after.classic === before.classic, `classic avatar (CAPPED) census identical: ${before.classic} -> ${after.classic}`);
chk(after.forestle === before.forestle + 1, `forestle (old-record-only, uncapped) honestly joins the count: ${before.forestle} -> ${after.forestle}`);

sec("S2 repeat + concurrent logins mint nothing twice");
const t2 = SRV._regBackfillForTest(A.wallet, A_CHIKIS);
chk(t2 === null, `second login inside the rate window is a no-op (${JSON.stringify(t2)})`);
SRV._regBackfillResetForTest(A.wallet);
const t3 = SRV._regBackfillForTest(A.wallet, A_CHIKIS);
chk(t3 && t3.chikimon.length + t3.mounts.length + t3.avatars.length + t3.oldRecord.length === 0,
    `forced re-run mints ZERO rows (${JSON.stringify(t3)})`);
// the real HTTP login, twice concurrently, on a fresh identical wallet
const A2 = await mkWallet();
SRV._setWalletFirstSeenForTest(A2.wallet, PRE_EPOCH);
const loginBody = { wallet: A2.wallet, authMsg: A2.authMsg, authSig: A2.authSig,
                    profile: { chikis: A_CHIKIS, mmo: { ...A_MMO, saved_at: Date.now() / 1000 } } };
const [r1, r2] = await Promise.all([post("/profile", loginBody), post("/profile", loginBody)]);
await wait(900); SRV._regBackfillResetForTest(A2.wallet);
await post("/profile", loginBody);                     // a third login after the save throttle
const a2Rows = rowsOf(A2.wallet, "chikimon");
console.log(`  concurrent logins: HTTP ${r1.status}/${r2.status}; A2 rows = ${a2Rows.length}, luids = ${luidsOf(A2.wallet).join(",")}`);
chk(a2Rows.length === 5, `concurrent + repeat HTTP logins land EXACTLY 5 chikimon rows (${a2Rows.length})`);
chk(new Set(luidsOf(A2.wallet)).size === luidsOf(A2.wallet).length, `zero duplicate luids (${luidsOf(A2.wallet).join(",")})`);
chk(rowsOf(A2.wallet, "mount").length === 1 && rowsOf(A2.wallet, "avatar").length === 2,
    `mounts=${rowsOf(A2.wallet, "mount").length} avatars=${rowsOf(A2.wallet, "avatar").length} (expect 1/2)`);

sec("S3 pure-MMO wallet (the legacy trap): no profile.chikis, fully covered");
const Bw = await mkWallet();
SRV._setWalletFirstSeenForTest(Bw.wallet, Date.now());
SRV._auditAssetsForTest(Bw.wallet, { onboarded: true, units: { u1: { species: "firix", kind: "normal", level: 2 },
  u2: { species: "jellox", kind: "normal", level: 3 } }, mounts: [], avatars: [], eggs: [] }, Date.now());
const bBefore = { firix: cnt("chikimon", "firix").count, jellox: cnt("chikimon", "jellox").count };
const tB = SRV._regBackfillForTest(Bw.wallet, null);
const bAfter = { firix: cnt("chikimon", "firix").count, jellox: cnt("chikimon", "jellox").count };
console.log("  tallies:", JSON.stringify(tB), "census:", JSON.stringify(bBefore), "->", JSON.stringify(bAfter));
chk(tB && tB.chikimon.length === 2, `pure-MMO wallet covered per-individual (${tB && tB.chikimon.length} rows, expect 2)`);
chk(luidsOf(Bw.wallet).join(",") === "u1,u2", `every held uid carried as a luid (${luidsOf(Bw.wallet).join(",")})`);
chk(bBefore.firix === bAfter.firix && bBefore.jellox === bAfter.jellox,
    `census identical: firix ${bBefore.firix}->${bAfter.firix}, jellox ${bBefore.jellox}->${bAfter.jellox}`);

sec("S4 species-collapsed row coexists — only the SURPLUS individuals mint");
const Cw = await mkWallet();
SRV._setWalletFirstSeenForTest(Cw.wallet, PRE_EPOCH);
SRV._mintAssetForTest("chikimon", Cw.wallet, { sp: "drolax", kind: "normal", lvl: 1, luid: "u1" }, "legacy");
SRV._auditAssetsForTest(Cw.wallet, { onboarded: true, units: { u1: { species: "drolax", kind: "normal", level: 5 },
  u2: { species: "drolax", kind: "normal", level: 6 }, u3: { species: "drolax", kind: "normal", level: 7 } },
  mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
const cBefore = cnt("chikimon", "drolax").count;
const tC = SRV._regBackfillForTest(Cw.wallet, null);
const cAfter = cnt("chikimon", "drolax").count;
console.log(`  drolax census ${cBefore} -> ${cAfter}; luids = ${luidsOf(Cw.wallet).join(",")}`);
chk(tC && tC.chikimon.length === 2, `existing u1 row kept; exactly 2 new rows for u2,u3 (${tC && tC.chikimon.length})`);
chk(luidsOf(Cw.wallet).join(",") === "u1,u2,u3", `three dragono-style individuals each have a named row (${luidsOf(Cw.wallet).join(",")})`);
chk(cBefore === cAfter, `census identical ${cBefore} -> ${cAfter}`);

sec("S5 a server-hatched row absorbs its own client unit — no duplicate");
const Dw = await mkWallet();
SRV._mintHatchedForTest("chikimon", Dw.wallet, { sp: "owzard", kind: "normal", lvl: 1 });
SRV._setWalletFirstSeenForTest(Dw.wallet, Date.now());
SRV._auditAssetsForTest(Dw.wallet, { onboarded: true, units: { u1: { species: "owzard", kind: "normal", level: 1 } },
  mounts: [], avatars: [], eggs: [] }, Date.now());
const dU = rowsOf(Dw.wallet, "chikimon").find(r => r.sp === "owzard");
const dBefore = cnt("chikimon", "owzard").count;
const tD = SRV._regBackfillForTest(Dw.wallet, null);
const dAfter = cnt("chikimon", "owzard").count;
console.log(`  owzard rows=${rowsOf(Dw.wallet, "chikimon").length} (parent=${!!dU.parent}); census ${dBefore} -> ${dAfter}; tallies ${JSON.stringify(tD && tD.chikimon)}`);
chk(tD && tD.chikimon.length === 0, `witnessed birth absorbs the client unit — 0 new rows (${tD && tD.chikimon.length})`);
chk(dBefore === dAfter && dAfter === 1, `census stays ${dAfter} (expect 1)`);

sec("S6 uid churn: wiped save, fresh uid — the stale-luid row absorbs");
const Ew = await mkWallet();
SRV._setWalletFirstSeenForTest(Ew.wallet, PRE_EPOCH);
SRV._mintAssetForTest("chikimon", Ew.wallet, { sp: "mushrow", kind: "normal", lvl: 1, luid: "u1" }, "legacy");
SRV._auditAssetsForTest(Ew.wallet, { onboarded: true, units: { u9: { species: "mushrow", kind: "normal", level: 3 } },
  mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
const eBefore = cnt("chikimon", "mushrow").count;
const tE = SRV._regBackfillForTest(Ew.wallet, null);
const eAfter = cnt("chikimon", "mushrow").count;
console.log(`  mushrow census ${eBefore} -> ${eAfter}; rows=${rowsOf(Ew.wallet, "chikimon").length}; minted=${JSON.stringify(tE && tE.chikimon)}`);
chk(tE && tE.chikimon.length === 0, `churned uid mints nothing — the stale row stands for it (${tE && tE.chikimon.length})`);
chk(rowsOf(Ew.wallet, "chikimon").length === 1, `still exactly one row (${rowsOf(Ew.wallet, "chikimon").length})`);
chk(eBefore === eAfter, `census identical ${eBefore} -> ${eAfter}`);

sec("S7 a species sold as an NFT is never re-adopted");
const Fw = await mkWallet(), Gw = await mkWallet();
const fRow = SRV._mintAssetForTest("chikimon", Fw.wallet, { sp: "scorplex", kind: "normal", lvl: 1, luid: "u1" }, "legacy");
SRV._setWalletFirstSeenForTest(Fw.wallet, PRE_EPOCH);
SRV._auditAssetsForTest(Fw.wallet, { onboarded: true, units: { u1: { species: "scorplex", kind: "normal", level: 4 } },
  mounts: [], avatars: [], eggs: [] }, PRE_EPOCH);
SRV._meSetMintForTest(fRow.id, Gw.wallet);   // any pubkey works as the recorded mint address
const settled = SRV._nftSettleForTest(fRow.id, Gw.wallet);
const tF = SRV._regBackfillForTest(Fw.wallet, null);
console.log(`  handover settled=${JSON.stringify(settled && settled.ok)}; debit=${JSON.stringify(SRV._nftHandDebitForTest(Fw.wallet))}; minted=${JSON.stringify(tF && tF.chikimon)}`);
chk(settled && settled.ok === true, "the NFT hand-off settled (row moved to the buyer)");
chk(tF && tF.chikimon.length === 0, `seller's ledger ghost is NOT re-adopted (${tF && tF.chikimon.length} rows minted)`);
chk(rowsOf(Fw.wallet, "chikimon").length === 0, `seller holds 0 scorplex rows (${rowsOf(Fw.wallet, "chikimon").length})`);

sec("S8 the unverified verdict rides along verbatim — flagged, never counted");
const Hw = await mkWallet();
SRV._setWalletFirstSeenForTest(Hw.wallet, Date.now());   // brand-new wallet, no amnesty for legendaries
SRV._auditAssetsForTest(Hw.wallet, { onboarded: true, units: { u1: { species: "tyrannos", kind: "legendary", level: 50 } },
  mounts: [], avatars: [], eggs: [] }, Date.now());
const hBefore = cnt("chikimon", "tyrannos");
const tH = SRV._regBackfillForTest(Hw.wallet, null);
const hRow = rowsOf(Hw.wallet, "chikimon").find(r => r.sp === "tyrannos");
const hAfter = cnt("chikimon", "tyrannos");
console.log(`  row origin=${hRow && hRow.origin}; census count ${hBefore.count}->${hAfter.count}, flagged ${hBefore.flagged}->${hAfter.flagged}`);
chk(hRow && hRow.origin === "unverified", `backfilled row keeps the ledger verdict verbatim (${hRow && hRow.origin})`);
chk(tH && tH.chikimon.length === 1, `the flagged creature still gets its honest row (${tH && tH.chikimon.length})`);
chk(hAfter.count === hBefore.count, `unverified never enters the clean count: ${hBefore.count} -> ${hAfter.count}`);
chk(hAfter.flagged === hBefore.flagged, `flagged tally identical (dedup holds): ${hBefore.flagged} -> ${hAfter.flagged}`);

console.log("\nflags:", JSON.stringify(SRV._regAllFlagsForTest()));
console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
