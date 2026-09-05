# rLive UI 与动画技术说明

写 `src/` 下的页面、组件或动效前先读这篇。它是规范而非实现日志：第 1–3 节是技术边界与组件/主题规则，第 4–6 节是动画选择流程、实现模板与性能规则，第 7–8 节是验证清单与源码索引。

- 前后端分层与数据路径：[架构说明](架构说明.md)
- 播放器内部结构与弹幕会话契约：[播放器技术文档](播放器技术文档.md)
- 检查命令、构建与同步：[开发指南](开发指南.md)

代码是最终事实来源。本文数值与行为变化时应同步更新本文。

## 1. 技术边界

| 层 | 当前实现 | 职责 |
| --- | --- | --- |
| 视图 | React 19 + React Router | 页面组合、路由状态、组件生命周期 |
| 样式 | Tailwind CSS 4 + `src/styles.css` | 响应式布局、语义颜色、状态过渡、全局关键帧 |
| UI 组件 | shadcn-style `base-nova` + Base UI | Button、Tabs、Dialog、Drawer、Field、Select 等 |
| 图标 | `lucide-react` | 导航、工具按钮、状态图标 |
| 运行时动画 | Web Animations API（`src/shared/motion/tween.ts`） | 页面入场、Zoom、手势回弹与可中断反馈 |
| 文档快照 | View Transition API + CSS keyframes | 亮暗主题全局淡化 |
| 原生 CSS 动画 | `tw-animate-css` + 自定义 utilities | Overlay、Drawer、主题淡化、加载旋转、短状态过渡 |
| 直播画面弹幕 | `danmu.js@1.2.1` + CSS transition | DOM 轨道与飘屏，不属于页面 UI 动画层 |
| 录制回放弹幕 | `RecordedDanmakuCanvas` + `requestAnimationFrame` | 按本地媒体时间绘制录制 sidecar |

硬性规则：

- 不使用 Framer Motion、GSAP 或任何第二套动画库。运行时动效只用 Web Animations API 与 CSS，封装在 `src/shared/motion/`。新增效果前先确认 `tween()`、CSS、`PagePan`、`PageZoom` 或 View Transition 是否已覆盖需求。
- 位移、缩放、旋转走 CSS transform；显隐只动画 opacity。
- 页面控件统一使用完整动态效果：`src/main.tsx` 在 React 首帧前固定根元素 `data-motion="full"`，不提供动效模式选择项。直播飘屏与录制回放弹幕作为持续运动例外，单独遵循 `prefers-reduced-motion`（右侧弹幕列表不受影响）；其他调用方需避免非必要动画时用 `prefersReducedMotion()` 直接读系统偏好。
- 动画用于表达导航层级、操作来源与状态变化，不作为持续装饰。播放、DOM 弹幕、滚动与手势同时工作时，动画仍须可中断、可清理、不阻塞交互。

## 2. 代码归属

| 路径 | 责任 |
| --- | --- |
| `src/components/ui/` | shadcn-style 基础组件源码与 variants |
| `src/shared/components/` | 跨功能业务组件（刷新按钮、站点切换器、房间卡片、播放器控制条） |
| `src/app/layout/` | 标题栏、侧栏、顶部导航、页面滚动容器、路由动效编排 |
| `src/features/*/` | 功能页与局部状态；`features/recording/` 为桌面录制库与本地回放 |
| `src/shared/motion/` | 动画令牌、系统减少动效检测、`PagePan`、`PageZoom`、`tween()` 助手 |
| `src/shared/hooks/`、`src/shared/gestures/` | 手势 hook 与纯判定常量 |
| `src/styles.css` | 主题变量、Tailwind 映射、全局响应式规则、CSS 关键帧与 View Transition |
| `src/app/theme.ts`、`androidSystemBars.ts` | 主题解析与应用、系统亮暗监听、全局淡化、Android 系统栏图标同步 |

