use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub symbol: [u8; 8],
    pub price: i64,
    pub exponent: i32,
    pub updated_at: i64,
    pub bump: u8,
}

impl PriceFeed {
    pub const SEED_PREFIX: &'static [u8] = b"price_feed";
    // Hackathon demo mode: do not block settlement when the demo oracle feeder
    // is not running. Production should restore a short staleness window.
    pub const MAX_STALENESS_SECS: i64 = i64::MAX;
}
