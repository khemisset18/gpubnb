#![forbid(unsafe_code)]

use std::env;

use ed25519_dalek::SigningKey;
use gpubnb_control_gateway::{
    protocol::{CommandAckStatus, LeaseBinding, MachinePhase},
    store::{
        command_ack_key, machine_auth_key, machine_phase_fence_key, machine_presence_key,
        resource_lease_key, CommandAckRecord, PhaseUpdateOutcome, RedisStore, TouchOutcome,
    },
};
use redis::AsyncCommands;

#[tokio::test]
async fn redis_presence_fencing_phase_fencing_and_lease_validation_are_atomic() {
    let Ok(redis_url) = env::var("REDIS_URL") else {
        eprintln!("REDIS_URL not set; skipping Redis contract test");
        return;
    };
    let store = RedisStore::connect(&redis_url).await.unwrap();
    let client = redis::Client::open(redis_url).unwrap();
    let mut redis = client.get_multiplexed_async_connection().await.unwrap();

    let machine_id = "machine_redis_contract_0001";
    let resource_id = "resource_redis_contract_001";
    let command_id = "command_redis_ack_0001";
    let signing = SigningKey::from_bytes(&[11_u8; 32]);
    let public_key = bs58::encode(signing.verifying_key().to_bytes()).into_string();

    let _: i64 = redis::cmd("HSET")
        .arg(machine_auth_key(machine_id))
        .arg("agentPublicKey")
        .arg(&public_key)
        .arg("keyVersion")
        .arg("1")
        .arg("status")
        .arg("ACTIVE")
        .query_async(&mut redis)
        .await
        .unwrap();

    let resolved = store.resolve_machine_key(machine_id, 1).await.unwrap();
    assert_eq!(resolved.to_bytes(), signing.verifying_key().to_bytes());

    let first = store
        .claim_presence(machine_id, "gateway_eu_0001", "eu-west-1", 1_000, 60)
        .await
        .unwrap();
    assert_eq!(
        store
            .touch_presence(machine_id, &first.connection_id, 1, 1_100, 60)
            .await
            .unwrap(),
        TouchOutcome::Accepted { sequence: 1 }
    );
    assert!(matches!(
        store
            .touch_presence(machine_id, &first.connection_id, 1, 1_101, 60)
            .await
            .unwrap(),
        TouchOutcome::Rejected { ref reason, .. } if reason == "STALE_SEQUENCE"
    ));

    let second = store
        .claim_presence(machine_id, "gateway_eu_0002", "eu-west-1", 1_200, 60)
        .await
        .unwrap();
    assert!(matches!(
        store
            .touch_presence(machine_id, &first.connection_id, 2, 1_201, 60)
            .await
            .unwrap(),
        TouchOutcome::Rejected { ref reason, .. } if reason == "STALE_CONNECTION"
    ));

    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &second.connection_id,
                "7",
                1,
                MachinePhase::Reserved,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Updated
    );
    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &second.connection_id,
                "6",
                99,
                MachinePhase::Available,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Rejected("STALE_FENCE".into())
    );
    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &second.connection_id,
                "7",
                1,
                MachinePhase::Reserved,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Existing
    );
    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &second.connection_id,
                "7",
                1,
                MachinePhase::Rented,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Rejected("PHASE_SEQUENCE_CONFLICT".into())
    );
    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &second.connection_id,
                "7",
                2,
                MachinePhase::Preparing,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Updated
    );

    let third = store
        .claim_presence(machine_id, "gateway_eu_0003", "eu-west-1", 1_300, 60)
        .await
        .unwrap();
    let phase_before_resume: String = redis
        .hget(machine_presence_key(machine_id), "phase")
        .await
        .unwrap();
    assert_eq!(phase_before_resume, "DRAINING");
    assert_eq!(
        store
            .set_authoritative_phase(
                machine_id,
                &third.connection_id,
                "7",
                2,
                MachinePhase::Preparing,
            )
            .await
            .unwrap(),
        PhaseUpdateOutcome::Existing
    );
    let phase_after_resume: String = redis
        .hget(machine_presence_key(machine_id), "phase")
        .await
        .unwrap();
    assert_eq!(phase_after_resume, "PREPARING");

    assert!(store
        .record_command_ack(CommandAckRecord {
            machine_id,
            connection_id: &second.connection_id,
            command_id,
            sequence: 1,
            status: CommandAckStatus::Succeeded,
            detail_code: Some("stale_socket"),
            acknowledged_at_ms: 1_399,
        })
        .await
        .is_err());
    let stale_ack_exists: bool = redis
        .exists(command_ack_key(machine_id, command_id))
        .await
        .unwrap();
    assert!(!stale_ack_exists);

    store
        .record_command_ack(CommandAckRecord {
            machine_id,
            connection_id: &third.connection_id,
            command_id,
            sequence: 1,
            status: CommandAckStatus::Succeeded,
            detail_code: Some("done"),
            acknowledged_at_ms: 1_400,
        })
        .await
        .unwrap();
    store
        .record_command_ack(CommandAckRecord {
            machine_id,
            connection_id: &third.connection_id,
            command_id,
            sequence: 1,
            status: CommandAckStatus::Accepted,
            detail_code: None,
            acknowledged_at_ms: 1_401,
        })
        .await
        .unwrap();
    let status_after_late_accepted: String = redis
        .hget(command_ack_key(machine_id, command_id), "status")
        .await
        .unwrap();
    assert_eq!(status_after_late_accepted, "SUCCEEDED");
    assert!(store
        .record_command_ack(CommandAckRecord {
            machine_id,
            connection_id: &third.connection_id,
            command_id,
            sequence: 1,
            status: CommandAckStatus::Failed,
            detail_code: Some("late_conflict"),
            acknowledged_at_ms: 1_402,
        })
        .await
        .is_err());
    let status_after_conflict: String = redis
        .hget(command_ack_key(machine_id, command_id), "status")
        .await
        .unwrap();
    assert_eq!(status_after_conflict, "SUCCEEDED");

    let lease = LeaseBinding {
        resource_id: resource_id.into(),
        holder_id: "booking_redis_contract_01".into(),
        lease_id: "lease_redis_contract_0001".into(),
        fencing_token: "9".into(),
    };
    let lease_key = resource_lease_key(resource_id);
    let _: i64 = redis::cmd("HSET")
        .arg(&lease_key)
        .arg("holderId")
        .arg(&lease.holder_id)
        .arg("leaseId")
        .arg(&lease.lease_id)
        .arg("fencingToken")
        .arg(&lease.fencing_token)
        .query_async(&mut redis)
        .await
        .unwrap();
    let _: bool = redis.pexpire(&lease_key, 60_000).await.unwrap();
    store.assert_active_lease(&lease).await.unwrap();

    let _: i64 = redis::cmd("DEL")
        .arg(machine_auth_key(machine_id))
        .arg(machine_presence_key(machine_id))
        .arg(machine_phase_fence_key(machine_id))
        .arg(command_ack_key(machine_id, command_id))
        .arg(lease_key)
        .query_async(&mut redis)
        .await
        .unwrap();
}
