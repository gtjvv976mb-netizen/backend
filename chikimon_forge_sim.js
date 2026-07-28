// chikimon_forge_sim.js — ADVERSARIAL probe of POST /assets/chikimon/sync (STEP 5 of server authority).
//
// The route (server.js ~3687) converts LEDGER-known, currently-held chikimon into permanent registry
// PROPERTY, carrying the ledger's own origin, and answers the wallet's unique active species list. I
// try to BREAK each intended property. Every assertion prints the ACTUAL value observed. "Could not
// break it" is a real result. NEVER touches the live backend: throwaway keypair, memory store, dead RPC.
//
// Properties under attack (task order):
//   1  NO LAUNDERING          — unverified mints unverified; adoption doesn't clear the ledger count
//   2  SALE-GATE NEUTRAL      — *** PRIORITY *** the adopted row must not flip the market sale gate
//   3  HELD-AWARENESS         — a held===false (sold/departed) creature is not adopted
//   4  NO CROSS-WALLET THEFT  — a proven wallet only mints to ITSELF; body target fields are ignored
//   5  NO DOUBLE-MINT/CLONE   — concurrent/repeat syncs make one row; the species list is dup-free
//   6  PROTOTYPE POLLUTION    — "__proto__"/"constructor" species are inert, never minted
//   7  LEVEL NOT ASSERTED     — the registry row lvl is birth 1; the answer carries no live level
//   8  CAPACITY               — at ASSET_REG_MAX: 200, adopt-what-fits, rest retryable, no crash
//   9  AUDIT INTERACTION      — a sync-minted row must not let the next save re-grade the ledger
//
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39331";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
// postRaw: send a hand-built JSON STRING so a payload the object-literal setter would swallow
// ("__proto__") actually reaches the server as a real key/element.
const postRaw = async (p, text) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0, broke = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const hole = (m) => { broke.push(m); console.log("  *** HOLE:", m); };
const sec = (s) => console.log(`\n— ${s} —`);
const HOUR = 3600 * 1000;
let _n = 0, _lid = 0;
const lidGen = () => "L" + Date.now() + "_" + (++_lid);
async function mkWallet(firstSeen) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const authMsg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), kp.secretKey)).toString("base64");
  const netId = "n" + Date.now() + "_" + (++_n);
  const v = await post("/verify", { wallet, netId, authMsg, authSig });
  const w = { wallet, authMsg, authSig, sid: netId, mktToken: v.body.mktToken };
  if (firstSeen) SRV._setWalletFirstSeenForTest(wallet, firstSeen);
  return w;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// a signed save (700ms clears the 600ms /profile throttle) is the only way a creature enters the ledger
const save = (w, mmo) => wait(700).then(() => post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }));
const saveRaw = (w, mmoText) => wait(700).then(() => postRaw("/profile",
  `{"wallet":${JSON.stringify(w.wallet)},"authMsg":${JSON.stringify(w.authMsg)},"authSig":${JSON.stringify(w.authSig)},"profile":{"mmo":${mmoText}}}`));
