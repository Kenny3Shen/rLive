# Android 开发与构建（Windows / WSL）

## 环境

Android 构建使用 Tauri 2、JDK 17、Android SDK、NDK 29.0.13846066 和 Rust Android target。建议在 WSL/Linux 或 Windows PowerShell 中使用同一套 SDK 版本：

- Android platform `android-36`
- Build Tools `36.0.0`
- NDK `29.0.13846066`
- Rust target `aarch64-linux-android`
- Bun 和 JDK 17

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

构建使用 Tauri 原生命令。项目 vendor 的 `sherpa-onnx-sys 1.13.4` 仅补充 Android target 支持：首次构建会从官方 `v1.13.4` release 下载 `sherpa-onnx-v1.13.4-android.tar.bz2`，解压到 Cargo `target/sherpa-onnx-prebuilt` 缓存，并按当前 ABI 完成链接和打包。离线构建时，可让下列变量指向已下载压缩包所在的目录：

```bash
export SHERPA_ONNX_ARCHIVE_DIR="/path/to/downloaded-archives"
```

该目录必须包含文件名完全相同的 `sherpa-onnx-v1.13.4-android.tar.bz2`。构建脚本把 Rust FFI 实际依赖的 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so` 复制到 `jniLibs/<abi>`，Gradle 随后将它们打入 APK；`libsherpa-onnx-jni.so` 是 Java/Kotlin JNI 接口，不用于当前 Rust 命令层。Zipformer、标点与可选 CAMPPlus 声纹模型不打包进 APK，首次启用对应功能时从 GitHub Release 下载到应用私有目录。

`--target aarch64` 只构建 `arm64-v8a`。Tauri/Gradle 的 flavor 名称可能仍显示为 `universal`，这不代表 APK 包含四种 ABI；以 APK 内的 `lib/arm64-v8a/` 目录为准。约 `550 MiB` 的 Zipformer 与标点模型仍在首次启用字幕时按需下载；开启默认关闭的说话人区分后会再下载约 `27 MiB`，这些模型都不会进入 APK。

产物通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## 常见问题

### Android target 选择错误 ABI

确认 `ANDROID_NDK_HOME` 指向版本目录而不是 SDK 根目录，并使用 `--target aarch64` 构建 `arm64-v8a`。切换 ABI 后若 Cargo 仍复用失败状态，可清理对应 target 的 `sherpa-onnx-sys` 构建缓存后重试；不要把桌面 MSVC 环境变量带入 Android 构建。

### 缺少 native library

检查 `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/` 是否包含 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so`。如果缺失，确认网络可以访问 `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/`；离线构建则确认 `SHERPA_ONNX_ARCHIVE_DIR` 指向包含官方 Android 压缩包的目录。

### 模型下载失败

基础模型下载合计约 `550 MiB`，说话人区分开启后合计约 `576 MiB`。Android 需要可访问 GitHub Release 的网络。代理设置会用于模型下载；网络不可用时可以先完成 APK 构建，进入设置后再重试模型准备。

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

安装后确认：播放直播、开启 CPU 语音字幕、按 `0.1 秒`步长调整 `0.2–1.0 秒`更新间隔、观察中英标点与自动两行字幕，以及关闭字幕时控制栏图标不会闪烁。还应单独验证默认关闭的说话人区分：只在 final 显示匿名编号、切房后重新编号。该功能会增加 endpoint 后的 CPU、耗电和发热，低性能设备应保持关闭。完整用户说明见[本地语音字幕](本地语音字幕.md)。
