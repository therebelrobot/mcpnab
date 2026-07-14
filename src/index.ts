// Quiet only the node:sqlite experimental notice; keep all other warnings.
const _emit = process.emitWarning.bind(process);
process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
  if (typeof w === "string" && w.includes("SQLite is an experimental")) return;
  return (_emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

import { loadContext } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? process.env.MCPNAB_CONFIG ?? "./config.json";
  const ctx = await loadContext(configPath);
  startServer(ctx);

  const shutdown = async () => {
    console.log("\n[mcpnab] shutting down");
    for (const a of ctx.adapters.values()) await a.close?.().catch(() => { });
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[mcpnab] fatal:", e);
  process.exit(1);
});
