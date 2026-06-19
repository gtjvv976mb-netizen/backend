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
  MAX_CLAIM_SOL = "0.05",
  DAILY_CAP_SOL = "1",             // global cap on confirmed payouts per rolling 24h
  POOL_RESERVE_SOL = "0.05",       // never pay the treasury below this floor (keeps a buffer for fees)
  PER_WALLET_DAILY_SOL = "0",      // per-wallet cap per rolling 24h (0 = unlimited)
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
const RARITY_SOL = { common:0.000004, uncommon:0.000008, rare:0.000018, epic:0.00004, mythic:0.0001, shiny:0.0002, legend:0.0005 };  /* 5x lower — preserve the reward pool while volume/fees are low */
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
function seededEarn(wallet, lastClaim, chikis, minutes){
  const slots = Math.min(4000, Math.floor(minutes * 60 / TASK_SEC));
  let sol = 0;
  for (let ci = 0; ci < chikis; ci++) for (let s = 0; s < slots; s++) sol += RARITY_SOL[slotRarity(wallet, lastClaim, ci, s)];
  return sol * MULT;
}
const WALLET_DAILY = Number(PER_WALLET_DAILY_SOL);
const verifyOn = String(VERIFY_HOLDERS).toLowerCase() === "true";

const isPubkey = (s) => { try { new PublicKey(s); return true; } catch { return false; } };

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
const legStamMax = lv => Math.round(120 + (Math.min(Math.max(lv, 1), MAX_LEVEL) - 1) / 49 * 780);
const stripTags  = s => String(s == null ? "" : s).replace(/[<>]/g, "");          // no HTML tags ⇒ no stored XSS
const clampNum   = (v, lo, hi, def) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };

