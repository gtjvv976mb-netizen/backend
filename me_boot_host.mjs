// me_boot_host.mjs — boot ONE server module on ONE port, in its own process, so two builds can be
// diffed side by side. argv: <moduleRelPath> <port>. Everything else comes from the parent's env.
// Throwaway keypair, dead RPC, memory store — never the live backend.
const [, , mod, port] = process.argv;
process.env.PORT = String(port);
await import(mod);
process.on("message", (m) => { if (m === "bye") process.exit(0); });
setInterval(() => {}, 1 << 30);
