//! OFFLINE migration probe. Public fixed bytes only; no runtime, signer or RPC.
use anchor_lang::{prelude::Pubkey, AccountSerialize, Event, InstructionData, ToAccountMetas};
use gpu_escrow as contract;
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|x| format!("{x:02x}")).collect() }
fn out(name: &str, bytes: &[u8]) { println!("{name}\t{}", hex(bytes)); }
fn main() {
    let k = |v| Pubkey::new_from_array([v; 32]);
    out("program_id", contract::ID.as_ref());
    let config = contract::Config {admin:k(1),pending_admin:k(2),platform:k(3),oracle:k(4),paused:true,bump:254};
    let escrow = contract::Escrow {booking:[5;32],buyer:k(6),provider:k(7),amount:u64::MAX,expected_seconds:86400,valid_seconds:43200,expires_at:1700000000,settle_after:1700003600,state:2,bump:253};
    let mut bytes=vec![]; config.try_serialize(&mut bytes).unwrap(); out("account:Config",&bytes);
    let mut bytes=vec![]; escrow.try_serialize(&mut bytes).unwrap(); out("account:Escrow",&bytes);
    out("ix:initialize_config", &contract::instruction::InitializeConfig {platform:k(3),oracle:k(4)}.data());
    out("ix:update_config", &contract::instruction::UpdateConfig {platform:k(3),oracle:k(4)}.data());
    out("ix:set_paused", &contract::instruction::SetPaused {paused:true}.data());
    out("ix:propose_admin", &contract::instruction::ProposeAdmin {pending_admin:k(2)}.data());
    out("ix:accept_admin", &contract::instruction::AcceptAdmin {}.data());
    out("ix:open", &contract::instruction::Open {booking:[5;32],amount:u64::MAX,expected_seconds:86400,expires_at:1700000000}.data());
    out("ix:propose_settlement", &contract::instruction::ProposeSettlement {valid_seconds:43200}.data());
    out("ix:dispute", &contract::instruction::Dispute {}.data());
    out("ix:finalize", &contract::instruction::Finalize {}.data());
    out("ix:resolve_dispute", &contract::instruction::ResolveDispute {valid_seconds:43200}.data());
    out("ix:refund_expired", &contract::instruction::RefundExpired {}.data());
    out("event:ConfigInitialized", &contract::ConfigInitialized {admin:k(1),platform:k(3),oracle:k(4)}.data());
    out("event:ConfigUpdated", &contract::ConfigUpdated {platform:k(3),oracle:k(4)}.data());
    out("event:PauseChanged", &contract::PauseChanged {paused:true}.data());
    out("event:AdminTransferProposed", &contract::AdminTransferProposed {current_admin:k(1),pending_admin:k(2)}.data());
    out("event:AdminTransferred", &contract::AdminTransferred {previous_admin:k(1),new_admin:k(2)}.data());
    out("event:EscrowOpened", &contract::EscrowOpened {escrow:k(8),booking:[5;32],buyer:k(6),provider:k(7),amount:u64::MAX,expected_seconds:86400,expires_at:1700000000}.data());
    out("event:SettlementProposed", &contract::SettlementProposed {escrow:k(8),valid_seconds:43200,settle_after:1700003600}.data());
    out("event:EscrowDisputed", &contract::EscrowDisputed {escrow:k(8),buyer:k(6)}.data());
    out("event:EscrowSettled", &contract::EscrowSettled {escrow:k(8),payable:100,platform_amount:5,provider_amount:95,refund:0,valid_seconds:43200}.data());
    out("event:EscrowRefunded", &contract::EscrowRefunded {escrow:k(8),buyer:k(6),amount:u64::MAX}.data());
    let metas=contract::accounts::Open {config:k(1),buyer:k(6),provider:k(7),escrow:k(8),system_program:k(9)}.to_account_metas(None);
    for (i,m) in metas.iter().enumerate() { let mut b=m.pubkey.to_bytes().to_vec();b.push(u8::from(m.is_signer));b.push(u8::from(m.is_writable));out(&format!("open_meta:{i}"),&b); }
    out("state_values", &[contract::EscrowState::Funded as u8,contract::EscrowState::SettlementProposed as u8,contract::EscrowState::Disputed as u8,contract::EscrowState::Settled as u8,contract::EscrowState::Refunded as u8]);
}
