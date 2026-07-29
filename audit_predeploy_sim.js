// audit_predeploy_sim.js — READ-ONLY pre-deploy audit of this session's backend changes.
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
//
// Targets: /world/raid/claim (net_id branch), /world/mat/flow (hostile shapes + unbounded work),
// restoreAssetLedger (hostile spent/gained/raid blobs), and the auction_cancel `returned` field.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39411";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};
const raw = async (p, txt) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: txt });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1500));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "netid" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, sid: netId, mktToken: v.body.mktToken };
}
const move = (id, tok) => post("/world/move", { wallet: id, mktToken: tok || "", x: 5, z: 5, dir: 0, handle: "Aud" });

// ===========================================================================
sec("A. /world/raid/claim — the net_id branch is an UNGATED weekly prize");
{
  // a client with no linked wallet broadcasts its private net_id as its presence id (Net._presence_id
  // falls back to d["net_id"]). isPresenceId accepts it, presenceOk lets it stand alone.
  const netId = "godot-deadbeef";
  await move(netId, "");
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push((await post("/world/raid/claim", { wallet: netId })).body);
  const grants = answers.filter(a => a && a.granted === true).length;
  chk(grants === 1,
    `6 consecutive claims from one net_id -> ${grants} granted (expected 1; server.js:3320 returns granted:true unconditionally)`);
  console.log("     answers:", JSON.stringify(answers));
  chk(SRV._raidWeekFor(netId) === null, "…and the server keeps NO week for it, so nothing can ever refuse it");
}

// ===========================================================================
sec("B. /world/raid/claim — the pubkey branch does gate (control)");
{
  const A = await mkWallet();
  await move(A.wallet, A.mktToken);
  const first = await post("/world/raid/claim", { wallet: A.wallet, mktToken: A.mktToken });
  const again = await post("/world/raid/claim", { wallet: A.wallet, mktToken: A.mktToken });
  chk(first.body.granted === true && again.body.granted === false, "a proven wallet is granted once, then refused");
}

// ===========================================================================
sec("C. /world/mat/flow — hostile event shapes");
{
  const A = await mkWallet();
  await move(A.wallet, A.mktToken);
  const flow = (ev) => post("/world/mat/flow", { wallet: A.wallet, mktToken: A.mktToken, ev });
  const wait = () => new Promise(r => setTimeout(r, 3100));   // FLOW_MIN_MS

  // objects whose toString/valueOf throw used to 500 the handler
  const poison = await raw("/world/mat/flow", JSON.stringify({
    wallet: A.wallet, mktToken: A.mktToken,
    ev: [{ k: { toString: 1 }, m: { wood: { valueOf: 1 } } }, { k: "craft", m: { wood: 5 } }],
  }));
  chk(poison.status === 200, `a poison-object batch answers 200, not 500 (got ${poison.status})`);

  await wait();
  const neg = await flow([{ k: "craft", m: { wood: -50, stone: 2147483648, iron: "1e400", gold: null } }]);
  chk(neg.status === 200, "negative / overflow / non-numeric quantities answer 200");
  const spent = SRV._flowFor(A.wallet).spent || {};
  chk(!("wood" in spent), `a negative quantity never lands in the tally (wood=${spent.wood})`);
  chk(!("stone" in spent) || spent.stone > 0, `2^31 is clamped positive, never wrapped negative (stone=${spent.stone})`);
  chk(!("gold" in spent), `null quantity ignored (gold=${spent.gold})`);
  console.log("     spent tally:", JSON.stringify(spent));

  await wait();
  const arr = await flow([{ k: "craft", m: ["wood", "stone"] }, { k: "chest", m: { __proto__: { crystal: 9 } } }]);
  chk(arr.status === 200 && arr.body.counted === false, "an array `m` and a prototype-only `m` count nothing");
  chk(({}).crystal === undefined, "no prototype pollution reached Object.prototype");

  await wait();
  const notarr = await flow("not-an-array");
  chk(notarr.status === 200 && notarr.body.counted === false, "a non-array `ev` is ignored, not a throw");

  // unbounded per-event key count: `ev` is capped at 32 events but `m` has no key cap
  await wait();
  const wide = {}; for (let i = 0; i < 20000; i++) wide["k" + i] = 1;
  wide.wood = 3;
  const t0 = Date.now();
  const big = await flow(new Array(32).fill(0).map(() => ({ k: "craft", m: wide })));
  const dt = Date.now() - t0;
  chk(big.status === 200, `32 events x 20k junk keys answers 200 in ${dt}ms (no key cap in the loop)`);
}

