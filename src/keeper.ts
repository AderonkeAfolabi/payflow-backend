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
  private readonly server: rpc.Server;
  private readonly config: Config;

  constructor(db: DatabaseSync, server: rpc.Server, config: Config) {
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

  /** Mandates the indexer believes are chargeable right now. */
  findDue(now: number = Math.floor(Date.now() / 1000), limit = 25): DueMandate[] {
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

  async tick(): Promise<SettleResult[]> {
    const due = this.findDue();
    const results: SettleResult[] = [];
    for (const mandate of due) {
      results.push(await this.settle(mandate.id));
    }
    return results;
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