基础组件是仓库内可维护源码。修改 `src/components/ui/` 会影响多个功能页，必须先检查所有调用方；页面特有布局留在对应 feature 中。项目配置在 `components.json`：样式 `base-nova`、primitive Base UI、Tailwind v4、路径别名 `@/`。

## 3. UI 规范

### 3.1 组件选择

新增 UI 时先复用 `src/components/ui/` 现有组件，再考虑扩展 variant，最后才创建新的基础组件。

- 明确命令用 `Button`；二元设置用 `Switch` / `Toggle` / `Checkbox`；有限选项用 `Select` / `ToggleGroup`；页面视图切换用 `Tabs`（`TabsTrigger` 必须在 `TabsList` 内）。
- 表单用 `Field` 系列；加载、空状态与通知分别用 `Skeleton`、`Empty`、`Spinner` 和项目 Base UI toast 封装导出的 `notify`。
- 破坏性确认用 `AlertDialog`；移动端底部面板用 `Drawer`；短上下文内容用 `Popover`。任务型 Overlay 必须有可访问标题，必要时用 `sr-only` 隐藏视觉标题。
- Card 只用于独立、重复或需要明确边界的内容；不嵌套 Card，不把整段页面当作悬浮 Card。Base UI 通过 `render` 组合自定义 trigger，不使用 Radix 的 `asChild`。
- 全屏图层内的 Overlay 必须传 `container`（播放器传 `player.stageRef`），否则默认 portal 到 `<body>` 会被 top layer 压住；`notify` 视口由 `setToastPortalContainer()` 在全屏期间整体移入 stage，退出后还原。

### 3.2 主题与语义令牌

亮暗主题定义在 `src/styles.css`：`:root` 提供亮色变量与 `color-scheme: light`，`.dark` 覆盖同一组语义变量，`@theme inline` 把 CSS 变量映射为 `bg-background`、`text-foreground`、`bg-card`、`text-muted-foreground` 等 utilities。

- `applyTheme()` 按 `light` / `dark` / `system` 切换根元素 `.dark` class，Zustand 设置变化由 `src/main.tsx` 订阅并立即应用。Android 上同一次调用还经 `src/app/androidSystemBars.ts` 把 resolved 亮暗同步到系统栏图标颜色（Kotlin `RliveSystemBars` 唯一写入；冷启动用 SharedPreferences 记忆值恢复图标外观并同步启动窗口与 WebView 预绘制底色；全屏覆盖为白图标）。
- 新增颜色先确定语义，再同时补齐亮暗值与 `@theme inline` 映射。组件中只用语义 token，不写 `bg-white dark:bg-gray-*`，不用原始蓝红绿代替状态语义。仅当 `RecordedDanmakuCanvas` 这类底层绘图无法消费 Tailwind class 时，才使用明确记录用途的中性描边颜色。
- 字体栈以 Geist Variable 的 Latin 子集为首选，中文依次回退 `PingFang SC`、`Microsoft YaHei`、`Noto Sans SC`。紧凑面板保持小字号、短行高，不按视口宽度缩放字体。

### 3.3 图标、文案与可访问性

- 用 `lucide-react`，不手绘已有语义的 SVG。Button 内图标用 `data-icon="inline-start"` / `data-icon="inline-end"`，基础组件负责尺寸时不额外加尺寸 class。
- 纯图标按钮必须有中文 `aria-label`，不熟悉的工具图标同时提供 Tooltip。焦点环由 `src/styles.css` 的全局 `:focus-visible` 规则绘制，新增交互元素复用 `focus-ring` 或基础组件的 `focus-visible` 样式。
- 加载与异步结果用 `role="status"`、`aria-live` 或组件内已有语义，不只靠颜色表达状态。
- 界面文案以中文为主，代码标识符、协议名与站点名保留原文。

### 3.4 布局与滚动所有权

`Shell` 是布局与滚动的唯一编排入口。

