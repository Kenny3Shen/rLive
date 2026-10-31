//! 按平台选择、安装与校验 CrispASR 预编译运行库。
//!
//! 运行库在首次启用字幕时从 CrispASR v0.8.48 release 下载，核对固定大小与 SHA-256
//! 后只解出加载所需的文件：版本化的 `.so` / `.dylib` 直接改名为它的 soname /
//! install name，不需要符号链接。最后写入版本标记并整体改名为正式目录。
//!
//! x86_64 的包都以 AVX2/FMA/F16C 编译。Windows 有 NVIDIA GPU（Compute Capability
//! 6.x–9.x、驱动支持 CUDA 12）时改用自带 CUDA 12.6 运行库的包；它同样能以 CPU 运行，
//! 因此推理后端在 CPU / CUDA 之间切换不需要换包或重启。

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const RELEASE_BASE: &str = "https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.48/";
const VERSION_FILE: &str = ".rlive-runtime-version";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    #[cfg(windows)]
    Zip,
}

#[derive(Debug)]
pub struct RuntimePackage {
    /// 安装目录名，同时写入版本标记。
    pub id: &'static str,
    pub archive: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub format: ArchiveFormat,
    /// 归档内路径 → 安装后的文件名。
    pub files: &'static [(&'static str, &'static str)],
    /// 加载入口。
    pub library: &'static str,
}

impl RuntimePackage {
    pub fn url(&self) -> String {
        format!("{RELEASE_BASE}{}", self.archive)
    }

    pub fn directory(&self, runtime_root: &Path) -> PathBuf {
        runtime_root.join(self.id)
    }

    pub fn library_path(&self, runtime_root: &Path) -> PathBuf {
        self.directory(runtime_root).join(self.library)
    }

