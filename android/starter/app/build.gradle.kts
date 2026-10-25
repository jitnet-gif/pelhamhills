plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ca.pelhamhills.starter"
    compileSdk = 35

    defaultConfig {
        applicationId = "ca.pelhamhills.starter"
        // Stripe Terminal 5.x 는 26 이상. Tap to Pay 자체는 Android 11(30) 이상에서만 켜진다 — 앱이 실행 중에 확인한다.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // 앱이 띄우는 화면. 바꾸려면 여기만(로컬 시험: http://10.0.2.2:3000/teesheet/mobile).
        buildConfigField("String", "START_URL", "\"https://pelhamhills-golf.vercel.app/teesheet/mobile\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.stripe:stripeterminal-taptopay:5.8.0")
    implementation("com.stripe:stripeterminal-core:5.8.0")
}
