// _adv_seal_reissue.mjs — the X7 loose thread, measured directly.
// QUESTION: when a SEALED row is retired (burned), what does the wallet end up holding — and can the
// owner ever get a sealed row for that species back?
// Same containment as every probe here: throwaway keypairs, throwaway ADMIN_KEY local to this
// process, memory store, DEAD RPC/ME. Never touches the live backend.
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59991";
process.env.ME_API_BASE = "http://127.0.0.1:59992";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.TEAM_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "39433"; process.env.STORE = "memory"; process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "reissue-throwaway-" + crypto.randomBytes(12).toString("hex");
process.env.CHIK_REG_ALL = "1"; process.env.CHIK_NFT_MINT = "1";
process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1"; process.env.CHIK_CHRONICLE = "1";
process.env.NFT_META_BASE = "http://127.0.0.1:39433";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY, B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
const v = await post("/verify", { wallet, netId: "reissue1", authMsg, authSig });
const mktToken = v.body.mktToken;

await post("/admin/grant-collection", { key: KEY, wallet });
const rowsOf = (sp) => [...(SRV._regOwnedForTest(wallet, "mount"))].map(r => SRV._assetRowForTest(r.id)).filter(r => r && r.sp === sp);
const allMountRows = () => { const out = []; for (const t of ["mount"]) for (const r of SRV._regOwnedForTest(wallet, t)) out.push(SRV._assetRowForTest(r.id)); return out; };

const victim = allMountRows()[0];
const SP = victim.sp;
console.log(`\nspecies under test: ${SP}`);
console.log(`  after the grant: rows=${rowsOf(SP).length} sealed=${rowsOf(SP).filter(r => r.creatorEdition === true).length}`);

// 1. RETIRE it, the way nftApplyClassification("retire") records a burn
victim.state = "burned";
victim.chain.push({ at: Date.now(), what: "burned", why: "reissue-probe" });
const burnedRow = SRV._assetRowForTest(victim.id);
console.log(`  after the retire: burned row state=${burnedRow.state} creatorEdition=${burnedRow.creatorEdition} (the ORIGINAL keeps its seal)`);
const trB = ((await get(`/assets/nft/meta/${encodeURIComponent(victim.id)}`)).body.attributes || []).find(a => a.trait_type === "Creator Edition");
console.log(`  the retired row's metadata trait: ${JSON.stringify(trB || null)}`);

// 2. the player's own client re-syncs (the ledger still lists the steed the grant wrote)
const s = await post("/assets/mounts/sync", { wallet, mktToken });
const after = rowsOf(SP);
const activeRows = after.filter(r => r.state === "active");
console.log(`\n  /assets/mounts/sync -> ${s.status} adopted=${JSON.stringify(s.body.adopted || [])}`);
console.log(`  rows for ${SP} now = ${after.length}  (active=${activeRows.length}, burned=${after.length - activeRows.length})`);
for (const r of after) console.log(`     id=${r.id.slice(0, 14)} state=${r.state} origin=${r.origin} creatorEdition=${r.creatorEdition}`);
const liveUnsealed = activeRows.filter(r => r.creatorEdition !== true).length;
console.log(`  >>> the wallet's PLAYABLE ${SP} is sealed: ${activeRows.length ? (activeRows[0].creatorEdition === true) : "n/a"}   (unsealed active rows = ${liveUnsealed})`);

// 3. can the owner re-issue a sealed one through the only sealing route?
const re = await post("/admin/grant-collection", { key: KEY, wallet });
const entry = [...(re.body.granted || []), ...(re.body.already || []), ...(re.body.refused || [])].find(e => e.sp === SP);
console.log(`\n  re-run /admin/grant-collection -> granted=${re.body.totals.granted} already=${re.body.totals.already}`);
console.log(`  ${SP} was reported as: ${JSON.stringify(entry)}`);
const sealedNow = rowsOf(SP).filter(r => r.state === "active" && r.creatorEdition === true).length;
console.log(`  >>> ACTIVE sealed rows for ${SP} after the re-grant = ${sealedNow}`);
console.log(sealedNow > 0
  ? `\nVERDICT: the owner CAN recover a sealed ${SP}.`
  : `\nVERDICT: the owner CANNOT recover a sealed ${SP} through /admin/grant-collection — heldVia reads the wallet as already holding one, so the grant reports "${entry && entry.via}" and issues nothing. The retired original keeps its seal forever; the playable replacement has none.`);
process.exit(0);
