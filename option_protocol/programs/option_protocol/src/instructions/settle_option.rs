use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::OptionError;
use crate::math::{normalize_spot, option_payout};
use crate::state::{Mm, OptionMarket, OptionPosition, PriceFeed};

#[event]
pub struct PositionSettled {
    pub position: Pubkey,
    pub payout: u64,
    pub status: u8,
}

#[derive(Accounts)]
pub struct SettleOption<'info> {
    pub settler: Signer<'info>,

    #[account(
        mut,
        constraint = position.status == OptionPosition::STATUS_OPEN
            @ OptionError::PositionAlreadySettled,
    )]
    pub position: Account<'info, OptionPosition>,

    #[account(
        constraint = market.key() == position.market @ OptionError::MarketMismatch,
    )]
    pub market: Account<'info, OptionMarket>,

    #[account(
        constraint = price_feed.key() == market.price_feed @ OptionError::PriceFeedMismatch,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    #[account(
        mut,
        seeds = [Mm::SEED_PREFIX, mm.authority.as_ref()],
        bump = mm.bump,
        constraint = mm.key() == position.mm @ OptionError::MmMismatch,
    )]
    pub mm: Account<'info, Mm>,

    #[account(
        mut,
        address = mm.usdc_vault @ OptionError::MmVaultMismatch,
    )]
    pub mm_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_usdc.owner == position.buyer @ OptionError::BuyerMismatch,
    )]
    pub buyer_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettleOption>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.position.expiry,
        OptionError::PositionNotExpired
    );

    let feed = &ctx.accounts.price_feed;
    require!(
        now - feed.updated_at <= PriceFeed::MAX_STALENESS_SECS,
        OptionError::PriceStale
    );

    // Normalize spot to the position's strike exponent
    let spot = normalize_spot(
        feed.price,
        feed.exponent,
        ctx.accounts.position.strike_exponent,
    )?;

    let payout = option_payout(
        ctx.accounts.market.option_kind,
        ctx.accounts.position.strike,
        spot,
        ctx.accounts.position.notional,
    )?;

    let pos = &mut ctx.accounts.position;

    if payout > 0 {
        let mm_authority_key = ctx.accounts.mm.authority;
        let bump = ctx.accounts.mm.bump;
        let seeds: &[&[u8]] = &[Mm::SEED_PREFIX, mm_authority_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi = CpiContext::new_with_signer(
            anchor_spl::token::ID,
            Transfer {
                from: ctx.accounts.mm_vault.to_account_info(),
                to: ctx.accounts.buyer_usdc.to_account_info(),
                authority: ctx.accounts.mm.to_account_info(),
            },
            signer_seeds,
        );
        transfer(cpi, payout)?;
        pos.status = OptionPosition::STATUS_EXERCISED;
        pos.payout_amount = payout;
    } else {
        pos.status = OptionPosition::STATUS_EXPIRED_OTM;
        pos.payout_amount = 0;
    }
    pos.settled_at = now;

    // Free up liability — notional was locked for max possible payout
    ctx.accounts.mm.outstanding_liability = ctx
        .accounts
        .mm
        .outstanding_liability
        .saturating_sub(pos.notional);

    emit!(PositionSettled {
        position: pos.key(),
        payout: pos.payout_amount,
        status: pos.status,
    });

    Ok(())
}
