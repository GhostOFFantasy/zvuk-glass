# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Zvuk Glass: классы, к которым обращается Rust (JNI) и Tauri (по имени и через рефлексию),
# не переименовывать и не выкидывать
-keep class com.zvukglass.app.ZgNative { *; }
-keep class com.zvukglass.app.ZgPlugin { *; }
-keep class com.zvukglass.app.NowPlaying { *; }
-keep class com.zvukglass.app.ApkArgs { *; }
-keep class com.zvukglass.app.MediaService { *; }
-keep class com.zvukglass.app.ZgSecrets { *; }
-keep class com.zvukglass.app.ZgInsets { *; }
-keep class com.zvukglass.app.MainActivity { *; }
