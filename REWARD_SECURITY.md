# Reward-payout security — READ BEFORE DEPLOY

Quest rewards now pay **real $CHIKI (SPL)** from the reward pool. This document explains why the
old wallet was drained, the fixes in code, and the **two things only you can do** to make it
unhackable: **rotate the key** and run a **hot/cold split**.

---

## 1. Why it was drained (diagnosis)

"Drains all SOL to one address every time the wallet replenishes" is the classic signature of a
**leaked private key + a sweeper bot** — NOT a backend bug. Once a key is exposed, an attacker's bot
watches the address and sweeps every incoming lamport to their own wallet, **completely bypassing
this server**. No server code can stop that; the only cure is a new key the attacker doesn't have.

The current `/quest/claim` and `/claim` are already redirect-safe (the payout destination is always
the *earning* wallet, never a client-chosen address; the amount is always the server ledger). So the
loss came from the key, not the endpoint.

**➡ Treat the old `TREASURY_SECRET` as permanently compromised. Never reuse it.**

---

## 2. What the code already enforces (defense in depth)

- **Server-authoritative rewards** — each main quest pays a **fixed** amount, **once**, **in order**,
  with a minimum real-time gap. Hard per-wallet ceiling = the sum of quest rewards. The client can't
  invent a balance.
- **Payout dest = the earner** — `payChiki()` sends to the wallet's own ATA. Never a client param.
- **Amount = server ledger** — never sent by the client.
- **Caps**: per-claim (`PER_CLAIM_CHIKI`), per-wallet-daily (`WALLET_DAILY_CHIKI`), pool reserve
  floor (`POOL_RESERVE_CHIKI`), min claim (`MIN_CLAIM_CHIKI`).
- **Global circuit breaker** (`BREAKER_HOURLY_CHIKI`) — total $CHIKI out across ALL wallets per
  rolling hour is capped; exceed it and every payout returns 503 until the window clears.
- **Write-before-send + per-wallet lock** — the pouch is debited *before* the transfer and a claim
  in flight blocks a second one, so a crash or double-submit can never double-pay.
- **No ATA creation** — we only pay wallets that already hold $CHIKI (guaranteed by the 500k play
  gate), so the treasury never spends rent on arbitrary addresses (a spam/grief vector).

---

## 3. What YOU must do — hot/cold split + key rotation

### a) Make a fresh HOT keypair (the server's signer)
```bash
solana-keygen new --no-bip39-passphrase -o hot.json
solana-keygen pubkey hot.json          # = the new reward-pool address
```
Set its secret as the server env var (Render → Environment), **nowhere else**:
```
TREASURY_SECRET = <contents of hot.json, the [12,34,…] array>
```
Never commit it. `.env` is already gitignored.

### b) Keep a COLD wallet (a hardware wallet / offline keypair) as the vault
- The **cold** wallet holds the BULK of the $CHIKI reward supply. Its key never touches the server.
- The **hot** wallet holds only a **small float** — enough for ~a day or two of payouts.
- Top the hot wallet up from cold **manually** (or via a separate, secured job) as it drains.
- **Result:** if the hot key ever leaks again, the most an attacker can take is the float, not the
  whole pool.

### c) Fund the hot wallet for $CHIKI payouts
Payouts are $CHIKI (SPL), so the hot wallet needs:
1. **$CHIKI tokens** — transfer the daily float of $CHIKI to the hot wallet's associated token
   account for the mint `CPYrgdAYWFQD74ZtsR8mEBWW7qnrXnegcn7gDMobpump`.
2. **A little SOL** — ~0.1 SOL for transaction fees (each payout costs ~0.000005 SOL).

### d) Optional but recommended
- Rotate the key on a schedule, and after anyone who had access leaves.
- Watch the hot wallet with an alert (e.g. a balance-drop webhook).
- Keep `BREAKER_HOURLY_CHIKI` set just above your realistic peak hourly payout.

---

## 4. New environment variables (set on Render)

| Var | Default | Meaning |
|---|---|---|
| `REWARDS_QUEST_ONLY` | `true` | Disables the old time-based SOL accrual (rewards are quest-only). |
| `CHIKI_DECIMALS` | `6` | $CHIKI SPL decimals (pump.fun = 6). |
| `QUEST_MIN_GAP_SEC` | `20` | Min real seconds between two quest completions (anti-bot). |
| `MIN_CLAIM_CHIKI` | `20` | Smallest claimable pouch. |
| `PER_CLAIM_CHIKI` | `1000` | Max $CHIKI paid in one claim. |
| `WALLET_DAILY_CHIKI` | `2000` | Max $CHIKI a single wallet can claim per day. |
| `POOL_RESERVE_CHIKI` | `0` | Never pay the pool below this $CHIKI floor. |
| `BREAKER_HOURLY_CHIKI` | `100000` | Global circuit breaker: max $CHIKI out per rolling hour. |

`RPC_URL`, `CHIKI_MINT`, `DATABASE_URL`, `VERIFY_HOLDERS` are unchanged from before.

---

## 5. After deploy — smoke test (devnet or with a spare wallet)
```bash
# server refuses skips and out-of-order:
curl -s -X POST $URL/quest/complete -H 'content-type: application/json' -d '{"wallet":"<W>","questId":"s_raid"}'   # 409
curl -s -X POST $URL/quest/complete -H 'content-type: application/json' -d '{"wallet":"<W>","questId":"s_meet"}'   # ok, pouch 20
curl -s "$URL/quest/state?wallet=<W>"                                                                              # pouchChiki:20
curl -s -X POST $URL/quest/claim    -H 'content-type: application/json' -d '{"wallet":"<W>"}'                      # pays real $CHIKI
```
The claim only succeeds once the hot wallet actually holds $CHIKI + a little SOL for fees.
