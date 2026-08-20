// masv_b_rarity.mjs — VERIFY LENS B: RULING 4, RARITY TRUTH. Independent of mas_sim.mjs.
//
//  RE-POINTED 2026-08-20: this sim was written around griffin at cap 5. The owner uncapped all six
//  ORIGINAL mounts on 2026-08-19 (the caps moved to the six Viranimals), so griffin now answers
//  "open" and every assertion here about "of 5" was asserting a repealed rule. momota is the
//  capped-5 mount now, so the sim exercises the same property against a species that still has it.
//  1. Issue FIVE momota (registry cap 5) and sell only ONE — the minted metadata must read
//     "Edition <its issuance serial> of 5" (the census/cap), NEVER "1 of 1" or "N of <minted>".
//     The ACTUAL metadata strings are printed, from both the on-chain Attributes composition and
//     the public /assets/nft/meta/:id JSON every marketplace reads.
//  2. A capped species AT cap refuses the next ISSUANCE with ZERO assets minted on-chain — the
//     sparse chain never frees cap room.
//  3. Healed editions for pre-existing (editionless) rows are DETERMINISTIC AND STABLE across two
//     runs: the same persisted ledger blob is restored in TWO FRESH server processes and healed
//     in each — the per-id edition maps must match exactly, and a row that already carried an
//     edition must never be renumbered.
//
// Boots the REAL server.js in-process (throwaway keys, dead RPC/ME, memory store, stubbed DAS +
// composer) plus two masv_b_host.mjs children for the two-process heal. No network beyond
// 127.0.0.1, no chain, no real key. Every assertion prints the ACTUAL value.
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import nacl from "tweetnacl"; import bs58 from "bs58";

const _t = nacl.sign.keyPair();
const POOL = bs58.encode(nacl.sign.keyPair().publicKey);
const _dele = nacl.sign.keyPair();
const COLLECTION = "2iyJEoY5mUnBXJ139R5mQSkfQtgzZXTP4BtnQaiGEgTN";
const PORT = "39822";
process.env.RPC_URL = "http://127.0.0.1:59322";                   // dead
process.env.ME_API_BASE = "http://127.0.0.1:59323";               // dead — composer is stubbed
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = PORT;
process.env.ADMIN_KEY = "test-admin-key"; process.env.TEAM_WALLET = POOL;
process.env.CHIK_NFT_MINT = "1"; process.env.CHIK_ME_MARKET = "1"; process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1";
process.env.CHIK_EGG_MEGUARD = "0";
process.env.ME_API_KEY = "test-key-never-sent";
process.env.NFT_COLLECTION = COLLECTION;
process.env.NFT_MINT_DELEGATE_SECRET = JSON.stringify(Array.from(_dele.secretKey));
process.env.MAS_CONF_TRIES = "3"; process.env.MAS_CONF_GAP_MS = "10";
process.env.ME_RL_WRITE_GAP_MS = "0"; process.env.ME_RL_WRITE_PER_MIN = "10000";
process.env.ME_RL_READ_GAP_MS = "0"; process.env.ME_RL_READ_PER_MIN = "10000";
delete process.env.DATABASE_URL;

