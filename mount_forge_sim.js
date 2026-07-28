// mount_forge_sim.js — ADVERSARIAL probe of POST /assets/mounts/sync (STEP 3 of server authority).
//
// The route (server.js ~3626) converts LEDGER-known mounts into registry PROPERTY, carrying the
// ledger's own origin, and answers the wallet's canonical mount-species list. I try to break each
// intended property below. Every assertion prints the ACTUAL value observed. "Could not break it"
// is a real result. This NEVER touches the live backend: throwaway keypair, memory store, dead RPC.
//
// Attacks, mapped to the intended security properties:
//   1  BODY NAMES NO MOUNT     — a crafted body cannot adopt a mount the ledger never knew
//   2  NO LAUNDERING           — unverified stays unverified; adoption is not amnesty for the count
//   3  NO CROSS-WALLET THEFT   — a proven wallet only ever mints to ITSELF
//   4  NO DOUBLE-MINT / CLONE  — concurrent/repeat syncs make one row; the answer is dup-free
//   5  NO PROTOTYPE POLLUTION  — "__proto__"/"constructor"/"hasOwnProperty" mount keys are inert
//   6  CAPACITY SAFETY         — at ASSET_REG_MAX: 200, adopt what fits, rest stays retryable
//   7  AUDIT INTERACTION       — after sync mints a row, the next save must not re-grade the ledger
//   8  HATCH-POOL INTERACTION  — owning an adopted mount only RESTRICTS the hatch pool, never helps
//
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39319";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const post = async (p, b) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
// postRaw: send a hand-built JSON STRING on the wire, so a payload the object-literal setter would
// have swallowed ("__proto__") actually reaches the server as a real key/element.
const postRaw = async (p, text) => { const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1400));

let pass = 0, fail = 0, broke = [];
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const hole = (m) => { broke.push(m); console.log("  *** HOLE:", m); };
const sec = (s) => console.log(`\n— ${s} —`);
const HOUR = 3600 * 1000;
let _n = 0;
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
// a signed save (700ms clears the 600ms /profile throttle) is the ONLY way a mount enters the ledger
const save = (w, mmo) => wait(700).then(() => post("/profile", { wallet: w.wallet, authMsg: w.authMsg, authSig: w.authSig, profile: { mmo } }));
// same, but the mmo is a raw JSON fragment spliced into the body text (for __proto__ etc.)
const saveRaw = (w, mmoText) => wait(700).then(() => postRaw("/profile",
  `{"wallet":${JSON.stringify(w.wallet)},"authMsg":${JSON.stringify(w.authMsg)},"authSig":${JSON.stringify(w.authSig)},"profile":{"mmo":${mmoText}}}`));
const sync = (w, extra) => post("/assets/mounts/sync", Object.assign({ wallet: w.wallet, mktToken: w.mktToken }, extra || {}));
const mine = (w) => get(`/assets/mine?wallet=${w.wallet}&mktToken=${encodeURIComponent(w.mktToken)}`);
const summary = () => get(`/assets/summary?key=test-admin-key`);
const claim = (w, kind) => post("/assets/egg/claim", { wallet: w.wallet, mktToken: w.mktToken, kind });
const hatch = (w, id) => post("/assets/egg/hatch", { wallet: w.wallet, mktToken: w.mktToken, id });
const consume = (w, id, sp) => post("/assets/egg/consume", { wallet: w.wallet, mktToken: w.mktToken, id, sp });
// live ledger record for a wallet (serializeAssetLedger returns the LIVE rec objects)
const ledgerRec = (w) => { const e = SRV.serializeAssetLedger().w.find(x => x[0] === w.wallet); return e ? e[1] : null; };

