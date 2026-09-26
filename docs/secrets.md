# Secrets

Configs contain only references like `secret:android/keystore-password`, never
values. A reference is resolved at run time through this chain, first match
wins:

1. **Environment variable** — the name upper-cased with every run of
   non-alphanumeric characters replaced by `_`:
   `android/keystore-password` → `ANDROID_KEYSTORE_PASSWORD`.
2. **macOS Keychain** — generic password item with service
   `caricamento/<name>`.
3. **Registry `.env`** — `~/.caricamento/projects/<name>.env` (registry mode only).
4. **Project `.env`** — `<project>/.env`.

Secrets for credential files may hold either a file path or the content
itself: service account JSON (inline JSON), the App Store Connect `.p8`
(inline PEM), iOS `.p12` and `.mobileprovision` (base64). The Android
keystore (`keystoreRef`) must be a file path.

## Keychain (recommended locally)

Store once, use from any directory:

```bash
caricamento secrets set android/keystore-path      # hidden prompt
caricamento secrets set android/keystore-password
caricamento secrets set android/key-password
caricamento secrets set play/service-account       # path to the JSON key
caricamento secrets set asc/private-key            # path to AuthKey_XXXX.p8
caricamento secrets list                           # names only
caricamento secrets get android/keystore-path
caricamento secrets delete android/key-password
```

Items live in the login keychain and are visible and editable in
**Keychain Access.app** (search for "caricamento"). `secrets set --value <v>`
exists for scripting, but the value ends up in shell history. Full flags:
[commands.md#secrets](commands.md#secrets).

## `.env` files

Next to the config: `~/.caricamento/projects/<name>.env` in registry mode,
`<project>/.env` in in-project mode (keep it in `.gitignore`).

```bash
ANDROID_KEYSTORE_PATH=/abs/path/to/upload.keystore
ANDROID_KEYSTORE_PASSWORD=...
ANDROID_KEY_PASSWORD=...
GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/firebase-sa.json
```

## CI

Provide everything as environment variables; the config stays the same:

```bash
export ANDROID_KEYSTORE_PATH=$RUNNER_TEMP/upload.keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_PASSWORD=...
export PLAY_SERVICE_ACCOUNT="$(cat play-sa.json)"
export IOS_CERTIFICATE=$(base64 -i dist.p12)
```

## Google credentials fallback

For Firebase, `targets.firebase.serviceAccountRef` is optional; without it the
standard `GOOGLE_APPLICATION_CREDENTIALS` variable is used. Play and Internal
App Sharing always require `serviceAccountRef`.