    /// 版本标记与清单里的每个文件都在且非空才算安装完成。
    pub fn is_installed(&self, runtime_root: &Path) -> bool {
        let directory = self.directory(runtime_root);
        let marker = std::fs::read_to_string(directory.join(VERSION_FILE)).unwrap_or_default();
        marker.trim() == self.id
            && self.files.iter().all(|(_, name)| {
                std::fs::metadata(directory.join(name))
                    .map(|metadata| metadata.is_file() && metadata.len() > 0)
                    .unwrap_or(false)
            })
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
static PACKAGE: RuntimePackage = RuntimePackage {
    id: "crispasr-0.8.48-linux-x86_64",
    archive: "libcrispasr-linux-x86_64.tar.gz",
    size: 22_695_928,
    sha256: "b510d11b24dbc747d6c8e2bd90f3ee13e5225404a7f29c20fb85d8f720eac8a9",
    format: ArchiveFormat::TarGz,
    files: &[
        ("libcrispasr-linux-x86_64/lib/libcrispasr.so.0.8.48", "libcrispasr.so.1"),
        ("libcrispasr-linux-x86_64/lib/libggml.so.0.26.0", "libggml.so.0"),
        ("libcrispasr-linux-x86_64/lib/libggml-base.so.0.26.0", "libggml-base.so.0"),
        ("libcrispasr-linux-x86_64/lib/libggml-cpu.so.0.26.0", "libggml-cpu.so.0"),
        ("libcrispasr-linux-x86_64/lib/libgomp.so.1", "libgomp.so.1"),
        ("libcrispasr-linux-x86_64/lib/libopenblas.so.0", "libopenblas.so.0"),
        ("libcrispasr-linux-x86_64/lib/libgfortran.so.5", "libgfortran.so.5"),
        ("libcrispasr-linux-x86_64/lib/libquadmath.so.0", "libquadmath.so.0"),
    ],
    library: "libcrispasr.so.1",
};

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
static PACKAGE: RuntimePackage = RuntimePackage {
    id: "crispasr-0.8.48-linux-arm64",
    archive: "libcrispasr-linux-arm64.tar.gz",
    size: 17_285_520,
    sha256: "97d44ec4fab6a1055a2e5c92e0b5a8da8e9b32adc28563cb40d18f591b541f63",
    format: ArchiveFormat::TarGz,
    files: &[
        ("libcrispasr-linux-arm64/lib/libcrispasr.so.0.8.48", "libcrispasr.so.1"),
        ("libcrispasr-linux-arm64/lib/libggml.so.0.26.0", "libggml.so.0"),
        ("libcrispasr-linux-arm64/lib/libggml-base.so.0.26.0", "libggml-base.so.0"),
        ("libcrispasr-linux-arm64/lib/libggml-cpu.so.0.26.0", "libggml-cpu.so.0"),
        ("libcrispasr-linux-arm64/lib/libgomp.so.1", "libgomp.so.1"),
        ("libcrispasr-linux-arm64/lib/libopenblas.so.0", "libopenblas.so.0"),
        ("libcrispasr-linux-arm64/lib/libgfortran.so.5", "libgfortran.so.5"),
    ],
    library: "libcrispasr.so.1",
};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static PACKAGE: RuntimePackage = RuntimePackage {
    id: "crispasr-0.8.48-macos-arm64",
    archive: "libcrispasr-macos-arm64.tar.gz",
    size: 9_278_378,
    sha256: "4116c1484fae68a5cb1a29808e77fdf6b52f574e88af0df25c5ca5f793e33042",
    format: ArchiveFormat::TarGz,
    files: &[
        ("libcrispasr-macos-arm64/lib/libcrispasr.0.8.48.dylib", "libcrispasr.1.dylib"),
        ("libcrispasr-macos-arm64/lib/libggml.0.26.0.dylib", "libggml.0.dylib"),
        ("libcrispasr-macos-arm64/lib/libggml-base.0.26.0.dylib", "libggml-base.0.dylib"),
        ("libcrispasr-macos-arm64/lib/libggml-cpu.0.26.0.dylib", "libggml-cpu.0.dylib"),
        ("libcrispasr-macos-arm64/lib/libggml-blas.0.26.0.dylib", "libggml-blas.0.dylib"),
        ("libcrispasr-macos-arm64/lib/libggml-metal.0.26.0.dylib", "libggml-metal.0.dylib"),
    ],
    library: "libcrispasr.1.dylib",
};

#[cfg(all(windows, target_arch = "x86_64"))]
static PACKAGE: RuntimePackage = RuntimePackage {
    id: "crispasr-0.8.48-windows-x86_64-cpu",
    archive: "libcrispasr-windows-x86_64.tar.gz",
    size: 58_546_043,
    sha256: "a717cf95e0c217fa5ffbfd4ba6c363fabe7dbe883fa1e788f93f9af2b1e0f428",
    format: ArchiveFormat::TarGz,
    files: &[
        ("libcrispasr-windows-x86_64/bin/crispasr.dll", "crispasr.dll"),
        ("libcrispasr-windows-x86_64/bin/ggml.dll", "ggml.dll"),
        ("libcrispasr-windows-x86_64/bin/ggml-base.dll", "ggml-base.dll"),
        ("libcrispasr-windows-x86_64/bin/ggml-cpu.dll", "ggml-cpu.dll"),
        ("libcrispasr-windows-x86_64/LICENSE", "LICENSE"),
        ("libcrispasr-windows-x86_64/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"),
    ],
    library: "crispasr.dll",
};

#[cfg(all(windows, target_arch = "x86_64"))]
static CUDA_PACKAGE: RuntimePackage = RuntimePackage {
    id: "crispasr-0.8.48-windows-x86_64-cuda126",
    archive: "crispasr-windows-x86_64-cuda126.zip",
    size: 713_524_258,
    sha256: "a035cbbedb776fc49ae4c29bfe9644bf4c4156b9207b6488c2fbc7c3e71b41f4",
    format: ArchiveFormat::Zip,
    files: &[
        ("crispasr-windows-x86_64-cuda126/crispasr.dll", "crispasr.dll"),
        ("crispasr-windows-x86_64-cuda126/ggml.dll", "ggml.dll"),
        ("crispasr-windows-x86_64-cuda126/ggml-base.dll", "ggml-base.dll"),
        ("crispasr-windows-x86_64-cuda126/ggml-cpu.dll", "ggml-cpu.dll"),
        ("crispasr-windows-x86_64-cuda126/ggml-cuda.dll", "ggml-cuda.dll"),
        ("crispasr-windows-x86_64-cuda126/cudart64_12.dll", "cudart64_12.dll"),
        ("crispasr-windows-x86_64-cuda126/cublas64_12.dll", "cublas64_12.dll"),
        ("crispasr-windows-x86_64-cuda126/cublasLt64_12.dll", "cublasLt64_12.dll"),
        ("crispasr-windows-x86_64-cuda126/LICENSE", "LICENSE"),
        ("crispasr-windows-x86_64-cuda126/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"),
    ],
    library: "crispasr.dll",
};

fn platform_package() -> Option<&'static RuntimePackage> {
    #[cfg(any(
        all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
        all(target_os = "macos", target_arch = "aarch64"),
        all(windows, target_arch = "x86_64"),
    ))]
    {
        Some(&PACKAGE)
    }
    #[cfg(not(any(
        all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
        all(target_os = "macos", target_arch = "aarch64"),
        all(windows, target_arch = "x86_64"),
    )))]
    {
        None
    }
}

