/** Run a single settlement pass and exit. */
import { loadConfig } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Keeper } from "../keeper.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const keeper = new Keeper(db, makeRpc(config), config);

keeper
  .tick()
  .then((results) => {
    logger.info({ results }, "settlement pass complete");
    db.close();
  })
  .catch((err) => {
    logger.error({ err }, "settlement pass failed");
    process.exitCode = 1;
  });