| 约束 | 规则 |
| --- | --- |
| 桌面侧栏 | 宽 `68px` |
| 移动端导航 | 底部导航含安全区；全部可见入口在同一 flex 容器内等宽分配 |
| 触摸目标 | 应用导航与表单至少 `44px`；仅播放器边缘媒体操作可用 `32px` 例外 |
| 安全区 | `env(safe-area-inset-*)` 用于 edge-to-edge、底部导航、Drawer、悬浮按钮，不用固定 padding 覆盖 |
| 横向溢出 | 由 `main[data-slot="app-content"]` 裁剪 |
| 纵向滚动 | 由 `div[data-slot="app-page"]` 承担（`overflow-y-auto`、`overscroll-y-contain`、`touch-pan-y`） |

feature 页面用 `min-h-full` 或内容自然高度，不再创建抢占滚轮和触摸手势的全屏滚动层。给祖先加 `overflow-hidden`、`h-full` 或 transform 前，必须确认没有截断 `app-page` 的滚动范围，也没有改变 fixed / fullscreen 元素的 containing block。短横屏手机由 `src/styles.css` 的 coarse-pointer media query 单独压缩标题栏、底部导航与页面 padding；新增 fixed / FAB 控件必须检查与底栏、安全区和其他 Overlay 的遮挡关系。

## 4. 动画架构

### 4.1 选择流程

| 需求 | 首选机制 |
| --- | --- |
| Hover、focus、pressed、简单显隐 | Tailwind / CSS transition |
| 单组件内的运行时入场或反馈 | Web Animations（`src/shared/motion/tween.ts` 的 `tween()`） |
| 多步编排序列 | 多条并行 Web Animations 补间 + `Promise.all` |
| 路由整页切换 / 沉浸式播放页进出 | `PagePan` / `PageZoom`，不要在页面内再叠一层路由动画 |
| 跟随手指并可回弹的横向切换 | `useHorizontalSwipe` |
| 触摸长按唤出操作抽屉 | `useLongPress` / `useLongPressDrawer` |
| 整个文档主题快照切换 | `fadeTheme()` |
| 滚动驱动动画 | 当前没有默认方案；需明确产品需求并证明不干扰页面滚动 |

### 4.2 共享 motion tokens

`src/shared/motion/tokens.ts` 输出 Web Animations 与 CSS 共用的参数，不依赖任何动画库。不要在 feature 内复制这些数值；确有不同语义时可局部覆盖，但要用注释解释原因。

| Token / 配置 | 当前值 | 用途 |
| --- | --- | --- |
| `EASE_OUT` | `cubic-bezier(0.215, 0.61, 0.355, 1)` | 入场减速曲线（quad out 的 CSS 等价），JS 与 CSS 共用 |
| 桌面 enter / exit | `0.22s` | 桌面页面平移与 Zoom |
| 触控 enter / exit | `0.20s` | 移动端更快完成页面读取 |
| `roomZoom` | 桌面 `0.26s`，触摸 `0.22s` | 直播间进出共用同一时长（比整页平移略长） |
| `ROOM_ZOOM_START_SCALE` / `BACKDROP_SCALE` / `EXIT_RATIO` | `0.96` / `1.02` / `0.72` | Zoom 起始缩放、退出时目标页起始缩放、离场补间占总时长比例 |
| `PAGE_PAN_PERCENT` | `110%` | 横向页面清除 padding 边缘残影 |
| `SWIPE_SETTLE_EASING` | 同 `EASE_OUT` | 手势释放收尾曲线 |
| 手势收尾时长 | `horizontalSwipeSettleDuration()`，钳制 `170ms ~ 400ms` | 由剩余距离与释放速度推导，不是常量 |

`src/shared/motion/preference.ts` 只做系统 `prefers-reduced-motion` 检测，不解析或持久化动效模式。

### 4.3 `PagePan`：路由与平台平移

`src/shared/motion/PagePan.tsx` 保留上一个 React subtree 直到离场结束后再卸载。出场页 `absolute inset-0` 离开布局流，两页保持完全不透明并同步移动，表现为一整块连续表面而非交叉淡化。时长与 easing 读 `motionProfile()`。必须遵守：

