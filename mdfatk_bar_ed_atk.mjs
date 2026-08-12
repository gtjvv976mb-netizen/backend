// mdfatk_bar_ed_atk.mjs — ADVERSARIAL part 2, in a FRESH process so every edition counter starts
// at zero: (M) edition collisions between the founder path and the paid path, (N) the paid egg the
// hold can strand, (O) forging the sybil bar, (P) census sanity around a founder creature.
// Real server.js in-process, memory store, dead RPC, throwaway keys. Live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59118";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39472";
process.env.ADMIN_KEY = "atk2-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_REG_ALL = "1";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN; delete process.env.MARKET_URL;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP; delete process.env.FOUNDER_PER_SPECIES;
delete process.env.FOUNDER_MIN_MINUTES; delete process.env.FOUNDER_MIN_ACTIONS;

const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(1400);

let pass = 0, fail = 0; const notes = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n========== ${s} ==========`);
const wal = () => bs58.encode(nacl.sign.keyPair().publicKey);
const caps = SRV._memeCapsForTest(), WAVE2 = SRV._memeWave2ForTest();
const startDrop = (species, days = 7) => post("/admin/event/start", { key: KEY, event: "founder_drop", days, species });
const stopDrop = () => post("/admin/event/stop", { key: KEY, event: "founder_drop" });
const burn = (sp, n) => { let m = 0; for (let i = 0; i < n; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp, kind: "meme", lvl: 1 }, "issued", null); m++; } catch (e) {} } return m; };
const rows = (sp) => SRV._regAllForTest().filter(r => r.type === "chikimon" && r.sp === sp);
const supply = async () => (await get("/meme/supply")).body.chars;

// =====================================================================================
sec("M  EDITION COLLISION — founder path vs paid path, on a virgin counter");
{
  // every other character retired so the paid roll can only land on ansem
  for (const k of Object.keys(caps)) if (k !== "ansem") burn(k, caps[k]);
  console.log(`  ansem registry rows before anything: ${rows("ansem").length}; nft edition counter is virgin`);

  await startDrop("meme_dynasty");
  const g = SRV._founderAwardForTest(wal());
  const fRow = SRV._regAllForTest().find(r => r.id === g.id);
  console.log(`  FOUNDER won ${g.sp}, registry edition #${fRow.edition}, origin ${fRow.origin}`);
  chk(fRow.edition === 1, `the founder creature is ansem registry edition #${fRow.edition}`);
  await stopDrop();   // hold releases so a normal buyer can reach the species

  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
  const sRow = SRV._regAllForTest().find(r => r.owner === w && r.sp === "ansem");
  const mine = await get(`/meme/mine?wallet=${w}`);
  console.log(`  PAID BUYER rolled ${hd.body.char}: /meme/hatched says edition #${hd.body.edition} of ${hd.body.cap}`);
  console.log(`  /meme/mine shows: ${JSON.stringify(mine.body.items[0])}`);
  console.log(`  ...but that same creature's registry row (the number nftAssetName / the on-chain NFT uses) is #${sRow.edition}`);
  const collision = rows("ansem").filter(r => r.edition === 1).length;
  console.log(`  registry editions now in existence for ansem: ${JSON.stringify(rows("ansem").map(r => ({ ed: r.edition, origin: r.origin })))}`);
  chk(hd.body.edition === sRow.edition,
      `the Bazaar number and the registry/on-chain number are the SAME creature number (bazaar #${hd.body.edition} vs registry #${sRow.edition})`);
  if (hd.body.edition !== sRow.edition) {
    notes.push(`EDITION COLLISION: the founder's ansem is registry #${fRow.edition}; the first PAID ansem is advertised to its buyer as "#${hd.body.edition} of ${hd.body.cap}" while its registry/on-chain row is #${sRow.edition}. Two different creatures are both "Ansem #1".`);
    console.log(`  >>> ${notes[notes.length - 1]}`);
  }
  // is the registry series itself sound?
  const eds = rows("ansem").map(r => r.edition).sort((a, b) => a - b);
  chk(new Set(eds).size === eds.length && JSON.stringify(eds) === JSON.stringify(eds.map((_, i) => i + 1)),
      `registry ansem editions are unique and 1..N: ${JSON.stringify(eds)}`);
  const t = await supply();
  chk(t.ansem.minted <= t.ansem.cap, `ansem census ${t.ansem.minted}/${t.ansem.cap}`);
}

