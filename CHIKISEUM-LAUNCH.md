# Chikiseum verified PvP release

Status: implemented and locally verified; production deployment and public two-player verification are still pending. Not publicly launched.

## Approved scope

- Finish authenticated, simultaneous online PvP before publishing the arena.
- Use separate server-earned PvP battle levels, starting at level 1. Never migrate or mutate main-world levels.
- Keep the established rarity bonuses and canonical creature/card catalogue.
- No SOL stake, payment, escrow, or economic reward is enabled by this release.
- Keep the reference arena, owner-follow camera, original creature sprites, official banner and compact deck.

## Production boundary

The new routes live only under `/chikiseum/live/v1`. They require the existing verified wallet token, current session ID and current session epoch on every private request. The client selects an owned asset ID and submits actions, never species, combat stats, levels, damage, outcomes or currency.

`CHIKISEUM_LIVE_ENABLED=1` enables the service. It additionally requires the existing PostgreSQL store and an exclusive advisory-lock lease. Missing storage, loss of ownership/authentication, or an invalid catalogue/arena binding does not substitute a local or AI match.

Only one server owns the live simulation. Restarts cancel unfinished fights. Completed-battle progression and the engine checkpoint are saved atomically; completion receipts prevent duplicate XP. Separate battle XP has participation and daily anti-farming limits. No main-world profile or inventory write is involved.

## Verification completed locally

- Actual backend HTTP tests: 136 passing checks, including two signed throwaway wallet sessions, registry ownership, invalid authentication, request replay, action authority and legacy endpoint regressions.
- Combat/navigation suites: 34 passing tests, including 2,412 independent card-mechanics comparisons.
- Combined `npm run test:chikiseum`: 61 passing tests, including progression, lease failures, request authority and retry behavior.
- Independent service fault review: 27 passing tests.
- Actual isolated PostgreSQL integration: 7 substantive gates (8 Node tests), covering exclusive ownership, durable XP replay, connection loss, atomic writes and bounded match checkpoint storage.
- Actual game client against the full authenticated local HTTP server: 47 headless checks and 50 native-render checks, with genuine server-confirmed attacks and shields.
- Final desktop package: 3,168 passing native checks, including all 402 cleaned card images, 41 original body atlases and server-confirmed two-client combat.
- Final mobile archive: 23,686 passing native checks, including all 5,459 decoded resources matching its controlled source pack, all card/body checks and server-confirmed two-client combat.
- Mobile runtime is 166.4 MiB, below the unchanged 170 MiB limit. Original card/body payloads remain exact. The three original music tracks are separate, optional, same-origin downloads; sound effects remain embedded.
- Optional music: 63 source/lifecycle checks and 9 actual-browser transport checks. Redirects and foreign URLs are rejected, cookies omitted, pending downloads cancelled when disabled. Original MP3 files are not transcoded.
- Final mobile ZIP archive booted in the in-app browser through the real wallet/guest screen and offline action lab. A successful same-origin soundtrack request was observed. This was a forced-phone code-path check, not physical-phone performance testing; the requested viewport override did not change the measured 1280×720 viewport.
- Final desktop PCK also booted through the real wallet/guest screen and offline action lab in the browser. Neither browser smoke check used a production wallet or placed a bet.
- Final release validator passed both filesystem checks and exact local HTTP payload checks for the current 402-card/804-atlas release, desktop/mobile/engine chunk reconstruction, source provenance and original music sidecars. Receipt SHA-256: `ed3111d7490e47e7bb3aa3cfd1e81160111320db26fa933f6a476340c21e0277`.

Combat checks use automated local fixture players with real signature verification and registry callbacks, but a synthetic persistence lease. Actual PostgreSQL was tested separately. These are not proof of public player login, production hosting, physical-phone performance, two-human internet play, or real-money settlement.

## Local release candidate

Game build: `d4afd296f8`; mobile archive version: `8fe1ca2245`.

- HD PCK SHA-256: `cc44d7059c0b17fb3aabe45cbd4c9730f808f9a6cb54fde8b9dbab0e055bda4c`
- Mobile PCZ SHA-256: `03b819289d6e3ffa7dd60fd1a98eb37a284f93801ff3cc3d81619e02a7534a7a`
- Approved individual ability sidecar: `02400b320307`, 402 card pairs / 804 atlases.
- Retained local evidence: `wicked-reborn/art/chikiseum-live-verification-2026-09-13/`.

The desktop stays on its existing PCK loader. Mobile mounts the ZIP archive under the explicit `index.pcz` filename; the raw mobile PCK is a verification intermediate and must not be published. Both downloads must succeed before engine initialization. Six browser-boot unit tests cover the two paths and failed downloads.

## Remaining release gates

1. Sign in to the existing Render dashboard, deploy the exact reviewed backend commit, and verify its private/public routing, PostgreSQL lease and readiness. Dashboard access is currently blocked by sign-in.
2. Verify two real signed-in clients over the deployed service before publishing the playable frontend. Do not grant fake production ownership or substitute local fixtures.
3. Publish only scoped `realm/` release files to the actual frontend repository; preserve unrelated site/backend edits. Include the immutable `realm/audio/4aab5ba194637b2ee672/` sidecar, official runtime workers and active ability atlas folder. The old 99-card publication helper is not suitable for this 402-card release.
4. Verify served build hashes and the Pages result. Test on a physical phone before describing mobile performance as verified.

Do not call this live, complete, publicly tested, or financially enabled while any applicable gate remains open. In particular, a successful health response or native screenshot is not an internet PvP playtest.
