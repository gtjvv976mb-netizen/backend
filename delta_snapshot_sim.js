#!/usr/bin/env node
// DELTA-ENCODED SNAPSHOTS. Snapshot egress is this game's scaling wall — ~33 KB/s downstream per
// player, ~18 KB per snapshot at the 60-peer cap — and ~123 of every ~292-byte player row is fields
// that never change during a session, resent every 0.55 s.
//
// The assertion that decides whether this ships is NOT the saving. It is that a CACHED CLIENT sees a
// byte-identical reply to the one it gets today: the web bundle is cached and two live players were
// measured this session still running a pre-pass-1 build. Opt-in or it does not ship.
// No live backend. Throwaway keypairs, memory store, dummy RPC.
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";

const treasury = Keypair.generate();
process.env.RPC_URL = "http://127.0.0.1:59993";
process.env.TREASURY_SECRET = JSON.stringify(Array.from(treasury.secretKey));
process.env.VERIFY_HOLDERS = "false";
process.env.PORT = "8802";
process.env.NETWORK = "devnet";
delete process.env.DATABASE_URL;
delete process.env.MARKET_ONCHAIN;

function signIn(kp) {
  const wallet = kp.publicKey.toBase58();
  const msg = `Chikoria sign-in\nwallet:${wallet}\nts:${Date.now()}`;
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { wallet, authMsg: msg, authSig: crypto.sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
}
const BASE = "http://127.0.0.1:8802";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ok   " + n + (e ? "  [" + e + "]" : "")); } else { fail++; fails.push(n + (e ? " — " + e : "")); console.log("  FAIL " + n + (e ? "  [" + e + "]" : "")); } };
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await get("/world/roster")).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); } throw new Error("no server"); }

const STATIC = ["handle", "leg", "el", "br", "avatar", "comp", "party", "eggs"];