- 上一页快照只在 `useLayoutEffect` 中更新为 React 已提交的 subtree，不在 render 阶段改写快照 ref（React 19 可能放弃或重放并发 render，ref 写入不会回滚，会漏掉退出层）。`PageZoom` 同一约束。
- 动画完成后先用 `commitStyles()` 固定旧页离屏最终位置，再同步卸载旧 subtree；不能先 cancel Animation 再把卸载放进低优先级更新，否则 Android 合成器可能短暂恢复旧页原位。
- 直接侧栏导航时 `RouteOutlet` 延迟一个 `requestAnimationFrame` 再以 `startTransition()` 挂载目标 route，让 compositor 先启动平移。

`Shell` 当前映射：桌面侧栏点击按侧栏项目顺序纵向平移；移动端底部导航、浏览器前进后退（按 history index 定方向）、首页平台切换、IPTV 源切换、关注页 IPTV 分组切换均为横向平移；关注页「直播关注 / IPTV 频道」在移动端由 `useHorizontalSwipe` 驱动两个常挂载面板 track、桌面用局部补间做短距离淡入平移；设置页一级与二级共用 `PagePan`（进入分类时一级左退、二级右进，返回反转），每层在内容层内独立纵向滚动。不属于上述来源的普通内容更新直接替换，不自动加整页动画。

### 4.4 `PageZoom`：沉浸式播放页进出

`src/shared/motion/PageZoom.tsx` 覆盖 `/room/*` 与 `/iptv/play`，`zoomKey` 取各自 pathname，因此两者之间切换不会被当成同一页而跳过过渡。沉浸式播放页只有 Zoom 一层路由动画：`Shell` 沉浸式分支渲染裸容器，路由级 `PagePan` 只作用于非沉浸式分支。

- 进入：`scale 0.96 -> 1` + `opacity 0 -> 1`，浏览列表已立即卸载。完成后清除 transform、opacity、visibility、transform origin 与 `will-change`，保证全屏播放器没有永久 transformed ancestor。
- 退出：双层交叉溶解，两条补间从时间 `0` 同时开始。离场 subtree 保持挂载执行 `scale 1 -> 0.96` + `opacity 1 -> 0`，只跑 `duration × 0.72` 以形成重叠，避免视口中间穿过一帧全空画面；目标页 `scale 1.02 -> 1` + `opacity 0 -> 1` 展开，反向缩放刻意比 `0.96` 更贴近 `1`，因为它是背景而非主体。
- 退出期间入场节点带 `bg-background`（否则离场直播间会透过淡入中的目标页继续可见）；两个节点在过渡期都 `pointer-events: none`。
- 离场 subtree 在两条补间都完成后才卸载，且不先恢复 opacity。删除前两道防闪措施：先 `commitStyles()` 把离场结束帧固化为内联样式再 cancel（否则 cancel 撤销 fill 的瞬间节点会以完全不透明重现）；再撤销离场层的 `will-change` 提升并等一帧合成后才移除子树（部分 WebView 会把该合成层的旧纹理再合成一两帧）。

房间 A 通过右侧关注栏切到房间 B 时使用 replace，B 的返回目标固定为 `/follow`，退出仍由同一个 `PageZoom` 处理。

### 4.5 `useHorizontalSwipe`：横向手势

`src/shared/hooks/useHorizontalSwipe.ts` 用 capture-phase pointer handler 处理横向切换并保留原生纵向滚动；阈值常量在 `src/shared/gestures/horizontalSwipe.ts`。

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `HORIZONTAL_SWIPE_LOCK_DISTANCE_PX` | `10px` | 方向锁定距离，横向距离需大于纵向的 `1.25` 倍 |
| 边界阻尼 | `0.18` 倍位移 | 首尾表达不可继续而非循环 |
| 快扫速度阈值 | `≥0.32 px/ms` | 同向快扫任意距离都翻页；反向回拉任意距离都取消 |
| `HORIZONTAL_SWIPE_COMMIT_PROGRESS` | `0.1` | 其余情况按页面实际走过的屏占比判定 |
| 速度采样窗口 | 最近 `32ms` 样本均值 | 差分噪声会把稳定拖动误判为快扫；松手前停顿读数为 `0`，回到位置判定 |
| 提交兜底回滚 | `600ms` 超时 | 必须长于收尾上限 `400ms`；`BrowserRouter` 的 `startTransition` 可能延后数帧提交 |