// Returns a sanitized copy of the incoming profile, using the previously-stored one to block roll-backs / jumps.
function sanitizeProfile(prev, p) {
  const out = { ...p };
  if (out.handle != null) out.handle = stripTags(out.handle).slice(0, 16);
  out.glory   = clampNum(out.glory, 0, 1e12, 0);
  out.renames = clampNum(out.renames, 0, 99, 0);
  const prevCh = (prev && Array.isArray(prev.chikis)) ? prev.chikis : [];
  // ===== ROSTER IS NEVER REDUCED: a wallet keeps every Chiki it has ever owned (by species),
  //       unless the player explicitly releases it. Incoming saves update existing Chikis and may
  //       ADD new species within the hatch caps, but can never drop a previously-owned one. =====
  const inc = Array.isArray(out.chikis) ? out.chikis : [];
  if (inc.length || prevCh.length) {
    const firstBySp = arr => { const m = new Map(); for (const c of arr) { const sp = clampNum(c.sp, 0, 14, 0); if (!m.has(sp)) m.set(sp, c); } return m; };
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
      const prevLv = clampNum(pc.level, 1, MAX_LEVEL, 1);
      let lv = clampNum(src.level, 1, MAX_LEVEL, 1);
      if (pc.level != null) lv = Math.min(Math.max(lv, prevLv), prevLv + 4);   // level monotonic, no jumps
      // BR can't be injected — it only rises gradually via Battle EXP; cap the per-save jump
      const brP = clampNum(pc.br, 1, MAX_BR, 1);
      let brF = Math.max(clampNum(src.br, 1, MAX_BR, 1), brP);
      if (pc.br != null) brF = Math.min(brF, brP + 3);
      // skill-card tiers must be a clean {slot:1..5} map — never accept arbitrary values
      const rawCT = (src.cardTier && typeof src.cardTier === "object" && !Array.isArray(src.cardTier)) ? src.cardTier
                  : ((pc.cardTier && typeof pc.cardTier === "object" && !Array.isArray(pc.cardTier)) ? pc.cardTier : null);
      let ctF = null;
      if (rawCT) { ctF = {}; for (const k in rawCT) { const slot = k | 0; if (slot >= 0 && slot < 12) ctF[slot] = clampNum(rawCT[k], 1, 5, 1); } }
      kept.push({
        sp, level: lv, isLegend, hungry: !!src.hungry, tending: !!src.tending,
        nick: src.nick != null ? stripTags(src.nick).slice(0, 16) : (pc.nick != null ? stripTags(pc.nick).slice(0, 16) : null),
        xp: clampNum(src.xp, 0, xpNeed(lv), 0),
        food: clampNum(src.food, 0, foodMaxSec(lv), 0),
        stamina: clampNum(src.stamina, 0, isLegend ? legStamMax(lv) : maxStamOf(lv), maxStamOf(lv)),
        tasksDone:   Math.max(clampNum(src.tasksDone, 0, 1e12, 0),  clampNum(pc.tasksDone, 0, 1e12, 0)),    // monotonic
        sleepCycles: Math.max(clampNum(src.sleepCycles, 0, 1e9, 0), clampNum(pc.sleepCycles, 0, 1e9, 0)),
        renames: clampNum(src.renames, 0, 9, 0),
        br: brF,
        battleXp: clampNum(src.battleXp, 0, 1e12, 0),
        skillPts: clampNum(src.skillPts, 0, 999, 0),
        arenaSkills: Array.isArray(src.arenaSkills) ? src.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0))
                   : (Array.isArray(pc.arenaSkills) ? pc.arenaSkills.slice(0, 12).map(s => clampNum(s, 0, 11, 0)) : null),
        cardTier: ctF,
        arenaStam: src.arenaStam != null ? clampNum(src.arenaStam, 0, legStamMax(lv), legStamMax(lv))
                 : (pc.arenaStam != null ? clampNum(pc.arenaStam, 0, legStamMax(lv), legStamMax(lv)) : null),
        arenaSleepUntil: clampNum(src.arenaSleepUntil != null ? src.arenaSleepUntil : pc.arenaSleepUntil, 0, Date.now() + 24 * 3600 * 1000, 0),
      });
    }
    out.chikis = kept;
  }
  return out;
}
const _lastSave = new Map();   // light per-wallet write throttle
const _lastChat = new Map();   // light per-wallet chat throttle

async function chikiBalance(owner) {
  if (!MINT) return 0;
  try {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: MINT });
    let b = 0; for (const { account } of r.value) b += account.data.parsed.info.tokenAmount.uiAmount || 0;
    return b;
  } catch { return 0; }
}
const poolSol = async () => (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;

/* ----------------------------- storage ----------------------------- */
// Two backends with one interface. Postgres when DATABASE_URL is set; else in-memory (dev only).
function makeStore() {
  if (DATABASE_URL) return pgStore();
  console.warn("⚠ No DATABASE_URL — using IN-MEMORY store (state is lost on restart; NOT for mainnet).");
  return memStore();
}

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
    },
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
        const amount = await compute(p);
        if (!(amount > 0)) { await c.query("ROLLBACK"); return { status: "none" }; }
        await c.query(`UPDATE players SET last_claim=$2, lifetime_paid=lifetime_paid+$3 WHERE wallet=$1`, [wallet, now, amount]);
        const ins = await c.query(`INSERT INTO payouts(wallet,amount,status) VALUES($1,$2,'pending') RETURNING id`, [wallet, amount]);
        await c.query("COMMIT");
        return { status: "ok", amount, payoutId: ins.rows[0].id, prevLastClaim: Number(p.last_claim) };
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
      const r = await pool.query(`SELECT wallet, profile FROM players WHERE profile IS NOT NULL`);
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
      const r = await pool.query(`SELECT profile FROM players WHERE profile IS NOT NULL`);
      let chikis = 0, holders = 0, legends = 0;
      for (const row of r.rows) { const c = row.profile?.chikis || []; if (c.length) { holders++; chikis += c.length; legends += c.filter(x => x.isLegend).length; } }
      return { chikis, holders, legends };
    },
  };
}

