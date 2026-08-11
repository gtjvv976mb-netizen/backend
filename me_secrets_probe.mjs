// me_secrets_probe.mjs — DOES THE MAGIC EDEN API KEY EVER LEAVE THIS PROCESS?
//
// ME_API_KEY moves money and is rate-limited per key across every player. A single response body,
// error message or log line carrying it is a giveaway. This probe sweeps a wide surface — every new
// route on every failure mode, the surrounding NFT routes, the admin routes, health and stats — and
// greps EVERY response body AND everything written to stdout/stderr for the key's literal value.
//
// It also tests the nastiest case: an UPSTREAM that echoes the key back inside its own error body. A
// naive proxy forwards that straight to the player. Ours scrubs it.
//
// Throwaway keypairs, dead RPC, memory store, stub Magic Eden. Nothing real is touched.
import nacl from "tweetnacl";
import bs58 from "bs58";
import http from "node:http";
import { ME_KEY, coreListingRow } from "./me_stub.mjs";

// A HOSTILE/BUGGY STUB: half its answers put the key in the body, the way a badly written upstream
// (or a proxy that logged the request URL) actually would.
const leaky = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname.startsWith("/v2/instructions/")) {
    // the key, echoed back inside three different error shapes their SDK is known to probe
    if (u.searchParams.get("price") === "1.5") return send(400, { message: `bad request for key ${ME_KEY}` });
    if (u.searchParams.get("price") === "2.5") return send(400, { error: `rejected: ${ME_KEY}` });
    return send(500, { error: { message: `upstream blew up while using ${ME_KEY}` } });
  }
  if (/\/listings$/.test(u.pathname)) return send(200, LISTINGS);
  if (/\/stats$/.test(u.pathname)) return send(200, { symbol: "chiki_monsters", listedCount: 1 });
  if (/\/tokens$/.test(u.pathname)) return send(200, WALLET_ROWS);
  return send(404, { message: "Not Found." });
});
await new Promise(r => leaky.listen(0, "127.0.0.1", r));
const LEAK_BASE = `http://127.0.0.1:${leaky.address().port}`;

const T = nacl.sign.keyPair();
const TEAM = bs58.encode(nacl.sign.keyPair().publicKey);
const COLLECTION = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(T.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39321";
process.env.ADMIN_KEY = "test-admin-key"; process.env.TEAM_WALLET = TEAM;
process.env.CHIK_ROSTER_GUARD = "off";
delete process.env.DATABASE_URL;
process.env.CHIK_ME_MARKET = "1";
process.env.ME_API_BASE = LEAK_BASE;
process.env.ME_API_KEY = ME_KEY;
process.env.ME_RL_READ_GAP_MS = "1"; process.env.ME_RL_WRITE_GAP_MS = "1";
process.env.ME_RL_READ_PER_MIN = "900"; process.env.ME_RL_WRITE_PER_MIN = "900";
process.env.CHIK_NFT_MINT = "1"; process.env.NFT_COLLECTION = COLLECTION;

// CAPTURE EVERY LOG LINE. A key in a log is a key in whatever ships those logs.
const LOGS = [];
for (const k of ["log", "warn", "error", "info", "debug"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { try { LOGS.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); } catch (e) {} orig(...a); };
}
const _we = process.stderr.write.bind(process.stderr), _wo = process.stdout.write.bind(process.stdout);
process.stderr.write = (c, ...r) => { try { LOGS.push(String(c)); } catch (e) {} return _we(c, ...r); };
process.stdout.write = (c, ...r) => { try { LOGS.push(String(c)); } catch (e) {} return _wo(c, ...r); };

const B = `http://127.0.0.1:${process.env.PORT}`;
const BODIES = [];
async function raw(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  let r, text = "";
  try { r = await fetch(B + p, init); text = await r.text(); } catch (e) { return { status: 0, body: {}, text: "" }; }
  BODIES.push({ method, p, status: r.status, text });
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: j || {}, text };
}
const get = (p) => raw("GET", p), post = (p, b) => raw("POST", p, b);

