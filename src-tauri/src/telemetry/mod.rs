//! In-process F1 telemetry core: a single UDP listener that parses the game's
//! packets and publishes a lock-free snapshot for both the webview (Coach tabs)
//! and the real-time FFB engine. Replaces the old Node UDP→WebSocket bridge.

pub mod demo;
pub mod header;
pub mod packets;
pub mod raw;
pub mod state;
pub mod udp;

pub use state::{now_ms, SharedTelemetry};
pub use udp::TelemetryCore;
