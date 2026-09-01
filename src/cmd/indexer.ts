/** Run a single indexing pass and exit. Useful for cron and for backfills. */
import { loadConfig } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Indexer } from "../indexer.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const indexer = new Indexer(db, makeRpc(config), config);

indexer
  .tick()
  .then((n) => {
    logger.info({ events: n }, "backfill complete");
    db.close();
  })
  .catch((err) => {
    logger.error({ err }, "backfill failed");
    process.exitCode = 1;
  });
