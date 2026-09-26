# AAB → universal APK

Google Play needs AABs, but an AAB cannot be installed directly on a device.
`caricamento apk` converts an AAB into a single universal APK for local
installation or sideloading.

```bash
caricamento apk myapp                                        # newest AAB from the build outputs
caricamento apk myapp --artifact app-release.aab --out /tmp/app.apk
adb install /tmp/app.apk
```

| Flag | Default | Description |
|---|---|---|
| `--artifact <path>` | newest AAB in the build outputs | Input AAB |
| `--out <path>` | `<name>-universal.apk` next to the AAB | Output APK |

Under the hood it runs `bundletool build-apks --mode=universal` and extracts
the APK. The output path is printed in the log.

## Signing

The APK is signed with the keystore from `android.signing` (see
[signing.md](signing.md#android)). Without `android.signing`, bundletool
applies its debug signature and a note is logged.

## bundletool resolution

1. `$BUNDLETOOL_PATH` (a binary or a `.jar`; an invalid path is an error)
2. `bundletool` on `PATH` (e.g. `brew install bundletool`)
3. `~/.caricamento/tools/bundletool.jar`, downloaded once from the latest
   [google/bundletool](https://github.com/google/bundletool/releases) GitHub
   release and cached
4. Otherwise a build error with a `brew install bundletool` hint

`.jar` files are run with `java -jar`, so a JDK must be on `PATH`.
