// Chiki Monsters backend v2 — Postgres-backed, idempotent logged payouts.
// Holder verification + server-signed SOL payouts. Devnet-first; set DATABASE_URL for production.
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bs58 from "bs58";
import crypto from "node:crypto";   // built-in — used for Ed25519 chat-signature verification (no external dep)
import pg from "pg";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createCup } from "./cup-live.js";   // Chikoria Cup live orchestrator (double-elim, deterministic resolver)
import { createMatch as pvpCreate, submit as pvpSubmit, tick as pvpTick, viewFor as pvpView, forfeit as pvpForfeit, spectatorView as pvpSpectate } from "./pvp-engine.js";   // live PvP battles
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";   // $CHIKI quest-reward payouts ($CHIKI is TOKEN-2022 — the legacy program rejects its accounts with InvalidAccountData)

dotenv.config();
const {
  NETWORK = "devnet",
  RPC_URL,
  CHIKI_MINT,
  MIN_HOLD = "500000",
  MIN_HOLD_MINUTES = "0",          // anti-sybil: wallet must be "seen" this long before it can claim
  WHALE_MIN_HOLD = "800000",       // balance for the 2nd Chiki
  WHALE_HOLD_HOURS = "6",          // must hold >= WHALE_MIN_HOLD continuously this long to earn the 2nd Chiki
  VERIFY_HOLDERS = "false",
  TREASURY_SECRET,
  TEAM_WALLET = "",
  REWARD_RATE_PER_MIN = "0.0008",  // legacy; no longer used (earnings are now task/rarity-based)
  EARN_MULT = "1",                 // global multiplier on all task SOL payouts (tune to your fee budget)
  TASK_SECONDS = "45",             // avg seconds a Chiki takes per task (sets task throughput)
  ACCRUAL_CAP_MIN = "1440",        // max minutes of task earnings counted per claim (24h pouch cap)
  MAX_CLAIM_SOL = "1",             // per-claim ceiling — high enough that even a 2-Chiki full pouch isn't clipped (displayed pouch ≈ actual payout)
  DAILY_CAP_SOL = "1",             // absolute backstop ceiling (rarely binds; the real cap is DAILY_CAP_FRAC below)
  DAILY_CAP_FRAC = "1",            // NO daily cap on the reward pool (1 = up to the whole spendable pool/day) — the reserve floor is the only pool guard
  POOL_RESERVE_SOL = "0.05",       // never pay the treasury below this floor — the hard "never go into debt" guarantee
  POOL_REF_SOL = "20",             // reward reference: payout = base_table × (pool / POOL_REF). Higher = SMALLER payouts (longer runway). Lower = more generous.
  PER_WALLET_DAILY_SOL = "0.1",    // per-wallet cap per rolling 24h (0 = unlimited) — stops one wallet draining the pool
  CLAIM_COOLDOWN_SEC = "30",
  DATABASE_URL = "",
  ADMIN_KEY = "",                   // set this to enable /admin/reset (wipe test profiles)
  ADMIN_WALLETS = "",               // comma-separated wallet addresses allowed to PIN/announce in chat
  PORT = "8787",
} = process.env;

if (!RPC_URL || !TREASURY_SECRET) {
  console.error("✖ Missing RPC_URL or TREASURY_SECRET in .env"); process.exit(1);
}
const parseSecret = (s) => (s.trim().startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s.trim()));
const conn = new Connection(RPC_URL, "confirmed");
const treasury = Keypair.fromSecretKey(parseSecret(TREASURY_SECRET));
const MINT = CHIKI_MINT ? new PublicKey(CHIKI_MINT) : null;
const MIN = Number(MIN_HOLD), CAP = Number(MAX_CLAIM_SOL);
const COOLDOWN = Number(CLAIM_COOLDOWN_SEC) * 1000;
const HOLD_MS = Number(MIN_HOLD_MINUTES) * 60_000;
const DAILY_CAP = Number(DAILY_CAP_SOL);
const RESERVE = Number(POOL_RESERVE_SOL);
const POOL_REF = Math.max(0.000001, Number(POOL_REF_SOL));
const DAILY_FRAC = Math.min(1, Math.max(0, Number(DAILY_CAP_FRAC)));
// TRUE percentage-of-pool model: payout = base_table × (pool / POOL_REF).
// This is a pure fraction of the LIVE pool — it scales DOWN as the pool drains and UP as it refills (no stuck floor).
// Because every payout is read against the current pool and bounded by the RESERVE floor, the pool asymptotes toward
// the reserve but never crosses it: the treasury can never go into debt, and rewards self-correct without a fixed cap.
// RETUNE: cap the reward-scaling multiplier so a flush pool can't pay runaway amounts (sustainability + safety).
const POOL_FACTOR_MAX = Math.max(1, Number(process.env.POOL_FACTOR_MAX || 3));
const poolFactor = (pool) => Math.max(0, Math.min(POOL_FACTOR_MAX, (Number(pool) || 0) / POOL_REF));
const MULT = Number(EARN_MULT), TASK_SEC = Math.max(5, Number(TASK_SECONDS)), ACCRUAL_CAP = Number(ACCRUAL_CAP_MIN);
const WHALE_MIN = Number(WHALE_MIN_HOLD), WHALE_HOLD_MS = Number(WHALE_HOLD_HOURS) * 3600_000;
const CLAIM_TAX = Math.min(0.95, Math.max(0, Number(process.env.CLAIM_TAX_PCT || 20) / 100));   /* SOL claim tax — withheld from payout, stays in treasury (1% burn / 39% pool / 60% team bookkeeping) */
/* effective Chiki count: 1 if eligible holder; 2 only after holding >= WHALE_MIN continuously for WHALE_HOLD_MS */
function chikiCount(balance, whaleSince) {
  if (balance < MIN) return 0;
  if (balance >= WHALE_MIN && whaleSince && (Date.now() - Number(whaleSince)) >= WHALE_HOLD_MS) return 2;
  return 1;
}
/* server-authoritative, rarity-weighted earnings: each simulated task pays SOL by rarity.
   The server rolls the tasks itself (using on-chain Chiki count + elapsed time), so it can't be faked. */
const RARITY_SOL = { common:0.000008, uncommon:0.000016, rare:0.000036, epic:0.00008, mythic:0.0002, shiny:0.0004, legend:0.001 };  /* task rewards cut 60% across the board · NO daily pool cap · bounded by per-claim cap, per-wallet daily cap + reserve floor */
const RARITY_DIST = [["common",45],["uncommon",27],["rare",15],["epic",7],["mythic",3.5],["shiny",1.7],["legend",0.8]];
const RARITY_TOTAL = RARITY_DIST.reduce((s, r) => s + r[1], 0);
function rollRarity() {
  let x = Math.random() * RARITY_TOTAL;
  for (const [name, w] of RARITY_DIST) { x -= w; if (x <= 0) return name; }
  return "common";
}
/* DETERMINISTIC earnings: expected SOL per task (rarity-weighted average) × tasks.
   No per-call randomness, so the Chiki Pouch rises smoothly with time and the
   estimate matches the actual claim exactly (no jitter). */
const RARITY_EV = RARITY_DIST.reduce((s, [name, w]) => s + RARITY_SOL[name] * (w / RARITY_TOTAL), 0);
function simEarn(minutes, chikis) {
  const tasks = Math.min(4000, Math.floor((minutes * 60 / TASK_SEC) * Math.max(1, chikis)));
  return tasks * RARITY_EV * MULT;
}
/* ---- SEEDED deterministic earnings ----
   The exact same math runs on the client, so the rares a player SEES are the rares the
   server pays for. Cheat-proof: the sequence is seeded by wallet + last_claim (both server-known),
   not by anything the client reports. Each Chiki earns 1 "slot" every TASK_SEC seconds. */
function chikiHash(str){
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++){ h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function slotRarity(wallet, lastClaim, ci, slot){
  let x = chikiHash(wallet + "|" + lastClaim + "|" + ci + "|" + slot) * RARITY_TOTAL;
  for (const [name, w] of RARITY_DIST){ x -= w; if (x <= 0) return name; }
  return "common";
}
// Rewards are now QUEST-ONLY (paid as real $CHIKI via /quest/claim). The old time-based SOL
// accrual is disabled so there is no second, unearned reward path.
const REWARDS_QUEST_ONLY = String(process.env.REWARDS_QUEST_ONLY || "true").toLowerCase() === "true";
function seededEarn(wallet, lastClaim, chikis, minutes){
  if (REWARDS_QUEST_ONLY) return 0;
  const slots = Math.min(4000, Math.floor(minutes * 60 / TASK_SEC));
  let sol = 0;
  for (let ci = 0; ci < chikis; ci++) for (let s = 0; s < slots; s++) sol += RARITY_SOL[slotRarity(wallet, lastClaim, ci, s)];
  return sol * MULT;
}
const WALLET_DAILY = Number(PER_WALLET_DAILY_SOL);
// RETUNE: dust guard — a pure-accrual claim must clear this floor so a tiny claim never costs more in tx fee than it pays. Cup prizes are exempt.
const MIN_CLAIM = Math.max(0, Number(process.env.MIN_CLAIM_SOL || 0.001));
const verifyOn = String(VERIFY_HOLDERS).toLowerCase() === "true";

const isPubkey = (s) => { try { new PublicKey(s); return true; } catch { return false; } };
// world PRESENCE (cosmetic avatar + name) accepts a real pubkey OR a safe per-install id — presence is not identity; rewards/BR/cup stay pubkey+signature gated
const isPresenceId = (s) => typeof s === "string" && (isPubkey(s) || /^[A-Za-z0-9_-]{6,44}$/.test(s));

/* Prove the request really comes from the owner of `wallet`:
   the client signs "…wallet:<wallet>…ts:<ms>…" with their Phantom key; we verify it here.
   Stops anyone from CHATTING / PINNING as the team, rewards, or any other wallet they don't own. */
function verifyWalletSig(wallet, msg, sigB64) {
  try {
    if (!wallet || !msg || !sigB64) return false;
    const m = String(msg);
    if (!m.includes("wallet:" + wallet)) return false;            // signature must bind THIS wallet
    const tm = m.match(/ts:(\d+)/); if (!tm) return false;
    const ts = Number(tm[1]);
    if (Date.now() - ts > 24 * 3600 * 1000) return false;         // signed too long ago
    if (ts - Date.now() > 5 * 60 * 1000) return false;            // future-dated
    const sig = Buffer.from(String(sigB64), "base64");
    if (sig.length !== 64) return false;
    // verify the Ed25519 signature with Node's built-in crypto (wrap the raw 32-byte key in SPKI DER)
    const pub = Buffer.from(new PublicKey(wallet).toBytes());
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(m, "utf8"), key, sig);
  } catch (e) { return false; }
}

/* ----- anti-cheat / anti-XSS: clamp the client profile to legal values before storing ----- */
const MAX_LEVEL = 50, MAX_BR = 30;
const maxStamOf  = lv => 80 + lv * 12;
const foodMaxSec = lv => Math.round(30 + (Math.min(lv, MAX_LEVEL) - 1) / 49 * 690) * 60;
const xpNeed     = lv => Math.round(140 + (Math.max(1, lv) - 1) * 95 + Math.pow(Math.max(1, lv), 2) * 0.8);
// Fastest LEGITIMATE seconds to fill ONE level (offline work model: 32 XP/task · 72s/task · NO naps). This is an
// UPPER BOUND on any real XP rate — online play is slower and naps add more — so a genuine grinder is never
// clamped, but a client that injects/spams levels can't beat this real-time floor. ~94h cumulative to reach L50.
const brNeed     = br => Math.round(60 + (Math.max(1, br) - 1) * 45);   // battle-XP to the next Battle Rank (mirrors the client)
const minSecForLevel = lv => Math.ceil(xpNeed(Math.max(1, lv)) / 32) * 72;
// Min real seconds the server will allow per Battle-Rating point and per card-tier point. BR rises only by winning
// real (server-resolved) battles; card tiers cost skill points (from BR) + $CHIKI — both inherently slow, so these
// floors never clamp a genuine player but make injected/instant battle power impossible.
const BR_MIN_SEC   = Math.max(1, Number(process.env.BR_MIN_SEC   || 90));
const CARD_MIN_SEC = Math.max(1, Number(process.env.CARD_MIN_SEC || 60));
const legStamMax = lv => Math.round(120 + (Math.min(Math.max(lv, 1), MAX_LEVEL) - 1) / 49 * 780);
const stripTags  = s => String(s == null ? "" : s).replace(/[<>]/g, "");          // no HTML tags ⇒ no stored XSS
const clampNum   = (v, lo, hi, def) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };

// Returns a sanitized copy of the incoming profile, using the previously-stored one to block roll-backs / jumps.
function sanitizeProfile(prev, p, wallet) {
  const out = { ...p };
  const now = Date.now();
  const totalWins = winsOf(wallet);   // server-authoritative count of real battle wins (BR headroom)
  if (out.handle != null) out.handle = stripTags(out.handle).slice(0, 16);
  out.glory   = clampNum(out.glory, 0, 1e12, 0);
  out.renames = clampNum(out.renames, 0, 99, 0);
  const prevCh = (prev && Array.isArray(prev.chikis)) ? prev.chikis : [];
  // ===== ROSTER IS NEVER REDUCED: a wallet keeps every Chiki it has ever owned (by species),
  //       unless the player explicitly releases it. Incoming saves update existing Chikis and may
  //       ADD new species within the hatch caps, but can never drop a previously-owned one. =====
  const inc = Array.isArray(out.chikis) ? out.chikis : [];
  if (inc.length || prevCh.length) {
    const firstBySp = arr => { const m = new Map(); for (const c of arr) { const sp = clampNum(c.sp, 0, 20, 0)   /* 21-species dex: 0-14 classic + 15-20 Meme Dynasty */; if (!m.has(sp)) m.set(sp, c); } return m; };
    const incBySp = firstBySp(inc), prevBySp = firstBySp(prevCh);
    const order = [];
    for (const sp of prevBySp.keys()) order.push(sp);                          // 1) preserve EVERY previously-owned species first
    for (const sp of incBySp.keys()) if (!prevBySp.has(sp)) order.push(sp);    // 2) then any brand-new species the save added
    let normals = 0, legs = 0; const kept = [];
    for (const sp of order) {
      const ic = incBySp.get(sp), pc = prevBySp.get(sp) || {};
      const src = ic || pc;                                                    // prefer the incoming (latest) data; fall back to stored
      const isLegend = !!(src.isLegend || pc.isLegend);
      if (isLegend) { if (legs >= 1) continue; legs++; } else { if (normals >= 2) continue; normals++; }   // caps drop EXCESS NEW ones, never originals
      // ===== LEVEL: monotonic + TIME-GATED to the fastest legitimate grind rate (kills injected/instant levels) =====
      const prevLv = clampNum(pc.level, 1, MAX_LEVEL, 1);
      let lv = clampNum(src.level, 1, MAX_LEVEL, 1);
      let lvAt = Number(pc._lvlAt) || now;                 // server-set timestamp of when this Chiki reached prevLv
      if (pc.level == null) { lv = 1; lvAt = now; }        // a Chiki the server has NEVER seen starts the grind at L1 (admin gifts are pre-written to the stored profile, so they're not "new" here; admin wallets skip sanitize entirely)
      else if (lv > prevLv) {                              // a level INCREASE is only honored as fast as real time allows
        let allowed = prevLv, budget = Math.max(0, now - lvAt);
        while (allowed < lv && allowed < MAX_LEVEL) { const need = minSecForLevel(allowed) * 1000; if (budget < need) break; budget -= need; allowed++; }
        lv = Math.max(prevLv, Math.min(lv, allowed));
        if (lv > prevLv) lvAt = now - budget;              // carry leftover earned time so a legit grind isn't penalized
      } else { lv = Math.max(lv, prevLv); }                // monotonic — a Chiki's level never drops
      // ===== BR (battle rating): SERVER-AUTHORITATIVE — can only rise via REAL, server-resolved battle wins. =====
      // Existing BR is grandfathered (the first time we see this Chiki we snapshot the unconsumed win count as its
      // base), then every new server win grants exactly +1 BR of headroom. No client edit / idle / time-spam can move it.
      const brP = clampNum(pc.br, 1, MAX_BR, 1);
      let brF = clampNum(src.br, 1, MAX_BR, 1);
      let brAt = Number(pc._brAt) || now;
      let brWinBase = (pc._brWinBase != null) ? Number(pc._brWinBase) : totalWins;   // snapshot wins at the moment of grandfathering
      const winCeil = Math.min(MAX_BR, brP + Math.max(0, totalWins - brWinBase));     // grandfathered base + NEW real wins
      if (pc.br == null) { brF = 1; brAt = now; brWinBase = totalWins; }              // brand-new Chiki: BR starts at 1
      else if (brF > brP) {
        let allowed = brP, budget = Math.max(0, now - brAt);
        while (allowed < brF && allowed < MAX_BR && budget >= BR_MIN_SEC * 1000) { budget -= BR_MIN_SEC * 1000; allowed++; }
        brF = Math.max(brP, Math.min(brF, brP + 3, allowed, winCeil));    // +3/save cap · real-time floor · AND the real-win ceiling
        if (brF > brP) { brAt = now - budget; brWinBase += (brF - brP); } // consume the wins that were just spent on BR
      } else { brF = Math.max(brF, brP); }                                // monotonic
      // skillPts are granted +1 per BR level-up (and spent on upgrades) → can never exceed the BR levels earned
      const skF = Math.min(clampNum(src.skillPts, 0, 999, 0), Math.max(0, brF - 1));
      // battleXp is just the progress bar toward the next BR point — bound it so it can't be inflated
      const bxF = clampNum(src.battleXp, 0, brNeed(brF), 0);
      // ===== card tiers {slot:1..5}: new cards start at tier 1; the TOTAL tier sum is time-gated (upgrades cost BR + $CHIKI) =====
      const rawCT = (src.cardTier && typeof src.cardTier === "object" && !Array.isArray(src.cardTier)) ? src.cardTier
                  : ((pc.cardTier && typeof pc.cardTier === "object" && !Array.isArray(pc.cardTier)) ? pc.cardTier : null);
      const prevCT = (pc.cardTier && typeof pc.cardTier === "object" && !Array.isArray(pc.cardTier)) ? pc.cardTier : {};
      const prevSum = Object.keys(prevCT).reduce((s, k) => s + clampNum(prevCT[k], 1, 5, 1), 0);
      let ctF = null, reqSum = 0;
      if (rawCT) { ctF = {}; for (const k in rawCT) { const slot = k | 0; if (slot >= 0 && slot < 12) { ctF[slot] = clampNum(rawCT[k], 1, 5, 1); reqSum += ctF[slot]; } } }
      let ctAt = Number(pc._ctAt) || now;
      if (pc.cardTier == null) { ctAt = now; if (ctF) for (const k in ctF) ctF[k] = 1; }   // brand-new Chiki: every card starts at tier 1
      else if (ctF && reqSum > prevSum) {
        let allowedSum = prevSum, budget = Math.max(0, now - ctAt);
        while (allowedSum < reqSum && budget >= CARD_MIN_SEC * 1000) { budget -= CARD_MIN_SEC * 1000; allowedSum++; }
        if (reqSum > allowedSum) { ctF = { ...prevCT }; }                 // grew faster than legit → reject, keep previous tiers
        else { ctAt = now - budget; }                                     // accepted; carry leftover time
      }
      // deck size (number of arena skills) can only grow one card per CARD_MIN_SEC; new Chikis keep their starting deck (≤3)
      const prevSkills = Array.isArray(pc.arenaSkills) ? pc.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0)) : null;
      let skillsF = Array.isArray(src.arenaSkills) ? src.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0)) : prevSkills;
      let dkAt = Number(pc._dkAt) || now;
      if (prevSkills == null) { dkAt = now; if (skillsF && skillsF.length > 3) skillsF = skillsF.slice(0, 3); }
      else if (skillsF && skillsF.length > prevSkills.length) {
        const grew = Math.floor(Math.max(0, now - dkAt) / (CARD_MIN_SEC * 1000));
        if (skillsF.length - prevSkills.length > grew) skillsF = prevSkills;   // added cards faster than legit → keep previous deck
        else dkAt = now;
      }
      kept.push({
        sp, level: lv, isLegend, _lvlAt: lvAt, hungry: !!src.hungry, tending: !!src.tending,
        nick: src.nick != null ? stripTags(src.nick).slice(0, 16) : (pc.nick != null ? stripTags(pc.nick).slice(0, 16) : null),
        xp: clampNum(src.xp, 0, xpNeed(lv), 0),
        food: clampNum(src.food, 0, foodMaxSec(lv), 0),
        stamina: clampNum(src.stamina, 0, isLegend ? legStamMax(lv) : maxStamOf(lv), maxStamOf(lv)),
        tasksDone:   Math.max(clampNum(src.tasksDone, 0, 1e12, 0),  clampNum(pc.tasksDone, 0, 1e12, 0)),    // monotonic
        sleepCycles: Math.max(clampNum(src.sleepCycles, 0, 1e9, 0), clampNum(pc.sleepCycles, 0, 1e9, 0)),
        renames: clampNum(src.renames, 0, 9, 0),
        br: brF, _brAt: brAt, _brWinBase: brWinBase, _ctAt: ctAt, _dkAt: dkAt,
        battleXp: bxF,
        skillPts: skF,
        arenaSkills: skillsF,
        cardTier: ctF,
        arenaStam: src.arenaStam != null ? clampNum(src.arenaStam, 0, legStamMax(lv), legStamMax(lv))
                 : (pc.arenaStam != null ? clampNum(pc.arenaStam, 0, legStamMax(lv), legStamMax(lv)) : null),
        arenaSleepUntil: clampNum(src.arenaSleepUntil != null ? src.arenaSleepUntil : pc.arenaSleepUntil, 0, Date.now() + 24 * 3600 * 1000, 0),
        sleeping: !!src.sleeping,                                                                  // preserve nap state across the server round-trip
        sleepUntil: clampNum(src.sleepUntil != null ? src.sleepUntil : pc.sleepUntil, 0, Date.now() + 24 * 3600 * 1000, 0),   // ...so a refresh RESUMES the nap instead of restarting it
      });
    }
    out.chikis = kept;
  }
  return out;
}
const _lastSave = new Map();   // light per-wallet write throttle
const _lastChat = new Map();   // light per-wallet chat throttle

// Per-wallet $CHIKI balance — CACHED 30s so 500+ polling clients don't spam Helius (429s).
const _balCache = new Map();
async function chikiBalance(owner, strict = false) {
  if (!MINT) return 0;
  const c = _balCache.get(owner);
  if (c && Date.now() - c.t < 30000) return c.v;
  try {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: MINT });
    let b = 0; for (const { account } of r.value) b += account.data.parsed.info.tokenAmount.uiAmount || 0;
    _balCache.set(owner, { t: Date.now(), v: b });
    if (_balCache.size > 5000) _balCache.clear();   // simple bound
    return b;
  } catch (e) {
    if (c) return c.v;
    if (strict) throw e;   // eligibility gates must FAIL CLOSED (503), not read "holds zero"
    return 0;
  }
}
// Treasury (reward pool) SOL — CACHED 20s. Pool changes slowly; this kills the per-request getBalance spam.
let _poolCache = { t: 0, v: 0 };
const poolSol = async () => {
  if (_poolCache.t && Date.now() - _poolCache.t < 20000) return _poolCache.v;
  const v = (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
  _poolCache = { t: Date.now(), v };
  return v;
};

/* ----------------------------- storage ----------------------------- */
// Two backends with one interface. Postgres when DATABASE_URL is set; else in-memory (dev only).
function makeStore() {
  if (DATABASE_URL) return pgStore();
  console.warn("⚠ No DATABASE_URL — using IN-MEMORY store (state is lost on restart; NOT for mainnet).");
  return memStore();
}

// ---- quest winner state helpers (admin-gated reward campaign) ----
function _advSub(s){ let h=0; for(let i=0;i<String(s).length;i++){ h=(h*31 + String(s).charCodeAt(i))|0; } return h; }
const _memWinners = new Map();   // memStore only: wallet -> {wallet,rank,won_at,balance_at_win,paid,payout_sig,payout_at}
const _memQR = new Map();         // memStore only: wallet -> {wallet,done_mask,paid_amount,payout_sig,payout_at,payout_lvbh,payout_amount}
let _memWLock = Promise.resolve();
function _memWith(fn){ const r=_memWLock.then(fn,fn); _memWLock=r.catch(()=>{}); return r; }

function pgStore() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS players(
          wallet TEXT PRIMARY KEY,
          first_seen BIGINT NOT NULL,
          last_claim BIGINT NOT NULL DEFAULT 0,
          lifetime_paid DOUBLE PRECISION NOT NULL DEFAULT 0,
          eligible BOOLEAN NOT NULL DEFAULT false,
          balance DOUBLE PRECISION NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS payouts(
          id BIGSERIAL PRIMARY KEY,
          wallet TEXT NOT NULL,
          amount DOUBLE PRECISION NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          signature TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS profile JSONB`);
      await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS whale_since BIGINT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS presence(
        wallet TEXT PRIMARY KEY, last_active BIGINT NOT NULL, chikis INT NOT NULL DEFAULT 1)`);
      await pool.query(`ALTER TABLE presence ADD COLUMN IF NOT EXISTS roster JSONB`);
      await pool.query(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v JSONB)`);   // small durable key/value (Cup prize ledger, flags)
      await pool.query(`CREATE TABLE IF NOT EXISTS quest_winners(
        wallet TEXT PRIMARY KEY,
        rank INT UNIQUE NOT NULL,
        won_at BIGINT NOT NULL,
        balance_at_win DOUBLE PRECISION NOT NULL DEFAULT 0,
        paid BOOLEAN NOT NULL DEFAULT false,
        payout_sig TEXT,
        payout_at BIGINT,
        payout_lvbh BIGINT
      )`);
      await pool.query(`ALTER TABLE quest_winners ADD COLUMN IF NOT EXISTS payout_lvbh BIGINT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS quest_rewards(
        wallet TEXT PRIMARY KEY,
        done_mask BIGINT NOT NULL DEFAULT 0,
        paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        payout_sig TEXT, payout_at BIGINT, payout_lvbh BIGINT, payout_amount DOUBLE PRECISION
      )`);
      // 63-chapter masks use bits up to 62 — widen a legacy INT column in place (values keep
      // their bit positions). Guarded so the rewrite only ever runs once.
      const dmType = await pool.query(`SELECT data_type FROM information_schema.columns
        WHERE table_name='quest_rewards' AND column_name='done_mask'`);
      if (dmType.rows[0] && dmType.rows[0].data_type === "integer")
        await pool.query(`ALTER TABLE quest_rewards ALTER COLUMN done_mask TYPE BIGINT`);
    },
    async kvGet(k) { const r = await pool.query(`SELECT v FROM kv WHERE k=$1`, [k]); return r.rows[0]?.v ?? null; },
    async kvSet(k, v) { await pool.query(`INSERT INTO kv(k,v) VALUES($1,$2::jsonb) ON CONFLICT(k) DO UPDATE SET v=$2::jsonb`, [k, JSON.stringify(v)]); },
    async firstSeen(wallet) { const r = await pool.query(`SELECT first_seen FROM players WHERE wallet=$1`, [wallet]); return r.rows[0] ? Number(r.rows[0].first_seen) : 0; },
    async winnersRemaining(cap) { const n = Number((await pool.query(`SELECT COUNT(*)::int n FROM quest_winners`)).rows[0].n); return Math.max(0, cap - n); },
    async winnerGet(wallet) { const r = await pool.query(`SELECT wallet,rank,won_at,balance_at_win,paid,payout_sig FROM quest_winners WHERE wallet=$1`, [wallet]); return r.rows[0] || null; },
    async winnersList() { const r = await pool.query(`SELECT wallet,rank,won_at,balance_at_win,paid,payout_sig FROM quest_winners ORDER BY rank ASC`); return r.rows; },
    async winnersUnpaid(limit) { const r = await pool.query(`SELECT wallet,rank,payout_sig,payout_at FROM quest_winners WHERE paid=false ORDER BY rank ASC LIMIT $1`, [Math.max(1, limit|0)]); return r.rows; },
    // ATOMIC winner-slot reservation — cross-instance safe (transaction-scoped advisory lock + unique wallet + cap check).
    async reserveWinner(wallet, cap, balance, now) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock($1)", [4210001]);
        const ex = await c.query("SELECT rank FROM quest_winners WHERE wallet=$1", [wallet]);
        if (ex.rows[0]) { await c.query("COMMIT"); return { won: true, already: true, rank: Number(ex.rows[0].rank) }; }
        const cnt = Number((await c.query("SELECT COUNT(*)::int n FROM quest_winners")).rows[0].n);
        if (cnt >= cap) { await c.query("COMMIT"); return { won: false, rank: 0 }; }
        const rank = cnt + 1;
        await c.query("INSERT INTO quest_winners(wallet,rank,won_at,balance_at_win) VALUES($1,$2,$3::bigint,$4)", [wallet, rank, now, balance]);
        await c.query("COMMIT");
        return { won: true, rank };
      } catch (e) { try { await c.query("ROLLBACK"); } catch (_) {} throw e; }
      finally { c.release(); }
    },
    // Serialized per-wallet payout gate. Marks an in-flight attempt (payout_at) so a concurrent/retried call
    // returns 'inflight' within the ~2min tx-expiry window; only proceeds once any prior tx has surely expired.
    async payoutBegin(wallet) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock($1,$2)", [4210002, _advSub(wallet)]);
        const r = await c.query("SELECT paid,payout_sig,payout_at,payout_lvbh FROM quest_winners WHERE wallet=$1 FOR UPDATE", [wallet]);
        const row = r.rows[0];
        if (!row) { await c.query("COMMIT"); return { state: "notwinner" }; }
        if (row.paid) { await c.query("COMMIT"); return { state: "already", sig: row.payout_sig }; }
        const now = Date.now(); const pat = row.payout_at ? Number(row.payout_at) : 0;
        if (pat && now - pat < 120000) { await c.query("COMMIT"); return { state: "inflight", sig: row.payout_sig, priorAt: pat }; }
        await c.query("UPDATE quest_winners SET payout_at=$2::bigint WHERE wallet=$1", [wallet, now]);
        await c.query("COMMIT");
        return { state: "proceed", priorSig: row.payout_sig || null, priorAt: pat, priorLvbh: row.payout_lvbh ? Number(row.payout_lvbh) : 0 };
      } catch (e) { try { await c.query("ROLLBACK"); } catch (_) {} throw e; }
      finally { c.release(); }
    },
    async payoutRecordSig(wallet, sig, lvbh, now) { await pool.query(`UPDATE quest_winners SET payout_sig=$2, payout_lvbh=$3::bigint, payout_at=$4::bigint WHERE wallet=$1 AND paid=false`, [wallet, sig, Math.floor(Number(lvbh) || 0), now]); },
    async payoutConfirm(wallet, sig) { await pool.query(`UPDATE quest_winners SET paid=true, payout_sig=$2 WHERE wallet=$1`, [wallet, sig]); },
    async payoutClear(wallet) { await pool.query(`UPDATE quest_winners SET payout_at=0, payout_sig=NULL, payout_lvbh=0 WHERE wallet=$1 AND paid=false`, [wallet]); },
    // ---- per-quest reward pouch: idempotent accrual (done_mask bit-OR) + variable-amount admin payout ----
    async qrAccrue(wallet, bit) { await pool.query(`INSERT INTO quest_rewards(wallet,done_mask) VALUES($1,$2::bigint) ON CONFLICT(wallet) DO UPDATE SET done_mask = quest_rewards.done_mask | $2::bigint`, [wallet, questMask(bit).toString()]); },
    async qrGet(wallet) { const r = await pool.query(`SELECT wallet,done_mask,paid_amount,payout_sig,payout_at,payout_lvbh,payout_amount FROM quest_rewards WHERE wallet=$1`, [wallet]); return r.rows[0] || null; },
    async qrList(limit) { const r = await pool.query(`SELECT wallet,done_mask,paid_amount FROM quest_rewards WHERE done_mask > 0 ORDER BY wallet LIMIT $1`, [Math.max(1, limit|0)]); return r.rows; },
    async qrPayoutBegin(wallet) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock($1,$2)", [4210003, _advSub(wallet)]);
        const r = await c.query("SELECT done_mask,paid_amount,payout_sig,payout_at,payout_lvbh,payout_amount FROM quest_rewards WHERE wallet=$1 FOR UPDATE", [wallet]);
        const row = r.rows[0];
        if (!row) { await c.query("COMMIT"); return { state: "none" }; }
        const now = Date.now(); const pat = Number(row.payout_at) || 0;
        if (pat && now - pat < 120000 && row.payout_sig) { await c.query("COMMIT"); return { state: "inflight", sig: row.payout_sig }; }
        await c.query("UPDATE quest_rewards SET payout_at=$2::bigint WHERE wallet=$1", [wallet, now]);
        await c.query("COMMIT");
        return { state: "proceed", doneMask: String(row.done_mask || 0), paidAmount: Number(row.paid_amount)||0,
                 priorSig: row.payout_sig||null, priorAt: pat, priorLvbh: row.payout_lvbh?Number(row.payout_lvbh):0, priorAmount: Number(row.payout_amount)||0 };
      } catch (e) { try { await c.query("ROLLBACK"); } catch(_){} throw e; } finally { c.release(); }
    },
    async qrPayoutRecordSig(wallet, sig, lvbh, amount, now) { await pool.query(`UPDATE quest_rewards SET payout_sig=$2, payout_lvbh=$3::bigint, payout_amount=$4, payout_at=$5::bigint WHERE wallet=$1`, [wallet, sig, Math.floor(Number(lvbh)||0), amount, now]); },
    async qrPayoutConfirm(wallet, amount) { await pool.query(`UPDATE quest_rewards SET paid_amount = paid_amount + COALESCE(payout_amount, $2), payout_sig=NULL, payout_lvbh=0, payout_amount=NULL, payout_at=0 WHERE wallet=$1 AND (payout_sig IS NOT NULL OR payout_at <> 0)`, [wallet, amount]); },
    async qrPayoutClear(wallet) { await pool.query(`UPDATE quest_rewards SET payout_sig=NULL, payout_lvbh=0, payout_amount=NULL, payout_at=0 WHERE wallet=$1`, [wallet]); },
    async heartbeat(wallet, chikis, roster) {
      await pool.query(
        `INSERT INTO presence(wallet,last_active,chikis,roster) VALUES($1,$2::bigint,$3,$4::jsonb)
         ON CONFLICT(wallet) DO UPDATE SET last_active=$2::bigint, chikis=$3, roster=$4::jsonb`,
        [wallet, Date.now(), Math.max(0, chikis | 0), JSON.stringify(Array.isArray(roster) ? roster.slice(0, 8) : [])]);
    },
    async presence(windowMs) {
      const r = await pool.query(
        `SELECT COUNT(*)::int a, COALESCE(SUM(chikis),0)::int c FROM presence WHERE last_active > $1`,
        [Date.now() - windowMs]);
      return { activeUsers: r.rows[0].a, chikimons: r.rows[0].c };
    },
    async resetProfiles() {
      const r = await pool.query(`UPDATE players SET profile=NULL WHERE profile IS NOT NULL`);
      await pool.query(`DELETE FROM presence`);
      return r.rowCount || 0;
    },
    async world(windowMs, exclude, cap) {
      const r = await pool.query(
        `SELECT wallet, roster FROM presence WHERE last_active > $1 AND wallet <> $2 ORDER BY last_active DESC`,
        [Date.now() - windowMs, exclude || ""]);
      const out = [];
      for (const row of r.rows) for (const e of (row.roster || [])) {
        out.push({ wallet: row.wallet, sp: e.sp | 0, level: e.level | 0 });
        if (out.length >= cap) return out;
      }
      return out;
    },
    async getProfile(wallet) {
      const r = await pool.query(`SELECT profile FROM players WHERE wallet=$1`, [wallet]);
      return r.rows[0]?.profile || null;
    },
    async setProfile(wallet, profile) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO players(wallet,first_seen,last_claim,profile)
         VALUES($1,$2::bigint,$3::bigint,$4::jsonb)
         ON CONFLICT(wallet) DO UPDATE SET profile=$4::jsonb`,
        [wallet, now, now - 60000, JSON.stringify(profile)]);
    },
    async touch(wallet, eligible, balance) {
      const now = Date.now();
      const ws = balance >= WHALE_MIN ? now : null;
      const r = await pool.query(
        `INSERT INTO players(wallet,first_seen,last_claim,eligible,balance,whale_since)
         VALUES($1,$2::bigint,$3::bigint,$4,$5,$6::bigint)
         ON CONFLICT(wallet) DO UPDATE SET eligible=$4, balance=$5,
           whale_since = CASE WHEN $5 < ${WHALE_MIN} THEN NULL
                              WHEN players.whale_since IS NULL THEN $2::bigint
                              ELSE players.whale_since END
         RETURNING *`, [wallet, now, now - 60000, eligible, balance, ws]);
      return r.rows[0];
    },
    async dailyTotal() {
      const r = await pool.query(
        `SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status='confirmed' AND created_at > now()-interval '1 day'`);
      return Number(r.rows[0].s);
    },
    async walletDaily(wallet) {
      const r = await pool.query(
        `SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE wallet=$1 AND status='confirmed' AND created_at > now()-interval '1 day'`, [wallet]);
      return Number(r.rows[0].s);
    },
    async earned(wallet) {
      const r = await pool.query(`SELECT COALESCE(lifetime_paid,0) p FROM players WHERE wallet=$1`, [wallet]);
      return Number(r.rows[0]?.p || 0);   // real SOL actually paid out to this wallet
    },
    async topEarners(limit) {
      const r = await pool.query(`SELECT wallet, COALESCE(lifetime_paid,0) p, profile->>'handle' AS handle FROM players WHERE lifetime_paid > 0 ORDER BY lifetime_paid DESC LIMIT $1`, [limit]);
      return r.rows.map(x => ({ wallet: x.wallet, earnedSol: Number(x.p), handle: x.handle || null }));
    },
    async totalPaid() {   // ALL-TIME SOL paid out to keepers (sum of every wallet's lifetime payouts)
      const r = await pool.query(`SELECT COALESCE(SUM(lifetime_paid),0) p FROM players`);
      return Number(r.rows[0]?.p || 0);
    },
    async chikisForWallets(wallets) {   // total Chikis owned in-game by a given set of wallets (the real keepers)
      if (!wallets || !wallets.length) return 0;
      const r = await pool.query(`SELECT COALESCE(SUM(jsonb_array_length(profile->'chikis')),0) c FROM players WHERE wallet = ANY($1) AND jsonb_typeof(profile->'chikis')='array'`, [wallets]);
      return Number(r.rows[0]?.c || 0);
    },
    // Atomically reserve a claim: row lock, cooldown + hold-time + amount check, advance last_claim, log pending payout.
    async reserve(wallet, now, compute) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`INSERT INTO players(wallet,first_seen,last_claim) VALUES($1,$2::bigint,$3::bigint) ON CONFLICT(wallet) DO NOTHING`, [wallet, now, now - 60000]);
        const { rows } = await c.query(`SELECT * FROM players WHERE wallet=$1 FOR UPDATE`, [wallet]);
        const p = rows[0];
        if (now - Number(p.last_claim) < COOLDOWN) { await c.query("ROLLBACK"); return { status: "cooldown", retryInMs: COOLDOWN - (now - Number(p.last_claim)) }; }
        if (now - Number(p.first_seen) < HOLD_MS) { await c.query("ROLLBACK"); return { status: "hold", waitMs: HOLD_MS - (now - Number(p.first_seen)) }; }
        const r = await compute(p);
        if (!(r.paid > 0)) { await c.query("ROLLBACK"); return { status: "none" }; }
        const prev = Number(p.last_claim);
        // Advance last_claim ONLY by the fraction of the pouch actually paid, so a capped claim keeps the remainder.
        const remainMs = r.grossNet > 0 ? Math.round(r.capMs * Math.max(0, 1 - r.paid / r.grossNet)) : 0;
        let newLast = now - remainMs; if (newLast < prev) newLast = prev; if (newLast > now) newLast = now;
        await c.query(`UPDATE players SET last_claim=$2, lifetime_paid=lifetime_paid+$3 WHERE wallet=$1`, [wallet, newLast, r.paid]);
        const ins = await c.query(`INSERT INTO payouts(wallet,amount,status) VALUES($1,$2,'pending') RETURNING id`, [wallet, r.paid]);
        await c.query("COMMIT");
        return { status: "ok", amount: r.paid, payoutId: ins.rows[0].id, prevLastClaim: prev };
      } catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; }
      finally { c.release(); }
    },
    async confirm(id, sig) { await pool.query(`UPDATE payouts SET status='confirmed', signature=$2 WHERE id=$1`, [id, sig]); },
    async fail(id, wallet, prevLastClaim, amount) {
      await pool.query(`UPDATE payouts SET status='failed' WHERE id=$1`, [id]);
      await pool.query(`UPDATE players SET last_claim=$2, lifetime_paid=GREATEST(0,lifetime_paid-$3) WHERE wallet=$1`, [wallet, prevLastClaim, amount]);
    },
    async count() { return Number((await pool.query(`SELECT COUNT(*) n FROM players`)).rows[0].n); },
    async allChikis(exclude, cap) {
      // bounded scan — only pull enough rows to fill the cap (avoids loading ALL profiles into memory each call)
      const r = await pool.query(`SELECT wallet, profile FROM players WHERE profile IS NOT NULL ORDER BY last_claim DESC LIMIT $1`, [Math.max(20, Math.min(300, (cap||60) * 3))]);
      const out = [];
      for (const row of r.rows) {
        if (row.wallet === exclude) continue;
        const pr = row.profile || {}, handle = pr.handle || null, bal = pr.bal || 0;
        for (const c of (pr.chikis || [])) {
          out.push({ wallet: row.wallet, handle, bal, sp: c.sp | 0, level: c.level | 0, nick: c.nick || null, tasksDone: c.tasksDone | 0, hungry: !!c.hungry, isLegend: !!c.isLegend });
          if (out.length >= cap) return out;
        }
      }
      return out;
    },
    async claimedTotals() {
      // Keepers + active Chikis = CURRENT eligible holders only (a wallet's last-known balance ≥ threshold);
      // legends = all-time hatched. This stops counting wallets that hatched a Chiki once and have since left.
      const r = await pool.query(`SELECT profile, eligible FROM players WHERE profile IS NOT NULL`);
      let chikis = 0, holders = 0, legends = 0;
      for (const row of r.rows) {
        const c = row.profile?.chikis || []; if (!c.length) continue;
        legends += c.filter(x => x.isLegend).length;
        if (row.eligible) { holders++; chikis += c.length; }
      }
      return { chikis, holders, legends };
    },
    // Wallets whose roster contains a Legendary (for Glory gifts).
    async legendHolderWallets() {
      const r = await pool.query(`SELECT wallet FROM players WHERE profile IS NOT NULL AND profile->'chikis' @> '[{"isLegend": true}]'::jsonb`);
      return r.rows.map(x => x.wallet);
    },
  };
}

function memStore() {
  const players = new Map(); const payouts = []; const presenceMap = new Map(); const kv = new Map();
  const get = (w) => players.get(w);
  return {
    kind: "memory",
    async init() {},
    async kvGet(k) { return kv.has(k) ? kv.get(k) : null; },
    async kvSet(k, v) { kv.set(k, v); },
    async firstSeen(wallet) { return Number(get(wallet)?.first_seen || 0); },
    async winnersRemaining(cap) { return Math.max(0, cap - _memWinners.size); },
    async winnerGet(wallet) { return _memWinners.get(wallet) || null; },
    async winnersList() { return [..._memWinners.values()].sort((a,b)=>a.rank-b.rank); },
    async winnersUnpaid(limit) { return [..._memWinners.values()].filter(r=>!r.paid).sort((a,b)=>a.rank-b.rank).slice(0, Math.max(1,limit|0)); },
    async reserveWinner(wallet, cap, balance, now) { return _memWith(async()=>{
      const ex=_memWinners.get(wallet); if(ex) return {won:true,already:true,rank:ex.rank};
      if(_memWinners.size>=cap) return {won:false,rank:0};
      const rank=_memWinners.size+1; _memWinners.set(wallet,{wallet,rank,won_at:now,balance_at_win:balance,paid:false,payout_sig:null,payout_at:0,payout_lvbh:0}); return {won:true,rank}; }); },
    async payoutBegin(wallet) { return _memWith(async()=>{
      const r=_memWinners.get(wallet); if(!r) return {state:"notwinner"};
      if(r.paid) return {state:"already",sig:r.payout_sig};
      const now=Date.now(); const pat=r.payout_at||0;
      if(pat && now-pat<120000) return {state:"inflight",sig:r.payout_sig,priorAt:pat};
      const prior={priorSig:r.payout_sig||null,priorAt:pat,priorLvbh:r.payout_lvbh||0}; r.payout_at=now; return {state:"proceed",...prior}; }); },
    async payoutRecordSig(wallet, sig, lvbh, now) { const r=_memWinners.get(wallet); if(r&&!r.paid){ r.payout_sig=sig; r.payout_lvbh=lvbh||0; r.payout_at=now; } },
    async payoutConfirm(wallet, sig) { const r=_memWinners.get(wallet); if(r){ r.paid=true; r.payout_sig=sig; } },
    async payoutClear(wallet) { const r=_memWinners.get(wallet); if(r&&!r.paid){ r.payout_at=0; r.payout_sig=null; r.payout_lvbh=0; } },
    async qrAccrue(wallet, bit) { const r=_memQR.get(wallet)||{wallet,done_mask:0n,paid_amount:0,payout_sig:null,payout_at:0,payout_lvbh:0,payout_amount:0}; r.done_mask=questMask(r.done_mask)|questMask(bit); _memQR.set(wallet,r); },
    async qrGet(wallet) { return _memQR.get(wallet)||null; },
    async qrList(limit) { return [..._memQR.values()].filter(r=>r.done_mask>0).slice(0,Math.max(1,limit|0)); },
    async qrPayoutBegin(wallet) { return _memWith(async()=>{ const r=_memQR.get(wallet); if(!r) return {state:"none"};
      const now=Date.now(), pat=r.payout_at||0; if(pat && now-pat<120000 && r.payout_sig) return {state:"inflight",sig:r.payout_sig};
      const prior={priorSig:r.payout_sig||null,priorAt:pat,priorLvbh:r.payout_lvbh||0,priorAmount:r.payout_amount||0}; r.payout_at=now;
      return {state:"proceed",doneMask:String(r.done_mask||0),paidAmount:r.paid_amount||0,...prior}; }); },
    async qrPayoutRecordSig(wallet, sig, lvbh, amount, now) { const r=_memQR.get(wallet); if(r){ r.payout_sig=sig; r.payout_lvbh=lvbh||0; r.payout_amount=amount; r.payout_at=now; } },
    async qrPayoutConfirm(wallet, amount) { const r=_memQR.get(wallet); if(r && (r.payout_sig || r.payout_at)){ r.paid_amount=(r.paid_amount||0)+((r.payout_amount||0)>=1?r.payout_amount:amount); r.payout_sig=null; r.payout_lvbh=0; r.payout_amount=0; r.payout_at=0; } },
    async qrPayoutClear(wallet) { const r=_memQR.get(wallet); if(r){ r.payout_sig=null; r.payout_lvbh=0; r.payout_amount=0; r.payout_at=0; } },
    async touch(wallet, eligible, balance) {
      const now = Date.now();
      const p = get(wallet) || { wallet, first_seen: now, last_claim: now - 60000, lifetime_paid: 0, profile: null };
      p.eligible = eligible; p.balance = balance;
      if (balance < WHALE_MIN) p.whale_since = null; else if (!p.whale_since) p.whale_since = now;
      players.set(wallet, p); return p;
    },
    async getProfile(wallet) { return get(wallet)?.profile || null; },
    async setProfile(wallet, profile) {
      const now = Date.now();
      const p = get(wallet) || { wallet, first_seen: now, last_claim: now - 60000, lifetime_paid: 0 };
      p.profile = profile; players.set(wallet, p);
    },
    async resetProfiles() { let n = 0; for (const p of players.values()) if (p.profile) { p.profile = null; n++; } presenceMap.clear(); return n; },
    async heartbeat(wallet, chikis, roster) { presenceMap.set(wallet, { t: Date.now(), chikis: Math.max(0, chikis | 0), roster: Array.isArray(roster) ? roster.slice(0, 8) : [] }); },
    async presence(windowMs) {
      const cut = Date.now() - windowMs; let a = 0, c = 0;
      for (const v of presenceMap.values()) if (v.t > cut) { a++; c += v.chikis; }
      return { activeUsers: a, chikimons: c };
    },
    async world(windowMs, exclude, cap) {
      const cut = Date.now() - windowMs; const out = [];
      for (const [wallet, v] of presenceMap) {
        if (v.t <= cut || wallet === exclude) continue;
        for (const e of (v.roster || [])) { out.push({ wallet, sp: e.sp | 0, level: e.level | 0 }); if (out.length >= cap) return out; }
      }
      return out;
    },
    async dailyTotal() {
      const cut = Date.now() - 86_400_000;
      return payouts.filter(x => x.status === "confirmed" && x.t > cut).reduce((s, x) => s + x.amount, 0);
    },
    async walletDaily(wallet) {
      const cut = Date.now() - 86_400_000;
      return payouts.filter(x => x.status === "confirmed" && x.wallet === wallet && x.t > cut).reduce((s, x) => s + x.amount, 0);
    },
    async earned(wallet) { return Number(get(wallet)?.lifetime_paid || 0); },   // real SOL actually paid out to this wallet
    async totalPaid() { let s = 0; for (const p of players.values()) s += Number(p.lifetime_paid || 0); return s; },
    async chikisForWallets(wallets) { const set = new Set(wallets || []); let c = 0; for (const [w, p] of players) { if (set.has(w)) { const ch = p.profile?.chikis; if (Array.isArray(ch)) c += ch.length; } } return c; },
    async topEarners(limit) {
      const arr = [];
      for (const [wallet, p] of players) { const e = Number(p.lifetime_paid || 0); if (e > 0) arr.push({ wallet, earnedSol: e, handle: p.profile?.handle || null }); }
      arr.sort((a, b) => b.earnedSol - a.earnedSol);
      return arr.slice(0, limit);
    },
    async reserve(wallet, now, compute) {
      const p = get(wallet) || { wallet, first_seen: now, last_claim: now - 60000, lifetime_paid: 0 };
      players.set(wallet, p);
      if (now - p.last_claim < COOLDOWN) return { status: "cooldown", retryInMs: COOLDOWN - (now - p.last_claim) };
      if (now - p.first_seen < HOLD_MS) return { status: "hold", waitMs: HOLD_MS - (now - p.first_seen) };
      const r = await compute(p);
      if (!(r.paid > 0)) return { status: "none" };
      const prev = p.last_claim;
      // Advance last_claim ONLY by the fraction actually paid — a capped claim keeps the remainder in the pouch.
      const remainMs = r.grossNet > 0 ? Math.round(r.capMs * Math.max(0, 1 - r.paid / r.grossNet)) : 0;
      let newLast = now - remainMs; if (newLast < prev) newLast = prev; if (newLast > now) newLast = now;
      p.last_claim = newLast; p.lifetime_paid += r.paid;
      const id = payouts.push({ id: payouts.length + 1, wallet, amount: r.paid, status: "pending", t: now });
      return { status: "ok", amount: r.paid, payoutId: id, prevLastClaim: prev };
    },
    async confirm(id, sig) { const p = payouts[id - 1]; if (p) { p.status = "confirmed"; p.signature = sig; } },
    async fail(id, wallet, prevLastClaim, amount) {
      const r = payouts[id - 1]; if (r) r.status = "failed";
      const p = get(wallet); if (p) { p.last_claim = prevLastClaim; p.lifetime_paid = Math.max(0, p.lifetime_paid - amount); }
    },
    async count() { return players.size; },
    async allChikis(exclude, cap) {
      const out = [];
      for (const [wallet, p] of players) {
        if (wallet === exclude || !p.profile?.chikis) continue;
        const handle = p.profile.handle || null, bal = p.profile.bal || 0;
        for (const c of p.profile.chikis) {
          out.push({ wallet, handle, bal, sp: c.sp | 0, level: c.level | 0, nick: c.nick || null, tasksDone: c.tasksDone | 0, hungry: !!c.hungry, isLegend: !!c.isLegend });
          if (out.length >= cap) return out;
        }
      }
      return out;
    },
    async claimedTotals() {
      let chikis = 0, holders = 0, legends = 0;
      for (const p of players.values()) {
        const c = p.profile?.chikis || []; if (!c.length) continue;
        legends += c.filter(x => x.isLegend).length;          // all-time legends hatched
        if (p.eligible) { holders++; chikis += c.length; }     // current keepers + their Chikis only
      }
      return { chikis, holders, legends };
    },
    async legendHolderWallets() {
      const out = [];
      for (const [wallet, p] of players) { const c = p.profile?.chikis || []; if (c.some(x => x.isLegend)) out.push(wallet); }
      return out;
    },
  };
}

const store = makeStore();

/* ----------------------------- chat ----------------------------- */
/* wallets allowed to pin/announce: ADMIN_WALLETS list + the team wallet */
const ADMIN_SET = new Set(String(ADMIN_WALLETS || "").split(",").map(s => s.trim()).filter(Boolean));
if (TEAM_WALLET) ADMIN_SET.add(TEAM_WALLET.trim());
const isAdminWallet = (w) => ADMIN_SET.has(w);

// ----- Reward-pool BAN LIST -----
// A banned wallet is blocked from EVERY treasury payout — both accrual claims AND Cup prizes (all SOL leaves the
// treasury, so one check covers the whole reward pool + team payouts). Seeded from BANNED_WALLETS env + persisted
// admin bans; managed live via /admin/ban + /admin/unban.
let bannedWallets = new Set(String(process.env.BANNED_WALLETS || "").split(/[,\s]+/).filter(s => isPubkey(s)));
const isBanned = (w) => bannedWallets.has(w);
async function saveBanned() { try { await store.kvSet("banned_wallets", [...bannedWallets]); } catch (e) {} }

// ----- Server-authoritative BATTLE WINS -----
// The ONLY way Battle Rating (BR) can rise is by winning REAL, server-resolved battles (live PvP + Cup matches).
// Each win here grants one BR point of headroom; the profile sanitizer clamps a Chiki's BR to (grandfathered base
// + new wins), so a client can never inflate BR by idling, time-spamming, or editing its own state.
let battleWins = {};   // wallet -> count of server-resolved match wins
const winsOf = (w) => Number(battleWins[w] || 0);
let _winsDirty = false;
function recordWin(wallet) { if (!isPubkey(wallet)) return; battleWins[wallet] = winsOf(wallet) + 1; _winsDirty = true; }
async function saveBattleWins() { if (!_winsDirty) return; _winsDirty = false; try { await store.kvSet("battle_wins", battleWins); } catch (e) {} }
setInterval(() => { saveBattleWins().catch(() => {}); }, 15000);   // flush the win ledger periodically

/* ----------------------------- Chikoria Cup (live event) ----------------------------- */
const CUP_ELEMS = ["Water", "Fire", "Beast", "Storm", "Light"];
let liveCup = null;                  // in-memory orchestrator (null until an admin creates one)
let cupRound = null;                 // transient: the current round's LIVE PvP matches { battling, matchByWallet, side, matches }
let cupPublic = true;                // true = open to ALL players (launched). Admin can flip to admin-only via /cup/public.
let cupAuto = true;                  // AUTO-RUN: server starts/finalizes each round on its own (no admin clicking). Toggle via /cup/auto.
let cupRoundStartedAt = 0;           // when the current battling round began (for the round time-limit)
let cupAutoNextAt = 0;               // earliest time the auto-runner may act again (inter-round pause)
const CUP_ROUND_MAX_MS = 4 * 60 * 1000;   // a round auto-finalizes after this even if a match is stuck (idle players forfeit far sooner)
const CUP_ROUND_GAP_MS = 7000;            // pause between finalizing a round and starting the next, so results are visible
const cupPrizes = new Map();         // wallet -> owed SOL (DURABLE — these are real funds; persisted to kv)
const cupPayers = new Map();         // wallet -> Glory paid in entry fees (DURABLE log, so we can refund on a reset)
const gloryCredits = new Map();      // wallet -> pending Glory to ADD on the player's next login/refresh.
                                     // Lives OUTSIDE the profile so client saves can't clobber it (Glory is client-authoritative).
let cupTotalAwarded = Number(process.env.CUP_AWARDED_SEED || 8);   // DURABLE cumulative SOL ever rewarded as Cup prizes; seeded with the 2 cups already run (4 SOL each). New cups add to it.
async function saveCupAwarded() { try { await store.kvSet("cup_total_awarded", cupTotalAwarded); } catch (e) {} }
let cupChampion = null;   // {wallet, name, ts} — the REIGNING Chikoria Cup champion (latest only)
async function saveCupChampion() { try { await store.kvSet("cup_champion", cupChampion); } catch (e) {} }
function crownChampion() {   // capture the winner of the just-finished cup as the reigning champion
  try { const c = liveCup && liveCup.state && liveCup.state.champion;
    if (c && isPubkey(c.wallet)) { cupChampion = { wallet: c.wallet, name: (c.snap && c.snap.name) || "Champion", ts: Date.now() }; saveCupChampion(); }
  } catch (e) {}
}

// ===== Meme Dynasty NFT eggs: buy egg -> hatch a RANDOM member (limited editions) -> mint worker turns it into an NFT =====
// Per-character supply = rarity. Fewer editions = rarer. `weight` = pull odds (set to the cap so each
// character depletes proportionally and the scarcer ones are genuinely harder to hatch).
const MEME_CHARS = [
  { key: "pepe",    name: "Pepe",      cap: 25, weight: 25, rarity: "Meme Legendary" },
  { key: "popcat",  name: "Popcat",    cap: 20, weight: 20, rarity: "Meme Legendary" },
  { key: "moodeng", name: "Moo Deng",  cap: 20, weight: 20, rarity: "Meme Legendary" },
  { key: "doge",    name: "Doge",      cap: 15, weight: 15, rarity: "Meme Legendary" },
  { key: "chillguy",name: "Chill Guy", cap: 15, weight: 15, rarity: "Meme Legendary" },
  { key: "alon",    name: "Alon",      cap: 10, weight: 10, rarity: "Founder's Edition" },  // rarest — its own tier
];
const MEME_KEYS = new Set(MEME_CHARS.map(c => c.key));
const MEME_CAP = Number(process.env.MEME_EDITION_CAP || 10);   // fallback cap if a character has none
const capOf = (key) => { const c = MEME_CHARS.find(x => x.key === key); return (c && c.cap) || MEME_CAP; };
const rarityOf = (key) => { const c = MEME_CHARS.find(x => x.key === key); return (c && c.rarity) || "Meme Legendary"; };
const MEME_TOTAL = MEME_CHARS.reduce((s, c) => s + (c.cap || MEME_CAP), 0);   // 105
const MEME_EGG_PRICE = Number(process.env.MEME_EGG_PRICE || 1000000);   // $CHIKI per egg
// 🔒 SALE SWITCH — hard server-side lock. CLOSED by default. Flip MEME_SALE_OPEN=true on Render at your X launch.
// While closed, /meme/hatch is rejected for everyone EXCEPT admin wallets (so you can still dry-run).
const MEME_SALE_OPEN = String(process.env.MEME_SALE_OPEN ?? "false").toLowerCase() === "true";
const MEME_ADMIN_WALLETS = new Set((process.env.MEME_ADMIN_WALLETS || TEAM_WALLET || "").split(",").map(s => s.trim()).filter(Boolean));
// Verify the on-chain $CHIKI payment before minting. ON by default because $CHIKI is a real (mainnet) token —
// without this, anyone could POST /meme/hatch and mint NFTs for free. Set MEME_VERIFY_PAY=false only for local testing.
const MEME_VERIFY_PAY = String(process.env.MEME_VERIFY_PAY ?? "true").toLowerCase() === "true";
// When a Tensor (or Magic Eden) collection URL is configured, real trading happens there — the custom in-game
// escrow ledger (/meme/buy) is disabled so we never settle real-money trades off-chain.
// Marketplace link for real on-chain trading. Configurable so it can point at Magic Eden, Tensor, etc.
// MARKET_URL/MARKET_NAME take precedence; TENSOR_URL is kept for back-compat.
const MARKET_URL = process.env.MARKET_URL || process.env.TENSOR_URL || "";
const MARKET_NAME = process.env.MARKET_NAME || (MARKET_URL.includes("magiceden") ? "Magic Eden" : "Tensor");
const TENSOR_URL = MARKET_URL;                 // back-compat alias used by older fields
const MEME_TRADE_TENSOR = !!MARKET_URL;        // any market URL set ⇒ route trading to that marketplace
let memeMinted = {};       // char -> editions handed out
let memeHatches = [];       // [{id, wallet, char, name, edition, status, mintAddr, ts}]
let memeUsedSigs = {};      // payment signature -> {wallet, ts}  (replay protection: a paid tx can hatch exactly one egg)
const _memeLastHatch = new Map();
async function saveMeme() { try { await store.kvSet("meme_minted", memeMinted); await store.kvSet("meme_hatches", memeHatches); await store.kvSet("meme_used_sigs", memeUsedSigs); } catch (e) {} }
// Verify a $CHIKI egg payment on-chain: the buyer signed it, it succeeded, they spent >= the price, and the treasury received funds.
async function verifyEggPayment(sig, wallet) {
  if (!MINT) return { ok: false, error: "server has no CHIKI mint configured" };
  if (!sig || typeof sig !== "string" || sig.length < 32) return { ok: false, error: "missing payment signature" };
  let tx;
  try { tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); }
  catch (e) { return { ok: false, error: "could not fetch payment transaction" }; }
  if (!tx || !tx.meta) return { ok: false, error: "payment not found yet — wait a moment and retry" };
  if (tx.meta.err) return { ok: false, error: "payment transaction failed on-chain" };
  // the buyer's wallet must have signed (so it's their payment, not a replayed third-party tx)
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const signed = keys.some(k => k && k.signer && (k.pubkey?.toString?.() || String(k.pubkey)) === wallet);
  if (!signed) return { ok: false, error: "payment was not signed by your wallet" };
  // compare CHIKI token-balance deltas for the buyer (must spend >= price) and the treasury (must receive funds)
  const mintStr = MINT.toString(), treasStr = treasury.publicKey.toString();
  const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  const bal = (arr, owner) => { const e = arr.find(b => b.mint === mintStr && b.owner === owner); return e ? Number(e.uiTokenAmount.uiAmount || 0) : 0; };
  const spent = bal(pre, wallet) - bal(post, wallet);
  const treasuryGain = bal(post, treasStr) - bal(pre, treasStr);
  if (spent < MEME_EGG_PRICE * 0.999) return { ok: false, error: `payment too small — ${MEME_EGG_PRICE.toLocaleString()} $CHIKI required` };
  if (treasuryGain < MEME_EGG_PRICE * 0.999) return { ok: false, error: "payment did not reach the treasury — the full price must land in the treasury" };
  return { ok: true, spent, treasuryGain };
}
// how many eggs are claimed (bought) — incubating(mystery) + pending + minted all hold a slot against the 105 total.
function memeReserved() { return memeHatches.filter(h => h.status === "incubating" || h.status === "pending" || h.status === "minted").length; }
function memeSupply() {
  const chars = {}; let hatched = 0;
  // per-character "minted" = species ROLLED at hatch (determined). Incubating eggs are a mystery and not counted per-character yet.
  for (const c of MEME_CHARS) { const cap = capOf(c.key), m = memeMinted[c.key] || 0; chars[c.key] = { name: c.name, minted: m, cap, left: Math.max(0, cap - m), rarity: c.rarity }; hatched += m; }
  const reserved = memeReserved();
  return { chars, totalLeft: Math.max(0, MEME_TOTAL - reserved), total: MEME_TOTAL, reserved, hatched, cap: MEME_CAP };
}
// MIGRATION: reset any already-bought (incubating) egg back to a MYSTERY so its species is re-rolled at hatch,
// and recompute per-character counts from only the determined (pending/minted) hatches. Idempotent.
async function migrateMemeRandomize() {
  let changed = false;
  for (const h of memeHatches) {
    if (h.status === "incubating" && (h.char || !h.undetermined)) { h.char = null; h.name = "Mystery Meme Egg"; h.edition = null; h.undetermined = true; changed = true; }
  }
  const recomputed = {};
  for (const h of memeHatches) { if ((h.status === "pending" || h.status === "minted") && h.char) recomputed[h.char] = (recomputed[h.char] || 0) + 1; }
  if (JSON.stringify(recomputed) !== JSON.stringify(memeMinted)) { memeMinted = recomputed; changed = true; }
  if (changed) { try { await saveMeme(); } catch (e) {} console.log("meme: randomize migration applied — incubating eggs reset to mystery; per-char counts recomputed"); }
}
// A player may hold only ONE Meme Legendary that isn't up for sale. To get another, list (sell) the current one first.
function memeOwnedActive(wallet) { return memeHatches.filter(h => h.wallet === wallet && !h.listed).length; }
// Lifetime cap: a wallet may HATCH at most MEME_MAX_HATCH eggs ever — counted by the ORIGINAL hatcher so
// selling/transferring an NFT never refunds a slot. Falls back to h.wallet for legacy rows without `hatcher`.
const MEME_MAX_HATCH = 5;
function memeLifetimeHatched(wallet) { return memeHatches.filter(h => (h.hatcher || h.wallet) === wallet).length; }

// ----- ON-CHAIN OWNERSHIP RECONCILE -----
// When trading is on Magic Eden (MEME_TRADE_TENSOR), transfers happen on-chain and the backend can't see them.
// This reads each minted asset's REAL owner via the DAS `getAsset` RPC and updates the ledger, so in-game ownership,
// the "1 at a time" rule, and the playable-Chiki grant all follow the true on-chain owner after any Magic Eden sale.
async function dasOwner(mintAddr) {
  try {
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "own", method: "getAsset", params: { id: mintAddr } }) });
    const j = await r.json();
    return (j && j.result && j.result.ownership && j.result.ownership.owner) || null;
  } catch (e) { return null; }
}
let _memeSyncBusy = false, _memeSyncAt = 0, _dasUnsupported = false;
async function reconcileMemeOwners() {
  if (!MEME_TRADE_TENSOR || _memeSyncBusy || _dasUnsupported) return;   // only meaningful in on-chain (Magic Eden) mode
  _memeSyncBusy = true; let changed = false, checked = 0;
  try {
    for (const h of memeHatches) {
      if (h.status !== "minted" || !h.mintAddr) continue;
      const owner = await dasOwner(h.mintAddr); checked++;
      if (owner && isPubkey(owner)) { if (owner !== h.wallet) { h.wallet = owner; h.listed = null; h._syncedAt = Date.now(); changed = true; } }
    }
    if (checked === 0) { /* nothing minted */ }
    else if (changed) await saveMeme();
  } finally { _memeSyncBusy = false; _memeSyncAt = Date.now(); }
}
setInterval(() => { reconcileMemeOwners().catch(() => {}); }, 5 * 60 * 1000);   // background reconcile every 5 min
function pickMeme() {
  const avail = MEME_CHARS.filter(c => (memeMinted[c.key] || 0) < capOf(c.key));
  if (!avail.length) return null;
  let tot = avail.reduce((s, c) => s + (c.weight || 1), 0), r = Math.random() * tot;
  for (const c of avail) { r -= (c.weight || 1); if (r <= 0) return c; }
  return avail[avail.length - 1];
}
async function loadCupState() {
  try { const p = await store.kvGet("cup_prizes"); if (p && typeof p === "object") for (const k in p) { const v = Number(p[k]) || 0; if (v > 0) cupPrizes.set(k, v); } } catch (e) {}
  try { const v = await store.kvGet("cup_public"); if (v !== null && v !== undefined) cupPublic = !!v; } catch (e) {}   // honor an explicit admin toggle; otherwise keep the default (public)
  try { const a = await store.kvGet("cup_auto"); if (a !== null && a !== undefined) cupAuto = !!a; } catch (e) {}   // auto-run setting persists across restarts
  try { const py = await store.kvGet("cup_payers"); if (py && typeof py === "object") for (const k in py) cupPayers.set(k, Number(py[k]) || 0); } catch (e) {}
  try { const gc = await store.kvGet("glory_credits"); if (gc && typeof gc === "object") for (const k in gc) { const v = Number(gc[k]) || 0; if (v > 0) gloryCredits.set(k, v); } } catch (e) {}
  try { const ta = await store.kvGet("cup_total_awarded"); if (ta != null) cupTotalAwarded = Number(ta) || 0; } catch (e) {}
  try { const ch = await store.kvGet("cup_champion"); if (ch != null) cupChampion = ch; } catch (e) {}
  try { const bw = await store.kvGet("banned_wallets"); if (Array.isArray(bw)) for (const w of bw) if (isPubkey(w)) bannedWallets.add(w); } catch (e) {}   // reward-pool bans persist across restarts
  try { const wins = await store.kvGet("battle_wins"); if (wins && typeof wins === "object") battleWins = wins; } catch (e) {}   // server-authoritative BR win ledger
  try { const mm = await store.kvGet("meme_minted"); if (mm && typeof mm === "object") memeMinted = mm; } catch (e) {}
  try { const mh = await store.kvGet("meme_hatches"); if (Array.isArray(mh)) memeHatches = mh; } catch (e) {}
  try { const us = await store.kvGet("meme_used_sigs"); if (us && typeof us === "object") memeUsedSigs = us; } catch (e) {}
  try { const pg = await store.kvGet("pending_gifts"); if (pg && typeof pg === "object") pendingGifts = pg; } catch (e) {}   // pending gift offers
  try { await migrateMemeRandomize(); } catch (e) {}   // reset predetermined eggs → species rolls at hatch
  try { const cs = await store.kvGet("cup_state"); if (cs && cs.status) liveCup = createCup({}, cs); } catch (e) { console.error("cup_state restore failed:", e?.message || e); }   // resume an in-progress bracket after a restart
}
async function saveCupPrizes() { const o = {}; for (const [k, v] of cupPrizes) if (v > 0) o[k] = v; try { await store.kvSet("cup_prizes", o); } catch (e) {} }
async function savePayers() { const o = {}; for (const [k, v] of cupPayers) if (v > 0) o[k] = v; try { await store.kvSet("cup_payers", o); } catch (e) {} }
async function saveGloryCredits() { const o = {}; for (const [k, v] of gloryCredits) if (v > 0) o[k] = v; try { await store.kvSet("glory_credits", o); } catch (e) {} }
// Apply any pending Glory credit to a freshly-loaded profile (called on login/refresh). Persists + clears the credit
// so it survives the client's authoritative profile saves and lands exactly once.
async function applyGloryCredit(wallet, profile) {
  const credit = gloryCredits.get(wallet) || 0;
  if (!(credit > 0) || !profile) return profile;
  profile.glory = (Number(profile.glory) || 0) + credit;
  try { await store.setProfile(wallet, profile); } catch (e) {}
  gloryCredits.delete(wallet); await saveGloryCredits();
  return profile;
}
// Add Glory back to a wallet's stored profile (used to refund cup entry fees on a reset).
async function refundGlory(wallet, amount) {
  if (!isPubkey(wallet) || !(amount > 0)) return false;
  try { const p = await store.getProfile(wallet); if (!p) return false; p.glory = (Number(p.glory) || 0) + amount; await store.setProfile(wallet, p); return true; } catch (e) { return false; }
}
// Persist the LIVE bracket so a restart (deploy / spin-down / crash) resumes instead of losing the cup.
async function persistCup() { try { await store.kvSet("cup_state", liveCup ? liveCup.snapshot() : null); } catch (e) {} }
const cupAdminOk = (req) => {
  const key = req.body?.key || req.query?.key;
  if (process.env.ADMIN_KEY && key === process.env.ADMIN_KEY) return true;
  const w = req.body?.wallet || req.query?.wallet;
  const msg = req.body?.authMsg || req.query?.authMsg, sig = req.body?.authSig || req.query?.authSig;
  return !!(w && isPubkey(w) && isAdminWallet(w) && verifyWalletSig(w, msg, sig));   // wallet branch now REQUIRES a fresh signature — bare wallet match is not enough
};
function cupSnapshot(forWallet) {
  const s = liveCup ? liveCup.state : null;
  const live = !!liveCup && s.status === "live";
  const out = {
    exists: !!liveCup, public: cupPublic, auto: cupAuto,
    status: s ? s.status : "none",
    entryGlory: s ? s.entryGlory : 100, prizePool: s ? s.prizePool : 4.0, cap: s ? s.cap : 10,
    entrants: s ? s.entrants.map(e => ({ name: e.snap.name, player: e.snap.player || null, br: e.snap.br, element: e.snap.element, bot: !!e.bot, ready: !!e.ready })) : [],
    round: live ? liveCup.roundName : null,
    matches: live ? liveCup.currentMatches() : [],
    champion: s && s.champion ? (s.champion.snap.player || s.champion.snap.name) : null,
    results: (s && s.status === "finished") ? liveCup.results() : null,
    bracket: (liveCup && s && s.status !== "registration") ? liveCup.bracketView() : null,
  };
  // Live PvP matches anyone can spectate this round (profile names + matchId + live status).
  if (cupRound && cupRound.battling && Array.isArray(cupRound.matches)) {
    const entName = w => { const e = s && s.entrants.find(x => x.wallet === w); return e ? (e.snap.player || e.snap.name) : "Player"; };
    const entEl = w => { const e = s && s.entrants.find(x => x.wallet === w); return e ? e.snap.element : "Fire"; };
    out.liveMatches = cupRound.matches.map(mm => { const m = pvpMatches.get(mm.matchId);
      return { matchId: mm.matchId, a: entName(mm.a), b: entName(mm.b), aEl: entEl(mm.a), bEl: entEl(mm.b),
        status: m ? m.status : "active", winner: m && m.status === "finished" ? m.winner : null }; });
  } else out.liveMatches = [];
  if (forWallet) {
    const me = s && s.entrants.find(e => e.wallet === forWallet);
    out.youRegistered = !!me; out.youReady = !!(me && me.ready);
    out.yourPrize = cupPrizes.get(forWallet) || 0;
    out.youPlace = (s && s.place) ? (s.place[forWallet] || null) : null;
    out.isAdmin = isAdminWallet(forWallet);
    if (cupRound && cupRound.battling) {           // a live PvP round is underway — tell the player about their match
      out.roundBattling = true;
      const mid = cupRound.matchByWallet.get(forWallet);
      if (mid) { out.pvpMatchId = mid; out.pvpSide = cupRound.side.get(forWallet); const mm = pvpMatches.get(mid); out.pvpOver = mm ? mm.status === "finished" : false; }
    }
  }
  return out;
}
// Validate + clamp a client-supplied legendary snapshot against the wallet's stored roster (anti-inflation).
// exported as a test seam so a sim can assert the deck is derived, not accepted
export async function cupSnapFromBody(wallet, snap) {
  const prof = await store.getProfile(wallet);
  const roster = (prof && Array.isArray(prof.chikis)) ? prof.chikis : [];
  const legends = roster.filter(c => c && c.isLegend);
  if (!legends.length) return { error: "Hatch a Legendary first to enter the Cup." };
  const bestBr = legends.reduce((m, c) => Math.max(m, Number(c.br) || 1), 1);
  const el = CUP_ELEMS.includes(snap?.element) ? snap.element : "Fire";
  // THE DECK IS THE SERVER'S, NOT THE CALLER'S. br was already clamped to the player's best
  // legendary, but arenaSkills and cardTier were taken straight from the request body and only
  // range-checked — so an entrant could claim all 12 ability cards at tier 5 regardless of what
  // they had actually unlocked, in a tournament that pays real SOL. The stored profile already
  // holds the true per-chiki deck (and /profile rate-limits how fast it may grow, CARD_MIN_SEC),
  // so that is the authority. The caller may still CHOOSE among the cards it owns — the body is
  // treated as a preference, intersected with the truth, never as the source.
  const champ = legends.reduce((b, c) => ((Number(c.br) || 1) >= (Number(b.br) || 1) ? c : b), legends[0]);
  const ownedSkills = Array.isArray(champ?.arenaSkills)
    ? champ.arenaSkills.map(n => n | 0).filter(n => n >= 0 && n < 12) : [];
  const wanted = Array.isArray(snap?.arenaSkills)
    ? snap.arenaSkills.map(n => n | 0).filter(n => n >= 0 && n < 12) : [];
  let skills = ownedSkills.length
    ? (wanted.length ? wanted.filter(n => ownedSkills.includes(n)) : ownedSkills)
    : wanted;                                   // legacy record with no stored deck: fall back
  if (!skills.length) skills = ownedSkills.length ? ownedSkills.slice(0, 3) : [0, 1, 2];
  const ownedCt = (champ?.cardTier && typeof champ.cardTier === "object") ? champ.cardTier : null;
  const ct = {};
  if (snap?.cardTier && typeof snap.cardTier === "object") {
    for (const k in snap.cardTier) {
      const sl = k | 0;
      if (sl < 0 || sl >= 12) continue;
      let v = Math.max(1, Math.min(5, Number(snap.cardTier[k]) || 1));
      if (ownedCt) v = Math.min(v, Math.max(1, Math.min(5, Number(ownedCt[sl]) || 1)));  // never above what is owned
      ct[sl] = v;
    }
  } else if (ownedCt) {
    for (const k in ownedCt) { const sl = k | 0; if (sl >= 0 && sl < 12) ct[sl] = Math.max(1, Math.min(5, Number(ownedCt[k]) || 1)); }
  }
  const br = Math.max(1, Math.min(MAX_BR, Math.min(Number(snap?.br) || bestBr, bestBr)));   // can't claim a higher BR than your best legendary
  const name = stripTags(snap?.name || (prof?.handle) || wallet.slice(0, 4)).slice(0, 18) || wallet.slice(0, 4);
  const player = stripTags(prof?.handle || "").slice(0, 18) || null;   // the PLAYER's profile name (shown in the Hub, not the Chikimon's name)
  return { snap: { name, player, element: el, br, arenaSkills: skills, cardTier: ct, glory: 0 } };
}

const CHAT_WINDOW = 120000;                   // a wallet shows as "online" for 2 min after its last beat
const onlineUsers = new Map();                // wallet -> { handle, ts }

/* profanity filter — normalize common leetspeak, then mask listed words (server-authoritative) */
const BAD_WORDS = ["fuck","shit","bitch","asshole","bastard","cunt","dick","piss","slut","whore",
  "nigger","nigga","faggot","retard","rape","cock","pussy","motherfucker","wank","twat","prick","jerkoff","cumshot"];
function cleanText(s) {
  s = String(s || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);   // strip < > so chat/handles can't inject HTML
  const norm = (w) => w.toLowerCase()
    .replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a")
    .replace(/0/g, "o").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
  return s.replace(/[\p{L}\p{N}@$!|*]+/gu, (tok) => {
    const n = norm(tok);
    for (const bad of BAD_WORDS) if (n === bad || (bad.length >= 4 && n.includes(bad))) return "*".repeat(tok.length);
    return tok;
  });
}

function makeChat() {
  if (DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: DATABASE_URL, max: 3,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    return {
      kind: "postgres",
      async init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS chat(
          id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, wallet TEXT NOT NULL, handle TEXT,
          body TEXT NOT NULL, to_wallet TEXT, pinned BOOLEAN NOT NULL DEFAULT false)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS chat_id_idx ON chat(id)`);
        await pool.query(`ALTER TABLE chat ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb`);   // {emoji:[wallet,...]}
      },
      async send(m) {
        const r = await pool.query(
          `INSERT INTO chat(ts,wallet,handle,body,to_wallet,pinned) VALUES($1::bigint,$2,$3,$4,$5,$6) RETURNING *`,
          [m.ts, m.wallet, m.handle || null, m.body, m.to || null, !!m.pinned]);
        return r.rows[0];
      },
      async fetch(wallet, since) {
        /* return the NEWEST 200 above `since` (then re-sort ascending) so new messages are never cut off */
        const r = await pool.query(
          `SELECT * FROM chat WHERE id>$1 AND (to_wallet IS NULL OR to_wallet=$2 OR wallet=$2) ORDER BY id DESC LIMIT 200`,
          [since || 0, wallet || ""]);
        const p = await pool.query(`SELECT * FROM chat WHERE pinned=true ORDER BY id DESC LIMIT 1`);
        // reaction counts for recently-reacted messages, so clients refresh them without re-fetching whole messages
        const rr = await pool.query(`SELECT id, reactions FROM chat WHERE reactions <> '{}'::jsonb ORDER BY id DESC LIMIT 150`);
        const recentReactions = {}; for (const row of rr.rows) recentReactions[row.id] = row.reactions;
        return { messages: r.rows.reverse(), pinned: p.rows[0] || null, recentReactions };
      },
      async pin(id, on) {
        if (on) await pool.query(`UPDATE chat SET pinned=false WHERE pinned=true`);
        await pool.query(`UPDATE chat SET pinned=$2 WHERE id=$1`, [id, !!on]);
      },
      async react(id, emoji, wallet) {
        const r = await pool.query(`SELECT reactions FROM chat WHERE id=$1`, [id]);
        if (!r.rows[0]) return null;
        const rx = r.rows[0].reactions || {};
        const set = new Set(rx[emoji] || []);
        if (set.has(wallet)) set.delete(wallet); else set.add(wallet);   // toggle
        if (set.size) rx[emoji] = [...set]; else delete rx[emoji];
        await pool.query(`UPDATE chat SET reactions=$2::jsonb WHERE id=$1`, [id, JSON.stringify(rx)]);
        return rx;
      },
    };
  }
  const msgs = []; let seq = 1;
  return {
    kind: "memory",
    async init() {},
    async send(m) {
      const row = { id: seq++, ts: m.ts, wallet: m.wallet, handle: m.handle || null, body: m.body, to_wallet: m.to || null, pinned: !!m.pinned, reactions: {} };
      msgs.push(row); if (msgs.length > 500) msgs.shift(); return row;
    },
    async fetch(wallet, since) {
      const messages = msgs.filter(x => x.id > (since || 0) && (!x.to_wallet || x.to_wallet === wallet || x.wallet === wallet)).slice(-200);
      const pinned = [...msgs].reverse().find(x => x.pinned) || null;
      const recentReactions = {}; for (const x of msgs) if (x.reactions && Object.keys(x.reactions).length) recentReactions[x.id] = x.reactions;
      return { messages, pinned, recentReactions };
    },
    async pin(id, on) { if (on) msgs.forEach(x => x.pinned = false); const m = msgs.find(x => x.id === id); if (m) m.pinned = !!on; },
    async react(id, emoji, wallet) {
      const m = msgs.find(x => x.id === id); if (!m) return null;
      const rx = m.reactions || (m.reactions = {});
      const set = new Set(rx[emoji] || []);
      if (set.has(wallet)) set.delete(wallet); else set.add(wallet);
      if (set.size) rx[emoji] = [...set]; else delete rx[emoji];
      return rx;
    },
  };
}
const chat = makeChat();

/* ----------------------------- live stats / leaderboard / feed ----------------------------- */
const SUPPLY_TOTAL = 1_000_000_000;     // pump.fun mints exactly 1B; supply only drops via burns
const feedEvents = []; let _feedSeq = 1;
function pushFeed(type, data) {
  feedEvents.push({ id: _feedSeq++, ts: Date.now(), type, ...data });
  if (feedEvents.length > 80) feedEvents.shift();
}
// On-chain $CHIKI holders via Helius DAS (getTokenAccounts). Also computes KEEPERS = owners whose TOTAL balance ≥ MIN.
// Heavy call → cached 30 min. Accurate ground truth (vs the stale eligible-flag profile scan).
let _holdersCache = { t: 0, n: 0, keepers: 0, keeperSet: new Set() };
async function chikiHolderCount() {
  if (!MINT) return _holdersCache;
  if (_holdersCache.n && Date.now() - _holdersCache.t < 30 * 60 * 1000) return _holdersCache;
  try {
    let dec = 6; try { dec = await chikiDecimals(); } catch (e) {}
    const threshold = BigInt(Math.round(MIN)) * (10n ** BigInt(dec));   // raw token units for the MIN_HOLD threshold
    const owners = new Set(), bal = new Map(); let cursor, pages = 0;
    while (pages < 25) {
      const params = { mint: MINT, limit: 1000, options: { showZeroBalance: false } };
      if (cursor) params.cursor = cursor;
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "holders", method: "getTokenAccounts", params }) });
      const j = await r.json();
      const accs = (j && j.result && j.result.token_accounts) || [];
      for (const a of accs) { if (!a.owner) continue; owners.add(a.owner);
        let amt = 0n; try { amt = BigInt(a.amount || 0); } catch (e) {}
        bal.set(a.owner, (bal.get(a.owner) || 0n) + amt); }                // sum across a holder's multiple token accounts
      cursor = j && j.result && j.result.cursor; pages++;
      if (!cursor || accs.length === 0) break;
    }
    if (owners.size) {
      const keeperSet = new Set(); for (const [o, amt] of bal) if (amt >= threshold) keeperSet.add(o);
      _holdersCache = { t: Date.now(), n: owners.size, keepers: keeperSet.size, keeperSet };
    }
    return _holdersCache;
  } catch (e) { return _holdersCache; }
}
let _statsCache = { t: 0, data: null };
async function getStats() {
  if (_statsCache.data && Date.now() - _statsCache.t < 15000) return _statsCache.data;
  // FAIL-CLOSED RPC: clientRpc must NEVER fall back to RPC_URL. /stats is public and
  // unauthenticated, so that fallback published the SERVER key — the one that signs treasury
  // payouts — to anyone who asked. A browser client cannot hold a secret anyway: CLIENT_RPC is
  // meant to be public and restricted. Unset it and on-chain buys disable visibly, which is the
  // safe failure. (2026-07: the server key was live on this endpoint until it was rotated.)
  const out = { network: NETWORK, minHold: MIN, whaleMin: WHALE_MIN, poolReserveSol: RESERVE, marketOnchain: MARKET_ONCHAIN, marketSplit: { seller: MARKET_SELLER_SHARE, team: MARKET_TEAM_TAX, burn: MARKET_BURN }, teamWallet: TEAM_WALLET || null, chikiMint: MINT ? MINT.toBase58() : null, chikiDecimals: CHIKI_DECIMALS, clientRpc: (process.env.CLIENT_RPC || "") };
  try { out.poolSol = await poolSol(); } catch (e) {}
  try { out.players = await store.count(); } catch (e) {}
  try { out.dailyPaidSol = await store.dailyTotal(); } catch (e) {}
  try { out.totalPaidSol = await store.totalPaid(); } catch (e) {}   // ALL-TIME SOL paid to keepers
  try { const p = await store.presence(PRESENCE_WINDOW); out.activeUsers = p.activeUsers; out.chikimons = p.chikimons; } catch (e) {}
  if (MINT) { try { const s = await conn.getTokenSupply(MINT); out.supply = s.value.uiAmount; out.burned = Math.max(0, SUPPLY_TOTAL - (s.value.uiAmount || 0)); } catch (e) {} }
  out.chikiHolders = _holdersCache.n || 0; chikiHolderCount().catch(()=>{});   // non-blocking: serve cached, refresh in background
  if (TEAM_WALLET) {
    try { out.teamSol = (await conn.getBalance(new PublicKey(TEAM_WALLET))) / LAMPORTS_PER_SOL; } catch (e) {}
    try { out.teamChiki = await chikiBalance(TEAM_WALLET); } catch (e) {}
  }
  try { const t = await store.claimedTotals(); out.legendsHatched = t.legends; } catch (e) {}   // legends = all-time hatched
  // KEEPERS + ACTIVE CHIKIS — accurate, from the on-chain ≥MIN holder set (not the stale eligible flag)
  out.holders = _holdersCache.keepers || 0;
  try { out.claimedChikis = await store.chikisForWallets([...(_holdersCache.keeperSet || [])]); } catch (e) { out.claimedChikis = 0; }
  // Chikoria Cup rewards
  out.cupPrizePool = liveCup ? liveCup.state.prizePool : 4;          // SOL on the line per cup
  out.cupChampionSol = 1;                                            // champion's share
  let cupOwed = 0; for (const v of cupPrizes.values()) cupOwed += v; // prizes credited but not yet claimed
  out.cupOwedSol = +cupOwed.toFixed(4);
  out.cupAwardedSol = +Number(cupTotalAwarded || 0).toFixed(4);       // ALL-TIME SOL rewarded in the Chikoria Cup
  out.cupChampion = cupChampion;                                     // {wallet, name, ts} reigning champion (or null)
  _statsCache = { t: Date.now(), data: out };
  return out;
}
let _lbCache = { t: 0, data: null };
async function getLeaderboard() {
  if (_lbCache.data && Date.now() - _lbCache.t < 180000) return _lbCache.data;
  const holders = [];
  if (MINT) {
    try {
      const largest = await conn.getTokenLargestAccounts(MINT);
      const accs = (largest.value || []).slice(0, 20);
      const infos = await Promise.all(accs.map(a => conn.getParsedAccountInfo(a.address).catch(() => null)));
      for (let i = 0; i < accs.length; i++) {
        const owner = infos[i]?.value?.data?.parsed?.info?.owner;
        const bal = accs[i].uiAmount || 0;
        if (!owner || bal < MIN) continue;
        holders.push({ owner, balance: bal, whale: bal >= WHALE_MIN });
      }
    } catch (e) {}
  }
  let earners = [];
  try { earners = await store.topEarners(15); } catch (e) {}
  const data = { holders: holders.slice(0, 15), earners, updatedAt: Date.now() };
  _lbCache = { t: Date.now(), data };
  return data;
}

/* ----------------------------- API ----------------------------- */
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", async (_q, res) => res.json({
  ok: true, network: NETWORK, store: store.kind, verifyHolders: verifyOn,
  treasury: treasury.publicKey.toBase58(), team: TEAM_WALLET || null,
  mint: CHIKI_MINT || null, minHold: MIN, minHoldMinutes: Number(MIN_HOLD_MINUTES),
  dailyCap: DAILY_FRAC >= 1 ? "none" : Math.round(DAILY_FRAC * 100) + "% pool/day", perWalletDailySol: WALLET_DAILY, poolReserveSol: RESERVE,
  maxClaimSol: CAP, earnModel: "rarity-weighted-tasks", earnMult: MULT, taskSeconds: TASK_SEC, accrualCapMin: ACCRUAL_CAP,
  whaleMin: WHALE_MIN, whaleHoldHours: Number(WHALE_HOLD_HOURS),
}));

app.get("/pool", async (_q, res) => {
  try { res.json({ poolSol: await poolSol(), players: await store.count(), dailyPaid: await store.dailyTotal() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/verify", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    // SIGN-IN (web): the client may attach a Phantom-signed "Chikoria sign-in" message.
    // A valid Ed25519 signature proves the caller OWNS this wallet (paste-any-address is
    // read-only). Absence is not an error — desktop builds still link by public address.
    const signedIn = verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig);
    if (signedIn) { try { await store.kvSet("signin:" + wallet, { ts: Date.now() }); } catch (e) {} }
    // 1) The wallet GATE = the on-chain balance. This is the only thing the connect flow truly
    //    needs, and it never touches the database.
    let balance = 0, eligible = true;
    if (verifyOn) { balance = await chikiBalance(wallet); eligible = balance >= MIN; }
    // 2) DB-backed EXTRAS (whale hold-timer + cross-device roster/Glory). Degrade gracefully if
    //    the database is unreachable — a dead/expired Postgres must NEVER zero out a real holder's
    //    balance (previously store.touch() threw and 500'd the whole request → "0 $CHIKI").
    let whaleSince = null, firstSeen = 0, profile = null, dbOk = true;
    try {
      const p = await store.touch(wallet, eligible, balance);
      whaleSince = p?.whale_since ?? null;
      firstSeen = Number(p?.first_seen) || 0;
      profile = await applyGloryCredit(wallet, p?.profile || null);   // pending Glory gift on login (clobber-proof)
    } catch (dbErr) {
      dbOk = false;
      console.warn("verify: DB unavailable — serving chain-only result:", String(dbErr?.message || dbErr));
    }
    // PRIVACY: the MMO cloud-save (profile.mmo) is only sent to PROVEN owners — an
    // address alone still gets the legacy web-game roster (the old import is address-trust
    // by design) but never another player's full game state.
    if (!signedIn && profile && typeof profile === "object" && profile.mmo) {
      profile = { ...profile };
      delete profile.mmo;
    }
    const chikis = eligible ? (chikiCount(balance, whaleSince) || 1) : 0;
    const whalePending = eligible && balance >= WHALE_MIN && chikis < 2;
    const whaleReadyInMs = whalePending && whaleSince ? Math.max(0, WHALE_HOLD_MS - (Date.now() - Number(whaleSince))) : 0;
    // CREATOR/ADMIN unlock: the client (Chain.gd) reads `isAdmin` here to unlock the in-game
    // F8/F9 Creator Toolbox. It was never sent → admin could never sign in and access it.
    // Require PROVEN ownership (signedIn) so pasting an admin's public address can't unlock it;
    // this flag only gates IN-GAME dev tools — every real-$CHIKI payout stays separately
    // signature-gated (_questAdminOk / admin_payout).
    const isAdmin = signedIn && isAdminWallet(wallet);
    // MARKET TOKEN: a proven owner gets a bearer token their client attaches to mutating market ops
    // (ack/cancel/bid). Non-signed-in (address-only / demo) callers get none. We ALSO bind this
    // wallet to the client's OWN net_id here — the only place a sid can be tied to a wallet safely,
    // since the net_id is private (in the owner's save) and arrives with a proven signature.
    const mktToken = signedIn ? mintMarketToken(wallet) : "";
    if (signedIn) bindSid(stripTags(String(req.body?.netId || "")).slice(0, 40), wallet);
    res.json({ wallet, eligible, balance, chikis, whalePending, whaleReadyInMs, minHold: MIN, verified: verifyOn, firstSeen, profile: profile || null, dbOk, signedIn, isAdmin, mktToken });
  } catch (e) { res.status(500).json({ error: "verify failed: " + String(e.message || e) }); }
});

// Save / load a wallet's game profile (chikis + progress) so it follows the wallet across devices.
app.post("/profile", async (req, res) => {
  const wallet = req.body?.wallet, profile = req.body?.profile;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!profile || typeof profile !== "object") return res.status(400).json({ error: "'profile' object required" });
  // the MMO cloud-save rides under profile.mmo (whole client state, ~10-30KB). Writes that
  // carry it MUST prove wallet ownership (web sign-in signature) — otherwise anyone could
  // overwrite anyone's progress by knowing their address. Legacy web-game-shape writes
  // (no mmo key) keep the old open behaviour for the original game's compatibility.
  const hasMmo = profile.mmo && typeof profile.mmo === "object";
  const cap = hasMmo ? 65000 : 8000;
  if (JSON.stringify(profile).length > cap) return res.status(413).json({ error: "profile too large" });
  let prev = null;
  try { prev = await store.getProfile(wallet); } catch (e) {}
  // AUTH GATE. A signature is required for: MMO saves, any write touching identity/score
  // (glory/handle), OR any write against an ESTABLISHED account (one that already has an mmo save).
  // The last clause closes the hole where an unsigned {profile:{}} for a victim wallet slipped past
  // the shape check and let sanitize zero their glory + drop their handle (a real griefing wipe).
  const touchesIdentity = ("glory" in profile) || ("handle" in profile);
  const isEstablished = !!(prev && prev.mmo);
  if ((hasMmo || touchesIdentity || isEstablished) && !verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig)) {
    return res.status(401).json({ error: "sign-in required to save progress" });
  }
  const now = Date.now();
  if (now - (_lastSave.get(wallet) || 0) < 600) return res.json({ ok: true, throttled: true });   // ignore rapid-fire writes (anti-spam)
  _lastSave.set(wallet, now);
  try {
    // admins are trusted (creator testing); everyone else is clamped to legal values
    const safe = isAdminWallet(wallet) ? profile : sanitizeProfile(prev, profile, wallet);
    // SECURITY: an unsigned legacy write must NOT drop protected identity/score fields it didn't
    // supply — carry them forward from the stored profile so a `{profile:{}}` can't zero a wallet's
    // Glory (Cup entry currency, real prize pool) or erase its handle/leaderboard score.
    if (!isAdminWallet(wallet) && prev) {
      if (!("glory"  in profile) && prev.glory  != null) safe.glory  = prev.glory;
      if (!("handle" in profile) && prev.handle != null) safe.handle = prev.handle;
      if (!("bal"    in profile) && prev.bal    != null) safe.bal    = prev.bal;
    }
    // STORING THE SAVE AND AUDITING IT ARE SEPARATE CONCERNS, and conflating them destroyed data:
    // this `else` belongs to hasMmo alone (an unsigned legacy write must not wipe the owner's cloud
    // save). When an `&& _assetsReady` was bolted onto the audit condition, the else-branch started
    // firing on SIGNED saves whenever the ledger had not loaded — silently replacing the player's
    // new save with their previous one while answering 200 {ok:true}. That window is every deploy's
    // boot, and the whole process lifetime after a failed store read.
    if (hasMmo) safe.mmo = profile.mmo;                // the signed MMO cloud-save rides through verbatim
    else if (prev && prev.mmo) safe.mmo = prev.mmo;    // SECURITY: legacy (unsigned) writes must NOT wipe it

    // Record every asset this save presents, with where it came from. Never rejects — a wrong
    // rejection costs a real player their roster. Auditing must never break a save, but a SILENT
    // swallow once hid a working exploit completely, so it logs. Skipped (never fatal) until the
    // restore lands, or the audit would grandfather forged rosters against an empty map.
    if (hasMmo && _assetsReady) {
      // prev.first_seen is the DB's own record of when this wallet first appeared — the only
      // trustworthy answer to "does this player predate the ledger?"
      try { auditAssets(wallet, profile.mmo, _testFirstSeen.get(wallet) || Number(prev?.first_seen) || 0); }
      catch (e) { console.error("auditAssets threw for", String(wallet).slice(0, 8), e && e.message); }
    }
    safe._serverSavedAt = now;   // authoritative "last seen" for offline progression
    await store.setProfile(wallet, safe);
    res.json({ ok: true, serverSavedAt: safe._serverSavedAt });
  } catch (e) { res.status(500).json({ error: "save failed: " + String(e.message || e) }); }
});

app.get("/profile", async (req, res) => {
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    let p = await store.getProfile(wallet);
    // the MMO cloud-save is owner-only: strip it unless the caller proves ownership
    if (p && typeof p === "object" && p.mmo && !verifyWalletSig(wallet, req.query?.authMsg, req.query?.authSig)) {
      p = { ...p };
      delete p.mmo;
    }
    res.json({ wallet, profile: p });
  }
  catch (e) { res.status(500).json({ error: "load failed: " + String(e.message || e) }); }
});

// ADMIN: grant a wallet a normal Chiki (e.g., a whale's owed 2nd earner). Protected by ADMIN_KEY.
// GET /admin/grant-chiki?key=SECRET&wallet=PUBKEY[&sp=0-9][&nick=Name]
app.get("/admin/grant-chiki", async (req, res) => {
  const KEY = process.env.ADMIN_KEY || "";
  if (!KEY || req.query?.key !== KEY) return res.status(403).json({ error: "forbidden" });
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    const profile = (await store.getProfile(wallet)) || null;
    if (!profile || !Array.isArray(profile.chikis)) return res.status(404).json({ error: "no profile for that wallet (they must have played at least once)" });
    const normals = profile.chikis.filter(c => !c.isLegend).length;
    if (normals >= 2) return res.json({ ok: false, reason: "already has 2 normal Chikis", chikis: profile.chikis.length });
    // normal species indices 0..9 (10..14 are Legendaries); pick one not already owned if possible
    const owned = new Set(profile.chikis.map(c => c.sp | 0));
    let sp = Number.isInteger(+req.query?.sp) ? Math.max(0, Math.min(9, +req.query.sp)) : -1;
    if (sp < 0) { for (let i = 0; i < 10; i++) if (!owned.has(i)) { sp = i; break; } if (sp < 0) sp = Math.floor(Math.random() * 10); }
    const nick = (req.query?.nick ? String(req.query.nick).slice(0, 16) : null);
    profile.chikis.push({ br: 1, sp, xp: 0, food: 1800, nick, level: 1, hungry: false, tending: false, battleXp: 0, cardTier: null, isLegend: false, skillPts: 0, tasksDone: 0, arenaSkills: null, sleepCycles: 0 });
    profile._serverSavedAt = Date.now();
    await store.setProfile(wallet, profile);
    res.json({ ok: true, wallet, granted: { sp, nick }, totalChikis: profile.chikis.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ADMIN RESTITUTION: re-issue a sale receipt whose credit was lost to the settlement race (e.g. an
// auction that sold but never paid the seller). Protected by ADMIN_KEY. The receipt lands in the
// seller's /market/sales queue and their client credits the standard 75% share on the next poll —
// so this uses the SAME crediting path a normal sale would (anti-cheat/ceiling apply identically),
// it does NOT mint or bypass the clamps. GET /admin/regrant-sale?key=SECRET&wallet=PUBKEY&species=NAME&price=N
app.get("/admin/regrant-sale", (req, res) => {
  const KEY = process.env.ADMIN_KEY || "";
  if (!KEY || req.query?.key !== KEY) return res.status(403).json({ error: "forbidden" });
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  const species = String(req.query?.species || "chikimon").slice(0, 24);
  const price = Math.max(1, Math.min(1e7, Math.floor(Number(req.query?.price) || 0)));
  if (price < 1) return res.status(400).json({ error: "price (the original hammer/sale amount) required" });
  try {
    // file under the SID the seller's client actually polls (their net_id) — falling back to the
    // wallet only if we've never seen them sign in. (The client polls /market/sales?sid=net_id, so
    // filing under the raw wallet would land in a bucket no client reads — the audit's finding #3.)
    const key = walletSid[wallet] || wallet;
    const arr = marketSales[key] || (marketSales[key] = []);
    const id = "REGRANT-" + species + "-" + Date.now();
    arr.push({ id, item: species, kind: "chikimon", qty: 1, price, buyer: "restitution",
               buyerName: "Sale restitution", ts: Date.now() });
    saveMarket();
    console.log("Admin restitution: re-issued", species, price, "sale for", wallet, "under sid", key);
    res.json({ ok: true, wallet, sid: key, species, price, sellerWillNet: Math.round(price * 0.75),
      note: "Have the seller open the game — their client credits 75% on the next market sync (~30s)." });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ADMIN RECOVERY: rebuild a wallet's roster for a user whose Chikis were lost to the old overwrite bug.
// GET /admin/restore-chikis?key=SECRET&wallet=PUBKEY&roster=sp:level[:L][:Nick],sp:level,...
//   sp = species index (0-9 normal, 10-14 legendary), add ":L" to mark a legendary, optional ":Nick" name.
//   The restored Chikis are MERGED with whatever the wallet currently has (never reduces the roster).
app.get("/admin/restore-chikis", async (req, res) => {
  const KEY = process.env.ADMIN_KEY || "";
  if (!KEY || req.query?.key !== KEY) return res.status(403).json({ error: "forbidden" });
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  const spec = String(req.query?.roster || "").trim();
  if (!spec) return res.status(400).json({ error: "roster required, e.g. roster=0:12:Spike,10:8:L:Genbu" });
  const replace = (req.query?.set === "1" || req.query?.set === "true");   // set=1 → replace the whole roster with exactly this spec
  try {
    const profile = (await store.getProfile(wallet)) || {};
    if (replace || !Array.isArray(profile.chikis)) profile.chikis = [];
    const have = new Set(profile.chikis.map(c => c.sp | 0));
    let nN = profile.chikis.filter(c => !c.isLegend).length, nL = profile.chikis.filter(c => c.isLegend).length;
    const added = [];
    for (const part of spec.split(",")) {
      const f = part.split(":").map(s => s.trim());
      const sp = clampNum(f[0], 0, 14, -1); if (sp < 0) continue;
      if (have.has(sp)) continue;                                   // don't duplicate a species they already have
      const isLegend = f.includes("L") || f.includes("l") || sp >= 10;
      if (isLegend) { if (nL >= 1) continue; nL++; } else { if (nN >= 2) continue; nN++; }   // enforce hatch caps
      const lv = clampNum(f[1], 1, MAX_LEVEL, 1);
      const nick = f.find((x, i) => i >= 2 && x && x !== "L" && x !== "l") || null;
      profile.chikis.push({ sp, level: lv, isLegend, hungry: false, tending: false,
        nick: nick ? stripTags(nick).slice(0, 16) : null, xp: 0, food: foodMaxSec(lv),
        stamina: isLegend ? legStamMax(lv) : maxStamOf(lv), tasksDone: 0, sleepCycles: 0,
        renames: 0, br: 1, battleXp: 0, skillPts: 0, arenaSkills: null, cardTier: null,
        arenaStam: isLegend ? legStamMax(lv) : null, arenaSleepUntil: 0 });
      have.add(sp); added.push({ sp, level: lv, isLegend, nick });
    }
    profile._serverSavedAt = Date.now();
    await store.setProfile(wallet, profile);
    res.json({ ok: true, wallet, replace, added, totalChikis: profile.chikis.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ADMIN: gift a Chiki (normal sp 0-9, or Legendary sp 10-14) to a wallet at any level — authenticated by the
// admin's WALLET SIGNATURE (no ADMIN_KEY in the browser). Body: { adminWallet, authMsg, authSig, wallet, sp(0-14), level, nick }
let pendingGifts = {};   // wallet -> [ {id, sp, level, isLegend, nick, ts} ]  (offers awaiting accept/decline when the recipient is at cap)
async function savePendingGifts() { try { await store.kvSet("pending_gifts", pendingGifts); } catch (e) {} }
function chikiFromGift(g) { const lv = g.level;
  return { sp: g.sp, level: lv, isLegend: !!g.isLegend, hungry: false, tending: false, nick: g.nick || null, xp: 0,
    food: foodMaxSec(lv), stamina: g.isLegend ? legStamMax(lv) : maxStamOf(lv), tasksDone: 0, sleepCycles: 0, renames: 0,
    br: 1, battleXp: 0, skillPts: 0, arenaSkills: null, cardTier: null, arenaStam: g.isLegend ? legStamMax(lv) : null, arenaSleepUntil: 0 };
}
async function adminGiftChiki(req, res) {
  const { adminWallet, authMsg, authSig, wallet, sp, level, nick } = req.body || {};
  if (!isPubkey(adminWallet) || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'adminWallet' and target 'wallet' required" });
  if (!verifyWalletSig(adminWallet, authMsg, authSig)) return res.status(401).json({ error: "wallet sign-in required (approve the signature)" });
  if (!isAdminWallet(adminWallet)) return res.status(403).json({ error: "admin only" });
  const si = Number(sp);
  if (!(Number.isInteger(si) && si >= 0 && si <= 14)) return res.status(400).json({ error: "sp must be 0–14 (0–9 normal, 10–14 Legendary)" });
  const lv = Math.max(1, Math.min(MAX_LEVEL, Number(level) || 1));
  const isLegend = si >= 10;
  const gift = { id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), sp: si, level: lv, isLegend, nick: nick ? stripTags(String(nick)).slice(0, 16) : null, ts: Date.now() };
  try {
    const profile = (await store.getProfile(wallet)) || {};
    if (!Array.isArray(profile.chikis)) profile.chikis = [];
    const atCap = isLegend ? profile.chikis.some(c => c.isLegend) : profile.chikis.filter(c => !c.isLegend).length >= 2;
    if (atCap) {   // recipient is full → queue an OFFER; they accept (choose which to replace) or decline in-game
      if (!pendingGifts[wallet]) pendingGifts[wallet] = [];
      pendingGifts[wallet].push(gift); if (pendingGifts[wallet].length > 5) pendingGifts[wallet] = pendingGifts[wallet].slice(-5);
      await savePendingGifts();
      return res.json({ ok: true, pending: true, message: "recipient is at capacity — they'll be asked to accept (and pick which Chiki to replace) or decline." });
    }
    profile.chikis.push(chikiFromGift(gift));
    profile._serverSavedAt = Date.now();
    await store.setProfile(wallet, profile);
    res.json({ ok: true, pending: false, granted: { sp: si, level: lv, isLegend, nick: gift.nick } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}
app.post("/admin/gift-chiki", adminGiftChiki);
app.post("/admin/gift-legendary", adminGiftChiki);   // back-compat alias

// Admin: ban / unban a wallet from ALL reward-pool payouts (accrual claims + Cup prizes).
// Auth via ?key=ADMIN_KEY or an admin wallet (cupAdminOk). Works as POST {wallet} or GET ?wallet=.
// Admin auth for bans: a browser URL with ?key=ADMIN_KEY, OR an in-game admin who SIGNED in (spoof-proof —
// the bare-wallet path is NOT accepted here, since an unban could let a drainer back into the pool).
function banAuthOk(req) {
  if (ADMIN_KEY && (req.query?.key === ADMIN_KEY || req.body?.key === ADMIN_KEY)) return true;
  const { adminWallet, authMsg, authSig } = req.body || {};
  return isPubkey(adminWallet) && verifyWalletSig(adminWallet, authMsg, authSig) && isAdminWallet(adminWallet);
}
// ADMIN: wipe a wallet's CLOUD save (profile.mmo only). One-time repair for saves contaminated
// by the pre-slot wallet-inheritance bug: the wrong trainer's whole profile could have been
// pushed under a newcomer's wallet. Deletes ONLY the MMO cloud copy — the legacy web-game
// fields and every local save are untouched; the wallet's next login starts clean (or from
// its own local slot).
app.post("/profile/admin-wipe", async (req, res) => {
  if (!banAuthOk(req)) return res.status(403).json({ error: "admin sign-in or key required" });
  const w = req.body?.target;
  if (!isPubkey(w)) return res.status(400).json({ error: "valid target wallet required" });
  try {
    const prev = await store.getProfile(w);
    if (!prev || !prev.mmo) return res.json({ ok: true, wiped: false, note: "that wallet has no MMO cloud-save" });
    delete prev.mmo;
    prev._mmoWipedAt = Date.now();
    await store.setProfile(w, prev);
    res.json({ ok: true, wiped: true, wallet: w });
  } catch (e) { res.status(500).json({ error: "wipe failed: " + String(e.message || e) }); }
});

// `target` = wallet to (un)ban — separate from the admin's own `wallet`/`adminWallet`.
async function adminBan(req, res) {
  if (!banAuthOk(req)) return res.status(403).json({ error: "admin sign-in or key required" });
  const w = req.body?.target || req.query?.target || req.query?.wallet;
  if (!isPubkey(w)) return res.status(400).json({ error: "valid target wallet required" });
  bannedWallets.add(w); await saveBanned();
  res.json({ ok: true, banned: w, total: bannedWallets.size, list: [...bannedWallets] });
}
async function adminUnban(req, res) {
  if (!banAuthOk(req)) return res.status(403).json({ error: "admin sign-in or key required" });
  const w = req.body?.target || req.query?.target || req.query?.wallet;
  if (!isPubkey(w)) return res.status(400).json({ error: "valid target wallet required" });
  const had = bannedWallets.delete(w); await saveBanned();
  res.json({ ok: true, unbanned: w, was: had, total: bannedWallets.size, list: [...bannedWallets] });
}
app.post("/admin/ban", adminBan);   app.get("/admin/ban", adminBan);
app.post("/admin/unban", adminUnban); app.get("/admin/unban", adminUnban);
app.get("/admin/banned", (req, res) => { if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" }); res.json({ banned: [...bannedWallets] }); });

// Recipient: see pending gift offers (shown in-game when at capacity).
app.get("/gift/pending", (req, res) => {
  const w = req.query?.wallet; if (!isPubkey(w)) return res.status(400).json({ error: "wallet required" });
  res.json({ gifts: pendingGifts[w] || [] });
});
// Recipient: accept a gift (replacing one of their Chikis) or decline. Signature proves it's really them.
app.post("/gift/claim", async (req, res) => {
  const { wallet, authMsg, authSig, giftId, action, replaceIndex } = req.body || {};
  if (!isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  if (!verifyWalletSig(wallet, authMsg, authSig)) return res.status(401).json({ error: "sign-in required (approve the signature)" });
  const list = pendingGifts[wallet] || [];
  const gi = list.findIndex(g => g.id === giftId); if (gi < 0) return res.status(404).json({ error: "gift not found" });
  const g = list[gi];
  if (action === "decline") { list.splice(gi, 1); if (!list.length) delete pendingGifts[wallet]; await savePendingGifts(); return res.json({ ok: true, declined: true }); }
  try {
    const profile = (await store.getProfile(wallet)) || {}; if (!Array.isArray(profile.chikis)) profile.chikis = [];
    const ri = Number(replaceIndex);
    if (!(Number.isInteger(ri) && ri >= 0 && ri < profile.chikis.length)) return res.status(400).json({ error: "choose which Chiki to replace" });
    if (!!profile.chikis[ri].isLegend !== !!g.isLegend) return res.status(400).json({ error: "you must replace a " + (g.isLegend ? "Legendary" : "normal") + " Chiki with this " + (g.isLegend ? "Legendary" : "normal") + " gift" });
    profile.chikis[ri] = chikiFromGift(g);
    profile._serverSavedAt = Date.now(); await store.setProfile(wallet, profile);
    list.splice(gi, 1); if (!list.length) delete pendingGifts[wallet]; await savePendingGifts();
    res.json({ ok: true, accepted: true, replaced: ri, granted: { sp: g.sp, level: g.level, isLegend: g.isLegend } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Real SOL paid out to a wallet (authentic "earned" figure for the profile).
app.get("/earned", async (req, res) => {
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try { res.json({ wallet, lifetimePaid: await store.earned(wallet) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Chiki Pouch: SOL accrued and waiting to be claimed (read-only estimate, no payout).
app.get("/claimable", async (req, res) => {
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (isBanned(wallet)) return res.json({ wallet, banned: true, eligible: false, claimableSol: 0, accruedSol: 0, cupPrizeSol: 0 });   // banned → pouch shows 0, no claim button
  try {
    let bal = 0; try { bal = await chikiBalance(wallet); } catch (e) {}
    const p = await store.touch(wallet, bal >= MIN, bal);
    const eligible = !verifyOn || bal >= MIN;
    const chikis = eligible ? (chikiCount(bal, p.whale_since) || 1) : 0;   // below the hold threshold ⇒ no accrual (matches /claim)
    const lastClaim = Number(p.last_claim);
    let poolBal = 0; try { poolBal = await poolSol(); } catch (e) {}
    const pf = poolFactor(poolBal);   // pool-scaling multiplier (≥1) — bigger payouts as the treasury fills
    // Activity gating DISABLED: it was client-reported and lossy (reset the pouch to 0 on every page load).
    // Earnings are time-based again (stable). A proper server-authoritative activity model can re-enable this later.
    const minutes = Math.min((Date.now() - lastClaim) / 60000, ACCRUAL_CAP);
    const gross = Math.max(0, seededEarn(wallet, lastClaim, chikis, minutes) * pf);
    const accrued = Math.floor(gross * (1 - CLAIM_TAX) * 1e6) / 1e6;   /* net after the SOL claim tax (tax stays in treasury) */
    const cupPrize = Math.floor((cupPrizes.get(wallet) || 0) * 1e6) / 1e6;   /* won Cup SOL waiting in the pouch (no tax) */
    const claimable = Math.floor((accrued + cupPrize) * 1e6) / 1e6;
    /* seed params let the client mirror the EXACT same rarity sequence it will be paid for */
    res.json({ wallet, claimableSol: claimable, accruedSol: accrued, cupPrizeSol: cupPrize, claimGrossSol: Math.floor(gross*1e6)/1e6, claimTaxPct: Math.round(CLAIM_TAX*100), lifetimePaid: await store.earned(wallet),
      eligible, minHold: MIN, balance: bal, lastClaim, chikis, taskSec: TASK_SEC, mult: MULT, accrualCap: ACCRUAL_CAP, raritySol: RARITY_SOL, poolFactor: pf, activeMin: minutes, poolSol: Math.floor(poolBal*1e6)/1e6, poolRef: POOL_REF,
      // FULL model so the client mirrors the EXACT economics (no display↔payout drift): distribution + exact tax fraction + claim floor.
      rarityDist: RARITY_DIST, claimTaxFrac: CLAIM_TAX, minClaimSol: MIN_CLAIM, poolFactorMax: POOL_FACTOR_MAX });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Live activity: heartbeat in, get back current active users + roaming chikis.
const PRESENCE_WINDOW = 120000;   // a wallet counts as "online" for 2 min after its last beat
app.post("/presence", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    await store.heartbeat(wallet, Number(req.body?.chikis) || 1, req.body?.roster);
    onlineUsers.set(wallet, { handle: cleanText(req.body?.handle || "").slice(0, 24) || null, ts: Date.now() });
    res.json(await store.presence(PRESENCE_WINDOW));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/presence", async (_q, res) => {
  try { res.json(await store.presence(PRESENCE_WINDOW)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Roster of other online players' chikis, so each client can render a live, shared world.
app.get("/world", async (req, res) => {
  try { res.json({ chikis: await store.world(PRESENCE_WINDOW, req.query?.exclude || "", Math.min(60, Number(req.query?.cap) || 40)) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// One-time admin reset: wipe all saved game profiles (test data). Guarded by ADMIN_KEY.
app.get("/admin/reset", async (req, res) => {
  const k = req.query?.key;
  // ONLY the secret ADMIN_KEY can wipe profiles (the old hardcoded "chikiwipe" backdoor is removed).
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  try { const n = await store.resetProfiles(); res.json({ ok: true, profilesCleared: n }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// GET /admin/grant-glory-legends?key=SECRET[&amount=100] — gift Glory to EVERY wallet that owns a Legendary.
// Credits a pending-ledger (not the live profile) so it survives the client's authoritative saves;
// each player receives it on their next login/refresh.
app.get("/admin/grant-glory-legends", async (req, res) => {
  if (!ADMIN_KEY || req.query?.key !== ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  const amount = Math.max(1, Number(req.query?.amount) || 100);
  try {
    const wallets = await store.legendHolderWallets();
    for (const w of wallets) gloryCredits.set(w, (gloryCredits.get(w) || 0) + amount);
    await saveGloryCredits();
    res.json({ ok: true, grantedEach: amount, legendaryHolders: wallets.length, applied: "on each player's next login/refresh" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ----------------------------- chat API ----------------------------- */
// Send a message (global, or a DM if `to` is set). Profanity is masked server-side.
app.post("/chat/send", async (req, res) => {
  const { wallet, handle, text, to } = req.body || {};
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  // VERIFICATION REQUIRED: every chatter must prove they own this wallet with a signature (anti-impersonation)
  if (!verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig)) return res.status(401).json({ error: "wallet verification required — approve the one-time sign-in to prove you own this wallet" });
  if (Date.now() - (_lastChat.get(wallet) || 0) < 800) return res.status(429).json({ error: "slow down — you're sending messages too fast" });
  _lastChat.set(wallet, Date.now());
  /* holder verification: when on-chain checks are enabled, chatters must hold the minimum $CHIKI */
  if (verifyOn) { try { if ((await chikiBalance(wallet)) < MIN) return res.status(403).json({ error: `hold ${MIN.toLocaleString()} $CHIKI to chat` }); } catch (e) {} }
  const body = cleanText(text);
  if (!body.trim()) return res.status(400).json({ error: "empty message" });
  if (to && !isPubkey(to)) return res.status(400).json({ error: "bad recipient" });
  let pinned = false;
  if (req.body?.pin) {
    if (!(isAdminWallet(wallet) || (ADMIN_KEY && req.body?.key === ADMIN_KEY))) return res.status(403).json({ error: "not allowed to pin" });
    pinned = true;
  }
  try {
    const row = await chat.send({ ts: Date.now(), wallet, handle: cleanText(handle || "").slice(0, 24), body, to, pinned });
    if (pinned) await chat.pin(row.id, true);
    onlineUsers.set(wallet, { handle: cleanText(handle || "").slice(0, 24) || null, ts: Date.now() });
    res.json({ ok: true, message: row });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// React to a message (toggle one of the allowed emojis). Signed like chat send (anti-impersonation).
const REACT_EMOJIS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];
app.post("/chat/react", async (req, res) => {
  const { wallet, id, emoji } = req.body || {};
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig)) return res.status(401).json({ error: "wallet verification required" });
  if (!REACT_EMOJIS.includes(emoji)) return res.status(400).json({ error: "unsupported emoji" });
  const mid = Number(id); if (!(mid > 0)) return res.status(400).json({ error: "bad message id" });
  try { const rx = await chat.react(mid, emoji, wallet); if (rx == null) return res.status(404).json({ error: "message not found" }); res.json({ ok: true, id: mid, reactions: rx }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Poll for new messages (global + this wallet's DMs) and the current pinned message.
app.get("/chat", async (req, res) => {
  try { res.json(await chat.fetch(req.query?.wallet || "", Number(req.query?.since) || 0)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Pin / unpin a message (admins only).
app.post("/chat/pin", async (req, res) => {
  const { wallet, id, pin, key } = req.body || {};
  const keyOk = ADMIN_KEY && key === ADMIN_KEY;
  if (!keyOk && !verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig)) return res.status(401).json({ error: "wallet signature required" });
  if (!(keyOk || isAdminWallet(wallet))) return res.status(403).json({ error: "not allowed" });
  try { await chat.pin(Number(id), pin !== false); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Who's online right now (with handles), for the chat user list + DM picker.
app.get("/chat/online", async (_q, res) => {
  const cut = Date.now() - CHAT_WINDOW; const users = [];
  for (const [wallet, v] of onlineUsers) if (v.ts > cut)
    users.push({ wallet, handle: v.handle, short: wallet.slice(0, 4) + "…" + wallet.slice(-4), admin: isAdminWallet(wallet) });
  res.json({ users, count: users.length });
});

/* ----------------------------- real stats / leaderboard / feed API ----------------------------- */
app.get("/stats", async (_q, res) => {
  try { res.json(await getStats()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/leaderboard", async (_q, res) => {
  try { res.json(await getLeaderboard()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// GET /rewards/history?wallet= — this wallet's confirmed reward payouts, newest first
app.get("/rewards/history", async (req, res) => {
  const w = String(req.query.wallet || "");
  if (!isPubkey(w)) return res.status(400).json({ error: "valid 'wallet' required" });
  try { res.json({ ok: true, history: (await store.kvGet("payhist:" + w)) || [] }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get("/feed", async (req, res) => {
  const since = Number(req.query?.since) || 0;
  res.json({ events: feedEvents.filter(e => e.id > since) });
});
// Every Chiki ever claimed (all saved profiles, online or not) — so the world reflects real ownership.
app.get("/allchikis", async (req, res) => {
  // Degrade gracefully: the shared world is cosmetic — never 500 the client over it.
  try { res.json({ chikis: await store.allChikis(req.query?.exclude || "", Math.min(160, Number(req.query?.cap) || 120)) }); }
  catch (e) { console.error("allchikis error:", e.message||e); res.json({ chikis: [] }); }
});

app.post("/claim", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (isBanned(wallet)) return res.status(403).json({ error: "this wallet is not eligible for reward-pool payouts", banned: true });   // banned → no claims, no Cup prizes

  let bal = 0;
  try { bal = await chikiBalance(wallet); } catch (e) {}
  const belowMin = verifyOn && bal < MIN;
  const prizeOwed = cupPrizes.get(wallet) || 0;
  // Below the threshold you can't accrue — but a Cup prize you've already WON is still yours to claim.
  if (belowMin && !(prizeOwed > 0)) return res.status(403).json({ error: `below ${MIN.toLocaleString()} $CHIKI threshold`, balance: bal });
  const pRow = await store.touch(wallet, bal >= MIN, bal);
  const chikis = belowMin ? 0 : (chikiCount(bal, pRow.whale_since) || 1);   // 2nd Chiki only after the whale hold time; 0 below threshold (prize-only claim)
  let pool, daily, walletPaid;
  try { pool = await poolSol(); daily = await store.dailyTotal(); walletPaid = await store.walletDaily(wallet); }
  catch (e) { return res.status(500).json({ error: "rpc/db error: " + String(e.message || e) }); }
  if (pool <= RESERVE) return res.status(503).json({ error: "reward pool is low — payouts paused, please try again later", poolSol: pool });
  // DAILY CAP (enforced): total daily payouts are bounded to a FRACTION of the live pool, and each wallet to PER_WALLET_DAILY_SOL.
  // Cup prizes are exempt — a winner can always collect their prize even if the day's accrual caps are hit.
  const dailyCapNow = DAILY_FRAC * pool;
  if (DAILY_FRAC < 1 && daily >= dailyCapNow && !(prizeOwed > 0)) return res.status(429).json({ error: "today's reward pool cap is reached — resets over the next 24h", dailyCapSol: +dailyCapNow.toFixed(4) });
  if (WALLET_DAILY > 0 && walletPaid >= WALLET_DAILY && !(prizeOwed > 0)) return res.status(429).json({ error: `your daily claim limit (${WALLET_DAILY} ◎) is reached — come back tomorrow`, perWalletDailySol: WALLET_DAILY });

  // Activity gating DISABLED (was client-reported + lossy). Time-based earning, stable.
  const now = Date.now();
  const compute = (p) => {
    const capMs = Math.min(now - Number(p.last_claim), ACCRUAL_CAP * 60_000);   // effective earning window (bounded by the accrual cap)
    const earnMin = capMs / 60_000;
    const grossNet = seededEarn(wallet, Number(p.last_claim), chikis, earnMin) * poolFactor(pool) * (1 - CLAIM_TAX);   /* full claimable, net of tax, BEFORE caps */
    let amt = Math.min(grossNet, (CAP > 0 ? CAP : Infinity),
      (DAILY_FRAC < 1 ? Math.max(0, dailyCapNow - daily) : Infinity),             // daily pool cap (Infinity = no cap)
      (WALLET_DAILY > 0 ? Math.max(0, WALLET_DAILY - walletPaid) : Infinity),     // remaining room under this wallet's daily cap
      Math.max(0, pool - RESERVE));
    const paid = Math.floor(amt * 1e6) / 1e6;
    // Return the gross + window so reserve() can advance last_claim ONLY by the fraction actually paid —
    // a capped claim must NOT forfeit the un-paid remainder (it stays in the pouch).
    return { paid, grossNet, capMs };
  };

  let r;
  try { r = await store.reserve(wallet, now, compute); }
  catch (e) { return res.status(500).json({ error: "reserve failed: " + String(e.message || e) }); }
  if (r.status === "cooldown") return res.status(429).json({ error: "cooldown", retryInMs: r.retryInMs });
  if (r.status === "hold") return res.status(403).json({ error: "wallet too new — min hold time not met", waitMs: r.waitMs });
  // r.status is now "ok" (accrued SOL to pay) or "none" (no accrual). A Cup prize can be paid in either case.
  const base = r.status === "ok" ? r.amount : 0;
  const prizePay = Math.floor(Math.min(prizeOwed, Math.max(0, pool - RESERVE - base)) * 1e6) / 1e6;   // prize comes from the same treasury; never breach the reserve floor
  const total = Math.floor((base + prizePay) * 1e6) / 1e6;
  if (!(total > 0)) return res.status(409).json({ error: "nothing to claim yet (or pool/cap empty)", poolSol: pool });
  // Dust guard: a pure-accrual claim must clear MIN_CLAIM (a Cup prize is always claimable regardless).
  if (prizePay <= 0 && total < MIN_CLAIM) return res.status(409).json({ error: `keep earning — claims start at ${MIN_CLAIM} ◎ (you have ${total.toFixed(6)})`, minClaimSol: MIN_CLAIM, haveSol: total });

  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: treasury.publicKey, toPubkey: new PublicKey(wallet),
      lamports: Math.floor(total * LAMPORTS_PER_SOL),
    }));
    const sig = await conn.sendTransaction(tx, [treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    if (r.status === "ok") await store.confirm(r.payoutId, sig);
    if (prizePay > 0) { const left = Math.floor(((cupPrizes.get(wallet) || 0) - prizePay) * 1e6) / 1e6; if (left > 0) cupPrizes.set(wallet, left); else cupPrizes.delete(wallet); await saveCupPrizes(); }
    pushFeed("claim", { wallet, short: wallet.slice(0, 4) + "…" + wallet.slice(-4), amountSol: total, signature: sig });
    res.json({ ok: true, wallet, amountSol: total, accruedSol: base, cupPrizeSol: prizePay, signature: sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=${NETWORK}` });
  } catch (e) {
    if (r.status === "ok") await store.fail(r.payoutId, wallet, r.prevLastClaim, r.amount); // refund cooldown so a failed payout isn't lost; prize stays owed
    res.status(500).json({ error: "payout failed: " + String(e.message || e) });
  }
});

/* ============================================================================
   SERVER-AUTHORITATIVE QUEST REWARDS  →  real $CHIKI (SPL) payout
   The SERVER, not the client, decides what each wallet has earned:
     · each main quest pays a FIXED amount, exactly ONCE, only IN ORDER
     · a minimum real-time gap between completions (anti-bot pacing)
     · a hard per-wallet ceiling = the sum of all quest rewards
   Payout destination is ALWAYS the earning wallet (never client-chosen), the
   amount is ALWAYS the server ledger (never client-sent), and every payout
   passes per-claim / per-wallet-daily / pool-reserve caps AND a global hourly
   circuit breaker that auto-halts if outflow spikes. Write-before-send + a
   per-wallet lock make double-claims impossible.
   ============================================================================ */
const CHIKI_DECIMALS = Math.max(0, Number(process.env.CHIKI_DECIMALS || 6));   // pump.fun = 6
// MUST stay in sync with the client's Econ story chain (ids + order).
// CHIKORIA · THE BROKEN WHEEL — ACT I is 63 chapters client-side (9 parts of 7); THESE 21 are
// the on-chain reward ladder — the client tags them "real": true and reports ONLY these ids.
// Their ids + RELATIVE order here must match the client's real-tagged chapters exactly (the
// server enforces in-order completion); the other 42 chapters pay soft in-game $CHIKI and are
// never reported. Amounts sum to 100,000/player — unchanged by the Act I expansion.
// ALL 63 story chapters pay REAL $CHIKI (2026-07-23: the 42 former soft chapters were
// promoted). ORDER = campaign chapter order — the in-order gate walks this list.
// "bit" = the chapter's PERMANENT position in quest_rewards.done_mask (BIGINT).
// Legacy bits 0-20 belong to the original 21 chapters in their OLD list order and
// must NEVER move (live wallets hold masks minted at those positions); promoted
// chapters take bits 21-62 in chapter order. 63 bits > 32 → ALL mask math is BigInt.
const MAIN_QUESTS = [
  { id: "s_meet",      chiki: 1000, bit: 0 },   // Ch.1
  { id: "s_kill",      chiki: 1500, bit: 1 },   // Ch.2
  { id: "s_gather",    chiki: 2000, bit: 2 },   // Ch.3
  { id: "s_stone",     chiki: 2500, bit: 3 },   // Ch.4
  { id: "s_craft",     chiki: 2500, bit: 4 },   // Ch.5
  { id: "s_forage",    chiki: 3500, bit: 5 },   // Ch.6
  { id: "s_fish",      chiki: 4000, bit: 6 },   // Ch.7
  { id: "s2_flower",   chiki: 60,   bit: 21 },   // Ch.8
  { id: "s2_pork",     chiki: 70,   bit: 22 },   // Ch.9
  { id: "s2_potion",   chiki: 80,   bit: 23 },   // Ch.10
  { id: "s2_cook",     chiki: 80,   bit: 24 },   // Ch.11
  { id: "s2_train5",   chiki: 90,   bit: 25 },   // Ch.12
  { id: "s2_kill2",    chiki: 100,  bit: 26 },   // Ch.13
  { id: "s2_honey1",   chiki: 100,  bit: 27 },   // Ch.14
  { id: "s_hunt",      chiki: 5000, bit: 7 },   // Ch.15
  { id: "s_shell",     chiki: 3500, bit: 8 },   // Ch.16
  { id: "s_gear",      chiki: 4000, bit: 9 },   // Ch.17
  { id: "s_meat",      chiki: 4500, bit: 10 },   // Ch.18
  { id: "s2_comp4",    chiki: 110,  bit: 28 },   // Ch.19
  { id: "s_stock",     chiki: 5000, bit: 11 },   // Ch.20
  { id: "s2_fish2",    chiki: 120,  bit: 29 },   // Ch.21
  { id: "s2_berry2",   chiki: 130,  bit: 30 },   // Ch.22
  { id: "s2_ffish",    chiki: 150,  bit: 31 },   // Ch.23
  { id: "s2_ffgold",   chiki: 160,  bit: 32 },   // Ch.24
  { id: "s2_eggmake",  chiki: 160,  bit: 33 },   // Ch.25
  { id: "s2_tend",     chiki: 150,  bit: 34 },   // Ch.26
  { id: "s_chiki",     chiki: 5500, bit: 12 },   // Ch.27
  { id: "s2_hatch1",   chiki: 200,  bit: 35 },   // Ch.28
  { id: "s_honey",     chiki: 5500, bit: 13 },   // Ch.29
  { id: "s2_train10",  chiki: 180,  bit: 36 },   // Ch.30
  { id: "s2_ffkoi",    chiki: 220,  bit: 37 },   // Ch.31
  { id: "s2_hide",     chiki: 200,  bit: 38 },   // Ch.32
  { id: "s2_eggmount", chiki: 220,  bit: 39 },   // Ch.33
  { id: "s2_kill3",    chiki: 240,  bit: 40 },   // Ch.34
  { id: "s2_hatchmount",chiki: 280,  bit: 41 },   // Ch.35
  { id: "s2_ride",     chiki: 240,  bit: 42 },   // Ch.36
  { id: "s_ore",       chiki: 5500, bit: 14 },   // Ch.37
  { id: "s2_list",     chiki: 260,  bit: 43 },   // Ch.38
  { id: "s2_sold",     chiki: 280,  bit: 44 },   // Ch.39
  { id: "s2_buy",      chiki: 260,  bit: 45 },   // Ch.40
  { id: "s2_merchant", chiki: 300,  bit: 46 },   // Ch.41
  { id: "s_angler",    chiki: 6000, bit: 15 },   // Ch.42
  { id: "s2_train15",  chiki: 320,  bit: 47 },   // Ch.43
  { id: "s2_ffeel",    chiki: 360,  bit: 48 },   // Ch.44
  { id: "s2_ore2",     chiki: 340,  bit: 49 },   // Ch.45
  { id: "s2_eggleg",   chiki: 380,  bit: 50 },   // Ch.46
  { id: "s_slayer",    chiki: 7500, bit: 16 },   // Ch.47
  { id: "s_forge2",    chiki: 7000, bit: 17 },   // Ch.48
  { id: "s2_hatchleg", chiki: 450,  bit: 51 },   // Ch.49
  { id: "s_crystal",   chiki: 7500, bit: 18 },   // Ch.50
  { id: "s_train",     chiki: 7500, bit: 19 },   // Ch.51
  { id: "s2_train20",  chiki: 420,  bit: 52 },   // Ch.52
  { id: "s2_ffrain1",  chiki: 500,  bit: 53 },   // Ch.53
  { id: "s2_scroll",   chiki: 500,  bit: 54 },   // Ch.54
  { id: "s2_kill4",    chiki: 420,  bit: 55 },   // Ch.55
  { id: "s2_comp14",   chiki: 450,  bit: 56 },   // Ch.56
  { id: "s2_ffrain10", chiki: 600,  bit: 57 },   // Ch.57
  { id: "s2_eggmeme",  chiki: 550,  bit: 58 },   // Ch.58
  { id: "s2_hatchmeme",chiki: 600,  bit: 59 },   // Ch.59
  { id: "s2_kill5",    chiki: 550,  bit: 60 },   // Ch.60
  { id: "s2_crystal2", chiki: 550,  bit: 61 },   // Ch.61
  { id: "s2_feast",    chiki: 600,  bit: 62 },   // Ch.62
  { id: "s_ascend",    chiki: 9000, bit: 20 },   // Ch.63
];
// Per-quest $CHIKI rewards accrue to a per-player pouch (admin-released, SEPARATE from the grand prize).
const QUEST_REWARD_AMT   = new Map(MAIN_QUESTS.map(q => [q.id, q.chiki || 0]));
const QUEST_BIT          = new Map(MAIN_QUESTS.map(q => [q.id, 1n << BigInt(q.bit)]));   // BigInt — bits reach 62
const QUEST_REWARD_TOTAL = MAIN_QUESTS.reduce((a, q) => a + (q.chiki || 0), 0);   // 112030 per player when all done
// mask may arrive as Number, numeric string (pg BIGINT), or BigInt — normalize to BigInt
function questMask(mask) { try { return BigInt(mask || 0); } catch (e) { return 0n; } }
function questEarned(mask) { const m = questMask(mask); let s = 0; for (const q of MAIN_QUESTS) if (m & QUEST_BIT.get(q.id)) s += (q.chiki || 0); return s; }
// REWARD MODEL — race to finish, ADMIN-GATED payout. The first WINNER_CAP wallets to COMPLETE THE WHOLE
// questline are recorded as winners atomically (cross-instance safe, once each). NO $CHIKI is sent on
// completion. An admin reviews the list and releases the pool in one idempotent, on-chain-reconciled batch
// (POST /quest/payout, admin-signed). Hard total = WINNER_CAP * WINNER_REWARD (default 10*1,000,000 = 10,000,000).
const WINNER_CAP    = Math.max(0, Number(process.env.WINNER_CAP    || 10));
const WINNER_REWARD = Math.max(0, Number(process.env.WINNER_REWARD || 1000000));
const FINAL_QUEST   = MAIN_QUESTS[MAIN_QUESTS.length - 1].id;
const QUEST_IDX     = new Map(MAIN_QUESTS.map((q, i) => [q.id, i]));
// OPTIONAL chapters (the market counterparty ones): the client lets a solo player skip these
// because they can't sell-to / buy-from another trainer. The in-order gate below MUST NOT require
// them as predecessors, or a skipped optional chapter permanently 409-stalls every later real
// reward (Ch.42..63) and the 1,000,000 winner slot. Keep in sync with Econ.gd "optional": true.
const QUEST_OPTIONAL = new Set(["s2_sold", "s2_buy", "s2_merchant"]);
const QUEST_MIN_GAP_MS = Math.max(0, Number(process.env.QUEST_MIN_GAP_SEC ?? 20)) * 1000;
// Winner eligibility — FAIL-CLOSED (enforced on the reward path regardless of VERIFY_HOLDERS):
const QUEST_MIN_HOLD = Math.max(0, Number(process.env.QUEST_MIN_HOLD || MIN));                       // must hold >= this $CHIKI
const QUEST_HOLD_MS  = Math.max(0, Number(process.env.QUEST_MIN_HOLD_MINUTES || 60)) * 60_000;       // wallet must be aged-in (anti-sybil)
const QKEY = (w) => "quest:" + w;   // per-wallet PROGRESS ledger (done map + throttle) — NOT money
async function _questLoad(wallet) {
  let led = null;
  try { led = await store.kvGet(QKEY(wallet)); } catch (e) {}
  if (!led || typeof led !== "object") led = {};
  led.done   = (led.done && typeof led.done === "object") ? led.done : {};
  led.lastAt = Number(led.lastAt) || 0;
  return led;
}
async function _questSave(wallet, led) { try { await store.kvSet(QKEY(wallet), led); } catch (e) {} }
// Send `amt` whole $CHIKI, returning the signature WITHOUT awaiting confirmation, so the caller can durably
// record the sig BEFORE confirming — the crux of an idempotent, non-double-paying payout.
async function sendChikiRaw(destWallet, amt) {
  // TOKEN-2022 mint: derive both ATAs against the Token-2022 program AND pass it to the
  // transfer ix — the defaults target legacy Tokenkeg and fail with InvalidAccountData.
  const destPk = new PublicKey(destWallet);
  const src = getAssociatedTokenAddressSync(MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(MINT, destPk, false, TOKEN_2022_PROGRAM_ID);
  const raw = BigInt(Math.round(amt * 10 ** CHIKI_DECIMALS));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  const tx = new Transaction()
    // winner may have emptied/closed their token account — recreate it idempotently (treasury pays ~0.002 SOL rent)
    .add(createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, dst, destPk, MINT, TOKEN_2022_PROGRAM_ID))
    .add(createTransferCheckedInstruction(src, MINT, dst, treasury.publicKey, raw, CHIKI_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  tx.recentBlockhash = blockhash; tx.feePayer = treasury.publicKey;
  const sig = await conn.sendTransaction(tx, [treasury]);
  return { sig, lastValidBlockHeight };
}
// durable per-wallet payout history — the in-game "reward received" toast + Ledger history
// read this. Appended ONLY on a confirmed on-chain landing; capped at the 50 newest.
async function recordPayout(wallet, kind, amount, sig) {
  try {
    const key = "payhist:" + wallet;
    const cur = (await store.kvGet(key)) || [];
    const list = Array.isArray(cur) ? cur : [];
    list.unshift({ kind, amount, sig, ts: Date.now() });
    await store.kvSet(key, list.slice(0, 50));
  } catch (e) { /* history is best-effort — never block a payout on it */ }
}

async function sigLanded(sig) {   // true = confirmed on-chain with no error; false = not found / failed
  if (!sig) return false;
  try { const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }); const s = st.value[0];
    return !!(s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")); }
  catch (e) { return false; }
}
// True only if `sig` is a SUCCESSFUL tx that moved >= `amount` of MINT FROM the treasury TO `wallet`.
// Guards admin reconcile paths so a random/mismatched sig can't falsely mark a payout done (prize-denial).
async function txPaid(sig, wallet, amount, exact) {
  try {
    const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || (tx.meta && tx.meta.err)) return false;
    const mint = MINT.toBase58(), treas = treasury.publicKey.toBase58();
    const pre = (tx.meta && tx.meta.preTokenBalances) || [], post = (tx.meta && tx.meta.postTokenBalances) || [];
    const amt = (arr, owner) => { const e = arr.find(b => b.owner === owner && b.mint === mint); return e ? Number((e.uiTokenAmount && e.uiTokenAmount.uiAmount) || 0) : 0; };
    const dWallet = amt(post, wallet) - amt(pre, wallet);
    const dTreas  = amt(post, treas)  - amt(pre, treas);
    if (exact) return Math.abs(dWallet - amount) <= 0.5 && dTreas <= -(amount - 0.5);
    return dWallet >= amount - 0.5 && dTreas <= -(amount - 0.5);
  } catch (e) { return false; }
}
// Scan the winner's $CHIKI token account for an existing treasury->winner reward transfer; returns its sig or null.
// Lets reconcile POSITIVELY confirm a sent-but-unrecorded payout so `clear` can never wipe an already-paid winner.
async function findTreasuryPayment(wallet, amount, exact) {
  try {
    const dst = getAssociatedTokenAddressSync(MINT, new PublicKey(wallet), false, TOKEN_2022_PROGRAM_ID);
    const sigs = await conn.getSignaturesForAddress(dst, { limit: 40 });
    for (const s of sigs) { if (s.err) continue; if (await txPaid(s.signature, wallet, amount, exact)) return s.signature; }
  } catch (e) {}
  return null;
}

// POST /quest/complete — record questline progress; the FINAL quest atomically reserves a winner slot (no payout).
app.post("/quest/complete", async (req, res) => {
  const wallet = req.body?.wallet;
  const questId = String(req.body?.questId || "");
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!QUEST_IDX.has(questId)) return res.status(400).json({ error: "unknown quest" });
  if (isBanned(wallet)) return res.status(403).json({ error: "not eligible", banned: true });
  const isFinal = questId === FINAL_QUEST;
  // AUTH MODEL: this game connects wallets by PUBLIC ADDRESS ONLY — it promises users it never asks for a
  // signature. So quest completion CANNOT prove wallet ownership by signature. Reward integrity therefore
  // rests on: the HOLDER GATE (>= QUEST_MIN_HOLD, re-checked at payout), the HOLD-TIME (aged wallet), and
  // ADMIN REVIEW before any payout is released (a 3rd party can complete quests for any holder's address,
  // so the admin must eyeball the winner/pouch lists before releasing). Admin PAYOUT endpoints ARE
  // signature-gated (the operator signs with a tool, not the game). See REWARD_SECURITY.md.
  try {
    const led = await _questLoad(wallet);
    const idx = QUEST_IDX.get(questId);
    if (led.done[questId]) {
      // SELF-HEAL: completions recorded before the per-quest pouch shipped (or whose accrual
      // write failed) have a done entry but no pouch bit — back-fill it here, idempotently.
      try { await store.qrAccrue(wallet, QUEST_BIT.get(questId) || 0); } catch (e) { console.error("qrAccrue(already) failed", wallet, questId, String(e.message || e)); }
      const wrow = isFinal ? await store.winnerGet(wallet) : null;
      return res.json({ ok: true, already: true, questId, finished: isFinal, won: !!wrow, rank: wrow ? wrow.rank : 0, done: Object.keys(led.done) });
    }
    for (let i = 0; i < idx; i++) { const pid = MAIN_QUESTS[i].id; if (QUEST_OPTIONAL.has(pid)) continue; if (!led.done[pid]) return res.status(409).json({ error: "complete earlier chapters first", need: pid }); }
    const now = Date.now();
    if (now - led.lastAt < QUEST_MIN_GAP_MS) return res.status(429).json({ error: "too fast — pace yourself", retryInMs: QUEST_MIN_GAP_MS - (now - led.lastAt) });

    let award = null;
    if (isFinal) {
      if (MINT && store.kind !== "postgres") return res.status(503).json({ error: "reward campaign temporarily unavailable (a database is required)" });
      // FAIL-CLOSED eligibility, independent of VERIFY_HOLDERS: must currently hold the stake AND be aged-in.
      let bal = 0;
      try { bal = await chikiBalance(wallet, true); } catch (e) { return res.status(503).json({ error: "eligibility check unavailable — try again" }); }
      if (bal < QUEST_MIN_HOLD) return res.status(403).json({ error: `hold at least ${QUEST_MIN_HOLD} $CHIKI to qualify for a winner slot`, balance: bal });
      if (QUEST_HOLD_MS > 0) { const fs = await store.firstSeen(wallet);
        if (!fs || now - fs < QUEST_HOLD_MS) return res.status(403).json({ error: "wallet too new to qualify — winner slots require an aged wallet (anti-sybil)", waitMs: fs ? QUEST_HOLD_MS - (now - fs) : QUEST_HOLD_MS }); }
      // ATOMIC, cross-instance-safe slot reservation (advisory lock + unique wallet + cap check in one tx).
      award = await store.reserveWinner(wallet, WINNER_CAP, bal, now);
    }
    led.done[questId] = now;
    led.lastAt = now;
    // Accrue this quest's per-quest reward to the admin-released pouch (idempotent via the done_mask bit).
    try { await store.qrAccrue(wallet, QUEST_BIT.get(questId) || 0); } catch (e) { console.error("qrAccrue failed", wallet, questId, String(e.message || e)); }
    await _questSave(wallet, led);
    res.json({ ok: true, questId, finished: isFinal,
      won: !!(award && award.won), rank: award ? (award.rank || 0) : 0,
      winnersRemaining: await store.winnersRemaining(WINNER_CAP),
      poolFull: !!(award && !award.won), done: Object.keys(led.done) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Per-quest reward pouch payout (admin-released, variable amount = earned - already paid) ----
// Mirrors _payoutOne: history-aware reconcile, blockhash-expiry-gated resend, payout-time balance
// re-check, never-blind-resend guard. The amount is variable (owed), so the in-flight amount is
// recorded with the sig and confirmed exactly.
async function _payoutQuestReward(wallet) {
  let begin;
  try { begin = await store.qrPayoutBegin(wallet); }
  catch (e) { return { error: "lock failed: " + String(e.message || e) }; }
  if (begin.state === "none")     return { skipped: "no quest rewards accrued" };
  if (begin.state === "inflight") return { pending: true, signature: begin.sig, note: "a payout attempt is in flight — retry shortly" };
  if (begin.priorSig) {
    if (await sigLanded(begin.priorSig)) { await store.qrPayoutConfirm(wallet, begin.priorAmount || 0); return { paid: true, reconciled: true, signature: begin.priorSig, amount: begin.priorAmount }; }
    const bh = await conn.getBlockHeight("finalized").catch(() => 0);
    if (!begin.priorLvbh || bh <= Number(begin.priorLvbh)) return { pending: true, signature: begin.priorSig, note: "prior tx not yet expired — retry shortly" };
  } else if (begin.priorAt) {
    return { pending: true, needsReconcile: true, note: "a prior payout attempt was not durably recorded — resolve via /quest/rewards/reconcile before releasing (not auto-resending, to avoid a double-pay)" };
  }
  const owed = Math.floor(Math.min(QUEST_REWARD_TOTAL, questEarned(begin.doneMask)) - (begin.paidAmount || 0));
  if (owed < 1) { await store.qrPayoutClear(wallet).catch(() => {}); return { skipped: "nothing owed", earned: questEarned(begin.doneMask), paid: begin.paidAmount }; }
  // OWNER POLICY (2026-07-22): eligibility is checked when the reward is EARNED (hold + age
  // gates on the final quest). Selling afterwards no longer forfeits the payout — no
  // at-payout balance re-check. Burn/system addresses are unpayable black holes: skip them.
  if (wallet === "11111111111111111111111111111111") { await store.qrPayoutClear(wallet).catch(() => {}); return { skipped: "system/burn address — unpayable" }; }
  const now = Date.now();
  let out;
  try { out = await sendChikiRaw(wallet, owed); }
  catch (e) { return { error: "send failed: " + String(e.message || e), needsReconcile: true, note: "send errored and a tx MAY have broadcast — resolve via /quest/rewards/reconcile before retrying" }; }
  let recorded = false;
  for (let i = 0; i < 3 && !recorded; i++) { try { await store.qrPayoutRecordSig(wallet, out.sig, out.lastValidBlockHeight, owed, now); recorded = true; } catch (e) { await new Promise(r => setTimeout(r, 400 * (i + 1))); } }
  let landed = false;
  try { await conn.confirmTransaction(out.sig, "confirmed"); landed = true; } catch (e) { landed = await sigLanded(out.sig); }
  if (landed) {
    for (let i = 0; i < 3; i++) { try { await store.qrPayoutConfirm(wallet, owed); recorded = true; break; } catch (e) { await new Promise(r => setTimeout(r, 400 * (i + 1))); } }
    pushFeed("questreward", { wallet, short: wallet.slice(0, 4) + "…" + wallet.slice(-4), chikiPaid: owed, signature: out.sig });
    await recordPayout(wallet, "quest", owed, out.sig);
    return { paid: true, signature: out.sig, amount: owed, recorded };
  }
  if (!recorded) return { sent: true, unrecorded: true, signature: out.sig, amount: owed, note: "SENT but the sig could not be recorded — reconcile via /quest/rewards/reconcile before re-running" };
  return { sent: true, unconfirmed: true, signature: out.sig, amount: owed, note: "sent but not yet confirmed — re-run payout to reconcile" };
}

// POST /quest/rewards {adminWallet,authMsg,authSig} — list per-quest reward pouches + amounts owed (admin only)
app.post("/quest/rewards", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_rewards"))) return res.status(401).json({ error: "admin signature required (action:quest_rewards + fresh nonce)" });
  try {
    const rows = await store.qrList(9999);
    let owedTotal = 0;
    const players = rows.map(r => { const earned = Math.min(QUEST_REWARD_TOTAL, questEarned(r.done_mask)); const paid = Number(r.paid_amount) || 0; const owed = Math.max(0, Math.floor(earned - paid)); owedTotal += owed; return { wallet: r.wallet, earned, paid, owed }; });
    res.json({ ok: true, count: players.length, owedTotalChiki: owedTotal, perPlayerMax: QUEST_REWARD_TOTAL, players });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /quest/rewards/payout {adminWallet,authMsg,authSig, wallet?, max?} — release owed pouches (admin batch; idempotent)
app.post("/quest/rewards/payout", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_rewards_payout"))) return res.status(401).json({ error: "admin signature required (action:quest_rewards_payout + fresh nonce)" });
  if (!MINT) return res.status(503).json({ error: "token payouts are not configured" });
  if (store.kind !== "postgres") return res.status(503).json({ error: "reward store unavailable — a database is required for payouts" });
  try {
    const only = (req.body?.wallet && isPubkey(req.body.wallet)) ? req.body.wallet : null;
    const max = Math.max(1, Math.min(25, Number(req.body?.max) || 10));
    const targets = only ? [only] : (await store.qrList(max)).map(r => r.wallet);
    const results = [];
    for (const w of targets) results.push({ wallet: w, ...(await _payoutQuestReward(w)) });
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /quest/rewards/reconcile {adminWallet,authMsg,authSig, wallet, sig?, clear?} — resolve a stuck quest-reward payout
app.post("/quest/rewards/reconcile", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_rewards_reconcile"))) return res.status(401).json({ error: "admin signature required (action:quest_rewards_reconcile + fresh nonce)" });
  if (store.kind !== "postgres") return res.status(503).json({ error: "reward store unavailable — a database is required" });
  const wallet = req.body?.wallet;
  if (!isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    const r = await store.qrGet(wallet);
    if (!r) return res.status(404).json({ error: "no quest rewards for this wallet" });
    // expected in-flight amount = recorded payout_amount, or (if the record write failed) the recomputed owed.
    const owedNow = Math.floor(Math.min(QUEST_REWARD_TOTAL, questEarned(r.done_mask)) - (Number(r.paid_amount) || 0));
    const expectAmt = (Number(r.payout_amount) || 0) >= 1 ? Number(r.payout_amount) : owedNow;
    const sig = req.body?.sig ? String(req.body.sig) : null;
    if (sig) {
      if (!(await sigLanded(sig))) return res.status(409).json({ error: "that signature did not land on-chain (or isn't final yet)" });
      if (expectAmt < 1 || !(await txPaid(sig, wallet, expectAmt, true))) return res.status(409).json({ error: `that transaction is not an EXACT treasury→wallet transfer of ${expectAmt} $CHIKI to this wallet` });
      await store.qrPayoutConfirm(wallet, expectAmt);
      return res.json({ ok: true, markedPaid: true, amount: expectAmt, signature: sig });
    }
    if (expectAmt >= 1) { const found = await findTreasuryPayment(wallet, expectAmt, true); if (found) { await store.qrPayoutConfirm(wallet, expectAmt); return res.json({ ok: true, markedPaid: true, reconciled: true, amount: expectAmt, signature: found }); } }
    if (req.body?.clear === true) { await store.qrPayoutClear(wallet); return res.json({ ok: true, cleared: true, note: "in-flight marker cleared — payout can be retried (only after verifying on-chain that the in-flight tx did NOT land)" }); }
    return res.status(409).json({ error: "no matching on-chain payment found; if you've verified none landed, pass clear:true to re-arm a retry" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// GET /quest/state — progress + winner/payout status for this wallet
app.get("/quest/state", async (req, res) => {
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    const led = await _questLoad(wallet);
    const wrow = await store.winnerGet(wallet);
    const qr = (await store.qrGet(wallet)) || {};
    // SELF-HEAL: the pouch mask must cover every chapter the ledger says is done. Chapters
    // reported before the pouch feature shipped (or whose accrual write failed) are missing
    // their bit — back-fill on this read path so every player heals on their next login.
    let qrMask = questMask(qr.done_mask);
    let ledMask = 0n;
    for (const qid of Object.keys(led.done)) ledMask |= (QUEST_BIT.get(qid) || 0n);
    if ((ledMask & ~qrMask) !== 0n) {
      try { await store.qrAccrue(wallet, ledMask); qrMask |= ledMask; }
      catch (e) { console.error("qrAccrue(state-heal) failed", wallet, String(e.message || e)); }
    }
    const qrEarned = questEarned(qrMask), qrPaid = Number(qr.paid_amount) || 0;
    res.json({ wallet, done: Object.keys(led.done), finished: !!led.done[FINAL_QUEST],
      won: !!wrow, rank: wrow ? wrow.rank : 0, paid: !!(wrow && wrow.paid),
      payoutSig: (wrow && wrow.paid) ? wrow.payout_sig : null,
      questRewardEarned: qrEarned, questRewardPaid: qrPaid, questRewardTotal: QUEST_REWARD_TOTAL,
      prize: WINNER_REWARD, winnerCap: WINNER_CAP, winnersRemaining: await store.winnersRemaining(WINNER_CAP) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /quest/claim — STATUS ONLY (payouts are an admin batch, never user-triggered). No token transfer here.
app.post("/quest/claim", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    const wrow = await store.winnerGet(wallet);
    if (!wrow) {
      const qr = (await store.qrGet(wallet)) || {};
      const earned = Math.min(QUEST_REWARD_TOTAL, questEarned(qr.done_mask));
      const paid = Number(qr.paid_amount) || 0;
      const owed = Math.max(0, Math.floor(earned - paid));
      return res.json({ ok: true, won: false, questRewardEarned: earned,
        questRewardPaid: paid, owed, status: owed > 0 ? "queued" : "none",
        winnersRemaining: await store.winnersRemaining(WINNER_CAP),
        message: owed > 0 ? `${owed} $CHIKI is queued for the next reward-pool release.` : "No quest reward is currently owed." });
    }
    res.json({ ok: true, won: true, rank: wrow.rank, prize: WINNER_REWARD,
      paid: !!wrow.paid, payoutSig: wrow.paid ? wrow.payout_sig : null,
      status: wrow.paid ? "paid" : "queued",
      message: wrow.paid ? "Your reward has been sent!" : `You're winner #${wrow.rank}! Your ${WINNER_REWARD} $CHIKI will be sent from the reward pool.` });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- ADMIN: review winners + release the pool (idempotent, on-chain-reconciled, admin-signed) ----
// Admin auth for money ops: valid wallet sig + admin + ACTION-bound + fresh(<=5min) + SINGLE-USE nonce (no replay).
async function _questAdminOk(body, action) {
  const w = body?.adminWallet, msg = String(body?.authMsg || "");
  if (!isPubkey(w) || !isAdminWallet(w)) return false;
  if (!verifyWalletSig(w, msg, body?.authSig)) return false;
  if (!msg.includes("action:" + action)) return false;                                   // bind to THIS action (blocks cross-endpoint replay)
  const tm = msg.match(/ts:(\d+)/); if (!tm || Date.now() - Number(tm[1]) > 5 * 60 * 1000) return false;   // tight window for money ops
  const nm = msg.match(/nonce:([A-Za-z0-9_-]{8,})/); if (!nm) return false;
  const nkey = "qnonce:" + nm[1];
  try { if (await store.kvGet(nkey)) return false; await store.kvSet(nkey, { used: Date.now(), action, w }); } catch (e) { return false; }   // consume once
  return true;
}

// POST /quest/winners {adminWallet,authMsg,authSig} — winner list (admin only; POST so creds never land in URL/logs)
app.post("/quest/winners", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_winners"))) return res.status(401).json({ error: "admin signature required (sign a message containing action:quest_winners + a fresh nonce)" });
  try {
    const rows = await store.winnersList();
    const paid = rows.filter(r => r.paid).length;
    res.json({ cap: WINNER_CAP, prize: WINNER_REWARD, total: rows.length, paid, unpaid: rows.length - paid,
      poolNeededChiki: (rows.length - paid) * WINNER_REWARD, winners: rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /quest/payout {adminWallet,authMsg,authSig, wallet?, max?} — release $CHIKI to unpaid winners, idempotently.
app.post("/quest/payout", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_payout"))) return res.status(401).json({ error: "admin signature required (sign a message containing action:quest_payout + a fresh nonce)" });
  if (!MINT) return res.status(503).json({ error: "token payouts are not configured" });
  if (store.kind !== "postgres") return res.status(503).json({ error: "reward store unavailable — a database is required for payouts" });
  const only = (req.body?.wallet && isPubkey(req.body.wallet)) ? req.body.wallet : null;
  const max  = Math.max(1, Math.min(25, Number(req.body?.max) || 10));   // small batches; call repeatedly
  try {
    const targets = only ? [only] : (await store.winnersUnpaid(max)).map(r => r.wallet);
    const results = [];
    for (const w of targets) results.push(Object.assign({ wallet: w }, await _payoutOne(w)));
    res.json({ ok: true, prize: WINNER_REWARD, processed: results.length, results,
      remainingUnpaid: (await store.winnersUnpaid(9999)).length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /quest/reconcile {adminWallet,authMsg,authSig, wallet, sig?, clear?} — resolve a stuck winner (admin, action-bound).
app.post("/quest/reconcile", async (req, res) => {
  if (!(await _questAdminOk(req.body, "quest_reconcile"))) return res.status(401).json({ error: "admin signature required (action:quest_reconcile + fresh nonce)" });
  if (store.kind !== "postgres") return res.status(503).json({ error: "reward store unavailable — a database is required" });
  const wallet = req.body?.wallet;
  if (!isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try {
    const w = await store.winnerGet(wallet);
    if (!w) return res.status(404).json({ error: "not a winner" });
    if (w.paid) return res.json({ ok: true, alreadyPaid: true, signature: w.payout_sig });
    const sig = req.body?.sig ? String(req.body.sig) : null;
    if (sig) {
      if (!(await sigLanded(sig))) return res.status(409).json({ error: "that signature did not land on-chain (or isn't final yet)" });
      if (!(await txPaid(sig, wallet, WINNER_REWARD))) return res.status(409).json({ error: `that transaction is not a treasury→wallet transfer of ${WINNER_REWARD} $CHIKI to this winner` });
      await store.payoutConfirm(wallet, sig);
      return res.json({ ok: true, markedPaid: true, signature: sig });
    }
    // No sig given: POSITIVELY scan the chain for an existing treasury->winner payment (covers sent-but-unrecorded).
    const found = await findTreasuryPayment(wallet, WINNER_REWARD);
    if (found) { await store.payoutConfirm(wallet, found); return res.json({ ok: true, markedPaid: true, reconciled: true, signature: found }); }
    if (req.body?.clear === true) { await store.payoutClear(wallet); return res.json({ ok: true, cleared: true, note: "no on-chain payment to this winner was found — marker cleared; a payout retry is now safe" }); }
    return res.status(409).json({ error: "no treasury payment to this winner found on-chain; if you've independently verified none landed, pass clear:true to re-arm a retry" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Idempotent single-winner payout. Serialized per-wallet in the DB; reconciles any prior in-flight tx
// on-chain BEFORE sending a new one, so a confirm timeout / retry can never double-pay.
async function _payoutOne(wallet) {
  let begin;
  try { begin = await store.payoutBegin(wallet); }
  catch (e) { return { error: "lock failed: " + String(e.message || e) }; }
  if (begin.state === "notwinner") return { skipped: "not a winner" };
  if (begin.state === "already")   return { paid: true, reused: true, signature: begin.sig };
  if (begin.state === "inflight")  return { pending: true, signature: begin.sig, note: "a payout attempt is in flight — retry shortly" };
  // Reconcile any prior attempt on-chain (history-aware) BEFORE resending, so a confirm-timeout never double-pays.
  if (begin.priorSig) {
    if (await sigLanded(begin.priorSig)) { await store.payoutConfirm(wallet, begin.priorSig); return { paid: true, reconciled: true, signature: begin.priorSig }; }
    // Resend only once the prior tx's blockhash has PROVABLY expired (can no longer land) — not on a wall-clock guess.
    const bh = await conn.getBlockHeight("finalized").catch(() => 0);
    if (!begin.priorLvbh || bh <= Number(begin.priorLvbh)) return { pending: true, signature: begin.priorSig, note: "prior tx not yet expired — retry shortly" };
  } else if (begin.priorAt) {
    // A prior attempt stamped payout_at but NO sig is on record — a send may have landed whose sig we lost (DB fault
    // mid-send). NEVER blind-resend; require the operator to verify on-chain and resolve via /quest/reconcile.
    return { pending: true, needsReconcile: true, note: "a prior payout attempt was not durably recorded — verify on-chain and resolve via /quest/reconcile before releasing (NOT auto-resending, to avoid a double-pay)" };
  }
  // Anti-sybil: the winner must STILL hold the stake at payout time (defeats flash/cycled-stake capture of all slots).
  if (wallet === "11111111111111111111111111111111") { await store.payoutClear(wallet).catch(() => {}); return { skipped: "system/burn address — unpayable" }; }

  const now = Date.now();
  let out;
  try { out = await sendChikiRaw(wallet, WINNER_REWARD); }
  catch (e) { return { error: "send failed: " + String(e.message || e), needsReconcile: true, note: "send errored and a tx MAY have broadcast — verify on-chain and resolve via /quest/reconcile before retrying (not auto-clearing, to avoid a double-pay)" }; }
  // DURABLY record the sig with retries — a lost sig here is what would let a later run blind-resend (guarded above too).
  let recorded = false;
  for (let i = 0; i < 3 && !recorded; i++) {
    try { await store.payoutRecordSig(wallet, out.sig, out.lastValidBlockHeight, now); recorded = true; }
    catch (e) { await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  let landed = false;
  try { await conn.confirmTransaction(out.sig, "confirmed"); landed = true; }
  catch (e) { landed = await sigLanded(out.sig); }
  if (landed) {
    for (let i = 0; i < 3; i++) { try { await store.payoutConfirm(wallet, out.sig); recorded = true; break; } catch (e) { await new Promise(r => setTimeout(r, 400 * (i + 1))); } }
    pushFeed("questwin", { wallet, short: wallet.slice(0, 4) + "…" + wallet.slice(-4), chikiPaid: WINNER_REWARD, signature: out.sig });
    await recordPayout(wallet, "winner", WINNER_REWARD, out.sig);
    return { paid: true, signature: out.sig, recorded };
  }
  if (!recorded) return { sent: true, unrecorded: true, signature: out.sig, note: "SENT but the sig could not be recorded — reconcile via /quest/reconcile with THIS signature before re-running payout (do NOT blind-retry)" };
  return { sent: true, unconfirmed: true, signature: out.sig, note: "sent but not yet confirmed — re-run payout to reconcile" };
}


/* ----------------------------- Chikoria Cup endpoints ----------------------------- */
// Public: current cup state (pass ?wallet= for your own registration/prize info)
app.get("/cup/status", async (req, res) => {
  try { res.json(cupSnapshot(req.query?.wallet && isPubkey(req.query.wallet) ? req.query.wallet : null)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Player: enter the cup — deducts the Glory entry fee from the stored profile, seats a clamped snapshot.
app.post("/cup/register", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!liveCup || liveCup.state.status !== "registration") return res.status(409).json({ error: "registration is not open" });
  if (!cupPublic && !isAdminWallet(wallet)) return res.status(403).json({ error: "the Cup isn't open to the public yet" });
  if (liveCup.state.entrants.find(e => e.wallet === wallet)) return res.status(409).json({ error: "already registered" });
  if (liveCup.state.entrants.length >= liveCup.state.cap) return res.status(409).json({ error: "the Cup is full" });
  try {
    const prof = await store.getProfile(wallet);
    if (!prof) return res.status(403).json({ error: "play first — no saved profile found" });
    const fee = liveCup.state.entryGlory;
    const glory = Number(prof.glory) || 0;
    if (glory < fee) return res.status(402).json({ error: `need ${fee} ✨ Glory to enter (you have ${Math.floor(glory)})`, glory });
    const built = await cupSnapFromBody(wallet, req.body?.snap || {});
    if (built.error) return res.status(403).json({ error: built.error });
    if (fee > 0) {
      prof.glory = glory - fee; await store.setProfile(wallet, prof);
      cupPayers.set(wallet, (cupPayers.get(wallet) || 0) + fee); await savePayers();   // remember how much they paid, so a reset can refund it
    }
    liveCup.register(wallet, built.snap);
    await persistCup();
    res.json({ ok: true, gloryLeft: prof.glory, ...cupSnapshot(wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Player: lock in (ready up) for the current round.
app.post("/cup/ready", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!liveCup || liveCup.state.status !== "live") return res.status(409).json({ error: "no live round" });
  try { const ok = liveCup.ready(wallet); if (!ok) return res.status(404).json({ error: "you're not in this cup" }); await persistCup(); res.json({ ok: true, ...cupSnapshot(wallet) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: create a fresh cup (registration opens immediately).
app.post("/cup/create", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  try {
    const entryGlory = req.body?.entryGlory != null ? Math.max(0, Number(req.body.entryGlory) || 0) : 100;   // 100 ✨ Glory entry by default
    const prizePool = Math.max(0, Number(req.body?.prizePool) || 4.0);
    const cap = [8, 10, 16].includes(Number(req.body?.cap)) ? Number(req.body.cap) : 10;
    // REFUND THE PREVIOUS LOBBY: anyone seated in the cup being replaced gets their entry Glory back,
    // so players who paid are never burned by a reset.
    let refunded = 0, refundEach = (liveCup && Array.isArray(liveCup.state.entrants)) ? (Number(liveCup.state.entryGlory) || 0) : 0;
    if (refundEach > 0) {
      for (const e of liveCup.state.entrants) {
        if (!e || e.bot || !isPubkey(e.wallet)) continue;
        if (await refundGlory(e.wallet, refundEach)) { refunded++; cupPayers.delete(e.wallet); }   // refunded → clear from the paid log
      }
      await savePayers();
    }
    liveCup = createCup({ entryGlory, prizePool, cap, seedBase: "cup-" + Date.now() });
    await persistCup();
    res.json({ ok: true, refundedPlayers: refunded, refundEachGlory: refundEach, ...cupSnapshot(req.body?.wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: launch / unlaunch publicly (controls whether non-admins can see+enter the Cup).
app.post("/cup/public", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  cupPublic = !!req.body?.public;
  try { await store.kvSet("cup_public", cupPublic); } catch (e) {}
  res.json({ ok: true, public: cupPublic });
});

// Admin: change the lobby SIZE live (8 / 10 / 16) WITHOUT recreating — keeps everyone already seated.
// Only during registration, and never below the number already registered.
app.post("/cup/resize", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup) return res.status(409).json({ error: "no cup created yet" });
  if (liveCup.state.status !== "registration") return res.status(409).json({ error: "can only resize during registration" });
  const cap = Number(req.body?.cap);
  if (![8, 10, 16].includes(cap)) return res.status(400).json({ error: "cap must be 8, 10, or 16" });
  const seated = liveCup.state.entrants.length;
  if (cap < seated) return res.status(409).json({ error: `${seated} players already registered — can't shrink below that` });
  liveCup.state.cap = cap;
  await persistCup();
  res.json({ ok: true, cap, ...cupSnapshot(req.body?.wallet) });
});

// ---- Cup chat: lightweight, ephemeral, in-memory live chat for the tournament ----
const cupChat = [];                 // ring buffer of {id,name,wallet,text,ts}
let cupChatId = 1;
const cupChatRate = new Map();      // wallet -> last-post ms (basic anti-spam)
const cleanChat = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

app.get("/cup/chat", (req, res) => {
  const since = Number(req.query?.since) || 0;
  res.json({ ok: true, messages: cupChat.filter(m => m.ts > since).slice(-60), now: Date.now() });
});

app.post("/cup/chat", (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  const text = cleanChat(req.body?.text).slice(0, 240);
  if (!text) return res.status(400).json({ error: "empty message" });
  const now = Date.now(), last = cupChatRate.get(wallet) || 0;
  if (now - last < 1200) return res.status(429).json({ error: "slow down a sec" });
  cupChatRate.set(wallet, now);
  const name = (cleanChat(req.body?.name).slice(0, 24)) || (wallet.slice(0, 4) + "…");
  const msg = { id: cupChatId++, name, wallet, text, ts: now };   // text stored raw; clients MUST escape on render
  cupChat.push(msg);
  if (cupChat.length > 200) cupChat.splice(0, cupChat.length - 200);
  res.json({ ok: true, message: msg });
});

// Admin: fill empty seats with bots (for a dry run). Bots auto-ready every round.
app.post("/cup/fill", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup || liveCup.state.status !== "registration") return res.status(409).json({ error: "registration is not open" });
  try {
    const S = liveCup.state; let added = 0;
    const NAMES = ["Voltere", "Aquilo", "Pyrrhos", "Umbros", "Selka", "Bronto", "Lumix", "Krait", "Nyxa", "Orrin", "Wystan", "Galador", "Adalor", "Tyrannos", "Grovador", "Dragonos"];
    while (S.entrants.length < S.cap) {
      const i = S.entrants.length, id = "BOT" + i;
      const el = CUP_ELEMS[i % 5], br = 4 + ((i * 5 + 3) % 24), sk = [i % 12, (i + 4) % 12, (i + 8) % 12];
      const ct = {}; sk.forEach(s => ct[s] = Math.min(5, 1 + (br / 6 | 0)));
      liveCup.register(id, { name: NAMES[i % NAMES.length] + " ·" + br, element: el, br, arenaSkills: sk, cardTier: ct });
      const e = S.entrants.find(x => x.wallet === id); if (e) e.bot = true; added++;
    }
    await persistCup();
    res.json({ ok: true, added, ...cupSnapshot(req.body?.wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: start the cup (needs a full lobby).
app.post("/cup/start", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup) return res.status(409).json({ error: "no cup created" });
  try { liveCup.start(); await persistCup(); res.json({ ok: true, ...cupSnapshot(req.body?.wallet) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Admin: resolve the current round (lock-in window closes). Bots auto-ready; on finish, prizes are credited.
app.post("/cup/resolve-round", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup || liveCup.state.status !== "live") return res.status(409).json({ error: "no live round" });
  try {
    liveCup.state.entrants.forEach(e => { if (e.bot) e.ready = true; });   // bots always lock in
    const r = liveCup.resolveRound();
    if (r.finished) {
      let awarded = 0;
      for (const row of liveCup.results()) { if (row.sol > 0 && isPubkey(row.wallet)) { cupPrizes.set(row.wallet, (cupPrizes.get(row.wallet) || 0) + row.sol); awarded += row.sol; } }
      cupTotalAwarded = +(cupTotalAwarded + awarded).toFixed(4);
      await saveCupPrizes(); await saveCupAwarded();
      crownChampion();
    }
    await persistCup();
    res.json({ ok: true, result: r, ...cupSnapshot(req.body?.wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: START the current round as LIVE PvP — spin up a real battle for every real-vs-real pair.
// Players then fight; byes/bots resolve automatically at finalize.
// Shared: spin up LIVE PvP matches for the current round's real-vs-real pairs. Returns # of live matches.
async function cupStartRoundLive() {
  if (cupRound && cupRound.battling) return cupRound.matches.length;   // round already live — don't spin a second set of matches
  const S = liveCup.state;
  const entOf = w => S.entrants.find(x => x.wallet === w);
  const isReal = w => { const e = entOf(w); return !!(e && !e.bot && isPubkey(w)); };
  const round = { battling: true, matchByWallet: new Map(), side: new Map(), matches: [] };
  cupRound = round;             // CLAIM synchronously (before any await) so two callers can't both start the round
  for (const m of liveCup.currentMatches()) {
    const aw = m.a.wallet, bw = m.b.wallet, ea = entOf(aw), eb = entOf(bw);
    if (ea) ea.ready = true; if (eb) eb.ready = true;   // mark seated so resolveRound runs the decide() path
    if (isReal(aw) && isReal(bw)) {
      const match = pvpStartMatch({ ...ea.snap, wallet: aw }, { ...eb.snap, wallet: bw }, { turnMs: 30000 });
      round.matchByWallet.set(aw, match.id); round.matchByWallet.set(bw, match.id);
      round.side.set(aw, "a"); round.side.set(bw, "b");
      round.matches.push({ matchId: match.id, a: aw, b: bw });
    }
  }
  cupRound = round; cupRoundStartedAt = Date.now(); await persistCup();
  return round.matches.length;
}
// Shared: advance the bracket using live PvP winners (unfinished matches fall back to the deterministic engine).
async function cupFinalizeRoundLive() {
  const round = cupRound;
  if (!round) return null;     // already finalized — a concurrent auto-tick or a manual call beat us here
  cupRound = null;             // CLAIM the round SYNCHRONOUSLY (before any await) so two callers can't both resolveRound → double-pay prizes
  liveCup.state.entrants.forEach(e => { if (e.bot) e.ready = true; });
  const decide = (a, b) => {
    if (!round) return null;
    const mid = round.matchByWallet.get(a.wallet); if (!mid) return null;
    const m = pvpMatches.get(mid); if (!m || m.status !== "finished") return null;   // not done → deterministic fallback
    const winWallet = m.winner === "a" ? m.walletA : m.walletB;
    return winWallet === a.wallet ? "a" : "b";
  };
  const r = liveCup.resolveRound(decide);
  if (r.finished) {
    let awarded = 0;
    for (const row of liveCup.results()) { if (row.sol > 0 && isPubkey(row.wallet)) { cupPrizes.set(row.wallet, (cupPrizes.get(row.wallet) || 0) + row.sol); awarded += row.sol; } }
    cupTotalAwarded = +(cupTotalAwarded + awarded).toFixed(4);
    await saveCupPrizes(); await saveCupAwarded();
    crownChampion();
  }
  await persistCup();           // cupRound was already cleared synchronously at the top
  return r;
}

// AUTO-RUNNER: when enabled, the server drives the whole tournament — starts the cup once the lobby is full,
// starts each round, ticks idle matches so they resolve, and finalizes when all battles are done (or time out).
let cupTickBusy = false;
async function cupAutoTick() {
  if (!cupAuto || !liveCup) return;
  if (cupTickBusy) return;                                       // a previous tick is still awaiting — never run two at once (would double-start/double-finalize)
  cupTickBusy = true;
  try {
    const S = liveCup.state;
    if (S.status === "registration") {
      if (S.entrants.length === S.cap) { try { liveCup.start(); cupAutoNextAt = Date.now() + CUP_ROUND_GAP_MS; await persistCup(); } catch (e) {} }
      return;
    }
    if (S.status !== "live") return;
    if (Date.now() < cupAutoNextAt) return;                     // respect the inter-round pause
    if (!cupRound || !cupRound.battling) { await cupStartRoundLive(); return; }
    // a round is underway — tick every active match so idle players auto-play/forfeit even if nobody is polling
    for (const mm of cupRound.matches) { const m = pvpMatches.get(mm.matchId); if (m && m.status === "active") { try { pvpTick(m); } catch (e) {} } }
    const allDone = (cupRound.matches || []).every(mm => { const m = pvpMatches.get(mm.matchId); return m && m.status === "finished"; });
    const timedOut = (Date.now() - cupRoundStartedAt) > CUP_ROUND_MAX_MS;
    if (allDone || timedOut) { await cupFinalizeRoundLive(); cupAutoNextAt = Date.now() + CUP_ROUND_GAP_MS; }
  } finally { cupTickBusy = false; }
}
setInterval(() => { cupAutoTick().catch(() => { cupTickBusy = false; }); }, 4000);

app.post("/cup/start-round", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup || liveCup.state.status !== "live") return res.status(409).json({ error: "no live round" });
  try {
    const n = await cupStartRoundLive();
    res.json({ ok: true, liveMatches: n, ...cupSnapshot(req.body?.wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: FINALIZE the round — advance the bracket using the live PvP winners (unfinished matches fall back to the engine).
app.post("/cup/finalize-round", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!liveCup || liveCup.state.status !== "live") return res.status(409).json({ error: "no live round" });
  try {
    const r = await cupFinalizeRoundLive();
    res.json({ ok: true, result: r, ...cupSnapshot(req.body?.wallet) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Admin: toggle AUTO-RUN on/off. When on, the server runs the whole tournament hands-free.
app.post("/cup/auto", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  cupAuto = !!req.body?.auto;
  try { await store.kvSet("cup_auto", cupAuto); } catch (e) {}
  res.json({ ok: true, auto: cupAuto });
});

// Public: the reigning Chikoria Cup champion (for the floating world trophy + profile badge).
app.get("/cup/champion", (req, res) => res.json(cupChampion || { wallet: null, name: null, ts: 0 }));
// Admin: manually set/clear the reigning champion (GET or POST; e.g., for cups run before this feature).
async function setChampionHandler(req, res) {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const src = req.method === "GET" ? req.query : (req.body || {});
  const wallet = src.wallet, name = src.name || "Champion";
  if (!wallet || wallet === "none" || wallet === "clear") { cupChampion = null; await saveCupChampion(); return res.json({ ok: true, cupChampion: null }); }
  if (!isPubkey(wallet)) return res.status(400).json({ error: "valid wallet required" });
  cupChampion = { wallet, name, ts: Date.now() }; await saveCupChampion();
  res.json({ ok: true, cupChampion });
}
app.get("/cup/set-champion", setChampionHandler);
app.post("/cup/set-champion", setChampionHandler);

// ----- Meme Dynasty NFT eggs -----
// Buy + hatch a Meme Legendary Egg → assigns a RANDOM member + edition; the mint worker turns it into an on-chain NFT.
// (Payment is taken client-side in $CHIKI like other game spends; production should verify payment on-chain.)
app.post("/meme/hatch", async (req, res) => {
  const wallet = req.body && req.body.wallet;
  const paySig = req.body && req.body.paySig;
  if (!isPubkey(wallet)) return res.status(400).json({ error: "valid wallet required" });
  // 🔒 SALE LOCK: closed to the public until launch; admin wallets bypass so the dry-run works.
  if (!MEME_SALE_OPEN && !MEME_ADMIN_WALLETS.has(wallet)) return res.status(403).json({ error: "Meme Dynasty hatching opens at official launch — stay tuned on X! 🥚" });
  const now = Date.now(), last = _memeLastHatch.get(wallet) || 0;
  if (now - last < 4000) return res.status(429).json({ error: "slow down — one egg at a time" });
  if (memeOwnedActive(wallet) >= 1) return res.status(409).json({ error: "You already own a Meme Legendary — list it in the Bazaar (put it up for sale) before hatching another." });
  // LIFETIME CAP: at most 5 hatches ever per wallet (admins bypass for testing/dry-runs).
  if (!MEME_ADMIN_WALLETS.has(wallet) && memeLifetimeHatched(wallet) >= MEME_MAX_HATCH)
    return res.status(409).json({ error: `You've reached the lifetime limit of ${MEME_MAX_HATCH} Meme Egg hatches.` });
  // PAYMENT GATE: real $CHIKI must have changed hands on-chain before we mint anything.
  if (MEME_VERIFY_PAY) {
    if (!paySig || typeof paySig !== "string") return res.status(402).json({ error: "payment required — include your $CHIKI payment signature" });
    if (memeUsedSigs[paySig]) return res.status(409).json({ error: "that payment was already used to hatch an egg" });
    memeUsedSigs[paySig] = { wallet, ts: now };   // CLAIM the sig BEFORE the await — one payment hatches exactly one egg even under concurrent requests (TOCTOU)
    const v = await verifyEggPayment(paySig, wallet);
    if (!v.ok) { delete memeUsedSigs[paySig]; return res.status(402).json({ error: v.error }); }
  }
  // 🎲 The species is NOT chosen here — it stays a MYSTERY and is rolled at hatch time (POST /meme/hatched).
  // We only RESERVE a slot against the 105 total here.
  if (memeReserved() >= MEME_TOTAL) { if (MEME_VERIFY_PAY && paySig) delete memeUsedSigs[paySig]; return res.status(409).json({ error: "sold out — every Meme Dynasty egg has been claimed" }); }
  _memeLastHatch.set(wallet, now);
  const h = { id: "h" + now.toString(36) + Math.random().toString(36).slice(2, 6), wallet, hatcher: wallet, char: null, name: "Mystery Meme Egg", edition: null, status: "incubating", undetermined: true, mintAddr: null, ts: now, paySig: paySig || null };
  memeHatches.push(h); await saveMeme();
  res.json({ ok: true, hatch: { id: h.id, status: "incubating", mystery: true }, supply: memeSupply() });
});
// The in-game egg finished its tended incubation → ROLL the random species now, then flip "incubating" → "pending" so the worker mints the NFT.
app.post("/meme/hatched", async (req, res) => {
  const { wallet, hatchId } = req.body || {};
  if (!isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  const h = memeHatches.find(x => x.id === hatchId && x.wallet === wallet);
  if (!h) return res.status(404).json({ error: "hatch not found" });
  if (h.status === "incubating") {
    if (!h.char) {   // roll the random Meme Legendary NOW (respecting remaining per-character caps)
      const c = pickMeme();
      if (!c) return res.status(409).json({ error: "the dynasty is fully hatched" });
      h.char = c.key; h.name = c.name; h.edition = (memeMinted[c.key] || 0) + 1; memeMinted[c.key] = h.edition; h.undetermined = false;
    }
    h.status = "pending"; h.hatchedAt = Date.now(); await saveMeme();
  }
  res.json({ ok: true, status: h.status, char: h.char, name: h.name, edition: h.edition, cap: capOf(h.char), rarity: rarityOf(h.char) });
});
// A wallet's hatched Meme NFTs (with mint status) + live supply.
app.get("/meme/mine", (req, res) => {
  const wallet = req.query && req.query.wallet;
  if (!isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  // In Magic Eden mode, keep the ledger in sync with on-chain owners (throttled, non-blocking) so a bought NFT shows up.
  if (MEME_TRADE_TENSOR && Date.now() - _memeSyncAt > 60000) reconcileMemeOwners().catch(() => {});
  const items = memeHatches.filter(h => h.wallet === wallet)
    .map(h => ({ id: h.id, char: h.char, name: h.name, edition: h.edition, status: h.status, mintAddr: h.mintAddr, ts: h.ts, listed: h.listed || null }))
    .sort((a, b) => b.ts - a.ts);
  const hatchesUsed = memeLifetimeHatched(wallet), ownedActive = memeOwnedActive(wallet);
  // `ownedChars` = the species this wallet currently owns on-chain → the client grants/keeps exactly these playable Chikis.
  const ownedChars = [...new Set(memeHatches.filter(h => h.wallet === wallet && h.status === "minted" && h.char).map(h => h.char))];
  res.json({ items, supply: memeSupply(), ownedChars,
    hatchesUsed, hatchesLeft: Math.max(0, MEME_MAX_HATCH - hatchesUsed), maxHatch: MEME_MAX_HATCH,
    ownsActive: ownedActive >= 1, canHatch: ownedActive < 1 && hatchesUsed < MEME_MAX_HATCH });
});
// Admin: force an immediate on-chain ownership reconcile.
app.get("/meme/sync", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!MEME_TRADE_TENSOR) return res.json({ ok: true, skipped: "not in on-chain (Magic Eden) trade mode" });
  await reconcileMemeOwners();
  res.json({ ok: true, syncedAt: _memeSyncAt, minted: memeHatches.filter(h => h.status === "minted").length });
});
app.get("/meme/supply", (req, res) => res.json({ ...memeSupply(), eggPrice: MEME_EGG_PRICE, verifyPay: MEME_VERIFY_PAY, saleOpen: MEME_SALE_OPEN, tradeTensor: MEME_TRADE_TENSOR, tensorUrl: TENSOR_URL || null, marketName: MARKET_NAME, marketUrl: MARKET_URL || null }));
// Public: the most recent hatches — drives a live "just hatched!" ticker for hype/engagement.
app.get("/meme/recent", (req, res) => {
  const items = memeHatches.filter(h => h.status !== "incubating")
    .slice(-12).reverse()
    .map(h => ({ char: h.char, name: h.name, edition: h.edition, cap: capOf(h.char), rarity: rarityOf(h.char), ts: h.hatchedAt || h.ts }));
  const sup = memeSupply();
  res.json({ items, minted: sup.total - sup.totalLeft, total: sup.total });
});
// Worker: list hatches awaiting an on-chain mint.
app.get("/meme/pending", (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  res.json({ pending: memeHatches.filter(h => h.status === "pending").slice(0, 50) });
});
// Worker/admin: list every ALREADY-MINTED asset (id, char, edition, wallet, mintAddr) so a one-time
// metadata "recase" pass can re-point each on-chain NFT at the new display-case art.
app.get("/meme/minted-list", (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  res.json({ minted: memeHatches.filter(h => h.status === "minted" && h.mintAddr)
    .map(h => ({ id: h.id, char: h.char, name: h.name, edition: h.edition, wallet: h.wallet, mintAddr: h.mintAddr })) });
});
// Worker: mark a hatch minted (records the on-chain asset address).
app.post("/meme/minted", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const { hatchId, mintAddr } = req.body || {};
  const h = memeHatches.find(x => x.id === hatchId);
  if (!h) return res.status(404).json({ error: "hatch not found" });
  // Idempotent: if this hatch is already minted on-chain, keep the original mint address
  // and don't reprocess. Prevents a late/duplicate worker callback from clobbering it.
  if (h.status === "minted" && h.mintAddr) {
    return res.json({ ok: true, already: true, mintAddr: h.mintAddr });
  }
  h.status = "minted"; h.mintAddr = mintAddr || null; await saveMeme();
  res.json({ ok: true });
});

// ----- Mystic Market NFT Bazaar (devnet) — list / unlist / browse / buy a Meme Dynasty NFT -----
// (Off-chain ownership ledger for the devnet demo. Mainnet should use Metaplex Auction House / Tensor for
//  escrowless on-chain trades + royalties — never a custom escrow.)
app.post("/meme/list", async (req, res) => {
  if (MEME_TRADE_TENSOR) return res.status(410).json({ error: `Trading is on ${MARKET_NAME} now — list your NFT there.`, marketUrl: MARKET_URL, marketName: MARKET_NAME, tensorUrl: TENSOR_URL });
  const { wallet, hatchId, price } = req.body || {};
  if (!isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  const h = memeHatches.find(x => x.id === hatchId);
  if (!h) return res.status(404).json({ error: "NFT not found" });
  if (h.wallet !== wallet) return res.status(403).json({ error: "not your NFT" });
  if (h.status !== "minted") return res.status(409).json({ error: "this Legendary is still hatching — you can list it once it's minted on-chain. 🥚" });
  const p = Number(price); if (!(p > 0)) return res.status(400).json({ error: "price must be greater than 0" });
  h.listed = { price: +p.toFixed(4), ts: Date.now() }; await saveMeme();
  res.json({ ok: true });
});
app.post("/meme/unlist", async (req, res) => {
  const { wallet, hatchId } = req.body || {};
  const h = memeHatches.find(x => x.id === hatchId);
  if (!h || h.wallet !== wallet) return res.status(403).json({ error: "not your NFT" });
  h.listed = null; await saveMeme();
  res.json({ ok: true });
});
app.get("/meme/market", (req, res) => {
  const items = memeHatches.filter(h => h.listed)
    .map(h => ({ id: h.id, char: h.char, name: h.name, edition: h.edition, price: h.listed.price, seller: h.wallet, mintAddr: h.mintAddr, status: h.status, listedAt: h.listed.ts }))
    .sort((a, b) => a.price - b.price);
  res.json({ items, supply: memeSupply() });
});
// Buy a listed NFT — transfers in-game ownership + records the sale. (Payment settled client-side for the devnet demo.)
app.post("/meme/buy", async (req, res) => {
  if (MEME_TRADE_TENSOR) return res.status(410).json({ error: `Buying happens on ${MARKET_NAME} now — settle the trade on-chain there.`, marketUrl: MARKET_URL, marketName: MARKET_NAME, tensorUrl: TENSOR_URL });
  const { wallet, hatchId } = req.body || {};
  if (!isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  const h = memeHatches.find(x => x.id === hatchId);
  if (!h || !h.listed) return res.status(409).json({ error: "this NFT is no longer for sale" });
  if (h.status !== "minted") return res.status(409).json({ error: "this NFT isn't minted on-chain yet — can't buy it" });
  if (h.wallet === wallet) return res.status(400).json({ error: "you can't buy your own listing" });
  if (memeOwnedActive(wallet) >= 1) return res.status(409).json({ error: "You already own a Meme Legendary — list yours for sale before buying another." });
  const price = h.listed.price, seller = h.wallet;
  // SECURITY: never reassign ownership on the buyer's say-so — require a real on-chain payment of the
  // full price from buyer -> seller, replay-guarded (mirrors the resource market / egg payment).
  const paySig = req.body && req.body.paySig;
  if (!paySig || typeof paySig !== "string") return res.status(402).json({ error: "on-chain payment required — pay the seller first" });
  if (memeUsedSigs[paySig]) return res.status(409).json({ error: "that payment was already used" });
  memeUsedSigs[paySig] = { wallet, ts: Date.now() };
  const paid = await txTransfer(paySig, wallet, seller, price);
  if (!paid) { delete memeUsedSigs[paySig]; return res.status(402).json({ error: "payment to the seller could not be verified on-chain" }); }
  h.wallet = wallet; h.listed = null; h.lastSale = { price, from: seller, to: wallet, ts: Date.now() };
  await saveMeme();
  res.json({ ok: true, price, seller, char: h.char, name: h.name, edition: h.edition });
});

// Admin: AUDIT the owed-prize ledger (read-only) — who is still owed Cup SOL, and how much.
app.get("/cup/prizes", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const prizes = [...cupPrizes.entries()].map(([wallet, sol]) => ({ wallet, sol: +Number(sol).toFixed(4) })).sort((a, b) => b.sol - a.sol);
  res.json({ count: prizes.length, totalSol: +prizes.reduce((s, x) => s + x.sol, 0).toFixed(4), prizes });
});

// Admin RECOVERY: manually credit a wallet a Cup prize (e.g., if a cup's result was lost before crediting).
// Strictly ADMIN_KEY-gated because it creates claimable SOL — a public wallet check is NOT enough here.
app.post("/cup/grant", async (req, res) => {
  if (!process.env.ADMIN_KEY || req.body?.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "admin key required" });
  const wallet = req.body?.wallet, sol = Number(req.body?.sol);
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!(sol > 0)) return res.status(400).json({ error: "positive 'sol' required" });
  cupPrizes.set(wallet, +(((cupPrizes.get(wallet) || 0) + sol)).toFixed(6));
  await saveCupPrizes();
  res.json({ ok: true, wallet, granted: sol, owedNow: cupPrizes.get(wallet) });
});

// Admin: refund cup-entry GLORY to wallets (e.g., players from a lost lobby that wasn't auto-refunded).
// Pass {wallets:[...]} to refund a specific list, or omit it to refund everyone in the durable paid-log.
app.post("/cup/refund", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const amount = Math.max(1, Number(req.body?.amount) || 100);
  // refund a specific {wallets:[...]}, OR source:"finishers" (everyone in the prize ledger = first cup's entrants), OR the paid-log
  let list;
  if (Array.isArray(req.body?.wallets) && req.body.wallets.length) list = req.body.wallets;
  else if (req.body?.source === "finishers") list = [...cupPrizes.keys()];
  else list = [...cupPayers.keys()];
  const done = [];
  for (const w of list) { if (await refundGlory(w, amount)) { done.push(w); cupPayers.delete(w); } }
  await savePayers();
  res.json({ ok: true, refundedEachGlory: amount, count: done.length, wallets: done });
});

// Admin: view the durable paid-log (who paid entry Glory and how much) — for auditing refunds.
app.get("/cup/payers", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const payers = [...cupPayers.entries()].map(([wallet, glory]) => ({ wallet, glory }));
  res.json({ count: payers.length, totalGlory: payers.reduce((s, x) => s + x.glory, 0), payers });
});

/* ----------------------------- LIVE PvP battles ----------------------------- */
const pvpMatches = new Map();   // matchId -> live match (in-memory; a battle is short-lived)
const pvpSideOf = (m, wallet) => m.walletA === wallet ? "a" : m.walletB === wallet ? "b" : null;
// drive turn timeouts / forfeits + clean up finished matches
setInterval(() => {
  const now = Date.now();
  for (const [id, m] of pvpMatches) {
    try { pvpTick(m, now); } catch (e) {}
    if (m.status === "finished") {
      if (!m._winRecorded) { m._winRecorded = true; const ww = m.winner === "a" ? m.walletA : m.winner === "b" ? m.walletB : null;
        // SECURITY: only credit a win when a REAL turn resolved (both sides submitted) and the wallets differ —
        // an instant forfeit at turn 0 (self-match farming) or a self-vs-self match earns nothing
        if (ww && (m.turn | 0) >= 1 && m.walletA !== m.walletB) recordWin(ww); }
      if (!m._doneAt) m._doneAt = now;
      else if (now - m._doneAt > 180000) { pvpMatches.delete(id);   // also clear the wallet→match pointers so the maps don't grow unbounded
        if (pvpPlayerMatch.get(m.walletA) === id) pvpPlayerMatch.delete(m.walletA);
        if (pvpPlayerMatch.get(m.walletB) === id) pvpPlayerMatch.delete(m.walletB); } }
  }
}, 1000);

const pvpQueue = [];                  // [{wallet, snap, ts}] players waiting for a live opponent
const pvpPlayerMatch = new Map();     // wallet -> their current matchId (so cup + queued players can find their battle)
// Count of ONLINE players who own a Legendary (= eligible to battle in the Chikiseum). Cached to avoid DB load.
const PVP_LEGEND_SP = new Set([10, 11, 12, 13, 14]);   // legendary species indices
let _pvpOnlineCache = { n: 0, t: 0 };
async function eligibleOnline() {
  const now = Date.now();
  if (now - _pvpOnlineCache.t < 4000) return _pvpOnlineCache.n;
  try {
    const rows = await store.world(PRESENCE_WINDOW, "", 5000);   // [{wallet, sp, level}]
    const set = new Set();
    for (const r of rows) if (PVP_LEGEND_SP.has(r.sp | 0)) set.add(r.wallet);
    _pvpOnlineCache = { n: set.size, t: now };
  } catch (e) {}
  return _pvpOnlineCache.n;
}
function pvpStartMatch(a, b, opts) {  // a,b = snapshots with .wallet
  const m = pvpCreate(a, b, opts || { turnMs: 30000 });
  pvpMatches.set(m.id, m); pvpPlayerMatch.set(m.walletA, m.id); pvpPlayerMatch.set(m.walletB, m.id);
  return m;
}

// Admin/Cup: create a live PvP match from two player snapshots {wallet, name, element, br, arenaSkills, cardTier}.
app.post("/pvp/create", async (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  const a = req.body?.a, b = req.body?.b;
  if (!a?.wallet || !b?.wallet || !isPubkey(a.wallet) || !isPubkey(b.wallet)) return res.status(400).json({ error: "a.wallet and b.wallet required" });
  const m = pvpStartMatch(a, b, { turnMs: Math.max(8000, Number(req.body?.turnMs) || 30000), id: req.body?.id });
  res.json({ ok: true, matchId: m.id, a: m.walletA, b: m.walletB, turnMs: m.turnMs });
});

// Open Chikiseum matchmaking: join the queue; pairs with the next waiting player into a live match.
app.post("/pvp/queue", async (req, res) => {
  const wallet = req.body?.wallet, snap = req.body?.snap;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!snap || !snap.element) return res.status(400).json({ error: "legendary 'snap' required" });
  snap.wallet = wallet;
  const eligible = await eligibleOnline();
  const r = availableJoin({ wallet, name: snap.name, snap, searching: true });   // legacy endpoint now shares the ONE pool
  if (r.matched) return res.json({ status: "matched", matchId: r.matched.matchId, side: r.matched.side });
  res.json({ status: "searching", queued: pvpAvail.size, eligible });
});

// Poll matchmaking / find your current match (used by open Chikiseum AND cup players).
app.get("/pvp/queue", async (req, res) => {
  const wallet = req.query?.wallet; if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "wallet required" });
  const cur = pvpPlayerMatch.get(wallet); const m = cur && pvpMatches.get(cur);
  if (m) return res.json({ status: "matched", matchId: cur, side: pvpSideOf(m, wallet), over: m.status === "finished" });
  res.json({ status: pvpQueue.find(q => q.wallet === wallet) ? "searching" : "idle", queued: pvpQueue.length, eligible: await eligibleOnline() });
});

// Online Chikiseum-eligible player count (owns a Legendary) — shown before/while queuing.
app.get("/pvp/online", async (req, res) => { cleanAvail(); res.json({ eligible: await eligibleOnline(), queued: pvpQueue.length, inChikiseum: pvpAvail.size, searching: [...pvpAvail.values()].filter(v => v.searching).length, names: [...pvpAvail.values()].map(v => v.name) }); });

// Leave the matchmaking queue.
app.post("/pvp/cancel", (req, res) => {
  const wallet = req.body?.wallet; const i = pvpQueue.findIndex(q => q.wallet === wallet);
  if (i >= 0) pvpQueue.splice(i, 1);
  pvpAvail.delete(wallet);
  res.json({ ok: true });
});

// ----- Direct challenge: see who's ready & challenge them (fixes "no one is searching at the same instant") -----
const pvpAvail = new Map();        // wallet -> {name, snap, ts} : Trainers with the Chikiseum open, ready to battle
let pvpChallenges = [];            // {id, from, fromName, to, snap, ts}
const AVAIL_TTL = 14000, CHALL_TTL = 30000;
function cleanAvail() { const now = Date.now(); for (const [w, v] of pvpAvail) if (now - v.ts > AVAIL_TTL) pvpAvail.delete(w); pvpChallenges = pvpChallenges.filter(c => now - c.ts < CHALL_TTL); }
// Heartbeat: register that you're in the Chikiseum (optionally actively searching). Returns other ready Trainers,
// your incoming challenges, and whether you've been matched. If `searching`, AUTO-PAIRS you with any other searcher.
// Shared join logic for the ONE matchmaking pool — used by both /pvp/available and the legacy /pvp/queue,
// so every searcher lives in the same pool and pairs reliably (verified seamless across thousands of sims).
function availableJoin(body) {
  const { wallet, name, snap, searching } = body || {};
  if (!isPubkey(wallet)) return { error: "wallet required" };
  cleanAvail();
  const cur = pvpPlayerMatch.get(wallet), curM = cur && pvpMatches.get(cur);
  if (curM && curM.status === "active") {
    pvpAvail.delete(wallet);
    const sd = pvpSideOf(curM, wallet);
    // THE SECRET IS A CREDENTIAL — hand it out only to a caller who has PROVEN this wallet.
    // This route is authorised by the wallet alone, and wallets are public (roster, world chat,
    // market board). Returning `sec` here unconditionally meant anyone could ask for a victim's
    // secret and then forfeit their duel — re-opening the exact hole the secrets were added to
    // close. Proving costs nothing for a real player: /verify already issued them a market token.
    const proven = mktWallet(body) === wallet;
    const out = { players: [], challenges: [], matched: { matchId: cur, side: sd } };
    if (proven) out.matched.sec = (sd === "a" ? curM.secA : curM.secB);
    return out;
  }
  if (snap && snap.element) pvpAvail.set(wallet, { name: String(name || "Trainer").slice(0, 20), snap, ts: Date.now(), searching: !!searching });
  else pvpAvail.delete(wallet);
  // auto-match: if I'm actively searching, pair me with ANY other searching Trainer not already in a battle
  if (searching && snap && snap.element) {
    for (const [w, v] of pvpAvail) {
      if (w === wallet || !v.searching) continue;
      const m = pvpPlayerMatch.get(w); if (m && pvpMatches.get(m) && pvpMatches.get(m).status === "active") continue;
      const me = { ...snap, wallet }, op = { ...v.snap, wallet: w };
      const match = pvpStartMatch(op, me, { turnMs: 30000 });   // earlier searcher = side a
      pvpAvail.delete(w); pvpAvail.delete(wallet);
      pvpChallenges = pvpChallenges.filter(c => c.from !== w && c.to !== w && c.from !== wallet && c.to !== wallet);
      { const sd = pvpSideOf(match, wallet);
        const proven2 = mktWallet(body) === wallet;      // same rule as above — see the note there
        const out2 = { players: [], challenges: [], matched: { matchId: match.id, side: sd } };
        if (proven2) out2.matched.sec = (sd === "a" ? match.secA : match.secB);
        return out2; }
    }
  }
  const players = [...pvpAvail.entries()].filter(([w]) => w !== wallet).map(([w, v]) => ({ wallet: w, name: v.name, searching: !!v.searching }));
  const challenges = pvpChallenges.filter(c => c.to === wallet).map(c => ({ id: c.id, from: c.from, fromName: c.fromName }));
  return { players, challenges, matched: null };
}
app.post("/pvp/available", (req, res) => { const r = availableJoin(req.body); if (r.error) return res.status(400).json(r); res.json(r); });
// Send a challenge to a specific Trainer.
app.post("/pvp/challenge", (req, res) => {
  const { from, fromName, to, snap } = req.body || {};
  if (!isPubkey(from) || !isPubkey(to)) return res.status(400).json({ error: "valid wallets required" });
  if (from === to) return res.status(400).json({ error: "you can't challenge yourself" });
  if (!snap || !snap.element) return res.status(400).json({ error: "legendary snap required" });
  cleanAvail();
  if (pvpChallenges.some(c => c.from === from && c.to === to)) return res.json({ ok: true });   // dedupe
  pvpChallenges.push({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), from, fromName: String(fromName || "Trainer").slice(0, 20), to, snap, ts: Date.now() });
  res.json({ ok: true });
});
// Accept a challenge -> starts the live match; both sides learn via /pvp/available (matched) or this response.
app.post("/pvp/challenge/accept", (req, res) => {
  const { wallet, challengeId, snap } = req.body || {};
  if (!snap || !snap.element) return res.status(400).json({ error: "legendary snap required" });
  const i = pvpChallenges.findIndex(c => c.id === challengeId && c.to === wallet);
  if (i < 0) return res.status(404).json({ error: "challenge expired" });
  const ch = pvpChallenges.splice(i, 1)[0];
  // guard: neither player may already be in a live battle (prevents double-matches)
  for (const w of [ch.from, wallet]) { const mm = pvpPlayerMatch.get(w); if (mm && pvpMatches.get(mm) && pvpMatches.get(mm).status === "active") { pvpChallenges = pvpChallenges.filter(c => c.from !== ch.from && c.to !== ch.from && c.from !== wallet && c.to !== wallet); return res.status(409).json({ error: "that Trainer is already in a battle" }); } }
  snap.wallet = wallet; ch.snap.wallet = ch.from;
  const m = pvpStartMatch(ch.snap, snap, { turnMs: 30000 });   // challenger = side a, accepter = side b
  pvpAvail.delete(ch.from); pvpAvail.delete(wallet);
  pvpChallenges = pvpChallenges.filter(c => c.from !== ch.from && c.to !== ch.from && c.from !== wallet && c.to !== wallet);
  { const side = pvpSideOf(m, wallet);
    // same credential rule as /pvp/available: only a proven wallet receives the per-match secret
    const body = req.body || {};
    const r2 = { ok: true, matchId: m.id, side };
    if (mktWallet(body) === wallet) r2.sec = (side === "a" ? m.secA : m.secB);
    res.json(r2); }
});
// Decline / clear a challenge.
app.post("/pvp/challenge/decline", (req, res) => {
  const { wallet, challengeId } = req.body || {};
  pvpChallenges = pvpChallenges.filter(c => !(c.id === challengeId && c.to === wallet));
  res.json({ ok: true });
});

// Player: poll your live battle state (only your own hand is revealed).
app.get("/pvp/state", (req, res) => {
  const m = pvpMatches.get(req.query?.matchId); if (!m) return res.status(404).json({ error: "match not found" });
  const who = pvpSideOf(m, req.query?.wallet); if (!who) return res.status(403).json({ error: "not your match" });
  try { pvpTick(m); } catch (e) {}
  res.json(pvpView(m, who));
});

// SPECTATORS: anyone can watch a live match (public view — HP/shield/score/log, no hands).
app.get("/pvp/spectate", (req, res) => {
  const m = pvpMatches.get(req.query?.matchId); if (!m) return res.status(404).json({ error: "match not found" });
  try { pvpTick(m); } catch (e) {}
  res.json(pvpSpectate(m));
});

// Player: lock in your cards for the current turn. body: { matchId, wallet, cards:[handIndex,...] }
// Resolve the caller's side from their per-match secret, falling back to the wallet ONLY for
// matches created before secrets existed (in-memory and short-lived, so this drains within minutes).
function pvpAuthSide(m, body) {
  const sec = String(body?.sec || "");
  if (m.secA || m.secB) {
    if (sec && sec === m.secA) return "a";
    if (sec && sec === m.secB) return "b";
    return null;
  }
  return pvpSideOf(m, body?.wallet);
}
app.post("/pvp/move", (req, res) => {
  const m = pvpMatches.get(req.body?.matchId); if (!m) return res.status(404).json({ error: "match not found" });
  const who = pvpAuthSide(m, req.body); if (!who) return res.status(403).json({ error: "not your match" });
  const r = pvpSubmit(m, who, Array.isArray(req.body?.cards) ? req.body.cards : []);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(pvpView(m, who));
});

// Player: leave the battle → instant loss; the opponent wins immediately (no waiting for the timer).
app.post("/pvp/forfeit", (req, res) => {
  const m = pvpMatches.get(req.body?.matchId); if (!m) return res.status(404).json({ error: "match not found" });
  const who = pvpAuthSide(m, req.body); if (!who) return res.status(403).json({ error: "not your match" });
  pvpForfeit(m, who);
  res.json({ ok: true, ...pvpView(m, who) });
});

// Devnet-only funding helper (open in a browser to airdrop to the treasury)
app.get("/fund", async (req, res) => {
  if (NETWORK !== "devnet") return res.status(400).json({ error: "devnet-only" });
  const amt = Math.min(2, Number(req.query.amount || 1));
  for (const url of [RPC_URL, "https://api.devnet.solana.com"]) {
    try {
      const c = new Connection(url, "confirmed");
      const sig = await c.requestAirdrop(treasury.publicKey, Math.floor(amt * LAMPORTS_PER_SOL));
      await c.confirmTransaction(sig, "confirmed");
      return res.json({ ok: true, airdropped: amt, poolSol: (await c.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL, signature: sig });
    } catch {}
  }
  res.status(502).json({ error: "airdrop failed (devnet faucets are rate-limited) — reload to retry" });
});

/* ============================ MMORPG — shared-world presence (Phase 0) ============================ */
// Lightweight real-time layer: trainers broadcast their position + companion Legendary; everyone fetches the
// nearby online players to render them live. In-memory + TTL-pruned (mirrors the PvP lobby). No DB, no rewards.
const worldPlayers = new Map();   // wallet -> { x, z, dir, handle, leg, el, br, ts }
const WORLD_TTL_MS = 12000;       // drop a trainer who hasn't pinged in 12s
const WORLD_RADIUS = 4000;        // only return players within this distance (interest management)
const WORLD_MAX_PEERS = 60;       // hard cap on peers per snapshot — applied to the NEAREST, see worldSnapshot()
const clampF = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
// ---- SHARED RESOURCE NODES ----------------------------------------------------
// Node LAYOUT is already identical on every client (Gather.gd seeds its RNG with fixed
// constants), so a node needs no server-side position — only whether it is currently spent.
// Without this each client tracked depletion privately, so the same rock could be mined by
// several players at once and everyone saw a different world. One map, one truth.
const worldNodes = new Map();          // "kind:ix:iz" -> respawnAtMs
const NODE_MAX = 20000;                // hard cap so a flood can't grow this unbounded
// MULTI-LOAD nodes (trees). A rock is one claim and it is gone; a tree holds TREE_WOOD loads and
// is worked several times before it falls. Depletion used to be entirely client-side, so two
// trainers chopping the same trunk each saw a private forest — one felled a tree the other still
// saw standing. The server now owns the load count, exactly as it already owns "is this rock spent".
// id -> { left, ts }. `ts` only exists so an abandoned half-chopped trunk can be pruned.
const worldNodeUses = new Map();
const NODE_USES_TTL_MS = 30 * 60 * 1000;   // a trunk nobody has touched in 30 min grows its loads back

function nodeSweep(now) {
  for (const [k, u] of worldNodeUses) if (now - u.ts > NODE_USES_TTL_MS) worldNodeUses.delete(k);
  if (worldNodes.size < NODE_MAX) return;
  for (const [k, t] of worldNodes) if (!(t > now)) worldNodes.delete(k);
}

// ---- the world REMEMBERS what has been taken from it ----
// worldNodes/worldNodeUses were in-memory only, so every restart instantly re-stood every felled
// tree and refilled every mined rock — and with autoDeploy on, that happened on every push. A
// shared world that forgets whenever you deploy is not a shared world.
//
// Absolute epoch timestamps are stored rather than remaining durations, so a respawn that came due
// while the process was down is simply already expired at load and the node is free again. Writes
// are debounced: a claim only marks state dirty, and one flush covers all of them, so a busy world
// costs one small write every NODE_SAVE_MS instead of a DB round-trip per swing.
let _nodesDirty = false;
const NODE_SAVE_MS = 10000;
function markNodesDirty() { _nodesDirty = true; }

// Exported so a sim can round-trip the REAL functions rather than a copy of them: there is no
// Postgres in the test environment, so serialise -> clear -> restore in one process is the only
// honest way to prove a restart keeps the world.
export function serializeWorldNodes(now = Date.now()) {
  return {
    nodes: [...worldNodes].filter(([, t]) => Number(t) > now).slice(-NODE_MAX),
    uses: [...worldNodeUses].filter(([, u]) => u && now - Number(u.ts) <= NODE_USES_TTL_MS).slice(-NODE_MAX),
  };
}

// Restoring trusts NOTHING: this blob came out of a database that a future bug could corrupt, so
// ids are re-sanitised through nodeId(), counts are re-clamped, and anything already expired is
// dropped rather than resurrected.
export function restoreWorldNodes(v, now = Date.now()) {
  if (!v || typeof v !== "object") return { nodes: 0, uses: 0 };
  let n = 0, u = 0;
  for (const e of (Array.isArray(v.nodes) ? v.nodes : [])) {
    if (!Array.isArray(e)) continue;
    const id = nodeId(e[0]), t = Number(e[1]);
    if (id && Number.isFinite(t) && t > now) { worldNodes.set(id, t); n++; }
  }
  for (const e of (Array.isArray(v.uses) ? v.uses : [])) {
    if (!Array.isArray(e) || !e[1] || typeof e[1] !== "object") continue;
    const id = nodeId(e[0]), left = Number(e[1].left), ts = Number(e[1].ts);
    if (id && left > 0 && left <= 16 && Number.isFinite(ts) && now - ts <= NODE_USES_TTL_MS) {
      worldNodeUses.set(id, { left, ts }); u++;
    }
  }
  return { nodes: n, uses: u };
}

// test seam: let a sim empty the live world without reaching into module internals
export function _clearWorldNodes() { worldNodes.clear(); worldNodeUses.clear(); }

async function saveWorldNodes() {
  if (!_nodesDirty) return;
  _nodesDirty = false;
  try {
    await store.kvSet("world_nodes", serializeWorldNodes());
  } catch (e) { _nodesDirty = true; }   // a failed write must not silently drop the world
}
setInterval(saveWorldNodes, NODE_SAVE_MS).unref?.();
// Render sends SIGTERM on every deploy — flush so the last claims before a push are not lost.
// ONE handler for everything that needs flushing: a second handler calling process.exit() would
// race this one and kill the process mid-write. saveAssetLedger is a hoisted declaration below.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // await the IN-FLIGHT flush first, then run one more for anything minted since it started —
    // exiting on a clean dirty flag aborted the write that was still carrying the newest assets.
    Promise.allSettled([saveWorldNodes(), Promise.resolve(_assetsFlush).then(() => saveAssetLedger())])
      .finally(() => process.exit(0));
  });
}

store.kvGet("world_nodes").then(v => {
  const r = restoreWorldNodes(v);
  if (r.nodes || r.uses) console.log(`world nodes restored: ${r.nodes} spent, ${r.uses} part-worked`);
}).catch(() => {});
function nodeId(s) { return String(s || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 40); }

// claim a node: first caller wins, everyone else is told it is already taken.
//
// AUTHORISED against the position the player is ALREADY broadcasting. Without this a scripted
// client could claim every node on the island without ever moving, denying the whole realm its
// resources - the griefing gets worse the more players there are. Three gates:
//   1. you must have a LIVE presence (you are actually in the world right now)
//   2. the node must be within reach of where you last said you were
//   3. you cannot claim faster than a human can gather
// Respawn windows, in seconds, owned by the server. Mines are permanent landmarks that merely
// refill (Gather.gd uses 10s for them); everything else is a normal node.
const NODE_CD_S = Object.freeze(Object.assign(Object.create(null), { gold: 10, iron: 10, crystal_mine: 10 }));
const NODE_USES = Object.freeze(Object.assign(Object.create(null), { wood: 3 }));
const CLAIM_RADIUS_KIND = Object.freeze(Object.assign(Object.create(null), { pig: 24, cow: 24 }));
const NODE_CD_DEFAULT_S = 60;
const CLAIM_RADIUS = 14;          // world units; in-game gather reach is ~7, doubled for latency
const CLAIM_MIN_MS = 1800;        // the client's own anti-macro floor is 2s
// WHAT A NODE DROPS, decided here rather than by the client. Transcribed from Gather.gd:694-729,
// which is the behaviour players have today — this names the drop, it does not rebalance it.
//
// An ALLOWLIST, never a default: a node id is "kind:ix:iz" and the handler accepts any kind string
// in it, so falling back to a material for an unknown kind would be a faucet. Unknown -> nothing.
//
// The cow really does yield TWO items from one claim and that is deliberate and live, so this maps
// to a LIST. Everything else is exactly one, which is the standing rule.
const NODE_DROP = Object.freeze(Object.assign(Object.create(null), {
  wood: ["wood"], stone: ["stone"], crystal: ["crystal"], crystal_mine: ["crystal"],
  gold: ["gold"], iron: ["iron"], seashell: ["seashell"], honey: ["honey"],
  flower: ["flower"], berries: ["berries"], pig: ["pork"], cow: ["beef", "hide"],
}));
const nodeDrop = (kind) => (Object.hasOwn(NODE_DROP, kind) ? NODE_DROP[kind] : []);
// how many claims arrive with a provable identity — read from /assets/summary, so the decision to
// start refusing unproven ones is made on a real number rather than a guess
let _provenClaims = 0, _unprovenClaims = 0;
const CLAIM_BURST = 40;           // per wallet per minute, a generous ceiling on honest play
const claimRate = new Map();      // wallet -> {last, count, windowStart}

app.post("/world/node/claim", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  const id = nodeId(b.id);
  if (!id) return res.status(400).json({ error: "id required" });
  const now = Date.now();
  nodeSweep(now);

  // 1. you have to actually be in the world
  const me = worldPlayers.get(b.wallet);
  if (!me || now - me.ts > WORLD_TTL_MS) {
    return res.status(403).json({ ok: false, error: "no live presence" });
  }

  // 2. the node has to be within reach of where you said you were. Ids are "kind:x:z", which is
  //    what lets us check this without trusting any position the caller sends.
  const parts = id.split(":");
  const kind = String(parts[0] || "");
  const nx = Number(parts[1]), nz = Number(parts[2]);
  if (!Number.isFinite(nx) || !Number.isFinite(nz)) {
    return res.status(400).json({ ok: false, error: "malformed id" });
  }
  const dist = Math.hypot(nx - (me.x || 0), nz - (me.z || 0));
  const claimRadius = Object.hasOwn(CLAIM_RADIUS_KIND, kind) ? CLAIM_RADIUS_KIND[kind] : CLAIM_RADIUS;
  if (dist > claimRadius) {
    return res.status(403).json({ ok: false, error: "out of reach", dist: Math.round(dist) });
  }

  // 3. no claiming faster than a human can gather
  // WHO IS ACTUALLY CLAIMING? The handler accepts any presence id, but a WALLET is public — it is
  // published in /world/roster, world chat and on the market board — so a bare wallet here proves
  // nothing, and anyone can burn a victim's nodes and their claim budget in their name. A net_id is
  // different: it never leaves its owner's save, so it stands alone (same rule as presenceOk).
  //
  // OBSERVE ONLY for now. Refusing today would silence every already-shipped client, whose claims
  // carry no token — their nodes would stay standing for everyone else, which is the very desync
  // this is meant to fix. So it is recorded and reported, and the gate comes after the roster shows
  // the tokened client is in the wild.
  const claimProven = presenceOk(String(b.wallet), b);
  if (!claimProven) _unprovenClaims++;
  else _provenClaims++;

  const r = claimRate.get(b.wallet) || { last: 0, count: 0, windowStart: now };
  if (now - r.windowStart > 60000) { r.count = 0; r.windowStart = now; }
  if (now - r.last < CLAIM_MIN_MS) {
    // TELL THE CLIENT WHEN TO COME BACK. This returns BEFORE r.last is refreshed below, so a
    // rejected call does not extend the window — a client that waits retryInMs and re-sends gets
    // through. Without this a queued claim was simply lost, and the node stayed standing for
    // everyone else, which is exactly what the shared world is supposed to prevent.
    return res.status(429).json({ ok: false, error: "too fast", retryInMs: CLAIM_MIN_MS - (now - r.last) });
  }
  if (r.count >= CLAIM_BURST) {
    return res.status(429).json({ ok: false, error: "rate limited", retryInMs: Math.max(0, 60000 - (now - r.windowStart)) });
  }
  r.last = now; r.count += 1;
  claimRate.set(b.wallet, r);
  if (claimRate.size > 5000) {
    for (const [k, v] of claimRate) if (now - v.last > 120000) claimRate.delete(k);
  }

  const until = worldNodes.get(id) || 0;
  if (until > now) return res.json({ ok: false, taken: true, until });
  // COOLDOWN IS THE SERVER'S, NOT THE CALLER'S. `cd` used to come straight from the request body,
  // clamped only to 1..3600s — so a griefer could claim a node and ask for a FULL HOUR, locking it
  // for everyone. (Honest clients never actually chose it: no node carries a `cd` key, so
  // Gather.gd's best.get("cd", 60.0) always sent 60. Nothing legitimate depended on it.)
  // Derived from the node KIND, which is the part of the id the reach check already trusts.
  const cd = (Object.hasOwn(NODE_CD_S, kind) ? NODE_CD_S[kind] : NODE_CD_DEFAULT_S) * 1000;

  // MULTI-LOAD (trees): `uses` is how many loads a FULL node holds. Each claim spends exactly one —
  // the one-item-per-gather rule is unchanged, the trunk simply holds several. Only the claim that
  // takes the last load puts the node on its respawn cooldown, and that is the moment it falls for
  // everyone. A single-load node (every rock, bush and hive) never sends `uses` and is untouched.
  const uses = Object.hasOwn(NODE_USES, kind) ? NODE_USES[kind] : 1;
  if (uses > 1) {
    const rec = worldNodeUses.get(id);
    const left = (rec ? rec.left : uses) - 1;
    if (left > 0) {
      worldNodeUses.set(id, { left, ts: now });
      markNodesDirty();
      const drop1 = nodeDrop(kind);
      recordGather(b.wallet, kind, drop1);
      return res.json({ ok: true, taken: false, left, felled: false, drop: drop1 });
    }
    worldNodeUses.delete(id);
    worldNodes.set(id, now + cd);
    markNodesDirty();
    const drop2 = nodeDrop(kind);
    recordGather(b.wallet, kind, drop2);
    return res.json({ ok: true, taken: false, left: 0, felled: true, until: now + cd, drop: drop2 });
  }

  worldNodes.set(id, now + cd);
  markNodesDirty();
  const drop3 = nodeDrop(kind);   // the SINGLE-USE path — every node except wood comes through here
  recordGather(b.wallet, kind, drop3);
  res.json({ ok: true, taken: false, until: now + cd, drop: drop3 });
});

// ============ STEP 6 OF SERVER AUTHORITY: fishing joins the observed faucet (observe-only) ============
// Gathering has been server-observed since Step 1 (recordGather from /world/node/claim). Fishing was
// the one high-frequency MATERIAL faucet the server never saw at all — the "fish" material entered a
// save with no server event. That blind spot actively MISFIRED the oversold signal: it compares fish
// LISTED against gatherCount["fish"], which was permanently 0, so every honest angler who listed >50
// fish already looked suspicious. This closes it exactly the way gathering is closed: the client
// reports each catch, the server records ONE fish per catch into the same gatherCount tally.
//
// OBSERVE-ONLY, and deliberately not enforcement. The client still credits the fish locally (fishing
// stays client-authoritative until the whole material count is enforced — that flip waits for live
// data, like every gate in this migration). This only lets the server learn the plausible ceiling of
// fish a wallet has caught, so `caught >= held + sold` becomes a real invariant for fish. recordGather
// already counts pubkey wallets only, so an unsigned net_id catch is harmlessly ignored (they cannot
// sell on the market either). A live world presence is required (same gate as a node claim), and the
// COUNT is rate-capped to a human catch pace so a spammed report cannot inflate the ceiling it exists
// to bound — the cap under-counts nothing an honest angler could actually do (the reel minigame is
// slower than this), it only refuses a tight machine-gun loop.
const FISH_REC_MIN_MS = 800;         // cap the COUNTED rate to human scale; honest play never beats it
const _lastFishRec = new Map();      // wallet -> last COUNTED catch ms (anti-inflation, not a refusal)
app.post("/world/fish/report", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  // PROVE THE WALLET, don't just name it. A wallet is PUBLIC — /world/roster publishes every one —
  // so accepting a bare wallet let anyone write into a stranger's record (and manufacture the
  // "presence" below by POSTing /world/move in their name). presenceOk demands the market token for
  // a public wallet; a private net_id still stands alone, exactly as node claims work.
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ ok: false, error: "prove this wallet first" });
  const now = Date.now();
  // you have to actually be in the world (same presence gate as a node claim)
  const me = worldPlayers.get(String(b.wallet));
  if (!me || now - me.ts > WORLD_TTL_MS) return res.status(403).json({ ok: false, error: "no live presence" });
  // count at most one fish per human-plausible interval — a spammed loop cannot inflate the ceiling
  const last = _lastFishRec.get(String(b.wallet)) || 0;
  if (now - last < FISH_REC_MIN_MS) return res.json({ ok: true, counted: false });
  _lastFishRec.set(String(b.wallet), now);
  if (_lastFishRec.size > 20000) {   // bound the map like every other per-wallet map here
    for (const [k, t] of _lastFishRec) { if (now - t > 120000) _lastFishRec.delete(k); }
  }
  recordGather(String(b.wallet), "fish", ["fish"]);   // pubkey-only inside; net_id catches are ignored
  res.json({ ok: true, counted: true });
});

// ============ STEP 6: combat essence joins the observed faucet (observe-only) ============
// "essence" (Dark Energy) is the ONLY other material with no gather node — it drops from combat
// kills (Profile.on_kill), never from the ground. So, exactly like fishing was, it had gatherCount 0
// forever, which meant EVERY wallet listing >50 essence tripped the oversold signal. With fishing +
// this, all 14 materials now have a server-observed source and that whole false-positive class is
// gone. A kill is a discrete event like a catch, so the client reports it and the server records a
// per-kill CEILING of essence into the same gatherCount tally.
//
// A CEILING, deliberately over-generous, because the real drop is variable (mob essence 1..3 x an
// avatar perk up to 1.40 = at most 4 today) and the client must not be trusted for the amount. The
// server credits ESSENCE_PER_KILL (6) per counted kill — always >= what a kill could really give, so
// the bound never under-counts an honest fighter (and essence starts at 0 for everyone, so this can
// only ever REDUCE false positives, never create one). Same presence gate and rate-cap as fishing;
// the cap only refuses a machine-gun loop, never a human's combat pace.
const ESSENCE_PER_KILL = 6;          // >= max real essence per kill (3 x 1.40 perk = 4), with headroom
const KILL_REC_MIN_MS = 500;         // combat is slower than this; the cap only stops a spammed loop
const _lastKillRec = new Map();      // wallet -> last COUNTED kill ms (anti-inflation, not a refusal)
app.post("/world/kill/report", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ ok: false, error: "prove this wallet first" });
  const now = Date.now();
  const me = worldPlayers.get(String(b.wallet));
  if (!me || now - me.ts > WORLD_TTL_MS) return res.status(403).json({ ok: false, error: "no live presence" });
  const last = _lastKillRec.get(String(b.wallet)) || 0;
  if (now - last < KILL_REC_MIN_MS) return res.json({ ok: true, counted: false });
  _lastKillRec.set(String(b.wallet), now);
  if (_lastKillRec.size > 20000) { for (const [k, t] of _lastKillRec) { if (now - t > 120000) _lastKillRec.delete(k); } }
  // record the per-kill ceiling of essence — pubkey-only inside recordGather, net_id kills ignored
  recordGather(String(b.wallet), "essence", new Array(ESSENCE_PER_KILL).fill("essence"));
  res.json({ ok: true, counted: true });
});

// ============ THE WEEKLY RAID PRIZE IS THE SERVER'S TO GIVE ============
// MALGROTH pays 500 soft $CHIKI + 25 crystal, once a week. That "once" was enforced ENTIRELY by
// d["last_raid_week"] in the client save — and that field is in no _econ_sig version, so a player
// could reset it, keep a perfectly valid signature, and re-claim the prize as often as they could
// re-kill the boss. Crystal feeds the real-$CHIKI market rail, so this was a live value leak.
//
// The week is now the SERVER's record, keyed to the proven wallet. The client asks before paying
// out; a wallet that already claimed this week gets the consolation prize instead. Deliberately NOT
// a roll — the prize is fixed, so there is nothing to randomise, only a claim to gate.
//
// Honest offline play is unaffected: if the server cannot be reached the client falls back to its
// own weekly gate, which is exactly today's behaviour. That fallback is why sealing the field in the
// save signature is still worth doing (it closes the save-editor path even with no network) — that
// is a SIG_VER bump, batched with every other unsigned value gate rather than done piecemeal.
const raidClaim = new Map();         // wallet -> ISO week index already claimed
const RAID_WEEK = () => Math.floor(Date.now() / 604800000);
app.post("/world/raid/claim", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ ok: false, error: "prove this wallet first" });
  const now = Date.now();
  const me = worldPlayers.get(String(b.wallet));
  if (!me || now - me.ts > WORLD_TTL_MS) return res.status(403).json({ ok: false, error: "no live presence" });
  if (!isPubkey(String(b.wallet))) return res.json({ ok: true, granted: true });   // net_id: no server record to keep
  const week = RAID_WEEK();
  const w = String(b.wallet);
  if (raidClaim.get(w) === week) return res.json({ ok: true, granted: false, week });
  // CLAIM BEFORE ANSWERING — the same rule the egg restitution and meme-egg guards follow, so two
  // requests racing the same kill cannot both be told "granted"
  raidClaim.set(w, week);
  if (raidClaim.size > 20000) {      // bound it, evicting oldest, like every per-wallet map here
    let drop = Math.max(1, Math.floor(20000 * 0.05));
    for (const k of raidClaim.keys()) { if (drop-- <= 0) break; raidClaim.delete(k); }
  }
  _assetsDirty = true;
  res.json({ ok: true, granted: true, week });
});

// ============ STEP 6: the FULL material flow becomes observable (observe-only) ============
// gatherCount (+ the fish/kill reports) now covers every material SOURCE with a world event. What the
// server still could not see: materials LEAVING a wallet (crafting, egg tending, barters, feeding)
// and the handful of reward faucets with no world event (chests, tasks, raids, level milestones,
// masterwork refunds). The client now reports those as a batched stream of flow events.
//
// TWO TALLIES, KEPT DELIBERATELY SEPARATE FROM gatherCount:
//   matSpent  — client-declared spends. Declaring MORE spend only lowers the declarer's own plausible
//               balance, so this direction cannot be gamed upward.
//   matGained — client-declared non-gather gains. This IS the laundering direction (a cheater could
//               claim huge chest luck to explain a forged stockpile), so it is whitelisted to real
//               materials, quantity-capped per event, rate-limited per wallet — and it NEVER feeds
//               gatherCount or the oversold signal, which stay on position-authorized evidence only.
//               matGained exists as telemetry: it shows the true magnitude of the reward faucets
//               across the honest fleet, which is exactly the data the eventual enforcement
//               thresholds must be designed from. Enforcement itself will not trust these numbers;
//               it will move the reward rolls server-side (as egg hatches already did) — documented
//               in the migration plan, deliberately not attempted here.
// OBSERVE-ONLY: nothing here blocks, clamps, or rejects anything a player does.
const MAT_IDS = new Set(["wood", "stone", "iron", "gold", "crystal", "seashell", "hide", "fish",
                         "honey", "berries", "flower", "pork", "beef", "essence"]);
const FLOW_SPEND = new Set(["craft", "tend", "eggtrade", "scroll", "eggrecipe", "feed"]);
const FLOW_GAIN = new Set(["chest", "task", "raid", "milestone", "refund"]);
const FLOW_MIN_MS = 3000;            // count at most one batch per wallet per 3s (client pushes ~5s)
const FLOW_EV_MAX = 32;              // events per counted batch
const FLOW_QTY_MAX = 600;            // > the largest legitimate single event (rod10 wood = 258)
const matSpent = new Map();          // wallet -> { mat: n }  (null-proto values)
const matGained = new Map();         // wallet -> { mat: n }
const _lastFlowRec = new Map();      // wallet -> last COUNTED batch ms
function _flowAdd(map, wallet, mat, n) {
  const g = _tallyRow(map, wallet);               // same evict-oldest policy as gatherCount
  g[mat] = (g[mat] || 0) + n;
}
export function _flowFor(wallet) { return { spent: matSpent.get(wallet) || null, gained: matGained.get(wallet) || null }; }
// A value the client sent may be a hostile OBJECT, and both String(x) and Number(x) invoke its
// toString/valueOf — so `{"toString":1,"valueOf":1}` throws a TypeError inside the handler. That
// answered 500, aborted the batch mid-loop (dropping the honest events after the poison), and burnt
// the wallet's rate window. Coerce only primitives; anything else is simply not a value.
const safeStr = (v) => (typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : "");
const safeNum = (v) => (typeof v === "number" ? v : (typeof v === "string" ? Number(v) : NaN));
app.post("/world/mat/flow", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  // PROVE THE WALLET (see /world/fish/report) — a public wallet is not a credential
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ ok: false, error: "prove this wallet first" });
  const now = Date.now();
  const me = worldPlayers.get(String(b.wallet));
  if (!me || now - me.ts > WORLD_TTL_MS) return res.status(403).json({ ok: false, error: "no live presence" });
  if (!isPubkey(String(b.wallet))) return res.json({ ok: true, counted: false });   // telemetry is wallet-keyed
  const last = _lastFlowRec.get(String(b.wallet)) || 0;
  if (now - last < FLOW_MIN_MS) return res.json({ ok: true, counted: false });
  const evs = Array.isArray(b.ev) ? b.ev.slice(0, FLOW_EV_MAX) : [];
  if (!evs.length) return res.json({ ok: true, counted: false });
  _lastFlowRec.set(String(b.wallet), now);
  if (_lastFlowRec.size > 20000) { for (const [k, t] of _lastFlowRec) { if (now - t > 120000) _lastFlowRec.delete(k); } }
  let counted = 0;
  for (const ev of evs) {
    if (!ev || typeof ev !== "object") continue;
    const kind = safeStr(ev.k);
    const isSpend = FLOW_SPEND.has(kind);
    if (!isSpend && !FLOW_GAIN.has(kind)) continue;                  // unknown kinds are ignored
    const m = (ev.m && typeof ev.m === "object") ? ev.m : {};
    for (const mat of Object.keys(m)) {
      if (!Object.prototype.hasOwnProperty.call(m, mat)) continue;
      if (!MAT_IDS.has(mat)) continue;                               // real materials only — junk keys never touch a map
      const q = safeNum(m[mat]);
      if (!Number.isFinite(q) || !(q > 0)) continue;
      // CLAMP, don't bit-twiddle. `q | 0` is ToInt32, so 2147483648 wrapped to -2147483648 and a
      // "cap" wrote a NEGATIVE tally that no lower bound caught. Floor into [1, FLOW_QTY_MAX].
      _flowAdd(isSpend ? matSpent : matGained, String(b.wallet), mat,
               Math.max(1, Math.min(FLOW_QTY_MAX, Math.floor(q))));
      counted++;
    }
  }
  if (counted) _assetsDirty = true;
  res.json({ ok: true, counted: counted > 0 });
});

// the world's currently-spent nodes, so a client can hide what someone else already took
// Provenance for one wallet's assets: what it holds, when each first appeared, and how.
// Readable by the PROVEN owner or an admin — an asset record is as sensitive as the roster itself.
app.get("/assets/audit", (req, res) => {
  const w = String(req.query?.wallet || "");
  if (!isPubkey(w)) return res.status(400).json({ error: "valid wallet required" });
  const admin = cupAdminOk(req);   // same ADMIN_KEY / admin-wallet gate the Cup uses
  if (!admin && mktWallet({ wallet: w, mktToken: String(req.query?.mktToken || "") }) !== w) {
    return res.status(403).json({ error: "prove this wallet first" });
  }
  // DO NOT distinguish "no record" from "not loaded". `known:false` was a free, authenticated,
  // self-service oracle telling a cheater the exact moment the ledger was empty — i.e. when a
  // forged roster would be grandfathered. It is the defender's blind spot, reported to the
  // attacker on request. A ledger that has not restored yet answers 503 instead.
  if (!_assetsReady) return res.status(503).json({ error: "asset ledger is still loading" });
  const rec = assetLedger.get(w);
  // A wallet with no ledger record still has telemetry — and that shape (activity, no cloud save) is
  // exactly the bot shape most worth reviewing. Returning bare zeros here hid it from the one view
  // built to look at it.
  if (!rec) return res.json({ wallet: w, units: {}, mounts: {}, unverified: 0,
                              gathered: gatherCount.get(w) || {},
                              spent: matSpent.get(w) || {}, gained: matGained.get(w) || {} });
  res.json({ wallet: w, firstSeen: rec.first, unverified: rec.unverified,
             units: rec.units, mounts: rec.mounts, eggsHeld: rec.eggsLast,
             gathered: gatherCount.get(w) || {},
             // Step 6 flow telemetry: spends are self-limiting; gains are CLIENT-CLAIMED and never
             // feed the oversold signal — shown here so a human reads all three side by side
             spent: matSpent.get(w) || {}, gained: matGained.get(w) || {} });
});

// Game-wide authenticity summary (admin): how much of what exists cannot be accounted for.
app.get("/assets/summary", (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  let wallets = 0, units = 0, mounts = 0, unver = 0;
  const byOrigin = {};
  // observed single-save level jumps, so a plausibility threshold can be set from the real
  // distribution rather than guessed. Nothing is blocked on this yet.
  const jumps = [];
  for (const [w, r] of assetLedger) {
    wallets++;
    for (const [uid, u] of Object.entries(r.units)) {
      units++; byOrigin[u.origin] = (byOrigin[u.origin] || 0) + 1;
      if (u.jump > 4) jumps.push({ w: w.slice(0, 8), uid, sp: u.sp, jump: u.jump, lvl: u.lvl, origin: u.origin });
    }
    for (const m of Object.values(r.mounts)) { mounts++; byOrigin[m.origin] = (byOrigin[m.origin] || 0) + 1; }
    unver += r.unverified;
  }
  jumps.sort((a, b) => b.jump - a.jump);
  // materials on sale vs materials ever gathered. NOT an accusation — crafting, quests, chests and
  // trades all add materials the claim counter never saw — but a wallet selling six figures of a
  // material it has pulled twenty of is worth a human look.
  const oversold = [];
  for (const row of marketListings) {
    if (!isPubkey(String(row.wallet || ""))) continue;
    if (!["mat", "ffish", "pot"].includes(String(row.kind))) continue;
    // `item` is attacker-chosen free text and the `|| {}` fallback used to be a PLAIN object, so
    // listing an item named "toString" resolved to a function, `got * 10` was NaN, and `qty > NaN`
    // is false — the check silently disabled itself. Own-property lookup only, numbers only.
    const _grow = gatherCount.get(row.wallet);
    const _gv = (_grow && Object.prototype.hasOwnProperty.call(_grow, row.item)) ? Number(_grow[row.item]) : 0;
    const got = Number.isFinite(_gv) && _gv > 0 ? _gv : 0;
    const qty = Number(row.qty) || 0;
    if (qty > Math.max(50, got * 10)) {
      oversold.push({ w: row.wallet.slice(0, 8), item: row.item, kind: row.kind, listed: qty, everGathered: got });
    }
  }
  oversold.sort((a, b) => b.listed - a.listed);
  res.json({ wallets, units, mounts, unverified: unver, byOrigin,
             mountsAdopted: _mountsAdopted, chikisAdopted: _chikisAdopted,
             matFlow: { spendingWallets: matSpent.size, gainingWallets: matGained.size },
             nodeClaims: { proven: _provenClaims, unproven: _unprovenClaims,
                           provenPct: (_provenClaims + _unprovenClaims) ? Math.round(100 * _provenClaims / (_provenClaims + _unprovenClaims)) : 0 },
             biggestLevelJumps: jumps.slice(0, 40), oversoldMaterials: oversold.slice(0, 40) });
});

app.get("/world/nodes", (_req, res) => {
  const now = Date.now();
  const out = {};
  for (const [k, t] of worldNodes) if (t > now) out[k] = t - now;
  // partially-worked multi-load nodes, so a client can reconcile a half-chopped trunk it never
  // touched itself. Absent id = full. An older client simply ignores this field.
  const uses = {};
  for (const [k, u] of worldNodeUses) if (now - u.ts <= NODE_USES_TTL_MS) uses[k] = u.left;
  res.json({ nodes: out, uses, ts: now });
});

function worldSnapshot(wallet, x, z) {
  const now = Date.now(), out = [];
  for (const [w, p] of worldPlayers) {
    if (now - p.ts > WORLD_TTL_MS) { worldPlayers.delete(w); continue; }
    if (w === wallet) continue;
    const d = Math.hypot((p.x || 0) - x, (p.z || 0) - z);
    if (d > WORLD_RADIUS) continue;
    out.push({ d, wallet: w, x: p.x, y: p.y || 0, z: p.z, dir: p.dir, handle: p.handle, leg: p.leg, el: p.el, br: p.br, avatar: p.avatar, comp: p.comp, party: p.party, mount: p.mount || "", act: p.act || "" });
  }
  // NEAREST FIRST, then cap. This used to `slice(0, 60)` straight off Map iteration order — which
  // is INSERTION order, i.e. oldest sessions first. With more than 60 trainers in range, #61
  // onward were permanently invisible no matter how close they were standing, and anyone who
  // reconnected went to the back of the queue behind players on the far side of the island.
  // Sorting by distance makes the cap mean "the 60 nearest", which is what interest management is
  // for. The radius is deliberately left alone: it is wider than the island, so it excludes nobody
  // today, and narrowing it would change who you can see — a gameplay change, not a fix.
  out.sort((a, b) => a.d - b.d);
  const near = out.slice(0, WORLD_MAX_PEERS);
  for (const e of near) delete e.d;   // `d` is a sort key, never part of the wire contract
  return near;
}
// Broadcast my position (and get nearby players back in one round-trip).
// A presence id is EITHER a public wallet or a private net_id, and only one of those can act as a
// credential. Wallets are published in /world/roster, world chat and on the market board — so a
// route that trusts a bare wallet is trusting something anyone can read. A net_id never leaves its
// owner's save, so it is still a shared secret between that client and this server.
// Therefore: a WALLET must be proven with the market token /verify issued; a net_id may stand alone.
// This keeps non-wallet and demo players working exactly as before while closing the exposure that
// only affects wallet players — who are precisely the ones with something to lose.
function presenceOk(id, body) {
  if (!isPresenceId(id)) return false;
  if (!isPubkey(id)) return true;                 // private net_id — the id IS the secret
  return mktWallet(body) === id;                  // public wallet — must be proven
}


// ---- MATERIAL PROVENANCE (observe only) --------------------------------------------------------
// Materials, fantasy fish and potions are listable on the real-$CHIKI rail and have no provenance
// record at all — a crafted save can set mats.crystal = 999999 and sell it, leaving strictly less
// evidence than a forged chikimon does. There is, however, one thing the server already owns:
// node claims. Ids are "kind:ix:iz", every claim is position-authorised and rate-limited, and the
// game's hard rule is exactly one item per gather. So the claim count IS the honest ceiling on how
// much of a material a wallet has ever pulled out of the ground.
//
// OBSERVE ONLY, for the same reason the level jump is: materials also arrive from crafting, quests,
// chests and trades, so `sold > gathered` is not proof of anything and a gate here would refuse
// real players. This records the ceiling and puts it next to what they are selling, so the
// discrepancy is visible and a rule can be written from real data rather than from my assumption.
const gatherCount = new Map();          // wallet -> { kind: n }
const GATHER_WALLETS_MAX = 20000;
// THE BOUND MUST NOT BECOME THE WEAPON. These maps used to REFUSE a new wallet once full, which
// turned the cap into a denial-of-record: fill 20k slots with junk and every player who arrives
// afterwards is never recorded, so their honest listings read as "gathered 0" and are flagged
// forever while the flooder hides in the noise. Evicting the OLDEST rows instead means a flood ages
// itself out as real play continues, and a newcomer is always recordable. Map iterates in insertion
// order, so this drops the least-recently-created rows. Losing an old telemetry row is harmless —
// unlike assetLedger rows, nothing here is evidence of ownership or a flag anyone can be judged on.
function _tallyRow(map, wallet) {
  let g = map.get(wallet);
  if (g) return g;
  if (map.size >= GATHER_WALLETS_MAX) {
    let drop = Math.max(1, Math.floor(GATHER_WALLETS_MAX * 0.05));   // shed 5% so this is rare
    for (const k of map.keys()) { if (drop-- <= 0) break; map.delete(k); }
  }
  g = Object.create(null); map.set(wallet, g);
  return g;
}
function recordGather(wallet, kind, drop) {
  if (!isPubkey(String(wallet || "")) || !kind) return;
  // Count the MATERIALS, not the node kind. The oversold check compares this against what a wallet
  // lists for sale, and nobody sells a "cow" — they sell beef and hide.
  const mats = Array.isArray(drop) && drop.length ? drop : [kind];
  const g = _tallyRow(gatherCount, wallet);
  for (const m of mats) g[m] = (g[m] || 0) + 1;
  _assetsDirty = true;
}
export function _gatheredFor(wallet) { return gatherCount.get(wallet) || null; }

// ============ ASSET REGISTRY — server-minted, permanent, transfer-only ============
// The ledger below INFERS provenance from consecutive cloud saves. That can be sharpened but never
// finished, because the save is authored and sampled by the client: it can only ever check that the
// player's own story is self-consistent. Six things are unreachable by any refinement of it —
// avatars and scrolls (never transmitted anywhere the server records), backdated egg timers
// (client-authored), material quantities, mount identity (a six-value namespace with no per-instance
// id), the existence of an egg at all, and cross-wallet cloning (one forged legendary sold to five
// buyers is five unrelated "new units").
//
// Every one of those becomes a lookup the moment the SERVER mints the asset. This registry is that:
//   * an id the server issues and the client cannot choose
//   * a birth timestamp the server writes, so incubation is real elapsed time
//   * a hatch ROLL the server performs, so a cheater cannot pick the griffin
//   * a provenance chain that is append-only
//   * ownership that changes only through a verified transfer
//
// A registered asset therefore CANNOT BE ERASED OR FORGED: a save that omits it does not destroy it
// (the registry is authoritative and hands it back), and a save that invents one cannot produce a
// registry id, because ids come from here. Eggs are consumed, never deleted — a consumed egg keeps
// its row and points at what hatched from it. That permanence, plus a stable id and a full lineage,
// is exactly what a future NFT mint needs in order to trust the record.
//
// ADDITIVE BY DESIGN. These are new endpoints; the live client does not call them yet, so no
// existing behaviour changes. As the client adopts them, assets gain registry identity — and the
// ledger keeps covering everything that predates adoption.
const assetReg = new Map();             // assetId -> row
const assetsByOwner = new Map();        // wallet  -> Set(assetId)
const ASSET_REG_MAX = 400000;

// Mirrors of the client's own tables (Econ.gd). The hatch rolls HERE, so these must match, and a
// mismatch shows up as a species the client cannot render rather than as a silent exploit.
const SPECIES_NORMAL = Object.freeze(["drolax", "electrox", "firix", "forestle", "healix",
                                      "jellox", "mushrow", "owzard", "scorplex", "solarix"]);
const SPECIES_LEGEND = Object.freeze(["galador", "adalor", "tyrannos", "grovador", "dragonos"]);
const SPECIES_MEME   = Object.freeze(["popcat", "moodeng", "doge", "pepe", "chillguy", "alon"]);
// supply-weighted exactly as Econ.MOUNTS: the Mythic griffin is the longest shot, and rolling it
// server-side is the point — a crafted save used to simply name it.
const MOUNT_SUPPLY = Object.freeze([["chicken", 15], ["boar", 20], ["gator", 15],
                                    ["horse", 10], ["wolf", 10], ["griffin", 5]]);
const AVATAR_IDS = Object.freeze(["classic", "Knight", "Mystic", "Navigator", "Star",
                                  "chemist", "electro", "fire", "night", "sailor"]);
const EGG_KIND_POOL = Object.freeze(Object.assign(Object.create(null), {
  normal: SPECIES_NORMAL, legendary: SPECIES_LEGEND, meme: SPECIES_MEME,
}));
const AVATARS_MAX = 2;                  // the client's own hard cap (GameHUD._azulon_buy)

let _regSeq = 0;
function mintAssetId(type) {
  // Unguessable and unique: the client must never be able to name an id it does not already hold.
  return `${type[0]}${Date.now().toString(36)}${(++_regSeq).toString(36)}${crypto.randomBytes(6).toString("hex")}`;
}
function ownerSet(w) { let s = assetsByOwner.get(w); if (!s) { s = new Set(); assetsByOwner.set(w, s); } return s; }
// Does the registry hold an ACTIVE, CLEAN-ORIGIN asset of this type and species for this wallet?
// This is the bridge that stops the inference-based ledger from condemning something the server
// itself minted — but a vouch must come only from a CLEAN origin. The adoption routes
// (/assets/mounts/sync, /assets/chikimon/sync) mint registry rows for ledger units of EVERY origin,
// including "unverified", so that a flagged creature still has a permanent, honestly-labelled record.
// Without the origin gate those adopted-unverified rows would vouch: the sale gate's species fallback
// would flip block→allow for a flagged creature listed without its real uid, and the audit grader
// would launder a churned re-save (fresh uid) from "unverified" to "issued". An unverified row is the
// server declining to vouch — it must never itself become a vouch. ORIGIN_CLEAN excludes exactly
// "unverified"; every legitimate origin (legacy/hatched/purchased/issued/traded/restitution) still
// vouches, so no genuine hatch or legacy creature is affected.
function regVouchesSpecies(wallet, type, sp) {
  for (const id of (assetsByOwner.get(wallet) || [])) {
    const r = assetReg.get(id);
    if (r && r.type === type && r.state === "active" && r.sp === sp && ORIGIN_CLEAN.has(r.origin)) return true;
  }
  return false;
}
function regOwned(wallet, type, state = "active") {
  const out = [];
  for (const id of (assetsByOwner.get(wallet) || [])) {
    const r = assetReg.get(id);
    if (r && r.type === type && (!state || r.state === state)) out.push(r);
  }
  return out;
}
// Append-only history. Nothing in this file ever rewrites or removes a chain entry — the chain IS
// the provenance, and a mutable provenance is not one.
function regEvent(row, what, extra) { row.chain.push(Object.assign({ at: Date.now(), what }, extra || {})); }

let _regWarnAt = 0;
function mintAsset(type, wallet, fields, origin, parent) {
  if (assetReg.size >= ASSET_REG_MAX) throw new Error("asset registry is full");
  // the cap is a cliff for EVERY player at once, so it must never arrive unannounced
  if (assetReg.size > ASSET_REG_MAX * 0.8 && Date.now() - _regWarnAt > 300000) {
    _regWarnAt = Date.now();
    console.warn(`asset registry at ${assetReg.size}/${ASSET_REG_MAX} — plan capacity before it fills`);
  }
  const id = mintAssetId(type);
  const row = Object.assign({
    id, type, owner: wallet, born: Date.now(), origin, state: "active",
    parent: parent || null, chain: [],
  }, fields || {});
  regEvent(row, "minted", { to: wallet, origin });
  assetReg.set(id, row);
  ownerSet(wallet).add(id);
  _assetsDirty = true;
  return row;
}

// Ownership moves ONLY through here, and the old owner's claim is removed in the same step — which
// is what makes a registered asset impossible to clone: it exists once, in one place.
function transferAsset(id, from, to, why, extra) {
  // Validate the DESTINATION. Without this, a transfer to a garbage string moved the asset to an
  // owner no wallet can ever prove — an irrecoverable erase, and a griefing primitive the moment
  // any route passes a client-supplied `to`.
  if (!isPubkey(to) || to === from) return null;
  const row = assetReg.get(id);
  if (!row || row.owner !== from || row.state !== "active") return null;
  row.owner = to;
  ownerSet(from).delete(id);
  ownerSet(to).add(id);
  regEvent(row, "transferred", Object.assign({ from, to, why }, extra || {}));
  _assetsDirty = true;
  return row;
}

function eggReadyAt(row) { return row.born + (EGG_HOURS[row.kind] || 3) * 3600 * 1000; }

// Deterministic-free, server-side roll. crypto.randomInt is used rather than Math.random because
// this decides real value — which mount, which legendary — and a predictable roll is a cheat.
function pickWeighted(pairs) {
  const total = pairs.reduce((a, p) => a + p[1], 0);
  if (total <= 0) return null;
  let roll = crypto.randomInt(total);
  for (const [id, w] of pairs) { if (roll < w) return id; roll -= w; }
  return pairs[pairs.length - 1][0];
}

// What this wallet already holds, from BOTH sources: the registry (what the server minted) and the
// ledger (what predates it). The client's rule is one of each species ever, so the roll must respect
// everything the player owns, not just the part this system issued.
function ownedSpecies(wallet) {
  const own = new Set();
  for (const r of regOwned(wallet, "chikimon")) own.add(r.sp);
  const lrec = assetLedger.get(wallet);
  if (lrec) for (const u of Object.values(lrec.units)) own.add(u.sp);
  return own;
}
function ownedMounts(wallet) {
  const own = new Set();
  for (const r of regOwned(wallet, "mount")) own.add(r.sp);
  const lrec = assetLedger.get(wallet);
  if (lrec) for (const id of Object.keys(lrec.mounts)) own.add(id);
  return own;
}

// ---- endpoints -----------------------------------------------------------------------------
// Every one requires a PROVEN wallet (the market token bound at /verify) — a bare wallet address is
// public and proves nothing.
function regWallet(req) {
  const b = req.body || {};
  const w = String(b.wallet || "");
  return mktWallet({ wallet: w, mktToken: String(b.mktToken || "") });
}
const EGG_CLAIM_MIN_MS = 5000;          // a human bartering at Mithra cannot beat this
const _lastEggClaim = new Map();

// Issue an egg. The client has already taken the barter from the player's own inventory; what the
// server adds — and what the client cannot fake — is the identity and the clock.
app.post("/assets/egg/claim", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  const kind = String(req.body?.kind || "");
  if (!["normal", "legendary", "meme", "mount"].includes(kind)) return res.status(400).json({ error: "unknown egg kind" });
  const now = Date.now();
  if (now - (_lastEggClaim.get(wallet) || 0) < EGG_CLAIM_MIN_MS) return res.status(429).json({ error: "too fast" });
  // the client's own rule: one egg of each kind at a time (Profile.gd start_egg)
  if (regOwned(wallet, "egg").some(e => e.kind === kind)) {
    return res.status(409).json({ error: "your nest already cradles an egg of that kind" });
  }
  _lastEggClaim.set(wallet, now);
  let row;
  try { row = mintAsset("egg", wallet, { kind, sp: kind }, "issued"); }
  catch (e) { return res.status(503).json({ error: "the asset registry is at capacity — this is a server fault, not yours; nothing was consumed" }); }
  res.json({ ok: true, egg: { id: row.id, kind, born: row.born, readyAt: eggReadyAt(row) } });
});

// Hatch. The server checks the clock IT wrote, rolls the result ITSELF, consumes the egg forever,
// and mints the creature. A crafted save can do none of those four things.
app.post("/assets/egg/hatch", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  const id = String(req.body?.id || "").slice(0, 64);
  const row = assetReg.get(id);
  if (!row || row.type !== "egg" || row.owner !== wallet) return res.status(404).json({ error: "no such egg" });
  if (row.state !== "active") return res.status(409).json({ error: "that egg has already hatched" });
  const ready = eggReadyAt(row);
  if (Date.now() < ready) return res.status(425).json({ error: "still incubating", readyIn: ready - Date.now() });

  let born;
  try {
  if (row.kind === "mount") {
    const have = ownedMounts(wallet);
    const pool = MOUNT_SUPPLY.filter(([mid]) => !have.has(mid));
    if (!pool.length) return res.status(409).json({ error: "your stable is already full" });
    born = mintAsset("mount", wallet, { sp: pickWeighted(pool), kind: "mount" }, "hatched", row.id);
  } else {
    const have = ownedSpecies(wallet);
    const pool = (EGG_KIND_POOL[row.kind] || SPECIES_NORMAL).filter(s => !have.has(s));
    if (!pool.length) return res.status(409).json({ error: "you already own every species from that egg" });
    const sp = pool[crypto.randomInt(pool.length)];
    born = mintAsset("chikimon", wallet, { sp, kind: row.kind === "normal" ? "normal" : row.kind, lvl: 1 }, "hatched", row.id);
  }
  } catch (e) {
    // the egg is NOT consumed on failure — a capacity fault must never destroy what a player paid for
    return res.status(503).json({ error: "the asset registry is at capacity — your egg is safe, try again later" });
  }
  // CONSUMED, NOT DELETED. The egg keeps its row and points at what came out of it, so the
  // creature's lineage is readable forever — and the egg can never vouch a second hatch.
  row.state = "consumed";
  row.hatchedTo = born.id;
  regEvent(row, "hatched", { into: born.id, sp: born.sp });
  _assetsDirty = true;
  res.json({ ok: true, hatched: { id: born.id, type: born.type, sp: born.sp, kind: born.kind, born: born.born, from: row.id } });
});

// Report a hatch that the CLIENT rolled, so the registered egg is consumed and the creature it
// produced inherits its lineage. This is the halfway house between "no registry at all" and the
// fully server-authoritative /assets/egg/hatch above: the species is still the client's choice here,
// so the creature is recorded as "hatched" rather than "issued" — a real lineage, honestly labelled,
// not a claim that the server rolled it.
//
// What it DOES buy, and the reason it exists: the egg is marked consumed with a server timestamp,
// so it can never be presented again or vouch a second hatch, and the creature carries a permanent
// parent link back to the egg that was genuinely paid for.
app.post("/assets/egg/consume", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  const id = String(req.body?.id || "").slice(0, 64);
  const row = assetReg.get(id);
  if (!row || row.type !== "egg" || row.owner !== wallet) return res.status(404).json({ error: "no such egg" });
  if (row.state !== "active") return res.status(409).json({ error: "that egg has already hatched" });
  // the same incubation floor the server-rolled hatch enforces — a registered egg cannot be
  // reported as hatched before it could possibly have finished
  const ready = eggReadyAt(row);
  if (Date.now() < ready) return res.status(425).json({ error: "still incubating", readyIn: ready - Date.now() });

  const sp = String(req.body?.sp || "").slice(0, 24);
  const isMount = row.kind === "mount";
  const pool = isMount ? MOUNT_SUPPLY.map(m => m[0]) : (EGG_KIND_POOL[row.kind] || SPECIES_NORMAL);
  if (!pool.includes(sp)) return res.status(400).json({ error: "that is not something this egg can produce" });

  let born;
  try {
    born = mintAsset(isMount ? "mount" : "chikimon", wallet,
      { sp, kind: isMount ? "mount" : (row.kind === "normal" ? "normal" : row.kind), lvl: 1 }, "hatched", row.id);
  } catch (e) { return res.status(503).json({ error: "the asset registry is at capacity — your egg is safe, try again later" }); }
  row.state = "consumed";
  row.hatchedTo = born.id;
  regEvent(row, "hatched", { into: born.id, sp });
  _assetsDirty = true;
  res.json({ ok: true, hatched: { id: born.id, type: born.type, sp: born.sp, from: row.id } });
});

// ============ STEP 3 OF SERVER AUTHORITY: THE REGISTRY IS THE CANONICAL STABLE ============
// Until now mount ownership lived in the client-authored save, and the server merely observed it
// (the ledger's delta inference). This route flips that: it converts what the LEDGER already
// believes a wallet holds into registry PROPERTY — carrying the ledger's own origin, so nothing is
// laundered (an unverified mount stays unverified forever, on its own row) — and answers with the
// registry's canonical species list, which the client adopts at sign-in.
//
// DELIBERATELY, THE REQUEST NAMES NO MOUNT. Adoption reads only the server's own records, so this
// route adds zero attacker-controlled input: a crafted body cannot ask for anything. A species the
// ledger has never seen is simply not adopted this pass — the wallet's next save audit records it,
// and the sign-in after that adopts it. Convergence over two sign-ins, no shortcut to forge.
//
// The answer grows an honest stable — everything ledger-known is adopted before the list is read
// back — with ONE exception: at ASSET_REG_MAX the mints fail and the answer can come back short of,
// or emptier than, what the wallet actually holds (the species list is read from the registry, and
// at capacity nothing was written to it). So the client must NOT trust this answer as a superset on
// its own. The safety that lets the client replace its local list wholesale lives on the CLIENT:
// _adopt_stable()'s superset guard keeps the local list untouched whenever the answer is missing a
// catalog steed it already holds. Given that guard, a wiped or stale save recovers its steeds from
// the registry, and a full registry simply defers recovery to a later sync — never a wipe. That is
// "cannot be erased" made real, and it is the two halves together, not this route alone.
const MOUNT_IDS = new Set(MOUNT_SUPPLY.map((m) => m[0]));
let _mountsAdopted = 0;
app.post("/assets/mounts/sync", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });

  const ownedSp = new Set(regOwned(wallet, "mount").map((r) => r.sp));
  const adopted = [];
  const lrec = assetLedger.get(wallet);
  if (lrec) {
    for (const sp of Object.keys(lrec.mounts)) {
      if (!MOUNT_IDS.has(sp)) continue;     // catalog species only — ledger keys are clamped text, not validated
      if (ownedSp.has(sp)) continue;        // already property; adoption is one row per species per wallet
      const lo = lrec.mounts[sp] && lrec.mounts[sp].origin;
      const origin = ORIGINS.has(lo) ? lo : "unverified";   // the ledger's verdict rides along, never upgraded
      try {
        mintAsset("mount", wallet, { sp, kind: "mount" }, origin);
        ownedSp.add(sp); adopted.push(sp); _mountsAdopted++;
      } catch (e) { break; }   // capacity: adopt what fits — the rest stays ledger-known and retries next sync
    }
  }

  // the canonical answer: unique active species, one card per species even if old consume reports
  // ever minted a duplicate row
  const seen = new Set(); const cards = [];
  for (const r of regOwned(wallet, "mount")) {
    if (seen.has(r.sp)) continue;
    seen.add(r.sp);
    cards.push({ id: r.id, sp: r.sp, origin: r.origin, born: r.born });
  }
  res.json({ ok: true, species: [...seen], mounts: cards, adopted });
});

// ============ STEP 5 OF SERVER AUTHORITY: legacy chikimon become permanent registry assets ============
// Before this, only chikimon HATCHED-and-reported through the egg routes had a registry row; every
// legacy creature existed only in the delta-inference LEDGER (capped at 20k wallets, evictable when
// clean, gone if a save is wiped). This adopts the wallet's ledger-known, currently-held creatures
// into the registry as permanent property, carrying the ledger's own origin — so an "unverified"
// creature mints an "unverified" row and stays blocked, exactly as mounts/sync does. After this a
// chikimon cannot be forged or erased: whatever a save says, the registry is the record.
//
// TWO HARD DIFFERENCES FROM MOUNTS, forced by the data shapes (see the recon):
//   1. A chikimon is IDENTITY + a save-only progression bundle (level, BR, skill points, card tiers,
//      battle XP, nickname, mood) the registry never stored and cannot regenerate. So this route is
//      ADOPT-ONLY: it makes the creature a permanent asset, but the client must NEVER replace its
//      roster from this answer (that would wipe every level). The client only stamps the registry id
//      onto its matching creature — additive, never a state overwrite.
//   2. The registry has no per-creature save uid, so adoption is SPECIES-LEVEL (one row per species,
//      the exact granularity regVouchesSpecies and the sale gate already consume). The birth `lvl`
//      is meaningless (always 1) and is deliberately not returned as live state.
// The sale gate is unchanged and NEUTRAL to this: its strong per-uid check still runs first and still
// blocks a known-unverified or no-longer-held uid; a species this route vouches was already vouchable
// via the ledger's species fallback, so nothing that could not be listed before can be listed now.
const CHIKIMON_IDS = new Set([...SPECIES_NORMAL, ...SPECIES_LEGEND, ...SPECIES_MEME]);
let _chikisAdopted = 0;
app.post("/assets/chikimon/sync", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });

  const ownedSp = new Set(regOwned(wallet, "chikimon").map((r) => r.sp));
  const adopted = [];
  const lrec = assetLedger.get(wallet);
  if (lrec) {
    for (const uid of Object.keys(lrec.units)) {
      const u = lrec.units[uid];
      if (!u || u.held === false) continue;      // only creatures currently in the roster
      const sp = String(u.sp || "");
      if (!CHIKIMON_IDS.has(sp)) continue;        // catalog species only — ledger keys are clamped text
      if (ownedSp.has(sp)) continue;              // already property; one row per species per wallet
      const origin = ORIGINS.has(u.origin) ? u.origin : "unverified";   // the ledger's verdict rides along, never upgraded
      try {
        mintAsset("chikimon", wallet, { sp, kind: String(u.kind || "normal").slice(0, 12), lvl: 1 }, origin);
        ownedSp.add(sp); adopted.push(sp); _chikisAdopted++;
      } catch (e) { break; }   // capacity: adopt what fits — the rest stays ledger-known and retries next sync
    }
  }

  // the canonical answer: unique active species with provenance, one card per species. `lvl` is the
  // frozen birth level (1) — NOT live state; the client keeps its own level and only reads id/sp.
  const seen = new Set(); const cards = [];
  for (const r of regOwned(wallet, "chikimon")) {
    if (seen.has(r.sp)) continue;
    seen.add(r.sp);
    cards.push({ id: r.id, sp: r.sp, kind: r.kind, origin: r.origin, born: r.born });
  }
  res.json({ ok: true, species: [...seen], chikimon: cards, adopted });
});

// Redeem an Avatar Scroll. Avatars had NO server record of any kind — adding one to a save was free
// and permanent, and each carries a rarity-scaled perk that converts into materials, which do sell
// on the real rail. The look is rolled here, from what the wallet does not already own.
// ============ v8 EGG RESTITUTION ============
// WHAT HAPPENED. The egg seal floor shipped enforced-immediately at 2026-07-27 18:41 UTC and the
// grace window was restored at 2026-07-28 00:10 UTC. For those ~5.5 hours a v8 save carrying an egg
// was forced through the v9 payload, failed its signature, and took the ordinary tamper response —
// which zeroes d["eggs"]. Restoring the deadline stopped further losses; it did not give anything
// back, and profiles are stored with ON CONFLICT DO UPDATE, so there is no previous version to
// recover. Nobody was made whole.
//
// WHAT CAN BE RECONSTRUCTED. The tamper response clears chests/nest/eggs/quest_vault/
// last_verified_balance/trade_in — it does NOT clear d["prog"], and the lifetime counters live
// there: `eggmake_<kind>` when Mithra conjures one, `hatch_<kind>` when it hatches. So for each kind
//
//     owed = eggmake  -  hatched  -  still held
//
// is exactly what this player paid fantasy fish and materials for and never received. It is not a
// gift and it cannot inflate: a wallet that never made an egg is owed nothing.
//
// CAPPED AT ONE PER KIND, on purpose. The client permits only one egg of each kind nesting at a
// time, so a single wipe event could take at most one of each — and `prog` rides in the save, which
// is client-authored, so an inflated counter must not buy a stack. One per kind is the most a real
// victim can have lost.
const EGG_RESTITUTION_UNTIL = Date.UTC(2026, 7, 4);   // 7 days, closes 2026-08-04 00:00 UTC
const eggRestitutionDone = new Map();                 // wallet -> { at, granted:[kind] }
const RESTITUTION_KINDS = Object.freeze(["normal", "legendary", "meme", "mount"]);

function owedEggs(mmo) {
  const prog = (mmo && mmo.prog && typeof mmo.prog === "object") ? mmo.prog : {};
  const held = Array.isArray(mmo && mmo.eggs) ? mmo.eggs : [];
  const out = [];
  for (const kind of RESTITUTION_KINDS) {
    const made = Math.max(0, Number(prog[`eggmake_${kind}`]) || 0);
    const hatched = Math.max(0, Number(prog[`hatch_${kind}`]) || 0);
    const has = held.filter(e => e && String(e.kind) === kind).length;
    if (made - hatched - has > 0) out.push(kind);       // one per kind, never a stack
  }

  // THE STARTER EGG LEAVES NO COUNTER. Every egg Mithra conjures bumps prog.eggmake_<kind>, but the
  // award-ceremony egg every new player receives is appended straight to the nest by Onboarding —
  // no counter at all — and the nest is exactly what the tamper wipe clears. So the arithmetic
  // above is blind to the one egg that a brand-new player is most likely to have lost.
  //
  // The evidence for it is circumstantial but unambiguous: they finished onboarding, they hold no
  // egg, they have never hatched anything, and they own no chikimon. A player who still had their
  // starter would hold it; one who hatched it would have the creature. Only someone whose nest was
  // emptied lands in all four at once.
  if (!out.includes("normal")) {
    const onboarded = !!(mmo && mmo.onboarded);
    const units = (mmo && mmo.units && typeof mmo.units === "object") ? Object.keys(mmo.units).length : 0;
    let hatchedAny = 0;
    for (const kind of RESTITUTION_KINDS) hatchedAny += Math.max(0, Number(prog[`hatch_${kind}`]) || 0);
    const madeAny = RESTITUTION_KINDS.reduce((n, k) => n + Math.max(0, Number(prog[`eggmake_${k}`]) || 0), 0);
    if (onboarded && held.length === 0 && units === 0 && hatchedAny === 0 && madeAny === 0) {
      out.push("normal");
    }
  }
  return out;
}

// What am I owed? Read-only, so a player can see the answer before claiming.
app.get("/assets/egg/restitution", async (req, res) => {
  const w = String(req.query?.wallet || "");
  if (!isPubkey(w)) return res.status(400).json({ error: "valid wallet required" });
  if (!cupAdminOk(req) && mktWallet({ wallet: w, mktToken: String(req.query?.mktToken || "") }) !== w) {
    return res.status(403).json({ error: "prove this wallet first" });
  }
  const open = Date.now() < EGG_RESTITUTION_UNTIL;
  const prior = eggRestitutionDone.get(w);
  let owed = [];
  try {
    const p = await store.getProfile(w);
    if (p && p.mmo) owed = owedEggs(p.mmo);
  } catch (e) { return res.status(503).json({ error: "could not read your save — try again shortly" }); }
  res.json({ open, closesAt: EGG_RESTITUTION_UNTIL, alreadyClaimed: !!prior,
             claimedAt: prior?.at || null, owed: prior ? [] : owed });
});

// Claim it. One shot per wallet, inside the window, and every returned egg is MINTED THROUGH THE
// REGISTRY — so a made-good egg carries the same provenance as one that was earned, rather than
// being injected into a save where it would be indistinguishable from a forgery.
app.post("/assets/egg/restitution", async (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  if (Date.now() >= EGG_RESTITUTION_UNTIL) return res.status(410).json({ error: "the egg restitution window has closed" });
  if (eggRestitutionDone.has(wallet)) return res.status(409).json({ error: "you have already claimed your eggs" });

  let mmo = null;
  try { const p = await store.getProfile(wallet); mmo = p && p.mmo; }
  catch (e) { return res.status(503).json({ error: "could not read your save — try again shortly" }); }
  if (!mmo) return res.status(404).json({ error: "no cloud save to check" });

  const owed = owedEggs(mmo);
  if (!owed.length) return res.json({ ok: true, granted: [], note: "nothing is owed on this wallet" });

  // CLAIM THE ONE-SHOT BEFORE MINTING, not after: a crash or a retry between the two must not be
  // able to pay twice. The same rule the meme-egg signature guard follows.
  eggRestitutionDone.set(wallet, { at: Date.now(), granted: owed.slice() });
  _assetsDirty = true;
  const granted = [];
  for (const kind of owed) {
    try {
      const row = mintAsset("egg", wallet, { kind, sp: kind }, "restitution");
      granted.push({ id: row.id, kind, born: row.born, readyAt: eggReadyAt(row) });
    } catch (e) { /* capacity: keep what was granted, the rest stays owed on the record */ }
  }
  console.log(`egg restitution: ${wallet.slice(0, 8)} granted ${granted.map(g => g.kind).join(",") || "none"}`);
  res.json({ ok: true, granted, note: "these are fresh eggs on a new incubation clock" });
});

app.post("/assets/scroll/redeem", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  const held = regOwned(wallet, "avatar");
  if (held.length >= AVATARS_MAX) return res.status(409).json({ error: "you already carry two looks" });
  const have = new Set(held.map(a => a.sp));
  // the ceremony look every player is awarded is theirs whether or not it was ever registered
  const pool = AVATAR_IDS.filter(a => !have.has(a) && a !== "classic");
  if (!pool.length) return res.status(409).json({ error: "no looks left" });
  let row;
  try { row = mintAsset("avatar", wallet, { sp: pool[crypto.randomInt(pool.length)], kind: "avatar" }, "scroll"); }
  catch (e) { return res.status(503).json({ error: "the asset registry is at capacity — this is a server fault, not yours; nothing was consumed" }); }
  res.json({ ok: true, avatar: { id: row.id, sp: row.sp, born: row.born } });
});

// The authoritative holdings. This is what makes "cannot be erased" true in practice: whatever a
// save says, this is what the wallet owns, and the client can reconcile against it.
app.get("/assets/mine", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const w = String(req.query?.wallet || "");
  if (!isPubkey(w)) return res.status(400).json({ error: "valid wallet required" });
  if (!cupAdminOk(req) && mktWallet({ wallet: w, mktToken: String(req.query?.mktToken || "") }) !== w) {
    return res.status(403).json({ error: "prove this wallet first" });
  }
  const out = { eggs: [], chikimon: [], mounts: [], avatars: [] };
  for (const id of (assetsByOwner.get(w) || [])) {
    const r = assetReg.get(id);
    if (!r) continue;
    const card = { id: r.id, sp: r.sp, kind: r.kind, born: r.born, origin: r.origin, state: r.state };
    if (r.type === "egg") { card.readyAt = eggReadyAt(r); card.hatchedTo = r.hatchedTo || null; out.eggs.push(card); }
    else if (r.type === "chikimon") { card.lvl = r.lvl; out.chikimon.push(card); }
    else if (r.type === "mount") out.mounts.push(card);
    else if (r.type === "avatar") out.avatars.push(card);
  }
  res.json(out);
});

// One asset's full lineage — the record a future NFT mint would carry as its provenance.
app.get("/assets/cert", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const id = String(req.query?.id || "").slice(0, 64);
  const r = assetReg.get(id);
  if (!r) return res.status(404).json({ error: "no such asset" });
  const lineage = [];
  for (let cur = r, guard = 0; cur && guard < 8; guard++) {
    lineage.push({ id: cur.id, type: cur.type, sp: cur.sp, born: cur.born, origin: cur.origin });
    cur = cur.parent ? assetReg.get(cur.parent) : null;
  }
  // owner is public here on purpose: a certificate nobody can check is not a certificate.
  res.json({ id: r.id, type: r.type, sp: r.sp, kind: r.kind, born: r.born, origin: r.origin,
             state: r.state, owner: r.owner, lineage, chain: r.chain.slice(0, 64) });
});

export function serializeAssetReg() {
  return { rows: [...assetReg.values()].slice(-ASSET_REG_MAX), restitution: [...eggRestitutionDone.entries()] };
}
export function restoreAssetReg(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.rows)) return 0;
  for (const e of (Array.isArray(v.restitution) ? v.restitution : [])) {
    if (!Array.isArray(e) || !isPubkey(String(e[0] || ""))) continue;
    eggRestitutionDone.set(String(e[0]), { at: Number(e[1]?.at) || 0,
      granted: Array.isArray(e[1]?.granted) ? e[1].granted.slice(0, 4).map(String) : [] });
  }
  let n = 0;
  for (const src of v.rows) {
    if (!src || typeof src !== "object") continue;
    const id = String(src.id || "").slice(0, 64), owner = String(src.owner || "").slice(0, 64);
    const type = String(src.type || "");
    if (!id || !isPubkey(owner) || !["egg", "chikimon", "mount", "avatar"].includes(type)) continue;
    // ONE ROW PER ID. Without this the same id was set once in assetReg but added to BOTH owners'
    // sets, so /assets/mine — the authoritative answer to "what do you own" — showed one asset in
    // two wallets. A clone, produced by the very code meant to rebuild the registry faithfully.
    if (assetReg.has(id)) continue;
    // The registry has no eviction, so honour the cap on the way IN. mintAsset's guard cannot see
    // rows arriving here, and a blob that exceeds MAX would be silently truncated on the next
    // flush — deleting the earliest players' property.
    if (assetReg.size >= ASSET_REG_MAX) break;
    const hatchedTo = src.hatchedTo ? String(src.hatchedTo).slice(0, 64) : undefined;
    const chain = Array.isArray(src.chain) ? src.chain.slice(0, 64) : [];
    // A CONSUMED EGG IS CONSUMED FOREVER. Trusting the persisted `state` alone let a row be
    // restored with state flipped back to "active", re-arming a spent egg to mint a second creature.
    // The evidence that it hatched lives in the row itself and outranks the flag.
    const spent = hatchedTo || chain.some(c => c && c.what === "hatched");
    const row = { id, type, owner, sp: String(src.sp || "").slice(0, 24), kind: String(src.kind || "").slice(0, 12),
                  born: Number(src.born) || Date.now(), origin: String(src.origin || "issued").slice(0, 16),
                  state: (src.state === "consumed" || spent) ? "consumed" : "active",
                  parent: src.parent ? String(src.parent).slice(0, 64) : null,
                  hatchedTo, lvl: Number(src.lvl) || undefined, chain };
    assetReg.set(id, row); ownerSet(owner).add(id); n++;
  }
  return n;
}
export function _clearAssetReg() { assetReg.clear(); assetsByOwner.clear(); eggRestitutionDone.clear(); }
// test seam: age an egg past its incubation window without waiting real hours
export function _ageAsset(id, ms) { const r = assetReg.get(id); if (r) { r.born -= ms; return true; } return false; }
export function _transferAssetForTest(id, from, to, why) { return transferAsset(id, from, to, why); }
// test seams: fill the registry to its cap, force an auction to end, and backdate a wallet's
// first-seen — all three model conditions a sim cannot otherwise reach (capacity, a 12h auction
// clock, and a player who predates this system).
export function _fillAssetRegForTest() {
  while (assetReg.size < ASSET_REG_MAX) assetReg.set("pad" + assetReg.size, { id: "pad", type: "chikimon", state: "consumed", chain: [] });
  return assetReg.size;
}
export function _endAuctionForTest(id) {
  const a = marketAuctions.find(x => x.id === id);
  if (!a) return false;
  a.endsAt = Date.now() - 1;
  sweepAuctions(Date.now());
  return true;
}
export function _setWalletFirstSeenForTest(w, ts) { _testFirstSeen.set(w, ts); return ts; }
const _testFirstSeen = new Map();

// ============ ASSET AUTHENTICITY LEDGER ============
// The server stored profile.mmo verbatim, so it had no idea what a wallet SHOULD own: a save
// carrying 12 fabricated level-50 legendaries, every mount and a conjured egg was accepted and
// handed straight back (forged_roster_sim.js). The client's tamper seal does not close this — its
// salt must ship in the client to sign saves, AND the tamper path clears currency/chests/eggs but
// leaves units and mounts untouched, so a flagged save keeps its forged roster.
//
// This is the record of what actually exists. Every asset a wallet has ever presented is recorded
// once, with when it first appeared and where it came from:
//   legacy     — present on the first save under this system; grandfathered, not vouched for
//   hatched    — appeared in the same save that consumed an egg, which is how chikimon are made
//   purchased  — appeared alongside a matching drop in the wallet's own recorded balance
//   unverified — appeared from nowhere. Not blocked, but permanently on the record.
//
// It deliberately does NOT reject saves. Rejecting would break legitimate play the moment any
// acquisition path was not modelled here, and a wrong rejection costs a real player their progress.
// Flagging is honest and reversible; blocking on a guess is not.
const assetLedger = new Map();          // wallet -> { first, units:{}, mounts:{}, eggs:{}, eggsLast, unverified }
const ASSET_LEDGER_MAX = 20000;
const ORIGIN_CLEAN = new Set(["legacy", "hatched", "purchased", "issued", "traded", "restitution"]);

// A uid is arbitrary CLIENT TEXT. The client's own format is "u<seq>" (Profile.gd _mk_unit), and
// anything else is a crafted save — including the Object.prototype key names, which a plain
// `rec.units[uid]` lookup resolves to inherited members: "toString" reads back truthy so the unit
// is never recorded, and "__proto__" (a real own property after JSON.parse) writes through to
// Object.prototype and poisons every object in the process. Both were reachable by any signed-in
// wallet through an ordinary cloud save. Null-prototype maps + hasOwnProperty close the lookup;
// this whitelist closes the rest.
const UID_RE = /^u\d{1,9}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Server-side incubation floor, mirroring Profile.gd EGG_HOURS. An egg the SERVER has not watched
// for this long cannot have legally hatched, whatever the save's own prog/started/fed_at claim —
// those are client-authored and only verify the author against themselves.
const EGG_HOURS = Object.freeze(Object.assign(Object.create(null),
  { legendary: 12, meme: 24, mount: 6, normal: 3 }));
const EGG_DWELL_GRACE_MS = 10 * 60 * 1000;   // clock skew + the save that first reports an egg
const EGG_KINDS_MAX = 4;                     // the client permits one egg per kind; >4 held is impossible

// When this ledger began. A wallet the database first saw BEFORE this is a genuine pre-existing
// player and is grandfathered in full; a wallet minted after it has no history to grandfather.
const LEDGER_EPOCH = Date.UTC(2026, 6, 28);   // 2026-07-28
// What a legitimate account can plausibly hold the first time it is audited. A fresh account starts
// at zero and is awarded one ceremony egg, so this is deliberately generous rather than tight — it
// only has to be smaller than a crafted roster. Anything past it needs evidence like everyone else.
const NEW_WALLET_GRANDFATHER = 3;
const NEW_WALLET_GRANDFATHER_MOUNTS = 1;

function assetRec(wallet) {
  let r = assetLedger.get(wallet);
  if (!r) {
    r = { first: Date.now(), units: Object.create(null), mounts: Object.create(null),
          eggs: Object.create(null), eggsLast: null, unverified: 0 };
    assetLedger.set(wallet, r);
  }
  return r;
}

// Buyer-side acquisition records, written by the VERIFIED on-chain settlement path. This is a
// server-authoritative grant: /market/buy-onchain only reaches it after txMarketSplit confirms a
// real 75/20/5 $CHIKI transfer. Without it every honest Trading Post buyer was stamped
// "unverified" — which both libels real players and gives a cheater the perfect cover story.
const assetBuys = new Map();            // wallet -> [{ sp, lvl, ts }]
const BUYS_TTL_MS = 30 * 24 * 3600 * 1000;
function recordAssetBuy(wallet, kind, item, lvl) {
  if (!isPubkey(String(wallet || "")) || String(kind) !== "chikimon") return;
  const arr = assetBuys.get(wallet) || [];
  arr.push({ sp: String(item || "").slice(0, 24), lvl: Number(lvl) || 1, ts: Date.now(), used: false });
  while (arr.length > 200) arr.shift();
  assetBuys.set(wallet, arr);
  _assetsDirty = true;
}
// Claim ONE unconsumed purchase of this species. Consuming it is what stops a single real purchase
// from vouching an unlimited number of forged copies of the same species.
function claimAssetBuy(wallet, sp) {
  const arr = assetBuys.get(wallet);
  if (!arr) return false;
  const now = Date.now();
  const hit = arr.find(b => !b.used && b.sp === sp && now - b.ts <= BUYS_TTL_MS);
  if (!hit) return false;
  hit.used = true;
  return true;
}

// Fold one cloud-save into the ledger and return what was learned about it.
function auditAssets(wallet, mmo, walletFirstSeen = 0) {
  if (!mmo || typeof mmo !== "object") return null;
  const rec = assetRec(wallet);
  const now = Date.now();

  // GRANDFATHERING IS A PROPERTY OF TIME, NOT OF THE RECORD. `firstEver` only says "this ledger has
  // not met you", which a brand-new wallet satisfies just as well as a three-year veteran — so a
  // keypair generated today presented 12 level-50 legendaries and all six mounts on its FIRST save
  // and had every one stamped "legacy" with unverified=0, then listed them on the real-$CHIKI rail.
  // The amnesty existed for players who predate this system; it is now limited to exactly them.
  //
  // A wallet the DB first saw before the cutoff is a real pre-existing player and keeps the full
  // amnesty. Anyone newer is grandfathered only up to what a legitimate account can actually be
  // holding the first time it saves — and a fresh account starts at zero (see the fresh-start
  // scrub in Profile.gd), so anything past a small allowance is a crafted roster, not history.
  const preExisting = walletFirstSeen > 0 && walletFirstSeen < LEDGER_EPOCH;
  const firstEver = rec.eggsLast === null && Object.keys(rec.units).length === 0;

  // ---- eggs get an IDENTITY and a server-side clock ----------------------------------------
  // Counting eggs made "the same egg" inexpressible: eggs:[E] -> eggs:[] -> eggs:[E] -> eggs:[]
  // re-presents byte-identical JSON forever, minting one "hatched" unit per cycle with no
  // rollback and no race. Keying each egg and timing it from the SERVER's first sighting makes a
  // hatch cost real wall-clock time, which is the one thing a crafted save cannot fabricate.
  const allEggs = Array.isArray(mmo.eggs) ? mmo.eggs : [];
  const eggsNow = allEggs.length;
  // Holding more eggs than the client can physically produce (one per kind) is a crafted save. This
  // used to be a single cosmetic flag on the save that HELD them, and false again on the save that
  // dropped them — so 32 declared eggs cost one flag that blocked nothing and returned 32 clean
  // "hatched" legendaries. The taint has to live on the EGGS, not on the moment.
  const eggGlutNow = eggsNow > EGG_KINDS_MAX;
  const eggArr = allEggs.slice(0, EGG_KINDS_MAX * 2);
  const seenNow = new Set();
  let eggsHatchable = 0;
  for (const e of eggArr) {
    if (!e || typeof e !== "object") continue;
    const kind = String(e.kind || "?").slice(0, 12);
    const key = `${kind}:${Math.round(Number(e.started) || 0)}`;
    seenNow.add(key);
    // a key first seen during a glut is marked, and stays marked for its whole life
    if (!has(rec.eggs, key)) rec.eggs[key] = { kind, firstSeen: now, tainted: eggGlutNow };
  }
  // an egg that VANISHED this save was consumed — was it old enough, and honest enough, to vouch?
  for (const key of Object.keys(rec.eggs)) {
    if (seenNow.has(key)) continue;
    const eg = rec.eggs[key];
    const needMs = (EGG_HOURS[eg.kind] || 3) * 3600 * 1000;
    if (!eg.tainted && now - eg.firstSeen + EGG_DWELL_GRACE_MS >= needMs) eggsHatchable++;
    delete rec.eggs[key];                       // consumed: it can never vouch a second hatch
  }
  if (Object.keys(rec.eggs).length > EGG_KINDS_MAX * 2) {
    // a save that seeds keys faster than it spends them is farming vouchers
    for (const k of Object.keys(rec.eggs).slice(EGG_KINDS_MAX * 2)) delete rec.eggs[k];
    flagLater.push("eggfarm");
  }
  const eggGlut = eggGlutNow;

  // eggsLast FIRST: the call site swallows exceptions, and assetRec() has already created the
  // record. A throw between here and the end used to leave {eggsLast:null, units:{}} — exactly
  // the firstEver predicate — so the next save would grandfather the whole roster as "legacy".
  rec.eggsLast = eggsNow;

  let newUnits = 0, newMounts = 0, flagged = [];
  const flagLater = [];
  const flag = (why) => { rec.unverified++; flagged.push(why); };

  const units = (mmo.units && typeof mmo.units === "object") ? mmo.units : {};
  // NEVER TRUNCATE SILENTLY. These caps used to drop the overflow BEFORE it was examined, while
  // /profile stored the save verbatim — so padding a save to exactly the cap hid a conjured griffin
  // and a conjured level-50 legendary from the record entirely (unverified=0) with both still live
  // in the player's roster. The cap stays, because the loops must stay bounded; what changes is
  // that going past it is now itself the accusation, since no legal client can produce it.
  const unitKeys = Object.keys(units);
  if (unitKeys.length > 400) flagLater.push(`overflow:units:${unitKeys.length}`);
  for (const uid of unitKeys.slice(0, 400)) {
    if (!UID_RE.test(uid)) { flag(`badeuid:${uid.slice(0, 24)}`); continue; }
    const u = (units[uid] && typeof units[uid] === "object") ? units[uid] : {};
    const sp = String(u.species || "?").slice(0, 24), kd = String(u.kind || "?").slice(0, 12);
    if (has(rec.units, uid)) {
      const r = rec.units[uid];
      // A VOUCHED uid used to be a permanent licence: only lvl was refreshed, so rewriting the
      // species in place turned a legacy common into a legendary with no flag — and moving a
      // flagged unit to a fresh uid laundered it. The identity is the (uid, species) pair.
      if (r.sp !== sp || r.kind !== kd) {
        if (r.origin !== "unverified") { r.origin = "unverified"; flag(`rebrand:${uid}:${r.sp}->${sp}`); }
        r.sp = sp; r.kind = kd;
      }
      // LEVEL IS PRICED VALUE — listings and auctions both carry it and buyers pay for it — and it
      // was overwritten unconditionally, so a level-2 creature could be rewritten to 50 in place and
      // advertised at 50 with nothing recorded. Note the biggest single-save jump.
      //
      // OBSERVE ONLY, deliberately. This does NOT touch `origin` and so blocks nothing, because the
      // threshold for an "implausible" jump is a balance judgement (offline accrual, quest rewards
      // and a long gap between saves all move levels legitimately) and guessing it wrong would
      // refuse a real player on a money path. It records the evidence so the threshold can be set
      // from real data instead of from my assumption.
      const newLvl = Number(u.level) || r.lvl;
      const jump = newLvl - (r.lvl || 1);
      if (jump > (r.jump || 0)) r.jump = jump;
      r.lvl = newLvl;
      continue;
    }
    newUnits++;
    let origin;
    // RARITY IS THE VALUE, so the new-wallet allowance never covers it. A fresh account starts at
    // zero and is awarded one ceremony egg, so a couple of NORMAL creatures on a first save is
    // ordinary; a legendary or a meme on a first save is not something a new account can have.
    const commonEnough = kd === "normal" || kd === "?";
    if (firstEver && (preExisting || (commonEnough && newUnits <= NEW_WALLET_GRANDFATHER))) origin = "legacy";
    // THE REGISTRY OUTRANKS THE INFERENCE. Once the client hatches through /assets/egg/hatch the
    // egg never appears in mmo.eggs at all, so the delta shows a unit from nowhere and the ledger
    // would condemn a creature the SERVER ITSELF minted — and the listing gate would then refuse a
    // genuine asset. Anything the registry vouches is vouched, full stop.
    else if (regVouchesSpecies(wallet, "chikimon", sp)) origin = "issued";
    else if (claimAssetBuy(wallet, sp)) origin = "purchased";   // verified on-chain settlement
    else if (!eggGlut && eggsHatchable >= newUnits) origin = "hatched";
    else origin = "unverified";
    rec.units[uid] = { sp, kind: kd, lvl: Number(u.level) || 1, ts: now, origin };
    if (origin === "unverified") flag(`unit:${uid}:${sp}`);
  }

  // HELD vs RECORDED. The record is permanent — hiding an asset never erases it — but you cannot
  // SELL what you are no longer holding, and after a sale the client removes the unit from d.units.
  // Without this the seller's own record would keep vouching a creature they had already sold.
  const present = new Set(unitKeys.filter(k => UID_RE.test(k)));
  for (const uid of Object.keys(rec.units)) rec.units[uid].held = present.has(uid);

  const allMounts = Array.isArray(mmo.mounts) ? mmo.mounts : [];
  if (allMounts.length > 40) flagLater.push(`overflow:mounts:${allMounts.length}`);
  const mounts = allMounts.slice(0, 40);
  for (const m of mounts) {
    const id = String(m).slice(0, 24);
    if (has(rec.mounts, id)) continue;
    newMounts++;
    // Mounts never consulted the egg evidence at all, so an HONEST mount-egg hatch was flagged
    // identically to appending all six ids. Same test as units — it is the same act.
    let origin;
    if (firstEver && (preExisting || newMounts <= NEW_WALLET_GRANDFATHER_MOUNTS)) origin = "legacy";
    else if (regVouchesSpecies(wallet, "mount", id)) origin = "issued";   // the server rolled it
    else if (!eggGlut && eggsHatchable >= newUnits + newMounts) origin = "hatched";
    else origin = "unverified";
    rec.mounts[id] = { ts: now, origin };
    if (origin === "unverified") flag(`mount:${id}`);
  }
  if (eggGlut) flag(`eggglut:${eggsNow}`);
  for (const why of flagLater) flag(why);
  if (newUnits || newMounts || flagged.length) _assetsDirty = true;

  // EVICTION MUST NEVER AMNESTY. Dropping a record does not just lose history: the wallet's next
  // save reads as firstEver, so everything it holds is re-stamped "legacy" and its flags are gone.
  // So only ever evict CLEAN records (unverified === 0) — a flagged wallet stays until it is dealt
  // with. If every record is flagged the map simply stops shrinking, which is the safe direction.
  if (assetLedger.size > ASSET_LEDGER_MAX) {
    // Keyed on LAST SEEN, not first seen. Evicting the oldest-joined record hands an early,
    // carefully-clean wallet a fresh firstEver — the amnesty this rule exists to prevent.
    const clean = [...assetLedger.entries()].filter(([, r]) => !r.unverified)
      .sort((a, b) => (a[1].seen || a[1].first) - (b[1].seen || b[1].first)).slice(0, 500);
    for (const [k] of clean) assetLedger.delete(k);
    _assetsDirty = true;
  }
  rec.seen = now;
  return { firstEver, newUnits, newMounts, eggsHatchable, eggGlut, flagged, unverified: rec.unverified };
}

// PERSISTENCE. Render restarts on every deploy and spins down when idle. An in-memory-only ledger
// would see each wallet's first save after every restart as firstEver and re-stamp a forged roster
// as "legacy" — the record would launder exactly what it exists to catch. So it goes to the store,
// same shape as the world nodes above, exported so a sim can round-trip the REAL functions.
let _assetsDirty = false;
const ASSET_SAVE_MS = 30000;

// The in-memory evictor above refuses to drop a flagged record — and this function used to undo
// that on the way to the database. `.slice(-MAX)` keeps the most recently INSERTED entries, and a
// Map iterates in insertion order, so it dropped the OLDEST rows regardless of their flags. That
// is the exact state the evictor's safe direction creates ("if every record is flagged the map
// simply stops shrinking"), so the invariant failed precisely when it mattered. Flagged first.
export function serializeAssetLedger() {
  const all = [...assetLedger.entries()];
  if (all.length > ASSET_LEDGER_MAX) {
    all.sort((a, b) => (b[1].unverified || 0) - (a[1].unverified || 0)
                    || (b[1].seen || b[1].first) - (a[1].seen || a[1].first));
    all.length = ASSET_LEDGER_MAX;
  }
  return { w: all, buys: [...assetBuys.entries()].slice(-5000), gather: [...gatherCount.entries()].slice(-GATHER_WALLETS_MAX),
           spent: [...matSpent.entries()].slice(-GATHER_WALLETS_MAX), gained: [...matGained.entries()].slice(-GATHER_WALLETS_MAX),
           // the weekly raid gate MUST survive a deploy — otherwise every restart hands the whole
           // playerbase a fresh claim, which is the very leak this gate exists to close
           raid: [...raidClaim.entries()].slice(-20000) };
}

// Restoring trusts NOTHING — this blob came back from a database, so every field is re-typed and
// re-clamped, and `unverified` is RECOUNTED from the origins rather than believed, so a corrupted
// (or edited) counter cannot clear a wallet's flags.
export function restoreAssetLedger(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.w)) return 0;
  let n = 0;
  for (const e of v.w) {
    if (!Array.isArray(e) || typeof e[1] !== "object" || !e[1]) continue;
    const w = String(e[0] || "").slice(0, 64), src = e[1];
    if (!w) continue;
    const rec = { first: Number(src.first) || Date.now(), seen: Number(src.seen) || 0,
                  units: Object.create(null), mounts: Object.create(null), eggs: Object.create(null),
                  eggsLast: Number.isFinite(Number(src.eggsLast)) ? Number(src.eggsLast) : null,
                  unverified: 0 };
    const su = (src.units && typeof src.units === "object") ? src.units : {};
    // The 400-unit cap dropped whatever sorted last, and uids are attacker-chosen — so a cheater
    // could compute which of their uids landed past the cap and park a FLAGGED one there, washing
    // it on the next restart. Flagged rows are kept first, for the same reason eviction keeps them.
    const uids = Object.keys(su).filter(k => has(su, k) && UID_RE.test(k))
      .sort((a, b) => ((su[b] || {}).origin === "unverified" ? 1 : 0) - ((su[a] || {}).origin === "unverified" ? 1 : 0));
    for (const uid of uids.slice(0, 400)) {
      const u = su[uid] || {}, origin = ORIGINS.has(u.origin) ? u.origin : "unverified";
      rec.units[uid] = { sp: String(u.sp || "?").slice(0, 24), kind: String(u.kind || "?").slice(0, 12),
                         lvl: Number(u.lvl) || 1, ts: Number(u.ts) || rec.first, origin,
                         jump: Number(u.jump) > 0 ? Number(u.jump) : undefined,
                         held: u.held === false ? false : undefined };
      if (origin === "unverified") rec.unverified++;
    }
    const sm = (src.mounts && typeof src.mounts === "object") ? src.mounts : {};
    for (const id of Object.keys(sm).filter(k => has(sm, k)).slice(0, 40)) {
      const m = sm[id] || {}, origin = ORIGINS.has(m.origin) ? m.origin : "unverified";
      rec.mounts[String(id).slice(0, 24)] = { ts: Number(m.ts) || rec.first, origin };
      if (origin === "unverified") rec.unverified++;
    }
    const se = (src.eggs && typeof src.eggs === "object") ? src.eggs : {};
    for (const k of Object.keys(se).filter(k => has(se, k)).slice(0, 32)) {
      const g = se[k] || {};
      rec.eggs[String(k).slice(0, 40)] = { kind: String(g.kind || "normal").slice(0, 12),
                                           firstSeen: Number(g.firstSeen) || rec.first };
    }
    assetLedger.set(w, rec); n++;
  }
  for (const e of (Array.isArray(v.gather) ? v.gather : [])) {
    if (!Array.isArray(e) || !e[1] || typeof e[1] !== "object") continue;
    const g = Object.create(null);
    for (const k of Object.keys(e[1]).filter(k => has(e[1], k)).slice(0, 40)) {
      const n = Number(e[1][k]); if (n > 0) g[String(k).slice(0, 24)] = n;
    }
    gatherCount.set(String(e[0] || "").slice(0, 64), g);
  }
  // The flow tallies restore re-typed and null-proto — and RESTORE TRUSTS NOTHING the live route
  // refuses. The route whitelists materials and bounds the map; a persisted blob is just as
  // attacker-shaped as a request, so it gets the same three rules: real materials only (junk keys
  // came back through here), FINITE positive numbers only (`n > 0` is true for Infinity, which then
  // serialises to null in the audit view), and the same wallet bound the live path enforces.
  for (const [src, map] of [[v.spent, matSpent], [v.gained, matGained]]) {
    for (const e of (Array.isArray(src) ? src : [])) {
      if (map.size >= GATHER_WALLETS_MAX) break;
      if (!Array.isArray(e) || !e[1] || typeof e[1] !== "object") continue;
      const g = Object.create(null);
      for (const k of Object.keys(e[1]).filter(k => has(e[1], k)).slice(0, 40)) {
        if (!MAT_IDS.has(k)) continue;
        const n = Number(e[1][k]);
        if (Number.isFinite(n) && n > 0) g[k] = Math.min(n, Number.MAX_SAFE_INTEGER);
      }
      map.set(String(e[0] || "").slice(0, 64), g);
    }
  }
  // weekly raid gate: wallet -> week index, re-typed and bounded like everything else here
  for (const e of (Array.isArray(v.raid) ? v.raid : [])) {
    if (raidClaim.size >= 20000) break;
    if (!Array.isArray(e)) continue;
    const wk = Number(e[1]);
    if (!Number.isFinite(wk) || wk <= 0) continue;
    raidClaim.set(String(e[0] || "").slice(0, 64), Math.floor(wk));
  }
  for (const e of (Array.isArray(v.buys) ? v.buys : [])) {
    if (!Array.isArray(e) || !Array.isArray(e[1])) continue;
    assetBuys.set(String(e[0] || "").slice(0, 64), e[1].slice(0, 200).map(b => ({
      sp: String((b || {}).sp || "").slice(0, 24), lvl: Number((b || {}).lvl) || 1,
      ts: Number((b || {}).ts) || 0, used: !!(b || {}).used })));
  }
  return n;
}
const ORIGINS = new Set(["legacy", "hatched", "purchased", "issued", "traded", "restitution", "unverified"]);

// test seams: empty the ledger, and AGE a wallet's eggs so a sim can prove the incubation floor in
// both directions without waiting 12 real hours for a legendary.
// clears EVERY per-wallet tally this module owns — a seam that misses one leaves a sim with dirty
// state that silently invalidates its assertions, so new tallies must be added here too
export function _clearAssetLedger() { assetLedger.clear(); assetBuys.clear(); gatherCount.clear(); matSpent.clear(); matGained.clear(); raidClaim.clear(); _assetsReady = true; }
export function _raidWeekFor(wallet) { return raidClaim.has(wallet) ? raidClaim.get(wallet) : null; }
export function _setRaidWeekForTest(wallet, week) { raidClaim.set(wallet, week); }
export function _ageAssetEggs(wallet, ms) {
  const r = assetLedger.get(wallet);
  if (!r) return 0;
  let n = 0;
  for (const k of Object.keys(r.eggs)) { r.eggs[k].firstSeen -= ms; n++; }
  return n;
}
export function _assetLedgerReady() { return _assetsReady; }
// test seam for the "purchased" origin: the real writer is /market/buy-onchain, which needs a
// signed on-chain transfer a sim cannot produce against a dead RPC.
export function _recordAssetBuyForTest(w, kind, item, lvl) { return recordAssetBuy(w, kind, item, lvl); }

// FAIL CLOSED UNTIL THE RESTORE LANDS. `kvGet(...).catch(() => {})` swallowed a failed read, and
// Render's Postgres wakes cold on every spin-up — so a slow or failed first read left the ledger
// EMPTY for the whole process lifetime. Every wallet's next save then read as firstEver, every
// forged asset was stamped "legacy", and the 30s flush WROTE that laundered ledger over the good
// one. Permanent, not transient. Until a restore has actually succeeded the ledger neither audits
// nor flushes, so an unreadable store costs provenance for new saves instead of destroying it.
let _assetsReady = false;
// The in-flight write is tracked so shutdown can WAIT for it. Clearing _assetsDirty before the
// awaits meant a SIGTERM arriving mid-write saw a clean flag, returned instantly, and the
// `process.exit(0)` in its .finally aborted the very write that carried a just-minted egg — an
// asset the player paid fantasy fish for, gone, on a GRACEFUL shutdown.
let _assetsFlush = null;
async function saveAssetLedger() {
  if (_assetsFlush) return _assetsFlush;          // re-entry joins the write already running
  if (!_assetsDirty || !_assetsReady) return;
  _assetsDirty = false;
  _assetsFlush = (async () => {
    try {
      // The REGISTRY goes first. It holds minted assets that exist nowhere else — losing a row
      // destroys a player's property, which the ledger (a derived record) can never do.
      await store.kvSet("asset_registry", serializeAssetReg());
      await store.kvSet("asset_ledger", serializeAssetLedger());
    } catch (e) { _assetsDirty = true; }          // a failed write must not silently drop the record
    finally { _assetsFlush = null; }
  })();
  return _assetsFlush;
}
// A crash is the same loss as a kill. There is an unhandledRejection handler already; without this
// an uncaught throw takes up to a full flush interval of minted assets with it.
process.on("uncaughtException", (e) => {
  console.error("uncaughtException — flushing assets before exit:", e && e.stack);
  Promise.resolve(_assetsFlush).then(() => saveAssetLedger()).finally(() => process.exit(1));
});
setInterval(saveAssetLedger, ASSET_SAVE_MS).unref?.();   // SIGTERM flush lives with saveWorldNodes
Promise.all([store.kvGet("asset_registry"), store.kvGet("asset_ledger")]).then(([rv, lv]) => {
  const rn = restoreAssetReg(rv);
  const n = restoreAssetLedger(lv);
  _assetsReady = true;
  if (rn || n) console.log(`assets restored: ${rn} registered, ${n} ledger wallets`);
}).catch(e => {
  console.error("asset restore FAILED — issuing and auditing are suspended until a restart reads it:", e && e.message);
});

app.post("/world/move", (req, res) => {
  const b = req.body || {}, wallet = b.wallet;
  if (!isPresenceId(wallet)) return res.status(400).json({ error: "valid wallet required" });
  // PUPPETEERING: anyone can read a wallet off /world/roster, so a bare wallet cannot own a
  // presence slot. But a hard gate here is wrong: a real player has a wallet id the moment they
  // sign in, a beat BEFORE /verify returns their token, and freezing them in place for that window
  // is worse than the bug. So the slot is CLAIMED instead — once a proven caller owns it, only a
  // proven caller may move it. An unproven caller can still take an unclaimed slot (a player
  // mid-sign-in, or a net_id) but can never seize one that is already proven.
  const held = worldPlayers.get(wallet);
  const iAmProven = presenceOk(wallet, b);
  if (held && held.proven && !iAmProven) {
    return res.status(403).json({ error: "that trainer is signed in — prove this wallet first" });
  }
  const x = clampF(b.x, -100000, 100000, 0), z = clampF(b.z, -100000, 100000, 0);
  const y = clampF(b.y, -1000, 100000, 0);   // height: without it every remote was ground-snapped and nobody could be seen jumping
  worldPlayers.set(wallet, {
    proven: iAmProven,
    x, y, z, dir: clampF(b.dir, -7, 7, 0),
    handle: stripTags(String(b.handle || "Trainer")).slice(0, 20),
    leg: clampF(b.leg, 0, 20, 14) | 0,                 // companion species index
    el: stripTags(String(b.el || "Fire")).slice(0, 10),
    avatar: stripTags(String(b.avatar || "classic")).slice(0, 20),   // player's chosen look → remote renders the real rig
    comp: stripTags(String(b.comp || "")).slice(0, 24),              // player's lead chikimon → remote renders it beside them
    party: String(b.party || "").split(",").filter(Boolean).slice(0, 3).map(s => stripTags(String(s)).slice(0, 24)).join(","),
    mount: stripTags(String(b.mount || "")).slice(0, 16),   // the steed they ride ("" = on foot)
    act: stripTags(String(b.act || "")).slice(0, 24),      // what they're DOING ("chop:axe") -> remotes play it
    br: clampF(b.br, 1, 50, 1) | 0,   // companion LEVEL (cap 50) — not the Cup 1..30 BR
    ts: Date.now(),
  });
  res.json({ ok: true, players: worldSnapshot(wallet, x, z), online: worldPlayers.size });
});
// Read-only: nearby online trainers (for spectators / light polling).
app.get("/world/players", (req, res) => {
  const wallet = req.query?.wallet || "", x = clampF(req.query?.x, -100000, 100000, 0), z = clampF(req.query?.z, -100000, 100000, 0);
  res.json({ players: worldSnapshot(wallet, x, z), online: worldPlayers.size });
});
// The "who's online" roster behind the presence pill. Sourced from the SAME worldPlayers map that
// backs the pill's count (NOT chat presence) — so the list can never say "no one" while the count
// says N. Returns EVERY live trainer (handle + short wallet), not distance-filtered, incl. the caller.
app.get("/world/roster", (_q, res) => {
  const now = Date.now(); const users = [];
  for (const [w, p] of worldPlayers) {
    if (now - p.ts > WORLD_TTL_MS) { worldPlayers.delete(w); continue; }
    users.push({ wallet: w, handle: p.handle || null, short: w.length >= 8 ? (w.slice(0, 4) + "…" + w.slice(-4)) : w, admin: isAdminWallet(w) });
  }
  res.json({ users, count: users.length });
});
setInterval(() => { const now = Date.now(); for (const [w, p] of worldPlayers) if (now - p.ts > WORLD_TTL_MS) worldPlayers.delete(w); }, 10000);

// Shared-world chat — a PERSISTED rolling log (kv), served in full so every player can scroll
// back through everyone's messages, including from before they logged in. History survives
// server restarts; the 1000-message window is the only trim.
const worldChat = [];
store.kvGet("world_chat").then(v => { if (Array.isArray(v) && !worldChat.length) worldChat.push(...v.slice(-1000)); }).catch(() => {});
let _chatSavedAt = 0;
function saveWorldChat() {
  const now = Date.now();
  if (now - _chatSavedAt < 5000) return;   // batch writes — chat can be bursty
  _chatSavedAt = now;
  store.kvSet("world_chat", worldChat.slice(-1000)).catch(() => {});
}
app.post("/world/chat", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  const text = stripTags(String(b.text || "")).slice(0, 200).trim();
  if (text) {
    // `wallet` is what makes a name in World chat clickable-to-whisper. Without it the client fell
    // back to `short` — an ellipsised "3J57…iji3" — which it then POSTed as the whisper recipient.
    // U+2026 fails isPresenceId(), so /world/dm 400'd and, because the client never reads that
    // response, the message vanished with no error. Only replying to a whisper worked, since the DM
    // route does send a full `from`. The same fallback also broke the unread badge, which compares
    // the sender id against your own full presence id. Messages stored before this fix have no
    // `wallet` and stay unwhisperable; new ones work.
    worldChat.push({ wallet: b.wallet, handle: stripTags(String(b.handle || "Trainer")).slice(0, 20), short: b.wallet.slice(0, 4) + "…" + b.wallet.slice(-4), text, ts: Date.now() });
    if (worldChat.length > 1000) worldChat.shift();
    saveWorldChat();
  }
  res.json({ ok: true, messages: worldChat.slice(-40) });
});
// full history on request (first load); incremental polls pass ?since=<last ts>
app.get("/world/chat", (req, res) => {
  const since = Number(req.query?.since) || 0;
  res.json({ messages: since > 0 ? worldChat.filter(m => m.ts > since).slice(-200) : worldChat.slice(-1000) });
});

// ---- Whispers (direct messages). PERSISTED inbox per recipient presence-id (kv) — history
// survives restarts, so a whisper always reaches its trainer. Sanitised, capped, 30d retention.
const worldDM = new Map();   // recipient sid -> [ {from, fromHandle, text, ts} ]
store.kvGet("world_dm").then(v => {
  if (v && typeof v === "object" && !worldDM.size)
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) worldDM.set(k, v[k].slice(-200));
}).catch(() => {});
let _dmSavedAt = 0;
function saveWorldDM() {
  const now = Date.now();
  if (now - _dmSavedAt < 5000) return;
  _dmSavedAt = now;
  const cutoff = now - 30 * 24 * 3600 * 1000;
  const obj = {};
  for (const [k, a] of worldDM) {
    const kept = a.filter(m => (m.ts || 0) > cutoff).slice(-200);
    if (kept.length) obj[k] = kept;
  }
  store.kvSet("world_dm", obj).catch(() => {});
}
function dmInbox(sid) { let a = worldDM.get(sid); if (!a) { a = []; worldDM.set(sid, a); } return a; }
app.post("/world/dm", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  // impersonation: sending AS a public wallet you do not own
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ error: "prove this wallet first" });
  const to = String(b.to || "");
  if (!isPresenceId(to)) return res.status(400).json({ error: "valid recipient required" });
  const text = stripTags(String(b.text || "")).slice(0, 200).trim();
  if (!text) return res.json({ ok: true });
  const from = String(b.wallet), fromHandle = stripTags(String(b.handle || "Trainer")).slice(0, 20);
  const msg = { from, fromHandle, to, text, ts: Date.now() };
  const inbox = dmInbox(to); inbox.push(msg); if (inbox.length > 200) inbox.shift();
  // echo into the sender's own inbox so their client shows the sent line in-thread
  const sent = dmInbox(from); sent.push({ ...msg, self: true }); if (sent.length > 200) sent.shift();
  // hard cap on distinct inboxes (DoS guard)
  if (worldDM.size > 5000) { const oldest = [...worldDM.keys()].slice(0, worldDM.size - 5000); oldest.forEach(k => worldDM.delete(k)); }
  saveWorldDM();
  res.json({ ok: true });
});
app.get("/world/dm", (req, res) => {
  const sid = String(req.query?.wallet || "");
  if (!isPresenceId(sid)) return res.status(400).json({ error: "valid wallet required" });
  // PRIVATE MESSAGE DISCLOSURE: this returned any player's whole whisper inbox to anyone who knew
  // their wallet — and wallets are published in /world/roster. Reading someone's DMs required
  // nothing but their address.
  if (!presenceOk(sid, { wallet: sid, mktToken: String(req.query?.mktToken || "") }))
    return res.status(403).json({ error: "prove this wallet first" });
  const since = Number(req.query?.since) || 0;
  res.json({ messages: (worldDM.get(sid) || []).filter(m => m.ts > since).slice(-40) });
});

// ---- ON-CHAIN Trading Post settlement (OPT-IN, off by default) ------------------------------
// When MARKET_ONCHAIN=1 the buyer signs a REAL $CHIKI SPL transfer straight to the seller's
// wallet (via Phantom, client-side). This endpoint only VERIFIES that transfer on-chain and then
// releases the item — it NEVER moves money itself. Real funds flow buyer -> seller directly.
// PREREQ before enabling: the client must bundle @solana/web3.js to build+sign the transfer, and
// the whole path needs a live mainnet Phantom test. Until then this returns 503 and the game uses
// the safe in-game-$CHIKI rail (op:buy above).
const MARKET_ONCHAIN = String(process.env.MARKET_ONCHAIN || "") === "1" && !!MINT && !!TEAM_WALLET;
// replay guard + idempotent recovery: each tx sig settles at most ONE listing/order (BOUND to its
// id), and re-POSTing the same sig for the SAME listing returns the cached release — so a dropped
// 200 response can't lose the buyer's paid-for goods. Pruned by AGE, not by count: a count cap could
// evict an old sig and let it be replayed against a different, cheaper listing (audit finding).
const _usedTxSigs = new Map();   // sig -> { listingId?/orderId?, buyer, released?, ts }
(async () => { try { const v = await store.kvGet("market_used_sigs"); if (Array.isArray(v)) { for (const e of v) { if (typeof e === "string") _usedTxSigs.set(e, { ts: 0 }); else if (e && e.sig) _usedTxSigs.set(String(e.sig), { listingId: e.listingId, orderId: e.orderId, buyer: e.buyer, released: e.released, ts: e.ts || 0 }); } } } catch (e) {} })();
const USED_SIG_KEEP_MS = 365 * 24 * 3600 * 1000;   // keep a year — sig volume is one per real trade
function saveUsedSigs() {
  try {
    const now = Date.now(), arr = [];
    for (const [sig, e] of _usedTxSigs) { if (e.ts && now - e.ts > USED_SIG_KEEP_MS) { _usedTxSigs.delete(sig); continue; } arr.push({ sig, listingId: e.listingId, orderId: e.orderId, buyer: e.buyer, released: e.released, ts: e.ts }); }
    // persist ALL age-pruned sigs — NO count cap: a count cap would drop the oldest active sig and
    // let it be replayed against a different cheaper listing (the age-only invariant above exists to
    // prevent exactly that). Volume is one sig per real trade, so age (1yr) is the sole bound.
    store.kvSet("market_used_sigs", arr);
  } catch (e) {}
}
// Market fee split on every on-chain BUY (must sum to 1.0): 75% seller, 20% TEAM wallet, 5% burn.
const MARKET_SELLER_SHARE = 0.75, MARKET_TEAM_TAX = 0.20, MARKET_BURN = 0.05;
// Verify the buyer's SINGLE signed transaction pays the correct 3-way split of REAL $CHIKI:
//   >= 75% to the seller, >= 20% to the reward-pool (treasury) wallet, and the full price left
//   the buyer (the missing 5% is burned/removed from circulation). Balance-delta based, so it
//   can't be spoofed by memo/instruction shape. Never moves money itself.
async function txMarketSplit(sig, buyer, seller, price) {
  try {
    const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || (tx.meta && tx.meta.err)) return { ok: false, reason: "transaction not confirmed" };
    const mint = MINT.toBase58(), teamStr = TEAM_WALLET;
    const pre = (tx.meta && tx.meta.preTokenBalances) || [], post = (tx.meta && tx.meta.postTokenBalances) || [];
    const amt = (arr, owner) => { const e = arr.find(b => b.owner === owner && b.mint === mint); return e ? Number((e.uiTokenAmount && e.uiTokenAmount.uiAmount) || 0) : 0; };
    const dSeller = amt(post, seller) - amt(pre, seller);
    const dTeam   = amt(post, teamStr) - amt(pre, teamStr);
    const dBuyer  = amt(pre, buyer) - amt(post, buyer);          // positive = spent
    // sum any REAL burn of the $CHIKI mint in this tx (top-level + inner instructions) so the 5%
    // can't be quietly redirected to an alt wallet — it must actually leave circulation
    let burned = 0;
    const scanBurn = (ixs) => { for (const ix of (ixs || [])) {
      const pr = ix && ix.parsed; if (!pr) continue;
      if (ix.program !== "spl-token" && ix.program !== "spl-token-2022") continue;
      if ((pr.type === "burn" || pr.type === "burnChecked") && pr.info && pr.info.mint === mint) {
        const ta = pr.info.tokenAmount;
        burned += ta ? Number(ta.uiAmount || 0) : Number(pr.info.amount || 0) / Math.pow(10, CHIKI_DECIMALS);
      }
    } };
    scanBurn(tx.transaction && tx.transaction.message && tx.transaction.message.instructions);
    for (const inner of ((tx.meta && tx.meta.innerInstructions) || [])) scanBurn(inner.instructions);
    // tolerance = a couple whole $CHIKI (each leg is rounded to whole tokens client-side); NOT a % of price
    // slack ONLY for whole-token client rounding — tight (≤25 tokens, 0.1%) and capped so a large
    // sale can't be proportionally underpaid. The zero-value legs are rejected explicitly below.
    const tol = Math.min(25, Math.max(2, price * 0.001));
    if (dBuyer <= 0 || dSeller <= 0 || dTeam <= 0 || burned <= 0) return { ok: false, reason: "no $CHIKI actually moved on one of the legs" };
    if (dBuyer  < price * 1.0                 - tol) return { ok: false, reason: `buyer paid ${dBuyer}, need ${price}` };
    if (dSeller < price * MARKET_SELLER_SHARE - tol) return { ok: false, reason: `seller got ${dSeller}, need ${price * MARKET_SELLER_SHARE}` };
    if (dTeam   < price * MARKET_TEAM_TAX     - tol) return { ok: false, reason: `team wallet got ${dTeam}, need ${price * MARKET_TEAM_TAX}` };
    if (burned  < price * MARKET_BURN         - tol) return { ok: false, reason: `only ${burned} $CHIKI burned, need ${price * MARKET_BURN}` };
    return { ok: true, seller: dSeller, team: dTeam, spent: dBuyer, burned };
  } catch (e) { return { ok: false, reason: "rpc error verifying transfer" }; }
}
// verify sig is a confirmed SPL transfer of >= amount of the $CHIKI mint from `from` to `to`
async function txTransfer(sig, from, to, amount) {
  try {
    const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || (tx.meta && tx.meta.err)) return false;
    const mint = MINT.toBase58();
    const pre = (tx.meta && tx.meta.preTokenBalances) || [], post = (tx.meta && tx.meta.postTokenBalances) || [];
    const amt = (arr, owner) => { const e = arr.find(b => b.owner === owner && b.mint === mint); return e ? Number((e.uiTokenAmount && e.uiTokenAmount.uiAmount) || 0) : 0; };
    const dTo = amt(post, to) - amt(pre, to);
    const dFrom = amt(post, from) - amt(pre, from);
    return dTo >= amount - 0.5 && dFrom <= -(amount - 0.5);
  } catch (e) { return false; }
}
app.post("/market/buy-onchain", async (req, res) => {
  if (!MARKET_ONCHAIN) return res.status(503).json({ error: "on-chain trading is not enabled yet — buys settle in in-game $CHIKI for now", onchain: false });
  const b = req.body || {};
  const buyer = String(b.buyer || "");
  const buyerName = stripTags(String(b.buyerName || "")).slice(0, 20);
  const sig = stripTags(String(b.txSig || "")).slice(0, 120);
  const id = stripTags(String(b.listingId || "")).slice(0, 40);
  if (!isPubkey(buyer)) return res.status(400).json({ error: "valid buyer wallet required" });
  if (!sig || !id) return res.status(400).json({ error: "txSig and listingId required" });
  // IDEMPOTENT RECOVERY: a re-POST of a sig already settled for THIS listing+buyer returns the same
  // release, so a buyer whose 200 was dropped can safely retry and still receive the goods. A sig
  // replayed against a DIFFERENT listing is refused — one payment settles exactly one item.
  const prior = _usedTxSigs.get(sig);
  if (prior) {
    if (prior.listingId === id && prior.buyer === buyer && prior.released) return res.json({ ok: true, released: prior.released, txSig: sig, replayed: true });
    return res.status(409).json({ error: "that transaction was already used" });
  }
  pruneMarket();
  const row = marketListings.find(x => x.id === id);
  if (!row) return res.status(404).json({ error: "listing is gone" });
  const sellerWallet = String(row.wallet || "");
  if (!isPubkey(sellerWallet)) return res.status(409).json({ error: "seller has no on-chain wallet on this listing" });
  if (sellerWallet === buyer) return res.status(400).json({ error: "that is your own listing" });
  // CLAIM the sig BEFORE the async verify so two concurrent requests can't both settle it (TOCTOU),
  // BOUND to this listing so ONE payment can never settle a second listing. Released again if verify fails.
  _usedTxSigs.set(sig, { listingId: id, buyer, ts: Date.now() });
  // the buyer's ONE signed transaction must pay the correct 3-way split of real $CHIKI:
  // 75% to the seller, 20% to the reward pool, 5% burned (full price left the buyer)
  const split = await txMarketSplit(sig, buyer, sellerWallet, Number(row.price) || 0);
  if (!split.ok) { _usedTxSigs.delete(sig); return res.status(409).json({ error: `on-chain split for that signature failed: ${split.reason}` }); }
  marketListings = marketListings.filter(x => x.id !== id);
  _consumeListing(id);   // SOLD -> a re-push can never resurrect it
  const released = { id: row.id, kind: row.kind, item: row.item, qty: row.qty, lvl: row.lvl, xp: row.xp };
  // A VERIFIED grant: this line is only reached after txMarketSplit confirmed a real on-chain
  // $CHIKI split. It is what lets the ledger stamp the buyer's new unit "purchased" instead of
  // condemning every honest Trading Post buyer as unverified.
  recordAssetBuy(buyer, row.kind, row.item, row.lvl);
  _usedTxSigs.set(sig, { listingId: id, buyer, released, ts: Date.now() });   // cache release for idempotent retry
  saveUsedSigs();
  // record the sale so the SELLER'S client shows the on-chain proceeds landed
  const arr = marketSales[row.sid] || (marketSales[row.sid] = []);
  if (!arr.some(s => s.id === row.id)) arr.push({ id: row.id, item: row.item, kind: row.kind, qty: row.qty, price: row.price, buyer: buyer.slice(0, 8), buyerName, onchain: true, txSig: sig, sellerNet: split.seller, teamTax: split.team, ts: Date.now() });
  await saveMarket();
  res.json({ ok: true, released, txSig: sig });
});

// ---- ORDER settlement (real $CHIKI): the POSTER pays a pending delivery. Their ONE signed
// transaction must carry the same verified 75/20/5 split as a listing buy, with the FILLER in
// the seller seat. On verification: order closes, goods queue to the poster (fills poll), and
// the filler gets an on-chain sale receipt (sales poll — no soft credit, the money is real).
app.post("/market/order-pay", async (req, res) => {
  if (!MARKET_ONCHAIN) return res.status(503).json({ error: "on-chain trading is not enabled" });
  const b = req.body || {};
  const payer = String(b.payer || "");
  const sig = stripTags(String(b.txSig || "")).slice(0, 120);
  const id = stripTags(String(b.orderId || "")).slice(0, 40);
  if (!isPubkey(payer)) return res.status(400).json({ error: "valid payer wallet required" });
  if (!sig || !id) return res.status(400).json({ error: "txSig and orderId required" });
  if (_usedTxSigs.has(sig)) return res.status(409).json({ error: "that transaction was already used" });
  pruneMarket();
  const row = marketOrders.find(x => x.id === id);
  if (!row) return res.status(404).json({ error: "order is gone" });
  if (row.state !== "delivered" || !isPubkey(String(row.fillerWallet || ""))) return res.status(409).json({ error: "no delivery is awaiting payment on that order" });
  if (payer !== String(row.wallet || "")) return res.status(403).json({ error: "only the order's poster wallet can pay it" });
  // RESERVE the row: while `paying` is fresh, decline / undeliver / expiry are all refused, so
  // the order can't be torn down between tx broadcast and verification (money-goods atomicity)
  row.paying = Date.now();
  // CLAIM the sig BEFORE the async verify (TOCTOU) — one payment can never settle twice, BOUND to
  // this order so it can't be replayed against another. Pruned by age in saveUsedSigs, not by count.
  _usedTxSigs.set(sig, { orderId: id, buyer: payer, ts: Date.now() });
  // the client submits the sig the moment Phantom broadcasts, usually BEFORE the cluster reaches
  // 'confirmed' — a single lookup would routinely miss a perfectly good payment and strand real
  // $CHIKI. Poll for up to ~20s before giving up.
  let split = { ok: false, reason: "transaction not confirmed" };
  for (let tries = 0; tries < 8; tries++) {
    split = await txMarketSplit(sig, payer, String(row.fillerWallet), Number(row.price) || 0);
    if (split.ok || !/not confirmed|rpc error/i.test(String(split.reason || ""))) break;
    await new Promise(r => setTimeout(r, 2500));
  }
  if (!split.ok) { _usedTxSigs.delete(sig); delete row.paying; return res.status(409).json({ error: `on-chain split for that signature failed: ${split.reason} — if you approved it in Phantom, wait a few seconds and press Pay again (the same payment is retried, never re-charged)` }); }
  saveUsedSigs();
  // re-fetch: the reservation blocks decline/expiry, but never trust a 20s-old reference
  const fresh = marketOrders.find(x => x.id === id) || row;
  marketOrders = marketOrders.filter(x => x.id !== id);
  // goods to the POSTER (their client grants via the fills poll). Value-bearing: never cap-drop.
  const farr = marketFills[fresh.sid] || (marketFills[fresh.sid] = []);
  if (!farr.some(f => f.id === fresh.id))
    farr.push({ id: fresh.id, item: fresh.item, kind: fresh.kind, qty: fresh.qty, price: fresh.price, fillerName: fresh.fillerName || "a trainer", ts: Date.now() });
  // on-chain receipt to the FILLER (their client records it via the sales poll, no soft credit)
  const sarr = marketSales[fresh.fillerSid] || (marketSales[fresh.fillerSid] = []);
  if (!sarr.some(s => s.id === fresh.id))
    sarr.push({ id: fresh.id, item: fresh.item, kind: fresh.kind, qty: fresh.qty, price: fresh.price, buyer: payer.slice(0, 8), buyerName: fresh.buyer, onchain: true, txSig: sig, sellerNet: split.seller, teamTax: split.team, ts: Date.now() });
  await saveMarket();   // durability: the goods+receipt must be persisted before we confirm the pay
  res.json({ ok: true, txSig: sig });
});

// ---- Trading Post: a shared player-to-player market of in-game items for in-game $CHIKI.
// In-memory ring (persisted best-effort to kv). Items + soft-currency only — no on-chain funds.
// SETTLEMENT: when a listing is bought, the sale is RECORDED for the seller; the seller's
// client polls /market/sales and credits the price (minus the 5% burned market fee) to their
// purse, then acks. Nothing is credited twice and nothing vanishes on a lost response.
let marketListings = [];
let marketSales = {};                        // seller sid -> [ {id,item,kind,qty,price,buyer,ts} ]
let marketOrders = [];                       // WTB craft orders: {id, buyer, sid, kind, item, qty, price(total), ts}
let marketFills = {};                        // buyer sid -> [ {id,item,kind,qty,price,fillerName,ts} ] — goods owed to the buyer
let marketAuctions = [];                     // 🔨 chikimon auctions: {id, seller, sid, species, lvl, xp, minBid, curBid, curSid, curName, ts, endsAt}
let auctionRefunds = {};                     // sid -> [ {rid,id,amt,ts} ] — outbid escrow going home
const MARKET_TTL_MS = 24 * 60 * 60 * 1000;   // listings expire after a day
// DURABILITY: a settled receipt lingers briefly for recovery, then drops; UNCREDITED value (owed
// proceeds/goods/escrow) survives far longer so a player offline for weeks still recovers it on
// return. Never blindly time-drop money that was never actually credited.
const KEEP_CREDITED_MS = 2 * 24 * 3600 * 1000;    // 2 days after credit/grant/refund
const KEEP_PENDING_MS = 60 * 24 * 3600 * 1000;    // 60 days for uncredited value (was a lossy 7)
// keep uncredited value-bearing rows for KEEP_PENDING_MS; settled receipts drop after KEEP_CREDITED_MS
function _pruneValueMap(map, doneKey, now) {
  for (const k of Object.keys(map)) {
    map[k] = (map[k] || []).filter(r => { const age = now - (r.ts || 0); return r[doneKey] ? age < KEEP_CREDITED_MS : age < KEEP_PENDING_MS; });
    if (!map[k].length) delete map[k];
  }
}
// bucket-count backstop against a flood of fake sids. Buckets are keyed by the client sid (net_id),
// NOT a wallet, so key-shape tells us nothing — protect by OWNERSHIP instead: a sid BOUND to a real
// signed-in wallet (sidOwner[k]) with any uncredited value is NEVER evicted, even if it's the oldest.
// Only fully-settled buckets, or UNBOUND ones (demo / a flood of never-signed-in fake sids), can go.
function _capValueMap(map, doneKey, cap) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  const evictable = keys.filter(k => !sidOwner[k] || (map[k] || []).every(r => r[doneKey]));
  if (!evictable.length) { console.warn(`_capValueMap: ${keys.length} buckets all hold owed value — not dropping any`); return; }
  evictable.map(k => [k, Math.max(0, ...(map[k] || []).map(r => r.ts || 0))])
    .sort((a, b) => a[1] - b[1]).slice(0, Math.min(evictable.length, keys.length - cap))
    .forEach(([k]) => delete map[k]);
}
store.kvGet("market_listings").then(v => { if (Array.isArray(v)) marketListings = v.filter(l => l && Date.now() - (l.ts || 0) < MARKET_TTL_MS); }).catch(() => {});
store.kvGet("market_sales").then(v => { if (v && typeof v === "object") marketSales = v; }).catch(() => {});
store.kvGet("market_orders").then(v => { if (Array.isArray(v)) marketOrders = v.filter(o => o && (o.state === "delivered" ? Date.now() - (o.deliveredTs || 0) < ORDER_PAY_WINDOW_MS + 3600000 : Date.now() - (o.ts || 0) < MARKET_TTL_MS)); }).catch(() => {});
store.kvGet("market_fills").then(v => { if (v && typeof v === "object") marketFills = v; }).catch(() => {});
store.kvGet("market_auctions").then(v => { if (Array.isArray(v)) marketAuctions = v; }).catch(() => {});
// RESURRECTION GUARD: once a listing id leaves the board (bought / cancelled / on-chain settled) it is
// remembered here, so a stale client re-push (offline reconcile) can NEVER re-add it — that was the
// double-sale bug where a SOLD item re-listed itself and could be bought again. Legit re-lists use a
// fresh id, so they're unaffected. Kept for MARKET_TTL_MS (matches the listing + client-save lifetime).
const _soldListings = new Map();   // listing id -> ts consumed
store.kvGet("market_sold_ids").then(v => { if (Array.isArray(v)) for (const e of v) { if (e && e.id) _soldListings.set(String(e.id), Number(e.ts) || Date.now()); } }).catch(() => {});
// test seam: lets a sim backdate a consumed id to prove it is NOT forgotten by age. Read-only use
// in production; nothing in the server calls it.
export function _soldIdsForTest() { return _soldListings; }

function _consumeListing(id) {
  releaseUnitFor(id);   // the row is gone: its creature is free to be listed again
  if (!id) return;
  _soldListings.set(String(id), Date.now());
  // bounded by COUNT, oldest-first — never by age (see pruneMarket). A Map keeps insertion order and
  // re-setting an existing key does not move it, so the first keys are genuinely the oldest.
  if (_soldListings.size > 8000) {
    let drop = _soldListings.size - 8000;
    for (const k of _soldListings.keys()) { if (drop-- <= 0) break; _soldListings.delete(k); }
  }
}
store.kvGet("auction_refunds").then(v => { if (v && typeof v === "object") auctionRefunds = v; }).catch(() => {});
async function saveMarket() {
  try {
    await Promise.all([
      store.kvSet("market_listings", marketListings.slice(-400)),
      store.kvSet("market_sales", marketSales),
      store.kvSet("market_orders", marketOrders.slice(-200)),
      store.kvSet("market_fills", marketFills),
      store.kvSet("market_auctions", marketAuctions.slice(-100)),
      store.kvSet("auction_refunds", auctionRefunds),
      store.kvSet("market_sold_ids", [..._soldListings].slice(-4000).map(([id, ts]) => ({ id, ts }))),
    ]);
  } catch (e) { console.warn("saveMarket persist failed:", String(e?.message || e)); }
}
// ---- MARKET SESSION AUTH ----
// The marketplace keys settlement on the client's `sid` (a per-install net_id). That sid is PUBLIC
// (it rides on every /market/list row), so the audit found anyone could forge it to wipe/hide/strand
// another player's proceeds via the ack & cancel ops. Fix WITHOUT re-keying settlement (which would
// break the client's sid-based mine-detection): tie each net_id to the WALLET that owns it, and
// require a matching bearer token on every mutating op.
//   • marketTokens: wallet -> token, minted to a PROVEN owner at /verify (valid Phantom signature).
//   • sidOwner:     net_id -> wallet. Bound ONLY from the owner's OWN proven identity — at /verify
//                   (the client sends its own net_id alongside its signature) and, at boot, seeded
//                   from the persisted board (each listing/order already carries its owner wallet).
//                   NEVER bound from an attacker-supplied sid on /market/op (that let a stranger seize
//                   a victim's sid), and never re-bound once set (first-writer-wins).
//   • walletSid:    wallet -> net_id, the reverse, so admin restitution files under the sid the
//                   seller's client actually polls.
let marketTokens = {}, sidOwner = {}, walletSid = {};
store.kvGet("market_tokens").then(v => { if (v && typeof v === "object") marketTokens = v; }).catch(() => {});
store.kvGet("market_sid_owner").then(v => { if (v && typeof v === "object") sidOwner = v; }).catch(() => {});
store.kvGet("market_wallet_sid").then(v => { if (v && typeof v === "object") walletSid = v; }).catch(() => {});
function mintMarketToken(wallet) {
  if (!isPubkey(wallet)) return "";
  if (!marketTokens[wallet]) { marketTokens[wallet] = crypto.randomBytes(24).toString("hex"); store.kvSet("market_tokens", marketTokens).catch(() => {}); }
  return marketTokens[wallet];
}
// the wallet a request has PROVEN it controls via its market token (or "" if unproven)
function mktWallet(b) {
  const w = String(b?.wallet || ""), t = String(b?.mktToken || "");
  return (isPubkey(w) && t.length >= 16 && marketTokens[w] === t) ? w : "";
}
// the wallet the persisted board already attributes this sid to (or "" if none) — used to reject a
// hijack where an attacker asserts a victim's (public, still-unbound) net_id at /verify.
function _sidBoardWallet(sid) {
  for (const l of marketListings) if (l.sid === sid && isPubkey(String(l.wallet || ""))) return l.wallet;
  for (const o of marketOrders) if (o.sid === sid && isPubkey(String(o.wallet || ""))) return o.wallet;
  for (const a of marketAuctions) {
    if (a.sid === sid && isPubkey(String(a.wallet || ""))) return a.wallet;          // seller
    if (a.curSid === sid && isPubkey(String(a.curWallet || ""))) return a.curWallet; // top bidder
  }
  return "";
}
// bind sid -> owner wallet, first-writer-wins. `sid` MUST be the caller's own (proven at /verify) or a
// persisted board row's own (seeded at boot) — never an arbitrary sid pulled from a /market/op body.
// ANTI-HIJACK: refuse to bind a sid the board already attributes to a DIFFERENT wallet, so a stranger
// can't sign in asserting a victim's net_id and seize it.
function bindSid(sid, wallet) {
  if (!sid || !isPubkey(wallet) || sidOwner[sid]) return;
  const boardW = _sidBoardWallet(sid);
  if (boardW && boardW !== wallet) return;
  sidOwner[sid] = wallet; walletSid[wallet] = sid;
  store.kvSet("market_sid_owner", sidOwner).catch(() => {});
  store.kvSet("market_wallet_sid", walletSid).catch(() => {});
}
// seed sid->wallet from the persisted board so pre-deploy listings can't be seized before their owner
// next signs in (each row carries its owner wallet; first-writer-wins, so a live /verify never loses).
function seedSidOwnerFromBoard() {
  let dirty = false;
  const take = (sid, w) => { if (sid && isPubkey(w) && !sidOwner[sid]) { sidOwner[sid] = w; walletSid[w] = sid; dirty = true; } };
  for (const l of marketListings) take(l.sid, l.wallet);
  for (const o of marketOrders) take(o.sid, o.wallet);
  for (const a of marketAuctions) { take(a.sid, a.wallet); take(a.curSid, a.curWallet); }
  if (dirty) { store.kvSet("market_sid_owner", sidOwner).catch(() => {}); store.kvSet("market_wallet_sid", walletSid).catch(() => {}); }
}
// gate a mutating op: the caller must PROVE the wallet that owns this sid. An unbound sid has no
// provable owner, so value-destroying ops on it are refused outright (a stranger can't strand an
// as-yet-unbound seller's proceeds, and a legit owner is always bound at /verify before they trade).
function opAuthOk(sid, b) { const owner = sidOwner[sid]; return !!owner && mktWallet(b) === owner; }

// Can this wallet put this species on the board? Returns an error string, or "" to allow.
//
// It lives here rather than inside `op:list` because the gate was written in the list branch alone
// and AUCTIONS accepted the exact chikimon list had just refused — the auction settles into the
// same real-$CHIKI transfer, one op name away. Any future path that puts kind "chikimon" on the
// board must call this.
//
// Two sources of truth, and the REGISTRY OUTRANKS THE LEDGER: a registry row is an asset the server
// minted itself, which is stronger evidence than any inference drawn from save deltas. Checking the
// ledger alone refused creatures the server had just issued, because the ledger only learns about
// them on the player's next cloud save.
// ONE LIVE SALE PER CREATURE. Matching on species alone let a single recorded chikimon back up to
// 12 simultaneous listings — the per-sid cap was the only limit, and each row settles independently
// into its own real-$CHIKI transfer. A creature is one thing and can be sold once at a time.
const unitReserved = new Map();          // "wallet|uid" -> listing/auction id
const _resKey = (w, uid) => `${w}|${uid}`;
function reserveUnit(wallet, uid, rowId) {
  if (!wallet || !uid) return true;                       // nothing to reserve (older client)
  const k = _resKey(wallet, uid), held = unitReserved.get(k);
  if (held && held !== rowId) return false;               // already on the board under another row
  unitReserved.set(k, rowId);
  return true;
}
function releaseUnitFor(rowId) {
  if (!rowId) return;
  for (const [k, v] of unitReserved) if (v === rowId) unitReserved.delete(k);
}

function chikimonSaleBlocked(wallet, sp, uid, rowId) {
  if (!wallet || !sp) return "";
  const lrec = assetLedger.get(wallet);

  // PER-UNIT when the client tells us which one. Market.gd already carries `uid` on every listing,
  // so this is the precise check: that exact creature, on the record, clean, still in their roster,
  // and not already up for sale somewhere else.
  if (uid && lrec) {
    const u = has(lrec.units, uid) ? lrec.units[uid] : null;
    if (u) {
      if (u.origin === "unverified") return "That chikimon isn't on your authenticity record. If you believe this is wrong, contact support.";
      if (u.sp !== sp) return "That chikimon doesn't match what your record says it is — sync your game and try again.";
      if (u.held === false) return "That chikimon isn't in your roster any more, so it can't be sold.";
      if (!reserveUnit(wallet, uid, rowId)) return "That chikimon is already up for sale — cancel the other listing first.";
      return "";
    }
    // a uid the ledger has never seen: fall through to the species check rather than refusing, so a
    // creature acquired since the last cloud save is not stranded
  }

  // SPECIES fallback — an older client, an auction, or a unit the ledger has not met yet. The
  // registry outranks the ledger: a row it minted is stronger evidence than any inference.
  if (regVouchesSpecies(wallet, "chikimon", sp)) return "";
  if (!lrec) return "";                                            // no record yet — grandfathered
  if (Object.values(lrec.units).some(u => u.sp === sp && u.origin !== "unverified")) return "";
  return "That chikimon isn't on your authenticity record yet — sync your game (it saves automatically) and try again. If it still won't list, contact support.";
}
const AUCTION_MS = 12 * 3600 * 1000;         // every auction runs 12h — snappy, two cycles a day
// the outbid bidder's escrow goes home through this queue (their client re-credits + acks)
function queueAuctionRefund(sid, id, amt) {
  if (!sid || !(amt > 0)) return;
  const arr = auctionRefunds[sid] || (auctionRefunds[sid] = []);
  arr.push({ rid: id + "#" + Date.now() + "#" + Math.floor(Math.random() * 1e4), id, amt, ts: Date.now() });
}
// settle every ENDED auction: winner gets the chikimon (fills queue), the seller gets a sale
// record (their client credits the 75/20/5 split), a no-bid chikimon walks home to its seller
function sweepAuctions(now) {
  marketAuctions = marketAuctions.filter(a => {
    if (now < (a.endsAt || 0)) return true;
    if (a.curSid && a.curBid > 0) {
      const farr = marketFills[a.curSid] || (marketFills[a.curSid] = []);
      if (!farr.some(f => f.id === a.id)) {
        farr.push({ id: a.id, item: a.species, kind: "chikimon", qty: 1, lvl: a.lvl, xp: a.xp, price: a.curBid, fillerName: a.seller, ts: now });
        // The winner legitimately acquired this creature — record it, or their next save presents a
        // unit from nowhere and the ledger condemns an honest buyer. recordAssetBuy used to have a
        // single call site (/market/buy-onchain), so every auction win was branded unverified.
        recordAssetBuy(a.curWallet, "chikimon", a.species, a.lvl);
      }
      const sarr = marketSales[a.sid] || (marketSales[a.sid] = []);
      if (!sarr.some(s => s.id === a.id))
        sarr.push({ id: a.id, item: a.species, kind: "chikimon", qty: 1, price: a.curBid, buyer: String(a.curSid).slice(0, 8), buyerName: a.curName || "a trainer", ts: now });
    } else {
      const rarr = marketFills[a.sid] || (marketFills[a.sid] = []);
      if (!rarr.some(f => f.id === a.id)) {
        rarr.push({ id: a.id, item: a.species, kind: "chikimon", qty: 1, lvl: a.lvl, xp: a.xp, price: 0, fillerName: a.seller, returned: true, why: "noBids", ts: now });
        // a no-bid return puts the creature back in the SELLER's hands — same reasoning as above
        recordAssetBuy(a.wallet, "chikimon", a.species, a.lvl);
      }
    }
    releaseUnitFor(a.id);   // the auction is over: its creature can be listed again
    return false;
  });
  _pruneValueMap(auctionRefunds, "refunded", now);   // un-returned escrow survives 60d, not 7
}
const ORDER_PAY_WINDOW_MS = 48 * 3600 * 1000; // poster has 48h to pay a delivery, then goods auto-return
// hand a pending delivery's goods back to the filler (decline / payment window expired) via the
// fills queue their client already polls; `returned` switches the client to the goods-back toast
function returnOrderGoods(row, why) {
  if (!row.fillerSid) return;
  const arr = marketFills[row.fillerSid] || (marketFills[row.fillerSid] = []);
  // value-bearing: the filler's staked goods ride on this record — never cap-drop it (memory is
  // bounded by the 200-order book + the 7-day fills TTL)
  if (!arr.some(f => f.id === row.id))
    arr.push({ id: row.id, item: row.item, kind: row.kind, qty: row.qty, price: row.price, fillerName: row.buyer, returned: true, why, ts: Date.now() });
}
let _sidSeeded = false;
function pruneMarket() {
  const now = Date.now();
  if (!_sidSeeded) { _sidSeeded = true; seedSidOwnerFromBoard(); }   // one-time: protect pre-deploy rows from seizure
  sweepAuctions(now);
  marketListings = marketListings.filter(l => now - (l.ts || 0) < MARKET_TTL_MS);
  // NOTE: _soldListings is deliberately NOT pruned by age here. The seller's client keeps its own
  // copy of a listing forever (it rides in the signed save and is rehydrated unconditionally), and
  // on login it re-pushes any "mine" listing the board lacks BEFORE the sales poll clears the sold
  // one. So if the server forgot a sold id after 24h, a listing that had already been bought went
  // straight back on the board and could be bought a SECOND time — duplicating the goods and paying
  // the seller real on-chain $CHIKI twice, through entirely normal play (sell, stay offline a day,
  // log back in). The memory is bounded by COUNT instead, in _consumeListing.
  _pruneValueMap(marketSales, "credited", now);   // uncredited proceeds survive 60d, not 7
  // orders: drop LEGACY soft-escrow rows (no wallet — pre-real-rail, unpayable); a DELIVERED
  // order is exempt from the open-order TTL but auto-returns its goods when the pay window ends
  marketOrders = marketOrders.filter(o => {
    if (!isPubkey(String(o.wallet || ""))) return false;
    if (o.state === "delivered") {
      if (o.paying && now - o.paying < 90000) return true;   // a payment is being verified — hold
      if (now - (o.deliveredTs || 0) < ORDER_PAY_WINDOW_MS) return true;
      returnOrderGoods(o, "expired");
      return false;
    }
    return now - (o.ts || 0) < MARKET_TTL_MS;
  });
  _pruneValueMap(marketFills, "granted", now);    // owed goods survive 60d, not 7
  // SECURITY backstop: cap distinct buckets so a flood of fake sids can't grow memory unbounded —
  // but only ever drop buckets with NO money owed (never a wallet bucket holding uncredited value)
  _capValueMap(marketFills, "granted", 5000);
  _capValueMap(marketSales, "credited", 5000);
  _capValueMap(auctionRefunds, "refunded", 5000);   // same content-based backstop as its siblings
}
app.get("/market/list", (_q, res) => { pruneMarket(); res.json({ listings: marketListings.slice(-300), orders: marketOrders.slice(-200), auctions: marketAuctions.slice(-100) }); });
// pending order FILLS for one buyer — client receives the goods then acks with the ids
app.get("/market/fills", (req, res) => {
  const sid = stripTags(String(req.query?.sid || "")).slice(0, 40);
  if (!sid) return res.status(400).json({ error: "sid required" });
  // return only rows NOT yet settled — a settled row lingers as a durable receipt but is never re-served
  res.json({ fills: (marketFills[sid] || []).filter(f => !f.granted).slice(0, 40), refunds: (auctionRefunds[sid] || []).filter(r => !r.refunded).slice(0, 40) });
});
// pending sale proceeds for one seller — client credits then acks with the ids
app.get("/market/sales", (req, res) => {
  const sid = stripTags(String(req.query?.sid || "")).slice(0, 40);
  if (!sid) return res.status(400).json({ error: "sid required" });
  res.json({ sales: (marketSales[sid] || []).filter(s => !s.credited).slice(0, 40) });
});
app.post("/market/op", async (req, res) => {
  const b = req.body || {};
  const sid = stripTags(String(b.sid || "")).slice(0, 40);
  const op = String(b.op || "");
  const l = b.listing || {};
  if (!sid) return res.status(400).json({ error: "sid required" });
  let cancelled;                                 // set by the cancel op → tells the seller's client whether to reclaim
  let returned;                                  // auction_cancel: the SERVER's record of the creature coming back
  pruneMarket();
  // AUTH GATE: every op that clears a player's own value queue, tears down their own listings/orders,
  // OR *creates* value under a sid must prove wallet ownership (market token) of that sid. Gating the
  // CREATE ops (list/order_post/auction_post) too means a row can only ever exist under the caller's
  // OWN bound sid — so the public `sid`/`wallet` fields on the board can't be poisoned to hijack the
  // sid->wallet binding, and proceeds can never accrue under an unbound (seizable) sid. The binding is
  // established ONLY from the owner's own proven identity (at /verify, seeded from the board at boot).
  const _AUTH_OPS = new Set(["list", "order_post", "auction_post", "sales_ack", "fills_ack", "refunds_ack", "cancel", "sold", "auction_cancel", "order_cancel", "order_decline", "order_undeliver", "auction_bid"]);
  if (_AUTH_OPS.has(op) && !opAuthOk(sid, b)) return res.status(401).json({ error: "market sign-in required to list, trade, or manage your proceeds" });
  if (op === "list") {
    const lid = stripTags(String(l.id || ("S" + Date.now() + Math.floor(Math.random() * 1e4)))).slice(0, 40);
    // IDEMPOTENT: a client may re-push a listing it made offline (reconcile). Don't duplicate an id.
    if (_soldListings.has(lid)) {
      // a stale reconcile re-pushing an already-SOLD listing — never resurrect it (double-sale exploit)
      return res.status(409).json({ error: "That listing id was already used. Your goods remain safely escrowed; cancel and re-list them." });
    }
    const listingClash = marketListings.find(x => x.id === lid);
    if (listingClash && listingClash.sid !== sid) {
      return res.status(409).json({ error: "Listing id collision — cancel and re-list with a fresh id." });
    } else if (!listingClash) {
      if (marketListings.filter(x => x.sid === sid).length >= 12) return res.status(429).json({ error: "too many listings" });
      // THE FLAG NEEDS A CONSUMER. A chikimon listing settles through /market/buy-onchain into a
      // real 75/20/5 $CHIKI transfer, so this is where a forged roster becomes money — and the
      // list op never asked whether the seller owns the creature. The ledger already knows.
      //
      // Deliberately narrow: refused ONLY when we hold a record for this wallet and that record
      // has no clean unit of this species. A wallet with no record yet (never saved under the
      // ledger, or restored mid-flight) is allowed through — a false refusal would strand a real
      // player's asset, and grandfathering is the standing policy for everything predating this.
      if (String(l.kind) === "chikimon") {
        const bad = chikimonSaleBlocked(mktWallet(b), stripTags(String(l.item || "")).slice(0, 24),
                                        stripTags(String(l.uid || "")).slice(0, 40), lid);
        if (bad) return res.status(409).json({ error: bad });
      }
      marketListings.push({
        id: lid,
        seller: stripTags(String(l.seller || "Trainer")).slice(0, 20), sid,
        // PROVEN identity only. This used to be taken verbatim from the caller's request body, so a
        // seller could list with wallet:"" — which slipped past the on-chain interlock below (it
        // only fired for rows that HAD a wallet) and let them soft-buy their own listing through
        // the unauthenticated op:buy for price*0.75 in soft $CHIKI. That credit lands in trade_in,
        // which raises the wallet's own earn ceiling, so the anti-cheat clamp never clawed it back.
        // "list" is in _AUTH_OPS, so mktWallet(b) is a wallet this caller has actually proven.
        wallet: mktWallet(b),
        kind: (["chikimon", "ffish", "pot"].includes(String(l.kind)) ? String(l.kind) : "mat"),
        item: stripTags(String(l.item || "wood")).slice(0, 24),
        qty: clampF(l.qty, 1, 999999, 1) | 0, price: clampF(l.price, 1, 9999999, 1) | 0,
        lvl: clampF(l.lvl, 1, 50, 1) | 0, xp: clampF(l.xp, 0, 1e9, 0) | 0, ts: Date.now(),
      });
      if (marketListings.length > 400) marketListings.shift();
    }
  } else if (op === "buy") {
    const id = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketListings.find(x => x.id === id);
    // SECURITY: when on-chain trading is live, a wallet-backed listing MUST settle through the
    // verified /market/buy-onchain path — never through this unauthenticated soft op:buy, or a
    // seller could POST a fake buy against their own listing to mint soft $CHIKI for nothing.
    if (row && MARKET_ONCHAIN && isPubkey(String(row.wallet || ""))) {
      return res.status(409).json({ error: "this listing settles on-chain — buy it through the on-chain flow" });
    }
    // A row with NO wallet cannot be paid on-chain at all, so while the on-chain rail is live it
    // must not be settleable through this unauthenticated soft path either — that hole was the
    // mint. New listings always carry a proven wallet (above); only pre-fix rows can be wallet-less
    // and they age out with the listing TTL.
    if (row && MARKET_ONCHAIN && !isPubkey(String(row.wallet || ""))) {
      return res.status(409).json({ error: "this listing cannot settle — it has no payable wallet" });
    }
    // record the sale for the seller BEFORE the listing disappears — this is the
    // player-to-player settlement: without it the seller's goods vanish for nothing
    if (row && row.sid && row.sid !== sid) {
      const arr = marketSales[row.sid] || (marketSales[row.sid] = []);
      const buyerName = stripTags(String(b.buyerName || "")).slice(0, 20);
      if (!arr.some(s => s.id === row.id) && arr.length < 50)
        arr.push({ id: row.id, item: row.item, kind: row.kind, qty: row.qty, price: row.price, buyer: sid.slice(0, 8), buyerName, ts: Date.now() });
    }
    const before = marketListings.length;
    marketListings = marketListings.filter(x => x.id !== id);
    if (marketListings.length < before) _consumeListing(id);   // only a REAL removed row enters the guard
  } else if (op === "cancel" || op === "sold") {
    const id = stripTags(String(l.id || "")).slice(0, 40);
    const before = marketListings.length;
    marketListings = marketListings.filter(x => !(x.id === id && x.sid === sid));
    cancelled = marketListings.length < before;   // true ONLY if a still-live listing was removed (else it already sold)
    // Blacklist ONLY an id this caller actually owned. _consumeListing used to run here
    // unconditionally, outside the sid check — so any signed-in player could POST cancel with ids
    // they had never owned and blacklist them for MARKET_TTL_MS. Client listing ids are a
    // sequential L<n> counter, so a few thousand such calls poisoned the entire practical id
    // space: every later list() answered ok:true while the server silently dropped the row, and
    // the seller's client had already deducted the goods. Goods destroyed, seller never told.
    // A genuine sale is already consumed by the buy path above, so gating on `cancelled` here
    // loses nothing.
    if (cancelled) _consumeListing(id);
  } else if (op === "order_post") {
    // WTB craft order — REAL-$CHIKI ONLY. No escrow moves at post time: the poster's wallet
    // rides on the order and they sign the real 75/20/5 payment (via /market/order-pay) when a
    // trainer delivers. Requires a wallet and (fail-open on RPC trouble) a live balance that can
    // cover the offer, so fillers don't lock goods against a wallet that can't pay.
    if (!MARKET_ONCHAIN) return res.status(503).json({ error: "orders are paused while on-chain trading is offline" });
    const ow = stripTags(String(l.wallet || "")).slice(0, 44);
    if (!isPubkey(ow)) return res.status(400).json({ error: "orders pay real $CHIKI — connect your Phantom wallet to post one" });
    const oid = stripTags(String(l.id || ("O" + Date.now() + Math.floor(Math.random() * 1e4)))).slice(0, 40);
    const price = clampF(l.price, 1, 50000, 1) | 0;
    try {
      const bal = await chikiBalance(ow, true);
      if (bal < price) return res.status(403).json({ error: `your wallet holds ${Math.floor(bal).toLocaleString()} $CHIKI — not enough to back a ${price.toLocaleString()} offer` });
    } catch (e) { /* RPC down: allow the post — decline + the 48h auto-return bound the risk */ }
    const clash = marketOrders.find(x => x.id === oid);
    if (clash && clash.sid !== sid) return res.status(409).json({ error: "order id collision — repost" });
    if (!clash) {
      if (marketOrders.filter(x => x.sid === sid).length >= 3) return res.status(429).json({ error: "3 open orders max" });
      marketOrders.push({
        id: oid,
        buyer: stripTags(String(l.seller || "Trainer")).slice(0, 20), sid, wallet: ow,
        kind: (["ffish", "pot"].includes(String(l.kind)) ? String(l.kind) : "mat"),
        item: stripTags(String(l.item || "wood")).slice(0, 24),
        qty: clampF(l.qty, 1, 99, 1) | 0, price, ts: Date.now(),
      });
      // cap eviction must NEVER destroy a delivered row (a filler's staked goods live on it)
      while (marketOrders.length > 200) {
        const oi = marketOrders.findIndex(x => x.state !== "delivered");
        if (oi < 0) break;
        marketOrders.splice(oi, 1);
      }
    }
  } else if (op === "order_fill") {
    // LEGACY soft-settlement fill from a stale cached client — never allow it against the
    // real-$CHIKI book. filled:false makes the old client keep its goods and show "too late".
    return res.json({ ok: true, filled: false, listings: marketListings.slice(-300) });
  } else if (op === "order_deliver") {
    // a filler stakes goods against an open order: the order LOCKS (one delivery at a time),
    // the goods leave the filler's bag client-side, and the poster is asked to pay real $CHIKI.
    const oid = stripTags(String(l.id || "")).slice(0, 40);
    const fw = stripTags(String(l.fillerWallet || "")).slice(0, 44);
    const row = marketOrders.find(x => x.id === oid);
    if (!row || row.state === "delivered") return res.json({ ok: true, delivered: false });
    if (row.sid === sid) return res.status(409).json({ error: "you can't deliver your own order" });
    if (!isPubkey(fw)) return res.status(400).json({ error: "connect your Phantom wallet — deliveries pay you real $CHIKI" });
    // PROVE the filler wallet before locking the order + arming its real-$CHIKI payout to fw — else a
    // tokenless caller could lock the whole order book and later collect returned goods / a payout for
    // goods never staked. The filler is a distinct party from the poster, so gate on fw ownership, not sid.
    if (mktWallet(b) !== fw) return res.status(401).json({ error: "sign in with the wallet you're delivering from" });
    if (fw === row.wallet) return res.status(409).json({ error: "you can't deliver to your own wallet" });
    row.state = "delivered";
    row.fillerSid = sid;
    row.fillerWallet = fw;
    row.fillerName = stripTags(String(b.buyerName || "")).slice(0, 20);
    row.deliveredTs = Date.now();
    saveMarket();
    // the DELIVERED flag is authoritative: two racing deliverers -> only the first gets true,
    // and only that client hands over goods — the loser keeps everything and gets told
    return res.json({ ok: true, delivered: true });
  } else if (op === "order_undeliver") {
    // the FILLER backs out of their own pending delivery (couldn't actually stake the goods,
    // or an ambiguous network failure) — reopen the order. Refused mid-payment.
    const oid = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketOrders.find(x => x.id === oid && x.state === "delivered" && x.fillerSid === sid);
    if (row && row.paying && Date.now() - row.paying < 90000) return res.status(409).json({ error: "the poster is paying right now" });
    if (row) {
      delete row.state; delete row.fillerSid; delete row.fillerWallet; delete row.fillerName; delete row.deliveredTs; delete row.paying;
    }
    cancelled = !!row;
  } else if (op === "order_decline") {
    // the poster refuses to pay a pending delivery: goods go BACK to the filler (fills queue,
    // flagged returned) and the order closes. Refused while a payment is being verified.
    const oid = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketOrders.find(x => x.id === oid && x.sid === sid);
    if (row && row.paying && Date.now() - row.paying < 90000) return res.status(409).json({ error: "your payment for this delivery is being verified — it can't be declined now" });
    if (row && row.state === "delivered") returnOrderGoods(row, "declined");
    if (row) marketOrders = marketOrders.filter(x => x.id !== oid);
    cancelled = !!row;
  } else if (op === "order_cancel") {
    const oid = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketOrders.find(x => x.id === oid && x.sid === sid);
    if (row && row.state === "delivered") return res.status(409).json({ error: "a delivery is awaiting your payment — pay it or decline it first" });
    marketOrders = marketOrders.filter(x => !(x.id === oid && x.sid === sid));
    cancelled = !!row;                          // nothing to refund — real orders hold no escrow
  } else if (op === "auction_post") {
    // 🔨 a chikimon goes under the hammer: 12h, highest bid wins. The seller's client already
    // took custody of the unit (it restores intact on cancel / no-bid return).
    const aid = stripTags(String(l.id || "")).slice(0, 40);
    if (!aid) return res.status(400).json({ error: "auction id required" });
    if (!marketAuctions.some(x => x.id === aid)) {
      if (marketAuctions.filter(x => x.sid === sid).length >= 2) return res.status(429).json({ error: "2 live auctions max" });
      // an auction is a sale — same gate as op:list, or the gate is one op name wide
      const bad = chikimonSaleBlocked(mktWallet(b), stripTags(String(l.species || "")).slice(0, 24),
                                      stripTags(String(l.uid || "")).slice(0, 40), aid);
      if (bad) return res.status(409).json({ error: bad });
      marketAuctions.push({
        id: aid, seller: stripTags(String(l.seller || "Trainer")).slice(0, 20), sid,
        wallet: mktWallet(b),   // proven seller wallet — puts the auction sid inside the anti-hijack surface
        species: stripTags(String(l.species || "")).slice(0, 24),
        lvl: clampF(l.lvl, 1, 50, 1) | 0, xp: clampF(l.xp, 0, 1e9, 0) | 0,
        minBid: clampF(l.minBid, 1, 50000, 1) | 0, curBid: 0, curSid: "", curName: "", curWallet: "",
        ts: Date.now(), endsAt: Date.now() + AUCTION_MS,
      });
    }
  } else if (op === "auction_bid") {
    // AUTHORITATIVE: exactly one bidder can hold the top spot; the displaced bidder's escrow
    // goes home through the refunds queue. accepted:false = the bidder's client deducts NOTHING.
    const aid = stripTags(String(l.id || "")).slice(0, 40);
    const amt = clampF(l.amount, 1, 50000, 1) | 0;
    const row = marketAuctions.find(x => x.id === aid);
    if (!row || Date.now() >= row.endsAt) return res.json({ ok: true, accepted: false, reason: "auction ended" });
    if (row.sid === sid) return res.status(409).json({ error: "you can't bid on your own auction" });
    const need = Math.max(row.minBid, row.curBid + Math.max(1, Math.ceil(row.curBid * 0.05)));
    if (amt < need) return res.json({ ok: true, accepted: false, need });
    if (row.curSid) queueAuctionRefund(row.curSid, row.id, row.curBid);
    row.curBid = amt;
    row.curSid = sid;
    row.curWallet = mktWallet(b);   // proven bidder wallet — protects the bidder's sid + escrow refund
    row.curName = stripTags(String(b.buyerName || "Trainer")).slice(0, 20);
    await saveMarket();   // the escrow refund we just queued for the displaced bidder must persist
    return res.json({ ok: true, accepted: true, cur: amt, endsAt: row.endsAt });
  } else if (op === "auction_cancel") {
    // only a bid-less auction can be pulled — once money is on the table, the hammer falls
    const aid = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketAuctions.find(x => x.id === aid && x.sid === sid);
    if (row && row.curSid) return res.status(409).json({ error: "there's already a bid — the auction must run its course" });
    marketAuctions = marketAuctions.filter(x => !(x.id === aid && x.sid === sid));
    if (row) releaseUnitFor(aid);             // pulled from the board: its creature is free again
    cancelled = !!row;                        // the seller's client restores the stashed unit
    // NAME THE CREATURE COMING BACK. The seller's client held the withdrawn unit in an unsigned
    // save field and restored it with no validation at all, so a forged stash returned a level-50
    // chikimon that then settled on the real-$CHIKI rail. These are the stats the SERVER recorded
    // when the auction was posted (clamped there), so the client can restore what actually went up
    // rather than whatever its save happens to say. The no-bid return path already carries them.
    if (row) returned = { species: row.species, lvl: row.lvl, xp: row.xp };
  } else if (op === "refunds_ack") {
    // MARK settled, never DELETE (auth-gated above). A forged/replayed ack can no longer destroy an
    // uncredited value row; the settled row stays a durable receipt until the short post-credit prune.
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(x => String(x).slice(0, 64));
    for (const r of (auctionRefunds[sid] || [])) if (ids.includes(r.rid)) r.refunded = true;
  } else if (op === "fills_ack") {
    const ids = (Array.isArray(b.ids) ? b.ids : (b.listing && Array.isArray(b.listing.ids) ? b.listing.ids : [])).map(x => String(x).slice(0, 40));
    for (const f of (marketFills[sid] || [])) if (ids.includes(f.id)) f.granted = true;
  } else if (op === "sales_ack") {
    const ids = (Array.isArray(b.ids) ? b.ids : (b.listing && Array.isArray(b.listing.ids) ? b.listing.ids : [])).map(x => String(x).slice(0, 40));
    for (const s of (marketSales[sid] || [])) if (ids.includes(s.id)) s.credited = true;
  }
  await saveMarket();
  res.json({ ok: true, cancelled, returned, listings: marketListings.slice(-300) });
});

// Open the port FIRST so Render detects it immediately (no "No open ports" timeout on a cold DB),
// then initialize the DB in the background (errors logged, not fatal — the server stays up and recovers).
app.listen(Number(PORT), () => {
  console.log(`Chiki backend v2 on :${PORT} · ${NETWORK} · store=${store.kind} · treasury ${treasury.publicKey.toBase58()}`);
  console.log(`verifyHolders=${verifyOn} · holdMin=${MIN_HOLD_MINUTES} · dailyCap=${DAILY_FRAC>=1?"none":Math.round(DAILY_FRAC*100)+"% pool/day"} · perWallet=${WALLET_DAILY} SOL`);
});
store.init().then(()=>{ console.log("store ready"); return loadCupState(); }).then(()=>console.log(`cup state loaded (public=${cupPublic}, owed prizes=${cupPrizes.size})`)).catch(e=>console.error("store.init failed:", e?.message||e));
chat.init().then(()=>console.log("chat ready")).catch(e=>console.error("chat.init failed:", e?.message||e));
