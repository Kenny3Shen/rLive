import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// This ignored file is created only by the protected release workflow (or a
// developer's local signing setup). Keeping it outside version control makes
// an unsigned local release possible while preventing a release tag from
// accidentally publishing a debug-signed Android artifact.
val releaseKeystorePropertiesFile = file("keystore.properties")
val releaseKeystoreProperties = Properties().apply {
    if (releaseKeystorePropertiesFile.exists()) {
        releaseKeystorePropertiesFile.inputStream().use { load(it) }
    }
}
val hasReleaseSigningConfig = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    .all { key -> !releaseKeystoreProperties.getProperty(key).isNullOrBlank() }

android {
    compileSdk = 36
    namespace = "com.shenss.rlive"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.shenss.rlive"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasReleaseSigningConfig) {
            create("release") {
                storeFile = project.file(releaseKeystoreProperties.getProperty("storeFile"))
                storePassword = releaseKeystoreProperties.getProperty("storePassword")
                keyAlias = releaseKeystoreProperties.getProperty("keyAlias")
                keyPassword = releaseKeystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (hasReleaseSigningConfig) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    packaging {
        // ASR is desktop-only. Generated jniLibs is intentionally ignored by
        // Git, so stale runtimes can survive local rebuilds unless packaging
        // rejects them explicitly.
        jniLibs.excludes += setOf(
            "**/libc++_shared.so",
            "**/libcrispasr.so",
            "**/libggml.so",
            "**/libggml-base.so",
            "**/libggml-cpu.so",
            "**/libomp.so",
            "**/libsherpa-onnx-c-api.so",
            "**/libonnxruntime.so",
        )
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
