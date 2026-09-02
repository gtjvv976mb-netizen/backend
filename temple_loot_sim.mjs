#!/usr/bin/env node
// Wicked Temple loot transport — pure 10,000-slot proof plus real HTTP grant/replay checks.
// Uses only throwaway wallets, the memory store, a dead RPC URL and imported test seams.
// Run: node temple_loot_sim.mjs
import { spawn } from "node:child_process";
import nacl from "tweetnacl";
import bs58 from "bs58";

const ROLE = process.env.TEMPLE_LOOT_ROLE || "on";
const PORT = ROLE === "loot_off" ? "39242" : ROLE === "temple_off" ? "39243" : "39241";
const BASE = "http://127.0.0.1:" + PORT;
const keypairs = new Map();
const wallet = () => {
  const kp = nacl.sign.keyPair(), w = bs58.encode(kp.publicKey);
  keypairs.set(w, kp); return w;
};

const W = {
  fish: wallet(), defeat: wallet(), missing: wallet(), rejected: wallet(), invalid: wallet(),
  capped: wallet(), daily: wallet(), dailyProbe: wallet(), unproven: wallet(), signed: wallet(), token: wallet(),
  race: wallet(), crashPrepareFish: wallet(), crashFish: wallet(), crashEgg: wallet(), crashCommitEgg: wallet(),
  failed: wallet(), off: wallet(),
};
const treasury = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = PORT;
process.env.CHIK_CHRONICLE = "1";
delete process.env.DATABASE_URL;
for (const key of ["TEMPLE_CHIKI_PER", "TEMPLE_DAILY_CHIKI", "TEMPLE_DAILY_RUNS", "TEMPLE_MIN_GAP_MS"])
  delete process.env[key];
if (ROLE === "temple_off") {
  delete process.env.CHIK_TEMPLE;
  process.env.CHIK_TEMPLE_LOOT = "1";
} else if (ROLE === "loot_off") {
  process.env.CHIK_TEMPLE = "1";
  delete process.env.CHIK_TEMPLE_LOOT;
} else {
  process.env.CHIK_TEMPLE = "1";
  process.env.CHIK_TEMPLE_LOOT = "1";
}

const SRV = await import("./server.js");
const postPath = (path, body) => fetch(BASE + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));
const post = (body) => postPath("/world/temple/purge", body);
const get = (path) => fetch(BASE + path).then(async (r) => ({ status: r.status, b: await r.json().catch(() => ({})) }));
function signed(w) {
  const authMsg = `Chikoria sign-in\nwallet:${w}\nts:${Date.now()}`;
  const authSig = Buffer.from(nacl.sign.detached(Buffer.from(authMsg, "utf8"), keypairs.get(w).secretKey)).toString("base64");
  return { authMsg, authSig };
}
const purge = (w, purified, runId, rounds = 5, extra = {}) => post({ wallet: w, purified, rounds,
  ...(runId === undefined ? {} : { runId }), ...signed(w), ...extra });
const purgeUnproven = (w, purified, runId, rounds = 5) => post({ wallet: w, purified, rounds,
  ...(runId === undefined ? {} : { runId }) });

let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log("  ok: " + message); }
  else { fail++; console.log("  FAIL: " + message); }
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function ownFish(w, species) { return Number(SRV._ownFor(w)?.cred?.["ffish:" + species] || 0); }
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }
async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const health = await get("/health");
      if (health.status && SRV._templeStateForTest().ready && SRV._assetLedgerReady()) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server subsystems did not become ready");
}

await waitReady();
SRV._clearTempleBookForTest();
SRV._clearOwnBook();
SRV._clearAssetReg();
SRV._clearAssetLedger();

