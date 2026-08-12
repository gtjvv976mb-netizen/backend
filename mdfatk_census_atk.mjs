// mdfatk_census_atk.mjs — ADVERSARIAL part 3, isolated: does a FOUNDER creature count exactly once
// in the census the cap is enforced from — at rest, and after it changes hands through the REAL
// production hand-off (not the raw transferAsset seam, which skips the ghost debit the live callers
// always pair with it)? No hatches, no prior sections, so nothing here is another test's residue.
// Real server.js in-process, memory store, dead RPC, throwaway keys. Live backend untouched.
import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59119";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39473";
process.env.ADMIN_KEY = "atk3-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1";
process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_REG_ALL = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN; delete process.env.MARKET_URL;
delete process.env.FOUNDER_SPECIES; delete process.env.FOUNDER_CAP;
const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));
let pass = 0, fail = 0; const notes = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const wal = () => bs58.encode(nacl.sign.keyPair().publicKey);
const caps = SRV._memeCapsForTest();
const cen = async (sp) => (await get("/meme/supply")).body.chars[sp].minted;
const real = (sp) => SRV._regAllForTest().filter(r => r.type === "chikimon" && r.sp === sp && r.state === "active").length;

console.log("\n========== ONE FOUNDER CREATURE, COUNTED ==========");
await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7, species: "meme_dynasty" });
const W = wal();
const g = SRV._founderAwardForTest(W);
const SP = g.sp;
console.log(`  founder won ${SP}; census=${await cen(SP)}; registry rows=${real(SP)}; ledger units=${Object.keys(SRV._assetLedgerRecForTest(W).units || {}).length}`);
chk(await cen(SP) === 1, `at rest, one founder creature counts ONCE: census=${await cen(SP)}`);

// ---- hand it over through the REAL settle path (the one live callers use: transfer + ghost debit)
const W2 = wal();
SRV._meSetMintForTest(g.id, "Mint" + bs58.encode(nacl.sign.keyPair().publicKey).slice(4));
const set = SRV._nftSettleForTest(g.id, W2);
const c2 = await cen(SP);
console.log(`  REAL hand-off ${W.slice(0, 6)} -> ${W2.slice(0, 6)}: ${JSON.stringify(set && set.ok !== undefined ? { ok: set.ok, why: set.why } : "moved")}; census=${c2}`);
chk(c2 === 1, `after the production hand-off it still counts ONCE: census=${c2}`);
if (c2 !== 1) notes.push(`CENSUS OVERCOUNT after the real hand-off: ${SP} reads ${c2} for 1 real creature.`);

// ---- the RAW transfer seam, for contrast: what happens if any future caller forgets the debit
const W3 = wal();
SRV._transferAssetForTest(g.id, W2, W3, "atk-raw");
const c3 = await cen(SP);
console.log(`  RAW transferAsset (no nftDebitKeyAdd) ${W2.slice(0, 6)} -> ${W3.slice(0, 6)}: census=${c3}, real=${real(SP)}`);
chk(c3 === real(SP), `a transfer that skips the ghost debit would drift: census=${c3} vs real=${real(SP)}`);
if (c3 !== real(SP)) notes.push(`FRAGILITY (not a live bug): transferAsset alone leaves the founder's ledger unit behind and the census reads ${c3} for ${real(SP)} creature(s). Both live callers (nftSettleHandover :7888, tpeSettleChikimon :15190) pair it with nftDebitKeyAdd, so this is only reachable by a future caller that forgets. The founder grant writes rec.units[luid] (server.js:5392) without stamping \`luid\` on the registry row, which is what makes the pair separable.`);

// ---- does the species still reach its FULL cap? (drop stopped, so the hold is out of the way)
console.log("\n========== DOES THE FULL CAP REMAIN MINTABLE? ==========");
await post("/admin/event/stop", { key: KEY, event: "founder_drop" });
let made = 0, lastErr = "";
for (let i = 0; i < caps[SP] + 5; i++) { try { SRV._mintAssetForTest("chikimon", wal(), { sp: SP, kind: "meme", lvl: 1 }, "issued", null); made++; } catch (e) { lastErr = e.code || e.message; } }
const c4 = await cen(SP), r4 = real(SP);
console.log(`  ${made} ordinary mints landed (then ${lastErr}); census=${c4}/${caps[SP]}; REAL creatures=${r4}`);
chk(r4 <= caps[SP], `NO CAP BREACH: real ${SP} = ${r4} <= ${caps[SP]}`);
chk(r4 === caps[SP], `the species reaches its FULL cap: ${r4}/${caps[SP]}`);
chk(c4 === r4, `the public rarity bar equals reality: bar says ${c4}, ${r4} exist`);
if (r4 < caps[SP]) notes.push(`STRANDED SUPPLY: only ${r4} of ${caps[SP]} ${SP} can ever exist; the bar reads ${c4}/${caps[SP]}.`);

// ---- and a plain creature, for the baseline
console.log("\n========== BASELINE: A PLAIN REGISTRY CREATURE ==========");
const sp2 = "triplet", A1 = wal(), A2 = wal();
const plain = SRV._mintAssetForTest("chikimon", A1, { sp: sp2, kind: "meme", lvl: 1 }, "issued", null);
const p1 = await cen(sp2);
SRV._transferAssetForTest(plain.id, A1, A2, "atk");
const p2 = await cen(sp2);
console.log(`  plain mint (registry row only, no ledger unit): census ${p1} -> ${p2} across a raw transfer`);
chk(p1 === 1 && p2 === 1, `a plain registry creature counts once before and after (${p1} -> ${p2})`);

console.log(`\n================ mdfatk_census_atk: ${pass} passed, ${fail} failed ================`);
console.log(notes.length ? "FINDINGS:\n  - " + notes.join("\n  - ") : "FINDINGS: none");
process.exit(0);
