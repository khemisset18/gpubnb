use serde::Serialize;

const DEFAULT_PAIRING_PATH: &str = "/host-install.html";
const ALLOWED_PAIRING_ORIGINS: [&str; 3] = [
    "https://gpubnb.com",
    "https://app.gpubnb.com",
    "https://gpubnb.netlify.app",
];

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
        .filter(|value| is_allowed_pairing_origin(value));

    PairingConfiguration {
        configured: base_url.is_some(),
        browser_url: base_url.map(|value| format!("{value}{DEFAULT_PAIRING_PATH}")),
        stores_password: false,
        explanation: "La connexion s'effectue sur le site officiel. Un code à usage unique valable dix minutes associe cet ordinateur sans transmettre ni stocker votre mot de passe.",
    }
}

fn is_allowed_pairing_origin(value: &str) -> bool {
    ALLOWED_PAIRING_ORIGINS.contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_official_pairing_origins() {
        assert!(is_allowed_pairing_origin("https://gpubnb.com"));
        assert!(is_allowed_pairing_origin("https://app.gpubnb.com"));
        assert!(is_allowed_pairing_origin("https://gpubnb.netlify.app"));
    }

    #[test]
    fn rejects_lookalike_or_ambiguous_origins() {
        assert!(!is_allowed_pairing_origin("http://gpubnb.com"));
        assert!(!is_allowed_pairing_origin(
            "https://gpubnb.com.evil.example"
        ));
        assert!(!is_allowed_pairing_origin("https://app.gpubnb.com:443"));
        assert!(!is_allowed_pairing_origin("https://gpubnb.com/path"));
        assert!(!is_allowed_pairing_origin("https://user@gpubnb.com"));
        assert!(!is_allowed_pairing_origin("javascript:alert(1)"));
    }

    #[test]
    fn pairing_never_claims_to_store_a_password() {
        let pairing = pairing_configuration();
        assert!(!pairing.stores_password);
        if let Some(url) = pairing.browser_url {
            assert!(url.ends_with("/host-install.html"));
        }
    }
}
