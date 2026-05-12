use anchor_lang::prelude::*;

use crate::state::MmRegistry;

#[derive(Accounts)]
#[instruction(quote_mint: Pubkey)]
pub struct InitRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + MmRegistry::INIT_SPACE,
        seeds = [MmRegistry::SEED],
        bump,
    )]
    pub registry: Account<'info, MmRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitRegistry>, quote_mint: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.authority = ctx.accounts.authority.key();
    registry.quote_mint = quote_mint;
    registry.mm_count = 0;
    registry.paused = false;
    registry.bump = ctx.bumps.registry;
    Ok(())
}
