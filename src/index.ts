import { loadConfig } from "./config.ts";
import { openDatabase } from "./lib/db.ts";
import { makeRpc } from "./lib/stellar.ts";
import { createApp } from "./app.ts";
import { Indexer } from "./indexer.ts";
import { Keeper } from "./keeper.ts";
import { logger } from "./lib/logger.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const server = makeRpc(config);

const app = createApp(db, config);
const http = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, network: config.STELLAR_NETWORK }, "api listening");
});

const indexer = new Indexer(db, server, config);
const indexerTimer = setInterval(() => {
  indexer
    .tick()
    .then((n) => {
      if (n > 0) logger.info({ events: n }, "indexed");
    })
    .catch((err) => logger.error({ err }, "indexer tick failed"));
}, config.INDEXER_INTERVAL_MS);

let keeperTimer: NodeJS.Timeout | undefined;
if (config.KEEPER_ENABLED) {
  const keeper = new Keeper(db, server, config);
  logger.info({ keeper: keeper.publicKey }, "keeper enabled");
  keeperTimer = setInterval(() => {
    keeper
      .tick()
      .then((results) => {
        const settled = results.filter((r) => r.status === "settled").length;
        if (results.length > 0) logger.info({ settled, attempted: results.length }, "keeper pass");
      })
      .catch((err) => logger.error({ err }, "keeper tick failed"));
  }, config.KEEPER_INTERVAL_MS);
} else {
  logger.info("keeper disabled (KEEPER_ENABLED=false)");
}

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  clearInterval(indexerTimer);
  if (keeperTimer) clearInterval(keeperTimer);
  http.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
