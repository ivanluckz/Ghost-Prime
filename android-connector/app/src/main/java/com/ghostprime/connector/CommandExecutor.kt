package com.ghostprime.connector

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

// Maps the bridge's command names (the same vocabulary scripts/fake-phone.mjs proved) onto real
// Android capabilities. Runs on the bridge worker thread; throws are reported back as { ok:false }.
object CommandExecutor {
    fun execute(ctx: Context, cmd: String, args: JSONObject): JSONObject = when (cmd) {
        "screenshot" -> screenshot()
        "uiDump" -> a11y().dumpTree()
        "tap" -> tap(args)
        "swipe" -> swipe(args)
        "type" -> type(args)
        "key" -> key(args)
        "openApp" -> openApp(ctx, args)
        "info" -> info()
        else -> throw IllegalArgumentException("unknown command: $cmd")
    }

    private fun a11y() = GhostAccessibilityService.instance
        ?: throw IllegalStateException("Accessibility service off — enable Ghost-Prime in Settings → Accessibility")

    private fun screenshot(): JSONObject {
        val svc = ScreenCaptureService.instance
            ?: throw IllegalStateException("Screen capture not granted — tap 'Grant screen capture' in the app")
        val img = svc.capture() ?: throw IllegalStateException("couldn't grab a frame")
        val (w, h) = svc.size()
        return JSONObject().put("image", img).put("w", w).put("h", h)
    }

    private fun tap(args: JSONObject): JSONObject {
        if (args.has("text")) return JSONObject().put("ok", a11y().clickByText(args.getString("text")))
        val x = args.optDouble("x", -1.0)
        val y = args.optDouble("y", -1.0)
        if (x < 0 || y < 0) throw IllegalArgumentException("tap needs x,y (pixels) or text")
        return JSONObject().put("ok", a11y().tap(x.toFloat(), y.toFloat())).put("x", x).put("y", y)
    }

    private fun swipe(args: JSONObject): JSONObject {
        val ok = a11y().swipe(
            args.optDouble("x1").toFloat(), args.optDouble("y1").toFloat(),
            args.optDouble("x2").toFloat(), args.optDouble("y2").toFloat(),
            args.optLong("durationMs", 300)
        )
        return JSONObject().put("ok", ok)
    }

    private fun type(args: JSONObject): JSONObject =
        JSONObject().put("ok", a11y().typeText(args.optString("text", "")))

    private fun key(args: JSONObject): JSONObject {
        val svc = a11y()
        val ok = when (args.optString("key", "").lowercase()) {
            "back" -> svc.back()
            "home" -> svc.home()
            "recents", "overview" -> svc.recents()
            else -> throw IllegalArgumentException("key must be back | home | recents")
        }
        return JSONObject().put("ok", ok)
    }

    private fun openApp(ctx: Context, args: JSONObject): JSONObject {
        val pkg = args.optString("package", "")
        val url = args.optString("url", "")
        return when {
            url.isNotEmpty() -> {
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                JSONObject().put("ok", true).put("url", url)
            }
            pkg.isNotEmpty() -> {
                val i = ctx.packageManager.getLaunchIntentForPackage(pkg)
                    ?: throw IllegalArgumentException("app not installed: $pkg")
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                JSONObject().put("ok", true).put("app", pkg)
            }
            else -> throw IllegalArgumentException("openApp needs 'package' or 'url'")
        }
    }

    private fun info(): JSONObject = JSONObject()
        .put("a11y", GhostAccessibilityService.isReady())
        .put("screen", ScreenCaptureService.isReady())
        .put("name", Prefs.deviceName())
}
