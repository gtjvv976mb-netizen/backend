# Chikoria backend

The API behind `chikimonsters.com`. Private repo, deploys to **Render**. The public site and the
game client live in `gtjvv976mb-netizen/chikimonsters` — **never put backend source there**, it is
a GitHub Pages tree and everything in it is served at `chikimonsters.com/<path>`.

`server.js` is ~19,500 lines and is the whole API. It is heavily commented, and the comments are
load-bearing: most of them record an incident. Read the comment before changing the line.

## Running the tests

```bash
npm test                 # build stamp + the Chikiseum suites + test:link
node app-account.test.mjs   # app-native accounts, against the real server
node realm-link.test.mjs    # iOS device pairing, against the real server
```

Both `.mjs` suites boot `server.js` on a random port with no database and no chain, and drive real
Ed25519 sign-ins. They are the ones to trust for anything touching identity.

**One failure in `npm test` is expected here**: `chikiseum-live-parity` needs a sibling Python tree
(`chikiseum_practice/`, a deliberately independent implementation) that is not checked out in the
Claude Code environment. It is environmental, not a regression. Everything else must be green.

## Identity: `wallet` is the primary key of everything

A base58 Solana address keys five Postgres tables, ~25 kv blobs, three kv key families whose *key*
embeds the address (`quest:`+w, `payhist:`+w, `signin:`+w), some sixty in-memory Maps, the
websocket (`ws._chik.wallet`), the Chikiseum admissions and the wager sides.

**Nothing is joined by a foreign key.** Every reference is a bare TEXT column or a plain string map
key, so a migration that misses one does not error — it silently orphans, and the player finds out
weeks later.

`isPubkey` (`new PublicKey(s)` in a try/catch) is a *format* test and nothing more. The load-bearing
check is `verifyWalletSig`, which demands a real Ed25519 signature.

## App-native accounts, and why the address is shaped that way

An iOS player who has never heard of Solana still needs an account, and the compiled Godot pack
cannot be rebuilt to accept a different kind of id. So they are given an address: **32 random bytes
that land OFF the Ed25519 curve.**

* It parses as a `PublicKey`, so every call site works unchanged.
* **No private key for it can exist** — mathematically absent, the same reason a PDA cannot sign.
* So `isWalletless(addr)` is a fact recomputed from the address at every call site, not a flag that
  can fall out of sync with a stale token or a dropped row. Every wallet a player can actually sign
  with is on-curve (measured: 1000/1000 generated keypairs), so there are no false positives.

**The price:** such an account can receive nothing on-chain — a payout to it is a burn with extra
steps. `unpayable()` guards every path that broadcasts a transaction naming a player's address, at
the lowest level so a future caller is covered too.

> **The system address `111…1` is ON the curve** (measured). `isWalletless` does *not* subsume the
> literal check against it. `unpayable()` is both checks, and both are needed.

## Two deny guards, and the difference matters

* **`APP_DENY_PATH`** — about *where the request came from*. Refuses the value-moving routes to any
  request carrying a Realm Link app-pool market token. Earning stays open, deliberately.
* **`NO_WALLET_DENY_PATH`** — about *what the account is*. Refuses the on-chain routes for an
  off-curve address, because an NFT minted to one could never be transferred, sold or burned by
  anyone. It keys on the **address**, so it holds no matter who is asking or what they hold.

`isAppToken` and `mktTokenOk` share one source of truth (`realmLink.appTokenWallet`). That coupling
is why a redeploy emptying the in-memory `appTokens` pool cannot fail *open*: the token stops being
recognised as an app token and stops authenticating at the same moment.

## The 500k $CHIKI gate — two traps in removing it

The gate is off for **app sessions only**; the website still enforces it, and
`app-account.test.mjs` has a control that fails if that stops being true.

1. **`MIN_HOLD=0` would also open every faucet.** `/claim`, `/chat/send` and the ten 1,000,000
   $CHIKI quest winner slots re-read `holdOk` for themselves. The waiver is scoped to *entry* only,
   exactly as the pre-existing OPEN-GATES event does, and `holdOk` stays the honest on-chain answer.
2. **Setting `eligible` alone does nothing.** The compiled game does not read it — `Onboarding`
   recomputes the gate itself and only `gateWaived` overrides it. Confirmed by decoding the shipped
   bytecode. `app-account.test.mjs` asserts `gateWaived`, not `eligible`.

## Bind: it refuses more than it moves, on purpose

`bindAppAccount()` moves an app-native account onto a real wallet. It leans on a property the guards
above give for free — such an account is *provably empty* in almost every subsystem, because it
could never reach them — but **checks every one of those "cannot"s anyway** and refuses on a
surprise. A player told "not yet" has lost nothing; a half-migrated one has lost something nobody
can reconstruct. Two live cloud saves are refused outright rather than merged, because the game
resolves saves wholesale by newest-saved with no field merge.

## Outstanding

* **Deploy `main` to Render.** `/account/new`, `/account/claim` and `/link/bind` are live in code
  and 404 in production until then — the iOS app cannot get past its first screen without them.
* **Decide what account deletion removes for a wallet-backed account.** The request/grace/cancel
  flow works; the execution step is deliberately unwired, and `realmLink.due()` lists what is past
  its grace. An app-made account has no such question — nothing of it lives anywhere else.
* `realm-link.js` keeps `bound` forever and serialises it alongside `tokens` on every save, which
  `resolve()` can trigger once per active device per minute. Fine at current scale; worth splitting
  if binds become common.