// =====================================================================================
sec("N  CAN THE HOLD STRAND A PAID EGG? (buy succeeds, hatch refuses)");
{
  SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
  // route 2 (in-game / registry) drains everything except two ansem — memeHatches stays EMPTY,
  // so memeReserved() (the number /meme/hatch gates on) still reads 0.
  for (const k of Object.keys(caps)) burn(k, k === "ansem" ? caps[k] - 2 : caps[k]);
  const r = await startDrop("meme_dynasty");
  const t0 = await supply();
  console.log(`  ansem: minted ${t0.ansem.minted}/${t0.ansem.cap}, left ${t0.ansem.left}, held ${t0.ansem.held}, buyable ${t0.ansem.buyable}`);
  console.log(`  founderReserveTotal=${SRV._founderReserveTotalForTest()}  memeReserved(hatch rows)=0  MEME_TOTAL=285`);
  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  console.log(`  POST /meme/hatch (the paid step) -> ${h.status} ${JSON.stringify(h.body.hatch || h.body.error)}`);
  chk(h.status !== 200, `the PAID step refuses when nothing is actually buyable (got ${h.status})`);
  if (h.status === 200) {
    const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
    console.log(`  POST /meme/hatched -> ${hd.status} ${JSON.stringify(hd.body)}`);
    const still = SRV._regAllForTest().filter(x => x.owner === w).length;
    notes.push(`STRANDED PAID EGG: /meme/hatch took the payment (200) while every remaining edition was held or gone; /meme/hatched then answered ${hd.status} "${hd.body.error}". The gate compares memeReserved()+founderReserveTotal() against the NOMINAL 285, and memeReserved() only counts memeHatches rows — it is blind to every creature born through the in-game/registry route.`);
    console.log(`  >>> ${notes[notes.length - 1]}`);
    chk(hd.status === 409, `the hatch is refused ${hd.status} — the egg row survives for a retry (${still} registry rows for the buyer)`);
    const again = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
    chk(again.status === 409, `and it is still retryable rather than consumed (${again.status})`);
  }
  const t1 = await supply();
  chk(t1.ansem.minted <= t1.ansem.cap, `ansem still ${t1.ansem.minted}/${t1.ansem.cap}`);
}

