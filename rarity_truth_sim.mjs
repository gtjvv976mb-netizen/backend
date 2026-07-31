// rarity_truth_sim — IS ADVERTISED SCARCITY ACTUALLY ENFORCED? Read-only diagnosis: boots the real
// server.js in-process (throwaway keys, memory store, dummy RPC, local port) and hammers each mint
// path far past its advertised supply, then reports, per asset class:
//     advertised supply -> how many the server actually issued -> enforced? (YES/NO)
// Changes NOTHING. Never touches the live backend or any chain.
import { createRequire } from "module";
const require = createRequire("/Users/michaelkennethbrillantes/Downloads/chiki-backend/package.json");
const nacl = (m => m.default || m)(require("tweetnacl"));
const bs58 = (m => m.default || m)(require("bs58"));

const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.NETWORK = "devnet";
process.env.PORT = "39281";
delete process.env.DATABASE_URL;

const srv = await import("/Users/michaelkennethbrillantes/Downloads/chiki-backend/server.js");
await new Promise(r => setTimeout(r, 1400));

// the ADVERTISED promises, read from the client's own tables (Econ.gd)
const ADVERTISED_AVATAR = { classic: 500, Knight: 200, Mystic: 100, Navigator: 300, Star: 200,
                            chemist: 50, electro: 300, fire: 300, night: 100, sailor: 200 };
const ADVERTISED_MOUNT  = { chicken: 15, boar: 20, gator: 15, horse: 10, wolf: 10, griffin: 5 };

const N = 700;   // past every raised cap too                       // far past every advertised supply
const mkWallet = () => bs58.encode(nacl.sign.keyPair().publicKey);

function tally(rows, kind) {
  const c = Object.create(null);
  for (const r of rows) if (r && r.type === kind) c[r.sp] = (c[r.sp] || 0) + 1;
  return c;
}

// ---- issue via the SAME server function every real mint path uses ----
const issued = [];
if (typeof srv._mintAssetForTest !== "function") {
  console.log("RARITY_TRUTH_DONE  (no _mintAssetForTest seam — cannot measure)"); process.exit(1);
}

// AVATARS: mirror the scroll-trade path (server.js ~5369) — random pick from the full id pool
const AVATAR_IDS = Object.keys(ADVERTISED_AVATAR);
for (let i = 0; i < N; i++) {
  const w = mkWallet();
  const sp = AVATAR_IDS[i % AVATAR_IDS.length];          // deterministic sweep, not random
  try { issued.push(srv._mintAssetForTest("avatar", w, { sp, kind: "avatar" }, "scroll")); } catch (e) {}
}
// MOUNTS: mirror the mount-egg hatch path (server.js ~5056)
const MOUNT_IDS = Object.keys(ADVERTISED_MOUNT);
for (let i = 0; i < N; i++) {
  const w = mkWallet();
  const sp = MOUNT_IDS[i % MOUNT_IDS.length];
  try { issued.push(srv._mintAssetForTest("mount", w, { sp, kind: "mount" }, "hatched")); } catch (e) {}
}
// MEMES: the class that IS capped — the control group
const MEME_IDS = ["doge", "pepe", "chillguy", "moodeng", "alon", "popcat"];
for (let i = 0; i < N; i++) {
  const w = mkWallet();
  const sp = MEME_IDS[i % MEME_IDS.length];
  try { issued.push(srv._mintAssetForTest("chikimon", w, { sp, kind: "meme", lvl: 1 }, "hatched")); } catch (e) {}
}

const av = tally(issued, "avatar"), mo = tally(issued, "mount"), me = tally(issued, "chikimon");

let breaches = 0;
function report(label, counts, advertised) {
  console.log(`\n=== ${label} ===`);
  console.log("  species        advertised   issued   enforced?");
  for (const k of Object.keys(advertised)) {
    const got = counts[k] || 0, cap = advertised[k];
    const ok = got <= cap;
    if (!ok) breaches++;
    console.log("  %s %s %s   %s",
      k.padEnd(14), String(cap).padStart(10), String(got).padStart(8),
      ok ? "  YES" : `  NO  (+${got - cap} over)`);
  }
}
report("AVATARS (advertised in Econ.AVATAR_SUPPLY)", av, ADVERTISED_AVATAR);
report("MOUNTS (advertised in Econ mount_supply)", mo, ADVERTISED_MOUNT);

console.log("\n=== MEME CHIKIMON (the control: caps exist server-side) ===");
console.log("  species        issued (server caps these at 5-25)");
for (const k of MEME_IDS) console.log("  %s %s", k.padEnd(14), String(me[k] || 0).padStart(8));
const memeMax = Math.max(...MEME_IDS.map(k => me[k] || 0));
console.log("  worst meme count: %d  (if this is small, meme caps ARE enforced)", memeMax);

console.log("\n---------------------------------------------------------------");
console.log("classes whose advertised scarcity is NOT enforced: %d species over cap", breaches);
// the public rarity board must reflect the same truth, and rarity must RISE as supply is claimed
const board = await (await fetch("http://127.0.0.1:39281/world/rarity")).json();
const g = board.mount.griffin, ch = board.avatar.chemist;
console.log("\n=== /world/rarity (public, read-only) ===");
console.log("  griffin  cap %d issued %d remaining %d -> %s", g.cap, g.issued, g.remaining, g.rarity);
console.log("  chemist  cap %d issued %d remaining %d -> %s", ch.cap, ch.issued, ch.remaining, ch.rarity);
const exhausted = g.remaining === 0 && g.rarity === "Extinct";
console.log("  a fully-claimed species reads Extinct:", exhausted ? "YES" : "NO");
if (!exhausted) breaches++;
console.log("RARITY_TRUTH_DONE breaches=%d memeMax=%d", breaches, memeMax);
process.exit(0);
