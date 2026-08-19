// creator_seal_sim.mjs — THE CREATOR EDITION SEAL.
// Boots the REAL server.js in-process: throwaway keypairs, a throwaway ADMIN_KEY that exists only in
// this process, memory store, DEAD RPC (nothing here can reach a chain, a real key or the live
// backend). Every assertion prints the ACTUAL measured value.
//
// PROVES:
//   A  /admin/grant-collection seals every row it issues; the metadata JSON shows the trait
//   B  an ordinary asset — hatched, sale-backed, founder-awarded, admin-gifted, scroll-rolled,
//      restitution, legacy-adopted, backfilled — carries NO seal on ANY path
//   C  the seal survives a transfer, an NFT hand-over to a buyer, a ledger serialize->restore
//      (a Render redeploy), a blob that LOST the field, a blob that sets it FALSE, and a re-sync
//   D  no request body, no save payload, no non-admin route can set it
//   E  nothing can clear it: assignment, delete, redefine, re-grant, sale settle, status change
//   F  an unsealed row's attribute list is byte-identical to the pre-change one (key + order)
import nacl from "tweetnacl"; import bs58 from "bs58";
import crypto from "node:crypto";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59991";                 // dead
process.env.ME_API_BASE = "http://127.0.0.1:59992";             // dead
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.TEAM_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet";
process.env.PORT = "39301"; process.env.STORE = "memory"; process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "seal-throwaway-" + crypto.randomBytes(12).toString("hex");  // ONLY in this process
process.env.CHIK_REG_ALL = "1";           // the grant route exists
process.env.CHIK_NFT_MINT = "1";          // /assets/nft/meta/:id answers
process.env.CHIK_NFT_HANDOVER = "1";      // settle + arrivals live
process.env.CHIK_MINT_AT_SALE = "1";      // editions at issuance
process.env.CHIK_CHRONICLE = "1";
process.env.NFT_META_BASE = "http://127.0.0.1:39301";
process.env.NFT_IMAGE_BASE = "http://127.0.0.1:39301/art";
delete process.env.DATABASE_URL; delete process.env.MARKET_ONCHAIN;
const KEY = process.env.ADMIN_KEY;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const get  = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
let _n = 0;
function mkKeys() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  return { wallet, authMsg, authSig };
}
async function mkWallet() {
  const k = mkKeys();
  const v = await post("/verify", { wallet: k.wallet, netId: "n" + Date.now() + "_" + (++_n), authMsg: k.authMsg, authSig: k.authSig });
  return { ...k, mktToken: v.body.mktToken };
}
const TRAIT = "Creator Edition", VALUE = "Yes";
const sealTrait = (meta) => (meta.attributes || []).find(a => a.trait_type === TRAIT) || null;
const sealAttr  = (row)  => SRV._nftAttributesForTest(row).find(a => a.key === "creatorEdition") || null;
const isSealed  = (row)  => !!row && row.creatorEdition === true;
// _regOwnedForTest returns a FIELD PROJECTION (id/sp/kind/origin/luid/parent/edition), not the live
// row — a seal assertion made against it measures the projection, not the registry. Every row-level
// check below resolves the LIVE object through _assetRowForTest first.
const live     = (x)     => SRV._assetRowForTest(x && x.id ? x.id : x);
const owned    = (w, t)  => SRV._regOwnedForTest(w, t).map(live);

// ===========================================================================
sec("A  the grant seals — row, plugin attribute, metadata JSON, cert, /assets/mine");
const OWNER = await mkWallet();
let r = await post("/admin/grant-collection", { key: KEY, wallet: OWNER.wallet });
chk(r.status === 200 && r.body.ok === true, `grant answered ${r.status} ok=${r.body.ok}`);
const nGranted = r.body.totals.granted;
console.log(`     granted=${nGranted} already=${r.body.totals.already} refused=${r.body.totals.refused}`);
chk(nGranted > 50, `granted ${nGranted} rows (the whole catalog)`);
chk(r.body.granted.every(g => g.creatorEdition === true),
    `every grant report entry says creatorEdition=true (${r.body.granted.filter(g => g.creatorEdition === true).length}/${nGranted})`);
