// mdfr_f2_edition.mjs — FINDING #2 + OWNER RULING from the OUTSIDE. The number a player sees for a
// Meme Dynasty (wave-2) creature must BE the registry/on-chain edition, so the founder path and the
// paid path never number two creatures the same and the Bazaar never disagrees with the NFT. The
// original SIX (wave 1) are grandfathered on the legacy memeMinted counter — a pre-existing row is
// NEVER renumbered. Real server.js in-process; live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59483";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39483";
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
const startDrop = (species) => post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species });
const stopDrop = () => post("/admin/event/stop", { key: KEY, event: "founder_drop" });
const reset = () => { SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest(); for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0); };
const regRowFor = (w, sp) => SRV._regAllForTest().find(r => r.owner === w && r.sp === sp && r.type === "chikimon");
const burnAllBut = (keep) => { for (const k of Object.keys(caps)) if (k !== keep) for (let i = 0; i < caps[k]; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp: k, kind: "meme", lvl: 1 }, "issued", null); } catch (e) {} } };
async function paidHatch(w) {
  const h = await post("/meme/hatch", { wallet: w });
  if (h.status !== 200) return { status: h.status, err: h.body.error };
  const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
  return { status: hd.status, char: hd.body.char, edition: hd.body.edition, id: h.body.hatch.id };
}

console.log("\n========== WAVE-2: paid-after-founder — registry == displayed, on a VIRGIN counter ==========");
{
  reset();
  burnAllBut("ansem");                 // force every roll onto ansem
  await startDrop("ansem");            // founder holds the last ansem editions
  const fw = wal();
  const g = SRV._founderAwardForTest(fw);
  const fRow = SRV._regAllForTest().find(r => r.id === g.id);
  console.log(`  FOUNDER ansem: registry edition #${fRow.edition}`);
  chk(fRow.edition === 1, `founder ansem is registry #${fRow.edition} (virgin counter)`);
  await stopDrop();                    // release the hold so a buyer can reach ansem
  const bw = wal();
  const sale = await paidHatch(bw);
  const sRow = regRowFor(bw, "ansem");
  console.log(`  PAID ansem: /meme/hatched edition #${sale.edition}; its registry row #${sRow.edition}`);
  chk(sale.status === 200 && sale.char === "ansem", `the paid buyer got ansem (${sale.char})`);
  chk(sale.edition === sRow.edition, `the DISPLAYED number IS the registry/on-chain number: bazaar #${sale.edition} == registry #${sRow.edition}`);
  chk(sale.edition === 2, `and it is the next in the series (founder #1, paid #2): #${sale.edition}`);
  // the same number everywhere a player looks. Mark it minted (worker step) so it can reach the Bazaar.
  const mine = (await get(`/meme/mine?wallet=${bw}`)).body.items[0];
  const recent = (await get("/meme/recent")).body.items.find(i => i.char === "ansem");
  await post("/meme/minted", { key: KEY, hatchId: sale.id, mintAddr: "Mint" + crypto.randomBytes(8).toString("hex") });
  await post("/meme/list", { wallet: bw, hatchId: sale.id, price: 5 });
  const market = (await get("/meme/market")).body.items.find(i => i.id === sale.id);
  console.log(`  /meme/mine=#${mine.edition}  /meme/recent=#${recent && recent.edition}  /meme/market=#${market && market.edition}  (registry #${sRow.edition})`);
  chk(mine.edition === sRow.edition && recent && recent.edition === sRow.edition && market && market.edition === sRow.edition,
      `mine / recent / Bazaar all show the registry number #${sRow.edition}`);
}

console.log("\n========== WAVE-1 (the six): a PRE-EXISTING creature is NEVER renumbered ==========");
{
  reset();
  burnAllBut("doge");
  // simulate FIVE pre-existing legacy doge sales on the memeMinted counter (players already hold #1..#5)
  SRV._setMemeMintedForTest("doge", 5);
  const bw = wal();
  const sale = await paidHatch(bw);
  const dRow = regRowFor(bw, "doge");
  console.log(`  new doge sale: displayed #${sale.edition}; its registry row #${dRow.edition}`);
  chk(sale.char === "doge" && sale.edition === 6, `a wave-1 doge keeps the LEGACY memeMinted series (#${sale.edition} = 5 prior + 1), not the registry edition #${dRow.edition}`);
  chk(sale.edition !== dRow.edition, `so the legacy display legitimately diverges from the registry row (display #${sale.edition} vs registry #${dRow.edition}) — a per-creature mismatch, NOT a collision`);
  // it is not recomputed by later activity (grandfather): the number is fixed at birth
  const before = (await get(`/meme/mine?wallet=${bw}`)).body.items[0].edition;
  for (let i = 0; i < 3; i++) { const w2 = wal(); await paidHatch(w2); }   // more doge sales advance counters
  const after = (await get(`/meme/mine?wallet=${bw}`)).body.items[0].edition;
  console.log(`  the pre-existing doge displayed #${before} before / #${after} after three more doge sales`);
  chk(before === after && after === 6, `the already-held doge is NEVER renumbered by later sales: still #${after}`);
}

console.log("\n========== WAVE-2 number is stable (write-once) across later activity ==========");
{
  reset();
  burnAllBut("stonks");
  const bw = wal();
  const sale = await paidHatch(bw);
  const first = (await get(`/meme/mine?wallet=${bw}`)).body.items[0].edition;
  for (let i = 0; i < 4; i++) { const w2 = wal(); await paidHatch(w2); }
  const later = (await get(`/meme/mine?wallet=${bw}`)).body.items[0].edition;
  console.log(`  wave-2 stonks displayed #${first} then #${later} after four more sales`);
  chk(first === later, `a wave-2 creature's shown number never moves once seen: #${first} == #${later}`);
}

console.log(`\nMDFR_F2_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
