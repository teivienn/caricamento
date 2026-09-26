# Internal App Sharing (`playsharing`)

A quick way to hand out a build by link, without tracks or tester groups: the
APK or AAB is uploaded to Google Play Internal App Sharing and Play returns a
`downloadUrl` that installs the build through the Play Store. The recipient
must have internal app sharing enabled on the device and use an allowed Google
account.

It uses the same service account as [Google Play](google-play.md) (scope
`androidpublisher`).

## One-time step in Play Console

Play Console → **Setup** → **Internal app sharing** → enable it and **accept
the Terms of Service**. Until this is done, the API rejects uploads with
`TOS_NOT_ACCEPTED` (surfaced as an upload error, exit code 5).

> Status: the upload code path is implemented and unit-tested, but live
> verification is blocked until the Terms of Service are accepted on the test
> account.

## Configuration

```typescript
targets: {
  playsharing: {
    serviceAccountRef: 'secret:play/service-account',
    packageName: 'com.example.app',
  },
},
```

| Field | Type | Description |
|---|---|---|
| `serviceAccountRef` | `secret:<name>` | **Required.** Service account JSON with Play API access |
| `packageName` | string | **Required.** applicationId as registered in Play Console |

## Usage

```bash
caricamento release myapp --targets playsharing          # build + link
caricamento upload myapp --target playsharing --artifact app-release.aab
```

`playsharing` is Android-only and accepts APK or AAB. The link is printed in
the step log (`Internal App Sharing download URL: ...`) and returned as `url`
in the `--json` output.
