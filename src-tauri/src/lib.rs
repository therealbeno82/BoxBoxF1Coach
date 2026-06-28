use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Holds the running bridge sidecar so we can shut it down when the app exits.
// Without this the f1-bridge.exe process (and its WebSocket server on :9001)
// would be orphaned after the window closes.
struct BridgeProcess(Mutex<Option<CommandChild>>);

// Start the bundled UDP→WebSocket bridge sidecar. It reads the game's UDP
// telemetry on 20777 and serves it over ws://localhost:9001 — exactly what the
// app's Setup tab already connects to. Replaces the old manual `npm run bridge`.
fn spawn_bridge(app: &tauri::AppHandle) {
    let sidecar = match app.shell().sidecar("f1-bridge") {
        Ok(cmd) => cmd,
        Err(e) => {
            log::error!("could not create bridge sidecar command: {e}");
            return;
        }
    };

    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            app.state::<BridgeProcess>().0.lock().unwrap().replace(child);
            // Drain the sidecar's stdout/stderr into our log so its status
            // ("WebSocket up …", "no packets yet …") is visible in dev.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            log::info!("[bridge] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            log::warn!("[bridge] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[bridge] exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => log::error!("failed to spawn bridge sidecar: {e}"),
    }
}

// Kill the bridge sidecar if it's still running (called on app exit).
fn stop_bridge(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<BridgeProcess>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BridgeProcess(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            spawn_bridge(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                stop_bridge(app_handle);
            }
        });
}
