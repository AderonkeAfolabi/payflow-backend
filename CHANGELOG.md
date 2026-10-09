# Changelog

All notable changes to payflow-backend. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.2.0] - 2026-10-09

Points at the v0.2.0 contract suite on testnet.

### Fixed

- **The keeper could stall behind failing mandates.** Every pass retried the
  25 oldest due mandates first, so 25 underfunded vaults blocked every other
  mandate indefinitely. A failed charge now backs off (1 minute, doubling, up
  to 6 hours) and a success clears it.
- **Passes could overlap.** Indexer and keeper ran on `setInterval`, so a pass
  slower than the interval ran alongside the next one. Overlapping indexer
  passes could move the cursor backwards; overlapping keeper passes submitted
  transactions with the same sequence number. Each loop now waits for its pass
  to finish.
- **A fresh indexer saw only the last ~11 hours.** With no cursor it started
  8,000 ledgers back. It now starts at `INDEXER_START_LEDGER` or, if unset, the
  oldest ledger the RPC node serves, and moves a cursor that fell out of
  retention forward instead of failing.
- **Ranges could end early.** A page with fewer than 200 events was taken to
  mean the range was exhausted. Paging now continues until a page is empty or
  passes the end of the range, which is passed to RPC as `endLedger`.
- **`npm run indexer` indexed one window and exited.** It now runs until it has
  caught up.
- **`npm run lint` could not run**: ESLint was not installed. ESLint 9 with
  typescript-eslint is configured and CI enforces it.
- **The Render blueprint could not deploy on the free plan**, which has no
  persistent disk. It now rebuilds the projection from the deployment ledger.

### Added

- `mandate_ended` events (a merchant ending a mandate) are projected as
  `Cancelled`, and mandates record who ended them in `ended_by`.
- `/health` reports `starting`, `ok` or `catching_up`, the indexer cursor, its
  lag behind the network, and the last error.
- A scheduled GitHub Actions keeper that settles due testnet mandates without
  an always-on server.

### Changed

- `@stellar/stellar-sdk` 13 → 17, for testnet's current protocol.
- 24 → 39 tests, including indexer sync against a fake RPC node, keeper
  backoff, and loop overlap.

## [0.1.0] - 2026-09-02

Event indexer, settlement keeper and read API for the first testnet
deployment.

[0.2.0]: https://github.com/MMM-pay/payflow-backend/releases/tag/v0.2.0
