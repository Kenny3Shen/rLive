# CMake toolchain used by crispasr-sys when Cargo targets Android.
#
# The upstream build script invokes CMake without Android-specific -D flags.
# Cargo does provide CARGO_CFG_TARGET_ARCH, so select the matching ABI here
# before including the NDK toolchain. The wrapper is intentionally CPU-only.

if(NOT DEFINED ENV{CRISPASR_ANDROID_NDK})
    message(FATAL_ERROR "CRISPASR_ANDROID_NDK must point to an Android NDK")
endif()

set(_crispasr_ndk "$ENV{CRISPASR_ANDROID_NDK}")
set(CMAKE_ANDROID_NDK "${_crispasr_ndk}" CACHE PATH "Android NDK" FORCE)
set(ANDROID_PLATFORM "android-24" CACHE STRING "Android API level" FORCE)
set(CMAKE_SYSTEM_VERSION 24 CACHE STRING "Android API level" FORCE)
set(CMAKE_ANDROID_API 24 CACHE STRING "Android API level" FORCE)

if("$ENV{CARGO_CFG_TARGET_ARCH}" STREQUAL "aarch64")
    set(_crispasr_android_abi "arm64-v8a")
    set(_crispasr_system_processor "aarch64")
elseif("$ENV{CARGO_CFG_TARGET_ARCH}" STREQUAL "arm")
    set(_crispasr_android_abi "armeabi-v7a")
    set(_crispasr_system_processor "armv7-a")
elseif("$ENV{CARGO_CFG_TARGET_ARCH}" STREQUAL "x86")
    set(_crispasr_android_abi "x86")
    set(_crispasr_system_processor "i686")
elseif("$ENV{CARGO_CFG_TARGET_ARCH}" STREQUAL "x86_64")
    set(_crispasr_android_abi "x86_64")
    set(_crispasr_system_processor "x86_64")
else()
    message(FATAL_ERROR "Unsupported Android Cargo target architecture: $ENV{CARGO_CFG_TARGET_ARCH}")
endif()

# NDK's legacy toolchain consumes ANDROID_ABI/ANDROID_PLATFORM and then
# derives CMAKE_ANDROID_ARCH_ABI. Set all three explicitly so the cache and
# the compiler target cannot disagree (for example arm64-v8a vs armv7-a).
set(ANDROID_ABI "${_crispasr_android_abi}" CACHE STRING "Android ABI" FORCE)
set(CMAKE_ANDROID_ARCH_ABI "${_crispasr_android_abi}" CACHE STRING "Android ABI" FORCE)

include("${_crispasr_ndk}/build/cmake/android.toolchain.cmake")

# The NDK legacy toolchain can leave CMAKE_SYSTEM_PROCESSOR from an earlier
# configure pass even when the ABI cache is correct. Reassert it after the
# include so FindOpenMP and ggml select the matching runtime directory.
set(CMAKE_SYSTEM_PROCESSOR "${_crispasr_system_processor}")
