# ROSTER RECOVERY — getting the ~2,443 players back

**What happened, in one paragraph.** Around Aug 2 the game was pointed at a database that does
not contain the players. The server looks up each wallet, finds no row, and politely hands that
player a brand-new empty profile — so ~2,443 real people lost their chikimons, mounts, levels and
gold *on screen*. Nothing was actually destroyed: their real rosters are sitting untouched in the
frozen database(s). The fix is a merge tool that copies everyone back into the live database
without overwriting anything anyone has done since.

**The one rule the tool lives by: it only ever ADDS.** For every wallet it proves, field by
field, that the merged result is greater-than-or-equal to every source before it will write. A
player who kept playing on an empty profile keeps that progress too. This was verified with 107 +
72 automated checks against local test databases, including deliberate attacks on the tool
itself.

**Three things before you start:**

1. **Do NOT delete any of the three databases.** Not the "wrong" one, not after it works. They
   are the evidence and the backup of last resort.
2. Do everything below from your Mac, in a terminal, starting with:
   `cd ~/Downloads/chiki-backend`
3. If at ANY step you see something different from what this document says you should see:
   **stop, change nothing, copy the terminal output, and report it.** Nothing below is
   destructive until Step 5, and Step 5 refuses to run by accident.

A note on pasting database URLs: get each one from Render → the database → **External Database
URL**. Paste them only into the `read` prompts below (typed input is hidden and stays out of
shell history). Never paste a URL into a file, a chat, or a command line directly.

---

## Step 1 — Back up the live database (this is what makes everything reversible)

The live database is whichever one the backend service is connected to right now: Render → the
backend service → Environment → the database its `DATABASE_URL` points at. Use that database's
External Database URL here:

```sh
cd ~/Downloads/chiki-backend
read -rs "LIVE?Paste the LIVE database URL and press Enter: "; export LIVE; echo ok
pg_dump --no-owner --format=custom "$LIVE" -f ~/Desktop/chiki_live_backup_$(date +%Y%m%d_%H%M).dump
ls -lh ~/Desktop/chiki_live_backup_*.dump
```

**You should see:** the command finishes silently, and `ls` shows a `.dump` file (the live
database is small right now — expect somewhere in the kilobytes-to-a-few-MB range).

**If instead** you see `server version mismatch`, use the newer bundled pg_dump:
`/opt/homebrew/opt/postgresql@18/bin/pg_dump` with the same arguments.

If you have the patience, take the same backup of the other two databases as well (change the
filename each time). It costs minutes and it means every one of the three databases is frozen in
amber before anyone touches anything.

---

## Step 2 — Work out which database is which

You have three databases on Render: **"db"**, **"chiki-db"**, and
**"chiki-postgres-singapore"**. The names lie (the "singapore" *service* is physically in
Oregon), so identify them by their contents, not their names. First load all three URLs into
hidden prompts (this keeps them out of shell history), then run the checker on each:

```sh
cd ~/Downloads/chiki-backend
read -rs "DB1?URL of 'db': ";                        export DB1; echo ok
read -rs "DB2?URL of 'chiki-db': ";                  export DB2; echo ok
read -rs "DB3?URL of 'chiki-postgres-singapore': ";  export DB3; echo ok

./dbcheck.sh "$DB1"
./dbcheck.sh "$DB2"
./dbcheck.sh "$DB3"
```

dbcheck is read-only — it counts things and changes nothing. Compare each printout against this
table:

| What dbcheck shows | What that database IS | Role in the merge |
|---|---|---|
| `with_a_profile` ≈ **31**, kv ≈ 72, `asset_registry` ≈ **9506 bytes**, `newest_player` = **today, minutes ago** | The database the game is writing RIGHT NOW | **TARGET** (`$LIVE`) |
| `player_rows` ≈ **2852**, `with_a_profile` ≈ **2474**, payouts ≈ 4321, `newest_player` = **2026-07-28** | The big frozen Oregon database — where the lost rosters live | **SOURCE** (`$OREGON`) |
| `newest_player` somewhere **between Jul 28 and Aug 2** (days stale, not minutes), and/or `asset_registry` ≈ **9506 bytes** like the live one | The missing middle: the database that served between Jul 28 and the cutover. This explains why the live registry is richer than Oregon's — it was copied forward from here. Anything players earned that week lives ONLY here. | **SOURCE, listed first** (`$NEWEST`) |

**You should see:** exactly one database matching each of the first two rows. The third database
will either match the third row (three-source merge) or turn out to be empty/unused (two-source
merge — that is fine, the tool takes any number of sources).

**If instead** no database shows `with_a_profile` ≈ 2474: **stop and report.** The rosters must
be located before anything else happens.

Now give each URL its role for the rest of this document, based on what dbcheck told you. For
example, if "db" turned out to be the live one, "chiki-postgres-singapore" the frozen Oregon
one, and "chiki-db" the middle source:

```sh
export LIVE="$DB1"; export OREGON="$DB3"; export NEWEST="$DB2"
```

(Swap the right-hand sides to match YOUR dbcheck results. If the third database turned out
empty/unused, skip `NEWEST` and drop its `--source` from every later command.)

