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

构建使用 Tauri 原生命令。若当前环境没有自动注入 NDK 的 CMake toolchain，请在执行命令前设置：

```bash
export CRISPASR_ANDROID_NDK="$ANDROID_NDK_HOME"
export CMAKE_TOOLCHAIN_FILE="$PWD/scripts/android-crispasr-toolchain.cmake"
export CMAKE_GENERATOR="Unix Makefiles"
```

`src-tauri/build.rs` 会把 `libcrispasr.so`、`libggml.so`、`libggml-base.so`、`libggml-cpu.so` 和 `libomp.so` 复制到 `jniLibs/<abi>`；Gradle 随后将它们打入 APK。模型文件不打包进 APK，首次启用字幕时从 Hugging Face 下载到应用私有目录。

产物通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## 常见问题

### CMake 选择错误 ABI

删除 `src-tauri/target` 中失败的 `crispasr-sys` 构建缓存后重试，并确认 `ANDROID_NDK_HOME` 指向版本目录而不是 SDK 根目录。Android 命令会自动选择 `arm64-v8a`；不要手动把桌面 `CMAKE_GENERATOR`（Visual Studio）带入 Android 构建。

### 缺少 native library

检查 `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/` 是否包含上述五个 `.so`。如果缺少 `libomp.so`，说明 NDK 未找到或版本不匹配；设置 `ANDROID_NDK_HOME` 后清理对应构建缓存再执行构建。

### 模型下载失败

模型约 631 MB，Android 需要可访问 Hugging Face 的网络。代理设置会用于模型下载；网络不可用时可以先完成 APK 构建，进入设置后再重试模型准备。

## 真机验证

```bash
adb devices
adb install -r src-tauri/gen/android/app/build/outputs/apk/*/app-*-release-unsigned.apk
```

安装后确认：播放直播、开启 CPU 语音字幕、按 `0.1 秒`步长调整 `1–6 秒`窗口、开启/关闭 VAD，以及关闭字幕时控制栏图标不会闪烁。完整用户说明见[本地语音字幕](本地语音字幕.md)。
