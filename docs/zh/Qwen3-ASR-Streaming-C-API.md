# Qwen3-ASR Streaming C API 暴露流程

本文记录将 Qwen3-ASR 的逐 token streaming 从 CrispASR CLI 暴露给 Rust/Tauri（以及未来 WASM）的实施边界和建议流程。它是接口设计文档，不表示当前 rLive 已经启用逐 token 字幕；当前客户端仍使用 1–8 秒自适应窗口完成一次 `asr_transcribe` 后更新字幕。

## 现状核对

以 rLive 固定的 CrispASR 提交 `6e5bf7f` 为准：

- CLI 的 Qwen3 `transcribe_streaming` 在 `examples/cli/crispasr_backend_qwen3.cpp`，流程是“收到一个音频窗口 → 计算 mel → encoder → ChatML prompt → KV prefill → `core_greedy_decode::run_with_probs_cb`”。回调在每个新 token 解码后执行，并通过 `on_text(accumulated_text, false)` 提供中间文本，最后再发送 `final=true`。
- `src/core/greedy_decode.h` 已有 `run_with_probs_cb`，但它是 C++ 模板回调，不是稳定 ABI，不能直接从 Rust 或 WASM 调用。
- `include/crispasr_session.h` 已声明 `crispasr_session_set_token_callback`、`crispasr_drain_streamed_tokens` 等通用 token callback/polling 符号；然而 Qwen3 session 路径在 `src/crispasr_c_api.cpp` 仍调用 `run_with_probs`，先完成整段 decode，再通过 `_fire_token_callbacks` 发出 token。因此现有 callback 对 Qwen3 不是“解码过程中”回调。
- `crispasr_session_stream_open` / `crispasr_stream_feed` 是为 whisper 等 rolling-window streaming 设计的通用接口；它不能把 Qwen3 的非因果 audio encoder 变成逐音频帧 encoder streaming。
- 固定提交的 `crispasr-sys/src/lib.rs` 尚未为 token callback 和新的 streaming session 操作提供 Rust 声明；当前 WASM 绑定只有同步 `asrTranscribe` 路径。

## 目标语义

需要同时定义两种“流式”，不要混为一个 API：

1. **窗口级流式音频**：每 1–8 秒提交一个 PCM 窗口，窗口完成 encoder 后开始解码；这是当前 rLive 的实现，延迟可控、改动小。
2. **窗口内逐 token 流式解码**：同一个窗口的 encoder/prefill 完成后，每产生一个文本 token 就通知上层；它可以让字幕更早出现，但不能在 encoder 尚未完成时可靠地产生 token。

Qwen3-ASR 属于第二种能力。它不是传统 CTC/Transducer 的逐帧增量模型，不能只把 `step_ms` 调小就得到相同效果。

## 推荐实施步骤

### 1. 把 CLI 逻辑移动到核心库

在 CrispASR 核心新增 Qwen3 session streaming 内部函数，复用 CLI 的 prompt、特殊 token 过滤、语言前缀、`fix_loops` 和 `max_new_tokens` 规则。不要在 `crispasr_c_api.cpp` 复制另一份 prompt 逻辑，否则 CLI 和 C ABI 的输出会逐渐分叉。

内部函数建议接收：

```text
pcm, n_samples, language, ask, translate, max_new_tokens
on_token(token_id, decoded_piece, probability)
on_complete(final_text, status)
```

实现上使用 `run_with_probs_cb`；回调中只做特殊 token 过滤和 UTF-8 piece 解码，不执行网络、锁等待或内存无界增长。

### 2. 增加明确的 C ABI

建议增加版本化接口，而不是改变现有 `crispasr_session_transcribe` 的行为：

```c
typedef struct crispasr_streaming_options_v1 {
    int n_threads;
    int max_new_tokens;
    const char *language;
    const char *ask;
    int translate;
} crispasr_streaming_options_v1;

typedef void (*crispasr_stream_token_callback_v1)(
    const char *token_text,
    int token_index,
    float probability,
    int is_final,
    void *user_data);

CRISPASR_SESSION_API int crispasr_session_transcribe_streaming(
    crispasr_session *session,
    const float *pcm,
    int n_samples,
    const crispasr_streaming_options_v1 *options,
    crispasr_stream_token_callback_v1 callback,
    void *user_data);
```

约定：

- 返回值只表示参数/执行成功与否；最终文本应通过 `is_final=1` 的事件或单独的结果 getter 获取。
- `token_text` 只在回调期间有效；调用方要复制。token 可能是 BPE 子词，不保证是完整汉字、单词或句子。
- 回调运行在转写线程，必须快速且不可重入 session。需要跨线程时使用有界 channel/ring buffer。
- callback 清理、取消和 session close 必须有明确的生命周期顺序：先停止新任务，再清 callback/user_data，最后关闭 session。

