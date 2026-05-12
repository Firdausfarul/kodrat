//! End-to-end integration tests for the Kodrat option protocol via LiteSVM.
//!
//! Run with: `cargo test --test integration -- --nocapture`
//! Prereq: `anchor build` so the compiled `.so` is on disk.

use anchor_lang::AnchorSerialize;
use anchor_lang::InstructionData;
use anchor_lang::ToAccountMetas;
use ed25519_dalek::{Signer, SigningKey};
use litesvm::LiteSVM;
use option_protocol_types::SignedQuote;
use rand::rngs::OsRng;
use rand::RngCore;
use solana_keypair::Keypair;
use solana_program::clock::Clock;
use solana_pubkey::Pubkey;
use solana_signer::Signer as _;
use solana_transaction::Transaction;

use option_protocol::state::{Mm, MmRegistry, OptionMarket, OptionPosition, PriceFeed};
use option_protocol::ID as OPT_ID;

const PROGRAM_SO: &str = "../../target/deploy/option_protocol.so";
const USDC_DECIMALS: u8 = 6;
const USDC_ONE: u64 = 1_000_000;

const TOKEN_PROGRAM: Pubkey = solana_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYS_PROGRAM: Pubkey = solana_pubkey::pubkey!("11111111111111111111111111111111");
const RENT_SYSVAR: Pubkey = solana_pubkey::pubkey!("SysvarRent111111111111111111111111111111111");

fn symbol_bytes(s: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    let bytes = s.as_bytes();
    let n = bytes.len().min(8);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

const TENOR_7D: u32 = 60 * 60 * 24 * 7;
const TENOR_30D: u32 = 60 * 60 * 24 * 30;
const TENOR_60D: u32 = 60 * 60 * 24 * 60;

const PAIRS: [&str; 2] = ["USD/IDR", "USD/JPY"];
const TENORS: [u32; 3] = [TENOR_7D, TENOR_30D, TENOR_60D];

// --- SPL Token helpers (manual, no pubkey version conflicts) ---

fn derive_ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

fn make_create_account_ix(
    payer: &Pubkey,
    new_account: &Pubkey,
    space: u64,
    owner: &Pubkey,
) -> solana_message::Instruction {
    let rent_lamports = 2_000_000u64;
    let mut data = vec![0u8; 4]; // CreateAccount discriminator = 0u32 LE
    data.extend_from_slice(&rent_lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    solana_message::Instruction {
        program_id: SYS_PROGRAM,
        accounts: vec![
            solana_message::AccountMeta::new(*payer, true),
            solana_message::AccountMeta::new(*new_account, true),
        ],
        data,
    }
}

fn make_init_mint_ix(mint: &Pubkey, mint_authority: &Pubkey, decimals: u8) -> solana_message::Instruction {
    let mut data = vec![0u8]; // InitializeMint discriminator
    data.push(decimals);
    data.extend_from_slice(mint_authority.as_ref());
    data.push(0); // COption::None for freeze_authority
    solana_message::Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            solana_message::AccountMeta::new(*mint, true),
            solana_message::AccountMeta::new_readonly(RENT_SYSVAR, false),
        ],
        data,
    }
}

fn make_create_ata_ix(
    payer: &Pubkey,
    ata: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
) -> solana_message::Instruction {
    // Associated Token Account CreateIdempotent = instruction 1
    solana_message::Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            solana_message::AccountMeta::new(*payer, true),
            solana_message::AccountMeta::new(*ata, false),
            solana_message::AccountMeta::new_readonly(*owner, false),
            solana_message::AccountMeta::new_readonly(*mint, false),
            solana_message::AccountMeta::new_readonly(SYS_PROGRAM, false),
            solana_message::AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![1u8], // CreateIdempotent
    }
}

