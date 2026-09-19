//! Ephemeral local-media capability for the Windows-native data plane.
//!
//! The capability is generated from the Windows system-preferred CNG RNG, is
//! never persisted by this crate, has no Debug/Clone implementation, and is
//! compared without token-dependent early exit.

use crate::PlatformError;

pub const MEDIA_CAPABILITY_ENTROPY_BYTES: usize = 32;
pub const MEDIA_CAPABILITY_TOKEN_BYTES: usize = MEDIA_CAPABILITY_ENTROPY_BYTES * 2;

pub struct MediaCapabilityToken {
    token: [u8; MEDIA_CAPABILITY_TOKEN_BYTES],
}

impl MediaCapabilityToken {
    pub fn generate() -> Result<Self, PlatformError> {
        #[cfg(target_os = "windows")]
        {
            let mut entropy = [0u8; MEDIA_CAPABILITY_ENTROPY_BYTES];
            windows_impl::fill_random(&mut entropy)?;
            Ok(Self::from_entropy(entropy))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }

    fn from_entropy(mut entropy: [u8; MEDIA_CAPABILITY_ENTROPY_BYTES]) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut token = [0u8; MEDIA_CAPABILITY_TOKEN_BYTES];
        for (index, byte) in entropy.iter().copied().enumerate() {
            token[index * 2] = HEX[(byte >> 4) as usize];
            token[index * 2 + 1] = HEX[(byte & 0x0f) as usize];
        }
        for byte in &mut entropy {
            // SAFETY: byte is uniquely borrowed within the fixed local entropy
            // array. Volatile clearing prevents this explicit wipe being removed.
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
        Self { token }
    }

    pub fn as_str(&self) -> &str {
        // from_entropy produces only lowercase ASCII hexadecimal bytes.
        std::str::from_utf8(&self.token).expect("media capability is ASCII")
    }

    pub fn matches(&self, presented: &str) -> bool {
        let candidate = presented.as_bytes();
        if candidate.len() != self.token.len() {
            return false;
        }

        let mut difference = 0u8;
        for (expected, actual) in self.token.iter().zip(candidate) {
            difference |= expected ^ actual;
        }
        difference == 0
    }
}

impl Drop for MediaCapabilityToken {
    fn drop(&mut self) {
        // Volatile stores make the best effort explicit: the in-struct secret
        // copy must not remain solely because the optimizer proves it dead.
        for byte in &mut self.token {
            // SAFETY: byte is a valid, uniquely borrowed u8 inside self and the
            // volatile write stays within the fixed token array.
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::MEDIA_CAPABILITY_ENTROPY_BYTES;
    use crate::PlatformError;
    use std::ffi::c_void;
    use std::ptr;

    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    const STATUS_SUCCESS: i32 = 0;

    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut c_void,
            buffer: *mut u8,
            buffer_len: u32,
            flags: u32,
        ) -> i32;
    }

    pub(super) fn fill_random(
        output: &mut [u8; MEDIA_CAPABILITY_ENTROPY_BYTES],
    ) -> Result<(), PlatformError> {
        // SAFETY: a null algorithm handle is required with
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG; output is writable for buffer_len.
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                output.as_mut_ptr(),
                output.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != STATUS_SUCCESS {
            return Err(PlatformError::RandomGenerationFailed);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_entropy_encodes_as_exact_lowercase_hex() {
        let token = MediaCapabilityToken::from_entropy([0xab; MEDIA_CAPABILITY_ENTROPY_BYTES]);
        assert_eq!(token.as_str(), "ab".repeat(MEDIA_CAPABILITY_ENTROPY_BYTES));
        assert_eq!(token.as_str().len(), MEDIA_CAPABILITY_TOKEN_BYTES);
    }

    #[test]
    fn matching_is_exact_case_sensitive_and_length_fenced() {
        let token = MediaCapabilityToken::from_entropy([0x5a; MEDIA_CAPABILITY_ENTROPY_BYTES]);
        let exact = token.as_str().to_owned();
        assert!(token.matches(&exact));

        let mut wrong = exact.clone().into_bytes();
        wrong[17] ^= 1;
        assert!(!token.matches(std::str::from_utf8(&wrong).expect("ASCII")));
        assert!(!token.matches(&exact.to_ascii_uppercase()));
        assert!(!token.matches(&exact[..exact.len() - 1]));
        assert!(!token.matches(&(exact + "0")));
    }

    #[test]
    fn capability_has_agent_compatible_entropy_and_alphabet() {
        let token = MediaCapabilityToken::from_entropy([0x01; MEDIA_CAPABILITY_ENTROPY_BYTES]);
        assert!(token.as_str().len() >= 32);
        assert!(
            token
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn generation_fails_closed_off_windows() {
        assert!(matches!(
            MediaCapabilityToken::generate(),
            Err(PlatformError::WindowsRequired)
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn generated_capabilities_are_nonzero_and_distinct() {
        let first = MediaCapabilityToken::generate().expect("first random capability");
        let second = MediaCapabilityToken::generate().expect("second random capability");
        assert_ne!(first.as_str(), "0".repeat(MEDIA_CAPABILITY_TOKEN_BYTES));
        assert_ne!(first.as_str(), second.as_str());
    }
}