---

## Step 3 — Dry run (writes nothing; cannot write anything)

The tool's default mode opens **every** connection — including the live one — with
`default_transaction_read_only=on`, so Postgres itself refuses writes. You can run this as many
times as you like.

```sh
cd ~/Downloads/chiki-backend
node roster_merge.mjs --target "$LIVE" --source "$NEWEST" --source "$OREGON" \
  --audit ~/Desktop/roster_audit_dry.json
```

(If there is no middle source, drop that `--source "$NEWEST"`. Sources go newest first; add
`--rank-auto` if you would rather the tool order them by their own timestamps.)

**You should see**, near the top, a probe line per database — check the `target` line shows
`withProfile=31`-ish. If the target line shows ~2474, the URLs are swapped: stop and redo Step 2.
Then, at the bottom, a summary like:

```
  INSERT (new to target) : 2xxx      <- expect roughly 2,400-2,500
  MERGE  (already there) : (small)
  NO CHANGE (idempotent) : (small)
  QUARANTINED (no write) : 0 or a handful
  MONOTONICITY ABORTS    : 0 or a handful
  known-answer test      : pass=NNNN fail=0
  TOTAL ASSETS RESTORED  : (five figures)

DRY RUN - nothing was written. Re-run with --commit to apply.
```

**How to read it:** INSERT is players coming back. The known-answer test re-derives each save's
anti-cheat seal and checks it against the player's own stored seal — `fail=0` means the reseal is
byte-perfect. QUARANTINED/ABORTS are wallets the tool refuses to touch rather than risk shrinking
— they stay exactly as they are and are listed in the audit file for a human decision.

**If instead** INSERT is far below ~2,400 (say under 2,000), or `fail=` is not 0: **stop and
report the output.** Far-too-few means the sources on the command line do not hold the players.

To look at one specific player before going further:

```sh
node roster_merge.mjs --target "$LIVE" --source "$NEWEST" --source "$OREGON" \
  --only "<that player's wallet address>" --audit ~/Desktop/roster_audit_one.json
```

---

## Step 4 — One decision before committing: `--restore-opening`

Recovered players get all their materials back. But the *right to sell* pre-existing materials on
the market comes from a one-time "opening balance" snapshot, and the recovery makes that snapshot
impossible to grant automatically ever again (the restore must stamp a fresh save-time, which
puts every recovered wallet past the snapshot epoch). Without the flag, a veteran with 4,000 wood
keeps the wood but can never sell it.

- **Recommended:** add `--restore-opening` to the commit in Step 5. It grants each recovered
  wallet an opening of `min(what they hold, 6200)` per material — capped, idempotent, and proven
  to only ever add.
- If you skip it now you can re-run later with the flag; nothing is lost either way.

The dry run also prints a short list of other **owner decisions** it will not make for you
(wallets paid quest rewards in two databases at once, any registry-vs-profile conflicts,
quarantined wallets). Keep `~/Desktop/roster_audit_dry.json` — it has one record per wallet and
is the paper trail for all of them.

---

## Step 5 — Commit: small batch first, then everyone

Writing requires the explicit `--commit` flag. The whole run is ONE database transaction: if
anything goes wrong mid-way it rolls back to exactly how it was (this was tested by killing the
tool mid-commit — the database came back byte-identical).

**5a. Five players, players-table only:**

```sh
node roster_merge.mjs --target "$LIVE" --source "$NEWEST" --source "$OREGON" \
  --limit 5 --no-kv --no-payouts --no-quests --commit \
  --audit ~/Desktop/roster_audit_limit5.json
```

**You should see:** `COMMITTED  players=5 ...` (or slightly fewer — the limit counts planned
wallets, and a planned wallet that needs no change writes nothing), with `kv=0 payouts=0
quest_rewards=0`. If a friendly affected player is reachable, have them log in now — their
roster should be back.

**5b. The full run:**

```sh
node roster_merge.mjs --target "$LIVE" --source "$NEWEST" --source "$OREGON" \
  --restore-opening --commit --audit ~/Desktop/roster_audit_commit.json
```

(Leave out `--restore-opening` if you decided against it in Step 4.)

**You should see** a final line like:

```
COMMITTED  players=24xx remerged=... kv=~10 payouts=43xx quest_rewards=...
```

**5c. Prove it is done (idempotency):** run the exact same command again.

**You should see:** `insert=0 merge=0`, everything `nochange`, and `COMMITTED  players=0 kv=0
payouts=0 quest_rewards=0`. The tool re-run changes nothing — that is the proof the merge is
complete and stable. **If instead** the second run wants to write again: stop and report.

---

## Step 6 — Verify

1. **Count the rosters:**
   ```sh
   ./dbcheck.sh "$LIVE"
   ```
   **You should see** `with_a_profile` jump from ~31 to **~2,474 or more**.

2. **Check supply did NOT inflate** (restoring a player's own dragon must not mint a second
   dragon):
   ```sh
   curl -s https://api.chikimonsters.com/world/rarity
   ```
   **You should see** the same census as before the recovery — **38 chikimon / 12 mount /
   38 avatar**. Equal is correct. **If any number is HIGHER, stop immediately and go to Step 7
   (rollback)** — that would mean duplicate assets were created, which the tool is specifically
   built to never do.

