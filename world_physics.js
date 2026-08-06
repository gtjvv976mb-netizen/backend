// world_physics.js — THE SERVER MOVES THE PLAYER.
//
// Until now the contract was: the client sends its POSITION and the server writes it down. Every
// reach check in server.js — node claims, monster strikes, the raid gate — is measured against that
// row, so a row the client authors makes all of them advisory. /world/move already stamps a WARP
// when a jump is impossible, but a warp stamp is a plaster: it never disputes where you are, it only
// stands the value routes down for 3 s.
//
// This module lets the server DERIVE the position instead: give it the same inputs the player's
// hands produce (a move vector, jump, sprint, the mode they are in) and it integrates the same
// physics Player.gd runs, against the same terrain (world_terrain.surfaceHeight, verified identical
// to the client generator on 405/405 points by terrain_parity_sim.mjs).
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS IS NOT: LOCKSTEP.
// ---------------------------------------------------------------------------------------------
// GDScript float32 + Jolt's move_and_slide against a meshed voxel world cannot be reproduced
// bit-exactly in JS, and chasing that would rubber-band every honest player. The goal is AUTHORITY,
// not parity. So there are two separate jobs here and they must not be confused:
//
//   THE SIMULATION  is a plausibility MODEL. It answers "where would a player pressing these keys
//                   be?" It is resynced to the client's own claim every time that claim is accepted,
//                   so its error never accumulates past one report interval.
//   THE CEILINGS    are the SECURITY boundary. They answer "could a player possibly have got there?"
//                   and they use the maximum multiplier the game can legitimately produce, so they
//                   never touch an honest player however geared.
//
// Corrections are ASYMMETRIC and that is the load-bearing design decision: a claim that is BEHIND
// the simulation is always accepted (the client was blocked by a building, a tree, a fence — none of
// which exist in the heightfield the server reads), while a claim AHEAD of the simulation by more
// than the tolerance is refused. Being slower than the model is never evidence of cheating; being
// faster is the only thing that is.
//
// EVERYTHING HERE IS OFF UNTIL CHIK_PHYS=1. server.js keeps its position-relay behaviour exactly.
import { surfaceHeight } from "./world_terrain.js";

// ============ THE CLIENT'S OWN NUMBERS ============
// Every value below is COPIED from ~/Downloads/ChikoriaSmooth/Player.gd at the cited line. None of
// them were invented, re-derived or "improved" — they were tuned by feel and the client is the
// authority on them. If Player.gd changes, this block is what has to move with it.
export const PHYS = {
  WALK: 9.0,            // Player.gd:9   @export var walk_speed
  RUN: 18.0,            // Player.gd:10  @export var run_speed   (sprint)
  SWIM: 7.0,            // Player.gd:19  @export var swim_speed
  GRAVITY: 30.0,        // Player.gd:20  @export var gravity
  JUMP: 12.0,           // Player.gd:21  @export var jump_speed  -> apex 12^2/(2*30) = 2.40 u, air 0.80 s
  AVATAR_H: 5.0,        // Player.gd:22  capsule height; collider centred at avatar_height*0.5
  WATER: 4.0,           // Player.gd:23  @export var water_level
  BOAT: 70.0,           // Player.gd:24  @export var boat_speed  (the fastest legitimate thing in the game)

  COYOTE: 0.10,         // Player.gd:573 grace after leaving the floor where a jump still fires
  JUMP_BUF: 0.12,       // Player.gd:578 grace before landing where an early press still fires
  DIR_EPS: 0.1,         // Player.gd:670 below this the client zeroes vx/vz outright — no friction curve
  WATER_ENTER: 0.4,     // Player.gd:537 _in_water := y < water_level - 0.4
  WATER_FLOAT: 1.2,     // Player.gd:551 buoyancy target = water_level - 1.2
  WATER_K: 3.0,         // Player.gd:552 vy = (target_y - y) * 3.0
  WATER_VY_MAX: 1.3,    // Player.gd:559 clamp(vy, -swim, swim * 1.3)
  SWIM_GATOR: 2.0,      // Player.gd:541 Swampborn: the gator swims as fast as it runs

  MOUNT_DASH: 1.55,     // Player.gd:598 dash multiplier ...
  MOUNT_DASH_WOLF: 1.85,//               ... 1.85 for the "dashspd" perk (Direwolf)
  FLY_HOVER: 5.0,       // Player.gd:128 FLY_MOUNT_HOVER — the griffin cruises this high over terrain
  FLY_LOOKAHEAD: 3.5,   // Player.gd:655 it clears obstacles by sampling this far ahead
  FLY_K: 6.0,           // Player.gd:658 vy = (target_y - y) * 6.0

  STEP_MAX: 1.6,        // Player.gd:683 auto step-up fires for a rise of 0.9..1.6 over 2.2 units;
  STEP_AHEAD: 2.2,      // Player.gd:681 anything taller is a wall you must jump or go around
  STEP_LIFT: 1.25,      // Player.gd:686/688 the lift the step-up applies

  BOAT_DECK: 0.4,       // Player.gd:3388 boat floats at water_level + 0.4 (+/- 0.3 bob)
  BOAT_SEAT: 2.2,       // Player.gd:3393 the rider rides 2.2 above the boat

  // MEASURED, NOT ASSUMED (dev_physdump.gd, windowed, real Main.tscn + real voxel collision):
  // where the avatar's ORIGIN rests relative to surfaceHeight(x,z) on flat ground. The voxel at
  // index h occupies [h, h+1), so the walkable face is h+1 and the capsule's foot sits on it.
  // Confirmed on the flat plateau (surf 21), the hill shelf (surf 11) and the beach (surf 6).
  FOOT: 1.0,
};

// ============ THE SPEED CEILINGS — the security boundary ============
// A player's real speed is walk/run TIMES Profile.speed_mult(), which the server does not know
// (it is gear + perks + a potion, all client-side). So the ceiling assumes the BEST case the game
// can produce and the simulation learns the rest (see mult, below). Decomposed from
// Profile.speed_mult() (Profile.gd:1125-1132) so each term can be checked:
//   boots Lv10          1 + Econ.BOOTS_SPD[10] = 1.98      (Econ.gd:246)
//   Navigator/Wayfinder x 1.18                             (Econ.gd:415 AVATAR_PERK "move")
//   Swiftfoot Serum     x 1.40                             (Profile.gd:1131)
//   mounted: + Econ.MOUNTS[mount].spd, max griffin 1.40    (Econ.gd:270)
//   Proud + full belly  x 1.03                             (Profile.gd:2055)
export const MAX_MULT_FOOT = 1.98 * 1.18 * 1.40;                    // 3.2710
export const MAX_MULT_MOUNT = (1.98 + 1.40) * 1.03 * 1.18 * 1.40;   // 5.7513

export const MODES = ["foot", "mount", "fly", "boat", "spec"];

// Top legitimate horizontal speed for a mode, in units/second. Everything is measured against this
// and nothing else; WARP_MAX_UPS (110) in server.js is the coarser, older version of this table and
// stays exactly as it is — this module never touches it.
export function maxSpeed(mode, wet) {
  if (wet) return PHYS.SWIM * PHYS.SWIM_GATOR;                          // 14.0 (gator)
  switch (mode) {
    case "boat": return PHYS.BOAT;                                      // 70.0
    case "mount":
    case "fly": return PHYS.WALK * MAX_MULT_MOUNT * PHYS.MOUNT_DASH_WOLF; // 95.77
    case "spec": return 420.0;                                          // Player.gd:18 fly_speed, CREATOR ONLY
    default: return PHYS.RUN * MAX_MULT_FOOT;                           // 58.88
  }
}

