fn main() {
    // nightly/LLVM23 和 NDK clang 都可能生成 AArch64 outline atomic helper 调用；
    // Android 系统库不导出这些符号，因此在最终 cdylib 链接时静态解析 NDK
    // compiler-rt archive，保留默认的 ARMv8 + outline runtime fallback。
    if is_android_aarch64() {
        link_android_aarch64_atomic_builtins();
    }

    // tauri-build 默认把应用清单编进资源，只链进二进制；lib 的单元测试可执行文件拿不到。
    // 测试同样导入 comctl32 v6 才有的 `TaskDialogIndirect`，没有清单时 Windows 加载器
    // 以 STATUS_ENTRYPOINT_NOT_FOUND 拒绝启动。改由 MSVC 链接器把同一份清单嵌进
    // 所有链接产物，并关掉 tauri-build 的那份，避免重复的清单资源。
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        let manifest =
            std::path::Path::new(&target("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}

fn is_android_aarch64() -> bool {
    target("CARGO_CFG_TARGET_OS") == "android" && target("CARGO_CFG_TARGET_ARCH") == "aarch64"
}

fn target(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

fn link_android_aarch64_atomic_builtins() {
    const CC_VAR: &str = "CC_aarch64_linux_android";
    const LINKER_VAR: &str = "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER";
    const BUILTINS: &str = "libclang_rt.builtins-aarch64-android.a";

    println!("cargo:rerun-if-env-changed={CC_VAR}");
    println!("cargo:rerun-if-env-changed={LINKER_VAR}");

    let clang = [CC_VAR, LINKER_VAR]
        .into_iter()
        .find_map(|key| std::env::var_os(key).filter(|value| !value.is_empty()))
        .unwrap_or_else(|| {
            panic!(
                "Android aarch64 构建需要 NDK clang：请配置 {CC_VAR} 或 {LINKER_VAR}（例如通过 bun run tauri）"
            )
        });

    let output = std::process::Command::new(&clang)
        .arg(format!("-print-file-name={BUILTINS}"))
        .output()
        .unwrap_or_else(|error| panic!("无法运行 NDK clang {:?}: {error}", clang));
    if !output.status.success() {
        panic!(
            "NDK clang 无法解析 {BUILTINS}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let archive = String::from_utf8(output.stdout)
        .unwrap_or_else(|error| panic!("NDK clang 返回非 UTF-8 的 builtins 路径: {error}"))
        .trim()
        .to_owned();
    if archive.is_empty() || archive == BUILTINS || !std::path::Path::new(&archive).is_file() {
        panic!("NDK compiler-rt archive 不存在: {archive:?}（由 {clang:?} 解析）");
    }
    // cargo 指令按行读取；普通空格会随 -C link-arg 的单个参数保留。
    if archive.contains('\n') || archive.contains('\r') {
        panic!("NDK compiler-rt archive 路径包含换行符: {archive:?}");
    }

    println!("cargo:rerun-if-changed={archive}");
    println!("cargo:rustc-link-arg={archive}");
}
