package com.ghostprime.connector

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

// Setup screen: enter the bridge connection, grant the three permissions, and start/stop the
// connector. A 1s ticker reflects live status (accessibility on? screen granted? bridge connected?).
class MainActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private lateinit var host: EditText
    private lateinit var port: EditText
    private lateinit var token: EditText
    private val ui = Handler(Looper.getMainLooper())
    private val REQ_CAPTURE = 7001
    private val REQ_NOTIF = 7002

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        host = findViewById(R.id.host)
        port = findViewById(R.id.port)
        token = findViewById(R.id.token)

        host.setText(Prefs.host(this))
        port.setText(Prefs.port(this).toString())
        token.setText(Prefs.token(this))

        findViewById<Button>(R.id.save).setOnClickListener {
            Prefs.save(this, host.text.toString().trim(), port.text.toString().toIntOrNull() ?: 8731, token.text.toString().trim())
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
            restartBridge()
        }
        findViewById<Button>(R.id.accessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            Toast.makeText(this, "Turn on Ghost-Prime", Toast.LENGTH_LONG).show()
        }
        findViewById<Button>(R.id.screen).setOnClickListener { requestScreenCapture() }
        findViewById<Button>(R.id.start).setOnClickListener { startConnector() }
        findViewById<Button>(R.id.stop).setOnClickListener { stopConnector() }
    }

    override fun onResume() {
        super.onResume()
        tick()
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacksAndMessages(null)
    }

    private fun tick() {
        val a11y = GhostAccessibilityService.isReady()
        val screen = ScreenCaptureService.isReady()
        val bridge = BridgeService.connected
        val line = StringBuilder()
        line.append(if (bridge) "● Connected to Ghost-Prime\n" else "○ Not connected\n")
        line.append(if (a11y) "✓ Accessibility on\n" else "✗ Accessibility off\n")
        line.append(if (screen) "✓ Screen capture ready\n" else "✗ Screen capture not granted\n")
        line.append("Device: ${Prefs.deviceName()}")
        if (!bridge && BridgeService.lastError.isNotEmpty()) line.append("\n(${BridgeService.lastError})")
        status.text = line.toString()
        ui.postDelayed({ tick() }, 1000)
    }

    private fun requestScreenCapture() {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CAPTURE && resultCode == Activity.RESULT_OK && data != null) {
            val i = Intent(this, ScreenCaptureService::class.java)
                .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ScreenCaptureService.EXTRA_DATA, data)
            ContextCompat.startForegroundService(this, i)
            Toast.makeText(this, "Screen capture granted", Toast.LENGTH_SHORT).show()
        }
    }

    private fun ensureNotifPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
    }

    private fun startConnector() {
        if (host.text.toString().isBlank()) {
            Toast.makeText(this, "Set the bridge host first", Toast.LENGTH_LONG).show()
            return
        }
        ensureNotifPermission()
        Prefs.save(this, host.text.toString().trim(), port.text.toString().toIntOrNull() ?: 8731, token.text.toString().trim())
        ContextCompat.startForegroundService(this, Intent(this, BridgeService::class.java))
    }

    private fun stopConnector() {
        stopService(Intent(this, BridgeService::class.java))
        stopService(Intent(this, ScreenCaptureService::class.java))
    }

    private fun restartBridge() {
        stopService(Intent(this, BridgeService::class.java))
        if (host.text.toString().isNotBlank()) {
            ContextCompat.startForegroundService(this, Intent(this, BridgeService::class.java))
        }
    }
}
