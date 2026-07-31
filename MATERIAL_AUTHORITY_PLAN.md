# Material authority — where Step 6 stands and how enforcement must actually work

Status: **Step 7 shipped 2026-07-31 — the save-path flip exists** (`matSaveBaseline` /
`matSaveEnforce` in server.js), staged behind a client version floor and a kill-switch, so today's
live fleet still runs observe-only. The sections below record the Step 6 groundwork; Step 7's design
is at the bottom.

## What the server observes today

| Flow | Channel | Trust level |
|---|---|---|
| Gather nodes | `/world/node/claim` → `gatherCount` | **Hard evidence** — position-authorised, reach-checked, rate-limited, one item per claim |
| Fishing | `/world/fish/report` → `gatherCount` | **Hard-ish** — live presence + human-rate cap, one fish per counted report |
| Combat essence | `/world/kill/report` → `gatherCount` | **Hard-ish** — live presence + rate cap, per-kill *ceiling* (6 ≥ real max 4) |
| Material spends | `/world/mat/flow` → `matSpent` | **Self-limiting** — declaring more spend only lowers your own plausible balance |
| Reward gains (chest/task/raid/milestone/refund) | `/world/mat/flow` → `matGained` | **Client-claimed — NOT evidence** |

`gatherCount` is the only tally that feeds an anti-cheat signal (`oversoldMaterials`). `matSpent` and
`matGained` are telemetry, exposed on `/assets/audit` and counted on `/assets/summary`, read by humans.

## The invariant available now

For any material, from server-side evidence alone:

```
gathered  >=  held + sold + spent  -  (unproven gains)
```

Gathered is a real ceiling. Spends are honest-by-incentive. The hole is the last term: **the reward
faucets are client-rolled**, so their true contribution can only be *claimed*, never proven.

## Why enforcement cannot simply use these numbers

`matGained` is the laundering direction and it is structurally untrustworthy: a modified client can
declare any chest luck it likes. `mat_flow_sim.js` and `mat_flow_forge_sim.js` both assert that a
declared gain never reaches `gatherCount` and never clears an oversold flag — that separation is the
whole safety of this increment, and enforcement must not undo it by starting to believe the numbers.

Collecting it is still worthwhile: across the honest fleet it shows the **real magnitude** of the
reward faucets, which is exactly the distribution any future threshold has to be drawn from. It is
input to designing enforcement, not a mechanism of it.

## How enforcement must actually work

Move the reward **rolls** server-side, exactly as `/assets/egg/hatch` already did for hatches (Step 4).
The pattern is proven and the ordering matters:

1. **Chests** — the server rolls the chest contents and returns them; the client stops rolling. Chest
   *count* is already sig-sealed (`d["chests"]`, v4), so the server can bound how many rolls a wallet
   may claim.
2. **Tasks** — task payouts come from a fixed table (`Econ.TASKS`) keyed by task id; the server can
   verify the id and the claim window rather than accept an amount.
3. **Raids** — already gated by `last_raid_week`, which is **not** in the save signature today; sealing
   it (or moving the weekly gate server-side) closes it.
4. **Level milestones** — derivable server-side: the milestone reward is a pure function of level, and
   level is already time-gated and monotonic in the save sanitiser.
5. **Masterwork refunds** — a function of the recipe and a roll; server-rollable once crafting reports
   the recipe id (crafting already reports the spend).

Only after those are server-derived does `gained` become provable, the invariant close, and a *balance*
(rather than a ceiling) become enforceable. Then the flip: compare declared `mmo.mats` against the
server balance and act on a divergence.

## The flip itself, when it comes

Same rule as every gate in this migration: **observe first, enforce only when live data shows the
tokened client is what the fleet actually runs.** Flipping early refuses honest players on shipped
clients — the exact failure the claim-identity gate is still deliberately waiting on. Expect to soft-flag
first (report divergence), then clamp, then refuse.

## Step 7 (2026-07-31): the flip, as actually shipped

There was no publicly readable live data to wait on, so the flip ships with a design safe under ANY
divergence, gathering its own live data before any client enforces:

**Invariant** (per material, per pubkey wallet, on every `/profile` save push):

```
claimed[m] <= base[m] + cred[m] + UNWITNESSED_ALLOWANCE − sold[m] − used[m]     (floored at 0)
```

It shares the acquisition-bound book (`ownBook` — same `cred`/`sold`/`used`, same 1500 allowance;
market purchases credit the buyer at `/market/buy-onchain`, egg barter debits `used`). Escrow is
deliberately NOT subtracted on the save path — the bag already excludes listed goods, and any
divergence must only ever loosen the bound. `base` is a **one-time grandfather** taken on the
wallet's first save-accept after the flip, stored as a net offset
(`min(claimed, OWN_OPEN_CAP) − cred + sold + used` at snapshot time) so pre-flip sales are never
double-counted against the player. The first post-flip save is grandfathered up to `OWN_OPEN_CAP`
per material — that is the accepted, bounded cost; the second inflated push clamps.

