# Android 开发与构建（Windows / WSL）

本页说明 Android 端的工具链要求、APK 构建方式和 WebView 远程调试流程。
要在真机或模拟器上跑 rLive、排查 Android 独有的触摸与显示问题时看这篇；桌面构建见[开发指南](开发指南.md)。

## 环境

| 项 | 版本 |
| --- | --- |
| Android platform | `android-36` |
| Build Tools | `36.0.0` |
| NDK | `29.0.13846066` |
| Rust target | `aarch64-linux-android` |
| 其他 | Tauri 2、Bun、JDK 17 |

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;29.0.13846066"
rustup target add aarch64-linux-android
```

Android 交叉编译必须用 NDK clang。通过仓库的 `bun run tauri` 入口构建时，`scripts/tauri.ts` 会自动探测 `ANDROID_NDK_HOME`（或 `ANDROID_HOME` 下最新 NDK），并为 bindgen、cc-rs 和 Cargo linker 注入同一套工具链。Tauri 的 Android 构建不经过 `cargo-ndk`，不要把主机 `clang` 或桌面 MSVC 工具链带进来。

## 构建 APK

```bash
bun install
bun run tauri -- android build --ci --target aarch64 --apk   # release
bun run tauri -- android dev --target aarch64                # 开发运行
```

产物在 `src-tauri/gen/android/app/build/outputs/apk/`。

`--target aarch64` 只构建 `arm64-v8a`。Tauri/Gradle 的 flavor 名可能仍显示 `universal`，这不代表 APK 含四种 ABI，以 APK 内的 `lib/arm64-v8a/` 为准。

移动端不提供语音字幕：Android target 在条件编译阶段排除 ASR module、commands 和 state，也不编译或打包 `sherpa-onnx`、ONNX Runtime 与模型解压依赖。

不走 `bun run tauri` 而直接用 Cargo 交叉编译时，需手动复用 NDK 工具链：

```bash
NDK="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK/sysroot --target=aarch64-linux-android24"
export CC_aarch64_linux_android="$NDK/bin/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$NDK/bin/llvm-ar"
export RANLIB_aarch64_linux_android="$NDK/bin/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK/bin/aarch64-linux-android24-clang"
```

## Android 调试

### WebView 远程调试（CDP）

前端在 Android 上运行于系统 WebView，可通过 Chrome DevTools Protocol 检查 DOM、注入脚本和采集事件流。两个硬前提：

- **必须是 debug 构建**。只有 Rust 侧 `debug_assertions` 开启时 wry 才调用 `setWebContentsDebuggingEnabled(true)`；release 包不创建 `webview_devtools_remote_<pid>` socket，CDP 无从接入。用 `adb shell cat /proc/net/unix | grep devtools_remote` 验证。
- **ABI 必须匹配**。真机（arm64）装 aarch64 包，x86_64 模拟器装 x86_64 包。用 `unzip -Z1 <apk> | grep lib/` 和 `adb shell pm dump com.shenss.rlive | grep primaryCpuAbi` 双向核对。

```bash
adb devices                          # unauthorized 则在手机上点「允许」
PID=$(adb shell pidof com.shenss.rlive | tr -d '\r\n ')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://localhost:9222/json/version   # 返回 Browser 版本即成功

playwright-cli attach --cdp=http://localhost:9222
playwright-cli --raw eval "location.pathname"
```

也可用 Chrome 打开 `chrome://inspect`。

### 触摸事件探针

排查触摸/手势 bug 前先在页面注入全事件探针，长按-取消类问题需要 touch/click/contextmenu/cancel 全覆盖：

```js
window.__ev = [];
const t0 = performance.now();
['touchstart','touchend','touchcancel','click','contextmenu','pointerdown','pointerup','pointercancel']
  .forEach(t => document.addEventListener(t, (e) =>
    window.__ev.push({ t: Math.round(performance.now() - t0), s: t + (e.touches ? `(${e.touches.length})` : ''),
                       tg: (e.target.className || e.target.tagName).toString().slice(0, 20) }), true));
```

