// w2_flagoff_sim.mjs — W2 FLAG-OFF IDENTITY (CHIK_REG_ALL unset): every W2 surface is inert.
// Boots the REAL server.js in-process: throwaway keypairs, memory store, dead RPC. Never live.
//   F1 the login save backfills NOTHING (no registry rows from chikis/units/mounts/avatars)
//   F2 /assets/egg/ceremony does not exist (404)
//   F3 /assets/chikimon/sync keeps the species-collapse and its cards carry NO luid key
//   F4 /meme/hatched writes no registry row and no regId on the hatch
//   F5 /admin/grant-chiki answers the exact pre-W2 shape (no regId key) and writes no row
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59995"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39284";
process.env.ADMIN_KEY = "w2-off-admin-key";
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.CHIK_REG_ALL; delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
function signOf(kp, wallet) {
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { authMsg, authSig };
}
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const s = signOf(kp, wallet);
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), ...s });
  return { wallet, kp, ...s, mktToken: v.body.mktToken };
}
const PRE_EPOCH = Date.UTC(2026, 5, 1);

sec("F0 the flag reads OFF");
console.log("  flags:", JSON.stringify(SRV._regAllFlagsForTest()));
chk(SRV._regAllFlagsForTest().on === false, "CHIK_REG_ALL is off");
chk(SRV._regBackfillForTest("x", null) === null, "regBackfillAll is inert (null)");

sec("F1 a legacy-rich login mints no rows");
const A = await mkWallet();
SRV._setWalletFirstSeenForTest(A.wallet, PRE_EPOCH);
await post("/profile", { wallet: A.wallet, ...signOf(A.kp, A.wallet),
  profile: { chikis: [{ sp: 0, level: 5 }, { sp: 10, level: 9, isLegend: true }],
             mmo: { onboarded: true, saved_at: Date.now() / 1000,
                    units: { u1: { species: "drolax", kind: "normal", level: 4 } },
                    mounts: ["horse"], avatars: ["fire"], avatar: "classic", eggs: [] } } });
const aC = SRV._regOwnedForTest(A.wallet, "chikimon"), aM = SRV._regOwnedForTest(A.wallet, "mount"), aA = SRV._regOwnedForTest(A.wallet, "avatar");
console.log(`  rows after login: chikimon=${aC.length} mount=${aM.length} avatar=${aA.length}`);
chk(aC.length + aM.length + aA.length === 0, `zero registry rows (${aC.length}/${aM.length}/${aA.length})`);

sec("F2 /assets/egg/ceremony does not exist");
const c = await post("/assets/egg/ceremony", { wallet: A.wallet, mktToken: A.mktToken, slot: "starter" });
chk(c.status === 404, `route falls through (${c.status})`);

sec("F3 sync keeps the species-collapse, cards carry no luid");
const s = await post("/assets/chikimon/sync", { wallet: A.wallet, mktToken: A.mktToken });
console.log("  answer:", JSON.stringify(s.body));
chk(s.status === 200 && s.body.chikimon?.length === 1, `one card per SPECIES (${s.body.chikimon?.length})`);
chk(s.body.chikimon?.every((card) => !("luid" in card)), "no luid key on any card (pre-W2 shape)");
chk(SRV._regOwnedForTest(A.wallet, "chikimon").length === 1, "species-collapsed adoption minted exactly one row");

sec("F4 /meme/hatched writes no registry row");
const M = await mkWallet();
const mh = await post("/meme/hatch", { wallet: M.wallet });
const md = await post("/meme/hatched", { wallet: M.wallet, hatchId: mh.body.hatch.id });
chk(md.status === 200 && !!md.body.char, `meme rolled ${md.body.char}`);
chk(SRV._regOwnedForTest(M.wallet, "chikimon").length === 0, `no registry row (${SRV._regOwnedForTest(M.wallet, "chikimon").length})`);

sec("F5 /admin/grant-chiki answers the pre-W2 shape");
const G = await mkWallet();
await post("/profile", { wallet: G.wallet, ...signOf(G.kp, G.wallet), profile: { chikis: [] } });
const g = await get(`/admin/grant-chiki?key=${process.env.ADMIN_KEY}&wallet=${G.wallet}&sp=2`);
console.log("  answer keys:", Object.keys(g.body).join(","));
chk(g.status === 200 && !("regId" in g.body), `no regId key (${Object.keys(g.body).join(",")})`);
chk(SRV._regOwnedForTest(G.wallet, "chikimon").length === 0, "no registry row from the grant");

console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
