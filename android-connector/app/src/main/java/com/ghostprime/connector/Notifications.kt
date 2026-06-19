package com.ghostprime.connector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.pm.ServiceInfo

enum class NotificationKind { BRIDGE, SCREEN }

// Foreground-service notifications. minSdk 30, so channels + typed startForeground are always present.
object Notifications {
    private const val CHANNEL = "ghost_connector"
    private const val BRIDGE_ID = 1001
    private const val SCREEN_ID = 1002

    private fun ensureChannel(c: Context) {
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Ghost-Prime Connector", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun build(c: Context, text: String): Notification {
        ensureChannel(c)
        return Notification.Builder(c, CHANNEL)
            .setContentTitle("Ghost-Prime")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
    }

    fun startForeground(service: Service, kind: NotificationKind) {
        val (id, text, type) = when (kind) {
            NotificationKind.BRIDGE -> Triple(BRIDGE_ID, "Connected to Ghost-Prime", ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            NotificationKind.SCREEN -> Triple(SCREEN_ID, "Screen capture ready", ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        }
        service.startForeground(id, build(service, text), type)
    }
}