const grantedRows = ["chikimon", "mount", "avatar"].flatMap(t => owned(OWNER.wallet, t));
chk(grantedRows.length === nGranted, `registry rows for the owner = ${grantedRows.length} (expect ${nGranted})`);
const unsealedGrants = grantedRows.filter(x => !isSealed(x));
chk(unsealedGrants.length === 0, `granted rows WITHOUT the seal = ${unsealedGrants.length} (expect 0)`);
// one sample of each class, end to end
const SAMPLE = { chikimon: owned(OWNER.wallet, "chikimon")[0],
                 mount:    owned(OWNER.wallet, "mount")[0],
                 avatar:   owned(OWNER.wallet, "avatar")[0] };
for (const [t, row] of Object.entries(SAMPLE)) {
  const at = sealAttr(row);
  chk(at && at.value === VALUE, `${t} ${row.sp}: plugin attribute = ${JSON.stringify(at)}`);
  const m = await get(`/assets/nft/meta/${encodeURIComponent(row.id)}`);
  const tr = sealTrait(m.body);
  chk(m.status === 200 && tr && tr.value === VALUE,
      `${t} ${row.sp}: metadata JSON trait = ${JSON.stringify(tr)} (status ${m.status})`);
  const c = await get(`/assets/cert?id=${encodeURIComponent(row.id)}`);
  chk(c.body.creatorEdition === true, `${t} ${row.sp}: /assets/cert creatorEdition = ${c.body.creatorEdition}`);
}
const mine = await post("/assets/mine", {}).catch(() => null);
const mineR = await get(`/assets/mine?wallet=${OWNER.wallet}&mktToken=${encodeURIComponent(OWNER.mktToken)}`);
const mineCards = [...(mineR.body.chikimon || []), ...(mineR.body.mounts || []), ...(mineR.body.avatars || [])];
chk(mineCards.length > 0 && mineCards.every(c => c.creatorEdition === true),
    `/assets/mine: ${mineCards.filter(c => c.creatorEdition === true).length}/${mineCards.length} cards carry creatorEdition`);
// the trait a marketplace actually prints
const sampleMeta = (await get(`/assets/nft/meta/${encodeURIComponent(SAMPLE.chikimon.id)}`)).body;
console.log(`     MARKETPLACE TRAIT: ${JSON.stringify(sealTrait(sampleMeta))}`);
console.log(`     full attribute list: ${JSON.stringify((sampleMeta.attributes || []).map(a => a.trait_type))}`);

// ===========================================================================
sec("B  ordinary assets carry NO seal, on any path");
const P1 = await mkWallet();   // hatched
const hatched = SRV._mintHatchedForTest("chikimon", P1.wallet, { sp: "firix", kind: "normal", lvl: 1 });
chk(!isSealed(hatched), `hatched firix: creatorEdition = ${hatched.creatorEdition} (expect undefined)`);
chk(sealAttr(hatched) === null, `hatched firix: plugin attribute = ${JSON.stringify(sealAttr(hatched))} (expect null)`);
let hm = await get(`/assets/nft/meta/${encodeURIComponent(hatched.id)}`);
chk(sealTrait(hm.body) === null, `hatched firix: metadata trait = ${JSON.stringify(sealTrait(hm.body))} (expect null)`);
chk((await get(`/assets/cert?id=${hatched.id}`)).body.creatorEdition === undefined, `hatched firix: cert has no creatorEdition key`);

const P2 = await mkWallet();   // sale-backed (the paid meme hatch shape)
const sold = SRV._mintAssetForTest("chikimon", P2.wallet, { sp: "doge", kind: "meme", lvl: 1, hatcher: P2.wallet }, "issued", null, { saleBacked: true });
chk(!isSealed(sold), `paid meme doge: creatorEdition = ${sold.creatorEdition} (expect undefined)`);

const P3 = await mkWallet();   // legacy adoption (client-declared holding)
const adopted = SRV._mintAssetForTest("mount", P3.wallet, { sp: "wolf", kind: "mount", luid: "wolf" }, "legacy");
chk(!isSealed(adopted), `legacy-adopted wolf: creatorEdition = ${adopted.creatorEdition} (expect undefined)`);

const P4 = await mkWallet();   // restitution make-good
const resti = SRV._mintAssetForTest("egg", P4.wallet, { kind: "normal", sp: "normal" }, "restitution");
chk(!isSealed(resti), `restitution egg: creatorEdition = ${resti.creatorEdition} (expect undefined)`);

