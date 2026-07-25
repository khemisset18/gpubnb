use serde::{Deserialize, Serialize};

const MAX_IDENTIFIER_LEN: usize = 96;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettlementTerms {
    pub reservation_id: String,
    pub prepaid_amount_minor_units: u64,
    pub scheduled_seconds: u64,
}

impl SettlementTerms {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identifier(&self.reservation_id)?;
        if self.prepaid_amount_minor_units == 0 {
            return Err("settlement_amount_required");
        }
        if self.scheduled_seconds == 0 {
            return Err("settlement_duration_required");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RentalSettlement {
    pub reservation_id: String,
    pub prepaid_amount_minor_units: u64,
    pub verified_service_seconds: u64,
    pub scheduled_seconds: u64,
    pub host_payout_minor_units: u64,
    pub renter_refund_minor_units: u64,
}

#[derive(Clone, Debug)]
pub struct AvailabilityMeter {
    terms: SettlementTerms,
    verified_service_seconds: u64,
    finalized: bool,
}

impl AvailabilityMeter {
    pub fn new(terms: SettlementTerms) -> Result<Self, &'static str> {
        terms.validate()?;
        Ok(Self {
            terms,
            verified_service_seconds: 0,
            finalized: false,
        })
    }

    pub fn record_verified_service(&mut self, seconds: u64) -> Result<(), &'static str> {
        if self.finalized {
            return Err("settlement_already_finalized");
        }
        if seconds == 0 {
            return Ok(());
        }
        self.verified_service_seconds = self
            .verified_service_seconds
            .saturating_add(seconds)
            .min(self.terms.scheduled_seconds);
        Ok(())
    }

    pub fn finalize(&mut self) -> Result<RentalSettlement, &'static str> {
        if self.finalized {
            return Err("settlement_already_finalized");
        }

        let payout = (u128::from(self.terms.prepaid_amount_minor_units)
            * u128::from(self.verified_service_seconds)
            / u128::from(self.terms.scheduled_seconds)) as u64;
        let refund = self.terms.prepaid_amount_minor_units - payout;
        self.finalized = true;

        Ok(RentalSettlement {
            reservation_id: self.terms.reservation_id.clone(),
            prepaid_amount_minor_units: self.terms.prepaid_amount_minor_units,
            verified_service_seconds: self.verified_service_seconds,
            scheduled_seconds: self.terms.scheduled_seconds,
            host_payout_minor_units: payout,
            renter_refund_minor_units: refund,
        })
    }
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("settlement_invalid_identifier");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> SettlementTerms {
        SettlementTerms {
            reservation_id: "reservation_001".into(),
            prepaid_amount_minor_units: 10_000,
            scheduled_seconds: 3_600,
        }
    }

    #[test]
    fn full_service_releases_all_funds_to_host() {
        let mut meter = AvailabilityMeter::new(terms()).unwrap();
        meter.record_verified_service(3_600).unwrap();
        let settlement = meter.finalize().unwrap();
        assert_eq!(settlement.host_payout_minor_units, 10_000);
        assert_eq!(settlement.renter_refund_minor_units, 0);
    }

    #[test]
    fn partial_service_is_paid_proportionally() {
        let mut meter = AvailabilityMeter::new(terms()).unwrap();
        meter.record_verified_service(1_800).unwrap();
        let settlement = meter.finalize().unwrap();
        assert_eq!(settlement.host_payout_minor_units, 5_000);
        assert_eq!(settlement.renter_refund_minor_units, 5_000);
    }

    #[test]
    fn overreported_service_never_exceeds_prepaid_amount() {
        let mut meter = AvailabilityMeter::new(terms()).unwrap();
        meter.record_verified_service(50_000).unwrap();
        let settlement = meter.finalize().unwrap();
        assert_eq!(settlement.verified_service_seconds, 3_600);
        assert_eq!(settlement.host_payout_minor_units, 10_000);
    }

    #[test]
    fn settlement_cannot_be_finalized_twice() {
        let mut meter = AvailabilityMeter::new(terms()).unwrap();
        meter.finalize().unwrap();
        assert_eq!(meter.finalize(), Err("settlement_already_finalized"));
    }
}