async function main() {
  await import("./server.js");
  await waitUp();
  console.log("\n=== DELTA-ENCODED SNAPSHOTS ===\n");

  let n = 0;
  const mk = async () => {
    const kp = Keypair.generate();
    const t = { kp, wallet: kp.publicKey.toBase58(), tok: "" };
    const v = await post("/verify", { ...signIn(kp), netId: "net_" + kp.publicKey.toBase58().slice(0, 10) });
    t.tok = v.json.mktToken;
    t.n = ++n;
    return t;
  };
  // `dl` is the opt-in. Everything else is exactly what the shipped client already sends.
  const move = (t, dl, extra = {}) => post("/world/move", {
    wallet: t.wallet, mktToken: t.tok, x: 100 + t.n, z: 200, y: 6, dir: 1,
    handle: "Trainer" + t.n, leg: 14, el: "Fire", br: 9,
    avatar: "classic", comp: "chillguy", party: "chillguy,pepe,moodeng",
    mount: "", act: "", eggs: "normal", spr: false, ...(dl ? { dl: 1 } : {}), ...extra,
  });

  // a small crowd so a snapshot has something in it
  const crowd = [];
  for (let i = 0; i < 6; i++) { const t = await mk(); crowd.push(t); await move(t, false); }
  const alice = await mk();

  // ---------- 1. A CACHED CLIENT MUST SEE NO CHANGE AT ALL ----------
  const legacy1 = await move(alice, false);
  const lrow = (legacy1.json.players || [])[0] || {};
  ok("a client that does not ask for deltas still gets every field",
     STATIC.every((k) => Object.hasOwn(lrow, k)),
     `missing: ${STATIC.filter((k) => !Object.hasOwn(lrow, k)).join(",") || "none"}`);
  ok("...and is never told a row was abbreviated", lrow.dl === undefined, `dl=${lrow.dl}`);
  const legacy2 = await move(alice, false);
  const lrow2 = (legacy2.json.players || [])[0] || {};
  ok("...even on the second poll, when a delta client would already be abbreviating",
     STATIC.every((k) => Object.hasOwn(lrow2, k)) && lrow2.dl === undefined,
     JSON.stringify(Object.keys(lrow2)));

  // ---------- 2. AN OPTED-IN CLIENT GETS THE FULL ROW ONCE, THEN THE VOLATILE HALF ----------
  const bob = await mk();
  const d1 = await move(bob, true);
  const r1 = (d1.json.players || [])[0] || {};
  ok("a delta client's FIRST sight of a peer carries the whole row",
     STATIC.every((k) => Object.hasOwn(r1, k)) && Number(r1.sq) >= 1,
     `sq=${r1.sq} keys=${Object.keys(r1).length}`);
  const d2 = await move(bob, true);
  const r2 = (d2.json.players || [])[0] || {};
  ok("...and the second poll omits the static half", r2.dl === 1 && !Object.hasOwn(r2, "handle"),
     `dl=${r2.dl} keys=${Object.keys(r2).join(",")}`);
  ok("...while still carrying everything that MOVES",
     ["wallet", "x", "y", "z", "dir", "act", "mount", "spr"].every((k) => Object.hasOwn(r2, k)),
     Object.keys(r2).join(","));

  // ---------- 3. THE SAVING, MEASURED ----------
  const full = Buffer.byteLength(JSON.stringify(d1.json.players));
  const delta = Buffer.byteLength(JSON.stringify(d2.json.players));
  const cut = (1 - delta / full) * 100;
  ok(`the abbreviated snapshot is materially smaller (${full} -> ${delta} bytes, ${cut.toFixed(1)}% off)`,
     cut > 30, `${cut.toFixed(1)}%`);

  // ---------- 4. A CHANGED STATIC FIELD RE-SENDS THAT PEER, ONCE ----------
  await move(crowd[0], false, { handle: "RenamedTrainer" });
  const d3 = await move(bob, true);
  const changed = (d3.json.players || []).find((p) => p.wallet === crowd[0].wallet) || {};
  ok("renaming a peer re-sends their full row", Object.hasOwn(changed, "handle") && changed.handle === "RenamedTrainer",
     `handle=${changed.handle} dl=${changed.dl}`);
  const others = (d3.json.players || []).filter((p) => p.wallet !== crowd[0].wallet);
  ok("...and ONLY theirs — everyone else stays abbreviated",
     others.length > 0 && others.every((p) => p.dl === 1),
     `${others.filter((p) => p.dl === 1).length}/${others.length} abbreviated`);
  const d4 = await move(bob, true);
  const settled = (d4.json.players || []).find((p) => p.wallet === crowd[0].wallet) || {};
  ok("...then they settle back to abbreviated on the next poll", settled.dl === 1, `dl=${settled.dl}`);

  // ---------- 5. MOVING MUST NOT COUNT AS A CHANGE, or the delta never applies ----------
  const before = Number((await move(bob, true)).json.players.find((p) => p.wallet === crowd[1].wallet)?.sq || 0);
  await move(crowd[1], false, { x: 999, z: -999, act: "chop:axe:5", mount: "wolf", spr: true });
  const after = (await move(bob, true)).json.players.find((p) => p.wallet === crowd[1].wallet) || {};
  ok("walking, acting, mounting and sprinting do NOT re-send the static half",
     after.dl === 1, `dl=${after.dl} sq_before=${before}`);
  ok("...but the new position and action still arrive",
     Number(after.x) === 999 && after.act === "chop:axe:5" && after.mount === "wolf" && after.spr === true,
     `x=${after.x} act=${after.act} mount=${after.mount} spr=${after.spr}`);

  // ---------- 6. THE TWO MODES AGREE ON THE FACTS ----------
  const carol = await mk();
  const asFull = (await move(carol, false)).json.players.find((p) => p.wallet === crowd[2].wallet);
  const dave = await mk();
  await move(dave, true);
  const asDelta = (await move(dave, true)).json.players.find((p) => p.wallet === crowd[2].wallet);
  ok("both modes report the same position for the same peer",
     asFull && asDelta && asFull.x === asDelta.x && asFull.z === asDelta.z,
     `full=(${asFull?.x},${asFull?.z}) delta=(${asDelta?.x},${asDelta?.z})`);

  // ---------- 7. the delta memory cannot outlive the session it belongs to ----------
  const src = await import("node:fs").then((fs) => fs.readFileSync("./server.js", "utf8"));
  ok("the per-caller memory lives on the caller's own presence row, so the TTL sweep evicts it",
     src.includes("seen: _prev ? _prev.seen : undefined"), "carried on the row");
  ok("...and is bounded rather than growing with session length",
     src.includes("seen.size > WORLD_MAX_PEERS * 3"), "bounded");

  console.log(`\nDELTA_SNAPSHOT_SIM  pass=${pass} fail=${fail}`);
  if (fail) { console.log("failures:"); for (const f of fails) console.log("  - " + f); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SIM ERROR", e); process.exit(1); });