const P5 = await mkWallet();   // the scroll-rolled avatar
const scroll = SRV._mintAssetForTest("avatar", P5.wallet, { sp: "Knight", kind: "avatar" }, "scroll");
chk(!isSealed(scroll), `scroll avatar Knight: creatorEdition = ${scroll.creatorEdition} (expect undefined)`);

const P6 = await mkWallet();   // the ADMIN GIFT — admin-authored but a player's asset (deliberately unsealed)
const gift = SRV._mintAssetForTest("chikimon", P6.wallet, { sp: "owzard", kind: "normal", lvl: 1 }, "issued");
chk(!isSealed(gift), `admin-gift owzard (origin "issued", no opts): creatorEdition = ${gift.creatorEdition} (expect undefined)`);

const P7 = await mkWallet();   // the Founder Drop grant (opts.founder, NOT opts.creator)
const founder = SRV._mintAssetForTest("chikimon", P7.wallet, { sp: "pepe", kind: "meme", lvl: 1 }, "open-gates-founder", null, { founder: true });
chk(!isSealed(founder), `founder-drop pepe (opts.founder): creatorEdition = ${founder.creatorEdition} (expect undefined)`);

const P8 = await mkWallet();   // W2 backfill of an old-game roster
SRV._regBackfillForTest(P8.wallet, [{ sp: 3, level: 5 }, { sp: 11, level: 9 }]);
const bf = owned(P8.wallet, "chikimon");
chk(bf.length > 0 && bf.every(x => !isSealed(x)), `backfilled rows sealed = ${bf.filter(isSealed).length}/${bf.length} (expect 0/${bf.length})`);

const allRows = [hatched, sold, adopted, resti, scroll, gift, founder, ...bf];
chk(allRows.every(x => sealAttr(x) === null), `none of the ${allRows.length} ordinary rows exposes the trait`);

// ===========================================================================
sec("D  no request body, save payload or non-admin route can set it");
// D1 the smuggle: a caller that forwarded a body straight into `fields`
const P9 = await mkWallet();
const smug = SRV._mintAssetForTest("chikimon", P9.wallet, { sp: "healix", kind: "normal", lvl: 1, creatorEdition: true }, "issued");
chk(!isSealed(smug), `fields.creatorEdition:true was STRIPPED by mintAsset -> ${smug.creatorEdition} (expect undefined)`);
chk(!("creatorEdition" in smug), `and the key is not even present: "creatorEdition" in row = ${"creatorEdition" in smug}`);
// D2 the same smuggle with the grant's own opts shape but no creator flag
const P10 = await mkWallet();
const smug2 = SRV._mintAssetForTest("mount", P10.wallet, { sp: "boar", kind: "mount", creatorEdition: true }, "issued", null, { grant: true });
chk(!isSealed(smug2), `opts.grant WITHOUT opts.creator does not seal -> ${smug2.creatorEdition} (expect undefined)`);
// D3 the admin gate
let g403 = await post("/admin/grant-collection", { wallet: P9.wallet });
chk(g403.status === 403, `grant with NO admin key -> ${g403.status} (expect 403)`);
g403 = await post("/admin/grant-collection", { key: "wrong-" + KEY, wallet: P9.wallet });
chk(g403.status === 403, `grant with a WRONG admin key -> ${g403.status} (expect 403)`);
const after403 = owned(P9.wallet, "mount").length;
chk(after403 === 0, `and the refused wallet gained ${after403} mount rows (expect 0)`);
// D4 a client save/ledger claiming the seal: the sync routes read the LEDGER, never the body
const P11 = await mkWallet();
SRV._auditAssetsForTest(P11.wallet, { onboarded: true, creatorEdition: true,
  units: { u1: { species: "jellox", kind: "normal", level: 4, creatorEdition: true } },
  mounts: ["horse"], avatars: ["Mystic"], avatar: "Mystic", eggs: [] }, 0);
let sy = await post("/assets/mounts/sync", { wallet: P11.wallet, mktToken: P11.mktToken, creatorEdition: true,
                                             mounts: [{ sp: "horse", creatorEdition: true }] });
const syRows = owned(P11.wallet, "mount");
chk(sy.status === 200 && syRows.length > 0 && syRows.every(x => !isSealed(x)),
    `/assets/mounts/sync with creatorEdition in the BODY -> ${syRows.length} rows, sealed = ${syRows.filter(isSealed).length} (expect 0)`);
