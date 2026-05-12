use anchor_lang::prelude::*;

use crate::errors::OptionError;
use crate::state::PriceFeed;

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(address = price_feed.authority @ OptionError::PriceFeedAuthorityMismatch)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handler(ctx: Context<UpdatePrice>, price: i64, exponent: i32) -> Result<()> {
    require!(price > 0, OptionError::InvalidPrice);

    let feed = &mut ctx.accounts.price_feed;

    // Deviation guard: max 5% change per update (interim protection)
    if feed.updated_at > 0 {
        let old_spot = normalize(feed.price, feed.exponent);
        let new_spot = normalize(price, exponent);
        let diff = (new_spot - old_spot).unsigned_abs();
        let max_delta = old_spot
            .unsigned_abs()
            .checked_mul(5)
            .and_then(|v| v.checked_div(100))
            .unwrap_or(u64::MAX);
        require!(diff <= max_delta, OptionError::StrikeOutOfRange);
    }

    feed.price = price;
    feed.exponent = exponent;
    feed.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}

fn normalize(price: i64, exponent: i32) -> i64 {
    if exponent >= 0 {
        price.checked_mul(10_i64.pow(exponent as u32)).unwrap_or(price)
    } else {
        price.checked_div(10_i64.pow((-exponent) as u32)).unwrap_or(price)
    }
}
