// Chiki Monsters backend v2 — Postgres-backed, idempotent logged payouts.
// Holder verification + server-signed SOL payouts. Devnet-first; set DATABASE_URL for production.
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bs58 from "bs58";
import crypto from "node:crypto";   // built-in — used for Ed25519 chat-signature verification (no external dep)
import pg from "pg";
import WS from "ws";               // WebSocket world transport — a SECOND transport beside /world/move polling, never a replacement
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createCup } from "./cup-live.js";   // Chikoria Cup live orchestrator (double-elim, deterministic resolver)
import { createMatch as pvpCreate, submit as pvpSubmit, tick as pvpTick, viewFor as pvpView, forfeit as pvpForfeit, spectatorView as pvpSpectate } from "./pvp-engine.js";   // live PvP battles
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";   // $CHIKI quest-reward payouts ($CHIKI is TOKEN-2022 — the legacy program rejects its accounts with InvalidAccountData)
import { loadTerrain, terrainInfo, terrainReady, surfaceHeight, SEA } from "./world_terrain.js";     // the island heightfield — the server's copy of the floor
import * as PhysMod from "./world_physics.js";                     // server-side movement simulation (CHIK_PHYS=1; OFF by default)

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
      // ===== ...AND WON, not merely WAITED =====
      // The tier sum was gated on WALL CLOCK ALONE — nothing in this block read totalWins, skillPts
      // or any balance, despite the line above it saying "upgrades cost BR + $CHIKI". Measured (with
      // CARD_MIN_SEC forced to 1s; prod is 60): a save-editor took the tier sum 3 -> 11 with eight
      // idle saves and the deck [0,1,2] -> all twelve slots in one save 11 seconds later, with no
      // battles and no spend. At the prod floor that is a full 12-card tier-5 deck in ~57 minutes of
      // doing nothing — and cupSnapFromBody then faithfully carries it into a 4.00 SOL tournament,
      // where every honest entrant resolves to 3 cards at tier 1 because no shipped client writes
      // these fields at all.
      //
      // So they get the ceiling BR already has: the server's own win ledger. GRANDFATHERED exactly
      // the way BR is — the first time this Chiki is seen we snapshot the unconsumed win count, so
      // nothing anyone already holds is ever reduced; only NEW growth has to be paid for in wins.
      let ctWinBase = (pc._ctWinBase != null) ? Number(pc._ctWinBase) : totalWins;
      const ctWinCeil = prevSum + Math.max(0, totalWins - ctWinBase);
      if (pc.cardTier == null) { ctAt = now; ctWinBase = totalWins; if (ctF) for (const k in ctF) ctF[k] = 1; }   // brand-new Chiki: every card starts at tier 1
      else if (ctF && reqSum > prevSum) {
        let allowedSum = prevSum, budget = Math.max(0, now - ctAt);
        while (allowedSum < reqSum && budget >= CARD_MIN_SEC * 1000) { budget -= CARD_MIN_SEC * 1000; allowedSum++; }
        allowedSum = Math.min(allowedSum, ctWinCeil);                     // real-time floor AND the real-win ceiling
        if (reqSum > allowedSum) { ctF = { ...prevCT }; }                 // grew faster than legit → reject, keep previous tiers
        else { ctAt = now - budget; ctWinBase += (reqSum - prevSum); }    // accepted; consume the wins it cost
      }
      // deck size (number of arena skills) can only grow one card per CARD_MIN_SEC AND one per real
      // server-resolved win — same grandfathered win ledger as the tiers above.
      const prevSkills = Array.isArray(pc.arenaSkills) ? pc.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0)) : null;
      let skillsF = Array.isArray(src.arenaSkills) ? src.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0)) : prevSkills;
      let dkAt = Number(pc._dkAt) || now;
      let dkWinBase = (pc._dkWinBase != null) ? Number(pc._dkWinBase) : totalWins;
      if (prevSkills == null) { dkAt = now; dkWinBase = totalWins; if (skillsF && skillsF.length > 3) skillsF = skillsF.slice(0, 3); }
      else if (skillsF && skillsF.length > prevSkills.length) {
        const grew = Math.min(Math.floor(Math.max(0, now - dkAt) / (CARD_MIN_SEC * 1000)),
                              Math.max(0, totalWins - dkWinBase));
        if (skillsF.length - prevSkills.length > grew) skillsF = prevSkills;   // added cards faster than legit → keep previous deck
        else { dkWinBase += (skillsF.length - prevSkills.length); dkAt = now; }
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
        _ctWinBase: ctWinBase, _dkWinBase: dkWinBase,
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

// POSTGRES JSONB REJECTS an escaped NUL. JSON.stringify happily emits it, and the in-memory store swallows
// it without complaint — so a NUL byte anywhere in user text (a chat line, a handle, a nickname, a
// listing name) throws "unsupported Unicode escape sequence in type jsonb" ONLY once DATABASE_URL is
// set. That is a production-only failure invisible in every dev run, and it lands on the persist
// path: the write fails and the state it carried is not saved. stripTags removes < and > and
// nothing else, so nothing upstream was catching it. Every ::jsonb parameter goes through here.
// A NUL is never legitimate game data, so dropping it loses nothing.
// Sanitise the VALUES, not the serialised text: stripping the six-character escape out of the JSON
// string would also mangle a string that legitimately contains those literal characters (its
// backslash is escaped, so a text-level strip eats half the pair and leaves invalid JSON that fails
// to parse on restore). A replacer only ever touches real string values.
const NUL_RE = /\u0000/g;
const jsonbSafe = (v) => JSON.stringify(v, (_k, val) =>
  (typeof val === "string" && val.indexOf("\u0000") !== -1) ? val.replace(NUL_RE, "") : val);
export function _jsonbSafe(v) { return jsonbSafe(v); }
function pgStore() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  return {
    kind: "postgres",
    async ping() { await pool.query("SELECT 1 FROM players LIMIT 0"); return true; },
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
    async kvSet(k, v) { await pool.query(`INSERT INTO kv(k,v) VALUES($1,$2::jsonb) ON CONFLICT(k) DO UPDATE SET v=$2::jsonb`, [k, jsonbSafe(v)]); },
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
        [wallet, Date.now(), Math.max(0, chikis | 0), jsonbSafe(Array.isArray(roster) ? roster.slice(0, 8) : [])]);
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
        [wallet, now, now - 60000, jsonbSafe(profile)]);
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
    // The roster guard's only input. Counts SAVED PLAYERS, not rows: a wallet with no profile is
    // someone who connected once and never played, so it must not pad the number that proves the
    // database still holds the people.
    async profileCount() { return Number((await pool.query(`SELECT COUNT(*) n FROM players WHERE profile IS NOT NULL`)).rows[0].n); },
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
    async ping() { return true; },
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
    async profileCount() { let n = 0; for (const p of players.values()) if (p && p.profile) n++; return n; },
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
async function saveBattleWins(strict = false) {
  if (!_winsDirty) return;
  _winsDirty = false;
  try { await store.kvSet("battle_wins", battleWins); }
  catch (e) { _winsDirty = true; if (strict) throw e; }
}
setInterval(() => { saveBattleWins().catch(() => {}); }, 15000);   // flush the win ledger periodically

// ============ THE FLIP (2026-08-01): SERVER AUTHORITY ON BY DEFAULT, GRACE FOR THE OLD FLEET ============
// Every stage of server authority now defaults ON, and every flag stays a KILL SWITCH: setting the
// env var to exactly "0" turns that piece off and restores the pre-flip behaviour. The three auth
// gates (CHIK_CLAIM_TOKEN, CHIK_CUP_AUTH, CHIK_QUEST_AUTH) take three values:
//     "0"                 OFF — observe/log only, exactly the pre-flip default.
//     unset / "" / "1"    GRACE — the shipping default. A credential is judged strictly when sent;
//                         a request WITHOUT one is forgiven while the old cached fleet drains,
//                         except where the LATCH below has matured.
//     "2" / "strict"      STRICT — refuse every unproven request immediately (the old "=1").
//
// WHY GRACE EXISTS, stated plainly. The deployed fleet (f8e1463525 live, d9f6053cd6 staged) does not
// attach mktToken on /world/node/claim, and older cached builds do not attach credentials on
// /quest/complete or /cup/* either; browser caches keep a superseded build alive for hours-to-days
// after a deploy. A gate that hard-refuses on day one silences honest players — that is how the gold
// wipe and the July egg wipe happened, and it is the one failure this flip must never have. So
// enforcement arrives in two steps:
//
//   THE LATCH (per wallet, per route-class): the first PROVEN request latches the wallet as
//   credential-capable. Once the latch is CRED_LATCH_MATURE_MS old — comfortably past the browser
//   cache horizon, so the same player's other, older cached device has turned over too — an
//   UNPROVEN request from that wallet is refused. Stripping the credential therefore buys an
//   attacker nothing against any wallet that has been on a current client since maturity; it only
//   leaves the never-proven population, which is exactly the population grace exists for, and whose
//   exposure is not new. The latch is persisted (kv "cred_latch") so a restart cannot restart every
//   wallet's maturity clock; losing it anyway fails LENIENT (back to grace), never refusing.
//
//   THE WINDOW: CHIK_CLAIM_GRACE_H / CHIK_AUTH_GRACE_H hours after CHIK_FLIP_EPOCH_MS, unproven
//   claim/quest requests from never-latched PUBKEY wallets stop being forgiven too (net_ids always
//   stand alone — the id is the secret, presenceOk's rule). The default (336h = 14 days) is far past
//   any cache horizon. The Cup deliberately has NO window: a desktop/demo player can never mint a
//   token, so its live-presence fallback is permanent and only the matured latch ever hardens a
//   wallet — full credential enforcement there applies exactly to wallets that proved they can send one.
//
// WHAT GRACE DOES NOT PROTECT while it lives, so nobody mistakes it for enforcement: an unproven
// pubkey claim can still burn a victim's node cooldowns (denial-of-gathering — the attacker gains no
// material, recordGather credits the victim), and an unproven quest report can still mint pouch
// LIABILITY for an arbitrary wallet (a review list, not a payout — no $CHIKI moves without an
// admin-signed batch). Both are today's exposures, unchanged in kind, shrinking with the fleet, and
// closed at latch maturity / window close.
function gateFlipMode(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "0") return "off";
  if (v === "2" || v === "strict") return "strict";
  return "grace";
}
const FLIP_EPOCH_MS = (() => { const v = Number(process.env.CHIK_FLIP_EPOCH_MS);
  return Number.isFinite(v) && v > 0 ? v : Date.parse("2026-08-01T00:00:00Z"); })();
const CLAIM_GRACE_MS = Math.max(0, Number(process.env.CHIK_CLAIM_GRACE_H ?? 336)) * 3600_000;
const AUTH_GRACE_MS  = Math.max(0, Number(process.env.CHIK_AUTH_GRACE_H  ?? 336)) * 3600_000;
const CRED_LATCH_MATURE_MS = Math.max(0, Number(process.env.CHIK_CRED_LATCH_H ?? 72)) * 3600_000;
const CRED_LATCH_TTL_MS = Math.max(0, Number(process.env.CHIK_CRED_LATCH_TTL_H ?? 720)) * 3600_000;
const credLatch = new Map();          // "cls:wallet" -> { f: firstProvenTs, l: lastProvenTs }
let _credLatchDirty = false, _credLatchTimer = null, _credLatchSavedAt = 0;
let _graceClaims = 0, _graceQuests = 0, _graceCups = 0, _latchRefusals = 0;
function saveCredLatchNow(strict = false) {
  _credLatchDirty = false; _credLatchSavedAt = Date.now();
  const o = {}; for (const [k, e] of credLatch) o[k] = { f: e.f, l: e.l };
  return store.kvSet("cred_latch", o).catch(e => { _credLatchDirty = true; if (strict) throw e; });
}
// Same throttle shape as the world feed's: at most one write per 5 s, plus a trailing timer so a
// burst's tail is never the row a restart forgets. The timer is unref'd — it must not hold the
// process open.
function saveCredLatch() {
  _credLatchDirty = true;
  if (Date.now() - _credLatchSavedAt > 5000) { saveCredLatchNow(); return; }
  if (!_credLatchTimer) {
    _credLatchTimer = setTimeout(() => { _credLatchTimer = null; if (_credLatchDirty) saveCredLatchNow(); }, 5000);
    if (_credLatchTimer.unref) _credLatchTimer.unref();
  }
}
store.kvGet("cred_latch").then(v => {
  if (!v || typeof v !== "object") return;
  for (const k of Object.keys(v)) {
    const f = Number(v[k] && v[k].f), l = Number(v[k] && v[k].l);
    if (Number.isFinite(f) && f > 0) credLatch.set(k, { f, l: Number.isFinite(l) && l > 0 ? l : f });
  }
}).catch(() => {});
function credLatchNote(cls, wallet) {
  const w = String(wallet || "");
  if (!isPubkey(w)) return;               // a net_id never needs a credential, so it never latches
  const k = cls + ":" + w, now = Date.now();
  const e = credLatch.get(k);
  if (e) { e.l = now; }
  else {
    if (credLatch.size >= 20000) { let d = 1000; for (const kk of credLatch.keys()) { if (d-- <= 0) break; credLatch.delete(kk); } }
    credLatch.set(k, { f: now, l: now });
  }
  saveCredLatch();
}
// Is the latch BINDING for this wallet on this route-class right now? Rolling TTL: a wallet whose
// proven client went quiet for CRED_LATCH_TTL_MS unlatches back to grace (fail lenient, always).
function credLatchBinding(cls, wallet, now) {
  const k = cls + ":" + String(wallet || "");
  const e = credLatch.get(k);
  if (!e) return false;
  if (CRED_LATCH_TTL_MS && now - e.l > CRED_LATCH_TTL_MS) { credLatch.delete(k); saveCredLatch(); return false; }
  return now - e.f >= CRED_LATCH_MATURE_MS;
}
// The verdict for an UNPROVEN request on a graced gate. graceMs=Infinity means "no window" (the Cup).
function graceAllows(cls, wallet, now, graceMs) {
  if (!isPubkey(String(wallet || ""))) return true;              // net_id — the id is the secret
  if (credLatchBinding(cls, wallet, now)) { _latchRefusals++; return false; }
  return now < FLIP_EPOCH_MS + graceMs;
}
export function _credLatchForTest(cls, w) { const e = credLatch.get(cls + ":" + String(w)); return e ? { f: e.f, l: e.l } : null; }
export function _flipStatsForTest() {
  return { claimMode: CLAIM_TOKEN_MODE, cupMode: CUP_AUTH_MODE, questMode: QUEST_AUTH_MODE,
           flipEpochMs: FLIP_EPOCH_MS, claimGraceMs: CLAIM_GRACE_MS, authGraceMs: AUTH_GRACE_MS,
           latchMatureMs: CRED_LATCH_MATURE_MS, latchTtlMs: CRED_LATCH_TTL_MS, latched: credLatch.size,
           graceClaims: _graceClaims, graceQuests: _graceQuests, graceCups: _graceCups, latchRefusals: _latchRefusals };
}

/* ----------------------------- Chikoria Cup (live event) ----------------------------- */
const CUP_ELEMS = ["Water", "Fire", "Beast", "Storm", "Light"];
let liveCup = null;                  // in-memory orchestrator (null until an admin creates one)
let cupRound = null;                 // transient: the current round's LIVE PvP matches { battling, matchByWallet, side, matches }
let cupPublic = true;                // true = open to ALL players (launched). Admin can flip to admin-only via /cup/public.
// Auth for /cup/register + /cup/ready. See THE FLIP block above: "0" = off (presence-gated, the
// pre-flip default), default = GRACE (credential judged when sent; latch + permanent presence
// fallback for the never-verified), "strict"/"2" = hard credential gate (the old "=1").
const CUP_AUTH_MODE = gateFlipMode("CHIK_CUP_AUTH");
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
  // minted counts BOTH routes (see memeIssued) — the bar used to show only the paid sale, so a
  // creature hatched from an in-game meme egg was invisible to the very number advertising its rarity
  for (const c of MEME_CHARS) {
    const cap = capOf(c.key), m = memeIssued(c.key);
    chars[c.key] = { name: c.name, minted: m, cap, left: Math.max(0, cap - m), rarity: c.rarity, sold: memeMinted[c.key] || 0 };
    hatched += m;
  }
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
  if (changed) { censusInvalidate(); try { await saveMeme(); } catch (e) {} console.log("meme: randomize migration applied — incubating eggs reset to mystery; per-char counts recomputed"); }
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
// HOW MANY OF THIS MEME CHARACTER EXIST, COUNTING EVERY WAY ONE CAN BE OBTAINED.
//
// There are two disjoint routes to a Meme Dynasty chikimon and neither knew about the other:
//   1. the paid Meme Dynasty sale  -> memeHatches -> memeMinted[char]
//   2. the in-game MEME EGG        -> /assets/egg/hatch|consume -> a registry chikimon row
// Only route 1 was counted, so the "x / 10" scarcity bar could read 0 while players genuinely owned
// the creature — and, far worse, route 2 was capped by NOTHING, so the 10-edition promise on Alon
// was not enforced at all. A cap that only one door respects is not a cap.
//
// Nor were the LEGACY ledger's meme creatures counted, and adding the sale counter to the registry
// blind double-counted the one creature that is in both (a paid sale is granted in-game, reaches
// the save, and is then adopted into the registry). So this is no longer a counter of its own: it
// is a thin wrapper over trueIssued(), the ONE consolidation across registry + ledger + sales.
// Two counters can drift; one cannot.
function memeRegistryCount(key) { return trueIssued("chikimon", key).registry; }
function memeIssued(key) { return trueIssued("chikimon", key).count; }
// is this meme species still mintable at all? used by every path that can create one
function memeAtCap(key) { return memeIssued(key) >= capOf(key); }
function pickMeme() {
  const avail = MEME_CHARS.filter(c => memeIssued(c.key) < capOf(c.key));
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
  try { const fe = await store.kvGet("fish_event"); if (fe && Number(fe.mult) > 1 && Number(fe.ends) > Date.now()) _fishEvent = { mult: Math.min(10, Math.max(1, Number(fe.mult))), ends: Number(fe.ends), label: String(fe.label || "Fishing Festival").slice(0, 40) }; } catch (e) {}   // a mid-festival restart must not end the party
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
        await pool.query(`UPDATE chat SET reactions=$2::jsonb WHERE id=$1`, [id, jsonbSafe(rx)]);
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

// Render sends SIGTERM before taking an instance away. From that instant onward, stop accepting
// new work on keep-alive connections while requests already in flight are allowed to finish.
let _draining = false, _chatReady = false;
app.use((req, res, next) => {
  if (_draining === false || req.path === "/health") return next();
  res.set("Retry-After", "30");
  return res.status(503).json({ error: "server is restarting; retry shortly" });
});

/* ------------------------- THE ROSTER GUARD -------------------------
 * 2026-08-04: the service was pointed at a database that did not hold the players. ~2,443 wallets
 * opened the game, the server found no row for their wallet, and handed each of them a fresh empty
 * profile — which their client then saved back. Nothing alarmed, because a server that cannot find
 * you is indistinguishable from a server meeting a brand-new player. The damage was silent and it
 * ran for days.
 *
 * The tripwire therefore has to be a number the server knows BEFORE it reads the database, and it
 * has to live OUTSIDE the database — otherwise it travels with the wrong one and agrees with it.
 * Two independent wires, because they fail in opposite directions:
 *
 *   CHIK_ROSTER_MIN   an env var on the SERVICE. Survives a DATABASE_URL swap, so it is the one
 *                     that fires the moment a new/short database is promoted to live. THIS IS THE
 *                     WIRE THAT WOULD HAVE CAUGHT 2026-08-04. Unset = unarmed (and said so loudly).
 *   kv roster_hwm     a high-water mark learned INSIDE each database, only ever revised upward.
 *                     Survives nothing, but catches a truncate/restore/partial-wipe of the database
 *                     the service is already on — which the env var cannot see.
 *
 * Floor = max(CHIK_ROSTER_MIN, hwm × (1 − CHIK_ROSTER_DROP)). Below the floor the guard trips.
 * Modes: off | warn (default — loud alarm, keeps serving) | refuse (503 everything but /health).
 * The default is `warn` on purpose: a mis-set env var must never be able to take a live game down.
 * The runbook's instruction is to arm MIN first, watch one boot, then move to `refuse`.
 */
const ROSTER_GUARD_MODE = (() => {
  const v = String(process.env.CHIK_ROSTER_GUARD ?? "warn").trim().toLowerCase();
  return (v === "off" || v === "0" || v === "refuse") ? (v === "0" ? "off" : v) : "warn";
})();
const ROSTER_MIN = Math.max(0, Math.floor(Number(process.env.CHIK_ROSTER_MIN ?? 0)) || 0);
const ROSTER_DROP = (() => { const v = Number(process.env.CHIK_ROSTER_DROP);
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0.20; })();
const ROSTER_RECHECK_MS = Math.max(60_000, Number(process.env.CHIK_ROSTER_RECHECK_MS) || 600_000);
// A trip is latched: it must not un-trip on its own while players keep arriving and re-saving empty
// profiles (which would slowly walk the count back up over the floor and hide the incident).
let _rosterGuard = { mode: ROSTER_GUARD_MODE, checked: false, tripped: false, profiles: -1,
                     floor: 0, hwm: 0, min: ROSTER_MIN, drop: ROSTER_DROP, reason: "", at: 0 };
export function _rosterGuardState() { return { ..._rosterGuard }; }

async function rosterGuardCheck(why) {
  if (ROSTER_GUARD_MODE === "off") { _rosterGuard.checked = true; return _rosterGuard; }
  let profiles;
  try { profiles = await store.profileCount(); }
  catch (e) {
    // A database that will not answer is a different failure (/health's dbReady already covers it).
    // Never trip on it: an unreachable database must not be reported as an empty one.
    console.warn(`roster guard: profile count unavailable (${String(e?.message || e)}) — check skipped`);
    return _rosterGuard;
  }
  let hwm = 0;
  try { const v = await store.kvGet("roster_hwm"); hwm = Math.max(0, Math.floor(Number(v?.n ?? v ?? 0)) || 0); } catch (e) {}
  const floor = Math.max(ROSTER_MIN, Math.floor(hwm * (1 - ROSTER_DROP)));
  const short = profiles < floor;
  _rosterGuard.checked = true; _rosterGuard.profiles = profiles; _rosterGuard.floor = floor;
  _rosterGuard.hwm = hwm; _rosterGuard.at = Date.now();

  if (short) {
    const reason = `${profiles} saved profiles, expected at least ${floor}` +
      ` (CHIK_ROSTER_MIN=${ROSTER_MIN}, learned high-water mark=${hwm}, tolerance=${Math.round(ROSTER_DROP * 100)}%)`;
    if (!_rosterGuard.tripped) {
      console.error("");
      console.error("  ############################################################");
      console.error("  #  ROSTER GUARD TRIPPED — THIS DATABASE IS MISSING PLAYERS  #");
      console.error("  ############################################################");
      console.error(`  ${reason}`);
      console.error(`  Checked because: ${why}`);
      console.error(`  This is what a wrong DATABASE_URL looks like. Every wallet that connects now`);
      console.error(`  gets a FRESH EMPTY PROFILE and saves it back over nothing.`);
      console.error(`  Mode=${ROSTER_GUARD_MODE}. ` + (ROSTER_GUARD_MODE === "refuse"
        ? "REFUSING ALL REQUESTS except /health until this is resolved."
        : "STILL SERVING (mode=warn). Set CHIK_ROSTER_GUARD=refuse to stop serving instead."));
      console.error(`  Do NOT delete any database. See ROSTER_RECOVERY.md.`);
      console.error("");
    }
    _rosterGuard.tripped = true; _rosterGuard.reason = reason;
    return _rosterGuard;
  }

  _rosterGuard.reason = "";
  if (_rosterGuard.tripped) {
    // Only a check that PASSES the floor clears the latch, and it is announced.
    console.log(`roster guard: cleared — ${profiles} saved profiles is at or above the floor of ${floor}`);
    _rosterGuard.tripped = false;
  }
  // Learn upward only. A wipe can never teach the guard a smaller number.
  if (profiles > hwm) {
    try { await store.kvSet("roster_hwm", { n: profiles, at: Date.now() }); _rosterGuard.hwm = profiles; } catch (e) {}
  }
  return _rosterGuard;
}

// Refuse mode. /health stays open so the platform and the owner can both see WHY, and so the fix
// is diagnosable without a redeploy. Everything else — including every path that would read a
// missing profile, hand back an empty one, or write one — is closed.
app.use((req, res, next) => {
  if (!(_rosterGuard.tripped && ROSTER_GUARD_MODE === "refuse") || req.path === "/health") return next();
  res.set("Retry-After", "300");
  return res.status(503).json({
    error: "the server is not serving: its database is missing player rosters",
    rosterGuard: { tripped: true, profiles: _rosterGuard.profiles, floor: _rosterGuard.floor, reason: _rosterGuard.reason },
  });
});

app.get("/health", async (_q, res) => {
  let dbReady = false;
  try { await store.ping(); dbReady = true; } catch {}
  const stateReady = _assetsReady && _ownReady;
  // A tripped guard makes /health RED only in refuse mode. In warn mode the alarm is reported but
  // /health stays green, or the platform would restart-loop a service that is still serving players.
  const rosterOk = !(_rosterGuard.tripped && ROSTER_GUARD_MODE === "refuse");
  const ok = _draining === false && dbReady && _chatReady && stateReady && rosterOk;
  res.status(ok ? 200 : 503).json({
    ok, draining: _draining, dbReady, chatReady: _chatReady, stateReady,
    rosterGuard: {
      mode: ROSTER_GUARD_MODE, armed: ROSTER_MIN > 0, tripped: _rosterGuard.tripped,
      profiles: _rosterGuard.profiles, floor: _rosterGuard.floor, min: ROSTER_MIN,
      hwm: _rosterGuard.hwm, checkedAt: _rosterGuard.at, reason: _rosterGuard.reason || null,
    },
    network: NETWORK, store: store.kind, verifyHolders: verifyOn,
    treasury: treasury.publicKey.toBase58(), team: TEAM_WALLET || null,
    mint: CHIKI_MINT || null, minHold: MIN, minHoldMinutes: Number(MIN_HOLD_MINUTES),
    dailyCap: DAILY_FRAC >= 1 ? "none" : Math.round(DAILY_FRAC * 100) + "% pool/day", perWalletDailySol: WALLET_DAILY, poolReserveSol: RESERVE,
    maxClaimSol: CAP, earnModel: "rarity-weighted-tasks", earnMult: MULT, taskSeconds: TASK_SEC, accrualCapMin: ACCRUAL_CAP,
    whaleMin: WHALE_MIN, whaleHoldHours: Number(WHALE_HOLD_HOURS),
  });
});

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
    // ONE LIVE SESSION PER WALLET. Cloud saves resolve by newest-saved_at, wholesale, with no field
    // merge (merging inventories would be a duplication faucet) — so two devices on one wallet meant
    // the loser's ENTIRE session was silently discarded, however long they had played. A sign-in now
    // mints a session id and becomes the live one; an older session learns it has been superseded on
    // its very next save and stops, instead of playing for an hour into a save that cannot land.
    // TAKEOVER, never refusal: the NEWEST sign-in always wins, so a stale session can never lock a
    // player out of their own wallet.
    const sessionId = signedIn ? mintSession(wallet) : "";
    res.json({ wallet, eligible, balance, chikis, whalePending, whaleReadyInMs, minHold: MIN, verified: verifyOn, firstSeen, profile: profile || null, dbOk, signedIn, isAdmin, mktToken, sessionId });
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
  // SUPERSEDED SESSION — refuse BEFORE the write, or the loser clobbers the live session's save.
  // Only ever fires for a client that sent a session id (older clients are unaffected), and only
  // when a NEWER sign-in for this same wallet has taken over. The client stops pushing and tells
  // the player, rather than playing on into saves that can never land.
  if (hasMmo && sessionSuperseded(wallet, String(req.body?.sessionId || ""))) {
    return res.status(409).json({ error: "this trainer was opened on another device", superseded: true });
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
    // THE ONE-TIME OPENING BALANCE. Taken from prev._serverSavedAt — the only clock the server writes
    // itself — BEFORE this save overwrites it, so a pre-existing player's real hoard becomes sellable
    // entitlement instead of being refused on cutover day.
    if (hasMmo) ownSnapshotOpening(wallet, profile.mmo, prev && prev._serverSavedAt);
    // STEP 7 — THE ECONOMY FLIP. Baseline first (one-time grandfather), then the invariant. The blob
    // is still stored VERBATIM below — the client's own signature must survive — so enforcement is
    // corrections in the RESPONSE (`matClamps`), which a >= MAT_SAVE_MIN_V client applies and
    // re-signs. Admin saves are trusted, same as the sanitizer above. Never fatal to a save.
    let matClamps = null;
    if (hasMmo && !isAdminWallet(wallet)) {
      try { matSaveBaseline(wallet, profile.mmo); matClamps = matSaveEnforce(wallet, profile.mmo); }
      catch (e) { console.error("mat save flip threw for", String(wallet).slice(0, 8), e && e.message); }
    }
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
    // matClamps: { material: bound } — the wallet exceeded the acquisition invariant; the client sets
    // each local count to min(current, bound) and re-signs. Old clients ignore unknown keys (Chain.gd
    // reads only serverSavedAt), so this is additive and non-destructive.
    if (matClamps) res.json({ ok: true, serverSavedAt: safe._serverSavedAt, matClamps, matFlagged: true });
    else res.json({ ok: true, serverSavedAt: safe._serverSavedAt });
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
    // read the SPLIT CONSTANT, never a fourth hand-written copy of it — this field is what the
    // operator is quoted, and txMarketSplit enforces MARKET_SELLER_SHARE
    res.json({ ok: true, wallet, sid: key, species, price, sellerWillNet: Math.round(price * MARKET_SELLER_SHARE),
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
// Read-only, public: THE RARITY BOARD — every capped species, its supply, how many exist, what is
// left, and the LIVE rarity that scarcity earns it. Rarity rises as the world claims more: the
// tier is read off what REMAINS, so the last few of anything are the rarest things in Chikoria.
function liveRarity(remaining, cap) {
  if (cap <= 0) return "Common";
  if (remaining <= 0) return "Extinct";
  if (remaining <= Math.max(1, Math.round(cap * 0.02))) return "Immortal";
  if (remaining <= Math.max(2, Math.round(cap * 0.08))) return "Mythic";
  if (remaining <= Math.max(4, Math.round(cap * 0.20))) return "Legendary";
  if (remaining <= Math.max(8, Math.round(cap * 0.40))) return "Epic";
  if (remaining <= Math.max(16, Math.round(cap * 0.70))) return "Rare";
  return "Uncommon";
}
// EVERY NUMBER HERE IS EXPLAINABLE. `issued` is the consolidated, deduped count across all three
// record sources, and `breakdown` says exactly where it came from — registry rows, legacy ledger
// entries, paid sales, and how many of those were the SAME creature seen twice. An owner who
// cannot audit a scarcity number has to take it on faith, and so does every buyer.
// Uncapped classes (normal/legendary chikimon, eggs) are published too, with cap 0: nothing the
// world holds should be invisible just because nothing limits it.
app.get("/world/rarity", (_req, res) => {
  const out = { avatar: {}, mount: {}, chikimon: {}, egg: {}, unlisted: [] };
  const done = new Set();
  const emit = (type, sp, cap) => {
    const k = _censusKey(type, sp);
    if (done.has(k)) return;
    done.add(k);
    const t = trueIssued(type, sp);
    const left = cap > 0 ? Math.max(0, cap - t.count) : -1;      // -1 = uncapped, nothing to run out of
    const bucket = out[type] || (out[type] = {});
    bucket[sp] = { cap, issued: t.count, remaining: left, rarity: cap > 0 ? liveRarity(left, cap) : "Uncapped",
                   breakdown: { registry: t.registry, ledger: t.ledger, sales: t.sales,
                                deduped: t.deduped, flagged: t.flagged } };
  };
  for (const [type, tbl] of Object.entries(ASSET_SUPPLY)) for (const sp of Object.keys(tbl)) emit(type, sp, tbl[sp]);
  for (const c of MEME_CHARS) emit("chikimon", c.key, c.cap || MEME_CAP);
  for (const sp of SPECIES_NORMAL) emit("chikimon", sp, 0);
  for (const sp of SPECIES_LEGEND) emit("chikimon", sp, 0);
  // Anything the world actually holds that NO supply table names — an old species, a renamed one, a
  // crafted save's invention. Reported, never a crash, and never silently dropped from the count.
  for (const c of censusAll().values()) {
    const k = _censusKey(c.type, c.sp);
    if (done.has(k) || (!c.count && !c.flagged)) continue;
    emit(c.type, c.sp, 0);
    out.unlisted.push({ type: c.type, sp: c.sp, issued: c.count, flagged: c.flagged });
  }
  res.json(out);
});
// Read-only, public: the island's chronicle — the FULL retained backlog (the client pop-up's
// history), the operator's "did any events happen?", and diagnosis. Writes nothing.
// Contract: rows are OLDEST → NEWEST, each {id,k,h,d,t} where id is a monotonic sequence (the
// unambiguous cursor — `t` can collide within one millisecond). `?since=<epoch ms>` keeps the
// exact strictly-greater clock semantics of the move reply's fs cursor; `?limit=N` (clamped to
// 1..WORLD_FEED_MAX) keeps the NEWEST N of whatever matched. `count` is rows returned (as before —
// the two were always equal), `total` is rows retained.
//
// THE DEFAULT PAGE IS SMALL ON PURPOSE. Measured (chron_attack_sim case G): serving the whole ring
// by default turned a 505 B public endpoint into 33,761 B, and one unauthenticated client pulled
// 569 req/s = 18.3 MiB/s of egress from a machine that has already had a hosting bandwidth incident.
// The backlog is still available in full — it just has to be ASKED for (`?limit=400`), which is what
// a pop-up opening once per session does and what a bandwidth drain will not bother to do.
// Rows never carry the author wallet (feedWire).
app.get("/world/feed", (req, res) => {
  const since = Number(req.query?.since) || 0;
  let lim = Math.floor(Number(req.query?.limit)) || WORLD_FEED_PUBLIC_PAGE;
  lim = Math.max(1, Math.min(WORLD_FEED_MAX, lim));
  const rows = (since > 0 ? worldFeed.filter((r) => r.t > since) : worldFeed).slice(-lim);
  res.json({ count: rows.length, total: worldFeed.length, max: WORLD_FEED_MAX, feed: rows.map(feedWire) });
});
// Read-only, public: is a festival on? The operator's answer to "did my curl land?", the website's
// banner source, and the only status check that needs no login and writes nothing.
app.get("/world/event", (_req, res) => {
  if (!fishEventActive()) return res.json({ active: false });
  res.json({ active: true, mult: _fishEvent.mult, ends: _fishEvent.ends, label: _fishEvent.label,
             remainingMs: Math.max(0, Number(_fishEvent.ends) - Date.now()) });
});
// Admin: schedule (or cancel) the fishing festival. Auth: ?key= or body key must equal ADMIN_KEY
// (which never leaves the env). mult clamps to 1..10, duration to 168h; mult<=1 or hours<=0 cancels.
app.post("/admin/fishing-event", async (req, res) => {
  const key = String(req.body?.key ?? req.query?.key ?? "");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "admin key required" });
  const mult = Math.min(10, Math.max(1, Number(req.body?.mult) || 1));
  const hours = Math.min(168, Math.max(0, Number(req.body?.hours) || 0));
  const label = stripTags(String(req.body?.label || "Fishing Festival")).slice(0, 40);
  if (mult <= 1 || hours <= 0) {
    _fishEvent = { mult: 1, ends: 0, label: "" };
    await saveFishEvent();
    return res.json({ ok: true, active: false });
  }
  _fishEvent = { mult, ends: Date.now() + hours * 3600000, label };
  await saveFishEvent();
  res.json({ ok: true, active: true, mult, hours, label, ends: _fishEvent.ends });
});
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
   Payout destination is ALWAYS the earning wallet (never client-chosen) and the
   amount is ALWAYS the server ledger (never client-sent). Write-before-send + a
   per-wallet lock make double-claims impossible.

   WHAT GUARDS THE OUTFLOW, PRECISELY — this header used to claim "per-claim /
   per-wallet-daily / pool-reserve caps AND a global hourly circuit breaker that
   auto-halts if outflow spikes". NONE OF THAT EXISTS ON THE $CHIKI PATHS.
   RESERVE / DAILY_FRAC / WALLET_DAILY are SOL constants belonging to the retired
   /claim route (REWARDS_QUEST_ONLY makes it pay 0), there is no hourly
   accumulator anywhere in this file, and neither _payoutQuestReward nor
   _payoutOne reads one — both call sendChikiRaw directly. The REAL controls are:
     · an ADMIN SIGNATURE on an action-bound, single-use, 5-minute nonce
     · MANUAL REVIEW of the list before release (/quest/rewards)
     · a batch size capped at 25 wallets per signed call
     · the winner path's at-payout stake re-check (added 2026-07-31)
     · and, ultimately, the treasury's own balance
   So the operator must eyeball the totals: 25 x 112,030 = 2,800,750 $CHIKI can
   leave in one signed call, and nothing here will stop it.
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
// THE MASK SITS EXACTLY ON THE POSTGRES BIGINT CEILING. A wallet that has claimed all 63 chapters
// holds 9223372036854775807 = 2^63-1, i.e. bits 0..62 are all consumed and bit 63 is the sign bit.
// quest_rewards.done_mask is BIGINT and qrAccrue casts `$2::bigint`, so a 64th chapter would make
// every completion of it throw — SILENTLY, because the call site swallows the error with a
// console.error. Fail LOUDLY at boot instead: the migration (done_mask -> NUMERIC, or a second
// done_mask_hi column read as a pair) has to land BEFORE the chapter, not after the reports start
// vanishing.
{
  const _overflow = MAIN_QUESTS.filter(q => q.bit > 62).map(q => `${q.id}(bit ${q.bit})`);
  if (_overflow.length) {
    throw new Error(`quest done_mask exceeds a signed BIGINT: ${_overflow.join(", ")} — migrate quest_rewards.done_mask to NUMERIC before adding this chapter`);
  }
}
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
// ============ THE 21 CHAPTERS THAT WERE ALWAYS REAL (Profile.gd REAL21) ============
// On 2026-07-24 06:00 UTC, 42 soft chapters were promoted to real payouts. Every player who had
// already claimed any of them banked the SOFT reward, so Profile._migrate_promo63 marks those ids
// `quest_soft_settled` and Chain.reconcile_quest_reports NEVER reports them again — that is what
// stops the same chapter being paid twice. But the in-order gate below required them as
// PREDECESSORS, and they are ids the server can therefore never receive from a grandfathered save.
//
// Measured (quests_grandfather_sim): a veteran replaying the real client's queue got 7 chapters
// credited (17,000 $CHIKI) and then s_hunt -> 409 need=s2_flower, forever. 83,000 of the 100,000
// they were owed blocked, s_ascend unreachable, and the client re-polls that 409 every 25 s for
// the rest of time (Chain.gd dequeues only on a 400). So the ordering gate now binds on the LEGACY
// 21 only: those still have to arrive in order, and a promoted chapter is never a required
// predecessor. Nothing is paid twice — each chapter still pays exactly once, on its own bit — and
// the blocked 83,000 needs no back-fill, because the client's own retry queue drains as soon as the
// 409 stops.
const QUEST_LEGACY21 = new Set(["s_meet", "s_kill", "s_gather", "s_stone", "s_craft", "s_forage", "s_fish",
  "s_hunt", "s_shell", "s_gear", "s_meat", "s_stock", "s_chiki", "s_honey", "s_ore",
  "s_angler", "s_slayer", "s_forge2", "s_crystal", "s_train", "s_ascend"]);
// Auth for /quest/complete. See THE FLIP block: "0" = off (the pre-flip default — unauthenticated
// reports accepted), default = GRACE (credential judged when sent; a bare {wallet, questId} from the
// old fleet forgiven until latch maturity / window close), "strict"/"2" = hard gate (the old "=1").
// A credential that IS sent is checked in every mode, and a WRONG one is always refused.
const QUEST_AUTH_MODE = gateFlipMode("CHIK_QUEST_AUTH");
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
  // AUTH MODEL — CORRECTED 2026-07-31. This comment used to say the game "connects wallets by PUBLIC
  // ADDRESS ONLY … it never asks for a signature", and that the holder gate is "re-checked at
  // payout". BOTH ARE NOW FALSE. /verify performs a real Ed25519 sign-in and mints a market token,
  // the shipped client refuses to poll without one, and the whole market rail is bound to it; and
  // neither _payoutQuestReward nor _payoutOne re-reads a balance (see the note in _payoutOne).
  //
  // What is TRUE today: this route is unauthenticated, and 103,030 $CHIKI of pouch LIABILITY can be
  // minted per arbitrary Solana address with curl (measured: 63 posts in 104 ms; 300 never-seen
  // wallets enqueued in 77 ms). No $CHIKI moves without an admin-signed batch, so this is a review
  // list, not a payout — but the list is the only control, so treat it as untrusted and cross-check
  // against presence/world activity before signing.
  //
  // The credential the client already holds is honoured here now, and a WRONG one is refused, so the
  // client half can ship and be verified before CHIK_QUEST_AUTH turns the gate on.
  const _qTok = String(req.body?.mktToken || "");
  if (_qTok && marketTokens[wallet] !== _qTok) return res.status(401).json({ error: "sign in again — that market token is stale" });
  const _qProven = (_qTok && marketTokens[wallet] === _qTok)
    || verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig);
  if (_qProven) credLatchNote("quest", wallet);
  if (QUEST_AUTH_MODE !== "off" && !_qProven) {
    // STRICT refuses outright; GRACE forgives the old fleet's bare {wallet, questId} until the
    // window closes — except a wallet the latch has matured on (THE FLIP block). The refusal
    // precedes every write on this route, so a refused report records nothing.
    if (QUEST_AUTH_MODE === "strict" || !graceAllows("quest", wallet, Date.now(), AUTH_GRACE_MS)) {
      return res.status(401).json({ error: "sign-in required to report a chapter" });
    }
    _graceQuests++;
  }
  try {
    const led = await _questLoad(wallet);
    const idx = QUEST_IDX.get(questId);
    if (led.done[questId]) {
      // SELF-HEAL: completions recorded before the per-quest pouch shipped (or whose accrual
      // write failed) have a done entry but no pouch bit — back-fill it here, idempotently.
      // A PURE READ IN THE COMMON CASE. This branch sits ABOVE the pacing gate, so it used to run an
      // INSERT..ON CONFLICT DO UPDATE on every repeat post of an already-done chapter, at whatever
      // rate the caller chose (12 repeats returned 200/already in 25 ms). The heal is only needed
      // when the bit is genuinely missing, so ask first and write only then.
      const _qb = QUEST_BIT.get(questId) || 0n;
      try {
        const _qr = await store.qrGet(wallet);
        if (_qb && !(questMask(_qr && _qr.done_mask) & _qb)) await store.qrAccrue(wallet, _qb);
      } catch (e) { console.error("qrAccrue(already) failed", wallet, questId, String(e.message || e)); }
      const wrow = isFinal ? await store.winnerGet(wallet) : null;
      return res.json({ ok: true, already: true, questId, finished: isFinal, won: !!wrow, rank: wrow ? wrow.rank : 0, done: Object.keys(led.done) });
    }
    // IN-ORDER, ON THE LEGACY 21 ONLY — see QUEST_LEGACY21 for why a promoted chapter can never be a
    // required predecessor (a grandfathered veteran never reports one, and the 409 jammed them at
    // Ch.15 with 83,000 $CHIKI unreachable).
    for (let i = 0; i < idx; i++) {
      const pid = MAIN_QUESTS[i].id;
      if (QUEST_OPTIONAL.has(pid) || !QUEST_LEGACY21.has(pid)) continue;
      if (!led.done[pid]) return res.status(409).json({ error: "complete earlier chapters first", need: pid });
    }
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

  // ...AND NOW IT ACTUALLY DOES. The line above described a check that did not exist: there was no
  // chikiBalance call anywhere between payoutBegin and sendChikiRaw, and balance_at_win was recorded
  // at reserveWinner and never compared to anything. So one actor with 500,000 $CHIKI of working
  // capital — not 5,000,000 — could hold it in wallet 1, run the 63 chapters (the route is
  // unauthenticated), move the stake to wallet 2, and repeat, capturing all ten slots and the entire
  // 10,000,000 $CHIKI prize pool, then sell the stake before the admin batch ran.
  //
  // SKIPPED, NEVER CLEARED. A wallet that fails this is left on the list exactly as it was, so a
  // genuine winner who happened to be mid-transfer (or an RPC that could not answer) is paid on the
  // next run rather than losing a prize they earned. This is the WINNER path only — the 2026-07-22
  // owner policy of no at-payout re-check for the per-chapter POUCH is unchanged.
  try {
    const _bal = await chikiBalance(wallet, true);
    if (_bal < QUEST_MIN_HOLD) {
      return { skipped: `stake no longer held (${Math.floor(_bal)} < ${QUEST_MIN_HOLD}) — left on the list, retry when it is restored`, balance: _bal };
    }
  } catch (e) {
    return { skipped: "eligibility check unavailable — left on the list, retry shortly" };
  }

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
  // ============ YOU MAY NOT SEAT SOMEONE ELSE ============
  // This route read req.body.wallet and never proved it — no signature, no market token, no
  // presence. Measured: a caller with no credential of any kind seated 7 strangers, filled an 8-seat
  // lobby, and burned 100 Glory from each. Every one of those players will no-show, forfeit round 1,
  // and hand the attacker's own entry a clean run at a 1.00 SOL prize — while real entrants are
  // locked out of a tournament with a real SOL pool.
  //
  // THE CLIENT DOES NOT SEND A CREDENTIAL YET (Chikiseum.gd _cup_register posts {wallet, snap}), so
  // a hard gate here would 401 every honest entry — this is a both-sides fix and the client half
  // must deploy first. Two things land now that do not need it:
  //   1. A LIVE WORLD PRESENCE. The Chikiseum is in the world and Net.gd POSTs /world/move every
  //      frame while the game is up (only the boot wallet-gate holds it), so an honest entrant
  //      always has a row. It cuts the victim pool from "any wallet on the roster, the market board
  //      or the chat log" to "someone playing right now", and it kills the sybil variant outright.
  //   2. A CREDENTIAL IS HONOURED IF SENT, AND A BAD ONE IS REFUSED — so the client half can ship
  //      and be verified before CHIK_CUP_AUTH is flipped.
  const _cupTok = String(req.body?.mktToken || "");
  const _cupProven = (_cupTok && marketTokens[wallet] === _cupTok)
    || verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig);
  if (_cupTok && marketTokens[wallet] !== _cupTok) return res.status(401).json({ error: "sign in again — that market token is stale" });
  if (_cupProven) credLatchNote("cup", wallet);
  if (CUP_AUTH_MODE === "strict" && !_cupProven) return res.status(401).json({ error: "sign-in required to enter the Cup" });
  if (!_cupProven) {
    // GRACE, permanently windowless for the Cup: a desktop/demo player can never mint a token, so
    // the live-presence fallback below is their tier for good. Only the matured latch hardens a
    // wallet — one that has proven it can send a credential must keep sending one.
    if (CUP_AUTH_MODE !== "off" && !graceAllows("cup", wallet, Date.now(), Infinity)) {
      return res.status(401).json({ error: "sign-in required to enter the Cup" });
    }
    const pres = worldPlayers.get(wallet);
    if (!pres || Date.now() - pres.ts > WORLD_TTL_MS) {
      return res.status(403).json({ error: "enter the Cup from inside Chikoria — no live presence for that trainer" });
    }
    if (CUP_AUTH_MODE !== "off") _graceCups++;
  }
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
  // same rule as /cup/register: readying a stranger starts a round they are not sitting at, which
  // costs them the match. Credential honoured if sent, wrong one refused, otherwise a live presence.
  const _rTok = String(req.body?.mktToken || "");
  if (_rTok && marketTokens[wallet] !== _rTok) return res.status(401).json({ error: "sign in again — that market token is stale" });
  const _rProven = (_rTok && marketTokens[wallet] === _rTok)
    || verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig);
  if (_rProven) credLatchNote("cup", wallet);
  if (CUP_AUTH_MODE === "strict" && !_rProven) return res.status(401).json({ error: "sign-in required" });
  if (!_rProven) {
    // same grace shape as /cup/register: windowless presence fallback, hardened only by the latch
    if (CUP_AUTH_MODE !== "off" && !graceAllows("cup", wallet, Date.now(), Infinity)) {
      return res.status(401).json({ error: "sign-in required" });
    }
    const pres = worldPlayers.get(wallet);
    if (!pres || Date.now() - pres.ts > WORLD_TTL_MS) return res.status(403).json({ error: "ready up from inside Chikoria" });
    if (CUP_AUTH_MODE !== "off") _graceCups++;
  }
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
  // IMPERSONATION. Same hole as /cup/register: `wallet` and `name` were taken verbatim, so a stranger
  // posted {wallet:<victim>, name:"Victim", text:"I concede"} and got a 200 with the victim's wallet
  // stamped on it. The credential the client will send is honoured here too, and a WRONG one is
  // refused; without one the speaker must at least be a live trainer OR seated in this cup, which is
  // who the cup room is for.
  const _chTok = String(req.body?.mktToken || "");
  if (_chTok && marketTokens[wallet] !== _chTok) return res.status(401).json({ error: "sign in again — that market token is stale" });
  const _chProven = (_chTok && marketTokens[wallet] === _chTok)
    || verifyWalletSig(wallet, req.body?.authMsg, req.body?.authSig);
  if (!_chProven) {
    const seated = !!(liveCup && Array.isArray(liveCup.state.entrants) && liveCup.state.entrants.some(e => e && e.wallet === wallet));
    const pres = worldPlayers.get(wallet);
    const live = pres && Date.now() - pres.ts <= WORLD_TTL_MS;
    if (!seated && !live) return res.status(403).json({ error: "speak from inside Chikoria" });
  }
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
      censusInvalidate();      // a sale just determined its species — the world census changed
    }
    h.status = "pending"; h.hatchedAt = Date.now(); await saveMeme();
    censusInvalidate();        // status incubating -> pending is what makes this sale countable
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
// ============ A WORLD DUEL'S FIGHTER IS NOT THE CALLER'S TO WRITE ============
// The Cup builds its entrants server-side (cupSnapFromBody), but the world-duel routes stored the
// caller's `snap` VERBATIM and pvp-engine read `br`, `arenaSkills` and `cardTier` straight off it.
// Measured against the strongest thing a legitimate client can send (Net.gd's PvpNet snap — companion level,
// cap 50, cardTier 1, arenaSkills []): forged br 100000 gave maxhp 1,200,240 against the honest 840,
// a hand of six tier-5 cards against six tier-1, and the forged side finished on 1,200,099 HP. One
// edited JSON body won any duel with certainty.
//
// THIS IS A SANITISER, NOT A REBUILD, deliberately. Routing world duels through cupSnapFromBody
// would ALSO require every duellist to own a Legendary and to have a stored profile — a gameplay
// change nobody asked for, since net_id and pre-save players can duel today. So instead the fields
// that decide combat are taken away from the wire:
//   * br  -> clamped to 1..50, exactly the range the shipped client sends (and the same clamp
//            /world/move already applies to the presence row's br).
//   * arenaSkills / cardTier -> DROPPED, not clamped. No shipped client writes either one (every
//            occurrence in the client is a hardcoded cardTier:1 / arenaSkills:[]), so the engine's
//            own defaults — deck [0,1,2], every card tier 1 — ARE the honest experience, byte for
//            byte. Clamping to 5 would have left the forger their tier-5 hand.
// When a client one day carries a real deck, it comes from the stored profile the way the Cup's
// does, never from this body.
const DUEL_MAX_BR = 50;
function duelSnap(wallet, snap) {
  const s = (snap && typeof snap === "object") ? snap : {};
  return {
    wallet,
    name: stripTags(String(s.name || "Trainer")).slice(0, 20),
    element: CUP_ELEMS.includes(s.element) ? s.element : "Fire",
    br: Math.max(1, Math.min(DUEL_MAX_BR, Math.floor(Number(s.br) || 1))),
    arenaSkills: [],        // engine default [0,1,2] — what every shipped client already plays
    cardTier: 1,            // engine default tier 1 for every slot
  };
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
  // SANITISED ON THE WAY IN, so nothing downstream ever sees the caller's numbers (see duelSnap)
  const _mySnap = (snap && snap.element) ? duelSnap(wallet, snap) : null;
  if (_mySnap) pvpAvail.set(wallet, { name: String(name || "Trainer").slice(0, 20), snap: _mySnap, ts: Date.now(), searching: !!searching });
  else pvpAvail.delete(wallet);
  // auto-match: if I'm actively searching, pair me with ANY other searching Trainer not already in a battle
  if (searching && _mySnap) {
    for (const [w, v] of pvpAvail) {
      if (w === wallet || !v.searching) continue;
      const m = pvpPlayerMatch.get(w); if (m && pvpMatches.get(m) && pvpMatches.get(m).status === "active") continue;
      const me = { ..._mySnap, wallet }, op = { ...duelSnap(w, v.snap), wallet: w };
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
  // PROVE `from`. It was never checked, so a challenge could be posted AS a stranger: accept it and
  // the victim's pvpPlayerMatch slot holds a duel they never entered, which is what /pvp/available
  // and /pvp/queue then return them into instead of matchmaking — measured, with an honest searcher
  // waiting, the victim's own /pvp/available came back matched to the attacker's forged match and
  // players:0. The attacker also authored the victim's fighter. mktWallet reads b.wallet, and this
  // body's field is `from`, so the token is checked against `from` explicitly.
  //
  // A CLAIMED-SLOT RULE, not a flat gate — the same shape /world/move uses. An unproven caller may
  // still challenge from an id nobody has proven (a net_id-era client, or the beat between sign-in
  // and /verify returning a token); what it may never do is speak for a wallet that IS proven.
  const _fromProven = isPubkey(from) && String(req.body?.mktToken || "").length >= 16 && marketTokens[from] === String(req.body?.mktToken || "");
  if (!_fromProven && marketTokens[from]) {
    return res.status(403).json({ error: "that Trainer is signed in — prove this wallet first" });
  }
  cleanAvail();
  if (pvpChallenges.some(c => c.from === from && c.to === to)) return res.json({ ok: true });   // dedupe
  pvpChallenges.push({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), from, fromName: String(fromName || "Trainer").slice(0, 20), to, snap: duelSnap(from, snap), ts: Date.now() });
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
  // both fighters sanitised (see duelSnap) — the accepter's body is as untrusted as the challenger's
  const m = pvpStartMatch(duelSnap(ch.from, ch.snap), duelSnap(wallet, snap), { turnMs: 30000 });   // challenger = side a, accepter = side b
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
// The movement plausibility bound (see the long note in /world/move). Not a refusal — a stamp that
// makes the two value-bearing reach checks stand down for a moment.
const WARP_MAX_UPS = 110;         // units/second; the boat (70) is the fastest legitimate thing
const WARP_SLACK = 60;            // units of free jump per ping, for latency and dropped packets
// Seconds of WARP_MAX_UPS travel a presence row may bank. Replaces WARP_SLACK's per-ping grant —
// see the long note at the stamp in worldMoveApply for the measurement that forced it.
const WARP_BANK_S = 2.5;
const WARP_HOLD_MS = 3000;        // how long a node claim / monster kill stands down after a warp
let _warpPings = 0;               // observability: how often this fires at all
export function _warpStatsForTest() { return { warps: _warpPings }; }
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
// Sims that predate the acquisition bound test the observe-only oversold signal, which needs a
// listing to actually reach the board. Granting entitlement directly keeps them fast — real gathering
// is CLAIM_MIN_MS-paced — without weakening the live credit path, which only routes can reach.
// Sims that predate the bound test a DIFFERENT layer (the observe-only oversold signal, the asset
// perimeter) and need a listing to reach the board. They turn enforcement off explicitly rather than
// have their assertions quietly rewritten to match it. Never reachable from a request.
export function _setOwnEnforceForTest(on) { _ownEnforce = !!on; return _ownEnforce; }
// Lets the sim prove both sides of the flag without two server boots. Production reads the env var.
export function _rollFantasyCatchForTest(tier, rod) { return rollFantasyCatch(tier, rod); }
// Goes through the REAL guard (proven author + per-author floor + fair trim), so a sim that seeds a
// row through it is also testing the guard. Returns whether the row was accepted. Ring-mechanics
// tests that need rows from an unproven id use _worldFeedSeam.seed instead.
export function _worldFeedPushForTest(k, w, d) { return worldFeedPush(k, w, d); }
// The persistence round-trip seam: this machine has no Postgres, so a sim proves save/restore by
// running the REAL functions in one process — save, wipe, restore, assert (the node_persist_sim
// pattern). Never reachable from a request.
export const _worldFeedSeam = {
  save: () => saveWorldFeedNow(),
  restore: () => restoreWorldFeed(),
  wipe: () => { worldFeed = []; _wfeedSeq = 0; _feedSavedAt = 0; },
  rows: () => worldFeed.slice(),
  seq: () => _wfeedSeq,
  // Ring-mechanics seed for sims that test the WIRE (cursor, ticks, trim) rather than the author
  // gate: it bypasses the proven-wallet check and the floor, and nothing else. Never a request path.
  seed: (k, h, d, w) => {
    const row = { id: ++_wfeedSeq, k: String(k), h: stripTags(String(h)).slice(0, 20),
                  d: String(d).slice(0, 32), t: Date.now(), w: String(w || h) };
    worldFeed.push(row); feedTrimFair(); return row;
  },
};
export function _setFfishAuthorityForTest(on) { _ffishAuth = !!on; if (_ffishAuth) OWN_KINDS.add("ffish"); else OWN_KINDS.delete("ffish"); return _ffishAuth; }
export function _grantOwnForTest(w, item, n, kind = "mat") { ownCredit(String(w), kind, item, n); return n; }
export function _clearOwnBook() { ownBook.clear(); _ownWorst.clear(); _ownRefusals = 0; _ownSkipped = 0; _ownSnapshots = 0; _ownReady = true; _ownEnforce = true;
                                  _matFlags.clear(); _matSaveClamps = 0; _matSaveObserved = 0; _matSaveSkipped = 0; _matBaselines = 0; }
export function _ownFor(w) { const r = ownBook.get(String(w)); return r ? { open: r.open, cred: r.cred, sold: r.sold, used: r.used, openSrc: r.openSrc, ffishOpenSrc: r.ffishOpenSrc || 0, base: r.base, baseSrc: r.baseSrc } : null; }
export function _ownAvailFor(w, kind, item) { return ownAvailable(String(w), kind, item); }
// Step 7 seams: read-only views so the flip sim can print the actual bound and counters.
export function _matFlipStateForTest() { return { clamps: _matSaveClamps, observedOnly: _matSaveObserved, skipped: _matSaveSkipped, baselines: _matBaselines, flagged: _matFlags.size }; }
export function _matSaveBoundForTest(w, m) { const r = ownBook.get(String(w)); return r ? matSaveBound(r, m) : UNWITNESSED_ALLOWANCE; }

async function saveWorldNodes(strict = false) {
  if (!_nodesDirty) return;
  _nodesDirty = false;
  try {
    await store.kvSet("world_nodes", serializeWorldNodes());
  } catch (e) { _nodesDirty = true; if (strict) throw e; }   // a failed write must not silently drop the world
}
setInterval(saveWorldNodes, NODE_SAVE_MS).unref?.();

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
// THE ISLAND'S GATHERABLE EXTENT (Gather.gd CX/CZ). A plausibility bound, not a manifest.
// SIZED FROM THE REAL NODES, NOT FROM THE PLACEMENT RING, because the ring is not the widest thing
// out there. Measured against the shipped client data on 2026-08-01:
//   * stone/crystal/berries/seashell/honey/flower: Gather.gd's ring, rad <= 640
//   * pig/cow: same ring, then wander <= 13 units from home            -> <= 653
//   * the three mines (gold -232,360 · iron -388,340 · crystal_mine -332,224) -> max 669.4 (iron)
//   * TREES (trees_meta.json "instances", 240 of them) are AUTHORED, not ring-placed, and reach
//     927.8 at (178,707). At R=900 four real trees — wood:-192:675, wood:-162:701, wood:178:707,
//     wood:398:618 — answered 400 "no such node", i.e. an honest player chopped for 16 s and had
//     the wood revoked. R=1000 clears the measured maximum by 72 units and still refuses the
//     20000-unit fabrications this gate exists for. Re-measure if trees_meta.json is ever re-baked.
const ISLAND_CX = 2, ISLAND_CZ = -204, ISLAND_NODE_R = 1000;
// WHAT IS STILL MISSING, STATED PLAINLY: there is no NODE MANIFEST. The gates below check that a
// claimed id is well-formed, of a real kind, on the island, within reach of a live presence and not
// faster than a human — but NOT that the node exists. Measured: a wallet standing on empty ground
// had 14/14 fabricated ids accepted, and one spot offers ~613 integer positions inside CLAIM_RADIUS.
// The remaining bound is the pace floor, which caps a fabricator at the same ~33 claims/minute an
// honest gatherer has; what it does not do is make them walk to a real node.
//
// The manifest is the real fix and it CANNOT be baked from source alone, which is why it is not here:
//   * stone/crystal/berries/seashell/honey/flower placement runs Godot's seeded RNG (seed 7711)
//     against the island heightmap, so reproducing it means porting `_surf` AND Godot's PCG stream;
//   * pig and cow are LIVESTOCK — they wander, so their ids change while the world runs and no
//     static set can ever contain them;
//   * only wood (trees_meta.json) and the three mines are exactly derivable today.
// The workable route is to DUMP the id set from a real client build and ship it as data, with the
// livestock kinds left position-checked rather than manifest-checked.
const NODE_MANIFEST = null;       // when this exists: refuse any id it does not contain
// WHAT A NODE DROPS, decided here rather than by the client. Transcribed from Gather.gd's _grant table,
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
// Auth for /world/node/claim. See THE FLIP block: "0" = off (observe-only, the pre-flip default),
// default = GRACE (a claim carrying a valid mktToken is judged and latches the wallet; a tokenless
// claim from the old fleet is forgiven until latch maturity / window close; net_ids stand alone
// forever), "strict"/"2" = hard gate (the old "=1"). See the note at the gate for what leaving the
// tokenless path open costs during grace.
const CLAIM_TOKEN_MODE = gateFlipMode("CHIK_CLAIM_TOKEN");
// CURRENTLY UNREACHABLE, and that is worth knowing rather than deleting. CLAIM_MIN_MS (1800 ms) caps
// one wallet at 60000/1800 = 33.3 claims/minute, below this 40 — measured over a 60 s maximum-rate
// run: 32 claims landed, "too fast" refused 412, burst refused 0. If the pace floor is ever lowered
// for a faster tool tier, THIS becomes the real ceiling; do not assume the floor is still doing the
// work. Left at 40 deliberately: the honest gloves-Lv10 berry ceiling is ~22/min and moving a gate
// to within 8% of real play is how honest players start getting refused.
const CLAIM_BURST = 40;           // per wallet per minute, a generous ceiling on honest play
const claimRate = new Map();      // wallet -> {last, count, windowStart}

// ============ STAGE 3: THE WORLD ADJUDICATES ACTIONS — CHIK_ACTIONS, ON BY DEFAULT ============
// Gathers, casts and strikes are all validated against the SERVER's own answer for where the actor
// is and what the world contains. ON by default since THE FLIP (2026-08-01) — it is safe for every
// client generation by construction (tool-less bodies pass, terrain-absent water bound is
// permissive). CHIK_ACTIONS=0 is the kill switch: NOTHING here runs, actionPos() returns exactly
// the presence-row coordinates every reach check already used, no tool is inspected, no cast is
// held, and every reply is byte-identical to the pre-flip relay —
// old clients keep working forever. What the flag adds, and only adds:
//
//   POSITION. When CHIK_PHYS is also on, reach is measured against the physics state the server
//   itself simulated (physStates) rather than the last relayed claim — the presence row already
//   carries the corrected numbers (worldMoveApply stores physApply's answer), but reading the
//   simulation directly cannot lag the row by a tick. A relay-only client falls back to its row,
//   which is exactly today's rule.
//
//   TOOL SUITABILITY. A claim that NAMES an implement must name the one that node kind swings
//   (Player.gd _GATHER_HELD, transcribed — this names today's behaviour, it does not rebalance it).
//   A claim with no tool field is every shipped client and always passes; berries/honey/flower are
//   bare-hand kinds, so only "" fits them. The refusal returns BEFORE the pace stamp, so a wrong
//   tool never consumes the claim window — graceful, like every refusal on this route.
//   THIS IS A CONSISTENCY CHECK, NOT AN AUTHORISATION, and the difference matters. Because a
//   tool-less body must pass forever, a cheater deletes ONE key and the gate is gone (measured:
//   _rv_actions_attack_sim.mjs A3 — an axe on a rock is 403, the identical claim with no `tool` is
//   200 immediately after). Nor does it bind TIER or OWNERSHIP: NODE_TOOL maps kind -> implement
//   NAME, nothing reads a level and nothing checks the wallet ever crafted one, because gear lives
//   in the client-authored save. It catches an honest client that got its own rules wrong; it
//   catches no attacker. Do not cite it as an anti-cheat control.
//
//   THE CAST. /world/fish/report gains the same two stand-downs a node claim always had: the warp
//   hold (a cast teleported into is held for WARP_HOLD_MS, not consumed — the client's one-die
//   fallback plays its local roll, so the player still lands a fish) and a WIDE water bound: a cast
//   with no water anywhere within FISH_WATER_R of the server's position is not fishing. An honest
//   angler is within FISH_SPOT_RANGE (24, Player.gd) of a school that swims IN water, so the 48-unit
//   bound holds 2x margin over the furthest legitimate stance; with no terrain file the bound asks
//   nothing (fail permissive — world_terrain answers SEA everywhere, i.e. water everywhere).
//
// Alive/unclaimed, cooldown, the one-item drop table, CLAIM_MIN_MS and the warp hold on claims and
// strikes are NOT duplicated here — they are the existing gates above and below, unchanged.
const ACTIONS_ON = String(process.env.CHIK_ACTIONS ?? "") !== "0";   // default ON; "0" is the kill switch
if (ACTIONS_ON && !terrainReady()) loadTerrain();   // the water bound wants the real floor; absent file = permissive
let _actToolRefusals = 0, _actCastHolds = 0, _actCastDry = 0, _actPhysPos = 0;
export function _actionsStatsForTest() {
  return { on: ACTIONS_ON, terrain: terrainReady(), toolRefusals: _actToolRefusals,
           castHolds: _actCastHolds, castDry: _actCastDry, physPos: _actPhysPos };
}
// Which implement each node kind swings — transcribed from Player.gd _GATHER_HELD. An allowlist
// keyed by kind; a kind absent here (berries/honey/flower) is bare-hand and only "" fits it.
const NODE_TOOL = Object.freeze(Object.assign(Object.create(null), {
  wood: "axe", stone: "pickaxe", iron: "pickaxe", gold: "pickaxe",
  crystal: "drill", crystal_mine: "drill", seashell: "shovel", pig: "sword", cow: "sword",
}));
// The server's own answer for where a wallet stands. Flag off: exactly the presence row, exactly
// as every reach check has always read it.
function actionPos(wallet, me) {
  if (ACTIONS_ON && PHYS_ON) {
    const st = physStates.get(wallet);
    if (st && st.driven) { _actPhysPos++; return { x: st.x, z: st.z }; }
  }
  return { x: (me && me.x) || 0, z: (me && me.z) || 0 };
}
const FISH_WATER_R = 48;      // 2x the furthest an honest angler can stand from a school's water
const FISH_WATER_STEP = 8;    // sample stride; a school's pool is far wider than this
function waterNear(x, z) {
  if (!terrainReady()) return true;   // unknown terrain must never refuse a cast
  for (let dx = -FISH_WATER_R; dx <= FISH_WATER_R; dx += FISH_WATER_STEP)
    for (let dz = -FISH_WATER_R; dz <= FISH_WATER_R; dz += FISH_WATER_STEP)
      if (surfaceHeight(x + dx, z + dz) < SEA) return true;
  return false;
}

app.post("/world/node/claim", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  let id = nodeId(b.id);
  if (!id) return res.status(400).json({ error: "id required" });
  const now = Date.now();
  nodeSweep(now);

  // 1. you have to actually be in the world
  const me = worldPlayers.get(b.wallet);
  if (!me || now - me.ts > WORLD_TTL_MS) {
    return res.status(403).json({ ok: false, error: "no live presence" });
  }
  // ...and you have to have GOT there. A presence row stamped by an impossible jump cannot turn into
  // material for WARP_HOLD_MS (see /world/move). Honest travel points and the drowning rescue also
  // land here, which costs a real player three seconds and nothing else.
  if (me.warp && now - me.warp < WARP_HOLD_MS) {
    return res.status(403).json({ ok: false, error: "catch your breath", retryInMs: WARP_HOLD_MS - (now - me.warp) });
  }

  // 2. the node has to be within reach of where you said you were. Ids are "kind:x:z", which is
  //    what lets us check this without trusting any position the caller sends.
  const parts = id.split(":");
  const kind = String(parts[0] || "");
  const nx = Number(parts[1]), nz = Number(parts[2]);
  if (!Number.isFinite(nx) || !Number.isFinite(nz)) {
    return res.status(400).json({ ok: false, error: "malformed id" });
  }
  // 2a. A KIND THAT DROPS NOTHING IS NOT A NODE. nodeDrop() is an allowlist and answers [] for
  //     anything unknown, but the id was still keyed into worldNodes and still reached recordGather.
  //     Refusing here keeps the shared node map free of kinds the world does not contain, and it is
  //     the first half of the "the id is not the evidence" problem (the second half is a real node
  //     manifest — see the note below).
  if (!Object.hasOwn(NODE_DROP, kind)) {
    return res.status(400).json({ ok: false, error: "no such node kind" });
  }
  // 2b. AND IT HAS TO BE ON THE ISLAND. Everything gatherable is placed inside a 240..640 ring
  //     around (CX,CZ)=(2,-204) (Gather.gd's placement plan), the three mines sit on the mountain
  //     inside it, and livestock wander only a few units from where they spawned. 900 is a wide
  //     margin over all of that; /world/move alone clamps a position to +/-100000, so without this a
  //     claim could be made at any coordinate in the world and stored forever in the node map.
  if (Math.hypot(nx - ISLAND_CX, nz - ISLAND_CZ) > ISLAND_NODE_R) {
    return res.status(400).json({ ok: false, error: "no such node" });
  }
  // 2c. CANONICALISE BEFORE THE ID IS USED AS A KEY. nodeId() sanitises CHARACTERS but never the
  //     numeric form, and the reach check parses with Number() — so "stone:120:-260",
  //     "stone:0120:-260", "stone:00000120:-260" and "stone:1.2e2:-260" all passed the position gate
  //     and each got its OWN worldNodes key and its own cooldown. One physical rock produced 17
  //     independent drops from 24 spellings of its id, and a cheater re-mined a rock other players
  //     still saw standing. The honest client always sends the canonical form
  //     (Gather.gd node_id: "%s:%d:%d" with int(round(...))), so rebuilding the key from the numbers
  //     the reach check already parsed changes nothing for it — and it is what makes a future node
  //     manifest lookup sound, because a manifest consulted with a non-canonical key is no manifest.
  id = `${kind}:${Math.round(nx)}:${Math.round(nz)}`;
  // Reach is measured against the SERVER's answer for where this wallet stands: with CHIK_ACTIONS
  // and CHIK_PHYS both on that is the simulated physics state; otherwise it is the presence row,
  // exactly the values this line always read (actionPos is a pass-through with the flag off).
  const _ap = actionPos(b.wallet, me);
  const dist = Math.hypot(nx - _ap.x, nz - _ap.z);
  const claimRadius = Object.hasOwn(CLAIM_RADIUS_KIND, kind) ? CLAIM_RADIUS_KIND[kind] : CLAIM_RADIUS;
  if (dist > claimRadius) {
    return res.status(403).json({ ok: false, error: "out of reach", dist: Math.round(dist) });
  }
  // 2d. STAGE 3 (CHIK_ACTIONS): a claim that NAMES an implement must name the right one. No tool
  //     field (every shipped client) always passes; the refusal sits BEFORE the pace stamp below,
  //     so a wrong tool never consumes the player's claim window.
  if (ACTIONS_ON) {
    const _tool = String(b.tool ?? "").slice(0, 16);
    const _needs = Object.hasOwn(NODE_TOOL, kind) ? NODE_TOOL[kind] : "";
    if (_tool && _tool !== _needs) {
      _actToolRefusals++;
      return res.status(403).json({ ok: false, error: "wrong tool", tool: _tool, needs: _needs || "bare hands" });
    }
  }

  // 3. no claiming faster than a human can gather
  // WHO IS ACTUALLY CLAIMING? The handler accepts any presence id, but a WALLET is public — it is
  // published in /world/roster, world chat and on the market board — so a bare wallet here proves
  // nothing, and anyone can burn a victim's nodes and their claim budget in their name. A net_id is
  // different: it never leaves its owner's save, so it stands alone (same rule as presenceOk).
  //
  // GRACED ENFORCEMENT since THE FLIP (2026-08-01). A proven claim (net_id, or pubkey + valid
  // mktToken) always passes and latches the wallet as credential-capable; a tokenless pubkey claim
  // is forgiven — counted, never silently — until either the wallet's latch matures (a proven
  // client was seen CRED_LATCH_MATURE_MS ago, so its cached siblings have turned over) or the
  // global CHIK_CLAIM_GRACE_H window closes. This is what lets the flag ship ON while the deployed
  // fleet (whose claim body is {wallet, id, cd}, no token) is still alive in browser caches.
  //
  // MEASURED COST OF THE GRACE PATH while it lives (unchanged from the observe-only era): an
  // attacker POSTs {wallet:<victim>, id:"stone:900:-500"} with no token, gets 200, and the victim's
  // own next claim is refused 429 — 12 s of contention gave the attacker 6 claims and the victim 0.
  // The attacker GAINS nothing (recordGather credits b.wallet, i.e. the victim), so this is pure
  // denial-of-gathering — and once the victim's own latch matures, the masquerade is refused.
  // `nodeClaims` in /assets/summary is still the gauge: unproven-at-noise is when the window can
  // be shortened (CHIK_CLAIM_GRACE_H) or the gate set "strict".
  const claimProven = presenceOk(String(b.wallet), b);
  if (!claimProven) _unprovenClaims++;
  else { _provenClaims++; credLatchNote("claim", String(b.wallet)); }
  if (CLAIM_TOKEN_MODE !== "off" && !claimProven) {
    if (CLAIM_TOKEN_MODE === "strict" || !graceAllows("claim", String(b.wallet), now, CLAIM_GRACE_MS)) {
      return res.status(403).json({ ok: false, error: "prove this wallet first" });
    }
    _graceClaims++;
  }

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
// stays client-authoritative until the whole material count is enforced — that flip now EXISTS: see
// STEP 7 / matSaveEnforce, staged behind the mmo.v floor and CHIK_MAT_ENFORCE, gathering its own live
// data through matSaveFlip.observedOnly). This only lets the server learn the plausible ceiling of
// fish a wallet has caught, so `caught >= held + sold` becomes a real invariant for fish. recordGather
// already counts pubkey wallets only, so an unsigned net_id catch is harmlessly ignored (they cannot
// sell on the market either). A live world presence is required (same gate as a node claim), and the
// COUNT is rate-capped to a human catch pace so a spammed report cannot inflate the ceiling it exists
// to bound — the cap under-counts nothing an honest angler could actually do (the reel minigame is
// slower than this), it only refuses a tight machine-gun loop.
const FISH_REC_MIN_MS = 800;         // cap the COUNTED rate to human scale; honest play never beats it
// per wallet per UTC day, scaled by any live festival multiplier — see the note at the roll
const FFISH_DAILY_MAX = Math.max(1, Number(process.env.FFISH_DAILY_MAX || 60));
const _ffishDay = new Map();         // wallet -> { day, n }
let _ffishCapped = 0;                // observability: legends dropped by the daily ceiling
export function _ffishDayStatsForTest(w) { return { capped: _ffishCapped, outlevelled: _ffishOutlevelled, row: _ffishDay.get(String(w)) || null }; }
// sim seam: seed a wallet's day counter so the ceiling can be exercised without a real day of casts
export function _setFfishDayForTest(w, n) { _ffishDay.set(String(w), { day: Math.floor(Date.now() / 86400000), n: Math.max(0, n | 0) }); return n; }
// ============ THE SERVER ROLLS THE CATCH — fantasy fish become witnessed, like eggs ============
// Fantasy fish are the PRIMARY ingredient of every egg (Econ.EGG_RECIPE), and an egg hatches into a
// tradeable chikimon. So a fantasy fish is the most valuable thing in the game that the server had
// never seen: /world/fish/report records a generic "fish" and discards the species, which meant the
// client both DECIDED what it caught and OWNED the record of it. Claiming a Rainbow Fish (1-in-5000
// at a calm spot) was a free assertion.
//
// This is the same move that fixed eggs in Step 4: THE SERVER ROLLS. A cast reports where and with
// what; the server performs the roll with the mirrored odds, and only the server's answer is credited.
// A modified client can no longer name its own catch — it has to win a rate-limited lottery.
//
// WHAT THE SERVER STILL CANNOT VERIFY, stated plainly: the spot TIER and the ROD level are both
// client-asserted. Gear lives in the client-authored save and the 44 school positions are generated
// client-side, so neither is checkable today. Both are clamped, which bounds the lie rather than
// removing it: maximal lying (tier 3, rod 10) is a 4x odds multiplier and unlocks every species, so a
// bot's best case is 1-in-1250 for a Rainbow at FISH_REC_MIN_MS 800 — about 17 minutes of continuous
// requests per meme egg, against instantaneous before. Honest players are unaffected either way.
// Closing it fully needs the spot table and gear server-side; this is the increment that makes the
// species real.
// ENFORCEMENT IS OFF UNTIL THE CLIENT ADOPTS THE SERVER'S ROLL, and this is not caution for its own
// sake — shipping it early would break honest players. Player.gd _roll_catch still rolls locally,
// so the client and the server now roll INDEPENDENTLY: a player sees "you caught a Golden Chikifish",
// their save holds it, and the server never witnessed it. Enforcing the sale bind or Mithra's fish
// price in that state refuses goods the player watched themselves catch — the exact class of harm the
// gold-wipe and the v8 egg wipe caused.
// So: the server ROLLS and CREDITS from today (data accrues, and the credit is real entitlement), and
// the refusals turn on with the client release that renders the server's `legend` instead of its own.
// ON BY DEFAULT since THE FLIP (2026-08-01); FFISH_AUTHORITY=0 is the kill switch. The old-fleet
// harm this paragraph warns about is closed by OWN_FFISH_EPOCH_MS below: every fish a save recorded
// before the flip epoch is grandfathered as a one-time opening balance, so the binding book only
// ever refuses what it never witnessed AND was never declared before the book existed.
const FFISH_AUTHORITY = String(process.env.FFISH_AUTHORITY || "") !== "0";
let _ffishAuth = FFISH_AUTHORITY;   // test-overridable mirror; every gate below reads this
const FFISH_ORDER = Object.freeze(["rainbow_fish", "mystic_eel", "crystal_koi", "golden_chikifish"]);
const FFISH_SET = new Set(FFISH_ORDER);
const FFISH_CATCH_BASE = Object.freeze(Object.assign(Object.create(null), {   // mirrors Econ.gd FFISH_CATCH_BASE
  golden_chikifish: 0.0060, crystal_koi: 0.0020, mystic_eel: 0.0007, rainbow_fish: 0.0002,
}));
const FFISH_ROD_REQ = Object.freeze(Object.assign(Object.create(null), {      // mirrors Econ.gd FFISH_ROD_REQ
  golden_chikifish: 2, crystal_koi: 4, mystic_eel: 6, rainbow_fish: 8,
}));
// THE TRAINER-LEVEL GATE IS THE CLIENT'S, AND THE SERVER HAS TO HONOUR IT OR THE CHRONICLE LIES.
// The ROD decides what can be hooked; the TRAINER LEVEL decides what can be LANDED. Player.gd snaps
// the line the instant a legend above Econ.FFISH_LEVEL is struck (_on_action, "outclassed"): the
// player is told "the Golden Chikifish SNAPPED the line — reach Trainer Lv 5", banks nothing, and
// the fish is gone. The server had already ownCredit'ed the ffish and announced the catch in the
// world feed — so a level-3 angler's chronicle row said they caught a fish they watched get away,
// and the acquisition book FFISH_AUTHORITY will one day enforce held an entitlement their save
// never had. Measured in _rv_fish_attack_sim.mjs case C2 (lvl:1 wallet, feed row golden_chikifish).
//
// `lvl` IS CLIENT-ASSERTED, AND THAT IS FINE HERE BECAUSE THE GATE ONLY EVER SUBTRACTS. A caller who
// inflates it, or omits it, gets exactly the answer they get today — so this adds no attack surface
// and can never refuse anything a liar could not already have. An ABSENT lvl is "no assertion", not
// "level 0": every already-shipped client sends none, so nothing deployed changes shape.
const FFISH_LEVEL = Object.freeze(Object.assign(Object.create(null), {        // mirrors Econ.gd FFISH_LEVEL
  golden_chikifish: 5, crystal_koi: 10, mystic_eel: 15, rainbow_fish: 20,
}));
let _ffishOutlevelled = 0;           // observability: legends the caller's own level could not land
export function _ffishLevelReqForTest(sp) { return Object.hasOwn(FFISH_LEVEL, sp) ? FFISH_LEVEL[sp] : 0; }
const FFISH_ROD_FLOOR = 0.30;
const FISH_TIER_MULT = Object.freeze({ 1: 1.0, 2: 2.2, 3: 4.0 });
function ffishCatchChance(sp, tier, rod) {
  if (!Object.hasOwn(FFISH_ROD_REQ, sp)) return 0;
  const req = FFISH_ROD_REQ[sp];
  if (rod < req) return 0;                       // below the unlock the fish never takes the line
  const span = Math.max(1, 10 - req);
  const t = Math.min(1, Math.max(0, (rod - req) / span));
  const rodFactor = FFISH_ROD_FLOOR + (1 - FFISH_ROD_FLOOR) * t;
  const mult = FISH_TIER_MULT[Math.min(3, Math.max(1, tier))] || 1.0;
  const ev = fishEventActive() ? Math.min(10, Math.max(1, Number(_fishEvent.mult))) : 1;
  return Math.min(FFISH_CATCH_BASE[sp] * mult * rodFactor * ev, EVENT_CAST_CAP);
}
// Rarest first, so a Rainbow is never masked by a Golden — same order as the client had.
function rollFantasyCatch(tier, rod) {
  for (const sp of FFISH_ORDER) if (Math.random() < ffishCatchChance(sp, tier, rod)) return sp;
  return "";
}
// Sim seam: the odds table itself, so the client's Econ.ffish_catch_chance can be DIFFED against the
// exact function the authoritative roll uses (fish_onedie_sim.js) instead of trusted to mirror it.
export function _ffishChanceForTest(sp, tier, rod) { return ffishCatchChance(sp, tier, rod); }

// ============ LIVE EVENT: the fishing festival (admin-scheduled, e.g. 24h of 4x legends) ============
// One multiplier, applied inside ffishCatchChance — the SAME chokepoint the client mirrors — so the
// authoritative roll and every displayed odd agree to the digit. Persisted in the kv store: a mid-
// festival restart must not end the party. EVENT_CAST_CAP mirrors Econ.gd: whatever the multiplier,
// no single cast may beat 1-in-4 for any legend.
const EVENT_CAST_CAP = 0.25;
let _fishEvent = { mult: 1, ends: 0, label: "" };
function fishEventActive(now = Date.now()) {
  return _fishEvent.mult > 1 && now < Number(_fishEvent.ends);
}
async function saveFishEvent() { try { await store.kvSet("fish_event", _fishEvent); } catch (e) {} }

// ============ THE WORLD FEED: server-witnessed rare moments, shown under every minimap ============
// Only events THIS server rolled may enter (fantasy catches, server-rolled legendary/meme hatches),
// so every headline is a fact — a restart cannot forge one. The chronicle is now a RETAINED,
// PERSISTED history (the world_chat pattern: kv restore at boot, throttled kv save on push), so a
// deploy or an idle spin-down no longer erases it. The move reply is unchanged: it ships only rows
// newer than the client's fs cursor, capped to the same 8-row window the shipped client has always
// received. The full backlog rides GET /world/feed only.
//
// Retention arithmetic (measured by feed_retention_sim: 505 B for 8 {k,h,d,t} rows = 63.1 B/row;
// the id key adds ~10 B): 400 rows x ~73 B ≈ 29 KB as a ONE-SHOT backlog fetch / kv value, well
// under the 1000-row world_chat kv row, and ~tens of KB resident. Feed events are rare (legendary/
// meme/mount hatches, fantasy catches), so 400 entries is weeks of history, not hours.
// ============ WHY THE CHRONICLE IS AUTHORISED, RATE-LIMITED AND FAIRLY TRIMMED ============
// MEASURED ATTACK (chron_attack_sim.mjs, real server in-process): with the retention raise and no
// author gate, 900 fabricated `godot-…` presence ids — no wallet, no signature, no token, nothing
// bought — POSTed /world/move and then /world/fish/report at the 800 ms floor and **erased the
// island's entire history in 12.3 s** (11,700 requests): 12 genuine moments -> 0, 400/400 rows the
// attacker's, and the save/restore round-trip then handed the FLOOD back after a restart. Before the
// raise the same flood cost 8 rows of a rolling ticker; retention is exactly what turned a cosmetic
// nuisance into the permanent destruction of the feature. Three bounds, in order of force:
//
//  1. AUTHOR MUST BE A PROVEN WALLET. presenceOk lets a private net_id stand alone (presence is not
//     identity, and that is right for an avatar) — but a durable, shared, PERSISTED world record is
//     value, and value settles against a wallet (isPubkey ⇒ presenceOk already demanded the market
//     token). A net_id may fish, hatch and be seen; it may not write the island's permanent record.
//     This alone makes the measured attack cost zero rows.
//  2. NO AUTHOR MAY EVICT ANOTHER. An author at WORLD_FEED_PER_AUTHOR replaces their OWN oldest row
//     instead of appending, so one identity can never push a stranger's moment out of the history.
//     That is the owner's requirement stated as an invariant, and it holds even if 1. is ever bypassed.
//  3. FAIR TRIM. When the ring is genuinely full the row dropped belongs to whoever holds the MOST
//     rows (ties → oldest), so the quietest author is never the one who loses their moment.
//
// THERE IS DELIBERATELY NO PER-AUTHOR RATE LIMIT. A 4 s floor was written and then removed: with
// the fair share above, a wallet spamming rows only ever replaces its OWN oldest, so a limit adds
// no protection — while it DOES drop a real moment whenever an angler lands two legends inside the
// window (the fish route's own floor is 800 ms). Refusing to record something that happened is the
// one failure this feature cannot have, so the bound is a SHARE, not a rate.
const WORLD_FEED_MAX = 400;        // retained history — the pop-up backlog
const WORLD_FEED_MOVE_WINDOW = 8;  // the move reply's delta cap — the shipped pill's contract
const WORLD_FEED_PER_AUTHOR = 24;  // ≤6% of the ring — one wallet's fair share of the island's memory
const WORLD_FEED_PUBLIC_PAGE = 60; // anonymous default page — the full 400 needs an explicit ?limit
let worldFeed = [];
let _wfeedSeq = 0;                 // monotonic row id — a cursor that, unlike `t`, never collides within a millisecond
let _feedAnonRefused = 0, _feedSelfReplaced = 0, _feedFairEvicted = 0;
// Anything restored from the store is re-validated on the way IN, exactly as restoreWorldNodes does:
// a persisted blob comes back from a database a future bug (or an operator) could corrupt, and this
// one is served to every client and copied into their local history. Shape, types, string lengths and
// the clock are all re-imposed — a row with a far-future `t` would otherwise advance every client's
// `fs` cursor past every real row and silence the chronicle for the whole fleet.
function sanitizeFeedRows(v) {
  if (!Array.isArray(v)) return [];
  const now = Date.now();
  const out = [];
  for (const r of v.slice(-WORLD_FEED_MAX)) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const t = Number(r.t);
    if (!Number.isFinite(t) || t <= 0 || t > now + 60000) continue;   // no future stamps, ever
    const k = stripTags(String(r.k == null ? "" : r.k)).slice(0, 12);
    const h = stripTags(String(r.h == null ? "" : r.h)).slice(0, 20);
    const d = stripTags(String(r.d == null ? "" : r.d)).slice(0, 32);
    if (!k) continue;
    const id = Math.floor(Number(r.id));
    out.push({ id: Number.isFinite(id) && id > 0 ? id : 0, k, h, d, t: Math.floor(t),
               w: typeof r.w === "string" ? r.w.slice(0, 44) : undefined });
  }
  return out;
}
export function _sanitizeFeedRowsForTest(v) { return sanitizeFeedRows(v); }
async function restoreWorldFeed() {
  try {
    const v = await store.kvGet("world_feed");
    if (Array.isArray(v) && !worldFeed.length) {
      worldFeed.push(...sanitizeFeedRows(v));
      let seq = 0;
      for (const r of worldFeed) seq = Math.max(seq, Number(r.id) || 0);
      for (const r of worldFeed) if (!r.id) r.id = ++seq;   // a blob that lost its ids still gets a cursor
      _wfeedSeq = seq;
    }
  } catch (e) {}
}
restoreWorldFeed();
let _feedSavedAt = 0, _feedSaveTimer = null;
function saveWorldFeedNow(strict = false) {
  _feedSavedAt = Date.now();
  return store.kvSet("world_feed", worldFeed.slice(-WORLD_FEED_MAX)).catch(e => { if (strict) throw e; });
}
function saveWorldFeed() {
  const now = Date.now();
  if (now - _feedSavedAt < 5000) {   // batch bursts like world_chat does…
    if (!_feedSaveTimer) {           // …but with a trailing write, so a burst's TAIL is never the row a restart forgets
      _feedSaveTimer = setTimeout(() => { _feedSaveTimer = null; saveWorldFeedNow(); }, 5000);
      if (_feedSaveTimer.unref) _feedSaveTimer.unref();
    }
    return;
  }
  saveWorldFeedNow();
}
// The public projection of a row. `w` (the author wallet) is the key the fairness bounds are keyed
// on and it NEVER goes on the wire — the roster publishes wallets for players who are in the world
// right now, a permanent log that names who caught what is a different and worse thing.
const feedWire = (r) => ({ id: r.id, k: r.k, h: r.h, d: r.d, t: r.t });
// Full ⇒ drop one row, choosing the author who currently holds the MOST. The quietest author is
// never the one who loses a moment; a loud one pays for their own volume first.
function feedTrimFair() {
  while (worldFeed.length > WORLD_FEED_MAX) {
    const counts = new Map();
    for (const r of worldFeed) counts.set(r.w, (counts.get(r.w) || 0) + 1);
    let worst = null, worstN = 0;
    for (const [w, n] of counts) if (n > worstN) { worstN = n; worst = w; }
    const i = worstN > 1 ? worldFeed.findIndex((r) => r.w === worst) : 0;   // that author's OLDEST
    worldFeed.splice(i < 0 ? 0 : i, 1);
    _feedFairEvicted++;
  }
}
function worldFeedPush(k, wallet, d) {
  const w = String(wallet);
  // 1. a proven wallet, or nothing. See the note at WORLD_FEED_MAX for the measured attack.
  if (!isPubkey(w)) { _feedAnonRefused++; return false; }
  const now = Date.now();
  const me = worldPlayers.get(w);
  const h = stripTags(String((me && me.handle) || "A trainer")).slice(0, 20);
  const row = { id: ++_wfeedSeq, k, h, d: String(d).slice(0, 32), t: now, w };
  // 2. at their fair share an author replaces their OWN oldest row — never a stranger's
  let mine = 0;
  for (const r of worldFeed) if (r.w === w) mine++;
  if (mine >= WORLD_FEED_PER_AUTHOR) {
    const i = worldFeed.findIndex((r) => r.w === w);
    worldFeed.splice(i, 1);
    _feedSelfReplaced++;
  }
  worldFeed.push(row);
  feedTrimFair();
  saveWorldFeed();
  return true;
}
function worldFeedSince(fs) {
  if (!worldFeed.length) return undefined;
  const cut = Number(fs) || 0;
  // The shipped incremental wire is UNCHANGED by the retention raise: same {k,h,d,t} row shape
  // (no id key), and at most the newest 8 — exactly what a fresh fs=0 client received when the
  // whole ring WAS 8. History belongs to GET /world/feed, never to the per-tick move reply.
  const rows = worldFeed.filter((r) => r.t > cut).slice(-WORLD_FEED_MOVE_WINDOW);
  return rows.length ? rows.map((r) => ({ k: r.k, h: r.h, d: r.d, t: r.t })) : undefined;
}
// Observability for the three chronicle bounds — refusals are invisible by design (the caller still
// gets their fish and their creature), so the only way to know they are firing is to count them.
export function _feedGuardStatsForTest() {
  return { anonRefused: _feedAnonRefused,
           selfReplaced: _feedSelfReplaced, fairEvicted: _feedFairEvicted,
           authors: new Set(worldFeed.map((r) => r.w)).size, rows: worldFeed.length };
}
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
  // STAGE 3 (CHIK_ACTIONS): the cast is adjudicated like a claim. Both refusals return BEFORE the
  // _lastFishRec stamp, so a refused cast is never consumed — the one-die client's verdict comes
  // back know=false and it plays its local roll, so the player still lands their fish.
  if (ACTIONS_ON) {
    // a cast teleported into is held exactly as a gather is (see /world/move's warp stamp)
    if (me.warp && now - me.warp < WARP_HOLD_MS) {
      _actCastHolds++;
      return res.status(403).json({ ok: false, error: "catch your breath", retryInMs: WARP_HOLD_MS - (now - me.warp) });
    }
    // ...and a cast with no water anywhere near the server's own position is not fishing. WIDE
    // bound (FISH_WATER_R, 2x the furthest honest stance) and permissive without terrain.
    const _fp = actionPos(String(b.wallet), me);
    if (!waterNear(_fp.x, _fp.z)) {
      _actCastDry++;
      return res.status(403).json({ ok: false, error: "no water here" });
    }
  }
  // count at most one fish per human-plausible interval — a spammed loop cannot inflate the ceiling
  const last = _lastFishRec.get(String(b.wallet)) || 0;
  if (now - last < FISH_REC_MIN_MS) return res.json({ ok: true, counted: false });
  _lastFishRec.set(String(b.wallet), now);
  if (_lastFishRec.size > 20000) {   // bound the map like every other per-wallet map here
    for (const [k, t] of _lastFishRec) { if (now - t > 120000) _lastFishRec.delete(k); }
  }
  recordGather(String(b.wallet), "fish", ["fish"]);   // pubkey-only inside; net_id catches are ignored
  // NOTE: recordGather already credits the book one "fish" per entry (creditOwn defaults true), so
  // there is deliberately no ownCredit for the ordinary catch here — adding one double-counted it.
  // THE SERVER ROLLS THE LEGEND. tier and rod are client-asserted and only clamped (see the note at
  // FFISH_ORDER) — but the ROLL is ours, so a client can no longer simply declare a Rainbow Fish.
  const _tier = Math.min(3, Math.max(1, Math.floor(Number(b.tier)) || 1));
  const _rod = Math.min(10, Math.max(0, Math.floor(Number(b.rod)) || 0));
  let _legend = rollFantasyCatch(_tier, _rod);
  // A LEGEND THE ANGLER CANNOT LAND IS NOT A CATCH. See FFISH_LEVEL: the client snaps the line on
  // exactly this condition, so crediting and chronicling it made the world feed announce a fish the
  // player was shown getting away. Placed BEFORE the daily ceiling so a snapped line never spends a
  // cap slot either. Only a NUMBER is an assertion — an absent/garbage lvl leaves today's behaviour.
  const _lvl = Math.floor(Number(b.lvl));
  if (_legend && Number.isFinite(_lvl) && _lvl >= 1 && _lvl < FFISH_LEVEL[_legend]) {
    _legend = ""; _ffishOutlevelled++;
  }
  // A DAY'S FISHING IS A DAY'S FISHING. tier and rod are asserted by the caller and only clamped, so
  // a keypair that has never played can post {tier:3, rod:10} at the 800 ms floor and win the lottery
  // 4,500 times an hour — measured 157.84 legends per 4,500 reports, i.e. ~3,780 witnessed fantasy
  // fish a day on a wallet with no gear and no game client. That is the exact credit FFISH_AUTHORITY
  // is supposed to make trustworthy, so the flip would arm a poisoned book.
  //
  // A CEILING, NOT A REFUSAL, and pitched far above real play: a hard session is a few hundred casts,
  // and at the very best odds that is on the order of ten legends. The base is 60, and it SCALES WITH
  // THE FESTIVAL MULTIPLIER because that multiplier is exactly what makes an honest angler's day
  // unusual. Over the cap the cast still counts as an ordinary fish — only the legend is dropped.
  if (_legend) {
    const _day = Math.floor(now / 86400000);
    const _fr = _ffishDay.get(String(b.wallet));
    const _row = (_fr && _fr.day === _day) ? _fr : { day: _day, n: 0 };
    const _cap = FFISH_DAILY_MAX * Math.max(1, Math.floor(fishEventActive() ? _fishEvent.mult : 1));
    if (_row.n >= _cap) { _legend = ""; _ffishCapped++; }
    else { _row.n++; _ffishDay.set(String(b.wallet), _row); }
    if (_ffishDay.size > 20000) { for (const [k, v] of _ffishDay) { if (v.day !== _day) _ffishDay.delete(k); } }
  }
  if (_legend) ownCredit(String(b.wallet), "ffish", _legend, 1);
  if (_legend) worldFeedPush("ffish", b.wallet, _legend);   // a witnessed catch: the world hears about it
  // The client renders what the SERVER says was caught. An older client ignores `legend` and keeps
  // rolling its own for display only — it just gains no sellable entitlement from it, which is the
  // point. `counted` keeps its old meaning so nothing existing changes shape.
  res.json({ ok: true, counted: true, legend: _legend || null, tier: _tier, rod: _rod });
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
  // The ceiling (6) is for the observe-only tally ONLY. The book gets ONE essence per counted kill:
  // at KILL_REC_MIN_MS 500 the ceiling would have been 43,200 essence/hour of sellable credit on a
  // wallet that never fought anything, because this route verifies no combat whatsoever.
  recordGather(String(b.wallet), "essence", new Array(ESSENCE_PER_KILL).fill("essence"), false);
  // THIS ROUTE NO LONGER CREDITS ANYTHING. It used to credit 1 essence per counted report whenever
  // the server had NOT witnessed a kill — i.e. precisely when it had no evidence — which measured
  // 7,194 units/hour of real, market-sellable acquisition entitlement on a wallet that did nothing
  // but /verify and one /world/move (12 counted reports in 6.0 s, book 1500 -> 1512). Essence gates
  // every craft recipe and is one of the 14 listable MAT_IDS, so that was laundering capacity at
  // zero cost, sybil-multiplied per keypair.
  //
  // The shared mob pool exists now and /world/mob/hit credits on the server's OWN observation of a
  // health pool it owns reaching zero, so there is a witnessed path for every one of the 24 world
  // monsters. The shipped client already fires both (Net.gd posts /world/mob/hit {finish:true} and
  // Profile.on_kill calls report_kill), and the dedupe below already stood this credit down whenever
  // the server saw the kill — so honest players lose nothing: the credit they were getting from here
  // was, by construction, only the credit the server could not see.
  //
  // The telemetry tally above is unchanged (creditOwn=false), so the observe-only oversold signal
  // still reads exactly what it read before.
  const _wk = lastWitnessedKill.get(String(b.wallet)) || 0;
  const _witnessed = Date.now() - _wk <= KILL_DEDUPE_MS;
  res.json({ ok: true, counted: true, credited: false, witnessed: _witnessed });
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
// The dark arena, mirrored from RaidBoss.gd BOSS_X/BOSS_Z; ENGAGE_R there is 78, so 110 is a wide
// margin around the whole platform. RAID_PRIZE_* mirror _pay_raid (RaidBoss.gd).
const RAID_BOSS_X = 359, RAID_BOSS_Z = 259, RAID_CLAIM_R = 110;
const RAID_PRIZE_CHIKI = 500, RAID_PRIZE_CRYSTAL = 25;
const RAID_CLAIM_MAX = 20000;
// EVICT ONLY SPENT WEEKS. Dropping the oldest rows blindly handed the evicted wallet its prize again
// in the SAME week — the eviction itself became the re-claim. A row for a PAST week protects nothing
// (the gate only ever compares against the current week), so those are free to drop; a current-week
// row IS the record and is never evicted. If every row is current the map simply stops shrinking —
// the safe direction, and the same doctrine the asset ledger's flagged-record eviction follows.
function evictRaidClaims() {
  if (raidClaim.size <= RAID_CLAIM_MAX) return 0;
  const week = RAID_WEEK();
  let drop = Math.max(1, Math.floor(RAID_CLAIM_MAX * 0.05)), n = 0;
  for (const [k, wk] of raidClaim) {
    if (drop <= 0) break;
    if (wk !== week) { raidClaim.delete(k); drop--; n++; }
  }
  return n;
}
export function _clearRaidClaims() { raidClaim.clear(); }
export function _raidClaimSize() { return raidClaim.size; }
export function _evictRaidClaims() { return evictRaidClaims(); }
app.post("/world/raid/claim", (req, res) => {
  const b = req.body || {};
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(String(b.wallet), b)) return res.status(403).json({ ok: false, error: "prove this wallet first" });
  const now = Date.now();
  const me = worldPlayers.get(String(b.wallet));
  if (!me || now - me.ts > WORLD_TTL_MS) return res.status(403).json({ ok: false, error: "no live presence" });
  // A net_id has no server-side record to gate against, so answering "granted" would hand every
  // unlinked client an unlimited weekly prize — worse than the client gate it replaced. Say so
  // explicitly instead: the client keeps using its own local weekly gate for these players.
  if (!isPubkey(String(b.wallet))) return res.json({ ok: true, granted: false, unmanaged: true });
  const week = RAID_WEEK();
  const w = String(b.wallet);
  if (raidClaim.get(w) === week) return res.json({ ok: true, granted: false, week });
  // WERE YOU EVEN AT THE ARENA? The gate was a permission slip with no evidence behind it: nothing
  // checked MALGROTH's HP, the player's position, or that a raid happened at all. Presence at the
  // arena is the one thing the server can check, and now that /world/move stamps implausible jumps
  // it means something — you cannot teleport in, claim, and teleport out. RAID_CLAIM_R is generous
  // (the client shows the boss HUD at 78 units) so a player fighting from the edge still claims.
  const _dR = Math.hypot((me.x || 0) - RAID_BOSS_X, (me.z || 0) - RAID_BOSS_Z);
  if (_dR > RAID_CLAIM_R || (me.warp && now - me.warp < WARP_HOLD_MS)) {
    return res.json({ ok: true, granted: false, week, tooFar: Math.round(_dR) });
  }
  // CLAIM BEFORE ANSWERING — the same rule the egg restitution and meme-egg guards follow, so two
  // requests racing the same kill cannot both be told "granted"
  raidClaim.set(w, week);
  evictRaidClaims();
  _assetsDirty = true;
  // THE PRIZE IS THE SERVER'S TO PAY, not just to permit. The 25 crystal has always been granted by
  // the client (RaidBoss.gd _pay_raid) and never recorded here, so a legitimately earned raid crystal
  // was spent out of UNWITNESSED_ALLOWANCE — an honest player's own forgiveness budget — instead of
  // raising their bound. Crediting it here is the accounting the payout always deserved, and the
  // amounts are now in the reply so a future client can apply what the SERVER says rather than a
  // local constant.
  ownCredit(w, "mat", "crystal", RAID_PRIZE_CRYSTAL);
  res.json({ ok: true, granted: true, week, prize: { chiki: RAID_PRIZE_CHIKI, mat: "crystal", qty: RAID_PRIZE_CRYSTAL } });
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

// ============ THE ACQUISITION BOUND — you may not sell more than Chikoria saw you get ============
// THE INVARIANT, and it is worth stating in the owner's own words rather than mine:
//   No wallet may sell, in total, more of an item than this server recorded it acquiring.
//
// This is a LIFETIME ACQUISITION BOUND, not provenance. Say it that way. It closes the fabricated-save
// class completely — the mmo blob rides through /profile verbatim (safe.mmo = profile.mmo) and nothing
// clamps mmo.mats, so before this a save could simply assert a hoard and sell it for real $CHIKI. It
// does NOT close botted-but-witnessed acquisition: material a wallet really did claim from real nodes
// is real material, however it was driven. No server-side rule can tell those apart, and pretending
// otherwise would be the security theatre this is meant to replace.
//
// MONOTONE BY DESIGN:  available = open + cred + ALLOWANCE − sold − escrowNow
// `cred` only grows and `sold` only grows. Material SPENDS ARE NEVER DEBITED. That is a deliberate
// over-credit in the player's favour, and it buys something specific: it removes the entire
// "declare a spend, then re-declare the stock" laundering direction, and it makes the flow channel's
// unreliability harmless. A player who crafts away their wood keeps the right to have sold it. The
// bound is on lifetime sales, not on a live inventory the server cannot see.
//
// CREDITS COME ONLY FROM EVENTS THE SERVER ITSELF AUTHORISED:
//   * a node claim  — position-checked against the server's own record of where you are, and the
//     game's hard rule is exactly one item per gather, so a claim IS an exact unit of acquisition
//   * a counted fish report / kill report — ONE unit each. Note kills credit 1, never
//     ESSENCE_PER_KILL (6): that constant is a deliberately over-generous CEILING built for an
//     observe-only signal, and at KILL_REC_MIN_MS 500 it would have been 43,200 essence/hour on a
//     free wallet. An enforcement path must never share a constant with a telemetry ceiling.
//   * a purchase — you bought it here, so you own it here
// Declared /world/mat/flow gains are NOT credited. They are client-authored: presenceOk proves who
// is talking, never that the goods were earned. One batch could assert FLOW_EV_MAX × MAT_IDS ×
// FLOW_QTY_MAX units.
//
// SO WHAT ABOUT REAL UNWITNESSED MATERIAL? It exists and it is SMALL, measured from the real tables:
// all 12 TASKS together grant 9, level milestones about 45 across a whole lifetime, a treasure chest
// 4–8 of one material (Profile.gd's chest grant) or 6 crystal, plus craft refunds bounded by what was spent.
// UNWITNESSED_ALLOWANCE covers all of it with a wide margin instead of refusing an honest player,
// and it is per (wallet, item) so it cannot be pooled into one big sale.
const OWN_KINDS = new Set(FFISH_AUTHORITY ? ["mat", "ffish"] : ["mat"]);   // mutated by _setFfishAuthorityForTest
// ffish is IN because the server now performs the catch roll itself (rollFantasyCatch) — a fantasy
// fish is the primary ingredient of every egg, so it is the last thing that should have been taken on
// the client's word. pot stays excluded: potions are crafted and crafting outputs are client-computed,
// so enforcing them today would refuse honest sellers. That waits on craft rolls moving server-side.
const UNWITNESSED_ALLOWANCE = 1500;         // per wallet per item; ~200 chests' worth, 13x under the qty cap
const OWN_FFISH_OPEN_CAP = 60;              // a pre-epoch angler's legends; a Golden is 1-in-42 at best
const OWN_OPEN_CAP = 6200;                 // the measured legitimate one-material ceiling (bag 1100 + tasks 9 + milestones ~45 + 25/wk raid over 200 weeks)
// A wallet whose FIRST server-written save predates this is a real pre-existing player and gets a
// one-time opening balance from that save. Anyone newer is covered by witnessed credits + allowance.
const OWN_EPOCH_MS = Date.parse("2026-07-31T00:00:00Z");
// THE FFISH FLIP EPOCH — the book binds only what it can know. The witnessed-catch book only became
// the fish's ledger when the server started rolling casts itself; every fantasy fish a client
// recorded BEFORE this epoch predates the book (or arrived from a legacy save) and must NEVER be
// refused for sale or barter. So the ffish opening balance keys off its own, LATER epoch than the
// material cutover: any wallet whose previous server save predates it gets its declared legends as
// a one-time opening (capped OWN_FFISH_OPEN_CAP per species), taken at its first save-accept after
// the flip and grandfathered PERMANENTLY. A wallet born after the epoch has no pre-book fish by
// definition: every catch it will ever make is server-rolled and server-credited (ownCredit runs
// with the flag off too, deliberate accrual). Set a day past the flip deploy so no save the old
// server stamped can miss it. Env-overridable (CHIK_FFISH_EPOCH_MS) for tests and for rollback.
const OWN_FFISH_EPOCH_MS = (() => { const v = Number(process.env.CHIK_FFISH_EPOCH_MS);
  return Number.isFinite(v) && v > 0 ? v : Date.parse("2026-08-02T00:00:00Z"); })();
const ownBook = new Map();                  // wallet -> { open:{key:n}, cred:{key:n}, sold:{key:n}, openSrc:ms }
let _ownReady = false;                      // its own flag — never ride _assetsReady
let _ownDirty = false;                      // set by every credit/sale/opening; flushed with the board
let _ownEnforce = true;                     // test-only switch (see _setOwnEnforceForTest); always on in production
let _ownRefusals = 0, _ownSkipped = 0, _ownSnapshots = 0;
const _ownWorst = new Map();                // wallet -> {short, item, asked, had} (bounded)
const ownKey = (kind, item) => `${kind}:${item}`;
function _ownRow(w) {
  let r = ownBook.get(w);
  if (r) return r;
  if (ownBook.size >= GATHER_WALLETS_MAX) {   // same evict-oldest policy as every per-wallet map here
    let drop = Math.max(1, Math.floor(GATHER_WALLETS_MAX * 0.05));
    for (const k of ownBook.keys()) { if (drop-- <= 0) break; ownBook.delete(k); }
  }
  r = { open: Object.create(null), cred: Object.create(null), sold: Object.create(null), used: Object.create(null), openSrc: 0,
        ffishOpenSrc: 0,                           // the fish flip's own once-marker (see OWN_FFISH_EPOCH_MS)
        base: Object.create(null), baseSrc: 0 };   // Step 7: the save-path grandfather baseline (see matSaveBaseline)
  ownBook.set(w, r);
  return r;
}
// Credit an acquisition the SERVER witnessed. Only ever called from a route that authorised the event.
const ownItemOk = (kind, item) => (kind === "ffish" ? FFISH_SET.has(item) : MAT_IDS.has(item));
function ownCredit(wallet, kind, item, n) {
  const w = String(wallet || "");
  // CREDIT is always allowed for a kind we roll ourselves, even when ENFORCEMENT for it is still off —
  // the book must already hold a player's real catches on the day the flag flips, or the flip refuses
  // everyone. Enforcement reads OWN_KINDS; crediting deliberately does not.
  const creditable = OWN_KINDS.has(kind) || kind === "ffish";
  if (!isPubkey(w) || !creditable || !ownItemOk(kind, item)) return;   // pubkeys only: a net_id is self-chosen
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q) || q <= 0) return;
  const r = _ownRow(w), k = ownKey(kind, item);
  r.cred[k] = Math.min((r.cred[k] || 0) + q, Number.MAX_SAFE_INTEGER);
  _ownDirty = true;
}
// Record a completed SALE against the seller's lifetime total.
function ownSold(wallet, kind, item, n) {
  const w = String(wallet || "");
  if (!isPubkey(w) || !OWN_KINDS.has(kind) || !ownItemOk(kind, item)) return;
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q) || q <= 0) return;
  const r = _ownRow(w), k = ownKey(kind, item);
  r.sold[k] = Math.min((r.sold[k] || 0) + q, Number.MAX_SAFE_INTEGER);
  _ownDirty = true;
}
// Consume material into a sink the SERVER itself authorised (today: Mithra's egg barter). This is not
// the same thing as a client-DECLARED spend, which is still never debited — the client cannot reach
// this, because the server decides that the egg was issued. So the book still only ever moves on
// events this server authorised, in either direction, and the declare-a-spend laundering direction
// stays closed.
function ownDebit(wallet, kind, item, n) {
  const w = String(wallet || "");
  if (!isPubkey(w) || !OWN_KINDS.has(kind) || !ownItemOk(kind, item)) return;
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q) || q <= 0) return;
  const r = _ownRow(w), k = ownKey(kind, item);
  r.used[k] = Math.min((r.used[k] || 0) + q, Number.MAX_SAFE_INTEGER);
  _ownDirty = true;
}
// ESCROW IS NOT STORED. It is derived from the live board every time it is asked for. Every exit path
// a listing has — cancel, TTL prune, the 400-row cap shift, a sale, an order decline or undeliver —
// already removes the row, so escrow releases itself with zero bookkeeping and can never be
// double-released, leaked, or forgotten across a restart. Storing it was the first thing the
// adversarial pass broke.
function ownEscrowed(wallet, kind, item) {
  let n = 0;
  for (const row of marketListings) {
    if (String(row.wallet || "") !== wallet) continue;
    if (String(row.kind || "mat") !== kind || String(row.item || "") !== item) continue;
    n += Math.max(0, Number(row.qty) || 0);
  }
  // A PENDING CRAFT-ORDER DELIVERY IS ESCROW TOO. The filler's goods have left their bag and the
  // poster has 48 hours to pay, so those units are committed exactly as a listing's are. Without
  // this the deliver-side bound was a no-op against repetition: `sold` only moves at PAY time, so
  // 30 consecutive 99-gold deliveries each measured themselves against the same untouched 1500 and
  // all 30 were accepted (measured). Counting them here is what makes the 48h window stop being a
  // bound-evasion race.
  for (const row of marketOrders) {
    if (row.state !== "delivered") continue;
    if (String(row.fillerWallet || "") !== wallet) continue;
    if (String(row.kind || "mat") !== kind || String(row.item || "") !== item) continue;
    n += Math.max(0, Number(row.qty) || 0);
  }
  return n;
}
function ownAvailable(wallet, kind, item, allowOverride) {
  const r = ownBook.get(wallet);
  const k = ownKey(kind, item);
  const open = r ? (r.open[k] || 0) : 0;
  const cred = r ? (r.cred[k] || 0) : 0;
  const sold = r ? (r.sold[k] || 0) : 0;
  const used = r ? (r.used[k] || 0) : 0;
  // NO ALLOWANCE FOR FANTASY FISH. The allowance exists because real material arrives from chests,
  // tasks and milestones the server never sees. A fantasy fish has exactly one source — a cast, which
  // the server now rolls itself — so there is no unwitnessed channel to forgive, and forgiving 1500 of
  // a 1-in-5000 fish would have been the whole exploit wearing a different hat.
  const allow = kind === "ffish" ? 0
    : (Number.isFinite(allowOverride) ? Math.max(0, allowOverride) : UNWITNESSED_ALLOWANCE);
  return (open + cred + allow) - sold - used - ownEscrowed(wallet, kind, item);
}
// THE ALLOWANCE IS NOT SPENDABLE ON ASSET ISSUANCE.
// 1500 per (wallet, item) is right for the MARKET — it forgives chests, tasks and milestones the
// server never witnessed, and the worst case there is a bounded sale. It is wrong for minting,
// because it also paid for eggs and scrolls: measured on a wallet that had done nothing but /verify,
// ownAvailable was 1500 for all six egg materials, i.e. 37 free legendary eggs and 37 free mount
// eggs — the fuel behind the /consume species drain. Issuance therefore reads a much smaller
// forgiveness, and the number is chosen against the recipes rather than by feel: the CHEAPEST egg
// still needs 30 wood, the dearest 50 crystal, and Azulon's scroll 50 wood, so 25 cannot fund any
// single recipe on its own while it still forgives a player whose last few gathers went unwitnessed
// (a backgrounded phone, a cold backend — /world/node/claim answers 403 and the client keeps the
// item). Grandfathering is untouched: this refuses a NEW claim, it never touches anything held.
const ISSUE_UNWITNESSED_ALLOWANCE = 25;
const ownAvailableForIssue = (wallet, kind, item) => ownAvailable(wallet, kind, item, ISSUE_UNWITNESSED_ALLOWANCE);
// ONE-TIME OPENING BALANCE. prev._serverSavedAt is the only clock the server writes itself
// (safe._serverSavedAt = now, unconditional), so a client cannot forge its way into this branch —
// unlike store.firstSeen, which /verify INSERTs for an unsigned address-only POST and which returns 0
// for a wallet that never called /verify, putting a brand-new wallet in the grandfathered branch.
// Capped per item at OWN_OPEN_CAP so a hoard fabricated just before cutover buys a bounded amount,
// and taken ONCE (openSrc set) so a later save can never top it up.
function ownSnapshotOpening(wallet, mmo, prevSavedAt) {
  if (!_ownReady || !isPubkey(String(wallet || ""))) return;
  const prev = Number(prevSavedAt) || 0;
  const wantMats  = prev > 0 && prev < OWN_EPOCH_MS;         // new account: witnessed credits + allowance cover it
  const wantFfish = prev > 0 && prev < OWN_FFISH_EPOCH_MS;   // pre-book angler — see OWN_FFISH_EPOCH_MS
  if (!wantMats && !wantFfish) return;
  const r = _ownRow(String(wallet));
  let took = false;
  if (wantMats && !r.openSrc) {                   // already taken — never again
    r.openSrc = prev;
    took = true;
    const mats = (mmo && typeof mmo.mats === "object" && mmo.mats) || null;
    if (mats) {
      for (const m of Object.keys(mats)) {
        if (!MAT_IDS.has(m)) continue;
        const q = Math.floor(Number(mats[m]));
        if (!Number.isFinite(q) || q <= 0) continue;
        r.open[ownKey("mat", m)] = Math.min(q, OWN_OPEN_CAP);
      }
    }
  }
  // A pre-epoch angler's caught legends are real property and must survive cutover — but capped hard,
  // because these were client-recorded and a fantasy fish buys an egg. OWN_FFISH_OPEN_CAP is far above
  // any plausible real holding (a Golden is 1-in-42 per cast at the very best) and far below a forgery.
  // Its own once-marker (ffishOpenSrc), because the fish epoch is LATER than the material one: a
  // wallet whose material opening was taken at the July cutover still gets its fish grandfathered at
  // THIS flip. max(), never overwrite — an opening already granted can only grow, grandfathering is
  // absolute.
  if (wantFfish && !r.ffishOpenSrc) {
    r.ffishOpenSrc = prev;
    took = true;
    const ff = (mmo && typeof mmo.ffish === "object" && mmo.ffish) || null;   // credited regardless of the flag, see ownCredit
    if (ff) {
      for (const sp of Object.keys(ff)) {
        if (!FFISH_SET.has(sp)) continue;
        const q = Math.floor(Number(ff[sp]));
        if (!Number.isFinite(q) || q <= 0) continue;
        const k = ownKey("ffish", sp);
        r.open[k] = Math.max(r.open[k] || 0, Math.min(q, OWN_FFISH_OPEN_CAP));
      }
    }
  }
  if (took) { _ownSnapshots++; _ownDirty = true; }
}

// ============ STEP 7 OF SERVER AUTHORITY: THE ECONOMY FLIP (save-path material bound) ============
// Until now the bound above only guarded the MARKET exit: a save could still assert any hoard and the
// server stored it verbatim (safe.mmo = profile.mmo). This extends the SAME book — same credits, same
// sinks, same allowance — to the save push itself. Nothing here rewrites the signed blob (the mmo
// save is client-signed; a server edit would trip the client's own tamper check and zero the player's
// currencies, which is exactly the destructive failure the audit passes banned). Instead the /profile
// response carries `matClamps`, corrections the client applies locally and re-signs — the same
// non-destructive direction as every ack in this codebase.
//
// THE INVARIANT, per material m, per pubkey wallet:
//     claimed[m]  <=  base[m] + cred[m] + UNWITNESSED_ALLOWANCE − sold[m] − used[m]     (floored at 0)
// where base[m] is a ONE-TIME grandfather snapshot taken on the wallet's first save-accept after the
// flip, stored as the NET offset  min(claimed_then, OWN_OPEN_CAP) − cred_then + sold_then + used_then,
// so that the formula above — evaluated with LIFETIME counters — measures sources and sinks SINCE the
// snapshot. Without the offset, a pre-flip sale would be double-counted against the player (sold
// already reflected in the smaller snapshot AND subtracted again) and could falsely clamp an honest
// wallet's remaining stock; the offset may therefore legitimately be NEGATIVE.
//
// ESCROW IS DELIBERATELY NOT SUBTRACTED here (unlike ownAvailable): the client removes listed goods
// from the bag at list time, so the bag count already excludes them, and any divergence in that dance
// must only ever LOOSEN the save bound — a false clamp costs a real player real property.
//
// STAGING, stated plainly:
//   * The FIRST save after the flip IS grandfathered — that is the accepted cost — but capped at
//     OWN_OPEN_CAP per material, so a hoard fabricated for cutover buys a bounded amount, and the
//     SECOND inflated push clamps.
//   * VERSION FLOOR: corrections only go to saves whose mmo.v >= MAT_SAVE_MIN_V (export_server stamps
//     v; today's shipped client sends 1). A stale client cannot reconcile corrections it never learned
//     to read, so it keeps observe-only behaviour: exceedance is counted and flagged server-side but
//     nothing is returned. A cheater declaring v=1 forever dodges only the correction — the excess is
//     already unsellable (market bound) and unspendable (egg barter), i.e. inert.
//   * KILL-SWITCH: CHIK_MAT_ENFORCE=0 reverts the whole flip (baselines and clamps) to observe-only.
//     Read per-request so no code change is needed to flip it.
//   * Non-pubkey net_ids: unchanged — /profile already requires a pubkey wallet, and the book ignores
//     anything else.
//   * Fails OPEN while the book restores (_ownReady), counted, same policy as the market gate. The
//     baseline is also NOT taken before restore completes — snapshotting against a half-restored book
//     would burn the one-time grandfather on wrong marks.
const MAT_SAVE_MIN_V = 2;   // mmo.v floor — bump export_server's v only WITH the client that applies matClamps
const matEnforceOn = () => String(process.env.CHIK_MAT_ENFORCE ?? "1") !== "0";
let _matSaveClamps = 0, _matSaveObserved = 0, _matSaveSkipped = 0, _matBaselines = 0;
const _matFlags = new Map();   // wallet -> { short, n, ts, mat, claimed, bound } — worst exceedance kept
function matSaveBaseline(wallet, mmo) {
  if (!matEnforceOn() || !_ownReady) return;
  const w = String(wallet || "");
  if (!isPubkey(w)) return;
  const prior = ownBook.get(w);
  if (prior && prior.baseSrc) return;             // written ONCE — a later save can never rewrite it
  const r = _ownRow(w);
  if (!r.base) r.base = Object.create(null);      // rows restored from a pre-flip blob lack the field
  r.baseSrc = Date.now();
  const mats = (mmo && typeof mmo.mats === "object" && mmo.mats) || {};
  const keys = new Set();
  for (const m of Object.keys(mats)) if (MAT_IDS.has(m)) keys.add(m);
  // ALSO mark every material the book already has activity for: a wallet that sold its whole legacy
  // stock before the flip holds 0 now, and without a mark its pre-flip `sold` would be subtracted
  // from nothing and falsely clamp its first post-flip gathers.
  for (const bucket of ["cred", "sold", "used"]) {
    for (const k of Object.keys(r[bucket])) if (k.startsWith("mat:")) keys.add(k.slice(4));
  }
  for (const m of keys) {
    const k = ownKey("mat", m);
    const q = Math.floor(safeNum(mats[m]));
    const claimed = Number.isFinite(q) && q > 0 ? Math.min(q, OWN_OPEN_CAP) : 0;
    r.base[k] = claimed - (r.cred[k] || 0) + (r.sold[k] || 0) + (r.used[k] || 0);
  }
  _matBaselines++; _ownDirty = true;
}
function matSaveBound(r, m) {
  const k = ownKey("mat", m);
  const base = (r.base && Number.isFinite(r.base[k])) ? r.base[k] : 0;
  return Math.max(0, base + (r.cred[k] || 0) + UNWITNESSED_ALLOWANCE - (r.sold[k] || 0) - (r.used[k] || 0));
}
// Inspect a pushed save against the invariant. Returns null (in bounds / not participating) or a
// { mat: bound } map of corrections. Never throws into the save path — the caller wraps it.
function matSaveEnforce(wallet, mmo) {
  if (!matEnforceOn()) return null;               // kill-switch: observe-only, instantly
  const w = String(wallet || "");
  if (!isPubkey(w)) return null;
  if (!_ownReady) { _matSaveSkipped++; return null; }
  const r = ownBook.get(w);
  if (!r || !r.baseSrc) return null;              // no baseline yet (it is written earlier this same save)
  const mats = (mmo && typeof mmo.mats === "object" && mmo.mats) || null;
  if (!mats) return null;
  const clamps = {};
  let worst = null;
  for (const m of Object.keys(mats)) {
    if (!MAT_IDS.has(m)) continue;
    const q = Math.floor(safeNum(mats[m]));
    if (!Number.isFinite(q) || q <= 0) continue;
    const bound = matSaveBound(r, m);
    if (q > bound) {
      clamps[m] = bound;
      if (!worst || q - bound > worst.claimed - worst.bound) worst = { mat: m, claimed: q, bound };
    }
  }
  if (!worst) return null;
  // FLAG regardless of client version — observability is the point of the observe tier.
  const f = _matFlags.get(w) || { short: w.slice(0, 8), n: 0, ts: 0, mat: "", claimed: 0, bound: 0 };
  f.n++; f.ts = Date.now();
  if (worst.claimed - worst.bound > f.claimed - f.bound) { f.mat = worst.mat; f.claimed = worst.claimed; f.bound = worst.bound; }
  _matFlags.set(w, f);
  if (_matFlags.size > 5000) { let d = 250; for (const k of _matFlags.keys()) { if (d-- <= 0) break; _matFlags.delete(k); } }
  const v = Math.floor(safeNum(mmo.v));
  if (!(Number.isFinite(v) && v >= MAT_SAVE_MIN_V)) { _matSaveObserved++; return null; }   // stale client: observe-only
  _matSaveClamps++;
  return clamps;
}

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
  // ...and a distinct 503 was still distinguishing them. `known:false` was replaced by a status code
  // that says the same thing in a different alphabet: poll this until it stops 503ing and you have
  // found the window where auditAssets is skipped and nothing flushes (see _assetsReady, below).
  // A non-admin caller now gets the SAME shape a wallet with no record gets, so the two are genuinely
  // indistinguishable — which is what the paragraph above always meant. The telemetry maps restore
  // with the ledger, so they are empty in this window anyway; the response is honest, just not
  // diagnostic. An ADMIN still gets the truth, because an operator debugging a cold boot needs it.
  if (!_assetsReady) {
    if (admin) return res.status(503).json({ error: "asset ledger is still loading" });
    return res.json({ wallet: w, units: {}, mounts: {}, unverified: 0, gathered: {}, spent: {}, gained: {} });
  }
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
                           provenPct: (_provenClaims + _unprovenClaims) ? Math.round(100 * _provenClaims / (_provenClaims + _unprovenClaims)) : 0,
                           enforcing: CLAIM_TOKEN_MODE },
             // THE FLIP's gauges. graceAccepts are requests a "strict" gate would have refused but
             // grace forgave — the number that must fall to noise before hardening. latchRefusals
             // are masquerade attempts (or genuinely stale mixed-fleet devices) the latch stopped.
             flip: { claim: CLAIM_TOKEN_MODE, cup: CUP_AUTH_MODE, quest: QUEST_AUTH_MODE,
                     graceAccepts: { claim: _graceClaims, quest: _graceQuests, cup: _graceCups },
                     latched: credLatch.size, latchRefusals: _latchRefusals,
                     claimWindowLeftH: Math.max(0, Math.round((FLIP_EPOCH_MS + CLAIM_GRACE_MS - Date.now()) / 3600000)),
                     authWindowLeftH: Math.max(0, Math.round((FLIP_EPOCH_MS + AUTH_GRACE_MS - Date.now()) / 3600000)) },
             // Refused for an impossible quantity (LIST_QTY_MAX). Unlike oversoldMaterials — which is
             // a soft signal, since materials also arrive from crafting/quests/chests/trades — every
             // row here is a listing the game could not have produced, so it names an actual attempt.
             // The acquisition bound. `skipped` is the one to watch: a nonzero value means listings went
             // through unchecked because the book had not restored, which is safe but not enforcing.
             worldTick: { running: _worldTickOn, mobsTracked: worldMobs.size, hits: _mobHits,
                          kills: _mobKills, hitsRefused: _mobHitsRefused,
                          maxKillsPerHour: Math.round(MOB_SPAWNS.length * 3600000 / MOB_RESPAWN_MS) },
             // THE PRE-FLIGHT GAUGE FOR CHIK_WS_DEFLATE, and the ONLY way to answer the one question
             // the flag cannot be tested for beforehand: does Cloudflare forward the extension ACCEPT
             // back to the browser. `negotiated` counts sockets that actually agreed on
             // permessage-deflate right now — nonzero after the flip means it works end to end, zero
             // with players connected means CF stripped it and the flag is a silent no-op.
             // It was previously readable only through _wsStatsForTest(), which no route serves, so
             // the deploy plan's own check had nowhere to be read. Integers and booleans only.
             wsTransport: { deflate: WS_DEFLATE_ON, deflateMax: WS_DEFLATE_MAX, negotiated: _wsDeflating,
                            dedupe: WS_DEDUPE_ON, dupSkips: _wsDupSkips, dupBytes: _wsDupBytes,
                            sockets: wsClients.size, max: WS_MAX_SOCKETS, refused: _wsRefused,
                            frames: _wsFrames, bytes: _wsBytes, hz: WS_TICK_HZ },
             acquisitionBound: { enforcing: _ownReady, refused: _ownRefusals, skipped: _ownSkipped,
                                 openings: _ownSnapshots, wallets: ownBook.size,
                                 worst: [..._ownWorst.values()].sort((a, b) => (b.asked - b.had) - (a.asked - a.had)).slice(0, 20) },
             // Step 7, the save-path flip. `observedOnly` is the pre-flight gauge: exceedances seen on
             // stale (< MAT_SAVE_MIN_V) clients, flagged but not corrected. Do not bump the client's
             // export version until this stays near zero for honest-shaped wallets on the live fleet.
             matSaveFlip: { on: matEnforceOn(), bookReady: _ownReady, minClientV: MAT_SAVE_MIN_V,
                            baselines: _matBaselines, clamps: _matSaveClamps, observedOnly: _matSaveObserved,
                            skipped: _matSaveSkipped, flagged: _matFlags.size,
                            worst: [..._matFlags.values()].sort((a, b) => (b.claimed - b.bound) - (a.claimed - a.bound)).slice(0, 20) },
             impossibleListings: { refused: _overQtyListings, sellers: _overQtyBy.size,
                                   worst: [..._overQtyBy].sort((a, b) => b[1].worst - a[1].worst).slice(0, 20)
                                     .map(([w, r]) => ({ w: String(w).slice(0, 8), tried: r.worst, item: r.item, kind: r.kind, attempts: r.n })) },
             biggestLevelJumps: jumps.slice(0, 40), oversoldMaterials: oversold.slice(0, 40) });
});

// ---- THE DEX CENSUS: how many of each species actually exist, live ----------------------------
// Per-species counts for the chikidex, mountdex and avatars, plus egg claim/hatch totals. Read-only
// and admin-gated (same gate as /assets/summary) — it names no wallet, only aggregates.
//
// TWO SOURCES, AND THEY MEAN DIFFERENT THINGS. Both are reported rather than blended, because a
// single merged number would hide which half it came from:
//   holders  — from the delta-inference LEDGER: wallets observed holding one in a cloud save. This
//              is the closest thing to "how many players actually have this".
//   minted   — from the server-minted REGISTRY: assets the server itself issued or adopted. Always
//              provable, but only covers what has passed through the registry.
// A species can show holders with 0 minted (a legacy creature never yet adopted) or minted with 0
// holders (issued but the owner has not cloud-saved since).
//
// FRESHNESS CAVEAT, stated in the payload: the ledger only knows what it has SEEN in cloud saves,
// so these numbers start near zero after a database change and fill in as players sign in.
function computeCensus() {
  const mk = (list) => { const m = Object.create(null); for (const id of list) m[id] = { holders: 0, minted: 0, byOrigin: {} }; return m; };
  const chikimon = mk([...SPECIES_NORMAL, ...SPECIES_LEGEND, ...SPECIES_MEME]);
  const mounts   = mk(MOUNT_SUPPLY.map((m) => m[0]));
  const avatars  = mk(AVATAR_IDS);
  const bump = (tbl, sp, field, origin) => {
    if (!sp || !Object.hasOwn(tbl, sp)) return;
    tbl[sp][field]++;
    if (origin) tbl[sp].byOrigin[origin] = (tbl[sp].byOrigin[origin] || 0) + 1;
  };

  // ---- holders, from the ledger ----
  let wallets = 0;
  for (const [, r] of assetLedger) {
    wallets++;
    // one wallet can hold several of a species over time; count DISTINCT species per wallet so
    // "holders" reads as players, not as rows
    const seenSp = new Set();
    for (const uid of Object.keys(r.units)) {
      const u = r.units[uid];
      if (!u || u.held === false) continue;            // sold or gone — not a current holder
      const key = u.sp + "|" + u.origin;
      if (seenSp.has(key)) continue;
      seenSp.add(key);
      bump(chikimon, u.sp, "holders", u.origin);
    }
    for (const sp of Object.keys(r.mounts)) bump(mounts, sp, "holders", (r.mounts[sp] || {}).origin);
    for (const sp of Object.keys(r.avatars || {})) bump(avatars, sp, "holders", null);
  }

  // ---- minted, from the registry, plus the egg ledger ----
  const eggs = { claimed: {}, hatched: {}, nesting: {} };
  for (const row of assetReg.values()) {
    if (!row) continue;
    if (row.type === "chikimon") bump(chikimon, row.sp, "minted", row.origin);
    else if (row.type === "mount") bump(mounts, row.sp, "minted", row.origin);
    else if (row.type === "avatar") bump(avatars, row.sp, "minted", row.origin);
    else if (row.type === "egg") {
      const k = String(row.kind || "normal");
      eggs.claimed[k] = (eggs.claimed[k] || 0) + 1;
      // an egg row is CONSUMED the moment it hatches and keeps pointing at what came out
      if (row.state === "consumed") eggs.hatched[k] = (eggs.hatched[k] || 0) + 1;
      else eggs.nesting[k] = (eggs.nesting[k] || 0) + 1;
    }
  }

  const rank = (tbl) => Object.keys(tbl)
    .map((sp) => ({ sp, ...tbl[sp] }))
    .sort((a, b) => (b.holders - a.holders) || (b.minted - a.minted) || a.sp.localeCompare(b.sp));
  const tot = (tbl) => Object.values(tbl).reduce((n, v) => n + v.holders, 0);

  return {
    generatedAt: Date.now(),
    note: "holders = wallets observed holding one in a cloud save; minted = issued/adopted through the registry. " +
          "The ledger only knows what it has seen, so counts fill in as players sign in.",
    ledgerWallets: wallets, registryRows: assetReg.size,
    chikimon: rank(chikimon), mounts: rank(mounts), avatars: rank(avatars), eggs,
    totals: { chikimonHeld: tot(chikimon), mountsHeld: tot(mounts), avatarsHeld: tot(avatars),
              eggsClaimed: Object.values(eggs.claimed).reduce((a, b) => a + b, 0),
              eggsHatched: Object.values(eggs.hatched).reduce((a, b) => a + b, 0) },
  };
}

app.get("/assets/census", (req, res) => {
  if (!cupAdminOk(req)) return res.status(403).json({ error: "admin only" });
  if (!_assetsReady) return res.status(503).json({ error: "asset ledger is still loading" });
  res.json(computeCensus());
});

// ---- THE PUBLIC DEX BOARD -----------------------------------------------------------------------
// The same census with everything sensitive taken out, so the in-game dex can show "N trainers own
// this" beside each species. Two things are deliberately absent:
//
//   ORIGINS. The admin view breaks each species down by origin, including "unverified". Published,
//   that is a free oracle: a cheater forges a Dragonos, refreshes the dex, and learns from the
//   unverified count whether the ledger caught them. Same reason /assets/audit answers 503 rather
//   than known:false. The public board reports ONE number per species and nothing about provenance.
//
//   PER-WALLET ANYTHING. It was already aggregate; this keeps it that way.
//
// CACHED, because this is the one census endpoint every client may hit. Walking every ledger record
// per request would make a dex screen a self-inflicted load test; the numbers move slowly and a
// minute-stale count is indistinguishable from a live one to a reader.
const DEX_TTL_MS = 60000;
let _dexCache = null, _dexAt = 0;
app.get("/assets/dex", (_req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "the dex is still loading" });
  const now = Date.now();
  if (!_dexCache || now - _dexAt > DEX_TTL_MS) {
    const c = computeCensus();
    const strip = (arr) => arr.map((x) => ({ sp: x.sp, owners: x.holders }));   // no origins, no minted
    _dexCache = {
      generatedAt: c.generatedAt, ttlMs: DEX_TTL_MS,
      chikimon: strip(c.chikimon), mounts: strip(c.mounts), avatars: strip(c.avatars),
      eggsHatched: Object.values(c.eggs.hatched).reduce((a, b) => a + b, 0),
      trainers: c.ledgerWallets,
    };
    _dexAt = now;
  }
  res.set("Cache-Control", "public, max-age=60");
  res.json(_dexCache);
});

// ---- STRIKE A SHARED MONSTER -------------------------------------------------------------------
// The co-op unlock. Two trainers hitting mob 7 are hitting ONE hp pool, it dies ONCE, and both are
// paid. Modelled on /world/node/claim (server.js:3180) because that route already solved the same
// problems: prove presence, derive reach from the id so no caller-sent position is trusted, own the
// cooldown rather than accept one, and rate-limit per wallet.
const mobHitRate = new Map();          // wallet -> last hit ms
app.post("/world/mob/hit", (req, res) => {
  const b = req.body || {};
  if (!_worldTickOn) return res.status(503).json({ ok: false, error: "the shared world is not live yet", tick: false });
  if (!isPresenceId(b.wallet)) return res.status(400).json({ error: "valid wallet required" });
  // COERCE NOTHING INTO A REAL MONSTER. Number() is far too willing here: Number(null), Number(""),
  // Number(false) and Number([]) are all 0 — a REAL spawn — and Number("0x7") is 7. So a request with a
  // missing or junk idx used to answer 200 for a monster it never named (measured: {idx:null} struck
  // spawn 0). Only a real number, or a plain decimal string, may name a monster.
  const rawIdx = typeof b.idx === "number" ? b.idx
    : (typeof b.idx === "string" && /^-?\d+(\.\d+)?$/.test(b.idx.trim())) ? Number(b.idx.trim())
    : NaN;
  const idx = Math.floor(rawIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MOB_SPAWNS.length) return res.status(400).json({ error: "unknown monster" });
  const now = Date.now();

  // 1. PROVE THE WALLET. This route credits sellable essence, and it had no proof gate at all while
  //    /world/kill/report right above it demands one — so an unproven keypair could damage a shared pool
  //    and be paid for it, and, worse, anyone could read a wallet off /world/roster and post hits AS its
  //    owner, exhausting that trainer's swing budget from across the world. Requiring proof closes both:
  //    the limiter below is keyed on b.wallet, which is now necessarily the caller's own.
  //    Residual, stated rather than hidden: presenceOk returns true for any self-chosen net_id, and
  //    net_ids are published on the roster, so a demo player's swing budget is still griefable. They
  //    earn nothing either way (ownCredit takes pubkeys only), so this costs a demo player a fight
  //    rather than value.
  if (!presenceOk(String(b.wallet), b)) {
    _mobHitsRefused++;
    return res.status(403).json({ ok: false, error: "prove this wallet first" });
  }
  // 2. you have to actually be in the world
  const me = worldPlayers.get(b.wallet);
  if (!me || now - me.ts > WORLD_TTL_MS) { _mobHitsRefused++; return res.status(403).json({ ok: false, error: "no live presence" }); }
  // ...and you have to have GOT there. The reach check below is measured against this row, so a row
  // written by a teleport makes it meaningless: one wallet swept all 24 spawns in 10 s and claimed
  // every kill on the island. See the note in /world/move — the move itself is allowed, the reward
  // is not, for WARP_HOLD_MS.
  if (me.warp && now - me.warp < WARP_HOLD_MS) {
    _mobHitsRefused++;
    return res.status(403).json({ ok: false, error: "catch your breath", retryInMs: WARP_HOLD_MS - (now - me.warp) });
  }

  const spec = MOB_SPAWNS[idx];

  // 4. no swinging faster than a person can
  const last = mobHitRate.get(b.wallet) || 0;
  if (now - last < MOB_HIT_MIN_MS) {
    _mobHitsRefused++;
    return res.status(429).json({ ok: false, error: "too fast", retryInMs: MOB_HIT_MIN_MS - (now - last) });
  }
  if (mobHitRate.size > 5000) { for (const [k, v] of mobHitRate) if (now - v > 120000) mobHitRate.delete(k); }

  // STAMP BEFORE ANY EARLY RETURN. This sat below the corpse branch, so hitting a dead monster was
  // never rate-limited at all — measured at 31,034 requests/minute on one wallet. A refused swing still
  // costs you your swing; that is the whole point of a rate limit.
  mobHitRate.set(b.wallet, now);
  worldMobTick(now);
  const m = mobRow(idx);
  if (m.deadAt) {
    // already down — tell them when it is back rather than letting them beat a corpse for credit
    return res.json({ ok: true, dead: true, back: Math.max(0, MOB_RESPAWN_MS - (now - m.deadAt)) | 0, gen: m.gen });
  }
  _mobHits++;

  // 3. REACH. Two independent ways to be in this fight, and the anchor may only ever ADD one.
  //
  //    THE MONSTER. Since MOB_SYNC_IDLE the idle path is a pure function of (ordinal, unix seconds) —
  //    ported above — so evaluate it and require the striker to be near where the monster ACTUALLY IS.
  //    MOB_ANCHOR_MAX survives only as a sanity backstop.
  //
  //    THE ANCHOR. A fight can be dragged off the idle path (an aggro chase, or a card battle that
  //    holds the monster still while the path point orbits on), so the first strike of a life also
  //    records where the fight is happening, from the striker's own presence row — never a position
  //    they sent us — and everyone already standing there keeps their reach.
  //
  //    THE ANCHOR IS PERMISSIVE, NOT RESTRICTIVE, and that is a FIX not a preference. It used to be
  //    the only test once set, which handed anyone a free island-wide denial of service: an opener may
  //    legitimately stand up to MOB_IDLE_GATE (220) from the monster, MOB_ANCHOR_R is 40, and nothing
  //    cleared a live mob's anchor — so one 1-damage request from an UNPROVEN net_id pinned the fight
  //    200 units off the monster and every honest trainer standing ON it was refused "too far from the
  //    fight" forever after. Measured (_skeptic_mobpool_sim): honest finisher 0 units from the mob,
  //    refused at dist=200, still refused after ten minutes of world ticks, mob stuck alive at 169/170
  //    in the shared snapshot. Twenty-four free requests locked the whole island. Anyone who could
  //    legitimately OPEN a fight here can therefore JOIN one here, and the anchor only ever widens that.
  //
  //    The anchor is also CARRIED BY THE MONSTER'S OWN MOTION (stored as an offset from the idle point
  //    at anchor time) and EXPIRES after MOB_ANCHOR_TTL of no accepted strike, so a stale fight releases
  //    rather than pinning a live monster to a spot it walked away from minutes ago.
  // STAGE 3: the striker's position is the SERVER's answer (physics state under CHIK_ACTIONS +
  // CHIK_PHYS, else the presence row — actionPos is a pass-through with the flag off).
  const _sp = actionPos(String(b.wallet), me);
  const px = _sp.x, pz = _sp.z;
  const ip = mobIdlePos(idx, now / 1000);
  const fromIdle = Math.hypot(ip.x - px, ip.z - pz);
  const fromHome = Math.hypot(spec[1] - px, spec[2] - pz);
  const nearMob = fromIdle <= MOB_IDLE_GATE && fromHome <= MOB_ANCHOR_MAX;
  const anchorLive = m.ax !== undefined && (now - (m.aT || 0)) <= MOB_ANCHOR_TTL;
  let fromAnchor = null;
  if (anchorLive) {
    // where the anchor has drifted to, dragged along by the monster's own path since it was set
    fromAnchor = Math.hypot((m.ax + (ip.x - m.aix)) - px, (m.az + (ip.z - m.aiz)) - pz);
  }
  if (!nearMob && !(fromAnchor !== null && fromAnchor <= MOB_ANCHOR_R)) {
    _mobHitsRefused++;
    return res.status(403).json(anchorLive
      ? { ok: false, error: "too far from the fight", dist: Math.round(Math.min(fromIdle, fromAnchor)) }
      : { ok: false, error: "that monster is nowhere near there", dist: Math.round(fromIdle) });
  }
  if (!anchorLive) { m.ax = px; m.az = pz; m.aix = ip.x; m.aiz = ip.z; }   // (re)open the fight here
  m.aT = now;                                                             // a live fight keeps its anchor

  // THE FINISHING BLOW. Chikoria has NO world-space chip damage: HIT_R is only a HUD hint, and a
  // monster is engaged into a private 1v1 card battle and killed outright on a win (Battle.gd:1281 ->
  // kill_mob). So the damage pool below models a mechanic this game does not have, and a client that
  // wins a battle needs to report a KILL, not 120 points of damage against a 400-HP boss it can never
  // whittle down.
  //
  // The server cannot verify a card battle happened — exactly as it cannot verify /world/kill/report.
  // So this is a claim, and the defence is not damage arithmetic, it is SCARCITY: there are 24 spawns
  // and a 90 s respawn, so every player on the island together can claim at most 24 kills per 90
  // seconds, and a second claim on the same life is refused outright. That is a hard island-wide
  // ceiling of ~16 kills/minute shared by everyone, against the 43,200 essence/hour a single wallet
  // could take from /world/kill/report. The proof gate, presence, anchor and dedupe above all still
  // apply, and credit still flows through the acquisition bound.
  if (b.finish === true) {
    m.hp = 0;
    m.deadAt = now;
    m.finisher = String(b.wallet);
    _mobKills++;
    const _fst = MOB_STATS[spec[0]];
    const ess = _fst ? _fst.essence : 1;
    const paid = [];
    // the finisher is always paid; anyone else who contributed to THIS life shares under the same
    // rules the damage path uses, so a future chip mechanic needs no second reward system
    const ranked = [...m.hitters.entries()]
      .filter(([w, d]) => isPubkey(w) && (w === m.finisher || d / Math.max(1, _fst ? _fst.hp : 60) >= MOB_SHARE_MIN))
      .sort((a, b2) => b2[1] - a[1]).slice(0, MOB_PAYEES);
    if (!ranked.some(([w]) => w === m.finisher) && isPubkey(m.finisher)) ranked.unshift([m.finisher, 0]);
    for (const [w] of ranked.slice(0, MOB_PAYEES)) {
      ownCredit(w, "mat", "essence", ess);
      lastWitnessedKill.set(w, now);
      paid.push(w.slice(0, 8));
    }
    m.hitters.clear();
    return res.json({ ok: true, killed: true, hp: 0, maxhp: (_fst ? _fst.hp : 60), gen: m.gen, paid: paid.length,
                      back: MOB_RESPAWN_MS });
  }

  // 5. the damage is CLAMPED. The client still computes it (gear and trainer level live in the
  //    client-authored save, so the server cannot derive it) but it can never exceed a real loadout,
  //    which is what stops a modified client deleting a boss in one request.
  const dmg = Math.max(1, Math.min(MOB_DMG_MAX, Math.floor(Number(b.dmg) || 1)));
  m.hp = Math.max(0, m.hp - dmg);
  const wallet = String(b.wallet);
  m.hitters.set(wallet, (m.hitters.get(wallet) || 0) + dmg);
  // EVICT THE SMALLEST CONTRIBUTOR, NEVER THE OLDEST. A Map iterates in insertion order, so dropping
  // `keys().next().value` dropped whoever opened the fight — measured: a trainer who dealt 360 of a
  // 400-HP monster was evicted by forty identities chipping 59 HP between them, and was paid NOTHING
  // while a 20-damage passer-by was paid in full. The bound has to shed the least invested, which is
  // also exactly the direction that makes the bound useless as an attack.
  if (m.hitters.size > MOB_HITTERS_MAX) {
    let weakest = null, least = Infinity;
    for (const [w, d] of m.hitters) if (d < least) { least = d; weakest = w; }
    if (weakest !== null) m.hitters.delete(weakest);
  }

  let killed = false;
  let paid = [];
  if (m.hp <= 0) {
    killed = true;
    m.deadAt = now;
    _mobKills++;
    // 6. THE REWARD IS THE SERVER'S, ONCE PER LIFE, SPLIT ACROSS EVERYONE WHO REALLY FOUGHT IT. The
    //    client never names it. Everyone who landed a hit on THIS generation gets the mob's own
    //    essence value — co-op pays both trainers rather than racing them for a last hit.
    const st = MOB_STATS[spec[0]];
    const ess = st ? st.essence : 1;
    // A CONTRIBUTOR HAS TO HAVE ACTUALLY FOUGHT IT. Paying every hitter in full was a 40x sybil
    // multiplier hiding in plain sight: hitters is capped at 40, so forty throwaway wallets each
    // landing ONE point of damage would have collected forty rewards for one monster.
    //
    // The bound is on the NUMBER OF PAYEES, not on each one's share, and that distinction matters. A
    // large minimum share (20% say) does cap the count, but it also cuts a trainer who honestly dealt
    // 30 of a 170-health monster — a real contribution by any reading. Taking the top MOB_PAYEES by
    // damage instead caps the multiplier at four whatever the fleet size, while a one-damage poke can
    // never be top-four in the presence of anyone actually fighting. The small floor then excludes
    // pure tourists even when nobody else showed up.
    const ranked = [...m.hitters.entries()]
      .filter(([w, dealt]) => isPubkey(w) && dealt >= mobMaxHp(idx) * MOB_SHARE_MIN)
      .sort((p, q) => q[1] - p[1])
      .slice(0, MOB_PAYEES);
    for (const [w] of ranked) {
      ownCredit(w, "mat", "essence", ess);
      lastWitnessedKill.set(w, now);   // silences kill/report's guess for KILL_DEDUPE_MS
      paid.push(w.slice(0, 8));
    }
    if (lastWitnessedKill.size > 5000) {
      for (const [w, t] of lastWitnessedKill) if (now - t > KILL_DEDUPE_MS * 4) lastWitnessedKill.delete(w);
    }
  }
  res.json({ ok: true, hp: Math.round(m.hp), maxhp: mobMaxHp(idx), killed, gen: m.gen,
             back: killed ? MOB_RESPAWN_MS : 0, paid: paid.length });
});

// The shared world, read-only: which monsters are hurt or down, and when they return. A pristine
// island answers with an empty object.
app.get("/world/mobs", (_q, res) => {
  const now = Date.now();
  worldMobTick(now);
  res.json({ tick: _worldTickOn, mobs: mobSnapshot(now), respawnMs: MOB_RESPAWN_MS, ts: now });
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

// ---- DELTA ENCODING: stop resending what never changes ----
// Measured from a live 2,396-snapshot capture: of the ~292 bytes in a player row, the fields that
// NEVER change during a session — handle, avatar, party, comp, el, leg, br, eggs — account for ~123 of
// them, and they were resent to everyone every 0.55 s. Snapshot egress is the scaling wall here (~33
// KB/s downstream per player, ~18 KB per snapshot at the 60-peer cap), so this is the cheapest real
// headroom available: roughly 40% off the wire without touching the tick rate or the peer cap, which
// are the two knobs that would cost phones frames.
//
// STRICTLY OPT-IN, because the web bundle is cached and two live players were measured this session
// still running a pre-pass-1 build. A caller must ask for deltas (`dl:1`); everyone else keeps getting
// the identical full rows they get today. Nothing about the old contract moves.
//
// The per-caller memory of "which peers have I already described to you" lives ON THE CALLER'S OWN
// worldPlayers row, so it is evicted by the same TTL sweep that evicts them — there is no second map
// to prune and no way for it to outlive the session it belongs to. `sq` on each peer is bumped
// whenever a static field actually changes, which re-sends that peer's full row exactly once.
const STATIC_KEYS = ["handle", "leg", "el", "br", "avatar", "comp", "party", "eggs"];
function bumpStaticSeq(prev, next) {
  if (!prev) return 1;
  for (const k of STATIC_KEYS) {
    if (String(prev[k] === undefined ? "" : prev[k]) !== String(next[k] === undefined ? "" : next[k])) {
      return (Number(prev.sq) || 1) + 1;
    }
  }
  return Number(prev.sq) || 1;
}
// ---- INTEREST RADIUS (with hysteresis) ----
// The client hides every remote past RENDER_DIST 240 (Net.gd RENDER_DIST) and skips all their per-frame
// work — yet the snapshot shipped every peer within WORLD_RADIUS 4000, i.e. the whole island. At
// 60 peers most of every snapshot was players the receiver could not see. So /world/move replies
// now ship only peers the receiver can actually render: ENTER at 260 (20 units beyond the render
// wall, so an approaching peer's rig + interp buffer exist BEFORE they become visible) and LEAVE
// at 320 (a 60-unit hysteresis band, ~4× the largest per-snapshot step of the fastest mount, so a
// peer dancing on the boundary flaps exactly once per real crossing, never per tick). Eviction
// also forgets the receiver's delta memory of that peer, so re-entry ships a FULL row — the
// client frees the rig after its 10 s grace and an abbreviated row would force a resync round.
// GET /world/players and /world/roster keep the wide view on purpose (spectate / the online pill).
const INTEREST_ENTER = 260;
const INTEREST_LEAVE = 320;
function worldSnapshot(wallet, x, z, delta = false, interest = false) {
  const now = Date.now(), out = [];
  const me = (delta || interest) ? worldPlayers.get(wallet) : null;
  const seen = (delta && me) ? (me.seen || (me.seen = new Map())) : null;
  // hysteresis memory: the peers this receiver is currently being shipped. Lives on the caller's
  // own row (like `seen`), so the TTL sweep that evicts them evicts it — nothing to prune later.
  const vis = (interest && me) ? (me.vis || (me.vis = new Set())) : null;
  for (const [w, p] of worldPlayers) {
    if (now - p.ts > WORLD_TTL_MS) { worldPlayers.delete(w); continue; }
    if (w === wallet) continue;
    const d = Math.hypot((p.x || 0) - x, (p.z || 0) - z);
    // INTEREST IS TESTED BEFORE THE WIDE RADIUS, and the order is load-bearing. A hostile client can
    // POST itself past WORLD_RADIUS; with the wide skip first, that peer left the receiver's bubble
    // WITHOUT running the eviction below, so it kept its `vis`/`seen` entries. On its way back it was
    // then shipped an abbreviated `dl:1` row for a rig the receiver's client had already freed —
    // one forced _dl_resync round per observer, per teleport, at the attacker's choosing.
    // INTEREST_LEAVE (320) is far inside WORLD_RADIUS (4000), so with interest on this branch already
    // catches everything the wide check would have; the wide check still guards the spectate path.
    if (interest) {
      const lim = (vis && vis.has(w)) ? INTEREST_LEAVE : INTEREST_ENTER;
      if (d > lim) {
        if (vis && vis.delete(w) && me.seen) me.seen.delete(w);   // evicted → next entry is a FULL row
        continue;
      }
      if (vis) vis.add(w);
    }
    if (d > WORLD_RADIUS) continue;
    // volatile half: always sent, because it is what actually moves
    // `a` = the sample's AGE in ms (now - when the mover reported it). An age, not a clock, so no
    // client/server clock sync is needed; the client stamps arrival-minus-age and gets a timeline in
    // its OWN clock that is jitter-free. Old clients ignore the field.
    // The STATIC half is decided further down, AFTER the cap — see there for why.
    const row = { d, wallet: w, x: p.x, y: p.y || 0, z: p.z, dir: p.dir, mount: p.mount || "", act: p.act || "", spr: !!p.spr, a: now - p.ts };
    row._p = p;                         // carried to the post-cap pass, deleted before it goes out
    out.push(row);
  }
  if (vis) {
    // a peer who TTL'd out (or signed out) without ever crossing the boundary would otherwise sit
    // in vis/seen forever; forgetting them here also makes their eventual REJOIN ship a full row.
    for (const w of vis) if (!worldPlayers.has(w)) { vis.delete(w); if (me.seen) me.seen.delete(w); }
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
  // THE DELTA MEMORY IS WRITTEN AFTER THE CAP, and that ordering is the whole point. Recording
  // `seen[w] = sq` inside the loop above marked peers the cap then THREW AWAY — so the server
  // believed it had sent a static half it never sent. The moment such a peer drifted into the 60
  // nearest (someone walks off, a crowd shifts) it was shipped `dl:1`: a row with no handle, no
  // avatar, no party, for a wallet the client has never heard of. Net.gd answers that with
  // `_dl_resync`, a whole extra full-snapshot round — and in a 60+ crowd, which is exactly when a
  // town square is at its heaviest, that fires on every poll. Measured at 10 of 10 promoted peers,
  // on this build AND on git HEAD before interest management existed (av_capseen_prechange_sim.mjs),
  // so this is an old bug the cap has always had, not a cost of the interest radius.
  for (const e of near) {
    const p = e._p, sq = Number(p.sq) || 1;
    if (seen && seen.get(e.wallet) === sq) {
      e.dl = 1;                       // "static half omitted — reuse what I already told you"
    } else {
      e.handle = p.handle; e.leg = p.leg; e.el = p.el; e.br = p.br;
      e.avatar = p.avatar; e.comp = p.comp; e.party = p.party; e.eggs = p.eggs || "";
      e.sq = sq;
      if (seen) seen.set(e.wallet, sq);
    }
    delete e.d; delete e._p;   // sort key and row back-pointer — never part of the wire contract
  }
  if (seen && seen.size > WORLD_MAX_PEERS * 3) {
    // bounded by the peer cap it serves; drop the oldest rather than let a long session accumulate
    let drop = seen.size - WORLD_MAX_PEERS * 2;
    for (const k of seen.keys()) { if (drop-- <= 0) break; seen.delete(k); }
  }
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


// ============ THE WORLD TICK — the server runs the world instead of remembering it ============
// Everything else the server owns is a RECORD: who is online, which trees are on cooldown, what is for
// sale, who owns which chikimon. It owns no causality. Every consequence in Chikoria was computed on a
// client and reported afterwards, which is why /world/kill/report accepts a claim about combat it
// cannot check (43,200 essence/hour, measured, on a wallet that never fought anything), and why two
// players standing together fight DIFFERENT COPIES of the same monster. Measured with two independent
// Monsters simulations in one tree: they drift up to 32 units apart — past HIT_R 9, so one player is in
// strike range while their friend is not — and on a kill one client has dead=true while the other has
// dead=false. There is no version of co-op available from that.
//
// So this is the first thing on the server that TICKS. Deliberately it owns only three facts per
// monster — HP, death, and the respawn clock — because those are what make a kill shared and a reward
// honest. It does NOT own position: mob motion can converge for free by seeding the wander from the
// spawn index and a shared clock, and streaming 24 positions on the world tick would spend the
// scarcest resource in the system (measured: 307 bytes/player-row, ~33 KB/s downstream per player,
// bandwidth-bound long before CPU-bound).
//
// WHY THIS IS NOT A NEW FAUCET, which is the question that decides the whole design:
//   * the CLIENT NEVER NAMES THE REWARD. A kill pays the mob's own essence value from MOB_STATS,
//     credited ONCE per generation, split across whoever actually damaged it.
//   * the SERVER OWNS THE RESPAWN CLOCK. 24 spawns on MOB_RESPAWN_MS means the entire island yields at
//     most 24 kills per 90 s even if every one died instantly — a hard ceiling of ~960 kills/hour that
//     no client can influence, versus a faucet that needed no movement at all. And collecting it means
//     physically travelling between 24 fixed points spread across the map.
//   * damage is CLAMPED and RATE-LIMITED per wallet, so a modified client cannot one-shot a boss.
//   * a hit is POSITION-AUTHORISED against the server's own presence record, exactly like
//     /world/node/claim (server.js:3180) — reach is derived from the spawn index, never from a
//     position the caller sends.
// ON BY DEFAULT since 2026-07-31: the client consumes the mobs field now (Net.gd applies it after
// its seq gate and hands the dead-set to Monsters.apply_shared), so the reason it shipped dark —
// "no client reads it yet" — no longer holds. Kill-switch: CHIK_WORLD_TICK=0 (or the legacy
// WORLD_TICK=0) forces the shared world off; WORLD_TICK=1, which every existing sim sets, still
// means on.
const WORLD_TICK_ON = String(process.env.CHIK_WORLD_TICK ?? process.env.WORLD_TICK ?? "") !== "0";
// Mirrors Econ.gd MOBS and Econ.gd RESPAWN_S. If these drift from the client the shared
// HP bar lies, so they are asserted equal by world_tick_sim rather than trusted.
const MOB_STATS = Object.freeze(Object.assign(Object.create(null), {
  darkeet:   { hp: 170, essence: 1 },
  shadowisp: { hp: 210, essence: 2 },
  hogwert:   { hp: 260, essence: 2 },
  darkeon:   { hp: 400, essence: 3 },
}));
// The 24 spawns, in the SAME ORDER Monsters.gd's spawn walk reads monsters_meta.json — so the array index IS
// the shared mob id on every client, with no negotiation and nothing to broadcast. This is the one
// piece of luck in the whole problem and the reason it is tractable.
const MOB_SPAWNS = Object.freeze([
  ["darkeet", 99.6, 344.7], ["darkeet", 378.0, -415.0], ["darkeet", -94.2, 113.7],
  ["darkeet", 307.3, 265.9], ["darkeet", -313.6, -15.3], ["darkeet", -408.3, -429.0],
  ["hogwert", -74.5, 141.3], ["hogwert", 202.3, 51.5], ["hogwert", 323.9, -286.2],
  ["hogwert", 143.1, 276.7], ["hogwert", 442.1, -199.5], ["hogwert", 356.1, -236.1],
  ["darkeon", 426.9, -198.1], ["darkeon", -431.6, 115.4], ["darkeon", 58.2, -630.3],
  ["darkeon", 264.5, -45.3], ["darkeon", 468.9, -308.6], ["darkeon", -436.9, -397.5],
  ["shadowisp", 138.4, -472.4], ["shadowisp", 84.0, -478.9], ["shadowisp", -230.7, 58.3],
  ["shadowisp", -460.2, -184.9], ["shadowisp", 289.8, -310.6], ["shadowisp", -170.1, 45.7],
].map((r) => Object.freeze(r)));
const MOB_RESPAWN_MS = 90 * 1000;      // Econ.RESPAWN_S 90.0
const MOB_HIT_MIN_MS = 400;            // per wallet; a human swing cycle is far slower
const MOB_DMG_MAX = 120;               // per hit; the strongest real loadout is well under this
// REACH IS NOT MEASURED FROM HOME, because home does not predict where a monster is. Monsters.gd's
// only steering (447-451) is an annulus keeper around the island centre (2, -204): steer inward past
// 620, outward inside 250, and NOTHING in between. There is no leash to home — home is only where a
// respawn places it. All 24 of 24 spawn homes sit inside that unsteered band (measured: 287..560 from
// centre), so every mob random-walks a 370-unit-wide ring and can sit hundreds of units from its own
// spawn point. A 90-unit gate around home would therefore have refused the honest fighter most of the
// time while stopping no bot at all, which is worse than having no gate: it is a coin flip that only
// ever lands on real players.
//
// The ANCHOR is the honest replacement. The first accepted strike of a generation records where that
// fight is happening, taken from the striker's own presence row — so it can never refuse the trainer
// who opened the fight. Everyone else must be near that anchor, which makes shared credit mean "we
// were standing together", the one positional property that survives /world/move having no speed
// check. Be clear about the limit: a lone bot sets its own anchor, so this bounds co-op credit, not
// solo farming. Solo farming is bounded by the respawn clock instead.
const MOB_ANCHOR_R = 40;        // extra reach granted to whoever is already standing at the fight
const MOB_ANCHOR_MAX = 780;     // sanity backstop: further from home than a mob could EVER be
// A fight with no accepted strike for this long is over: release the anchor so a live monster is never
// pinned to a spot it walked away from. Comfortably longer than one card battle, far shorter than the
// forever an unreleased anchor used to last.
const MOB_ANCHOR_TTL = 45000;
// ---- THE SHARED IDLE PATH — PORTED EXACTLY from Monsters.gd (MOB_SYNC_IDLE block, _mob_hash /
// _mob_wander_r / _mob_idle_pos). Since the client made idle motion a pure function of
// (spawn ordinal, unix seconds), every client agrees where mob idx N is — and so can the server.
// That retires the 780-unit "somewhere in the annulus" first-strike gate: the opener must now be
// near where the monster actually IS. Do not edit these constants or the arithmetic without
// changing Monsters.gd in the same commit — world_share_v2_sim asserts convergence within 1 unit
// against values printed by the real GDScript functions, so a drift fails the sim rather than
// silently refusing honest fighters.
const MOB_ISLE_CX = 2.0, MOB_ISLE_CZ = -204.0;          // Monsters.gd ISLE_CX / ISLE_CZ
const MOB_ANNULUS_IN = 250.0, MOB_ANNULUS_OUT = 620.0;  // Monsters.gd ANNULUS_IN / ANNULUS_OUT
const MOB_WANDER_R = 60.0;                              // Monsters.gd MOB_WANDER_R
// How far from the evaluated idle point an honest opener can be: an aggro chase drags a mob up to
// DEAGGRO_R 70 off its path, a card battle holds it in place while the path point orbits up to a
// full wander diameter (2 x 60) away, plus strike reach and a few units of client clock skew
// (1 s of skew is a few units of path). 220 covers that sum; a claim from across the map (600+) is
// refused, against the 780 the home-based gate accepted.
const MOB_IDLE_GATE = 220;
function mobHash(i, salt) {
  // Monsters.gd _mob_hash runs in 64-bit signed ints and the product reaches ~2.7e18 — past
  // Number's 2^53 — so BigInt is REQUIRED for the port to be exact. It never exceeds 2^63, so
  // neither side wraps and no masking is needed.
  let h = BigInt(i * 73856093) ^ BigInt(salt * 19349663);
  h = (h ^ (h >> 13n)) * 1274126177n;
  if (h < 0n) h = -h;                                   // absi — defensive on both sides
  return Number(h % 100000n) / 100000;
}
function mobWanderR(hx, hz) {
  const hr = Math.hypot(hx - MOB_ISLE_CX, hz - MOB_ISLE_CZ);
  return Math.max(8.0, Math.min(MOB_WANDER_R, Math.min(hr - MOB_ANNULUS_IN - 5.0, MOB_ANNULUS_OUT - hr - 5.0)));
}
function mobIdlePos(idx, tSec) {
  const sp = MOB_SPAWNS[idx];
  const hx = sp[1], hz = sp[2];
  const rMax = mobWanderR(hx, hz);
  const w1 = 0.045 + mobHash(idx, 1) * 0.055;
  const w2 = 0.017 + mobHash(idx, 2) * 0.031;
  const p1 = mobHash(idx, 3) * Math.PI * 2;
  const p2 = mobHash(idx, 4) * Math.PI * 2;
  const ang = tSec * w1 + p1;
  const rad = rMax * (0.45 + 0.40 * Math.sin(tSec * w2 + p2) + 0.15 * Math.sin(tSec * w1 * 0.37 + p2 * 1.7));
  return { x: hx + Math.sin(ang) * rad, z: hz + Math.cos(ang) * rad };
}
export function _mobIdlePos(idx, tSec) { return mobIdlePos(idx, tSec); }   // sim seam: convergence proof
// Who gets paid for a kill. MOB_PAYEES caps the reward multiplier at four no matter how many wallets
// touched the monster; MOB_SHARE_MIN is only a tourist floor, deliberately low enough that an honest
// 30-of-170 contribution still counts.
const MOB_HITTERS_MAX = 40;    // contributors tracked per life; sheds the SMALLEST, see the hit route
const MOB_PAYEES = 4;
const MOB_SHARE_MIN = 0.05;
const worldMobs = new Map();           // idx -> {hp, gen, deadAt, hitters:Map(wallet->dmg), ax, az}
// A WITNESSED KILL MUST SILENCE THE SELF-REPORTED ONE. /world/kill/report credits essence on the
// client's word; this tick credits it on the server's own observation. Both fire for the same monster,
// so the same fight paid twice — measured: mob kill credited 1, then kill/report answered
// counted:true and credited another. The witnessed path is the truthful one, so it wins and the
// reported one stands down for a window comfortably longer than one fight.
const lastWitnessedKill = new Map();   // wallet -> ms of their last server-observed kill
const KILL_DEDUPE_MS = 30000;
let _mobKills = 0, _mobHits = 0, _mobHitsRefused = 0;

function mobRow(idx) {
  let m = worldMobs.get(idx);
  if (m) return m;
  const spec = MOB_SPAWNS[idx];
  if (!spec) return null;
  const st = MOB_STATS[spec[0]];
  m = { hp: st ? st.hp : 60, gen: 1, deadAt: 0, hitters: new Map(),
        ax: undefined, az: undefined, aix: 0, aiz: 0, aT: 0 };
  worldMobs.set(idx, m);
  return m;
}
function mobMaxHp(idx) {
  const spec = MOB_SPAWNS[idx];
  const st = spec ? MOB_STATS[spec[0]] : null;
  return st ? st.hp : 60;
}
// THE TICK. It advances one clock and nothing else — a dead mob comes back when its timer is up, for
// everybody at once. Cheap and O(dead), so it costs nothing when the island is quiet.
function worldMobTick(now) {
  for (const [idx, m] of worldMobs) {
    if (!m.deadAt) continue;
    if (now - m.deadAt < MOB_RESPAWN_MS) continue;
    m.deadAt = 0;
    m.hp = mobMaxHp(idx);
    m.gen++;                           // a new life: credit for the old one can never be claimed again
    m.hitters.clear();
    m.ax = undefined; m.az = undefined; m.aT = 0; // and a new life anchors wherever it is next found
  }
}
// What every client is told about the shared world. Only mobs that are NOT at full health or are dead
// are worth sending — a pristine island is an empty object, so the common case costs ~2 bytes.
function mobSnapshot(now) {
  // EXPIRE ON EVERY READ. The /world/move reply is the main consumer now, and it did not tick —
  // so a mob whose respawn came due stayed {dead, back:0} in every move snapshot until someone
  // happened to hit something or GET /world/mobs. O(dead), so it costs nothing when quiet.
  worldMobTick(now);
  const out = {};
  for (const [idx, m] of worldMobs) {
    if (!m.deadAt && m.hp >= mobMaxHp(idx)) continue;
    out[idx] = m.deadAt
      ? { dead: 1, back: Math.max(0, MOB_RESPAWN_MS - (now - m.deadAt)) | 0, gen: m.gen }
      : { hp: Math.round(m.hp), gen: m.gen };
  }
  return out;
}
// PERSIST THE DEAD, exactly as node cooldowns already are (serializeWorldNodes, 3091) and for the same
// reason: Render's free plan restarts on every deploy and on idle spin-down, and an in-memory-only
// world means 24 monsters resurrect at full health each time. That is a farm — kill the island, trigger
// a restart, kill it again — and it also silently un-does a shared death everyone watched happen.
// Only DEAD mobs are worth keeping: a live one is fully described by its spawn entry, and a respawn
// that came due while the process was down should simply have happened.
export function serializeWorldMobs(now = Date.now()) {
  const out = [];
  for (const [idx, m] of worldMobs) {
    if (!m.deadAt) continue;
    if (now - m.deadAt >= MOB_RESPAWN_MS) continue;     // due back anyway; do not carry a stale corpse
    out.push([idx, { deadAt: m.deadAt, gen: m.gen }]);
  }
  return out;
}
// Trusts nothing, same as the node restore: an index must be a real spawn, a timestamp must be finite
// and not in the future, and a corpse whose clock already ran out is simply not restored.
export function restoreWorldMobs(v, now = Date.now()) {
  if (!Array.isArray(v)) return 0;
  let n = 0;
  for (const e of v) {
    if (!Array.isArray(e) || !e[1] || typeof e[1] !== "object") continue;
    const idx = Math.floor(Number(e[0]));
    if (!Number.isInteger(idx) || idx < 0 || idx >= MOB_SPAWNS.length) continue;
    const deadAt = Number(e[1].deadAt);
    if (!Number.isFinite(deadAt) || deadAt <= 0 || deadAt > now) continue;
    if (now - deadAt >= MOB_RESPAWN_MS) continue;       // its respawn came due while we were down
    const gen = Math.max(1, Math.floor(Number(e[1].gen)) || 1);
    const m = mobRow(idx);
    m.deadAt = deadAt; m.gen = gen; m.hp = 0;
    m.hitters.clear(); m.ax = undefined; m.az = undefined; m.aT = 0;   // credit for that life is closed
    n++;
  }
  return n;
}
store.kvGet("world_mobs").then((v) => { const n = restoreWorldMobs(v); if (n) console.log(`world mobs restored: ${n} still down`); }).catch(() => {});
async function saveWorldMobs(strict = false) {
  try { await store.kvSet("world_mobs", serializeWorldMobs()); }
  catch (e) { console.warn("saveWorldMobs failed:", String(e?.message || e)); if (strict) throw e; }
}
setInterval(saveWorldMobs, 10000).unref?.();

// Sim seams so the island-wide ceiling can be asserted against the REAL spawn table rather than a
// number copied into the test (which would agree with itself forever if the table changed).
export function _mobSpawnCount() { return MOB_SPAWNS.length; }
export function _mobSpawnAt(i) { return MOB_SPAWNS[i]; }
export function _mobEssenceTotal() { let t = 0; for (const sp of MOB_SPAWNS) { const st = MOB_STATS[sp[0]]; t += st ? st.essence : 1; } return t; }
export function _clearWorldMobs() { worldMobs.clear(); _mobKills = 0; _mobHits = 0; _mobHitsRefused = 0; }
export function _mobFor(idx) { const m = worldMobs.get(idx); return m ? { hp: m.hp, gen: m.gen, dead: !!m.deadAt, hitters: [...m.hitters.keys()] } : null; }
export function _mobTickForTest(now) { worldMobTick(now || Date.now()); }
export function _setWorldTickForTest(on) { _worldTickOn = !!on; return _worldTickOn; }
let _worldTickOn = WORLD_TICK_ON;

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
// creditOwn=false for callers whose per-unit count is a deliberately inflated telemetry CEILING
// rather than a real acquisition (the kill report's ESSENCE_PER_KILL). Default true: a node claim.
function recordGather(wallet, kind, drop, creditOwn = true) {
  if (!isPubkey(String(wallet || "")) || !kind) return;
  // Count the MATERIALS, not the node kind. The oversold check compares this against what a wallet
  // lists for sale, and nobody sells a "cow" — they sell beef and hide.
  // NO FALLBACK TO THE NODE KIND. NODE_DROP is written as "an ALLOWLIST, never a default — unknown
  // -> nothing", and nodeDrop() honours it by returning []. This line used to turn that empty drop
  // straight back into the raw kind string, so a claim of a node kind that does not exist
  // ("essence:800:-400") credited the acquisition book anyway if the string happened to be in
  // MAT_IDS — measured 1500 -> 1501 on a drop of []. The two real callers (fish, kill) already pass
  // a filled array, so nothing legitimate depended on the fallback.
  const mats = Array.isArray(drop) ? drop : [];
  if (!mats.length) return;
  const g = _tallyRow(gatherCount, wallet);
  // MATERIALS ONLY as tally keys. The restore path truncates a gather row to its first 40 keys, so
  // junk keys written here could push a wallet's REAL counts out of the row the oversold signal
  // reads. The flow tallies already enforce exactly this rule on restore.
  for (const m of mats) { if (!MAT_IDS.has(m)) continue; g[m] = (g[m] || 0) + 1; }
  _assetsDirty = true;
  // THE ACQUISITION BOUND'S ONLY BULK CREDIT. A node claim is position-authorised against the
  // server's own record of where this wallet is, and one gather is exactly one item, so each entry
  // here is one witnessed unit. gatherCount keeps its own over-generous counts for the observe-only
  // oversold signal; the book gets the honest one. They must not share a number.
  if (creditOwn) for (const m of mats) ownCredit(wallet, "mat", m, 1);
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

// ============ RARITY IS A LAW, NOT A LABEL ============
// Advertised scarcity used to be enforced NOWHERE for avatars, and for mounts the "supply" numbers
// were only pickWeighted WEIGHTS — rarer to roll, unlimited to own. Only Meme Dynasty had real
// caps, and even those were enforced at the ROUTE, not here: nine call sites reach mintAsset, so
// every new path was a silent bypass (measured: 400 mint attempts produced 40 of a 5-supply avatar
// and 66 griffins against a supply of 5). The cap now lives at the CHOKEPOINT every issuance must
// pass through, so nothing can route around it — including future code.
//
// Avatar caps are the client's Econ.AVATAR_SUPPLY x10 (the owner's decision after the Mad
// Alchemist was over-issued: raising the ceiling rather than confiscating anyone's avatar).
// GRANDFATHERING: a species already past its cap simply stops issuing — nothing is ever deleted or
// taken back. Over-issued holders keep what they have; the cap binds from here on.
const ASSET_SUPPLY = Object.freeze({
  // Avatar caps divided by 5 (owner decision, 2026-08-01) — scarcity tightened across the board.
  // Safe against grandfathering: every live issued count was BELOW its new cap when this was applied
  // (worst headroom classic 22/100, chemist 3/10), so no holder is stranded above a cap. mintAsset
  // refuses at the cap and never revokes, so even if a count later resolves higher, minting simply
  // stops — nothing is ever taken back.
  avatar: Object.freeze({ classic: 100, Knight: 40, Mystic: 20, Navigator: 60, Star: 40,
                          chemist: 10, electro: 60, fire: 60, night: 20, sailor: 40 }),
  mount:  Object.freeze({ chicken: 15, boar: 20, gator: 15, horse: 10, wolf: 10, griffin: 5 }),
});
// ============ ONE CENSUS, THREE RECORD SOURCES ============
// A cap is only as true as its DENOMINATOR, and the denominator used to be the registry alone —
// which is the newest and smallest of three places a living creature can be recorded:
//
//   1. assetReg      the server-minted registry (id/type/sp/owner/origin/state/parent/chain)
//   2. assetLedger   the LEGACY per-wallet ledger — rec.units / rec.mounts / rec.avatars. This is
//                    where every old-game creature lives, and there are worlds where it holds far
//                    more of a species than the registry does. Counting only (1) let a
//                    legacy-heavy species issue right past its advertised supply.
//   3. memeMinted    the PAID Meme Dynasty sale counter (kv "meme_minted", backed by memeHatches).
//
// THE DEDUP TRAP. These sources overlap, and a naive union double-counts:
//   - /assets/mounts/sync and /assets/chikimon/sync ADOPT ledger entries by minting a registry row
//     for them, so one creature sits in BOTH (1) and (2);
//   - anything the server itself hatched appears in (1) and then, on the player's next save, in (2);
//   - a paid-sale meme is counted in (3), is granted in-game (so it reaches (2)), and is then
//     adopted into (1) — one creature, counted three times.
// Double-counting is not a harmless overestimate: it refuses honest players at a ceiling the world
// has not actually reached. So the union is reconciled PER WALLET PER SPECIES, registry-first.
//
// THE DEDUP KEY. Adoption used to carry no link back to the ledger entry it adopted (only sp/owner
// /origin), so `luid` — the ledger's own key for that entry (the unit uid for chikimon, the species
// key for mounts, which is what rec.mounts is keyed by) — is written on every adopted row from
// here on. Rows adopted BEFORE this existed have no luid, so the reconciliation also absorbs one
// unmatched ledger entry per unmatched registry row of the same wallet+species: species-level
// adoption is one row per species per wallet, which makes that absorption exact for those rows.
//
// EXCLUSIONS: a ledger entry with held === false was sold or given away; a registry row in state
// consumed/void (a hatched egg, above all) is not a living creature. Neither counts.
// A species named by no supply table is still counted and still reported — never a crash.
//
// UNVERIFIED ASSETS ARE REPORTED, NOT COUNTED. A flagged asset is one the record says appeared from
// nowhere. If it consumed a cap slot, then conjuring five griffins into a save would permanently
// deny the last five griffins to every honest player — forgery as a denial-of-service on scarcity,
// paid for by the innocent. Nothing is deleted or taken (that is not what flags are for): they ride
// in the published `flagged` line, visible and auditable, and simply do not bind the cap.
const CENSUS_TTL_MS = 30000;            // backstop only; every mutation invalidates explicitly
let _census = null, _censusAt = 0, _censusBuilds = 0;
function censusInvalidate() { _census = null; }
// the asset TYPE is a closed set that never contains ":", so type+sp is unambiguous as one key
function _censusKey(type, sp) { return String(type) + ":" + String(sp); }

function buildCensus() {
  const byKey = new Map();
  const slotOf = (type, sp) => {
    const k = _censusKey(type, sp);
    let s = byKey.get(k);
    if (!s) { s = { type, sp, registry: 0, ledger: 0, sales: 0, deduped: 0, count: 0, flagged: 0, orphanSales: 0, w: new Map() }; byKey.set(k, s); }
    return s;
  };
  // Each wallet keeps two parallel tallies of the same shape: `c` (clean — what binds the cap) and
  // `f` (flagged — reported only). Both are reconciled by the identical rule, so a forged asset is
  // deduped as carefully as an honest one; it is simply counted somewhere that costs nobody.
  const grp = () => ({ R: 0, L: 0, luids: null, uids: null });
  const wOf = (slot, wallet) => {
    let w = slot.w.get(wallet);
    if (!w) { w = { c: grp(), f: grp(), S: 0 }; slot.w.set(wallet, w); }
    return w;
  };
  const addReg = (g, luid) => { g.R++; if (luid) (g.luids || (g.luids = new Set())).add(String(luid)); };
  const addLed = (g, uid) => { g.L++; (g.uids || (g.uids = [])).push(String(uid)); };
  const distinctOf = (g) => {
    let matched = 0;
    if (g.luids && g.uids) for (const uid of g.uids) if (g.luids.has(uid)) matched++;
    if (matched > g.R) matched = g.R;
    const unmatchedL = g.L - matched, freeR = g.R - matched;
    const absorbed = Math.min(unmatchedL, Math.max(0, freeR));      // pre-luid adoptions & own hatches
    return g.R + (unmatchedL - absorbed);
  };

  // ---- 1. the registry: what the server itself minted --------------------------------------
  for (const r of assetReg.values()) {
    if (!r || r.state !== "active") continue;         // consumed / void are not living creatures
    const type = String(r.type || ""), sp = String(r.sp || "");
    if (!type || !sp) continue;
    const slot = slotOf(type, sp), w = wOf(slot, String(r.owner || "?"));
    const bad = r.origin === "unverified";
    addReg(bad ? w.f : w.c, r.luid);
    if (!bad) slot.registry++;                     // `flagged` is filled in by the reconcile below
  }
  // ---- 2. the legacy ledger: what predates the registry -------------------------------------
  for (const [wallet, rec] of assetLedger) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.units) for (const uid of Object.keys(rec.units)) {
      const u = rec.units[uid];
      if (!u || u.held === false) continue;           // sold / no longer in the roster
      const sp = String(u.sp || "");
      if (!sp || sp === "?") continue;
      const slot = slotOf("chikimon", sp), w = wOf(slot, wallet), bad = u.origin === "unverified";
      addLed(bad ? w.f : w.c, uid);
      if (!bad) slot.ledger++;
    }
    if (rec.mounts) for (const sp of Object.keys(rec.mounts)) {
      const m = rec.mounts[sp];
      if (!m || m.held === false) continue;
      if (!sp || sp === "?") continue;
      const slot = slotOf("mount", sp), w = wOf(slot, wallet), bad = m.origin === "unverified";
      addLed(bad ? w.f : w.c, sp);                    // rec.mounts IS keyed by species
      if (!bad) slot.ledger++;
    }
    // avatars are census-only in the ledger — never graded, so there is no flagged case here
    if (rec.avatars) for (const sp of Object.keys(rec.avatars)) {
      const a = rec.avatars[sp];
      if (!a || a.held === false) continue;
      if (!sp || sp === "?") continue;
      const slot = slotOf("avatar", sp), w = wOf(slot, wallet);
      addLed(w.c, sp); slot.ledger++;
    }
  }
  // ---- 3. the paid Meme Dynasty sale ---------------------------------------------------------
  for (const h of memeHatches) {
    if (!h || !h.char) continue;
    if (h.status !== "pending" && h.status !== "minted") continue;   // a mystery egg has no species yet
    const slot = slotOf("chikimon", String(h.char)), w = wOf(slot, String(h.wallet || "?"));
    w.S++; slot.sales++;
  }
  // a persisted memeMinted tally with no hatch row behind it (an older kv blob) still counts — it
  // just cannot be attributed to a wallet, so it can never be deduped against one either
  for (const key of Object.keys(memeMinted)) {
    const n = Math.max(0, Number(memeMinted[key]) || 0);
    if (!n) continue;
    const slot = slotOf("chikimon", key);
    const extra = Math.max(0, n - slot.sales);
    if (extra > 0) { slot.sales += extra; slot.orphanSales += extra; }
  }

  // ---- reconcile: registry first, then whatever the registry does not already stand for -------
  for (const slot of byKey.values()) {
    let total = slot.orphanSales, flagged = 0;
    for (const w of slot.w.values()) {
      const base = distinctOf(w.c);
      total += base + Math.max(0, w.S - base);       // a sale already standing in (1)/(2) adds nothing
      flagged += distinctOf(w.f);
    }
    slot.count = total;
    slot.flagged = flagged;
    slot.deduped = Math.max(0, slot.registry + slot.ledger + slot.sales - slot.count);
    slot.w = null;                                    // working state, not a published record
  }
  _censusBuilds++;
  return byKey;
}
function censusAll() {
  if (!_census || Date.now() - _censusAt > CENSUS_TTL_MS) { _census = buildCensus(); _censusAt = Date.now(); }
  return _census;
}
// THE one counter. Everything that asks "how many of these exist" asks this, so there is a single
// number to be right about rather than two that drift apart.
const _CENSUS_ZERO = Object.freeze({ count: 0, registry: 0, ledger: 0, sales: 0, deduped: 0, flagged: 0 });
function trueIssued(type, sp) {
  const c = censusAll().get(_censusKey(type, sp));
  if (!c) return _CENSUS_ZERO;
  return { count: c.count, registry: c.registry, ledger: c.ledger, sales: c.sales,
           deduped: c.deduped, flagged: c.flagged };
}
// live issuance for one species — the DEDUPED union of every record source, not the registry alone
function issuedCount(type, sp) { return trueIssued(type, sp).count; }
function supplyOf(type, sp) {
  const t = ASSET_SUPPLY[type];
  if (t && Object.hasOwn(t, sp)) return t[sp];
  if (type === "chikimon") { const c = MEME_CHARS.find(x => x.key === sp); if (c) return c.cap || MEME_CAP; }
  return 0;                       // 0 = uncapped class (normal/legendary chikimon, eggs)
}
function atSupplyCap(type, sp) {
  const cap = supplyOf(type, sp);
  return cap > 0 && issuedCount(type, sp) >= cap;
}
// how many are LEFT — the number the world's rarity is derived from
function remainingOf(type, sp) {
  const cap = supplyOf(type, sp);
  return cap > 0 ? Math.max(0, cap - issuedCount(type, sp)) : -1;   // -1 = uncapped
}

let _regWarnAt = 0;
function mintAsset(type, wallet, fields, origin, parent) {
  if (assetReg.size >= ASSET_REG_MAX) throw new Error("asset registry is full");
  // THE CHOKEPOINT. Every path that issues anything comes through here; refusing here is what makes
  // the advertised rarity true. Restores/adoptions of assets that ALREADY EXIST are not issuance —
  // they carry origin "legacy"/"unverified"/"restitution" and are exempt, or the registry would
  // refuse to record history it is supposed to preserve.
  //
  // ADOPTION IS NOT ISSUANCE, WHATEVER THE LEDGER GRADED IT. `luid` is only ever set by the two
  // sync routes, and it names the ledger entry the row adopts — a creature the census ALREADY
  // counts from the ledger, so the cap must not be re-applied to it. Reading the exemption off the
  // ORIGIN alone was wrong: the ledger's verdict is "legacy" for a pre-epoch roster but "hatched",
  // "purchased", "issued" or "traded" for everyone else, and those graded rows were refused
  // SUPPLY_EXHAUSTED on any full species — a player denied the registration of a creature they
  // already own (and, through the sync loop's `break`, denied it for their whole stable).
  const _sp = String((fields && fields.sp) || "");
  const _adopting = !!(fields && fields.luid);
  const _issuing = !_adopting && !["legacy", "unverified", "restitution"].includes(String(origin || ""));
  if (_issuing && _sp && atSupplyCap(type, _sp)) {
    const e = new Error(`every ${_sp} that will ever exist has been claimed`);
    e.code = "SUPPLY_EXHAUSTED";
    throw e;
  }
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
  censusInvalidate();      // the count this row belongs to is now stale — the cap must never read it stale
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
  censusInvalidate();      // the census reconciles PER WALLET, so a change of owner re-groups it
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
// MITHRA'S PRICE, MIRRORED SERVER-SIDE (Econ.gd EGG_RECIPE). The route below used to charge nothing:
// its comment said "the client has already taken the barter from the player's own inventory", so the
// server owned the identity and the clock but not whether anyone had actually PAID. A proven wallet
// could claim an egg every 5s — 15/day once the EGG_HOURS walls are accounted for — hatch it, and
// receive a chikimon minted with clean "issued" provenance. That creature then passes
// chikimonSaleBlocked and sells for real $CHIKI, which is a bypass straight THROUGH the acquisition
// bound: the fraud happens at claim time and the registry certifies it afterwards.
//
// The MATERIAL half is enforceable and is now enforced against the book. THE FANTASY FISH HALF IS
// NOT: /world/fish/report records a generic "fish" and never the species (server.js:3317), so the
// server has never witnessed a golden chikifish. That half stays on the client until the catch roll
// moves server-side. So this makes an egg cost real GATHERING; it does not yet make it cost a legend.
// The fantasy fish each egg demands (Econ.gd EGG_RECIPE fish/fish_n; counts set by the owner
// 2026-07-24). This is the PRIMARY ingredient — enforceable only because the server now rolls catches.
const EGG_RECIPE_FISH = Object.freeze({
  normal:    Object.freeze({ sp: "golden_chikifish", n: 3 }),
  mount:     Object.freeze({ sp: "crystal_koi",      n: 2 }),
  legendary: Object.freeze({ sp: "mystic_eel",       n: 1 }),
  meme:      Object.freeze({ sp: "rainbow_fish",     n: 1 }),
});
const EGG_RECIPE_MATS = Object.freeze({
  normal:    Object.freeze({ wood: 30, berries: 24, essence: 8 }),
  mount:     Object.freeze({ seashell: 40, hide: 30, iron: 22, essence: 16 }),
  legendary: Object.freeze({ crystal: 40, gold: 30, essence: 26 }),
  meme:      Object.freeze({ crystal: 50, honey: 34, berries: 40, essence: 34 }),
});
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
  // CAN THIS WALLET AFFORD MITHRA'S PRICE? Fails OPEN while the book is loading — refusing a claim on
  // missing data would strand a real player's progression, which is worse than the egg.
  const _recipe = Object.hasOwn(EGG_RECIPE_MATS, kind) ? EGG_RECIPE_MATS[kind] : null;
  const _fishReq = Object.hasOwn(EGG_RECIPE_FISH, kind) ? EGG_RECIPE_FISH[kind] : null;
  if (_ffishAuth && _ownEnforce && _ownReady && _fishReq) {
    // THE PRIMARY INGREDIENT. Now that the server rolls the catch, the legend it demands is one it
    // witnessed itself — this is the half that was never enforceable before.
    const haveF = ownAvailable(wallet, "ffish", _fishReq.sp);
    if (haveF < _fishReq.n) {
      _ownRefusals++;
      return res.status(409).json({
        error: `Mithra will not trade without the spark — she asks for ${_fishReq.n} ${_fishReq.sp.replace(/_/g, " ")}, and Chikoria has recorded you catching ${Math.max(0, haveF)}.`,
        need: _fishReq.n, have: Math.max(0, haveF), fish: _fishReq.sp,
      });
    }
  }
  let _charge = false;
  if (_ownEnforce && _ownReady && _recipe) {
    for (const m of Object.keys(_recipe)) {
      const have = ownAvailableForIssue(wallet, "mat", m);   // issuance reads the strict allowance
      if (have < _recipe[m]) {
        _ownRefusals++;
        return res.status(409).json({
          error: `Mithra counts your offering and shakes her head — you need ${_recipe[m]} ${m}, and Chikoria has recorded you acquiring ${Math.max(0, have)}.`,
          need: _recipe[m], have: Math.max(0, have), mat: m,
        });
      }
    }
    _charge = true;   // every ingredient cleared — but nothing is taken until the egg EXISTS
  } else if (_ownEnforce && !_ownReady) {
    _ownSkipped++;
  }
  _lastEggClaim.set(wallet, now);
  // the only per-wallet map in this region without a bound; same sweep the neighbours use
  if (_lastEggClaim.size > 5000) {
    let _d = 250;
    for (const k of _lastEggClaim.keys()) { if (_d-- <= 0) break; _lastEggClaim.delete(k); }
  }
  let row;
  try { row = mintAsset("egg", wallet, { kind, sp: kind }, "issued"); }
  catch (e) { return res.status(503).json({ error: "the asset registry is at capacity — this is a server fault, not yours; nothing was consumed" }); }
  // CHARGED AFTER THE MINT, AND THAT ORDER IS THE POINT. The debit used to run before mintAsset, so
  // a registry-capacity throw took 40 crystal + 30 gold + 26 essence and answered "nothing was
  // consumed" — a false sentence over a real loss (measured: crystal 1500 -> 1460 on a 503).
  // Charged only once every material AND the legend cleared, so a partial payment is never taken.
  if (_charge) {
    for (const m of Object.keys(_recipe)) ownDebit(wallet, "mat", m, _recipe[m]);
    if (_ffishAuth && _fishReq) ownDebit(wallet, "ffish", _fishReq.sp, _fishReq.n);
  }
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
    // the supply cap binds the ROLL too, exactly as it does for memes: a steed whose last piece is
    // claimed can no longer be rolled. The egg is NOT consumed when nothing is left (409 before any
    // state change) — a player must never lose an egg to the world running out.
    const pool = MOUNT_SUPPLY.filter(([mid]) => !have.has(mid) && !atSupplyCap("mount", mid));
    if (!pool.length) return res.status(409).json({ error: ownedMounts(wallet).size >= MOUNT_SUPPLY.length
      ? "your stable is already full" : "every remaining steed has been claimed — the stable is legendary now" });
    born = mintAsset("mount", wallet, { sp: pickWeighted(pool), kind: "mount" }, "hatched", row.id);
  } else {
    const have = ownedSpecies(wallet);
    let pool = (EGG_KIND_POOL[row.kind] || SPECIES_NORMAL).filter(s => !have.has(s));
    // THE EDITION CAP IS A PROMISE, so it binds here too. A meme egg used to roll freely from all
    // six characters with no reference to how many of each already exist, which made "Alon, 1 of 10"
    // decoration rather than a limit. Anything at its cap simply leaves the pool.
    if (row.kind === "meme") pool = pool.filter((sp) => !memeAtCap(sp));
    if (!pool.length) {
      return res.status(409).json({ error: row.kind === "meme"
        ? "every Meme Dynasty edition you could still receive has been claimed"
        : "you already own every species from that egg" });
    }
    const sp = pool[crypto.randomInt(pool.length)];
    born = mintAsset("chikimon", wallet, { sp, kind: row.kind === "normal" ? "normal" : row.kind, lvl: 1 }, "hatched", row.id);
  }
  } catch (e) {
    // the egg is NOT consumed on failure — a capacity fault must never destroy what a player paid for
    // ...and a species that has genuinely run out is NOT a capacity fault. Telling a player to "try
    // again later" for a cap that will never move sends them into an endless retry and misdirects
    // support, so the two are answered separately.
    if (e && e.code === "SUPPLY_EXHAUSTED") return res.status(409).json({ error: `${e.message} — your egg is safe, hatch it again` });
    return res.status(503).json({ error: "the asset registry is at capacity — your egg is safe, try again later" });
  }
  // CONSUMED, NOT DELETED. The egg keeps its row and points at what came out of it, so the
  // creature's lineage is readable forever — and the egg can never vouch a second hatch.
  row.state = "consumed";
  row.hatchedTo = born.id;
  censusInvalidate();      // a consumed egg leaves the live count; the creature it became joins it
  regEvent(row, "hatched", { into: born.id, sp: born.sp });
  // the world feed carries ONLY server-rolled hatches (the /assets/egg/consume halfway house is a
  // client-chosen species — an honest lineage, but not a witnessed roll, so it stays out)
  if (row.kind === "legendary" || row.kind === "meme" || row.kind === "mount") {
    worldFeedPush(row.kind === "meme" ? "meme" : (row.kind === "mount" ? "mount" : "legend"), wallet, born.sp);
  }
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
  // THE POOL IS THE ONE /assets/egg/hatch ROLLS FROM, NOT THE WHOLE CATALOG.
  // This used to be `MOUNT_SUPPLY.map(m => m[0])` / the raw species list, i.e. the client NAMED the
  // prize and the only test was "is that a thing this egg can produce". Two consequences, both
  // measured (hatching_consume_sim.mjs): five brand-new wallets took all five griffins — a 5/75
  // weighted Mythic roll turned into a deterministic pick — and one wallet consumed three legendary
  // eggs as dragonos and listed all three duplicates on the Trading Post. The dedup and the cap
  // filter below are exactly what /hatch already applies before it rolls; this route now offers the
  // same set, so the only thing it still concedes is WHICH of the legal outcomes was drawn.
  const owned = isMount ? ownedMounts(wallet) : ownedSpecies(wallet);
  const catalog = isMount ? MOUNT_SUPPLY.map(m => m[0]) : (EGG_KIND_POOL[row.kind] || SPECIES_NORMAL);
  if (!catalog.includes(sp)) return res.status(400).json({ error: "that is not something this egg can produce" });
  // ONE OF EACH SPECIES. /hatch filters the roll by ownedSpecies/ownedMounts; without the same
  // filter here a wallet mints the same legendary as often as it can find eggs.
  if (owned.has(sp)) {
    return res.status(409).json({ error: isMount
      ? "that steed already waits in your stable — your egg is safe, hatch it again"
      : "you already carry that one — your egg is safe, hatch it again" });
  }
  // the client picked this species itself, so the cap has to be checked rather than assumed
  if (row.kind === "meme" && memeAtCap(sp)) {
    return res.status(409).json({ error: "that Meme Dynasty edition is fully claimed — your egg is safe, hatch it again" });
  }
  if (atSupplyCap(isMount ? "mount" : "chikimon", sp)) {
    return res.status(409).json({ error: `every ${sp} that will ever exist has been claimed — your egg is safe, hatch it again` });
  }

  let born;
  try {
    born = mintAsset(isMount ? "mount" : "chikimon", wallet,
      { sp, kind: isMount ? "mount" : (row.kind === "normal" ? "normal" : row.kind), lvl: 1 }, "hatched", row.id);
  } catch (e) {
    // A CAP IS NOT A CAPACITY FAULT. One catch used to answer both, so a player whose species had
    // genuinely run out was told to "try again later" and would retry forever. The egg survives
    // either way (nothing above this line mutates it) — only the sentence changes.
    if (e && e.code === "SUPPLY_EXHAUSTED") return res.status(409).json({ error: `${e.message} — your egg is safe, hatch it again` });
    return res.status(503).json({ error: "the asset registry is at capacity — your egg is safe, try again later" });
  }
  row.state = "consumed";
  row.hatchedTo = born.id;
  censusInvalidate();      // same as the server-rolled hatch: the egg leaves the live count
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
        // `luid` is the DEDUP KEY: rec.mounts is keyed by species, so the species IS the ledger's
        // name for this steed. Without it the world census counts the adopted row and the ledger
        // entry it came from as two mounts, and the cap refuses honest players early.
        mintAsset("mount", wallet, { sp, kind: "mount", luid: sp }, origin);
        ownedSp.add(sp); adopted.push(sp); _mountsAdopted++;
      } catch (e) {
        // A PER-SPECIES refusal must not end the loop. `break` was written for the one failure that
        // existed (registry capacity — "adopt what fits"), and a species-scoped throw arriving at
        // the same catch silently cost the wallet every OTHER steed it owns.
        if (e && e.code === "SUPPLY_EXHAUSTED") continue;
        break;   // capacity: adopt what fits — the rest stays ledger-known and retries next sync
      }
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
        // `luid` is the DEDUP KEY: the ledger's own uid for the creature this row adopts, so the
        // world census counts one creature rather than one per record source.
        mintAsset("chikimon", wallet, { sp, kind: String(u.kind || "normal").slice(0, 12), lvl: 1, luid: uid }, origin);
        ownedSp.add(sp); adopted.push(sp); _chikisAdopted++;
      } catch (e) {
        // per-species refusal skips that creature only; capacity ends the pass (see mounts/sync)
        if (e && e.code === "SUPPLY_EXHAUSTED") continue;
        break;   // capacity: adopt what fits — the rest stays ledger-known and retries next sync
      }
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
// ONLY AN ACCOUNT THAT EXISTED WHEN THE WIPE HAPPENED CAN HAVE BEEN WIPED.
// `prog` rides in the client-authored save, so the arithmetic above reads numbers the player writes:
// a crafted push of eggmake_*=9 / hatch_*=0 answered `owed:["normal","legendary","meme","mount"]`
// and minted four registry eggs — one of them a CAPPED Meme Dynasty edition and one a CAPPED mount —
// on a wallet created seconds earlier (measured, hatching_consume_sim.mjs R5). The one-shot is per
// wallet, so it was unlimited across wallets.
//
// The discriminator is a clock the SERVER wrote and a new wallet cannot have: players.first_seen,
// INSERTed the first time an address reaches /verify. The seal-floor wipe ran 2026-07-27 18:41 UTC
// to 2026-07-28 00:10 UTC, so every genuine victim's account already existed by the END of that
// window; anyone first seen after it cannot have lost an egg to it. Every real victim is still paid
// in full — this refuses the throwaway wallet, not the make-good.
const EGG_WIPE_END_MS = Date.UTC(2026, 6, 28, 0, 10);   // 2026-07-28 00:10 UTC — grace restored
async function restitutionEligibleFirstSeen(wallet) {
  let fs = _testFirstSeen.get(wallet) || 0;
  if (!fs) { try { fs = Number(await store.firstSeen(wallet)) || 0; } catch (e) { fs = 0; } }
  return fs;
}

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
  // the same account-age gate the claim enforces, so nobody is shown a number they cannot collect
  const fsG = await restitutionEligibleFirstSeen(w);
  if (!fsG || fsG >= EGG_WIPE_END_MS) owed = [];
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
  // AN ACCOUNT THE SERVER FIRST SAW AFTER THE WIPE CANNOT HAVE BEEN WIPED (see EGG_WIPE_END_MS).
  // A DB that cannot answer is retryable rather than refused-forever, and the one-shot is untouched.
  const fs = await restitutionEligibleFirstSeen(wallet);
  if (!fs) return res.status(503).json({ error: "could not confirm when this account was first seen — try again shortly" });
  if (fs >= EGG_WIPE_END_MS) {
    return res.status(403).json({ error: "this account was first seen after the 2026-07-27 incident, so nothing was lost from it", firstSeen: fs });
  }

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

// AZULON'S PRICE, MIRRORED SERVER-SIDE (Econ.gd SCROLL_TRADE — one of every catchable fantasy fish
// plus 230 units of gathered material). It had NO server mirror at all: the route checked
// AVATARS_MAX and atSupplyCap and nothing else, so 40 throwaway keypairs holding nothing minted 80
// supply-capped avatars in 111 ms, and ~875 signed-in wallets could permanently exhaust the entire
// 1750-slot scroll-reachable avatar supply. mintAsset never deletes and grandfathering is absolute,
// so every slot taken that way is denied to an honest player forever.
//
// The MATERIAL half is enforceable today and is enforced. THE FANTASY FISH HALF IS NOT, for exactly
// the reason the egg route gives: the shipped client's cast report carries no rod or spot tier, so
// the witnessed ffish book is empty for honest players. It therefore sits behind the same _ffishAuth
// flag, and turning that flag on is one decision for both routes.
const SCROLL_RECIPE_FISH = Object.freeze({ rainbow_fish: 1, mystic_eel: 1, crystal_koi: 1, golden_chikifish: 1 });
const SCROLL_RECIPE_MATS = Object.freeze({ gold: 12, iron: 18, crystal: 20, wood: 50, stone: 40,
                                           berries: 30, honey: 12, seashell: 20, hide: 10, essence: 18 });
const SCROLL_REDEEM_MIN_MS = 5000;      // the egg route's floor; a human bartering cannot beat it
const _lastScrollRedeem = new Map();
app.post("/assets/scroll/redeem", (req, res) => {
  if (!_assetsReady) return res.status(503).json({ error: "asset registry is still loading" });
  const wallet = regWallet(req);
  if (!wallet) return res.status(403).json({ error: "prove this wallet first" });
  const held = regOwned(wallet, "avatar");
  if (held.length >= AVATARS_MAX) return res.status(409).json({ error: "you already carry two looks" });
  const nowS = Date.now();
  if (nowS - (_lastScrollRedeem.get(wallet) || 0) < SCROLL_REDEEM_MIN_MS) return res.status(429).json({ error: "too fast" });
  const have = new Set(held.map(a => a.sp));
  // the ceremony look every player is awarded is theirs whether or not it was ever registered
  const pool = AVATAR_IDS.filter(a => !have.has(a) && a !== "classic");
  if (!pool.length) return res.status(409).json({ error: "no looks left" });
  // CAN THIS WALLET AFFORD AZULON'S PRICE? Same fail-open policy as the egg claim: while the book is
  // still loading the barter is allowed through, because refusing on missing data strands a real
  // player. Nothing is taken until the avatar exists.
  if (_ffishAuth && _ownEnforce && _ownReady) {
    for (const f of Object.keys(SCROLL_RECIPE_FISH)) {
      const haveF = ownAvailable(wallet, "ffish", f);
      if (haveF < SCROLL_RECIPE_FISH[f]) {
        _ownRefusals++;
        return res.status(409).json({
          error: `Azulon asks for the four sparks — ${SCROLL_RECIPE_FISH[f]} ${f.replace(/_/g, " ")}, and Chikoria has recorded you catching ${Math.max(0, haveF)}.`,
          need: SCROLL_RECIPE_FISH[f], have: Math.max(0, haveF), fish: f,
        });
      }
    }
  }
  let _chargeS = false;
  if (_ownEnforce && _ownReady) {
    for (const m of Object.keys(SCROLL_RECIPE_MATS)) {
      const haveM = ownAvailableForIssue(wallet, "mat", m);   // issuance reads the strict allowance
      if (haveM < SCROLL_RECIPE_MATS[m]) {
        _ownRefusals++;
        return res.status(409).json({
          error: `Azulon weighs your offering and the mist stays shut — you need ${SCROLL_RECIPE_MATS[m]} ${m}, and Chikoria has recorded you acquiring ${Math.max(0, haveM)}.`,
          need: SCROLL_RECIPE_MATS[m], have: Math.max(0, haveM), mat: m,
        });
      }
    }
    _chargeS = true;   // every ingredient cleared — nothing is taken until the avatar EXISTS
  } else if (_ownEnforce && !_ownReady) {
    _ownSkipped++;
  }
  _lastScrollRedeem.set(wallet, nowS);
  if (_lastScrollRedeem.size > 5000) {
    let _d = 250;
    for (const k of _lastScrollRedeem.keys()) { if (_d-- <= 0) break; _lastScrollRedeem.delete(k); }
  }
  let row;
  const availA = pool.filter((a) => !atSupplyCap("avatar", a));
  if (!availA.length) return res.status(409).json({ error: "every avatar of the looks you lack has been claimed" });
  try { row = mintAsset("avatar", wallet, { sp: availA[crypto.randomInt(availA.length)], kind: "avatar" }, "scroll"); }
  catch (e) { return res.status(503).json({ error: "the asset registry is at capacity — this is a server fault, not yours; nothing was consumed" }); }
  // charged after the mint, for the same reason the egg claim is: a capacity fault must never take
  // material and then answer "nothing was consumed"
  if (_chargeS) {
    for (const m of Object.keys(SCROLL_RECIPE_MATS)) ownDebit(wallet, "mat", m, SCROLL_RECIPE_MATS[m]);
    if (_ffishAuth) for (const f of Object.keys(SCROLL_RECIPE_FISH)) ownDebit(wallet, "ffish", f, SCROLL_RECIPE_FISH[f]);
  }
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
                  hatchedTo, lvl: Number(src.lvl) || undefined, chain,
                  // the census dedup key, re-typed like everything else — a row that adopted a
                  // ledger entry must keep saying so, or the restart double-counts that creature
                  luid: src.luid ? String(src.luid).slice(0, 32) : undefined };
    assetReg.set(id, row); ownerSet(owner).add(id); n++;
  }
  censusInvalidate();
  return n;
}
// test seams for the meme cap sim: mint a creature exactly as an in-game egg hatch does, and set
// the paid-sale tally, so the two routes can be exercised independently
export function _mintAssetForTest(type, wallet, fields, origin) { return mintAsset(type, wallet, fields, origin); }
export function _setMemeMintedForTest(key, n) { memeMinted[key] = n; censusInvalidate(); }
export function _clearAssetReg() { assetReg.clear(); assetsByOwner.clear(); eggRestitutionDone.clear(); censusInvalidate(); }
// the WHOLE truth about one species: the consolidated count and where every number came from
export function _trueIssued(type, sp) { return trueIssued(type, sp); }
export function _censusStats() { return { builds: _censusBuilds, keys: censusAll().size }; }
// test seam: age an egg past its incubation window without waiting real hours
export function _ageAsset(id, ms) { const r = assetReg.get(id); if (r) { r.born -= ms; return true; } return false; }
export function _transferAssetForTest(id, from, to, why) { return transferAsset(id, from, to, why); }
// test seam: the two per-wallet rate maps in this region, so a sim can prove they are BOUNDED
// without minting five thousand real wallets
export function _issueRateMapsForTest() { return { egg: _lastEggClaim, scroll: _lastScrollRedeem }; }
// test seams: fill the registry to its cap, force an auction to end, and backdate a wallet's
// first-seen — all three model conditions a sim cannot otherwise reach (capacity, a 12h auction
// clock, and a player who predates this system).
export function _fillAssetRegForTest() {
  while (assetReg.size < ASSET_REG_MAX) assetReg.set("pad" + assetReg.size, { id: "pad", type: "chikimon", state: "consumed", chain: [] });
  censusInvalidate();
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
// The acquisition bound's opening balance keys off prev._serverSavedAt, which the server writes
// itself and a test therefore cannot produce by simply saving. Same seam pattern as above.
export async function _setServerSavedAtForTest(w, ts) {
  const pr = await store.getProfile(w);
  if (!pr) return 0;
  pr._serverSavedAt = Number(ts) || 0;
  await store.setProfile(w, pr);
  return pr._serverSavedAt;
}
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
          eggs: Object.create(null), avatars: Object.create(null), eggsLast: null, unverified: 0 };
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
  // AVATARS — CENSUS ONLY, never flagged. Recorded so the dex can report how many of each look are
  // actually out there; deliberately NOT graded into origins and NOT capable of raising a flag.
  // An avatar is cosmetic (its perk converts to materials, but it cannot itself be listed or sold),
  // and the honest ways to get one — the onboarding ceremony, the roulette, an Azulon scroll — leave
  // no delta evidence the inference could read. Grading them would manufacture "unverified" noise
  // against players who did nothing wrong, which is the one thing this ledger must never do.
  const allAv = Array.isArray(mmo.avatars) ? mmo.avatars : [];
  if (allAv.length > 40) flagLater.push(`overflow:avatars:${allAv.length}`);
  let newAvatars = 0;
  for (const a of allAv.slice(0, 40)) {
    const id = String(a).slice(0, 24);
    if (!id || has(rec.avatars, id)) continue;
    rec.avatars[id] = { ts: now };
    newAvatars++;
  }
  // the look they are WEARING counts too — a ceremony avatar can be worn without ever being listed
  const worn = String(mmo.avatar || "").slice(0, 24);
  if (worn && !has(rec.avatars, worn)) { rec.avatars[worn] = { ts: now }; newAvatars++; }

  if (eggGlut) flag(`eggglut:${eggsNow}`);
  for (const why of flagLater) flag(why);
  if (newUnits || newMounts || newAvatars || flagged.length) _assetsDirty = true;

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
  censusInvalidate();   // this save may have added, or released (held=false), a creature the world census counts
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
                  avatars: Object.create(null),
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
    // avatars are census-only, so there is no origin to re-type and nothing here can raise a flag
    const sa = (src.avatars && typeof src.avatars === "object") ? src.avatars : {};
    for (const id of Object.keys(sa).filter(k => has(sa, k)).slice(0, 40)) {
      rec.avatars[String(id).slice(0, 24)] = { ts: Number((sa[id] || {}).ts) || rec.first };
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
    // MATERIALS ONLY, the same rule the flow tallies below already enforce and the same rule
    // recordGather now enforces on the way in. Without it a blob carrying junk keys came back and
    // the 40-key truncation could evict a wallet's real counts.
    for (const k of Object.keys(e[1]).filter(k => has(e[1], k)).slice(0, 40)) {
      if (!MAT_IDS.has(k)) continue;
      const n = Number(e[1][k]); if (Number.isFinite(n) && n > 0) g[String(k).slice(0, 24)] = n;
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
  censusInvalidate();   // a restored ledger is a different world than the empty one that preceded it
  return n;
}
const ORIGINS = new Set(["legacy", "hatched", "purchased", "issued", "traded", "restitution", "unverified"]);

// test seams: empty the ledger, and AGE a wallet's eggs so a sim can prove the incubation floor in
// both directions without waiting 12 real hours for a legendary.
// clears EVERY per-wallet tally this module owns — a seam that misses one leaves a sim with dirty
// state that silently invalidates its assertions, so new tallies must be added here too
export function _clearAssetLedger() { assetLedger.clear(); assetBuys.clear(); gatherCount.clear(); matSpent.clear(); matGained.clear(); raidClaim.clear(); _assetsReady = true; censusInvalidate(); }
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
async function saveAssetLedger(strict = false) {
  if (_assetsFlush) return _assetsFlush;          // re-entry joins the write already running
  if (!_assetsDirty || !_assetsReady) return;
  _assetsDirty = false;
  _assetsFlush = (async () => {
    try {
      // The REGISTRY goes first. It holds minted assets that exist nowhere else — losing a row
      // destroys a player's property, which the ledger (a derived record) can never do.
      await store.kvSet("asset_registry", serializeAssetReg());
      await store.kvSet("asset_ledger", serializeAssetLedger());
    } catch (e) { _assetsDirty = true; if (strict) throw e; }          // a failed write must not silently drop the record
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

// ============ SERVER-SIMULATED MOVEMENT — CHIK_PHYS, ON BY DEFAULT ============
// The whole of world_physics.js hangs off this flag. ON by default since THE FLIP (2026-08-01):
// a relay client (coords, no inputs) is still served untouched — its presence row keeps the claimed
// numbers, nothing simulates it, the reply merely gains a `phys` echo — so the deployed fleet keeps
// working forever while input-sending clients are simulated and judged. CHIK_PHYS=0 is the kill
// switch: NOTHING below runs, no terrain is loaded, no state is kept, no field is added to any
// reply, and /world/move relays the client's position exactly as it always has.
// NO TERRAIN, NO PHYSICS. world_terrain fails PERMISSIVE by design (surfaceHeight returns sea level
// when the file is absent, so it can never refuse a player), which is right for a lookup and
// catastrophic for an authority: every ground test would put the island's floor at 6.0, lifting
// anyone in a valley and blocking nothing. island_data.bin is 7 MB and lives in the CLIENT project,
// so a deploy that sets CHIK_PHYS=1 without vendoring it is a plausible accident. Make it a no-op
// instead of a wrong answer.
const _physWanted = String(process.env.CHIK_PHYS ?? "") !== "0";   // default ON; "0" is the kill switch
const _physTerrain = _physWanted ? loadTerrain() : null;
const PHYS_ON = _physWanted && !!(_physTerrain && _physTerrain.ok);
const physStates = new Map();      // wallet -> world_physics state (only while PHYS_ON)
let _physCorrections = 0, _physDrops = 0, _physTeleports = 0, _physResyncs = 0;
if (_physWanted) {
  console.log(PHYS_ON
    ? `server physics ON (CHIK_PHYS default-on) — terrain ${terrainInfo().w}x${terrainInfo().h} from ${terrainInfo().source}`
    : `server physics REFUSED TO START: CHIK_PHYS is on (the default) but island_data.bin was not found, so movement stays a pure relay and no player is judged. FIX, pick one: (1) vendor island_data.bin next to server.js — the deploy repo ships it, so a missing file means the deploy did not copy it; (2) set CHIK_ISLAND_BIN=/absolute/path/to/island_data.bin; (3) set CHIK_PHYS=0 to choose relay mode deliberately. Tried ${JSON.stringify(_physTerrain && _physTerrain.tried)}`);
}
export function _physStatsForTest() {
  return { on: PHYS_ON, states: physStates.size, corrections: _physCorrections, drops: _physDrops, teleports: _physTeleports, resyncs: _physResyncs };
}
export function _physStateForTest(wallet) { return physStates.get(wallet) || null; }
export function _physGrantTeleportForTest(wallet, x, y, z, reason) {
  const st = physStates.get(wallet); if (!st) return null;
  return PhysMod.grantTeleport(st, x, y, z, Date.now(), reason || "test");
}

// A position-only client never says what it is doing, so the mode is INFERRED from the fields it
// already broadcasts: `mount` is on the wire today (it has to be — remotes render the steed). There
// is no sail flag anywhere in the wire, which is why a non-declaring client's hard ceiling is
// floored at the boat's 70 u/s: mistaking a sailor for a walker would correct an honest player at
// full speed, and that is the one failure this design must never have.
function physModeOf(b, st) {
  const m = String(b.mount || "");
  if (m === "griffin") return "fly";
  if (m) return "mount";
  return st && st.driven ? st.mode : "foot";
}
// "spec" is the CREATOR free-fly: 420 u/s and no collision at all (Player.gd:466-481). The client
// gates it on d["creator"], which is a client-side flag on a hostile client, so the ceiling has to be
// re-earned here. isAdminWallet is the same rule /world/roster and the toolbox routes use.
const physSpecOk = (wallet) => { try { return isAdminWallet(wallet); } catch (e) { return false; } };
function physStateFor(wallet, x, y, z, dir, nowMs) {
  let st = physStates.get(wallet);
  if (!st) { st = PhysMod.newState(x, y, z, dir, nowMs); physStates.set(wallet, st); }
  return st;
}
// Runs INSIDE worldMoveApply, after the coordinates are clamped and rounded and before the row is
// built. Returns the position the row should actually store.
function physApply(wallet, b, x, y, z, dir) {
  const now = Date.now();
  const st = physStateFor(wallet, x, y, z, dir, now);
  st.mode = physModeOf(b, st);
  if (Number.isFinite(+dir)) st.dir = +dir;
  // ---- 1. INPUTS. One frame or a batch; a malformed frame is dropped, never fatal. ----
  const raw = Array.isArray(b.inputs) ? b.inputs.slice(0, 16) : (b.input ? [b.input] : []);
  const allowSpec = physSpecOk(wallet);
  if (st.mode === "spec" && !allowSpec) st.mode = "foot";   // a sticky mode from before the gate
  for (const f of raw) {
    const inp = PhysMod.sanitizeInput(f, st, { allowSpec });
    if (!inp) { st.drops = (st.drops || 0) + 1; _physDrops++; continue; }
    st.mode = inp.mode;
    Object.assign(st, PhysMod.advance(st, inp, inp.dt, now).state);
    st.input = inp; st.inputMs = now; st.driven = true;
  }
  // ---- 2. THE CLAIM. Old clients send only this; new ones send it as well, and it is what the
  //         simulation is resynced to whenever it is plausible.
  //         A body with NO coordinates at all is a pure-input client and must not be reconciled:
  //         clampF turns a missing x into 0, and "reconciling" against the origin would correct
  //         every one of them, every ping, into the middle of the sea. ----
  const claims = b.x !== undefined || b.z !== undefined;
  const r = claims ? PhysMod.reconcile(st, { x, y, z }, now, {
    soft: !!st.driven,                                   // no inputs => no model => nothing to compare
    minSpeed: st.driven ? 0 : PhysMod.PHYS.BOAT,         // see physModeOf
  }) : { action: "derived" };
  st.lastAction = r.action;
  if (r.action === "correct") _physCorrections++;
  else if (r.action === "teleport") _physTeleports++;
  else if (r.action === "resync") _physResyncs++;
  // A RESYNC hands back the POSITION and withholds the PAYOUT. It fires only after STUCK_MS of
  // unbroken refusals, i.e. exactly when the alternative is leaving an honest player's presence row
  // stranded where every value route can see it (measured: 12 consecutive corrections left a row
  // 235 u behind, permanently). The stand-down is longer than world_physics' own resync cooldown, so
  // a client that forces resyncs deliberately never gets a window in which a gather would settle.
  return { x: Math.round(st.x * 100) / 100, y: Math.round(st.y * 100) / 100, z: Math.round(st.z * 100) / 100,
           action: r.action, holdMs: r.action === "resync" ? PhysMod.TUNE.RESYNC_HOLD_MS : 0 };
}
// What the mover is told about itself. `undefined` when the flag is off, so JSON.stringify omits the
// key entirely and the reply is byte-identical to today's.
function physWire(wallet) {
  if (!PHYS_ON) return undefined;
  const st = physStates.get(wallet);
  if (!st) return undefined;
  const w = PhysMod.snapshotOf(st);
  if (st.lastAction === "correct") w.corr = 1;      // snap to this; the model refused your claim
  return w;
}
// THE 20 Hz ADVANCE. Everyone the server is simulating moves whether or not they just spoke, so
// peers see continuous motion between a mover's 280 ms reports instead of a stair-step. A player who
// stops sending stops steering (world_physics INPUT_TTL) but keeps falling, so nobody hangs in
// mid-air. Time-based, so calling it twice in the same millisecond grants no extra distance.
function physTickAll(now = Date.now()) {
  if (!PHYS_ON) return 0;
  let n = 0;
  for (const [w, st] of physStates) {
    const p = worldPlayers.get(w);
    if (!p || now - p.ts > WORLD_TTL_MS) { physStates.delete(w); continue; }
    if (!st.driven) continue;                       // a position-relay client is not simulated
    Object.assign(st, PhysMod.tickPlayer(st, now));
    p.x = Math.round(st.x * 100) / 100;
    p.y = Math.round(st.y * 100) / 100;
    p.z = Math.round(st.z * 100) / 100;
    p.dir = Math.round(st.dir * 1000) / 1000;
    n++;
  }
  return n;
}
if (PHYS_ON) setInterval(() => { try { physTickAll(); } catch (e) {} }, 50).unref?.();

// ============ ONE MOVE HANDLER, TWO TRANSPORTS ============
// The body of /world/move lives here as a plain function because a WebSocket now carries the same
// contract (see attachWorldSocket at the bottom of the file). It is a FUNCTION, not a second copy:
// the warp/speed stamp, the seq ordering rule, the presence claim, the coordinate rounding and the
// reply assembly all have exactly one implementation, so the two transports cannot drift apart —
// and drift here would be invisible, because both would keep "working" while disagreeing about the
// world. Returns {code, body, wallet, proven} instead of touching res, so it has no idea which
// transport called it.
function worldMoveApply(b) {
  const wallet = b.wallet;
  if (!isPresenceId(wallet)) return { code: 400, body: { error: "valid wallet required" }, wallet: "", proven: false };
  // PUPPETEERING: anyone can read a wallet off /world/roster, so a bare wallet cannot own a
  // presence slot. But a hard gate here is wrong: a real player has a wallet id the moment they
  // sign in, a beat BEFORE /verify returns their token, and freezing them in place for that window
  // is worse than the bug. So the slot is CLAIMED instead — once a proven caller owns it, only a
  // proven caller may move it. An unproven caller can still take an unclaimed slot (a player
  // mid-sign-in, or a net_id) but can never seize one that is already proven.
  const held = worldPlayers.get(wallet);
  const iAmProven = presenceOk(wallet, b);
  if (held && held.proven && !iAmProven) {
    return { code: 403, body: { error: "that trainer is signed in — prove this wallet first" }, wallet, proven: false };
  }
  // PIPELINED MOVES: the client may now keep two requests in flight, and TCP does not promise the
  // second POST arrives second. A monotonically increasing per-session `seq` decides which body is
  // newest; a stale one must NOT overwrite the row (position would step backwards for every peer),
  // but its reply is still useful — the snapshot is read fresh either way. seq is optional: an older
  // client sends none and behaves exactly as before.
  const seq = Number.isFinite(+b.seq) ? Math.max(0, Math.floor(+b.seq)) : null;
  if (seq !== null && held && Number.isFinite(held.seq) && seq <= held.seq) {
    return { code: 200, wallet, proven: iAmProven,
             body: worldMoveReply({ ok: true, stale: true, seq }, wallet, held.x, held.z, b.dl, b.fs, iAmProven) };
  }
  // Presence coords are rounded AT STORE TIME: they arrive as float32 noise (15 significant digits
  // for a 1-unit-per-voxel world) and every extra digit is paid for on EVERY snapshot to every peer.
  // 2dp on x/y/z is sub-visible; dir stays at 3dp because Net.gd lerp_angles it and coarser steps
  // are visible on slow turns. This touches the wire/presence row ONLY — never the save or economy.
  const x = Math.round(clampF(b.x, -100000, 100000, 0) * 100) / 100;   // 2dp
  const z = Math.round(clampF(b.z, -100000, 100000, 0) * 100) / 100;   // 2dp
  const y = Math.round(clampF(b.y, -1000, 100000, 0) * 100) / 100;     // 2dp — height: without it every remote was ground-snapped and nobody could be seen jumping
  // The row is REPLACED wholesale every ping, so anything that must survive has to be carried over:
  // `seen` is this caller's delta memory. `sq` is derived from the FINISHED row rather than a parallel
  // copy — an earlier draft rebuilt the static fields separately with subtly different clamps, which
  // would have made every ping look like a change and silently turned the delta back into a full send.
  const _prev = worldPlayers.get(wallet);
  // ============ IS THAT A PLACE YOU COULD HAVE GOT TO? ============
  // /world/move clamped x/z to +/-100000 and rounded to 2dp and did NOTHING else — no previous
  // position, no dt, no speed term anywhere in the handler. So a wallet teleported between all 24
  // monster spawns in 10.2 s (largest accepted single jump: 913.9 units) and claimed 24/24 kills
  // with zero refusals, taking the whole island's kill reward and denying it to everyone actually
  // standing there. Every reach check in the file — node claims, mob strikes, the raid gate — is
  // measured against this row, so a row that can be anywhere makes all of them decorative.
  //
  // IT DOES NOT REFUSE THE MOVE, AND THAT IS DELIBERATE. Chikoria teleports honest players: the
  // drowning rescue drops you at the Healing Center and travel points warp you (Player.gd's drown
  // rescue and _travel), both with a client-side _tp_grace. Refusing or snapping would rubber-band a
  // real player at exactly those moments. Instead the row is STAMPED, and the two routes that turn
  // presence into value — the node claim and the monster kill — stand down for WARP_HOLD_MS. You may
  // teleport; you may not bank a gather or a kill you teleported into.
  //
  // The ceiling is generous on purpose: the fastest thing in the game is the boat at 70 u/s
  // (Player.gd boat_speed), against run_speed 18 and the griffin's ride multiplier, so 110 u/s plus
  // 60 units of slack absorbs latency, a lag spike and a dropped ping without ever touching honest
  // movement. dt is clamped to a 10 s ceiling so a long gap does not hand out an unlimited budget.
  //
  // THE ALLOWANCE IS A BANK, NOT A PER-PING CONSTANT — and this is the correction of a LIVE hole,
  // not a refinement. `WARP_MAX_UPS * dt + WARP_SLACK` grants a fresh 60 units of free jump to every
  // MESSAGE, and nothing rate-limits POST /world/move, so the whole stamp was bypassed simply by
  // sending more of them: measured on the deployed build (`_av_phys_preexist_sim.mjs`), 19 hops of
  // 65 u carried a wallet 1200 units in 0.04 s with ZERO warps stamped, and the node claim at the far
  // end answered `200 ["wood"]`. Sustained: 37,143 u/s. The stand-down that node claims, monster
  // kills and the raid gate all depend on simply never armed.
  // The bank fills at exactly WARP_MAX_UPS per second of wall clock and is spent by the distance
  // moved, so an honest player never notices it (a boat at 70 u/s spends 0.18 s of bank per 0.28 s
  // report and sits at the cap forever; ten coalesced reports cost 0.7 s of a 2.5 s bank) while an
  // attacker is held to WARP_MAX_UPS whatever their message rate. The one-shot allowance is
  // 110 * 2.5 = 275 u — TIGHTER than the old rule already gave for any gap over 2 s (at dt 10 s the
  // old rule allowed 1160 u in a single ping).
  // A PURE-INPUT CLIENT CLAIMS NO COORDINATES, so there is no jump to measure: clampF defaults its
  // x/z to 0, and measuring the "jump" to the ORIGIN stamped a warp on every input-only ping — an
  // honest CHIK_PHYS client was permanently stood down from every gather (measured in
  // stage3_actions_sim before this guard). Only a body that CLAIMS a position can look like a
  // teleport, and for input-driven clients physApply below stamps its own warp on every implausible
  // claim. Guarded on PHYS_ON so the deployed relay fleet (which always claims coordinates, and
  // where a coordinate-less body really did mean "you moved to 0,0") is byte-identical to today.
  const _claims = b.x !== undefined || b.z !== undefined;
  let _warp = _prev ? _prev.warp : 0;
  let _wbank = WARP_BANK_S;
  if (_prev && Number.isFinite(_prev.x) && (_claims || !PHYS_ON)) {
    const _el = Math.max(0, (Date.now() - (_prev.ts || Date.now())) / 1000);
    _wbank = Math.min(WARP_BANK_S, (Number.isFinite(_prev.wbank) ? _prev.wbank : WARP_BANK_S) + _el);
    const _jump = Math.hypot(x - _prev.x, z - _prev.z);
    if (_jump > WARP_MAX_UPS * _wbank) { _warp = Date.now(); _warpPings++; _wbank = 0; }
    else _wbank = Math.max(0, _wbank - _jump / WARP_MAX_UPS);
  }
  // ============ THE SERVER'S OWN ANSWER (CHIK_PHYS) ============
  // With the flag off these three are the client's numbers, unchanged, and physApply is never
  // called — so the row, the reply and the wire are byte-identical to what ships today.
  let px = x, py = y, pz = z;
  if (PHYS_ON) {
    const _pr = physApply(wallet, b, x, y, z, Math.round(clampF(b.dir, -7, 7, 0) * 1000) / 1000);
    px = _pr.x; py = _pr.y; pz = _pr.z;
    // A corrected claim is also an implausible one: stand the value routes down exactly as a warp
    // does, so nobody banks a gather or a kill on a position the server just refused.
    if (_pr.action === "correct" || _pr.action === "teleport") _warp = Date.now();
    // A RESYNC gives the position back after STUCK_MS of refusals, so it must withhold value for
    // longer than a client can force another one. The value routes compare `now - warp < WARP_HOLD_MS`,
    // so a warp stamped in the FUTURE is simply a longer stand-down — 16 s here against
    // world_physics' 15 s resync cooldown, i.e. an attacker who resyncs on a timer never owns a
    // moment in which a gather, a kill or a raid claim would settle.
    else if (_pr.action === "resync") _warp = Date.now() + Math.max(0, (_pr.holdMs || 0) - WARP_HOLD_MS);
  }
  const _row = {
    proven: iAmProven,
    warp: _warp,                          // last implausible jump — read by the two value routes
    wbank: _wbank,                        // unspent reach budget in seconds — internal, never on the wire
    seen: _prev ? _prev.seen : undefined,
    vis: _prev ? _prev.vis : undefined,   // interest-radius hysteresis memory — must survive the row replace

    x: px, y: py, z: pz, dir: Math.round(clampF(b.dir, -7, 7, 0) * 1000) / 1000,   // 3dp — do NOT round coarser (yaw stepping)
    handle: stripTags(String(b.handle || "Trainer")).slice(0, 20),
    leg: clampF(b.leg, 0, 20, 14) | 0,                 // companion species index
    el: stripTags(String(b.el || "Fire")).slice(0, 10),
    avatar: stripTags(String(b.avatar || "classic")).slice(0, 20),   // player's chosen look → remote renders the real rig
    comp: stripTags(String(b.comp || "")).slice(0, 24),              // player's lead chikimon → remote renders it beside them
    party: String(b.party || "").split(",").filter(Boolean).slice(0, 3).map(s => stripTags(String(s)).slice(0, 24)).join(","),
    mount: stripTags(String(b.mount || "")).slice(0, 16),   // the steed they ride ("" = on foot)
    act: stripTags(String(b.act || "")).slice(0, 24),      // what they're DOING ("chop:axe") -> remotes play it
    // The caravan of incubating eggs the trainer tows. It renders beside the local player and had no
    // wire field at all, so to everyone else their carts simply did not exist. Comma-joined kinds,
    // capped at 4 (the client nests one of each kind) and whitelisted to real kinds — this string is
    // fed straight into a model lookup on every other client.
    eggs: String(b.eggs || "").split(",").filter(Boolean).slice(0, 4)
      .filter((k) => ["normal", "legendary", "meme", "mount"].includes(k)).join(","),
    spr: !!b.spr,                                          // actually sprinting, vs inferred from speed
    br: clampF(b.br, 1, 50, 1) | 0,   // companion LEVEL (cap 50) — not the Cup 1..30 BR
    seq: seq !== null ? seq : (_prev && Number.isFinite(_prev.seq) ? _prev.seq : undefined),
    ts: Date.now(),
  };
  _row.sq = bumpStaticSeq(_prev, _row);   // advances ONLY when a static field really changed
  worldPlayers.set(wallet, _row);
  // The shared world rides the reply the client is ALREADY making, so co-op costs zero extra requests
  // and zero extra round trips. An older client ignores the field; a pristine island makes it empty.
  return { code: 200, wallet, proven: iAmProven,
           body: worldMoveReply({ ok: true, seq: seq !== null ? seq : undefined }, wallet, px, pz, b.dl, b.fs, iAmProven) };
}
// THE reply builder — used by the POST, by the socket's move ack, and by the socket tick. One copy,
// so "what a client is told about the world" has a single definition. `base` carries the
// transport/ordering fields (ok/seq/stale, or the socket's frame tag) and is mutated in place so the
// JSON key order stays exactly what /world/move has always emitted.
function worldMoveReply(base, wallet, x, z, dl, fs, iAmProven) {
  base.players = worldSnapshot(wallet, x, z, !!dl, true);
  base.online = worldPlayers.size;
  base.mobs = _worldTickOn ? mobSnapshot(Date.now()) : undefined;
  base.event = fishEventActive() ? { mult: _fishEvent.mult, ends: _fishEvent.ends, label: _fishEvent.label } : undefined;
  // PROVEN CALLERS ONLY. The presence slot is CLAIMED, not owned (see the puppeteering
  // note above): an unproven caller may still take an UNCLAIMED slot — which is what a
  // wallet's row becomes ~12 s after they close the tab. That is tolerable for a
  // position, but the party field is a ROSTER: it names who a trainer is grouped with,
  // their leader, and every member's island-wide coordinates. Anyone can read a wallet
  // off /world/roster, so without this gate a stranger POSTs the lapsed slot and is
  // handed the group. presenceOk is the same rule the party routes use — a net_id
  // stands alone, a public wallet must present its /verify token, which the shipped
  // client sends on EVERY move (Net.gd's move POST), so no honest player loses the field.
  base.party = iAmProven ? partyWire(wallet) : undefined;   // members only, max 4 rows, island-wide — the ONE interest bypass
  base.feed = worldFeedSince(fs);
  // WHERE THE SERVER THINKS *YOU* ARE, plus the last input sequence it has consumed. undefined while
  // CHIK_PHYS is off, and JSON.stringify drops undefined keys, so the reply keeps its exact shape.
  base.phys = physWire(wallet);
  return base;
}
app.post("/world/move", (req, res) => {
  const r = worldMoveApply(req.body || {});
  res.status(r.code).json(r.body);
});

// ============ THE WEBSOCKET WORLD TRANSPORT — ADDITIVE, NEVER A REPLACEMENT ============
// Every client in the wild right now speaks HTTP: POST /world/move every 280 ms on two pipelined
// lanes, snapshot rides the reply. That keeps working EXACTLY as it does today — this block adds a
// second door onto the same room. Nothing above this line changed behaviour; worldMoveApply and
// worldMoveReply are the same functions the POST runs.
//
// WHAT IT BUYS: on HTTP a change waits for the next poll, so propagation is measured at p50 143 ms /
// p95 275 ms — most of which is poll wait, not network. A push tick removes the wait term.
// WHAT IT COSTS: a tick is unconditional, so a socket receives ~5.6x more snapshots per second than
// a poller. That is the trade, and it is measured in ws_transport_sim.mjs rather than assumed.
//
// If the upgrade fails, the socket drops, or CHIK_WS=0 refuses it, the client simply keeps polling.
// No route, no field and no timing above depends on a socket existing.
const WS_ON = String(process.env.CHIK_WS ?? "") !== "0";
const WS_PATH = "/ws/world";
// 20 Hz = 50 ms. WHY 20: the client interpolates remotes 0.45 s in the past (Net.gd INTERP_DELAY),
// so anything that lands inside that buffer is invisible as lag; 50 ms is a fifth of the 280 ms poll
// period it replaces, which turns the dominant term in the measured p95 (poll wait) into noise.
// Going faster spends bandwidth on samples the interpolator will never show — the wire cost is
// linear in the rate and the snapshot is ~300 bytes PER PEER ROW, so 60 Hz in a crowded square is
// three times the bytes for zero visible difference. Going slower re-introduces the wait it exists
// to delete. Tunable for load testing via CHIK_WS_HZ, clamped to something sane.
const WS_TICK_HZ = Math.min(60, Math.max(1, Number(process.env.CHIK_WS_HZ) || 20));
const WS_TICK_MS = Math.max(1, Math.round(1000 / WS_TICK_HZ));
const WS_MAX_PAYLOAD = 16 * 1024;   // an inbound move is ~300 bytes; anything near this is not a client
const WS_MSG_BURST = 40;            // inbound messages/second per socket — the HTTP client makes ~7
const WS_BACKPRESSURE = 256 * 1024; // skip a tick for a socket this far behind rather than grow the heap
// ============ THE THREE BOUNDS THAT MAKE A PUSH TRANSPORT SAFE TO EXPOSE ============
// A POST is self-limiting: one request buys one snapshot, so an attacker's egress is capped by
// their own upload. A TICK is not. Measured (`_av_ws_load_sim.mjs`, out-of-process server and
// out-of-process attacker, against the rows-only control): 200 anonymous sockets, each sending ONE
// ~300-byte move every 10 s to stay inside WORLD_TTL_MS, pulled **27.4 MiB/s of egress from 6 KB/s
// of upload** — x89 what the identical 200 clients got over HTTP — and dragged an honest HTTP
// poller's p95 from 3.3 ms to 12.8 ms. 400 sockets: 54.7 MiB/s and 14.0 ms. The control (the same
// 200 presence rows made over HTTP, no sockets) measured 3.3 ms, i.e. presence-map growth costs
// nothing and every byte of that is the socket. None of it needs a wallet, a token or a signature.
//
//  1. WS_MAX_SOCKETS — an absolute ceiling. Over it the upgrade is refused exactly the way the
//     CHIK_WS=0 kill switch refuses it, and the client falls back to polling. This can only deny
//     an OPTIMISATION, never the game: a refused player plays on HTTP, which is what 100% of the
//     fleet does today. Deliberately NOT a per-IP cap — Render terminates TLS and proxies, so
//     remoteAddress is the proxy for everyone (a per-IP cap would break honest play) and
//     x-forwarded-for is client-writable (a cap keyed on a rotatable identity is not a cap).
//  2. WS_AUTH_GRACE_MS — a socket that never gets a move ACCEPTED is closed. Connecting is free
//     and was otherwise permanent: an idle socket also pinned the 20 Hz timer forever, which is
//     precisely what the "the tick only exists while someone is listening" note exists to avoid.
//  3. WS_MOVE_IDLE_MS — the stream follows the client's own cadence. Net.gd sends every 280 ms and
//     drops its socket after 600 ms of silence (WS_SILENCE), so 4 s is 14x the honest cadence and
//     strictly more permissive than the client's own watchdog: no honest player can reach it. It
//     turns "one message buys WORLD_TTL_MS x 20 Hz = 240 snapshots" into "buys 80", and makes the
//     attacker's egress proportional to their upload instead of free.
const WS_MAX_SOCKETS = Math.max(0, Math.min(20000, Number(process.env.CHIK_WS_MAX ?? 250)));   // 0 = unlimited (load tests only)
// > Render's measured 4.9-5.1 s cold start AND the client's own 8 s WS_CONNECT_TIMEOUT, so a socket
// that is merely slow to get going is never inside this. Swept every 5 s, so the real close lands
// between GRACE and GRACE+5 s. Env-tunable so a sim can prove the sweep without waiting 30 s.
const WS_AUTH_GRACE_MS = Math.max(1000, Number(process.env.CHIK_WS_GRACE_MS) || 30000);
const WS_MOVE_IDLE_MS = Math.max(1000, Number(process.env.CHIK_WS_IDLE_MS) || 4000);   // stop PUSHING to a socket this quiet; never closes it, the next move re-arms it
// ============ TRANSPORT COMPRESSION — permessage-deflate, OFF BY DEFAULT ============
// MEASURED, not argued (wire_bytes_sim.mjs, on real captured frames with real 44-char base58
// wallets): consecutive 20 Hz snapshots are nearly identical, so a deflate stream WITH CONTEXT
// TAKEOVER gets 93.9%/95.3% (12-peer/60-peer) — more than every hand-rolled JSON trick COMBINED
// (39.8%) and more than a packed binary wire (88%), for one option object and zero client change.
// Without context takeover the same deflate only manages 54.7%/67.5%, so the streaming context IS
// the win and `serverNoContextTakeover` must stay false.
//
// WHY THIS IS THE ONE COMPRESSION LEVER LEFT. Measured read-only against the live host: HTTP
// replies already come back `content-encoding: gzip` from the Cloudflare edge (/world/players 590 ->
// 374 B, /health 484 -> 355 B) even though this origin sends none — so the poll transport is ALREADY
// compressed on the last mile and origin gzip would only save the Render->edge leg. Cloudflare does
// not compress WebSocket frames. The socket is the only uncompressed hop a player actually sees.
//
// WHY IT IS OFF BY DEFAULT ANYWAY — two costs, both measured:
//  * RAM. ~330 KiB RSS per socket for the deflate+inflate context pair (_wire_zmem_child.mjs), i.e.
//    80.7 MiB at WS_MAX_SOCKETS 250 in a bare process. Nobody has read RSS on the deployed dyno, so
//    WS_DEFLATE_MAX bounds it independently of WS_MAX_SOCKETS: sockets past the ceiling are handed
//    to a second, extension-less WS.Server and behave EXACTLY as they do today. Compression can
//    therefore never be the reason the 251st player fails to connect.
//  * The proxy. The extension is negotiated end to end; if Cloudflare ever forwarded the offer but
//    stripped the accept, a compressing server would talk RSV1 at a browser that is not expecting
//    it. That is survivable (the client's _ws_fail hands the world back to polling) but it would
//    silently disable the socket for the fleet, so the flip is a deliberate, observable act:
//    _wsStatsForTest().deflate.negotiated counts sockets that actually agreed on it.
// CPU is NOT a reason to hesitate: 60 sockets x 9.5 KB is 0.466 ms p50 / 0.781 ms p95 per tick,
// 0.9% of the 50 ms budget, because `ws` runs zlib on the libuv threadpool. Added frame latency,
// honest one-in-flight ping-pong: +0.070 ms p50.
const WS_DEFLATE_ON = String(process.env.CHIK_WS_DEFLATE ?? "") !== "0";   // default ON since THE FLIP; "0" kills
const WS_DEFLATE_MAX = Math.max(0, Math.min(20000, Number(process.env.CHIK_WS_DEFLATE_MAX ?? 120)));  // 0 = no ceiling
// Below this many bytes `ws` sends the frame UNCOMPRESSED (RSV1 clear) and does not touch the
// stream context. The move ack — the one latency-critical frame, it carries the `phys` verdict — is
// p50 66 B, so it stays out of the compressor entirely at this setting. Nothing is lost: a 66 B
// frame has nothing to give.
const WS_DEFLATE_THRESHOLD = Math.max(0, Number(process.env.CHIK_WS_DEFLATE_MIN ?? 256));
const WS_DEFLATE_LEVEL = Math.min(9, Math.max(1, Number(process.env.CHIK_WS_DEFLATE_LEVEL ?? 6)));
const WS_DEFLATE_MEMLEVEL = Math.min(9, Math.max(1, Number(process.env.CHIK_WS_DEFLATE_MEMLEVEL ?? 8)));
// ============ TICK DEDUPE — do not push a frame that says nothing new. ON BY DEFAULT (=0 kills) ============
// A tick is unconditional today: a socket sitting in an empty field is handed 20 byte-identical
// snapshots a second. This suppresses a tick frame that is identical to the last one that socket
// RECEIVED, comparing with `a` (the per-row sample age, the only field that moves on its own)
// normalised out.
//
// WHY THIS IS SAFE FOR THE CLIENT AND ROW-LEVEL SUPPRESSION IS NOT. Dropping a ROW makes the peer
// absent from the snapshot, and Net.gd `_mark_unseen` HIDES a remote the instant it is absent
// (grace only decides when it is freed) — so suppressing unchanged rows would make every standing
// player invisible on every client in the wild. Dropping the WHOLE FRAME is invisible to that
// mechanism: the client is not told anything, so it concludes nothing. The client's own silence
// watchdog (WS_SILENCE 0.6 s) is fed by the IMMEDIATE MOVE ACK, which is sent synchronously on
// every one of its 280 ms moves and is never deduped — 2.1x headroom that does not depend on the
// tick at all.
//
// WHAT IT CANNOT DO: help a crowded square. With K peers each reporting every 280 ms, ~K*50/280 rows
// change per 50 ms tick, so at K=30 a frame is essentially never identical. It targets the idle
// case, not the plaza.
//
// AND IT IS NOT A DoS BOUND — READ THIS BEFORE RAISING WS_MAX_SOCKETS. Both flags were benchmarked
// against an attacker that HELPS them: one that offers permessage-deflate and parks 250 sockets on
// fixed coordinates. That attacker's egress falls 29.7 -> 0.04 MiB/s (x3572 -> x5). An adversary
// makes the other two choices — decline the extension (one constructor flag) and STAGGER the same
// 3.5 s move cadence across the sockets so one peer moves every 14 ms — and the same 250 sockets
// measure (_av_lw_dos_sim.mjs, both profiles in one run, in-process rig identical to
// latency_wins_sim.mjs PHASE D):
//     today 33.46 MiB/s x3700 | deflate 33.46 x3706 (ZERO effect) | dedupe 23.61 x2598 | both 23.38 x2575
// So the real reduction under attack is ~30%, not 99.9%, deflate contributes nothing at all, and
// dedupe COSTS cpu when it cannot suppress (42% -> 49% of a core at 250 sockets). The bound that
// actually holds an attacker is still WS_MAX_SOCKETS + WS_MOVE_IDLE_MS, exactly as before. Neither
// flag buys headroom to raise the socket ceiling.
//
// SIDE-EFFECT SAFETY: building a reply advances the receiver's `seen`/`vis` delta memory and the
// feed cursor. A frame that consumed any of that CANNOT be identical to the previous one (a newly
// delivered static makes the row full, a lost/regained peer changes the row set, a pushed headline
// adds `feed`), so a suppressed frame is by construction one that consumed nothing.
// A CONFIGURED EXTENSION CAN REFUSE AN UPGRADE THAT IS ACCEPTED TODAY, AND THAT IS THE ONE WAY THIS
// FLAG COULD HURT A REAL PLAYER. `ws` (7.5.11, websocket-server.js:242-251) parses
// Sec-WebSocket-Extensions and calls PerMessageDeflate.accept ONLY when the server was configured
// with perMessageDeflate; if either throws it answers `abortHandshake(socket, 400)` — the WHOLE
// upgrade, not just the extension. And `serverNoContextTakeover: false` below means "refuse any
// offer that asks for no-context-takeover", which is a legal RFC 7692 offer a proxy may add.
// MEASURED (_av_lw_attack_sim.mjs section D, flags-off vs flags-on side by side): four headers that
// answer 101 today answer 400 with the flag on — `server_max_window_bits=99`, a duplicated
// parameter, an unknown parameter, and `server_no_context_takeover`.
// So the offer is screened here and anything outside the shape `ws` is certain to accept goes to
// the PLAIN server, i.e. exactly today's behaviour. Deliberately an ALLOW-LIST: an offer nobody
// recognises must degrade to no compression, never to no socket. Real browser offers
// (`permessage-deflate`, `permessage-deflate; client_max_window_bits`) are inside it.
function deflateOfferSafe(req) {
  const h = String((req && req.headers && req.headers["sec-websocket-extensions"]) || "");
  if (!h) return true;                                  // no offer at all — nothing to negotiate
  if (h.length > 512) return false;                     // not a client, and ws's parser would throw
  for (const offer of h.split(",")) {
    const parts = offer.split(";").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return false;                    // empty element — ws's parse() throws
    if (parts[0].toLowerCase() !== "permessage-deflate") continue;   // some other extension: ws ignores it
    const seen = new Set();
    for (const p of parts.slice(1)) {
      const eq = p.indexOf("=");
      const k = (eq < 0 ? p : p.slice(0, eq)).trim().toLowerCase();
      const v = eq < 0 ? "" : p.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (seen.has(k)) return false;                    // duplicate parameter — ws's parse() throws
      seen.add(k);
      if (k === "client_no_context_takeover") { if (v !== "") return false; continue; }
      if (k === "client_max_window_bits" || k === "server_max_window_bits") {
        if (v === "" && k === "server_max_window_bits") return false;   // must carry a value
        if (v !== "" && !(Number(v) >= 8 && Number(v) <= 15 && /^\d+$/.test(v))) return false;
        continue;
      }
      return false;   // server_no_context_takeover, or anything unrecognised
    }
  }
  return true;
}
const WS_DEDUPE_ON = String(process.env.CHIK_WS_DEDUPE ?? "") !== "0";   // default ON since THE FLIP; "0" kills
const WS_AGE_RE = /"a":-?\d+(\.\d+)?/g;   // safe: JSON.stringify escapes quotes, so `"a":` cannot occur inside a string value
const wsClients = new Set();
let _wsFrames = 0, _wsBytes = 0, _wsTicks = 0, _wsCpuUs = 0, _wsJitMax = 0, _wsJitSum = 0, _wsJitN = 0, _wsLastTick = 0, _wsIv = null;
let _wsRefused = 0, _wsIdleSkips = 0, _wsGraceClosed = 0, _wsDupSkips = 0, _wsDupBytes = 0, _wsDeflating = 0;
// Observability + the sim's measuring stick. Never returns anything a client sent.
export function _wsStatsForTest() {
  return { on: WS_ON, path: WS_PATH, hz: WS_TICK_HZ, tickMs: WS_TICK_MS, max: WS_MAX_SOCKETS,
           sockets: wsClients.size, authed: [...wsClients].filter(w => w._chik && w._chik.wallet).length, ticking: !!_wsIv,
           frames: _wsFrames, bytes: _wsBytes, ticks: _wsTicks, cpuUs: _wsCpuUs,
           refused: _wsRefused, idleSkips: _wsIdleSkips, graceClosed: _wsGraceClosed,
           dupSkips: _wsDupSkips, dupBytes: _wsDupBytes,
           deflate: { on: WS_DEFLATE_ON, max: WS_DEFLATE_MAX, threshold: WS_DEFLATE_THRESHOLD,
                      level: WS_DEFLATE_LEVEL, memLevel: WS_DEFLATE_MEMLEVEL, negotiated: _wsDeflating },
           dedupe: WS_DEDUPE_ON,
           jitterMaxMs: _wsJitMax, jitterAvgMs: _wsJitN ? _wsJitSum / _wsJitN : 0 };
}
export function _wsResetStatsForTest() {
  _wsFrames = 0; _wsBytes = 0; _wsTicks = 0; _wsCpuUs = 0; _wsJitMax = 0; _wsJitSum = 0; _wsJitN = 0; _wsLastTick = 0;
  _wsRefused = 0; _wsIdleSkips = 0; _wsGraceClosed = 0; _wsDupSkips = 0; _wsDupBytes = 0;
}
function wsSend(ws, obj) {
  if (ws.readyState !== 1) return 0;
  const s = JSON.stringify(obj);
  ws.send(s);
  _wsFrames++; _wsBytes += s.length;
  return s.length;
}
// The tick's send. Identical to wsSend when CHIK_WS_DEDUPE is unset — same JSON, same counters —
// so the OFF path is the shipped path. Only the tick uses this; the move ack never does, because
// the ack is what feeds the client's silence watchdog and carries the `phys` verdict.
function wsSendTick(ws, st, obj) {
  if (ws.readyState !== 1) return 0;
  const s = JSON.stringify(obj);
  if (WS_DEDUPE_ON) {
    const key = s.replace(WS_AGE_RE, '"a":0');
    if (key === st.lastKey) { _wsDupSkips++; _wsDupBytes += s.length; return 0; }
    st.lastKey = key;
  }
  ws.send(s);
  _wsFrames++; _wsBytes += s.length;
  return s.length;
}
// THE TICK. Per socket it produces the SAME object /world/move would have returned to that receiver
// right now — same worldSnapshot (so the same interest radius, the same nearest-60 cap and the same
// per-receiver sq/dl delta memory, which lives on the receiver's presence row and is therefore
// SHARED with its HTTP polls), the same mobSnapshot, the same party gate, the same feed cursor.
function wsTick() {
  const now = Date.now();
  // jitter = how far this tick landed from WS_TICK_MS after the last one. Measured on the tick
  // itself, not on a parallel timer, so it includes the cost of the tick's own work.
  if (_wsLastTick) { const d = Math.abs(now - _wsLastTick - WS_TICK_MS); _wsJitSum += d; _wsJitN++; if (d > _wsJitMax) _wsJitMax = d; }
  _wsLastTick = now;
  // Advance the simulation before sampling it, so a socket frame carries this tick's position rather
  // than the last one's. No-op unless CHIK_PHYS=1, and time-based, so the standalone 20 Hz interval
  // doing the same thing costs nothing here.
  physTickAll(now);
  const cpu0 = process.cpuUsage();
  for (const ws of wsClients) {
    const st = ws._chik;
    // AN UNAUTHENTICATED SOCKET RECEIVES NOTHING. `wallet` is set only by an accepted move, i.e. by
    // exactly the checks the POST runs (isPresenceId + the proven-slot claim). There is no weaker
    // socket-only path: a hijacked socket can do precisely what a forged POST can do, no more.
    if (!st || !st.wallet || ws.readyState !== 1) continue;
    if (ws.bufferedAmount > WS_BACKPRESSURE) continue;
    // THE STREAM FOLLOWS THE CLIENT'S CADENCE. Presence alone (WORLD_TTL_MS, 12 s) is far too loose
    // a licence to push at 20 Hz: it let one ~300-byte message buy 240 snapshots, which is the whole
    // of the measured x89 egress amplification. Net.gd sends every 280 ms and kills its own socket
    // after 600 ms of silence, so a real player is never within an order of magnitude of this bound.
    // It does not close the socket and does not clear the wallet — the next accepted move re-arms it,
    // so a client that stalls and recovers simply resumes.
    if (now - (st.lastMove || 0) > WS_MOVE_IDLE_MS) { _wsIdleSkips++; continue; }
    const p = worldPlayers.get(st.wallet);
    // Presence lapsed (they stopped sending moves, or the TTL sweep took the row) — a socket does not
    // keep a trainer alive that a poller would have let expire.
    if (!p || now - p.ts > WORLD_TTL_MS) { st.wallet = ""; continue; }
    // Re-derive proof EVERY tick from the stored credential rather than caching a bool: a market
    // token can rotate under us (a re-/verify), and the party roster must stop the moment it does.
    const proven = presenceOk(st.wallet, st.auth);
    if (p.proven && !proven) {   // someone proven now owns the slot — the same 403 the POST gives
      st.wallet = ""; wsSend(ws, { t: "err", code: 403, error: "that trainer is signed in — prove this wallet first" });
      continue;
    }
    const body = worldMoveReply({ t: "world" }, st.wallet, p.x, p.z, st.dl, st.fs, proven);
    // Advance the feed cursor by what we actually pushed, so the next tick does not repeat a headline.
    // The client's own `fs` still governs its move acks, exactly as it does over HTTP.
    // A HEADLINE IS NEVER DEDUPED. The cursor advances here, before the send, so a suppressed frame
    // would eat the headline for good. In practice a feed-bearing frame can never equal the previous
    // one (the cursor guarantees the previous frame did not carry the same rows), but the loss is
    // permanent if that reasoning is ever wrong, so the bypass is explicit rather than derived.
    if (body.feed && body.feed.length) {
      for (const r of body.feed) if (r.t > st.fs) st.fs = r.t;
      st.lastKey = "";
      wsSend(ws, body);
    } else {
      wsSendTick(ws, st, body);
    }
  }
  const cpu = process.cpuUsage(cpu0);
  _wsCpuUs += cpu.user + cpu.system;
  _wsTicks++;
}
function attachWorldSocket(server) {
  // The upgrade is handled explicitly (noServer) for two reasons: a path that is not ours must be
  // closed rather than left hanging (once ANY upgrade listener exists, Node stops auto-destroying),
  // and CHIK_WS=0 must answer with a real refusal instead of a reset.
  const wss = WS_ON ? new WS.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false }) : null;
  // THE SECOND SERVER EXISTS ONLY TO BOUND MEMORY. `perMessageDeflate` is a WS.Server option, not a
  // per-connection one, so the only way to stop compressing past a socket count is to hand the
  // upgrade to a server that does not offer the extension. `wss` above is that server — it is the
  // one every socket uses today and the one every socket past WS_DEFLATE_MAX still uses. Nothing
  // about the ceiling can refuse a connection; it can only decline an optimisation.
  // maxPayload is set on BOTH: `ws` enforces it on the INFLATED size as well, which is what stops a
  // small compressed inbound frame expanding into a heap bomb. Proven in the sim, not assumed.
  const wssZ = (WS_ON && WS_DEFLATE_ON) ? new WS.Server({
    noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false,
    perMessageDeflate: {
      // serverNoContextTakeover MUST stay false — the streaming context is the entire win
      // (93.9-95.3% with it, 54.7-67.5% without). clientNoContextTakeover is true because the
      // inbound direction is 3.57 moves/s of ~300 B, where the context buys nothing and costs RAM.
      serverNoContextTakeover: false,
      clientNoContextTakeover: true,
      threshold: WS_DEFLATE_THRESHOLD,
      zlibDeflateOptions: { level: WS_DEFLATE_LEVEL, memLevel: WS_DEFLATE_MEMLEVEL },
      concurrencyLimit: 10,
    },
  }) : null;
  server.on("upgrade", (req, socket, head) => {
    const path = String(req.url || "").split("?")[0];
    if (path !== WS_PATH) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    if (_draining === true) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\n\r\n");
      socket.destroy(); return;
    }
    if (!WS_ON) {   // the kill switch: the endpoint does not exist, and the client falls back to polling
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nX-Chik-Ws: off\r\n\r\n");
      socket.destroy(); return;
    }
    // THE CEILING. Refused in exactly the shape the kill switch uses, because that shape is the one
    // the client is already proven to survive: connect_to_url succeeds, the handshake does not, the
    // peer leaves STATE_CONNECTING without reaching STATE_OPEN and _ws_fail() hands the world back
    // to polling on the next frame. Refusing here can therefore only cost a player the OPTIMISATION.
    if (WS_MAX_SOCKETS > 0 && wsClients.size >= WS_MAX_SOCKETS) {
      _wsRefused++;
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nX-Chik-Ws: full\r\nRetry-After: 30\r\n\r\n");
      socket.destroy(); return;
    }
    // Compress only while under the ceiling, only for a client that offered the extension, and only
    // when the offer is one the compressing server is CERTAIN to accept — `ws` decides the second,
    // deflateOfferSafe the third. A Godot native WebSocketPeer (measured: offers nothing) lands on
    // the compressing server and still gets an uncompressed stream. Both paths reach the same
    // wsOpen; the socket's own `extensions` is what says which one it got.
    const useZ = wssZ && (WS_DEFLATE_MAX === 0 || _wsDeflating < WS_DEFLATE_MAX) && deflateOfferSafe(req);
    (useZ ? wssZ : wss).handleUpgrade(req, socket, head, (ws) => wsOpen(ws));
  });
  if (WS_ON) {
    // A half-open TCP connection (laptop lid, dead wifi) never fires 'close'. Ping; a socket that
    // misses two rounds is terminated. Presence is unaffected either way — the TTL owns that.
    const hv = setInterval(() => {
      for (const ws of wsClients) {
        const st = ws._chik;
        if (st && st.dead) { try { ws.terminate(); } catch {} continue; }
        if (st) st.dead = true;
        try { ws.ping(); } catch {}
      }
    }, 30000); hv.unref?.();
    // The grace sweep gets its OWN timer rather than riding the heartbeat: the heartbeat's 30 s
    // cadence IS the liveness rule (two missed pongs = dead), and shortening it to make the grace
    // tighter would quietly halve how long a lossy link is tolerated. Two cheap unref'd timers.
    // NEVER AUTHENTICATED = closed. Opening a socket costs an attacker one TCP connection and
    // nothing else; without this a socket that says nothing lives forever, occupies a
    // WS_MAX_SOCKETS slot, and (through wsLoopSync) pins the 20 Hz timer that is supposed to exist
    // only while someone is listening. `authed` is stamped by the first ACCEPTED move, so this
    // closes only sockets that never presented anything the POST would have accepted either.
    const gv = setInterval(() => {
      const now = Date.now();
      for (const ws of wsClients) {
        const st = ws._chik;
        if (st && !st.authed && now - (st.born || 0) > WS_AUTH_GRACE_MS) { _wsGraceClosed++; try { ws.terminate(); } catch {} }
      }
    }, 5000); gv.unref?.();
    console.log(`world socket on ${WS_PATH} · ${WS_TICK_HZ}Hz · max ${WS_MAX_SOCKETS || "unlimited"}`
      + ` · deflate ${WS_DEFLATE_ON ? `ON (max ${WS_DEFLATE_MAX || "unlimited"}, >=${WS_DEFLATE_THRESHOLD}B, L${WS_DEFLATE_LEVEL}/M${WS_DEFLATE_MEMLEVEL})` : "off"}`
      + ` · dedupe ${WS_DEDUPE_ON ? "ON" : "off"}`);
  } else {
    console.log(`world socket DISABLED (CHIK_WS=0) — clients fall back to /world/move polling`);
  }
}
// THE TICK ONLY EXISTS WHILE SOMEONE IS LISTENING. No shipped client speaks WebSocket yet, so an
// always-on 20Hz timer would be pure waste on a free-tier dyno that is otherwise idle between polls
// — and a permanently busy event loop is exactly what stops Render spinning a service down.
// Started by the first socket, stopped by the last. The loop still spins for a connected-but-silent
// socket (measured: ONE such socket produced 29 ticks in 1.5 s and zero frames) — that is why the
// grace sweep closes an unauthenticated socket rather than leaving it to sit there.
function wsLoopSync() {
  if (WS_ON && wsClients.size > 0 && !_wsIv) { _wsIv = setInterval(wsTick, WS_TICK_MS); _wsIv.unref?.(); _wsLastTick = 0; }
  else if (wsClients.size === 0 && _wsIv) { clearInterval(_wsIv); _wsIv = null; _wsLastTick = 0; }
}
function wsOpen(ws) {
  // `pmd` is read from the socket, never assumed from the flag: the client has to have offered the
  // extension for it to be there. It is the only honest count of what compression is actually doing.
  const pmd = String(ws.extensions || "").includes("permessage-deflate");
  ws._chik = { wallet: "", auth: null, dl: 0, fs: 0, dead: false, msgs: 0, win: 0,
               born: Date.now(), authed: false, lastMove: 0, lastKey: "", pmd };
  if (pmd) _wsDeflating++;
  wsClients.add(ws);
  wsLoopSync();
  ws.on("pong", () => { if (ws._chik) ws._chik.dead = false; });
  ws.on("error", () => { try { ws.terminate(); } catch {} });
  // A DROPPED SOCKET CLEARS PRESENCE THE WAY A STOPPED POLL DOES: it stops refreshing `ts`, and
  // WORLD_TTL_MS (12 s) sweeps the row. Deleting it here instead would make a transport switch
  // (socket → poll, or a reconnect) visibly pop the trainer out of everyone's world for a frame.
  ws.on("close", () => { if (ws._chik && ws._chik.pmd) { ws._chik.pmd = false; _wsDeflating = Math.max(0, _wsDeflating - 1); } wsClients.delete(ws); wsLoopSync(); });
  ws.on("message", (raw) => {
    const st = ws._chik; if (!st) return;
    const now = Date.now();
    if (now - st.win > 1000) { st.win = now; st.msgs = 0; }
    if (++st.msgs > WS_MSG_BURST) return;   // drop, don't close — a lagging client bursting is not an attack
    let m; try { m = JSON.parse(String(raw)); } catch { wsSend(ws, { t: "err", error: "bad json" }); return; }
    if (!m || typeof m !== "object") { wsSend(ws, { t: "err", error: "bad frame" }); return; }
    const kind = String(m.t || "move");
    if (kind === "ping") { wsSend(ws, { t: "pong", ts: now }); return; }
    if (kind !== "move") { wsSend(ws, { t: "err", error: "unknown frame" }); return; }
    // SAME VALIDATION AS THE POST — literally the same function. Warp stamp, seq ordering, presence
    // claim, coordinate rounding, delta memory: one implementation, so the transports cannot disagree.
    const r = worldMoveApply(m);
    if (r.code !== 200) {
      st.wallet = ""; st.auth = null;                        // a refused move de-authenticates the socket
      wsSend(ws, { t: "err", code: r.code, error: r.body && r.body.error });
      return;
    }
    st.wallet = r.wallet;
    st.auth = { wallet: r.wallet, mktToken: String(m.mktToken || "") };   // re-checked every tick
    st.authed = true;              // survived the grace sweep: this socket presented an accepted move
    st.lastMove = now;             // arms WS_MOVE_IDLE_MS — the push follows the client's own cadence
    st.dl = m.dl ? 1 : 0;
    const fs = Number(m.fs) || 0; if (fs > st.fs) st.fs = fs;
    if (r.body.feed) for (const row of r.body.feed) if (row.t > st.fs) st.fs = row.t;   // don't re-push what the ack carried
    // THE ACK IS NEVER DEDUPED, and it invalidates the tick's memory. Two reasons, both structural:
    // it is the frame that feeds the client's WS_SILENCE watchdog (0.6 s, one ack per 280 ms move —
    // so the watchdog does not depend on the tick at all), and it carries the `phys` verdict. Zeroing
    // lastKey means a tick can only ever be suppressed against a state the client received FROM A
    // TICK, so the ack can never leave the client holding a value the next tick then withholds.
    st.lastKey = "";
    // The ack IS the HTTP reply. Byte-for-byte the same object the POST would have returned for this
    // body, plus the frame tag — ws_transport_sim.mjs asserts that field by field against a live POST.
    wsSend(ws, Object.assign({ t: "move" }, r.body));
  });
}
// Read-only: nearby online trainers (for spectators / light polling). Deliberately WIDE
// (WORLD_RADIUS, no interest filter): a spectator wants the island view, not a render bubble.
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
// THE WORLD TICK. Every other interval in this file is housekeeping — flush a ledger, prune a map.
// This one advances the world: a monster killed anywhere comes back for everyone when its clock runs
// out, whether or not a single client is polling. One second is plenty for a 90 s respawn and it costs
// O(dead mobs), so a quiet island costs nothing.
setInterval(() => { try { worldMobTick(Date.now()); } catch (e) {} }, 1000).unref?.();

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
  // PARTY CHAT: to:"party" fans the message out to every member's whisper inbox — one store, one
  // delivery loop, all the DM hardening for free. "party" can never collide with a real recipient:
  // it is 5 chars and isPresenceId requires 6+.
  if (to === "party") {
    const pid = partyOf.get(String(b.wallet)), p = pid ? parties.get(pid) : null;
    if (!p) return res.status(409).json({ error: "you are not in a party" });
    const ptext = stripTags(String(b.text || "")).slice(0, 200).trim();
    if (!ptext) return res.json({ ok: true });
    const pfrom = String(b.wallet), pHandle = stripTags(String(b.handle || "Trainer")).slice(0, 20);
    const pmsg = { from: pfrom, fromHandle: pHandle, to: "party", pid, text: ptext, ts: Date.now() };
    for (const w of p.members) {
      const inbox = dmInbox(w);
      inbox.push(w === pfrom ? { ...pmsg, self: true } : pmsg);
      if (inbox.length > 200) inbox.shift();
    }
    saveWorldDM();
    return res.json({ ok: true });
  }
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

// ============ PARTY REGISTRY ============
// Small opt-in co-op groups, max 4 trainers. The server owns the roster; the client only renders
// it. NOTHING ECONOMIC moves through a party — no shared loot, no shared XP, no gather changes.
// It is a social contract plus exactly ONE wire privilege: members see each other's coordinates
// island-wide in the /world/move reply (the single deliberate interest-radius bypass, members
// only, capped at PARTY_MAX rows). Auth is presenceOk, exactly like /world/dm: a net_id stands
// alone (so demo players may party — no value moves), a public wallet must present the /verify
// market token, because wallets are published in /world/roster and cannot be their own credential.
const PARTY_MAX = 4;
const PARTY_INVITE_MIN_MS = 2000;             // per-inviter rate cap (the chat-cap shape, line ~1745)
// A PER-INVITER cap is not a spam bound, because the inviter is a self-asserted net_id: an attacker
// rotates `wallet` and pays nothing. Measured (_av_party_attack_sim.mjs A9): 260 invites from 260
// fresh ids in 419 ms, zero refused, and because an invite is delivered as a DM into the victim's
// 200-row inbox ring it EVICTED ALL FIVE of their real whispers. So the real bound is on the
// RECIPIENT: at most this many unanswered invites may be sitting in one trainer's inbox at a time.
// Past that the route refuses BEFORE writing anything, so an invite flood can never cost a player
// their whisper history. (The same flood through /world/dm still can — that route is older than
// this feature and takes no invite path; see the audit note.)
// The window is DELIBERATELY much shorter than PARTY_INVITE_TTL_MS. Declining is purely local (the
// client collapses the line; there is no /party/decline), so counting across the full 10-minute TTL
// would let a griefer spend five requests to lock a trainer out of every legitimate invite for ten
// minutes — trading a flood for a targeted denial. One minute bounds the flood just as well and an
// honest inviter is never refused for long.
const PARTY_INVITE_MAX_PENDING = 5;
const PARTY_INVITE_PEND_MS = 60000;
const PARTY_INVITE_MAX = 20000;               // the invite map itself must not be an unbounded write
// Second half of the same guarantee: even at the capped rate, invites accumulate, and the inbox is a
// 200-row ring. Shifting the head to make room spends a REAL WHISPER on an invite nobody asked for,
// so an invite evicts the oldest INVITE instead, and falls back to the head only when it is the
// only row there is. Whisper history can therefore never be destroyed through this route.
function pushInvite(inbox, msg) {
  inbox.push(msg);
  if (inbox.length <= 200) return;
  const k = inbox.findIndex(m => m && m.kind === "pinv" && m !== msg);
  inbox.splice(k >= 0 ? k : 0, 1);
}
const PARTY_INVITE_TTL_MS = 10 * 60 * 1000;   // an unanswered invite dies after 10 minutes
const PARTY_DEAD_MS = 5 * WORLD_TTL_MS;       // every member's presence expired for this long → disband
const parties = new Map();      // id -> { members: [presenceId..PARTY_MAX], leader, created, deadSince? }
const partyOf = new Map();      // presenceId -> party id (reverse index — DERIVED, never persisted alone)
const partyInvites = new Map(); // "from|to" -> { pid, ts }  pid = inviter's party AT ISSUE TIME (null = none yet)
const _lastInvite = new Map();  // inviter -> ts of last accepted invite POST (rate cap)
function newPartyId() { return "pty_" + crypto.randomBytes(12).toString("hex"); }   // server-minted, unguessable
// ONE kv blob. partyOf is reconstructed from it on restore, so the two maps can never disagree
// after a restart — same reasoning as sidOwner/walletSid being persisted as a pair.
function serializeParties() { return [...parties.entries()].map(([id, p]) => ({ id, members: p.members, leader: p.leader, created: p.created })); }
// A restored blob is an UNTRUSTED INPUT — it comes back from a database a future bug or an admin
// could have corrupted, so every invariant the live routes enforce is re-enforced here, on the way
// IN (the restoreWorldNodes rule). The one that matters is ONE PARTY PER ID: partyOf can only hold
// a single pid, so an id listed by two parties becomes a GHOST MEMBER of the party partyOf does not
// point at — it keeps receiving that party's private chat and /party/leave (which works through
// partyOf) can never get it out. Duplicate ids inside one row are the same bug in miniature: they
// eat a slot and deliver every party message twice.
const PARTY_MAX_ROWS = 20000;   // a corrupt blob must not be an unbounded allocation
function restoreParties(v) {
  parties.clear(); partyOf.clear();
  if (!Array.isArray(v)) return;
  for (const e of v) {
    if (!e || typeof e.id !== "string" || !e.id || !Array.isArray(e.members)) continue;
    if (parties.size >= PARTY_MAX_ROWS) break;
    if (parties.has(e.id)) continue;                         // duplicate id — first row wins
    const members = [];
    for (const w of e.members) {
      if (!isPresenceId(w)) continue;
      if (members.includes(w) || partyOf.has(w)) continue;   // dup inside the row / already claimed
      members.push(w);
      if (members.length >= PARTY_MAX) break;
    }
    if (members.length < 2) continue;                        // a party is at least two people
    const leader = members.includes(e.leader) ? e.leader : members[0];
    parties.set(e.id, { members, leader, created: Number(e.created) || Date.now() });
    for (const w of members) partyOf.set(w, e.id);
  }
}
store.kvGet("world_parties").then(v => { if (!parties.size) restoreParties(v); }).catch(() => {});
function saveParties() { store.kvSet("world_parties", serializeParties()).catch(() => {}); }
function disbandParty(pid) {
  const p = parties.get(pid); if (!p) return;
  for (const w of p.members) if (partyOf.get(w) === pid) partyOf.delete(w);
  parties.delete(pid);
}
function partyRemove(pid, who) {
  const p = parties.get(pid); if (!p) return;
  p.members = p.members.filter(w => w !== who);
  if (partyOf.get(who) === pid) partyOf.delete(who);
  if (p.members.length < 2) disbandParty(pid);        // auto-disband — a solo "party" is nobody's group
  else if (p.leader === who) p.leader = p.members[0]; // leadership passes to the longest-standing member
  saveParties();
}
// TTL sweep, the WORLD_TTL_MS pattern: a party whose EVERY member has lost presence is dead — but
// only after the whole group has been gone PARTY_DEAD_MS, so a page reload (12 s presence TTL)
// doesn't nuke the group. deadSince is in-memory only: a restart restarts the clock, which is the
// point — persisted parties must survive a deploy, when nobody has presence yet.
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const [pid, p] of parties) {
    const anyLive = p.members.some(w => { const pr = worldPlayers.get(w); return pr && now - pr.ts <= WORLD_TTL_MS; });
    if (anyLive) { if (p.deadSince) delete p.deadSince; continue; }
    if (!p.deadSince) { p.deadSince = now; continue; }
    if (now - p.deadSince > PARTY_DEAD_MS) { disbandParty(pid); dirty = true; }
  }
  if (dirty) saveParties();
  for (const [k, inv] of partyInvites) if (now - inv.ts > PARTY_INVITE_TTL_MS) partyInvites.delete(k);
}, 10000).unref?.();
// The ONE deliberate interest-radius bypass: "where is my group" is the whole point of a party, so
// members get each other's coordinates island-wide, riding the /world/move reply they already make.
// Members only, max PARTY_MAX rows, coordinates + handle only — never inventory, never the static
// half. Absent entirely for partyless players (undefined → dropped by JSON), and it is a TOP-LEVEL
// reply field, never part of STATIC_KEYS (the peer-row "party" static is the chikimon party string
// — an unrelated field that happens to share the word).
function partyWire(id) {
  const pid = partyOf.get(id);
  if (!pid) return undefined;
  const p = parties.get(pid);
  if (!p) { partyOf.delete(id); return undefined; }
  const now = Date.now(), m = [];
  for (const w of p.members) {
    const pr = worldPlayers.get(w);
    if (!pr || now - pr.ts > WORLD_TTL_MS) continue;   // offline member — no coordinates to share
    m.push({ w, h: pr.handle || "Trainer", x: pr.x, z: pr.z });
  }
  return { id: pid, leader: p.leader, m };
}
app.post("/party/invite", (req, res) => {
  const b = req.body || {}, from = String(b.wallet || "");
  if (!isPresenceId(from)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(from, b)) return res.status(403).json({ error: "prove this wallet first" });
  const to = String(b.to || "");
  if (!isPresenceId(to)) return res.status(400).json({ error: "valid recipient required" });
  if (to === from) return res.status(400).json({ error: "you cannot invite yourself" });
  const now = Date.now();
  if (now - (_lastInvite.get(from) || 0) < PARTY_INVITE_MIN_MS) return res.status(429).json({ error: "slow down — invites are rate-limited" });
  const pid = partyOf.get(from) || null;
  if (pid) {
    const p = parties.get(pid);
    if (!p) partyOf.delete(from);
    else if (p.members.length >= PARTY_MAX) return res.status(409).json({ error: "party is full" });
  }
  // RECIPIENT-SIDE BOUND — the one an id-rotating flood cannot walk around. Counted off the
  // recipient's own inbox (their SENT echoes carry self:true and are skipped, or a trainer who
  // invites five friends could not be invited back), newest-first with an early exit, so it is a
  // handful of array reads on a ring that is already capped at 200.
  const nowBox = worldDM.get(to) || [];
  let pend = 0;
  for (let i = nowBox.length - 1; i >= 0 && pend < PARTY_INVITE_MAX_PENDING; i--) {
    const m = nowBox[i];
    if (m && m.kind === "pinv" && !m.self && now - (Number(m.ts) || 0) <= PARTY_INVITE_PEND_MS) pend++;
  }
  if (pend >= PARTY_INVITE_MAX_PENDING)
    return res.status(429).json({ error: "that trainer already has invites waiting" });
  _lastInvite.set(from, now);
  if (_lastInvite.size > 5000) { for (const k of [..._lastInvite.keys()].slice(0, _lastInvite.size - 5000)) _lastInvite.delete(k); }
  // The invite names a MOMENT: the inviter's party as it stands right now. Accept re-checks this,
  // which is what makes an invite issued before a disband stale instead of a ghost door.
  partyInvites.set(from + "|" + to, { pid: partyOf.get(from) || null, ts: now });
  // invites to FABRICATED recipients cost the attacker nothing and never reach a real inbox, so the
  // map needs its own ceiling; Map iterates in insertion order, so this drops the oldest first
  if (partyInvites.size > PARTY_INVITE_MAX) {
    for (const k of [...partyInvites.keys()].slice(0, partyInvites.size - PARTY_INVITE_MAX)) partyInvites.delete(k);
  }
  // Delivered AS A TYPED DM — the whisper store wholesale (sanitising, caps, 30d retention, kv
  // persistence, the token-gated GET) so an invite inherits every hardening whispers already have.
  // kind:"pinv" is what tells the client to render accept/decline buttons instead of a text row.
  const fromHandle = stripTags(String(b.handle || "Trainer")).slice(0, 20);
  const msg = { from, fromHandle, to, text: fromHandle + " invites you to a party", kind: "pinv", ts: now };
  pushInvite(dmInbox(to), msg);
  // the sender's own echo goes through the same rule: a harvested net_id (they are published in
  // /world/roster) lets a stranger POST invites AS a victim, and that echo lands in the VICTIM's inbox
  pushInvite(dmInbox(from), { ...msg, self: true });
  if (worldDM.size > 5000) { const oldest = [...worldDM.keys()].slice(0, worldDM.size - 5000); oldest.forEach(k => worldDM.delete(k)); }
  saveWorldDM();
  res.json({ ok: true });
});
app.post("/party/accept", (req, res) => {
  const b = req.body || {}, me = String(b.wallet || "");
  if (!isPresenceId(me)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(me, b)) return res.status(403).json({ error: "prove this wallet first" });
  const from = String(b.from || "");
  if (!isPresenceId(from)) return res.status(400).json({ error: "valid inviter required" });
  const key = from + "|" + me, inv = partyInvites.get(key), now = Date.now();
  if (!inv || now - inv.ts > PARTY_INVITE_TTL_MS) { partyInvites.delete(key); return res.status(403).json({ error: "no open invite from that trainer" }); }
  if (partyOf.has(me)) return res.status(409).json({ error: "leave your current party first" });
  const curPid = partyOf.get(from) || null;
  // STALE: an invite names a party, and it dies with that party. Disband — or the inviter changing
  // groups — must not teleport the accepter into whatever the inviter happens to be in now.
  //
  // A null pid means "party with me, whatever that becomes", and it must mean ONLY the party the
  // inviter goes on to FOUND. An earlier draft let a null-pid invite open whatever party the
  // inviter had since joined, which is a consent bypass with a name: a mole issues an invite to
  // their own alt while partyless, gets themselves invited into someone else's group, and the alt
  // then walks in on the OLD invite — into a party nobody there ever offered it. Measured
  // (_av_party_attack_sim.mjs A7): the alt landed in the victim party and read its private chat.
  // The honest flow that null exists for — invite two friends at once, before any party exists —
  // is preserved by RETARGETING at the moment of founding (below), so this test is now exact.
  if (inv.pid !== curPid) { partyInvites.delete(key); return res.status(409).json({ error: "that invite is stale — the party has changed" }); }
  let pid = curPid, p = pid ? parties.get(pid) : null;
  if (pid && !p) { partyInvites.delete(key); return res.status(409).json({ error: "that party is gone" }); }
  if (p && p.members.length >= PARTY_MAX) return res.status(409).json({ error: "party is full" });
  if (!p) {
    pid = newPartyId();
    p = { members: [from], leader: from, created: now };
    parties.set(pid, p); partyOf.set(from, pid);
    // RETARGET: this accept is the moment the inviter's party comes into being, so every other
    // invite they issued while partyless now names it. Doing it here — rather than treating null
    // as a wildcard at redemption time — is what keeps "A invites B and C at once" working while
    // an invite can still only ever open the party its own issuer founded.
    for (const [k, iv] of partyInvites) if (iv.pid === null && k.startsWith(from + "|")) iv.pid = pid;
  }
  p.members.push(me); partyOf.set(me, pid);
  delete p.deadSince;
  partyInvites.delete(key);
  saveParties();
  res.json({ ok: true, party: partyWire(me) });
});
app.post("/party/leave", (req, res) => {
  const b = req.body || {}, me = String(b.wallet || "");
  if (!isPresenceId(me)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(me, b)) return res.status(403).json({ error: "prove this wallet first" });
  const pid = partyOf.get(me);
  if (!pid || !parties.get(pid)) return res.status(409).json({ error: "you are not in a party" });
  partyRemove(pid, me);
  res.json({ ok: true });
});
app.post("/party/kick", (req, res) => {
  const b = req.body || {}, me = String(b.wallet || "");
  if (!isPresenceId(me)) return res.status(400).json({ error: "valid wallet required" });
  if (!presenceOk(me, b)) return res.status(403).json({ error: "prove this wallet first" });
  const who = String(b.who || "");
  if (!isPresenceId(who)) return res.status(400).json({ error: "valid member required" });
  const pid = partyOf.get(me), p = pid ? parties.get(pid) : null;
  if (!p) return res.status(409).json({ error: "you are not in a party" });
  if (p.leader !== me) return res.status(403).json({ error: "only the leader may kick" });
  if (who === me) return res.status(400).json({ error: "leave, don't kick yourself" });
  if (!p.members.includes(who)) return res.status(404).json({ error: "not a member of your party" });
  partyRemove(pid, who);
  // A kick that any open invite can undo is not a kick. Every member may invite (that is the
  // design), so the removed trainer walked straight back in on an invite ANOTHER member had issued
  // before the kick — no new decision by anyone, the leader's action simply reversed itself
  // (measured, _av_party_attack_sim.mjs A8). Only invites belonging to THIS party are dropped, so
  // an unrelated group's open invite to the same trainer is untouched, and any member who genuinely
  // wants them back can still issue a fresh one.
  for (const [k, iv] of partyInvites) {
    if (!k.endsWith("|" + who)) continue;
    if (iv.pid === pid || partyOf.get(k.slice(0, k.length - who.length - 1)) === pid) partyInvites.delete(k);
  }
  res.json({ ok: true });
});
// test seam (the node_persist_sim pattern): round-trip the REAL serialize/restore in one process.
export const _partySeam = {
  serialize: serializeParties,
  restore: restoreParties,
  clear() { parties.clear(); partyOf.clear(); partyInvites.clear(); _lastInvite.clear(); },
  clearInviteCap() { _lastInvite.clear(); },
  size() { return { parties: parties.size, partyOf: partyOf.size, invites: partyInvites.size }; },
  pidOf(id) { return partyOf.get(id); },
  // the WHOLE inbox ring — GET /world/dm serves only the last 40 rows, which cannot show a sim
  // whether an invite flood destroyed the older whispers underneath it
  dmRing(id) { return (worldDM.get(id) || []).slice(); },
};

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
  // THE ACQUISITION BOUND. Reached only after txMarketSplit confirmed a real on-chain $CHIKI split,
  // so this is a settled sale: it counts against the seller's lifetime total, and the buyer genuinely
  // acquired the goods HERE, which is the strongest provenance a material can have.
  ownSold(sellerWallet, String(row.kind || "mat"), String(row.item || ""), Number(row.qty) || 0);
  ownCredit(buyer, String(row.kind || "mat"), String(row.item || ""), Number(row.qty) || 0);
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
  _consumeOrder(fresh.id);   // this id has now settled: it can never be posted again (see _soldOrders)
  // ---- THE OWNERSHIP BOOKKEEPING THE LISTING RAIL ALREADY DOES ----
  // /market/buy-onchain debits the seller and credits the buyer (ownSold + ownCredit, one line each).
  // This route did neither, in both directions. Seller half: a filler could stake the same fabricated
  // stockpile forever because `sold` never moved. Buyer half: a poster who paid real $CHIKI for 1,980
  // iron got no entitlement for it, so order-bought goods were unsellable beyond the allowance and
  // would be clamped out of the save the moment the v>=2 client ships.
  ownSold(String(fresh.fillerWallet || ""), String(fresh.kind || "mat"), String(fresh.item || ""), Number(fresh.qty) || 0);
  ownCredit(payer, String(fresh.kind || "mat"), String(fresh.item || ""), Number(fresh.qty) || 0);
  // goods to the POSTER (their client grants via the fills poll). Value-bearing: never cap-drop.
  // BOTH QUEUES STILL KEY ON THE ORDER ID, and they must: the filler's client matches this id
  // against its own my_deliveries record (Market.gd _deliv_done) and the poster's against its
  // orders_credited set, so a synthetic per-settlement id would leave an honest filler's delivery
  // showing "awaiting payment" forever. What made the shared key dangerous was that a settled id
  // could be POSTED AGAIN — that is what _consumeOrder above closes, at the source.
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
// ---- A LISTING'S QUANTITY MUST BE A QUANTITY THE GAME CAN ACTUALLY HOLD ----
// A listing settles through /market/buy-onchain into a real 75/20/5 $CHIKI transfer, so a listing IS
// a claim on a stranger's money. The qty was clamped to 999999 — 908x the most of one material any
// player can carry — so a save with a fabricated `mats` value (the mmo blob rides through /profile
// verbatim, and nothing clamps it) could ask a real buyer to pay for a million of something.
//
// These ceilings come from what the game can REPRESENT, measured, not guessed:
//   BAG_CAP tops out at 1100 per material (Econ.gd BAG_CAP), and every over-cap source is small and
//   slow — all 12 TASKS together grant 9 crystal, level milestones ~45 lifetime, and the weekly
//   raid 25 (RaidBoss.gd _pay_raid). Even a 200-week raider tops out near 6,150 of a single material.
//   Fantasy fish are 1-in-42 per cast at the very best (tier-3 spot, Lv10 rod), so 2000 is on the
//   order of 200 hours of ideal fishing. Potions are crafted, bounded by the mats they consume.
//
// DELIBERATELY NOT A PROVENANCE TEST. gatherCount is the honest ceiling on what a wallet ever pulled
// from the ground, but it only began recording at Step 1 — a pre-Step-1 hoard reads as "gathered 0",
// so enforcing it would refuse real players (which is exactly why it is observe-only). A magnitude
// bound needs no per-wallet record at all, so it cannot false-positive on a grandfathered player.
// It bounds the damage; it does not prove the goods are real. Only server-owned materials can.
//
// REFUSE, don't clamp: clamping would silently turn an absurd listing into a plausible one and
// destroy the signal. A refusal is visible to the seller and counted for the operator below.
// chikimon is absent on purpose — one creature is one row, and chikimonSaleBlocked already gates it.
// EVERY LISTABLE ITEM NAME IS A CATALOG ENTRY. `kind` was coerced to a known value but `item` was
// stored verbatim (`stripTags(String(l.item || "wood")).slice(0,24)`) on both op:list and
// op:order_post — auction_post has had a catalog check all along, which is what makes the omission
// visible. Measured: a listing of kind "mat" item "not_a_material" was accepted and served on the
// board, and on the LISTING rail that string settles through /market/buy-onchain into `released`,
// which the BUYER's client feeds to credit_mat — attacker-chosen data written into a stranger's
// save. Inert today (matSaveEnforce and ownItemOk both skip non-MAT_IDS keys), but it is unvalidated
// input crossing between players and it costs one Set lookup to close.
// POT_IDS mirrors Econ.gd POTIONS (22 rows) — the only crafted things that are listable.
const POT_IDS = new Set(["healing_draught", "greater_healing_draught", "phoenix_tonic", "feast_of_the_fallen",
  "second_wind", "wakeful_elixir", "scholars_tonic", "rage_brew", "ironhide_tonic", "streak_sigil",
  "ember_vial", "tide_vial", "gale_vial", "wild_vial", "lucky_lure", "swiftfoot_serum",
  "berry_mash", "hearty_broth", "grand_banquet", "trail_fodder", "golden_oats", "beast_ration"]);
function listItemOk(kind, item) {
  if (kind === "mat") return MAT_IDS.has(item);
  if (kind === "ffish") return FFISH_SET.has(item);
  if (kind === "pot") return POT_IDS.has(item);
  if (kind === "chikimon") return CHIKIMON_IDS.has(item);
  return false;
}
const LIST_QTY_MAX = Object.freeze(Object.assign(Object.create(null), {
  mat: 20000,      // ~3.3x the ceiling a four-year raider could reach on one material
  ffish: 2000,     // ~200h of best-case fantasy fishing
  pot: 20000,      // crafted; bounded by the materials spent
}));
let _overQtyListings = 0;                    // observe: how often an impossible quantity was refused
const _overQtyBy = new Map();                // wallet/sid -> {n, worst, item, kind, ts} (bounded below)
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
  // RAISED 8000 -> 50000 (~2.5 MB). The cancel op now returns a seller's goods when an id was never
  // consumed and carries no receipt, so forgetting that an id SOLD is the one way that branch could
  // double-pay. The window is already near-impossible — crediting a sale removes the row from the
  // seller's own client, so a client still holding it has an uncredited receipt, and those live 60
  // days — but the memory is cheap and this pushes the eviction horizon out by years.
  if (_soldListings.size > 50000) {
    let drop = _soldListings.size - 50000;
    for (const k of _soldListings.keys()) { if (drop-- <= 0) break; _soldListings.delete(k); }
  }
}
// THE SAME RESURRECTION GUARD, FOR ORDERS — orders had none (13 mentions of _soldListings, 0 of an
// order equivalent). An order id is client-chosen, and order_post only checked for a clash against
// the LIVE board — a settled order has already been spliced out, so re-posting its id was a plain
// 200. That id is still sitting in the filler's fills queue as an acked receipt (rows are marked
// granted, not deleted, and live KEEP_CREDITED_MS = 2 days), so returnOrderGoods' `if (!arr.some(f
// => f.id === row.id))` suppressed the SECOND return: measured end to end, cycle 2's 50 iron left
// the filler's bag and never came back, with no error shown to either side. Uncapped repetitions,
// pure destruction of another player's goods.
const _soldOrders = new Map();     // order id -> ts consumed (settled / declined / cancelled / expired)
store.kvGet("market_sold_orders").then(v => { if (Array.isArray(v)) for (const e of v) { if (e && e.id) _soldOrders.set(String(e.id), Number(e.ts) || Date.now()); } }).catch(() => {});
export function _soldOrderIdsForTest() { return _soldOrders; }
function _consumeOrder(id) {
  if (!id) return;
  _soldOrders.set(String(id), Date.now());
  // bounded by COUNT, oldest-first — never by age, for the same reason listings are not: the fills
  // queue that would swallow a re-used id outlives any age window worth choosing.
  if (_soldOrders.size > 50000) {
    let drop = _soldOrders.size - 50000;
    for (const k of _soldOrders.keys()) { if (drop-- <= 0) break; _soldOrders.delete(k); }
  }
}
store.kvGet("auction_refunds").then(v => { if (v && typeof v === "object") auctionRefunds = v; }).catch(() => {});
const AUCTION_PERSIST_MAX = 5000;    // a runaway guard, far above any real live set (12h expiry)
let _aucWarnAt = 0;
function _capAuctions() {
  if (marketAuctions.length <= AUCTION_PERSIST_MAX) return marketAuctions;
  if (Date.now() - _aucWarnAt > 300000) {
    _aucWarnAt = Date.now();
    console.warn(`saveMarket: ${marketAuctions.length} live auctions exceeds ${AUCTION_PERSIST_MAX} — ` +
                 `persisting the newest; escrowed creatures in the remainder are at risk, investigate.`);
  }
  return marketAuctions.slice(-AUCTION_PERSIST_MAX);
}
function serializeOwnBook() {
  const out = [];
  for (const [w, r] of ownBook) out.push([w, { open: r.open, cred: r.cred, sold: r.sold, used: r.used, openSrc: r.openSrc || 0,
                                               ffishOpenSrc: r.ffishOpenSrc || 0,
                                               base: r.base || {}, baseSrc: r.baseSrc || 0 }]);
  return out.slice(-GATHER_WALLETS_MAX);
}
// RESTORE TRUSTS NOTHING. This blob came out of a database a future bug could corrupt, and it now
// carries SELLING RIGHTS, so it gets the same rules the live paths enforce: keys must be a real kind
// and a real material, numbers must be finite and positive, wallets bounded. A count mismatch is
// announced rather than swallowed — silently restoring fewer rows would hand players back a smaller
// entitlement than they earned, which reads to them exactly like a wipe.
export function restoreOwnBook(v) {
  if (!Array.isArray(v)) { _ownReady = true; return 0; }
  let n = 0;
  for (const e of v) {
    if (!Array.isArray(e) || !e[1] || typeof e[1] !== "object") continue;
    const w = String(e[0] || "").slice(0, 64);
    if (!isPubkey(w)) continue;
    const r = { open: Object.create(null), cred: Object.create(null), sold: Object.create(null), used: Object.create(null), openSrc: 0,
                ffishOpenSrc: 0,
                base: Object.create(null), baseSrc: 0 };
    for (const bucket of ["open", "cred", "sold", "used"]) {
      const src = e[1][bucket];
      if (!src || typeof src !== "object") continue;
      for (const k of Object.keys(src).filter(k => Object.hasOwn(src, k)).slice(0, 64)) {
        const cut = String(k).indexOf(":");
        if (cut < 1) continue;
        const kind = k.slice(0, cut), item = k.slice(cut + 1);
        // ffish is accepted here even when FFISH_AUTHORITY=0 (OWN_KINDS then lacks it): crediting
        // deliberately ignores the flag (see ownCredit), so a kill-switch boot must not DROP the
        // persisted fish entitlement — a later save from that boot would erase it forever.
        if (!(OWN_KINDS.has(kind) || kind === "ffish") || !ownItemOk(kind, item)) continue;
        const q = Number(src[k]);
        if (Number.isFinite(q) && q > 0) r[bucket][`${kind}:${item}`] = Math.min(q, Number.MAX_SAFE_INTEGER);
      }
    }
    // Step 7 baseline: mats only, and — unlike the buckets — a NEGATIVE value is legal here, because
    // base is a NET OFFSET (min(claimed, OWN_OPEN_CAP) − cred + sold + used; see matSaveBaseline).
    // THE CEILING MUST CARRY THE SINKS. An earlier version clamped base to OWN_OPEN_CAP flat, on the
    // reasoning that "the positive side can never legitimately exceed the grandfather cap" — which is
    // exactly the raw-snapshot assumption the offset exists to kill. `sold`/`used` are LIFETIME and
    // unbounded, so a pre-cutover veteran's honest offset legitimately runs far above the cap: one
    // with a 6200 opening balance who sold his whole 7700 entitlement baselines at base=13900, and
    // the flat clamp cut him to 6200 — bound 7700 -> 0, turning his next honest save into
    // matClamps:{wood:0}, a total wipe of that material, on nothing worse than a routine redeploy.
    // Clamping to OWN_OPEN_CAP + sold + used keeps the anti-corruption ceiling identical (the bound
    // is base + cred + allowance − sold − used, so it still cannot exceed OWN_OPEN_CAP + cred +
    // allowance no matter what the blob claims) while never cutting a real offset. The buckets are
    // restored ABOVE this block, so r.sold/r.used are already populated here — do not reorder.
    const bsrc = e[1].base;
    if (bsrc && typeof bsrc === "object") {
      for (const k of Object.keys(bsrc).filter(k => Object.hasOwn(bsrc, k)).slice(0, 64)) {
        const cut = String(k).indexOf(":");
        if (cut < 1) continue;
        const kind = k.slice(0, cut), item = k.slice(cut + 1);
        if (kind !== "mat" || !ownItemOk(kind, item)) continue;
        const q = Number(bsrc[k]);
        if (!Number.isFinite(q)) continue;
        const kk = `${kind}:${item}`;
        const ceil = OWN_OPEN_CAP + (r.sold[kk] || 0) + (r.used[kk] || 0);
        r.base[kk] = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(q, ceil));
      }
    }
    const os = Number(e[1].openSrc);
    r.openSrc = Number.isFinite(os) && os > 0 ? os : 0;
    const fs2 = Number(e[1].ffishOpenSrc);   // absent in pre-flip blobs -> 0, i.e. "not yet taken"
    r.ffishOpenSrc = Number.isFinite(fs2) && fs2 > 0 ? fs2 : 0;
    const bs = Number(e[1].baseSrc);
    r.baseSrc = Number.isFinite(bs) && bs > 0 ? bs : 0;
    ownBook.set(w, r); n++;
  }
  if (n !== v.length) console.error(`restoreOwnBook: kept ${n} of ${v.length} rows — the remainder failed validation`);
  _ownReady = true;
  return n;
}
store.kvGet("own_book").then(v => restoreOwnBook(v)).catch(() => { _ownReady = true; });
// A restore that never resolves must not leave enforcement permanently skipped OR permanently on a
// half-book: the .catch above and this backstop both flip the flag, and a skip is counted either way.
setTimeout(() => { if (!_ownReady) { _ownReady = true; console.error("own_book restore timed out — enforcing on what restored"); } }, 20000);

async function saveMarket(strict = false) {
  try {
    await Promise.all([
      store.kvSet("market_listings", marketListings.slice(-400)),
      store.kvSet("market_sales", marketSales),
      store.kvSet("market_orders", marketOrders.slice(-200)),
      store.kvSet("market_fills", marketFills),
      // AN AUCTION HOLDS A CREATURE. Persisting only the last 100 dropped the oldest live rows, and
      // after a restart auction_cancel answered cancelled:false for them — so the seller's client
      // never restored the stashed chikimon and it sat in my_auctions forever, unreachable. Sealing
      // my_auctions (sig v14) closed the old hand-repair, so this was the last way out. Auctions
      // expire on their own in 12h (sweepAuctions), so the live set is bounded by TIME, not count;
      // the number here is a runaway guard, and per the never-truncate-silently rule it announces
      // itself rather than quietly eating escrowed creatures.
      store.kvSet("market_auctions", _capAuctions()),
      store.kvSet("auction_refunds", auctionRefunds),
      store.kvSet("market_sold_ids", [..._soldListings].slice(-25000).map(([id, ts]) => ({ id, ts }))),
      store.kvSet("market_sold_orders", [..._soldOrders].slice(-25000).map(([id, ts]) => ({ id, ts }))),
      // THE BOOK RIDES WITH THE BOARD. Escrow is derived from marketListings, so a book persisted on a
      // different schedule than the listings it is read against would restore inconsistent. /market/op
      // awaits this on every op, including list.
      store.kvSet("own_book", serializeOwnBook()),
    ]);
  } catch (e) { console.warn("saveMarket persist failed:", String(e?.message || e)); if (strict) throw e; }
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
// ---- LIVE SESSION per wallet (see the note at /verify) --------------------------------------
// In memory only, on purpose: a redeploy forgetting every session is the SAFE direction — the first
// save after it simply re-establishes one, and nobody is locked out. Bounded like every other
// per-wallet map here.
const liveSession = new Map();          // wallet -> { sid, ts }
const SESSION_MAX = 20000;
function mintSession(wallet) {
  if (!isPubkey(wallet)) return "";
  if (liveSession.size >= SESSION_MAX && !liveSession.has(wallet)) {
    let drop = Math.max(1, Math.floor(SESSION_MAX * 0.05));
    for (const k of liveSession.keys()) { if (drop-- <= 0) break; liveSession.delete(k); }
  }
  const sid = crypto.randomBytes(18).toString("hex");
  liveSession.set(wallet, { sid, ts: Date.now() });
  return sid;
}
// Has this caller's session been taken over by a newer sign-in? Unknown/absent session ids are
// treated as CURRENT, so an older client that does not send one keeps working exactly as before.
function sessionSuperseded(wallet, sid) {
  if (!sid) return false;
  const cur = liveSession.get(wallet);
  if (!cur) return false;
  return cur.sid !== sid;
}
export function _liveSessionFor(w) { return liveSession.get(w) || null; }
export function _clearSessions() { liveSession.clear(); }
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
      _consumeOrder(o.id);                                   // spent id — never postable again
      return false;
    }
    if (now - (o.ts || 0) >= MARKET_TTL_MS) { _consumeOrder(o.id); return false; }
    return true;
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
      // IMPOSSIBLE QUANTITY. Checked BEFORE the row is built, so an absurd listing never reaches the
      // board and never becomes something a real buyer can pay for on-chain. See LIST_QTY_MAX.
      const _lk = (["chikimon", "ffish", "pot"].includes(String(l.kind)) ? String(l.kind) : "mat");
      const _lq = clampF(l.qty, 1, 999999, 1) | 0;
      // the item has to be a thing that exists (see listItemOk) — checked before the row is built,
      // so a made-up name never reaches the board and never reaches a buyer's client
      if (!listItemOk(_lk, stripTags(String(l.item || "")).slice(0, 24))) {
        return res.status(400).json({ error: "Chikoria has no such item. Cancel the listing to put your goods back in your bag." });
      }
      if (Object.hasOwn(LIST_QTY_MAX, _lk) && _lq > LIST_QTY_MAX[_lk]) {
        _overQtyListings++;
        // Bound this map like every other per-wallet map here, and keep the WORST attempt per seller
        // rather than the latest — the biggest ask is the informative one.
        const _who = String(mktWallet(b) || sid);
        const _row = _overQtyBy.get(_who) || { n: 0, worst: 0, item: "", kind: "", ts: 0 };
        _row.n++; _row.ts = Date.now();
        if (_lq > _row.worst) { _row.worst = _lq; _row.item = stripTags(String(l.item || "")).slice(0, 24); _row.kind = _lk; }
        _overQtyBy.set(_who, _row);
        if (_overQtyBy.size > 5000) { let drop = 250; for (const k of _overQtyBy.keys()) { if (drop-- <= 0) break; _overQtyBy.delete(k); } }
        // The client shows this string to the seller verbatim (Market.gd's list-error toast), and by now it has
        // already taken the goods out of their bag locally — so say how to get them back.
        return res.status(409).json({ error: `A ${_lk} listing cannot exceed ${LIST_QTY_MAX[_lk]}. Cancel the listing to put your goods back in your bag, then list a smaller amount.`, max: LIST_QTY_MAX[_lk] });
      }
      // ---- THE ACQUISITION BOUND: you may not sell more than Chikoria saw you acquire ----
      // FAILS OPEN, always. If the book has not restored yet we do not know what this wallet acquired,
      // and refusing on missing data is how a migration destroys a real player's afternoon. The skip
      // is COUNTED so the operator can see it rather than discover it.
      const _ow = mktWallet(b);
      if (_ownEnforce && OWN_KINDS.has(_lk) && isPubkey(String(_ow || ""))) {
        if (!_ownReady) {
          _ownSkipped++;
        } else {
          const _item = stripTags(String(l.item || "")).slice(0, 24);
          const _avail = ownAvailable(_ow, _lk, _item);
          if (_lq > _avail) {
            _ownRefusals++;
            const _row = _ownWorst.get(_ow) || { short: String(_ow).slice(0, 8), item: "", asked: 0, had: 0, n: 0 };
            _row.n++;
            if (_lq - _avail > _row.asked - _row.had) { _row.item = _item; _row.asked = _lq; _row.had = Math.max(0, _avail); }
            _ownWorst.set(_ow, _row);
            if (_ownWorst.size > 5000) { let d = 250; for (const k of _ownWorst.keys()) { if (d-- <= 0) break; _ownWorst.delete(k); } }
            // The client shows this verbatim (Market.gd's list-error toast) and has already taken the goods out of
            // the bag, so it must say how to get them back — cancel can now actually do that.
            return res.status(409).json({
              error: `Chikoria has only recorded you acquiring ${Math.max(0, _avail)} of that. Cancel the listing to put your goods back in your bag.`,
              available: Math.max(0, _avail),
            });
          }
        }
      }
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
    if (marketListings.length < before) {
      _consumeListing(id);   // only a REAL removed row enters the guard
      // Same bookkeeping as the on-chain path. The buyer here is a sid, not necessarily a wallet, so
      // only the SELLER's side is recordable — ownCredit ignores anything that is not a pubkey anyway.
      if (row) ownSold(String(row.wallet || ""), String(row.kind || "mat"), String(row.item || ""), Number(row.qty) || 0);
    }
  } else if (op === "cancel" || op === "sold") {
    const id = stripTags(String(l.id || "")).slice(0, 40);
    const before = marketListings.length;
    marketListings = marketListings.filter(x => !(x.id === id && x.sid === sid));
    cancelled = marketListings.length < before;   // true ONLY if a still-live listing was removed (else it already sold)
    // A ROW THE SERVER NEVER HAD IS NOT A SALE. `cancelled:false` was doing double duty — it meant
    // both "this sold" and "I have no record of it" — and the client only reclaims on `true`
    // (Market.gd's mine-reconcile). So any listing the server refused or dropped left the seller's goods deducted
    // (Market.gd's list submit) with no way back: cancel answered false, the client kept the row and re-pushed
    // it forever. The LIST_QTY_MAX refusal above walks straight into that, and its message tells the
    // seller to cancel — advice that could not work until this branch existed.
    //
    // If the id was never consumed AND this seller holds no sale receipt for it, then nobody ever
    // bought it, so returning the goods cannot double-pay. Both are durable: _soldListings persists
    // (market_sold_ids) and marketSales keeps UNCREDITED receipts for KEEP_PENDING_MS (60 days),
    // far longer than a listing's own 24h TTL.
    if (!cancelled && !_soldListings.has(id) && !(marketSales[sid] || []).some(s => s.id === id)) {
      cancelled = true;
    }
    // ...but NEVER blacklist an id on that branch. Consuming an id the server never had is exactly
    // the id-poisoning bug described below, so the blacklist stays tied to a REAL removal.
    // Blacklist ONLY an id this caller actually owned. _consumeListing used to run here
    // unconditionally, outside the sid check — so any signed-in player could POST cancel with ids
    // they had never owned and blacklist them for MARKET_TTL_MS. Client listing ids are a
    // sequential L<n> counter, so a few thousand such calls poisoned the entire practical id
    // space: every later list() answered ok:true while the server silently dropped the row, and
    // the seller's client had already deducted the goods. Goods destroyed, seller never told.
    // A genuine sale is already consumed by the buy path above, so gating on `cancelled` here
    // loses nothing.
    if (marketListings.length < before) _consumeListing(id);
  } else if (op === "order_post") {
    // WTB craft order — REAL-$CHIKI ONLY. No escrow moves at post time: the poster's wallet
    // rides on the order and they sign the real 75/20/5 payment (via /market/order-pay) when a
    // trainer delivers. Requires a wallet and (fail-open on RPC trouble) a live balance that can
    // cover the offer, so fillers don't lock goods against a wallet that can't pay.
    if (!MARKET_ONCHAIN) return res.status(503).json({ error: "orders are paused while on-chain trading is offline" });
    const ow = stripTags(String(l.wallet || "")).slice(0, 44);
    if (!isPubkey(ow)) return res.status(400).json({ error: "orders pay real $CHIKI — connect your Phantom wallet to post one" });
    const oid = stripTags(String(l.id || ("O" + Date.now() + Math.floor(Math.random() * 1e4)))).slice(0, 40);
    // A SETTLED OR CLOSED ORDER ID IS SPENT FOREVER — the same rule op:list has had since the
    // double-sale bug. Re-posting one is how a poster destroyed a filler's staked goods.
    if (_soldOrders.has(oid)) {
      return res.status(409).json({ error: "That order id was already used. Post a new order with a fresh id." });
    }
    const price = clampF(l.price, 1, 50000, 1) | 0;
    try {
      const bal = await chikiBalance(ow, true);
      if (bal < price) return res.status(403).json({ error: `your wallet holds ${Math.floor(bal).toLocaleString()} $CHIKI — not enough to back a ${price.toLocaleString()} offer` });
    } catch (e) { /* RPC down: allow the post — decline + the 48h auto-return bound the risk */ }
    const clash = marketOrders.find(x => x.id === oid);
    if (clash && clash.sid !== sid) return res.status(409).json({ error: "order id collision — repost" });
    if (!clash) {
      if (marketOrders.filter(x => x.sid === sid).length >= 3) return res.status(429).json({ error: "3 open orders max" });
      const _ok = (["ffish", "pot"].includes(String(l.kind)) ? String(l.kind) : "mat");
      const _oi = stripTags(String(l.item || "wood")).slice(0, 24);
      // same catalog rule as op:list — an order names a real item or it is not posted
      if (!listItemOk(_ok, _oi)) return res.status(400).json({ error: "Chikoria has no such item to order." });
      marketOrders.push({
        id: oid,
        buyer: stripTags(String(l.seller || "Trainer")).slice(0, 20), sid, wallet: ow,
        kind: _ok,
        item: _oi,
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
    // ---- THE ACQUISITION BOUND APPLIES HERE TOO ----
    // op:list refuses the 1501st unit a wallet was never seen acquiring; this rail accepted an
    // unbounded amount of the same material from the same wallet. Measured: a filler whose book had
    // no row at all (ownAvailable 1500, the bare allowance) had 30 consecutive deliveries of 99 gold
    // accepted, 2,970 units staked against orders worth up to 1,500,000 real $CHIKI, and its
    // available count was still 1500 afterwards because nothing was ever debited. A craft order is a
    // real-$CHIKI exit; it gets the same gate, the same fail-open-while-loading policy and the same
    // sentence as the listing rail.
    const _dw = fw, _dk = String(row.kind || "mat"), _di = String(row.item || ""), _dq = Number(row.qty) || 0;
    if (_ownEnforce && OWN_KINDS.has(_dk) && isPubkey(_dw)) {
      if (!_ownReady) {
        _ownSkipped++;
      } else {
        const _davail = ownAvailable(_dw, _dk, _di);
        if (_dq > _davail) {
          _ownRefusals++;
          return res.status(409).json({
            error: `Chikoria has only recorded you acquiring ${Math.max(0, _davail)} of that. Deliver what you have gathered.`,
            available: Math.max(0, _davail),
          });
        }
      }
    }
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
    if (row) { marketOrders = marketOrders.filter(x => x.id !== oid); _consumeOrder(oid); }
    cancelled = !!row;
  } else if (op === "order_cancel") {
    const oid = stripTags(String(l.id || "")).slice(0, 40);
    const row = marketOrders.find(x => x.id === oid && x.sid === sid);
    if (row && row.state === "delivered") return res.status(409).json({ error: "a delivery is awaiting your payment — pay it or decline it first" });
    marketOrders = marketOrders.filter(x => !(x.id === oid && x.sid === sid));
    if (row) _consumeOrder(oid);                // a closed id is spent — it can never be posted again
    cancelled = !!row;                          // nothing to refund — real orders hold no escrow
  } else if (op === "auction_post") {
    // 🔨 a chikimon goes under the hammer: 12h, highest bid wins. The seller's client already
    // took custody of the unit (it restores intact on cancel / no-bid return).
    // THE SAME INTERLOCK op:buy HAS. When the on-chain rail is live every LISTING must settle
    // through the verified 75/20/5 split — the unauthenticated soft op:buy is refused precisely so a
    // client cannot pay for a real asset with currency the server never verified. The auction house
    // was left on the soft rail: auction_bid took a 50,000 bid from a wallet whose measured balance
    // was 0, the hammer handed the creature over through the fills queue with recordAssetBuy
    // stamping it "purchased", and the winner then listed it on the REAL rail for 40,000. That is a
    // forged-currency-to-real-asset converter, and the honest seller is paid in nothing.
    //
    // TO BRING AUCTIONS BACK: give the hammer a buy-onchain-shaped settle (the winning bid signed as
    // a real transfer and verified by txMarketSplit), then delete this gate. Until then the house is
    // shut while the real rail is on, rather than open and unbacked.
    if (MARKET_ONCHAIN) {
      return res.status(409).json({ error: "the auction house is closed while trading settles on-chain — list it on the Trading Post instead" });
    }
    const aid = stripTags(String(l.id || "")).slice(0, 40);
    if (!aid) return res.status(400).json({ error: "auction id required" });
    if (!marketAuctions.some(x => x.id === aid)) {
      if (marketAuctions.filter(x => x.sid === sid).length >= 2) return res.status(429).json({ error: "2 live auctions max" });
      // an auction is a sale — same gate as op:list, or the gate is one op name wide
      const aSpecies = stripTags(String(l.species || "")).slice(0, 24);
      // THE SPECIES MUST BE A REAL ONE. This was stored verbatim, and auction_cancel echoes it back
      // as the authoritative identity of the returning creature — so an unrecognised string became
      // whatever the client wanted, and Econ.unit_kind() maps anything it does not know to
      // "legendary". A catalog check makes the echoed record mean something even for a wallet the
      // ledger has never seen.
      if (!CHIKIMON_IDS.has(aSpecies)) return res.status(400).json({ error: "that is not a chikimon" });
      const bad = chikimonSaleBlocked(mktWallet(b), aSpecies,
                                      stripTags(String(l.uid || "")).slice(0, 40), aid);
      if (bad) return res.status(409).json({ error: bad });
      marketAuctions.push({
        id: aid, seller: stripTags(String(l.seller || "Trainer")).slice(0, 20), sid,
        wallet: mktWallet(b),   // proven seller wallet — puts the auction sid inside the anti-hijack surface
        species: aSpecies,                 // catalog-checked above
        lvl: clampF(l.lvl, 1, 50, 1) | 0, xp: clampF(l.xp, 0, 1e9, 0) | 0,
        minBid: clampF(l.minBid, 1, 50000, 1) | 0, curBid: 0, curSid: "", curName: "", curWallet: "",
        ts: Date.now(), endsAt: Date.now() + AUCTION_MS,
      });
    }
  } else if (op === "auction_bid") {
    // AUTHORITATIVE: exactly one bidder can hold the top spot; the displaced bidder's escrow
    // goes home through the refunds queue. accepted:false = the bidder's client deducts NOTHING.
    // the other half of the interlock above — a bid is the payment, and it is soft $CHIKI the server
    // never verified. accepted:false is the shape the client already handles (it deducts nothing).
    if (MARKET_ONCHAIN) {
      return res.json({ ok: true, accepted: false, reason: "the auction house is closed while trading settles on-chain" });
    }
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

function shutdownDmSnapshot(now = Date.now()) {
  const cutoff = now - 30 * 24 * 3600 * 1000;
  const obj = {};
  for (const [k, a] of worldDM) {
    const kept = a.filter(m => (m.ts || 0) > cutoff).slice(-200);
    if (kept.length) obj[k] = kept;
  }
  return obj;
}

function shutdownMarketSigSnapshot() {
  return [..._usedTxSigs].map(([sig, e]) => ({
    sig, listingId: e.listingId, orderId: e.orderId, buyer: e.buyer,
    released: e.released, ts: e.ts,
  }));
}

function shutdownPositiveMap(m) {
  const o = {};
  for (const [k, v] of m) if (v > 0) o[k] = v;
  return o;
}

async function flushDurableState() {
  // Ownership and the market are one save because escrow is derived from the board. The asset
  // ledger first joins any write already in flight, then performs one final dirty pass.
  const jobs = [
    ["battle wins", () => saveBattleWins(true)],
    ["credential latch", () => _credLatchDirty ? saveCredLatchNow(true) : Promise.resolve()],
    ["world nodes", () => saveWorldNodes(true)],
    ["world mobs", () => saveWorldMobs(true)],
    ["asset ledger", () => Promise.resolve(_assetsFlush).then(() => saveAssetLedger(true))],
    ["world feed", () => saveWorldFeedNow(true)],
    ["world chat", () => store.kvSet("world_chat", worldChat.slice(-1000))],
    ["world DMs", () => store.kvSet("world_dm", shutdownDmSnapshot())],
    ["parties", () => store.kvSet("world_parties", serializeParties())],
    ["market signatures", () => store.kvSet("market_used_sigs", shutdownMarketSigSnapshot())],
    ["market tokens", () => store.kvSet("market_tokens", marketTokens)],
    ["market sid owners", () => store.kvSet("market_sid_owner", sidOwner)],
    ["market wallet sids", () => store.kvSet("market_wallet_sid", walletSid)],
    ["market and ownership", () => saveMarket(true)],
    ["bans", () => store.kvSet("banned_wallets", [...bannedWallets])],
    ["pending gifts", () => store.kvSet("pending_gifts", pendingGifts)],
    ["fishing event", () => store.kvSet("fish_event", _fishEvent)],
    ["meme ledger", () => Promise.all([
      store.kvSet("meme_minted", memeMinted),
      store.kvSet("meme_hatches", memeHatches),
      store.kvSet("meme_used_sigs", memeUsedSigs),
    ])],
    ["cup state", () => store.kvSet("cup_state", liveCup ? liveCup.snapshot() : null)],
    ["cup public flag", () => store.kvSet("cup_public", cupPublic)],
    ["cup auto flag", () => store.kvSet("cup_auto", cupAuto)],
    ["cup prizes", () => store.kvSet("cup_prizes", shutdownPositiveMap(cupPrizes))],
    ["cup payers", () => store.kvSet("cup_payers", shutdownPositiveMap(cupPayers))],
    ["glory credits", () => store.kvSet("glory_credits", shutdownPositiveMap(gloryCredits))],
    ["cup awarded", () => store.kvSet("cup_total_awarded", cupTotalAwarded)],
    ["cup champion", () => store.kvSet("cup_champion", cupChampion)],
  ];
  const results = await Promise.allSettled(jobs.map(([, run]) => Promise.resolve().then(run)));
  const failed = results.flatMap((r, i) => r.status === "rejected" ? [jobs[i][0]] : []);
  if (failed.length) throw new Error(`shutdown flush failed: ${failed.join(", ")}`);
}

async function gracefulShutdown(sig, httpServer) {
  if (_draining === true) return;
  _draining = true;
  console.log(`${sig} received — draining requests and flushing durable state`);

  // A socket must not keep producing world mutations while the final snapshot is being written.
  for (const ws of wsClients) { try { ws.terminate(); } catch {} }

  // Render's default shutdown window is 30 s. Give in-flight HTTP work up to 12 s, leaving the
  // remainder for two database passes. Closing idle connections prevents keep-alive from delaying it.
  await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => { httpServer.closeAllConnections?.(); finish(); }, 12000);
    httpServer.close(finish);
    httpServer.closeIdleConnections?.();
  });

  try {
    // The second pass catches a mutation that was already awaiting its first store write.
    await flushDurableState();
    await flushDurableState();
    console.log("shutdown flush complete");
    process.exit(0);
  } catch (e) {
    console.error("shutdown flush FAILED:", e?.stack || e);
    process.exit(1);
  }
}

// Open the port FIRST so Render detects it immediately (no "No open ports" timeout on a cold DB),
// then initialize the DB in the background (errors logged, not fatal — the server stays up and recovers).
const httpServer = app.listen(Number(PORT), () => {
  console.log(`Chiki backend v2 on :${PORT} · ${NETWORK} · store=${store.kind} · treasury ${treasury.publicKey.toBase58()}`);
  console.log(`verifyHolders=${verifyOn} · holdMin=${MIN_HOLD_MINUTES} · dailyCap=${DAILY_FRAC>=1?"none":Math.round(DAILY_FRAC*100)+"% pool/day"} · perWallet=${WALLET_DAILY} SOL`);
});
attachWorldSocket(httpServer);   // the SECOND transport — see the block above /world/move's neighbours
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { void gracefulShutdown(sig, httpServer); });
store.init()
  .then(()=>{ console.log("store ready"); return rosterGuardBoot(); })
  .then(()=>loadCupState())
  .then(()=>console.log(`cup state loaded (public=${cupPublic}, owed prizes=${cupPrizes.size})`))
  .catch(e=>console.error("store.init failed:", e?.message||e));

// The guard runs the moment the database is reachable — before the first player can be handed an
// empty profile — and then on a slow timer, so an in-place wipe of a database we are already on is
// caught too. The timer is unref'd: it must never be the reason a process stays alive.
async function rosterGuardBoot() {
  if (ROSTER_GUARD_MODE === "off") { console.log("roster guard: OFF (CHIK_ROSTER_GUARD=off)"); return; }
  const st = await rosterGuardCheck("boot");
  if (!st.tripped) {
    console.log(`roster guard: OK — ${st.profiles} saved profiles (floor ${st.floor}, mode=${ROSTER_GUARD_MODE})`);
    if (ROSTER_MIN === 0 && store.kind === "postgres") {
      console.warn(`⚠ roster guard is UNARMED: CHIK_ROSTER_MIN is not set, so pointing this service at a`);
      console.warn(`  DIFFERENT (empty) database would NOT be caught — a fresh database has no high-water`);
      console.warn(`  mark either. Set CHIK_ROSTER_MIN to about 90% of ${st.profiles} (i.e. ${Math.floor(st.profiles * 0.9)}).`);
    }
  }
  setInterval(() => { rosterGuardCheck("periodic recheck").catch(()=>{}); }, ROSTER_RECHECK_MS).unref?.();
}
chat.init().then(()=>{ _chatReady = true; console.log("chat ready"); }).catch(e=>console.error("chat.init failed:", e?.message||e));
