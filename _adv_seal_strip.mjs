// _adv_seal_strip.mjs — ADVERSARIAL: try to STRIP or LOSE the Creator Edition seal.
// Boots the REAL server.js in-process. Throwaway keypairs, throwaway ADMIN_KEY that exists only in
// this process, memory store, DEAD RPC/ME endpoints. Nothing here can reach a chain, a real key, or
// the live backend. Every assertion prints the ACTUAL measured value.
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59991";                 // dead
process.env.ME_API_BASE = "http://127.0.0.1:59992";             // dead
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.TEAM_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "39411"; process.env.STORE = "memory"; process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "strip-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_REG_ALL = "1";
process.env.CHIK_NFT_MINT = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";
process.env.CHIK_CHRONICLE = "1";
process.env.CHIK_TP_ESCROW = "1";          // the escrow settle leg the builder's sim never enabled
process.env.NFT_META_BASE = "http://127.0.0.1:39411";
process.env.NFT_IMAGE_BASE = "http://127.0.0.1:39411/art";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get  = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0; const defects = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n===== ${s} =====`);
let _n = 0;
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { wallet, authMsg, authSig };
}
async function mkWallet() {
  const k = mkKeys();
  const v = await post("/verify", { wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg: k.authMsg, authSig: k.authSig });
  return { ...k, mktToken: v.body.mktToken };
}
const TRAIT = "Creator Edition", VALUE = "Yes";
const sealTrait = (meta) => (meta.attributes || []).find(a => a.trait_type === TRAIT) || null;
const isSealed  = (row)  => !!row && row.creatorEdition === true;
const live      = (x)    => SRV._assetRowForTest(x && x.id ? x.id : x);
const owned     = (w, t) => SRV._regOwnedForTest(w, t).map(live);
const allOwned  = (w)    => ["chikimon", "mount", "avatar"].flatMap(t => owned(w, t));
const metaTrait = async (id) => sealTrait((await get(`/assets/nft/meta/${encodeURIComponent(id)}`)).body);

// ---- the creator wallet, granted the whole catalog ----
const OWNER = await mkWallet();
let g = await post("/admin/grant-collection", { key: KEY, wallet: OWNER.wallet });
const N0 = g.body?.totals?.granted ?? -1;
console.log(`grant: status=${g.status} granted=${N0} sealed-in-report=${(g.body.granted||[]).filter(x=>x.creatorEdition===true).length}`);
chk(N0 > 50 && allOwned(OWNER.wallet).every(isSealed), `baseline: ${allOwned(OWNER.wallet).filter(isSealed).length}/${allOwned(OWNER.wallet).length} owner rows sealed`);

// =====================================================================================
sec("X1  REGISTRY CAPACITY TRUNCATION — is a sealed row exempt the way a MINTED row is?");
// _partitionAssetRows is what serializeAssetReg persists through. Minted rows are exempt by design
// ("a genuine one can never age out", server.js:11949). Creator rows are unminted by default
// (CHIK_NFT=0 in production), and they are the OLDEST unminted rows in the registry.
{
  const sealedRows = allOwned(OWNER.wallet);
  // one MINTED row, to show the exemption that does exist
  const mintedVictim = sealedRows[0];
  SRV._meSetMintForTest(mintedVictim.id, bs58.encode(nacl.sign.keyPair().publicKey));
  // a pile of NEWER, ordinary, unminted rows — exactly what a live registry accumulates over time
  const NEWER = 40;
  const younger = [];
  for (let i = 0; i < NEWER; i++) {
    const w = bs58.encode(nacl.sign.keyPair().publicKey);
    younger.push(SRV._mintAssetForTest("egg", w, { kind: "normal", sp: "normal" }, "issued"));
  }
  const all = [...sealedRows, ...younger];                       // creation order, as the Map holds it
  const max = younger.length;                                    // force truncation to the newest N
  const kept = SRV._partitionAssetRows(all, max);
  const keptSealed = kept.filter(isSealed).length;
  const totalSealed = all.filter(isSealed).length;
  const keptMintedSealed = kept.filter(r => isSealed(r) && r.mint).length;
  console.log(`     rows in=${all.length} max=${max} kept=${kept.length}`);
  console.log(`     SEALED rows kept = ${keptSealed} / ${totalSealed}   (minted+sealed kept = ${keptMintedSealed} of 1)`);
  chk(keptMintedSealed === 1, `the MINTED sealed row survived truncation (exempt): kept=${keptMintedSealed}`);
  const lost = totalSealed - keptSealed;
  if (lost > 0) {
    defects.push({ id: "X1", what: `_partitionAssetRows dropped ${lost}/${totalSealed} UNMINTED sealed rows at capacity` });
    console.log(`  DEFECT X1: ${lost}/${totalSealed} sealed rows were dropped from the persisted blob (only the minted one is exempt)`);
  }
  chk(lost === 0, `sealed rows lost to truncation = ${lost} (want 0)`);
  // and prove the loss is terminal: restore the truncated blob into a clean registry
  const before = SRV._assetRowForTest(sealedRows[5].id);
  const blob = { rows: kept, restitution: [] };
  const snapshot = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));   // keep the real one to put back
  SRV._clearAssetReg();
  SRV.restoreAssetReg(JSON.parse(JSON.stringify(blob)));
  const after = SRV._assetRowForTest(sealedRows[5].id);
  console.log(`     after restoring the truncated blob: row ${sealedRows[5].sp} = ${after ? "present, sealed=" + after.creatorEdition : "GONE"} (was sealed=${before.creatorEdition})`);
  chk(!!after, `sealed row ${sealedRows[5].sp} survived the truncated-blob restore: ${!!after}`);
  // put the real registry back for the rest of the run
  SRV._clearAssetReg();
  SRV.restoreAssetReg(snapshot);
  chk(allOwned(OWNER.wallet).filter(isSealed).length === N0, `registry restored for the next tests: ${allOwned(OWNER.wallet).filter(isSealed).length}/${N0} sealed`);
}

// =====================================================================================
sec("X2  THREE FULL BOOT CYCLES with heavy trading between each (chain truncation compounding)");
{
  const A = await mkWallet(), Bw = await mkWallet();
  let victim = owned(OWNER.wallet, "chikimon")[0];
  const vid = victim.id;
  let holder = OWNER.wallet;
  for (let cycle = 1; cycle <= 3; cycle++) {
    // ping-pong the asset to pile chain events on it
    for (let i = 0; i < 60; i++) {
      const to = holder === A.wallet ? Bw.wallet : A.wallet;
      const moved = SRV._transferAssetForTest(vid, holder, to, i % 2 ? "tp-settle" : "nft-handover");
      if (!moved) break;
      holder = to;
    }
    const pre = SRV._assetRowForTest(vid);
    const depth = pre.chain.length;
    const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
    const blobRow = blob.rows.find(r => r.id === vid);
    SRV._clearAssetReg();
    const n = SRV.restoreAssetReg(blob);
    const post0 = SRV._assetRowForTest(vid);
    const tr = await metaTrait(vid);
    console.log(`  cycle ${cycle}: chain ${depth} -> ${post0.chain.length}, blob had creatorEdition=${blobRow.creatorEdition}, granted-in-blob-chain=${blobRow.chain.some(c=>c.what==="granted")}`);
    chk(isSealed(post0), `  cycle ${cycle}: still sealed after restore = ${post0.creatorEdition}`);
    chk(tr && tr.value === VALUE, `  cycle ${cycle}: metadata trait = ${JSON.stringify(tr)}`);
    chk(n > 0, `  cycle ${cycle}: rows restored = ${n}`);
  }
  // and the WHOLE collection is still sealed after 3 cycles
  const stillSealed = allOwned(OWNER.wallet).filter(isSealed).length + 0;
  const movedAway = 1;
  console.log(`     owner rows sealed after 3 boot cycles = ${stillSealed} (1 was traded away)`);
  chk(stillSealed === N0 - movedAway, `sealed rows still with the owner = ${stillSealed} (expect ${N0 - movedAway})`);
  chk(isSealed(SRV._assetRowForTest(vid)), `the traded-away row is still sealed for its new owner = ${SRV._assetRowForTest(vid).creatorEdition}`);
}

// =====================================================================================
sec("X3  TRADING POST ESCROW SETTLE (CHIK_TP_ESCROW=1) — the seller never gets it back");
{
  const buyer = await mkWallet();
  const row = owned(OWNER.wallet, "chikimon").filter(isSealed)[2];
  const before = row.owner;
  const moved = SRV._transferAssetForTest(row.id, OWNER.wallet, buyer.wallet, "tp-settle");
  const after = SRV._assetRowForTest(row.id);
  chk(!!moved && after.owner === buyer.wallet, `tp-settle moved ${row.sp}: ${before.slice(0,6)} -> ${after.owner.slice(0,6)}`);
  chk(isSealed(after), `after tp-settle: creatorEdition = ${after.creatorEdition}`);
  const tr = await metaTrait(row.id);
  chk(tr && tr.value === VALUE, `buyer's metadata trait = ${JSON.stringify(tr)}`);
  // and across a restart (the tp-settle chain event is what restore reads)
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  const r2 = SRV._assetRowForTest(row.id);
  chk(isSealed(r2) && r2.owner === buyer.wallet, `after restart: owner=${r2.owner.slice(0,6)} creatorEdition=${r2.creatorEdition}`);
}

