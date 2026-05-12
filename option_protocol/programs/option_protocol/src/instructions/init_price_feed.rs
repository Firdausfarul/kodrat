use anchor_lang::prelude::*;

use crate::errors::OptionError;
use crate::state::{MmRegistry, PriceFeed};

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct InitPriceFeed<'info> {
    #[account(mut, address = registry.authority @ OptionError::AdminOnly)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, MmRegistry>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [PriceFeed::SEED_PREFIX, symbol.as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitPriceFeed>, symbol: [u8; 8]) -> Result<()> {
    let feed = &mut ctx.accounts.price_feed;
    feed.authority = ctx.accounts.authority.key();
    feed.symbol = symbol;
    feed.price = 0;
    feed.exponent = 0;
    feed.updated_at = 0;
    feed.bump = ctx.bumps.price_feed;
    Ok(())
}