// =====================================================================================
sec("O  FORGING THE SYBIL BAR — 30 minutes AND 10 actions");
{
  SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
  const r = await startDrop("meme_dynasty");
  const BAR_MS = r.body.bar.minutes * 60000, BAR_ACTS = r.body.bar.actions, TICK = 30000;
  console.log(`  the bar the server states: ${JSON.stringify(r.body.bar)}`);

  let _n = 0;
  const mk = async () => {
    const kp = nacl.sign.keyPair(), wallet = bs58.encode(kp.publicKey);
    const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("base64");
    const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg: msg, authSig: sig });
    return { wallet, mktToken: v.body.mktToken };
  };
  const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 2000, z: -204 });
  const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 1, rod: 0 });
  const A = (w) => SRV._founderActivityForTest(w) || { ms: 0, acts: 0 };
  const claim = (w) => SRV._founderClaimForTest(w);
  let CLK = Date.now();
  const walk = (ws, ticks) => { let st = 0; for (let k = 0; k < ticks; k++) { CLK += TICK; for (const w of ws) if (SRV._stampPresenceForTest(w, CLK - 500)) st++; SRV._founderTickForTest(CLK); } return st; };
  const actN = async (ws, n, gap = 900) => { let unc = 0; for (let k = 0; k < n; k++) { await Promise.all(ws.map(move)); const rs = await Promise.all(ws.map(fish)); unc += rs.filter(x => !(x.status === 200 && x.body.counted === true)).length; if (k < n - 1) await sleep(gap); } return unc; };

  // ---- O1  29 MINUTES + 100 ACTIONS
  const W29 = await mk(); await move(W29);
  walk([W29.wallet], 1);                                   // baseline sweep
  const spamStart = Date.now();
  let counted = 0, sent = 0;
  for (let i = 0; i < 100; i++) { await move(W29); const f = await fish(W29); sent++; if (f.body.counted) counted++; await sleep(90); }
  const spamMs = Date.now() - spamStart;
  walk([W29.wallet], 57);                                  // 57 x 30s = 28.5 min
  console.log(`  ACTION SPAM: ${sent} fish reports in ${spamMs} ms -> ${counted} COUNTED (server floor ${800} ms/report)`);
  console.log(`  W29: ms=${A(W29.wallet).ms} (${(A(W29.wallet).ms / 60000).toFixed(1)} min), acts=${A(W29.wallet).acts}, claim=${JSON.stringify(claim(W29.wallet))}`);
  chk(A(W29.wallet).ms < BAR_MS, `presence parked UNDER the arm: ${(A(W29.wallet).ms / 60000).toFixed(1)} min < 30`);
  chk(A(W29.wallet).acts >= BAR_ACTS, `action arm massively over: acts=${A(W29.wallet).acts} >= ${BAR_ACTS}`);
  chk(claim(W29.wallet) === null, `29 MIN + ${A(W29.wallet).acts} ACTIONS AWARDS NOTHING`);
  chk(counted < sent, `spamming does not inflate the count 1:1 — ${counted}/${sent} counted (800ms floor holds)`);

  // ---- O2  31 MINUTES + 9 ACTIONS
  const W31 = await mk(); await move(W31);
  walk([W31.wallet], 1);
  await actN([W31], BAR_ACTS - 1);
  const st = walk([W31.wallet], 64);                       // 64 x 30s = 32 min
  console.log(`  W31: ms=${A(W31.wallet).ms} (${(A(W31.wallet).ms / 60000).toFixed(1)} min), acts=${A(W31.wallet).acts}, claim=${JSON.stringify(claim(W31.wallet))} (${st} ticks stamped)`);
  chk(A(W31.wallet).ms >= BAR_MS && A(W31.wallet).acts === BAR_ACTS - 1, `over the time arm, one action short`);
  chk(claim(W31.wallet) === null, `31 MIN + 9 ACTIONS AWARDS NOTHING`);
  // the 10th closes it
  await sleep(900); await move(W31); await fish(W31);
  const c31 = claim(W31.wallet);
  console.log(`  the 10th action: ${JSON.stringify(c31)}`);
  chk(!!c31, `BOTH arms -> awarded ${c31 && c31.sp} #${c31 && c31.n}`);
  chk(c31 && WAVE2.includes(c31.sp), `and the prize is one of the eleven Dynasty species: ${c31 && c31.sp}`);

  // ---- O3  CLOCK MANIPULATION: one giant forged jump
  const WC = await mk(); await move(WC);
  walk([WC.wallet], 1);
  const before = A(WC.wallet).ms;
  CLK += 6 * 3600000; SRV._stampPresenceForTest(WC.wallet, CLK - 500); SRV._founderTickForTest(CLK);
  const gained = A(WC.wallet).ms - before;
  console.log(`  a forged SIX-HOUR clock jump credited ${gained} ms (clamp is ${TICK} ms/sweep)`);
  chk(gained === TICK, `the clock jump is CLAMPED to one sweep: ${gained} ms`);
  chk(claim(WC.wallet) === null, `and it awards nothing: ${JSON.stringify(claim(WC.wallet))}`);
  // client-supplied timestamps in /world/move buy nothing either
  await post("/world/move", { wallet: WC.wallet, mktToken: WC.mktToken, x: 2000, z: -204, ts: Date.now() - 86400000 });
  walk([WC.wallet], 1);
  console.log(`  after posting a 24h-old client ts: ms=${A(WC.wallet).ms}`);
  chk(A(WC.wallet).ms <= TICK * 3, `a forged client ts buys no presence: ms=${A(WC.wallet).ms}`);

  // ---- O4  UNPROVEN / DEMO
  const PUP = wal();
  await post("/world/move", { wallet: PUP, x: 2000, z: -204 });
  const pf = await post("/world/fish/report", { wallet: PUP, tier: 1, rod: 0 });
  walk([PUP], 70);
  console.log(`  tokenless wallet: fish/report -> ${pf.status}; activity=${JSON.stringify(SRV._founderActivityForTest(PUP))}`);
  chk(pf.status === 403 && SRV._founderActivityForTest(PUP) === null, `an unproven wallet accrues NOTHING over 70 stamped ticks`);
  const DEMO = { wallet: "ndemo_" + Date.now(), mktToken: "" };
  await move(DEMO); await actN([DEMO], 12, 850); walk([DEMO.wallet], 70);
  chk(SRV._founderActivityForTest(DEMO.wallet) === null, `a demo/net_id session accrues NOTHING: ${JSON.stringify(SRV._founderActivityForTest(DEMO.wallet))}`);

  // ---- O5  PARALLEL FARM: does one operator's 30 minutes cover many wallets at once?
  const farm = []; for (let i = 0; i < 6; i++) farm.push(await mk());
  await Promise.all(farm.map(move));
  walk(farm.map(f => f.wallet), 1);
  await actN(farm, BAR_ACTS, 850);
  walk(farm.map(f => f.wallet), 64);
  const won = farm.filter(f => claim(f.wallet));
  console.log(`  6 wallets driven CONCURRENTLY through both arms -> ${won.length} awards: ${won.map(f => claim(f.wallet).sp).join(", ")}`);
  console.log(`  per-wallet cost: ${BAR_ACTS} fish reports (>=800ms apart = ~${(BAR_ACTS * 0.8).toFixed(1)}s) + a /world/move ping at least every 12s for 30 WALL-CLOCK minutes (~150 pings).`);
  console.log(`  the 30 minutes are WALL CLOCK and SHARED — N wallets pinged in parallel all clear the arm in the same 30 minutes.`);
  chk(won.length === 6, `all 6 parallel wallets cleared the bar in ONE 30-minute window: ${won.length}/6`);
  notes.push(`SYBIL ECONOMICS (measured): the presence arm is wall-clock and accrues in PARALLEL. 6/6 concurrent wallets cleared both arms from one driver. Extrapolated, 50 throwaway wallets = ~50 x 150 = 7,500 /world/move pings + 500 fish reports over ONE 30-minute window (~4.5 req/s) to take the entire drop. This is the owner's chosen bar, unchanged by this task — but the prize is now 28% of a hard-capped 180-piece collection instead of uncapped legendaries.`);
  console.log(`  >>> ${notes[notes.length - 1]}`);

  const t = await supply();
  const over = WAVE2.filter(sp => t[sp].minted > t[sp].cap);
  console.log("  CENSUS after the bar section: " + WAVE2.map(sp => `${sp} ${t[sp].minted}/${t[sp].cap}`).join("  "));
  chk(over.length === 0, `no species over cap: ${over.length}`);
}