// The speed the SIMULATION uses: the same table, but with the player's own learned multiplier
// instead of the ceiling. `mult` is bounded by the ceiling, so a hostile client can never teach it
// anything the ceiling would not already have allowed.
export function simSpeed(state, input, wet) {
  const mult = clamp(state.mult || 1, 1, state.mode === "mount" || state.mode === "fly" ? MAX_MULT_MOUNT : MAX_MULT_FOOT);
  if (wet) return PHYS.SWIM * (state.mode === "mount" ? PHYS.SWIM_GATOR : 1);
  switch (state.mode) {
    case "boat": return PHYS.BOAT;
    case "mount":
    case "fly": {
      const base = PHYS.WALK * mult;
      return input.sprint && (state.dash || 0) > 0 ? base * PHYS.MOUNT_DASH : base;
    }
    case "spec": return 420.0;
    default: return (input.sprint ? PHYS.RUN : PHYS.WALK) * mult;
  }
}

// ============ TUNING — the numbers this module itself owns ============
export const TUNE = {
  DT_MAX: 0.10,          // biggest dt a single input frame may claim (6 client frames at 60 Hz)
  DT_MIN: 0.0005,        // below this a frame is noise
  SUB_DT: 1 / 60,        // integrate in client-sized substeps so a big dt cannot tunnel a wall
  // The wall-clock bank an input frame spends from (see grantDt). SIZED FROM THE WIRE, not taste:
  // one /world/move body carries at most INPUT_MAX_FRAMES 16 buckets (Net.gd:1546) and sanitizeInput
  // clamps each to DT_MAX, so 1.60 s is the most a single honest MESSAGE can ever describe. It was
  // 0.50, which is SMALLER than one message — a client whose report was 1.8 s late sent 1.44 s of
  // perfectly honest input frames and grantDt could afford 0.50 s of them, so the model sat still
  // while the player ran and reconcile called the difference a cheat (strand_min.mjs, 2026-08-05).
  //
  // 3.20, NOT 1.60, BECAUSE THE CLIENT DOES NOT SEND ONE MESSAGE AT A TIME. Net.gd:44 keeps TWO
  // request lanes in flight ("PIPELINED MOVES"), so a link that frees up after a stall delivers a
  // PAIR milliseconds apart: lane 1 with its 16 trimmed buckets and lane 2 with everything since.
  // A bank sized for one message pays for lane 1 and then short-changes lane 2 — measured on the
  // plateau at a 30.24 u/s geared sprint (fgs_fix_phys_sim F1, and the same shape end-to-end through
  // real server.js in fgs_move_spike_sim): lane 2 carried 0.280 s of honest input frames and the
  // bank could fund 0.163 s of them, so the model fell exactly the unfunded 0.117 s x 30.24 = 3.54 u
  // behind and rule 4 refused the player "ahead-of-sim" by 0.53 u. 16 of 22 stall lengths between
  // 1.8 s and 4.4 s corrected a player running in a straight line on flat ground, and each one cost
  // them 3 s of "catch your breath" on the next gather, cast, strike and raid claim.
  // The ceiling is the same derivation as before, for the number of lanes that actually exist:
  // 2 x INPUT_MAX_FRAMES 16 x DT_MAX 0.10 = 3.20 s is the most a coalesced PAIR can ever describe
  // (2 x 16 x INPUT_BUCKET 0.09 = 2.88 s honestly), so no honest burst can outrun the bank again.
  // THE ANTI-INFLATION INVARIANT IS UNTOUCHED AND IS THE WHOLE POINT: the bank still fills at
  // exactly one second per second of WALL CLOCK, so this buys a client nothing it did not wait for —
  // 600 frames claiming dt:1.0 posted inside one millisecond still buy 0.000 s (fgs_fix_phys_sim
  // F1b), and the sustained grant rate over 60 s of real time is still <= 60 s. All that changes is
  // that seconds the client REALLY WAITED THROUGH may now be spent in one burst instead of being
  // thrown away, which is the difference between the model tracking a recovering player and the
  // model being told they cheated. The security boundary is unmoved: the HARD reach gate (rule 2)
  // is a SEPARATE bank of REACH_BANK_S 2.5 s at the ceiling speed and still binds every claim.
  BUDGET_MAX: 3.20,
  INPUT_TTL: 0.35,       // a held input older than this stops steering (the tick must not run a
                         // backgrounded tab across the island); slightly over MOVE_DT 0.28
  // How much of a report interval the SOFT gate will forgive as "the server had no model here".
  // See the open-loop note in reconcile(). Deliberately smaller than the reach bank (2.5 s): past
  // OPEN_MAX the HARD gate is the binding one, which is where the security boundary belongs.
  OPEN_MAX: 1.00,

  // THE TOLERANCE. A claim more than this far AHEAD of the simulation is corrected. Chosen from
  // measurement, not taste: the shipped client authors a position every MOVE_DT = 0.28 s (Net.gd:12)
  // and the p95 sample age is 0.275 s (ledger, mobile_desktop_sync), so the model runs open-loop for
  // ~0.55 s in the worst case. Over that window the measured sim-vs-client divergence on the flat is
  // an order of magnitude smaller than this; the number is set by the SLOPES, where the client's
  // capsule and the server's heightfield disagree about how fast you climb. 2.0 u is ~40% of the
  // 5.04 u a sprinter covers in one report interval — loose enough that no honest player is ever
  // fought, tight enough that the smallest useful teleport (across a shop, onto a resource node) is
  // caught. Raise it before you ever consider making it asymmetric in the other direction.
  POS_TOL: 2.0,

  // ============ THE HARD REACHABILITY GATE — A BANK, NOT A PER-CLAIM CONSTANT ============
  // This was `maxSpeed * dtWall + REACH_SLACK(6.0)`, and a fixed per-CLAIM allowance is wrong in
  // BOTH directions at once. Measured, not argued (_av_phys_attack_sim A10, _av_phys_honest_sim B4):
  //   TOO LOOSE — the allowance is per MESSAGE, so it scales with how often you talk. 120 claims of
  //     5.5 u posted as fast as HTTP accepts them travelled 660 u in 0.21 s = 3203 u/s, uncorrected,
  //     because each claim arrived with dtWall ~0 and collected another whole 6.0 u of slack.
  //   TOO TIGHT — 6.0 u is SMALLER than one honest report interval. The recorded client sprints at
  //     30.24 u/s, i.e. 8.47 u per MOVE_DT, and Net.gd deliberately keeps TWO requests in flight, so
  //     whenever a pair coalesces the second one has dtWall ~0.001 and a ceiling of 6.07 against a
  //     move of 8.47: 18 corrections in 24 reports for a player running in a straight line.
  // Both symptoms are the same mistake. The fix is the one grantDt already uses for time: a BANK
  // that fills at exactly the ceiling speed per second of WALL CLOCK. Held in SECONDS so that a mode
  // change (stepping onto a boat) rescales the allowance automatically.
  //   honest sprinter  — spends 0.12 s of bank per 0.28 s elapsed; the bank sits at the cap forever
  //   honest burst     — ten coalesced reports cost 0.85 s of a 2.5 s bank
  //   attacker         — drains the bank in a fraction of a second and is then held to EXACTLY the
  //                      ceiling speed, however fast they post
  REACH_BANK_S: 2.5,

  // A player who is corrected can never be accepted again while the base the check measures from is
  // frozen — moved only grows. Measured: a boat whose claim went one step past what the heightfield
  // allowed produced 12 consecutive corrections and left the presence row stranded 235 u behind,
  // permanently. Every value route reads that row, so a false correction that sticks does not merely
  // rubber-band a player, it takes their gathering away until they relog. After STUCK_MS of unbroken
  // corrections the base is resynced to the claim — and the value routes are stood down for
  // RESYNC_HOLD_MS, which is longer than the cooldown, so a cheater who forces a resync deliberately
  // gets a position and never a payout.
  STUCK_MS: 4000,
  RESYNC_COOLDOWN_MS: 15000,
  RESYNC_HOLD_MS: 16000,

  // How far a straight line between two accepted positions may pass through solid rock before it is
  // a wall hack. A step (1.6) plus a margin for the fact that the heightfield is sampled every ~2
  // units and the client's collision is finer: 3.0 clears every honest voxel staircase measured in
  // dev_physdump (worst penetration on the recorded hill and wall runs: 0.0).
  PEN_TOL: 3.0,

  // Vertical is deliberately NOT authoritative — see the note on adopt().
  FLOOR_EPS: 0.35,       // how far below the terrain a claim may sit before it is lifted
  LAND_SNAP: 0.6,        // fall this close to the ground with vy<=0 and you are standing on it

  TELEPORT_R: 14.0,      // how close a claim must land to a whitelisted destination to be granted
  TELEPORT_HOLD_MS: 3000,// how long a granted teleport keeps accepting (matches WARP_HOLD_MS)
  MODE_SWITCH_R: 24.0,   // boarding/leaving a boat legitimately moves you this far in one frame
};

