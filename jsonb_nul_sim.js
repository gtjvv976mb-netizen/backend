// jsonb_nul_sim.js — the Postgres JSONB NUL trap, before DATABASE_URL is ever switched on.
//
// Postgres JSONB REJECTS an escaped NUL ("unsupported Unicode escape sequence in type jsonb").
// JSON.stringify emits one happily, and the in-memory store accepts it without complaint — so a NUL
// byte in any user text (a chat line, a handle, a nickname, a market listing name) breaks the PERSIST
// path only once a real database is attached. It would look like "some state randomly stops saving in
// production", and never reproduce in dev. Every ::jsonb parameter now goes through jsonbSafe().
//
// This also pins the subtlety that broke the first attempt: sanitising the serialised TEXT corrupts a
// string that legitimately contains the literal characters backslash-u-0-0-0-0.
//
// Boots the real server in-process: throwaway keypair, memory store, dead RPC. Never touches live.
import nacl from "tweetnacl"; import bs58 from "bs58";
const _t = nacl.sign.keyPair();
process.env.RPC_URL = "http://127.0.0.1:59999"; process.env.TREASURY_SECRET = JSON.stringify(Array.from(_t.secretKey));
process.env.VERIFY_HOLDERS = "false"; process.env.NETWORK = "devnet"; process.env.PORT = "39303";
process.env.ADMIN_KEY = "test-admin-key"; delete process.env.DATABASE_URL;
const SRV = await import("./server.js"); await new Promise(r => setTimeout(r, 1200));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log("  ok:", m)) : (fail++, console.log("  FAIL:", m)); };
const sec = (s) => console.log(`\n— ${s} —`);
const NUL = String.fromCharCode(0);
const safe = SRV._jsonbSafe;
// what Postgres refuses to accept inside a jsonb literal
const hasNulEscape = (txt) => txt.includes("\\u0000");

// ---------------------------------------------------------------------------
sec("a NUL in user text never reaches the jsonb parameter");
{
  const chatty = { msgs: [{ who: "Trainer" + NUL, text: "hello" + NUL + "world" }] };
  const out = safe(chatty);
  chk(!hasNulEscape(out), `no escaped NUL survives serialisation (${JSON.stringify(out).slice(0, 60)}…)`);
  const back = JSON.parse(out);
  chk(back.msgs[0].text === "helloworld", `the text is preserved minus the NUL ("${back.msgs[0].text}")`);
  chk(back.msgs[0].who === "Trainer", `and so is the name ("${back.msgs[0].who}")`);
}

// ---------------------------------------------------------------------------
sec("it survives every shape a persisted blob actually takes");
{
  const nested = {
    listings: [{ item: "wo" + NUL + "od", seller: NUL + "Bob", qty: 5 }],
    map: { ["plain"]: "ok" },
    deep: { a: { b: { c: ["x" + NUL, { d: "y" + NUL }] } } },
    nums: [1, 2.5, -3], flag: true, nul: null,
  };
  const out = safe(nested);
  chk(!hasNulEscape(out), "a deeply nested blob emits no escaped NUL");
  const b = JSON.parse(out);
  chk(b.listings[0].item === "wood" && b.listings[0].seller === "Bob", "nested strings are cleaned");
  chk(b.deep.a.b.c[1].d === "y" && b.deep.a.b.c[0] === "x", "arrays and deep objects are cleaned");
  chk(b.nums[1] === 2.5 && b.flag === true && b.nul === null, "non-strings are untouched");
}

// ---------------------------------------------------------------------------
sec("THE SUBTLETY: a literal backslash-u-0-0-0-0 must NOT corrupt the JSON");
{
  // this is what broke the first attempt — a text-level strip ate half the escaped backslash and
  // produced JSON that would not parse on restore
  const literal = { a: "\\u0000", b: "trailing\\" };
  const out = safe(literal);
  let parsed = null, err = "";
  try { parsed = JSON.parse(out); } catch (e) { err = e.message; }
  chk(parsed !== null, `the output still parses (${err || "no error"})`);
  chk(parsed && parsed.a === "\\u0000", `and the literal text is preserved verbatim (${JSON.stringify(parsed && parsed.a)})`);
  chk(parsed && parsed.b === "trailing\\", "a trailing backslash is preserved too");
}

// ---------------------------------------------------------------------------
sec("clean data is passed through byte-identical to JSON.stringify");
{
  const clean = { wallet: "abc", n: 42, arr: [1, "two", { three: true }], s: "no nulls here" };
  chk(safe(clean) === JSON.stringify(clean), "no behaviour change for data without NULs");
  chk(safe([]) === "[]" && safe({}) === "{}", "empty containers are unchanged");
  chk(safe(null) === "null" && safe(0) === "0", "primitives are unchanged");
}

// ---------------------------------------------------------------------------
sec("the real persist path is NUL-free end to end");
{
  // drive an actual world-chat post carrying a NUL, then serialise what would be persisted
  const kp = nacl.sign.keyPair(); const w = bs58.encode(kp.publicKey);
  const B = `http://127.0.0.1:${process.env.PORT}`;
  await fetch(B + "/world/move", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w, x: 1, z: 1, dir: 0, handle: "Nul" + NUL + "Guy" }) });
  await fetch(B + "/world/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w, handle: "Nul" + NUL + "Guy", text: "hi" + NUL + "there" }) });
  const log = await (await fetch(B + "/world/chat")).json();
  const asPersisted = safe(log);
  chk(!hasNulEscape(asPersisted), "the chat log serialises with no escaped NUL — Postgres would accept it");
  chk(JSON.parse(asPersisted) !== null, "and it round-trips");
}

// ---------------------------------------------------------------------------
console.log(`\nJSONB_NUL_SIM pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