实现约束：

- 跟手阶段直接在 pointermove 中写 `transform`，不合并到 `requestAnimationFrame`（合并会让每帧绘制上一帧的手指位置，就是「不跟手」的观感）。释放后由 Web Animations 接管剩余位移，不用 JS 补间：翻页会触发 React 提交，rAF ticker 与之争抢主线程会吞掉收尾帧。收尾动画必须在通知 React 之前启动，顺序不能颠倒。
- `layout` 只有两种：`track` 按**绝对索引**把所有挂载页排在 `index × width`、整层平移到 `-活动索引 × width`（提交时无页需要位移，用于 Shell 移动端平台切换、关注页与历史页双 Tab、房间侧栏 Tab）；`page` 只承载当前一页，提交时先按 `horizontalSwipeCommitOffset` 重基到一屏外再滑入 `0`，供相邻页未挂载的条带使用。`track` 宽度取移动层父元素 `clientWidth`，因此点击 Tab 触发的切换首次交互即可动画。
- 中途抓住正在收尾的页面时从其当前实际像素位置（`DOMMatrixReadOnly`）接管，不回跳。相邻平台页为无缝预览保持挂载，但用 layout/paint/style containment 隔离；完全离屏页的 CSS animation 暂停。
- Slider、Input、Textarea、Select、可编辑区域与 ScrollArea scrollbar 拥有自己的连续手势，不被页面 swipe 接管；已识别 swipe 后短暂抑制合成 click。
- 开始新手势、禁用 hook 或卸载时必须取消在飞 Animation、清兜底定时器并清除 transform / `will-change`；取消收尾动画前先把当前像素位置写回 inline style。
- 移动层的 `transform` 会让它成为 `position: fixed` 后代的包含块：`track` 连静止时都带着 `translate3d(-活动索引 × width, 0, 0)`，落在其中的固定定位层会被整层平移（RefreshFab 曾随内容滚走，关注页 dnd-kit `DragOverlay` 曾偏移一个 track 左上角）。这类层必须 `createPortal` 到 `document.body`，不能只靠 `position: fixed`。

### 4.6 `useLongPress`：触摸长按

`src/shared/hooks/useLongPress.ts` 把「按住约半秒」翻译为一次回调，`useLongPressDrawer` 在其上封装抽屉开关、Android Back 收起与点按抑制，由 `RoomCard` 与关注页卡片共用。判定常量在 `src/shared/gestures/longPress.ts`：触发 `500ms`、漂移容忍半径 `10px`、`LONG_PRESS_CONTEXTMENU_GRACE_MS` `300ms`。

- 只有触摸 / 触控笔主指针参与；鼠标交给右键菜单，桌面端 `enabled: false`。触发后松手可能合成一次 click，调用方需用「触发时置位、下次 pointerdown 清零」的标记抑制。
- 取消判定除卡片自身的 pointermove/up/cancel 外，还必须镜像到 **window 捕获阶段**：祖先横向翻页锁定手势后会 `setPointerCapture` 并 `stopPropagation`，卡片自身取消路径会失明。`HORIZONTAL_SWIPE_LOCK_DISTANCE_PX`（10px）不小于长按容忍半径，保证能锁定为翻页的手势在计时器到期前必已取消。
- Android WebView 在系统长按点派发原生 `contextmenu`：调用方在卡片上 `preventDefault` 并经 `triggerNow()` 立即触发；自持计时器承担 iOS WebView 与兜底。`contextmenu` 必须归属本卡片的按压，距上次触发不足一个触发周期的伪信号在宽限外一律忽略。
- 卡片封面在 `@media (pointer: coarse)` 下 `pointer-events: none`（`.room-card img`、`[data-motion-press] img`）：Android WebView 149+ 在 `<img>` 上识别长按会启动原生图片菜单接管，应用层 `preventDefault` 后触摸路由会悬死。iOS 长按封面的系统菜单由同组规则中的 `-webkit-touch-callout: none` 压制。
- 抽屉退出动画期间（`data-closed` 存在时）遮罩与弹层 `pointer-events: none`（`styles.css` 的 `.motion-dialog-overlay` 等规则），避免抬手事件派发到已卸载节点导致后续点按不再合成 click。
- 关注卡片上长按计时与 dnd-kit 拖拽激活器共用同一次 pointerdown；触摸不激活 MouseSensor。

