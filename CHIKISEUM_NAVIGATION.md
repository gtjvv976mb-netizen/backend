# Exact full-floor Node navigation

`chikiseum-live-navigation.js` ports the approved Python v2 authority, not a
simplified arena. The local plan is pinned to SHA-256
`4f37041b6c132b542284dd22c4d1b7445ccc3c3900c3ee6a6bdc58e21eea682b`.
Missing or changed plan bytes fail closed with `ArenaChanged.code = arena_changed`.

The floor has radius 24m; the actor's upright circular footprint has radius
0.35m and height 1.7m. All six boxes and all 381 original concave polygons
(6,401 vertices) remain authoritative. A 4m grid and polygon AABBs reject
only distant candidates; neither replaces actual edge geometry. Polygon
contact is analytic; boxes, floor and rival use the original 48-prefix search.
Clipped movement retains a 0.00001m inset along its actual segment.

Exports are `ChikiseumLiveNavigation` (also default), `ArenaChanged`,
`PLAN_SHA256`, `PLAN_URL`, and `CLIP_INSET_M`.
The engine API is `actorHome(side)`, `validPosition(p)`, `onEmblem(p)`,
`lineOfSight(from,to,height=0.9)`, `binding()`, and
`sweepIntent(origin,dx,dz,distance,rivalPosition=null)`.
`sweepIntent` is an alias of `sweep` and returns `{position,travelled,reason}`.
Direction components must be finite, each within [-1,1], with length at most
1; distance is finite and within [0,128]. The engine owns normalization,
elapsed time and movement budgets. Rival exclusion uses both 0.35m radii.
`sweepBetween(from,to,rival=null)` exists for test/advisory segment queries.
`layout()` and `binding()` return independent copies, not mutable authority.
Combat calls must retain the verified 0.9m sight-line height.

Run from the repository root:

```sh
node --test server/production-pvp/chikiseum-live-navigation.test.js
```

The frozen input JSON is byte-identical to the existing Python/Godot fixture.
The suite verifies 3,323 parity assertions, a separately implemented original
48-prefix concave-edge oracle (372 assertions), and 124 accepted endpoints
after both JSON-position and Godot-geometry/vector float32 conversion.
Additional tests cover strict finite inputs, rival collisions, connected
outer routes, metadata, defensive copies, plan failure and bounded runtime.
The measured receipt is `fixtures/chikiseum-node-navigation-qa-v1.json`.
Benchmarks are local single-process measurements, not concurrent-load proof.

This module does not modify damage, cards, art, client navigation, legacy
servers, wallets or SOL. Its tests do not authorize activation or deployment.
