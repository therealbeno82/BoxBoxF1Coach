use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

mod ffb;
mod telemetry;

use ffb::{DeviceInfo, FfbCommand, FfbHandle, FfbSettings, FfbSystem};
use telemetry::{now_ms, TelemetryCore};

// Default UDP port the game broadcasts telemetry on.
const DEFAULT_UDP_PORT: u16 = 20777;

/// Holds the running telemetry core so commands can reach it and the app can shut
/// it down cleanly on exit.
struct CoreState {
    core: Mutex<TelemetryCore>,
}

/// Holds the running FFB system (thread) for shutdown on exit.
struct FfbState {
    system: Mutex<FfbSystem>,
}

/// Stop flag for the emitter thread, so it winds down on exit like the core and
/// FFB threads do (it wakes every ~33 ms, so no join is needed).
struct EmitterState {
    running: Arc<AtomicBool>,
}

// ── Telemetry commands ──────────────────────────────────────────────────────

/// Re-point the UDP listener at a different port (custom-port / rebroadcaster
/// setups). The core rebinds live.
#[tauri::command]
fn set_udp_port(port: u16, state: tauri::State<CoreState>) {
    if let Ok(core) = state.core.lock() {
        core.set_port(port);
    }
}

/// One of this machine's network addresses, surfaced to console players who run
/// the app on a second device: the game's telemetry output must target the PC's
/// LAN IP, and this is how the UI tells them which address to enter.
#[derive(serde::Serialize)]
struct LocalAddr {
    /// Interface name (e.g. "Wi-Fi", "Ethernet") — helps pick the right one.
    name: String,
    ip: String,
}

/// List this machine's non-loopback IPv4 addresses. Private LAN ranges
/// (192.168/10./172.16–31) sort first, since a console on the same network
/// reaches the PC through one of those.
#[tauri::command]
fn get_local_ips() -> Vec<LocalAddr> {
    use std::net::IpAddr;
    let mut out: Vec<LocalAddr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, ip)| match ip {
            // Drop loopback (127.x) and APIPA link-local (169.254.x) — neither is
            // reachable from another device.
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => {
                Some(LocalAddr { name, ip: v4.to_string() })
            }
            _ => None,
        })
        .collect();
    out.sort_by_key(|a| !is_private_v4(&a.ip));
    out
}

/// True for RFC-1918 private ranges — the addresses a LAN device would use.
fn is_private_v4(ip: &str) -> bool {
    ip.starts_with("192.168.")
        || ip.starts_with("10.")
        // 172.16.0.0–172.31.255.255
        || ip
            .strip_prefix("172.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|oct| oct.parse::<u8>().ok())
            .is_some_and(|second| (16..=31).contains(&second))
}

/// Toggle synthetic-telemetry mode (a fake lap for testing with no game).
#[tauri::command]
fn set_fake_mode(enabled: bool, state: tauri::State<CoreState>) {
    if let Ok(core) = state.core.lock() {
        core.set_fake(enabled);
    }
}

/// Current synthetic-telemetry state. The Settings toggle reads this once on
/// boot so an `F1_FAKE=1` launch is reflected in the UI rather than being
/// silently overwritten by the saved preference.
#[tauri::command]
fn get_fake_mode(state: tauri::State<CoreState>) -> bool {
    state.core.lock().map(|core| core.is_fake()).unwrap_or(false)
}

// ── FFB commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_ffb_devices(handle: tauri::State<Arc<FfbHandle>>) -> Vec<DeviceInfo> {
    let (tx, rx) = sync_channel(1);
    if handle.cmd_tx.send(FfbCommand::Enumerate(tx)).is_err() {
        return vec![];
    }
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
}

#[tauri::command]
fn open_ffb_device(index: i32, handle: tauri::State<Arc<FfbHandle>>) -> Result<String, String> {
    let (tx, rx) = sync_channel(1);
    handle
        .cmd_tx
        .send(FfbCommand::Open(index, tx))
        .map_err(|_| "FFB engine offline".to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "FFB engine timed out opening the device".to_string())?
}

#[tauri::command]
fn close_ffb_device(handle: tauri::State<Arc<FfbHandle>>) {
    let _ = handle.cmd_tx.send(FfbCommand::Close);
}

#[tauri::command]
fn set_ffb_settings(settings: FfbSettings, handle: tauri::State<Arc<FfbHandle>>) {
    handle.settings.store(Arc::new(settings));
}

/// The engine's default tuning — the single source of truth the UI seeds its
/// sliders / "Reset all" from (no hand-mirrored copy in JS).
#[tauri::command]
fn get_ffb_defaults() -> FfbSettings {
    FfbSettings::default()
}

