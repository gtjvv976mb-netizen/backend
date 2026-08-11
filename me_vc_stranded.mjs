// me_vc_stranded.mjs — VERIFY LENS C, THE BACKEND HALF.
//
// One question: DOES ANY PLAYER PAY REAL MONEY FOR SOMETHING THEY DO NOT GET?
//
// The in-game marketplace and the in-game hand-over are TWO SEPARATE FLAGS. The buy confirmation the
// player reads says, verbatim (PlayerPanel.gd:3585):
//     "The collectible is yours the moment the transaction lands. The CREATURE walks into your
//      satchel a little later, once Chikoria's registry sees the new on-chain owner."
// and Market.gd:2048:
//     "Payment sent. The collectible is yours on-chain now; the creature arrives in your satchel
//      once the sale settles — usually a few minutes."
// Both sentences are TRUE ONLY IF CHIK_NFT_HANDOVER=1. This file boots the real server.js in the
// exact flag combination a staged rollout produces — marketplace ON, hand-over OFF (its default) —
// executes a real proxied purchase against the local stub, drives the REAL reconcile past two reads
// and the 60 s dwell, and then prints who owns the creature and what each side was told.
//
// Then it re-runs the identical script with CHIK_NFT_HANDOVER=1 in a second process, so the
// difference is attributable to the flag and nothing else.
//
// NOTHING LIVE. Throwaway keypairs, RPC_URL on a dead port, memory store, ME_API_BASE pointed at
// me_stub.mjs. No real Magic Eden call, no chain, no live backend, no real key.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { startStub, ME_KEY, coreListingRow } from "./me_stub.mjs";

const HANDOVER = process.env.VC_HANDOVER === "1";
const stub = await startStub();
const T = nacl.sign.keyPair();
const TEAM = bs58.encode(nacl.sign.keyPair().publicKey);
const COLLECTION = bs58.encode(nacl.sign.keyPair().publicKey);

process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(T.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = String(39400 + (HANDOVER ? 1 : 0));
process.env.ADMIN_KEY = "test-admin-key"; process.env.TEAM_WALLET = TEAM;
process.env.CHIK_ROSTER_GUARD = "off";
delete process.env.DATABASE_URL;
process.env.CHIK_ME_MARKET = "1";
process.env.ME_API_BASE = stub.base;
process.env.ME_API_KEY = ME_KEY;
process.env.ME_COLLECTION_SYMBOL = "chiki_monsters";
process.env.ME_RL_WRITE_GAP_MS = "0"; process.env.ME_RL_WRITE_PER_MIN = "400";
process.env.ME_RL_READ_GAP_MS = "0"; process.env.ME_RL_READ_PER_MIN = "400";
process.env.ME_TOKEN_CACHE_MS = "50";
// THE VARIABLE UNDER TEST. Everything else is identical between the two runs.
process.env.CHIK_NFT_MINT = "1";
process.env.CHIK_NFT_HANDOVER = HANDOVER ? "1" : "0";
process.env.NFT_COLLECTION = COLLECTION;

const B = `http://127.0.0.1:${process.env.PORT}`;
async function raw(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  const r = await fetch(B + p, init);
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: j || {}, text };
}
const get = (p) => raw("GET", p);
const post = (p, b) => raw("POST", p, b);

const SRV = await import("./server.js");
await new Promise(r => setTimeout(r, 1600));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok  ", m)) : (fail++, console.log("  FAIL", m)); };
const hdr = (s) => console.log(`\n=========== ${s} ===========`);

let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "vc_net_" + (++_n) + "_" + Date.now(), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
// a REAL 64-byte base58 signature — the confirm route decodes and length-checks it
const fakeSig = () => bs58.encode(nacl.sign.detached(Buffer.from("vc" + Math.random(), "utf8"), nacl.sign.keyPair().secretKey));
async function reconcileTo(id, want, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await SRV._nftReconcileForTest();
    SRV._nftAgeHolderObsForTest(id, 61000);
    const r = SRV._nftRowForTest(id);
    if (want && r && String(r.owner) === String(want)) return r;
  }
  return SRV._nftRowForTest(id);
}

SRV._clearAssetLedger(); SRV._clearAssetReg(); SRV._meCacheClearForTest();
SRV._setNftDasStubForTest(() => ({ dasFailed: true }));

console.log(`\n################ CHIK_NFT_HANDOVER=${HANDOVER ? "1" : "0"}  (CHIK_ME_MARKET=1, CHIK_NFT_MINT=1) ################`);

const SELLER = await mkWallet();      // holds the creature, lists it on Magic Eden
const BUYER = await mkWallet();       // a real Chikoria player with a real game account
const MINT = bs58.encode(nacl.sign.keyPair().publicKey);

const leg = SRV._mintHatchedForTest("chikimon", SELLER.wallet, { sp: "galador", kind: "legendary", lvl: 9 });
SRV._meSetMintForTest(leg.id, MINT);
stub.st.byMint.set(MINT, [coreListingRow({ mint: MINT, seller: SELLER.wallet, price: 2.5 })]);