const MINT = bs58.encode(nacl.sign.keyPair().publicKey);
let LISTINGS = [], WALLET_ROWS = [];

const SRV = await import("./server.js");
await new Promise(r => setTimeout(r, 1600));
SRV._clearAssetLedger(); SRV._clearAssetReg(); SRV._meCacheClearForTest();
SRV._setNftDasStubForTest(() => ({ dasFailed: true }));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };

let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "sec_net_" + (++_n) + "_" + Date.now();
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken, netId };
}

console.log(`\n================ me_secrets_probe — leaky upstream at ${LEAK_BASE} ================`);
const A = await mkWallet();
const row = SRV._mintHatchedForTest("chikimon", A.wallet, { sp: "galador", kind: "legendary", lvl: 5 });
SRV._meSetMintForTest(row.id, MINT);
LISTINGS = [coreListingRow({ mint: MINT, seller: A.wallet, price: 1.5 })];
WALLET_ROWS = [{ mintAddress: MINT, tokenAddress: MINT, owner: A.wallet, collection: "chiki_monsters",
                 listStatus: "unlisted", name: "Galador #1", supply: 1, price: 0, sellerFeeBasisPoints: 2000,
                 primarySaleHappened: false, isCompressed: false, properties: {}, attributes: [] }];

console.log(`\n— the upstream deliberately echoes the key in THREE error shapes —`);
{
  const r1 = await post("/nft/market/list", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, priceSol: 1.5 });
  console.log(`  upstream {message:"…<key>…"} -> ${r1.status} ${JSON.stringify(r1.body.error)}`);
  chk(!r1.text.includes(ME_KEY), `body carries no key (${r1.text.length}B)`);
  const r2 = await post("/nft/market/list", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, priceSol: 2.5 });
  console.log(`  upstream {error:"…<key>…"} -> ${r2.status} ${JSON.stringify(r2.body.error)}`);
  chk(!r2.text.includes(ME_KEY), `body carries no key (${r2.text.length}B)`);
  const r3 = await post("/nft/market/list", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, priceSol: 3.5 });
  console.log(`  upstream 500 {error:{message:"…<key>…"}} -> ${r3.status} ${JSON.stringify(r3.body.error)}`);
  chk(!r3.text.includes(ME_KEY), `body carries no key (${r3.text.length}B)`);
  chk(r1.status === 400 && r2.status === 400 && r3.status === 502, `mapped to ${r1.status}/${r2.status}/${r3.status} — a 5xx becomes 502, a 4xx stays 400`);
}