// ============ THE TELEPORTS THAT ARE REAL ============
// Chikoria moves honest players instantly and the server must never fight it. There is exactly one
// such destination live in the client today:
//   the drowning rescue — Player.gd:1737-1741 puts you at (105, surf+1.5, -104), in front of the
//   Healing Center, after 1.2 s of floundering in open sea.
// _travel() (Player.gd:2695) is the same mechanism for travel points; no node joins the "portal"
// group in the shipped client yet, so the table below is the whole of it. ADD TO THIS TABLE when a
// portal ships — a destination that is not here is treated as a silent jump and corrected.
export const TELEPORTS = [
  { name: "healing_center_rescue", x: 105.0, z: -104.0, r: TUNE.TELEPORT_R },
];

export function teleportDestination(x, z) {
  for (const t of TELEPORTS) if (Math.hypot(x - t.x, z - t.z) <= t.r) return t;
  return null;
}

// ============ helpers ============
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function num(v, dflt = 0) { const n = +v; return Number.isFinite(n) ? n : dflt; }
export function groundAt(x, z) { return surfaceHeight(x, z) + PHYS.FOOT; }

// THE FLOOR, AS APPLIED TO A POSITION THE SERVER IS ABOUT TO PUBLISH. Exactly reconcile rule 5's
// rule and no other: more than FLOOR_EPS under the terrain is lifted onto it, anything at or above
// the terrain is left completely alone — bridges, road decks, shop floors and rooftops are real
// collision the heightfield cannot see, and disputing THOSE is what adopt() warns against. This is
// only the "you may not be under the island" half, which step() already treats as absolute.
export function liftToFloor(x, y, z) {
  const g = groundAt(x, z);
  return y < g - TUNE.FLOOR_EPS ? g : y;
}

// ============ STATE ============
export function newState(x, y, z, dir = 0, nowMs = Date.now()) {
  return {
    x: num(x), y: num(y), z: num(z), dir: num(dir),
    vx: 0, vy: 0, vz: 0,
    grounded: false, blocked: false,
    coyote: 0, jumpBuf: 0, jumpPrev: false,
    mode: "foot",
    wet: false,
    dash: 1,               // the mount's remaining dash budget, in seconds (Econ.mount_dash 3..9)
    mult: 1,               // learned speed multiplier, bounded by MAX_MULT_* — see learnMult()
    lastInputSeq: 0,       // acked back to the client every tick
    simT: 0,               // seconds of simulation this state has actually been granted
    budget: 0,             // unspent wall-clock, in seconds (the anti-dt-inflation bank)
    lastMs: nowMs,         // when the budget was last topped up
    coastMs: nowMs,        // when the model last coasted (see tickPlayer) — a SEPARATE clock from lastMs
    driveT: 0,             // seconds of simulation granted since the last ACCEPTED claim (reconcile reads it)
    claimedMove: false,    // has the client sent a MOVING input frame since the last accepted claim?
    claimX: num(x), claimY: num(y), claimZ: num(z), claimMs: nowMs,   // last ACCEPTED client claim (reach check base)
    acceptUntil: 0,        // a granted teleport window: accept whatever the client says until then
    reachS: TUNE.REACH_BANK_S,  // unspent reach budget, in SECONDS of ceiling-speed travel
    reachMs: nowMs,             // when the reach bank was last topped up
    stuckSince: 0,              // first of an unbroken run of corrections (0 = not stuck)
    lastResyncMs: 0,            // last time the stuck escape fired
    corrections: 0, rejects: 0, drops: 0, resyncs: 0,
  };
}

// ============ INPUT SANITATION ============
// A malformed frame is a DROPPED FRAME, never a kicked player: a phone that backgrounds mid-send, a
// truncated socket write and a fuzzer all produce the same garbage, and only one of them is hostile.
// Returns null for "ignore this frame".
// `opts.allowSpec` — "spec" is the CREATOR free-fly (Player.gd:466-481, 420 u/s, no collision at
// all). It is admin-gated in the CLIENT, which is worth nothing: a hostile client simply puts
// mode:"spec" in an input frame, physModeOf then keeps it sticky, and maxSpeed hands them a 420 u/s
// ceiling and a step() branch that ignores the ground. Measured before this gate existed: a bare
// net_id declared spec and had a 110 u jump in 0.3 s ACCEPTED (366 u/s). server.js passes
// isAdminWallet(wallet); anything else falls back to "foot".
export function sanitizeInput(raw, state, opts = {}) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Math.floor(num(raw.seq, -1));
  if (!(seq >= 0)) return null;
  if (state && seq <= state.lastInputSeq) return null;    // replay or out-of-order — the newest wins
  let dt = num(raw.dt, 0);
  if (!(dt > 0)) return null;
  if (dt > 1.0) return null;                              // beyond absurd; a real frame is ~0.016
  const mv = raw.move && typeof raw.move === "object" ? raw.move : {};
  let mx = num(mv.x, 0), mz = num(mv.z, 0);
  const len = Math.hypot(mx, mz);
  if (!Number.isFinite(len)) return null;
  if (len > 1) { mx /= len; mz /= len; }                  // Player.gd set_move does limit_length(1.0)
  let mode = MODES.includes(String(raw.mode || "")) ? String(raw.mode) : "foot";
  if (mode === "spec" && !opts.allowSpec) mode = "foot";
  return { seq, dt: clamp(dt, TUNE.DT_MIN, TUNE.DT_MAX), move: { x: mx, z: mz }, jump: !!raw.jump, sprint: !!raw.sprint, mode };
}

// THE OLDEST SPEED HACK IS AN INFLATED dt. Nothing stops a client claiming dt:1.0 sixty times a
// second, so dt is not merely clamped per frame — it is spent from a bank that fills at exactly one
// second per second of WALL CLOCK. Sixty inflated frames drain the bank and then buy nothing at all,
// while an honest client (whose frames sum to real time) never notices the bank exists.
export function grantDt(state, wantDt, nowMs) {
  const elapsed = Math.max(0, (nowMs - (state.lastMs || nowMs)) / 1000);
  state.budget = Math.min(TUNE.BUDGET_MAX, (state.budget || 0) + elapsed);
  state.lastMs = nowMs;
  const dt = Math.min(clamp(num(wantDt, 0), 0, TUNE.DT_MAX), state.budget);
  state.budget -= dt;
  return dt;
}

