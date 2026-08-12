// mdfr_f1_poolval.mjs — FINDING #1 from the OUTSIDE: /admin/event/start must REFUSE a founder pool
// containing an unknown/typo'd/mis-cased species key (400 + the list of valid tokens), and every
// recognised GROUP token must still start a Dynasty drop. Before the fix an unknown literal was
// pushed through and minted UNCAPPED (supplyOf=0). Real server.js in-process; live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59482";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39482";
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
const WAVE2 = SRV._memeWave2ForTest();
const caps = SRV._memeCapsForTest();
const startDrop = (species) => post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species });
const stopDrop = () => post("/admin/event/stop", { key: KEY, event: "founder_drop" });
const reset = () => { SRV._clearAssetReg(); SRV._clearAssetLedger(); SRV._resetLiveEventsForTest(); for (const k of Object.keys(caps)) SRV._setMemeMintedForTest(k, 0); };
const founderRows = () => SRV._regAllForTest().filter(r => r.origin === "open-gates-founder");

console.log("\n========== BAD POOL TOKENS ARE REFUSED (400 + valid tokens) ==========");
for (const bad of ["Ansem", "wave-2", "meme_dynsaty", "nope_not_a_species", "DOGE ", "legend_ary"]) {
  reset();
  const r = await startDrop(bad);
  const vt = r.body.validTokens || {};
  const listsTokens = Array.isArray(vt.meme) && Array.isArray(vt.legendary) && Array.isArray(vt.groups)
                      && vt.meme.includes("ansem") && vt.groups.includes("meme_dynasty");
  console.log(`  species:${JSON.stringify(bad)} -> ${r.status}; error mentions the key? ${String(r.body.error||"").includes(String(bad).trim())}`);
  chk(r.status === 400 && listsTokens, `"${bad}" refused with 400 that lists valid tokens (status ${r.status}, meme[0]=${vt.meme && vt.meme[0]})`);
  // and NOTHING was armed / minted
  let n = 0; for (let i = 0; i < 5; i++) if (SRV._founderAwardForTest(wal())) n++;
  chk(n === 0 && founderRows().length === 0, `no phantom drop ran for "${bad}" (grants=${n}, founder rows=${founderRows().length})`);
}

console.log("\n========== A POOL WITH ONE BAD KEY AMONG GOOD ONES IS REFUSED WHOLE ==========");
{
  reset();
  const r = await startDrop(["ansem", "nope_not_a_species", "meme_dynasty"]);
  console.log(`  mixed pool -> ${r.status} ${JSON.stringify(r.body.error || r.body.species)}`);
  chk(r.status === 400, `a single unknown key refuses the entire request (${r.status})`);
}

console.log("\n========== EVERY RECOGNISED GROUP TOKEN STILL STARTS A DROP ==========");
for (const tok of ["meme_dynasty", "Meme Dynasty", "meme-dynasty", "MEME_DYNASTY", "dynasty", "wave2", "memedynasty"]) {
  reset();
  const r = await startDrop(tok);
  const ok = r.status === 200 && Array.isArray(r.body.species) && JSON.stringify(r.body.species) === JSON.stringify(WAVE2);
  console.log(`  species:${JSON.stringify(tok)} -> ${r.status}, pool size ${r.body.species && r.body.species.length}`);
  chk(ok, `"${tok}" starts the Dynasty drop with the eleven wave-2 keys (status ${r.status}, size ${r.body.species && r.body.species.length})`);
  // and it actually hands out one of the eleven
  const g = SRV._founderAwardForTest(wal());
  chk(g && WAVE2.includes(g.sp), `and it awards one of the eleven: ${g && g.sp}`);
  await stopDrop();
}

console.log("\n========== EXACT SPECIES KEYS AND THE LEGENDARY GROUP STILL WORK ==========");
{
  reset();
  const r1 = await startDrop(["ansem", "stonks"]);
  chk(r1.status === 200 && JSON.stringify(r1.body.species) === JSON.stringify(["ansem", "stonks"]),
      `an exact-key pool ["ansem","stonks"] is accepted verbatim: ${JSON.stringify(r1.body.species)}`);
  await stopDrop(); reset();
  const r2 = await startDrop("legendary");
  chk(r2.status === 200 && Array.isArray(r2.body.species) && r2.body.species.length > 0,
      `the "legendary" group token expands the uncapped roster (${r2.body.species && r2.body.species.length} species)`);
  await stopDrop();
}

console.log(`\nMDFR_F1_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
