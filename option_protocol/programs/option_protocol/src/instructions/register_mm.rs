use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::OptionError;
use crate::state::{Mm, MmRegistry};

#[derive(Accounts)]
pub struct RegisterMm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MmRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, MmRegistry>,

    #[account(
        init,
        payer = authority,
        space = 8 + Mm::INIT_SPACE,
        seeds = [Mm::SEED_PREFIX, authority.key().as_ref()],
        bump,
    )]
    pub mm: Account<'info, Mm>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = mm,
        constraint = registry.quote_mint == Pubkey::default()
            || usdc_mint.key() == registry.quote_mint @ OptionError::QuoteMintMismatch,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterMm>, quote_signer: Pubkey) -> Result<()> {
    require!(!ctx.accounts.registry.paused, OptionError::RegistryPaused);

    let mm = &mut ctx.accounts.mm;
    mm.authority = ctx.accounts.authority.key();
    mm.quote_signer = quote_signer;
    mm.usdc_vault = ctx.accounts.usdc_vault.key();
    mm.active = true;
    mm.created_at = Clock::get()?.unix_timestamp;
    mm.outstanding_liability = 0;
    mm.bump = ctx.bumps.mm;

    let registry = &mut ctx.accounts.registry;
    registry.mm_count = registry.mm_count.saturating_add(1);
    Ok(())
}
