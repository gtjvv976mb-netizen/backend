// me_stub.mjs — a LOCAL STUB MAGIC EDEN. Speaks the exact request/response shapes recorded from
// Magic Eden's live free endpoints and their published OpenAPI + official SDK, so the proxy in
// server.js can be verified end to end WITHOUT an API key and WITHOUT ever touching the real
// instruction API (house rule). Same discipline the NFT mint work used: stub the part you cannot
// legally exercise, verify everything around it, and say plainly what only a real key can confirm.
//
// It also does the things the REAL Magic Eden does that break naive proxies:
//   * a 429 whose body is PLAIN TEXT with no JSON envelope,
//   * a `limit` it does not honour (returns more rows than asked),
//   * a /stats response with the floorPrice KEY ABSENT when nothing is listed,
//   * an instruction response whose transaction is a Node Buffer serialised to JSON.
import http from "node:http";
import { Transaction, VersionedTransaction, TransactionMessage, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";

export const ME_KEY = "me_stub_key_DO_NOT_LEAK_2f8a1c9b4e7d6a30";   // the sim greps every body for this

const BLOCKHASH = "11111111111111111111111111111111";

// A REAL legacy transaction and a REAL v0 transaction, so the envelope handling is tested against
// actual Solana bytes rather than a hand-rolled fake.
export function makeLegacyTx(from, to, extraSigner) {
  const tx = new Transaction();
  tx.feePayer = new PublicKey(from);
  tx.recentBlockhash = BLOCKHASH;
  tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports: 1000 }));
  if (extraSigner) { tx.partialSign(extraSigner); }
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
export function makeV0Tx(from, to, extraSigner) {
  const msg = new TransactionMessage({
    payerKey: new PublicKey(from), recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports: 1000 })],
  }).compileToV0Message();
  const vt = new VersionedTransaction(msg);
  if (extraSigner) { try { vt.sign([extraSigner]); } catch (e) {} }
  return Buffer.from(vt.serialize());
}
const buf = (b) => ({ type: "Buffer", data: Array.from(b) });

// A listing row with the EXACT key set observed live on a Metaplex Core M2 listing.
export function coreListingRow(o) {
  const mint = o.mint;
  return {
    pdaAddress: o.pda || "C9SrsVCmhExwq4pdZa8SLL3dJnTwzT4ZNP2FEvfYXWsR",
    auctionHouse: o.pool ? "" : (o.auctionHouse || "E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe"),
    tokenAddress: mint,                    // Core: tokenAddress == tokenMint (20/20, 40/40, 85/85 live)
    tokenMint: mint,
    seller: o.seller,
    sellerReferral: o.sellerReferral || "autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2",
    tokenSize: 1,
    price: o.price,                        // SOL float
    priceInfo: { solPrice: { rawAmount: String(Math.round(o.price * 1e9)), address: "So11111111111111111111111111111111111111112", decimals: 9 } },
    rarity: { meInstant: { rank: o.rank || 788 } },
    extra: { img: o.img === undefined ? "" : o.img },     // EMPTY STRING on a live sample — must fall back
    expiry: o.expiry === undefined ? -1 : o.expiry,
    listingSource: o.pool ? "MMM" : "M2",
    token: {
      mintAddress: mint, owner: o.seller, supply: 1,
      collection: "chiki_monsters", collectionName: "Chiki Monsters",
      name: o.name || "Galador #1", updateAuthority: o.seller,
      primarySaleHappened: false, sellerFeeBasisPoints: 2000,
      image: o.image || "http://127.0.0.1:1/img/x.png",
      attributes: [{ trait_type: "species", value: "galador" }],
      properties: { category: "image", files: [], creators: [] },
      isCompressed: false, price: o.price, listStatus: "listed",
      tokenAddress: mint,
      priceInfo: { solPrice: { rawAmount: String(Math.round(o.price * 1e9)), address: "So11111111111111111111111111111111111111112", decimals: 9 } },
    },
  };
}

