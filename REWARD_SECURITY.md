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

## 1b. Reward model — race to finish, ADMIN-GATED payout (first 100 winners)

The payout is a **fixed pool split among a capped number of winners**, released by **you**, not auto-sent:

- The **first `WINNER_CAP` (100) wallets** to **complete the whole 7-quest line** are recorded as
  winners, each entitled to `WINNER_REWARD` (**100,000**) $CHIKI. **Hard total = 100 × 100,000 =
  10,000,000 $CHIKI** — the pool can never pay more.
- **No $CHIKI is sent on completion.** Completing the final quest only *reserves a winner slot*. You
  review the list and **release the pool yourself** via an admin-signed batch endpoint — a human
  checkpoint before any token moves (catches obvious scripting/Sybil).
- **Winner slots are reserved ATOMICALLY in Postgres** (`reserveWinner()`): a transaction takes a
  global `pg_advisory_xact_lock`, checks `wallet` (PK) + `COUNT(*) < cap`, and inserts (`rank` UNIQUE).
  This is **cross-instance safe** — a 101st winner is impossible even if Render runs multiple instances.
  Unit-tested: 250 concurrent finishers → exactly 100 winners, unique ranks, total exactly 10,000,000.
- **Winning requires a wallet signature** (`verifyWalletSig` on the final quest) — no anonymous
  curl-to-win — plus **fail-closed eligibility**: the wallet must currently hold `QUEST_MIN_HOLD`
  $CHIKI *and* be aged in (`QUEST_MIN_HOLD_MINUTES`, anti-Sybil), enforced regardless of `VERIFY_HOLDERS`.
- **Payout is idempotent** (`_payoutOne`): each winner is paid **exactly once**. A per-wallet advisory
  lock + a 2-minute in-flight window + **on-chain signature reconciliation** (the sig is recorded
  *before* confirming) mean a confirm-timeout, a retry, or a crash **never double-pays**. Unit-tested.

### Residual risk you should know
The game is **client-authoritative** — the backend can't *prove* someone genuinely played vs. scripted
the completion calls. The wallet signature proves *ownership*, and the hold-time raises Sybil cost, but
a determined actor who owns wallets and holds `QUEST_MIN_HOLD` in each could still script the questline.
**This is exactly why payout is admin-gated:** review `GET /quest/winners` before you release funds.

### Admin runbook — releasing the pool
1. Set `ADMIN_WALLETS` (Render env) to your admin wallet address(es).
2. Fund the hot wallet with up to **10,000,000 $CHIKI** + ~0.05 SOL for fees.
3. Review winners: `GET /quest/winners?adminWallet=<W>&authMsg=<M>&authSig=<S>` (admin-signed) — shows
   rank, wallet, balance-at-win, paid status, and `poolNeededChiki`.
4. Release in small idempotent batches: `POST /quest/payout {adminWallet,authMsg,authSig, max:10}` —
   repeat until `remainingUnpaid` is 0. Pay one wallet with `{...,wallet:"<addr>"}`. Safe to re-run: it
   skips already-paid, reconciles any unconfirmed tx, and never double-sends.

## 2. What the code already enforces (defense in depth)

- **Server-authoritative rewards** — the prize is a **fixed** amount, granted **once per wallet**, only
  after the full questline is completed **in order** with a minimum real-time gap. Hard per-wallet
  ceiling = one prize (`WINNER_REWARD`). The client can't invent a balance.
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
| `WINNER_CAP` | `100` | How many wallets get paid (first N to finish the questline). |
| `WINNER_REWARD` | `100000` | $CHIKI each winner gets. `WINNER_CAP × WINNER_REWARD` = the hard total pool (10,000,000). |
| `ADMIN_WALLETS` | *(empty)* | **Required to release funds.** Comma-separated admin wallet address(es) allowed to call `/quest/payout` (admin-signed). |
| `QUEST_MIN_HOLD` | `MIN_HOLD` (500000) | Winner must currently hold ≥ this much $CHIKI (fail-closed, ignores `VERIFY_HOLDERS`). |
| `QUEST_MIN_HOLD_MINUTES` | `60` | Anti-Sybil: wallet must have been first-seen this many minutes before it can win a slot. |
| `QUEST_MIN_GAP_SEC` | `20` | Min real seconds between two quest completions (anti-bot). |

**To change the numbers** (e.g. 50 winners of 200k, or 200 winners of 50k) set `WINNER_CAP` and
`WINNER_REWARD` on Render. Fund the hot wallet with up to `WINNER_CAP × WINNER_REWARD` $CHIKI.

> The old per-claim/daily/breaker vars (`PER_CLAIM_CHIKI`, `WALLET_DAILY_CHIKI`, `BREAKER_HOURLY_CHIKI`,
> `MIN_CLAIM_CHIKI`) no longer apply — there is no user-triggered claim. Payout is the admin batch
> (`/quest/payout`), which is idempotent and paced by you.

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
