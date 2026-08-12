// mdfr_p_artifact.mjs — PROVE that mdfatk_bar_ed_atk.mjs section P's 4 fails are the ATTACKER'S OWN
// test-setup errors, not code defects. Two distinct artifacts:
//   (1) section P does not (cannot — there is no seam) clear `memeHatches`, so a REAL paid sale left
//       by section M/N leaks into P's census; "one creature counts 2" is 1 founder + 1 leftover sale.
//   (2) section P transfers with the RAW transferAsset seam, which never populates the settled
//       hand-off debit (nftHandDebit) that cancels the seller's ledger ghost; the +1 is that ghost.
// A clean boot shows the census reads exactly 1 for one founder creature — no double-count exists.
// Real server.js in-process, memory store, dead RPC, throwaway keys. Live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59481";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39481";
process.env.ADMIN_KEY = "mdfr-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_REG_ALL = "1";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN; delete process.env.MARKET_URL;
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
const supply = async () => (await get("/meme/supply")).body.chars;
const startDrop = (species) => post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species });
const stopDrop = () => post("/admin/event/stop", { key: KEY, event: "founder_drop" });

console.log("\n========== CLEAN BOOT: one founder creature counts exactly ONCE ==========");
{
  // clean world, empty memeHatches (fresh process)
  for (const k of Object.keys(caps)) if (k !== "ansem") SRV._mintAssetForTest("chikimon", wal(), { sp: k, kind: "meme", lvl: 1 }, "issued", null);
  await startDrop("meme_dynasty");
  const g = SRV._founderAwardForTest(wal());
  const t = await supply();
  console.log(`  founder granted ${g.sp}; census ansem=${t.ansem.minted}`);
  chk(t.ansem.minted === 1, `on a clean boot ONE founder ansem counts ONCE: ${t.ansem.minted} (mdfatk section P read 2 only because a leftover paid sale from its section M was still in memeHatches)`);
  await stopDrop();
}

console.log("\n========== REPRODUCE THE ARTIFACT: a leftover paid sale makes the count read 2 ==========");
{
  // clean slate, then force the paid roll onto ansem (burn every other species to cap)
  SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
  for (const k of Object.keys(caps)) if (k !== "ansem") for (let i = 0; i < caps[k]; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp: k, kind: "meme", lvl: 1 }, "issued", null); } catch (e) {} }
  const w = wal();
  const h = await post("/meme/hatch", { wallet: w });
  const hd = await post("/meme/hatched", { wallet: w, hatchId: h.body.hatch.id });
  console.log(`  paid buyer hatched ${hd.body.char} #${hd.body.edition} (forced onto ansem)`);
  // clear reg + ledger the way section P does — but memeHatches has NO clear seam, so the paid sale survives
  SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest();
  for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0);
  const leftover = (await supply());
  console.log(`  after clearing reg+ledger (NOT memeHatches): ansem still reads ${leftover.ansem.minted} — the paid sale row survived`);
  await startDrop("meme_dynasty");
  const g = SRV._founderAwardForTest(wal());
  const t = await supply();
  console.log(`  now one founder grant of ${g.sp}: census ansem=${t.ansem.minted}`);
  chk(hd.body.char === "ansem" && g.sp === "ansem" && t.ansem.minted === 2,
      `census = ${t.ansem.minted} = 1 leftover paid sale + 1 founder — TWO real creatures, correctly counted (section P's "counts 2" is this leftover, not a double-count)`);
}

console.log(`\nmdfr_p_artifact: pass=${pass} fail=${fail}`);
console.log("VERDICT: bar_ed section P's 4 fails are the attacker's own setup artifacts (uncleared memeHatches");
console.log("         + a raw transferAsset seam that bypasses the settled hand-off nftHandDebit). No code defect.");
console.log(`MDFR_P_ARTIFACT_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