// =====================================================================================
sec("X4  RETIRE / BURN / RESTRICTED — a retired seal must still read as a seal");
{
  const burnRow = owned(OWNER.wallet, "mount").filter(isSealed)[0];
  burnRow.state = "burned";                       // what nftApplyClassification('retire') records
  burnRow.chain.push({ at: Date.now(), what: "burned", why: "adv-probe" });
  const trB = await metaTrait(burnRow.id);
  chk(isSealed(burnRow), `burned row still sealed in memory = ${burnRow.creatorEdition}`);
  chk(trB && trB.value === VALUE, `burned row metadata trait = ${JSON.stringify(trB)}`);
  const restrictRow = owned(OWNER.wallet, "avatar").filter(isSealed)[0];
  restrictRow.gameStatus = "restricted"; restrictRow.statusReason = "adv-probe";
  const trR = await metaTrait(restrictRow.id);
  chk(trR && trR.value === VALUE, `restricted row metadata trait = ${JSON.stringify(trR)}`);
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  const b2 = SRV._assetRowForTest(burnRow.id), r2 = SRV._assetRowForTest(restrictRow.id);
  chk(b2 && isSealed(b2) && b2.state === "burned", `after restart: burned row state=${b2 && b2.state} sealed=${b2 && b2.creatorEdition}`);
  chk(r2 && isSealed(r2) && r2.gameStatus === "restricted", `after restart: restricted row status=${r2 && r2.gameStatus} sealed=${r2 && r2.creatorEdition}`);
}

