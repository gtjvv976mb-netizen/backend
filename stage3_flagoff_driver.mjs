// stage3_flagoff_driver.mjs — a FIXED, deterministic request sequence against one already-booted
// local server. Used by stage3_actions_sim.mjs to prove CHIK_ACTIONS=0 is byte-identical to the
// pre-change server: the same transcript is taken from the baseline copy and from the patched
// server with the flag off, normalised ONLY on wall-clock fields (ts/until/retryInMs/back/t/ends/
// mobs/feed — all of them times or time-derived snapshots), then compared byte-for-byte.
// Prints one JSON array of "NAME STATUS NORMALISED-BODY" lines on stdout.
const port = process.argv[2];
const mob0x = Number(process.argv[3]), mob0z = Number(process.argv[4]);
const base = `http://127.0.0.1:${port}`;
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
// wall-clock-valued keys only; everything else must match to the byte
// ("a" is a peer row's sample AGE in ms — request jitter, server.js worldSnapshot)
const VOLATILE = new Set(["ts", "until", "retryInMs", "back", "t", "ends", "mobs", "feed", "a"]);
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = VOLATILE.has(k) ? "~" : scrub(val); return o; }
  return v;
}
function norm(t) { try { return JSON.stringify(scrub(JSON.parse(t))); } catch { return t; } }
async function step(name, path, body) { const r = await post(path, body); out.push(`${name} ${r.status} ${norm(r.text)}`); }

const W1 = "godot-aaaa0001", W2 = "godot-aaaa0002", W3 = "godot-aaaa0003";
await step("s1.move", "/world/move", { wallet: W1, x: 121, z: -259, dir: 0 });
await step("s2.claim-ok", "/world/node/claim", { wallet: W1, id: "stone:120:-260", cd: 60 });
await step("s3.claim-toofast", "/world/node/claim", { wallet: W1, id: "stone:120:-260", cd: 60 });
await sleep(1900);
await step("s4.claim-replay", "/world/node/claim", { wallet: W1, id: "stone:120:-260", cd: 60 });
await step("s5.claim-outofreach", "/world/node/claim", { wallet: W1, id: "stone:400:100", cd: 60 });
await sleep(1900);
await step("s6.claim-with-tool-field", "/world/node/claim", { wallet: W1, id: "stone:122:-258", cd: 60, tool: "rod" });
await step("s7a.teleport", "/world/move", { wallet: W1, x: 621, z: 241, dir: 0 });
await step("s7b.claim-warped", "/world/node/claim", { wallet: W1, id: "stone:620:240", cd: 60 });
await step("s8a.move", "/world/move", { wallet: W2, x: 121, z: -259, dir: 0 });
await step("s8b.fish", "/world/fish/report", { wallet: W2, tier: 1, rod: 0 });
await step("s9a.teleport", "/world/move", { wallet: W2, x: 621, z: 241, dir: 0 });
await sleep(900);
await step("s9b.fish-after-teleport", "/world/fish/report", { wallet: W2, tier: 1, rod: 0 });
await step("s10a.move", "/world/move", { wallet: W3, x: mob0x + 1, z: mob0z + 1, dir: 0 });
await step("s10b.mob-dmg", "/world/mob/hit", { wallet: W3, idx: 0, dmg: 5 });
await sleep(450);
await step("s10c.mob-finish", "/world/mob/hit", { wallet: W3, idx: 0, finish: true });
await sleep(450);
await step("s10d.mob-finish-replay", "/world/mob/hit", { wallet: W3, idx: 0, finish: true });
await step("s11a.claim-badid", "/world/node/claim", { wallet: W1, id: ":::" });
await step("s11b.claim-badkind", "/world/node/claim", { wallet: W1, id: "banana:100:-200" });
await step("s11c.fish-nowallet", "/world/fish/report", {});
await step("s11d.mob-nullidx", "/world/mob/hit", { wallet: W3, idx: null });
console.log(JSON.stringify(out));
