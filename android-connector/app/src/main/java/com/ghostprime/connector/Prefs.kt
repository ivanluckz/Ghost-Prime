package com.ghostprime.connector

import android.content.Context
import android.os.Build
import java.util.UUID

// Connection settings + a stable per-install device identity (so this phone is recognizable as a
// named device by the bridge). The id is generated once and persisted.
object Prefs {
    private const val FILE = "ghost_prefs"
    private fun sp(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun host(c: Context): String = sp(c).getString("host", "") ?: ""
    fun port(c: Context): Int = sp(c).getInt("port", 8731)
    fun token(c: Context): String = sp(c).getString("token", "ghost-local") ?: "ghost-local"

    fun save(c: Context, host: String, port: Int, token: String) {
        sp(c).edit().putString("host", host).putInt("port", port).putString("token", token).apply()
    }

    fun deviceId(c: Context): String {
        val sp = sp(c)
        var id = sp.getString("device_id", null)
        if (id == null) {
            id = "android-" + UUID.randomUUID().toString().substring(0, 8)
            sp.edit().putString("device_id", id).apply()
        }
        return id
    }

    // A friendly name like "Google Pixel 8" (avoids "Google Google Pixel").
    fun deviceName(): String {
        val mk = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return if (model.startsWith(mk, ignoreCase = true)) model else "$mk $model"
    }

    fun brand(): String = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
}
