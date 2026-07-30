#!/usr/bin/env node
// A REFUSAL MUST BE SURVIVABLE. `cancelled:false` used to mean two different things — "this already
// sold" and "I have no record of this" — and the client only returns the goods on `true`
// (Market.gd:519). So any listing the server refused or dropped left the seller's materials deducted
// (Market.gd:405) with no way to get them back. The LIST_QTY_MAX refusal walked straight into that,
// and its own message told the seller to cancel: advice that could not work.
//
// What must hold:
//   * a listing the server NEVER had cancels as `cancelled:true` -> the client reclaims
//   * a listing that genuinely SOLD still cancels as `cancelled:false` -> no double-pay
//   * an id with an uncredited sale receipt is likewise never reclaimable
//   * the never-had branch does NOT blacklist the id (that was the id-poisoning bug) so an honest
//     seller can immediately re-list it
//   * an id that WAS really removed is still blacklisted, so a sold row can never resurrect
// No live backend, no on-chain. Throwaway keypairs, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59996";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8798";
process.env.NETWORK = "devnet";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;          // soft settle path, so a sale can be produced without a chain

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8798";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/market/list")).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }
let seq = 0; const lid = () => "R" + (++seq) + "_" + crypto.randomBytes(3).toString("hex");

async function main() {
  await import("./server.js");
  await waitUp();
  console.log("\n=== A REFUSAL MUST BE SURVIVABLE ===\n");

  const mk = async () => {
    const kp = Keypair.generate();
    const sid = "net_" + kp.publicKey.toBase58().slice(0, 10);
    const v = await post("/verify", { ...signIn(kp), netId: sid });
    return { wallet: kp.publicKey.toBase58(), sid, tok: v.json.mktToken };
  };
  const list = (t, l) => post("/market/op", { sid: t.sid, op: "list", mktToken: t.tok, wallet: t.wallet, listing: l });
  const cancel = (t, id) => post("/market/op", { sid: t.sid, op: "cancel", mktToken: t.tok, wallet: t.wallet, listing: { id } });
  const board = async () => (await get("/market/list")).json.listings || [];

  const seller = await mk();
  const buyer = await mk();
  ok("seller and buyer signed in", !!seller.tok && !!buyer.tok);

  // ---------- 1. THE BUG I SHIPPED: a listing refused for an impossible quantity ----------
  const refused = lid();
  const r = await list(seller, { id: refused, kind: "mat", item: "crystal", qty: 999999, price: 5000 });
  ok("the impossible listing is still refused", r.status === 409, `status ${r.status}`);
  ok("...and the server genuinely has no such row", !(await board()).some(x => x.id === refused));
  const c = await cancel(seller, refused);
  ok("cancelling it now returns cancelled:TRUE, so the client reclaims the goods",
     c.status === 200 && c.json.cancelled === true, `status ${c.status} cancelled=${c.json.cancelled}`);

  // the never-had branch must NOT blacklist — the seller has to be able to re-list that id
  const relist = await list(seller, { id: refused, kind: "mat", item: "crystal", qty: 500, price: 900 });
  ok("...and the id was NOT poisoned — a sane re-list of it succeeds", relist.status === 200,
     `status ${relist.status} ${JSON.stringify(relist.json.error || "")}`);
  await cancel(seller, refused);

  // ---------- 2. a listing that never existed at all (dropped/pruned) ----------
  const ghost = lid();
  const cg = await cancel(seller, ghost);
  ok("a listing the server never saw also cancels as true", cg.status === 200 && cg.json.cancelled === true,
     `cancelled=${cg.json.cancelled}`);

  // ---------- 3. THE COUNTER-TEST: a real sale must NEVER be reclaimable ----------
  const sold = lid();
  const ls = await list(seller, { id: sold, kind: "mat", item: "wood", qty: 10, price: 50 });
  ok("a normal listing is accepted", ls.status === 200, `status ${ls.status}`);
  const buy = await post("/market/op", { sid: buyer.sid, op: "buy", mktToken: buyer.tok, wallet: buyer.wallet, listing: { id: sold } });
  ok("the buyer bought it", buy.status === 200, `status ${buy.status} ${JSON.stringify(buy.json).slice(0, 120)}`);
  ok("...so it left the board", !(await board()).some(x => x.id === sold));
  const cs = await cancel(seller, sold);
  ok("cancelling a SOLD listing still returns false — the goods are NOT handed back",
     cs.json.cancelled === false, `cancelled=${cs.json.cancelled}`);

  // and it can never resurrect: a real removal still blacklists
  const resurrect = await list(seller, { id: sold, kind: "mat", item: "wood", qty: 10, price: 50 });
  ok("...and a sold id can never be re-listed (resurrection guard intact)", resurrect.status === 409,
     `status ${resurrect.status}`);

  // ---------- 4. an uncredited receipt also blocks a reclaim ----------
  const sales = await get(`/market/sales?sid=${encodeURIComponent(seller.sid)}`);
  const hasReceipt = ((sales.json.sales) || []).some(s => s.id === sold);
  ok("the seller holds an uncredited receipt for the sold row", hasReceipt,
     `receipts=${JSON.stringify((sales.json.sales || []).map(s => s.id))}`);

  // ---------- 5. an honest cancel of a LIVE listing still works exactly as before ----------
  const live = lid();
  await list(seller, { id: live, kind: "mat", item: "stone", qty: 7, price: 30 });
  const cl = await cancel(seller, live);
  ok("cancelling a live listing returns true", cl.json.cancelled === true, `cancelled=${cl.json.cancelled}`);
  ok("...and it left the board", !(await board()).some(x => x.id === live));
  const reuse = await list(seller, { id: live, kind: "mat", item: "stone", qty: 7, price: 30 });
  ok("...and a genuinely cancelled id IS blacklisted (real removal still consumes)", reuse.status === 409,
     `status ${reuse.status}`);

  // ---------- 6. another seller cannot reclaim my id ----------
  const other = await mk();
  const mine = lid();
  await list(seller, { id: mine, kind: "mat", item: "honey", qty: 3, price: 20 });
  const steal = await cancel(other, mine);
  ok("a stranger cancelling MY live id does not remove it", (await board()).some(x => x.id === mine),
     `their cancelled=${steal.json.cancelled}`);
  // they get cancelled:true (they have no such row and no receipt) but nothing of mine moved — the
  // reclaim happens in THEIR client against goods THEY escrowed, which for this id is nothing.
  ok("...and my listing is untouched", (await board()).find(x => x.id === mine)?.sid === seller.sid);

  console.log(`\nCANCEL_RECLAIM_SIM  pass=${pass} fail=${fail}`);
  if (fail) { console.log("failures:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SIM ERROR", e); process.exit(1); });
