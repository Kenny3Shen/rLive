fn main() {
    #[cfg(target_os = "linux")]
    {
        // vendored 的 sherpa-onnx 构建脚本会把共享运行时库暂存在 Cargo 二进制旁边。
        // 安装后的 Linux 包会把同样的文件放在 `<prefix>/lib/rLive`，
        // 因此最终的应用 ELF 需要同时具备这两个可重定位搜索路径。
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/rLive");
    }
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-lib=dylib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:sherpa-onnx-c-api.dll");
    }
    tauri_build::build();
}