**Enforcement is non-destructive**: the signed mmo blob is stored verbatim (a server rewrite would
trip the client's own tamper check); the response carries `matClamps: { mat: bound }` +
`matFlagged: true`, corrections the client applies and re-signs. The wallet is flagged in
`/assets/summary → matSaveFlip` (admin-gated).

**Staging**: corrections only go to saves with `mmo.v >= MAT_SAVE_MIN_V` (2); today's client stamps
`v: 1` (`Profile.gd export_server`), so the fleet is observe-only — exceedances are counted in
`matSaveFlip.observedOnly` and flagged. **Do not bump the client's export version until that gauge
stays near zero for honest-shaped wallets.** A cheater pinning `v: 1` dodges only the correction:
the excess is already unsellable (market bound) and unspendable (egg barter) — inert. Kill-switch:
`CHIK_MAT_ENFORCE=0` reverts everything (baselines and clamps) to observe-only. Non-pubkey net_ids:
unchanged (`/profile` requires a pubkey).

Proven by `mat_save_flip_sim.js` (37/37): honest 3-session life incl. legacy stock and a pre-flip
seller never clamps; a teleported 5000-iron hoard clamps to base+cred+allowance exactly; the
baseline cannot be reset or ratcheted; heavy traders never clamp; sink replay is refused; the stored
blob survives byte-identical; version floor and kill-switch both hold; a restored book blob is
re-validated (negative offsets legal, absurd/junk keys dropped).

Related: `NFT_PROVENANCE_PLAN.md`, and the migration memory `server-authority-migration`.

### Step 7 defect found in adversarial review (2026-07-31) — the restore ceiling

The first cut of `restoreOwnBook` clamped the restored `base` to a flat `OWN_OPEN_CAP`, on the
reasoning that "the positive side can never legitimately exceed the grandfather cap". **That is the
raw-snapshot assumption the net offset exists to kill**, and it silently destroyed property on every
redeploy.

`base = min(claimed, OWN_OPEN_CAP) − cred + sold + used`. `sold` and `used` are LIFETIME and
unbounded, so an honest offset legitimately runs far above the cap. Concretely (proved by
`av_flip_attack_sim.mjs` case 8): a pre-cutover veteran with a 6200 opening balance who sold his
whole 7700 entitlement over time, still holding 6200 wood, baselines at `base = 13900` and a live
bound of **7700** — his save passes clean. The flat clamp cut `base` to 6200 on the next restart, so
the bound became `6200 + 0 + 1500 − 7700 = −1500 → 0`, and the *same honest save* came back
`matClamps: { wood: 0 }`. A routine Render redeploy would have wiped that material for him.

**Fixed:** the ceiling now carries the sinks — `min(base, OWN_OPEN_CAP + sold[k] + used[k])`, read
off the same row (the buckets are restored *above* the base block; do not reorder). The
anti-corruption property is unchanged: the bound is `base + cred + allowance − sold − used`, so it
still cannot exceed `OWN_OPEN_CAP + cred + allowance` no matter what a corrupted blob claims —
verified for a blob claiming `base = 9e15` both with and without forged sinks.

**The lesson**: an invariant stored as a *net offset* must be validated against the same terms it
was computed from. A ceiling written for the gross value is a wipe waiting for the next restart.

### Step 7 residuals confirmed by the same pass (accepted, not defects)

- **Save grandfather grants no selling rights.** `ownAvailable` (the market bound) reads `open + cred
  + allowance`, never `base`. A fresh wallet pushing 999999 iron grandfathers to a 7700 *save* bound
  but can still only list **1500** — refused end-to-end at 3000. The pre-epoch `open` snapshot is not
  taken for it (`openSrc = 0`).
- **Self-trading between two owned wallets cannot launder.** The seller is debited: their save bound
  fell by exactly the 200 sold. The soft (off-chain) path credits no one, so the pair's total only
  shrinks (6000 → 5800); with the on-chain credit half applied the pair is exactly conserved (6000 →
  6000), and five more round trips never inflate it.
- **Sinks are monotonic.** No code path anywhere decrements `cred`/`sold`/`used` (`grep` on
  `.sold[` / `.used[` / `.cred[` shows only `+=`). Four replays of the egg barter, and five replays of
  `sales-ack` + `cancel`, moved neither `used` nor `sold`.
- **`_matFlags` (the named `worst[]` list in `/assets/summary`) is floodable.** 5400 throwaway signed
  saves in 19s pushed the map to its 5000 cap and evicted the attacker's own earlier flag — it evicts
  by insertion order, so a cheater can erase their own name for the cost of some signatures. The
  *counters* (`observedOnly`, `clamps`, `baselines`) are monotonic and cannot be erased, and those are
  what the "do not bump to v2" gauge reads. Left as-is deliberately: switching the eviction to
  by-severity would in turn hide persistent low-grade cheaters. Operator note only.
- **The book now grows per saving wallet, not per trading wallet**, because `matSaveBaseline` calls
  `_ownRow` for everyone. 5400 saves → 5406 baselines. That brings `GATHER_WALLETS_MAX` (20000)
  eviction closer; eviction is self-healing for an honest player (re-baseline at their current claim,
  no clamp) and re-grandfathers a cheater at `OWN_OPEN_CAP` — the residual already recorded.
- **Kill-switch cost, stated:** a wallet whose *first* save lands while `CHIK_MAT_ENFORCE=0` takes no
  baseline, and grandfathers at whatever it claims when the switch returns — bounded at
  `OWN_OPEN_CAP`, verified.
