//! Bounded deserialization regression on the published, pinned0.10.4 backport.
//! Never executes the older vulnerable implementation. No crypto/key/transaction.
use borsh::BorshDeserialize;
#[derive(BorshDeserialize)]
struct PublicMarker;
fn main() {
    for count in [0u32, 1, 3] {
        let result = Vec::<PublicMarker>::try_from_slice(&count.to_le_bytes());
        let error = match result { Ok(_) => panic!("ZST vector accepted"), Err(e) => e };
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("Vectors of zero-sized types are not allowed"));
    }
    let ordinary = Vec::<u8>::try_from_slice(&[3, 0, 0, 0, 1, 2, 3]).unwrap();
    assert_eq!(ordinary, vec![1, 2, 3]);
    println!("BORSH_0_10_4_BACKPORT_PASS zst_rejections=3 ordinary_vector=PASS scanner_gate=UNCHANGED");
}