const sync = (w, extra) => post("/assets/chikimon/sync", Object.assign({ wallet: w.wallet, mktToken: w.mktToken }, extra || {}));
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const audit = (w) => get(`/assets/audit?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const summary = () => get(`/assets/summary?key=test-admin-key`);
const claim = (w, kind) => post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind });
const consume = (w, id, sp) => post("/assets/egg/consume", { wallet: w.wallet, mktToken: w.mktToken, id, sp });
// live ledger record for a wallet (serializeAssetLedger returns the LIVE rec objects)
const ledgerRec = (w) => { const e = SRV.serializeAssetLedger().w.find(x => x[0] === w.wallet); return e ? e[1] : null; };
// a REAL market listing attempt (the money path). op:list is auth-gated on the caller's own bound sid.
const listOp = (w, listing) => post("/market/op", { sid: w.sid, op: "list", wallet: w.wallet, mktToken: w.mktToken, listing });
const cancelOp = (w, id) => post("/market/op", { sid: w.sid, op: "cancel", wallet: w.wallet, mktToken: w.mktToken, listing: { id } });
// list a chikimon; returns {status, allowed, onBoard, err}
async function tryList(w, species, uid, priorId) {
  const id = priorId || lidGen();
  const listing = { id, kind: "chikimon", item: species, price: 500, qty: 1, lvl: 1 };
  if (uid !== undefined) listing.uid = uid;
  const r = await listOp(w, listing);
  const onBoard = !!(r.body.listings || []).find(x => x.id === id);
  return { id, status: r.status, allowed: r.status === 200 && onBoard, onBoard, err: r.body.error || "" };
}
const PRE = Date.UTC(2025, 0, 1);   // a pre-ledger (grandfathered) player

// ===========================================================================
sec("SETUP CONTROL — the market plumbing is real (a clean creature CAN be listed)");
{
  const S = await mkWallet(PRE);
  await save(S, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "firix", kind: "normal", level: 9 } } });
  const a = (await audit(S)).body;
  chk(a.units.u1 && a.units.u1.origin === "legacy", `(control) firix is legacy/clean in the ledger (${a.units.u1 && a.units.u1.origin})`);
  const r = await tryList(S, "firix", "u1");
  console.log("    clean firix list -> status:", r.status, " onBoard:", r.onBoard, " err:", r.err);
  chk(r.allowed, `(control) a CLEAN creature lists successfully — proves the sale gate + auth are live (${r.status})`);
}

// ===========================================================================
sec("PROPERTY 1 — NO LAUNDERING (unverified rides unchanged; the flag COUNT is not cleared)");
{
  const C = await mkWallet();   // fresh, no grandfather
  await save(C, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "drolax", kind: "normal", level: 1 } } });
  await save(C, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "drolax", kind: "normal", level: 1 },
    u2: { species: "tyrannos", kind: "legendary", level: 50 } } });
  const aBefore = (await audit(C)).body;
  const sumBefore = (await summary()).body.byOrigin.unverified || 0;
  chk(aBefore.units.u2 && aBefore.units.u2.origin === "unverified", `the conjured legendary is UNVERIFIED in the ledger (${aBefore.units.u2 && aBefore.units.u2.origin})`);

  const r = await sync(C);
  const rows = (await mine(C)).body.chikimon || [];
  const tyr = rows.find(x => x.sp === "tyrannos"), dro = rows.find(x => x.sp === "drolax");
  console.log("    registry rows:", rows.map(x => `${x.sp}:${x.origin}`).join(", "));
  chk(!!tyr && tyr.origin === "unverified", `the adopted tyrannos row is UNVERIFIED, not upgraded (${tyr && tyr.origin})`);
  chk(!!dro && dro.origin === "legacy", `the grandfathered drolax adopts as legacy — origins are per-row (${dro && dro.origin})`);
  if (tyr && tyr.origin !== "unverified") hole(`P1: unverified ledger unit minted as '${tyr.origin}' (laundered origin)`);
  const sumAfter = (await summary()).body.byOrigin.unverified || 0;
  console.log("    game-wide unverified count:", sumBefore, "->", sumAfter);
  chk(sumAfter >= sumBefore, `adoption did NOT clear the ledger's unverified count in /assets/summary (${sumBefore} -> ${sumAfter})`);
  if (sumAfter < sumBefore) hole("P1: adoption dropped the game-wide unverified count — an amnesty");
}

