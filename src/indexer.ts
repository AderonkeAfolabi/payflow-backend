import type { DatabaseSync } from "node:sqlite";
import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import { readCursor, writeCursor } from "./lib/db.ts";
import { big, decodeEvent, num, str, type DecodedEvent } from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";

/** RPC caps a single getEvents window; stay well inside it. */
const LEDGER_WINDOW = 8_000;
const PAGE_LIMIT = 200;

export class Indexer {
  private readonly db: DatabaseSync;
  private readonly server: rpc.Server;
  private readonly config: Config;

  constructor(db: DatabaseSync, server: rpc.Server, config: Config) {
    this.db = db;
    this.server = server;
    this.config = config;
  }

  private contractIds(): string[] {
    return [
      this.config.PLAN_REGISTRY_ID,
      this.config.VAULT_ID,
      this.config.SUBSCRIPTION_ID,
    ];
  }

  /**
   * Index one batch. Returns the number of events applied.
   *
   * The cursor only advances after a batch is applied, so a crash mid-batch
   * replays that range on restart. Every apply path is idempotent to make that
   * safe.
   */
  async tick(): Promise<number> {
    const latest = await this.server.getLatestLedger();
    let start = readCursor(this.db, this.config.INDEXER_START_LEDGER);

    if (start <= 0) {
      // Soroban RPC retains a limited history window. Start from the oldest
      // ledger the node still serves rather than from genesis.
      start = Math.max(1, latest.sequence - LEDGER_WINDOW);
    }
    if (start > latest.sequence) return 0;

    const endLedger = Math.min(start + LEDGER_WINDOW, latest.sequence);
    let cursor: string | undefined;
    let applied = 0;
    let lastLedger = start;

    for (;;) {
      const page: rpc.Api.GetEventsResponse = await this.server.getEvents({
        startLedger: cursor ? undefined : start,
        cursor,
        filters: [{ type: "contract", contractIds: this.contractIds() }],
        limit: PAGE_LIMIT,
      } as Parameters<rpc.Server["getEvents"]>[0]);

      const events = page.events ?? [];
      for (const raw of events) {
        const decoded = decodeEvent(raw);
        if (!decoded) continue;
        this.apply(decoded);
        applied += 1;
        lastLedger = Math.max(lastLedger, decoded.ledger);
      }

      if (events.length < PAGE_LIMIT) break;
      cursor = page.cursor;
      if (!cursor) break;
    }

    writeCursor(this.db, Math.max(lastLedger, endLedger));
    return applied;
  }

  /** Route a decoded event to its projection. Unknown names are ignored. */
  apply(e: DecodedEvent): void {
    switch (e.name) {
      case "plan_created":
        return this.onPlanCreated(e);
      case "plan_status_changed":
        return this.onPlanStatus(e);
      case "subscribed":
        return this.onSubscribed(e);
      case "charged":
        return this.onCharged(e);
      case "cancelled":
        return this.onStatus(e, "Cancelled");
      case "mandate_completed":
        return this.onStatus(e, "Completed");
      case "pause_changed":
        return this.onPauseChanged(e);
      case "deposit":
      case "withdraw":
      case "debit":
        return this.onVaultEvent(e);
      default:
        logger.debug({ name: e.name }, "unhandled event");
    }
  }

  private onPlanCreated(e: DecodedEvent): void {
    const [merchant, planId] = e.topics;
    this.db
      .prepare(
        `INSERT INTO plans (id, merchant, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           merchant = excluded.merchant, token = excluded.token,
           amount = excluded.amount, period = excluded.period`,
      )
      .run(
        num(planId),
        str(merchant),
        str(e.data.token),
        big(e.data.amount),
        num(e.data.period),
        e.ledger,
      );
  }

  private onPlanStatus(e: DecodedEvent): void {
    const [, planId] = e.topics;
    this.db
      .prepare("UPDATE plans SET active = ? WHERE id = ?")
      .run(e.data.active ? 1 : 0, num(planId));
  }

  private onSubscribed(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    this.db
      .prepare(
        `INSERT INTO mandates
           (id, subscriber, merchant, plan_id, amount, period, next_charge,
            last_charge, charges_made, max_charges, status, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'Active', ?)
         ON CONFLICT(id) DO UPDATE SET
           subscriber  = excluded.subscriber,
           merchant    = excluded.merchant,
           max_charges = excluded.max_charges`,
      )
      .run(
        num(mandateId),
        str(subscriber),
        str(merchant),
        num(e.data.plan_id),
        big(e.data.amount),
        num(e.data.period),
        num(e.data.next_charge),
        num(e.data.max_charges),
        e.ledger,
      );
  }

  private onCharged(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    const id = num(mandateId);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO charges
           (tx_hash, mandate_id, subscriber, merchant, amount, fee,
            charges_made, next_charge, ledger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        id,
        str(subscriber),
        str(merchant),
        big(e.data.amount),
        big(e.data.fee),
        num(e.data.charges_made),
        num(e.data.next_charge),
        e.ledger,
        Date.now(),
      );

    // The Charged event carries next_charge but not last_charge. The contract
    // sets next_charge = now + period, so the settlement time is recoverable
    // from the mandate's own period.
    // Guard against out-of-order delivery: never move a mandate backwards.
    this.db
      .prepare(
        `UPDATE mandates
            SET charges_made = ?,
                next_charge  = ?,
                last_charge  = MAX(0, ? - period)
          WHERE id = ? AND charges_made < ?`,
      )
      .run(
        num(e.data.charges_made),
        num(e.data.next_charge),
        num(e.data.next_charge),
        id,
        num(e.data.charges_made),
      );
  }

  private onStatus(e: DecodedEvent, status: string): void {
    const [mandateId] = e.topics;
    this.db
      .prepare("UPDATE mandates SET status = ? WHERE id = ?")
      .run(status, num(mandateId));
  }

  private onPauseChanged(e: DecodedEvent): void {
    const [mandateId] = e.topics;
    this.db
      .prepare(
        `UPDATE mandates SET status = ?
          WHERE id = ? AND status IN ('Active','Paused')`,
      )
      .run(e.data.paused ? "Paused" : "Active", num(mandateId));
  }

  private onVaultEvent(e: DecodedEvent): void {
    const [user, token, counterparty] = e.topics;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO vault_events
           (tx_hash, kind, user, token, counterparty, amount, balance, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        e.name,
        str(user),
        str(token),
        counterparty === undefined ? null : str(counterparty),
        big(e.data.amount),
        big(e.data.balance),
        e.ledger,
      );
  }
}
