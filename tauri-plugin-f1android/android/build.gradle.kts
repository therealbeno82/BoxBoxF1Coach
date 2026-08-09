plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    // Must match PLUGIN_IDENTIFIER in ../src/lib.rs — Tauri resolves the plugin
    // class as "<identifier>.<class name>" by reflection.
    namespace = "com.boxbox.plugin.f1android"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    // The Tauri Android runtime — Plugin/Invoke/JSObject and the @Command,
    // @TauriPlugin, @InvokeArg annotations. Included into the app's Gradle build
    // by tauri.settings.gradle, which is generated from the Cargo dep graph.
    implementation(project(":tauri-android"))
}