### 4.7 主题全局淡化

主题切换由 `src/app/theme.ts`、`src/app/layout/Sidebar.tsx` 与设置页「外观配置」协作，提供跟随系统（默认）、浅色、深色三档，跟随系统时由 `watchSystemThemeChanges()` 实时重应用。流程：`document.startViewTransition()` 捕获旧、新快照，`flushSync()` 在 update callback 中应用 Zustand 主题（确保新快照含更新后的 React 图标与 `.dark` class），CSS `theme-fade` keyframe 对 `::view-transition-new(root)` 做 `opacity` 0→1 整屏淡入、旧快照静态垫底，`ViewTransition.finished` 作为唯一结束信号并清理 `data-theme-fade`、临时 CSS 变量与行内样式。

时长桌面 `280ms`、coarse pointer `240ms`，指针与键盘激活共用同一时间线，侧栏按钮另有 scale / rotation 反馈。`src/styles.css` 关闭浏览器默认的 root-group `250ms` 插值与 snapshot crossfade，整个切换只保留一条淡化时间线。不支持 View Transition API 时直接切换主题；快速连续点击由组件锁与可取消 transition 约束，不能留下临时 CSS 变量或未结束的快照状态。

### 4.8 CSS 动画的适用范围

CSS 只承担无需 JavaScript 编排的短状态，交互动画优先用可中断 transition，只在主题淡化、加载旋转等确定时间线使用 keyframes。新增效果继续只动画 `transform` / `opacity`，并复用 `--motion-ease-out` 或 `--motion-ease-drawer`。

| 场景 | 实现 / 时长 |
| --- | --- |
| hover、focus、pressed、Tabs indicator、播放器控制条显隐 | `transition-*` |
| 加载图标连续旋转 | `animate-spin-soft` |
| Popover、Tooltip、Dialog、AlertDialog、Drawer、Toast | Base UI `data-starting-style` / `data-ending-style`，反向操作可从当前帧继续 |
| Overlay 时长 | Drawer 进 `240ms` / 退 `160ms`；Dialog `200ms` / `140ms`；Popover `160ms` / `110ms` |
| Tooltip | 首次 Hover 延迟 `350ms`，相邻 Tooltip 用即时状态并跳过动画 |

## 5. Web Animations 实现规范

最小可用模板（事件回调中的按压反馈用同一组合，关键帧换成 `[{ transform: "scale(0.94)" }, { transform: "scale(1)" }]`）：

```tsx
useLayoutEffect(() => {
  const target = rootRef.current?.querySelector<HTMLElement>("[data-motion-target]");
  if (!target) return;
  const { duration, ease } = motionProfile().enter;
  target.style.willChange = "transform,opacity";
  settleTween(
    target,
    tween(
      target,
      [{ opacity: 0, transform: "translate3d(0,8px,0)" }, { opacity: 1, transform: "none" }],
      { duration: duration * 1000, easing: ease, fill: "both" },
    ),
  );
}, [contentKey]);
```

补间规则：

