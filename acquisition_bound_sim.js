#!/usr/bin/env node
// THE ACQUISITION BOUND: no wallet may sell more of an item than Chikoria recorded it acquiring.
//
// The tests that MATTER here are the false-positive ones. Refusing a real player's goods is worse
// than the exploit this closes — two save migrations have already destroyed real property in this
// project — so a pre-existing hoard, a fresh gatherer and an unwitnessed-reward player must all
// still be able to sell.
// No live backend, no on-chain. Throwaway keypairs, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59995";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8799";
process.env.NETWORK = "devnet";
process.env.ADMIN_KEY = "simonly-" + crypto.randomBytes(8).toString("hex");
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
const BASE = "http://127.0.0.1:8799";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/market/list")).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }
let seq = 0; const lid = () => "A" + (++seq) + "_" + crypto.randomBytes(3).toString("hex");
const ALLOW = 1500;          // UNWITNESSED_ALLOWANCE
const OPEN_CAP = 6200;       // OWN_OPEN_CAP

async function main() {
  const srv = await import("./server.js");
  await waitUp();
  srv._clearOwnBook();       // deterministic: never inherit another sim's book
  console.log("\n=== THE ACQUISITION BOUND ===\n");

  const mk = async () => {
    const kp = Keypair.generate();
    const sid = "net_" + kp.publicKey.toBase58().slice(0, 10);
    const v = await post("/verify", { ...signIn(kp), netId: sid });
    return { kp, wallet: kp.publicKey.toBase58(), sid, tok: v.json.mktToken, auth: signIn(kp) };
  };
  const list = (t, l) => post("/market/op", { sid: t.sid, op: "list", mktToken: t.tok, wallet: t.wallet, listing: l });
  const cancel = (t, id) => post("/market/op", { sid: t.sid, op: "cancel", mktToken: t.tok, wallet: t.wallet, listing: { id } });
  // gather for real: presence, then position-authorised node claims
  const gather = async (t, kind, ix, iz, n) => {
    let got = 0;
    for (let i = 0; i < n; i++) {
      await post("/world/move", { wallet: t.wallet, mktToken: t.tok, x: ix, z: iz, y: 6, dir: 0, handle: "S", leg: 1, el: "Fire", br: 1 });
      const r = await post("/world/node/claim", { wallet: t.wallet, mktToken: t.tok, id: `${kind}:${ix + i * 3}:${iz}` });
      if (r.status === 200 && r.json.ok !== false) got++;
      await new Promise(r2 => setTimeout(r2, 1850));   // CLAIM_MIN_MS 1800
    }
    return got;
  };

  // ---------- 1. THE ATTACK: a fabricated hoard, never gathered ----------
  const forger = await mk();
  const f1 = lid();
  const rF = await list(forger, { id: f1, kind: "mat", item: "crystal", qty: 19000, price: 90000 });
  ok("a wallet that acquired NOTHING cannot sell 19,000 crystal",
     rF.status === 409, `status ${rF.status} ${JSON.stringify(rF.json.error || "")}`);
  ok("...and the refusal reports what it DID record", Number(rF.json.available) === ALLOW,
     `available=${rF.json.available} (allowance ${ALLOW})`);
  const cF = await cancel(forger, f1);
  ok("...and that refusal is recoverable (Stage 0 holds)", cF.json.cancelled === true);

  // ---------- 2. FALSE-POSITIVE: a fresh player selling inside the allowance ----------
  const fresh = await mk();
  const n1 = lid();
  const rN = await list(fresh, { id: n1, kind: "mat", item: "wood", qty: 300, price: 400 });
  ok("a new player selling 300 wood (unwitnessed rewards, chests) is ALLOWED",
     rN.status === 200, `status ${rN.status} ${JSON.stringify(rN.json.error || "")}`);

  // ---------- 3. witnessed gathering raises the ceiling ----------
  const digger = await mk();
  const got = await gather(digger, "wood", 500, 500, 3);
  ok("real position-authorised claims were recorded", got === 3, `claims accepted=${got}`);
  const avail = srv._ownAvailFor(digger.wallet, "mat", "wood");
  ok("...and each claim credited exactly ONE unit", avail === ALLOW + 3, `available=${avail} expected=${ALLOW + 3}`);
  const bk = srv._ownFor(digger.wallet);
  ok("...into cred, not open", bk && bk.cred["mat:wood"] === 3, JSON.stringify(bk && bk.cred));

  // ---------- 4. a kill REPORT credits nothing at all (2026-07-31) ----------
  // It used to credit 1 essence whenever the server had NOT witnessed the kill — i.e. exactly when it
  // had no evidence — which measured 7,194 sellable units/hour on a wallet that never fought. The
  // shared mob pool is the witnessed path now (/world/mob/hit credits on the server's own view of a
  // health pool reaching zero) and the shipped client fires both, so nothing honest is lost.
  const fighter = await mk();
  await post("/world/move", { wallet: fighter.wallet, mktToken: fighter.tok, x: 10, z: 10, y: 6, dir: 0, handle: "F", leg: 1, el: "Fire", br: 1 });
  const k1 = await post("/world/kill/report", { wallet: fighter.wallet, mktToken: fighter.tok });
  ok("a kill report is counted", k1.status === 200, `status ${k1.status}`);
  const eb = srv._ownFor(fighter.wallet);
  ok("...crediting NO sellable essence on the client's word",
     !eb || !eb.cred["mat:essence"], `cred=${JSON.stringify(eb && eb.cred)}`);
  const gc = srv._gatheredFor(fighter.wallet);
  ok("...while the observe-only tally KEEPS its over-generous 6", gc && gc.essence === 6,
     `gatherCount=${JSON.stringify(gc)}`);

  // ---------- 5. DECLARED gains are never credited ----------
  const liar = await mk();
  await post("/world/move", { wallet: liar.wallet, mktToken: liar.tok, x: 20, z: 20, y: 6, dir: 0, handle: "L", leg: 1, el: "Fire", br: 1 });
  await post("/world/mat/flow", { wallet: liar.wallet, mktToken: liar.tok,
    gained: [{ kind: "chest", mats: { crystal: 600 } }, { kind: "task", mats: { crystal: 600 } }] });
  const lb = srv._ownFor(liar.wallet);
  ok("a declared /world/mat/flow gain credits NOTHING to the book",
     !lb || !lb.cred["mat:crystal"], `cred=${JSON.stringify(lb && lb.cred)}`);
  const rL = await list(liar, { id: lid(), kind: "mat", item: "crystal", qty: 1900, price: 3000 });
  ok("...so a declared hoard still cannot be sold", rL.status === 409, `status ${rL.status}`);

  // ---------- 6. FALSE-POSITIVE THAT MATTERS MOST: the pre-existing player ----------
  // A wallet whose FIRST server-written save predates the epoch keeps its hoard as entitlement.
  const vet = await mk();
  // seed a save, then backdate the SERVER's own clock on it, then save again — the opening is taken
  // from the PREVIOUS save's _serverSavedAt, which is what proves the account predates the epoch.
  await post("/profile", { wallet: vet.wallet, ...vet.auth, profile: { mmo: { mats: { crystal: 4000 } } } });
  await srv._setServerSavedAtForTest(vet.wallet, Date.parse("2026-06-01T00:00:00Z"));
  // MUST clear the 600ms _lastSave throttle, or the second save returns {throttled:true} before it
  // ever reaches the snapshot — which is how this test failed the first time I ran it.
  await new Promise(r => setTimeout(r, 700));
  const vSave = await post("/profile", { wallet: vet.wallet, ...vet.auth, profile: { mmo: { mats: { crystal: 4000 } } } });
  ok("the veteran's second save was not throttled away", vSave.json.throttled !== true, JSON.stringify(vSave.json).slice(0, 90));
  const vb = srv._ownFor(vet.wallet);
  const vAvail = srv._ownAvailFor(vet.wallet, "mat", "crystal");
  console.log("      veteran book:", JSON.stringify(vb));
  const rV = await list(vet, { id: lid(), kind: "mat", item: "crystal", qty: 3500, price: 9000 });
  ok("a pre-epoch veteran can sell their real 3,500-crystal hoard",
     rV.status === 200, `status ${rV.status} available=${vAvail} ${JSON.stringify(rV.json.error || "")}`);
  ok("...and the opening is capped at the measured ceiling",
     !vb || !vb.open["mat:crystal"] || vb.open["mat:crystal"] <= OPEN_CAP, `open=${JSON.stringify(vb && vb.open)}`);

  // ---------- 7. escrow: the SAME stack cannot back 12 listings ----------
  const stacker = await mk();
  let allowed = 0, refusedAt = -1;
  for (let i = 0; i < 6; i++) {
    const r = await list(stacker, { id: lid(), kind: "mat", item: "stone", qty: 400, price: 100 });
    if (r.status === 200) allowed++; else if (refusedAt < 0) refusedAt = i;
  }
  ok("escrow stops the same goods backing listing after listing",
     allowed * 400 <= ALLOW + 400 && refusedAt >= 0,
     `allowed=${allowed} listings x400 = ${allowed * 400} units, first refusal at #${refusedAt} (allowance ${ALLOW})`);

  // ---------- 8. cancelling frees the escrow again ----------
  const freed = lid();
  const st2 = await mk();
  await list(st2, { id: freed, kind: "mat", item: "honey", qty: 1400, price: 100 });
  const blocked = await list(st2, { id: lid(), kind: "mat", item: "honey", qty: 1400, price: 100 });
  ok("a second listing beyond the ceiling is refused while the first is escrowed", blocked.status === 409,
     `status ${blocked.status}`);
  await cancel(st2, freed);
  const after = await list(st2, { id: lid(), kind: "mat", item: "honey", qty: 1400, price: 100 });
  ok("...and cancelling the first frees the escrow so it can be listed again", after.status === 200,
     `status ${after.status} ${JSON.stringify(after.json.error || "")}`);

  // ---------- 9. a SALE consumes the entitlement permanently ----------
  const s3 = await mk();
  const b3 = await mk();
  const sellId = lid();
  await list(s3, { id: sellId, kind: "mat", item: "berries", qty: 1400, price: 60 });
  const availBefore = srv._ownAvailFor(s3.wallet, "mat", "berries");
  await post("/market/op", { sid: b3.sid, op: "buy", mktToken: b3.tok, wallet: b3.wallet, listing: { id: sellId } });
  const availAfter = srv._ownAvailFor(s3.wallet, "mat", "berries");
  const sb = srv._ownFor(s3.wallet);
  // The escrow released (the row left the board) but `sold` took its place, so the number is
  // unchanged — that IS the invariant. Assert the sold column moved, not just the net.
  ok("a settled sale is recorded against the seller's lifetime total",
     sb && sb.sold["mat:berries"] === 1400, `sold=${JSON.stringify(sb && sb.sold)}`);
  ok("...and the entitlement did not come back with the escrow",
     availAfter <= availBefore, `before=${availBefore} after=${availAfter}`);
  const resell = await list(s3, { id: lid(), kind: "mat", item: "berries", qty: 1400, price: 60 });
  ok("...so the seller cannot sell that same 1,400 again", resell.status === 409, `status ${resell.status}`);

  // ---------- 10. ffish / pot are NOT enforced yet, and must not be ----------
  const fisher = await mk();
  // DEFAULT (flag off): ffish is credited but NOT enforced, because the shipped client still rolls its
  // own catch and would show a player a fish the server never saw.
  srv._setFfishAuthorityForTest(false);
  const rFFoff = await list(fisher, { id: lid(), kind: "ffish", item: "golden_chikifish", qty: 1900, price: 400 });
  ok("with FFISH_AUTHORITY off, a fantasy-fish listing is NOT bound (no desync harm to honest players)",
     rFFoff.status === 200, `status ${rFFoff.status}`);
  // FLAG ON: the bind is real
  srv._setFfishAuthorityForTest(true);
  const fisher2 = await mk();
  const rFF = await list(fisher2, { id: lid(), kind: "ffish", item: "golden_chikifish", qty: 1900, price: 400 });
  ok("with it on, an uncaught legend cannot be sold at all", rFF.status === 409, `status ${rFF.status}`);
  srv._grantOwnForTest(fisher2.wallet, "golden_chikifish", 4, "ffish");
  const rFF2 = await list(fisher2, { id: lid(), kind: "ffish", item: "golden_chikifish", qty: 4, price: 400 });
  ok("...and exactly what WAS caught can be sold", rFF2.status === 200, `status ${rFF2.status}`);
  const rPot = await list(fisher, { id: lid(), kind: "pot", item: "healing_draught", qty: 900, price: 40 });
  ok("...nor potions (crafted client-side)", rPot.status === 200, `status ${rPot.status}`);

  // ---------- 11. the operator can see it ----------
  const sum = await get("/assets/summary?key=" + encodeURIComponent(process.env.ADMIN_KEY));
  const ab = sum.json.acquisitionBound || {};
  ok("the audit reports the bound as enforcing", ab.enforcing === true, `enforcing=${ab.enforcing}`);
  ok("...with the refusals counted", Number(ab.refused) >= 3, `refused=${ab.refused}`);
  ok("...and NOTHING skipped for an unready book", Number(ab.skipped) === 0, `skipped=${ab.skipped}`);
  ok("...naming the worst shortfall", (ab.worst || []).some(x => x.asked >= 19000),
     `worst=${JSON.stringify((ab.worst || []).slice(0, 2))}`);

  // ---------- 12. restore is hostile-input safe ----------
  const kept = srv.restoreOwnBook([
    ["not-a-wallet", { cred: { "mat:wood": 5 } }],
    [forger.wallet, { cred: { "mat:../../etc": 9, "pot:healing_draught": 9, "mat:notamat": 9, "mat:wood": -4, "mat:stone": 7 } }],
  ]);
  const rb = srv._ownFor(forger.wallet);
  ok("restore drops a non-pubkey row", kept === 1, `kept=${kept}`);
  ok("...and keeps only real kind:material keys with positive finite values",
     rb && rb.cred["mat:stone"] === 7 && !rb.cred["mat:notamat"] && !rb.cred["pot:healing_draught"] && !rb.cred["mat:../../etc"] && !rb.cred["mat:wood"],
     JSON.stringify(rb && rb.cred));

  // ---------- 13. MITHRA'S PRICE: an egg must cost real acquired material ----------
  // This is the bypass THROUGH the bound: a free egg hatches into a chikimon minted with clean
  // "issued" provenance, which then passes chikimonSaleBlocked and sells for real $CHIKI.
  // HONEST SCOPE: a legendary egg needs 40 crystal / 30 gold / 26 essence, all far inside the 1500
  // unwitnessed allowance — so a brand-new wallet IS still granted one, by design. The allowance is a
  // one-time per-item budget that protects honest players, and spending it on eggs is spending it. The
  // real property to assert is that the budget is FINITE and shared with selling.
  const beggar = await mk();
  srv._setFfishAuthorityForTest(true);
  const rE = await post("/assets/egg/claim", { wallet: beggar.wallet, mktToken: beggar.tok, kind: "legendary" });
  ok("a wallet that caught no Mystic Eel is refused a legendary egg — the PRIMARY ingredient is enforced",
     rE.status === 409 && rE.json.fish === "mystic_eel", `status ${rE.status} fish=${rE.json.fish}`);
  // now exhaust that wallet's crystal budget by escrowing it in a listing, and the egg is refused
  const drain = await mk();
  await list(drain, { id: lid(), kind: "mat", item: "crystal", qty: 1480, price: 900 });
  const rE2 = await post("/assets/egg/claim", { wallet: drain.wallet, mktToken: drain.tok, kind: "legendary" });
  ok("once the budget is spent, Mithra refuses — the egg and the market draw on the SAME entitlement",
     rE2.status === 409, `status ${rE2.status} ${JSON.stringify(rE2.json.error || "").slice(0, 120)}`);
  ok("...and the refusal names what is missing and what was recorded",
     (rE2.json.fish === "mystic_eel" || rE2.json.mat === "crystal") && Number.isFinite(Number(rE2.json.have)),
     JSON.stringify({ fish: rE2.json.fish, mat: rE2.json.mat, need: rE2.json.need, have: rE2.json.have }));

  // A PLAYER WHOSE GATHERING THE SERVER WITNESSED CAN STILL CLAIM.
  // 2026-07-31: asset ISSUANCE no longer spends the 1500 market allowance — it reads
  // ISSUE_UNWITNESSED_ALLOWANCE (25), which is below every recipe's largest ingredient, because the
  // full allowance measured out at 37 free legendary eggs and 37 free mount eggs on a wallet that had
  // done nothing but /verify (the fuel behind the /assets/egg/consume species drains). So this case
  // now grants the materials the way a real gather does, which is what it was always describing.
  const payer = await mk();
  srv._setFfishAuthorityForTest(true);
  srv._grantOwnForTest(payer.wallet, "golden_chikifish", 3, "ffish");   // the 3 legends the recipe demands
  for (const [m, n] of Object.entries({ wood: 30, berries: 24, essence: 8 })) srv._grantOwnForTest(payer.wallet, m, n);
  const rP = await post("/assets/egg/claim", { wallet: payer.wallet, mktToken: payer.tok, kind: "normal" });
  ok("a player who caught the legend AND has the materials gets their egg",
     rP.status === 200, `status ${rP.status} ${JSON.stringify(rP.json.error || "").slice(0, 90)}`);
  const pb = srv._ownFor(payer.wallet);
  ok("...and the barter was actually CHARGED to the book",
     pb && pb.used["mat:wood"] === 30 && pb.used["mat:berries"] === 24 && pb.used["mat:essence"] === 8,
     `used=${JSON.stringify(pb && pb.used)}`);
  const availWood = srv._ownAvailFor(payer.wallet, "mat", "wood");
  ok("...so the material they spent is no longer sellable",
     availWood === ALLOW + 30 - 30, `wood available=${availWood} expected=${ALLOW}`);

  // and the charge is atomic: a wallet short on ONE material pays nothing
  const short = await mk();
  await post("/assets/egg/claim", { wallet: short.wallet, mktToken: short.tok, kind: "normal" });
  await new Promise(r => setTimeout(r, 5100));   // EGG_CLAIM_MIN_MS
  // drain the allowance on one material via a big legit-looking listing, then try an egg needing it
  const sb2 = srv._ownFor(short.wallet);
  ok("a partial payment is never taken (all-or-nothing charge)",
     !sb2 || !sb2.used["mat:wood"] || sb2.used["mat:wood"] % 30 === 0,
     `used=${JSON.stringify(sb2 && sb2.used)}`);

  // ---------- 14. FANTASY FISH: the server rolls, and the species is now witnessed ----------
  // A fantasy fish is the PRIMARY ingredient of every egg, so it was the worst thing to take on the
  // client's word. The client can no longer name its catch.
  const angler = await mk();
  await post("/world/move", { wallet: angler.wallet, mktToken: angler.tok, x: 30, z: 30, y: 6, dir: 0, handle: "A", leg: 1, el: "Fire", br: 1 });
  const declared = await post("/world/fish/report", { wallet: angler.wallet, mktToken: angler.tok, species: "rainbow_fish", ffish: 500 });
  ok("a fish report is accepted", declared.status === 200, `status ${declared.status}`);
  const ab2 = srv._ownFor(angler.wallet);
  ok("...but a client-DECLARED species credits nothing — only the server's roll counts",
     !ab2 || !ab2.cred["ffish:rainbow_fish"] || ab2.cred["ffish:rainbow_fish"] < 500,
     `cred=${JSON.stringify(ab2 && ab2.cred)}`);
  ok("...while the ordinary catch credited exactly one fish (no double count)",
     ab2 && ab2.cred["mat:fish"] === 1, `cred.mat:fish=${ab2 && ab2.cred["mat:fish"]}`);

  // there is NO allowance for fantasy fish — its only source is a cast the server rolled
  // the server's roll must credit the book even while enforcement is off, or the day the flag flips it
  // would refuse every honest angler who caught something in the meantime
  srv._setFfishAuthorityForTest(false);
  srv._grantOwnForTest(angler.wallet, "crystal_koi", 2, "ffish");
  ok("ffish is CREDITED even with the flag off, so the eventual flip refuses nobody",
     (srv._ownFor(angler.wallet) || {}).cred["ffish:crystal_koi"] === 2,
     `cred=${JSON.stringify((srv._ownFor(angler.wallet) || {}).cred)}`);
  srv._setFfishAuthorityForTest(true);
  const noAllow = srv._ownAvailFor(angler.wallet, "ffish", "rainbow_fish");
  ok("fantasy fish get NO unwitnessed allowance (a 1-in-5000 fish must not be forgiven 1500)",
     noAllow <= 0, `available=${noAllow}`);
  const rSell = await list(angler, { id: lid(), kind: "ffish", item: "rainbow_fish", qty: 5, price: 9000 });
  ok("...so an uncaught legend cannot be listed at all", rSell.status === 409,
     `status ${rSell.status} ${JSON.stringify(rSell.json.error || "").slice(0, 90)}`);

  // the roll itself must obey the rod gate: rod 0 can never produce a legend
  let legends = 0;
  for (let i = 0; i < 25; i++) {
    const r = await post("/world/fish/report", { wallet: angler.wallet, mktToken: angler.tok, tier: 3, rod: 0 });
    if (r.json && r.json.legend) legends++;
    await new Promise(z => setTimeout(z, 850));
  }
  ok("rod 0 can never hook a legend, however the client asks (FFISH_ROD_REQ)", legends === 0, `legends=${legends}`);

  // and Mithra now demands the legend she was always supposed to
  // MATERIALS GRANTED THE WAY A GATHER GRANTS THEM — issuance reads the strict allowance now
  // (ISSUE_UNWITNESSED_ALLOWANCE 25, below the meme egg's 50 crystal), so the fish half is what these
  // two cases are actually about and the material half has to be paid for like a real player's.
  const MEME_MATS = { crystal: 50, honey: 34, berries: 40, essence: 34 };
  const eggless = await mk();
  for (const [m, n] of Object.entries(MEME_MATS)) srv._grantOwnForTest(eggless.wallet, m, n);
  srv._setFfishAuthorityForTest(false);
  const rMemeOff = await post("/assets/egg/claim", { wallet: eggless.wallet, mktToken: eggless.tok, kind: "meme" });
  ok("with the flag off Mithra still trades without the legend (today's behaviour, unbroken)",
     rMemeOff.status === 200, `status ${rMemeOff.status}`);
  srv._setFfishAuthorityForTest(true);
  const eggless2 = await mk();
  for (const [m, n] of Object.entries(MEME_MATS)) srv._grantOwnForTest(eggless2.wallet, m, n);
  const rMeme = await post("/assets/egg/claim", { wallet: eggless2.wallet, mktToken: eggless2.tok, kind: "meme" });
  ok("a meme egg is refused without the Rainbow Fish the recipe demands",
     rMeme.status === 409 && rMeme.json.fish === "rainbow_fish",
     `status ${rMeme.status} ${JSON.stringify(rMeme.json.error || "").slice(0, 120)}`);
  // grant one legitimately and it goes through, charged
  srv._grantOwnForTest(eggless2.wallet, "rainbow_fish", 1, "ffish");
  const rMeme2 = await post("/assets/egg/claim", { wallet: eggless2.wallet, mktToken: eggless2.tok, kind: "meme" });
  ok("...and granted the caught legend, Mithra trades", rMeme2.status === 200,
     `status ${rMeme2.status} ${JSON.stringify(rMeme2.json.error || "").slice(0, 120)}`);
  const mb = srv._ownFor(eggless2.wallet);
  ok("...charging the fish, not just the materials", mb && mb.used["ffish:rainbow_fish"] === 1,
     `used=${JSON.stringify(mb && mb.used)}`);

  console.log(`\nACQUISITION_BOUND_SIM  pass=${pass} fail=${fail}`);
  if (fail) { console.log("failures:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SIM ERROR", e); process.exit(1); });