hdr("1  WHAT THE CLIENT IS TOLD BEFORE IT SPENDS ANYTHING");
const cfg = await get("/nft/market/config");
console.log(`     /nft/market/config -> ${cfg.status}  handoverOn=${JSON.stringify(cfg.body.handoverOn)}  reconcileOn=${JSON.stringify(cfg.body.reconcileOn)}  tradingReady=${JSON.stringify(cfg.body.tradingReady)}`);
chk(Object.hasOwn(cfg.body, "handoverOn"),
  `the server DOES publish handoverOn (=${JSON.stringify(cfg.body.handoverOn)}) — the client has the fact it needs`);

hdr("2  A REAL PURCHASE IS BUILT AND CONFIRMED");
const ownerBefore = SRV._nftRowForTest(leg.id).owner;
const buy = await post("/nft/market/buy", { wallet: BUYER.wallet, mktToken: BUYER.mktToken, tokenMint: MINT, maxPriceSol: 2.5 });
console.log(`     POST /nft/market/buy -> ${buy.status}  priceSol=${JSON.stringify(buy.body.priceSol)}  txBytes=${JSON.stringify(buy.body.bytes)}  ver=${JSON.stringify(buy.body.ver)}`);
chk(buy.status === 200 && typeof buy.body.tx === "string" && buy.body.tx.length > 0,
  `the server builds a REAL, signable purchase transaction with the hand-over off: status=${buy.status}, tx length=${(buy.body.tx || "").length}`);
const conf = await post("/nft/market/confirm", { wallet: BUYER.wallet, mktToken: BUYER.mktToken, tokenMint: MINT, action: "buy", signature: fakeSig() });
console.log(`     POST /nft/market/confirm -> ${conf.status}  applied=${JSON.stringify(conf.body.applied)}  settlesVia=${JSON.stringify(conf.body.settlesVia)}  handoverOn=${JSON.stringify(conf.body.handoverOn)}  reconcileOn=${JSON.stringify(conf.body.reconcileOn)}`);
chk(conf.status === 200, `the confirm is accepted: ${conf.status}`);

hdr("3  THE CHAIN NOW SAYS THE BUYER OWNS IT. DOES CHIKORIA?");
SRV._setNftDasStubForTest((m) => (m === MINT
  ? { owner: BUYER.wallet, burned: false, collection: COLLECTION, iface: "MplCoreAsset" }
  : { dasFailed: true }));
const after = await reconcileTo(leg.id, BUYER.wallet);
console.log(`     registry row after reconcile: owner=${String(after.owner).slice(0, 10)}…  (seller was ${String(ownerBefore).slice(0, 10)}…, buyer is ${BUYER.wallet.slice(0, 10)}…)`);
console.log(`     pendingHandover = ${JSON.stringify(after.pendingHandover ? { to: String(after.pendingHandover.to).slice(0, 10) + "…", dormant: after.pendingHandover.dormant } : null)}`);
const migrated = String(after.owner) === String(BUYER.wallet);
console.log(`     THE CREATURE MIGRATED IN-GAME: ${migrated}`);

const buyerNews = SRV._nftNewsForTest(BUYER.wallet);
const sellerNews = SRV._nftNewsForTest(SELLER.wallet);
console.log(`     buyer notices  = ${JSON.stringify(buyerNews.map(n => n.kind))}`);
console.log(`     seller notices = ${JSON.stringify(sellerNews.map(n => n.kind))}`);
if (buyerNews.length) console.log(`       buyer text : ${buyerNews[0].text}`);
if (sellerNews.length) console.log(`       seller text: ${sellerNews[0].text}`);

// what /assets/mine — the roster the client actually renders from — says for each side
const bMine = await get(`/assets/mine?wallet=${BUYER.wallet}&mktToken=${BUYER.mktToken}`);
const sMine = await get(`/assets/mine?wallet=${SELLER.wallet}&mktToken=${SELLER.mktToken}`);
const bHas = (bMine.body.chikimon || []).some(r => r.id === leg.id);
const sHas = (sMine.body.chikimon || []).some(r => r.id === leg.id);
console.log(`     /assets/mine says buyer holds it = ${bHas}; seller still holds it = ${sHas}`);

