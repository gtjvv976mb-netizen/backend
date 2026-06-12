// Chiki Monsters — backend: holder verification + server-signed SOL payouts.
// Run on devnet first (NETWORK=devnet). Never commit your .env.
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";

dotenv.config();
const {
  NETWORK = "devnet",
  RPC_URL,
  CHIKI_MINT,
  MIN_HOLD = "500000",
  VERIFY_HOLDERS = "false",
  TREASURY_SECRET,
  TEAM_WALLET = "",
  REWARD_RATE_PER_MIN = "0.0008",
  MAX_CLAIM_SOL = "0.05",
  CLAIM_COOLDOWN_SEC = "30",
  PORT = "8787",
} = process.env;

if (!RPC_URL || !TREASURY_SECRET) {
  console.error("✖ Missing RPC_URL or TREASURY_SECRET in .env (copy .env.example → .env and fill it in).");
  process.exit(1);
}

function parseSecret(s) {
  s = s.trim();
  if (s.startsWith("[")) return Uint8Array.from(JSON.parse(s)); // JSON array form
  return bs58.decode(s);                                        // base58 form
}

const conn = new Connection(RPC_URL, "confirmed");
const treasury = Keypair.fromSecretKey(parseSecret(TREASURY_SECRET));
const MINT = CHIKI_MINT ? new PublicKey(CHIKI_MINT) : null;
const MIN = Number(MIN_HOLD);
const RATE = Number(REWARD_RATE_PER_MIN);
const CAP = Number(MAX_CLAIM_SOL);
const COOLDOWN = Number(CLAIM_COOLDOWN_SEC) * 1000;
const verifyOn = String(VERIFY_HOLDERS).toLowerCase() === "true";

// In-memory player ledger. For production, back this with a real DB.
const players = new Map(); // wallet -> { lastClaim, eligible, balance, lifetime }

function isPubkey(s) { try { new PublicKey(s); return true; } catch { return false; } }

async function chikiBalance(owner) {
  if (!MINT) return 0;
  try {
    const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: MINT });
    let bal = 0;
    for (const { account } of res.value) bal += account.data.parsed.info.tokenAmount.uiAmount || 0;
    return bal;
  } catch { return 0; }
}

async function poolSol() {
  const lam = await conn.getBalance(treasury.publicKey);
  return lam / LAMPORTS_PER_SOL;
}

const app = express();
app.use(cors());
app.use(express.json());

// Health / config
app.get("/health", async (_req, res) => {
  res.json({
    ok: true, network: NETWORK, verifyHolders: verifyOn,
    treasury: treasury.publicKey.toBase58(),
    team: TEAM_WALLET || null, mint: CHIKI_MINT || null, minHold: MIN,
  });
});

// Live pool status
app.get("/pool", async (_req, res) => {
  try { res.json({ poolSol: await poolSol(), players: players.size }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Verify a wallet's eligibility (reads on-chain $CHIKI balance via RPC)
app.post("/verify", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });
  let balance = 0, eligible = true;
  if (verifyOn) { balance = await chikiBalance(wallet); eligible = balance >= MIN; }
  const chikis = eligible ? (balance >= 1_000_000 ? 2 : 1) : 0;
  const p = players.get(wallet) || { lastClaim: 0, lifetime: 0 };
  players.set(wallet, { ...p, eligible, balance, lastSeen: Date.now() });
  res.json({ wallet, eligible, balance, chikis, minHold: MIN, verified: verifyOn });
});

// Claim accrued SOL — server-authoritative (client cannot dictate the amount).
app.post("/claim", async (req, res) => {
  const wallet = req.body?.wallet;
  if (!wallet || !isPubkey(wallet)) return res.status(400).json({ error: "valid 'wallet' required" });

  // Re-check eligibility at claim time (anti-abuse)
  let balance = 0, eligible = true;
  if (verifyOn) { balance = await chikiBalance(wallet); eligible = balance >= MIN; }
  if (!eligible) return res.status(403).json({ error: `below ${MIN.toLocaleString()} $CHIKI threshold`, balance });

  const now = Date.now();
  const p = players.get(wallet) || { lastClaim: now - 60_000, lifetime: 0 };
  if (now - p.lastClaim < COOLDOWN)
    return res.status(429).json({ error: "cooldown", retryInMs: COOLDOWN - (now - p.lastClaim) });

  // Accrue reward = elapsed minutes * rate, capped, and bounded by the live pool.
  const minutes = Math.min((now - p.lastClaim) / 60_000, 60); // cap accrual window at 1h
  let amount = Math.min(minutes * RATE, CAP);
  const pool = await poolSol();
  amount = Math.min(amount, Math.max(0, pool - 0.001)); // keep a little for rent/fees
  amount = Math.floor(amount * 1e6) / 1e6;
  if (amount <= 0) return res.status(409).json({ error: "nothing to claim yet (or pool empty)", poolSol: pool });

  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: new PublicKey(wallet),
      lamports: Math.floor(amount * LAMPORTS_PER_SOL),
    }));
    const sig = await conn.sendTransaction(tx, [treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    players.set(wallet, { ...p, lastClaim: now, eligible, balance, lifetime: (p.lifetime || 0) + amount });
    res.json({
      ok: true, wallet, amountSol: amount, signature: sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=${NETWORK}`,
      lifetimeSol: (p.lifetime || 0) + amount,
    });
  } catch (e) {
    res.status(500).json({ error: "payout failed: " + String(e.message || e) });
  }
});

// One-shot devnet funding helper: open /fund in a browser to airdrop SOL to the treasury.
app.get("/fund", async (req, res) => {
  if (NETWORK !== "devnet") return res.status(400).json({ error: "funding helper is devnet-only" });
  const amt = Math.min(2, Number(req.query.amount || 1));
  const endpoints = [RPC_URL, "https://api.devnet.solana.com"];
  for (const url of endpoints) {
    try {
      const c = new Connection(url, "confirmed");
      const sig = await c.requestAirdrop(treasury.publicKey, Math.floor(amt * LAMPORTS_PER_SOL));
      await c.confirmTransaction(sig, "confirmed");
      const bal = (await c.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
      return res.json({ ok: true, airdropped: amt, poolSol: bal, signature: sig });
    } catch (e) { /* try the next endpoint */ }
  }
  res.status(502).json({ error: "airdrop failed (devnet faucets are rate-limited) — reload to retry in a moment" });
});

app.listen(Number(PORT), () => {
  console.log(`Chiki backend on :${PORT}  ·  ${NETWORK}  ·  treasury ${treasury.publicKey.toBase58()}`);
  console.log(`Holder verification: ${verifyOn ? "ON" : "OFF (devnet test mode)"}`);
});
