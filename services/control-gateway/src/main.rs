#![forbid(unsafe_code)]

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use gpubnb_control_gateway::{
    admin::{self, AdminState},
    config::GatewayConfig,
    metrics::GatewayMetrics,
    quic::{self, QuicState},
    registry::{GatewayRegistry, RegistryLimits},
    store::RedisStore,
};
use tokio::sync::{watch, Mutex};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_ansi(false)
        .with_target(false)
        .compact()
        .init();

    let config = Arc::new(GatewayConfig::from_env()?);
    let store = RedisStore::connect(&config.redis_url).await?;
    store
        .ping()
        .await
        .context("Redis is not ready at gateway startup")?;

    let registry = Arc::new(Mutex::new(GatewayRegistry::new(RegistryLimits {
        max_connections: config.max_connections,
        max_pending_commands_per_machine: config.max_pending_commands_per_machine,
        command_retention_ms: config.command_retention_seconds.saturating_mul(1000),
    })));
    let metrics = Arc::new(GatewayMetrics::default());
    let admin_listener = tokio::net::TcpListener::bind(config.admin_bind)
        .await
        .with_context(|| {
            format!(
                "failed to bind control-gateway admin listener {}",
                config.admin_bind
            )
        })?;

    let admin_state = AdminState {
        config: Arc::clone(&config),
        registry: Arc::clone(&registry),
        store: store.clone(),
        metrics: Arc::clone(&metrics),
    };
    let quic_state = QuicState {
        config: Arc::clone(&config),
        registry: Arc::clone(&registry),
        store,
        metrics,
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut admin_shutdown = shutdown_rx.clone();
    let mut quic_task = tokio::spawn(quic::run(quic_state, shutdown_rx));
    let mut admin_task = tokio::spawn(async move {
        info!(
            event = "control_gateway_admin_ready",
            bind = %admin_listener.local_addr()?,
            "control-gateway admin listener ready"
        );
        axum::serve(admin_listener, admin::router(admin_state))
            .with_graceful_shutdown(async move {
                while admin_shutdown.changed().await.is_ok() {
                    if *admin_shutdown.borrow() {
                        break;
                    }
                }
            })
            .await
            .context("control-gateway admin server failed")
    });

    tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            if let Err(error) = signal {
                error!(event = "control_gateway_signal_error", error = %error, "failed to receive shutdown signal");
            }
            let _ = shutdown_tx.send(true);
        }
        result = &mut quic_task => {
            let _ = shutdown_tx.send(true);
            return result.context("QUIC gateway task panicked")?;
        }
        result = &mut admin_task => {
            let _ = shutdown_tx.send(true);
            return result.context("admin gateway task panicked")?;
        }
    }

    let graceful = async {
        quic_task.await.context("QUIC gateway task panicked")??;
        admin_task.await.context("admin gateway task panicked")??;
        Ok::<(), anyhow::Error>(())
    };
    tokio::time::timeout(Duration::from_secs(15), graceful)
        .await
        .context("control gateway graceful shutdown timed out")??;
    info!(
        event = "control_gateway_stopped",
        "regional control gateway stopped cleanly"
    );
    Ok(())
}