3. **Ask one real player** to log in and confirm their companions, mounts, levels and gold are
   back, and that anything they did in the last few days is still there too.

---

## Step 7 — Rollback (only if something is wrong)

The backup from Step 1 restores the live database to exactly the moment before the merge:

```sh
pg_restore --clean --if-exists --no-owner -d "$LIVE" ~/Desktop/chiki_live_backup_<timestamp>.dump
```

Two honest warnings:

- This rewinds EVERYTHING in the live database to backup time — saves made between the backup
  and the rollback are lost. So if you are going to roll back, do it promptly, and prefer a
  quiet hour.
- Rolling back does not lose the recovery work: the frozen sources are untouched, the audit
  JSONs list exactly what was written per wallet, and the merge can be re-run after the problem
  is understood.

---

## Step 8 — Rotate the database password

A database connection URL (which contains the password) was pasted into a chat at some point
during this incident. Treat it as burned:

1. Render → the database → **Info / Access** → reset the password (Render regenerates the URL).
2. Immediately update the backend service's `DATABASE_URL` environment variable to the new URL
   (Render → the backend service → Environment) — the service restarts with the new credential.
3. Do this for any database whose URL was ever pasted into chat. The frozen ones can be rotated
   without breaking anything (nothing live uses them).
4. The commands in this runbook kept URLs in hidden prompts and environment variables only, and
   the merge tool redacts URLs from everything it prints and writes — but rotation is what makes
   the leak actually dead.

---

## Step 9 — Make sure this can never happen silently again

**The root cause was not data loss.** The game was pointed at a database that did not contain
the players, and the server treated 2,443 missing rows as 2,443 brand-new players. Nothing
alarmed, because to a server, "I cannot find you" and "you are new here" look identical.

**The migration rule from now on:** before any future database or service switch, run
`./dbcheck.sh` on BOTH sides, side by side. A service is not allowed to be promoted to live
until `with_a_profile` on the new side matches the old side (and `asset_registry` /
`asset_ledger` bytes are at least as large). Sixty seconds of counting rows is the whole
prevention.

**The permanent tripwire — the roster guard.** The backend now refuses (or loudly alarms) when
its database has drastically fewer saved profiles than expected. It ships with the next backend
deploy and is controlled by environment variables on the **service**:

| Env var | What it does |
|---|---|
| `CHIK_ROSTER_MIN` | The number you promise the database holds. Below it, the guard trips. **Set it to ~90% of the profile count** (after recovery: `2200` is right; the server prints the exact suggested number at every boot while unset). Unset = unarmed, and the boot log nags about it. |
| `CHIK_ROSTER_GUARD` | `warn` (default) = trip prints an unmissable alarm but keeps serving. `refuse` = trip answers **503 to everything except `/health`** — no player can be handed an empty profile. `off` = disabled. |
| `CHIK_ROSTER_DROP` | Tolerance for the self-learned high-water mark (default 20%). The server remembers the biggest profile count it has ever seen *inside each database* and trips if the count falls more than this below it — so even with `CHIK_ROSTER_MIN` unset, an in-place wipe of the current database is caught. (The high-water mark cannot catch a swap to a different database — that is exactly what `CHIK_ROSTER_MIN` is for. Arm both.) |
| `CHIK_ROSTER_RECHECK_MS` | How often it re-checks while running (default 10 min, min 1 min). |

**How to arm it (after the recovery, after the next backend deploy):**

1. Render → backend service → Environment → add `CHIK_ROSTER_MIN` = `2200`. Leave
   `CHIK_ROSTER_GUARD` unset (= warn) for the first boot.
2. Watch the deploy log for: `roster guard: OK — 24xx saved profiles (floor 2200, mode=warn)`.
3. Then set `CHIK_ROSTER_GUARD` = `refuse`. From that moment, a repeat of this incident stops
   the service cold at boot instead of quietly resetting players. `curl .../health` always shows
   the guard's state (`rosterGuard: {...}`).
4. Do NOT set `CHIK_ROSTER_MIN` on a staging service or an intentionally-empty database — it
   will trip, because that is its job.

**What a trip looks like** in the service log, so you recognize it instantly:

```
  ############################################################
  #  ROSTER GUARD TRIPPED — THIS DATABASE IS MISSING PLAYERS  #
  ############################################################
  31 saved profiles, expected at least 2200 (CHIK_ROSTER_MIN=2200, ...)
  This is what a wrong DATABASE_URL looks like. Every wallet that connects now
  gets a FRESH EMPTY PROFILE and saves it back over nothing.
```

All of this was verified end-to-end against throwaway local databases: 62/62 checks — including
booting against a full copy (serves), a wiped copy (alarms/refuses, `/verify` and `/profile`
answer 503 so no blank profile can ever be handed out), a mid-run wipe (caught by the periodic
recheck within 60 s), an unreachable database (correctly NOT treated as a wipe), and a
brand-new empty database (tripped at boot, before the first player could connect).
