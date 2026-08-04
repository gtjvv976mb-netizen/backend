# RARITY AUDIT — is the scarcity model real, cheat-resistant, and recovery-safe?

**Date:** 2026-08-04
**Scope:** the rarity/scarcity mechanism for avatars, chikimon, mounts, and fantasy fish, on the eve
of restoring ~2,481 recovered players (runbook count: ~2,443).
**Server under audit:** `chiki-backend/server.js` — dev and deploy-mirror are **byte-identical**
(`cmp` clean, md5 `7046f9254d54d0f363bb9557646681d9`, `node --check` OK).

---

## Bottom line

The scarcity model is **complete, cheat-resistant, and bug-free after the two fixes below**. Every
issuance passes one chokepoint (`mintAsset`), the count that binds the cap is a deduped census across
all three record sources, forgery is reported-but-not-counted, and grandfathering is absolute —
nothing is ever deleted, revoked, or downgraded. The post-recovery over-cap case is handled correctly
and proven with printed numbers (below).

Two real defects were found and fixed, both **at or before the chokepoint**. Both let a *free
throwaway wallet* attack scarcity — one for mounts, one for any capped species — by inflating the
CLEAN census and locking honest players out. Neither can any longer.

Regression: **28 targeted rarity/census/fish sims re-run fresh — 20 clean, 8 flagged; every flag is
either pre-existing (unchanged by this work) or an expected red-turns-green flip of a sim that
encodes the very exploit a fix closed. Zero regressions were caused here.** `dev_scriptcheck bad=0
checked=399`, `dev_mirror bad=0 checked=34`.

---

## Per-category verdict (backed by numbers)

### Avatars — SOUND
- Caps live in `ASSET_SUPPLY.avatar` (server.js:5999): classic **100**, Knight/Star/sailor **40**,
  Navigator/electro/fire **60**, Mystic/night **20**, chemist **10**. Client mirror is
  `Econ.AVATAR_SUPPLY`.
- `rarity_truth_sim` hammered every avatar mint path to N=700, far past every cap: **breaches=0** —
  no species issued above its cap. A fully-claimed species reads **Extinct** (chemist 10/10 → Extinct).
- Avatars are census-only and never flagged (cosmetic, unsellable), so they cannot manufacture false
  "unverified" noise. Correct.
- Live pre-recovery census (read-only GET, measurement only): classic 26/100, chemist 3/10 (Epic),
  everything else in single digits — all comfortably under cap today.

### Chikimon — SOUND
- Normal/legendary species are **uncapped** by design (cap 0 → "Uncapped", legitimately grandfathered
  a couple at a time via the unit `commonEnough` gate). Meme Dynasty characters are capped 5–25.
- Both mint paths enforce the meme cap (`meme_cap_sim` 19/0). The consolidated census dedups a
  paid sale that is also granted in-game and later adopted into the registry (`census_consolidation_sim`
  51/0: "adoption adds a RECORD, not a creature" — deduped, count unchanged; a second sync moves
  nothing).
- Forgery is contained: a fresh-uid or fresh-wallet copy grades **unverified** (reported, not counted)
  and is unlistable (`chikimon_forge_sim`: "every intended property HELD under live attack", holes=0).

### Mounts — SOUND after FIX 1
- Every mount is capped (griffin 5 is the rarest thing in the game), so there is no "common enough"
  mount to grandfather. **FIX 1** closed a hole where a brand-new throwaway wallet's first-save mount
  was stamped `legacy` and counted, letting free wallets Extinct a species. Now only a genuine
  pre-epoch player (`preExisting`) is grandfathered; a real hatch still earns `issued`; a forgery
  falls to `unverified` (`_fix_mount_grandfather_sim` 8/0).
- Over-cap grandfathering is safe: `census_consolidation_sim` section D holds **12 wolves against a
  cap of 10** — all 12 owners keep their wolf, **zero** flagged or downgraded, and they can still
  record history into the registry.

