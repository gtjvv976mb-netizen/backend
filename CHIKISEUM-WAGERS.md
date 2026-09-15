# Chikiseum SOL wagers

Two players stake the same amount of SOL on one live arena match. The winner takes the pot; a
match with no winner refunds both. This document is the contract for the client (the in-game
"pill"), the operator, and anyone reading the ledger.

## Custody, in one paragraph

Custody is **server-held**. Both stakes are transferred into the treasury wallet (the same wallet
that pays task rewards) *before* the match is created, and the treasury pays the winner or
refunds both afterwards. That means the host holding `TREASURY_SECRET` custodies player money for
the length of a match. The caps are low on purpose (0.05 SOL per stake, 0.25 SOL per wallet per
day by default) and the feature is **off by default** (`CHIK_WAGERS=on` to accept new wagers).

Stakes are never spendable by anything else: `poolSol()` — what `/claim`, the earning rate and
`/stats` see — is the treasury balance **minus** open wager liability. `/pool` reports the raw
balance as `treasurySol` and the held stakes as `wagerEscrowSol`.

## Lifecycle

```
posted ──deposit A──▶ open ──accept──▶ accepting ──deposit B──▶ funded ──pair──▶ matched
  │                    │                  │                                        │
  └─ expires (10 min)  └─ expires (30 min) └─ acceptor unfunded (5 min) → open      └─ match ends
     nothing owed         → refund A          (or backs out → open)                      │
                                                                              ┌──────────┴──────────┐
                                                                    winner / forfeit          anything else
                                                                    pay winner pot−rake     refund both stakes
                                                                              └──────────┬──────────┘
                                                                                     settling → settled / refunded
```

- A wager is on the board only once the **challenger's deposit is verified** — no unfunded bait.
- **Pairing is immediate** when the second deposit lands: the match is created in the same step,
  or (if the challenger has left / is now incompatible) both are refunded in the same step.
  Nothing waits in between.
- The match is an **ordinary arena match**: same engine, same rules, same battle XP. The engine
  never sees money; the ledger reads its terminal status afterwards.
- **Outcomes:** `finished` with a winner, or `forfeit` → winner is paid `2 × stake − rake`.
  `finished` with equal HP, `draw`, `cancelled`, `ready_timeout`, `admission_revoked`,
  `server_restart`, or a match the engine no longer has → **both refunded in full**.
- Abandoning a wagered fight (cancel, or 45 s absent) is a **forfeit**, and pays the opponent.
  With money on the line, walking away cannot be free.
- A restart **never invents a winner**: matches in progress are cancelled and refunded.

## Deposits: what the client must send

The player signs one SOL transfer to the treasury carrying a **memo**:

```
to:      <deposit_to from wager_board / wager_post / wager_accept>
amount:  exactly stake_lamports (an overpayment is credited and the excess refunded automatically)
memo:    chikiseum-wager:<wager_id>:<side>        side = A (challenger) or B (acceptor)
```

Use the SPL Memo program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). Then POST the
transaction signature to `wager_deposit`. The server reads the transaction from the chain and
credits it only if **all** of these hold: it succeeded; the player's wallet **signed** it; the
treasury **gained** at least the stake; the memo names **this wager and this side**; and the
signature has **never been used before**. A transaction carrying two wager memos funds neither.

The exact memo string is returned as `wager.you.memo` on every response for your side.

## Routes

All under `/chikiseum/live/v1/`, POST, JSON, with the same auth fields as every arena command
(`wallet, mktToken, sessionId, sessionEpoch`) and an **admitted fighter** (call `session` first).

| route | body | what it does |
|---|---|---|
| `wager_board` | – | Open (funded) challenges, newest first. `deposit_to` is the treasury address. |
| `wager_mine` | – | Your live wager (`active`), ones with payouts in flight (`pending`), recent finished ones. |
| `wager_post` | `stake_sol` | Post a challenge. Returns the wager with `you.memo`; fund it with `wager_deposit`. |
| `wager_accept` | `wager_id` | Lock an open challenge (your fighter must be compatible, the challenger present). Fund it with `wager_deposit`. |
| `wager_deposit` | `wager_id, signature` | Credit your deposit. When it completes the funding, the response has `matched: true` and `match_id` — go `ready`. |
| `wager_withdraw` | `wager_id` | Challenger: cancel (refund if funded). Acceptor before funding: back out. Locked once matched. |