// ===========================================================================
sec("PROPERTY 2 — *** SALE-GATE NEUTRALITY *** (the priority; exercised through a REAL market listing)");
{
  // Build a wallet with a CLEAN unit (drolax, control) and an UNVERIFIED unit (tyrannos, target).
  const W = await mkWallet();
  await save(W, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "drolax", kind: "normal", level: 1 } } });
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "drolax", kind: "normal", level: 1 },
    u2: { species: "tyrannos", kind: "legendary", level: 50 } } });
  const aBefore = JSON.stringify((await audit(W)).body.units);
  chk(JSON.parse(aBefore).u2.origin === "unverified", `target tyrannos(u2) is unverified in the ledger (${JSON.parse(aBefore).u2.origin})`);

  // (A) BEFORE SYNC — the unverified creature must be UNLISTABLE by every uid the client could send.
  const preUid = await tryList(W, "tyrannos", "u2");            // honest client: real uid
  const preNoUid = await tryList(W, "tyrannos", undefined);     // attacker: omit the uid
  const preFakeUid = await tryList(W, "tyrannos", "u87654321"); // attacker: uid the ledger never saw
  console.log("    BEFORE sync  list tyrannos: realUid=", preUid.status, " noUid=", preNoUid.status, " fakeUid=", preFakeUid.status);
  chk(!preUid.allowed && preUid.status === 409, `BEFORE sync: unverified tyrannos with real uid is REFUSED 409 (${preUid.status})`);
  chk(!preNoUid.allowed && preNoUid.status === 409, `BEFORE sync: unverified tyrannos with NO uid is REFUSED 409 (${preNoUid.status})`);
  chk(!preFakeUid.allowed && preFakeUid.status === 409, `BEFORE sync: unverified tyrannos with a fake uid is REFUSED 409 (${preFakeUid.status})`);
  // control the other way: the CLEAN drolax lists fine before sync (probe/auth is genuinely live)
  const preClean = await tryList(W, "drolax", "u1");
  chk(preClean.allowed, `BEFORE sync: the CLEAN drolax lists (control — the refusals above are real, not broken plumbing) (${preClean.status})`);
  await cancelOp(W, preClean.id);   // release the unit reservation so we can re-test after sync

  // ADOPT: sync mints registry rows. Ledger MUST be byte-identical afterward (sale gate reads it per-uid).
  const r = await sync(W);
  const aAfter = JSON.stringify((await audit(W)).body.units);
  console.log("    sync adopted:", JSON.stringify(r.body.adopted));
  chk(aBefore === aAfter, `the ledger units are BYTE-IDENTICAL before and after sync (sync did not touch assetLedger)`);
  if (aBefore !== aAfter) hole("P2: sync mutated the ledger units");
  const rows = (await mine(W)).body.chikimon || [];
  const tyrRow = rows.find(x => x.sp === "tyrannos");
  chk(!!tyrRow && tyrRow.origin === "unverified", `sync minted an UNVERIFIED registry tyrannos row (${tyrRow && tyrRow.origin})`);

  // (B) AFTER SYNC — the SAME listings again. The intended property: STILL unlistable.
  const postUid = await tryList(W, "tyrannos", "u2");
  const postNoUid = await tryList(W, "tyrannos", undefined);
  const postFakeUid = await tryList(W, "tyrannos", "u87654321");
  console.log("    AFTER sync   list tyrannos: realUid=", postUid.status, " noUid=", postNoUid.status, " fakeUid=", postFakeUid.status);
  console.log("      -> noUid onBoard=", postNoUid.onBoard, " fakeUid onBoard=", postFakeUid.onBoard, " noUid err=", JSON.stringify(postNoUid.err));

  // The per-uid check (honest client, real uid) must still block — verify it does.
  chk(!postUid.allowed && postUid.status === 409, `AFTER sync: real-uid listing STILL refused 409 — the per-uid gate holds (${postUid.status})`);

  // THE CLAIM UNDER TEST: the adopted unverified registry row must NOT flip the gate to allow.
  if (postNoUid.allowed) {
    hole("P2: after chikimon/sync, an UNVERIFIED creature LISTS on the real-$CHIKI market via a no-uid listing "
       + "(chikimonSaleBlocked species-fallback calls regVouchesSpecies, server.js:4841, which returns true for the "
       + "adopted UNVERIFIED registry row because regVouchesSpecies@3413 ignores origin). BEFORE sync the identical "
       + `listing was 409; AFTER sync it is ${postNoUid.status} and on the board.`);
  }
  chk(!postNoUid.allowed, `AFTER sync: no-uid listing STILL refused (sale gate neutral) — observed status ${postNoUid.status}, onBoard=${postNoUid.onBoard}`);
  if (postFakeUid.allowed) {
    hole("P2: after chikimon/sync, an UNVERIFIED creature LISTS via a fake/unseen-uid listing — same species-fallback vouch path.");
  }
  chk(!postFakeUid.allowed, `AFTER sync: fake-uid listing STILL refused — observed status ${postFakeUid.status}, onBoard=${postFakeUid.onBoard}`);

  // clean creature must STILL be listable after sync (no false-positive regression)
  const postClean = await tryList(W, "drolax", "u1");
  chk(postClean.allowed, `AFTER sync: the CLEAN drolax is STILL listable — no honest-player regression (${postClean.status})`);
  await cancelOp(W, postClean.id);
}

