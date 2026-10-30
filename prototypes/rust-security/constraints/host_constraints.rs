//! Host-only generated account validation and instruction metadata.
//! Public fixed pubkeys and in-memory account fixtures; no handler, CPI, signer,
//! transaction, validator, wallet, private key, or network operation is invoked.
use anchor_lang::{prelude::*, AccountSerialize, ToAccountMetas};
use gpu_escrow as contract;
use std::collections::BTreeSet;

fn k(n: u8) -> Pubkey { Pubkey::new_from_array([n; 32]) }
fn bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut out = vec![];
    value.try_serialize(&mut out).unwrap();
    out
}
fn account(key: Pubkey, owner: Pubkey, data: Vec<u8>, signer: bool, writable: bool) -> AccountInfo<'static> {
    // Solana3 removes the deprecated rent_epoch constructor argument. This
    // fixture-only adapter changes no contract source or account bytes.
    #[cfg(feature = "probe-anchor-v1")]
    let info = AccountInfo::new(Box::leak(Box::new(key)), signer, writable,
        Box::leak(Box::new(1_000_000_000)), Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)), false);
    #[cfg(not(feature = "probe-anchor-v1"))]
    let info =
    AccountInfo::new(Box::leak(Box::new(key)), signer, writable,
        Box::leak(Box::new(1_000_000_000)), Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)), false, 0);
    info
}
fn fixture(case: &str) -> Vec<AccountInfo<'static>> {
    let (config_key, config_bump) = Pubkey::find_program_address(&[b"config"], &contract::ID);
    let booking = [5u8; 32];
    let (escrow_key, escrow_bump) = Pubkey::find_program_address(&[b"escrow", &booking], &contract::ID);
    let buyer = k(6);
    let provider = k(7);
    let platform = if case == "finalize_alias_provider_platform" { provider } else { k(3) };
    let config = contract::Config { admin:k(1), pending_admin:k(2), platform, oracle:k(4), paused:false, bump:config_bump };
    let escrow = contract::Escrow { booking, buyer, provider, amount:1_000_000,
        expected_seconds:1000, valid_seconds:500, expires_at:1_700_000_000,
        settle_after:1_700_003_600, state:1, bump:escrow_bump };
    let mut config_bytes = bytes(&config);
    if case == "admin_bad_discriminator" { config_bytes[0] ^= 1; }
    if case == "admin_bad_boolean" { config_bytes[136] = 2; }
    let config_info = account(if case == "admin_wrong_seed" { k(90) } else { config_key },
        if case == "admin_wrong_owner" { k(91) } else { contract::ID },
        config_bytes, false, case != "admin_readonly");
    let escrow_info = account(escrow_key,
        if case == "finalize_wrong_owner" { k(92) } else { contract::ID },
        bytes(&escrow), false, case != "finalize_readonly");
    let admin_info = account(if case == "admin_wrong_authority" { k(93) } else { k(1) },
        k(0), vec![], case != "admin_missing_signer", false);
    let buyer_info = account(if case == "finalize_wrong_buyer" || case == "dispute_wrong_buyer" { k(94) } else { buyer },
        k(0), vec![], case != "dispute_missing_signer", true);
    let provider_info = account(if case == "finalize_wrong_provider" { k(95) } else { provider }, k(0), vec![], false, true);
    let platform_info = if case == "finalize_alias_provider_platform" { provider_info.clone() } else {
        account(if case == "finalize_wrong_platform" { k(96) } else { platform }, k(0), vec![], false, true)
    };
    if case.starts_with("admin_") { vec![admin_info, config_info] }
    else if case.starts_with("dispute_") { vec![buyer_info, escrow_info] }
    else if case.starts_with("oracle_") {
        vec![config_info, account(if case == "oracle_wrong_authority" { k(97) } else { k(4) },
            k(0), vec![], case != "oracle_missing_signer", false), escrow_info]
    }
    else { vec![config_info, escrow_info, buyer_info, provider_info, platform_info] }
}
fn snapshot(accounts: &[AccountInfo<'_>]) -> Vec<(u64, Vec<u8>)> {
    accounts.iter().map(|a| (a.lamports(), a.try_borrow_data().unwrap().to_vec())).collect()
}
fn outcome(result: anchor_lang::Result<()>) -> String {
    match result {
        Ok(()) => "OK".to_string(),
        Err(anchor_lang::error::Error::AnchorError(e)) => format!("{}:{}", e.error_name, e.error_code_number),
        Err(e) => format!("PROGRAM_ERROR:{e}"),
    }
}
fn main() {
    for case in ["admin_valid", "admin_missing_signer", "admin_wrong_authority", "admin_readonly",
        "admin_wrong_owner", "admin_wrong_seed", "admin_bad_discriminator", "admin_bad_boolean",
        "dispute_valid", "dispute_missing_signer", "dispute_wrong_buyer",
        "oracle_valid", "oracle_wrong_authority", "oracle_missing_signer",
        "finalize_valid", "finalize_wrong_owner", "finalize_readonly", "finalize_wrong_buyer",
        "finalize_wrong_provider", "finalize_wrong_platform", "finalize_alias_provider_platform"] {
        let accounts: &'static [AccountInfo<'static>] = Box::leak(fixture(case).into_boxed_slice());
        let before = snapshot(accounts);
        let mut view = accounts;
        let mut reallocs = BTreeSet::new();
        let result = if case.starts_with("admin_") {
            contract::AdminConfig::try_accounts(&contract::ID, &mut view, &[], &mut Default::default(), &mut reallocs).map(|_| ())
        } else if case.starts_with("dispute_") {
            contract::Dispute::try_accounts(&contract::ID, &mut view, &[], &mut Default::default(), &mut reallocs).map(|_| ())
        } else if case.starts_with("oracle_") {
            contract::ProposeSettlement::try_accounts(&contract::ID, &mut view, &[], &mut Default::default(), &mut reallocs).map(|_| ())
        } else {
            contract::Finalize::try_accounts(&contract::ID, &mut view, &[], &mut Default::default(), &mut reallocs).map(|_| ())
        };
        assert_eq!(before, snapshot(accounts), "validation mutated fixture {case}");
        println!("constraint:{case}\t{}", outcome(result));
    }
    macro_rules! metas {
        ($name:literal, $value:expr) => {
            for (i, m) in $value.to_account_metas(None).iter().enumerate() {
                let hex: String = m.pubkey.as_ref().iter().map(|x| format!("{x:02x}")).collect();
                println!("meta:{}:{i}\t{hex}:{}{}", $name, u8::from(m.is_signer), u8::from(m.is_writable));
            }
        }
    }
    metas!("initialize_config", contract::accounts::InitializeConfig {admin:k(1),config:k(2),system_program:k(9)});
    metas!("update_config", contract::accounts::AdminConfig {admin:k(1),config:k(2)});
    metas!("set_paused", contract::accounts::AdminConfig {admin:k(1),config:k(2)});
    metas!("propose_admin", contract::accounts::AdminConfig {admin:k(1),config:k(2)});
    metas!("accept_admin", contract::accounts::AcceptAdmin {pending_admin:k(1),config:k(2)});
    metas!("open", contract::accounts::Open {config:k(2),buyer:k(6),provider:k(7),escrow:k(8),system_program:k(9)});
    metas!("propose_settlement", contract::accounts::ProposeSettlement {config:k(2),oracle:k(4),escrow:k(8)});
    metas!("dispute", contract::accounts::Dispute {buyer:k(6),escrow:k(8)});
    metas!("finalize", contract::accounts::Finalize {config:k(2),escrow:k(8),buyer:k(6),provider:k(7),platform:k(3)});
    metas!("resolve_dispute", contract::accounts::ResolveDispute {config:k(2),admin:k(1),escrow:k(8),buyer:k(6),provider:k(7),platform:k(3)});
    metas!("refund_expired", contract::accounts::RefundExpired {escrow:k(8),buyer:k(6)});
}
