use anchor_lang::prelude::*;
use option_protocol_types::SignedQuote;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("H5yv1n2BMwPXgVGYA9Rewz4PQFx7p3RDpbZgBajoiULY");

#[program]
pub mod option_protocol {
    use super::*;

    pub fn init_registry(ctx: Context<InitRegistry>, quote_mint: Pubkey) -> Result<()> {
        instructions::init_registry::handler(ctx, quote_mint)
    }

    pub fn register_mm(ctx: Context<RegisterMm>, quote_signer: Pubkey) -> Result<()> {
        instructions::register_mm::handler(ctx, quote_signer)
    }

    pub fn init_price_feed(ctx: Context<InitPriceFeed>, symbol: [u8; 8]) -> Result<()> {
        instructions::init_price_feed::handler(ctx, symbol)
    }

    pub fn init_market(
        ctx: Context<InitMarket>,
        base_symbol: [u8; 8],
        tenor_seconds: u32,
        min_notional: u64,
        max_notional: u64,
        option_kind: u8,
    ) -> Result<()> {
        instructions::init_market::handler(ctx, base_symbol, tenor_seconds, min_notional, max_notional, option_kind)
    }

    pub fn update_price(ctx: Context<UpdatePrice>, price: i64, exponent: i32) -> Result<()> {
        instructions::update_price::handler(ctx, price, exponent)
    }

    pub fn buy_option(ctx: Context<BuyOption>, quote: SignedQuote) -> Result<()> {
        instructions::buy_option::handler(ctx, quote)
    }

    pub fn settle_option(ctx: Context<SettleOption>) -> Result<()> {
        instructions::settle_option::handler(ctx)
    }

    pub fn set_registry_paused(ctx: Context<SetRegistryPaused>, paused: bool) -> Result<()> {
        instructions::set_registry_paused::handler(ctx, paused)
    }

    pub fn set_market_active(ctx: Context<SetMarketActive>, active: bool) -> Result<()> {
        instructions::set_market_active::handler(ctx, active)
    }

    pub fn rotate_quote_signer(ctx: Context<RotateQuoteSigner>, new_signer: Pubkey) -> Result<()> {
        instructions::rotate_quote_signer::handler(ctx, new_signer)
    }

    pub fn withdraw_vault(ctx: Context<WithdrawVault>, amount: u64) -> Result<()> {
        instructions::withdraw_vault::handler(ctx, amount)
    }
}