如果需要兼容已有 ABI，可保留 `crispasr_session_set_token_callback` 作为 session 级默认 callback，再增加 `v2` 的一次性 options/callback 接口；不要让不同并发请求共享隐式全局 token 缓冲。

### 3. 更新 Rust FFI

在 `crispasr-sys/src/lib.rs` 中使用 `#[repr(C)]` 声明 options 和 callback 类型，并为函数增加 `unsafe extern "C"` 声明。Rust 封装层应：

1. 固定保存 callback userdata 的所有权，直到 C 函数返回；
2. 用 `std::sync::mpsc::sync_channel` 或 crossbeam bounded channel 传递 token，设置丢弃/取消策略；
3. 在阻塞线程池执行 C 调用，Tauri async 线程只负责收事件；
4. C 调用返回后发送一个完成或错误事件，再释放 userdata；
5. 同一 session 串行化，避免并发调用破坏 KV cache；设备切换或离开房间时用 generation/cancel 标记丢弃过期事件。

伪代码：

```rust
let (tx, rx) = sync_channel::<TokenEvent>(128);
let callback_state = CallbackState::new(tx);
spawn_blocking(move || unsafe {
    crispasr_session_transcribe_streaming(
        session,
        pcm.as_ptr(),
        pcm.len() as i32,
        &options,
        Some(token_callback_trampoline),
        &callback_state as *const _ as *mut c_void,
    )
})?;
while let Ok(event) = rx.recv() {
    app_handle.emit("asr_token", event)?;
}
```

示例只表达所有权和线程方向；实际代码不能让 callback 持有栈上 userdata 超过 C 调用生命周期，也不能在 callback 中直接调用 Tauri API。

### 4. 接入 Tauri 与字幕 UI

建议事件载荷包含 `session_id`、`window_start_ms`、`token_index`、`text`、`probability`、`is_final` 和 `generation`。前端只接受当前房间、当前 generation 的事件，按 token 顺序追加到临时字幕；收到 final 时提交为稳定字幕。新窗口开始时清理临时文本，并用窗口偏移修正显示时间。

不要把 token 事件写入 SQLite，也不要让每个 token 触发 React 全树渲染。可在 30–60 Hz 合并 UI 更新，字幕字号仍只由 `asr_font_size` 控制。

### 5. WASM 的边界

浏览器 WASM 不能直接调用桌面动态库的 C ABI。若未来要支持 WASM：

- 将 CrispASR/C++ 编译为 Emscripten WASM，并把 callback 转成 `EM_JS`/`emscripten::val` 或共享内存 ring buffer；
- 在 Web Worker 中加载模型、执行 encoder/decode，并通过 `postMessage` 发送 token；主线程只更新字幕；
- 模型内存、WASM 线性内存和浏览器 AudioWorklet 的复制成本必须单独评估；
- 不能把桌面 Tauri 的 `invoke`/原生指针直接暴露给 WASM。

如果不想维护 Emscripten 构建，浏览器更现实的选择是 Worker + 本地服务/原生 companion，通过 WebSocket 传 token；这不属于纯 WASM。

## 实时性与正确性检查清单

- **窗口边界**：继续使用 1–8 秒和有限背压；不要为了 token 更早而无限缩短 encoder 窗口。
- **VAD**：VAD 返回空片段时不启动 Qwen3 decode；有语音时 token 时间轴仍以窗口起点为偏移。
- **时间戳**：Qwen3 当前 token callback 没有可靠的 token 时间戳；只能标记窗口范围，不能伪造逐 token 精确时间。
- **去重**：重叠窗口会重复文本，采用 token/text LCS 或稳定前缀去重；final 前的临时 token 不应重复写入历史。
- **背压**：callback 必须有界；UI 消费慢时合并临时文本或丢弃旧 partial，不能阻塞模型线程。
- **取消**：房间切换、字幕关闭、设备切换和窗口销毁都必须可取消，并忽略过期 generation。
- **回归**：同一音频分别走 CLI `--live`、C ABI 和现有同步 API，对比最终文本、特殊 token 过滤、EOS、语言提示和空音频行为。

## 参考

- [CrispASR streaming 文档](https://github.com/CrispStrobe/CrispASR/blob/main/docs/streaming.md)
- [CrispASR concurrency 文档](https://github.com/CrispStrobe/CrispASR/blob/main/docs/concurrency.md)
- [CrispASR Rust bindings 文档](https://github.com/CrispStrobe/CrispASR/blob/main/docs/bindings.md)
- [Qwen3-ASR CLI adapter（固定提交）](https://github.com/CrispStrobe/CrispASR/blob/6e5bf7ff1de640617726c93a017fd7df855874c4/examples/cli/crispasr_backend_qwen3.cpp)
- [CrispASR session C header（固定提交）](https://github.com/CrispStrobe/CrispASR/blob/6e5bf7ff1de640617726c93a017fd7df855874c4/include/crispasr_session.h)
