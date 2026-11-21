//! Public, offline compatibility vectors for the Anchor dependency migration.
//!
//! Expected discriminators were derived independently with Python SHA256 over
//! `namespace:name`; field bytes below follow the documented Borsh layout, not
//! the generated serializer. The same file must pass on both dependency graphs.
//! This does not execute SBF, a CPI, a wallet, or a financial transaction.

use anchor_lang::{AccountDeserialize, AccountSerialize, Event, InstructionData, Owner, Space, ToAccountMetas};
use anchor_lang::prelude::Pubkey;
use gpu_escrow::{accounts, instruction, Config, Escrow, ErrorCode};

fn hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len()).step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}

fn key(byte: u8) -> Pubkey { Pubkey::new_from_array([byte; 32]) }

fn check(label: &str, actual: &[u8], discriminator: &str, fields: &[&[u8]]) {
    let mut expected = hex(discriminator);
    for field in fields { expected.extend_from_slice(field); }
    assert_eq!(actual, expected, "wire changed: {label}");
    let encoded: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    println!("ANCHOR_WIRE_COMPAT name={label} hex={encoded}");
}

#[test]
fn all_instruction_discriminators_and_payloads_match_independent_bytes() {
    check("initialize_config", &instruction::InitializeConfig { platform: key(0x33), oracle: key(0x44) }.data(),
          "d07f1501c2bec446", &[&[0x33; 32], &[0x44; 32]]);
    check("update_config", &instruction::UpdateConfig { platform: key(0x33), oracle: key(0x44) }.data(),
          "1d9efcbf0a53db63", &[&[0x33; 32], &[0x44; 32]]);
    for paused in [false, true] {
        check(if paused { "set_paused_true" } else { "set_paused_false" },
              &instruction::SetPaused { paused }.data(), "5b3c7dc0b0e1a6da", &[&[u8::from(paused)]]);
    }
    check("propose_admin", &instruction::ProposeAdmin { pending_admin: key(0x22) }.data(),
          "79d6c7d4572775ea", &[&[0x22; 32]]);
    check("accept_admin", &instruction::AcceptAdmin {}.data(), "702a2d5a74b50daa", &[]);
    check("open", &instruction::Open { booking: [0x55; 32], amount: 0x0102030405060708,
          expected_seconds: 0x10203040, expires_at: -0x0102030405060708 }.data(),
          "e4dc9b47c7bd3c2d", &[&[0x55; 32], &hex("080706050403020140302010f8f8f9fafbfcfdfe")]);
    check("propose_settlement", &instruction::ProposeSettlement { valid_seconds: u32::MAX }.data(),
          "e495383d892b6a19", &[&[0xff; 4]]);
    check("dispute", &instruction::Dispute {}.data(), "d85c8092ca558749", &[]);
    check("finalize", &instruction::Finalize {}.data(), "ab3dda387f730cd9", &[]);
    check("resolve_dispute", &instruction::ResolveDispute { valid_seconds: 0 }.data(),
          "e706ca0660670ce6", &[&[0; 4]]);
    check("refund_expired", &instruction::RefundExpired {}.data(), "7699a4f42880f2fa", &[]);
}

fn config() -> Config {
    Config { admin: key(0x11), pending_admin: key(0x22), platform: key(0x33), oracle: key(0x44),
             paused: true, bump: 0xff }
}

fn escrow() -> Escrow {
    Escrow { booking: [0x55; 32], buyer: key(0x11), provider: key(0x22), amount: u64::MAX,
             expected_seconds: u32::MAX, valid_seconds: 0, expires_at: i64::MIN,
             settle_after: i64::MAX, state: 4, bump: 0xff }
}

#[test]
fn account_owners_sizes_discriminators_and_integer_bounds_match() {
    assert_eq!(Config::INIT_SPACE, 130);
    assert_eq!(Escrow::INIT_SPACE, 130);
    assert_eq!(Config::owner(), gpu_escrow::ID);
    assert_eq!(Escrow::owner(), gpu_escrow::ID);
    let mut config_bytes = Vec::new();
    config().try_serialize(&mut config_bytes).unwrap();
    check("config_account", &config_bytes, "9b0caae01efacc82",
          &[&[0x11; 32], &[0x22; 32], &[0x33; 32], &[0x44; 32], &[1, 0xff]]);
    assert_eq!(config_bytes.len(), 8 + Config::INIT_SPACE);
    let decoded = Config::try_deserialize(&mut config_bytes.as_slice()).unwrap();
    assert_eq!(decoded.admin, key(0x11));
    assert_eq!(decoded.pending_admin, key(0x22));
    assert_eq!(decoded.platform, key(0x33));
    assert_eq!(decoded.oracle, key(0x44));
    assert!(decoded.paused);
    assert_eq!(decoded.bump, 0xff);
    let mut escrow_bytes = Vec::new();
    escrow().try_serialize(&mut escrow_bytes).unwrap();
    check("escrow_account", &escrow_bytes, "1fd57bbbba16da9b",
          &[&[0x55; 32], &[0x11; 32], &[0x22; 32], &[0xff; 8], &[0xff; 4], &[0; 4],
            &hex("0000000000000080ffffffffffffff7f"), &[4, 0xff]]);
    assert_eq!(escrow_bytes.len(), 8 + Escrow::INIT_SPACE);
    let decoded = Escrow::try_deserialize(&mut escrow_bytes.as_slice()).unwrap();
    assert_eq!(decoded.booking, [0x55; 32]);
    assert_eq!(decoded.buyer, key(0x11));
    assert_eq!(decoded.provider, key(0x22));
    assert_eq!(decoded.amount, u64::MAX);
    assert_eq!(decoded.expected_seconds, u32::MAX);
    assert_eq!(decoded.valid_seconds, 0);
    assert_eq!(decoded.expires_at, i64::MIN);
    assert_eq!(decoded.settle_after, i64::MAX);
    assert_eq!((decoded.state, decoded.bump), (4, 0xff));
}