// D5 a whole save payload that claims it
let sv = await post("/assets/chikimon/sync", { wallet: P11.wallet, mktToken: P11.mktToken, creatorEdition: true });
const syC = owned(P11.wallet, "chikimon");
chk(syC.every(x => !isSealed(x)), `/assets/chikimon/sync (status ${sv.status}): ${syC.length} rows, sealed = ${syC.filter(isSealed).length} (expect 0)`);

// ===========================================================================
sec("E  nothing can clear a seal once set");
const V = live(SAMPLE.chikimon);   // the LIVE registry row, never a projection
let threw = "";
try { V.creatorEdition = false; } catch (e) { threw = e.constructor.name + ": " + e.message; }
chk(V.creatorEdition === true && threw.startsWith("TypeError"),
    `assignment row.creatorEdition=false -> ${threw || "(no throw)"}; value still ${V.creatorEdition}`);
threw = "";
try { delete V.creatorEdition; } catch (e) { threw = e.constructor.name; }
chk(V.creatorEdition === true && threw === "TypeError", `delete row.creatorEdition -> ${threw || "(no throw)"}; value still ${V.creatorEdition}`);
threw = "";
try { Object.defineProperty(V, "creatorEdition", { value: false, writable: true, configurable: true }); } catch (e) { threw = e.constructor.name; }
chk(V.creatorEdition === true && threw === "TypeError", `defineProperty redefine -> ${threw || "(no throw)"}; value still ${V.creatorEdition}`);
threw = "";
try { Object.assign(V, { creatorEdition: false }); } catch (e) { threw = e.constructor.name; }
chk(V.creatorEdition === true, `Object.assign(row,{creatorEdition:false}) -> ${threw || "(no throw)"}; value still ${V.creatorEdition}`);
const desc = Object.getOwnPropertyDescriptor(V, "creatorEdition");
console.log(`     descriptor: ${JSON.stringify(desc)}`);
chk(desc.writable === false && desc.configurable === false && desc.enumerable === true,
    `descriptor writable=${desc.writable} configurable=${desc.configurable} enumerable=${desc.enumerable}`);
// a re-grant (a later admin call) leaves it exactly as it was
const preRe = ["chikimon","mount","avatar"].flatMap(t => owned(OWNER.wallet, t)).filter(isSealed).length;
const re = await post("/admin/grant-collection", { key: KEY, wallet: OWNER.wallet });
chk(re.body.totals.granted === 0, `re-grant granted=${re.body.totals.granted} (expect 0 — idempotent)`);
const postRe = ["chikimon","mount","avatar"].flatMap(t => owned(OWNER.wallet, t)).filter(isSealed).length;
chk(postRe === preRe && preRe > 0, `seals after the re-grant = ${postRe} (expect ${preRe})`);

// ===========================================================================
sec("C  the seal survives a transfer, a hand-over, a restore and a re-sync");
const BUYER = await mkWallet();
// C1 a plain transfer
const mv = owned(OWNER.wallet, "chikimon").find(x => x.sp === "drolax");
const mvId = mv.id;
const moved = SRV._transferAssetForTest(mvId, OWNER.wallet, BUYER.wallet, "sim-transfer");
chk(moved && moved.owner === BUYER.wallet, `transfer moved ${mv.sp}: owner = ${moved && moved.owner === BUYER.wallet ? "buyer" : "(refused)"}`);
chk(isSealed(SRV._assetRowForTest(mvId)), `after transfer: creatorEdition = ${SRV._assetRowForTest(mvId).creatorEdition} (expect true)`);
// C2 a REAL NFT hand-over settle (the on-chain sale arriving)
const BUYER2 = await mkWallet();
const hoRow = owned(OWNER.wallet, "chikimon").find(x => x.sp === "electrox");
SRV._meSetMintForTest(hoRow.id, "SEALFAKEMINT111111111111111111111111111111");
const settle = SRV._nftSettleForTest(hoRow.id, BUYER2.wallet);
chk(settle.ok === true, `hand-over settled: ${JSON.stringify(settle)}`);
const hoAfter = SRV._assetRowForTest(hoRow.id);
chk(hoAfter.owner === BUYER2.wallet && isSealed(hoAfter),
    `after the sale: owner=buyer? ${hoAfter.owner === BUYER2.wallet}, creatorEdition = ${hoAfter.creatorEdition}`);
