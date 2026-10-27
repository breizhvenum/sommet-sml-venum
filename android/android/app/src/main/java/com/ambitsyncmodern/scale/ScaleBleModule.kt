package com.ambitsyncmodern.scale

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener

/*
 * Passive listener for a Bluetooth scale that only BROADCASTS its reading (Etekcity FIT 8S:
 * manufacturer id 0x06D0, no pairing, no connection, no account). It never connects and never
 * writes. Every advertisement carrying that manufacturer id is forwarded to JS as a
 * "ScaleBleAdvert" event {address, rssi, hex}; decoding, settling and the body-fat estimate live
 * in TypeScript (src/services/ScaleDecode.ts) so the phone and the desktop read the scale alike.
 *
 * Foreground only: it scans while the app is open. start()/stop() are safe to repeat.
 */
class ScaleBleModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ScaleBle"

    private var callback: ScanCallback? = null
    private var pendingPermissionPromise: Promise? = null

    companion object {
        private const val COMPANY_ID = 0x06D0
        private const val PERMISSION_REQUEST_CODE = 4247
    }

    @ReactMethod fun addListener(eventName: String) {}          // required by NativeEventEmitter
    @ReactMethod fun removeListeners(count: Int) {}

    @ReactMethod
    fun start(promise: Promise) {
        if (callback != null) { promise.resolve(true); return }
        if (!hasPermissions()) { pendingPermissionPromise = promise; requestPermissions(); return }
        startScan(promise)
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopScan()
        promise.resolve(true)
    }

    override fun invalidate() {
        stopScan()
        super.invalidate()
    }

    private fun startScan(promise: Promise) {
        val adapter = (reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) { promise.reject("BLUETOOTH_OFF", "Bluetooth is off or unavailable"); return }
        val scanner = adapter.bluetoothLeScanner
            ?: run { promise.reject("BLE_UNAVAILABLE", "BLE scanning unavailable"); return }
        val filter = ScanFilter.Builder().setManufacturerData(COMPANY_ID, ByteArray(0)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val data = result.scanRecord?.getManufacturerSpecificData(COMPANY_ID) ?: return
                val map = Arguments.createMap().apply {
                    putString("address", result.device.address)
                    putInt("rssi", result.rssi)
                    putString("hex", data.joinToString("") { "%02x".format(it) })
                }
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("ScaleBleAdvert", map)
            }
            override fun onScanFailed(errorCode: Int) {
                callback = null
                val map = Arguments.createMap().apply { putInt("code", errorCode) }
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("ScaleBleError", map)
            }
        }
        try {
            scanner.startScan(listOf(filter), settings, cb)
            callback = cb
            promise.resolve(true)
        } catch (e: SecurityException) {
            promise.reject("PERMISSION_DENIED", e.message ?: "Bluetooth permission denied")
        }
    }

    private fun stopScan() {
        val cb = callback ?: return
        callback = null
        val adapter = (reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: SecurityException) {}
    }

    private fun permissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun hasPermissions(): Boolean =
        permissions().all { ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED }

    private fun requestPermissions() {
        val activity = reactContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            pendingPermissionPromise?.let { pendingPermissionPromise = null; it.reject("NO_ACTIVITY", "No active activity") }
            return
        }
        activity.requestPermissions(permissions(), PERMISSION_REQUEST_CODE, object : PermissionListener {
            override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, results: IntArray): Boolean {
                if (requestCode != PERMISSION_REQUEST_CODE) return false
                val granted = results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED }
                val promise = pendingPermissionPromise
                pendingPermissionPromise = null
                if (granted && promise != null) startScan(promise)
                else promise?.reject("PERMISSION_DENIED", "Bluetooth permission was not granted")
                return true
            }
        })
    }
}