// The two child roles prove both independent default-off gates without mutating module constants.
if (ROLE !== "on") {
  console.log(`\n=== TEMPLE LOOT GATE: ${ROLE} ===`);
  const cfg = SRV._templeStateForTest();
  SRV._templeSetLootRollsForTest([0, 0]);
  const r = await purge(W.off, 5, "off_gate_run_01");
  if (ROLE === "loot_off") {
    ok(cfg.on === true && cfg.lootOn === false, `Temple stays on while unset loot flag is off (${JSON.stringify(cfg)})`);
    ok(r.status === 200 && r.b.ok === true && r.b.chiki === 120, `legacy $CHIKI reply is unchanged (${r.status}, ${JSON.stringify(r.b)})`);
    ok(!Object.prototype.hasOwnProperty.call(r.b, "loot"), "default-off reply adds no loot contract fields");
    ok(ownFish(W.off, "golden_chikifish") === 0 && SRV._nftOwnerSetForTest(W.off).length === 0,
      "unset loot flag reaches neither fish credit nor egg issuance");
  } else {
    ok(cfg.on === false && cfg.lootOn === false, `loot cannot be live while the Purge gate is off (${JSON.stringify(cfg)})`);
    ok(r.status === 200 && r.b.ok === false && r.b.reason === "off" && r.b.chiki === 0,
      `Purge-off request is the existing zero-value reply (${r.status}, ${JSON.stringify(r.b)})`);
    ok(SRV._templeRowForTest(W.off) === null, "Purge-off request creates no receipt or daily row");
    ok(ownFish(W.off, "golden_chikifish") === 0 && SRV._nftOwnerSetForTest(W.off).length === 0,
      "Purge-off request reaches neither fish credit nor egg issuance");
  }
  console.log(`TEMPLE_LOOT_${ROLE.toUpperCase()}_DONE pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

console.log("\n=== WICKED TEMPLE LOOT ===");
const cfg = SRV._templeStateForTest();
ok(cfg.on === true && cfg.lootOn === true && cfg.rounds === 5 && cfg.per === 24,
  `both strict flags are live while shipped $CHIKI semantics remain 5 x 24 (${JSON.stringify(cfg)})`);

console.log("\n--- 1. exact deterministic 10,000-slot tables ---");
const tables = SRV._templeLootTablesForTest();
ok(tables.total === 10000, `roll domain is exactly ${tables.total}`);
ok(same(tables.outer.map((r) => r.weight), [6000, 2500, 800, 500, 200]),
  `outer weights are exact and ordered (${tables.outer.map((r) => r.weight).join("/")})`);
ok(tables.outer.reduce((n, r) => n + r.weight, 0) === 10000, "outer weights sum to exactly 10,000");
ok(same(tables.fish.map((r) => r.weight), [6700, 2300, 800, 200]),
  `fish weights are exact (${tables.fish.map((r) => r.weight).join("/")})`);
ok(tables.fish.reduce((n, r) => n + r.weight, 0) === 10000, "fish weights sum to exactly 10,000");

const outerCounts = Object.create(null);
for (let roll = 0; roll < 10000; roll++) {
  const key = SRV._templeLootPickForTest(roll, 0).rewardKey;
  outerCounts[key] = (outerCounts[key] || 0) + 1;
}
ok(same(outerCounts, { fantasy_fish: 6000, normal_egg: 2500, legendary_egg: 800, chikimount_egg: 500, meme_dynasty_egg: 200 }),
  `exhaustive outer distribution is exact (${JSON.stringify(outerCounts)})`);
const fishCounts = Object.create(null);
for (let roll = 0; roll < 10000; roll++) {
  const species = SRV._templeLootPickForTest(0, roll).species;
  fishCounts[species] = (fishCounts[species] || 0) + 1;
}
ok(same(fishCounts, { golden_chikifish: 6700, crystal_koi: 2300, mystic_eel: 800, rainbow_fish: 200 }),
  `exhaustive fish distribution is exact and has no Leviathan (${JSON.stringify(fishCounts)})`);
ok(!Object.keys(fishCounts).some((s) => s.toLowerCase().includes("leviathan")), "Leviathan is excluded from every fish slot");
ok(same([5999, 6000, 8499, 8500, 9299, 9300, 9799, 9800, 9999].map((r) => SRV._templeLootPickForTest(r, 0).rewardKey),
  ["fantasy_fish", "normal_egg", "normal_egg", "legendary_egg", "legendary_egg", "chikimount_egg", "chikimount_egg", "meme_dynasty_egg", "meme_dynasty_egg"]),
  "all outer half-open boundaries select the intended adjacent tiers");
ok(same([6699, 6700, 8999, 9000, 9799, 9800, 9999].map((r) => SRV._templeLootPickForTest(0, r).species),
  ["golden_chikifish", "crystal_koi", "crystal_koi", "mystic_eel", "mystic_eel", "rainbow_fish", "rainbow_fish"]),
  "all fish half-open boundaries select the intended adjacent species");
ok(throws(() => SRV._templeLootPickForTest(-1, 0)) && throws(() => SRV._templeLootPickForTest(10000, 0)) &&
   throws(() => SRV._templeLootPickForTest(0, 10000)) && throws(() => SRV._templeSetLootRollsForTest([1.5])),
  "invalid injected rolls fail closed instead of wrapping or clamping");

console.log("\n--- 2. durable loot requires wallet proof ---");
SRV._templeSetLootRollsForTest([9999]);
const unproven = await purgeUnproven(W.unproven, 5, "unproven_run_001");
ok(unproven.status === 200 && unproven.b.chiki === 120 && unproven.b.loot === null && unproven.b.lootReason === "identity_proof_required",
  `unproven 5/5 keeps legacy $CHIKI but receives no durable value (${JSON.stringify(unproven.b)})`);
ok(SRV._ownFor(W.unproven) === null && SRV._nftOwnerSetForTest(W.unproven).length === 0,
  "unproven request reaches neither fish credit nor egg issuance");
const unprovenReplay = await purgeUnproven(W.unproven, 5, "unproven_run_001");
ok(unprovenReplay.b.replay === true && unprovenReplay.b.lootReason === "identity_proof_required" && unprovenReplay.b.loot === null,
  "unproven no-loot result is receipted and idempotent before pace");
const signedProof = await purge(W.signed, 5, "signed_proof_run1");
ok(signedProof.b.loot?.rewardKey === "meme_dynasty_egg", "valid Ed25519 wallet signature unlocks the queued server roll");
const hiddenReplay = await purgeUnproven(W.signed, 5, "signed_proof_run1");
ok(hiddenReplay.b.replay === true && hiddenReplay.b.loot === null && hiddenReplay.b.lootReason === "identity_proof_required",
  "a receipt is not a bearer credential: unproven replay cannot retrieve a valuable grant card");
const signedReplay = await purge(W.signed, 5, "signed_proof_run1");
ok(signedReplay.b.replay === true && signedReplay.b.loot?.id === signedProof.b.loot.id,
  "proved replay still receives the exact original grant card/id");

const tokenAuth = signed(W.token);
const verified = await postPath("/verify", { wallet: W.token, netId: "temple_loot_token_01", ...tokenAuth });
ok(verified.status === 200 && typeof verified.b.mktToken === "string" && verified.b.mktToken.length > 0,
  "wallet verification issues a market token for the token-proof branch");
SRV._templeSetLootRollsForTest([0, 6700]);
const tokenProof = await post({ wallet: W.token, purified: 5, rounds: 5, runId: "token_proof_run01", mktToken: verified.b.mktToken });
ok(tokenProof.status === 200 && tokenProof.b.loot?.species === "crystal_koi" && ownFish(W.token, "crystal_koi") === 1,
  "valid market token alone authorizes exactly one forced fish grant");

console.log("\n--- 3. fish grant and receipt-before-pace replay ---");
SRV._templeSetLootRollsForTest([0, 0]);
const fish1 = await purge(W.fish, 5, "fish_run_000001");
ok(fish1.status === 200 && fish1.b.ok && fish1.b.chiki === 120 && !fish1.b.capped,
  `perfect victory preserves the shipped 120 $CHIKI result (${JSON.stringify(fish1.b)})`);
ok(fish1.b.loot?.type === "ffish" && fish1.b.loot?.species === "golden_chikifish" && fish1.b.loot?.qty === 1,
  `forced slot grants one authoritative Fantasy Fish (${JSON.stringify(fish1.b.loot)})`);
ok(ownFish(W.fish, "golden_chikifish") === 1, "fish grant reaches ownCredit(wallet,'ffish',species,1) exactly once");
const fishRow1 = SRV._templeRowForTest(W.fish);
const fishReplay = await purge(W.fish, 5, "fish_run_000001");
ok(fishReplay.status === 200 && fishReplay.b.replay === true && same(fishReplay.b.loot, fish1.b.loot),
  `same-run retry beats the pace gate and returns the same loot (${JSON.stringify(fishReplay.b)})`);
ok(ownFish(W.fish, "golden_chikifish") === 1 && same(SRV._templeRowForTest(W.fish), fishRow1),
  "retry neither credits a second fish nor increments runs/$CHIKI");
const mismatch = await purge(W.fish, 4, "fish_run_000001");
ok(mismatch.status === 409 && ownFish(W.fish, "golden_chikifish") === 1, "same runId with a different result is rejected without value");
SRV._templeSetLootRollsForTest([0, 0]);
const raced = await Promise.all([
  purge(W.race, 5, "same_run_race_001"), purge(W.race, 5, "same_run_race_001"),
]);
ok(raced.every((r) => r.status === 200) && raced.filter((r) => r.b.replay === true).length === 1 &&
   ownFish(W.race, "golden_chikifish") === 1,
  "two concurrent copies of one run serialize to one grant plus one replay");
SRV._templeDropDayRowForTest(W.race);
await SRV._saveTempleBookForTest();
await SRV._templeRestartDurableForTest();
const journalReplay = await purge(W.race, 5, "same_run_race_001");
ok(journalReplay.status === 200 && journalReplay.b.replay === true &&
   journalReplay.b.loot?.species === "golden_chikifish" && ownFish(W.race, "golden_chikifish") === 1,
  "the two-day run journal replays value after its daily counter row has rolled away");

console.log("\n--- 4. only a 5/5 victory may consume a roll ---");
SRV._templeSetLootRollsForTest([9999]);
const loss = await purge(W.defeat, 4, "defeat_run_0001");
ok(loss.status === 200 && loss.b.chiki === 96 && loss.b.loot === null && loss.b.lootReason === "victory_required",
  `4/5 defeat keeps its 4 x 24 $CHIKI but gets no chest (${JSON.stringify(loss.b)})`);
ok(SRV._nftOwnerSetForTest(W.defeat).length === 0 && SRV._ownFor(W.defeat) === null,
  "defeat reaches neither egg nor fish mutator");
SRV._templeClearGapForTest(W.defeat);
const afterLoss = await purge(W.defeat, 5, "after_loss_run_01");
ok(afterLoss.b.loot?.rewardKey === "meme_dynasty_egg" && afterLoss.b.loot?.kind === "meme",
  "the queued 9999 slot survived the defeat and is consumed only by the next flawless victory");
const eggCard = afterLoss.b.loot;
const eggRow = SRV._assetRowForTest(eggCard.id);
ok(eggCard.type === "egg" && eggCard.sp === "meme" && Number.isFinite(eggCard.born) && eggCard.readyAt > eggCard.born,
  `egg response is Profile.nft_receive-compatible (${JSON.stringify(eggCard)})`);
ok(eggRow?.origin === "issued" && eggRow?.kind === "meme" && eggRow?.sp === "meme" &&
   eggRow.chain.some((e) => e.what === "temple_reward" && e.runId === "after_loss_run_01"),
  "mintAsset egg row has issued origin and append-only temple_reward provenance");
const ownedBeforeEggReplay = SRV._nftOwnerSetForTest(W.defeat).slice();
const eggReplay = await purge(W.defeat, 5, "after_loss_run_01");
ok(eggReplay.b.replay === true && eggReplay.b.loot?.id === eggCard.id && same(SRV._nftOwnerSetForTest(W.defeat), ownedBeforeEggReplay),
  "egg retry returns the original id and never mints a second registry row");

console.log("\n--- 5. missing/rejected inputs cannot roll or grant ---");
SRV._templeSetLootRollsForTest([8500]);
const noId = await purge(W.missing, 5, undefined);
ok(noId.status === 200 && noId.b.chiki === 120 && noId.b.loot === null && noId.b.lootReason === "valid_run_id_required",
  `legacy request still earns $CHIKI but has no unreceipted loot (${JSON.stringify(noId.b)})`);
SRV._templeClearGapForTest(W.missing);
const afterNoId = await purge(W.missing, 5, "after_noid_run_1");
ok(afterNoId.b.loot?.rewardKey === "legendary_egg", "missing runId did not consume the queued legendary slot");
const invalidBefore = SRV._templeStateForTest().size;
const invalid = await purge(W.invalid, 5, "bad");
ok(invalid.status === 400 && SRV._templeRowForTest(W.invalid) === null && SRV._templeStateForTest().size === invalidBefore,
  "malformed runId is rejected before pace, book and grant state");
SRV._templeSetLootRollsForTest([9300]);
const wrongRounds = await purge(W.rejected, 5, "rejected_run_01", 4);
ok(wrongRounds.status === 400 && SRV._templeRowForTest(W.rejected) === null, "wrong-round request is rejected before creating a receipt");
const afterReject = await purge(W.rejected, 5, "rejected_run_01", 5);
ok(afterReject.b.loot?.rewardKey === "chikimount_egg", "rejected request did not consume the queued Chikimount Egg slot");

console.log("\n--- 6. capped results never grant ---");
for (let i = 1; i <= 2; i++) {
  SRV._templeClearGapForTest(W.capped); SRV._templeSetLootRollsForTest([0, i - 1]);
  await purge(W.capped, 5, `cap_paid_run_0${i}`);
}
const capFishBefore = [ownFish(W.capped, "golden_chikifish"), ownFish(W.capped, "crystal_koi")];
const capAssetsBefore = SRV._nftOwnerSetForTest(W.capped).length;
SRV._templeClearGapForTest(W.capped); SRV._templeSetLootRollsForTest([9999]);
const capped = await purge(W.capped, 5, "cap_zero_run_003");
ok(capped.b.capped === true && capped.b.chiki === 0 && capped.b.loot === null && capped.b.lootReason === "capped",
  `money-capped victory gets no loot (${JSON.stringify(capped.b)})`);
const capReplay = await purge(W.capped, 5, "cap_zero_run_003");
ok(capReplay.b.replay === true && capReplay.b.loot === null &&
   same(capFishBefore, [ownFish(W.capped, "golden_chikifish"), ownFish(W.capped, "crystal_koi")]) &&
   SRV._nftOwnerSetForTest(W.capped).length === capAssetsBefore,
  "capped receipt replays without any fish/egg mutation");

console.log("\n--- 7. daily-run ceiling cannot issue a victory chest ---");
for (let i = 1; i <= 6; i++) {
  SRV._templeClearGapForTest(W.daily);
  const r = await purge(W.daily, 0, `daily_loss_run_0${i}`);
  ok(r.b.loot === null && r.b.lootReason === "victory_required", `daily setup loss ${i}/6 carries no participation loot`);
}
const dailyAssetsBefore = SRV._nftOwnerSetForTest(W.daily).length;
SRV._templeClearGapForTest(W.daily); SRV._templeSetLootRollsForTest([9800]);
const dailyCap = await purge(W.daily, 5, "daily_cap_run_07");
ok(dailyCap.b.reason === "daily_runs" && dailyCap.b.capped === true && dailyCap.b.loot === null && dailyCap.b.lootReason === "capped" &&
   SRV._nftOwnerSetForTest(W.daily).length === dailyAssetsBefore,
  `seventh run cannot grant even when it reports a 5/5 victory (${JSON.stringify(dailyCap.b)})`);
const dailyCapReplay = await purge(W.daily, 5, "daily_cap_run_07");
ok(dailyCapReplay.b.replay === true && dailyCapReplay.b.reason === "daily_runs" && dailyCapReplay.b.loot === null,
  "daily-cap no-loot result is itself idempotent before the pace gate");
const dailyProbe = await purge(W.dailyProbe, 5, "daily_probe_run1");
ok(dailyProbe.b.loot?.rewardKey === "meme_dynasty_egg", "daily-cap request did not consume its queued 9800 roll");

console.log("\n--- 8. receipt persists with the Temple day-book ---");
await SRV._saveTempleBookForTest();
const snap = SRV._templeSnapshotForTest();
const persistedFish = snap.w.find((r) => r[0] === W.fish);
ok(Array.isArray(persistedFish?.[4]) && persistedFish[4][0]?.id === "fish_run_000001",
  "snapshot carries the bounded receipt beside the existing day/runs/chiki columns");
SRV._clearTempleBookForTest();
await SRV._bootRestoreTempleForTest();
const restored = await purge(W.defeat, 5, "after_loss_run_01");
ok(restored.b.replay === true && restored.b.loot?.id === eggCard.id && SRV._nftOwnerSetForTest(W.defeat).length === 1,
  "restored receipt replays the original egg id without a second grant");

console.log("\n--- 9. crash-durable prepare / entitlement / commit reconciliation ---");
SRV._templeSetLootRollsForTest([0, 0]);
SRV._templeSetCrashPointForTest("prepare");
const prepareCrash = await purge(W.crashPrepareFish, 5, "crash_prepare_fish_01");
ok(prepareCrash.status === 503 && ownFish(W.crashPrepareFish, "golden_chikifish") === 0 &&
   SRV._templeRowForTest(W.crashPrepareFish)?.receipts?.[0]?.grantState === "prepared",
  "crash after durable PREPARE returns no value and has not touched fish entitlement");
await SRV._templeRestartDurableForTest();
const prepareRetry = await purge(W.crashPrepareFish, 5, "crash_prepare_fish_01");
ok(prepareRetry.status === 200 && prepareRetry.b.replay === true &&
   prepareRetry.b.loot?.species === "golden_chikifish" && ownFish(W.crashPrepareFish, "golden_chikifish") === 1,
  "restored PREPARE resumes the fixed fish decision and commits exactly one entitlement");

SRV._templeSetLootRollsForTest([0, 6700]);
SRV._templeSetCrashPointForTest("entitlement");
const fishEntCrash = await purge(W.crashFish, 5, "crash_fish_ent_001");
ok(fishEntCrash.status === 503 && ownFish(W.crashFish, "crystal_koi") === 1 &&
   SRV._templeRowForTest(W.crashFish)?.receipts?.[0]?.grantState === "prepared",
  "fish entitlement is durable while its Temple receipt intentionally remains PREPARE");
await SRV._templeRestartDurableForTest();
const fishBeforeRetry = ownFish(W.crashFish, "crystal_koi");
const fishEntRetry = await purge(W.crashFish, 5, "crash_fish_ent_001");
ok(fishBeforeRetry === 1 && fishEntRetry.status === 200 && fishEntRetry.b.loot?.species === "crystal_koi" &&
   ownFish(W.crashFish, "crystal_koi") === 1,
  "restored own_book run marker reconciles a fish ghost window without double-crediting");

SRV._templeSetLootRollsForTest([8500]);
SRV._templeSetCrashPointForTest("entitlement");
const eggEntCrash = await purge(W.crashEgg, 5, "crash_egg_ent_0001");
const crashEggIds = SRV._nftOwnerSetForTest(W.crashEgg).slice();
ok(eggEntCrash.status === 503 && crashEggIds.length === 1 &&
   SRV._templeRowForTest(W.crashEgg)?.receipts?.[0]?.grantState === "prepared",
  "egg registry row is durable while its Temple receipt intentionally remains PREPARE");
await SRV._templeRestartDurableForTest();
const eggEntRetry = await purge(W.crashEgg, 5, "crash_egg_ent_0001");
ok(eggEntRetry.status === 200 && eggEntRetry.b.loot?.id === crashEggIds[0] &&
   same(SRV._nftOwnerSetForTest(W.crashEgg), crashEggIds),
  "restored temple_reward run marker reconciles the original egg id without a second mint");

SRV._templeSetLootRollsForTest([9300]);
SRV._templeSetCrashPointForTest("commit");
const commitCrash = await purge(W.crashCommitEgg, 5, "crash_commit_egg01");
const committedEggIds = SRV._nftOwnerSetForTest(W.crashCommitEgg).slice();
ok(commitCrash.status === 503 && committedEggIds.length === 1 &&
   !SRV._templeRowForTest(W.crashCommitEgg)?.receipts?.[0]?.grantState,
  "crash after committed receipt withholds the HTTP 200 even though both stores are durable");
await SRV._templeRestartDurableForTest();
const commitRetry = await purge(W.crashCommitEgg, 5, "crash_commit_egg01");
ok(commitRetry.status === 200 && commitRetry.b.replay === true && commitRetry.b.loot?.id === committedEggIds[0] &&
   same(SRV._nftOwnerSetForTest(W.crashCommitEgg), committedEggIds),
  "lost post-commit response replays the same durable egg and never grants twice");

console.log("\n--- 10. synchronous issuance refusal is receipted, never rerolled ---");
SRV._fillAssetRegForTest();
SRV._templeSetLootRollsForTest([9999]);
const failedIssue = await purge(W.failed, 5, "failed_mint_run1");
ok(failedIssue.status === 200 && failedIssue.b.chiki === 120 && failedIssue.b.loot === null && failedIssue.b.lootReason === "issuance_failed",
  `asset-registry refusal preserves $CHIKI but reports no granted egg (${JSON.stringify(failedIssue.b)})`);
const failedReplay = await purge(W.failed, 5, "failed_mint_run1");
ok(failedReplay.b.replay === true && failedReplay.b.loot === null && failedReplay.b.lootReason === "issuance_failed" &&
   SRV._nftOwnerSetForTest(W.failed).length === 0,
  "issuance failure is a durable no-loot result; retry cannot reroll into value");

console.log("\n--- 11. independent flag processes ---");
async function child(role) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [new URL(import.meta.url).pathname], {
      env: { ...process.env, TEMPLE_LOOT_ROLE: role }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    cp.stdout.on("data", (d) => { out += d; });
    cp.stderr.on("data", (d) => { out += d; });
    cp.on("exit", (code) => resolve({ code, out }));
  });
}
for (const role of ["loot_off", "temple_off"]) {
  const result = await child(role);
  console.log(result.out.split("\n").filter((line) => /^(  (ok|FAIL):|TEMPLE_LOOT_)/.test(line)).join("\n"));
  ok(result.code === 0, `${role} child proved its independent no-grant gate (exit ${result.code})`);
}

console.log(`\nTEMPLE_LOOT_DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
