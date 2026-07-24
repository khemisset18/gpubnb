use serde::Serialize;

const DEFAULT_PAIRING_PATH: &str = "/host/pair";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingConfiguration {
    pub configured: bool,
    pub browser_url: Option<String>,
    pub stores_password: bool,
    pub explanation: &'static str,
}

pub fn pairing_configuration() -> PairingConfiguration {
    let base_url = option_env!("GPUBNB_WEB_BASE_URL")
        .map(str::trim)
        .filter(|value| is_allowed_https_origin(value));

    PairingConfiguration {
        configured: base_url.is_some(),
        browser_url: base_url.map(|value| format!("{}{DEFAULT_PAIRING_PATH}", value.trim_end_matches('/'))),
        stores_password: false,
        explanation: "La connexion s'effectue dans le navigateur avec un code temporaire. Le mot de passe n'est jamais transmis à l'application.",
    }
}

fn is_allowed_https_origin(value: &str) -> bool {
    if !value.starts_with("https://") || value.len() > 200 {
        return false;
    }

    let authority = &value[8..];
    !authority.is_empty()
        && !authority.contains(['/', '?', '#', '@', '\\'])
        && authority.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_https_origin() {
        assert!(is_allowed_https_origin("https://gpubnb.example"));
        assert!(is_allowed_https_origin("https://app.gpubnb.example:443"));
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_origins() {
        assert!(!is_allowed_https_origin("http://gpubnb.example"));
        assert!(!is_allowed_https_origin("https://gpubnb.example/path"));
        assert!(!is_allowed_https_origin("https://user@gpubnb.example"));
        assert!(!is_allowed_https_origin("javascript:alert(1)"));
    }

    #[test]
    fn pairing_never_claims_to_store_a_password() {
        assert!(!pairing_configuration().stores_password);
    }
}
