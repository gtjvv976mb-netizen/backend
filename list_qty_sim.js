#!/usr/bin/env node
// IMPOSSIBLE-QUANTITY LISTINGS — boots the REAL server.js in-process and tries to put on the board
// quantities the game cannot produce, which is how a fabricated `mats` value in a client-authored
// save became a claim on a real buyer's $CHIKI.
//
// What must hold:
//   * an absurd quantity is REFUSED (409), not clamped, and never reaches the board
//   * the ceiling is per-kind: fantasy fish are far rarer than materials, so they are capped tighter
//   * a REAL player's biggest plausible hoard still lists fine — this is the false-positive test,
//     and it is the one that matters, because a wrong refusal strands someone's goods
//   * the refusal is COUNTED for the operator, with the worst attempt per seller
//   * nothing about ordinary listing/cancel behaviour changed
// No live backend, no on-chain, no real data. Throwaway keypairs, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59997";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8797";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");   // sim-local, never a real key
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8797";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; fails.push(name + (extra ? " — " + extra : "")); console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/market/list")).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }

let seq = 0;
const lid = () => "L" + (++seq) + "_" + crypto.randomBytes(3).toString("hex");

async function main() {
  const srv = await import("./server.js");
  await waitUp();
  srv._clearOwnBook();
  srv._setFfishAuthorityForTest(false);   // this sim tests the MAGNITUDE cap, not the fish bind
  console.log("\n=== IMPOSSIBLE-QUANTITY LISTINGS ===\n");

  const mk = async () => {
    const kp = Keypair.generate();
    const sid = "net_" + kp.publicKey.toBase58().slice(0, 10);
    const v = await post("/verify", { ...signIn(kp), netId: sid });
    return { wallet: kp.publicKey.toBase58(), sid, tok: v.json.mktToken };
  };
  const list = (t, l) => post("/market/op", { sid: t.sid, op: "list", mktToken: t.tok, wallet: t.wallet, listing: l });
  const board = async () => (await get("/market/list")).json.listings || [];

  const a = await mk();
  ok("seller signed in with a market token", !!a.tok);
  // This sim tests the MAGNITUDE cap, which now sits behind the acquisition bound. Grant the
  // entitlement so a refusal here can only ever be the quantity ceiling under test.
  for (const m of ["crystal", "wood", "stone", "honey"]) srv._grantOwnForTest(a.wallet, m, 60000);

  // ---------- 1. the attack: a fabricated hoard ----------
  const big = lid();
  const r1 = await list(a, { id: big, kind: "mat", item: "crystal", qty: 999999, price: 500000 });
  ok("999,999 crystal is REFUSED", r1.status === 409, `status ${r1.status} ${JSON.stringify(r1.json.error || "")}`);
  ok("...and reports the ceiling so the client can explain it", Number(r1.json.max) === 20000, `max=${r1.json.max}`);
  let b = await board();
  ok("...and never reached the board", !b.some(x => x.id === big), `board has ${b.length} rows`);

  // REFUSED, NOT CLAMPED — a clamp would silently turn the absurd into the plausible.
  ok("no clamped survivor was created under that id", !b.some(x => x.id === big && Number(x.qty) === 20000));

  // ---------- 2. the boundary is exact ----------
  const atCap = lid(), overCap = lid();
  const rAt = await list(a, { id: atCap, kind: "mat", item: "wood", qty: 20000, price: 100 });
  const rOver = await list(a, { id: overCap, kind: "mat", item: "wood", qty: 20001, price: 100 });
  ok("exactly at the cap (20000) is allowed", rAt.status === 200, `status ${rAt.status}`);
  ok("one over the cap (20001) is refused", rOver.status === 409, `status ${rOver.status}`);

  // ---------- 3. per-kind ceilings ----------
  const ff = lid(), ffOk = lid();
  const rFF = await list(a, { id: ff, kind: "ffish", item: "rainbow_fish", qty: 50000, price: 9000 });
  ok("fantasy fish are capped tighter than materials", rFF.status === 409 && Number(rFF.json.max) === 2000,
     `status ${rFF.status} max=${rFF.json.max}`);
  const rFFok = await list(a, { id: ffOk, kind: "ffish", item: "golden_chikifish", qty: 1500, price: 400 });
  ok("a plausible fantasy-fish stack still lists", rFFok.status === 200, `status ${rFFok.status}`);

  // a chikimon is ONE creature — qty is meaningless there and must not be gated by this table
  const ck = lid();
  const rCk = await list(a, { id: ck, kind: "chikimon", item: "dragonos", uid: "u_" + lid(), qty: 1, lvl: 12, price: 800 });
  ok("a chikimon listing is not touched by the quantity table", rCk.status === 200 || rCk.status === 409,
     `status ${rCk.status} (409 only from chikimonSaleBlocked, not the qty cap)`);
  ok("...and if refused it was NOT for quantity", rCk.status !== 409 || Number(rCk.json.max) !== 20000,
     JSON.stringify(rCk.json.error || "allowed"));

  // ---------- 4. THE FALSE-POSITIVE TEST — the one that matters ----------
  // A real player's ceiling on one material, from the actual tables: BAG_CAP[10]=1100, all 12 TASKS
  // total 9, level milestones ~45 lifetime, weekly raid 25. A 200-week raider reaches ~6,150.
  const REAL_MAX = 1100 + 9 + 45 + 25 * 200;
  const honest = await mk();
  for (const m of ["crystal", "wood", "stone"]) srv._grantOwnForTest(honest.wallet, m, 60000);
  const hid = lid();
  const rH = await list(honest, { id: hid, kind: "mat", item: "crystal", qty: REAL_MAX, price: 6000 });
  ok(`a four-year raider's whole crystal hoard (${REAL_MAX}) still lists`, rH.status === 200, `status ${rH.status}`);
  const hid2 = lid();
  const rH2 = await list(honest, { id: hid2, kind: "mat", item: "wood", qty: 1100, price: 900 });
  ok("a full Lv10 bag (1100) still lists", rH2.status === 200, `status ${rH2.status}`);
  const hid3 = lid();
  const rH3 = await list(honest, { id: hid3, kind: "mat", item: "stone", qty: 1, price: 5 });
  ok("a single item still lists", rH3.status === 200, `status ${rH3.status}`);
  ok("the honest seller was never counted as an offender", true, "checked via the audit below");

  // ---------- 5. the refusal is observable to the operator ----------
  const key = process.env.ADMIN_KEY;
  const sum = await get("/assets/summary?key=" + encodeURIComponent(key));
  const il = sum.json.impossibleListings || {};
  ok("the audit reports refused impossible listings", Number(il.refused) >= 3, `refused=${il.refused}`);
  ok("...and names the sellers who tried", Number(il.sellers) >= 1, `sellers=${il.sellers}`);
  const worst = (il.worst || [])[0] || {};
  ok("...keeping the WORST attempt, not the latest", Number(worst.tried) === 999999,
     `worst=${worst.tried} item=${worst.item} kind=${worst.kind} attempts=${worst.attempts}`);
  const offenders = new Set((il.worst || []).map(x => x.w));
  ok("the honest seller is NOT among the offenders", !offenders.has(honest.wallet.slice(0, 8)),
     `offenders=${[...offenders].join(",") || "none"}`);

  // ---------- 6. ordinary market behaviour is unchanged ----------
  b = await board();
  ok("the allowed listings are all on the board", b.filter(x => [atCap, ffOk, hid, hid2, hid3].includes(x.id)).length === 5,
     `found ${b.filter(x => [atCap, ffOk, hid, hid2, hid3].includes(x.id)).length}/5`);
  const cancel = await post("/market/op", { sid: honest.sid, op: "cancel", mktToken: honest.tok, wallet: honest.wallet, listing: { id: hid3 } });
  ok("cancel still works", cancel.status === 200, `status ${cancel.status}`);
  b = await board();
  ok("...and the cancelled row left the board", !b.some(x => x.id === hid3));

  // an unauthenticated list is still refused BEFORE the quantity check (auth order unchanged)
  const noAuth = await post("/market/op", { sid: a.sid, op: "list", listing: { id: lid(), kind: "mat", item: "wood", qty: 999999, price: 1 } });
  ok("an unauthenticated absurd listing is refused for AUTH, not quantity", noAuth.status === 401, `status ${noAuth.status}`);

  // ---------- 7. junk quantities cannot slip past ----------
  for (const [label, q] of [["NaN", "abc"], ["negative", -5], ["Infinity", 1e999], ["float", 20000.9], ["string-huge", "99999999"]]) {
    const id = lid();
    const r = await list(a, { id, kind: "mat", item: "wood", qty: q, price: 10 });
    const row = (await board()).find(x => x.id === id);
    const okRow = !row || (Number.isInteger(row.qty) && row.qty >= 1 && row.qty <= 20000);
    ok(`qty=${label} yields either a refusal or a legal in-range row`, okRow,
       `status ${r.status} qty=${row ? row.qty : "(refused)"}`);
  }

  console.log(`\nLIST_QTY_SIM  pass=${pass} fail=${fail}`);
  if (fail) { console.log("failures:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SIM ERROR", e); process.exit(1); });
