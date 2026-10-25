package ca.pelhamhills.starter

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import org.json.JSONObject

/**
 * 웹 티 시트(`/teesheet/mobile`)를 한 화면 가득 띄운다. 메뉴·화면은 전부 웹이고, 이 앱은 탭 결제와 인쇄만 한다.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var bridge: WebBridge
    private lateinit var tap: TapPayments
    private lateinit var printers: Printers
    private var cameraRequest: PermissionRequest? = null

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val request = cameraRequest ?: return@registerForActivityResult
        cameraRequest = null
        if (granted[Manifest.permission.CAMERA] == true) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else request.deny()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        printers = Printers(this)
        tap = TapPayments(this, { bridge }, lifecycleScope)
        bridge = WebBridge(web, lifecycleScope) { method, args -> handle(method, args) }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString PelhamStarter/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(bridge, "PelhamStarterNative")
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) return request.deny()
                if (has(Manifest.permission.CAMERA)) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    cameraRequest = request
                    permissions.launch(arrayOf(Manifest.permission.CAMERA))
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        askStartupPermissions()
        if (savedInstanceState == null) web.loadUrl(BuildConfig.START_URL) else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private suspend fun handle(method: String, args: JSONObject): Any? = when (method) {
        "tapToPay" -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw IllegalStateException("Tap to Pay needs Android 11 or newer.")
            if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                askStartupPermissions()
                throw IllegalStateException("Allow Location for Pelham Starter, then try again.")
            }
            tap.pay(args.optString("clientSecret"))
        }
        "cancelTap" -> tap.cancel()
        "print" -> printers.print(Base64.decode(args.getString("base64"), Base64.DEFAULT))
        "printers" -> printers.list()
        "choosePrinter" -> printers.choose(args)
        else -> throw IllegalArgumentException("Unknown action $method")
    }

    private fun has(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun askStartupPermissions() {
        val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) wanted += Manifest.permission.BLUETOOTH_CONNECT
        val missing = wanted.filterNot(::has)
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
    }
}
