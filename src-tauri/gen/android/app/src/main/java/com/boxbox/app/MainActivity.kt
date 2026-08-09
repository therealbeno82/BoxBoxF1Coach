package com.boxbox.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

/**
 * The app's activity. Everything else under `generated/` is auto-generated and
 * says so; this file is ours.
 *
 * It exists to claim the HARDWARE BACK BUTTON. `WryActivity` would route back to
 * `webView.goBack()`, but `TauriActivity` sets `handleBackNavigation = false`
 * (this app is one page — there is no history to walk), which leaves back doing
 * the platform default: destroy the activity. Measured before this was written —
 * two `history.pushState` entries deep, one press and the process was gone. A
 * driver mid-session with an open modal would have lost the session to a stray
 * thumb.
 *
 * So back is asked of the page first. The JS side keeps a stack of things that
 * can be closed (modals, then a non-default tab) and answers `true` when it
 * closed one; anything else — including a wedged or not-yet-loaded page, which
 * returns "null" — falls through to the platform behaviour, so back can never
 * become a dead key.
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView
        if (wv == null) { fallThrough(); return }
        // evaluateJavascript's callback carries the expression's value as JSON —
        // "true" only if the page really consumed the press.
        wv.evaluateJavascript(
          "(function(){try{return !!(window.__f1AndroidBack&&window.__f1AndroidBack())}catch(e){return false}})()"
        ) { result ->
          if (result != "true") fallThrough()
        }
      }

      /** Hand the press back to the platform (which finishes the activity). */
      private fun fallThrough() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }
}