console.log(`\n— the wide sweep —`);
const SURFACE = [
  ["GET", `/nft/market/config?wallet=${A.wallet}&mktToken=${A.mktToken}`],
  ["GET", `/nft/market/listings?wallet=${A.wallet}&mktToken=${A.mktToken}`],
  ["GET", `/nft/market/listings?wallet=${A.wallet}&mktToken=${A.mktToken}&offset=40&limit=100`],
  ["GET", `/nft/market/listings`],
  ["GET", `/nft/market/mine?wallet=${A.wallet}&mktToken=${A.mktToken}`],
  ["GET", `/nft/market/mine`],
  ["GET", `/nft/market/img/0000000000000000000`],
  ["POST", "/nft/market/buy", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, maxPriceSol: 99 }],
  ["POST", "/nft/market/buy", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT }],
  ["POST", "/nft/market/buy", {}],
  ["POST", "/nft/market/list", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, priceSol: 1.5 }],
  ["POST", "/nft/market/list", { wallet: A.wallet, mktToken: A.mktToken }],
  ["POST", "/nft/market/delist", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT }],
  ["POST", "/nft/market/delist", {}],
  ["POST", "/nft/market/confirm", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, action: "list", signature: bs58.encode(Buffer.alloc(64, 3)) }],
  ["POST", "/nft/market/confirm", { wallet: A.wallet, mktToken: A.mktToken, tokenMint: MINT, action: "buy", signature: "bad" }],
  ["GET", "/assets/nft/config"],
  ["GET", `/assets/cert?id=${row.id}`],
  ["GET", `/assets/nft/meta/${row.id}`],
  ["POST", "/assets/nft/prepare", { wallet: A.wallet, mktToken: A.mktToken, id: row.id }],
  ["POST", "/assets/nft/mint", { wallet: A.wallet, mktToken: A.mktToken, id: row.id }],
  ["POST", "/assets/nft/reconcile", { key: "test-admin-key" }],
  ["GET", "/assets/nft/reconcile?key=test-admin-key"],
  ["GET", "/health"], ["GET", "/stats"], ["GET", "/leaderboard"], ["GET", "/assets/dex"],
  ["GET", "/assets/census?key=test-admin-key"], ["GET", "/assets/summary?key=test-admin-key"],
  ["GET", `/assets/mine?wallet=${A.wallet}&mktToken=${A.mktToken}`],
  ["GET", "/market/list"],
  ["GET", "/admin/banned?key=test-admin-key"],
  ["POST", "/verify", { wallet: A.wallet, netId: A.netId }],
];
for (const [m, p, b] of SURFACE) await raw(m, p, b);
console.log(`  swept ${SURFACE.length} endpoints; ${BODIES.length} bodies captured, ${BODIES.reduce((a, x) => a + x.text.length, 0)} bytes`);
const leaks = BODIES.filter(b => b.text.includes(ME_KEY));
for (const l of leaks.slice(0, 5)) console.log(`      LEAK ${l.method} ${l.p} -> ${l.text.slice(0, 240)}`);
chk(leaks.length === 0, `ME_API_KEY appears in ${leaks.length} of ${BODIES.length} response bodies`);

// a partial-key check too, so a truncated or re-encoded leak cannot slip past an exact-match grep
const HALF = ME_KEY.slice(0, Math.max(12, Math.floor(ME_KEY.length / 2)));
const partial = BODIES.filter(b => b.text.includes(HALF));
console.log(`  partial-match sweep for the first ${HALF.length} chars ("${HALF.slice(0, 8)}…"): ${partial.length} hits`);
chk(partial.length === 0, `no partial key fragment either (${partial.length})`);
const b64 = Buffer.from(ME_KEY).toString("base64");
const enc = BODIES.filter(b => b.text.includes(b64) || b.text.includes(encodeURIComponent(ME_KEY)));
console.log(`  encoded-form sweep (base64 + percent-encoded): ${enc.length} hits`);
chk(enc.length === 0, `no encoded form of the key either (${enc.length})`);

const logLeaks = LOGS.filter(l => l.includes(ME_KEY) || l.includes(HALF));
console.log(`  ${LOGS.length} log lines captured; containing the key or a fragment: ${logLeaks.length}`);
for (const l of logLeaks.slice(0, 5)) console.log(`      LOG LEAK: ${l.slice(0, 240)}`);
chk(logLeaks.length === 0, `the key appears in ${logLeaks.length} of ${LOGS.length} log lines`);

// And the treasury/admin secrets the house rules care about, while we are here.
const OTHER = [process.env.TREASURY_SECRET, "test-admin-key"];
for (const s of OTHER) {
  const hits = BODIES.filter(b => s && b.text.includes(s));
  console.log(`  sweep for ${s === "test-admin-key" ? "ADMIN_KEY" : "TREASURY_SECRET"}: ${hits.length} hits`);
  chk(hits.length === 0, `${s === "test-admin-key" ? "ADMIN_KEY" : "TREASURY_SECRET"} appears in ${hits.length} bodies`);
}

console.log(`\n================ me_secrets_probe: ${pass} passed, ${fail} failed ================\n`);
leaky.close();
process.exit(fail ? 1 : 0);
