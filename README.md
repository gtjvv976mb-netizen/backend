# Chiki Monsters — Backend (holder verification + SOL payouts)

A tiny Node service that does the two things the game **can't** do safely in the browser:
1. **Verify** a wallet's on-chain $CHIKI balance (gate at 500,000).
2. **Sign real SOL payouts** from your treasury wallet — server-authoritative, so players can't fake the amount.

Start on **devnet** (test SOL, zero risk). Flip to mainnet only after you've tested the loop.

---

## 1. Setup
```bash
cd chiki-backend
npm install
cp .env.example .env        # then edit .env
```

## 2. Make a devnet test treasury (optional)
If you want a throwaway treasury for testing instead of your real one:
```bash
npm run treasury            # prints a PUBLIC KEY + SECRET array
```
Put the printed secret array into `.env` as `TREASURY_SECRET`, then fund it:
```bash
# with the Solana CLI:
solana airdrop 2 <PUBLIC_KEY> --url devnet
# or use the web faucet: https://faucet.solana.com
```

> Use your **real** treasury only on mainnet, once everything works. Never commit `.env`.

## 3. Fill in .env
- `NETWORK=devnet` and `RPC_URL=` your **devnet** Helius URL (`https://devnet.helius-rpc.com/?api-key=...`)
- `VERIFY_HOLDERS=false` for devnet (the real mainnet $CHIKI mint doesn't exist on devnet, so skip the check to test payouts). Set `true` when `RPC_URL` is mainnet.
- `TREASURY_SECRET=` the treasury secret (JSON array or base58)
- `TEAM_WALLET=` your team wallet public key

## 4. Run
```bash
npm start
# Chiki backend on :8787 · devnet · treasury <addr>
```

## 5. Endpoints
| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/health` | — | config + treasury address |
| GET | `/pool` | — | live treasury SOL balance |
| POST | `/verify` | `{ "wallet": "<pubkey>" }` | reads $CHIKI balance, returns `{ eligible, balance, chikis }` |
| POST | `/claim` | `{ "wallet": "<pubkey>" }` | pays accrued SOL from treasury → wallet, returns tx signature |

Quick test:
```bash
curl localhost:8787/health
curl -X POST localhost:8787/verify -H 'content-type: application/json' -d '{"wallet":"<YOUR_WALLET>"}'
curl -X POST localhost:8787/claim  -H 'content-type: application/json' -d '{"wallet":"<YOUR_WALLET>"}'
```

## 6. Wire the game to it
In `play.html`, after Phantom connects, point the game at your backend instead of the simulated balance:
```js
const BACKEND = "http://localhost:8787";           // your deployed URL later

// eligibility (replaces the demo balance):
const v = await fetch(BACKEND + "/verify", {method:"POST",
  headers:{"content-type":"application/json"}, body:JSON.stringify({wallet: pk})}).then(r=>r.json());
if (!v.eligible) { /* show "top up to 500k" */ }

// when the player presses "Claim" (or on a timer):
const c = await fetch(BACKEND + "/claim", {method:"POST",
  headers:{"content-type":"application/json"}, body:JSON.stringify({wallet: pk})}).then(r=>r.json());
if (c.ok) addFeed(`💰 Claimed ${c.amountSol} SOL — ${c.signature.slice(0,8)}…`);
```

## 7. Reward economy
`/claim` accrues `REWARD_RATE_PER_MIN` SOL per eligible minute (capped per claim, bounded by the live pool, with a per-wallet cooldown). Tune these in `.env`. The pool is just the treasury's SOL balance — in production you'd top it up from your **pump.fun creator fees**.

## 8. Going to mainnet (checklist)
- `NETWORK=mainnet`, mainnet `RPC_URL`, `VERIFY_HOLDERS=true`.
- Treasury = a wallet holding only what you can afford to distribute (ideally a **Squads multisig**).
- Make payouts scale to **actual fee inflows** so the pool can't drain.
- Add anti-sybil rules (min hold time, per-wallet caps), persistent storage (Postgres/Redis), and rate limiting.
- Get a security + legal review before real money flows.

## The 20 / 45 / 35 upgrade split
That split (🔥 burn / 💰 pool / 🏦 team) applies to **upgrade purchases**, which the *player* signs from their own wallet — the backend doesn't move player funds. Build that as a separate transaction the player approves: 20% buy-burn $CHIKI, 45% to the pool/treasury, 35% to `TEAM_WALLET`.

---

## Deploy to Render (one-click)
This repo includes `render.yaml`. To deploy:
1. Push the `chiki-backend` folder to a GitHub repo (its own repo, or a subfolder).
2. In **Render → New → Blueprint**, connect that repo. Render reads `render.yaml`.
3. When prompted, paste the secret env vars: `RPC_URL` (your devnet Helius URL), `TREASURY_SECRET`, `TEAM_WALLET`. (They're `sync:false`, so they live only in Render, never in git.)
4. Deploy. You'll get a URL like `https://chiki-backend.onrender.com`.
5. Test it: open `https://chiki-backend.onrender.com/health`.

Then in the game's `play.html`, set:
```js
const CHAIN={ MINT:"…", RPC:"…", BACKEND:"https://chiki-backend.onrender.com" };  // no trailing slash
```
and re-upload `play.html`.

> Render's **free** web service sleeps after ~15 min idle, so the first request after a nap takes a few seconds to wake. Fine for testing; upgrade or add a keep-alive ping for production.
