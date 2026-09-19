//! Fail-closed provenance contract for Blender, FreeCAD and Steam.
//!
//! The Windows adapter is responsible for collecting these facts from opened
//! file/process handles using Win32 trust and file-identity APIs. The policy layer
//! accepts no path-only qualification.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplicationTrustEvidence {
    pub path_allowlisted: bool,
    pub local_volume: bool,
    pub reparse_point: bool,
    pub authenticode_trusted: bool,
    pub publisher_policy_matched: bool,
    pub verification_handle_held_through_launch: bool,
    pub verified_identity: FileIdentity,
    pub launched_identity: FileIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationTrustError {
    PathPolicy,
    RemoteVolume,
    ReparsePoint,
    Authenticode,
    PublisherPolicy,
    VerificationHandleReleased,
    FileIdentityChanged,
}

pub fn validate_application_trust(
    evidence: ApplicationTrustEvidence,
) -> Result<FileIdentity, ApplicationTrustError> {
    if !evidence.path_allowlisted {
        return Err(ApplicationTrustError::PathPolicy);
    }
    if !evidence.local_volume {
        return Err(ApplicationTrustError::RemoteVolume);
    }
    if evidence.reparse_point {
        return Err(ApplicationTrustError::ReparsePoint);
    }
    if !evidence.authenticode_trusted {
        return Err(ApplicationTrustError::Authenticode);
    }
    if !evidence.publisher_policy_matched {
        return Err(ApplicationTrustError::PublisherPolicy);
    }
    if !evidence.verification_handle_held_through_launch {
        return Err(ApplicationTrustError::VerificationHandleReleased);
    }
    if evidence.verified_identity != evidence.launched_identity {
        return Err(ApplicationTrustError::FileIdentityChanged);
    }
    Ok(evidence.launched_identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: FileIdentity = FileIdentity {
        volume_serial: 0x1122_3344_5566_7788,
        file_id: [0xAB; 16],
    };

    fn trusted() -> ApplicationTrustEvidence {
        ApplicationTrustEvidence {
            path_allowlisted: true,
            local_volume: true,
            reparse_point: false,
            authenticode_trusted: true,
            publisher_policy_matched: true,
            verification_handle_held_through_launch: true,
            verified_identity: IDENTITY,
            launched_identity: IDENTITY,
        }
    }

    #[test]
    fn fully_qualified_binary_is_accepted() {
        assert_eq!(validate_application_trust(trusted()), Ok(IDENTITY));
    }

    #[test]
    fn each_independent_trust_gate_fails_closed() {
        let cases = [
            (
                ApplicationTrustEvidence {
                    path_allowlisted: false,
                    ..trusted()
                },
                ApplicationTrustError::PathPolicy,
            ),
            (
                ApplicationTrustEvidence {
                    local_volume: false,
                    ..trusted()
                },
                ApplicationTrustError::RemoteVolume,
            ),
            (
                ApplicationTrustEvidence {
                    reparse_point: true,
                    ..trusted()
                },
                ApplicationTrustError::ReparsePoint,
            ),
            (
                ApplicationTrustEvidence {
                    authenticode_trusted: false,
                    ..trusted()
                },
                ApplicationTrustError::Authenticode,
            ),
            (
                ApplicationTrustEvidence {
                    publisher_policy_matched: false,
                    ..trusted()
                },
                ApplicationTrustError::PublisherPolicy,
            ),
            (
                ApplicationTrustEvidence {
                    verification_handle_held_through_launch: false,
                    ..trusted()
                },
                ApplicationTrustError::VerificationHandleReleased,
            ),
        ];
        for (evidence, expected) in cases {
            assert_eq!(validate_application_trust(evidence), Err(expected));
        }
    }

    #[test]
    fn replacement_between_verification_and_launch_is_rejected() {
        let mut evidence = trusted();
        evidence.launched_identity.file_id[0] ^= 0xFF;
        assert_eq!(
            validate_application_trust(evidence),
            Err(ApplicationTrustError::FileIdentityChanged)
        );

        let mut evidence = trusted();
        evidence.launched_identity.volume_serial += 1;
        assert_eq!(
            validate_application_trust(evidence),
            Err(ApplicationTrustError::FileIdentityChanged)
        );
    }
}
