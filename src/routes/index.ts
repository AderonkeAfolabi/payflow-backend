import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { readCursor } from "../lib/db.ts";

const MAX_LIMIT = 200;

/** Both recurring-revenue figures normalise each mandate's period to these. */
const SECONDS_PER_MONTH = 2_592_000; // a 30-day month
const SECONDS_PER_YEAR = 31_536_000; // a 365-day year

function limitOf(raw: unknown, fallback = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

export function buildRoutes(db: DatabaseSync): Router {
  const r = Router();

  r.get("/plans", (req, res) => {
    const { merchant } = req.query;
    const rows = merchant
      ? db
          .prepare("SELECT * FROM plans WHERE merchant = ? ORDER BY id DESC LIMIT ?")
          .all(String(merchant), limitOf(req.query.limit))
      : db
          .prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?")
          .all(limitOf(req.query.limit));
    res.json({ plans: rows });
  });

  r.get("/plans/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    res.json(row);
  });

  r.get("/mandates", (req, res) => {
    const { subscriber, merchant, status } = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    if (subscriber) {
      where.push("subscriber = ?");
      args.push(String(subscriber));
    }
    if (merchant) {
      where.push("merchant = ?");
      args.push(String(merchant));
    }
    if (status) {
      where.push("status = ?");
      args.push(String(status));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limitOf(req.query.limit));
    const rows = db
      .prepare(`SELECT * FROM mandates ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[]));
    res.json({ mandates: rows });
  });

  r.get("/mandates/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM mandates WHERE id = ?").get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: "mandate_not_found" });
      return;
    }
    res.json(row);
  });

  r.get("/mandates/:id/charges", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM charges WHERE mandate_id = ? ORDER BY ledger DESC LIMIT ?")
      .all(Number(req.params.id), limitOf(req.query.limit));
    res.json({ charges: rows });
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge, amount
           FROM mandates
          WHERE status = 'Active' AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)
          ORDER BY next_charge ASC LIMIT ?`,
      )
      .all(now, limitOf(req.query.limit));
    res.json({ now, due: rows });
  });

  r.get("/merchants/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      )
      .get(address) as { n: number };
    const collected = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      )
      .get(address) as { total: number; n: number };
    // Recurring revenue, normalised from each mandate's own period: MRR over a
    // 30-day month and ARR over a 365-day year. Integer division truncates,
    // which is fine at base-unit (stroop) scale.
    const recurring = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_MONTH} / period), 0) AS mrr,
                COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_YEAR} / period), 0) AS arr
           FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      )
      .get(address) as { mrr: number; arr: number };

    res.json({
      merchant: address,
      activeMandates: active.n,
      totalCollected: String(collected.total),
      chargeCount: collected.n,
      mrr: String(recurring.mrr),
      arr: String(recurring.arr),
    });
  });

  r.get("/subscribers/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const mandates = db
      .prepare("SELECT * FROM mandates WHERE subscriber = ? ORDER BY id DESC")
      .all(address);
    const paid = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      )
      .get(address) as { total: number };
    res.json({ subscriber: address, mandates, totalPaid: String(paid.total) });
  });

  r.get("/stats", (_req, res) => {
    const one = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    res.json({
      plans: one("SELECT COUNT(*) AS n FROM plans"),
      mandates: one("SELECT COUNT(*) AS n FROM mandates"),
      activeMandates: one("SELECT COUNT(*) AS n FROM mandates WHERE status = 'Active'"),
      charges: one("SELECT COUNT(*) AS n FROM charges"),
      lastIndexedLedger: readCursor(db, 0),
    });
  });

  return r;
}