// ============ ONE FIXED STEP ============
// step(state, input, dt) -> newState. Pure: it does not mutate `state`. dt is expected to be small
// (<= TUNE.SUB_DT); advance() does the splitting. The order of operations mirrors
// Player.gd:_physics_process exactly — water first (it returns early there too), then gravity, then
// the coyote/buffer jump, then the horizontal move, then the ground.
export function step(state, input, dt) {
  const s = { ...state };
  const inp = input || { move: { x: 0, z: 0 }, jump: false, sprint: false, mode: s.mode };
  s.mode = MODES.includes(inp.mode) ? inp.mode : s.mode;
  dt = clamp(num(dt, 0), 0, TUNE.SUB_DT);
  if (dt <= 0) return s;
  s.simT += dt;

  let mx = num(inp.move.x), mz = num(inp.move.z);
  const mlen = Math.hypot(mx, mz);
  const moving = mlen > PHYS.DIR_EPS;      // Player.gd:670 — the client's own threshold
  if (moving) { mx /= mlen; mz /= mlen; }  // Player.gd:671 dir = dir.normalized()
  if (moving) s.dir = Math.atan2(mx, mz);  // Player.gd:689 _body.rotation.y = atan2(dir.x, dir.z)

  // ---- SWIMMING (Player.gd:536-562). Buoyancy, not gravity; the branch returns early there. ----
  s.wet = s.y < PHYS.WATER - PHYS.WATER_ENTER;
  if (s.wet && s.mode !== "boat" && s.mode !== "spec") {
    const sp = simSpeed(s, inp, true);
    if (moving) { s.vx = mx * sp; s.vz = mz * sp; }
    else {
      // Player.gd:548 lerp(v, 0, clamp(5*dt,0,1)) — the one place the client eases instead of cutting
      const k = clamp(5.0 * dt, 0, 1);
      s.vx += (0 - s.vx) * k; s.vz += (0 - s.vz) * k;
    }
    let vy = (PHYS.WATER - PHYS.WATER_FLOAT - s.y) * PHYS.WATER_K;
    if (inp.jump) vy += PHYS.SWIM;
    s.vy = clamp(vy, -PHYS.SWIM, PHYS.SWIM * PHYS.WATER_VY_MAX);
    moveHorizontal(s, dt);
    s.y += s.vy * dt;
    const gw = groundAt(s.x, s.z);
    if (s.y < gw) { s.y = gw; s.vy = Math.max(0, s.vy); s.grounded = true; }   // the sea BED is still a floor
    else s.grounded = false;
    return s;
  }

  // ---- BOAT (Player.gd:3378-3395). The hull is driven, the rider is carried; no gravity at all. ----
  if (s.mode === "boat") {
    const sp = PHYS.BOAT;
    s.vx = moving ? mx * sp : 0; s.vz = moving ? mz * sp : 0;
    s.x += s.vx * dt; s.z += s.vz * dt;      // a boat does not collide with the heightfield: it is at sea
    // THE HORIZONTAL non-collision above is deliberate and stays. THE FLOOR IS NOT PART OF IT: the
    // land, swim and fly branches all end by refusing to leave a body under the island, and this one
    // pinned y to the deck height unconditionally. At sea that is the same number either way (the
    // seabed on the recorded runs is -7 to -8, against a deck at 6.60), so no sailor can tell the
    // difference — but a hull the 20 Hz tick carries inland on its last held input (INPUT_TTL 0.35 s
    // x BOAT 70 u/s = 24.5 u) sits at 6.60 under a 22.00 plateau, and physTickAll writes that y
    // straight into the presence row 20 times a second. Measured through real server.js before this
    // line (fgs_fix_underterrain_probe): worst hull sample x=348.11 y=6.6000 with groundAt 22.00 —
    // BURIED 15.40 u, published to every peer, with corr=1 on 10 of 26 reports.
    s.y = Math.max(PHYS.WATER + PHYS.BOAT_DECK + PHYS.BOAT_SEAT, groundAt(s.x, s.z));
    s.vy = 0; s.grounded = false;
    return s;
  }

  // ---- CREATOR FREE-FLY (Player.gd:466-481). Admin-gated in the client; see server.js. ----
  if (s.mode === "spec") {
    const sp = 420.0;
    s.vx = moving ? mx * sp : 0; s.vz = moving ? mz * sp : 0;
    s.x += s.vx * dt; s.z += s.vz * dt; s.vy = 0; s.grounded = false;
    return s;
  }

  // ---- FLYING MOUNT (Player.gd:644-669). Cruises FLY_HOVER over the ground it is about to cross. ----
  if (s.mode === "fly") {
    const sp = simSpeed(s, inp, false);
    let gsurf = surfaceHeight(s.x, s.z);
    if (moving) gsurf = Math.max(gsurf, surfaceHeight(s.x + mx * PHYS.FLY_LOOKAHEAD, s.z + mz * PHYS.FLY_LOOKAHEAD));
    const ty = gsurf + PHYS.FLY_HOVER + PHYS.FOOT;
    s.vy = (ty - s.y) * PHYS.FLY_K;
    if (moving) { s.vx = mx * sp; s.vz = mz * sp; }
    else { s.vx = towards(s.vx, 0, sp * 6 * dt); s.vz = towards(s.vz, 0, sp * 6 * dt); }
    s.x += s.vx * dt; s.z += s.vz * dt; s.y += s.vy * dt;
    const gf = groundAt(s.x, s.z);
    if (s.y < gf) { s.y = gf; s.vy = Math.max(0, s.vy); }
    s.grounded = false;
    return s;
  }

  // ---- ON LAND / MOUNTED (Player.gd:564-694) ----
  if (!s.grounded) s.vy -= PHYS.GRAVITY * dt;      // Player.gd:566
  else if (s.vy < 0) s.vy = 0;                     // Player.gd:568
  s.coyote = s.grounded ? PHYS.COYOTE : Math.max(0, s.coyote - dt);      // Player.gd:572-575
  if (inp.jump && !s.jumpPrev) s.jumpBuf = PHYS.JUMP_BUF;                // Player.gd:577-580
  else s.jumpBuf = Math.max(0, s.jumpBuf - dt);
  if (s.coyote > 0 && s.jumpBuf > 0) {                                   // Player.gd:581-584
    s.vy = PHYS.JUMP; s.coyote = 0; s.jumpBuf = 0; s.grounded = false;
  }
  s.jumpPrev = !!inp.jump;

  // mount dash burns while held and recharges when you ease off (Player.gd:596-607)
  if (s.mode === "mount") {
    if (inp.sprint && s.dash > 0.001) s.dash = Math.max(0, s.dash - dt);
    else if (!inp.sprint) s.dash = Math.min(9.0, s.dash + dt);           // Econ.mount_dash tops out at 9
  }

  const sp = simSpeed(s, inp, false);
  if (moving) { s.vx = mx * sp; s.vz = mz * sp; }
  else { s.vx = 0; s.vz = 0; }                     // Player.gd:691 — a hard cut, no deceleration

  moveHorizontal(s, dt);

  // ---- THE GROUND ----
  const g = groundAt(s.x, s.z);
  s.y += s.vy * dt;
  if (s.y <= g + (s.vy <= 0 ? TUNE.LAND_SNAP : 0)) {
    if (s.vy <= 0) { s.y = g; s.vy = 0; s.grounded = true; }
    else if (s.y < g) { s.y = g; s.grounded = false; }
  } else s.grounded = false;
  // THE FLOOR IS ABSOLUTE. Whatever else happened, a player is never under the island.
  if (s.y < g) { s.y = g; if (s.vy < 0) s.vy = 0; s.grounded = true; }
  return s;
}