if (HANDOVER) {
  chk(migrated, `HANDOVER=1: the paid-for creature reached the buyer (owner==buyer = ${migrated})`);
  chk(buyerNews.some(n => n.kind === "arrived"), `HANDOVER=1: the buyer gets an 'arrived' notice (kinds: ${JSON.stringify(buyerNews.map(n => n.kind))})`);
  chk(sellerNews.some(n => n.kind === "sold"), `HANDOVER=1: the seller gets the farewell (kinds: ${JSON.stringify(sellerNews.map(n => n.kind))})`);
  chk(bHas && !sHas, `HANDOVER=1: /assets/mine agrees — buyer=${bHas}, seller=${sHas}`);
} else {
  // THIS IS THE FINDING, STATED AS A MEASUREMENT AND NOT AS AN OPINION.
  chk(!migrated, `HANDOVER=0: the creature did NOT migrate — owner is still ${String(after.owner) === String(ownerBefore) ? "the SELLER" : "someone else"} after ${6} reconcile passes and the 60s dwell`);
  chk(buyerNews.length === 0,
    `HANDOVER=0: the buyer who just paid gets ZERO notices (${buyerNews.length}) — nothing tells them the creature is not coming`);
  chk(!bHas && sHas,
    `HANDOVER=0: /assets/mine — buyer holds it = ${bHas}, seller still holds it = ${sHas}. The buyer paid and the seller kept the creature.`);
  console.log("");
  console.log("     >>> A buyer on this build pays real SOL, receives the NFT on chain, and is told by");
  console.log("     >>> Market.gd:2048 'the creature arrives in your satchel once the sale settles —");
  console.log("     >>> usually a few minutes'. Measured above: it never arrives, and no notice is");
  console.log("     >>> ever queued. The server publishes handoverOn=false in /nft/market/config and");
  console.log("     >>> the client (Chain.gd) never reads that key — grep: 0 occurrences outside probes.");
}

hdr("4  THE OTHER HALF OF THE SAME QUESTION: THE SELLER'S CREATURE WHILE LISTED");
const SELLER2 = await mkWallet();
const MINT2 = bs58.encode(nacl.sign.keyPair().publicKey);
const leg2 = SRV._mintHatchedForTest("chikimon", SELLER2.wallet, { sp: "adalor", kind: "legendary", lvl: 5 });
SRV._meSetMintForTest(leg2.id, MINT2);
stub.st.byMint.set(MINT2, []);
stub.st.wallets.set(SELLER2.wallet, [{ mintAddress: MINT2, tokenAddress: MINT2, owner: SELLER2.wallet,
  name: "Adalor #1", collection: "chiki_monsters", listStatus: "unlisted", supply: 1, isCompressed: false,
  sellerFeeBasisPoints: 2000, price: 0, primarySaleHappened: false, properties: {}, attributes: [] }]);
const lst = await post("/nft/market/list", { wallet: SELLER2.wallet, mktToken: SELLER2.mktToken, tokenMint: MINT2, priceSol: 3.25 });
console.log(`     POST /nft/market/list -> ${lst.status}`);
await post("/nft/market/confirm", { wallet: SELLER2.wallet, mktToken: SELLER2.mktToken, tokenMint: MINT2, action: "list", signature: fakeSig() });
// Magic Eden's modern Core listing keeps the SELLER as the on-chain owner (freeze delegate), so DAS
// keeps saying "seller". Drive the real reconcile over that.
SRV._setNftDasStubForTest((m) => (m === MINT2
  ? { owner: SELLER2.wallet, burned: false, collection: COLLECTION, iface: "MplCoreAsset" }
  : { dasFailed: true }));
await SRV._nftReconcileForTest();
await SRV._nftReconcileForTest();
const lrow = SRV._nftRowForTest(leg2.id);
console.log(`     after listing + 2 reconciles: owner=${String(lrow.owner) === SELLER2.wallet ? "STILL THE SELLER" : "MOVED"}  listedOffchain=${lrow.listedOffchain}  meList=${lrow.meList ? "present" : "absent"}  state=${lrow.state}`);
chk(String(lrow.owner) === SELLER2.wallet,
  `listing never takes the creature away: owner still the seller = ${String(lrow.owner) === SELLER2.wallet}`);
const s2mine = await get(`/assets/mine?wallet=${SELLER2.wallet}&mktToken=${SELLER2.mktToken}`);
const s2has = (s2mine.body.chikimon || []).some(r => r.id === leg2.id);
chk(s2has, `and it is still in the seller's playable roster while listed: /assets/mine holds it = ${s2has}`);

hdr("5  DOES A LISTED CREATURE STAY OUT OF EVERY OTHER DISPOSAL PATH?");
const el = SRV._nftEligibilityForTest(SRV._assetRowForTest(leg2.id), SELLER2.wallet);
console.log(`     nftEligibility while listed = ${JSON.stringify(el)}`);
chk(String(el && (el.code || el.state || el)) !== "ok",
  `a listed creature is not simultaneously mintable/free: eligibility = ${JSON.stringify(el)}`);
const blocked = SRV._meBoardBlockedForTest(SELLER2.wallet, leg2.id);
console.log(`     _meBoardBlockedForTest = ${JSON.stringify(blocked)}`);
chk(!!blocked, `the in-game Trading Post gate blocks selling it for $CHIKI too: ${JSON.stringify(blocked)}`);

console.log(`\nVC_STRANDED_DONE handover=${HANDOVER ? 1 : 0} pass=${pass} fail=${fail}`);
process.exit(0);
