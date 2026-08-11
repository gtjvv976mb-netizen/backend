// w2_frombirth_sim.mjs — W2 FROM BIRTH (CHIK_REG_ALL=1): every issuance path the registry used to
// miss now writes a per-individual row AT CREATION, server-side. Boots the REAL server.js
// in-process: throwaway keypairs, memory store, dead RPC. Never live. Drives each closed path:
//   P1 Meme Dynasty direct (/meme/hatch -> /meme/hatched): row at the server's roll, census counts 1
//   P2 /admin/grant-chiki: row origin "issued"
//   P3 /admin/restore-chikis: rows origin "restitution" (a make-good, cap-exempt)
//   P4 /admin/gift-chiki direct + the at-capacity /gift/claim accept: rows origin "issued"
//   P5 /assets/egg/ceremony: the starter/second egg exists from birth, one-shot per wallet per slot,
//      and the one-shot SURVIVES a serialize->clear->restore round trip (the record is the chain)
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
const _adminKp = nacl.sign.keyPair();
const ADMIN_W = bs58.encode(_adminKp.publicKey);
process.env.RPC_URL = "http://127.0.0.1:59997"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39282";
process.env.CHIK_REG_ALL = "1";
process.env.ADMIN_KEY = "w2-test-admin-key";
process.env.ADMIN_WALLETS = ADMIN_W;                   // the signed-gift admin
process.env.MEME_SALE_OPEN = "true"; process.env.MEME_VERIFY_PAY = "false";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
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
const rowsOf = (w) => SRV._regOwnedForTest(w, "chikimon");
const NORMALS = ["drolax", "electrox", "firix", "forestle", "healix", "jellox", "mushrow", "owzard", "scorplex", "solarix"];
const LEGENDS = ["galador", "adalor", "tyrannos", "grovador", "dragonos"];

// ---------------------------------------------------------------------------
sec("P1 Meme Dynasty direct: the server's roll writes the row");
const M = await mkWallet();
const mh = await post("/meme/hatch", { wallet: M.wallet });
chk(mh.status === 200 && mh.body.hatch?.id, `/meme/hatch reserved (${mh.status}, id=${mh.body.hatch?.id})`);
const md = await post("/meme/hatched", { wallet: M.wallet, hatchId: mh.body.hatch.id });
chk(md.status === 200 && md.body.char, `/meme/hatched rolled ${md.body.char} edition ${md.body.edition}`);
const mRows = rowsOf(M.wallet);
console.log("  registry rows:", mRows.map(r => `${r.sp}:${r.kind}:${r.origin}`).join(" "));
chk(mRows.length === 1 && mRows[0].sp === md.body.char && mRows[0].kind === "meme" && mRows[0].origin === "issued",
    `one row at the roll: ${mRows[0] && `${mRows[0].sp}/${mRows[0].kind}/${mRows[0].origin}`}`);
const mc = SRV._trueIssued("chikimon", md.body.char);
console.log(`  census for ${md.body.char}:`, JSON.stringify(mc));
chk(mc.count === 1, `sale + row dedup to ONE creature (count=${mc.count})`);
const mRepeat = await post("/meme/hatched", { wallet: M.wallet, hatchId: mh.body.hatch.id });
chk(mRepeat.status === 200 && rowsOf(M.wallet).length === 1, `re-POST of /meme/hatched mints no second row (${rowsOf(M.wallet).length})`);

sec("P2 /admin/grant-chiki writes an issued row");
const G1 = await mkWallet();
await post("/profile", { wallet: G1.wallet, ...signOf(G1.kp, G1.wallet), profile: { chikis: [] } });
const g1 = await get(`/admin/grant-chiki?key=${process.env.ADMIN_KEY}&wallet=${G1.wallet}&sp=2`);
chk(g1.status === 200 && g1.body.ok === true, `grant answered (${g1.status}) regId=${g1.body.regId || "none"}`);
const g1Rows = rowsOf(G1.wallet);
chk(g1Rows.length === 1 && g1Rows[0].sp === "firix" && g1Rows[0].origin === "issued",
    `row = ${g1Rows[0] && `${g1Rows[0].sp}/${g1Rows[0].origin}`} (expect firix/issued — sp index 2)`);

