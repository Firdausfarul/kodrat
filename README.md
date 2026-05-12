# Meridian FX — Pooled FX Hedging on Solana

> **Hackathon demo on Solana Devnet.** All collateral is a program-owned demo stablecoin (demoUSD). No real funds are at risk.

Meridian FX lets retail users lock in a USD/IDR or USD/JPY exchange rate for a fixed horizon, and lets liquidity providers earn the spread by taking the other side.

---

## What it is

Emerging-market exporters and importers face FX rate risk between invoice and payment. Forward contracts exist but require bank relationships, minimum notionals, and KYC. Meridian FX provides the same economic exposure on-chain:

- **Traders** deposit USDC (demoUSD on devnet), pick a direction, and receive a guaranteed settlement rate if they hold to expiry.
- **LPs** deposit into a pool to backstop positions. They earn the spread on every trade plus collect losing traders' collateral at settlement.

This is **not a bilateral NDF** with a forward curve and tenor pricing. Economically it is a full-collateral, capped FX bet priced at spot ± a static spread. Think of it as the simplest on-chain equivalent of a deliverable forward.

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Anchor Program  (86v5K13XU2TiFmg2HCf8sHf9TYGXsaoBGM1UEFZhoXer)          │
│                                                        │
│  Pool ──── PriceFeed (base) ── PriceFeed (quote)       │
│    │                                                   │
│    ├── LpAccount (one per LP)                          │
│    ├── Position  (one per trade)                       │
│    └── PoolVault (SPL token account)                   │
└────────────────────────────────────────────────────────┘
```

### On-chain accounts

| Account | Seeds | Description |
|---------|-------|-------------|
| `Pool` | `[b"pool", pair, expiry_le]` | Market for one (pair, expiry) |
| `PoolVault` | `[b"pool_vault", pool]` | SPL token account holding all collateral |
| `LpAccount` | `[b"lp_account", pool, lp]` | LP shares for one wallet |
| `Position` | `[b"pos", pool, trader, nonce]` | One open trade |
| `PriceFeed` | `[b"price_feed", symbol_8b]` | Admin-maintained oracle |
| `DemoMint` | `[b"demo_mint"]` | Program-owned stablecoin (devnet only) |

### Instructions

| Instruction | Who calls it | What it does |
|-------------|-------------|--------------|
| `init_pool` | admin | Create a `(pair, expiry)` market with a spread |
| `deposit_liquidity` | LP | Mint shares priced at current NAV |
| `withdraw_liquidity` | LP | Burn shares, receive `total_usdc × shares / supply` |
| `open_position` | trader | Lock collateral, record entry rate |
| `settle_pool` | anyone | Capture settlement rate after expiry |
| `settle_position` | anyone | Pay out one position based on settlement rate |
| `update_price_feed` | admin | Push a new price for a symbol |
| `init_demo_mint` | admin | One-time demo mint setup |
| `airdrop_demo_usdc` | anyone | Mint up to 1,000 demoUSD per call |

### Settlement math

```
mid_rate  = base_usd_price / quote_usd_price          (6 dp)
entry     = mid × (1 ± spread_bps / 10_000)
pnl       = notional × |settlement − entry| / entry   (capped at notional)
payout    = notional + pnl  (win)  or  notional − pnl  (loss)
```

LP NAV moves inversely to net trader PnL: when traders collectively profit, LP shares lose value; when traders lose, LP NAV rises.

---

## Frontend

| Route | Purpose |
|-------|---------|
| `/` | Market overview — active pools with liquidity and utilization |
| `/hedge` | Retail flow — pick use case, amount, expiry date, submit |
| `/lp` | LP dashboard — deposit/withdraw per pool |
| `/portfolio` | Open and settled positions, claim payout |

The frontend requires no wallet for the market overview (read-only). Trades, LP actions, and airdrop require a connected Solana wallet (Phantom, Backpack, etc.) on Devnet.

---

## Known limitations (demo scope)

The following are known issues that would need to be resolved before a production deployment:

**Security**
- `init_pool` accepts any signer as admin; there is no protocol-level registry of trusted markets. A malicious user can create lookalike pools on devnet.
- `open_position` and `settle_pool` accept arbitrary `PriceFeed` accounts without verifying the symbol against `pool.pair`. An attacker can supply a freshly-initialized feed at an arbitrary price. In production, feeds should be validated against a trusted registry.
- `update_price_feed` initializes a new feed on first call from any signer, so anyone can create their own price authority.

**Economics**
- LP NAV pricing includes trader collateral in `total_usdc`. This means share prices are overstated while positions are open, and NAV drops sharply at settlement when losing traders' collateral is paid out. A proper implementation would separate LP capital from trader collateral.
- `reserved_usdc` tracks pool-side collateral. `total_usdc − reserved_usdc` is the withdrawal ceiling for LPs. However, `total_usdc` also includes trader collateral posted as `open_position` deposits, so LPs can theoretically withdraw funds that implicitly back active positions. This is safe in normal cases (pool-side reserve > trader notional) but creates a solvency edge case if pool NAV drops significantly.
- Spread is a fixed 30 bps regardless of tenor, utilization, or skew. An EM FX tail-risk book needs dynamic pricing.
- Tiny deposits/withdrawals can round to zero shares or zero USDC (integer truncation). Minimum size is not enforced.

**UX / liveness**
- Oracle freshness: the program requires price updates within 60 seconds. Without an automated keeper, trades will fail on a cold devnet. Run `npm run update-feeds` or use the admin panel before demoing.
- Settlement requires a two-step flow: first `settle_pool` (capture rate), then `settle_position` per trade. The app's Portfolio page shows unsettled positions but does not yet provide a "Settle pool" admin button.
- Displayed preview rate comes from a third-party REST API; on-chain entry rate comes from the `PriceFeed` account. These can diverge if the feed is stale.

---

## Repository layout

```
ndf_protocol/
├── programs/ndf_protocol/   Anchor program (Rust)
│   ├── src/instructions/    One file per instruction
│   ├── src/math.rs          Pure arithmetic (30+ unit tests)
│   ├── src/state.rs         Account layouts
│   └── src/errors.rs        Error codes
├── tests/integration.rs     6 end-to-end tests via litesvm
├── app/                     Next.js 14 frontend
│   ├── src/pages/           Route pages
│   ├── src/components/      NavBar, AirdropButton, etc.
│   ├── src/hooks/           useNdfProgram, usePools, useDemoMint, …
│   ├── src/lib/             IDL, constants, math utils
│   └── scripts/init_markets.ts  Admin bootstrap script
└── Anchor.toml
```

---

## Setup

### Prerequisites

- Rust + `cargo` (stable)
- Solana CLI ≥ 1.18
- Anchor CLI 1.0.x (`avm use 1.0.x`)
- Node.js ≥ 18, yarn

### Build and test the program

```bash
cd ndf_protocol
cargo test                        # 33 unit tests + 6 integration tests
anchor build                      # compile to target/deploy/
```

### Run the frontend

```bash
cd ndf_protocol/app
yarn install
yarn dev                          # http://localhost:3000
```

### Seed devnet markets (one-time admin)

```bash
# Requires ~/.config/solana/id.json funded on devnet
cd ndf_protocol/app
npm run init-markets              # creates demo mint + 8 pools (USD/IDR × 4, USD/JPY × 4)
```

After seeding, keep a keeper running to refresh oracle prices:

```bash
npm run update-feeds              # push fresh prices every ~30s
```

---

## Test suite

```
tests/integration.rs
├── admin_can_init_pool                          happy-path pool creation
├── lp_deposit_increases_tvl                     deposit → TVL, shares, NAV
├── trader_open_position_happy_path              open → collateral locked, reserved_usdc rises
├── lp_deposit_withdraw_roundtrip                full roundtrip, no positions → get principal back
├── short_position_profits_when_idr_appreciates  direction=1, rate falls → payout > notional
└── cannot_double_settle_position                PositionAlreadySettled on second settle
```

All tests use `litesvm` for sub-second execution without a validator.

---

## License

MIT

# kodrat