// ===========================================================================
sec("PROPERTY 2b — SALE-GATE via LAUNDERING-BY-CHURN (adopted row lets a fresh-uid re-save grade 'issued')");
{
  const W = await mkWallet();
  await save(W, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "electrox", kind: "normal", level: 1 } } });
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "electrox", kind: "normal", level: 1 },
    u2: { species: "galador", kind: "legendary", level: 44 } } });
  chk(ledgerRec(W).units.u2.origin === "unverified", `galador(u2) is unverified pre-sync (${ledgerRec(W).units.u2.origin})`);

  // BEFORE sync, the classic churn (move the flagged creature to a fresh uid) does NOT launder:
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "electrox", kind: "normal", level: 1 },
    u2: { species: "galador", kind: "legendary", level: 44 },
    u3: { species: "galador", kind: "legendary", level: 44 } } });
  const churnPreSync = ledgerRec(W).units.u3.origin;
  console.log("    fresh-uid galador(u3) BEFORE sync grades:", churnPreSync);
  chk(churnPreSync === "unverified", `pre-sync: a fresh-uid copy of the flagged creature stays UNVERIFIED — churn is closed (${churnPreSync})`);

  // ADOPT — sync mints an unverified registry galador row.
  await sync(W);
  const regGal = ((await mine(W)).body.chikimon || []).find(x => x.sp === "galador");
  chk(!!regGal && regGal.origin === "unverified", `sync minted an unverified registry galador (${regGal && regGal.origin})`);

  // NOW churn again to ANOTHER fresh uid and re-save. If the audit's newUnit branch consults
  // regVouchesSpecies (server.js:4144) it will stamp the fresh uid 'issued' off the adopted row.
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "electrox", kind: "normal", level: 1 },
    u4: { species: "galador", kind: "legendary", level: 44 } } });
  const churnPostSync = ledgerRec(W).units.u4.origin;
  console.log("    fresh-uid galador(u4) AFTER sync grades:", churnPostSync);
  if (churnPostSync !== "unverified") {
    hole(`P2b/P9: after sync, a fresh-uid re-save of the flagged galador was graded '${churnPostSync}' (not unverified) — `
       + `auditAssets@4144 (else-if regVouchesSpecies -> origin='issued') is fed the UNVERIFIED registry row sync planted. `
       + `The pre-2026 laundering-by-churn hole is REOPENED by Step 5.`);
  }
  chk(churnPostSync === "unverified", `AFTER sync: a fresh-uid copy STILL grades unverified — churn stays closed (${churnPostSync})`);

  // and prove the money consequence: does the churned uid now LIST?
  const churnList = await tryList(W, "galador", "u4");
  console.log("    list galador via churned uid u4 -> status:", churnList.status, " onBoard:", churnList.onBoard);
  if (churnList.allowed) hole("P2b: the churned-to-clean galador LISTS on the real-$CHIKI market via its fresh uid u4.");
  chk(!churnList.allowed, `AFTER churn: galador(u4) is still UNLISTABLE — observed ${churnList.status}, onBoard=${churnList.onBoard}`);
  if (churnList.id) await cancelOp(W, churnList.id);
}

// ===========================================================================
sec("PROPERTY 3 — HELD-AWARENESS (a departed/sold creature is NOT adopted)");
{
  const D = await mkWallet(PRE);
  await save(D, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "owzard", kind: "normal", level: 8 },
    u2: { species: "mushrow", kind: "normal", level: 5 } } });
  await save(D, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "owzard", kind: "normal", level: 8 } } });
  const a = (await audit(D)).body;
  chk(a.units.u2 && a.units.u2.held === false, `the departed mushrow is held=false in the ledger (${a.units.u2 && a.units.u2.held})`);
  const r = await sync(D);
  chk(r.body.adopted.includes("owzard"), `the held owzard is adopted (${JSON.stringify(r.body.adopted)})`);
  chk(!r.body.adopted.includes("mushrow"), `the departed mushrow is NOT adopted`);
  if (r.body.adopted.includes("mushrow")) hole("P3: a held===false creature was adopted");
  const rows = (await mine(D)).body.chikimon || [];
  chk(rows.every(x => x.sp !== "mushrow"), `and no mushrow row was minted (${rows.map(x => x.sp)})`);
}

