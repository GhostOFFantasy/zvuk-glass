package com.zvukglass.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Фоновое воспроизведение: сервис переднего плана с уведомлением «Сейчас играет» (обложка, название,
 * кнопки ⏮ ⏯ ⏭), экраном блокировки и кнопками гарнитуры. Сам звук играет интерфейс (WebView), сервис
 * лишь не даёт системе усыпить приложение и передаёт нажатия обратно в интерфейс.
 */
class MediaService : Service() {
    companion object {
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 7

        @Volatile private var title: String = ""
        @Volatile private var artist: String = ""
        @Volatile private var coverUrl: String = ""
        @Volatile private var playing = false
        @Volatile private var position = 0.0
        @Volatile private var duration = 0.0
        @Volatile private var art: Bitmap? = null
        @Volatile private var artFor: String = ""
        @Volatile var instance: MediaService? = null

        fun update(ctx: Context, t: String?, a: String?, cover: String?, isPlaying: Boolean, pos: Double, dur: Double) {
            title = t ?: ""
            artist = a ?: ""
            coverUrl = cover ?: ""
            playing = isPlaying
            position = pos
            duration = dur
            val s = instance
            if (s == null) {
                // сервис поднимаем, когда музыка пошла (Android разрешает это, пока приложение на экране)
                if (!isPlaying || title.isEmpty()) return
                ContextCompat.startForegroundService(ctx, Intent(ctx, MediaService::class.java))
            } else {
                s.main.post { s.refresh() }
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, MediaService::class.java))
        }
    }

    val main = Handler(Looper.getMainLooper())
    private lateinit var session: MediaSessionCompat
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL, "Воспроизведение", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Что сейчас играет и кнопки управления"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        session = MediaSessionCompat(this, "ZvukGlass").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = send("play")
                override fun onPause() = send("pause")
                override fun onSkipToNext() = send("next")
                override fun onSkipToPrevious() = send("prev")
                override fun onStop() = send("pause")
                override fun onSeekTo(pos: Long) = send("seek:" + (pos / 1000.0))
            })
            setSessionActivity(openApp())
            isActive = true
        }
        // процессор не засыпает, пока играет музыка (экран при этом гаснет как обычно)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ZvukGlass:playback").apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "toggle", "next", "prev" -> send(intent.action!!)
        }
        refresh()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // приложение смахнули из недавних — останавливаемся вместе с ним
        stopSelf()
    }

    override fun onDestroy() {
        wake?.release()
        session.isActive = false
        session.release()
        instance = null
        super.onDestroy()
    }

    private fun send(cmd: String) {
        try {
            ZgNative.command(cmd)
        } catch (_: Throwable) {
        }
    }

    private fun openApp(): PendingIntent {
        val i = packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(icon: Int, label: String, act: String, code: Int): NotificationCompat.Action {
        val i = Intent(this, MediaService::class.java).setAction(act)
        val pi = PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action(icon, label, pi)
    }

    fun refresh() {
        loadArt()
        val meta = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (duration * 1000).toLong())
        art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        session.setMetadata(meta.build())
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SEEK_TO,
                )
                .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, (position * 1000).toLong(), if (playing) 1f else 0f)
                .build(),
        )
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_zg)
            .setContentTitle(title)
            .setContentText(artist)
            .setLargeIcon(art)
            .setContentIntent(openApp())
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(action(android.R.drawable.ic_media_previous, "Предыдущий", "prev", 1))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, "Пауза", "toggle", 2)
                else action(android.R.drawable.ic_media_play, "Играть", "toggle", 2),
            )
            .addAction(action(android.R.drawable.ic_media_next, "Следующий", "next", 3))
            .setStyle(androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
        if (playing) {
            wake?.acquire(6 * 60 * 60 * 1000L)
            val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
        } else {
            wake?.release()
            // на паузе уведомление можно смахнуть, а система может выгрузить приложение — как у обычных плееров
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, n)
        }
    }

    /** Обложку грузим в фоне и обновляем уведомление, когда она пришла. */
    private fun loadArt() {
        val url = coverUrl
        if (url.isEmpty() || url == artFor) return
        artFor = url
        art = null
        thread(isDaemon = true) {
            val bmp = try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.inputStream.use { BitmapFactory.decodeStream(it) }
            } catch (_: Throwable) {
                null
            }
            if (bmp != null && artFor == url) {
                art = bmp
                main.post { if (instance != null) refresh() }
            }
        }
    }
}
