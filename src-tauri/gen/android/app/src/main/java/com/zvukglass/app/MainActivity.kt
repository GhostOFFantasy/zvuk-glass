package com.zvukglass.app

import android.graphics.Color
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Оболочка приложения на Android.
 *  - Интерфейс рисуется на весь экран (под строкой состояния и полосой жестов), а реальные отступы
 *    системных панелей, выреза камеры и клавиатуры передаются в интерфейс (CSS-переменные).
 *  - «Назад» (кнопка или жест от края) сначала закрывает то, что открыто внутри приложения, и только
 *    на главном экране сворачивает его — не закрывает: музыка продолжает играть.
 */
class MainActivity : TauriActivity() {
    private var web: WebView? = null

    // своя обработка «Назад» вместо стандартной (та закрывала приложение вместе с музыкой)
    override val handleBackNavigation: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // тёмный интерфейс — светлые значки в строке состояния и полосе навигации
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w == null) {
                    moveTaskToBack(true)
                    return
                }
                w.evaluateJavascript("(window.ZG_back && window.ZG_back()) ? 1 : 0") { r ->
                    if (r?.trim() != "1") moveTaskToBack(true)
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        web = webView
        webView.setBackgroundColor(0xFF0B0B10.toInt())
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val d = resources.displayMetrics.density
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            ZgInsets.last = "{\"top\":${bars.top / d},\"bottom\":${bars.bottom / d},\"left\":${bars.left / d},\"right\":${bars.right / d},\"ime\":${ime.bottom / d}}"
            webView.evaluateJavascript("window.ZG_insets && window.ZG_insets(${ZgInsets.last})", null)
            insets
        }
        ViewCompat.requestApplyInsets(webView)
    }
}

/** Последние отступы экрана — интерфейс спрашивает их при запуске (страница могла загрузиться позже). */
object ZgInsets {
    @Volatile
    var last: String = ""
}
