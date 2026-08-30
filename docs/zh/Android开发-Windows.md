# Android 开发与构建（Windows / WSL）

本页说明 Android 端的工具链要求、APK 构建方式和 WebView 远程调试流程。
要在真机或模拟器上跑 rLive、排查 Android 独有的触摸与显示问题时看这篇；桌面构建见[开发指南](开发指南.md)。

## 环境

| 项 | 版本 |
| --- | --- |
| Android platform | `android-36`（compileSdk / targetSdk 36，minSdk 24） |
| Build Tools | `36.0.0` |
| NDK | `29.0.13846066` |
| Rust target | `aarch64-linux-android`（真机）、`x86_64-linux-android`（模拟器） |
| 其他 | Tauri 2、Bun、JDK 17 |

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;29.0.13846066"
rustup target add aarch64-linux-android x86_64-linux-android
```

Android 交叉编译必须用 NDK clang。通过仓库的 `bun run tauri` 入口构建时，`scripts/tauri.ts` 会自动探测 `ANDROID_NDK_HOME`（或 `ANDROID_HOME` 下最新 NDK），并为 bindgen、cc-rs 和 Cargo linker 注入同一套工具链。Tauri 的 Android 构建不经过 `cargo-ndk`，不要把主机 `clang` 或桌面 MSVC 工具链带进来。

## 构建 APK

```bash
bun install
bun run tauri -- android build --ci --target aarch64 --apk   # release
bun run tauri -- android dev --target aarch64                # 开发运行
```

产物路径固定为 `src-tauri/gen/android/app/build/outputs/apk/universal/<profile>/app-universal-<profile>.apk`，`<profile>` 为 `debug` 或 `release`。

Gradle flavor 恒为 `universal`：`--target aarch64` 通过 Gradle 属性把构建收窄到 `arm64-v8a`，但不改变 flavor 与输出路径（除非用 `--split-per-abi`）。APK 实际包含哪些 ABI 以 `unzip -Z1 <apk> | grep '^lib/'` 为准。

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

## 调试

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

也可用 Chrome 打开 `chrome://inspect`。WebView 的 devtools socket 只接受一个客户端，用完执行 `playwright-cli detach`；被强杀的客户端会把 socket 占死，表现为 `curl` 挂起无响应，见排错清单。

### 触摸事件探针

排查触摸/手势 bug 前先在页面注入全事件探针，长按-取消类问题需要 touch/click/contextmenu/cancel 全覆盖：

```bash
playwright-cli --raw eval '(() => {
  window.__ev = [];
  const t0 = performance.now();
  ["touchstart","touchend","touchcancel","click","contextmenu","pointerdown","pointerup","pointercancel"]
    .forEach(t => document.addEventListener(t, e =>
      window.__ev.push({ t: Math.round(performance.now() - t0), s: t + (e.touches ? "(" + e.touches.length + ")" : ""),
                         tg: (e.target.className || e.target.tagName).toString().slice(0, 20) }), true));
  return "probe ready";
})()'
```

读取用 `playwright-cli --raw eval "JSON.stringify(window.__ev)"`。重复注入前先刷新页面，否则监听器叠加、事件会重复记录。

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
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

### 模拟器调试（Windows emulator + WSL 驱动）

模拟器进程跑在 Windows（WHPX），构建、`adb`、CDP 全留在 WSL。带窗口时图形走宿主 Vulkan，H.264 硬解不依赖 `libcuda`，也能直接用 VS Code Emulate 扩展开窗。

| 项 | 位置 |
| --- | --- |
| Windows SDK | `D:\dev\android-sdk`（emulator 36.6.11、platform-tools 37.0.0） |
| 系统镜像 | `system-images;android-36-ext18;google_apis;x86_64` |
| AVD 索引 | `C:\Users\shens\.android\avd\rlive_win.ini` |
| AVD 数据 | `D:\dev\android-sdk\avd\rlive_win.avd`（4G RAM、6G data、`hw.gpu.enabled=yes`、`hw.keyboard=yes`） |

AVD 索引必须留在 `%USERPROFILE%\.android\avd`：WSL 里 export 的环境变量不会传进 `.exe`（除非写入 `WSLENV`），`ANDROID_AVD_HOME` 靠不住。索引 `.ini` 只有三行，镜像与 userdata 由其中的 `path=` 指到 D 盘，磁盘占用仍全在 `D:\dev`。

