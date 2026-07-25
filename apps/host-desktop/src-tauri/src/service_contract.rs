use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

const MAX_ID_LEN: usize = 64;
const MAX_CLOCK_SKEW_SECONDS: u64 = 120;
const MAX_REPLAY_ENTRIES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceCommand {
    ReadStatus,
    CertifyHost,
    SetMiningEnabled,
    AcceptReservation,
    ConfirmMinerStopped,
    ConfirmWorkspaceReady,
    FinishRental,
    ConfirmCleanup,
    EmergencyStop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceRequest {
    pub request_id: String,
    pub installation_id: String,
    pub issued_at_unix_seconds: u64,
    pub command: ServiceCommand,
    pub enabled: Option<bool>,
}

impl ServiceRequest {
    pub fn validate_shape(&self, now_unix_seconds: u64) -> Result<(), &'static str> {
        validate_identifier(&self.request_id)?;
        validate_identifier(&self.installation_id)?;

        let skew = now_unix_seconds.abs_diff(self.issued_at_unix_seconds);
        if skew > MAX_CLOCK_SKEW_SECONDS {
            return Err("service_request_expired");
        }

        match self.command {
            ServiceCommand::SetMiningEnabled if self.enabled.is_none() => {
                Err("service_request_missing_enabled")
            }
            ServiceCommand::SetMiningEnabled => Ok(()),
            _ if self.enabled.is_some() => Err("service_request_unexpected_enabled"),
            _ => Ok(()),
        }
    }
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return Err("service_request_invalid_identifier");
    }

    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("service_request_invalid_identifier");
    }

    Ok(())
}

#[derive(Debug, Default)]
pub struct ReplayGuard {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl ReplayGuard {
    pub fn accept(&mut self, request: &ServiceRequest) -> Result<(), &'static str> {
        if self.seen.contains(&request.request_id) {
            return Err("service_request_replayed");
        }

        self.seen.insert(request.request_id.clone());
        self.order.push_back(request.request_id.clone());

        while self.order.len() > MAX_REPLAY_ENTRIES {
            if let Some(expired) = self.order.pop_front() {
                self.seen.remove(&expired);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(command: ServiceCommand) -> ServiceRequest {
        ServiceRequest {
            request_id: "request_123".into(),
            installation_id: "install_123".into(),
            issued_at_unix_seconds: 1_000,
            command,
            enabled: None,
        }
    }

    #[test]
    fn command_contract_has_no_arbitrary_shell_variant() {
        let serialized = serde_json::to_string(&ServiceCommand::EmergencyStop)
            .expect("command should serialize");
        assert_eq!(serialized, "\"emergency_stop\"");
        assert!(serde_json::from_str::<ServiceCommand>("\"shell\"").is_err());
        assert!(serde_json::from_str::<ServiceCommand>("\"run_command\"").is_err());
    }

    #[test]
    fn rejects_stale_or_future_requests() {
        let stale = request(ServiceCommand::ReadStatus);
        assert_eq!(stale.validate_shape(1_121), Err("service_request_expired"));
        assert_eq!(stale.validate_shape(879), Err("service_request_expired"));
    }

    #[test]
    fn mining_command_requires_exact_boolean_payload() {
        let missing = request(ServiceCommand::SetMiningEnabled);
        assert_eq!(
            missing.validate_shape(1_000),
            Err("service_request_missing_enabled")
        );

        let mut valid = missing;
        valid.enabled = Some(true);
        assert_eq!(valid.validate_shape(1_000), Ok(()));

        let mut unexpected = request(ServiceCommand::EmergencyStop);
        unexpected.enabled = Some(false);
        assert_eq!(
            unexpected.validate_shape(1_000),
            Err("service_request_unexpected_enabled")
        );
    }

    #[test]
    fn identifiers_reject_paths_urls_and_control_characters() {
        for invalid in [
            "../secret",
            "https://evil.example",
            "user@host",
            "with space",
            "line\nbreak",
            "",
        ] {
            let mut candidate = request(ServiceCommand::ReadStatus);
            candidate.request_id = invalid.into();
            assert_eq!(
                candidate.validate_shape(1_000),
                Err("service_request_invalid_identifier")
            );
        }
    }

    #[test]
    fn replayed_request_is_rejected() {
        let request = request(ServiceCommand::ReadStatus);
        let mut guard = ReplayGuard::default();
        assert_eq!(guard.accept(&request), Ok(()));
        assert_eq!(guard.accept(&request), Err("service_request_replayed"));
    }
}
