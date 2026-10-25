package ca.pelhamhills.starter

import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 웹 화면(`frontend/lib/starter/bridge.ts`)과 주고받는 곳. 모양은 그 파일의 머리말과 같다.
 *
 * - 웹 → 앱: `PelhamStarterNative.call(id, method, args)` → 일이 끝나면 `window.__pelhamStarter.reply(...)`.
 * - 앱 → 웹: `window.__pelhamStarter.request(id, method, args)` → 웹이 `PelhamStarterNative.reply(...)`.
 *   지금은 Stripe 연결 토큰 하나뿐이다. 직원 로그인 토큰은 웹에 남고 앱으로 오지 않는다.
 */
class WebBridge(
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val handle: suspend (method: String, args: JSONObject) -> Any?,
) {
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private val seq = AtomicInteger()

    @JavascriptInterface
    fun call(id: String, method: String, args: String) {
        scope.launch {
            try {
                val result = handle(method, if (args.isBlank()) JSONObject() else JSONObject(args))
                send("reply", id, true, payload(result))
            } catch (e: Exception) {
                send("reply", id, false, JSONObject().put("message", e.message ?: e.javaClass.simpleName).toString())
            }
        }
    }

    @JavascriptInterface
    fun reply(id: String, ok: Boolean, payload: String) {
        val deferred = waiting.remove(id) ?: return
        val body = try {
            JSONObject(payload)
        } catch (e: Exception) {
            JSONObject().put("message", payload)
        }
        if (ok) deferred.complete(body) else deferred.completeExceptionally(IllegalStateException(body.optString("message", "The screen refused.")))
    }

    /** 웹에 묻는다. 화면이 닫혔거나 답이 없으면 20초 뒤 실패. */
    suspend fun request(method: String, args: JSONObject = JSONObject()): JSONObject {
        val id = "n${seq.incrementAndGet()}"
        val deferred = CompletableDeferred<JSONObject>()
        waiting[id] = deferred
        send("request", id, method, args.toString())
        return try {
            withTimeout(20_000) { deferred.await() }
        } finally {
            waiting.remove(id)
        }
    }

    private fun send(fn: String, id: String, second: Any, third: String) {
        val arg2 = if (second is Boolean) second.toString() else JSONObject.quote(second.toString())
        val js = "window.__pelhamStarter && window.__pelhamStarter.$fn(${JSONObject.quote(id)}, $arg2, ${JSONObject.quote(third)})"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun payload(value: Any?): String = when (value) {
        null, Unit -> "null"
        is JSONObject -> value.toString()
        is Map<*, *> -> JSONObject(value).toString()
        else -> JSONObject.quote(value.toString())
    }
}
