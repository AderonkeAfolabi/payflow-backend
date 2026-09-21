<h1 align="center">Payflow — Backend</h1>

<p align="center">
  <strong>Event indexer, settlement keeper, and read API for the Payflow protocol.</strong>
</p>

<p align="center">
  <a href="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml/badge.svg"/>
  </a>
  <img alt="Node" src="https://img.shields.io/badge/node-22-green"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.9-blue"/>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-green"/>
</p>

> **Live demo:** https://mmm-pay.github.io/payflow-frontend/ ·
> **Docs:** https://mmm-pay.github.io/payflow-docs/

---

## What this does

Soroban contracts can answer "what is the state of mandate 7?" but they cannot
answer "show me every mandate this merchant has, sorted by revenue." That is
what this service is for. It does three jobs:

| Component | Job |
|---|---|
| **Indexer** | Polls Soroban RPC for contract events and projects them into SQLite |
| **Keeper** | Finds mandates that have fallen due and calls `charge` on-chain |
| **API** | Serves the projection to the frontend over REST |

### The keeper is not a trust dependency

`charge` is permissionless on-chain. This keeper holds no user funds and has no
privileged role — it only pays the transaction fee to trigger settlement. If it
stops running, merchants and subscribers can settle their own mandates directly.
Nothing is lost but timeliness.

### Indexing is idempotent by construction

The ledger cursor advances only after a batch is applied, so a crash mid-batch
replays that range on restart. Every write is designed for that:

- `plans` and `mandates` are upserts keyed on the on-chain id.
- `charges` is keyed on `(tx_hash, mandate_id)`, so a replayed ledger cannot
  double-count revenue.
- Mandate updates are guarded by `WHERE charges_made < ?`, so an out-of-order
  event can never move a mandate backwards.

## Quick start

```bash
npm install
cp .env.example .env      # already points at the deployed testnet contracts
npm test                  # 20 tests, no network needed
npm run dev
```

Backfill once without starting the server:

```bash
npm run indexer
```

## API

Base path `/api`. All amounts are strings in the token's smallest unit
(stroops for XLM) to avoid JavaScript float precision loss.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Service status and the contract IDs it is wired to |
| `GET` | `/api/plans?merchant=&limit=` | Published plans |
| `GET` | `/api/plans/:id` | One plan |
| `GET` | `/api/mandates?subscriber=&merchant=&status=` | Mandates |
| `GET` | `/api/mandates/:id` | One mandate |
| `GET` | `/api/mandates/:id/charges` | Settlement history |
| `GET` | `/api/due` | Mandates chargeable right now |
| `GET` | `/api/merchants/:address/summary` | Active mandates, revenue, MRR |
| `GET` | `/api/subscribers/:address/summary` | Mandates and total paid |
| `GET` | `/api/stats` | Protocol totals and last indexed ledger |

Example:

```bash
curl localhost:8080/api/merchants/GB343X.../summary
{
  "merchant": "GB343X...",
  "activeMandates": 1,
  "totalCollected": "19800000",
  "chargeCount": 2,
  "mrr": "432000000000"
}
```

`mrr` normalises every active mandate to a 30-day month. A short-period demo
plan therefore produces a very large figure; that is arithmetic, not a bug.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network id |
| `PLAN_REGISTRY_ID` | — | Deployed registry contract |
| `VAULT_ID` | — | Deployed vault contract |
| `SUBSCRIPTION_ID` | — | Deployed subscription contract |
| `KEEPER_ENABLED` | `false` | Turn on automatic settlement |
| `KEEPER_SECRET` | — | `S...` key that pays settlement fees. Required when the keeper is on |
| `KEEPER_INTERVAL_MS` | `60000` | Settlement poll interval |
| `INDEXER_INTERVAL_MS` | `10000` | Indexing poll interval |
| `INDEXER_START_LEDGER` | `0` | `0` starts from the oldest ledger RPC still serves |
| `DATABASE_PATH` | `./payflow.db` | SQLite file |
| `PORT` | `8080` | HTTP port |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |

The keeper is **off** by default. Turning it on requires funding
`KEEPER_SECRET` with XLM for transaction fees.

## Deployment

`render.yaml` is a working Render blueprint: Node 22, a 1 GB disk mounted at
`/var/data` for the SQLite file, and `/health` as the health check. Set
`CORS_ORIGIN` to your deployed frontend URL and `KEEPER_SECRET` in the
dashboard rather than in the blueprint.

## Related repositories

| Repo | Role |
|---|---|
| [payflow-contract](https://github.com/MMM-pay/payflow-contract) | Soroban contracts this service indexes |
| [payflow-backend](https://github.com/MMM-pay/payflow-backend) | This repo |
| [payflow-frontend](https://github.com/MMM-pay/payflow-frontend) | Consumes this API |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `typecheck`, `test`, and
`build`; all three must pass.

## Security

See [SECURITY.md](SECURITY.md). Unaudited, testnet only.

## Maintainers

| Name | Role | Contact |
|---|---|---|
| Victor Adeleke | Lead maintainer | [@titilope12](https://github.com/titilope12) |

## Contributors

<a href="https://github.com/MMM-pay/payflow-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MMM-pay/payflow-backend"/>
</a>

## License

Apache-2.0.