Windows SDK 的 cmdline-tools 只有 `.bat`（需要 Windows JDK），新建 AVD 用 WSL 的 `avdmanager` 生成到临时目录，再把 `.avd` 拷到 D 盘、把索引 `.ini` 的 `path=` 改成 Windows 路径即可；`config.ini` 里的 `image.sysdir.1` 是相对 SDK 根的路径，跨平台通用。

带窗口启动（日常调试）：

```bash
cd /mnt/d/dev/android-sdk/emulator
setsid nohup ./emulator.exe -avd rlive_win -no-boot-anim > /tmp/emu-win.log 2>&1 &
adb devices                      # 不需要 adb connect

bun run tauri -- android build --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

headless 启动必须让进程彻底脱离 WSL，用 PowerShell 起：

```bash
cd /mnt/c && powershell.exe -NoProfile -Command "Start-Process -FilePath 'D:\dev\android-sdk\emulator\emulator.exe' -ArgumentList @('-avd','rlive_win','-no-window','-no-audio','-no-boot-anim','-gpu','swiftshader_indirect') -RedirectStandardOutput 'D:\Temp\emu.log' -RedirectStandardError 'D:\Temp\emu.err' -WindowStyle Hidden"
```

`setsid nohup ./emulator.exe ... &` 起的进程会跟着 WSL 侧调用方（终端或 agent 会话）一起被回收 —— 实测两次在会话结束时模拟器无声消失，日志停在半行。`Start-Process` 起的进程挂在 Windows 侧，跨会话存活。

`.wslconfig` 为 `networkingMode=Mirrored` + `hostAddressLoopback=true`，WSL 与 Windows 共享 loopback，Windows 模拟器会自己注册到 WSL 的 adb server，`adb devices` 直接列出，无需 `adb connect`。端口从 5554 起取第一对空闲端口：另有模拟器占用 5554/5555 时它是 `emulator-5556`，命令要带 `-s`。装包后的 CDP 流程与真机完全一致。

VS Code Emulate 扩展（remote 侧 machine settings，`~/.vscode-server/data/Machine/settings.json`）：

```json
"emulator.emulatorPathWSL": "/mnt/d/dev/android-sdk/emulator",
"emulator.androidColdBoot": true,
"emulator.androidExtraBootArgs": "-no-boot-anim"
```

扩展在 WSL 下会把该路径拼上 `emulator.exe` 再 exec，所以必须指向 Windows 侧目录。

行为与限制：

- H.264 硬解正常：guest 拿到 `ro.boot.qemu.hwcodec.avcdec=2`，走 `c2.goldfish.h264.decoder`，headless + 720p 直播连播 3 分钟以上正常，emulator 日志无 ERROR/FATAL。
- `-no-window` 会让渲染退回 SwiftShader + lavapipe 软件光栅（宿主 GPU 只在带窗口时启用），冷启动约 30s，app、WebView 与播放均可用。headless 的进程名是 `qemu-system-x86_64-headless`，用 `Get-Process qemu-system-x86_64` 查不到，别据此判定模拟器已退出（带窗口时进程名才是 `qemu-system-x86_64`）。
- 带窗口启动（含 VS Code Emulate 扩展）默认加载 `default_boot` 快照，userdata 连同已装应用和 WebView 缓存回滚到快照时点 —— 表现为刚装的新版又变回旧版。需要干净状态时加 `-no-snapshot-load`（扩展侧已开 `androidColdBoot`）。
- `adb emu <cmd>` 会静默失败：控制台 token 在 `C:\Users\shens\.emulator_console_auth_token`，而 WSL 的 adb 读 `~/.emulator_console_auth_token`。需要时 `cp /mnt/c/Users/shens/.emulator_console_auth_token ~/`。
- 镜像仍是 WebView 133（随镜像发布，落后于真机的 149+），触摸/手势类 bug 依旧只能真机验证；镜像也无法升级到 WebView 149，官方 x86_64 WebView 无公开分发渠道，强装 arm64 WebView 会在 berberis 翻译层崩溃。

### 排错清单

- **`curl http://localhost:9222/json/version` 挂起无响应**：上一个 CDP 客户端没有干净断开（如 playwright-cli 会话被强杀），WebView devtools socket 的单客户端槽位仍被占用。先 `playwright-cli detach`；已无可断开的会话时 `adb shell am force-stop com.shenss.rlive`，重开应用再重新 forward。
- **换包后界面仍是旧版**：`versionName` 已是新的，但新控件不出现。WebView 对 `http://tauri.localhost` 的 HTTP 缓存跳不过应用升级，连 `index.html` 一起命中旧缓存，于是加载的还是上一版的 hash chunk。确诊：把运行时加载的 chunk 名与 `ls dist/assets/` 对比，不一致即是缓存。修复：

  ```bash
  playwright-cli --raw eval "JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()).filter(n=>n.endsWith('.js')))])"
  adb shell am force-stop com.shenss.rlive
  adb shell run-as com.shenss.rlive rm -rf ./cache   # debug 包才能 run-as；保留设置与 Cookie
  ```

  `adb shell pm clear com.shenss.rlive` 也行，但会连设置、Cookie 和本地数据库一起清掉。