// =====================================================================================
sec("P  CENSUS SANITY AROUND A FOUNDER CREATURE (transfer, double-count, rarity display)");
{
  SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
  await startDrop("meme_dynasty");
  const W = wal();
  const g = SRV._founderAwardForTest(W);
  let t = await supply();
  console.log(`  after ONE founder grant: ${g.sp} census=${t[g.sp].minted} (the grant writes BOTH a registry row and a ledger unit)`);
  chk(t[g.sp].minted === 1, `one creature counts ONCE, not twice: ${t[g.sp].minted}`);
  // hand it to someone else
  const W2 = wal();
  const ok = SRV._transferAssetForTest(g.id, W, W2, "atk-transfer");
  t = await supply();
  console.log(`  after transferring it to another wallet: census=${t[g.sp].minted} (transfer ok=${!!ok})`);
  chk(t[g.sp].minted === 1, `a transferred founder creature still counts exactly ONCE: ${t[g.sp].minted}`);
  if (t[g.sp].minted !== 1) notes.push(`CENSUS DRIFT on transfer: ${g.sp} reads ${t[g.sp].minted} for 1 real creature — the ledger unit stays with the old wallet.`);
  // drain the species to its cap through the ordinary path and confirm the cap binds exactly
  const made = burn(g.sp, caps[g.sp] + 5);
  t = await supply();
  console.log(`  ordinary mints after the grant: ${made} landed; ${g.sp} ${t[g.sp].minted}/${t[g.sp].cap}`);
  chk(t[g.sp].minted === t[g.sp].cap, `the species lands EXACTLY on its cap: ${t[g.sp].minted}/${t[g.sp].cap}`);
  chk(made === caps[g.sp] - 1, `and the founder's copy consumed exactly one slot (${made} = ${caps[g.sp]} - 1)`);
}

console.log(`\n================ mdfatk_bar_ed_atk: ${pass} passed, ${fail} failed ================`);
console.log(notes.length ? "FINDINGS:\n  - " + notes.join("\n  - ") : "FINDINGS: none");
process.exit(0);