// =====================================================================================
sec("X5  MARKET LISTING MARKERS — list, cancel, re-list, then a settle");
{
  const row = owned(OWNER.wallet, "chikimon").filter(isSealed)[4];
  row.listedOffchain = true;
  row.meList = { price: 12345, at: Date.now(), sig: "advprobe", verified: true, src: "confirm" };
  let blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  let r = SRV._assetRowForTest(row.id);
  chk(isSealed(r) && r.listedOffchain === true, `LISTED across a restart: listed=${r.listedOffchain} sealed=${r.creatorEdition}`);
  // cancel
  r.listedOffchain = false; delete r.meList;
  blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  r = SRV._assetRowForTest(row.id);
  chk(isSealed(r) && !r.listedOffchain, `CANCELLED across a restart: listed=${!!r.listedOffchain} sealed=${r.creatorEdition}`);
  const tr = await metaTrait(row.id);
  chk(tr && tr.value === VALUE, `metadata trait after list+cancel = ${JSON.stringify(tr)}`);
}

// =====================================================================================
sec("X6  NFT HAND-OVER SETTLE to a buyer, then the buyer's own restart");
{
  const row = owned(OWNER.wallet, "chikimon").filter(isSealed)[6];
  SRV._meSetMintForTest(row.id, bs58.encode(nacl.sign.keyPair().publicKey));
  const buyer = await mkWallet();
  const st = SRV._nftSettleForTest(row.id, buyer.wallet);
  const r = SRV._assetRowForTest(row.id);
  chk(st.ok === true && r.owner === buyer.wallet, `handover settled: ok=${st.ok} owner=${r.owner.slice(0,6)}`);
  chk(isSealed(r), `after the sale: creatorEdition = ${r.creatorEdition}`);
  const tr = await metaTrait(row.id);
  chk(tr && tr.value === VALUE, `the BUYER's marketplace trait = ${JSON.stringify(tr)}`);
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  const r2 = SRV._assetRowForTest(row.id);
  chk(isSealed(r2), `after the buyer's restart: creatorEdition = ${r2.creatorEdition}`);
}