function towards(v, t, d) { return v > t ? Math.max(t, v - d) : Math.min(t, v + d); }

// Horizontal integration WITH the heightfield as a wall. The client gets this from
// move_and_slide against meshed voxels; here it is a rise test, and the axis-separated retry is
// what reproduces sliding along a cliff instead of stopping dead against it.
function moveHorizontal(s, dt) {
  const nx = s.x + s.vx * dt, nz = s.z + s.vz * dt;
  if (passable(s, nx, nz)) { s.x = nx; s.z = nz; return; }
  // BLOCKED. Remember it: a blocked model is a model that has lost the plot for this interval, and
  // reconcile() must not then accuse the player of being "ahead of the simulation" — the heightfield
  // has no bridges, no road decks over gullies and no building floors, all of which the client walks
  // on quite legally.
  s.blocked = true;
  if (passable(s, nx, s.z)) { s.x = nx; s.vz = 0; return; }
  if (passable(s, s.x, nz)) { s.z = nz; s.vx = 0; return; }
  s.vx = 0; s.vz = 0;   // cornered
}
// You may enter a column whose walkable face is no more than STEP_MAX above your FEET. Standing on
// the flat that is the client's auto-step-up band (Player.gd:683); airborne it is exactly right too,
// because a jump that clears a ledge puts s.y above it.
function passable(s, nx, nz) { return groundAt(nx, nz) <= s.y + PHYS.STEP_MAX; }

// DID THE PLAYER PASS THROUGH SOLID ROCK? Sampled along the straight line between the last accepted
// position and the new claim. This is the anti-wallhack test that does NOT depend on knowing anyone's
// gear, speed or frame rate — geometry only. It cannot fight a bridge or a rooftop, because those put
// the player ABOVE the sampled ground, and the test only fires where the ground is above BOTH ends of
// the segment by more than a step. Returns the worst penetration in units, 0 for a clean line.
export function segmentPenetration(x0, y0, z0, x1, y1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  if (!(d > 0)) return 0;
  // THE ENDPOINT IS SAMPLED, AND THE SHORT-SEGMENT SKIP IS GONE. `if (!(d > 1)) return 0` plus a
  // loop of `i < n` tested neither, and the two together were a complete bypass: a claim that lands
  // INSIDE a column is lifted onto it by rule 5 (the terrain floor), so a client posting a series of
  // 1.0-unit hops walked straight up the steepest face on the island — 40 hops, 0 corrections,
  // arriving on top of a 7-unit wall it should have had to go around (_av_phys_attack_sim A12).
  // Sampling the destination costs an honest player nothing, because a real client is standing ON
  // the ground it claims: g - (y + STEP_MAX) is then <= -1.0 by construction, and a voxel staircase
  // rises 1 unit per step against a 1.6 step allowance. Measured on all 8 recorded client runs
  // (dev_physdump, real Jolt collision): worst penetration 0.000 with the endpoint included.
  const n = Math.min(96, Math.max(2, Math.ceil(d / 2)));   // a sample every ~2 units, capped
  const ceilY = Math.max(y0, y1) + PHYS.STEP_MAX;
  let worst = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const g = groundAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    if (g - ceilY > worst) worst = g - ceilY;
  }
  return worst;
}

// ============ ADVANCE — dt clamping, the wall-clock bank, and substepping ============
export function advance(state, input, wantDt, nowMs = Date.now()) {
  // ACK FIRST, MOVE SECOND. The ack means "I have consumed up to this seq", not "I granted it time" —
  // a frame the wall-clock bank refuses still arrived and must never be resent. Acking only the
  // frames that were granted dt made the ack stall behind a client whose frames summed to slightly
  // more than real time (measured: 48 frames sent, ack stuck at 45).
  // THE EVIDENCE LEDGER, read by reconcile's open-loop allowance. `claimedMove` records that the
  // client has actually TOLD the server it was moving since the last accepted claim, which is what
  // separates an honest late report (16 buckets of real motion) from a client that went quiet and
  // then blinked — the second one earns no open-loop credit at all. Only a NEW seq counts, so the
  // 20 Hz tick re-using the held input cannot inflate it.
  const _isNew = !!(input && Number.isFinite(input.seq) && input.seq > (state.lastInputSeq || 0));
  if (input && Number.isFinite(input.seq)) state.lastInputSeq = Math.max(state.lastInputSeq, input.seq);
  if (_isNew && input.move && Math.hypot(num(input.move.x), num(input.move.z)) > PHYS.DIR_EPS) state.claimedMove = true;
  const dt = grantDt(state, wantDt, nowMs);
  // Seconds the model was actually INTEGRATED since the last accepted claim. Everything reconcile
  // cannot explain with this is open loop; adopt() zeroes it on every accepted claim.
  state.driveT = (state.driveT || 0) + dt;
  if (dt <= 0) return { state, dt: 0, steps: 0 };
  let s = state, steps = 0, left = dt;
  while (left > 1e-9 && steps < 64) {
    const d = Math.min(TUNE.SUB_DT, left);
    s = step(s, input, d);
    left -= d; steps++;
  }
  return { state: s, dt, steps };
}

// The 20 Hz tick's per-player work: carry the last input forward, but only while it is fresh. A tab
// that stops sending must NOT keep running across the island; gravity keeps applying so a player who
// disconnects mid-jump still lands.
export function tickPlayer(state, nowMs = Date.now()) {
  const held = state.input || null;
  const fresh = held && (nowMs - (state.inputMs || 0)) / 1000 <= TUNE.INPUT_TTL;
  // TWO CLOCKS. `lastMs` is the BANK's clock (grantDt tops the budget up from it); `coastMs` is the
  // integration clock. They are the same thing while the model is being steered and must not be
  // while it is coasting — see below.
  const clk = Math.max(state.lastMs || 0, state.coastMs || 0) || nowMs;
  const dtWant = Math.min(TUNE.DT_MAX, Math.max(0, (nowMs - clk) / 1000));
  // ---- THE TICK NEVER SPENDS THE CLIENT'S WALL-CLOCK BANK, ON EITHER BRANCH. ----
  // The coasting branch below stopped debiting it because "those seconds belong to the input frames
  // the client is about to send describing them". That is just as true of the CARRY-FORWARD branch:
  // re-running an already-acked input frame is the server EXTRAPOLATING so peers see continuous
  // motion between a mover's 280 ms reports — it is presentation, not simulation the player pays
  // for. Calling advance() here charged those seconds to grantDt, and the client's own frames for
  // the same seconds then arrived with nothing left to pay for them. Measured with advance() still
  // on this branch (adv_e20.mjs, 2026-08-05, IDENTICAL on the pre-strand-fix and post-strand-fix
  // trees, so it is the OLDER half of the same bug): Net.gd keeps two request lanes in flight, so a
  // stalled link delivers a pair ~8 ms apart; the first is accepted, the tick has already spent
  // ~0.35 s of the 0.56 s budget, and the SECOND of every pair is granted driveT 0.003 s and refused
  // "ahead-of-sim" — 12 corrections in 25 reports for a player running in a straight line. After
  // this change: 1 in 25, and that one is the very first pair, before mult has learned the player.
  // No inflation is possible without the bank here: this branch integrates WALL CLOCK (now - clk,
  // capped at DT_MAX per tick), never a client-declared dt, so it can never run faster than time.
  const drive = fresh ? held
    : { seq: state.lastInputSeq, dt: 0, move: { x: 0, z: 0 }, jump: false, sprint: false, mode: state.mode };
  // ---- COASTING (`drive` is the idle frame): no fresh input, so NOTHING TO SIMULATE. ----
  // Gravity still applies (a player who disconnects mid-jump must land) but the horizontal move
  // vector is zero, so this stretch moves nobody sideways. THE WALL-CLOCK BANK IS NOT DEBITED and
  // `lastMs` is not advanced, because those seconds do not belong to the server's guess — they
  // belong to the input frames the client is about to send describing them. Draining the bank here
  // WAS THE STRAND: the 20 Hz tick spent every second of a late report interval on "you stood
  // still", so when the client's own 16 honest buckets arrived grantDt could afford ~0 of them, the
  // model stayed where it was, and reconcile read the player's real distance as a cheat. Measured
  // before this change (strand_min.mjs, 2026-08-05): one 1.60 s gap accepted, 1.65 s refused, and
  // 14 of the next 20 replies still carried corr:1 at a normal 0.28 s cadence.
  // simT is left alone for the same reason: nothing was GRANTED, so nothing was simulated.
  const simT0 = state.simT;
  let s = state, left = dtWant, steps = 0;
  while (left > 1e-9 && steps < 8) { const d = Math.min(TUNE.SUB_DT, left); s = step(s, drive, d); left -= d; steps++; }
  if (s === state) s = { ...state };
  s.simT = simT0;
  s.coastMs = nowMs;
  return s;
}

