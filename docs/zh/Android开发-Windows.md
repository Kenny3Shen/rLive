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

构建使用 Tauri 原生命令。移动端不提供语音字幕，Android target 会在 Rust 条件编译阶段排除 ASR module、commands 和 state，也不会编译或打包 `sherpa-onnx`、ONNX Runtime、CrispASR、ggml 与模型解压依赖。桌面端 ASR 实现不受影响。

`--target aarch64` 只构建 `arm64-v8a`。Tauri/Gradle 的 flavor 名称可能仍显示为 `universal`，这不代表 APK 包含四种 ABI；以 APK 内的 `lib/arm64-v8a/` 目录为准。

产物通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## 常见问题

### 竖屏房间控制栏与视频底边有一段空隙（已修复）

**现象**：冷启动后首次进入直播间，竖屏堆叠布局（视频在上、弹幕面板在下）中控制栏与视频画面底边有明显空隙，没有贴合。点一次全屏再返回后空隙消失，同一次会话里再进其他直播间都正常；退出应用重新进入又复现。

**成因**：`PlayerControls` 的 overlay 分支无条件施加 `pb-[max(1px,env(safe-area-inset-bottom))]`。`env(safe-area-inset-bottom)` 描述的是**窗口**底边被系统 UI 遮挡的高度，不是某个元素与屏幕的距离。应用启用了 `enableEdgeToEdge()` 且 `index.html` 用 `viewport-fit=cover`，所以这个值在竖屏下等于 Android 手势导航条的 16dp（约 17 CSS px）。但竖屏堆叠布局里控制栏浮在视频画面底边上，它的下方是弹幕面板而不是屏幕边缘——这段 padding 没有任何可避让的系统 UI，只是把按钮凭空顶高了一个手势条的高度。

值得说明的是，**用户以为正常的「全屏返回后」状态才是异常态**。对比两张截图的顶部可以确认：正常态 y=44–75 有状态栏内容，而「全屏返回后」从 y=0 到 y=92 全是背景色，即系统栏并未恢复。系统栏消失使 `env(safe-area-inset-bottom)` 塌陷为 0，于是这段多余的 padding 也随之消失，恰好「看起来正确」。测量按钮底边到面板边界：正常态约 31 CSS px，系统栏消失时约 14.5 CSS px，差值约 17 px 正是手势条高度。这也解释了全部现象——冷启动复现、全屏往返后消失、同会话内切房间正常（系统栏尚未恢复，inset 仍为 0）。

**解决方案**：把「是否需要避让系统 UI」变成一个显式条件，只在控制栏真的位于窗口底边时才施加 inset。

- `src/shared/components/player/PlayerControls.tsx` 新增纯函数 `playerControlsAvoidSystemGestureBar(fullscreen, stackedBelowPlayer)`：全屏时控制栏铺满窗口，需要避让；播放器铺满视口时同理；只有堆叠在其他内容之上（`stackedBelowPlayer`）才不需要。
- 新增 prop `stackedBelowPlayer`，由 `PlayerPane`（竖屏堆叠时传 `portraitStackedPlayer`）、`IptvPlayer`（stage 是 `relative aspect-video`，下方有 footer）、`MultiRoomPlayer`（3×3 网格中的一格）传入。
- SuperChat 叠加层与 ASR 字幕原先各自硬编码 `env(safe-area-inset-bottom)`，同样会错位。统一改为读取 stage 上的 `--player-chrome-inset` 变量，与控制栏共用一套基准。
- 回归测试见 `tests/player-controls.test.ts`：覆盖窗口底边、堆叠、全屏三种情形。

**经验**：`env(safe-area-inset-*)` 是窗口级量，只有当元素自身贴着窗口对应边时才等于它需要的 padding。嵌套或堆叠布局中的元素直接引用它，就会引入一段与实际遮挡无关的偏移。

### 退出视频全屏后系统栏未恢复（未修复）

**现象**：进入 HTML 视频全屏再退出后，状态栏和导航栏没有恢复显示，界面继续按无系统栏布局。副作用是所有 `env(safe-area-inset-*)` 塌陷为 0。

**已定位的成因**：`RliveFullscreenWebChromeClient.enterImmersiveMode()`（`src-tauri/gen/android/app/src/main/java/com/shenss/rlive/RliveFullscreenWebChromeClient.kt:113`）在隐藏系统栏前，先用 `ViewCompat.getRootWindowInsets(decorView)?.isVisible(systemBars())` 记录原本的可见性到 `restoreVisibleSystemBars`，退出时（同文件 `dismissCustomView()`，第 138 行）仅在该标记为 `true` 时才 `controller.show(systemBars())`。这个「记录再恢复」的思路本身没问题，但取值时机不可靠：

1. 全屏前若已因 `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` 处于瞬时隐藏状态（例如上一次全屏刚退出、或系统正在播放栏动画），`isVisible` 会读到 `false`，于是退出时判定「原本就该隐藏」而不再恢复。
2. `getRootWindowInsets` 在 insets 尚未派发时返回 `null`，此时 `?: true` 兜底是对的；但返回非 null 而内容是动画中间态时没有兜底。
3. `previousSystemBarsBehavior` 会被连续两次 `enterImmersiveMode()` 覆盖成沉浸态自身的值，嵌套或快速重入时无法回到真正的原始 behavior。

**修复方向**（尚未实施，需要真机验证）：这个 Activity 始终以 `enableEdgeToEdge()` 运行、除视频全屏外没有任何隐藏系统栏的路径，因此不存在「原本就该隐藏」的合法状态——直接无条件 `controller.show(systemBars())` 并把 behavior 复位为 `BEHAVIOR_DEFAULT`，比记录再恢复更可靠。同时应在 `onResume` 兜底一次恢复，以覆盖进程被系统回收后重建的情况。

**当前影响**：控制栏 padding 已不再依赖系统栏可见性，所以这个问题不再表现为布局错位，但状态栏和导航栏仍会缺失，需要单独修复。

### Android target 选择错误 ABI

确认 `ANDROID_NDK_HOME` 指向版本目录而不是 SDK 根目录，并使用 `--target aarch64` 构建 `arm64-v8a`。切换 ABI 后若 Cargo 仍复用失败状态，可清理对应 target 的 `sherpa-onnx-sys` 构建缓存后重试；不要把桌面 MSVC 环境变量带入 Android 构建。

### APK 意外包含旧 native library

`src-tauri/gen/android/app/src/main/jniLibs/` 是生成目录，旧的本地构建可能遗留被 Git 忽略的 `.so`。Release Gradle 配置会排除已知 ASR/C++ runtime，发布工作流还会校验最终 native 清单。当前 arm64 APK/AAB 只应包含 `librlive_lib.so`。

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

安装后确认直播浏览、播放、弹幕、横竖屏与系统返回行为正常，并检查「设置 → 播放」、房间设置面板和播放器控制栏均不出现语音字幕入口。高刷设备可通过开发者选项的刷新率叠层确认前台目标模式；再开启省电模式验证系统降帧时动画速度不变。Android 不应下载 Zipformer、标点或 CAMPPlus 模型，也不应包含 Sherpa/ONNX/CrispASR native runtime。
