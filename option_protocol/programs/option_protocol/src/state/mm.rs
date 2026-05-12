use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Mm {
    pub authority: Pubkey,
    pub quote_signer: Pubkey,
    pub usdc_vault: Pubkey,
    pub outstanding_liability: u64,
    pub active: bool,
    pub created_at: i64,
    pub bump: u8,
}

impl Mm {
    pub const SEED_PREFIX: &'static [u8] = b"mm";
}
