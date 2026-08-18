fn main() {
    #[cfg(target_os = "linux")]
    {
        // The vendored sherpa-onnx build script stages shared runtime libraries
        // beside Cargo binaries. Installed Linux bundles place the same files
        // at `<prefix>/lib/rLive`, so the final application ELF needs both
        // relocatable search paths.
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
