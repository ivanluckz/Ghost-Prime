package com.ghostprime.connector

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.ByteArrayOutputStream

// Holds the user-granted MediaProjection and grabs a PNG frame on demand (the pixel side of the
// UI-tree + screenshot fusion). Runs as a mediaProjection foreground service, as Android 14 requires.
class ScreenCaptureService : Service() {
    companion object {
        @Volatile
        var instance: ScreenCaptureService? = null
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        fun isReady() = instance?.projection != null
    }

    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var width = 0
    private var height = 0
    private var density = 0
    @Volatile
    private var lastFrame: String? = null // Android sends no new frame while the screen is unchanged

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.startForeground(this, NotificationKind.SCREEN)
        instance = this
        val code = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
        if (code != 0 && data != null) startCapture(code, data)
        return START_NOT_STICKY
    }

    private fun startCapture(code: Int, data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val metrics = DisplayMetrics()
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        width = metrics.widthPixels
        height = metrics.heightPixels
        density = metrics.densityDpi

        projection = mpm.getMediaProjection(code, data)
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                teardown()
            }
        }, null)
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = projection?.createVirtualDisplay(
            "ghost-cap",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader!!.surface, null, null
        )
    }

    // Grab the latest frame as a base64 PNG data URL. Retries briefly if no frame is ready yet.
    fun capture(): String? {
        val r = reader ?: return null
        var image: Image? = null
        for (i in 0 until 12) {
            image = r.acquireLatestImage()
            if (image != null) break
            Thread.sleep(60)
        }
        image ?: return lastFrame // no new frame = the screen hasn't changed since the last grab
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * width
            val bmpW = width + rowPadding / pixelStride
            val bmp = Bitmap.createBitmap(bmpW, height, Bitmap.Config.ARGB_8888)
            bmp.copyPixelsFromBuffer(buffer)
            val cropped = if (rowPadding == 0) bmp else Bitmap.createBitmap(bmp, 0, 0, width, height)
            val out = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.PNG, 100, out)
            if (cropped !== bmp) bmp.recycle()
            return ("data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).also { lastFrame = it }
        } finally {
            image.close()
        }
    }

    fun size(): Pair<Int, Int> = Pair(width, height)

    private fun teardown() {
        lastFrame = null
        virtualDisplay?.release(); virtualDisplay = null
        reader?.close(); reader = null
        projection?.stop(); projection = null
    }

    override fun onDestroy() {
        teardown()
        instance = null
        super.onDestroy()
    }
}