// ===========================================================================
sec("PROPERTY 4 — NO CROSS-WALLET THEFT (a proven wallet only mints to ITSELF; body target fields ignored)");
{
  const VICTIM = await mkWallet();
  await save(VICTIM, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "dragonos", kind: "legendary", level: 50 } } });
  const ATT = await mkWallet(PRE);
  await save(ATT, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "solarix", kind: "normal", level: 3 } } });

  // CONTROL: attacker syncing their OWN wallet with their OWN token works (proves probe auth is real)
  const ctl = await sync(ATT);
  chk(ctl.status === 200 && ctl.body.species.includes("solarix"), `(control) attacker syncs their own solarix — 200 (${ctl.status})`);

  // THEFT 1: attacker asserts victim's wallet with attacker's token -> token binding must reject
  const t1 = await post("/assets/chikimon/sync", { wallet: VICTIM.wallet, mktToken: ATT.mktToken });
  chk(t1.status === 403, `attacker's token on victim's wallet -> 403 (${t1.status})`);
  if (t1.status === 200) hole("P4: attacker's token drove a sync on the victim's wallet");

  // THEFT 2: attacker names the victim in every plausible field; route reads its OWN ledger only
  const t2 = await sync(ATT, { units: ["dragonos"], sp: "dragonos", species: ["dragonos"],
                               target: VICTIM.wallet, forWallet: VICTIM.wallet, owner: VICTIM.wallet });
  console.log("    attacker-with-target species:", JSON.stringify(t2.body.species));
  chk(!t2.body.species.includes("dragonos"), `attacker cannot pull the victim's dragonos into their own stable`);
  const attRows = (await mine(ATT)).body.chikimon || [];
  chk(attRows.every(x => x.sp !== "dragonos"), `attacker's registry holds no dragonos (${attRows.map(x => x.sp)})`);
  if (attRows.some(x => x.sp === "dragonos")) hole("P4: the victim's dragonos was minted into the attacker's wallet");
  const vMine = (await mine(VICTIM)).body.chikimon || [];
  chk(vMine.length === 0, `and nothing was minted under the victim by the attacker (${vMine.length})`);
}

// ===========================================================================
sec("PROPERTY 5 — NO DOUBLE-MINT / CLONE (concurrent + repeat syncs; dedup even over duplicate rows)");
{
  // (a) five concurrent syncs on one ledger-known species
  const A = await mkWallet(PRE);
  await save(A, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "healix", kind: "normal", level: 12 } } });
  const results = await Promise.all([sync(A), sync(A), sync(A), sync(A), sync(A)]);
  const totalAdopted = results.reduce((n, r) => n + (r.body.adopted || []).filter(s => s === "healix").length, 0);
  console.log("    healix adopted across 5 concurrent syncs:", totalAdopted);
  chk(totalAdopted === 1, `exactly ONE of five concurrent syncs adopted the healix (${totalAdopted})`);
  const healixRows = ((await mine(A)).body.chikimon || []).filter(x => x.sp === "healix");
  chk(healixRows.length === 1, `the registry holds exactly ONE healix row, not a clone (${healixRows.length})`);
  if (healixRows.length > 1) hole(`P5: concurrent syncs cloned the healix into ${healixRows.length} rows`);

  // (b) canonical answer must be dup-free even if egg/consume earlier minted TWO rows of one species.
  const G = await mkWallet(PRE);
  await save(G, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "forestle", kind: "normal", level: 4 } } });
  for (let i = 0; i < 2; i++) {
    const ce = await claim(G, "normal");
    if (ce.status !== 200) { console.log("    (claim retry — rate limit)", ce.status); await wait(5200); i--; continue; }
    SRV._ageAsset(ce.body.egg.id, 7 * HOUR);
    const cr = await consume(G, ce.body.egg.id, "jellox");
    chk(cr.status === 200, `consume #${i + 1} minted a jellox row (${cr.status})`);
    await wait(5200);   // egg-claim rate limit is 5s
  }
  const dupBefore = ((await mine(G)).body.chikimon || []).filter(x => x.sp === "jellox").length;
  console.log("    registry jellox rows before sync:", dupBefore);
  chk(dupBefore === 2, `two real duplicate jellox rows exist pre-sync (${dupBefore})`);
  const r = await sync(G);
  console.log("    sync species:", JSON.stringify(r.body.species), " cards jellox count:",
    (r.body.chikimon || []).filter(x => x.sp === "jellox").length);
  chk(new Set(r.body.species).size === r.body.species.length, `the species list is duplicate-free (${JSON.stringify(r.body.species)})`);
  chk((r.body.chikimon || []).filter(x => x.sp === "jellox").length === 1, `the cards answer collapses the duplicate to ONE jellox`);
  chk(!r.body.adopted.includes("jellox"), `sync did not re-adopt the already-owned jellox (${JSON.stringify(r.body.adopted)})`);
  if (new Set(r.body.species).size !== r.body.species.length) hole("P5: canonical species list carried a duplicate");
}