function memStore() {
  const players = new Map(); const payouts = []; const presenceMap = new Map();
  const get = (w) => players.get(w);
  return {
    kind: "memory",
    async init() {},
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
      const amount = await compute(p);
      if (!(amount > 0)) return { status: "none" };
      const prev = p.last_claim; p.last_claim = now; p.lifetime_paid += amount;
      const id = payouts.push({ id: payouts.length + 1, wallet, amount, status: "pending", t: now }) ;
      return { status: "ok", amount, payoutId: id, prevLastClaim: prev };
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
      for (const p of players.values()) { const c = p.profile?.chikis || []; if (c.length) { holders++; chikis += c.length; legends += c.filter(x => x.isLegend).length; } }
      return { chikis, holders, legends };
    },
  };
}

const store = makeStore();

/* ----------------------------- chat ----------------------------- */
/* wallets allowed to pin/announce: ADMIN_WALLETS list + the team wallet */
const ADMIN_SET = new Set(String(ADMIN_WALLETS || "").split(",").map(s => s.trim()).filter(Boolean));
if (TEAM_WALLET) ADMIN_SET.add(TEAM_WALLET.trim());
const isAdminWallet = (w) => ADMIN_SET.has(w);
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
        return { messages: r.rows.reverse(), pinned: p.rows[0] || null };
      },
      async pin(id, on) {
        if (on) await pool.query(`UPDATE chat SET pinned=false WHERE pinned=true`);
        await pool.query(`UPDATE chat SET pinned=$2 WHERE id=$1`, [id, !!on]);
      },
    };
  }
  const msgs = []; let seq = 1;
  return {
    kind: "memory",
    async init() {},
    async send(m) {
      const row = { id: seq++, ts: m.ts, wallet: m.wallet, handle: m.handle || null, body: m.body, to_wallet: m.to || null, pinned: !!m.pinned };
      msgs.push(row); if (msgs.length > 500) msgs.shift(); return row;
    },
    async fetch(wallet, since) {
      const messages = msgs.filter(x => x.id > (since || 0) && (!x.to_wallet || x.to_wallet === wallet || x.wallet === wallet)).slice(-200);
      const pinned = [...msgs].reverse().find(x => x.pinned) || null;
      return { messages, pinned };
    },
    async pin(id, on) { if (on) msgs.forEach(x => x.pinned = false); const m = msgs.find(x => x.id === id); if (m) m.pinned = !!on; },
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
let _statsCache = { t: 0, data: null };
async function getStats() {
  if (_statsCache.data && Date.now() - _statsCache.t < 15000) return _statsCache.data;
  const out = { network: NETWORK, minHold: MIN, whaleMin: WHALE_MIN, poolReserveSol: RESERVE };
  try { out.poolSol = await poolSol(); } catch (e) {}
  try { out.players = await store.count(); } catch (e) {}
  try { out.dailyPaidSol = await store.dailyTotal(); } catch (e) {}
  try { const p = await store.presence(PRESENCE_WINDOW); out.activeUsers = p.activeUsers; out.chikimons = p.chikimons; } catch (e) {}
  if (MINT) { try { const s = await conn.getTokenSupply(MINT); out.supply = s.value.uiAmount; out.burned = Math.max(0, SUPPLY_TOTAL - (s.value.uiAmount || 0)); } catch (e) {} }
  if (TEAM_WALLET) {
    try { out.teamSol = (await conn.getBalance(new PublicKey(TEAM_WALLET))) / LAMPORTS_PER_SOL; } catch (e) {}
    try { out.teamChiki = await chikiBalance(TEAM_WALLET); } catch (e) {}
  }
  try { const t = await store.claimedTotals(); out.claimedChikis = t.chikis; out.holders = t.holders; out.legendsHatched = t.legends; } catch (e) {}
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
  dailyCapSol: DAILY_CAP, perWalletDailySol: WALLET_DAILY, poolReserveSol: RESERVE,
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
    let balance = 0, eligible = true;
    if (verifyOn) { balance = await chikiBalance(wallet); eligible = balance >= MIN; }
    const p = await store.touch(wallet, eligible, balance);
    const chikis = eligible ? (chikiCount(balance, p.whale_since) || 1) : 0;
    const whalePending = eligible && balance >= WHALE_MIN && chikis < 2;
    const whaleReadyInMs = whalePending && p.whale_since ? Math.max(0, WHALE_HOLD_MS - (Date.now() - Number(p.whale_since))) : 0;
    res.json({ wallet, eligible, balance, chikis, whalePending, whaleReadyInMs, minHold: MIN, verified: verifyOn, firstSeen: Number(p.first_seen), profile: p.profile || null });
  } catch (e) { res.status(500).json({ error: "verify failed: " + String(e.message || e) }); }
});