// ===========================================================================
sec("ATTACK 1 — the request body NAMES NO MOUNT (a crafted body cannot adopt the unknown)");
{
  const A = await mkWallet(Date.UTC(2025, 0, 1));   // pre-ledger player: stable grandfathered
  await save(A, { onboarded: true, units: {}, mounts: ["boar"], eggs: [] });
  // Throw everything a body could plausibly carry at it: the field names sync could have read,
  // plus a wallet/target swap. NONE of it is attacker-adoptable input.
  const r = await sync(A, {
    mounts: ["griffin"], sp: "griffin", species: ["griffin", "horse", "wolf"],
    adopt: ["griffin"], ledger: { mounts: { griffin: { origin: "legacy" } } },
    wallet2: A.wallet, target: A.wallet, forWallet: A.wallet, origin: "legacy",
  });
  console.log("    adopted:", JSON.stringify(r.body.adopted), " species:", JSON.stringify(r.body.species));
  const okBoar = r.body.species.includes("boar");
  const noInject = !r.body.species.includes("griffin") && !r.body.species.includes("horse") && !r.body.species.includes("wolf");
  chk(okBoar, `only the ledger-known boar is returned (${JSON.stringify(r.body.species)})`);
  chk(noInject, `every injected name is ignored (griffin/horse/wolf absent)`);
  if (!noInject) hole("ATTACK 1: a body field named a mount into the canonical list");
  const rows = (await mine(A)).body.mounts || [];
  chk(rows.length === 1 && rows[0].sp === "boar", `and only the boar was minted (${rows.map(m => m.sp)})`);
  if (rows.some(m => m.sp !== "boar")) hole("ATTACK 1: a body field minted an un-ledgered mount row");
}

// ===========================================================================
sec("ATTACK 2 — NO LAUNDERING (unverified rides unchanged; the flag COUNT is not cleared)");
{
  const C = await mkWallet();                                                  // fresh, no grandfather
  await save(C, { onboarded: true, units: {}, mounts: ["wolf"], eggs: [] });   // 1st mount -> legacy grandfather
  await save(C, { onboarded: true, units: {}, mounts: ["wolf", "griffin"], eggs: [] }); // 2nd -> unverified
  const recBefore = ledgerRec(C);
  const unvBefore = recBefore.unverified, grifOriginBefore = recBefore.mounts["griffin"].origin;
  console.log("    ledger BEFORE sync: griffin.origin=", grifOriginBefore, " unverified-count=", unvBefore);
  chk(grifOriginBefore === "unverified", `the conjured griffin is UNVERIFIED in the ledger (${grifOriginBefore})`);

  const r = await sync(C);
  const rows = (await mine(C)).body.mounts || [];
  const grif = rows.find(m => m.sp === "griffin"), wolf = rows.find(m => m.sp === "wolf");
  console.log("    registry rows:", rows.map(m => `${m.sp}:${m.origin}`).join(", "));
  chk(!!grif && grif.origin === "unverified", `the adopted griffin row is UNVERIFIED, not upgraded (${grif && grif.origin})`);
  chk(!!wolf && wolf.origin === "legacy", `the grandfathered wolf adopts as legacy — origins are per-row, not blended (${wolf && wolf.origin})`);
  if (grif && grif.origin !== "unverified") hole(`ATTACK 2: unverified ledger mount minted as '${grif.origin}' (laundered)`);

  const recAfter = ledgerRec(C);
  console.log("    ledger AFTER sync: griffin.origin=", recAfter.mounts["griffin"].origin, " unverified-count=", recAfter.unverified);
  chk(recAfter.unverified === unvBefore, `sync did NOT clear the ledger's unverified count (${unvBefore} -> ${recAfter.unverified})`);
  if (recAfter.unverified < unvBefore) hole("ATTACK 2: adoption was an amnesty — the ledger unverified count dropped");
  const sum = (await summary()).body;
  chk(sum.byOrigin && sum.byOrigin.unverified >= 1, `game-wide summary still counts >=1 unverified mount (${sum.byOrigin && sum.byOrigin.unverified})`);
}