// =====================================================================================
sec("X7  A PROFILE SAVE THAT OMITS THE ASSETS, then a re-sync and a re-grant");
{
  const beforeSealed = allOwned(OWNER.wallet).filter(isSealed).length;
  const sv = await post("/save", { wallet: OWNER.wallet, mktToken: OWNER.mktToken,
    data: { onboarded: true, chikis: [], mounts: [], avatars: [], avatar: "", eggs: [], gold: 0 } });
  const afterSave = allOwned(OWNER.wallet).filter(isSealed).length;
  console.log(`     /save (empty roster) -> status ${sv.status}; sealed rows ${beforeSealed} -> ${afterSave}`);
  chk(afterSave === beforeSealed, `an empty-roster save removed ${beforeSealed - afterSave} sealed rows (expect 0)`);
  const s1 = await post("/assets/mounts/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken });
  const s2 = await post("/assets/chikimon/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken });
  const afterSync = allOwned(OWNER.wallet);
  console.log(`     mounts/sync ${s1.status} adopted=${JSON.stringify(s1.body.adopted||[])}; chikimon/sync ${s2.status} adopted=${JSON.stringify((s2.body.adopted||[]).length)}`);
  chk(afterSync.filter(isSealed).length === beforeSealed, `after both syncs: sealed = ${afterSync.filter(isSealed).length} (expect ${beforeSealed})`);
  const unsealedTwins = afterSync.filter(r => !isSealed(r));
  console.log(`     rows the syncs ADDED that are unsealed = ${unsealedTwins.length}` + (unsealedTwins.length ? ` -> ${JSON.stringify(unsealedTwins.map(r=>r.type+":"+r.sp))}` : ""));
  const re = await post("/admin/grant-collection", { key: KEY, wallet: OWNER.wallet });
  const afterRe = allOwned(OWNER.wallet).filter(isSealed).length;
  console.log(`     re-grant: granted=${re.body.totals.granted} already=${re.body.totals.already}`);
  chk(afterRe >= beforeSealed, `after the re-grant: sealed = ${afterRe} (expect >= ${beforeSealed})`);
}

// =====================================================================================
sec("X8  A LEDGER-SEEDED DUPLICATE — can an UNSEALED twin of a sealed species appear?");
{
  const sealedSp = owned(OWNER.wallet, "chikimon").filter(isSealed)[8].sp;
  const rowsBefore = owned(OWNER.wallet, "chikimon").filter(r => r.sp === sealedSp);
  // a hostile/ordinary client save declaring it holds TWO of that species
  SRV._auditAssetsForTest(OWNER.wallet, { onboarded: true,
    units: { advdup1: { species: sealedSp, kind: "normal", level: 9 }, advdup2: { species: sealedSp, kind: "normal", level: 9 } },
    mounts: [], avatars: [], eggs: [] }, 0);
  const s = await post("/assets/chikimon/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken });
  const rowsAfter = owned(OWNER.wallet, "chikimon").filter(r => r.sp === sealedSp);
  const twins = rowsAfter.filter(r => !isSealed(r));
  console.log(`     ${sealedSp}: rows ${rowsBefore.length} -> ${rowsAfter.length}; unsealed twins = ${twins.length} (sync status ${s.status})`);
  chk(rowsBefore.every(isSealed) && rowsBefore.length === rowsAfter.filter(isSealed).length,
      `the original sealed row is untouched: sealed rows for ${sealedSp} = ${rowsAfter.filter(isSealed).length}`);
  if (twins.length) {
    defects.push({ id: "X8", what: `a client ledger can birth ${twins.length} UNSEALED registry row(s) of a species the creator holds sealed` });
    console.log(`  NOTE X8: ${twins.length} unsealed twin row(s) exist for ${sealedSp} — the SEALED row is intact, but a mint that picks the wrong row would publish an unsealed certificate`);
  }
}

// =====================================================================================
sec("X9  FORGERY — the second witness (the CHAIN) is not sanitised the way the field is");
{
  const P = await mkWallet();
  // the field: stripped (the builder's belt)
  const a = SRV._mintAssetForTest("chikimon", P.wallet, { sp: "healix", kind: "normal", lvl: 1, creatorEdition: true }, "issued");
  chk(!isSealed(a), `fields.creatorEdition:true -> row.creatorEdition = ${a.creatorEdition} ("creatorEdition" in row = ${"creatorEdition" in a})`);
  // the chain: NOT stripped. `Object.assign({...chain: []}, fields)` lets fields.chain win.
  const P2 = await mkWallet();
  const forged = SRV._mintAssetForTest("chikimon", P2.wallet,
    { sp: "owzard", kind: "normal", lvl: 1, chain: [{ at: Date.now(), what: "granted", route: "/admin/grant-collection", creator: true }] },
    "issued");
  console.log(`     in-process after mint: creatorEdition = ${forged.creatorEdition}; chain[0].what = ${forged.chain[0] && forged.chain[0].what}`);
  chk(!isSealed(forged), `fields.chain forgery is NOT sealed at issuance: ${forged.creatorEdition}`);
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  const f2 = SRV._assetRowForTest(forged.id);
  const tr = await metaTrait(forged.id);
  console.log(`     after ONE restart: creatorEdition = ${f2 && f2.creatorEdition}; metadata trait = ${JSON.stringify(tr)}`);
  if (f2 && f2.creatorEdition === true) {
    defects.push({ id: "X9", what: "a `chain` array passed in mintAsset `fields` overwrites the base chain and retro-seals the row on the next restart" });
    console.log(`  DEFECT X9: the row was NOT sealed at issuance but IS sealed after a restart — fields.chain is the unguarded second witness`);
  }
  chk(!(f2 && f2.creatorEdition === true), `a fields.chain forgery is still unsealed after a restart: ${f2 && f2.creatorEdition}`);
}

// =====================================================================================
sec("X10  LIVE REACHABILITY of X9 — can any HTTP route put a `chain` into mintAsset fields?");
{
  const P = await mkWallet();
  SRV._auditAssetsForTest(P.wallet, { onboarded: true,
    units: { advc1: { species: "jellox", kind: "normal", level: 3, chain: [{ what: "granted", route: "/admin/grant-collection" }] } },
    mounts: ["horse"], avatars: ["Mystic"], avatar: "Mystic", eggs: [] }, 0);
  await post("/assets/chikimon/sync", { wallet: P.wallet, mktToken: P.mktToken,
    chain: [{ what: "granted", route: "/admin/grant-collection" }],
    units: [{ sp: "jellox", chain: [{ what: "granted", route: "/admin/grant-collection" }] }] });
  await post("/assets/mounts/sync", { wallet: P.wallet, mktToken: P.mktToken,
    chain: [{ what: "granted", route: "/admin/grant-collection" }] });
  const rows = allOwned(P.wallet);
  const bad = rows.filter(r => (r.chain || []).some(c => c && c.what === "granted"));
  console.log(`     rows born from a hostile save/body = ${rows.length}; carrying a forged "granted" event = ${bad.length}`);
  chk(bad.length === 0, `no HTTP path put a "granted" event on a row: ${bad.length} (expect 0)`);
  const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
  SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
  const sealedAfter = allOwned(P.wallet).filter(isSealed).length;
  chk(sealedAfter === 0, `and after a restart the hostile wallet holds ${sealedAfter} sealed rows (expect 0)`);
}

// =====================================================================================
sec("X11  DoS — does a strict-mode write to a sealed property 500 any live route?");
{
  const row = owned(OWNER.wallet, "chikimon").filter(isSealed)[0];
  const bodies = [
    ["/assets/mounts/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken, creatorEdition: false }],
    ["/assets/chikimon/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken, creatorEdition: false }],
    ["/save", { wallet: OWNER.wallet, mktToken: OWNER.mktToken, data: { onboarded: true, creatorEdition: false, chikis: [], mounts: [], avatars: [], eggs: [] } }],
    ["/admin/grant-collection", { key: KEY, wallet: OWNER.wallet, creatorEdition: false }],
  ];
  let worst = 0;
  for (const [p, b] of bodies) { const r = await post(p, b); console.log(`     POST ${p} -> ${r.status}`); worst = Math.max(worst, r.status >= 500 ? r.status : 0); }
  const m = await get(`/assets/nft/meta/${encodeURIComponent(row.id)}`);
  const c = await get(`/assets/cert?id=${encodeURIComponent(row.id)}`);
  console.log(`     GET meta -> ${m.status}; GET cert -> ${c.status}`);
  chk(worst === 0 && m.status === 200 && c.status === 200, `no route 500ed on a creatorEdition-bearing body (worst 5xx = ${worst || "none"})`);
  chk(isSealed(SRV._assetRowForTest(row.id)), `and the row is still sealed = ${SRV._assetRowForTest(row.id).creatorEdition}`);
}

// =====================================================================================
sec("X12  FINAL STATE — the whole collection, end of run");
{
  const rows = ["chikimon", "mount", "avatar"].flatMap(t => [...SRV._regOwnedForTest(OWNER.wallet, t)].map(live));
  console.log(`     owner holds ${rows.length} rows; sealed = ${rows.filter(isSealed).length}`);
  const sample = rows.filter(isSealed)[0];
  const meta = (await get(`/assets/nft/meta/${encodeURIComponent(sample.id)}`)).body;
  console.log(`     MEASURED marketplace trait: ${JSON.stringify(sealTrait(meta))}`);
  console.log(`     MEASURED attribute labels:  ${JSON.stringify((meta.attributes || []).map(a => a.trait_type))}`);
  // 4 sealed rows left this wallet's ACTIVE set on purpose: X2 (traded), X3 (tp-settle),
  // X6 (nft handover) and X4 (burned — _regOwnedForTest lists active rows only). All four were
  // asserted still sealed in their own sections; this is the arithmetic, not a new claim.
  chk(rows.filter(isSealed).length === N0 - 4, `sealed rows still held+active = ${rows.filter(isSealed).length} (expect ${N0 - 4}: 3 traded away, 1 burned)`);
}

console.log(`\n==== _adv_seal_strip: ${pass} passed, ${fail} failed ====`);
if (defects.length) { console.log("DEFECTS:"); for (const d of defects) console.log(`  ${d.id}: ${d.what}`); }
else console.log("DEFECTS: none");
process.exit(0);
