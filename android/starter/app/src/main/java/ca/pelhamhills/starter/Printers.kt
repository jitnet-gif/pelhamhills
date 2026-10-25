package ca.pelhamhills.starter

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID

/**
 * 영수증 프린터. 웹 화면이 만든 ESC/POS 바이트(`frontend/lib/retail/escpos.ts`, 계산대 영수증과 같다)를 그대로 보낸다.
 * - 블루투스: Android 설정에서 페어링한 프린터(SPP). TM-m30 계열·휴대용 Epson 이 이 방식이다.
 * - 와이파이: 프로샵의 TM-m30III 에 TCP 9100 으로(브라우저와 달리 인증서 허용이 필요 없다).
 * 고른 프린터는 이 폰에만 기억한다.
 */
class Printers(private val context: Context) {
    private val prefs = context.getSharedPreferences("printer", Context.MODE_PRIVATE)

    fun current(): JSONObject? {
        val kind = prefs.getString("kind", null) ?: return null
        return JSONObject().put("kind", kind).put("name", prefs.getString("name", "")).put("address", prefs.getString("address", ""))
    }

    fun choose(args: JSONObject) {
        val kind = args.getString("kind")
        require(kind == "bluetooth" || kind == "network") { "Unknown printer kind." }
        prefs.edit().putString("kind", kind).putString("name", args.optString("name")).putString("address", args.getString("address")).apply()
    }

    @SuppressLint("MissingPermission")
    fun list(): JSONObject {
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        val paired = JSONArray()
        try {
            adapter?.bondedDevices?.sortedBy { it.name ?: "" }?.forEach {
                paired.put(JSONObject().put("kind", "bluetooth").put("name", it.name ?: it.address).put("address", it.address))
            }
        } catch (e: SecurityException) {
            throw IllegalStateException("Allow Nearby devices for Pelham Starter in Android settings.")
        }
        return JSONObject().put("current", current() ?: JSONObject.NULL).put("paired", paired)
    }

    @SuppressLint("MissingPermission")
    suspend fun print(bytes: ByteArray) = withContext(Dispatchers.IO) {
        val kind = prefs.getString("kind", null) ?: throw IllegalStateException("Choose a receipt printer first (🖨 button).")
        val address = prefs.getString("address", "") ?: ""
        if (kind == "network") {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(address, 9100), 5000)
                socket.getOutputStream().apply { write(bytes); flush() }
            }
            return@withContext
        }
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            ?: throw IllegalStateException("This phone has no Bluetooth.")
        if (!adapter.isEnabled) throw IllegalStateException("Turn Bluetooth on.")
        val device = adapter.getRemoteDevice(address)
        adapter.cancelDiscovery()
        device.createRfcommSocketToServiceRecord(SPP).use { socket ->
            try {
                socket.connect()
            } catch (e: Exception) {
                throw IllegalStateException("The printer did not answer. Check it is on and nearby.")
            }
            val out = socket.outputStream
            // 블루투스 버퍼가 작다 — 조금씩 보내고, 끊기 전에 프린터가 다 받을 시간을 준다.
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + 512, bytes.size)
                out.write(bytes, offset, end - offset)
                out.flush()
                offset = end
            }
            Thread.sleep(600)
        }
    }

    companion object {
        private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")
    }
}