// ===========================================================================
sec("ATTACK 3 — NO CROSS-WALLET THEFT (a proven wallet only ever mints to ITSELF)");
{
  const VICTIM = await mkWallet();
  await save(VICTIM, { onboarded: true, units: {}, mounts: ["griffin"], eggs: [] });  // victim's ledger knows griffin
  const ATT = await mkWallet(Date.UTC(2025, 0, 1));
  await save(ATT, { onboarded: true, units: {}, mounts: ["horse"], eggs: [] });

  // CONTROL: the attacker syncing their OWN wallet with their OWN token works (proves the probe auth is real)
  const ctl = await sync(ATT);
  chk(ctl.status === 200 && ctl.body.species.includes("horse"), `(control) attacker syncs their own horse — 200 (${ctl.status})`);

  // THEFT 1: attacker asserts the victim's wallet with the attacker's token -> token binding must reject
  const t1 = await post("/assets/mounts/sync", { wallet: VICTIM.wallet, mktToken: ATT.mktToken });
  chk(t1.status === 403, `attacker's token on victim's wallet -> 403 (${t1.status})`);
  if (t1.status === 200) hole("ATTACK 3: attacker's token drove a sync on the victim's wallet");

  // THEFT 2: attacker names the victim in every plausible target field; route reads its OWN ledger only
  const t2 = await sync(ATT, { target: VICTIM.wallet, forWallet: VICTIM.wallet, owner: VICTIM.wallet });
  console.log("    attacker-with-target adopted:", JSON.stringify(t2.body.adopted), " species:", JSON.stringify(t2.body.species));
  chk(!t2.body.species.includes("griffin"), `attacker cannot pull the victim's griffin into their own stable`);

  // the victim's griffin never became attacker property, and the victim (who never synced) still owns it in the ledger
  const attMounts = (await mine(ATT)).body.mounts || [];
  chk(attMounts.every(m => m.sp !== "griffin"), `attacker's registry holds no griffin (${attMounts.map(m => m.sp)})`);
  if (attMounts.some(m => m.sp === "griffin")) hole("ATTACK 3: the victim's griffin was minted into the attacker's wallet");
  const vRec = ledgerRec(VICTIM);
  chk(!!vRec && !!vRec.mounts["griffin"], `victim's ledger still knows its griffin (untouched)`);
  const vMine = (await mine(VICTIM)).body.mounts || [];
  chk(vMine.length === 0, `and nothing was minted under the victim by the attacker (${vMine.length})`);
}

// ===========================================================================
sec("ATTACK 4 — NO DOUBLE-MINT / CLONE (concurrent + repeat syncs; dedup even over duplicate rows)");
{
  // (a) five concurrent syncs on one ledger-known species
  const A = await mkWallet(Date.UTC(2025, 0, 1));
  await save(A, { onboarded: true, units: {}, mounts: ["wolf"], eggs: [] });
  const results = await Promise.all([sync(A), sync(A), sync(A), sync(A), sync(A)]);
  const totalAdopted = results.reduce((n, r) => n + (r.body.adopted || []).filter(s => s === "wolf").length, 0);
  console.log("    wolf adopted across 5 concurrent syncs:", totalAdopted);
  chk(totalAdopted === 1, `exactly ONE of the five concurrent syncs adopted the wolf (${totalAdopted})`);
  const wolfRows = ((await mine(A)).body.mounts || []).filter(m => m.sp === "wolf");
  console.log("    wolf registry rows after concurrent storm:", wolfRows.length);
  chk(wolfRows.length === 1, `and the registry holds exactly ONE wolf row, not a clone (${wolfRows.length})`);
  if (wolfRows.length > 1) hole(`ATTACK 4: concurrent syncs cloned the wolf into ${wolfRows.length} rows`);

  // (b) canonical answer must be dup-free even if an OLDER path minted two rows of one species.
  //     /assets/egg/consume mints a mount from a client-chosen species WITHOUT an ownedMounts check,
  //     so it can legitimately produce two 'griffin' rows — a real duplicate the answer must swallow.
  const G = await mkWallet(Date.UTC(2025, 0, 1));
  for (let i = 0; i < 2; i++) {
    const ce = await claim(G, "mount");
    if (ce.status !== 200) { console.log("    (claim retry — rate limit)", ce.status); await wait(5200); i--; continue; }
    SRV._ageAsset(ce.body.egg.id, 7 * HOUR);
    const cr = await consume(G, ce.body.egg.id, "griffin");
    chk(cr.status === 200, `consume #${i + 1} minted a griffin row (${cr.status})`);
    await wait(5200);   // egg-claim rate limit is 5s
  }
  const dupBefore = ((await mine(G)).body.mounts || []).filter(m => m.sp === "griffin").length;
  console.log("    registry griffin rows before sync:", dupBefore);
  chk(dupBefore === 2, `two real duplicate griffin rows exist pre-sync (${dupBefore})`);
  const r = await sync(G);
  console.log("    sync species:", JSON.stringify(r.body.species), " mounts-cards griffin count:",
    (r.body.mounts || []).filter(m => m.sp === "griffin").length);
  chk(new Set(r.body.species).size === r.body.species.length, `the species list is duplicate-free (${JSON.stringify(r.body.species)})`);
  chk((r.body.mounts || []).filter(m => m.sp === "griffin").length === 1, `the cards answer collapses the duplicate to ONE griffin`);
  chk(!r.body.adopted.includes("griffin"), `sync did not re-adopt the already-owned griffin (${JSON.stringify(r.body.adopted)})`);
  if (new Set(r.body.species).size !== r.body.species.length) hole("ATTACK 4: canonical species list carried a duplicate");
}

