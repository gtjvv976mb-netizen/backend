// The attacker, in its OWN process so its receive cost never lands on the server's event loop.
//   mode=ws    N sockets, each authenticated with a FABRICATED net_id, each re-sending ONE move
//              every 10s — just enough to stay inside WORLD_TTL_MS (12s). Frames counted and
//              discarded WITHOUT parsing: the cheapest possible attacker.
//   mode=rows  THE CONTROL. The identical N presence rows created over HTTP at the identical
//              1 POST / 10 s, and no socket at all. Whatever this costs the honest poller is
//              presence-map growth, which predates the socket; only the DIFFERENCE is the socket's.
//   mode=http  the same attacker paying HTTP prices: one POST buys exactly one snapshot.
// argv[5] = the attacker's inbound cadence in ms. 10000 is the naive attacker (one message per
// socket per 10 s, the cheapest thing that stays inside WORLD_TTL_MS). 3500 is the ADAPTED attacker
// after WS_MOVE_IDLE_MS lands — the fastest they must talk to hold a 100% duty cycle on the stream.
const N = Number(process.argv[2] || 200);
const PORT = Number(process.argv[3] || 41901);
const MODE = String(process.argv[4] || "ws");
const CADENCE = Number(process.argv[5] || 10000);
const URL = `ws://127.0.0.1:${PORT}/ws/world`;
let bytes = 0, frames = 0;
const id = (i) => "godot-flood" + String(i).padStart(6, "0");
const at = (i) => [1200 + (i % 8), 1200 + (((i / 8) | 0) % 8)];
const mv = (w, x, z) => JSON.stringify({ wallet: w, x, y: 0, z, dir: 0, handle: "F", leg: 1, el: "Fire", br: 1, dl: 1 });
const post = async (i) => {
  const [x, z] = at(i);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/world/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: mv(id(i), x, z) });
        const t = await r.text(); frames++; bytes += t.length; } catch {}
};

if (MODE === "ws") {
  const WS = (await import("ws")).default;
  const socks = [];
  for (let i = 0; i < N; i++) {
    const ws = new WS(URL);
    ws.on("error", () => {});
    ws.on("message", (d) => { frames++; bytes += d.length; });
    ws.on("open", () => { const [x, z] = at(i); ws.send(mv(id(i), x, z)); });
    socks.push({ ws, i });
  }
  setInterval(() => { for (const s of socks) if (s.ws.readyState === 1) { const [x, z] = at(s.i); s.ws.send(mv(id(s.i), x, z)); } }, CADENCE);
} else {
  const kick = () => { for (let i = 0; i < N; i++) post(i); };
  kick(); setInterval(kick, CADENCE);
}
setInterval(() => console.log(`FLOODSTAT frames=${frames} bytes=${bytes} open=${MODE === "ws" ? "n/a" : "n/a"}`), 1000);