- **模拟器启动 FATAL `Running multiple emulators with the same AVD`**：上次非正常退出留下了 `hardware-qemu.ini.lock/` 和 `multiinstance.lock`。残留进程还活着时 WSL 侧删不掉这两个锁（drvfs 报 Permission denied），先 `Stop-Process` 掉 `emulator`/`qemu-system-x86_64-headless`/`netsimd`，再 `rm -rf` 锁文件。
- **无 devtools socket**：装的是 release/不可调试构建（`adb shell pm dump com.shenss.rlive | grep pkgFlags` 无 `DEBUGGABLE`），或 ABI 不匹配导致仍是旧包。重新 `--debug --target aarch64`。
- **`adb install` 静默失败**：x86_64-only APK 装不进 arm64 设备，`install -r` 可能无输出且旧包仍在。用 `unzip -Z1` 核对 ABI 后重装。
- **INSTALL_FAILED_UPDATE_INCOMPATIBLE**：换机器构建的 debug 包签名不同。保留数据可用项目 keystore 重签（`apksigner sign --ks /home/shenss/upload-keystore.jks --ks-key-alias upload`），否则先 `adb uninstall com.shenss.rlive`。
- **触摸整体失灵（WebView 149 实测案例）**：`<img>` 上的长按会触发原生图片菜单接管（pointercancel 先于 contextmenu 到达），应用层 `preventDefault` 取消菜单后 WebView 触摸路由悬死，后续 touch 全部不派发——页面只能滚动、点击全无反应，极像应用卡死。注入探针后 touchstart 完全消失即可确诊。规避：长按交互面内不让 `<img>` 参与命中测试（`pointer-events: none`）。
- **VS Code Emulate 扩展报 `Error fetching your Android emulators!` 或列表为空**：都是扩展找不到 AVD。前者是路径错了——扩展在 WSL 下把 `emulator.emulatorPathWSL` 拼上 `emulator.exe` 再 exec，默认值仍是 macOS 路径，改指向 Windows SDK 即可；后者（`emulator.exe -list-avds` 有输出但扩展列表空）是 AVD 索引 `.ini` 不在 `%USERPROFILE%\.android\avd`，把索引文件放回默认目录，只用 `path=` 把数据目录指向 D 盘。

## 真机验证

```bash
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name 'app-*-release*.apk' -type f | head -n 1)
adb install -r "$APK"

unzip -Z1 "$APK" | awk '/^lib\// { print }'
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -c -v 4 "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$APK"
```

`app-*-release.apk` 可直接安装；`*.aab` 是商店格式，不能 `adb install`。本地未配置 release keystore（`src-tauri/gen/android/app/keystore.properties`）时生成的是 unsigned APK，必须先签名。当前 arm64 APK/AAB 只应包含 `librlive_lib.so`（`jniLibs/` 是生成目录，旧本地构建可能遗留被 Git 忽略的 `.so`）。

验证项：

- 直播浏览、播放、弹幕、横竖屏与系统返回正常。
- 「设置 → 播放」、房间设置面板和播放器控制栏均无语音字幕入口，且不下载任何 ASR 模型。
- 系统栏图标覆盖四种组合（系统浅/深 × 应用浅/深），图标与背景对比清晰；应用内切主题即时生效；冷启动（`am force-stop` 后重开）首帧图标与上次主题一致；房间全屏后下滑出的临时系统栏为白图标，退出恢复。
- 高刷设备用开发者选项的刷新率叠层确认前台刷新率与系统设置一致（60 Hz 与高刷各验证一次），再开省电模式确认系统降帧时动画速度不变。

刷新率完全跟随系统：应用不请求固定显示模式或刷新率偏好，省电模式、温控与厂商动态刷新策略直接生效。已知取舍是部分厂商 ROM 只给「主动表达高刷意图」的应用高刷，这类设备上 rLive 可能稳定在 60 Hz。Web 动画和 Canvas 全部按时间基准推进（WAAPI/CSS 时长、`px/s` 弹幕速度、按媒体时间绘制的回放弹幕），因此不同刷新率下观感时长一致。
