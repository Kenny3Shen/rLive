fn main() {
    // tauri-build 默认把应用清单编进资源，只链进二进制；lib 的单元测试可执行文件拿不到。
    // 测试同样导入 comctl32 v6 才有的 `TaskDialogIndirect`，没有清单时 Windows 加载器
    // 以 STATUS_ENTRYPOINT_NOT_FOUND 拒绝启动。改由 MSVC 链接器把同一份清单嵌进
    // 所有链接产物，并关掉 tauri-build 的那份，避免重复的清单资源。
    let target = |key: &str| std::env::var(key).unwrap_or_default();
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