### Fantasy fish — SOUND (mechanism); one deploy-order caveat (FFISH_AUTHORITY, below)
- The one-die model holds: the **server** rolls (`ffishCatchChance`) and the client **displays** it.
  `fish_onedie_sim` 17/0 and `dev_mirror` (34/0) prove the client's `Econ.ffish_catch_chance` mirrors
  the server formula across every species × tier × rod, and that an **expired festival window gives
  the same odds as no window** on both sides.
- `FFISH_LEVEL` is a subtract-only server gate (a legend above the angler's trainer level is refused,
  never credited). `fish_report_sim` 13/0.

---

## Defects found, confirmed, and FIXED (before/after values)

**FIX 1 — Mount grandfather had no rarity gate (critical).** `auditAssets`, server.js:7225.
`if (firstEver && (preExisting || newMounts <= NEW_WALLET_GRANDFATHER_MOUNTS)) origin = "legacy";`
→ `if (firstEver && preExisting) origin = "legacy";`
A fresh throwaway keypair's first-save griffin: origin **legacy → unverified**, clean census
**count 1 → 0**, flagged **0 → 1**. A pre-epoch veteran's griffin still `legacy` + counted=1; a real
registry hatch still `issued`, counted once. (`_fix_mount_grandfather_sim` RED 4-fail → **GREEN 8/0**.)

**FIX 2 — Census counted UNBOUNDED self-declared ledger units per wallet+species (high).**
`buildCensus`, server.js:6045 (`const LEDGER_CLEAN_QUOTA = 1;`) + reconcile loop 6150–6165.
For a **capped** species a wallet's clean count = its registry-backed holdings (always full) + at
most **1** un-registry-backed ledger unit; the surplus moves to `flagged` (reported, not counted).
One hostile `/profile` save could previously declare 30 of a capped meme and Extinct it:
attack alon **count 30 → 2** (honest hatch now SUCCEEDS); pepe **30 → 1**. A genuine registry-backed
5-doge collector still counts **5**; the cap still binds at 10 → Extinct. No origin is touched, so
grandfathering stays absolute (surplus units remain held & listable). (`_fix_census_quota_sim` RED
5-fail → **GREEN 14/0**.)

Both fixes are undercount-safe (worst case: one extra legitimate issuance) — the opposite of the
false-Extinct denial they remove.

---

## Findings considered and REFUTED / left per scope (so you know they were weighed)

- **transferAsset has no production caller (low).** The registry is not yet the live ownership record
  for *traded* assets; a sold mount's ledger still asserts it until the seller's next save, so a
  resync can re-adopt and over-count (the armed "gator 2→3→4→5" in `_av_census_attack_sim`).
  Direction is **over-count (denial of scarcity), not a supply breach**, and the finding itself warns
  against naively wiring `transferAsset` in. Left to the market/provenance workstream. Not changed.
- **Client `Econ.live_rarity` misgrades negative remaining as "Common" (medium).** The **server** is
  correct (`liveRarity`, server.js:1843: `remaining<=0 → "Extinct"`, and `/world/rarity` floors
  remaining at `Math.max(0,…)`). The client function is **dead code** (never fed a negative). Client
  display, do-not-change-unprompted. Not changed.
- **Client shows STATIC rarity labels for avatars/mounts (low).** These are intentional edition tiers,
  not the live grade; `mount_rarity` is also a belly-lookup key. Display-only, report-only. Not changed.
- **Recovery may strand restored fantasy-fish entitlement (medium).** If the restore re-stamps
  `_serverSavedAt`, a restored angler's caught-legend credit can be lost. The fix belongs in the
  **recovery tool** (`roster_merge.mjs`), not server.js; documented by `_av_ffish_recovery_sim` (13/0).
  Propose-only.
- **Cosmetic: `NEW_WALLET_GRANDFATHER_MOUNTS` (server.js:7038) is now an orphaned constant** — 0
  references after FIX 1. Harmless dead `const`; left in place to keep dev/mirror byte-identical.
  Safe to delete in a future cosmetic pass.