// ============ RECONCILIATION — the tolerant part ============
// Called with what the client SAYS its position is. Returns what the server decided and why.
//   accept   — the claim is plausible; the simulation is resynced to it (error cannot accumulate)
//   lift     — accepted, but the claim was under the terrain and was raised onto it
//   correct  — the claim is ahead of what the model allows; the SERVER's position stands
//   teleport — a granted destination (drown rescue / travel point / boat) — accepted wholesale
// opts.soft   — run the sim-vs-claim comparison at all. FALSE for a client that sends no inputs:
//               there is no model to compare against, and rule 2 (pure claim-vs-claim) still holds.
// opts.minSpeed — a floor under the ceiling. server.js passes the boat's 70 u/s for clients that do
//               not declare a mode, because nothing on today's wire distinguishes a sailor.
export function reconcile(state, claim, nowMs = Date.now(), opts = {}) {
  const cx = num(claim.x, state.x), cy = num(claim.y, state.y), cz = num(claim.z, state.z);
  const dtWall = Math.max(0.001, (nowMs - (state.claimMs || nowMs)) / 1000);
  const moved = Math.hypot(cx - state.claimX, cz - state.claimZ);
  const simDist = Math.hypot(cx - state.x, cz - state.z);
  const simMoved = Math.hypot(state.x - state.claimX, state.z - state.claimZ);
  const soft = opts.soft !== false;
  // THE REACH BANK. Fills at one second per second of wall clock and is spent in seconds of
  // ceiling-speed travel, so the allowance is a RATE and not a per-message constant (see TUNE).
  const ceilSpeed = Math.max(maxSpeed(state.mode, state.wet), num(opts.minSpeed, 0));
  const bankEl = Math.max(0, (nowMs - (state.reachMs || nowMs)) / 1000);
  state.reachMs = nowMs;
  state.reachS = Math.min(TUNE.REACH_BANK_S, (Number.isFinite(state.reachS) ? state.reachS : TUNE.REACH_BANK_S) + bankEl);
  const ceiling = ceilSpeed * state.reachS;
  const out = { moved: r3(moved), simDist: r3(simDist), ceiling: r3(ceiling), dtWall: r3(dtWall), bank: r3(state.reachS) };

  // Refused for STUCK_MS without a break? The base every check measures from is FROZEN at the last
  // accepted claim, so `moved` only ever grows and an honest player whose claim was refused once for
  // a reason that persists (a cave mouth, a mine tunnel, a bridge the heightfield cannot see) can
  // never be accepted again. See TUNE.STUCK_MS — a position is handed back, a payout is not.
  const stuckFor = state.stuckSince ? nowMs - state.stuckSince : 0;
  const mayResync = stuckFor > TUNE.STUCK_MS && (nowMs - (state.lastResyncMs || 0)) > TUNE.RESYNC_COOLDOWN_MS;
  const refuse = (why, extra) => {
    state.corrections++; state.rejects++;
    // A REFUSAL PUBLISHES THE MODEL'S OWN POSITION, SO THE MODEL MAY NOT BE UNDER THE ISLAND.
    // server.js:8774 takes physApply's y and server.js:8794 writes it into the presence row, which
    // is the y every OTHER client draws this player at — the mover themself is protected, because
    // Net.gd/_net_take lifts the replay start onto the client's own generator, so the whole cost of
    // a buried y lands on everyone else's screen. step() treats the floor as absolute on the land,
    // swim, fly and (as of the line above) boat paths, but TWO adopt paths still seat the model
    // wherever the client says without any floor test, because rule 5's lift is on the accept path
    // only: rule 1's granted-teleport window and the STUCK_MS resync both take `cy` VERBATIM.
    // Neither has a live caller in server.js today (grantTeleport/grantModeSwitch are test-only and
    // the only armed window is the drown rescue), so this is the belt to the boat branch's braces —
    // one line, the same rule as rule 5, and it costs an honest player nothing because a claim at or
    // above the ground is never touched. Lifting the MODEL and not just the reply also unwedges it:
    // passable() measures from s.y, and a buried model can enter no column at all.
    state.y = liftToFloor(state.x, state.y, state.z);
    // A REFUSED PLAYER STILL TEACHES THE MODEL HOW FAST THEY ARE, and without this line a refusal is
    // SELF-SUSTAINING: learnMult used to sit only on the accept path, so a corrected sprinter left
    // the model running at mult 1.0 (18 u/s) against their real 30.24, the gap grew by 12 u every
    // interval, and the next claim was refused for exactly the same reason — a closed loop broken
    // only by STUCK_MS and then a 15 s cooldown. It authorises nothing: learnMult hard-clamps to
    // MAX_MULT_*, mult never touches the HARD gate (rule 2 uses maxSpeed, the ceiling) and a faster
    // model makes the soft gate TIGHTER, not looser, because it shrinks the `unknown` term below.
    // THE WINDOW HAS TO BE LONG ENOUGH TO *BE* A SPEED, and learnMult's own 0.05 s floor is not:
    // Net.gd keeps two request lanes in flight, so when a stalled link frees up the pair lands
    // milliseconds apart and the second one reads one whole report interval of honest travel over
    // ~0.002 s of wall clock. Measured letting that through (dev_strandnet p3/p5, 2026-08-05): mult
    // was taught the 3.271 CAP from a 30.24 u/s player, and a model running at 58.88 over-runs the
    // real client, which DISARMS the soft gate (it only fires when moved > simMoved) and hands a
    // small teleport a free pass. MOVE_DT is 0.28 s; 0.2 s admits a real report and nothing else.
    // REMOVED 2026-08-05 — and the removal is the STRICTLY BETTER of the two, measured both ways.
    // `moved` on a REFUSED claim is not a speed: on an "unreachable" refusal it is a TELEPORT
    // distance, and one refused 432 u respawn jump took mult 1.020 -> the 3.271 CAP in a single hop.
    // The model then ran at 58.88 u/s in whatever direction the client's inputs pushed — AWAY from
    // the player — so 20 honest reports after the jump the trainer was still 418.93 u from their own
    // presence row, where it closed to 192.03 u without this line (adv_diag D5). End to end that was
    // the difference between a respawn re-converging in 9.4 s and NEVER re-converging inside 11.2 s
    // (adv_entry E18). It also handed a plain speed hacker the max-gear model for free: a sustained
    // 200 u/s claim moved the row at 73.85 u/s with this line and 38.61 u/s without it (adv_fix_sim
    // F5), against a 58.88 u/s ceiling.
    // AND THE SELF-SUSTAINING REFUSAL IT WAS WRITTEN FOR CANNOT HAPPEN ONCE THE GEAR TERM IS RIGHT.
    // That loop needs the allowance to be NARROWER than the player's real divergence, and the
    // allowance is WIDEST at mult 1 — `ceilSpeed - modelTop` is 40.88 u/s for a foot player who has
    // been taught nothing, against the 12.24 u/s a 30.24 u/s sprinter actually diverges at. Not
    // learning on a refusal is therefore self-correcting: the refused player keeps the widest
    // tolerance the server has. Proven on the REAL client, not argued — dev_strandnet.gd 13/13,
    // 100.0% travel efficiency and 0 corrections at 0 / 2600 / 4500 ms of injected move lag.
    if (!state.stuckSince) state.stuckSince = nowMs;
    if (mayResync) {
      // THE RESYNC IS BOUNDED, and this matters more than it looks. An unbounded one adopts the
      // claim wholesale, so a client that simply keeps claiming an impossible position is refused
      // for STUCK_MS and then handed the whole distance for free: measured at 187 u/s sustained
      // against a 58.88 u/s ceiling, i.e. the escape hatch became the exploit. Moving only as far
      // along the line as the ceiling could have carried them in the stuck window unfreezes the
      // honest case (a player wedged at a cave mouth is metres away, not hundreds) and gives a
      // cheater nothing at all.
      const reachable = ceilSpeed * Math.min(10, stuckFor / 1000);
      const gap = Math.hypot(cx - state.x, cz - state.z);
      const t = gap > reachable ? reachable / gap : 1;
      const rx = state.x + (cx - state.x) * t, rz = state.z + (cz - state.z) * t;
      // Same floor as the refusal above and as rule 5: the resync publishes a position too (server.js
      // stores st.y for EVERY action), and `t >= 1` took the client's y verbatim, so a sub-terrain
      // claim inside the reachable radius was handed to every peer unchecked.
      const ry = liftToFloor(rx, t >= 1 ? cy : Math.max(cy, groundAt(rx, rz)), rz);
      state.lastResyncMs = nowMs; state.resyncs = (state.resyncs || 0) + 1;
      state.stuckSince = 0; state.acceptUntil = 0;
      // DEBIT the bank by what the resync actually moved, do not ZERO it. Zeroing looks safer and is
      // not: the resync distance is already bounded by the ceiling and gated by a 15 s cooldown, so
      // the only thing an empty bank buys is another 2.5 s of corrections aimed at the honest player
      // this hatch exists for. A refusal never debits, so the bank is full at this moment anyway.
      state.reachS = Math.max(0, state.reachS - (gap * t) / Math.max(1e-6, ceilSpeed));
      adopt(state, rx, ry, rz, nowMs);
      state.vx = 0; state.vy = 0; state.vz = 0; state.blocked = false;
      return { ...out, action: "resync", why, stuckMs: stuckFor, moveTo: r3(gap * t), holdMs: TUNE.RESYNC_HOLD_MS };
    }
    // A REFUSAL HANDS BACK THE SERVER'S OWN POSITION AND MOVES THE PLAYER NOWHERE, and that stays
    // exactly as it is. A "carry" that dragged a refused claim along the line by whatever the reach
    // bank could pay for was tried and REVERTED on 2026-08-05: it fixed nothing the open-loop
    // allowance above had not already fixed, and it cost three measured contracts — a silent 900 u
    // jump moved 147 u instead of 0 (physics_authority_sim test 7), a 1900 u jump nine seconds after
    // a drown rescue moved 175 u (_av_phys_attack_sim A5), and stacking on top of the STUCK_MS
    // resync it carried a sustained 200 u/s claimant at 139.83 u/s against a 58.88 u/s ceiling
    // (physics_authority_sim test 5). The escape from a persistent refusal is the bounded resync
    // above and nothing else.
    return { ...out, action: "correct", why, ...extra, x: r3(state.x), y: r3(state.y), z: r3(state.z) };
  };

  // 1. A GRANTED TELEPORT WINS OVER EVERYTHING. The drowning rescue fires client-side with no
  //    warning and moves you hundreds of units; a server that argues with it strands the player in
  //    the sea it just pulled them out of.
  //    THE WINDOW IS ARMED BY THE GRANT, NEVER BY A CLAIM THAT MERELY LANDS INSIDE IT. Re-arming on
  //    every accepted claim made one drown rescue permanent: measured 30 of 30 honest reports over
  //    8.5 s still answering "teleport", and a 1900 u jump accepted wholesale nine seconds after the
  //    rescue. The same re-arm promoted grantModeSwitch's deliberately short 400 ms boarding window
  //    to a rolling 3 s one on its first claim.
  const tp = teleportDestination(cx, cz);
  const inWindow = state.acceptUntil > nowMs;
  const granting = moved > ceiling && tp;
  if (inWindow || granting) {
    adopt(state, cx, cy, cz, nowMs);
    state.stuckSince = 0;
    if (granting && !inWindow) state.acceptUntil = nowMs + TUNE.TELEPORT_HOLD_MS;
    return { ...out, action: "teleport", to: tp ? tp.name : "granted" };
  }
  // 2. THE HARD GATE. Could a player of this mode have covered that ground in that time?
  if (moved > ceiling) return refuse("unreachable");
  // 3. THROUGH THE ISLAND. Geometry only — no speed, no gear, no frame rate. A straight line from
  //    the last accepted position to the claim that passes through rock is a wall hack whatever
  //    speed it was done at, and this is the one test that catches a SLOW one.
  const pen = segmentPenetration(state.claimX, state.claimY ?? state.y, state.claimZ, cx, cy, cz);
  if (pen > TUNE.PEN_TOL) return refuse("through-terrain", { pen: r3(pen) });
  // 4. THE SOFT GATE — the sim-vs-claim tolerance, and it is ONE-SIDED. Being BEHIND the model is
  //    never evidence of anything: the heightfield has no buildings, trees, fences or fishing stalls,
  //    so the model over-runs every honest player who bumps into one, and MEASUREMENT says it also
  //    over-runs anyone climbing a slope — dev_physdump's recorded hill run has the real client 13%
  //    slower than the model (26.33 vs 30.24 u/s), because the terrain is a 1-unit voxel STAIRCASE
  //    and the capsule pays for every riser. That is 7.97 u of honest divergence in one open-loop
  //    window; a symmetric 2 u tolerance would have corrected a player simply walking up a hill.
  //
  //    The other two carve-outs are just as load-bearing:
  //      blocked — the model hit a heightfield wall the client legitimately crossed (a road bridging
  //                a gully is baked into wall_voxels.bin, which this server does not read).
  //      gear    — the server does not know your boots, your perk or your serum, so the part of the
  //                gap that an unknown multiplier could explain is subtracted before judging.
  //
  //    AND THE THIRD CARVE-OUT, WHICH IS THE ONE THAT STRANDED PLAYERS: THE OPEN LOOP.
  //    The model only steers while the held input is FRESH (INPUT_TTL 0.35 s). A report interval
  //    longer than that leaves it coasting to a stop while the player is still running, and the gap
  //    that opens is the SERVER's, not the player's — charging it to them is what pinned honest
  //    logins at the spawn. `driveT` is the wall clock the model was actually integrated over since
  //    the last accepted claim (advance() counts it, adopt() clears it); anything left over is open
  //    loop and is allowed at the CEILING, because over that stretch the server has no model and the
  //    ceiling is the only honest bound it has.
  //    THREE THINGS KEEP THAT FROM BECOMING A TELEPORT HOLE:
  //      · it is capped at OPEN_MAX 1.0 s, so it can never grow into the reach bank's 2.5 s;
  //      · it requires `claimedMove` — a client that goes quiet and then blinks has sent no moving
  //        input frame, earns nothing, and is judged exactly as it is today;
  //      · the HARD gate (rule 2) is unchanged and still binds first for every mode: at the ceiling
  //        it refuses past 2.5 s of silence, while this allowance only reaches 2.79 s.
  //    The gear term is likewise a rate over the seconds actually simulated, floored at the flat
  //    1 s constant this line used to carry, so the allowance can never be SMALLER than it was.
  if (soft && !state.blocked && moved > simMoved) {
    const driveS = Math.min(dtWall, Math.max(Math.min(dtWall, 1), num(state.driveT, 0)));
    const openS = state.claimedMove ? clamp(dtWall - driveS, 0, TUNE.OPEN_MAX) : 0;
    //    THE GEAR TERM WAS WRITTEN IN MULTIPLIER SPACE AND THAT UNDER-COUNTS EVERY MOUNT.
    //    `(capM - mult) * base` is exactly `ceilSpeed - modelSpeed` for FOOT (18*(3.271-mult) ==
    //    58.88 - 18*mult) and is NOT for a mount: `base` was WALK 9, so the term ignored the dash
    //    multiplier entirely. maxSpeed("mount") is WALK x MAX_MULT_MOUNT x MOUNT_DASH_WOLF = 95.76
    //    (the Direwolf's "dashspd" perk, Econ.gd:269) while simSpeed can only ever produce
    //    WALK x mult x MOUNT_DASH = 80.23 — and the server cannot see which mount you ride, nor that
    //    its real dash budget is 6.0 s against the 1 s newState seeds. So an honest Direwolf riding
    //    at the ceiling the HARD gate declares legal was refused by the SOFT gate on every report:
    //    12/12 refusals with the model 138 u behind in 3.4 s (adv_diag D1), and through the route
    //    57.66% travel efficiency with 14 of 15 replies carrying corr:1 (adv_entry E15). It had
    //    never shown up because the honest mount test rode the position-relay shape, where `soft`
    //    is false and rule 4 never runs at all.
    //    SO SAY IT IN SPEED, NOT IN MULTIPLIERS: the unknown is the gap between the CEILING and the
    //    model's OWN top speed, which is simSpeed's job to know. For foot it is algebraically the
    //    identical number — RUN*(capM - mult) == RUN*capM - RUN*mult == ceilSpeed - modelTop —
    //    asserted numerically over a full mult sweep at 7.1e-15 u/s worst delta (adv_fix_sim F0), so
    //    nothing changes for the overwhelming majority of players. For a mount it finally counts the
    //    dash, and it self-corrects when the model's dash budget runs out (simSpeed then returns the
    //    un-dashed speed, so the allowance widens by exactly what the model lost). It reads nothing
    //    the client controls that the old term did not, so it opens no new farming surface: the
    //    alternating-direction input farm still buys 40 u (adv_attack A7, same on all three trees).
    const modelTop = simSpeed(state, { sprint: true }, state.wet);
    const unknown = Math.max(0, ceilSpeed - modelTop) * driveS + ceilSpeed * openS;
    if (simDist > TUNE.POS_TOL + unknown)
      return refuse("ahead-of-sim", { allow: r3(TUNE.POS_TOL + unknown), drive: r3(driveS), open: r3(openS) });
  }
  // 5. ACCEPTED. Resync so the model's error cannot accumulate, and learn how fast this player is.
  const g = groundAt(cx, cz);
  let lifted = false, y = cy;
  if (y < g - TUNE.FLOOR_EPS) { y = g; lifted = true; }
  learnMult(state, moved, dtWall);
  state.reachS = Math.max(0, state.reachS - moved / Math.max(1e-6, ceilSpeed));   // the bank is spent
  state.stuckSince = 0;
  adopt(state, cx, y, cz, nowMs);
  state.blocked = false;                 // the model is back in step with the client — fresh slate
  return { ...out, action: lifted ? "lift" : "accept", y: r3(y) };
}