#[test]
fn account_truncation_wrong_discriminators_and_noncanonical_bool_fail_closed() {
    let mut config_bytes = Vec::new();
    config().try_serialize(&mut config_bytes).unwrap();
    for len in 0..config_bytes.len() {
        assert!(Config::try_deserialize(&mut &config_bytes[..len]).is_err(), "Config prefix {len}");
    }
    let mut escrow_bytes = Vec::new();
    escrow().try_serialize(&mut escrow_bytes).unwrap();
    for len in 0..escrow_bytes.len() {
        assert!(Escrow::try_deserialize(&mut &escrow_bytes[..len]).is_err(), "Escrow prefix {len}");
    }
    assert!(Config::try_deserialize(&mut escrow_bytes.as_slice()).is_err());
    assert!(Escrow::try_deserialize(&mut config_bytes.as_slice()).is_err());
    config_bytes[8 + 128] = 2;
    assert!(Config::try_deserialize(&mut config_bytes.as_slice()).is_err());
}

fn metas(label: &str, actual: Vec<anchor_lang::solana_program::instruction::AccountMeta>, expected: &[(u8, bool, bool)]) {
    assert_eq!(actual.len(), expected.len(), "meta count changed: {label}");
    for (meta, (byte, signer, writable)) in actual.iter().zip(expected) {
        assert_eq!((meta.pubkey, meta.is_signer, meta.is_writable), (key(*byte), *signer, *writable),
                   "account ordering or privileges changed: {label}");
    }
    let encoded = expected.iter().map(|(b, s, w)| format!("{b:02x}:{}:{}", u8::from(*s), u8::from(*w))).collect::<Vec<_>>().join(",");
    println!("ANCHOR_WIRE_COMPAT name={label} metas={encoded}");
}

#[test]
fn all_generated_account_orders_and_privileges_match() {
    metas("initialize_config_metas", accounts::InitializeConfig { admin: key(0x11), config: key(0x22), system_program: key(0x33) }.to_account_metas(None),
          &[(0x11, true, true), (0x22, false, true), (0x33, false, false)]);
    metas("admin_config_metas", accounts::AdminConfig { admin: key(0x11), config: key(0x22) }.to_account_metas(None),
          &[(0x11, true, false), (0x22, false, true)]);
    metas("accept_admin_metas", accounts::AcceptAdmin { pending_admin: key(0x11), config: key(0x22) }.to_account_metas(None),
          &[(0x11, true, false), (0x22, false, true)]);
    metas("open_metas", accounts::Open { config: key(0x11), buyer: key(0x22), provider: key(0x33), escrow: key(0x44), system_program: key(0x55) }.to_account_metas(None),
          &[(0x11, false, false), (0x22, true, true), (0x33, false, false), (0x44, false, true), (0x55, false, false)]);
    metas("propose_settlement_metas", accounts::ProposeSettlement { config: key(0x11), oracle: key(0x22), escrow: key(0x33) }.to_account_metas(None),
          &[(0x11, false, false), (0x22, true, false), (0x33, false, true)]);
    metas("dispute_metas", accounts::Dispute { buyer: key(0x11), escrow: key(0x22) }.to_account_metas(None),
          &[(0x11, true, false), (0x22, false, true)]);
    metas("finalize_metas", accounts::Finalize { config: key(0x11), escrow: key(0x22), buyer: key(0x33), provider: key(0x44), platform: key(0x55) }.to_account_metas(None),
          &[(0x11, false, false), (0x22, false, true), (0x33, false, true), (0x44, false, true), (0x55, false, true)]);
    metas("resolve_dispute_metas", accounts::ResolveDispute { config: key(0x11), admin: key(0x22), escrow: key(0x33), buyer: key(0x44), provider: key(0x55), platform: key(0x66) }.to_account_metas(None),
          &[(0x11, false, false), (0x22, true, false), (0x33, false, true), (0x44, false, true), (0x55, false, true), (0x66, false, true)]);
    metas("refund_expired_metas", accounts::RefundExpired { escrow: key(0x11), buyer: key(0x22) }.to_account_metas(None),
          &[(0x11, false, true), (0x22, false, true)]);
}

