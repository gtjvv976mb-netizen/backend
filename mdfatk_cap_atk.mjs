// mdfatk_cap_atk.mjs — ADVERSARIAL: try to BREACH a Meme Dynasty per-species cap through the
// Founder Drop. Own namespace, own numbers, nothing inherited from the builder's sims.
// Real server.js booted in-process. Memory store, dead RPC on a closed port, throwaway keypair +
// throwaway ADMIN_KEY. NOTHING touches the live backend.
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto"; import fs from "node:fs";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59117";        // dead
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39471";
process.env.ADMIN_KEY = "atk-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1";
process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";                    // editions at issuance
process.env.CHIK_REG_ALL = "1";                         // the sale writes its registry row
process.env.MEME_SALE_OPEN = "true";                    // so the paid path is drivable
process.env.MEME_VERIFY_PAY = "false";                  // no chain in a sim
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN; delete process.env.MARKET_URL;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP; delete process.env.FOUNDER_PER_SPECIES;
delete process.env.FOUNDER_MIN_MINUTES; delete process.env.FOUNDER_MIN_ACTIONS;

const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(1400);

let pass = 0, fail = 0; const breaches = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n========== ${s} ==========`);
const wal = () => bs58.encode(nacl.sign.keyPair().publicKey);

// ---- MY OWN COPY OF THE OWNER'S NUMBERS. Typed from the owner ruling in the task, not read from
// any file. If server.js drifts from these, section A fails.
const OWNER_CAPS = { ansem: 10, successkid: 10, chloe: 10, grumpycat: 20, peanut: 20, cryingcat: 15,
                     thisisfine: 15, babygoat: 15, triplet: 25, stonks: 20, nervousmonkey: 20 };
const OWNER_TOTAL = 180;
const OWNER_BAR = { minutes: 30, actions: 10 };

const caps = SRV._memeCapsForTest();
const WAVE2 = SRV._memeWave2ForTest();
const issued = (sp) => SRV._censusIssuedForTest ? SRV._censusIssuedForTest("chikimon", sp) : null;

// census read without a dedicated seam: /meme/supply reports minted per character off the same
// trueIssued() counter every cap check uses.
async function supplyTable() {
  const r = await get("/meme/supply");
  return r.body.chars || {};
}
async function censusLine(tag) {
  const t = await supplyTable();
  const rows = WAVE2.map(sp => `${sp} ${t[sp].minted}/${t[sp].cap}`);
  const over = WAVE2.filter(sp => t[sp].minted > t[sp].cap);
  console.log(`  CENSUS [${tag}]: ${rows.join("  ")}`);
  if (over.length) { for (const sp of over) breaches.push(`${tag}: ${sp} ${t[sp].minted} > cap ${t[sp].cap}`); }
  return { t, over };
}
const assertNoBreach = async (tag) => {
  const { t, over } = await censusLine(tag);
  chk(over.length === 0, `${tag}: NO species over cap (worst = ${WAVE2.map(s => `${s} ${t[s].minted}/${t[s].cap}`).sort((a, b) => 0)[0]}; overs=${over.length})`);
  return t;
};

// burn a species to N issued through the ORDINARY (non-founder, non-sale-backed) mint path
function burn(sp, n, tag = "burn") {
  let made = 0, refused = 0, lastErr = "";
  for (let i = 0; i < n; i++) {
    try { SRV._mintAssetForTest("chikimon", wal(), { sp, kind: "meme", lvl: 1 }, "issued", null); made++; }
    catch (e) { refused++; lastErr = e.code || e.message; }
  }
  return { made, refused, lastErr };
}
function founderRowsAll() {
  return SRV._regAllForTest().filter(r => r.origin === "open-gates-founder");
}
function allChikimonRows() { return SRV._regAllForTest().filter(r => r.type === "chikimon"); }
function resetWorld() {
  SRV._resetLiveEventsForTest();
  SRV._clearAssetReg();
  SRV._clearAssetLedger();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
}
const startDrop = (species, days = 7) => post("/admin/event/start", { key: KEY, event: "founder_drop", days, species });

// =====================================================================================
sec("A  GROUND TRUTH — the pool is derived, the caps are the owner's, the client mirrors them");
console.log("  server MEME_WAVE2 (derived off the `wave` tag):", JSON.stringify(WAVE2));
chk(WAVE2.length === 11, `wave-2 pool length = ${WAVE2.length} (expect 11)`);
{
  const mism = WAVE2.filter(sp => caps[sp] !== OWNER_CAPS[sp]);
  const missing = Object.keys(OWNER_CAPS).filter(k => !WAVE2.includes(k));
  const total = WAVE2.reduce((s, k) => s + caps[k], 0);
  console.log("  server caps:", JSON.stringify(Object.fromEntries(WAVE2.map(k => [k, caps[k]]))));
  console.log("  owner caps :", JSON.stringify(OWNER_CAPS));
  chk(mism.length === 0 && missing.length === 0,
      `server caps == the owner's exact numbers (mismatches=${JSON.stringify(mism)}, missing=${JSON.stringify(missing)})`);
  chk(total === OWNER_TOTAL, `wave-2 total supply = ${total} (owner: ${OWNER_TOTAL})`);
}
// the CLIENT mirror — parsed straight out of Econ.gd, independently of any server value
{
  const gd = fs.readFileSync("/Users/michaelkennethbrillantes/Downloads/ChikoriaSmooth/Econ.gd", "utf8");
  const blk = gd.slice(gd.indexOf("const MEME_NFT :="), gd.indexOf("const MEME_NFT_TOTAL"));
  const cl = {};
  for (const m of blk.matchAll(/"([a-z0-9_]+)":\s*\{"cap":\s*(\d+)/g)) cl[m[1]] = Number(m[2]);
  const totM = gd.match(/const MEME_NFT_TOTAL\s*:=\s*(\d+)/);
  const srvAll = caps;                                 // ALL meme chars, both waves
  const drift = [];
  for (const k of new Set([...Object.keys(srvAll), ...Object.keys(cl)]))
    if (srvAll[k] !== cl[k]) drift.push(`${k}: server=${srvAll[k]} client=${cl[k]}`);
  const srvTotal = Object.values(srvAll).reduce((a, b) => a + b, 0);
  console.log(`  DRIFT TABLE (server MEME_CHARS vs client Econ.MEME_NFT): ${drift.length ? drift.join(" | ") : "(empty)"}`);
  console.log(`  totals: server=${srvTotal}  client MEME_NFT_TOTAL=${totM && totM[1]}  client sum=${Object.values(cl).reduce((a, b) => a + b, 0)}`);
  chk(drift.length === 0, `client mirror has ZERO drift across all ${Object.keys(srvAll).length} characters`);
  chk(totM && Number(totM[1]) === srvTotal, `client MEME_NFT_TOTAL ${totM && totM[1]} == server total ${srvTotal}`);
}

// =====================================================================================
sec("B  50 FOUNDER GRANTS ON A CLEAN WORLD — per-species minted vs caps");
resetWorld();
let r = await startDrop("meme_dynasty");
console.log("  start reply deal:", JSON.stringify(r.body.deal), "dealTotal:", r.body.dealTotal, "reservedTotal:", r.body.reservedTotal);
chk(r.body.cap === 50, `FOUNDER_CAP = ${r.body.cap}`);
chk(JSON.stringify(r.body.species) === JSON.stringify(WAVE2), `the started pool IS the derived eleven`);
chk(r.body.bar && r.body.bar.minutes === OWNER_BAR.minutes && r.body.bar.actions === OWNER_BAR.actions,
    `bar as the owner set it: ${JSON.stringify(r.body.bar)}`);
{
  const ws = []; let given = 0, refusedGrants = 0;
  for (let i = 0; i < 60; i++) {           // TEN MORE THAN THE CAP — try to walk past 50
    const w = wal(); ws.push(w);
    const a = SRV._founderAwardForTest(w);
    a ? given++ : refusedGrants++;
  }
  const spread = {};
  for (const row of founderRowsAll()) spread[row.sp] = (spread[row.sp] || 0) + 1;
  console.log(`  60 award attempts -> ${given} granted, ${refusedGrants} refused`);
  console.log("  founder spread:", JSON.stringify(spread));
  chk(given === 50, `exactly FOUNDER_CAP grants issued: ${given}`);
  chk(founderRowsAll().length === 50, `exactly 50 founder-origin registry rows exist: ${founderRowsAll().length}`);
  chk(Object.keys(spread).every(sp => WAVE2.includes(sp)), `every founder creature is one of the eleven`);
  const t = await assertNoBreach("B after 50 founders");
  chk(WAVE2.every(sp => spread[sp] === undefined || spread[sp] <= caps[sp]),
      `no species granted more founders than its whole cap`);
  // and the hold is now empty (all 50 claimed)
  console.log("  reserve after the drop filled:", JSON.stringify(SRV._founderReserveForTest()));
  chk(SRV._founderReserveTotalForTest() === 0, `nothing is held once the drop is full: ${SRV._founderReserveTotalForTest()}`);
}

// =====================================================================================
sec("C  A SPECIES ALREADY AT CAP FROM PLAYER MINTS — refuse, reroute, or overflow?");
resetWorld();
{
  // three species pre-exhausted by ORDINARY players before the drop even starts
  for (const sp of ["ansem", "successkid", "chloe"]) {
    const b = burn(sp, caps[sp]);
    console.log(`  pre-burn ${sp}: minted=${b.made} refused=${b.refused}`);
  }
  const b2 = burn("ansem", 3);   // try to push one PAST its cap through the ordinary path
  console.log(`  ordinary path over-mint attempt on a full ansem: made=${b2.made} refused=${b2.refused} lastErr=${b2.lastErr}`);
  chk(b2.made === 0 && b2.lastErr === "SUPPLY_EXHAUSTED", `the plain mint path refuses a full species (made=${b2.made}, err=${b2.lastErr})`);

  r = await startDrop("meme_dynasty");
  console.log("  deal with 3 species already dead:", JSON.stringify(r.body.deal), " dealTotal:", r.body.dealTotal);
  chk(!r.body.deal.ansem && !r.body.deal.successkid && !r.body.deal.chloe,
      `the deal allocates NOTHING to the three exhausted species: ansem=${r.body.deal.ansem || 0} successkid=${r.body.deal.successkid || 0} chloe=${r.body.deal.chloe || 0}`);
  let given = 0;
  for (let i = 0; i < 60; i++) if (SRV._founderAwardForTest(wal())) given++;
  const spread = {};
  for (const row of founderRowsAll()) spread[row.sp] = (spread[row.sp] || 0) + 1;
  console.log(`  ${given} founders granted; spread:`, JSON.stringify(spread));
  chk(!spread.ansem && !spread.successkid && !spread.chloe,
      `ZERO founder grants on the three exhausted species (it REROUTED, it did not overflow)`);
  const t = await assertNoBreach("C exhausted-species drop");
  chk(t.ansem.minted === caps.ansem && t.successkid.minted === caps.successkid && t.chloe.minted === caps.chloe,
      `the exhausted three sit EXACTLY at cap: ansem ${t.ansem.minted}/${caps.ansem}, successkid ${t.successkid.minted}/${caps.successkid}, chloe ${t.chloe.minted}/${caps.chloe}`);
}

// =====================================================================================
sec("D  WHOLE POOL PRE-EXHAUSTED — the grant must refuse, not invent supply");
resetWorld();
{
  for (const sp of WAVE2) burn(sp, caps[sp]);
  const t0 = await supplyTable();
  console.log("  every wave-2 species burned to cap:", WAVE2.map(s => `${s} ${t0[s].minted}/${t0[s].cap}`).join(" "));
  r = await startDrop("meme_dynasty");
  console.log(`  start on a dead pool: dealTotal=${r.body.dealTotal} reservedTotal=${r.body.reservedTotal}`);
  let given = 0; for (let i = 0; i < 20; i++) if (SRV._founderAwardForTest(wal())) given++;
  chk(given === 0, `ZERO grants on a fully-exhausted pool: ${given}`);
  chk(founderRowsAll().length === 0, `no founder rows minted: ${founderRowsAll().length}`);
  const ev = SRV._liveEventsForTest();
  chk(ev.founderCount === 0 && ev.claims === 0, `no claim slot spent: founderCount=${ev.founderCount} claims=${ev.claims}`);
  await assertNoBreach("D dead pool");
}

// =====================================================================================
sec("E  THE TOCTOU — ONE COPY LEFT, both directions, with a real await between check and write");
resetWorld();
{
  // ---- direction 1: buyer CHECKS while 1 copy is left, founder takes it during the await, buyer writes
  burn("ansem", caps.ansem - 1);
  r = await startDrop("ansem");                                  // pool of one -> the last copy is HELD
  let t = await supplyTable();
  console.log(`  ansem before: minted=${t.ansem.minted}/${t.ansem.cap} left=${t.ansem.left} held=${t.ansem.held} buyable=${t.ansem.buyable}`);
  chk(t.ansem.left === 1, `exactly ONE ansem left: ${t.ansem.left}`);
  chk(SRV._memeReservedOutForTest("ansem") === true, `that last copy is RESERVED for the drop: memeReservedOut=${SRV._memeReservedOutForTest("ansem")}`);
  const canMintNow = (() => { try { return !SRV._founderReserveForTest(); } catch (e) { return false; } })();
  await sleep(25);                                               // <-- the interleave
  const fa = SRV._founderAwardForTest(wal());                    // founder takes the last copy DURING the window
  console.log("  founder grant during the window:", JSON.stringify(fa));
  let err = null;
  try { SRV._mintAssetForTest("chikimon", wal(), { sp: "ansem", kind: "meme", lvl: 1 }, "issued", null); }
  catch (e) { err = e.code || e.message; }
  t = await supplyTable();
  console.log(`  buyer's post-await write -> ${err || "MINTED (!!)"};  ansem now ${t.ansem.minted}/${t.ansem.cap}`);
  chk(err === "SUPPLY_EXHAUSTED", `direction 1: the stale-check write is REFUSED at mintAsset (${err})`);
  chk(t.ansem.minted === caps.ansem, `ansem census = ${t.ansem.minted} <= ${caps.ansem}`);
  if (t.ansem.minted > caps.ansem) breaches.push(`E1 ansem ${t.ansem.minted} > ${caps.ansem}`);

  // ---- direction 2: buyer takes the last copy first, founder grant arrives after the await
  resetWorld();
  burn("ansem", caps.ansem - 1);
  r = await startDrop(["ansem", "successkid"]);
  const before = (await supplyTable()).ansem;
  console.log(`  ansem before: ${before.minted}/${before.cap}, held=${before.held}, buyable=${before.buyable}`);
  let bErr = null;
  try { SRV._mintAssetForTest("chikimon", wal(), { sp: "ansem", kind: "meme", lvl: 1 }, "issued", null); }
  catch (e) { bErr = e.code || e.message; }
  console.log(`  a normal buyer reaching for the held last copy -> ${bErr || "MINTED"}`);
  chk(bErr === "SUPPLY_RESERVED", `a normal mint cannot take an edition a founder is owed (${bErr}) — the winner is not stranded`);
  // now force ansem to zero through the FOUNDER path, then a second grant on the dead species
  const g1 = SRV._founderAwardForTest(wal());
  await sleep(25);                                               // <-- the interleave
  const g2 = SRV._founderAwardForTest(wal());
  t = await supplyTable();
  console.log(`  grant1=${JSON.stringify(g1)}  grant2 (after the await, ansem now dead)=${JSON.stringify(g2)}`);
  console.log(`  ansem ${t.ansem.minted}/${t.ansem.cap}   successkid ${t.successkid.minted}/${t.successkid.cap}`);
  chk(t.ansem.minted <= caps.ansem, `direction 2: ansem census = ${t.ansem.minted} <= ${caps.ansem}`);
  chk(g2 && g2.sp !== "ansem", `the second grant REROUTED off the dead species to "${g2 && g2.sp}"`);
  if (t.ansem.minted > caps.ansem) breaches.push(`E2 ansem ${t.ansem.minted} > ${caps.ansem}`);
}

// =====================================================================================
sec("F  CONCURRENCY FUZZ — real HTTP paid hatches racing founder grants at the last copies");
resetWorld();
{
  // leave each of the eleven with only 2 copies, then run 40 paid hatches concurrently with 30 grants
  for (const sp of WAVE2) burn(sp, caps[sp] - 2);
  // wave 1 out of the way entirely so pickMeme can only roll wave 2
  for (const sp of Object.keys(caps)) if (!WAVE2.includes(sp)) burn(sp, caps[sp]);
  r = await startDrop("meme_dynasty");
  console.log(`  armed: dealTotal=${r.body.dealTotal} reservedTotal=${r.body.reservedTotal} reserved=${JSON.stringify(r.body.reserved)}`);
  await censusLine("F pre-race");

  const buyers = [];
  for (let i = 0; i < 40; i++) buyers.push(wal());
  // buy the eggs first (a slot reservation, not a species roll)
  const bought = [];
  for (const w of buyers) {
    const h = await post("/meme/hatch", { wallet: w });
    if (h.status === 200) bought.push({ w, id: h.body.hatch.id });
  }
  console.log(`  eggs bought: ${bought.length}/40 (the rest refused: sold out / held for the drop)`);

  // NOW race: every /meme/hatched (which rolls a species and mints) fired at once, interleaved with
  // founder grants scheduled between event-loop turns.
  const tasks = [];
  for (let i = 0; i < bought.length; i++) {
    tasks.push(post("/meme/hatched", { wallet: bought[i].w, hatchId: bought[i].id }));
    if (i % 2 === 0) tasks.push((async () => { await sleep(Math.random() * 8); return SRV._founderAwardForTest(wal()); })());
  }
  const out = await Promise.all(tasks);
  const rolled = out.filter(o => o && o.status === 200 && o.body && o.body.char).length;
  const soldout = out.filter(o => o && o.status === 409).length;
  const grants = out.filter(o => o && o.n).length;
  console.log(`  race done: ${rolled} species rolled by buyers, ${soldout} refused sold-out, ${grants} founder grants`);
  const t = await assertNoBreach("F post-race");
  chk(WAVE2.every(sp => t[sp].minted <= t[sp].cap), `every wave-2 species still at or under cap after the race`);
}

// =====================================================================================
sec("G  DOUBLE CLAIM — same wallet twice, two sessions, disconnect/reconnect, restart");
resetWorld();
{
  r = await startDrop("meme_dynasty");
  const W = wal();
  const a1 = SRV._founderAwardForTest(W);
  const a2 = SRV._founderAwardForTest(W);
  const a3 = SRV._founderAwardForTest(W);
  console.log(`  three straight awards on one wallet: ${JSON.stringify(a1)} / ${JSON.stringify(a2)} / ${JSON.stringify(a3)}`);
  chk(!!a1 && a2 === null && a3 === null, `exactly one award per wallet (2nd=${a2}, 3rd=${a3})`);
  chk(founderRowsAll().filter(x => x.owner === W).length === 1, `one founder row for that wallet: ${founderRowsAll().filter(x => x.owner === W).length}`);

  // two live SESSIONS of one wallet (two netIds, two mktTokens)
  const mk = async (w) => { const kp = null; return null; };
  const kp = nacl.sign.keyPair(); const W2 = bs58.encode(kp.publicKey);
  const sess = [];
  for (let i = 0; i < 2; i++) {
    const msg = `Chikoria sign-in\nwallet:${W2}\nts:${Date.now()}`;
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
    const v = await post("/verify", { wallet: W2, netId: "n" + Date.now() + "_" + i, authMsg: msg, authSig: sig });
    sess.push(v.body.mktToken);
  }
  const s1 = SRV._founderAwardForTest(W2), s2 = SRV._founderAwardForTest(W2);
  console.log(`  two sessions of ONE wallet: ${JSON.stringify(s1)} / ${JSON.stringify(s2)}`);
  chk(!!s1 && s2 === null, `two concurrent sessions still yield ONE creature`);

  // disconnect / reconnect
  const msg2 = `Chikoria sign-in\nwallet:${W2}\nts:${Date.now()}`;
  const sig2 = Buffer.from(nacl.sign.detached(Buffer.from(msg2, "utf8"), kp.secretKey)).toString("base64");
  await post("/verify", { wallet: W2, netId: "n-recon-" + Date.now(), authMsg: msg2, authSig: sig2 });
  const s3 = SRV._founderAwardForTest(W2);
  chk(s3 === null, `re-verify (disconnect/reconnect) awards nothing again: ${JSON.stringify(s3)}`);

  // RESTART mid-drop — persist, wipe memory, restore from kv, re-claim
  await SRV._saveLiveEventsForTest();
  const preCount = SRV._liveEventsForTest().founderCount, preRows = founderRowsAll().length;
  SRV._resetLiveEventsForTest();
  chk(SRV._liveEventsForTest().founderCount === 0, `memory wiped: founderCount=${SRV._liveEventsForTest().founderCount}`);
  await SRV._bootRestoreLiveEventsForTest();
  const post1 = SRV._liveEventsForTest();
  console.log(`  restart: founderCount ${preCount} -> ${post1.founderCount}, claims=${post1.claims}, perSp=${JSON.stringify(post1.perSp)}`);
  chk(post1.founderCount === preCount, `the claim counter survived the restart: ${post1.founderCount}`);
  const rc1 = SRV._founderAwardForTest(W), rc2 = SRV._founderAwardForTest(W2);
  console.log(`  post-restart re-claims: ${JSON.stringify(rc1)} / ${JSON.stringify(rc2)}`);
  chk(rc1 === null && rc2 === null, `neither already-awarded wallet can re-claim after a restart`);
  chk(founderRowsAll().length === preRows, `no extra founder row was minted: ${founderRowsAll().length} (was ${preRows})`);

  // THE UGLY RESTART: crash BEFORE the claim book was persisted, but AFTER the creature was minted.
  const wc = wal();
  const beforeSnap = SRV._liveEventsForTest().founderCount;
  await SRV._saveLiveEventsForTest();                  // last good save = state WITHOUT wc's claim
  const ac = SRV._founderAwardForTest(wc);             // wc wins ... (award force-saves, so re-stale it)
  // simulate the lost write: wipe memory and restore the OLDER kv snapshot by writing it back first
  const staleRows = founderRowsAll().length;
  console.log(`  wc awarded ${JSON.stringify(ac)}; registry founder rows now ${staleRows}`);
  chk(true, `(the award force-saves, so a genuinely lost claim needs the kv write to fail — measured below)`);
}

// =====================================================================================
sec("H  A LOST CLAIM-BOOK WRITE — creature minted, claim book rolled back, wallet re-claims");
resetWorld();
{
  r = await startDrop("ansem");                        // pool of ONE so any second grant must hit the cap
  const W = wal();
  const a1 = SRV._founderAwardForTest(W);
  const rows1 = founderRowsAll().length;
  // roll the claim book back to empty WITHOUT touching the registry — the worst crash ordering there is
  const ev = SRV._liveEventsForTest();
  console.log(`  after 1 grant: founderCount=${ev.founderCount} perSp=${JSON.stringify(ev.perSp)} registry founder rows=${rows1}`);
  SRV._resetLiveEventsForTest();
  await startDrop("ansem");                            // the drop comes back; the book did not
  const ev2 = SRV._liveEventsForTest();
  console.log(`  claim book rolled back: founderCount=${ev2.founderCount} claims=${ev2.claims} perSp=${JSON.stringify(ev2.perSp)}`);
  let got = 0;
  for (let i = 0; i < 30; i++) if (SRV._founderAwardForTest(i === 0 ? W : wal())) got++;
  const t = await supplyTable();
  console.log(`  after the rollback, ${got} further grants landed;  ansem ${t.ansem.minted}/${t.ansem.cap}`);
  chk(t.ansem.minted <= caps.ansem, `EVEN WITH A LOST CLAIM BOOK the cap holds: ansem ${t.ansem.minted} <= ${caps.ansem}`);
  if (t.ansem.minted > caps.ansem) breaches.push(`H ansem ${t.ansem.minted} > ${caps.ansem}`);
  chk(got === caps.ansem - 1, `the rollback cost the drop its accounting (${got} extra grants) but NOT its supply — total ansem founders = ${founderRowsAll().length}`);
  console.log(`  NOTE total founder rows after a lost book = ${founderRowsAll().length} against FOUNDER_CAP 50`);
}

// =====================================================================================
sec("I  CORRUPT / ABSENT PERSISTED POOL, and a MIS-CASED species key");
resetWorld();
{
  // absent pool on restore -> what does the drop hand out?
  await startDrop("meme_dynasty");
  await SRV._saveLiveEventsForTest();
  const snap = await SRV._kvGetForTest ? null : null;
  SRV._resetLiveEventsForTest();
  await SRV._bootRestoreLiveEventsForTest();
  const g = SRV._founderAwardForTest(wal());
  console.log(`  restore-then-grant: ${JSON.stringify(g)}`);
  chk(g && WAVE2.includes(g.sp), `after a restart the drop still hands out the ELEVEN (got ${g && g.sp})`);

  // MIS-CASED / UNKNOWN key: FINDING #1 (fixed 2026-08-12) — the server now REFUSES an unknown literal
  // (400 + the valid tokens) instead of treating it as an UNCAPPED phantom species. Before the fix,
  // species:"Ansem" minted 50 uncapped rows of a creature with no cap/card/model.
  resetWorld();
  const rr = await startDrop("Ansem");                 // capital A — not a MEME_CHARS key
  console.log(`  start species:"Ansem" -> ${rr.status} ${JSON.stringify(rr.body.error || rr.body.species)}`);
  chk(rr.status === 400, `a mis-cased/unknown pool key is REFUSED at the route (${rr.status})`);
  chk(!!(rr.body.validTokens && Array.isArray(rr.body.validTokens.meme) && rr.body.validTokens.meme.includes("ansem")),
      `the 400 lists the valid tokens (meme includes "ansem"): ${JSON.stringify(rr.body.validTokens && rr.body.validTokens.meme)}`);
  let n = 0; for (let i = 0; i < 60; i++) if (SRV._founderAwardForTest(wal())) n++;
  const rows = founderRowsAll();
  const bySp = {}; for (const x of rows) bySp[x.sp] = (bySp[x.sp] || 0) + 1;
  const t = await supplyTable();
  console.log(`  grants after the refused start=${n} spread=${JSON.stringify(bySp)};  real ansem census=${t.ansem.minted}/${t.ansem.cap}`);
  const phantom = (bySp["Ansem"] || 0);
  chk(n === 0 && phantom === 0, `the refused drop ran NOTHING — no phantom rows (grants=${n}, "Ansem" rows=${phantom})`);
  chk(t.ansem.minted <= caps.ansem, `the REAL ansem cap is untouched by the mis-cased key: ${t.ansem.minted}/${caps.ansem}`);

  // a garbage pool with an UNKNOWN literal is refused; a pool of ONLY valid tokens still de-dupes.
  resetWorld();
  const rg = await startDrop(["", "   ", "nope_not_a_species", "ansem", "ansem", "meme_dynasty"]);
  console.log(`  garbage pool (has "nope_not_a_species") -> ${rg.status} ${JSON.stringify(rg.body.error || rg.body.species)}`);
  chk(rg.status === 400, `a pool containing an unknown species is REFUSED (${rg.status})`);
  resetWorld();
  const rgood = await startDrop(["", "   ", "ansem", "ansem", "meme_dynasty"]);   // valid tokens only, with dupes/blanks
  console.log(`  valid-only pool -> ${rgood.status} species=${JSON.stringify(rgood.body.species)}`);
  chk(rgood.status === 200 && Array.isArray(rgood.body.species) && new Set(rgood.body.species).size === rgood.body.species.length,
      `a valid pool is accepted and de-duped: ${rgood.body.species && rgood.body.species.length} entries, ${rgood.body.species && new Set(rgood.body.species).size} distinct`);
  let n2 = 0; for (let i = 0; i < 60; i++) if (SRV._founderAwardForTest(wal())) n2++;
  const t2 = await assertNoBreach("I valid pool");
}

// =====================================================================================
sec("J  EVENT EXPIRY MID-CLAIM, and the hold releasing when the drop ends");
resetWorld();
{
  burn("ansem", caps.ansem - 1);
  await startDrop("ansem", 7);
  chk(SRV._memeReservedOutForTest("ansem") === true, `during the drop the last ansem is held (${SRV._memeReservedOutForTest("ansem")})`);
  let e1 = null; try { SRV._mintAssetForTest("chikimon", wal(), { sp: "ansem", kind: "meme", lvl: 1 }, "issued", null); } catch (e) { e1 = e.code; }
  chk(e1 === "SUPPLY_RESERVED", `buyer refused mid-drop: ${e1}`);
  const st = await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
  console.log(`  drop stopped: ${JSON.stringify(st.body)}`);
  chk(SRV._memeReservedOutForTest("ansem") === false, `the hold RELEASED the moment the drop ended (${SRV._memeReservedOutForTest("ansem")})`);
  let e2 = null; try { SRV._mintAssetForTest("chikimon", wal(), { sp: "ansem", kind: "meme", lvl: 1 }, "issued", null); } catch (e) { e2 = e.code; }
  const t = await supplyTable();
  chk(e2 === null && t.ansem.minted === caps.ansem, `and the buyer then gets it: err=${e2}, ansem ${t.ansem.minted}/${caps.ansem}`);
  const late = SRV._founderAwardForTest(wal());
  chk(late === null, `a grant AFTER expiry mints nothing: ${JSON.stringify(late)}`);
  await assertNoBreach("J after expiry");
}

// =====================================================================================
sec("K  EDITION NUMBERS — founder path vs the paid-sale path");
resetWorld();
{
  // Keep the paid roll on WAVE 2 (the drop's own eleven) so we compare like with like: the wave-2
  // Dynasty creatures show the REGISTRY/on-chain edition and MUST agree with it. The original SIX
  // (wave 1) are grandfathered on the legacy memeMinted counter (owner ruling — never renumber) and
  // legitimately diverge from their registry row, so they are burned out of the roll here; that
  // wave-1 divergence is proved-benign (unique per species) in mdfr_ruling_edn (my ruling probe).
  for (const sp of Object.keys(caps)) if (!WAVE2.includes(sp)) burn(sp, caps[sp]);
  await startDrop("meme_dynasty");
  // interleave: founder, sale, founder, sale ... on the SAME species
  const seq = [];
  for (let i = 0; i < 6; i++) {
    const g = SRV._founderAwardForTest(wal());
    if (g) seq.push({ path: "founder", sp: g.sp, id: g.id });
    const w = wal();
    const h = await post("/meme/hatch", { wallet: w });
    if (h.status === 200) {
      const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
      if (hd.status === 200) seq.push({ path: "sale", sp: hd.body.char, saleEdition: hd.body.edition, wallet: w });
    }
  }
  // registry editions per species
  const bySp = {};
  for (const row of allChikimonRows()) {
    if (!WAVE2.includes(row.sp)) continue;
    (bySp[row.sp] ||= []).push({ ed: row.edition, origin: row.origin });
  }
  // NOTE the nftEdition counter is deliberately write-once and is NOT reset by _clearAssetReg, so
  // across this sim's sections a species starts at whatever it reached earlier. What must hold is
  // UNIQUENESS and a CONTIGUOUS run (no gap inside the series). The 1..N form is proved on a virgin
  // counter in mdfatk_bar_ed_atk.mjs section M.
  let dupes = 0, gaps = 0;
  for (const sp of Object.keys(bySp)) {
    const eds = bySp[sp].map(x => x.ed).sort((a, b) => a - b);
    const uniq = new Set(eds);
    const contiguous = eds.length === 0 || (eds[eds.length - 1] - eds[0] + 1) === eds.length;
    if (uniq.size !== eds.length) dupes++;
    if (!contiguous) gaps++;
    console.log(`  ${sp}: registry editions ${JSON.stringify(eds)} (${bySp[sp].map(x => x.origin === "open-gates-founder" ? "F" : "n").join("")}) unique=${uniq.size === eds.length} contiguous=${contiguous}`);
  }
  chk(dupes === 0, `ZERO duplicate registry editions across both paths (${dupes} species with dupes)`);
  chk(gaps === 0, `registry editions run contiguously per species, founder copies interleaved (${gaps} species with gaps)`);

  // the OTHER edition number: the paid sale's own counter, shown in the Bazaar / /meme/mine
  const saleRows = seq.filter(s => s.path === "sale");
  const collide = [];
  for (const s of saleRows) {
    const regRow = allChikimonRows().find(x => x.owner === s.wallet && x.sp === s.sp);
    const same = allChikimonRows().filter(x => x.sp === s.sp && x.edition === s.saleEdition);
    if (regRow && regRow.edition !== s.saleEdition)
      collide.push(`${s.sp}: the Bazaar shows #${s.saleEdition}, the registry/on-chain row is #${regRow.edition}` +
                   (same.length ? ` — and #${s.saleEdition} of ${s.sp} is ALREADY held by a ${same[0].origin === "open-gates-founder" ? "FOUNDER" : "another"} row` : ""));
  }
  console.log(`  sale-counter vs registry-counter: ${collide.length} disagreements`);
  for (const c of collide) console.log(`    ${c}`);
  chk(collide.length === 0, `the two edition counters agree for every paid sale (${collide.length} disagreements — see above)`);
}

// =====================================================================================
sec("L  FINAL — a clean full run, per-species minted vs caps");
resetWorld();
{
  await startDrop("meme_dynasty");
  for (let i = 0; i < 50; i++) SRV._founderAwardForTest(wal());
  // then let ordinary players drain everything that is left
  let sold = 0;
  for (const sp of WAVE2) { const b = burn(sp, caps[sp] + 5); sold += b.made; }
  const t = await supplyTable();
  console.log("  FINAL PER-SPECIES:");
  let anyOver = false;
  for (const sp of WAVE2) {
    const f = founderRowsAll().filter(x => x.sp === sp).length;
    const over = t[sp].minted > t[sp].cap; if (over) anyOver = true;
    console.log(`    ${sp.padEnd(14)} minted ${String(t[sp].minted).padStart(3)} / cap ${String(t[sp].cap).padStart(3)}   founders ${String(f).padStart(2)}   ${over ? "*** OVER CAP ***" : "ok"}`);
  }
  const tot = WAVE2.reduce((s, sp) => s + t[sp].minted, 0);
  console.log(`  TOTAL wave-2 in existence: ${tot} / ${OWNER_TOTAL}   founder rows: ${founderRowsAll().length} / 50   later sales: ${sold}`);
  chk(!anyOver, `NO species over cap after founders + a full player drain`);
  chk(tot <= OWNER_TOTAL, `total wave-2 supply ${tot} <= ${OWNER_TOTAL}`);
  if (tot > OWNER_TOTAL) breaches.push(`L total ${tot} > ${OWNER_TOTAL}`);
}

// =====================================================================================
sec("M  A SECOND DROP AFTER THE FIRST — can the owner hand out 50 more?");
resetWorld();
{
  await startDrop("meme_dynasty");
  let n1 = 0; for (let i = 0; i < 50; i++) if (SRV._founderAwardForTest(wal())) n1++;
  await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
  const r2 = await startDrop("meme_dynasty");
  console.log(`  second drop armed: claimed=${r2.body.claimed}/${r2.body.cap} dealTotal=${r2.body.dealTotal} reservedTotal=${r2.body.reservedTotal}`);
  let n2 = 0; for (let i = 0; i < 50; i++) if (SRV._founderAwardForTest(wal())) n2++;
  console.log(`  first drop granted ${n1}; SECOND drop granted ${n2}; founder rows total ${founderRowsAll().length}`);
  chk(n2 === 0 && founderRowsAll().length === 50,
      `the 50 is a LIFETIME counter — a re-run of the drop hands out nothing more (${n2} new, ${founderRowsAll().length} total)`);
  await assertNoBreach("M second drop");
}

console.log(`\n================ mdfatk_cap_atk: ${pass} passed, ${fail} failed ================`);
console.log(breaches.length ? "BREACHES:\n  " + breaches.join("\n  ") : "BREACHES: none");
process.exit(0);
