# Firebase App Distribution

caricamento uploads APKs, AABs and IPAs to Firebase App Distribution over REST
(no `firebase-tools`): upload → release notes → distribution to tester groups
and individual testers.

## One-time setup (~5 minutes)

1. **Firebase project**: [console.firebase.google.com](https://console.firebase.google.com)
   → create a project (the free Spark plan is enough).
2. **Register the app**: in the project → *Add app* → Android (the package name
   must equal your `applicationId`) and/or iOS (the bundle ID). Copy the
   **App ID**, e.g. `1:123456789:android:abc123...`. `google-services.json` is
   not needed.
3. **Tester group**: App Distribution → *Testers & Groups* → create a group,
   e.g. `qa`. The group alias is what goes into the config.
4. **Service account**: [Google Cloud Console](https://console.cloud.google.com)
   (same project) → IAM & Admin → Service Accounts → create one with the role
   **Firebase App Distribution Admin** → create a JSON key.
5. Point caricamento at the key, either with the standard variable:

   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-sa.json
   ```

   or via a secret: `caricamento secrets set firebase/service-account` plus
   `serviceAccountRef: 'secret:firebase/service-account'` in the config.

## Configuration

```typescript
targets: {
  firebase: {
    appIdAndroid: '1:123456789:android:abc123',
    appIdIos: '1:123456789:ios:def456',
    groups: ['qa'],
    testers: ['dev@example.com'],
    serviceAccountRef: 'secret:firebase/service-account',
    releaseNotes: 'What is new in this build',
  },
},
```

| Field | Type | Default | Description |
|---|---|---|---|
| `appIdAndroid` | string | — | Firebase App ID for Android builds |
| `appIdIos` | string | — | Firebase App ID for iOS builds |
| `groups` | string[] | `[]` | Tester group aliases (a `groups/` prefix is stripped) |
| `testers` | string[] | `[]` | Tester emails |
| `serviceAccountRef` | `secret:<name>` | — | Service account JSON (path or inline). Falls back to `GOOGLE_APPLICATION_CREDENTIALS` |
| `releaseNotes` | string | — | Release notes; overridden by `--release-notes`, falls back to the [git changelog](changelog.md) |

Firebase accepts both APK and AAB, so `--targets firebase,play` (which forces
an AAB) is fine. Firebase can also be the
[auto-increment source](versioning.md#auto-increment-sources).

```bash
caricamento release --platform android --targets firebase
caricamento release --platform ios --targets firebase
caricamento upload --target firebase --artifact app-release.apk
```

## Idempotent re-runs

Before uploading, existing releases are listed. If a release with the same
`buildVersion` already exists, the upload and release-notes steps are skipped
("already uploaded") and distribution to groups/testers runs as usual (it is
idempotent).

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `HTTP 404` on upload | Wrong App ID, or the artifact's package name differs from the one registered in Firebase |
| `404` on distribute | The group does not exist; check the alias in *Testers & Groups* |
| `401` / `403` | The service account lacks *Firebase App Distribution Admin*, or no credentials are configured |