- 使用真实 DOM ref；字符串 selector 必须限定在 scope 容器内。只在浏览器 lifecycle（effect、事件回调）内创建动画，不在 render 阶段调用。
- `tween()` 先取消同元素上仍在运行的旧补间，元素随子树卸载后条目由 WeakMap 回收。结束帧与自然态一致时用 `settleTween`（完成后撤销动画并归还行内样式）；结束态需要保留时用 `commitTween`（把终态固化为内联样式再撤销动画）。
- 不要让已完成的 `fill` 动画长期持有终态：它已不在 `tween()` 的取消登记里，且部分 WebView 会把这种动画从 `getAnimations()` 移除而效果仍挂在级联上，之后任何 cancel 都无法清除。原生 event listener、`requestAnimationFrame`、长时间存活的 Animation 与 pointer capture 仍需各自显式清理。

Exit 动画：React 在节点离开 element tree 时立即卸载，不能对已卸载 DOM 做退出动画。已有场景复用 `PagePan` 或 `PageZoom`，不在 feature 中复制持有逻辑；确需自建时按顺序做——layout effect 记录已提交 subtree 并由 state 保存快照、新旧 subtree 同时渲染（旧节点脱离布局流并禁用输入）、执行 exit 并在取消或路由再变化时终止、最终帧后固定样式并同步卸载（完成回调必须校验快照身份）、清理 animation / RAF / inline style / `will-change`。

## 6. 性能规则

通用：

- 避免用动画修改 `width`、`height`、`top`、`left`、margin、padding 等触发布局的属性。先完成 DOM 读取再批量写入，不在一个 pointermove 中交替读布局和写 style。
- `will-change` 只在动画运行时设置，结束、取消与卸载都必须清除。同一 target 开始新补间前先由 `tween()` 自动取消（或手动 `killTweensOf()`）。
- 相同列表效果用一条编排好的序列，不为每项创建独立 delay；动画目标数量必须有界。长列表优先只动画首屏或有界数量，无限滚动追加内容默认直接出现，并继续用 `.room-card` 的 `content-visibility: auto`。
- 连续手势输入不进 React state（只承担刷新、选中项等离散状态）。下拉刷新位移经 RAF 合并，横向滑动位移直接在 pointermove 中写 transform。
- 动画 wrapper 不得扩大滚动区域；外层负责 clipping，纵向滚动留给 `app-page`。Android 宿主不请求固定显示模式或刷新率偏好，动画全部按时间基准推进，不设固定帧率 ticker。
- 不把「组件出现」默认等同于「需要动画」：高频列表刷新、轮询状态、弹幕新增和播放器帧更新通常应直接更新。

播放页（与播放器、danmu.js 共享主线程与合成预算）：

- 避免模糊、滤镜、大面积阴影变化和无限背景动画。控制栏用 `player-scrim-overlay`（由底边向上淡出的黑色渐变，画在 `::before` 上且高于控制栏自身高度，不设上边框、不用 `backdrop-filter`），自动显隐仅合成 opacity，不触发播放器 React 重渲染。
- 音量与播放设置 Drawer / 弹层用 `glass-surface-overlay`：桌面 `14px` blur；coarse pointer 或 slow-update 设备关闭 `backdrop-filter`，改用更实的静态半透明底色。移动端对话框遮罩、视频浮层与房间卡片角标同样不采样动态背景。
- 浏览器回退亮度使用覆盖视频与弹幕 DOM 容器的黑色 opacity 叠层，不对整幅动态画面用 `filter: brightness()`；手势提示通过局部 DOM 写入更新，不每步重渲染 `PlayerPane`。
- 移动端推荐、分类、分区、关注、历史、IPTV 及房间内关注列表统一使用下拉刷新，桌面端保留刷新按钮入口。fullscreen 播放器稳定后不能保留 transformed ancestor；Zoom 与页面动画完成时必须恢复普通绘制。

画面弹幕（`DanmuJsDanmaku`，会话与实例契约见 [播放器技术文档](播放器技术文档.md)）：

