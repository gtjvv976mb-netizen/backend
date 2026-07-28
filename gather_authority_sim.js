// gather_authority_sim.js — the server now NAMES what a node drops. That is only safe if it names
// exactly what the shipped client already grants, so this pins the table against Gather.gd and
// proves the additions cannot break an old client.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39290";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  return { wallet, netId, mktToken: v.body.mktToken };
}
const place = (w, x, z) => post("/world/move", { wallet: w.wallet, mktToken: w.mktToken, sid: w.netId, x, y: 0, z });
const claim = (w, id, x, z) => post("/world/node/claim", { wallet: w.wallet, mktToken: w.mktToken, id, x, y: 0, z });

// THE CONTRACT: exactly what Gather.gd:694-729 grants today.
const EXPECT = { wood: ["wood"], stone: ["stone"], crystal: ["crystal"], crystal_mine: ["crystal"],
  gold: ["gold"], iron: ["iron"], seashell: ["seashell"], honey: ["honey"], flower: ["flower"],
  berries: ["berries"], pig: ["pork"], cow: ["beef", "hide"] };

sec("the server names the same drop the shipped client already grants");
{
  const W = await mkWallet();
  let x = 100;
  for (const [kind, want] of Object.entries(EXPECT)) {
    x += 40;
    await place(W, x, 100);
    const r = await claim(W, `${kind}:${x}:100`, x, 100);
    const got = r.body.drop;
    chk(Array.isArray(got) && JSON.stringify(got) === JSON.stringify(want),
        `${kind.padEnd(13)} -> ${JSON.stringify(got)}`);
    await wait(1900);   // CLAIM_MIN_MS is 1800
  }
}

sec("the cow's TWO items survive — that is deliberate, not a bug to tidy");
{
  const W = await mkWallet();
  await place(W, 900, 900);
  const r = await claim(W, "cow:900:900", 900, 900);
  chk(r.body.drop.length === 2, `a cow yields two items (${JSON.stringify(r.body.drop)})`);
  const others = Object.entries(EXPECT).filter(([k]) => k !== "cow");
  chk(others.every(([, v]) => v.length === 1), `every other node yields exactly one`);
}

sec("an unknown node kind yields NOTHING — an allowlist, never a default");
{
  const W = await mkWallet();
  await place(W, 500, 500);
  const r = await claim(W, "unobtanium:500:500", 500, 500);
  chk(Array.isArray(r.body.drop) && r.body.drop.length === 0,
      `a made-up kind drops nothing (${JSON.stringify(r.body.drop)})`);
}

sec("a rate-limited claim now says when to come back, instead of vanishing");
{
  const W = await mkWallet();
  await place(W, 700, 700);
  const a = await claim(W, "wood:700:700", 700, 700);
  chk(a.body.ok === true, `the first claim lands (${a.status})`);
  const b = await claim(W, "wood:701:700", 700, 700);
  chk(b.status === 429, `an immediate second is refused (${b.status})`);
  chk(typeof b.body.retryInMs === "number" && b.body.retryInMs > 0 && b.body.retryInMs <= 1800,
      `and says how long to wait (${b.body.retryInMs}ms)`);
  // the refusal must NOT extend the window, or a polite client could never get through
  await wait(b.body.retryInMs + 120);
  const c = await claim(W, "wood:701:700", 700, 700);
  chk(c.body.ok === true, `waiting exactly that long then succeeds (${c.status}) — the refusal did not push the window back`);
}

sec("the gather counter now counts MATERIALS, not node kinds");
{
  const W = await mkWallet();
  await place(W, 300, 300);
  await claim(W, "cow:300:300", 300, 300);
  await wait(1900);
  const g = SRV._gatheredFor(W.wallet) || {};
  chk(g.beef === 1 && g.hide === 1, `a cow claim counts beef and hide (${JSON.stringify(g)})`);
  chk(g.cow === undefined, `and NOT "cow" — nobody sells a cow`);
}

sec("claim identity is measured, and nobody is refused yet");
{
  const W = await mkWallet();
  await place(W, 200, 200);
  const proven = await claim(W, "stone:200:200", 200, 200);
  chk(proven.body.ok === true, `a proven wallet claims fine (${proven.status})`);
  await wait(1900);
  // an OLD client sends no token — it must still work, or every shipped player desyncs
  const bare = await post("/world/node/claim", { wallet: W.wallet, id: "stone:201:200", x: 200, y: 0, z: 200 });
  chk(bare.body.ok === true, `a tokenless claim (every shipped client) is STILL accepted (${bare.status})`);
  const sum = (await get("/assets/summary?key=test-admin-key")).body;
  chk(sum.nodeClaims && sum.nodeClaims.proven > 0 && sum.nodeClaims.unproven > 0,
      `both are counted for the decision later (${JSON.stringify(sum.nodeClaims)})`);
}

console.log(`\nGATHERAUTH_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