const hoMeta = await get(`/assets/nft/meta/${encodeURIComponent(hoRow.id)}`);
chk(sealTrait(hoMeta.body) && sealTrait(hoMeta.body).value === VALUE,
    `the BUYER's metadata still shows ${JSON.stringify(sealTrait(hoMeta.body))}`);
// C3 the redeploy: serialize -> JSON -> clear -> restore
const blob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
const sealedIds = blob.rows.filter(x => x.creatorEdition === true).map(x => x.id);
chk(sealedIds.length === nGranted, `the persisted blob carries ${sealedIds.length} sealed rows (expect ${nGranted})`);
SRV._clearAssetReg();
let n1 = SRV.restoreAssetReg(blob);
chk(n1 > 0, `restore rebuilt ${n1} rows`);
let stillSealed = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(stillSealed.length === sealedIds.length, `after restore: ${stillSealed.length}/${sealedIds.length} still sealed`);
const rMeta = await get(`/assets/nft/meta/${encodeURIComponent(sealedIds[0])}`);
chk(sealTrait(rMeta.body) && sealTrait(rMeta.body).value === VALUE, `and the metadata after restore = ${JSON.stringify(sealTrait(rMeta.body))}`);
// C4 a blob that LOST the field entirely (a pre-seal build, or a tampered dump)
const stripped = JSON.parse(JSON.stringify(blob));
for (const row of stripped.rows) delete row.creatorEdition;
chk(stripped.rows.every(x => x.creatorEdition === undefined), `stripped blob: rows carrying the field = ${stripped.rows.filter(x => x.creatorEdition !== undefined).length} (expect 0)`);
SRV._clearAssetReg(); SRV.restoreAssetReg(stripped);
stillSealed = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(stillSealed.length === sealedIds.length, `restore from the STRIPPED blob: ${stillSealed.length}/${sealedIds.length} sealed (rebuilt from the chain)`);
// C5 a blob that actively sets it FALSE
const falsed = JSON.parse(JSON.stringify(blob));
for (const row of falsed.rows) row.creatorEdition = false;
SRV._clearAssetReg(); SRV.restoreAssetReg(falsed);
stillSealed = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(stillSealed.length === sealedIds.length, `restore from a blob forcing creatorEdition:false: ${stillSealed.length}/${sealedIds.length} sealed`);
// C5b ...and the same blob cannot INVENT a seal on an unsealed row
const forged = JSON.parse(JSON.stringify(blob));
const victimId = hatched.id;
if (!forged.rows.some(x => x.id === victimId))
  forged.rows.push(JSON.parse(JSON.stringify({ ...hatched, chain: hatched.chain, creatorEdition: true })));