const B = `http://127.0.0.1:${PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j }; };
const get = async (p) => { const r = await fetch(B + p); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j }; };
const SRV = await import("./server.js"); await new Promise((r) => setTimeout(r, 1500));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "vbr" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
const pk = () => bs58.encode(nacl.sign.keyPair().publicKey);
const fakeSig = () => bs58.encode(nacl.sign.keyPair().secretKey);
const dasMap = new Map();
SRV._setNftDasStubForTest((mint) => dasMap.get(mint) || { dasFailed: true, absent: true });
let composeCalls = [];
SRV._setMasComposeStubForTest(async (args) => { composeCalls.push(args); return { ok: true, b64: Buffer.from("tx-" + args.assetAddr).toString("base64"), ver: "legacy", cosigned: false }; });
SRV._clearAssetReg();
console.log(`\nmasv_b_rarity — flags: ${JSON.stringify(SRV._masFlagsForTest())}`);

// ================================================================================================
sec("1. FIVE momota issued (cap 5), ONE sold — the metadata's denominator is the CENSUS");
const SELLER = await mkWallet();
const g1 = SRV._mintHatchedForTest("mount", pk(), { sp: "momota", kind: "mount" });
const g2 = SRV._mintHatchedForTest("mount", pk(), { sp: "momota", kind: "mount" });
const g3 = SRV._mintHatchedForTest("mount", SELLER.wallet, { sp: "momota", kind: "mount" });   // the one that sells
const g4 = SRV._mintHatchedForTest("mount", pk(), { sp: "momota", kind: "mount" });
const g5 = SRV._mintHatchedForTest("mount", pk(), { sp: "momota", kind: "mount" });
console.log(`  issuance serials: ${[g1, g2, g3, g4, g5].map((g) => "#" + g.edition).join(" ")}   census=${SRV._trueIssued("mount", "momota").count}/5   minted on chain: 0`);
chk([g1, g2, g3, g4, g5].map((g) => g.edition).join(",") === "1,2,3,4,5", `editions assigned at issuance, sequential (${[g1, g2, g3, g4, g5].map((g) => g.edition)})`);

sec("2. AT CAP, ZERO MINTED — the sixth ISSUANCE refuses; the sparse chain frees nothing");
{
  const mintedNow = [g1, g2, g3, g4, g5].filter((g) => SRV._assetRowForTest(g.id).mint).length;
  let refused = null;
  try { SRV._mintHatchedForTest("mount", pk(), { sp: "momota", kind: "mount" }); } catch (e) { refused = e; }
  console.log(`  minted on chain at refusal time: ${mintedNow}   sixth issuance -> ${refused && refused.code}: ${refused && refused.message}`);
  chk(mintedNow === 0 && !!refused && refused.code === "SUPPLY_EXHAUSTED", `cap binds at ISSUANCE with zero on-chain mints (${refused && refused.code})`);
}

sec("3. SELL ONLY #3 — its minted metadata must say Edition 3 of 5, never 1 of 1");
{
  const r = await post("/nft/market/list", { wallet: SELLER.wallet, mktToken: SELLER.mktToken, id: g3.id, priceSol: 2 });
  chk(r.status === 200 && r.body.composed === "mint+list", `momota #3's first sale composes mint+list (${r.status})`);
  const attrs = (composeCalls[0] && composeCalls[0].plugins[0].attributeList) || [];
  const at = (k) => { const e = attrs.find((x) => x.key === k); return e ? e.value : null; };
  console.log(`  ON-CHAIN Attributes composed: edition="${at("edition")}" editionOf="${at("editionOf")}" -> "Edition ${at("edition")} of ${at("editionOf")}"   witness="${at("witness")}"`);
  chk(at("edition") === "3" && at("editionOf") === "5", `the composed metadata reads Edition 3 of 5 — the census, not the minted count (got "Edition ${at("edition")} of ${at("editionOf")}")`);
  chk(!(at("edition") === "1" && at("editionOf") === "1"), `it is NOT "1 of 1" (got "Edition ${at("edition")} of ${at("editionOf")}")`);
  dasMap.set(r.body.tokenMint, { owner: SELLER.wallet, burned: false, iface: "MplCoreAsset", collection: COLLECTION });
  const cf = await post("/nft/market/confirm", { wallet: SELLER.wallet, mktToken: SELLER.mktToken, tokenMint: r.body.tokenMint, signature: fakeSig(), action: "list" });
  chk(cf.status === 200 && cf.body.applied === "minted+listed", `#3 is now the ONLY minted momota (confirm=${cf.status})`);
  const meta = await get(`/assets/nft/meta/${encodeURIComponent(g3.id)}`);
  // 2026-08-15: the public JSON now labels traits for humans ("Edition Of", not "editionOf") while the
  // ON-CHAIN Attributes plugin keeps its camelCase keys forever. What this sim asserts is the VALUE —
  // the census denominator — so look each trait up under either spelling rather than pinning a label.
  const TRL = { edition: "Edition", editionOf: "Edition Of", witness: "Witness" };
  const tr = (k) => { const e = (meta.body.attributes || []).find((x) => x.trait_type === k || x.trait_type === TRL[k]); return e ? e.value : null; };
  console.log(`  PUBLIC metadata (${meta.status}): name="${meta.body.name}" edition="${tr("edition")}" editionOf="${tr("editionOf")}" witness="${tr("witness")}"`);
  chk(meta.body.name === "#3 Momota" && tr("edition") === "3" && tr("editionOf") === "5", `what every marketplace reads: "${meta.body.name}", Edition ${tr("edition")} of ${tr("editionOf")}`);
}
{
  // an UNMINTED sibling's metadata carries the same census denominator — 1 minted must not shrink it
  const a5 = SRV._nftAttributesForTest(SRV._assetRowForTest(g5.id));
  const at5 = (k) => { const e = a5.find((x) => x.key === k); return e ? e.value : null; };
  console.log(`  unminted griffin #5 metadata: "Edition ${at5("edition")} of ${at5("editionOf")}"`);
  chk(at5("edition") === "5" && at5("editionOf") === "5", `unminted #5 still states Edition 5 of 5 (minted count is 1 and irrelevant)`);
  // and an uncapped kind invents NO cap
  const norm = SRV._mintHatchedForTest("chikimon", pk(), { sp: "pipo", kind: "normal", lvl: 1 });
  const aN = SRV._nftAttributesForTest(SRV._assetRowForTest(norm.id));
  const atN = (k) => { const e = aN.find((x) => x.key === k); return e ? e.value : null; };
  console.log(`  uncapped normal pipo metadata: edition="${atN("edition")}" editionOf="${atN("editionOf")}"`);
  chk(atN("editionOf") === "open", `an uncapped normal states an OPEN edition — no invented cap (editionOf="${atN("editionOf")}")`);
}

