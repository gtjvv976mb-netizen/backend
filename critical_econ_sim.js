// The two CRITICAL economy bugs. Real server in-process, throwaway keypairs, memory store, dead RPC.
import nacl from "tweetnacl";
import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59997";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39191";
// MARKET_ONCHAIN is only true when the flag AND a mint AND a team wallet are all present
// (server.js:3237). Production has all three — a sim that sets only the flag silently runs with the
// on-chain rail OFF and never exercises the interlock at all.
process.env.MARKET_ONCHAIN = "1";
process.env.CHIKI_MINT = "CPYrgdAYWFQD74ZtsR8mEBWW7qnrXnegcn7gDMobpump";
process.env.TEAM_WALLET = "5UyorwoiQkuKxvfWmyjvRVtwoEZmyK3BqTPmH8xkGh1v";
delete process.env.DATABASE_URL;
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const chk = (c, w) => { if (c) { pass++; console.log("  ok:", w); } else { fail++; console.log("  FAIL:", w); } };
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();
const srv = await import("./server.js");
await new Promise(r => setTimeout(r, 1400));

let nid = 0;
async function trader() {
  const kp = nacl.sign.keyPair(), wallet = bs58.encode(kp.publicKey);
  const netId = `net${++nid}${Date.now().toString(36)}`;
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, sid: netId, tok: v.mktToken };
}
const op = (t, o, listing, extra = {}) => post("/market/op", { sid: t.sid, op: o, listing, wallet: t.wallet, mktToken: t.tok, ...extra });
const board = async () => (await get("/market/list")).listings || [];
const onBoard = async (id) => (await board()).some(x => x.id === id);

console.log("— CRITICAL 1: a sold listing must never come back, however long the seller is away —");
{
  const seller = await trader(), buyer = await trader();
  await op(seller, "list", { id: "R1", item: "gold", kind: "mat", qty: 99, price: 500, seller: "S" });
  chk(await onBoard("R1"), "listing goes up");
  const row = (await board()).find(x => x.id === "R1");
  chk(row && row.wallet === seller.wallet, `the row carries the seller's PROVEN wallet (${row && row.wallet ? "yes" : "NO"})`);

  // it sells (on-chain rail is live, so soft-buy is refused — consume it the way a real sale does)
  srv._soldIdsForTest().set("R1", Date.now());
  await post("/market/op", { sid: seller.sid, op: "cancel", listing: { id: "R1" }, wallet: seller.wallet, mktToken: seller.tok });
  chk(!(await onBoard("R1")), "and leaves the board once sold");

  // the seller stays offline for more than a day, then their client re-pushes its local copy
  srv._soldIdsForTest().set("R1", Date.now() - 25 * 3600 * 1000);
  await get("/market/list");                     // forces pruneMarket()
  await op(seller, "list", { id: "R1", item: "gold", kind: "mat", qty: 99, price: 500, seller: "S" });
  chk(!(await onBoard("R1")), "25h later the client's re-push is STILL refused — no resurrection, no double sale");

  // and the memory is still bounded
  const before = srv._soldIdsForTest().size;
  for (let i = 0; i < 20; i++) srv._soldIdsForTest().set("bulk" + i, Date.now());
  chk(srv._soldIdsForTest().size === before + 20, "the sold-id memory still accepts new ids (bounded by count, not age)");
}

console.log("— CRITICAL 2: a blank-wallet listing can no longer be minted against —");
{
  const attacker = await trader(), ghost = { sid: "ghost-" + Date.now() };
  // the exploit: list with a blank wallet at the price ceiling, then soft-buy it unauthenticated
  await op(attacker, "list", { id: "EXPL1", item: "gold", kind: "mat", qty: 1, price: 9999999, seller: "A", wallet: "" });
  const row = (await board()).find(x => x.id === "EXPL1");
  chk(!!row, "the listing is accepted");
  chk(row && row.wallet === attacker.wallet,
      `but its wallet is the PROVEN one, not the blank they asked for (${row && row.wallet ? row.wallet.slice(0, 8) + "…" : "BLANK"})`);
  const buy = await post("/market/op", { sid: ghost.sid, op: "buy", listing: { id: "EXPL1" }, buyerName: "ghost" });
  chk(!!buy.error, `the unauthenticated soft-buy is refused (${buy.error})`);
  const sales = await get(`/market/sales?sid=${attacker.sid}`).catch(() => ({}));
  const queued = (sales && sales.sales) ? sales.sales.length : 0;
  chk(queued === 0, `and no sale was queued for the attacker to credit (${queued} rows)`);
  chk(await onBoard("EXPL1"), "the listing is untouched — nothing was settled");
}

console.log(`CRITECON_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
