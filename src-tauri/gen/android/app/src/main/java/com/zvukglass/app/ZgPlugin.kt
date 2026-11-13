package com.zvukglass.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

/** Что сейчас играет — приходит из интерфейса при каждой смене трека, паузе и перемотке. */
@InvokeArg
class NowPlaying {
    var title: String? = null
    var artist: String? = null
    var cover: String? = null
    var playing: Boolean = false
    var position: Double = 0.0
    var duration: Double = 0.0
}

@InvokeArg
class ApkArgs {
    var path: String = ""
}

/** Мост к Rust-части (src-tauri/src/mobile.rs): уведомление «Сейчас играет» и установка обновлений. */
@TauriPlugin
class ZgPlugin(private val activity: Activity) : Plugin(activity) {
    private var askedNotifications = false

    @Command
    fun update(invoke: Invoke) {
        val a = invoke.parseArgs(NowPlaying::class.java)
        MediaService.update(activity.applicationContext, a.title, a.artist, a.cover, a.playing, a.position, a.duration)
        if (a.playing) askNotifications()
        invoke.resolve()
    }

    /** Отступы системных панелей, выреза и клавиатуры (в CSS-пикселях) — для интерфейса при запуске. */
    @Command
    fun insets(invoke: Invoke) {
        val r = app.tauri.plugin.JSObject()
        r.put("json", ZgInsets.last)
        invoke.resolve(r)
    }

    @Command
    fun stop(invoke: Invoke) {
        MediaService.stop(activity.applicationContext)
        invoke.resolve()
    }

    /** Системное окно установки скачанного APK. Подпись должна совпадать с установленной версией. */
    @Command
    fun installApk(invoke: Invoke) {
        val a = invoke.parseArgs(ApkArgs::class.java)
        val file = File(a.path)
        if (!file.exists()) {
            invoke.reject("Файл обновления не найден")
            return
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        invoke.resolve()
    }

    /** Android 13+: без разрешения уведомление с кнопками не видно (музыка при этом всё равно играет). */
    private fun askNotifications() {
        if (askedNotifications || Build.VERSION.SDK_INT < 33) return
        askedNotifications = true
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
    }
}

/** Кнопки уведомления, экрана блокировки и гарнитуры → Rust → событие media:command в интерфейсе. */
object ZgNative {
    @JvmStatic
    external fun command(cmd: String)
}