// ===========================================================================
sec("PROPERTY 6 — NO PROTOTYPE POLLUTION (dangerous species names are inert, never minted)");
{
  const E = await mkWallet(PRE);
  // Build units as RAW JSON text so "__proto__" travels as a real own property after JSON.parse.
  const mmoText = `{"onboarded":true,"mounts":[],"eggs":[],"units":{`
    + `"u1":{"species":"__proto__","kind":"legendary","level":50},`
    + `"u2":{"species":"constructor","kind":"legendary","level":50},`
    + `"u3":{"species":"firix","kind":"normal","level":7}}}`;
  const parsed = JSON.parse(mmoText);
  chk(parsed.units.u1.species === "__proto__", `payload literally carries species "__proto__" (${parsed.units.u1.species})`);
  await saveRaw(E, mmoText);
  const rec = ledgerRec(E);
  console.log("    ledger unit species:", JSON.stringify(Object.values(rec.units).map(u => u.sp)));

  const r = await sync(E);
  console.log("    sync adopted:", JSON.stringify(r.body.adopted), " species:", JSON.stringify(r.body.species));
  chk(r.body.species.includes("firix"), `the real firix is adopted (${JSON.stringify(r.body.species)})`);
  const junk = r.body.species.some(s => s === "__proto__" || s === "constructor" || s === "hasOwnProperty");
  chk(!junk, `NO dangerous name was minted or listed`);
  if (junk) hole("P6: a prototype-key name was minted as a chikimon");
  // the point: no global pollution. Fresh objects minted AFTER the attack must be clean.
  const probe = {};
  const polluted = probe.origin !== undefined || probe.sp !== undefined || ({}).polluted !== undefined
    || Object.prototype.origin !== undefined || Object.prototype.sp !== undefined;
  console.log("    post-attack {}.origin=", probe.origin, " {}.sp=", probe.sp, " Object.prototype.origin=", Object.prototype.origin);
  chk(!polluted, `Object.prototype is un-poisoned process-wide`);
  if (polluted) hole("P6: Object.prototype was polluted via a species name");
}

// ===========================================================================
sec("PROPERTY 7 — LEVEL IS NOT ASSERTED (registry lvl is birth 1; the answer carries no live level)");
{
  const L = await mkWallet(PRE);
  await save(L, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "scorplex", kind: "normal", level: 48 } } });
  const r = await sync(L);
  const rows = (await mine(L)).body.chikimon || [];
  const row = rows.find(x => x.sp === "scorplex");
  console.log("    save level=48; registry row lvl=", row && row.lvl, " ; answer card keys=", JSON.stringify(Object.keys((r.body.chikimon || [])[0] || {})));
  chk(!!row && row.lvl === 1, `the registry row lvl is birth 1, NOT the save's level 48 (${row && row.lvl})`);
  if (row && row.lvl !== 1) hole(`P7: registry row carried the save level ${row.lvl}`);
  const card = (r.body.chikimon || []).find(x => x.sp === "scorplex");
  chk(card && card.lvl === undefined, `the sync answer card carries NO live level field for the client to adopt (lvl=${card && card.lvl})`);
  if (card && card.lvl !== undefined) hole(`P7: the answer leaked a live level (${card.lvl})`);
}

