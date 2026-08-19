import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const environment = { ...process.env };

const androidTargets = [
  {
    alias: "aarch64",
    triple: "aarch64-linux-android",
    clangTarget: "aarch64-linux-android24",
  },
  {
    alias: "armv7",
    triple: "armv7-linux-androideabi",
    clangTarget: "armv7a-linux-androideabi24",
  },
  {
    alias: "i686",
    triple: "i686-linux-android",
    clangTarget: "i686-linux-android24",
  },
  {
    alias: "x86_64",
    triple: "x86_64-linux-android",
    clangTarget: "x86_64-linux-android24",
  },
];

function fail(message) {
  console.error(`Android toolchain configuration failed: ${message}`);
  process.exit(1);
}

function resolveAndroidNdk() {
  const explicitNdk = environment.ANDROID_NDK_HOME || environment.NDK_HOME;
  if (explicitNdk) {
    return resolve(explicitNdk);
  }

  const sdkRoot = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  if (!sdkRoot) {
    fail("set ANDROID_NDK_HOME or ANDROID_HOME before running a Tauri Android command");
  }

  const ndkRoot = join(resolve(sdkRoot), "ndk");
  if (!existsSync(ndkRoot)) {
    fail(`Android NDK directory not found: ${ndkRoot}`);
  }

  const candidates = readdirSync(ndkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ndkRoot, entry.name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (candidates.length === 0) {
    fail(`no installed Android NDK found under ${ndkRoot}`);
  }
  return candidates[0];
}

function resolveToolchain(ndkRoot) {
  const hostTags = process.arch === "arm64" ? ["linux-aarch64", "linux-x86_64"] : ["linux-x86_64"];
  for (const hostTag of hostTags) {
    const candidate = join(ndkRoot, "toolchains", "llvm", "prebuilt", hostTag);
    if (existsSync(join(candidate, "bin", "llvm-ar"))) {
      return candidate;
    }
  }
  fail(`NDK LLVM toolchain not found under ${ndkRoot}`);
}

function requestedAndroidTargets() {
  const targetArgumentIndex = args.findIndex((arg) => arg === "--target");
  const targetArgument =
    targetArgumentIndex >= 0
      ? args[targetArgumentIndex + 1]
      : args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);

  if (!targetArgument || targetArgument === "universal") {
    return androidTargets;
  }

  const requested = new Set(targetArgument.split(","));
  const selected = androidTargets.filter(
    (target) => requested.has(target.alias) || requested.has(target.triple),
  );
  if (selected.length === 0) {
    fail(`unsupported Android target: ${targetArgument}`);
  }
  return selected;
}

function configureAndroidToolchain() {
  if (process.platform !== "linux" || args[0] !== "android") {
    return;
  }

  const ndkRoot = resolveAndroidNdk();
  const toolchainRoot = resolveToolchain(ndkRoot);
  const toolchainBin = join(toolchainRoot, "bin");
  const sysroot = join(toolchainRoot, "sysroot");
  const ar = join(toolchainBin, "llvm-ar");
  const ranlib = join(toolchainBin, "llvm-ranlib");

  if (!existsSync(sysroot) || !existsSync(ar) || !existsSync(ranlib)) {
    fail(`incomplete NDK LLVM toolchain: ${toolchainRoot}`);
  }

  for (const target of requestedAndroidTargets()) {
    const targetKey = target.triple.replaceAll("-", "_");
    const compiler = join(toolchainBin, `${target.clangTarget}-clang`);
    if (!existsSync(compiler)) {
      fail(`NDK compiler not found: ${compiler}`);
    }

    environment[`BINDGEN_EXTRA_CLANG_ARGS_${targetKey}`] =
      `--sysroot=${sysroot} --target=${target.clangTarget}`;
    environment[`CC_${targetKey}`] = compiler;
    environment[`AR_${targetKey}`] = ar;
    environment[`RANLIB_${targetKey}`] = ranlib;
    environment[`CARGO_TARGET_${targetKey.toUpperCase()}_LINKER`] = compiler;
  }

  environment.ANDROID_NDK_HOME = ndkRoot;
  environment.NDK_HOME = ndkRoot;
  console.error(`Android NDK: ${ndkRoot}`);
}

configureAndroidToolchain();

if (!existsSync(cliPath)) {
  fail(`Tauri CLI not found: ${cliPath}; run bun install first`);
}

const result = spawnSync(process.execPath, [cliPath, ...args], {
  cwd: repoRoot,
  env: environment,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
