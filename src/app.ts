import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { buildRoutes } from "./routes/index.ts";
import { logger } from "./lib/logger.ts";

export function createApp(db: DatabaseSync, config: Config): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors({ origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",") }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      network: config.STELLAR_NETWORK,
      contracts: {
        planRegistry: config.PLAN_REGISTRY_ID,
        vault: config.VAULT_ID,
        subscription: config.SUBSCRIPTION_ID,
      },
    });
  });

  app.use("/api", buildRoutes(db));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled request error");
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