// ===========================================================================
sec("ATTACK 5 — NO PROTOTYPE POLLUTION (dangerous mount-key names are inert, never minted)");
{
  const E = await mkWallet(Date.UTC(2025, 0, 1));
  // Build the mounts array as RAW JSON text so "__proto__" travels as a literal element.
  const mmoText = `{"onboarded":true,"units":{},"eggs":[],"mounts":["__proto__","constructor","hasOwnProperty","horse"]}`;
  const parsed = JSON.parse(mmoText);
  chk(parsed.mounts.includes("__proto__"), `payload literally carries "__proto__" in mounts (${parsed.mounts.length} entries)`);
  await saveRaw(E, mmoText);
  // sanity: the ledger recorded the dangerous strings on a null-proto submap (no pollution at record time)
  const rec = ledgerRec(E);
  console.log("    ledger mount keys:", JSON.stringify(Object.keys(rec.mounts)));

  const r = await sync(E);
  console.log("    sync adopted:", JSON.stringify(r.body.adopted), " species:", JSON.stringify(r.body.species));
  chk(r.body.species.includes("horse"), `the real horse is adopted (${JSON.stringify(r.body.species)})`);
  const junkMinted = r.body.species.some(s => s === "__proto__" || s === "constructor" || s === "hasOwnProperty");
  chk(!junkMinted, `NO dangerous name was minted or listed`);
  if (junkMinted) hole("ATTACK 5: a prototype-key name was minted as a mount");
  const rows = (await mine(E)).body.mounts || [];
  chk(rows.every(m => ["chicken", "boar", "gator", "horse", "wolf", "griffin"].includes(m.sp)),
    `only catalog mounts exist as registry rows (${rows.map(m => m.sp)})`);

  // the whole point: no global pollution. A fresh object minted AFTER the attack must be clean.
  const probe = {};
  const polluted = probe.origin !== undefined || probe.ts !== undefined || ({}).polluted !== undefined
    || Object.prototype.origin !== undefined || Object.prototype.ts !== undefined;
  console.log("    post-attack {}.origin=", probe.origin, " {}.ts=", probe.ts, " Object.prototype.origin=", Object.prototype.origin);
  chk(!polluted, `Object.prototype is un-poisoned process-wide`);
  if (polluted) hole("ATTACK 5: Object.prototype was polluted via a mount key");
}

