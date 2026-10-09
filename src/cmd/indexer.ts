/** Index until caught up with the network, then exit. For cron and backfills. */
import { loadConfig } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Indexer } from "../indexer.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const indexer = new Indexer(db, makeRpc(config), config);

indexer
  .catchUp()
  .then((n) => {
    logger.info({ events: n }, "backfill complete");
    db.close();
  })
  .catch((err) => {
    logger.error({ err }, "backfill failed");
    process.exitCode = 1;
  });