// VERTICAL IS NOT AUTHORITATIVE, AND THAT IS DELIBERATE. The server's world is a heightfield; the
// client's world also contains road decks, bridge planks, shop floors and rooftops, all real
// collision that the heightfield cannot see. Disputing y would fight every player standing on any of
// them. So the server enforces only the FLOOR (you may not be under the island) and otherwise takes
// the client's word for height — which costs nothing, because value in this game is settled by
// horizontal proximity (CLAIM_RADIUS 14, the mob reach, the raid gate), never by altitude.
function adopt(state, x, y, z, nowMs) {
  state.x = x; state.y = y; state.z = z;
  state.claimX = x; state.claimY = y; state.claimZ = z; state.claimMs = nowMs;
  // The open-loop ledger is per-INTERVAL, and the interval restarts here (claimMs just moved).
  state.driveT = 0; state.claimedMove = false;
  state.grounded = y <= groundAt(x, z) + 0.05;
  state.wet = y < PHYS.WATER - PHYS.WATER_ENTER;
}

// The server does not know your boots, your perk or whether you drank a serum, so it WATCHES. The
// estimate only ever rises to what was actually observed and is hard-bounded by the ceiling, so this
// can be fed hostile data all day and still never authorise more than MAX_MULT_*.
function learnMult(state, moved, dtWall) {
  if (dtWall < 0.05 || moved < 0.5) return;
  const base = state.mode === "mount" || state.mode === "fly" ? PHYS.WALK : PHYS.RUN;
  const obs = moved / dtWall / base;
  const cap = state.mode === "mount" || state.mode === "fly" ? MAX_MULT_MOUNT : MAX_MULT_FOOT;
  state.mult = clamp(Math.max(state.mult || 1, obs * 1.02), 1, cap);
}

