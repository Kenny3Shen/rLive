# Android 开发与构建（Windows / WSL）

本页说明 Android 端的工具链要求、APK 构建方式和 WebView 远程调试流程。
要在真机或模拟器上跑 rLive、排查 Android 独有的触摸与显示问题时看这篇；桌面构建见[开发指南](开发指南.md)。

## 环境

| 项               | 版本                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Android platform | `android-36`（compileSdk / targetSdk 36，minSdk 24）                |
| Build Tools      | `36.0.0`                                                            |
| NDK              | `29.0.13846066`                                                     |
| Rust target      | `aarch64-linux-android`（真机）、`x86_64-linux-android`（模拟器） |
| 其他             | Tauri 2、Bun、JDK 17                                                  |

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
PID=$(adb -s "$SERIAL" shell pidof com.shenss.rlive | tr -d '\r\n ')
adb -s "$SERIAL" forward --remove-all
adb -s "$SERIAL" forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://localhost:9222/json/version   # 核对 Android-Package 是 com.shenss.rlive

playwright-cli -s=rand attach --cdp=http://localhost:9222
playwright-cli -s=rand --raw eval "location.pathname"
```

socket 名必须用**本应用**的 pid 拼：设备上常同时有别的 WebView（如 `com.google.android.googlequicksearchbox`）各开一个 socket，`cat /proc/net/unix | grep devtools_remote` 抓到的第一个往往不是自己的，连上后 `/json/version` 的 `Android-Package` 会露馅。

也可用 Chrome 打开 `chrome://inspect`。devtools socket 只接受一个客户端，用完 `playwright-cli detach`；被强杀的客户端会把 socket 占死，表现为 `curl` 挂起，见排错清单。

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

注入手势（物理坐标 = CSS 坐标 × `window.devicePixelRatio`，`rlive_win` 实测 dpr 2.625、CSS 视口 412×915）：

```bash
adb shell input tap 541 433                      # 单击
adb shell input swipe 541 433 1081 433 260       # 横滑（末位是时长 ms；终点不要超出屏幕，否则会被 Shell 路由横滑接走）
adb shell input swipe 541 433 541 433 700        # 长按：起终点相同、拉长时长
```

`input motionevent DOWN/UP` 在 `rlive_win` 上实测**不派发任何指针事件**（探针数组为空），不要用它测长按。`input swipe` 即使用相同起终点也会做插值，细微位移可能越过 12px 锁定阈值，长按因此难以用注入输入覆盖，真机手动按住更可靠。双击是两次 `input tap` 连发（间隔要落在识别器的双击窗内，约 200ms）。

断言读真实状态而不是截图：媒体 `currentTime`、play/pause/seeked 事件计数、HUD 的 `data-visible`、页签面板的 `inert`。视频画面走硬件层，`page.screenshot` 拍不到，要视觉证据用 `adb exec-out screencap -p > /tmp/x.png`。

进被测页面要走**真实入口**（列表里 `input tap` 点进去）：`pushState` + `popstate` 直接跳 URL 会跳过沿途组件的副作用——实测同一个 `/video/play?...` URL，点卡片进入与 pushState 进入的应用状态不同（卡片点击先把播放列表写进 store 再导航），只有前者能复现依赖该状态的 bug。pushState 只适合快速到达无关页面。

注入的输入没有真实手指微抖，抖动相关问题无法完全复现，必要时真机手动操作配合探针分析。

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

| 项          | 位置                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows SDK | `D:\dev\android-sdk`（emulator 36.6.11、platform-tools 37.0.0）                                                                                                                                                        |
| 系统镜像    | `system-images;android-36-ext18;google_apis;x86_64`                                                                                                                                                                    |
| AVD 索引    | `C:\Users\shens\.android\avd\rlive_win.ini`（手机）、`rlive_tablet_win.ini`（平板）                                                                                                                                  |
| AVD 数据    | `D:\dev\android-sdk\avd\rlive_win.avd`（4G RAM、6G data、`hw.gpu.enabled=yes`、`hw.keyboard=yes`）；`rlive_tablet_win.avd` 为 2560×1600 @320dpi 的 10 寸横屏平板（CSS 视口 1280×800、dpr 2、初始横屏），4G RAM |

AVD 索引必须留在 `%USERPROFILE%\.android\avd`：WSL 里 export 的环境变量不会传进 `.exe`（除非写入 `WSLENV`），`ANDROID_AVD_HOME` 靠不住。索引 `.ini` 只有三行，镜像与 userdata 由其中的 `path=` 指到 D 盘，磁盘占用仍全在 `D:\dev`。

