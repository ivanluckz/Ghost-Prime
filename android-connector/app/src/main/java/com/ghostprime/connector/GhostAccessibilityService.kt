package com.ghostprime.connector

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Cross-app control without root/adb: read the live UI tree and perform taps/swipes/typing + global
// BACK/HOME/RECENTS. A static instance lets the bridge worker call in from its own thread.
class GhostAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: GhostAccessibilityService? = null
        fun isReady() = instance != null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)
    fun recents() = performGlobalAction(GLOBAL_ACTION_RECENTS)

    // Tap at absolute screen pixels via a synthesized gesture (works across apps).
    fun tap(x: Float, y: Float, timeoutMs: Long = 4000): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        return dispatchBlocking(GestureDescription.Builder().addStroke(stroke).build(), timeoutMs)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 300, timeoutMs: Long = 4000): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(50, 5000))
        return dispatchBlocking(GestureDescription.Builder().addStroke(stroke).build(), timeoutMs + durationMs)
    }

    private fun dispatchBlocking(gesture: GestureDescription, timeoutMs: Long): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        val posted = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) {
                ok = true
                latch.countDown()
            }

            override fun onCancelled(d: GestureDescription?) {
                ok = false
                latch.countDown()
            }
        }, null)
        if (!posted) return false
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return ok
    }

    // Set text on the currently focused editable field (or the first editable one found).
    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }
            ?: firstEditable(root) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    // Click the first node whose text/content-desc matches, climbing to a clickable ancestor.
    fun clickByText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        for (n in root.findAccessibilityNodeInfosByText(text)) {
            var node: AccessibilityNodeInfo? = n
            var hops = 0
            while (node != null && hops < 6) {
                if (node.isClickable) return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                node = node.parent
                hops++
            }
        }
        return false
    }

    private fun firstEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val r = firstEditable(node.getChild(i))
            if (r != null) return r
        }
        return null
    }

    // Compact JSON of the interesting on-screen nodes — the structured side of the fusion.
    fun dumpTree(maxNodes: Int = 120): JSONObject {
        val nodes = JSONArray()
        val root = rootInActiveWindow
        val pkg = root?.packageName?.toString() ?: ""
        if (root != null) walk(root, nodes, maxNodes)
        return JSONObject().put("package", pkg).put("nodes", nodes)
    }

    private fun walk(node: AccessibilityNodeInfo?, out: JSONArray, max: Int) {
        if (node == null || out.length() >= max) return
        val text = node.text?.toString()?.trim()
        val desc = node.contentDescription?.toString()?.trim()
        val interesting = node.isClickable || node.isEditable || node.isCheckable ||
            !text.isNullOrEmpty() || !desc.isNullOrEmpty()
        if (interesting) {
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.width() > 0 && r.height() > 0) {
                val o = JSONObject()
                if (!text.isNullOrEmpty()) o.put("text", text.take(120))
                if (!desc.isNullOrEmpty()) o.put("desc", desc.take(120))
                node.className?.toString()?.substringAfterLast('.')?.let { if (it.isNotEmpty()) o.put("role", it) }
                o.put("bounds", JSONArray(listOf(r.left, r.top, r.right, r.bottom)))
                if (node.isClickable) o.put("clickable", true)
                if (node.isEditable) o.put("editable", true)
                out.put(o)
            }
        }
        for (i in 0 until node.childCount) walk(node.getChild(i), out, max)
    }
}