/// 当前机器不能运行 CrispASR 时返回原因；可运行时返回 `None`。
pub fn unsupported_reason() -> Option<&'static str> {
    if platform_package().is_none() {
        return Some("当前平台没有可用的 CrispASR 预编译运行库");
    }
    #[cfg(target_arch = "x86_64")]
    {
        if !(std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c"))
        {
            return Some("CrispASR 运行库需要支持 AVX2 / FMA / F16C 的 x86_64 CPU");
        }
    }
    None
}

/// 启用功能时需要的运行库包。Windows 上首次调用会探测 NVIDIA GPU。
pub fn required_package() -> Result<&'static RuntimePackage, &'static str> {
    if let Some(reason) = unsupported_reason() {
        return Err(reason);
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    if cuda::probe().is_some_and(cuda::GpuProbe::usable) {
        return Ok(&CUDA_PACKAGE);
    }
    platform_package().ok_or("当前平台没有可用的 CrispASR 预编译运行库")
}

/// 不触发 GPU 探测的包：已探测过就用探测结果，否则按已安装的包推断。
/// 只用于状态展示与体积估算。
pub fn known_package(runtime_root: &Path) -> Option<&'static RuntimePackage> {
    if unsupported_reason().is_some() {
        return None;
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let use_cuda = match cuda::cached_probe() {
            Some(probe) => probe.is_some_and(cuda::GpuProbe::usable),
            None => CUDA_PACKAGE.is_installed(runtime_root),
        };
        if use_cuda {
            return Some(&CUDA_PACKAGE);
        }
    }
    let _ = runtime_root;
    platform_package()
}

/// Windows 上 CUDA 包比 CPU 包多出的下载体积；其余平台为 0。
pub fn cuda_extra_bytes() -> u64 {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        CUDA_PACKAGE.size.saturating_sub(PACKAGE.size)
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        0
    }
}

