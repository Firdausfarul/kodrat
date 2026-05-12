use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MmRegistry {
    pub authority: Pubkey,
    pub quote_mint: Pubkey,
    pub mm_count: u32,
    pub paused: bool,
    pub bump: u8,
}

impl MmRegistry {
    pub const SEED: &'static [u8] = b"mm_registry";
}
