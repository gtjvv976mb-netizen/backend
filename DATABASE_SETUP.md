# Turning on the database (DATABASE_URL) — what to do, and what I checked first

Right now the backend runs on the **in-memory store**. Every deploy and every idle spin-down on
Render's free plan wipes: live sessions, the asset ledger and registry, the material-flow tallies,
raid-claim weeks, market rows, world nodes and chat. The server says so on boot:

```
⚠ No DATABASE_URL — using IN-MEMORY store (state is lost on restart; NOT for mainnet).
```

Everything built this week — server-owned mounts, chikimon and eggs, the one-live-session lock, the
authenticity ledger — only genuinely persists once this is set. **This is the single biggest gap
between the game as it stands and a real MMO.**

## What you do (I cannot — it needs your Render account)

1. Render dashboard → **New +** → **PostgreSQL**. The free tier is fine to start; note that Render's
   free Postgres expires after 90 days, so pick a paid tier if this is holding real player value.
2. Once it is created, copy its **Internal Database URL** (the `postgres://…` string). Internal is
   preferred — it does not leave Render's network.
3. Open the backend service → **Environment** → add:
   - Key: `DATABASE_URL`
   - Value: the connection string you copied
4. Save. Render redeploys automatically.
5. Confirm it took: the boot log should NO LONGER show the in-memory warning. `GET /stats` should
   report `dbOk` true.

Do not paste the connection string into chat, a commit, or a client build — it is a credential.
`render.yaml` has `autoDeploy: true`, so the redeploy is automatic once the variable is saved.

## What happens on first boot with a database

`store.init()` runs `CREATE TABLE IF NOT EXISTS` for players / payouts / presence / kv /
quest_winners / quest_rewards, plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for the columns added
since. It is safe to run repeatedly and safe on an empty database — no migration step is needed.

**Existing players are not lost, but they do start from their client saves.** The cloud is empty on
day one, so each player's first sign-in pushes their local save up and it becomes the cloud copy. The
asset ledger and registry likewise rebuild from the saves the server audits. Nothing is destroyed;
the server simply starts remembering.

## What I verified before recommending this

I could not boot a real Postgres here (none installed, no Docker), so I read the pgStore path
carefully and tested what I could in-process. Two production-only failure classes were worth chasing,
because both work perfectly against the in-memory store and only break once a real database exists:

- **The 63-bit quest mask — checked, already safe.** `quest_rewards.done_mask` is `BIGINT` and Act I
  uses bits up to 62, which is past JavaScript's safe integer range. `pg` returns `int8` as a *string*
  for exactly that reason, and the code routes every read through `questMask()` → `BigInt(...)` and
  every write through `.toString()`. No precision loss. Nothing to fix.

- **Escaped NUL in JSONB — FOUND AND FIXED.** Postgres rejects an escaped NUL inside a `jsonb` value
  ("unsupported Unicode escape sequence in type jsonb"). `JSON.stringify` emits one happily and the
  in-memory store accepts it silently, and `stripTags` only removes `<` and `>` — so a NUL byte in any
  user-controlled text (a chat line, a handle, a nickname, a market listing name) would have thrown on
  the **persist** path the moment a database was attached. It would have looked like "state randomly
  stops saving in production" and would never have reproduced in dev. All four writable `::jsonb`
  parameters (kv, presence roster, player profile, chat reactions) now go through `jsonbSafe()`, which
  strips NULs from string *values*. Verified by `jsonb_nul_sim.js` (15/15), including the subtlety that
  broke my first attempt: sanitising the serialised text instead of the values corrupts a string that
  legitimately contains the literal characters backslash-u-0-0-0-0, producing JSON that will not parse
  on restore.

## After it is on, worth doing

- Watch the boot log once for `saveMarket persist failed` / `asset ledger` warnings — the first real
  write is where any remaining schema surprise would show.
- The session lock becomes meaningfully stronger, because sessions currently reset on every deploy
  (they fail open by design, so that is safe, just weaker).
- Only then is the enforcement flip in `MATERIAL_AUTHORITY_PLAN.md` worth considering — enforcing
  against state that a redeploy wipes would be worse than not enforcing at all.