Error codes worth handling: `WAGERS_DISABLED`, `WAGER_BUSY` (one live wager per wallet),
`DAILY_LIMIT`, `STAKE_TOO_SMALL/LARGE`, `INCOMPATIBLE`, `CHALLENGER_AWAY`, `WAGER_NOT_OPEN`,
`DEPOSIT_UNVERIFIED` (not on chain yet — retry), `DEPOSIT_WRONG_SIGNER`, `DEPOSIT_WRONG_MEMO`,
`DEPOSIT_SHORT`, `DEPOSIT_REPLAYED`, `WAGER_LOCKED`, `ACCOUNT_BUSY` (finish your current match).

`/chikiseum/live/v1/health` carries a `wagers` block: `enabled`, `configured`, `real_sol_enabled`,
caps, counts by state, `stuck_legs`, `liability_sol`.

## Payouts: how money leaves

Each payment is a **leg** (`W` winner, `RA`/`RB` refunds, `OA`/`OB` overpayment returns), sent by
the treasury with the memo `chikiseum-wager:<wager_id>:<leg>`.

- A leg is written to durable state as `sending` **before** the transaction is broadcast.
- A confirmed transaction closes the leg. An expired blockhash or an on-chain failure means
  nothing moved: the leg is rebuilt and resent, with backoff.
- A send that fails **before** broadcast (preflight, bad blockhash) is retried. A send whose
  outcome is **ambiguous** (timeout, socket reset) is *not* retried blindly: the leg stays
  `sending` and is reconciled by looking for its memo among the treasury's recent transactions.
  A candidate counts only if the **treasury signed it** and the **payee received the lamports** —
  a player can put any memo on any transaction; they cannot sign as the treasury.
- The same reconciliation runs on boot for anything a crash left in `sending`.
- After `max_attempts` (5) a leg is **stuck** and waits for an operator. A stuck payout is
  recoverable; a double payout is not.

## Operator: stuck legs

`POST /chikiseum/live/v1/wager_admin` with the usual admin signature
(`adminWallet, authMsg, authSig`; the message must contain `action:chikiseum_wager_admin`, a fresh
`ts:` and `nonce:`).

| `action` | extra fields | effect |
|---|---|---|
| `stuck` | – | list stuck legs and current liability |
| `retry` | `wager_id, leg_id` | release a stuck leg for automatic retry (after you fixed the cause, e.g. funded fees) |
| `resolve` | `wager_id, leg_id, sig` | mark it paid by hand — only after you verified `sig` on the explorer, or paid it yourself |

## Configuration

| env | default | meaning |
|---|---|---|
| `CHIK_WAGERS` | `off` | `on` to accept new wagers. Off never strands money: held stakes keep settling. |
| `CHIK_WAGER_MIN_SOL` | `0.001` | minimum stake |
| `CHIK_WAGER_MAX_SOL` | `0.05` | maximum stake |
| `CHIK_WAGER_WALLET_DAILY_SOL` | `0.25` | stakes one wallet may risk per UTC day (posted + accepted, refunded or not) |
| `CHIK_WAGER_RAKE_BPS` | `0` | house share of the pot, basis points (max 2000); recorded per wager at post time |

The treasury must hold enough SOL for transaction fees (~0.000005 SOL per payout). Stakes
themselves are covered by the deposits.

## What is tested

`npm run test:wagers` — 56 tests, no key, no network:

- ledger (`chikiseum-wagers.test.js`): stake bounds, caps, one-live-wager rule, every deposit
  refusal, signature replay across wagers, overpayment, accept/back-out/expiry, every outcome
  mapping, rake, idempotent settlement under repeated/changed observations, the full payout state
  machine, retry/stuck/operator paths, snapshot round-trip, and ten corruptions that must fail closed.
- service (`chikiseum-wagers-service.test.js`): the whole path through the real engine with a
  real fight; draw, forfeit, restart refund; crash between `sending` and the broadcast record with
  the memo found / not found; ambiguous send; pre-broadcast failure; expired transaction;
  challenger gone at funding; incompatible fighters; disabled-but-holding still pays; a saved
  ledger with no configuration fails boot closed; the HTTP operator route.
- chain adapters (`chikiseum-wager-chain.test.js`): parsed-transaction reading, the forged-memo
  attack on reconciliation, send-error classification, status mapping.

Not covered, by design: wallet signature verification (the arena's existing `/verify` session),
and a real RPC. Run one small mainnet wager with the caps at their defaults before raising them.
