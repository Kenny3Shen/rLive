use std::{
    env, fs,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};

fn main() {
    stage_crispasr_runtime().expect("failed to stage CrispASR runtime libraries");
    tauri_build::build();
}

fn stage_crispasr_runtime() -> io::Result<()> {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // Destination names next to the final binary / package resources.
    let library_names = match target_os.as_str() {
        "linux" => vec![
            "libcrispasr.so.1",
            "libggml.so.0",
            "libggml-base.so.0",
            "libggml-cpu.so.0",
        ],
        "macos" => vec![
            "libcrispasr.1.dylib",
            "libggml.0.dylib",
            "libggml-base.0.dylib",
            "libggml-cpu.0.dylib",
        ],
        "windows" => vec!["crispasr.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll"],
        "android" => vec![
            "libcrispasr.so",
            "libggml.so",
            "libggml-base.so",
            "libggml-cpu.so",
            // NDK OpenMP is a shared dependency of ggml/crispasr on Android.
            // It lives in the NDK clang runtime tree rather than the CMake
            // build directory and must be packaged beside the other JNI libs.
            "libomp.so",
        ],
        _ => return Ok(()),
    };

    println!("cargo:rerun-if-env-changed=DEP_CRISPASR_LIB_DIR");
    let native_build_dir = PathBuf::from(env::var_os("DEP_CRISPASR_LIB_DIR").ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "DEP_CRISPASR_LIB_DIR was not provided by crispasr-sys",
        )
    })?);
    let out_dir = PathBuf::from(
        env::var_os("OUT_DIR")
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "Cargo did not provide OUT_DIR"))?,
    );
    let profile_dir = out_dir.ancestors().nth(3).ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            format!("unexpected Cargo OUT_DIR layout: {}", out_dir.display()),
        )
    })?;
    let bundle_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("crispasr-libs");

    let android_jni_dir = if target_os == "android" {
        let abi = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "arm64-v8a",
            Ok("arm") => "armeabi-v7a",
            Ok("x86") => "x86",
            Ok("x86_64") => "x86_64",
            _ => "unknown",
        };
        if abi == "unknown" {
            None
        } else {
            Some(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("gen")
                    .join("android")
                    .join("app")
                    .join("src")
                    .join("main")
                    .join("jniLibs")
                    .join(abi),
            )
        }
    } else {
        None
    };

    if bundle_dir.exists() {
        remove_dir_all_with_retry(&bundle_dir)?;
    }
    fs::create_dir_all(&bundle_dir)?;
    if let Some(directory) = &android_jni_dir {
        fs::create_dir_all(directory)?;
    }

    for name in library_names {
        let source = match find_runtime_library(&native_build_dir, name) {
            Ok(path) => path,
            Err(error) if target_os == "android" => {
                find_android_runtime_library(name).map_err(|android_error| {
                    io::Error::new(
                        android_error.kind(),
                        format!("{error}; Android runtime lookup also failed: {android_error}"),
                    )
                })?
            }
            Err(error) => return Err(error),
        };
        // Always stage under the canonical runtime name so the loader and
        // Windows bundler see crispasr.dll / ggml*.dll next to the exe.
        copy_with_retry(&source, &profile_dir.join(name))?;
        copy_with_retry(&source, &bundle_dir.join(name))?;
        if let Some(directory) = &android_jni_dir {
            copy_with_retry(&source, &directory.join(name))?;
        }
    }

    match target_os.as_str() {
        "linux" => {
            println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
            println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
        }
        "macos" => {
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        }
        _ => {}
    }

    Ok(())
}

fn windows_file_is_busy(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

fn copy_with_retry(source: &Path, destination: &Path) -> io::Result<()> {
    let attempts = if cfg!(windows) { 20 } else { 1 };
    for attempt in 0..attempts {
        match fs::copy(source, destination) {
            Ok(_) => return Ok(()),
            Err(error) if windows_file_is_busy(&error) && attempt + 1 < attempts => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "failed to copy {} to {}: {error}",
                        source.display(),
                        destination.display()
                    ),
                ));
            }
        }
    }
    unreachable!("copy retry loop always returns")
}

fn remove_dir_all_with_retry(path: &Path) -> io::Result<()> {
    let attempts = if cfg!(windows) { 20 } else { 1 };
    for attempt in 0..attempts {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if windows_file_is_busy(&error) && attempt + 1 < attempts => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("failed to recreate {}: {error}", path.display()),
                ));
            }
        }
    }
    unreachable!("remove retry loop always returns")
}

