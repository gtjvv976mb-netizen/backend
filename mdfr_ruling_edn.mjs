// mdfr_ruling_edn.mjs — OWNER RULING (2026-08-12): "do not issue a meme dynasty chikimon with the
// same number." NO two Meme Dynasty chikimon of the same species may EVER carry the same displayed
// number, across the founder path, the paid path, and every surface that shows a number. This drives
// a CONCURRENT mixed run (founder grants racing paid hatches) and asserts, per species, that every
// issued number is unique — printing the full list per species. A duplicate FAILS the whole run.
// Real server.js in-process; memory store; dead RPC; throwaway keys. Live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59485";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39485";
process.env.ADMIN_KEY = "mdfr-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_REG_ALL = "1";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL; delete process.env.MARKET_URL;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP;

const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(1400);

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const wal = () => bs58.encode(nacl.sign.keyPair().publicKey);
const caps = SRV._memeCapsForTest();
const WAVE2 = SRV._memeWave2ForTest();
const startDrop = (species) => post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species });
const reset = () => { SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._clearMemeHatchesForTest(); SRV._resetLiveEventsForTest(); for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0); };
const burn = (sp, n) => { for (let i = 0; i < n; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp, kind: "meme", lvl: 1 }, "issued", null); } catch (e) {} } };
const regRowsOf = (sp) => SRV._regAllForTest().filter(r => r.type === "chikimon" && r.sp === sp);

console.log("\n========== CONCURRENT MIXED RUN OVER WAVE-2 (founder grants racing paid hatches) ==========");
{
  reset();
  for (const sp of Object.keys(caps)) if (!WAVE2.includes(sp)) burn(sp, caps[sp]);   // roll can only land on wave-2
  await startDrop("meme_dynasty");

  // displayed numbers, collected as a player would see them: founder shows its registry edition; a
  // paid buyer shows /meme/hatched's edition. Both must be the SAME per-species series.
  const seen = {};                                     // sp -> [{num, path, wallet, id}]
  const add = (sp, num, path, extra) => { (seen[sp] ||= []).push({ num, path, ...extra }); };

  const founderTask = () => { const w = wal(); const g = SRV._founderAwardForTest(w); if (g) { const row = SRV._regAllForTest().find(r => r.id === g.id); add(g.sp, row.edition, "founder", { wallet: w, id: g.id }); } };
  const paidTask = async () => {
    const w = wal();
    const h = await post("/meme/hatch", { wallet: w });
    if (h.status !== 200) return;
    const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
    if (hd.status === 200 && hd.body.char) add(hd.body.char, hd.body.edition, "paid", { wallet: w, char: hd.body.char });
  };

  // race: 30 paid hatches interleaved with 30 founder grants, scheduled between event-loop turns
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    tasks.push(paidTask());
    tasks.push((async () => { await sleep(Math.random() * 6); founderTask(); })());
  }
  await Promise.all(tasks);

  // cross-check EVERY paid creature: the number it was shown == the number on its registry/on-chain row
  let mismatch = 0;
  for (const sp of Object.keys(seen)) for (const e of seen[sp]) if (e.path === "paid") {
    const row = SRV._regAllForTest().find(r => r.owner === e.wallet && r.sp === sp && r.type === "chikimon");
    if (!row || row.edition !== e.num) mismatch++;
  }
  chk(mismatch === 0, `every paid creature's shown number equals its on-chain registry edition (${mismatch} mismatches)`);

  // THE RULING: per species, no two creatures share a number
  let dupSpecies = 0, totalCreatures = 0;
  for (const sp of WAVE2) {
    const nums = (seen[sp] || []).map(e => e.num).sort((a, b) => a - b);
    const paths = (seen[sp] || []).map(e => e.path === "founder" ? "F" : "p").join("");
    const uniq = new Set(nums);
    const contiguous = nums.length === 0 || (nums[nums.length - 1] === nums.length && nums[0] === 1);
    totalCreatures += nums.length;
    if (uniq.size !== nums.length) dupSpecies++;
    // also confirm the registry itself has no duplicate edition for the species
    const regEds = regRowsOf(sp).map(r => r.edition).sort((a, b) => a - b);
    const regUniq = new Set(regEds).size === regEds.length;
    console.log(`  ${sp.padEnd(14)} numbers ${JSON.stringify(nums)} (${paths})  unique=${uniq.size === nums.length}  1..N=${contiguous}  regUnique=${regUniq}`);
    if (!regUniq) dupSpecies++;
  }
  console.log(`  total wave-2 creatures issued in the race: ${totalCreatures}`);
  chk(dupSpecies === 0, `NO species has two creatures sharing a number (dupes in ${dupSpecies} species) — the owner ruling holds`);
  chk(totalCreatures > 20, `the run actually issued a meaningful mix: ${totalCreatures} creatures`);
}

console.log("\n========== WAVE-1 (the six) legacy counter is ALSO collision-free per species ==========");
{
  reset();
  for (const sp of WAVE2) burn(sp, caps[sp]);          // roll can only land on wave-1
  // pretend each of the six already has a handful of legacy sales
  const legacy = {}; for (const sp of ["pepe", "popcat", "moodeng", "doge", "chillguy", "alon"]) { legacy[sp] = 1 + Math.floor(Math.random() * 4); SRV._setMemeMintedForTest(sp, legacy[sp]); }
  const seen = {};
  for (let i = 0; i < 20; i++) {
    const w = wal();
    const h = await post("/meme/hatch", { wallet: w });
    if (h.status !== 200) continue;
    const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
    if (hd.status === 200 && hd.body.char) (seen[hd.body.char] ||= []).push(hd.body.edition);
  }
  let dup = 0;
  for (const sp of Object.keys(seen)) {
    const nums = seen[sp].sort((a, b) => a - b);
    const uniq = new Set(nums).size === nums.length;
    const aboveLegacy = nums.every(n => n > legacy[sp]);   // new sales continue ABOVE the pre-existing legacy numbers
    console.log(`  ${sp.padEnd(10)} legacy held #1..#${legacy[sp]}; new sales ${JSON.stringify(nums)}  unique=${uniq}  all>legacy=${aboveLegacy}`);
    if (!uniq || !aboveLegacy) dup++;
  }
  chk(dup === 0, `every wave-1 species keeps a unique, monotonic legacy series — new sales never collide with a held number (${dup} bad species)`);
}

console.log(`\nMDFR_RULING_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