#[test]
fn program_identity_pda_derivation_and_error_codes_remain_stable() {
    assert_eq!(gpu_escrow::ID.to_bytes().as_slice(), hex("da075cb2ff5ec6817613de530c085e19168ec49553cdc4e2890017ea741a16f4"));
    for (label, seeds, expected) in [
        ("config_pda", vec![b"config".as_slice()], "7e16ace31b37c38de657fb4fd91f2fcd1d928d3155ac467b2dd1382ca184fddb"),
        ("escrow_pda", vec![b"escrow".as_slice(), &[0x55; 32]], "b66475e97f52837d0dc01d69db5f454d6e33360c655eabdfb7a2c1cefe74a7cc"),
    ] {
        let (derived, bump) = Pubkey::find_program_address(&seeds, &gpu_escrow::ID);
        assert_eq!(derived.to_bytes().as_slice(), hex(expected));
        assert_eq!(bump, 255);
        println!("ANCHOR_WIRE_COMPAT name={label} address={expected} bump={bump}");
    }
    let codes = [ErrorCode::Paused, ErrorCode::InvalidInput, ErrorCode::InvalidExpiry,
                 ErrorCode::InvalidState, ErrorCode::TooEarly, ErrorCode::Math,
                 ErrorCode::InvalidAddress, ErrorCode::SelfBooking, ErrorCode::DisputeWindowClosed,
                 ErrorCode::Unauthorized].map(u32::from);
    assert_eq!(codes, [6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009]);
    println!("ANCHOR_WIRE_COMPAT name=error_codes values={codes:?}");
}

#[test]
fn system_transfer_instruction_program_data_and_privileges_remain_stable() {
    let amount = 0x0102030405060708;
    let ix = anchor_lang::solana_program::system_instruction::transfer(&key(0x11), &key(0x22), amount);
    assert_eq!(ix.program_id, Pubkey::default());
    assert_eq!(ix.data, hex("020000000807060504030201"));
    metas("system_transfer_metas", ix.accounts, &[(0x11, true, true), (0x22, false, true)]);
    println!("ANCHOR_WIRE_COMPAT name=system_transfer_data hex=020000000807060504030201 program=11111111111111111111111111111111");
}

#[test]
fn all_event_discriminators_and_fields_match_independent_bytes() {
    check("config_initialized_event", &gpu_escrow::ConfigInitialized { admin: key(0x11), platform: key(0x33), oracle: key(0x44) }.data(),
          "b531c89c13a7b25b", &[&[0x11; 32], &[0x33; 32], &[0x44; 32]]);
    check("config_updated_event", &gpu_escrow::ConfigUpdated { platform: key(0x33), oracle: key(0x44) }.data(),
          "28f1e67a0b13c6c2", &[&[0x33; 32], &[0x44; 32]]);
    check("pause_changed_event", &gpu_escrow::PauseChanged { paused: true }.data(), "eebcd54e86d1b2da", &[&[1]]);
    check("admin_transfer_proposed_event", &gpu_escrow::AdminTransferProposed { current_admin: key(0x11), pending_admin: key(0x22) }.data(),
          "cba8af33ef681455", &[&[0x11; 32], &[0x22; 32]]);
    check("admin_transferred_event", &gpu_escrow::AdminTransferred { previous_admin: key(0x11), new_admin: key(0x22) }.data(),
          "ff93b605c7d926b3", &[&[0x11; 32], &[0x22; 32]]);
    check("escrow_opened_event", &gpu_escrow::EscrowOpened { escrow: key(0x66), booking: [0x55; 32], buyer: key(0x11), provider: key(0x22), amount: u64::MAX, expected_seconds: u32::MAX, expires_at: i64::MIN }.data(),
          "c92a60087b09d4a4", &[&[0x66; 32], &[0x55; 32], &[0x11; 32], &[0x22; 32], &[0xff; 8], &[0xff; 4], &hex("0000000000000080")]);
    check("settlement_proposed_event", &gpu_escrow::SettlementProposed { escrow: key(0x66), valid_seconds: 0, settle_after: i64::MAX }.data(),
          "8b2040cd1b9a6493", &[&[0x66; 32], &[0; 4], &hex("ffffffffffffff7f")]);
    check("escrow_disputed_event", &gpu_escrow::EscrowDisputed { escrow: key(0x66), buyer: key(0x11) }.data(),
          "844951c8b1338012", &[&[0x66; 32], &[0x11; 32]]);
    check("escrow_settled_event", &gpu_escrow::EscrowSettled { escrow: key(0x66), payable: u64::MAX, platform_amount: 1, provider_amount: u64::MAX - 1, refund: 0, valid_seconds: u32::MAX }.data(),
          "611b9637cbb3ad17", &[&[0x66; 32], &[0xff; 8], &hex("0100000000000000feffffffffffffff0000000000000000"), &[0xff; 4]]);
    check("escrow_refunded_event", &gpu_escrow::EscrowRefunded { escrow: key(0x66), buyer: key(0x11), amount: u64::MAX }.data(),
          "84d1316d878a1c51", &[&[0x66; 32], &[0x11; 32], &[0xff; 8]]);
}