// ============ THE EXPLICIT TELEPORT ACCEPT PATH ============
// server.js calls this when something the SERVER knows about moved a player: a rescue, a travel
// point, a duel arena. It opens a window in which the client's claim is taken as-is, and it is the
// only way a legitimate 900-unit jump is not a correction.
export function grantTeleport(state, x, y, z, nowMs = Date.now(), reason = "server") {
  adopt(state, num(x, state.x), num(y, state.y), num(z, state.z), nowMs);
  state.vx = 0; state.vy = 0; state.vz = 0;
  state.acceptUntil = nowMs + TUNE.TELEPORT_HOLD_MS;
  state.stuckSince = 0;
  state.teleReason = reason;
  return state;
}

// A mode flip (stepping onto or off a boat) legitimately moves the body a short distance in one
// frame — Player.gd:_board seats you on the deck, _disembark lands you 8 units ahead.
export function grantModeSwitch(state, nowMs = Date.now()) {
  state.acceptUntil = Math.max(state.acceptUntil, nowMs + 400);
  return state;
}

// What rides the snapshot. Rounded exactly as /world/move rounds its row (2dp position, 3dp dir) so
// a simulated row and a relayed row are indistinguishable on the wire.
export function snapshotOf(state) {
  return {
    x: Math.round(state.x * 100) / 100,
    y: Math.round(state.y * 100) / 100,
    z: Math.round(state.z * 100) / 100,
    dir: Math.round(state.dir * 1000) / 1000,
    ack: state.lastInputSeq | 0,
  };
}

function r3(v) { return Math.round(v * 1000) / 1000; }

export default { PHYS, TUNE, MODES, newState, segmentPenetration, sanitizeInput, step, advance, tickPlayer, reconcile, grantTeleport, grantModeSwitch, grantDt, snapshotOf, maxSpeed, groundAt, liftToFloor, teleportDestination, MAX_MULT_FOOT, MAX_MULT_MOUNT };