注入手势用 `input motionevent`：

```bash
adb shell "input motionevent DOWN <x> <y>; sleep 0.6; input motionevent UP <x> <y>"
```

物理坐标 = CSS 坐标 × `window.devicePixelRatio`。注入的输入没有真实手指微抖，抖动相关问题无法完全复现，必要时真机手动操作配合探针分析。

### 真机调试（USB）

1. 开启「开发者选项 → USB 调试」，连接后在手机上允许授权。
2. 保持亮屏（熄屏时 WebView 挂起）：开启「充电时屏幕不休眠」或 `adb shell svc power stayon true`。
3. 装 debug 包后按上文 forward CDP 端口：

```bash
bun run tauri -- android build --debug --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/aarch64/debug/app-aarch64-debug.apk
```

### 模拟器调试（WSL）

```bash
sdkmanager "system-images;android-36-ext18;google_apis;x86_64" "emulator" "platform-tools"
echo no | avdmanager create avd -n rlive_test -k "system-images;android-36-ext18;google_apis;x86_64" -d pixel_6

# headless 启动（KVM 权限：sudo gpasswd -a <user> kvm 后重新登录）
setsid sg kvm -c "$ANDROID_HOME/emulator/emulator -avd rlive_test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -feature -HardwareDecoder" > /tmp/emu.log 2>&1 &
adb wait-for-device && adb shell getprop sys.boot_completed   # 等待 1
adb shell settings put global window_animation_scale 0

bun run tauri -- android build --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk
```

`-feature -HardwareDecoder` 不是可选优化：不加它时模拟器会在解 H.264 时整台段错误崩掉（`/tmp/emu.log` 尾部为 `dlopen "libcuda.so" failed!` → `Failed to call cuInit, cannot use nvidia cuvid decoder for h264 stream` → `Segmentation fault`）。进直播间就发，现象是 `adb devices` 突然变空，很像应用卡死或崩溃，实际是宿主 qemu 进程死了。加上该 flag 后模拟器不再向 guest 注入 `qemu.hwcodec.avcdec=2`（该属性变为空），转软解，代价是高码率流更卡，但可稳定播完。还需注意崩溃会丢掉未落盘的 userdata 写入，刚装的 APK 可能随之消失。

带 GUI 启动（包括 VS Code Emulate 扩展）默认会加载 `default_boot` 快照，userdata 连同已装应用和 WebView 缓存一起回滚到快照时点 —— 表现为刚装的新版又变回旧版。需要干净状态时加 `-no-snapshot-load` 冷启。

模拟器 WebView 版本随镜像发布（API 36-ext18 为 WebView 133），落后于真机（如 149+），因此**触摸/手势类 bug 必须在真机验证**。

镜像兼容性上限（WSL + emulator 37.x 实测）：android-36-ext18 稳定可用；android-36.1 与 android-37.0/37.1 的 guest gfxstream 驱动会在 RegionSampling 触发 `Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma` 崩溃循环，使 system_server 反复重启，各种 GLDMA/Vulkan 开关均无法绕过，需等上游修复。模拟器也无法升级到 WebView 149：官方 x86_64 WebView 无公开分发渠道，强装 arm64 WebView 会在 berberis 翻译层崩溃。

### 排错清单

- **换包后界面仍是旧版**：`versionName` 已是新的，但新控件不出现。WebView 对 `http://tauri.localhost` 的 HTTP 缓存跳不过应用升级，连 `index.html` 一起命中旧缓存，于是加载的还是上一版的 hash chunk。确诊：把运行时加载的 chunk 名与 `ls dist/assets/` 对比，不一致即是缓存。修复：

  ```bash
  playwright-cli --raw eval "JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>n.endsWith('.js')))])"
  adb shell am force-stop com.shenss.rlive
  adb shell run-as com.shenss.rlive rm -rf ./cache   # debug 包才能 run-as；保留设置与 Cookie
  ```

  `adb shell pm clear com.shenss.rlive` 也行，但会连设置、Cookie 和本地数据库一起清掉。
