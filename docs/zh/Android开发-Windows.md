# Android 开发与构建（Windows / WSL）

## 环境

Android 构建使用 Tauri 2、JDK 17、Android SDK、NDK 29.0.13846066 和 Rust Android target。建议在 WSL/Linux 或 Windows PowerShell 中使用同一套 SDK 版本：

- Android platform `android-36`
- Build Tools `36.0.0`
- NDK `29.0.13846066`
- Rust target `aarch64-linux-android`
- Bun 和 JDK 17

Android 交叉编译需要 NDK clang：`scripts/tauri.ts` 会把它注入为 Cargo linker 与 cc-rs 的 C 编译器（如 rusqlite 打包的 SQLite）。Linux/WSL 下通过仓库的 `bun run tauri` 入口构建 Android 时，会自动探测 `ANDROID_NDK_HOME`（或 `ANDROID_HOME` 下的最新 NDK），并为 cc-rs 和 Cargo linker 注入同一套 NDK 工具链。Tauri 的 Android 构建不经过 `cargo-ndk`，不要把主机 `clang` 或桌面 MSVC 工具链用于 Android。

先设置 SDK/NDK 根目录并确认目标：

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
```

刷新率完全跟随系统：应用不请求固定显示模式或刷新率偏好，系统设 60 Hz 就 60 Hz，设高刷就高刷，省电模式、温控与厂商动态刷新策略直接生效。已知取舍：部分厂商 ROM 只给「主动表达高刷意图」的应用高刷，这类设备上 rLive 可能稳定在 60 Hz。Web 动画和 Canvas 全部按时间基准推进（WAAPI/CSS 时长、`px/s` 弹幕速度、按媒体时间绘制的回放弹幕），跟随系统实际提供的 `requestAnimationFrame` 时间戳，因此不同刷新率下观感时长一致。

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

## Android 调试

### WebView 远程调试（CDP）原理

前端在 Android 上运行于系统 WebView，可通过 Chrome DevTools Protocol（CDP）连接实时检查 DOM、注入脚本与采集事件流。关键前提：

- **必须安装 debug 构建的 APK**（`bun run tauri -- android build --debug --target aarch64`）。Rust 侧 `debug_assertions` 开启时 wry 才会调用 `WebView.setWebContentsDebuggingEnabled(true)`，release/不可调试 APK 不会创建 `webview_devtools_remote_<pid>` 抽象 socket，CDP 无从接入。
- 验证方法：`adb shell cat /proc/net/unix | grep devtools_remote`，无输出则说明当前安装的不是 debug 构建，或 WebView 未初始化。
- 架构必须匹配：模拟器 x86_64 镜像装 x86_64 APK，真机（arm64）装 aarch64 APK。用 `unzip -Z1 xxx.apk | grep lib/` 确认 APK 内的 ABI，`adb shell pm dump com.shenss.rlive | grep primaryCpuAbi` 确认设备实际加载的 ABI；`--target` 参数决定产物 ABI，Tauri flavor 名称显示 `universal` 不代表包含全部 ABI。

连接步骤（真机或模拟器相同）：

```bash
adb devices                          # 确认设备在线；unauthorized 则在手机上点「允许」
PID=$(adb shell pidof com.shenss.rlive | tr -d '\r\n ')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://localhost:9222/json/version   # 返回 Browser 版本即成功
```

连接后可用 Chrome 打开 `chrome://inspect`，或用 playwright-cli 直接 attach：

```bash
playwright-cli attach --cdp=http://localhost:9222
playwright-cli --raw eval "location.pathname"
```

排查触摸/手势类 bug 时，注入事件探针采集全量事件流（时间戳 + 目标 + touches 数）：

```js
// 页面侧探针：长按-取消类问题需要 touch/click/contextmenu/cancel 全覆盖
window.__ev = [];
const t0 = performance.now();
['touchstart','touchend','touchcancel','click','contextmenu','pointerdown','pointerup','pointercancel']
  .forEach(t => document.addEventListener(t, (e) =>
    window.__ev.push({ t: Math.round(performance.now() - t0), s: t + (e.touches ? `(${e.touches.length})` : ''),
                       tg: (e.target.className || e.target.tagName).toString().slice(0, 20) }), true));
```

模拟器注入长按用 `input motionevent`（忠实单指序列，无注入抖动）：

```bash
adb shell "input motionevent DOWN <x> <y>; sleep 0.6; input motionevent UP <x> <y>"
```

物理坐标 = CSS 坐标 × `window.devicePixelRatio`，探针里可用 `getBoundingClientRect()` 换算。真机/模拟器注入的输入没有真实手指的微抖，无法 100% 复现抖动相关的问题，必要时需真机手动操作配合探针分析。

### 模拟器调试（WSL）

```bash
# 安装镜像与工具（首次）
sdkmanager "system-images;android-36-ext18;google_apis;x86_64" "emulator" "platform-tools"
echo no | avdmanager create avd -n rlive_test -k "system-images;android-36-ext18;google_apis;x86_64" -d pixel_6

# 启动 headless 模拟器（KVM 权限：sudo gpasswd -a <user> kvm 后重新登录）
setsid sg kvm -c "$ANDROID_HOME/emulator/emulator -avd rlive_test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect" > /tmp/emu.log 2>&1 &

adb wait-for-device && adb shell getprop sys.boot_completed   # 等待 1
adb shell settings put global window_animation_scale 0        # 关系统动画提升稳定性
```

