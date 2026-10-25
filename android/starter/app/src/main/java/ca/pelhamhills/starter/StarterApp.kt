package ca.pelhamhills.starter

import android.app.Application
import com.stripe.stripeterminal.TerminalApplicationDelegate
import com.stripe.stripeterminal.taptopay.TapToPay

/**
 * Tap to Pay 는 카드를 읽을 때 따로 떨어진 프로세스를 띄운다. 그 프로세스에서는 앱 준비를 하지 않는다
 * (Stripe 규칙 — 같은 일을 두 번 하면 SDK 가 거절한다).
 */
class StarterApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (TapToPay.isInTapToPayProcess()) return
        TerminalApplicationDelegate.onCreate(this)
    }
}