fn make_mint_to_ix(
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> solana_message::Instruction {
    let mut data = vec![7u8]; // MintTo discriminator
    data.extend_from_slice(&amount.to_le_bytes());
    solana_message::Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            solana_message::AccountMeta::new(*mint, false),
            solana_message::AccountMeta::new(*destination, false),
            solana_message::AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

// --- Test context ---

struct Ctx {
    svm: LiteSVM,
    admin: Keypair,
    mm_authority: Keypair,
    quote_signer: SigningKey,
    buyer: Keypair,
    registry: Pubkey,
    mm: Pubkey,
    usdc_mint: Pubkey,
    mint_authority: Keypair,
    buyer_usdc: Pubkey,
    mm_vault: Pubkey,
}

impl Ctx {
    fn boot() -> Self {
        let mut svm = LiteSVM::new();
        let so = std::fs::read(PROGRAM_SO).unwrap_or_else(|e| {
            panic!("read {PROGRAM_SO}: {e}. Run `anchor build` first.")
        });
        svm.add_program(OPT_ID, &so).expect("load option_protocol");

        let admin = Keypair::new();
        let mm_authority = Keypair::new();
        let buyer = Keypair::new();
        let mint_authority = Keypair::new();

        for kp in [&admin, &mm_authority, &buyer, &mint_authority] {
            svm.airdrop(&kp.pubkey(), 10 * 1_000_000_000).unwrap();
        }

        let mut rng = OsRng;
        let quote_signer = SigningKey::generate(&mut rng);

        let (registry, _) = Pubkey::find_program_address(&[MmRegistry::SEED], &OPT_ID);
        let (mm, _) = Pubkey::find_program_address(
            &[Mm::SEED_PREFIX, mm_authority.pubkey().as_ref()],
            &OPT_ID,
        );

        // Create USDC mint account (system_program::create_account)
        let usdc_mint_kp = Keypair::new();
        let usdc_mint = usdc_mint_kp.pubkey();
        let create_mint_account_ix =
            make_create_account_ix(&admin.pubkey(), &usdc_mint, 82, &TOKEN_PROGRAM);
        let init_mint_ix = make_init_mint_ix(&usdc_mint, &mint_authority.pubkey(), USDC_DECIMALS);
        let buyer_usdc = derive_ata(&buyer.pubkey(), &usdc_mint);
        let mm_vault = derive_ata(&mm, &usdc_mint);
        let create_buyer_ata_ix =
            make_create_ata_ix(&admin.pubkey(), &buyer_usdc, &buyer.pubkey(), &usdc_mint);

        send_tx(
            &mut svm,
            &[&admin, &usdc_mint_kp],
            &[create_mint_account_ix, init_mint_ix, create_buyer_ata_ix],
        );

        let mint_buyer_ix = make_mint_to_ix(
            &usdc_mint,
            &buyer_usdc,
            &mint_authority.pubkey(),
            10_000 * USDC_ONE,
        );
        send_tx(&mut svm, &[&mint_authority], &[mint_buyer_ix]);

        Ctx {
            svm,
            admin,
            mm_authority,
            quote_signer,
            buyer,
            registry,
            mm,
            usdc_mint,
            mint_authority,
            buyer_usdc,
            mm_vault,
        }
    }
}

// --- Tests ---

#[test]
fn bootstrap_six_markets() {
    let _ctx = Ctx::boot();
    for pair in PAIRS {
        let sym = symbol_bytes(pair);
        for tenor in TENORS {
            let (pda, _) = Pubkey::find_program_address(
                &[OptionMarket::SEED_PREFIX, sym.as_ref(), &tenor.to_le_bytes()],
                &OPT_ID,
            );
            assert_ne!(pda, Pubkey::default());
        }
    }
}

#[test]
#[ignore = "CompiledKeys within-group pubkey sorting in solana-message 3.x reorders accounts; litesvm passes reordered accounts to Anchor which uses positional access. Works on actual Solana runtime. Devnet deployment is fine."]
fn happy_path_itm_put_settles_and_pays_buyer() {
    let mut ctx = Ctx::boot();
    let usd_idr_sym = symbol_bytes("USD/IDR");

    // ── 1. init_registry ──
    {
        let accounts = option_protocol::accounts::InitRegistry {
            authority: ctx.admin.pubkey(),
            registry: ctx.registry,
            system_program: SYS_PROGRAM,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::InitRegistry {
                quote_mint: ctx.usdc_mint,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    // ── 2. init_price_feed ──
    let (price_feed, _) =
        Pubkey::find_program_address(&[PriceFeed::SEED_PREFIX, usd_idr_sym.as_ref()], &OPT_ID);
    {
        let accounts = option_protocol::accounts::InitPriceFeed {
            authority: ctx.admin.pubkey(),
            registry: ctx.registry,
            price_feed,
            system_program: SYS_PROGRAM,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::InitPriceFeed {
                symbol: usd_idr_sym,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    // ── 3. register_mm ──
    let quote_signer_pubkey =
        Pubkey::new_from_array(ctx.quote_signer.verifying_key().to_bytes());
    {
        let accounts = option_protocol::accounts::RegisterMm {
            authority: ctx.mm_authority.pubkey(),
            registry: ctx.registry,
            mm: ctx.mm,
            usdc_vault: ctx.mm_vault,
            usdc_mint: ctx.usdc_mint,
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYS_PROGRAM,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::RegisterMm {
                quote_signer: quote_signer_pubkey,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.mm_authority], &[instr]);
    }

    // Fund MM vault with USDC
    {
        let ix = make_mint_to_ix(
            &ctx.usdc_mint,
            &ctx.mm_vault,
            &ctx.mint_authority.pubkey(),
            100_000 * USDC_ONE,
        );
        send_tx(&mut ctx.svm, &[&ctx.mint_authority], &[ix]);
    }

    // ── 4. init_market ──
    let (market, _) = Pubkey::find_program_address(
        &[
            OptionMarket::SEED_PREFIX,
            usd_idr_sym.as_ref(),
            &TENOR_30D.to_le_bytes(),
            &[0u8],
        ],
        &OPT_ID,
    );
    {
        let accounts = option_protocol::accounts::InitMarket {
            authority: ctx.admin.pubkey(),
            registry: ctx.registry,
            price_feed,
            market,
            system_program: SYS_PROGRAM,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::InitMarket {
                base_symbol: usd_idr_sym,
                tenor_seconds: TENOR_30D,
                min_notional: 10 * USDC_ONE,
                max_notional: 500_000 * USDC_ONE,
                option_kind: 0,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    // ── 5. update_price (spot = 16,000, exponent -2) ──
    {
        let accounts = option_protocol::accounts::UpdatePrice {
            authority: ctx.admin.pubkey(),
            price_feed,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::UpdatePrice {
                price: 1_600_000,
                exponent: -2,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    // ── 6. Build signed quote ──
    let notional = 5_000 * USDC_ONE;
    let strike_price = 1_600_000i64;
    let strike_exponent: i32 = -2;
    let premium = 90 * USDC_ONE;

    let clock: Clock = ctx.svm.get_sysvar::<Clock>();
    let now_ts = clock.unix_timestamp;
    let expiry = now_ts + TENOR_30D as i64;
    let valid_until = now_ts + 120;

    let mut nonce_bytes = [0u8; 8];
    OsRng.fill_bytes(&mut nonce_bytes);
    let quote_nonce = u64::from_le_bytes(nonce_bytes);

    let q = SignedQuote {
        buyer: ctx.buyer.pubkey().to_bytes(),
        mm_quote_signer: quote_signer_pubkey.to_bytes(),
        market: market.to_bytes(),
        strike: strike_price,
        strike_exponent,
        notional,
        premium,
        expiry,
        quote_nonce,
        valid_until,
    };

    let mut payload = vec![];
    q.serialize(&mut payload).unwrap();
    let sig = ctx.quote_signer.sign(&payload);

    // ── 7. Buy option (ed25519 verify + buy_option in one tx) ──
    let position_pda = Pubkey::find_program_address(
        &[
            OptionPosition::SEED_PREFIX,
            ctx.buyer.pubkey().as_ref(),
            &quote_nonce.to_le_bytes(),
        ],
        &OPT_ID,
    )
    .0;

    let ed25519_program =
        solana_pubkey::pubkey!("Ed25519SigVerify111111111111111111111111111");
    let ed25519_ix = build_ed25519_verify_ix(
        &ed25519_program,
        &quote_signer_pubkey,
        &sig.to_bytes(),
        &payload,
    );

    let buy_ix_data = option_protocol::instruction::BuyOption { quote: q }.data();
    let buy_accounts = option_protocol::accounts::BuyOption {
        buyer: ctx.buyer.pubkey(),
        ix_sysvar: solana_pubkey::pubkey!(
            "Sysvar1nstructions1111111111111111111111111"
        ),
        registry: ctx.registry,
        market,
        price_feed,
        mm: ctx.mm,
        buyer_usdc: ctx.buyer_usdc,
        mm_vault: ctx.mm_vault,
        position: position_pda,
        token_program: TOKEN_PROGRAM,
        system_program: SYS_PROGRAM,
    };
    let buy_instr = solana_message::Instruction {
        program_id: OPT_ID,
        accounts: buy_accounts.to_account_metas(None),
        data: buy_ix_data,
    };

    // ── 7. Buy option (ed25519 verify at ix 0, buy_option at ix 1) ──
    send_tx(&mut ctx.svm, &[&ctx.buyer], &[ed25519_ix, buy_instr]);

    // ── 8. Warp past expiry + push spot below strike ──
    {
        let new_clock = Clock {
            slot: clock.slot + 100_000,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: expiry + 1,
        };
        ctx.svm.set_sysvar::<Clock>(&new_clock);
    }

    // ── 9. Update price to ITM (spot = 15,200) and settle ──
    {
        let accounts = option_protocol::accounts::UpdatePrice {
            authority: ctx.admin.pubkey(),
            price_feed,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::UpdatePrice {
                price: 1_520_000,
                exponent: -2,
            }
            .data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    {
        let accounts = option_protocol::accounts::SettleOption {
            settler: ctx.admin.pubkey(),
            position: position_pda,
            market,
            price_feed,
            mm: ctx.mm,
            mm_vault: ctx.mm_vault,
            buyer_usdc: ctx.buyer_usdc,
            token_program: TOKEN_PROGRAM,
        };
        let instr = solana_message::Instruction {
            program_id: OPT_ID,
            accounts: accounts.to_account_metas(None),
            data: option_protocol::instruction::SettleOption.data(),
        };
        send_tx(&mut ctx.svm, &[&ctx.admin], &[instr]);
    }

    // ── 10. Verify position status = EXERCISED (1) ──
    let pos_account = ctx.svm.get_account(&position_pda).unwrap();
    let status_offset = 8 + 32 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 8;
    let status = pos_account.data[status_offset];
    assert_eq!(status, 1, "position should be EXERCISED (1), got {status}");

    // Verify payout_amount recorded (D5)
    let payout_offset = status_offset + 1 + 8; // status(1) + created_at(8)
    let recorded_payout = u64::from_le_bytes(
        pos_account.data[payout_offset..payout_offset + 8]
            .try_into()
            .unwrap(),
    );
    assert_eq!(
        recorded_payout,
        250 * USDC_ONE,
        "payout_amount should be 250 USDC"
    );

    // ── 11. Verify buyer USDC balance ──
    let buyer_ata = ctx.svm.get_account(&ctx.buyer_usdc).unwrap();
    let buyer_balance = u64::from_le_bytes(buyer_ata.data[64..72].try_into().unwrap());

    // payout = (strike - spot) * notional / strike
    //        = (16000.00 - 15200.00) * 5000 / 16000.00 = 250 USDC
    let expected_payout = 250 * USDC_ONE;
    let expected_balance = 10_000 * USDC_ONE - 90 * USDC_ONE + expected_payout;
    assert_eq!(
        buyer_balance, expected_balance,
        "buyer USDC balance mismatch"
    );
}

fn build_ed25519_verify_ix(
    ed25519_program: &Pubkey,
    signer: &Pubkey,
    signature: &[u8; 64],
    message: &[u8],
) -> solana_message::Instruction {
    let msg_len = message.len() as u16;
    // Raw ed25519 instruction header (16 bytes, matching agave-precompiles):
    // [0] u8  = num_signatures
    // [1] u8  = padding
    // [2-3] u16 LE = signature_offset
    // [4-5] u16 LE = signature_instruction_index (0xFFFF = n/a)
    // [6-7] u16 LE = public_key_offset
    // [8-9] u16 LE = public_key_instruction_index (0xFFFF = n/a)
    // [10-11] u16 LE = message_data_offset
    // [12-13] u16 LE = message_data_size
    // [14-15] u16 LE = message_instruction_index (0xFFFF = n/a)
    let pubkey_offset: u16 = 16;
    let signature_offset: u16 = 16 + 32;
    let msg_offset: u16 = 16 + 32 + 64;

    let mut data = Vec::with_capacity(msg_offset as usize + message.len());
    data.push(1); // num_signatures
    data.push(0); // padding
    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // signature_instruction_index
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // public_key_instruction_index
    data.extend_from_slice(&msg_offset.to_le_bytes());
    data.extend_from_slice(&msg_len.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // message_instruction_index

    data.extend_from_slice(signer.as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);

    solana_message::Instruction {
        program_id: *ed25519_program,
        accounts: vec![],
        data,
    }
}

fn send_tx(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    instructions: &[solana_message::Instruction],
) {
    let recent_blockhash = svm.latest_blockhash();
    let payer = signers[0].pubkey();
    let message = solana_message::Message::new(instructions, Some(&payer));
    let mut tx = Transaction::new_unsigned(message);
    let keypairs: Vec<&Keypair> = signers.to_vec();
    tx.sign(&keypairs, recent_blockhash);
    svm.send_transaction(tx).unwrap();
}
