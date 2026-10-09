import type { DatabaseSync } from "node:sqlite";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import { logger } from "./lib/logger.ts";

export interface DueMandate {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
}

/** The RPC calls the keeper makes. Narrow so tests can supply a fake. */
export type KeeperRpc = Pick<
  rpc.Server,
  "getAccount" | "prepareTransaction" | "sendTransaction" | "getTransaction"
>;

/** First retry delay after a failed charge; doubles per failure. */
const BACKOFF_BASE_S = 60;
/** Longest a failing mandate waits between attempts. */
const BACKOFF_MAX_S = 6 * 60 * 60;
/** Most charges submitted in one pass. */
const BATCH = 25;

export interface SettleResult {
  mandateId: number;
  status: "settled" | "failed";
  txHash?: string;
  error?: string;
}

/**
 * Settles mandates that have fallen due.
 *
 * The keeper holds no user funds and has no privileged role on-chain: `charge`
 * is permissionless, so this process is a convenience, not a trust dependency.
 * If it stops, merchants or subscribers can settle their own mandates and
 * nothing is lost beyond timeliness.
 */
export class Keeper {
  private readonly keypair: Keypair;
  private readonly db: DatabaseSync;
  private readonly server: KeeperRpc;
  private readonly config: Config;
  /**
   * Mandates whose last charge failed, with when to try again. Without this,
   * the oldest due mandates are retried first on every pass, so a batch's
   * worth of underfunded vaults would block every other mandate forever.
   */
  private readonly backoff = new Map<number, { failures: number; retryAt: number }>();

  constructor(db: DatabaseSync, server: KeeperRpc, config: Config) {
    this.db = db;
    this.server = server;
    this.config = config;
    if (!config.KEEPER_SECRET) {
      throw new Error("Keeper requires KEEPER_SECRET");
    }
    this.keypair = Keypair.fromSecret(config.KEEPER_SECRET);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Mandates the indexer believes are chargeable right now, oldest first,
   * skipping any that are backing off after a failed charge.
   */
  findDue(now: number = Math.floor(Date.now() / 1000), limit = BATCH): DueMandate[] {
    const due: DueMandate[] = [];
    // Read past the backing-off mandates so they cannot fill the batch.
    for (const m of this.queryDue(now, limit + this.backoff.size)) {
      const wait = this.backoff.get(m.id);
      if (wait && wait.retryAt > now) continue;
      due.push(m);
      if (due.length === limit) break;
    }
    return due;
  }

  private queryDue(now: number, limit: number): DueMandate[] {
    return this.db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge
           FROM mandates
          WHERE status = 'Active'
            AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)
          ORDER BY next_charge ASC
          LIMIT ?`,
      )
      .all(now, limit) as unknown as DueMandate[];
  }

  async tick(now: number = Math.floor(Date.now() / 1000)): Promise<SettleResult[]> {
    const due = this.findDue(now);
    const results: SettleResult[] = [];
    for (const mandate of due) {
      const result = await this.settle(mandate.id);
      this.record(result, now);
      results.push(result);
    }
    return results;
  }

  /** Seconds until `mandateId` is next attempted; 0 when not backing off. */
  retryIn(mandateId: number, now: number = Math.floor(Date.now() / 1000)): number {
    const wait = this.backoff.get(mandateId);
    return wait ? Math.max(0, wait.retryAt - now) : 0;
  }

  private record(result: SettleResult, now: number): void {
    if (result.status === "settled") {
      this.backoff.delete(result.mandateId);
      return;
    }
    const failures = (this.backoff.get(result.mandateId)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_S * 2 ** (failures - 1), BACKOFF_MAX_S);
    this.backoff.set(result.mandateId, { failures, retryAt: now + delay });
  }

  /**
   * Submit one `charge`. Simulation failures are expected and benign — an
   * underfunded vault or a mandate cancelled since the last index pass both
   * surface here — so they are logged and skipped, never retried in a tight
   * loop.
   */
  async settle(mandateId: number): Promise<SettleResult> {
    try {
      const account = await this.server.getAccount(this.publicKey);
      const contract = new Contract(this.config.SUBSCRIPTION_ID);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call("charge", nativeToScVal(mandateId, { type: "u64" })),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(this.keypair);

      const sent = await this.server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        return {
          mandateId,
          status: "failed",
          error: JSON.stringify(sent.errorResult ?? sent.status),
        };
      }

      const confirmed = await this.poll(sent.hash);
      if (confirmed.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        logger.info({ mandateId, txHash: sent.hash }, "mandate settled");
        return { mandateId, status: "settled", txHash: sent.hash };
      }
      return { mandateId, status: "failed", txHash: sent.hash, error: confirmed.status };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ mandateId, error }, "charge skipped");
      return { mandateId, status: "failed", error };
    }
  }

  private async poll(
    hash: string,
    attempts = 10,
    delayMs = 1_000,
  ): Promise<rpc.Api.GetTransactionResponse> {
    let latest = await this.server.getTransaction(hash);
    for (let i = 0; i < attempts; i += 1) {
      if (latest.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return latest;
      await new Promise((r) => setTimeout(r, delayMs));
      latest = await this.server.getTransaction(hash);
    }
    return latest;
  }
}
