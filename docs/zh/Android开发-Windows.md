# Android 开发与构建（Windows / WSL）

## 环境

Android 构建使用 Tauri 2、JDK 17、Android SDK、NDK 29.0.13846066 和 Rust Android target。建议在 WSL/Linux 或 Windows PowerShell 中使用同一套 SDK 版本：

- Android platform `android-36`
- Build Tools `36.0.0`
- NDK `29.0.13846066`
- Rust target `aarch64-linux-android`
- Bun 和 JDK 17

QuickJS 的 FFI 绑定需要 NDK clang。Linux/WSL 下通过仓库的 `bun run tauri` 入口构建 Android 时，会自动探测 `ANDROID_NDK_HOME`（或 `ANDROID_HOME` 下的最新 NDK），并为 bindgen、`cc-rs` 和 Cargo linker 注入同一套 NDK 工具链。Tauri 的 Android 构建不经过 `cargo-ndk`，不要把主机 `clang` 或桌面 MSVC 工具链用于 Android。

先设置 SDK/NDK 根目录并确认目标：

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
```

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

如果直接使用 Cargo 交叉编译，而不是从 `bun run tauri` 入口启动，则需要手动复用 NDK 工具链环境：

```bash
NDK="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK/sysroot --target=aarch64-linux-android24"
export CC_aarch64_linux_android="$NDK/bin/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$NDK/bin/llvm-ar"
export RANLIB_aarch64_linux_android="$NDK/bin/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK/bin/aarch64-linux-android24-clang"
```

Debug 开发运行：

```bash
bun run tauri -- android dev --target aarch64
```

构建使用 Tauri 原生命令。移动端不提供语音字幕，Android target 会在 Rust 条件编译阶段排除 ASR module、commands 和 state，也不会编译或打包 `sherpa-onnx`、ONNX Runtime 或模型解压依赖。桌面端 ASR 实现不受影响。

`--target aarch64` 只构建 `arm64-v8a`。Tauri/Gradle 的 flavor 名称可能仍显示为 `universal`，这不代表 APK 包含四种 ABI；以 APK 内的 `lib/arm64-v8a/` 目录为准。

产物通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## 常见问题

### Android target 选择错误 ABI

确认 `ANDROID_NDK_HOME` 指向版本目录而不是 SDK 根目录，并使用 `--target aarch64` 构建 `arm64-v8a`。切换 ABI 后若 Cargo 仍复用失败状态，可清理对应 Android target 的构建缓存后重试；不要把桌面 MSVC 环境变量带入 Android 构建。

### APK 意外包含旧 native library

`src-tauri/gen/android/app/src/main/jniLibs/` 是生成目录，旧的本地构建可能遗留被 Git 忽略的 `.so`。Release Gradle 配置会排除桌面 ASR/C++ runtime，发布工作流还会校验最终 native 清单。当前 arm64 APK/AAB 只应包含 `librlive_lib.so`。

## 真机验证

```bash
adb devices
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name 'app-*-release*.apk' -type f | head -n 1)
adb install -r "$APK"
```

安装前可检查 APK 格式和最终 JNI 清单：

```bash
unzip -Z1 "$APK" | awk '/^lib\// { print }'
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -c -v 4 "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$APK"
```

`app-*-release.apk` 是可直接安装的 APK；`*.aab` 是应用商店格式，不能用 `adb install` 直接安装。`--ci` 未配置 release keystore 时可能生成 unsigned APK，必须先签名再安装或发布。

安装后确认直播浏览、播放、弹幕、横竖屏与系统返回行为正常，并检查「设置 → 播放」、房间设置面板和播放器控制栏均不出现语音字幕入口。高刷设备可通过开发者选项的刷新率叠层确认前台目标模式；再开启省电模式验证系统降帧时动画速度不变。Android 不应下载 Zipformer、标点或 CAMPPlus 模型，也不应包含 `sherpa-onnx` / ONNX Runtime native runtime。