/// 已加载运行库的包是否带 GPU 后端。
pub fn package_has_gpu(package: &RuntimePackage) -> bool {
    package.files.iter().any(|(_, name)| *name == "ggml-cuda.dll")
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub mod cuda {
    use std::sync::OnceLock;

    use libloading::Library;

    /// CUDA 12.6 运行库依赖次版本兼容，驱动至少要支持 CUDA 12.0。
    const MIN_DRIVER_VERSION: i32 = 12_000;

    #[derive(Debug, Clone, Copy)]
    pub struct GpuProbe {
        pub major: i32,
        pub minor: i32,
        pub driver_version: i32,
    }

    impl GpuProbe {
        /// 包内 ggml-cuda 覆盖 Pascal 到 Hopper；Blackwell（10.x 起）需要更新的 CUDA。
        pub fn usable(self) -> bool {
            (6..10).contains(&self.major) && self.driver_version >= MIN_DRIVER_VERSION
        }
    }

    static PROBE: OnceLock<Option<GpuProbe>> = OnceLock::new();

    /// 已探测过时返回结果，未探测时返回 `None`，不会触发探测。
    pub fn cached_probe() -> Option<Option<GpuProbe>> {
        PROBE.get().copied()
    }

    /// 加载 `nvcuda.dll` 查询第一块 GPU；结果按进程缓存。
    pub fn probe() -> Option<GpuProbe> {
        *PROBE.get_or_init(query)
    }

    fn query() -> Option<GpuProbe> {
        type CuInit = unsafe extern "system" fn(u32) -> i32;
        type CuDriverGetVersion = unsafe extern "system" fn(*mut i32) -> i32;
        type CuDeviceGet = unsafe extern "system" fn(*mut i32, i32) -> i32;
        type CuDeviceComputeCapability = unsafe extern "system" fn(*mut i32, *mut i32, i32) -> i32;

        let driver = unsafe { Library::new("nvcuda.dll").ok()? };
        let cu_init = unsafe { driver.get::<CuInit>(b"cuInit\0").ok()? };
        let cu_driver_get_version =
            unsafe { driver.get::<CuDriverGetVersion>(b"cuDriverGetVersion\0").ok()? };
        let cu_device_get = unsafe { driver.get::<CuDeviceGet>(b"cuDeviceGet\0").ok()? };
        let cu_device_compute_capability = unsafe {
            driver
                .get::<CuDeviceComputeCapability>(b"cuDeviceComputeCapability\0")
                .ok()?
        };

        if unsafe { cu_init(0) } != 0 {
            return None;
        }
        let mut driver_version = 0;
        if unsafe { cu_driver_get_version(&mut driver_version) } != 0 {
            return None;
        }
        let mut device = 0;
        if unsafe { cu_device_get(&mut device, 0) } != 0 {
            return None;
        }
        let (mut major, mut minor) = (0, 0);
        if unsafe { cu_device_compute_capability(&mut major, &mut minor, device) } != 0 {
            return None;
        }
        Some(GpuProbe {
            major,
            minor,
            driver_version,
        })
    }

    /// 用户希望用 CUDA 但当前不可用时的说明。
    pub fn fallback_message() -> String {
        match cached_probe().flatten() {
            Some(probe) if !(6..10).contains(&probe.major) => format!(
                "当前 NVIDIA GPU Compute Capability {}.{} 不在 CrispASR CUDA 12.6 运行库支持范围（6.0–9.x），已使用 CPU",
                probe.major, probe.minor
            ),
            Some(probe) if probe.driver_version < MIN_DRIVER_VERSION => format!(
                "NVIDIA 驱动仅支持 CUDA {}.{}，需要 12.0 以上，已使用 CPU",
                probe.driver_version / 1000,
                probe.driver_version % 1000 / 10
            ),
            _ => "未检测到可用的 NVIDIA GPU，已使用 CPU".to_string(),
        }
    }
}

/// 把已校验的归档解到 `runtime_root/<id>`：先解到暂存目录、写版本标记，再整体改名。
pub fn install(package: &RuntimePackage, archive: &Path, runtime_root: &Path) -> AppResult<()> {
    std::fs::create_dir_all(runtime_root)
        .map_err(|_| install_error("无法创建语音字幕运行库目录"))?;
    let staging = runtime_root.join(format!(".{}.extracting", package.id));
    remove_dir_if_exists(&staging)?;
    std::fs::create_dir_all(&staging).map_err(|_| install_error("无法创建运行库暂存目录"))?;

    let result = extract(package, archive, &staging)
        .and_then(|()| {
            std::fs::write(staging.join(VERSION_FILE), package.id)
                .map_err(|_| install_error("无法写入运行库版本标记"))
        })
        .and_then(|()| {
            let target = package.directory(runtime_root);
            remove_dir_if_exists(&target)?;
            std::fs::rename(&staging, &target).map_err(|_| install_error("无法安装语音字幕运行库"))
        });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn extract(package: &RuntimePackage, archive: &Path, destination: &Path) -> AppResult<()> {
    let file = File::open(archive).map_err(|_| install_error("无法读取运行库归档"))?;
    let mut found = vec![false; package.files.len()];
    match package.format {
        ArchiveFormat::TarGz => {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
            let entries = tar.entries().map_err(|_| install_error("运行库归档格式无效"))?;
            for entry in entries {
                let mut entry = entry.map_err(|_| install_error("运行库归档读取失败"))?;
                if !entry.header().entry_type().is_file() {
                    continue;
                }
                let path = entry.path().map_err(|_| install_error("运行库归档路径无效"))?;
                let Some(index) = file_index(package, &path.to_string_lossy()) else {
                    continue;
                };
                write_entry(&mut entry, &destination.join(package.files[index].1))?;
                found[index] = true;
            }
        }
        #[cfg(windows)]
        ArchiveFormat::Zip => {
            let mut zip = zip::ZipArchive::new(BufReader::new(file))
                .map_err(|_| install_error("运行库归档格式无效"))?;
            for position in 0..zip.len() {
                let mut entry = zip
                    .by_index(position)
                    .map_err(|_| install_error("运行库归档读取失败"))?;
                if !entry.is_file() {
                    continue;
                }
                let name = entry
                    .name()
                    .map_err(|_| install_error("运行库归档路径无效"))?;
                let Some(index) = file_index(package, &name) else {
                    continue;
                };
                drop(name);
                write_entry(&mut entry, &destination.join(package.files[index].1))?;
                found[index] = true;
            }
        }
    }
    if found.contains(&false) {
        return Err(install_error("运行库归档内容不完整"));
    }
    Ok(())
}

/// 只认清单里的归档路径；输出文件名来自清单而不是归档，避免路径穿越。
fn file_index(package: &RuntimePackage, entry_path: &str) -> Option<usize> {
    let normalized = entry_path.replace('\\', "/");
    let normalized = normalized.trim_start_matches("./");
    package
        .files
        .iter()
        .position(|(archive_path, _)| *archive_path == normalized)
}

fn write_entry(reader: &mut impl std::io::Read, target: &Path) -> AppResult<()> {
    let mut output = File::create(target).map_err(|_| install_error("无法写入运行库文件"))?;
    std::io::copy(reader, &mut output).map_err(|_| install_error("运行库文件解压失败"))?;
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> AppResult<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(install_error("无法清理旧的语音字幕运行库")),
    }
}

fn install_error(message: &str) -> AppError {
    AppError::new("asr_runtime_install", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_PACKAGE: RuntimePackage = RuntimePackage {
        id: "crispasr-test",
        archive: "libcrispasr-test.tar.gz",
        size: 0,
        sha256: "",
        format: ArchiveFormat::TarGz,
        files: &[
            ("pkg/lib/libcrispasr.so.0.8.48", "libcrispasr.so.1"),
            ("pkg/LICENSE", "LICENSE"),
        ],
        library: "libcrispasr.so.1",
    };

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rlive-crispasr-runtime-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let encoder =
            flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn installs_only_listed_files_under_their_load_names() {
        let root = temp_root();
        let archive = root.join("pkg.tar.gz");
        write_archive(
            &archive,
            &[
                ("pkg/lib/libcrispasr.so.0.8.48", b"lib"),
                ("pkg/LICENSE", b"license"),
                ("pkg/include/crispasr.h", b"header"),
            ],
        );

        install(&TEST_PACKAGE, &archive, &root).unwrap();

        let directory = TEST_PACKAGE.directory(&root);
        assert!(TEST_PACKAGE.is_installed(&root));
        assert_eq!(std::fs::read(TEST_PACKAGE.library_path(&root)).unwrap(), b"lib");
        let mut names: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, [VERSION_FILE, "LICENSE", "libcrispasr.so.1"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_archive_leaves_nothing_installed() {
        let root = temp_root();
        let archive = root.join("pkg.tar.gz");
        write_archive(&archive, &[("pkg/LICENSE", b"license")]);

        assert!(install(&TEST_PACKAGE, &archive, &root).is_err());

        assert!(!TEST_PACKAGE.is_installed(&root));
        assert!(!TEST_PACKAGE.directory(&root).exists());
        assert!(!root.join(".crispasr-test.extracting").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installation_requires_the_version_marker_and_every_file() {
        let root = temp_root();
        let directory = TEST_PACKAGE.directory(&root);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("libcrispasr.so.1"), b"lib").unwrap();
        std::fs::write(directory.join("LICENSE"), b"license").unwrap();
        assert!(!TEST_PACKAGE.is_installed(&root));

        std::fs::write(directory.join(VERSION_FILE), "sherpa-onnx-1.12").unwrap();
        assert!(!TEST_PACKAGE.is_installed(&root));

        std::fs::write(directory.join(VERSION_FILE), TEST_PACKAGE.id).unwrap();
        assert!(TEST_PACKAGE.is_installed(&root));

        std::fs::write(directory.join("LICENSE"), b"").unwrap();
        assert!(!TEST_PACKAGE.is_installed(&root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_paths_are_matched_exactly_after_separator_normalization() {
        assert_eq!(file_index(&TEST_PACKAGE, "./pkg/LICENSE"), Some(1));
        assert_eq!(file_index(&TEST_PACKAGE, "pkg\\LICENSE"), Some(1));
        assert_eq!(file_index(&TEST_PACKAGE, "pkg/lib/../LICENSE"), None);
        assert_eq!(file_index(&TEST_PACKAGE, "other/pkg/LICENSE"), None);
    }
}