// ===========================================================================
sec("ATTACK 7 — AUDIT INTERACTION (a sync-minted row must not let the next save re-grade the ledger)");
{
  const W = await mkWallet();
  await save(W, { onboarded: true, units: {}, mounts: ["wolf"], eggs: [] });               // wolf -> legacy (1st)
  await save(W, { onboarded: true, units: {}, mounts: ["wolf", "griffin"], eggs: [] });    // griffin -> unverified
  const before = ledgerRec(W).mounts["griffin"].origin;
  await sync(W);   // mints a registry griffin row => regVouchesSpecies(mount, griffin) is now TRUE
  const rows = (await mine(W)).body.mounts || [];
  const regGrif = rows.find(m => m.sp === "griffin");
  chk(!!regGrif && regGrif.origin === "unverified", `sync minted the griffin registry row as unverified (${regGrif && regGrif.origin})`);
  // NOW re-save the same roster. If the audit re-examined the mount it could stamp it 'issued'
  // (the registry vouches it). The loop's `if (has(rec.mounts,id)) continue` must prevent that.
  const unvBeforeResave = ledgerRec(W).unverified;
  await save(W, { onboarded: true, units: {}, mounts: ["wolf", "griffin"], eggs: [] });
  const after = ledgerRec(W).mounts["griffin"].origin;
  const unvAfter = ledgerRec(W).unverified;
  console.log("    ledger griffin.origin: before-sync=", before, " after post-sync re-save=", after,
    " | unverified:", unvBeforeResave, "->", unvAfter);
  chk(after === "unverified", `the ledger griffin stays UNVERIFIED after a post-sync re-save — no self-vouch upgrade (${after})`);
  if (after !== "unverified") hole(`ATTACK 7: post-sync re-save upgraded ledger griffin from unverified to '${after}' via regVouchesSpecies`);
  chk(unvAfter === unvBeforeResave, `and the unverified count is unmoved (${unvBeforeResave} -> ${unvAfter})`);
}

// ===========================================================================
sec("ATTACK 8 — HATCH-POOL INTERACTION (owning an adopted mount only RESTRICTS the pool)");
{
  // adopt 5 of 6 species, then hatch a mount egg: the pool must have exactly the 1 unowned left,
  // so the roll can NEVER duplicate an owned mount.
  const H = await mkWallet(Date.UTC(2025, 0, 1));
  await save(H, { onboarded: true, units: {}, mounts: ["chicken", "boar", "gator", "horse", "wolf"], eggs: [] });
  const sr = await sync(H);
  const owned = new Set(sr.body.species);
  console.log("    adopted stable:", JSON.stringify([...owned]));
  chk(owned.size === 5 && !owned.has("griffin"), `five species owned, griffin still unowned (${owned.size})`);
  const ce = await claim(H, "mount");
  chk(ce.status === 200, `mount egg claimed (${ce.status})`);
  SRV._ageAsset(ce.body.egg.id, 7 * HOUR);
  const hr = await hatch(H, ce.body.egg.id);
  console.log("    hatched sp:", hr.body.hatched && hr.body.hatched.sp);
  chk(hr.status === 200 && hr.body.hatched.sp === "griffin", `the hatch rolled the ONLY unowned species, griffin — no duplicate (${hr.body.hatched && hr.body.hatched.sp})`);
  if (hr.status === 200 && owned.has(hr.body.hatched.sp)) hole(`ATTACK 8: hatch rolled an already-owned mount (${hr.body.hatched.sp})`);
  await wait(5200);

  // now the wallet owns all six. a further mount hatch must REFUSE (409) and NOT consume the egg —
  // owning everything can never help escape the cap.
  const ce2 = await claim(H, "mount");
  chk(ce2.status === 200, `second mount egg claimed (${ce2.status})`);
  SRV._ageAsset(ce2.body.egg.id, 7 * HOUR);
  const hr2 = await hatch(H, ce2.body.egg.id);
  console.log("    full-stable hatch status:", hr2.status);
  chk(hr2.status === 409, `a full stable refuses the hatch (409), it does not roll a seventh (${hr2.status})`);
  const cert = await get(`/assets/cert?id=${ce2.body.egg.id}`);
  chk(cert.body.state === "active", `and the egg was NOT consumed by the refused hatch — nothing lost (${cert.body.state})`);
  if (hr2.status !== 409) hole(`ATTACK 8: a full stable did not refuse the hatch (${hr2.status})`);
}

