package com.ghostprime.connector

import android.app.Service
import android.content.Intent
import android.os.IBinder
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// The phone-side analog of the Chrome extension: a foreground service that long-polls the bridge's
// /poll, runs each command via CommandExecutor, and POSTs the result to /result. Identifies itself
// with a stable id + friendly name + kind=phone so it registers as a named device.
class BridgeService : Service() {
    @Volatile
    @Volatile
    private var running = false
    private var worker: Thread? = null

    companion object {
        @Volatile
        var connected = false

        @Volatile
        var lastError: String = ""
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.startForeground(this, NotificationKind.BRIDGE)
        if (!running) {
            running = true
            worker = Thread { loop() }.apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        connected = false
        worker?.interrupt()
        super.onDestroy()
    }

    private fun base() = "http://${Prefs.host(applicationContext)}:${Prefs.port(applicationContext)}"
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun loop() {
        val ctx = applicationContext
        val id = Prefs.deviceId(ctx)
        val name = Prefs.deviceName()
        val brand = Prefs.brand()
        while (running) {
            if (Prefs.host(ctx).isBlank()) {
                connected = false
                lastError = "set the bridge host"
                sleep(1500)
                continue
            }
            val token = Prefs.token(ctx)
            try {
                val url = URL(
                    "${base()}/poll?token=${enc(token)}&id=${enc(id)}&name=${enc(name)}&kind=phone&brand=${enc(brand)}"
                )
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 35000 // longer than the server's 25s long-poll hold
                    requestMethod = "GET"
                }
                conn.connect() // reached the computer; the bridge may hold this first poll for up to 25 s
                if (!connected) lastError = "reached ${Prefs.host(ctx)}, waiting for Ghost-Prime (the first reply can take 25 s)"
                val code = conn.responseCode
                if (!running) { // stopped (or re-paired) while this poll was held: don't report or run anything
                    conn.disconnect()
                    break
                }
                if (code == 200) {
                    connected = true
                    lastError = ""
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    conn.disconnect()
                    handle(body, token)
                } else {
                    connected = false
                    lastError = if (code == 403) "wrong token (HTTP 403): scan the pairing QR again" else "poll HTTP $code"
                    conn.disconnect()
                    sleep(1500)
                }
            } catch (e: Exception) {
                if (!running) break
                connected = false
                lastError = e.message ?: e.toString()
                sleep(1500)
            }
        }
    }

    private fun handle(body: String, token: String) {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || trimmed == "{}") return // idle long-poll timeout
        val cmd = JSONObject(trimmed)
        val cid = cmd.optString("id", "")
        val name = cmd.optString("cmd", "")
        if (name.isEmpty()) return
        val args = cmd.optJSONObject("args") ?: JSONObject()
        val result = try {
            JSONObject().put("id", cid).put("ok", true).put("data", CommandExecutor.execute(applicationContext, name, args))
        } catch (e: Exception) {
            JSONObject().put("id", cid).put("ok", false).put("error", e.message ?: "error")
        }
        if (cid.isNotEmpty() && cid != "fire") postResult(token, result)
    }

    private fun postResult(token: String, result: JSONObject) {
        try {
            val conn = (URL("${base()}/result?token=${enc(token)}").openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 15000
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            conn.outputStream.use { it.write(result.toString().toByteArray()) }
            conn.responseCode // force the request to flush
            conn.disconnect()
        } catch (_: Exception) {
        }
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
        }
    }
}
