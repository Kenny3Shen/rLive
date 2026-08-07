# Android 开发与构建（Windows / WSL）

## 环境

Android 构建使用 Tauri 2、JDK 17、Android SDK、NDK 29.0.13846066 和 Rust Android target。建议在 WSL/Linux 或 Windows PowerShell 中使用同一套 SDK 版本：

- Android platform `android-36`
- Build Tools `36.0.0`
- NDK `29.0.13846066`
- Rust target `aarch64-linux-android`
- Bun 和 JDK 17

`MainActivity` 在应用回到前台时会向 Android 请求同分辨率下不高于 120 Hz 的最高高刷模式。60/90 Hz 设备使用自身上限；只有 60/144 Hz 而没有 90/120 Hz 模式的面板使用 144 Hz，避免误退回 60 Hz。系统省电、温控、厂商策略与动态刷新率仍可降低实际刷新率，因此该请求不会强制所有设备固定运行在 120 FPS。Web 动画和 Canvas 仍以系统实际提供的 `requestAnimationFrame` 时间戳推进。

设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 后安装工具链：

```bash
sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;29.0.13846066"
rustup target add aarch64-linux-android
```

也可以显式指定 NDK：

```bash
export ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/29.0.13846066"
```

## 构建 APK

在仓库根目录执行：

```bash
bun install
bun run tauri -- android build --ci --target aarch64 --apk
```

Debug 开发运行：

```bash
bun run tauri -- android dev --target aarch64
```

构建使用 Tauri 原生命令。移动端当前不提供语音字幕，但 Rust 依赖仍需要链接 sherpa-onnx native runtime。项目 vendor 的 `sherpa-onnx-sys 1.13.4` 补充 Android target 支持：首次构建会从官方 `v1.13.4` release 下载 `sherpa-onnx-v1.13.4-android.tar.bz2`，解压到 Cargo `target/sherpa-onnx-prebuilt` 缓存，并按当前 ABI 完成链接和打包。离线构建时，可让下列变量指向已下载压缩包所在的目录：

```bash
export SHERPA_ONNX_ARCHIVE_DIR="/path/to/downloaded-archives"
```

该目录必须包含文件名完全相同的 `sherpa-onnx-v1.13.4-android.tar.bz2`。构建脚本把 Rust FFI 实际依赖的 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so` 复制到 `jniLibs/<abi>`，Gradle 随后将它们打入 APK；`libsherpa-onnx-jni.so` 是 Java/Kotlin JNI 接口，不用于当前 Rust 命令层。Zipformer、标点与 CAMPPlus 模型不打包进 APK；Android 不展示字幕设置或播放器入口，也不会下载这些模型。

`--target aarch64` 只构建 `arm64-v8a`。Tauri/Gradle 的 flavor 名称可能仍显示为 `universal`，这不代表 APK 包含四种 ABI；以 APK 内的 `lib/arm64-v8a/` 目录为准。

产物通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## 常见问题

### Android target 选择错误 ABI

确认 `ANDROID_NDK_HOME` 指向版本目录而不是 SDK 根目录，并使用 `--target aarch64` 构建 `arm64-v8a`。切换 ABI 后若 Cargo 仍复用失败状态，可清理对应 target 的 `sherpa-onnx-sys` 构建缓存后重试；不要把桌面 MSVC 环境变量带入 Android 构建。

### 缺少 native library

检查 `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/` 是否包含 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so`。如果缺失，确认网络可以访问 `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/`；离线构建则确认 `SHERPA_ONNX_ARCHIVE_DIR` 指向包含官方 Android 压缩包的目录。

## 真机验证

```bash
adb devices
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name 'app-*-release*.apk' -type f | head -n 1)
adb install -r "$APK"
```

安装前可检查 APK 格式和 JNI 架构：

```bash
file src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/*.so
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -c -v 4 "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$APK"
```

`app-*-release.apk` 是可直接安装的 APK；`*.aab` 是应用商店格式，不能用 `adb install` 直接安装。`--ci` 未配置 release keystore 时可能生成 unsigned APK，必须先签名再安装或发布。

安装后确认直播浏览、播放、弹幕、横竖屏与系统返回行为正常，并检查「设置 → 播放」、房间设置面板和播放器控制栏均不出现语音字幕入口。高刷设备可通过开发者选项的刷新率叠层确认前台目标模式；再开启省电模式验证系统降帧时动画速度不变。Android 不应下载 Zipformer、标点或 CAMPPlus 模型。