export function startStub(opts = {}) {
  const st = {
    key: opts.key || ME_KEY,
    listings: [],                       // collection listings (array of coreListingRow)
    byMint: new Map(),                  // mint -> [rows]  (the /v2/tokens/{mint}/listings answer)
    wallets: new Map(),                 // wallet -> [wallet-token rows]
    pools: new Map(),                   // mint -> pool object
    stats: { symbol: "chiki_monsters", listedCount: 0 },   // floorPrice ABSENT on purpose
    calls: new Map(),                   // path prefix -> count
    last: new Map(),                    // path prefix -> last query object
    lastAuth: new Map(),                // path prefix -> authorization header seen
    rate429: false,                     // flip to make EVERY endpoint answer the real plain-text 429
    txMode: "v0-cosigned",              // v0-cosigned | v0 | legacy | both | garbage
    imgBytes: Buffer.from("89504e470d0a1a0a", "hex"),      // PNG magic — enough for a content-type test
    delayMs: 0,
  };
  const bump = (k, q, auth) => {
    st.calls.set(k, (st.calls.get(k) || 0) + 1);
    st.last.set(k, q); st.lastAuth.set(k, auth || "");
  };
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json" }); res.end(b); };

  function txBody(from, to) {
    const cosigner = Keypair.generate();
    if (st.txMode === "garbage") return { nothing: true };
    if (st.txMode === "legacy") return { tx: buf(makeLegacyTx(from, to)) };
    if (st.txMode === "v0") return { tx: buf(makeLegacyTx(from, to)), v0: { tx: buf(makeV0Tx(from, to)) } };
    if (st.txMode === "both") return { tx: buf(makeLegacyTx(from, to)), txSigned: buf(makeLegacyTx(from, to, cosigner)), v0: { tx: buf(makeV0Tx(from, to)) } };
    // default: what Magic Eden's own SDK expects — v0, cosigned
    return { tx: buf(makeLegacyTx(from, to)), v0: { tx: buf(makeV0Tx(from, to)), txSigned: buf(makeV0Tx(from, to, cosigner)) } };
  }

  const srv = http.createServer(async (req, res) => {
    if (st.delayMs) await new Promise(r => setTimeout(r, st.delayMs));
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams.entries());
    const auth = String(req.headers.authorization || "");
    // THE REAL 429: plain text, no JSON envelope at all.
    if (st.rate429) {
      res.writeHead(429, { "content-type": "text/plain" });
      return res.end("You have exceeded the requests in 1 min limit! Please try again soon.");
    }
    // ---- free reads ----
    let m;
    if ((m = p.match(/^\/v2\/collections\/([^/]+)\/listings$/))) {
      bump("listings", q, auth);
      // Magic Eden does NOT reliably honour `limit` — return MORE than asked, on purpose.
      return json(res, 200, st.listings);
    }
    if ((m = p.match(/^\/v2\/collections\/([^/]+)\/stats$/))) { bump("stats", q, auth); return json(res, 200, st.stats); }
    if ((m = p.match(/^\/v2\/collections\/([^/]+)\/activities$/))) { bump("activities", q, auth); return json(res, 200, []); }
    if ((m = p.match(/^\/v2\/tokens\/([^/]+)\/listings$/))) { bump("token", q, auth); return json(res, 200, st.byMint.get(m[1]) || []); }
    if ((m = p.match(/^\/v2\/wallets\/([^/]+)\/tokens$/))) { bump("wallet", q, auth); return json(res, 200, st.wallets.get(m[1]) || []); }
    if ((m = p.match(/^\/v2\/mmm\/token\/([^/]+)\/pools$/))) { bump("pools", q, auth); return json(res, 200, { results: st.pools.has(m[1]) ? [st.pools.get(m[1])] : [] }); }
    if (p === "/img/x.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(st.imgBytes); }
    // ---- KEYED instruction endpoints ----
    if (p.startsWith("/v2/instructions/")) {
      const kind = p.slice("/v2/instructions/".length);
      bump(kind, q, auth);
      if (auth !== "Bearer " + st.key) return json(res, 401, { message: "Unauthorized" });
      const from = q.buyer || q.seller;
      const to = q.seller || q.buyer || from;
      if (!from) return json(res, 400, { message: "missing wallet" });
      return json(res, 200, txBody(from, to));
    }
    return json(res, 404, { message: "Not Found." });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ st, srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise(r => srv.close(r)) }));
  });
}
