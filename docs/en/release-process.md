# Release process

CI and formal releases are deliberately separate. Pull requests and pushes to `master` run checks and tests only; a version tag is required to build, sign, and draft a release.

## Triggering a release

1. Keep the versions in `package.json`, `backend/Cargo.toml`, and `backend/tauri.conf.json` identical.
2. Push the matching tag, for example `git tag v0.1.0 && git push origin v0.1.0`.
3. `.github/workflows/release.yml` rejects a mismatched tag. A GitHub draft Release is created only after both signed builds pass.

The draft is not public automatically. Review the APK, AAB, Windows installer, and `SHA256SUMS.txt` before publishing it in GitHub.

## One-time GitHub setup

Create a GitHub Environment named `release`, restrict it to `v*` tags, and add reviewers as appropriate. Store signing secrets in that Environment only; PR and regular CI jobs never receive them.

| Purpose | Name | Type |
| --- | --- | --- |
| Android keystore Base64 | `ANDROID_KEYSTORE_BASE64` | secret |
| Android keystore password | `ANDROID_KEYSTORE_PASSWORD` | secret |
| Android key alias | `ANDROID_KEY_ALIAS` | secret |
| Android key password | `ANDROID_KEY_PASSWORD` | secret |
| Optional Android SHA-256 certificate fingerprint | `ANDROID_CERT_SHA256` | variable |
| Windows Authenticode PFX Base64 | `WINDOWS_CERTIFICATE_BASE64` | secret |
| Windows PFX password | `WINDOWS_CERTIFICATE_PASSWORD` | secret |
| Windows RFC 3161 timestamp URL | `WINDOWS_TIMESTAMP_URL` | variable |

Repository Actions settings must also permit the final publishing job to use `GITHUB_TOKEN` with `contents: write`.

## Android signing

Generate the keystore once and keep the raw `.jks` outside the repository. For example:

```bash
keytool -genkeypair -v -keystore rlive-release.jks -alias rlive \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w 0 rlive-release.jks
```

Save that Base64 output as `ANDROID_KEYSTORE_BASE64`. Never commit the `.jks`, `keystore.properties`, passwords, or Base64 text. The workflow restores the keystore in a temporary directory, writes ignored Gradle properties, builds arm64, verifies the APK/AAB with `apksigner` and `jarsigner`, then removes the signing files.

### Local signed build

Keep the keystore outside the repository, restrict its permissions, and inspect its alias and certificate fingerprint locally. `keytool` prompts for the password, so do not pass it through chat or shell history:

```bash
chmod 600 /home/shenss/upload-keystore.jks
keytool -list -v -keystore /home/shenss/upload-keystore.jks
```

Create `backend/gen/android/app/keystore.properties` with mode `600` (it is already Git-ignored) and fill in the actual values:

```properties
storeFile=/home/shenss/upload-keystore.jks
storePassword=<keystore password>
keyAlias=<Alias name from keytool>
keyPassword=<private-key password>
```

Then build and verify the artifacts:

```bash
bun run tauri -- android build --ci --target aarch64 --apk --aab
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs \
  backend/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
jarsigner -verify -strict \
  backend/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

The local `keystore.properties` file is excluded from the Windows mirror so plaintext passwords do not persist in `D:\\dev\\rLive`.

### GitHub Environment setup

1. Open `Settings → Environments → New environment` and create the environment named exactly `release`.
2. Add any required reviewers and restrict deployment branches/tags to `v*` tags.
3. Add `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` as **Environment secrets**. In a private WSL terminal, `base64 -w 0 /home/shenss/upload-keystore.jks | clip.exe` copies the one-line Base64 value for the first secret; never paste it into chat or the repository.
4. Add the SHA-256 fingerprint printed by `keytool` as the `ANDROID_CERT_SHA256` **Environment variable**. This is recommended so the release verifies the signing certificate it actually used.
5. Under `Settings → Actions → General → Workflow permissions`, allow `GITHUB_TOKEN` to read and write repository contents; otherwise the final job cannot create the draft Release.

A formal tag builds both Windows and Android. Before pushing a `v*` tag, configure the Windows secrets and timestamp variable described below too; an Android JKS cannot replace a Windows Authenticode certificate.

- `rLive_<version>_android-arm64-v8a.apk` is for direct installation on arm64-v8a devices (minimum Android API 24).
- `rLive_<version>_android-arm64-v8a.aab` is for Play Console or another store; it is not directly installable.

Before each store upload, make sure the generated Android `versionCode` is greater than the already published version. Do not edit Tauri-generated `tauri.properties` by hand.

## Windows signing

Convert an Authenticode-capable PFX to single-line Base64 outside the repository, then save it as the environment secret. For example in PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\rlive-signing.pfx"))
```

The workflow imports it only into the disposable Windows runner's `CurrentUser\My` certificate store and has Tauri sign both the application binary and NSIS installer. It verifies the signature status and certificate thumbprint with `Get-AuthenticodeSignature`; absent certificate, password, or timestamp URL fails the release.

The formal Windows asset is `rLive_<version>_x64-setup.exe`, not a bare `rlive.exe`.

## Final review

1. Download every draft asset and `SHA256SUMS.txt`.
2. In an empty directory, run `sha256sum -c SHA256SUMS.txt`.
3. Test-install the NSIS package on Windows, and validate APK signature, installation, networking, and core playback on an arm64 Android device.
4. Review release notes and publish the draft.

`TAURI_SIGNING_PRIVATE_KEY` signs Tauri updater artifacts. It is not an Android keystore or Windows Authenticode PFX, and this release workflow does not use it.
