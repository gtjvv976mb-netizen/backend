# Material authority — where Step 6 stands and how enforcement must actually work

Status: **observation complete, enforcement deliberately not attempted.** This records what the server
now sees, what it still cannot prove, and why the obvious next step (trusting the numbers we just
started collecting) would be a mistake.

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

Related: `NFT_PROVENANCE_PLAN.md`, and the migration memory `server-authority-migration`.