// ===========================================================================
// CAPACITY LAST: it fills the whole registry, then clears it — destructive, so it runs at the end.
sec("ATTACK 6 — CAPACITY SAFETY (at ASSET_REG_MAX: 200, adopt-what-fits, rest stays retryable)");
{
  const P = await mkWallet();
  await save(P, { onboarded: true, units: {}, mounts: ["horse"], eggs: [] });               // horse -> legacy (1st)
  await save(P, { onboarded: true, units: {}, mounts: ["horse", "griffin"], eggs: [] });    // griffin -> unverified
  const ledgerSpecies = Object.keys(ledgerRec(P).mounts).filter(s => ["chicken","boar","gator","horse","wolf","griffin"].includes(s));
  console.log("    ledger knows mounts:", JSON.stringify(ledgerSpecies));

  SRV._fillAssetRegForTest?.();   // registry now at ASSET_REG_MAX — every mint throws
  const rFull = await sync(P);
  console.log("    at-capacity sync -> status:", rFull.status, " ok:", rFull.body.ok,
    " adopted:", JSON.stringify(rFull.body.adopted), " species:", JSON.stringify(rFull.body.species));
  chk(rFull.status === 200 && rFull.body.ok === true, `the route holds its 200 at capacity — no crash, no 500 (${rFull.status})`);
  chk(Array.isArray(rFull.body.adopted) && rFull.body.adopted.length === 0, `nothing is adopted when the registry is full (${JSON.stringify(rFull.body.adopted)})`);
  if (rFull.status !== 200) hole(`ATTACK 6: sync lost its 200 at capacity (${rFull.status})`);

  // the un-adopted mounts must remain LEDGER-KNOWN so a later sync (after capacity frees) restores them
  const stillKnown = Object.keys(ledgerRec(P).mounts).filter(s => ["chicken","boar","gator","horse","wolf","griffin"].includes(s));
  console.log("    after at-capacity sync the ledger still knows:", JSON.stringify(stillKnown));
  chk(stillKnown.length === ledgerSpecies.length, `every ledger mount is still known — none lost by the failed adopt (${stillKnown.length}/${ledgerSpecies.length})`);
  if (stillKnown.length < ledgerSpecies.length) hole("ATTACK 6: a mount was lost from the ledger by a capacity-failed sync");

  // NOTE (reported, not a route break): at capacity the CANONICAL answer's species list is what the
  // ledger cannot yet back with registry rows — here it is empty even though the ledger knows mounts.
  // The route's own docstring claims the answer 'can only ever GROW an honest stable'; that invariant
  // does NOT hold at capacity. A client that replaces its local list wholesale from this answer would
  // momentarily show an empty stable. Print the evidence:
  console.log("    OBSERVATION @capacity: ledger-known=", ledgerSpecies.length, " but canonical species=", JSON.stringify(rFull.body.species));

  // RETRYABLE: free capacity and sync again — everything the ledger knew is now adopted.
  SRV._clearAssetReg();
  const rFree = await sync(P);
  console.log("    after capacity freed -> adopted:", JSON.stringify(rFree.body.adopted), " species:", JSON.stringify(rFree.body.species));
  const recovered = ledgerSpecies.every(s => rFree.body.species.includes(s));
  chk(recovered, `once capacity frees, the SAME ledger mounts adopt cleanly — genuinely retryable (${JSON.stringify(rFree.body.species)})`);
  if (!recovered) hole("ATTACK 6: mounts did NOT recover after capacity freed — not actually retryable");
}

// ===========================================================================
console.log(`\nMOUNT_FORGE_SIM pass=${pass} fail=${fail} holes=${broke.length}`);
if (broke.length) { console.log("CONFIRMED HOLES:"); broke.forEach((h, i) => console.log(`  ${i + 1}. ${h}`)); }
else console.log("No holes found by these probes — every intended property HELD under live attack.");
process.exit(fail ? 1 : 0);