- 位置与时序由 danmu.js 的单条 linear transform transition 管理，不维护应用级逐帧渲染循环、目标 FPS、跳帧或位图缓存。普通消息用 `moveV: 100` 与 `setPlayRate` 实现 `50–200 px/s` 匀速移动，SC 只用平台提供的持续时长；不要为调整快慢叠加 JS 补间。聚合只更新同一活动 bullet 的文本与计数槽。
- 数据池、本地 metadata、聚合目标与 SC 计时器都必须有界，并在 `bullet_remove` / `destroy` 时同步释放；实例必须等容器非零尺寸后才启动，隐藏或卸载时销毁以免继续分配 DOM。
- 两个容器都保持 `opacity: 1`，普通消息与 SC 各自从统一的 `danmaku_opacity` 写到元素上，避免容器与子项透明度相乘。字号与描边变化要同时更新两层的现有 DOM 与后续 comment，描边为 0 时移除 `-webkit-text-stroke` 与 `paint-order`；resize 与全屏后由各自 ResizeObserver 重排。

## 7. 流程与验证清单

新增 UI 或动画：先确定 owner（基础组件 / shared component / Shell / feature），检查 `src/components/ui/` 与现有 motion 封装避免平行实现，先完成无动画的布局、滚动、焦点、键盘与触控行为，再按 4.1 节选择机制并实现取消、卸载与 inline style 清理。最后执行检查与浏览器验证，交付前同步 Windows 镜像。

静态检查（命令细节见 [开发指南](开发指南.md)）：纯文档修改不要求运行时测试；UI 或动画实现至少执行 `bun run check` 与对应单元测试，交付前运行 `bun run build`。

浏览器检查至少覆盖桌面 `1280x720` 以上、手机竖屏约 `360x732`、coarse pointer 短横屏约 `844x390`，以及系统开启 `prefers-reduced-motion: reduce` 的情况（页面导航仍沿用完整动效；直播飘屏按既有策略停用，录制回放弹幕停止横向飘移并按媒体时间短暂静态显示，偏好恢复后直播弹幕建立全新会话、不补放旧消息）。

每个动画检查开始帧、中间帧、最终帧与快速重复操作：

- 页面没有空白、闪回、旧 subtree 短暂复活或边缘残影；退出动画结束后旧直播 subtree 直接卸载、不恢复 opacity。
- 动画过程中无双滚动条，结束后仍可完整纵向滚动；fixed、FAB、底部导航、Drawer 与播放器控制不互相遮挡。
- 触摸 swipe 不抢占纵向滚动、Slider、Input 与 ScrollArea scrollbar。
- 最终 DOM 不残留 transform、opacity、visibility、`will-change`、临时 data attribute 或 finished Animation。
- Console 无新增 error/warning，动画运行时无明显 layout shift。
- Home Card、关注 Card、深链接与「关注栏切房后返回 `/follow`」均使用 `PageZoom`，导航目标正确。

主题与播放器叠层类视觉效果不能只检查 DOM 存在，应结合截图或像素检查确认实际画面非空且方向正确。

## 8. 关键源码索引

目录责任见第 2 节。改动动效或布局时最常需要读的具体文件：

| 文件 | 内容 |
| --- | --- |
| `src/styles.css` | 主题 tokens、全局响应式规则、View Transition 与 CSS 动画 |
| `src/app/layout/Shell.tsx` | 页面滚动、路由来源识别与动画编排 |
| `src/app/theme.ts`、`src/app/androidSystemBars.ts` | 主题应用、系统亮暗监听、全局淡化与 Android 系统栏图标同步 |
| `src/shared/motion/tween.ts`、`tokens.ts`、`preference.ts` | 补间助手、共享 easing / duration 与系统减少动效检测 |
| `src/shared/motion/PagePan.tsx`、`PageZoom.tsx` | 整页平移与 outgoing subtree 生命周期、沉浸式播放页 Zoom |
| `src/shared/gestures/horizontalSwipe.ts`、`longPress.ts` | swipe 与长按的阈值常量和纯判定逻辑 |
| `src/shared/components/player/PlayerControls.tsx` | 共享播放控制条与安全区避让 |
