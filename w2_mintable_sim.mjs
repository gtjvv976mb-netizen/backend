// w2_mintable_sim.mjs — W2 MINTABLE (CHIK_REG_ALL=1 + CHIK_MINT_AT_SALE=1): backfilled rows flow
// into the player-paid mint-at-sale path exactly like born-registered ones. The gate under test is
// nftEligibility — the exact function /nft/market/list consults before composing the player-signed
// mint+list transaction (payer/owner/signer = the player; the delegate never pays — mas sims).
// Boots the REAL server.js in-process: throwaway keypairs, memory store, dead RPC. Never live.
//   M1 a ledger-backfilled "legacy" creature: eligibility ok, witness "player-reported", edition real
//   M2 an old-record (profile.chikis) creature: eligibility ok, witness "player-reported"
//   M3 a server-hatched creature: witness "server-hatched" (the stronger claim is never diluted)
//   M4 an "unverified" backfilled row: HONEST refusal — flagged path, HELD, never burned
//   M5 a backfilled mount/avatar: eligibility ok (rarity counted, edition at issuance)
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59996"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39283";
process.env.CHIK_REG_ALL = "1"; process.env.CHIK_MINT_AT_SALE = "1";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
async function mkWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const v = await post("/verify", { wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg, authSig });
  return { wallet, mktToken: v.body.mktToken };
}
const PRE_EPOCH = Date.UTC(2026, 5, 1);
const elig = (id, w) => SRV._nftEligibilityForTest(SRV._assetRowForTest(id), w);

sec("M1 ledger-backfilled legacy creature lists like a born-registered one");
const A = await mkWallet();
SRV._setWalletFirstSeenForTest(A.wallet, PRE_EPOCH);
SRV._auditAssetsForTest(A.wallet, { onboarded: true, units: { u1: { species: "dragonos", kind: "legendary", level: 20 },
  u2: { species: "dragonos", kind: "legendary", level: 21 }, u3: { species: "dragonos", kind: "legendary", level: 22 } },
  mounts: ["wolf"], avatars: ["night"], eggs: [] }, PRE_EPOCH);
const t = SRV._regBackfillForTest(A.wallet, [{ sp: 7, level: 3 }]);   // sp7 = owzard, old record
console.log("  backfill:", JSON.stringify(t));
const dRows = SRV._regOwnedForTest(A.wallet, "chikimon").filter(r => r.sp === "dragonos");
chk(dRows.length === 3, `three dragonos individuals, three rows (${dRows.length})`);
for (const r of dRows.slice(0, 1)) {
  const e = elig(r.id, A.wallet);
  const w = SRV._masWitnessForTest(SRV._assetRowForTest(r.id));
  console.log(`  row ${r.id.slice(0, 10)}… luid=${r.luid} edition=${r.edition} -> eligibility=${e.code}, witness=${w}`);
  chk(e.code === "ok", `backfilled legacy dragonos is LISTABLE (code=${e.code})`);
  chk(w === "player-reported", `witness stated honestly on-chain (${w})`);
  chk(Number.isInteger(r.edition) && r.edition > 0, `edition assigned at issuance (${r.edition})`);
}
chk(new Set(dRows.map(r => r.edition)).size === 3, `three DISTINCT editions ${dRows.map(r => r.edition).join(",")} — "sell one of three dragonos" names an individual`);

sec("M2 old-record creature is mintable too (the owner mandate)");
const oRow = SRV._regOwnedForTest(A.wallet, "chikimon").find(r => r.sp === "owzard");
const oe = elig(oRow.id, A.wallet);
console.log(`  owzard luid=${oRow.luid} origin=${oRow.origin} -> ${oe.code}, witness=${SRV._masWitnessForTest(SRV._assetRowForTest(oRow.id))}`);
chk(oe.code === "ok", `profile.chikis-born row is listable (${oe.code})`);

sec("M3 a server-hatched row keeps the stronger witness");
const H = await mkWallet();
const born = SRV._mintHatchedForTest("chikimon", H.wallet, { sp: "solarix", kind: "normal", lvl: 1 });
const hw = SRV._masWitnessForTest(SRV._assetRowForTest(born.id));
chk(elig(born.id, H.wallet).code === "ok" && hw === "server-hatched", `hatched row: ok + witness=${hw}`);

sec("M4 unverified stays refused — honestly");
const U = await mkWallet();
SRV._setWalletFirstSeenForTest(U.wallet, Date.now());
SRV._auditAssetsForTest(U.wallet, { onboarded: true, units: { u1: { species: "grovador", kind: "legendary", level: 50 } },
  mounts: [], avatars: [], eggs: [] }, Date.now());
SRV._regBackfillForTest(U.wallet, null);
const uRow = SRV._regOwnedForTest(U.wallet, "chikimon").find(r => r.sp === "grovador");
const ue = elig(uRow.id, U.wallet);
console.log(`  grovador origin=${uRow.origin} -> ${ue.code}: "${ue.error}"`);
chk(uRow.origin === "unverified" && ue.code === "origin", `refusal is the anti-launder rule (${ue.code})`);
chk(/stays yours/.test(String(ue.error)), `the reason is honest — HELD, never burned ("${ue.error}")`);

sec("M5 backfilled mount + avatar are listable");
const wRow = SRV._regOwnedForTest(A.wallet, "mount").find(r => r.sp === "wolf");
const vRow = SRV._regOwnedForTest(A.wallet, "avatar").find(r => r.sp === "night");
chk(wRow && elig(wRow.id, A.wallet).code === "ok", `wolf mount row listable (${wRow && elig(wRow.id, A.wallet).code}, edition ${wRow && wRow.edition})`);
chk(vRow && elig(vRow.id, A.wallet).code === "ok", `night avatar row listable (${vRow && elig(vRow.id, A.wallet).code}, edition ${vRow && vRow.edition})`);

console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