- **模拟器在进直播间时整台消失**：H.264 硬解崩溃，不是应用问题。启动时加 `-feature -HardwareDecoder`，详见上文模拟器调试。
- **无 devtools socket**：装的是 release/不可调试构建（`adb shell pm dump com.shenss.rlive | grep pkgFlags` 无 `DEBUGGABLE`），或 ABI 不匹配导致仍是旧包。重新 `--debug --target aarch64`。
- **`adb install` 静默失败**：x86_64-only APK 装不进 arm64 设备，`install -r` 可能无输出且旧包仍在。用 `unzip -Z1` 核对 ABI 后重装。
- **INSTALL_FAILED_UPDATE_INCOMPATIBLE**：换机器构建的 debug 包签名不同。保留数据可用项目 keystore 重签（`apksigner sign --ks /home/shenss/upload-keystore.jks --ks-key-alias upload`），否则先 `adb uninstall com.shenss.rlive`。
- **触摸整体失灵（WebView 149 实测案例）**：`<img>` 上的长按会触发原生图片菜单接管（pointercancel 先于 contextmenu 到达），应用层 `preventDefault` 取消菜单后 WebView 触摸路由悬死，后续 touch 全部不派发——页面只能滚动、点击全无反应，极像应用卡死。注入探针后 touchstart 完全消失即可确诊。规避：长按交互面内不让 `<img>` 参与命中测试（`pointer-events: none`）。
- **VS Code Emulate 扩展报 `Error fetching your Android emulators!`**：该扩展在 WSL 下拼接 `emulator.exe`，默认路径还是 macOS 的。修复：`ln -s $ANDROID_HOME/emulator/emulator $ANDROID_HOME/emulator/emulator.exe`，并设置 `"emulator.emulatorPathWSL": "/home/shenss/Android/Sdk/emulator"`。sdkmanager 重装或升级 emulator 包会重写 `emulator/` 目录并删掉该链接，导致同一报错复发，重建即可。

## 真机验证

```bash
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name 'app-*-release*.apk' -type f | head -n 1)
adb install -r "$APK"

unzip -Z1 "$APK" | awk '/^lib\// { print }'
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -c -v 4 "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$APK"
```

`app-*-release.apk` 可直接安装；`*.aab` 是商店格式，不能 `adb install`。`--ci` 未配置 release keystore 时可能生成 unsigned APK，必须先签名。当前 arm64 APK/AAB 只应包含 `librlive_lib.so`（`jniLibs/` 是生成目录，旧本地构建可能遗留被 Git 忽略的 `.so`）。

验证项：

- 直播浏览、播放、弹幕、横竖屏与系统返回正常。
- 「设置 → 播放」、房间设置面板和播放器控制栏均无语音字幕入口，且不下载任何 ASR 模型。
- 系统栏图标覆盖四种组合（系统浅/深 × 应用浅/深），图标与背景对比清晰；应用内切主题即时生效；冷启动（`am force-stop` 后重开）首帧图标与上次主题一致；房间全屏后下滑出的临时系统栏为白图标，退出恢复。
- 高刷设备用开发者选项的刷新率叠层确认前台刷新率与系统设置一致（60 Hz 与高刷各验证一次），再开省电模式确认系统降帧时动画速度不变。

刷新率完全跟随系统：应用不请求固定显示模式或刷新率偏好，省电模式、温控与厂商动态刷新策略直接生效。已知取舍是部分厂商 ROM 只给「主动表达高刷意图」的应用高刷，这类设备上 rLive 可能稳定在 60 Hz。Web 动画和 Canvas 全部按时间基准推进（WAAPI/CSS 时长、`px/s` 弹幕速度、按媒体时间绘制的回放弹幕），因此不同刷新率下观感时长一致。