// ===========================================================================
sec("D. restoreAssetLedger — hostile spent/gained/raid blobs");
{
  SRV._clearAssetLedger();
  const before = { spent: SRV._flowFor("Wx").spent, raid: SRV._raidWeekFor("Wx") };
  chk(before.spent === null && before.raid === null, "the seam really cleared the tallies");

  SRV.restoreAssetLedger({
    w: [],
    spent: [["Wx", { wood: 5, __proto__: { crystal: 1 }, notamat: 99, iron: Infinity, gold: "12", stone: -4 }],
           ["Wy", { wood: Number.MAX_VALUE }]],
    gained: "hostile-not-an-array",
    raid: [["Wx", 2900], ["Wy", { valueOf: 1 }], ["Wz", "3000"], [{}, 5], ["Wq", -1]],
  });
  const sx = SRV._flowFor("Wx").spent || {};
  chk(sx.wood === 5, `a good value restores (wood=${sx.wood})`);
  chk(!("notamat" in sx), "a non-material key is dropped");
  chk(!("iron" in sx), `Infinity is dropped (iron=${sx.iron})`);
  chk(!("stone" in sx), `a negative is dropped (stone=${sx.stone})`);
  chk(!("gold" in sx), `a STRING quantity "12" is dropped, not coerced (gold=${sx.gold})`);
  chk(Object.getPrototypeOf(sx) === null, "the restored row is null-proto");
  chk(SRV._raidWeekFor("Wx") === 2900, `a good week restores (${SRV._raidWeekFor("Wx")})`);
  chk(SRV._raidWeekFor("Wy") === null, `an object week is dropped (${SRV._raidWeekFor("Wy")})`);
  chk(SRV._raidWeekFor("Wz") === 3000, `a STRING week "3000" is accepted as 3000 (${SRV._raidWeekFor("Wz")})`);
  chk(SRV._raidWeekFor("Wq") === null, "a negative week is dropped");

  // round trip through the real serializer
  const blob = SRV.serializeAssetLedger();
  SRV._clearAssetLedger();
  SRV.restoreAssetLedger(blob);
  chk(SRV._raidWeekFor("Wx") === 2900, "serialize -> restore preserves the raid week across a deploy");
  chk((SRV._flowFor("Wx").spent || {}).wood === 5, "serialize -> restore preserves the flow tally");
}

// ===========================================================================
sec("E. auction_cancel returns the SERVER's record of the creature");
{
  const S = await mkWallet();
  const authed = (o) => Object.assign({ wallet: S.wallet, mktToken: S.mktToken }, o);
  const postA = await post("/market/op", authed({ op: "auction_post", sid: S.sid,
    listing: { id: "AUD1", seller: "Aud", species: "dragonos", lvl: 50, xp: 999, uid: "u_forged", minBid: 5 } }));
  chk(postA.status === 200, `a brand-new wallet with NO ledger row may post any species/level (status ${postA.status})`);
  const can = await post("/market/op", authed({ op: "auction_cancel", sid: S.sid, listing: { id: "AUD1" } }));
  chk(can.status === 200 && can.body.cancelled === true, "cancel succeeds");
  console.log("     returned:", JSON.stringify(can.body.returned));
  chk(can.body.returned && can.body.returned.species === "dragonos" && can.body.returned.lvl === 50,
    "the `returned` block echoes exactly what the CLIENT claimed at post time (no catalog check)");
}

// ===========================================================================
sec("F. cancelling an auction the server no longer knows leaves the client holding the stash");
{
  const S = await mkWallet();
  const authed = (o) => Object.assign({ wallet: S.wallet, mktToken: S.mktToken }, o);
  const can = await post("/market/op", authed({ op: "auction_cancel", sid: S.sid, listing: { id: "NOPE" } }));
  chk(can.status === 200 && can.body.cancelled === false,
    `an unknown auction id answers cancelled:false (status ${can.status}) — Market.cancel_auction then never calls _restore_auction_unit`);
  chk(can.body.returned === undefined, "and carries no `returned` block");
}

console.log(`\nAUDIT_BACKEND_DONE pass=${pass} fail=${fail}`);
process.exit(0);
