use anchor_lang::{prelude::Pubkey, AccountDeserialize, AccountSerialize};
use gpu_escrow as contract;
#[test]
fn explicit_program_id_regression() { assert_eq!(contract::ID.to_string(), "Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m"); }
#[test]
fn config_layout_exact_and_discriminator_rejects_mutation() {
    let c=contract::Config {admin:Pubkey::new_from_array([1;32]),pending_admin:Pubkey::new_from_array([2;32]),platform:Pubkey::new_from_array([3;32]),oracle:Pubkey::new_from_array([4;32]),paused:true,bump:254};
    let mut bytes=vec![];c.try_serialize(&mut bytes).unwrap();assert_eq!(bytes.len(),138);assert_eq!(&bytes[8..40], &[1;32]);assert_eq!(bytes[136],1);assert_eq!(bytes[137],254);
    let result=contract::Config::try_deserialize(&mut bytes.as_slice()).unwrap();assert!(result.paused);assert_eq!(result.bump,254);
    bytes[0]^=1;assert!(contract::Config::try_deserialize(&mut bytes.as_slice()).is_err());
}
#[test]
fn config_rejects_every_truncation_and_invalid_boolean() {
    let c=contract::Config {admin:Pubkey::new_from_array([1;32]),pending_admin:Pubkey::new_from_array([2;32]),platform:Pubkey::new_from_array([3;32]),oracle:Pubkey::new_from_array([4;32]),paused:false,bump:1};
    let mut bytes=vec![];c.try_serialize(&mut bytes).unwrap();
    for n in 0..bytes.len(){assert!(contract::Config::try_deserialize(&mut &bytes[..n]).is_err(), "accepted truncation {n}");}
    bytes[136]=2;assert!(contract::Config::try_deserialize(&mut bytes.as_slice()).is_err());
}