x86_64 模拟器 APK 构建与安装：

```bash
bun run tauri -- android build --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk
```

模拟器内置 WebView 版本随镜像发布（API 36-ext18 镜像为 WebView 133），与真机最新 WebView（如 vivo x300 的 149+）行为可能不同；触摸/手势类 bug 建议在真机验证。实测镜像兼容性上限（WSL + emulator 37.x）：android-36-ext18（WebView 133）稳定可用；android-36.1（WebView 134）与 android-37.0/37.1 的 guest gfxstream 驱动会在 RegionSampling 中触发 `Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma` 崩溃循环，导致 system_server 反复重启、package 服务间歇不可用，稳定版与 canary 模拟器、GLDMA/VirtioGpuNext/-Vulkan 各种开关均无法绕过，需等待上游修复。也曾在模拟器上尝试将 WebView 升级到 149：官方 x86_64 WebView 无公开分发渠道（APKPure 的 x86_64 变体是占位包），arm64 WebView 虽可 `pm install --abi arm64-v8a` 强制安装，但 arm64 应用在 x86_64 模拟器的 berberis 翻译层会因未实现指令崩溃（`libndk_translation.so DoBadTrampoline`），因此 WebView 149+ 的验证以真机为准。

### 实机调试（USB）

1. 手机开启「开发者选项 → USB 调试」，USB 连接后在弹窗上点「允许」（勾选一律允许）。
2. 保持屏幕常亮避免 WebView 挂起：开发者选项开启「充电时屏幕不休眠」，或 `adb shell svc power stayon true`。
3. 构建并安装 arm64 debug 包：

```bash
bun run tauri -- android build --debug --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/aarch64/debug/app-aarch64-debug.apk
```

4. 按「WebView 远程调试」一节 forward CDP 端口后即可用 playwright-cli attach 实时调 DOM。

### 调试排错清单

- **无 devtools socket**：安装的是 release/不可调试构建（`adb shell pm dump com.shenss.rlive | grep pkgFlags` 无 `DEBUGGABLE`），或 ABI 不匹配导致装的仍是旧包。重新构建 `--debug --target aarch64`。
- **`adb install` 静默失败**：x86_64-only APK 装不进 arm64 设备，`install -r` 可能无输出且旧包仍在；用 `unzip -Z1` 核对 APK 内 `lib/` ABI 后重装。
- **签名不匹配（INSTALL_FAILED_UPDATE_INCOMPATIBLE）**：换机器/换系统构建的 debug 包与已装包签名不同。保留数据安装可用项目 keystore 重签：`apksigner sign --ks /home/shenss/upload-keystore.jks --ks-key-alias upload`（密码见 `src-tauri/gen/android/app/keystore.properties`），否则先 `adb uninstall com.shenss.rlive`。
- **unauthorized**：手机上确认 USB 调试授权弹窗。
- **熄屏后无响应**：屏幕熄灭时 WebView/渲染器会被挂起，唤醒后再采集。
- **触摸失灵类 bug 排查范式（WebView 149 实测案例）**：`<img>` 上的长按会触发原生图片菜单接管（pointercancel 先于 contextmenu 到达）；应用层 `preventDefault` 取消菜单后 WebView 触摸路由悬死，后续 touch 全部不派发（页面只能滚动，点击全无反应），但系统手势与 contextmenu 仍在——极像「应用卡死」。注入全事件探针后若发现 touchstart 完全消失即可确诊。规避：长按交互面内不要让 `<img>` 参与命中测试（`pointer-events: none`），事件探针模板见上文。
- **VS Code Emulate 扩展报 `Error fetching your Android emulators!`**：该扩展在 WSL 下会拼接 `emulator.exe`，且默认路径是 macOS 的 `~/Library/Android/sdk`。修复：`ln -s $ANDROID_HOME/emulator/emulator $ANDROID_HOME/emulator/emulator.exe`，并在 VS Code 远程设置里配置 `"emulator.emulatorPathWSL": "/home/shenss/Android/Sdk/emulator"`。注意：sdkmanager 重装或升级 emulator 包（含切 canary 通道）会重写整个 `emulator/` 目录并删掉该符号链接，导致同一报错复发，重建一次链接即可（`~/.vscode-server/data/Machine/settings.json` 里的设置不受影响）。

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

安装后确认直播浏览、播放、弹幕、横竖屏与系统返回行为正常，并检查「设置 → 播放」、房间设置面板和播放器控制栏均不出现语音字幕入口。系统栏图标需覆盖四种组合：系统浅色 × 应用浅色/深色、系统深色 × 应用浅色/深色，图标始终与页面背景对比清晰；应用内切换主题即时生效，冷启动（`adb shell am force-stop` 后重开）首帧图标与上次主题一致；进入房间全屏（页面内层与视频 custom view）后下滑出的临时系统栏为白图标，退出后恢复。高刷设备可通过开发者选项的刷新率叠层确认前台刷新率与系统设置一致（60 Hz 与高刷各验证一次）；再开启省电模式验证系统降帧时动画速度不变。Android 不应下载 Zipformer、标点或 CAMPPlus 模型，也不应包含 `sherpa-onnx` / ONNX Runtime native runtime。
