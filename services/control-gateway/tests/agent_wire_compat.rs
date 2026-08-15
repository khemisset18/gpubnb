#![forbid(unsafe_code)]

use gpubnb_control_gateway::{
    protocol::{
        AgentMessage, ClientHello, CommandAckStatus, FenceReason, GatewayMessage, ServerHello,
    },
    CONTROL_GATEWAY_PROTOCOL_VERSION,
};
use serde_json::json;

#[test]
fn python_client_hello_field_names_deserialize_into_gateway_contract() {
    let value = json!({
        "protocolVersion": 1,
        "machineId": "machine_00000001",
        "keyVersion": 1,
        "issuedAtMs": 1_000_000,
        "nonce": "0123456789abcdef0123456789abcdef",
        "lastAckedCommandSequence": 41,
        "signatureHex": "00".repeat(64),
    });
    let hello: ClientHello = serde_json::from_value(value).unwrap();
    assert_eq!(hello.protocol_version, CONTROL_GATEWAY_PROTOCOL_VERSION);
    assert_eq!(hello.machine_id, "machine_00000001");
    assert_eq!(hello.last_acked_command_sequence, 41);
}

#[test]
fn python_agent_message_snake_case_fields_match_externally_tagged_enum() {
    let heartbeat: AgentMessage = serde_json::from_value(json!({
        "type": "HEARTBEAT",
        "sequence": 9,
        "observed_at_ms": 1_000_000,
    }))
    .unwrap();
    assert!(matches!(
        heartbeat,
        AgentMessage::Heartbeat {
            sequence: 9,
            observed_at_ms: 1_000_000,
        }
    ));

    let ack: AgentMessage = serde_json::from_value(json!({
        "type": "COMMAND_ACK",
        "command_id": "command_00000001",
        "sequence": 7,
        "status": "SUCCEEDED",
        "detail_code": "job_wake_processed",
    }))
    .unwrap();
    assert!(matches!(
        ack,
        AgentMessage::CommandAck {
            command_id,
            sequence: 7,
            status: CommandAckStatus::Succeeded,
            detail_code: Some(detail),
        } if command_id == "command_00000001" && detail == "job_wake_processed"
    ));
}

#[test]
fn gateway_server_messages_serialize_to_python_expected_shape() {
    let hello = GatewayMessage::ServerHello {
        hello: ServerHello {
            protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
            gateway_id: "gateway_eu_0001".into(),
            region: "eu-west-1".into(),
            connection_id: "conn_0123456789abcdef0123456789abcdef".into(),
            presence_ttl_seconds: 60,
            heartbeat_timeout_seconds: 45,
            resumed_after_command_sequence: 41,
        },
    };
    assert_eq!(
        serde_json::to_value(hello).unwrap(),
        json!({
            "type": "SERVER_HELLO",
            "hello": {
                "protocolVersion": 1,
                "gatewayId": "gateway_eu_0001",
                "region": "eu-west-1",
                "connectionId": "conn_0123456789abcdef0123456789abcdef",
                "presenceTtlSeconds": 60,
                "heartbeatTimeoutSeconds": 45,
                "resumedAfterCommandSequence": 41,
            }
        })
    );

    let receipt = GatewayMessage::AckReceipt {
        command_id: "command_00000001".into(),
        sequence: 7,
    };
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        json!({
            "type": "ACK_RECEIPT",
            "command_id": "command_00000001",
            "sequence": 7,
        })
    );

    let fence = GatewayMessage::Fence {
        reason: FenceReason::PresenceOwnershipLost,
    };
    assert_eq!(
        serde_json::to_value(fence).unwrap(),
        json!({
            "type": "FENCE",
            "reason": "PRESENCE_OWNERSHIP_LOST",
        })
    );
}
