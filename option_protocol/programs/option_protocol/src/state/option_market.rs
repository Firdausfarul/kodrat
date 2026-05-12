use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct OptionMarket {
    pub price_feed: Pubkey,
    pub base_symbol: [u8; 8],
    pub tenor_seconds: u32,
    pub option_kind: u8,
    pub min_notional: u64,
    pub max_notional: u64,
    pub active: bool,
    pub bump: u8,
}

impl OptionMarket {
    pub const SEED_PREFIX: &'static [u8] = b"market";
    pub const KIND_PUT: u8 = 0;
    pub const KIND_CALL: u8 = 1;
}
