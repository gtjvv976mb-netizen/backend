// evv_b_restart_child.mjs — one REAL server boot against the throwaway scratch Postgres.
// Spawned twice by evv_b_restart.mjs (phase=boot1 | boot2). Never the live backend: local
// scratch DB, dead RPC, throwaway admin key + keypairs.
import nacl from "tweetnacl"; import bs58 from "bs58";
import fs from "node:fs";
const PHASE = process.argv[2];
const STATE = process.argv[3];   // JSON hand-off file between the two boots
process.env.RPC_URL = "http://127.0.0.1:59991";
process.env.TREASURY_SECRET = process.env.TREASURY_SECRET || JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39293";
process.env.CHIK_CHRONICLE = "1"; process.env.CHIK_NFT_HANDOVER = "1"; process.env.CHIK_MINT_AT_SALE = "1";
delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SRV = await import("./server.js"); await sleep(2600);

let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
const move = (w) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, x: 2000, z: -204 });
const fish = (w) => post("/world/fish/report", { wallet: w.wallet, mktToken: w.mktToken, tier: 1, rod: 0 });

if (PHASE === "boot1") {
  const g = await post("/admin/event/start", { key: KEY, event: "open_gates", days: 7 });
  const f = await post("/admin/event/start", { key: KEY, event: "fishing_festival", days: 5, mult: 4 });
  const d = await post("/admin/event/start", { key: KEY, event: "founder_drop", days: 7 });
  const ws = [];
  for (let i = 0; i < 3; i++) ws.push(await mkWallet());
  await Promise.all(ws.map(w => move(w)));
  for (let k = 0; k < 3; k++) { await Promise.all(ws.map(w => fish(w))); if (k < 2) await sleep(900); }
  const ev = SRV._liveEventsForTest();
  const claims = ws.map(w => ({ wallet: w.wallet, claim: SRV._founderClaimForTest(w.wallet) }));
  fs.writeFileSync(STATE, JSON.stringify({ gEnds: Number(g.body.ends), fEnds: Number(f.body.ends), dEnds: Number(d.body.ends),
    count: ev.founderCount, claims }));
  console.log("BOOT1", JSON.stringify({ count: ev.founderCount, gEnds: Number(g.body.ends), fEnds: Number(f.body.ends) }));
  process.kill(process.pid, "SIGTERM");   // the REAL deploy path: Render's SIGTERM -> flushDurableState
  await sleep(15000);                     // never reached if the shutdown path works
  process.exit(7);
}

if (PHASE === "boot2") {
  const prev = JSON.parse(fs.readFileSync(STATE, "utf8"));
  let bad = 0;
  const chk = (c, m) => { c ? console.log("  ok:", m) : (bad++, console.log("  FAIL:", m)); };
  const ev = SRV._liveEventsForTest();
  chk(ev.openGates.ends === prev.gEnds, `open_gates survived the restart: ends=${ev.openGates.ends} === ${prev.gEnds}`);
  chk(ev.founder.ends === prev.dEnds, `founder_drop survived: ends=${ev.founder.ends} === ${prev.dEnds}`);
  chk(ev.fishing.ends === prev.fEnds && ev.fishing.mult === 4,
      `FESTIVAL survived (the loadCupState fish_event restore): ends=${ev.fishing.ends} === ${prev.fEnds}, mult=${ev.fishing.mult}`);
  chk(ev.founderCount === prev.count, `claim count survived: ${ev.founderCount} === ${prev.count}`);
  for (const c of prev.claims) {
    const now = SRV._founderClaimForTest(c.wallet);
    chk(now && now.n === c.claim.n && now.sp === c.claim.sp,
        `claim #${c.claim.n} ${c.claim.sp} intact for ${c.wallet.slice(0, 8)}… -> ${JSON.stringify(now)}`);
    const rows = SRV._regOwnedForTest(c.wallet, "chikimon").filter(x => x.origin === "open-gates-founder");
    chk(rows.length === 1, `registry row survived for ${c.wallet.slice(0, 8)}…: rows=${rows.length} origin=${rows[0] && rows[0].origin}`);
  }
  const r = await get("/world/event");
  chk(r.body.events && r.body.events.openGates && r.body.events.fishing && r.body.events.founder
      && r.body.founderClaimed === prev.count,
      `/world/event after restart: kinds=${Object.keys(r.body.events || {}).join(",")} founderClaimed=${r.body.founderClaimed}`);
  // the event CONTINUES: a new wallet crosses the bar on the second boot and takes the next number
  const w4 = await mkWallet(); await move(w4);
  for (let k = 0; k < 3; k++) { await fish(w4); if (k < 2) await sleep(900); }
  const c4 = SRV._founderClaimForTest(w4.wallet);
  chk(c4 && c4.n === prev.count + 1, `the drop continues across the deploy: new wallet takes #${c4 && c4.n} (expect ${prev.count + 1})`);
  // and nobody from boot1 can double-claim
  const w1 = prev.claims[0].wallet;
  chk(SRV._regOwnedForTest(w1, "chikimon").filter(x => x.origin === "open-gates-founder").length === 1,
      `boot1 wallet still holds exactly 1 founder row`);
  console.log(`BOOT2 ${bad === 0 ? "ALL_OK" : bad + "_FAILED"}`);
  process.exit(bad ? 1 : 0);
}
console.error("unknown phase", PHASE); process.exit(2);
