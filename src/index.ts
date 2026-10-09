import { loadConfig } from "./config.ts";
import { openDatabase } from "./lib/db.ts";
import { makeRpc } from "./lib/stellar.ts";
import { createApp } from "./app.ts";
import { Indexer } from "./indexer.ts";
import { Keeper } from "./keeper.ts";
import { logger } from "./lib/logger.ts";
import { every, type Loop } from "./lib/loop.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const server = makeRpc(config);

const indexer = new Indexer(db, server, config);
const app = createApp(db, config, indexer.status);
const http = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, network: config.STELLAR_NETWORK }, "api listening");
});

// A pass can take longer than the interval while backfilling, so each loop
// waits for its pass to finish before scheduling the next. Overlapping passes
// would race on the cursor and, for the keeper, on the account sequence number.
const loops: Loop[] = [];

loops.push(
  every(config.INDEXER_INTERVAL_MS, async () => {
    try {
      const r = await indexer.tick();
      indexer.status.lastRunAt = Date.now();
      indexer.status.lastError = null;
      if (r.applied > 0) logger.info({ events: r.applied, cursor: r.cursor }, "indexed");
    } catch (err) {
      indexer.status.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "indexer pass failed");
    }
  }),
);

if (config.KEEPER_ENABLED) {
  const keeper = new Keeper(db, server, config);
  logger.info({ keeper: keeper.publicKey }, "keeper enabled");
  loops.push(
    every(config.KEEPER_INTERVAL_MS, async () => {
      try {
        const results = await keeper.tick();
        const settled = results.filter((r) => r.status === "settled").length;
        if (results.length > 0) logger.info({ settled, attempted: results.length }, "keeper pass");
      } catch (err) {
        logger.error({ err }, "keeper pass failed");
      }
    }),
  );
} else {
  logger.info("keeper disabled (KEEPER_ENABLED=false)");
}

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  for (const loop of loops) loop.stop();
  http.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