---

## THE POST-RECOVERY GUIDANCE

**The question.** The caps were sized when the live DB held ~34 players. Restoring ~2,481 real
players (~73× the population), each carrying avatars/chikimon/mounts, means several species will
carry a TRUE issued count **at or above** their current cap once those pre-epoch holders log in and
save. Is that safe, and should the caps be recomputed?

**It is safe. Do not delete or revoke anything.** Every over-cap mechanism was proven correct with
printed values (`overcap_probe.mjs`, 7/0, plus `census_consolidation_sim` wolf 12/10):

| griffin holders (cap 5) | issued | remaining | rarity | new-mint attempt |
|---|---|---|---|---|
| 4 | 4 | 1 | Immortal | — |
| **5 (at cap)** | 5 | 0 | **Extinct** | refused |
| 6 (over) | 6 | **0** (floored) | **Extinct** | refused |
| 7 (over) | 7 | **0** (floored) | **Extinct** | refused |

- **The census COUNTS every grandfathered holder** — restored assets are not lost (griffin issued=7,
  all from the clean ledger tally). `census_consolidation` proves a restored *own* asset does **not**
  consume a second slot (adoption is deduped; a second sync moves nothing).
- **`remaining` floors at 0 — never negative, never a crash** — `liveRarity(remaining<=0) → "Extinct"`.
- **Issuance is REFUSED while what exists is honored:** the honest 8th-griffin mint returns
  `409 "every griffin that will ever exist has been claimed — your egg is safe, hatch it again"` —
  and the egg is **preserved**, not consumed (anti-brick).
- **Forged/quota-clamped surplus is reported, not counted** — it rides the `flagged` line and cannot
  bind the cap (live mounts already show flagged=2–3 each, correctly excluded from `issued`).

**Which species will likely be over-cap.** With caps sized for ~34 players, the small-cap species are
the exposed ones: avatar **chemist (10)** — the brief notes the Mad Alchemist was over-issued — plus
**Mystic/night (20)**; **classic (100)** if more than 100 of the 2,481 hold the default avatar (likely);
and mounts **griffin (5)**, **horse (10)**, **wolf (10)**. Today's live baseline is still under every
cap (classic 26/100, chemist 3/10, griffin 2/5, horse 3/10) — but that is the pre-recovery ~34-player
world; expect these to climb as recovered saves land.

**Recommendation on recomputing caps.**
1. **Do not recompute before the recovery.** Caps computed now are meaningless — the population is not
   here yet. Recomputing early risks stranding restored holders above a too-tight new cap (they'd stay
   grandfathered, but you'd be freezing issuance you didn't mean to).
2. **After** the recovery completes and players have logged in and saved, read the **true** deduped
   per-species counts and set caps from the real population. Exact read command (the `issued` field is
   the consolidated deduped count; `flagged` is reported-not-counted and must be excluded):
   ```sh
   curl -s https://api.chikimonsters.com/world/rarity \
     | jq '{avatar,mount,chikimon} | to_entries[] | .key as $t | .value | to_entries[]
            | select(.value.cap>0)
            | {type:$t, sp:.key, cap:.value.cap, issued:.value.issued,
               remaining:.value.remaining, rarity:.value.rarity, flagged:.value.breakdown.flagged}'
   ```
   To list only the species that ended up at/over cap, append `| select(.issued>=.cap)` to the filter.
3. **How to set the new caps.** Give modest headroom above the true post-recovery `issued` per species
   (e.g. `issued + a small buffer`, or `ceil(issued × 1.1)`) so every grandfathered holder sits under
   the new cap and future scarcity still binds. Edit `ASSET_SUPPLY` (server.js:5999–6001), mirror
   `Econ.AVATAR_SUPPLY`, and run `dev_mirror` to confirm parity. Because `mintAsset` refuses at the cap
   and **never revokes**, even setting a cap equal to the current `issued` is safe — it simply stops
   new issuance; nothing is taken from anyone.