// Save / load a wallet's game profile (chikis + progress) so it follows the wallet across devices.
app.post("/profile", async (req, res) => {
  const wallet = req.body?.wallet, profile = req.body?.profile;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  if (!profile || typeof profile !== "object") return res.status(400).json({ error: "'profile' object required" });
  if (JSON.stringify(profile).length > 8000) return res.status(413).json({ error: "profile too large" });
  const now = Date.now();
  if (now - (_lastSave.get(wallet) || 0) < 600) return res.json({ ok: true, throttled: true });   // ignore rapid-fire writes (anti-spam)
  _lastSave.set(wallet, now);
  try {
    const prev = await store.getProfile(wallet);
    // admins are trusted (creator testing); everyone else is clamped to legal values
    const safe = isAdminWallet(wallet) ? profile : sanitizeProfile(prev, profile);
    safe._serverSavedAt = now;   // authoritative "last seen" for offline progression
    await store.setProfile(wallet, safe);
    res.json({ ok: true, serverSavedAt: safe._serverSavedAt });
  } catch (e) { res.status(500).json({ error: "save failed: " + String(e.message || e) }); }
});

app.get("/profile", async (req, res) => {
  const wallet = req.query?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  try { res.json({ wallet, profile: await store.getProfile(wallet) }); }
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
  try {
    let bal = 0; try { bal = await chikiBalance(wallet); } catch (e) {}
    const p = await store.touch(wallet, bal >= MIN, bal);
    const eligible = !verifyOn || bal >= MIN;
    const chikis = eligible ? (chikiCount(bal, p.whale_since) || 1) : 0;   // below the hold threshold ⇒ no accrual (matches /claim)
    const lastClaim = Number(p.last_claim);
    const minutes = Math.min((Date.now() - lastClaim) / 60000, ACCRUAL_CAP);
    const gross = Math.max(0, seededEarn(wallet, lastClaim, chikis, minutes));
    const claimable = Math.floor(gross * (1 - CLAIM_TAX) * 1e6) / 1e6;   /* net after the SOL claim tax (tax stays in treasury) */
    /* seed params let the client mirror the EXACT same rarity sequence it will be paid for */
    res.json({ wallet, claimableSol: claimable, claimGrossSol: Math.floor(gross*1e6)/1e6, claimTaxPct: Math.round(CLAIM_TAX*100), lifetimePaid: await store.earned(wallet),
      eligible, minHold: MIN, balance: bal, lastClaim, chikis, taskSec: TASK_SEC, mult: MULT, accrualCap: ACCRUAL_CAP, raritySol: RARITY_SOL });
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
app.get("/feed", async (req, res) => {
  const since = Number(req.query?.since) || 0;
  res.json({ events: feedEvents.filter(e => e.id > since) });
});
// Every Chiki ever claimed (all saved profiles, online or not) — so the world reflects real ownership.
app.get("/allchikis", async (req, res) => {
  try { res.json({ chikis: await store.allChikis(req.query?.exclude || "", Math.min(160, Number(req.query?.cap) || 120)) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/claim", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });

  let bal = 0;
  try { bal = await chikiBalance(wallet); } catch (e) {}
  if (verifyOn && bal < MIN) return res.status(403).json({ error: `below ${MIN.toLocaleString()} $CHIKI threshold`, balance: bal });
  const pRow = await store.touch(wallet, bal >= MIN, bal);
  const chikis = chikiCount(bal, pRow.whale_since) || 1;   // 2nd Chiki only after the whale hold time
  let pool, daily, walletPaid;
  try { pool = await poolSol(); daily = await store.dailyTotal(); walletPaid = await store.walletDaily(wallet); }
  catch (e) { return res.status(500).json({ error: "rpc/db error: " + String(e.message || e) }); }
  if (pool <= RESERVE) return res.status(503).json({ error: "reward pool is low — payouts paused, please try again later", poolSol: pool });
  if (daily >= DAILY_CAP) return res.status(429).json({ error: "daily payout cap reached", dailyCapSol: DAILY_CAP });
  if (WALLET_DAILY > 0 && walletPaid >= WALLET_DAILY) return res.status(429).json({ error: "your daily claim limit is reached — come back tomorrow", perWalletDailySol: WALLET_DAILY });

  const now = Date.now();
  const compute = (p) => {
    const minutes = Math.min((now - Number(p.last_claim)) / 60_000, ACCRUAL_CAP);
    let amt = seededEarn(wallet, Number(p.last_claim), chikis, minutes);   /* deterministic seeded rarity earnings (synced with the client) */
    amt = amt * (1 - CLAIM_TAX);                                           /* SOL claim tax withheld — the tax stays in the treasury */
    amt = Math.min(amt, (CAP > 0 ? CAP : Infinity), Math.max(0, DAILY_CAP - daily), (WALLET_DAILY > 0 ? Math.max(0, WALLET_DAILY - walletPaid) : Infinity), Math.max(0, pool - RESERVE));
    return Math.floor(amt * 1e6) / 1e6;
  };

  let r;
  try { r = await store.reserve(wallet, now, compute); }
  catch (e) { return res.status(500).json({ error: "reserve failed: " + String(e.message || e) }); }
  if (r.status === "cooldown") return res.status(429).json({ error: "cooldown", retryInMs: r.retryInMs });
  if (r.status === "hold") return res.status(403).json({ error: "wallet too new — min hold time not met", waitMs: r.waitMs });
  if (r.status !== "ok") return res.status(409).json({ error: "nothing to claim yet (or pool/cap empty)", poolSol: pool });

  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: treasury.publicKey, toPubkey: new PublicKey(wallet),
      lamports: Math.floor(r.amount * LAMPORTS_PER_SOL),
    }));
    const sig = await conn.sendTransaction(tx, [treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    await store.confirm(r.payoutId, sig);
    pushFeed("claim", { wallet, short: wallet.slice(0, 4) + "…" + wallet.slice(-4), amountSol: r.amount, signature: sig });
    res.json({ ok: true, wallet, amountSol: r.amount, signature: sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=${NETWORK}` });
  } catch (e) {
    await store.fail(r.payoutId, wallet, r.prevLastClaim, r.amount); // refund cooldown so a failed payout isn't lost
    res.status(500).json({ error: "payout failed: " + String(e.message || e) });
  }
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

await store.init();
await chat.init();
app.listen(Number(PORT), () => {
  console.log(`Chiki backend v2 on :${PORT} · ${NETWORK} · store=${store.kind} · treasury ${treasury.publicKey.toBase58()}`);
  console.log(`verifyHolders=${verifyOn} · holdMin=${MIN_HOLD_MINUTES} · dailyCap=${DAILY_CAP} SOL`);
});
