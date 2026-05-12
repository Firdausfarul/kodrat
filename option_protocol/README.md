# Kodrat — Option Protocol

Permissionless USD/IDR + USD/JPY vanilla put option RFQ on Solana. Hackathon
sibling of `../ndf_protocol/`; option is the headline product, NDF is the
foundation kept for the Q4 2026 roadmap slide.

## Status

Skeleton (2026-05-02). Compiles structurally; tests are stubs marked
`#[ignore]` pending ed25519 verify-ix wiring. NOT deployed.

## Layout

```
option_protocol/
├── Anchor.toml                 # placeholder program ID — replace post-keygen
├── Cargo.toml                  # workspace
├── programs/option_protocol/   # Anchor program
│   └── src/
│       ├── lib.rs              # #[program] entry
│       ├── state/              # MmRegistry, Mm, OptionMarket, OptionPosition, PriceFeed
│       ├── instructions/       # 6 ix: init_registry, register_mm, init_market,
│       │                       # update_price, buy_option, settle_option
│       ├── math.rs             # put_payout_usdc helper + unit tests
│       ├── errors.rs
│       └── constants.rs
├── bot/                        # off-chain MM (axum POST /quote)
│   └── src/
│       ├── main.rs
│       ├── pricer.rs           # ATM Black-Scholes
│       ├── iv_table.rs         # fixed IV per (pair, tenor)
│       └── quote.rs            # SignedQuote — must match on-chain borsh
└── migrations/
```

## On-chain flow

1. `init_registry` (admin once)
2. `register_mm` (per MM; v1 single MM = user wallet)
3. `init_market` × 6 (USD/IDR + USD/JPY × 7d/30d/60d)
4. Buyer flow per trade:
   - hits bot `POST /quote { pair, tenor_seconds, notional_usdc }`
   - bot returns `{ SignedQuote, signature }` (ed25519 over borsh payload)
   - buyer constructs tx with **two** instructions:
     - `Ed25519Program` verify ix (sig + pubkey + payload)
     - `option_protocol::buy_option(quote)`
   - `buy_option` checks the verify ix is present at index 0 and that its
     payload matches `quote.try_to_vec()` byte-for-byte
   - premium USDC transferred buyer → `mm.usdc_vault`, position PDA created at
     seeds `[b"position", quote_nonce_le]` (replay-protected)
5. `settle_option` (anyone after expiry):
   - reads `PriceFeed`, computes `put_payout_usdc(strike, spot, notional)`
   - if ITM: PDA-signed CPI transfer `mm.usdc_vault` → buyer ATA
   - position marked `EXERCISED` or `EXPIRED_OTM`

## MM vault ownership (important for v1)

For permissionless settle to work, the MM's USDC vault MUST be a token
account whose authority is the `Mm` PDA at `[b"mm", mm_authority]`. Otherwise
the PDA-signed transfer in `settle_option` will fail. Tooling for vault
creation is TODO — `register_mm` currently accepts any `UncheckedAccount`.

## Build

```bash
anchor build              # produces target/deploy/option_protocol.so
cargo test                # unit + integration (most ignored — flesh out per
                          # tests/integration.rs plan)
```

## Bot

```bash
cd bot && cargo run --release
# POST http://localhost:8787/quote
# {"pair":"usd_idr","tenor_seconds":2592000,"notional_usdc":5000000000}
```

Response includes borsh-serialized `payload_b64` and base58 signature; the
frontend constructs the ed25519 verify ix from these and sends both ixs in
one tx.

## Anchor 1.0.x gotchas (inherited from ndf_protocol)

- JS: `@anchor-lang/core` (NOT `@coral-xyz/anchor`)
- `new Program(IDL, provider)` — program ID comes from `IDL.address`
- `CpiContext::new(program_pubkey, accounts)` — Pubkey, not AccountInfo
- `pub use instructions::*; pub use state::*;` MUST be `pub` at crate root
- `anchor-spl` needs `"idl-build"` feature for IDL gen (already set)

## Custom oracle

Pyth SDK incompatible with Solana 2.x / Anchor 1.0.x. Reuse the same
`PriceFeed` PDA pattern as ndf_protocol (seeds `[b"price_feed", symbol_8]`),
admin-pushed via `update_price`. Hackathon-only; v2 swaps to
Switchboard/Chainlink push oracle.

Hackathon demo note: oracle staleness is intentionally disabled in the
program and quote bot so a stale devnet feeder does not block live demos.
Production should restore a short staleness window before launch.

## V1 collateral note

Kodrat reserves 100% of option notional as MM liability. This fully
collateralizes puts because put payout is capped by notional. Calls are kept
for importer-flow demos, but call payout can exceed notional in extreme FX
moves; v1 relies on short-tenor major FX bounds. Production should use capped
calls, dynamic margin, or liquidation-based collateral management.

## Brutal scope cuts (8-day timeline)

- Put options only; no calls
- ATM-only (strike = current spot at quote time)
- USD/IDR + USD/JPY only
- 3 fixed tenors: 7d / 30d / 60d
- European cash-settled (no early exercise)
- Single MM in v1, registry-ready for multi-MM in v1.1
- Off-chain BS-ATM pricer; no vol surface, no skew
- No bot delta hedging — `OptionMarket.max_notional` enforces inventory cap

## What's deferred

- Multi-MM aggregation (UI picks best quote)
- IV surface (per-strike, not flat ATM)
- Calls
- NDF integration as collateralization primitive (Q4 2026 per deck)
