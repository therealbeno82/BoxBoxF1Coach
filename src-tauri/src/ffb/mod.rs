//! Native force-feedback engine: a real-time thread that reads the shared
//! telemetry snapshot, computes wheel forces (ported from the C++ FFB engine),
//! and drives a DirectInput wheel via SDL2 haptics. Controlled from the React
//! "Force Feedback" tab through Tauri commands + events.

pub mod engine;
pub mod settings;
pub mod wheel;

pub use engine::{ffb_thread, FfbCommand, FfbGauges, FfbHandle, FfbStatus};
pub use settings::FfbSettings;
pub use wheel::DeviceInfo;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread::JoinHandle;

use arc_swap::ArcSwap;

use crate::telemetry::SharedTelemetry;

/// Owns the FFB thread and exposes the shared handle for commands + the emitter.
pub struct FfbSystem {
    pub handle: Arc<FfbHandle>,
    shared: Arc<SharedTelemetry>,
    thread: Option<JoinHandle<()>>,
}

impl FfbSystem {
    pub fn start(shared: Arc<SharedTelemetry>) -> FfbSystem {
        let (tx, rx) = sync_channel::<FfbCommand>(16);
        let running = Arc::new(AtomicBool::new(true));
        let handle = Arc::new(FfbHandle {
            settings: ArcSwap::from_pointee(FfbSettings::default()),
            gauges: ArcSwap::from_pointee(FfbGauges::default()),
            status: ArcSwap::from_pointee(FfbStatus::default()),
            enabled: AtomicBool::new(true),
            cmd_tx: tx,
            running: running.clone(),
        });
        let thread = {
            let handle = handle.clone();
            let shared = shared.clone();
            std::thread::spawn(move || ffb_thread(handle, shared, rx))
        };
        FfbSystem {
            handle,
            shared,
            thread: Some(thread),
        }
    }

    pub fn stop(&mut self) {
        self.handle.running.store(false, Ordering::Relaxed);
        // The thread is usually parked in wait_timeout_while on the frame condvar
        // (up to 250 ms with no wheel open) — wake it so shutdown is immediate.
        {
            let wake = &self.shared.stats.wake;
            let _g = wake.0.lock().unwrap_or_else(|e| e.into_inner());
            wake.1.notify_one();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for FfbSystem {
    fn drop(&mut self) {
        self.stop();
    }
}
