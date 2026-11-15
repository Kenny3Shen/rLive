# GPUI Kit IPTV WebAssembly 实验（已撤销）

## 当前状态

2026-11-15，IPTV GPUI WebAssembly 实验已撤销。实验入口、环境变量配置、构建脚本、Vite 插件、iframe 宿主、Rust WASM crate 和相关测试均已从应用代码中移除。

当前应用恢复为既有的 Tauri 2、React 和 Video.js 架构，不提供 GPUI 实验运行入口，也没有可从仓库启动的 GPUI IPTV 页面。`feat/gpui-migration` 分支只承载迁移调研和后续试验，不代表原生迁移已经完成；迁移分析见[GPUI迁移调研.md](GPUI迁移调研.md)。

撤销后的现有 IPTV 回归为 7 个测试文件共 40 项通过，包含 favorites。下面记录的 43 项前端测试和 4 项 Rust 测试属于实验存续期间的历史验收，不应作为当前实现状态。

## 实验结构

React 仍是频道数据和播放业务的唯一所有者。实验只把发现页的展示快照交给 iframe，由其中的 GPUI Kit WASM 虚拟网格负责绘制和二维选择：

```text
IptvController
  ├─ Rust Tauri commands 加载和探测频道
  ├─ 现有搜索、分组、可用性筛选
  └─ 展示快照
       └─ iframe 内嵌 GPUI 页面
            └─ GPUI Kit WASM 虚拟卡片网格
                 └─ 选择不透明频道 id
                      └─ 回到现有 openChannel
```

iframe 隔离了 GPUI Web 的单窗口和单画布生命周期。重试会创建新实例，切回标准列表会销毁旧实例。选择结果必须匹配当前快照 revision 和频道 id，之后才回到 React 的原有 `/iptv/play` 路由。

实验没有替换源加载、可用性探测、关注、播放器或代理逻辑，也没有把 GPUI 引入 Tauri 主窗口的 React 生命周期。

## 数据与协议边界

实验只向 iframe 传展示字段，不传播放 URL、请求头、源地址或原始台标地址。React 继续管理频道源、查询、搜索、分组、可用性和播放入口。

快照包含 `revision`、`dark`、`channels` 和 `appearance`。不透明频道 id 在不同筛选结果之间保持稳定；React 打开频道时会同时校验 revision 和 id，避免迟到的旧结果串入新列表。

`appearance` 包含：

- 当前根字号 `remSize`，单位为 CSS px。
- 紧凑模式 `compact`。
- 卡片圆角 `cardRadius` 和台标圆角 `logoRadius`，单位为 rem。
- `background`、`foreground`、`card`、`cardElevated`、`muted`、`mutedForeground`、`borderSubtle`、`success`、`danger`、`focusRing` 十个颜色 token。
- 每个颜色 token 是 sRGB normalized RGBA 数组 `[r, g, b, a]`，分量范围为 `0..1`。

JavaScript loader 只检查快照的基本结构，完整协议解析由 Rust serde 负责，避免在两层各自维护字段语义。

台标只允许由 React 获取、校验并转码后的安全 PNG data URI。Rust 不下载台标，也不读取原始台标 URL；宿主只加载当前可见 id 中与当前 revision 匹配的台标，首屏预取前 24 个，加载为 4 并发，单张 8 秒超时，最长边缩放到 128 px，PNG data URL 缓存最多 256 项，请求不带 referrer。CORS、解码或转码失败时显示通用电视图标，不阻断频道列表。

## 网格与字体

GPUI 网格复用 React 列表的 17 rem 卡片最小宽度、0.625 rem 间距、4.25 rem 卡片高度和 2.5 rem 台标容器。频道标题使用 0.875 rem 和 500 字重，分组与延迟使用 0.75 rem 和 400 字重。虚拟化以网格行为单位，末行卡片保持与完整行相同的宽度；滚动条属于网格视口。

实验开启时，IPTV 页面滚动容器保留稳定的 scrollbar gutter，避免切换标准分页列表和 GPUI 内部滚动时出现内容横移。

字体使用固定 Geist commit `ef2597cfc42f4797676df105517ccc0a1cfa6569` 的 Regular 400 与 Medium 500 静态 TTF，OFL 随包。使用静态 400/500 是为保证 GPUI 字体登记字重；单可变字体按 face 缓存 400，500/600 请求会被覆盖。中文与 emoji 依赖系统字体回退，因此不保证与 React DOM 的字体栅格化和字形度量完全一致。

## 历史验收

### 2026-11-15 样式对齐

- 前端桥接和现有 IPTV 回归共 43 项通过，Rust 网格几何、导航和延迟格式单测 4 项通过；`bun run check`、loader 类型检查、Rust WASM `cargo check` 和 `cargo fmt --check` 通过。
- Windows WebView2 主窗口使用真实中文源的 220 个频道验收。1920 x 1032 视口下，标准列表和 GPUI 区域均从 `(413, 156)` 开始，宽度均为 1376 CSS px，网格为四列；1280 宽视口为三列，760 宽视口为单列。
- 根字号从 16 调到 20 CSS px 后，字体、台标、间距、行高与列数同步缩放。明暗主题的颜色与圆角 token 同步。
- 搜索 ABN、CCTV 和清空搜索分别得到 1、38 和 220 个频道；切回标准列表会销毁 iframe 并恢复 120 张分页卡片。
- 从宿主控件按 Tab 可进入网格，方向键移动后有可见选中轮廓；Enter、Space 和鼠标点击均进入原有 `/iptv/play`。Shift-Tab 返回宿主切换控件。
- 验收截图保存于本地，未进入版本库。该轮只验证样式与播放入口，不重新确认上游频道持续可播。

### 2026-11-14 初始实验

- 前端桥接及现有 IPTV 路由、筛选、缓存、探测回归共 40 项通过；Rust WASM `cargo check` 和格式检查通过。
- 开发 WASM 为 34,313,156 字节，约 32.7 MiB。默认前端构建不包含 GPUI 资源。
- Windows WebView2 主窗口加载 220 个频道，搜索 CCTV 后同步为 38 个；中文状态及浅色、深色主题可见，页面重载后收到 Rust 首帧 ready。
- 方向键、Enter 和鼠标点击均进入原有播放路由；资源缺失时显示初始化超时，切回标准列表后恢复分页卡片。
- 两个测试源没有稳定输出视频，其中 CCTV+ 源返回 HLS 分片 404。本轮只确认播放入口与播放器挂载，没有确认上游源持续可播。

## 未验证与限制

- Linux、macOS 和 Android 没有完成该实验的原生或 Web 验收。
- Windows WebView2 实验已验收方向键、Enter、Space、Tab、Shift-Tab 的列表进出；其他平台、原生路径、屏幕阅读器和完整可访问性未验收。Canvas 内容不能自动等价于可读的 DOM 语义。
- 没有证明性能提升，也没有形成冷启动、重绘或长列表滚动的对比数据。
- 没有验证原生 GPUI 窗口、Rust IPC 业务迁移或原生视频播放。
- WASM 仍以上游展示用途为主，浏览器输入、字体、启动耗时、部署和可访问性都需要按具体产品验证。
- 本次撤销只恢复应用架构，不代表 IPTV 原生迁移完成，也不代表其他平台获得 GPUI 支持。
