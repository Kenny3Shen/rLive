use std::{
    env, fs,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    process::Command,
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
    let android_release = target_os == "android"
        && env::var("PROFILE")
            .map(|profile| profile == "release")
            .unwrap_or(false);

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
        // A PE import table records the DLL's real file name, so a build that
        // emitted libcrispasr.dll is linked against that name and the loader
        // ignores the canonical copy above. Stage the original name as well
        // when it differs; harmless elsewhere since Unix names match exactly.
        if let Some(source_name) = source.file_name().and_then(|n| n.to_str()) {
            if source_name != name {
                copy_with_retry(&source, &profile_dir.join(source_name))?;
                copy_with_retry(&source, &bundle_dir.join(source_name))?;
            }
        }
        if let Some(directory) = &android_jni_dir {
            let destination = directory.join(name);
            copy_with_retry(&source, &destination)?;
            if android_release {
                // CMake's Android toolchain adds `-g` even to Release builds.
                // Strip only the copies staged for packaging; the CMake output
                // remains intact for incremental/debug builds.
                strip_android_debug_sections(&destination)?;
            }
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
        // MSVC leaves shared libraries unprefixed, so the canonical name is
        // usually what CMake emitted. ggml clears CMAKE_SHARED_LIBRARY_PREFIX
        // for WIN32, but only inside its own directory scope — crispasr-lib
        // lives in src/ and keeps the default prefix under toolchains where
        // that prefix is "lib", yielding libcrispasr.dll. Probe both.
        if !canonical.starts_with("lib") {
            names.push(format!("lib{canonical}"));
        }
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

fn android_ndk_path() -> io::Result<PathBuf> {
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
    Ok(ndk)
}

fn android_llvm_prebuilt(ndk: &Path) -> io::Result<PathBuf> {
    let prebuilt = ndk.join("toolchains").join("llvm").join("prebuilt");
    if !prebuilt.is_dir() {
        return Err(io::Error::new(
            ErrorKind::NotFound,
            format!(
                "Android LLVM prebuilt directory is missing: {}",
                prebuilt.display()
            ),
        ));
    }
    Ok(prebuilt)
}

fn android_target_llvm_arch() -> io::Result<&'static str> {
    match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => Ok("aarch64"),
        Ok("arm") => Ok("arm"),
        // NDK names the 32-bit x86 directory `i386`, while Cargo uses `x86`.
        Ok("x86") => Ok("i386"),
        Ok("x86_64") => Ok("x86_64"),
        Ok(arch) => Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!("unsupported Android Cargo target architecture: {arch}"),
        )),
        Err(error) => Err(io::Error::new(
            ErrorKind::NotFound,
            format!("CARGO_CFG_TARGET_ARCH is unavailable: {error}"),
        )),
    }
}

fn find_android_runtime_library(name: &str) -> io::Result<PathBuf> {
    let ndk = android_ndk_path()?;
    let llvm_prebuilt = android_llvm_prebuilt(&ndk)?;

    // OpenMP is shipped once per target architecture below clang's runtime
    // tree. A broad recursive walk is unsafe here: directory iteration can
    // return the 32-bit ARM `libomp.so` before the arm64 copy, which produces
    // an APK that installs but crashes while Android loads libcrispasr.so.
    let target_arch = android_target_llvm_arch()?;
    if name == "libomp.so" {
        if let Ok(hosts) = fs::read_dir(&llvm_prebuilt) {
            for host in hosts.flatten() {
                let clang_root = host.path().join("lib").join("clang");
                if let Ok(versions) = fs::read_dir(&clang_root) {
                    for version in versions.flatten() {
                        let candidate = version
                            .path()
                            .join("lib")
                            .join("linux")
                            .join(target_arch)
                            .join(name);
                        if candidate.is_file() {
                            return Ok(candidate);
                        }
                    }
                }
            }
        }
        return Err(io::Error::new(
            ErrorKind::NotFound,
            format!(
                "Android runtime library {name} for {target_arch} was not found under {}",
                llvm_prebuilt.display()
            ),
        ));
    }

    let names = candidate_names(name);
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

fn find_android_llvm_strip() -> io::Result<PathBuf> {
    let ndk = android_ndk_path()?;
    let prebuilt = android_llvm_prebuilt(&ndk)?;
    if let Ok(hosts) = fs::read_dir(&prebuilt) {
        for host in hosts.flatten() {
            let candidate = host.path().join("bin").join("llvm-strip");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(io::Error::new(
        ErrorKind::NotFound,
        format!(
            "Android llvm-strip was not found under {}",
            prebuilt.display()
        ),
    ))
}

fn strip_android_debug_sections(path: &Path) -> io::Result<()> {
    let strip = find_android_llvm_strip()?;
    let status = Command::new(&strip)
        .arg("--strip-debug")
        .arg(path)
        .status()
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to run {}: {error}", strip.display()),
            )
        })?;
    if !status.success() {
        return Err(io::Error::new(
            ErrorKind::Other,
            format!(
                "{} failed while stripping {} (status {status})",
                strip.display(),
                path.display()
            ),
        ));
    }
    Ok(())
}
