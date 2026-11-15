//! Exercises the actual Borsh trait re-exported by the locked Anchor dependency.
//! No dependency override, account layout change, or on-chain operation.
use anchor_lang::AnchorDeserialize;
use std::io::{ErrorKind, Read, Result};
use std::sync::atomic::{AtomicUsize, Ordering};

static DESERIALIZER_CALLS: AtomicUsize = AtomicUsize::new(0);

// Intentionally neither Copy nor Clone: this is the advisory's type category.
#[derive(Debug)]
struct NonCloneZeroSized;

impl AnchorDeserialize for NonCloneZeroSized {
    fn deserialize_reader<R: Read>(_reader: &mut R) -> Result<Self> {
        DESERIALIZER_CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(Self)
    }
}

#[test]
fn rejects_zero_sized_vectors_before_deserializing_any_element() {
    assert_eq!(std::mem::size_of::<NonCloneZeroSized>(), 0);
    // Small cases execute first, so an old vulnerable implementation fails
    // immediately rather than iterating a huge hostile declared length.
    for count in [0_u32, 1, 1_000, u32::MAX] {
        let result = Vec::<NonCloneZeroSized>::try_from_slice(&count.to_le_bytes());
        let error = result.expect_err("ZST vector must fail closed");
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
        assert_eq!(DESERIALIZER_CALLS.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn ordinary_vector_bytes_remain_compatible_and_truncation_is_rejected() {
    let encoded = [2, 0, 0, 0, 0x34, 0x12, 0xcd, 0xab];
    assert_eq!(Vec::<u16>::try_from_slice(&encoded).unwrap(), vec![0x1234, 0xabcd]);
    assert!(Vec::<u16>::try_from_slice(&encoded[..7]).is_err());
    assert_eq!(Vec::<u16>::try_from_slice(&[0, 0, 0, 0]).unwrap(), Vec::<u16>::new());
}
