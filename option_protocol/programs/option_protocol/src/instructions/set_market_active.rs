use anchor_lang::prelude::*;

use crate::errors::OptionError;
use crate::state::{MmRegistry, OptionMarket};

#[event]
pub struct MarketActiveToggled {
    pub market: Pubkey,
    pub active: bool,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct SetMarketActive<'info> {
    #[account(address = registry.authority @ OptionError::AdminOnly)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, MmRegistry>,

    #[account(mut)]
    pub market: Account<'info, OptionMarket>,
}

pub fn handler(ctx: Context<SetMarketActive>, active: bool) -> Result<()> {
    ctx.accounts.market.active = active;
    emit!(MarketActiveToggled {
        market: ctx.accounts.market.key(),
        active,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
