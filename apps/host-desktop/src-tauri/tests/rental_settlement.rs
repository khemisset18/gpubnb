#[path = "../src/rental_settlement.rs"]
mod rental_settlement;

use rental_settlement::{AvailabilityMeter, SettlementTerms};

#[test]
fn two_month_rental_can_settle_full_service() {
    let two_months = 60 * 24 * 60 * 60;
    let mut meter = AvailabilityMeter::new(SettlementTerms {
        reservation_id: "reservation_two_months".into(),
        prepaid_amount_minor_units: 1_200_000,
        scheduled_seconds: two_months,
    })
    .unwrap();

    meter.record_verified_service(two_months).unwrap();
    let settlement = meter.finalize().unwrap();

    assert_eq!(settlement.host_payout_minor_units, 1_200_000);
    assert_eq!(settlement.renter_refund_minor_units, 0);
}

#[test]
fn host_is_paid_only_for_verified_machine_uptime() {
    let scheduled = 60 * 24 * 60 * 60;
    let delivered = 45 * 24 * 60 * 60;
    let mut meter = AvailabilityMeter::new(SettlementTerms {
        reservation_id: "reservation_partial_uptime".into(),
        prepaid_amount_minor_units: 1_200_000,
        scheduled_seconds: scheduled,
    })
    .unwrap();

    meter.record_verified_service(delivered).unwrap();
    let settlement = meter.finalize().unwrap();

    assert_eq!(settlement.host_payout_minor_units, 900_000);
    assert_eq!(settlement.renter_refund_minor_units, 300_000);
}
