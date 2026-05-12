use anchor_lang::prelude::*;

use crate::constants::{MAX_TENOR_SECONDS, MIN_TENOR_SECONDS};
use crate::errors::OptionError;
use crate::state::{MmRegistry, OptionMarket, PriceFeed};

#[derive(Accounts)]
#[instruction(base_symbol: [u8; 8], tenor_seconds: u32, min_notional: u64, max_notional: u64, option_kind: u8)]
pub struct InitMarket<'info> {
    #[account(mut, address = registry.authority @ OptionError::AdminOnly)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, MmRegistry>,

    pub price_feed: Account<'info, PriceFeed>,

    #[account(
        init,
        payer = authority,
        space = 8 + OptionMarket::INIT_SPACE,
        seeds = [
            OptionMarket::SEED_PREFIX,
            base_symbol.as_ref(),
            &tenor_seconds.to_le_bytes(),
            &[option_kind],
        ],
        bump,
    )]
    pub market: Account<'info, OptionMarket>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitMarket>,
    base_symbol: [u8; 8],
    tenor_seconds: u32,
    min_notional: u64,
    max_notional: u64,
    option_kind: u8,
) -> Result<()> {
    require!(
        tenor_seconds >= MIN_TENOR_SECONDS && tenor_seconds <= MAX_TENOR_SECONDS,
        OptionError::TenorOutOfRange
    );
    require!(option_kind <= 1, OptionError::InvalidOptionKind);

    let market = &mut ctx.accounts.market;
    market.price_feed = ctx.accounts.price_feed.key();
    market.base_symbol = base_symbol;
    market.tenor_seconds = tenor_seconds;
    market.option_kind = option_kind;
    market.min_notional = min_notional;
    market.max_notional = max_notional;
    market.active = true;
    market.bump = ctx.bumps.market;
    Ok(())
}