sec("P3 /admin/restore-chikis writes restitution rows");
const G2 = await mkWallet();
const g2 = await get(`/admin/restore-chikis?key=${process.env.ADMIN_KEY}&wallet=${G2.wallet}&roster=1:5,11:8:L`);
chk(g2.status === 200 && g2.body.added?.length === 2, `restore added ${g2.body.added?.length} (expect 2)`);
const g2Rows = rowsOf(G2.wallet).map(r => `${r.sp}:${r.kind}:${r.origin}`).sort();
console.log("  rows:", g2Rows.join(" "));
chk(g2Rows.join(" ") === "adalor:legendary:restitution electrox:normal:restitution",
    `rows carry origin restitution (${g2Rows.join(" ")})`);

sec("P4 signed admin gift: direct grant + at-capacity accept");
const G3 = await mkWallet();
await post("/profile", { wallet: G3.wallet, ...signOf(G3.kp, G3.wallet), profile: { chikis: [] } });
const gift1 = await post("/admin/gift-chiki", { adminWallet: ADMIN_W, ...signOf(_adminKp, ADMIN_W),
  wallet: G3.wallet, sp: 4, level: 3 });
chk(gift1.status === 200 && gift1.body.pending === false, `direct gift landed (${gift1.status}, pending=${gift1.body.pending})`);
chk(rowsOf(G3.wallet).some(r => r.sp === "healix" && r.origin === "issued"),
    `healix issued row exists (${rowsOf(G3.wallet).map(r => r.sp + ":" + r.origin).join(" ")})`);
// fill to the 2-normal cap, then gift again -> pending -> accept
await post("/admin/gift-chiki", { adminWallet: ADMIN_W, ...signOf(_adminKp, ADMIN_W), wallet: G3.wallet, sp: 5, level: 2 });
const gift3 = await post("/admin/gift-chiki", { adminWallet: ADMIN_W, ...signOf(_adminKp, ADMIN_W), wallet: G3.wallet, sp: 6, level: 2 });
chk(gift3.status === 200 && gift3.body.pending === true, `third normal queues as an offer (pending=${gift3.body.pending})`);
const pend = await get(`/gift/pending?wallet=${G3.wallet}`);
const gid = pend.body.gifts?.[0]?.id;
const acc = await post("/gift/claim", { wallet: G3.wallet, ...signOf(G3.kp, G3.wallet), giftId: gid, action: "accept", replaceIndex: 0 });
chk(acc.status === 200 && acc.body.accepted === true, `offer accepted (${acc.status})`);
const g3Rows = rowsOf(G3.wallet).map(r => `${r.sp}:${r.origin}`).sort();
console.log("  rows:", g3Rows.join(" "));
chk(rowsOf(G3.wallet).some(r => r.sp === "mushrow" && r.origin === "issued"),
    `accepted gift (sp 6 = mushrow) has its issued row; the replaced creature's row is KEPT (grandfathered)`);

sec("P5 the ceremony egg exists from birth, one-shot, restart-proof");
const C = await mkWallet();
const c1 = await post("/assets/egg/ceremony", { wallet: C.wallet, mktToken: C.mktToken, slot: "starter" });
chk(c1.status === 200 && c1.body.egg?.id, `starter granted (${c1.status}, id=${c1.body.egg?.id?.slice(0, 10)}…, readyAt real)`);
const row1 = SRV._assetRowForTest(c1.body.egg.id);
chk(row1 && row1.origin === "issued" && row1.chain.some(e => e.what === "ceremony" && e.slot === "starter"),
    `row origin=${row1 && row1.origin}, ceremony chain event present`);
const c1b = await post("/assets/egg/ceremony", { wallet: C.wallet, mktToken: C.mktToken, slot: "starter" });
chk(c1b.status === 409, `second starter refused (${c1b.status})`);
const c2 = await post("/assets/egg/ceremony", { wallet: C.wallet, mktToken: C.mktToken, slot: "second" });
chk(c2.status === 200, `the 1M second egg is its own slot (${c2.status})`);
const cBad = await post("/assets/egg/ceremony", { wallet: C.wallet, mktToken: C.mktToken, slot: "third" });
chk(cBad.status === 400, `unknown slot refused (${cBad.status})`);
// restart: serialize -> clear -> restore; the one-shot must survive with the rows
const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
SRV._clearAssetReg();
const n = SRV.restoreAssetReg(blob);
const c1c = await post("/assets/egg/ceremony", { wallet: C.wallet, mktToken: C.mktToken, slot: "starter" });
chk(c1c.status === 409, `after a restore of ${n} rows the starter one-shot still refuses (${c1c.status})`);
const c9 = await post("/assets/egg/ceremony", { wallet: C.wallet, slot: "starter" });
chk(c9.status === 403, `unproven wallet refused (${c9.status})`);

console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