// ===========================================================================
sec("PROPERTY 9 — AUDIT INTERACTION, SAME UID (a post-sync re-save must not re-grade the same uid)");
{
  const W = await mkWallet();
  await save(W, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "mushrow", kind: "normal", level: 1 } } });
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "mushrow", kind: "normal", level: 1 },
    u2: { species: "adalor", kind: "legendary", level: 40 } } });
  const before = ledgerRec(W).units.u2.origin;
  const unvBefore = ledgerRec(W).unverified;
  await sync(W);
  const regAd = ((await mine(W)).body.chikimon || []).find(x => x.sp === "adalor");
  chk(!!regAd && regAd.origin === "unverified", `sync minted the adalor registry row unverified (${regAd && regAd.origin})`);
  // re-save the SAME roster: the `if (has(rec.units,uid)) continue` at ~4109 must prevent a re-grade.
  await save(W, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "mushrow", kind: "normal", level: 1 },
    u2: { species: "adalor", kind: "legendary", level: 40 } } });
  const after = ledgerRec(W).units.u2.origin;
  const unvAfter = ledgerRec(W).unverified;
  console.log("    ledger adalor(u2).origin: before-sync=", before, " after post-sync re-save=", after, " | unverified:", unvBefore, "->", unvAfter);
  chk(after === "unverified", `the SAME-uid adalor stays UNVERIFIED after a post-sync re-save (${after})`);
  if (after !== "unverified") hole(`P9: post-sync same-uid re-save upgraded adalor to '${after}' via regVouchesSpecies`);
  chk(unvAfter === unvBefore, `the unverified count is unmoved for the same-uid re-save (${unvBefore} -> ${unvAfter})`);
}

// ===========================================================================
// CAPACITY LAST: it fills the whole registry, then clears it — destructive, so it runs at the end.
sec("PROPERTY 8 — CAPACITY SAFETY (at ASSET_REG_MAX: 200, adopt-what-fits, rest stays retryable)");
{
  const P = await mkWallet();
  await save(P, { onboarded: true, mounts: [], eggs: [], units: { u1: { species: "owzard", kind: "normal", level: 1 } } });
  await save(P, { onboarded: true, mounts: [], eggs: [], units: {
    u1: { species: "owzard", kind: "normal", level: 1 },
    u2: { species: "tyrannos", kind: "legendary", level: 50 } } });
  const ledgerSpecies = Object.values(ledgerRec(P).units).map(u => u.sp);
  console.log("    ledger knows species:", JSON.stringify(ledgerSpecies));

  SRV._fillAssetRegForTest();   // registry now at ASSET_REG_MAX — every mint throws
  const rFull = await sync(P);
  console.log("    at-capacity sync -> status:", rFull.status, " ok:", rFull.body.ok, " adopted:", JSON.stringify(rFull.body.adopted));
  chk(rFull.status === 200 && rFull.body.ok === true, `the route holds its 200 at capacity — no crash, no 500 (${rFull.status})`);
  chk(Array.isArray(rFull.body.adopted) && rFull.body.adopted.length === 0, `nothing is adopted when the registry is full (${JSON.stringify(rFull.body.adopted)})`);
  if (rFull.status !== 200) hole(`P8: sync lost its 200 at capacity (${rFull.status})`);

  const stillKnown = Object.values(ledgerRec(P).units).map(u => u.sp);
  console.log("    after at-capacity sync the ledger still knows:", JSON.stringify(stillKnown));
  chk(stillKnown.length === ledgerSpecies.length, `every ledger unit is still known — none lost by the failed adopt (${stillKnown.length}/${ledgerSpecies.length})`);
  if (stillKnown.length < ledgerSpecies.length) hole("P8: a unit was lost from the ledger by a capacity-failed sync");

  SRV._clearAssetReg();
  const rFree = await sync(P);
  console.log("    after capacity freed -> adopted:", JSON.stringify(rFree.body.adopted), " species:", JSON.stringify(rFree.body.species));
  const recovered = ledgerSpecies.every(s => rFree.body.species.includes(s));
  chk(recovered, `once capacity frees, the SAME ledger creatures adopt cleanly — genuinely retryable (${JSON.stringify(rFree.body.species)})`);
  if (!recovered) hole("P8: creatures did NOT recover after capacity freed — not actually retryable");
}

// ===========================================================================
console.log(`\nCHIKIMON_FORGE_SIM pass=${pass} fail=${fail} holes=${broke.length}`);
if (broke.length) { console.log("CONFIRMED HOLES:"); broke.forEach((h, i) => console.log(`  ${i + 1}. ${h}`)); }
else console.log("No holes found by these probes — every intended property HELD under live attack.");
process.exit(fail ? 1 : 0);