/// Alternate names for Unix sonames produced by different CMake layouts.
fn candidate_names(canonical: &str) -> Vec<String> {
    let mut names = vec![canonical.to_string()];

    if canonical.ends_with(".dll") {
        // Windows builds use the MSVC DLL names exactly as requested.
    } else if let Some(stem) = canonical
        .strip_suffix(".so.1")
        .or_else(|| canonical.strip_suffix(".so.0"))
        .or_else(|| canonical.strip_suffix(".so"))
    {
        // Unversioned fallback (rare, but cheap to probe)
        names.push(format!("{stem}.so"));
        if let Some(base) = stem.strip_prefix("lib") {
            names.push(format!("lib{base}.so.1"));
            names.push(format!("lib{base}.so.0"));
        }
    } else if let Some(stem) = canonical
        .strip_suffix(".1.dylib")
        .or_else(|| canonical.strip_suffix(".0.dylib"))
        .or_else(|| canonical.strip_suffix(".dylib"))
    {
        names.push(format!("{stem}.dylib"));
    }

    names.sort();
    names.dedup();
    names
}

fn known_search_dirs(build_dir: &Path) -> Vec<PathBuf> {
    // CrispASR / ggml CMake layouts observed across generators:
    //   src/, src/Release/          — import libs + sometimes the DLL itself
    //   bin/, bin/Release/          — Windows RUNTIME_OUTPUT_DIRECTORY
    //   ggml/src/, ggml/bin/        — ggml shared backends
    let configs = ["", "Release", "Debug", "RelWithDebInfo", "MinSizeRel"];
    let mut dirs = Vec::new();
    for root in [
        build_dir.to_path_buf(),
        build_dir.join("bin"),
        build_dir.join("src"),
        build_dir.join("lib"),
        build_dir.join("ggml").join("bin"),
        build_dir.join("ggml").join("src"),
        build_dir.join("ggml").join("lib"),
    ] {
        dirs.push(root.clone());
        for cfg in configs.iter().skip(1) {
            dirs.push(root.join(cfg));
        }
    }
    dirs
}

fn walk_find(dir: &Path, names: &[String], max_depth: u32) -> Option<PathBuf> {
    if max_depth == 0 || !dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if names.iter().any(|n| n == file_name) {
                    return Some(path);
                }
            }
        } else if path.is_dir() {
            // Skip heavy / irrelevant trees inside the cmake build.
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if matches!(
                name,
                "CMakeFiles" | ".cmake" | "CMakeTmp" | "Testing" | "examples" | "tests"
            ) {
                continue;
            }
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        if let Some(found) = walk_find(&sub, names, max_depth - 1) {
            return Some(found);
        }
    }
    None
}

fn list_nearby_libs(build_dir: &Path) -> String {
    let mut found = Vec::new();
    for dir in known_search_dirs(build_dir) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".dll")
                || lower.ends_with(".so")
                || lower.contains(".so.")
                || lower.ends_with(".dylib")
                || lower.ends_with(".lib")
            {
                found.push(format!("  - {}", path.display()));
            }
        }
    }
    found.sort();
    found.dedup();
    if found.is_empty() {
        "  (no .dll/.so/.dylib/.lib files in known output dirs)".to_string()
    } else {
        found.join("\n")
    }
}

fn find_runtime_library(build_dir: &Path, name: &str) -> io::Result<PathBuf> {
    let names = candidate_names(name);

    for dir in known_search_dirs(build_dir) {
        for n in &names {
            let path = dir.join(n);
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    // Last resort: shallow walk of the cmake build tree. Windows generators
    // occasionally place RUNTIME DLLs under unexpected config subfolders.
    if let Some(found) = walk_find(build_dir, &names, 6) {
        return Ok(found);
    }

    Err(io::Error::new(
        ErrorKind::NotFound,
        format!(
            "CrispASR runtime library {name} was not found under {}\n\
             looked for: {}\n\
             libraries present:\n{}",
            build_dir.display(),
            names.join(", "),
            list_nearby_libs(build_dir)
        ),
    ))
}

fn find_android_runtime_library(name: &str) -> io::Result<PathBuf> {
    let ndk = [
        env::var_os("CRISPASR_ANDROID_NDK").map(PathBuf::from),
        env::var_os("ANDROID_NDK_HOME").map(PathBuf::from),
        env::var_os("ANDROID_NDK_ROOT").map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.join("toolchains").join("llvm").is_dir())
    .ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "Android NDK path is unavailable; set ANDROID_NDK_HOME",
        )
    })?;

    let names = candidate_names(name);
    let llvm_prebuilt = ndk.join("toolchains").join("llvm").join("prebuilt");
    if let Some(found) = walk_find(&llvm_prebuilt, &names, 10) {
        return Ok(found);
    }
    Err(io::Error::new(
        ErrorKind::NotFound,
        format!(
            "Android runtime library {name} was not found under {}",
            llvm_prebuilt.display()
        ),
    ))
}
