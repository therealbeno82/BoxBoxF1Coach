package com.boxbox.plugin.f1android

import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.view.WindowManager
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

@InvokeArg
class SpeakArgs {
    lateinit var text: String
    var rate: Double = 1.0
    var pitch: Double = 1.0
    var voice: String? = null
    var flush: Boolean = true
}

@InvokeArg
class KeepAwakeArgs {
    var enabled: Boolean = false
}

/**
 * The coach's voice on Android, plus the two device concerns a WebView can't
 * reach: keeping the screen on and holding the Wi-Fi multicast lock.
 *
 * The load-bearing design choice is that `speak` DEFERS ITS INVOKE and settles it
 * from [UtteranceProgressListener]. That makes one `speak` call a promise that
 * resolves when the phrase has actually finished, which is the contract the app's
 * speech arbiter already expects from its other two engines — without it the JS
 * side would need a separate event channel and a correlation table to know when a
 * call ended, and the arbiter would talk over itself.
 */
@TauriPlugin
class F1AndroidPlugin(private val activity: Activity) : Plugin(activity) {
    private var tts: TextToSpeech? = null

    @Volatile private var ready = false
    // Set when the engine came up but has no usable voice data for the language —
    // recoverable by the user (Settings ▸ TTS ▸ install voice data), so it is
    // reported rather than treated as a hard failure.
    @Volatile private var initError: String? = null

    // Utterance id → the Invoke parked until that utterance ends. Touched from the
    // TTS callback thread as well as the plugin's, hence the concurrent map.
    private val pending = ConcurrentHashMap<String, Invoke>()
    private val seq = AtomicLong(0)

    private var mcLock: WifiManager.MulticastLock? = null

    override fun load(webView: WebView) {
        // applicationContext, not the Activity: the engine outlives a rotation and
        // holding the Activity here would leak it.
        tts = TextToSpeech(activity.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val engine = tts
                val lang = engine?.setLanguage(Locale.UK) ?: TextToSpeech.ERROR
                if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                    // Fall back to whatever the device does have rather than going
                    // silent — an American voice still coaches.
                    val fallback = engine?.setLanguage(Locale.US) ?: TextToSpeech.ERROR
                    if (fallback == TextToSpeech.LANG_MISSING_DATA || fallback == TextToSpeech.LANG_NOT_SUPPORTED) {
                        initError = "no English voice data installed"
                    }
                }
                ready = true
            } else {
                initError = "text-to-speech engine unavailable"
            }
            trigger("tts_ready", JSObject().put("ready", ready).put("error", initError))
        }

        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            // Done, interrupted and failed all mean the same thing to the caller:
            // this phrase is over, take the next one. A rejection here would only
            // make the arbiter's queue stall on a phrase nobody can hear anyway.
            override fun onDone(utteranceId: String?) = settle(utteranceId)
            // The no-code overload is deprecated but still abstract, so it has to
            // be implemented; older engines are the ones that call it.
            @Suppress("OVERRIDE_DEPRECATION")
            override fun onError(utteranceId: String?) = settle(utteranceId)
            override fun onError(utteranceId: String?, errorCode: Int) = settle(utteranceId)
            override fun onStop(utteranceId: String?, interrupted: Boolean) = settle(utteranceId)
        })
    }

    private fun settle(utteranceId: String?) {
        if (utteranceId == null) return
        pending.remove(utteranceId)?.resolve()
    }

    @Command
    fun isReady(invoke: Invoke) {
        invoke.resolve(JSObject().put("ready", ready).put("error", initError))
    }

    @Command
    fun speak(invoke: Invoke) {
        val args = invoke.parseArgs(SpeakArgs::class.java)
        val engine = tts
        if (engine == null || !ready) {
            invoke.reject(initError ?: "text-to-speech is not ready")
            return
        }

        engine.setSpeechRate(args.rate.toFloat())
        engine.setPitch(args.pitch.toFloat())
        args.voice?.let { wanted ->
            try {
                engine.voices?.firstOrNull { it.name == wanted }?.let { engine.voice = it }
            } catch (_: Exception) {
                // Some engines throw out of `voices` entirely; the default voice
                // is still fine, so this is not worth failing the call over.
            }
        }

        val id = "u" + seq.incrementAndGet()
        // Park BEFORE speaking: a very short phrase can complete before speak()
        // returns, and the listener must find the invoke already in the map.
        pending[id] = invoke
        val mode = if (args.flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        val result = engine.speak(args.text, mode, null, id)
        if (result != TextToSpeech.SUCCESS) {
            pending.remove(id)?.reject("text-to-speech refused the phrase")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        // Every parked invoke settles through onStop; nothing to drain by hand.
        tts?.stop()
        invoke.resolve()
    }

    @Command
    fun voices(invoke: Invoke) {
        val list = JSArray()
        try {
            tts?.voices
                ?.filter { it.locale.language == Locale.ENGLISH.language }
                // The app is built to work with no network at a race weekend, so a
                // voice that needs a round trip to synthesise is worse than useless.
                ?.filter { !it.isNetworkConnectionRequired }
                ?.sortedBy { it.name }
                ?.forEach { v ->
                    list.put(
                        JSObject()
                            .put("name", v.name)
                            .put("locale", v.locale.toLanguageTag())
                            .put("quality", qualityName(v))
                    )
                }
        } catch (_: Exception) {
            // Leave the list empty — the UI falls back to "Default".
        }
        invoke.resolve(JSObject().put("voices", list))
    }

    private fun qualityName(v: Voice): String = when {
        v.quality >= Voice.QUALITY_VERY_HIGH -> "very high"
        v.quality >= Voice.QUALITY_HIGH -> "high"
        v.quality >= Voice.QUALITY_NORMAL -> "normal"
        else -> "low"
    }

    @Command
    fun setKeepAwake(invoke: Invoke) {
        val on = invoke.parseArgs(KeepAwakeArgs::class.java).enabled
        // Window flags are UI-thread-only.
        activity.runOnUiThread {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        invoke.resolve()
    }

    @Command
    fun acquireMulticastLock(invoke: Invoke) {
        if (mcLock != null) { invoke.resolve(); return }
        try {
            val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            mcLock = wifi.createMulticastLock("f1coach-telemetry").apply {
                // Not reference counted: acquire/release are driven by the app
                // coming to and going from the foreground, which can fire unevenly.
                setReferenceCounted(false)
                acquire()
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("could not take the Wi-Fi multicast lock", e)
        }
    }

    @Command
    fun releaseMulticastLock(invoke: Invoke) {
        try { mcLock?.release() } catch (_: Exception) {}
        mcLock = null
        invoke.resolve()
    }

    override fun onPause() {
        // Backgrounded: the lock costs battery and nothing is arriving anyway
        // (Android freezes the app's threads within seconds).
        try { mcLock?.release() } catch (_: Exception) {}
        mcLock = null
    }

    override fun onDestroy(activity: AppCompatActivity) {
        tts?.stop()
        tts?.shutdown()
        tts = null
        try { mcLock?.release() } catch (_: Exception) {}
        mcLock = null
    }
}
