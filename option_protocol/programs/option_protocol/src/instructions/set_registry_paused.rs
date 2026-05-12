use anchor_lang::prelude::*;

use crate::errors::OptionError;
use crate::state::MmRegistry;

#[event]
pub struct RegistryPauseToggled {
    pub authority: Pubkey,
    pub paused: bool,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct SetRegistryPaused<'info> {
    #[account(address = registry.authority @ OptionError::AdminOnly)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, MmRegistry>,
}

pub fn handler(ctx: Context<SetRegistryPaused>, paused: bool) -> Result<()> {
    ctx.accounts.registry.paused = paused;
    emit!(RegistryPauseToggled {
        authority: ctx.accounts.authority.key(),
        paused,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