// ================================================================================================
sec("4. HEAL DETERMINISM — one persisted blob, TWO fresh processes, identical editions");
// Pre-edition-era rows: three editionless drakor (borns deliberately out of id order) + one that
// already carries its edition and must NEVER be renumbered.
const W = pk();
const d1 = SRV._mintAssetForTest("chikimon", W, { sp: "drakor", kind: "legendary", lvl: 1, luid: "vb_d1" }, "legacy");
const d2 = SRV._mintAssetForTest("chikimon", W, { sp: "drakor", kind: "legendary", lvl: 1, luid: "vb_d2" }, "legacy");
const d3 = SRV._mintAssetForTest("chikimon", W, { sp: "drakor", kind: "legendary", lvl: 1, luid: "vb_d3" }, "legacy");
const d4 = SRV._mintAssetForTest("chikimon", W, { sp: "drakor", kind: "legendary", lvl: 1, luid: "vb_d4" }, "legacy");
const keep4 = SRV._assetRowForTest(d4.id).edition;                 // this one KEEPS its number
for (const [row, born] of [[d1, 3000], [d2, 1000], [d3, 2000]]) { const r = SRV._assetRowForTest(row.id); delete r.edition; r.born = born; }
const SNAP = SRV.serializeAssetReg();
const SNAP_PATH = "/private/tmp/claude-502/-Users-michaelkennethbrillantes-Downloads-chiki-monsters-github/af3679f8-9bd4-4f61-b5ce-8d086a78fa4b/scratchpad/masv_b_heal_snapshot.json";
writeFileSync(SNAP_PATH, JSON.stringify(SNAP));
console.log(`  blob: ${SNAP.rows.length} rows, persisted counters ${JSON.stringify(SNAP.nftEdition || {})}, editionless drakor: 3 (borns 1000/2000/3000), kept #${keep4}`);

async function healInFreshProcess(port, hookPort) {
  const env = { ...process.env, PORT: String(port) };
  const c = fork("./masv_b_host.mjs", ["./server.js", String(port), String(hookPort)], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  c.stdout.on("data", () => {}); c.stderr.on("data", () => {});
  const hook = async (fn, ...args) => {
    const r = await fetch(`http://127.0.0.1:${hookPort}/`, { method: "POST", body: JSON.stringify({ fn, args }) });
    return r.json();
  };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 25000) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status) { up = true; break; } } catch (e) {} await new Promise((r) => setTimeout(r, 250)); }
  if (!up) { c.kill("SIGKILL"); return { up: false }; }
  await hook("_clearAssetReg");
  await hook("restoreAssetReg", SNAP);
  const healed = await hook("_masHealEditionsForTest");
  const map = {};
  for (const id of [d1.id, d2.id, d3.id, d4.id]) { const r = await hook("_assetRowForTest", id); map[id] = r.val ? r.val.edition : null; }
  c.kill("SIGKILL");
  return { up: true, healed: healed.val, map };
}
const run1 = await healInFreshProcess(39823, 41823);
const run2 = await healInFreshProcess(39824, 41824);
chk(run1.up && run2.up, `two fresh server processes restored the same blob (up=${run1.up},${run2.up})`);
console.log(`  run1 healed=${run1.healed}: ${JSON.stringify(run1.map)}`);
console.log(`  run2 healed=${run2.healed}: ${JSON.stringify(run2.map)}`);
chk(run1.healed === 3 && run2.healed === 3, `each run healed exactly the 3 editionless rows (${run1.healed}, ${run2.healed})`);
chk(JSON.stringify(run1.map) === JSON.stringify(run2.map), `DETERMINISTIC AND STABLE: both runs assign identical editions`);
chk(run1.map[d4.id] === keep4, `a row that already carried its edition is NEVER renumbered (#${run1.map[d4.id]} == #${keep4})`);
chk(run1.map[d2.id] < run1.map[d3.id] && run1.map[d3.id] < run1.map[d1.id], `healed order follows ISSUANCE order, born asc (${run1.map[d2.id]} < ${run1.map[d3.id]} < ${run1.map[d1.id]})`);
chk(Math.min(run1.map[d1.id], run1.map[d2.id], run1.map[d3.id]) > keep4, `healed numbers continue past the persisted counter — no live edition re-issued (min healed ${Math.min(run1.map[d1.id], run1.map[d2.id], run1.map[d3.id])} > ${keep4})`);

console.log(`\n=== masv_b_rarity: ${pass} passed / ${fail} failed ===`);
process.exit(fail ? 1 : 0);
