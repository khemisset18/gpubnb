//! Public recovery fixtures only: no signing, secret keys, RNG, RPC or handlers.
use anchor_lang::solana_program::secp256k1_recover::{
    secp256k1_recover, Secp256k1Pubkey, Secp256k1RecoverError,
};

fn bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
        .collect()
}

#[test]
fn actual_solana_reexport_matches_independent_public_recovery_oracle() {
    let fixtures: serde_json::Value = match std::env::var("GPUBNB_RECOVERY_FIXTURES") {
        Ok(path) => serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap(),
        Err(_) => serde_json::from_str(include_str!(
            "../../../prototypes/solana-recovery-migration/public-recovery-fixtures.json"
        ))
        .unwrap(),
    };
    assert_eq!(fixtures["schemaVersion"], 2);
    let cases = fixtures["cases"].as_array().unwrap();
    assert_eq!(
        cases.len() as u64,
        fixtures["summary"]["totalRecoveryCases"]
    );
    assert!(
        fixtures["summary"]["explicitHighSMatches"]
            .as_u64()
            .unwrap()
            > 0
    );
    for case in cases {
        let message_hash = bytes(case["hash"].as_str().unwrap());
        let signature = bytes(case["signature"].as_str().unwrap());
        let recovery_id = case["recoveryId"].as_u64().unwrap() as u8;
        let actual = secp256k1_recover(&message_hash, recovery_id, &signature);
        let expected = &case["expected"];
        if let Some(point) = expected["point"].as_str() {
            assert_eq!(
                actual.as_ref().map(|key| key.to_bytes().to_vec()),
                Ok(bytes(point)),
                "public recovery case {}",
                case["id"]
            );
        } else {
            let error = match expected["error"].as_str().unwrap() {
                "InvalidHash" => Secp256k1RecoverError::InvalidHash,
                "InvalidRecoveryId" => Secp256k1RecoverError::InvalidRecoveryId,
                "InvalidSignature" => Secp256k1RecoverError::InvalidSignature,
                unexpected => panic!("unknown independent oracle error {unexpected}"),
            };
            assert_eq!(
                actual.err(),
                Some(error),
                "public recovery case {}",
                case["id"]
            );
        }
    }
    println!("PUBLIC_RECOVERY_CASES_PASS={}", cases.len());
}

#[test]
fn wrapper_layout_and_error_codes_are_retained() {
    assert_eq!(std::mem::size_of::<Secp256k1Pubkey>(), 64);
    assert_eq!(std::mem::align_of::<Secp256k1Pubkey>(), 1);
    for (error, code) in [
        (Secp256k1RecoverError::InvalidHash, 1),
        (Secp256k1RecoverError::InvalidRecoveryId, 2),
        (Secp256k1RecoverError::InvalidSignature, 3),
    ] {
        assert_eq!(u64::from(error.clone()), code);
        assert_eq!(Secp256k1RecoverError::from(code), error);
    }
}
