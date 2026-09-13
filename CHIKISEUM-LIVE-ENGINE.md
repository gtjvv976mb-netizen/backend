# Free-only authoritative live engine

`ChikiseumLiveEngine` is a synchronous pure engine, not a public server or an
authentication provider. It never grants currency, items, SOL, wallet credentials,
or XP. Legacy `pvp-engine.js` and Cup behavior are unchanged.

## Adapter contract

Authenticate every private POST before calling any engine method. The adapter
constructs `admit({id,wallet,asset_id,species,level,handle,inventory_verified:true})`
from active owned registry assets and **separate server-earned PvP levels**. Never
pass a client fighter record, client level, HP, damage, rarity, cards or outcome.
Wallet and rival asset identities are internal. Only private `you.asset_id`
binds the authenticated player's selected asset; public `players` omit asset IDs.

The adapter routes `/chikiseum/live/v1/session` to `admit`; admission returns
`chikiseum.live-session/v1`, `trainer_id`, canonical `fighter`, `handle`, expiry,
catalogue hash, exact arena binding and `level_source: server_earned_pvp`.
No engine bearer token exists. The adapter must map authenticated wallet/current
session to the exact admitted ID and validate ownership/session validity repeatedly.

Methods (all synchronous):

- `lobby(id)`: `chikiseum.live-lobby/v1`, bounded available trainers, private incoming challenges and active match ID.
- `queue(id)`: `{match_id,searching}`; no stake/currency argument.
- `challenge(id,targetId)`: `{challenge_id}`; target must be recently present and compatible.
- `accept(id,challengeId)`: `{match_id}`; only its target can accept.
- `state(id,matchId)`, `ready(id,matchId)`: private `chikiseum.battle/v1` view.
- `move(id,matchId,dx,dz,requestId)`: intent axes only; server-monotonic 50ms cadence, 3.8m/s, max elapsed .2s, exact navigation sweep and rival exclusion.
- `cast(id,matchId,slot,requestId)`: reserves canonical cost/cooldown immediately; full private view with equal top-level/`you.cast_ack` and `cast_queued` true while pending, false for completed idempotent replay.
- `cancel(id,matchId?)`: clear queue/challenges; ready cancel or active forfeit. No XP summary.
- `revoke(id)`: immediately cancel/forfeit and release identity leases; use when auth/ownership/session invalidates.
- `tick()` / `expire()`: owner calls every 50ms. They also run before commands. No AI and no wait for opponent commitment.

All live responses declare `mode:live`, `currency:NONE`,
`real_sol_enabled:false`, `inventory_verified:true`. One immutable canonical
fighter enters per account/asset, stable own hand, `turn:0` compatibility only,
`round_number:1`, continuous server match clock. Every public confirmed event
retains exact species/slot/card key and status owner; private request IDs never
enter public events. Mechanics intentionally match the frozen Python realtime
engine, including no invented rend/bleed/status behavior.

`LiveRejected` carries `code` and HTTP-compatible `status`. Caller metadata is
never accepted as authoritative time, position, HP or outcome.

## Bounds and persistence

Defaults: 512 admissions; 128 retained matches; 50 visible lobby peers;
900s sliding admission TTL; 45s presence/inactivity; 90s queue; 30s challenge/ready;
four outgoing challenges; 4096 casts / 16384 movement IDs per match; 1024 retained
monotonic events; 300s terminal retention. One owner process per match is required;
the adapter must hold the exclusive durable-store lease before advertising ready.
Admission/cooldown limits are not substitutes for HTTP/account rate limiting.

`checkpoint()` returns JSON-serializable server-private match state and pending
completion summaries. Persist it atomically with progression/receipt/cap changes.
Its compact restart-only form stores eight event-tail records and empty transient
request/pending-cast ledgers. Runtime replay maps/events are untouched. No prior
cast can execute on restore, because unfinished matches are cancelled. The bounded
128-match full-cache test measures the resulting checkpoint below8MiB.
`restoreCheckpoint()` (also `restore()`) requires a fresh empty engine and exact
catalogue/plan hashes. It cancels every prior ready/active match as `server_restart`
without winner/XP, clears pending casts, and preserves normal finished summaries.
Reauthenticate and re-admit accounts after restart; never reuse a public caller ID
as proof of ownership. `shutdown()` cancels active matches then permits checkpoint.

`drainCompletions()` returns **non-destructive copies** of normal `finished`
summaries only. Each carries match ID, winner, trusted timestamps/identity, actual
resolved cast count and capped actual HP damage dealt. It is adapter-private.
Apply XP in an idempotent durable transaction with minimum activity/duration,
pair/day caps and the approved server-earned progression policy; no award for
cancel, restart, timeout-before-ready, revocation or inactivity/forfeit.
`acknowledgeCompletion(matchId)` only after that transaction commits. It is not
a reward grant. Pending summaries survive checkpoints and terminal match expiry.
If completions saturate the match bound, new matches fail closed instead of losing
awards. Production store, auth, rate limiting, deployment and two public-account
proofs remain adapter/release requirements—not established by pure unit tests.

## Frozen authority

- profiles: `8347a90aec5091ae174c6fef17389fa78114ec118efa7ab21cb008c7bd2cd79c`, 402 cards.
- floor v2: `4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b`, R24 and actual solid footprints.
- Constructor receives `navigation`, optional `cataloguePath`, server clock and
  monotonic movement clock. Defaults load adjacent `chikiseum-profiles.json`.
- `chikiseum-live-parity.test.js` compares all 402 cards × 3 tier levels × 2 status
  scenarios against independent original Python authority using actual navigation.
  Synthetic admissions in unit tests are explicitly **not production auth proof**.