Windows SDK 的 cmdline-tools 只有 `.bat`（需要 Windows JDK），新建 AVD 用 WSL 的 `avdmanager` 生成到临时目录，再把 `.avd` 拷到 D 盘、把索引 `.ini` 的 `path=` 改成 Windows 路径即可；`config.ini` 里的 `image.sysdir.1` 是相对 SDK 根的路径，跨平台通用。

带窗口启动（日常调试）：

```bash
setsid nohup cd /mnt/d/dev/android-sdk/emulator/emulator.exe -avd rlive_win -no-boot-anim > /tmp/emu-win.log 2>&1 &
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
- 停止模拟器用 `adb -s emulator-XXXX emu kill` 优雅关停：qemu 退出时自行清理 `hardware-qemu.ini.lock`。`Stop-Process -Force` 强杀来不及清锁，是下一次启动 FATAL 的主要来源。另外从 WSL 跑 `emulator.exe` 时输出一律重定向到文件：`emulator.exe ... | head` / `| grep` 这类管道会在读端关闭时杀掉 `emulator.exe`，而它已经派生的 `qemu-system-x86_64.exe` 成为孤儿继续运行并持有 AVD 锁——进程列表里看不到 `emulator` 时别急着断定模拟器已退出，两种 qemu 进程名各查一遍。
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
- **VS Code Emulate 扩展报 `Error running your Android emulator! Try running this command: <cmd>`**：照提示把那条命令在 WSL 里跑一遍（输出重定向到文件，别接管道，见下一条），真实原因几乎都是 FATAL `Running multiple emulators with the same AVD`。
- **模拟器启动 FATAL `Running multiple emulators with the same AVD`**：阻塞者不是残留的锁文件，而是仍活着的持有进程——强杀（`Stop-Process -Force` / `taskkill /F`）后没死透的 `qemu-system-x86_64.exe` / `qemu-system-x86_64-headless.exe` / `netsimd`（两种 qemu 进程名都要查），或被关闭的输出管道孤儿化的 qemu。持有者 pid 记录在 `<avd>/hardware-qemu.ini.lock/pid`；模拟器还能响应时优先 `adb -s emulator-XXXX emu kill` 优雅关停（会自行清掉 `hardware-qemu.ini.lock`），不行再 `Stop-Process` 后 `rm -rf` `<avd>/hardware-qemu.ini.lock` 与 `multiinstance.lock`——持有者活着时 drvfs 报 Permission denied，杀干净后才能删。实测无持有者的残留锁文件不阻塞下一次启动，可不清。
- **无 devtools socket**：装的是 release/不可调试构建（`adb shell pm dump com.shenss.rlive | grep pkgFlags` 无 `DEBUGGABLE`），或 ABI 不匹配导致仍是旧包。重新 `--debug --target aarch64`。
- **只拿到 minified 错误码、没有组件栈**：生产 React 不带组件栈，而 `vite build --mode development` **不产出** dev React（vendor chunk 仍是生产版，错误照旧是 `Minified React error #xxx`）。要组件栈只能 `bun run tauri -- android dev`（它把 dev server 的 dev 构建喂进应用，同时保留 Tauri IPC）。
- **`android dev` 起不来**：两种原因。一是它**不接受 `--target`**（ABI 按设备推断，硬传会报 usage 错误）；二是 1420 被占，`beforeDevCommand` 直接非零退出——占用者可能是上次没清干净的 `vite` 子进程（`pgrep -af vite` 后 kill），也可能是**正在跑的 Windows dev 会话**（镜像网络共享 loopback，二者互斥，先停 Windows 侧）。
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
- 普通直播与视频播放时，视频画面从状态栏下方开始；加载/失败态顶栏只预留一份安全区，进入全屏仍铺满窗口，退出后恢复占位。
- 高刷设备用开发者选项的刷新率叠层确认前台刷新率与系统设置一致（60 Hz 与高刷各验证一次），再开省电模式确认系统降帧时动画速度不变。

刷新率完全跟随系统：应用不请求固定显示模式或刷新率偏好，省电模式、温控与厂商动态刷新策略直接生效。已知取舍是部分厂商 ROM 只给「主动表达高刷意图」的应用高刷，这类设备上 rLive 可能稳定在 60 Hz。Web 动画和 Canvas 全部按时间基准推进（WAAPI/CSS 时长、`px/s` 弹幕速度、按媒体时间绘制的回放弹幕），因此不同刷新率下观感时长一致。
