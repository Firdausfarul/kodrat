use anchor_lang::prelude::*;

use crate::errors::OptionError;
use crate::state::Mm;

#[event]
pub struct QuoteSignerRotated {
    pub mm: Pubkey,
    pub old_signer: Pubkey,
    pub new_signer: Pubkey,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct RotateQuoteSigner<'info> {
    #[account(address = mm.authority @ OptionError::MmAuthorityMismatch)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Mm::SEED_PREFIX, mm.authority.as_ref()],
        bump = mm.bump,
    )]
    pub mm: Account<'info, Mm>,
}

pub fn handler(ctx: Context<RotateQuoteSigner>, new_signer: Pubkey) -> Result<()> {
    let old_signer = ctx.accounts.mm.quote_signer;
    ctx.accounts.mm.quote_signer = new_signer;
    emit!(QuoteSignerRotated {
        mm: ctx.accounts.mm.key(),
        old_signer,
        new_signer,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
