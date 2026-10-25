package ca.pelhamhills.starter

import android.content.Context
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration.TapToPayConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionTokenException
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration.TapToPayDiscoveryConfiguration
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.PaymentIntentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.TapUseCase
import com.stripe.stripeterminal.external.models.TerminalErrorCode
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 폰을 Stripe 리더로 쓰는 곳(Tap to Pay). 금액·PaymentIntent 는 서버(`/payments/terminal/phone/sale`)가
 * 만들고, 여기서는 그 client_secret 으로 카드를 읽어 확정만 한다. 결과의 진실은 서버 기록이다 — 웹 화면이
 * 이 결과를 받은 뒤 서버에 다시 묻는다.
 *
 * Stripe 테스트 키면 가상 리더(simulated)로 붙는다: 카드 없이 결제 화면을 지나 테스트 카드로 승인된다.
 */
class TapPayments(private val context: Context, private val bridge: () -> WebBridge, private val scope: CoroutineScope) {
    private var location: String? = null
    private var simulated = false
    /** 위치를 알려고 먼저 받아 둔 토큰. 토큰은 한 번만 쓸 수 있어서, SDK 가 다음에 달라고 할 때 이것을 준다. */
    private var spare: String? = null
    private var running: Cancelable? = null

    private val tokens = object : ConnectionTokenProvider {
        override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
            val ready = spare
            if (ready != null) {
                spare = null
                callback.onSuccess(ready)
                return
            }
            scope.launch {
                try {
                    callback.onSuccess(fetchToken())
                } catch (e: Exception) {
                    callback.onFailure(ConnectionTokenException(e.message ?: "Could not get a Stripe token", e))
                }
            }
        }
    }

    private suspend fun fetchToken(): String {
        val body = bridge().request("connectionToken")
        location = body.optString("location").ifBlank { location }
        simulated = body.optString("environment") == "test"
        return body.getString("secret")
    }

    private fun terminal(): Terminal {
        if (!Terminal.isInitialized()) {
            Terminal.init(context.applicationContext, LogLevel.NONE, tokens, object : TerminalListener {}, null)
        }
        return Terminal.getInstance()
    }

    private suspend fun ensureConnected() {
        val terminal = terminal()
        if (terminal.connectedReader != null) return
        if (location == null) spare = fetchToken()
        val locationId = location ?: throw IllegalStateException("No Stripe Terminal location on the server.")
        val reader = suspendCancellableCoroutine<Reader> { cont ->
            var picked = false
            val discovery = terminal.discoverReaders(
                TapToPayDiscoveryConfiguration(isSimulated = simulated),
                object : DiscoveryListener {
                    override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                        val first = readers.firstOrNull() ?: return
                        if (picked) return
                        picked = true
                        if (cont.isActive) cont.resume(first)
                    }
                },
                object : Callback {
                    override fun onSuccess() {}
                    override fun onFailure(e: TerminalException) {
                        if (!picked && cont.isActive) cont.resumeWithException(e)
                    }
                },
            )
            cont.invokeOnCancellation { discovery.cancel(noop) }
        }
        suspendCancellableCoroutine<Reader> { cont ->
            terminal.connectReader(
                reader,
                TapToPayConnectionConfiguration(TapUseCase.Pay(locationId), true, null),
                object : ReaderCallback {
                    override fun onSuccess(reader: Reader) = cont.resume(reader)
                    override fun onFailure(e: TerminalException) = cont.resumeWithException(e)
                },
            )
        }
    }

    /** 웹의 `tapToPay`. 결과: {status: succeeded | canceled | failed, message?}. */
    suspend fun pay(clientSecret: String): JSONObject {
        if (clientSecret.isBlank()) return result("failed", "The server did not start the payment.")
        return try {
            ensureConnected()
            val terminal = terminal()
            val intent = suspendCancellableCoroutine<PaymentIntent> { cont ->
                terminal.retrievePaymentIntent(clientSecret, intentCallback(cont))
            }
            val done = suspendCancellableCoroutine<PaymentIntent> { cont ->
                running = terminal.processPaymentIntent(intent = intent, callback = intentCallback(cont))
            }
            running = null
            if (done.status == PaymentIntentStatus.SUCCEEDED || done.status == PaymentIntentStatus.REQUIRES_CAPTURE) {
                result("succeeded")
            } else {
                result("failed", "The payment did not finish (${done.status}).")
            }
        } catch (e: TerminalException) {
            running = null
            if (e.errorCode == TerminalErrorCode.CANCELED) result("canceled") else result("failed", e.errorMessage)
        }
    }

    fun cancel() {
        running?.cancel(noop)
        running = null
    }

    private fun intentCallback(cont: kotlinx.coroutines.CancellableContinuation<PaymentIntent>) = object : PaymentIntentCallback {
        override fun onSuccess(paymentIntent: PaymentIntent) {
            if (cont.isActive) cont.resume(paymentIntent)
        }
        override fun onFailure(e: TerminalException) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    }

    private fun result(status: String, message: String? = null) =
        JSONObject().put("status", status).apply { if (message != null) put("message", message) }

    private val noop = object : Callback {
        override fun onSuccess() {}
        override fun onFailure(e: TerminalException) {}
    }
}
