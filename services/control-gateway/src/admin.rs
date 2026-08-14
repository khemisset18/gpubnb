use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::{
    config::GatewayConfig,
    metrics::GatewayMetrics,
    protocol::{CommandEnvelope, MachinePhase},
    registry::{DispatchStatus, GatewayRegistry},
    store::{PhaseUpdateOutcome, RedisStore},
};

#[derive(Clone)]
pub struct AdminState {
    pub config: Arc<GatewayConfig>,
    pub registry: Arc<Mutex<GatewayRegistry>>,
    pub store: RedisStore,
    pub metrics: Arc<GatewayMetrics>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    gateway_id: String,
    region: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandDispatchResponse {
    accepted: bool,
    status: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PhaseUpdateRequest {
    connection_id: String,
    fencing_token: String,
    phase_sequence: u64,
    phase: MachinePhase,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseUpdateResponse {
    accepted: bool,
    status: String,
}

pub fn router(state: AdminState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/metrics", get(metrics))
        .route("/v1/internal/commands/{machine_id}", post(dispatch_command))
        .route(
            "/v1/internal/presence/{machine_id}/phase",
            put(update_phase),
        )
        .with_state(state)
}

async fn health(State(state): State<AdminState>) -> impl IntoResponse {
    Json(HealthResponse {
        ok: true,
        gateway_id: state.config.gateway_id.clone(),
        region: state.config.region.clone(),
    })
}

async fn ready(State(state): State<AdminState>) -> Response {
    let stats = state.registry.lock().await.stats();
    if stats.draining {
        return (StatusCode::SERVICE_UNAVAILABLE, "draining\n").into_response();
    }
    match state.store.ping().await {
        Ok(()) => (StatusCode::OK, "ready\n").into_response(),
        Err(error) => {
            state.metrics.redis_error();
            warn!(event = "control_gateway_readiness_redis_failed", error = %error, "Redis readiness check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "redis_unavailable\n").into_response()
        }
    }
}

async fn metrics(State(state): State<AdminState>) -> Response {
    let stats = state.registry.lock().await.stats();
    let body = state
        .metrics
        .render_prometheus(stats.active_connections, stats.pending_commands);
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn dispatch_command(
    State(state): State<AdminState>,
    Path(machine_id): Path<String>,
    headers: HeaderMap,
    Json(command): Json<CommandEnvelope>,
) -> Response {
    if !authorized(&headers, &state.config.internal_token) {
        return (StatusCode::UNAUTHORIZED, Json(error_json("unauthorized"))).into_response();
    }
    if command.machine_id != machine_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(error_json("machine_id_mismatch")),
        )
            .into_response();
    }
    let now_ms = match now_ms() {
        Ok(value) => value,
        Err(error) => return internal_error("clock_error", error),
    };
    if let Err(error) = command.validate(now_ms) {
        return (
            StatusCode::BAD_REQUEST,
            Json(error_json(&error.to_string())),
        )
            .into_response();
    }

    if let Some(lease) = &command.lease {
        if let Err(error) = state.store.assert_active_lease(lease).await {
            state.metrics.redis_error();
            warn!(
                event = "control_gateway_command_lease_rejected",
                machine = %machine_id,
                command = %command.command_id,
                error = %error,
                "command rejected because resource lease is not current"
            );
            return (
                StatusCode::CONFLICT,
                Json(error_json("stale_or_missing_resource_lease")),
            )
                .into_response();
        }
    }

    let command_id = command.command_id.clone();
    let outcome = {
        let mut registry = state.registry.lock().await;
        registry.dispatch(command, now_ms)
    };
    match outcome {
        Ok(outcome) => {
            state.metrics.command_enqueued();
            let status = match outcome.status {
                DispatchStatus::Delivered => "DELIVERED",
                DispatchStatus::QueuedDisconnected => "QUEUED_DISCONNECTED",
                DispatchStatus::QueuedBackpressure => {
                    state.metrics.command_backpressured();
                    "QUEUED_BACKPRESSURE"
                }
                DispatchStatus::Existing => "EXISTING",
            };
            info!(
                event = "control_gateway_command_accepted",
                machine = %machine_id,
                command = %command_id,
                dispatch_status = status,
                "control command accepted by regional gateway"
            );
            (
                StatusCode::ACCEPTED,
                Json(CommandDispatchResponse {
                    accepted: true,
                    status,
                }),
            )
                .into_response()
        }
        Err(error) => {
            let code = if error.to_string().contains("capacity") {
                StatusCode::TOO_MANY_REQUESTS
            } else if error.to_string().contains("monotonic")
                || error.to_string().contains("conflict")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            (code, Json(error_json(&error.to_string()))).into_response()
        }
    }
}

async fn update_phase(
    State(state): State<AdminState>,
    Path(machine_id): Path<String>,
    headers: HeaderMap,
    Json(update): Json<PhaseUpdateRequest>,
) -> Response {
    if !authorized(&headers, &state.config.internal_token) {
        return (StatusCode::UNAUTHORIZED, Json(error_json("unauthorized"))).into_response();
    }
    let outcome = state
        .store
        .set_authoritative_phase(
            &machine_id,
            &update.connection_id,
            &update.fencing_token,
            update.phase_sequence,
            update.phase,
        )
        .await;
    let outcome = match outcome {
        Ok(value) => value,
        Err(error) => {
            state.metrics.redis_error();
            return internal_error("phase_store_unavailable", error);
        }
    };

    match outcome {
        PhaseUpdateOutcome::Updated | PhaseUpdateOutcome::Existing => {
            if let Err(error) = state
                .registry
                .lock()
                .await
                .set_phase(&machine_id, update.phase)
            {
                return (StatusCode::CONFLICT, Json(error_json(&error.to_string())))
                    .into_response();
            }
            let status = if matches!(outcome, PhaseUpdateOutcome::Updated) {
                "UPDATED"
            } else {
                "EXISTING"
            };
            (
                StatusCode::OK,
                Json(PhaseUpdateResponse {
                    accepted: true,
                    status: status.to_owned(),
                }),
            )
                .into_response()
        }
        PhaseUpdateOutcome::Rejected(reason) => (
            StatusCode::CONFLICT,
            Json(PhaseUpdateResponse {
                accepted: false,
                status: reason,
            }),
        )
            .into_response(),
    }
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    let Some(actual) = headers
        .get("x-gpubnb-internal-token")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    constant_time_equal(actual.as_bytes(), expected.as_bytes())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn error_json(message: &str) -> serde_json::Value {
    serde_json::json!({ "error": message })
}

fn internal_error(context: &str, error: anyhow::Error) -> Response {
    warn!(event = "control_gateway_internal_error", context, error = %error, "control gateway internal error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(error_json("internal_error")),
    )
        .into_response()
}

fn now_ms() -> anyhow::Result<u64> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| anyhow::anyhow!("system clock before Unix epoch: {error}"))?;
    u64::try_from(duration.as_millis()).map_err(|_| anyhow::anyhow!("system time overflow"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_token_comparison_is_exact() {
        assert!(constant_time_equal(
            b"abcdefghijklmnopqrstuvwxyz123456",
            b"abcdefghijklmnopqrstuvwxyz123456"
        ));
        assert!(!constant_time_equal(
            b"abcdefghijklmnopqrstuvwxyz123456",
            b"abcdefghijklmnopqrstuvwxyz123457"
        ));
        assert!(!constant_time_equal(b"short", b"longer"));
    }
}
