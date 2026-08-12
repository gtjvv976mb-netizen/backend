// mdfr_f3_gate.mjs — FINDING #3 from the OUTSIDE. /meme/hatch must refuse BEFORE taking the egg when
// nothing can actually roll — the gate is now REGISTRY-AWARE (counts every birth route + the founder
// hold), where the old gate compared memeReserved()+founderReserveTotal() to the nominal 285 and was
// blind to creatures born in-game, so it took an egg's payment into a dead end. And it STILL accepts
// when exactly one copy is genuinely free. Real server.js in-process; live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59484";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39484";
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
const reset = () => { SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._clearMemeHatchesForTest(); SRV._resetLiveEventsForTest(); for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0); };
const burn = (sp, n) => { for (let i = 0; i < n; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp, kind: "meme", lvl: 1 }, "issued", null); } catch (e) {} } };
const eggsOf = async (w) => (await get(`/meme/mine?wallet=${w}`)).body.items.length;

console.log("\n========== NOTHING HATCHABLE (last copy founder-held, all else retired) -> REFUSE, NO EGG TAKEN ==========");
{
  reset();
  // every species to cap EXCEPT ansem, which is left at 9/10; the last ansem is held by a live drop
  for (const k of Object.keys(caps)) burn(k, k === "ansem" ? caps[k] - 1 : caps[k]);
  await startDrop("ansem");
  const t = (await get("/meme/supply")).body.chars.ansem;
  console.log(`  ansem minted ${t.minted}/${t.cap} left ${t.left} held ${t.held} buyable ${t.buyable}; founderReserveTotal=${SRV._founderReserveTotalForTest()}`);
  chk(t.buyable === 0 && t.held === 1, `nothing is buyable — the last ansem is founder-held (buyable ${t.buyable}, held ${t.held})`);
  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  console.log(`  POST /meme/hatch -> ${h.status} ${JSON.stringify(h.body.error || h.body.hatch)}`);
  chk(h.status !== 200, `the PAID step REFUSES before taking the egg (got ${h.status})`);
  chk(await eggsOf(w) === 0, `no egg row was created for the payer (mine has ${await eggsOf(w)} items)`);
  chk(/founder/i.test(h.body.error || ""), `the refusal names the Founder Drop hold: "${h.body.error}"`);
}

console.log("\n========== EVERYTHING GENUINELY SOLD OUT -> REFUSE, NO EGG TAKEN ==========");
{
  reset();
  for (const k of Object.keys(caps)) burn(k, caps[k]);   // whole collection minted
  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  console.log(`  POST /meme/hatch (285/285 minted) -> ${h.status} ${JSON.stringify(h.body.error)}`);
  chk(h.status !== 200 && await eggsOf(w) === 0, `refused with no egg taken (${h.status}, ${await eggsOf(w)} eggs)`);
}

console.log("\n========== OUTSTANDING INCUBATING EGGS ARE NETTED OUT (no over-sell) ==========");
{
  // NOTE: runs on a CLEAN memeHatches — the two sections above only ever REFUSED, so no egg row
  // lingers (memeHatches has no clear seam, so ordering matters; the exactly-one-copy section that
  // creates a pending sale is kept LAST for exactly this reason).
  reset();
  // two ansem free, no drop. First egg accepted (1 outstanding). Second accepted (2 outstanding == 2 buyable).
  // Third must refuse: 2 incubating >= 2 buyable, even though nothing has ROLLED yet.
  for (const k of Object.keys(caps)) burn(k, k === "ansem" ? caps[k] - 2 : caps[k]);
  const t = (await get("/meme/supply")).body.chars.ansem;
  console.log(`  ansem ${t.minted}/${t.cap} buyable ${t.buyable}`);
  const w1 = wal(), w2 = wal(), w3 = wal();
  const a = await post("/meme/hatch", { wallet: w1 });
  const b = await post("/meme/hatch", { wallet: w2 });
  const c = await post("/meme/hatch", { wallet: w3 });
  console.log(`  three buyers vs two buyable ansem: ${a.status}, ${b.status}, ${c.status}`);
  chk(a.status === 200 && b.status === 200 && c.status !== 200,
      `the third egg is refused because two are already incubating against two buyable copies (${a.status}/${b.status}/${c.status})`);
  chk(await eggsOf(w3) === 0, `the refused third buyer took no egg (${await eggsOf(w3)})`);
}

console.log("\n========== EXACTLY ONE COPY GENUINELY FREE -> ACCEPT, then the NEXT is refused ==========");
{
  reset();
  // every species to cap EXCEPT ansem at 9/10, and NO drop -> the last ansem is freely buyable
  for (const k of Object.keys(caps)) burn(k, k === "ansem" ? caps[k] - 1 : caps[k]);
  const t = (await get("/meme/supply")).body.chars.ansem;
  console.log(`  ansem ${t.minted}/${t.cap} left ${t.left} held ${t.held} buyable ${t.buyable}`);
  chk(t.buyable === 1, `exactly one ansem is buyable: ${t.buyable}`);
  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  chk(h.status === 200, `the egg is ACCEPTED when a copy is free (${h.status})`);
  const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
  console.log(`  /meme/hatch ${h.status} -> /meme/hatched ${hd.status} ${hd.body.char} #${hd.body.edition}`);
  chk(hd.status === 200 && hd.body.char === "ansem", `it hatches the free ansem (#${hd.body.edition})`);
  // now the collection is truly full — the next buyer is refused before paying
  const w2 = wal();
  const h2 = await post("/meme/hatch", { wallet: w2 });
  console.log(`  next /meme/hatch (now 285/285) -> ${h2.status} ${JSON.stringify(h2.body.error)}`);
  chk(h2.status !== 200 && await eggsOf(w2) === 0, `and the very next egg is refused with nothing taken (${h2.status})`);
}

console.log(`\nMDFR_F3_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