#[tauri::command]
fn set_ffb_enabled(enabled: bool, handle: tauri::State<Arc<FfbHandle>>) {
    handle.enabled.store(enabled, Ordering::Relaxed);
}

/// Reset the "peak lateral force this session" tracker (Auto Max Force panel).
#[tauri::command]
fn reset_ffb_peak(handle: tauri::State<Arc<FfbHandle>>) {
    let _ = handle.cmd_tx.send(FfbCommand::ResetPeak);
}

// ── File export ───────────────────────────────────────────────────────────────

/// Write UTF-8 text to `path`, which the frontend obtained from the dialog
/// plugin's Save dialog. Writing here (rather than via the fs plugin) keeps the
/// destination unrestricted without opening an fs scope — the path is one the
/// user just picked, so it's exactly where they want the file.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save the file: {e}"))
}

// ── Emitter: bridge in-process state to the webview via Tauri events ─────────
// Samples the shared state at ~30 Hz but only emits what actually changed:
// every writer stores a fresh Arc, so Arc::ptr_eq against the last-emitted
// value is an exact "nothing new" test — an idle app costs no IPC. The FFB
// engine reads the shared telemetry directly at full rate — the UI event
// cadence never affects FFB latency.
fn spawn_emitter(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    let shared = {
        let core = app.state::<CoreState>();
        let core = core.core.lock().unwrap_or_else(|e| e.into_inner());
        core.shared.clone()
    };
    let ffb = app.state::<Arc<FfbHandle>>().inner().clone();

    /// Remember `cur` and report whether it differs (by pointer) from last time.
    fn changed<T>(last: &mut Option<Arc<T>>, cur: &Arc<T>) -> bool {
        if last.as_ref().is_some_and(|p| Arc::ptr_eq(p, cur)) {
            return false;
        }
        *last = Some(cur.clone());
        true
    }

    std::thread::spawn(move || {
        let mut last_core: Option<(bool, u16)> = None;
        let mut last_snap = None;
        let mut last_gauges = None;
        let mut last_status = None;
        while running.load(Ordering::Relaxed) {
            let now = now_ms();
            let got_packet = shared.got_packet.load(Ordering::Relaxed);
            let core = (
                shared.stats.receiving(now, 1500),
                shared.udp_port.load(Ordering::Relaxed),
            );
            if last_core != Some(core) {
                last_core = Some(core);
                let _ = app.emit(
                    "core_status",
                    serde_json::json!({
                        "receiving": core.0,
                        "udpPort": core.1,
                    }),
                );
            }
            if got_packet {
                let snap = shared.ui.load_full();
                if changed(&mut last_snap, &snap) {
                    let _ = app.emit("telemetry", snap.as_ref());
                }
            }
            let gauges = ffb.gauges.load_full();
            if changed(&mut last_gauges, &gauges) {
                let _ = app.emit("ffb_gauges", gauges.as_ref());
            }
            let status = ffb.status.load_full();
            if changed(&mut last_status, &status) {
                let _ = app.emit("ffb_status", status.as_ref());
            }
            std::thread::sleep(Duration::from_millis(33));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Optional dev switch: F1_FAKE=1 starts the core in synthetic-telemetry mode.
    let fake = std::env::var("F1_FAKE").ok().as_deref() == Some("1");
    let core = TelemetryCore::start(DEFAULT_UDP_PORT, fake);
    let ffb = FfbSystem::start(core.shared.clone());
    let ffb_handle = ffb.handle.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreState {
            core: Mutex::new(core),
        })
        .manage(FfbState {
            system: Mutex::new(ffb),
        })
        .manage(ffb_handle)
        .invoke_handler(tauri::generate_handler![
            set_udp_port,
            get_local_ips,
            set_fake_mode,
            get_fake_mode,
            get_ffb_devices,
            open_ffb_device,
            close_ffb_device,
            set_ffb_settings,
            get_ffb_defaults,
            set_ffb_enabled,
            reset_ffb_peak,
            write_text_file,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let running = Arc::new(AtomicBool::new(true));
            app.manage(EmitterState { running: running.clone() });
            spawn_emitter(app.handle().clone(), running);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<EmitterState>() {
                    state.running.store(false, Ordering::Relaxed);
                }
                if let Some(state) = app_handle.try_state::<FfbState>() {
                    if let Ok(mut sys) = state.system.lock() {
                        sys.stop();
                    }
                }
                if let Some(state) = app_handle.try_state::<CoreState>() {
                    if let Ok(mut core) = state.core.lock() {
                        core.stop();
                    }
                }
            }
        });
}
