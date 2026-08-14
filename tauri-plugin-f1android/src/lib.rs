//! F1 Coach's Android bridge — three jobs the WebView can't do for itself.
//!
//! * **Speech.** The Android System WebView does not reliably implement the Web
//!   Speech API, and the desktop build's neural voice (Kokoro, ~90 MB of weights
//!   plus a 21 MB ONNX runtime) is deliberately stripped from the Android bundle.
//!   So the coach talks through `android.speech.tts.TextToSpeech` instead.
//! * **Keep-awake.** `navigator.wakeLock` needs a secure context; the WebView is
//!   served from `http://tauri.localhost`, which isn't one. `FLAG_KEEP_SCREEN_ON`
//!   is the supported way to hold a phone awake next to the wheel.
//! * **The Wi-Fi multicast lock.** Only matters when the game is set to BROADCAST
//!   telemetry rather than unicast it at the phone's own address, but without one
//!   Android's power-save filter silently drops the frames.
//!
//! Every command forwards to the Kotlin plugin and is therefore Android-only; on
//! any other target they compile, and fail with a plain message. The app's
//! dependency table only pulls this crate in for Android, so that path is really
//! only there to keep `cargo check` honest off-device.
//!
//! `speak` RESOLVES WHEN THE PHRASE FINISHES, not when it starts. The Kotlin side
//! parks the `Invoke` and settles it from `UtteranceProgressListener`, which is
//! what lets the speech arbiter in BoxBoxApp treat it exactly like the Kokoro and
//! Web Speech paths (`play()` advances its queue on the same `onDone`). It's an
//! async command, so the wait is a suspended future rather than a blocked thread.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

// Must match the Kotlin package exactly — Tauri resolves the plugin class as
// `<identifier>.<class name>` by reflection at registration time.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.boxbox.plugin.f1android";

#[cfg(target_os = "android")]
struct F1Android<R: Runtime>(PluginHandle<R>);

/// Forward one call to the Kotlin plugin and await its `resolve`/`reject`.
async fn call<R: Runtime, A: Serialize>(
    app: &AppHandle<R>,
    method: &str,
    args: A,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        // Clone the handle out of state rather than holding the `State` borrow
        // across the await.
        let handle = app.state::<F1Android<R>>().0.clone();
        handle
            .run_mobile_plugin_async::<Value>(method, args)
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, method, args);
        Err("f1android is an Android-only plugin".to_string())
    }
}

/// Speak `text`, resolving when the utterance ENDS (or is stopped/errors).
///
/// `flush` preempts whatever is speaking, which is the arbiter's own semantics —
/// an urgent corner call must not queue behind a debrief.
#[tauri::command]
async fn speak<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    rate: Option<f64>,
    pitch: Option<f64>,
    voice: Option<String>,
    flush: Option<bool>,
) -> Result<Value, String> {
    call(
        &app,
        "speak",
        json!({
            "text": text,
            "rate": rate.unwrap_or(1.0),
            "pitch": pitch.unwrap_or(1.0),
            "voice": voice,
            "flush": flush.unwrap_or(true),
        }),
    )
    .await
}

/// Silence the engine. Every parked `speak` resolves via `onStop`.
#[tauri::command]
async fn stop<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    call(&app, "stop", json!({})).await
}

/// The installed voices, already filtered to ones usable offline.
#[tauri::command]
async fn voices<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    call(&app, "voices", json!({})).await
}

/// `{ ready, error }` — the engine initialises asynchronously and may come back
/// missing its language data, which is a user-fixable condition, not a failure.
#[tauri::command]
async fn is_ready<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    call(&app, "isReady", json!({})).await
}

/// Write `contents` to a `content://` URI returned by the system Save dialog.
///
/// Android's picker hands back a SAF URI, not a path, so the app's own
/// `write_text_file` (a `std::fs::write`) cannot open it — only the
/// ContentResolver can. Same arrangement as on desktop, different handle.
#[tauri::command]
async fn write_document<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
    contents: String,
    base64: Option<bool>,
) -> Result<Value, String> {
    call(
        &app,
        "writeDocument",
        json!({ "uri": uri, "contents": contents, "base64": base64.unwrap_or(false) }),
    )
    .await
}

/// Hold the screen on (`FLAG_KEEP_SCREEN_ON`) while telemetry is arriving.
#[tauri::command]
async fn set_keep_awake<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<Value, String> {
    call(&app, "setKeepAwake", json!({ "enabled": enabled })).await
}

/// Take the Wi-Fi multicast lock so broadcast telemetry survives power save.
#[tauri::command]
async fn acquire_multicast_lock<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    call(&app, "acquireMulticastLock", json!({})).await
}

/// Release it again — it costs battery, so it's held only while in front.
#[tauri::command]
async fn release_multicast_lock<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    call(&app, "releaseMulticastLock", json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("f1android")
        .invoke_handler(tauri::generate_handler![
            speak,
            stop,
            voices,
            is_ready,
            write_document,
            set_keep_awake,
            acquire_multicast_lock,
            release_multicast_lock,
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "F1AndroidPlugin")?;
                _app.manage(F1Android(handle));
            }
            Ok(())
        })
        .build()
}
