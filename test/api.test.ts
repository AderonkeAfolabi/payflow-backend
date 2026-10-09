import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

const config = {
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

let server: Server;
const status = { cursor: 1_000, latest: 1_010, lastRunAt: Date.now(), lastError: null };
let base: string;
const db = openDatabase(":memory:");

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  const ev = (name: string, topics: unknown[], data: Record<string, unknown>, tx = "t"): DecodedEvent => ({
    name, contractId: "C", ledger: 1, txHash: tx, topics, data,
  });

  ix.apply(ev("plan_created", [MERCHANT, 1n], { token: "C", amount: 10_000_000n, period: 2_592_000n }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
  }));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
  }, "tx1"));

  const app = createApp(db, config, status);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() as Record<string, never> };
};

describe("http api", () => {
  test("health reports contract wiring", async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  test("health reports indexer lag", async () => {
    const { body } = await get("/health");
    const ix = body.indexer as unknown as { cursor: number; lag: number };
    assert.equal(ix.cursor, 1_000);
    assert.equal(ix.lag, 10);
  });

  test("health says catching_up while far behind, but stays 200", async () => {
    status.latest = 50_000;
    try {
      const res = await get("/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "catching_up");
    } finally {
      status.latest = 1_010;
    }
  });

  test("lists plans and filters by merchant", async () => {
    const all = await get("/api/plans");
    assert.equal((all.body.plans as unknown[]).length, 1);

    const mine = await get(`/api/plans?merchant=${MERCHANT}`);
    assert.equal((mine.body.plans as unknown[]).length, 1);

    const none = await get("/api/plans?merchant=GNOBODY");
    assert.equal((none.body.plans as unknown[]).length, 0);
  });

  test("unknown plan is 404", async () => {
    const { status } = await get("/api/plans/999");
    assert.equal(status, 404);
  });

  test("mandate charge history", async () => {
    const { body } = await get("/api/mandates/1/charges");
    assert.equal((body.charges as unknown[]).length, 1);
  });

  test("merchant summary computes MRR and revenue", async () => {
    const { body } = await get(`/api/merchants/${MERCHANT}/summary`);
    assert.equal(body.activeMandates, 1);
    assert.equal(body.totalCollected, "9900000");
    // 10_000_000 per 30-day period normalises to itself
    assert.equal(body.mrr, "10000000");
  });

  test("subscriber summary includes fee in total paid", async () => {
    const { body } = await get(`/api/subscribers/${SUBSCRIBER}/summary`);
    assert.equal(body.totalPaid, "10000000");
  });

  test("due list excludes future charges", async () => {
    const { body } = await get("/api/due");
    assert.equal((body.due as unknown[]).length, 0);
  });

  test("stats reflect indexed state", async () => {
    const { body } = await get("/api/stats");
    assert.equal(body.plans, 1);
    assert.equal(body.mandates, 1);
    assert.equal(body.charges, 1);
  });

  test("unknown route is 404 json", async () => {
    const { status, body } = await get("/nope");
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });
});
