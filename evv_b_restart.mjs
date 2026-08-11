// evv_b_restart.mjs — REAL two-process redeploy durability proof for the live events.
// Driver: spawns evv_b_restart_child.mjs twice (boot1 -> SIGTERM, boot2) against a THROWAWAY
// local scratch Postgres (EVV_PG_URL). This exercises the genuine deploy path: Render's SIGTERM
// -> flushDurableState (fish_event + live_events rows), then a cold boot -> loadCupState's
// fish_event restore + restoreLiveEvents. Never the live backend, never the live DB.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import nacl from "tweetnacl";
const PG = process.env.EVV_PG_URL || "postgresql://evv@127.0.0.1:55989/evv_scratch";
const STATE = (process.env.EVV_STATE_DIR || "/tmp") + "/evv_restart_state.json";
const env = { ...process.env, DATABASE_URL: PG, ADMIN_KEY: "evv-throwaway-" + crypto.randomBytes(12).toString("hex"),
              TREASURY_SECRET: JSON.stringify(Array.from(nacl.sign.keyPair().secretKey)) };
function run(phase) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["evv_b_restart_child.mjs", phase, STATE], { env, cwd: import.meta.dirname });
    let out = "";
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("exit", (code, sig) => res({ code, sig, out }));
  });
}
console.log("— boot 1: events started, 3 founders awarded, then the deploy SIGTERM —");
const b1 = await run("boot1");
console.log(`boot1 exit code=${b1.code} signal=${b1.sig}`);
if (!/BOOT1/.test(b1.out)) { console.log("FAIL boot1 never reached its checkpoint"); process.exit(1); }
console.log("\n— boot 2: cold process, same DB — everything must still be there —");
const b2 = await run("boot2");
console.log(`boot2 exit code=${b2.code}`);
const ok = b2.code === 0 && /ALL_OK/.test(b2.out);
console.log(`\n==== evv_b_restart: ${ok ? "PASS — a real redeploy mid-event preserves events + claims" : "FAIL"} ====`);
process.exit(ok ? 0 : 1);