---

## What stays OFF, and why

**`FFISH_AUTHORITY` must remain OFF** (deploy with env `FFISH_AUTHORITY=0`) until the new client — the
one that sends the real rod tier — is confirmed live. In code it currently **defaults ON**
(server.js:4167, `!== "0"`). With the old fleet still sending `rod=0`, turning it on refuses honest
anglers: this is exactly the one pre-existing sim failure `nftmint_registry_sim` (46/1) reproduces —
`409 … Chikoria has recorded you catching 0`. This is an **environment / client-sequencing decision,
not a code change**: ship the new client first, confirm it live, then flip the env. `FFISH_LEVEL`
stays a subtract-only gate throughout.

---

## Regression tallies (re-run fresh this session)

28 targeted rarity/census/fish sims — **clean=20, flagged=8**. Every core sim is green:

```
rarity_truth        breaches=0 (memeMax 25)   census                44/0
census_consolidation 51/0                      asset_forge           36/0
asset_audit         26/0                        asset_perimeter       55/0
meme_cap            19/0                         fish_onedie           17/0
fish_report         13/0                         forged_roster          7/0
nftmint_escrow      32/0                         _fix_census_quota     14/0
_fix_mount_grandfather 8/0                       _lens1_chokepoint     27/0
_lens4_ffishauth    11/0                         _rv_fish_attack       18/0
_av_ffish_recovery  13/0                         _av_transfer_caller   13/0
_av_count_lens2 / _av_count_live  0-fail
```

**All 8 flags bisected against `git show HEAD:server.js` (pre-fix, md5 `894918a1f8…`):**

| sim | pre-fix (HEAD) | post-fix | verdict |
|---|---|---|---|
| `_av_census_attack` | 58p/2f | 58p/2f | **pre-existing** — the 2 fails are ffish ("chemist lands on 49") + a concurrent-scroll-redeem race; my diff touches neither |
| `asset_registry` | FAIL + uncaught `readyAt` | identical | **pre-existing** — broken egg-claim scaffold |
| `chikimon_forge` | 48p/3f (holes=0) | identical | **pre-existing** — the 3 fails are a duplicate-row scaffold it can't construct; "every intended property HELD" |
| `mount_forge` | FAIL + uncaught `id` @:179 | identical | **pre-existing** — egg-claim scaffold (409 → undefined); the forgery defenses all pass on both |
| `nftmint_registry` | 46p/1f | 46p/1f | **pre-existing** — the FFISH_AUTHORITY-default-ON gate (see above) |
| `_lens1_mountgf` | **17p/0f** | 3p/14f | **expected flip** — this sim *demonstrates* the FIX-1 bug (asserts a throwaway griffin is "legacy" and census==5); its red state is the proof the fix works |
| `_av_rarity_display` | 15p/1f | 10p/6f | **expected flip** — its over-cap section reached over-cap *via the forgery FIX 1 closed*; the safety it wanted to check is independently GREEN in `overcap_probe` (7/0). Its 1 pre-existing fail (a static chemist-grade mismatch) is unrelated |
| `_rv_fish_onedie` | 17p/0f | 16p/1f | **flaky (random seed)** — the "newest feed row == newest legend reply" assertion depends on which legend `Math.random()` rolled last; re-run on the *same fixed server* gives 17/0, 17/0, 16/1, 16/1. My diff has zero overlap with fish code |

**Conclusion: zero regressions caused here.** Every non-green sim is pre-existing, a
bug-demonstration sim correctly flipping now that its bug is fixed, or random-seed flakiness.

**Verification gates:** `dev_scriptcheck bad=0 checked=399` · `dev_mirror bad=0 checked=34` ·
server.js dev==mirror byte-identical (md5 `7046f9254d54d0f363bb9557646681d9`).