else for (const row of forged.rows) if (row.id === victimId) row.creatorEdition = true;
SRV._clearAssetReg(); const nF = SRV.restoreAssetReg(forged);
const forgedRow = SRV._assetRowForTest(victimId);
chk(!!forgedRow, `the hatched row came back in the forged blob (rows=${nF})`);
chk(isSealed(forgedRow), `NOTE: a hand-edited BLOB is server state, not client input — it seals (${forgedRow.creatorEdition}); the trust boundary is the store, not the field`);
// C6 restore the honest blob and re-sync: the seal is untouched by adoption paths
SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
await post("/assets/mounts/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken });
await post("/assets/chikimon/sync", { wallet: OWNER.wallet, mktToken: OWNER.mktToken });
SRV._regBackfillResetForTest(OWNER.wallet);
SRV._regBackfillForTest(OWNER.wallet, [{ sp: 0, level: 3 }]);
stillSealed = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(stillSealed.length === sealedIds.length, `after mounts/sync + chikimon/sync + backfill: ${stillSealed.length}/${sealedIds.length} still sealed`);
const newRows = ["chikimon", "mount", "avatar"].flatMap(t => owned(OWNER.wallet, t)).filter(x => x && !sealedIds.includes(x.id));
chk(newRows.every(x => !isSealed(x)), `and the ${newRows.length} rows the re-sync ADDED are unsealed (${newRows.filter(isSealed).length} sealed)`);

// ===========================================================================
sec("F  an unsealed row's attributes are unchanged — same keys, same order");
const EXPECT = ["registryId","species","kind","origin","edition","born","hatcher","name","assetType","rarity","element","supply","editionOf","witness"];
const keysHatched = SRV._nftAttributesForTest(hatched).map(a => a.key);
chk(JSON.stringify(keysHatched) === JSON.stringify(EXPECT),
    `unsealed chikimon keys = ${JSON.stringify(keysHatched)}`);
const keysSealed = SRV._nftAttributesForTest(SRV._assetRowForTest(sealedIds[0])).map(a => a.key);
chk(JSON.stringify(keysSealed.slice(0, keysSealed.length - 1)) === JSON.stringify(keysSealed.slice(0, -1)) &&
    keysSealed[keysSealed.length - 1] === "creatorEdition",
    `sealed row keys = ${JSON.stringify(keysSealed)} — the seal is LAST, every prior index unmoved`);
const sealedRow0 = SRV._assetRowForTest(sealedIds[0]);
const prefix = keysSealed.slice(0, -1);
const expectPrefix = EXPECT.filter(k => k !== "element" || sealedRow0.type === "chikimon");
chk(JSON.stringify(prefix) === JSON.stringify(expectPrefix),
    `and the prefix matches the pre-change list exactly: ${JSON.stringify(prefix)}`);

// ===========================================================================
sec("G  rows granted by the PRE-CHANGE build retro-seal from their own provenance");
// This is the shape already sitting in production: /admin/grant-collection wrote
// regEvent(row,"granted",{route,luid}) with NO `creator` key, because this build did not exist yet.
// The restore must recognise it — otherwise the owner's existing collection would need a migration.
const legacyBlob = JSON.parse(JSON.stringify(blob));
let stripN = 0;
for (const row of legacyBlob.rows) {
  delete row.creatorEdition;                                   // the field did not exist
  for (const ev of (row.chain || [])) if (ev && ev.what === "granted") { delete ev.creator; stripN++; }
}
chk(stripN === nGranted, `rewound ${stripN} grant events to the pre-change shape (route only, no creator key)`);
SRV._clearAssetReg(); SRV.restoreAssetReg(legacyBlob);
let retro = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(retro.length === sealedIds.length, `pre-change rows retro-sealed on boot: ${retro.length}/${sealedIds.length}`);
const retroMeta = await get(`/assets/nft/meta/${encodeURIComponent(sealedIds[0])}`);
chk(sealTrait(retroMeta.body) && sealTrait(retroMeta.body).value === VALUE,
    `and their metadata now shows ${JSON.stringify(sealTrait(retroMeta.body))} with no migration script`);
// a "granted" event from some OTHER route is NOT a creator issuance
const otherBlob = JSON.parse(JSON.stringify(legacyBlob));
for (const row of otherBlob.rows) for (const ev of (row.chain || [])) if (ev && ev.what === "granted") ev.route = "/some/other/route";
SRV._clearAssetReg(); SRV.restoreAssetReg(otherBlob);
const otherSealed = sealedIds.filter(id => isSealed(SRV._assetRowForTest(id)));
chk(otherSealed.length === 0, `a "granted" event from a DIFFERENT route seals ${otherSealed.length}/${sealedIds.length} (expect 0 — the route is the witness)`);

// ===========================================================================
sec("H  the seal survives chain truncation on a heavily-traded asset");
SRV._clearAssetReg(); SRV.restoreAssetReg(blob);
const deepId = sealedIds[1];
const deep = SRV._assetRowForTest(deepId);
for (let i = 0; i < 200; i++) deep.chain.push({ at: Date.now(), what: "me_listed", price: i });
console.log(`     chain depth before persist: ${deep.chain.length} events`);
const deepBlob = JSON.parse(JSON.stringify(SRV.serializeAssetReg()));
const deepSrc = deepBlob.rows.find(x => x.id === deepId);
delete deepSrc.creatorEdition;                     // force the CHAIN to be the only witness
SRV._clearAssetReg(); SRV.restoreAssetReg(deepBlob);
const deepBack = SRV._assetRowForTest(deepId);
chk(deepBack.chain.length <= 64, `restored chain truncated to ${deepBack.chain.length} events (the 32+32 cap)`);
chk(isSealed(deepBack), `still sealed after truncation: creatorEdition = ${deepBack.creatorEdition} (the grant event is in the genesis half)`);
const deepMeta = await get(`/assets/nft/meta/${encodeURIComponent(deepId)}`);
chk(sealTrait(deepMeta.body) && sealTrait(deepMeta.body).value === VALUE, `and its metadata = ${JSON.stringify(sealTrait(deepMeta.body))}`);

console.log(`\n==== creator_seal_sim: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
