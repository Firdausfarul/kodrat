use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::OptionError;
use crate::state::Mm;

#[derive(Accounts)]
pub struct WithdrawVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Mm::SEED_PREFIX, mm.authority.as_ref()],
        bump = mm.bump,
        constraint = mm.authority == authority.key() @ OptionError::MmAuthorityMismatch,
    )]
    pub mm: Account<'info, Mm>,

    #[account(
        mut,
        address = mm.usdc_vault @ OptionError::MmVaultMismatch,
    )]
    pub mm_vault: Account<'info, TokenAccount>,

    /// CHECK: Destination token account owned by the MM authority
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawVault>, amount: u64) -> Result<()> {
    require!(amount > 0, OptionError::NotionalTooSmall);

    // Must be able to cover outstanding liabilities after withdrawal
    let remaining = ctx
        .accounts
        .mm_vault
        .amount
        .checked_sub(amount)
        .ok_or(OptionError::InsufficientFreeCollateral)?;
    require!(
        remaining >= ctx.accounts.mm.outstanding_liability,
        OptionError::InsufficientFreeCollateral,
    );

    let bump = ctx.accounts.mm.bump;
    let authority_key = ctx.accounts.mm.authority;
    let seeds: &[&[u8]] = &[Mm::SEED_PREFIX, authority_key.as_ref(), &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    let cpi = CpiContext::new_with_signer(
        anchor_spl::token::ID,
        Transfer {
            from: ctx.accounts.mm_vault.to_account_info(),
            to: ctx.accounts.destination.to_account_info(),
            authority: ctx.accounts.mm.to_account_info(),
        },
        signer_seeds,
    );
    transfer(cpi, amount)?;

    Ok(())
}
