# Google Play

Publishing uses the Google Play Developer API v3 directly (no `googleapis`),
as a transactional *edit*: upload AAB → assign to a track → upload
`mapping.txt` → commit.

## One-time setup (~10 minutes)

You need a Google Play developer account, and the app must **already exist**
in Play Console: creating an app is only possible in the web UI.

**1. Google Cloud project.** Open
[console.cloud.google.com](https://console.cloud.google.com) → project picker
→ **New Project** (e.g. `caricamento-play`) → **Create**. An existing project
(including the one Firebase created) works too.

**2. Enable the Google Play Android Developer API.** Open
[console.cloud.google.com/apis/library/playdeveloper.googleapis.com](https://console.cloud.google.com/apis/library/playdeveloper.googleapis.com),
make sure the right project is selected, and click **Enable**.

**3. Create a service account.** Open
[console.cloud.google.com/iam-admin/serviceaccounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
→ **Create Service Account** → name it `play-publisher` → **Create and
Continue** → **skip** "Grant this service account access to project" (no
Cloud role is needed; access is granted in Play Console) → **Done**.

**4. Download a JSON key.** Click the service account's email → **Keys** →
**Add Key** → **Create new key** → **JSON** → **Create**. The file downloads
once; you can only create new keys later.

**5. Invite the service account in Play Console.** The old *Setup → API
access* page has been removed; service accounts are now invited like regular
users. Open [play.google.com/console](https://play.google.com/console) →
**Users and permissions** → **Invite new users** → paste the service account
email (`play-publisher@<project>.iam.gserviceaccount.com`).

**6. Grant permissions** in the same invite form. Under **Account
permissions**, the minimum for publishing is:

- **View app information and download bulk reports (read-only)** — required;
- **Release apps to testing tracks** — for internal / alpha / beta;
- **Release to production, exclude devices and use Play app signing** — only
  if you publish to production through the API.

Alternatively grant them per app under **App permissions**. Click **Invite
user**; service accounts become Active immediately.

**7. Store the key:**

```bash
caricamento secrets set play/service-account   # paste the PATH to the JSON file
```

## Configuration

```typescript
targets: {
  play: {
    serviceAccountRef: 'secret:play/service-account', // required
    packageName: 'com.example.app',                   // required
    track: 'internal',
    status: 'completed',
    releaseNotes: 'What is new',
  },
},
```

| Field | Type | Default | Description |
|---|---|---|---|
| `serviceAccountRef` | `secret:<name>` | — | **Required.** Service account JSON (path or inline JSON) |
| `packageName` | string | — | **Required.** The app's applicationId as registered in Play Console |
| `track` | `internal` \| `alpha` \| `beta` \| `production` | `internal` | Target track |
| `status` | `completed` \| `draft` | `completed` | `draft` leaves the release unpublished on the track; `completed` makes it available immediately |
| `releaseNotes` | string | — | "What's new" text, locale `en-US` only. Overridden by `--release-notes`, falls back to the [git changelog](changelog.md) |

## Tracks

| Track | Audience | Typical use |
|---|---|---|
| `internal` | Up to 100 testers, no Google review | Daily builds for the team / QA |
| `alpha` | Closed testing by list | Stable builds for a wider group |
| `beta` | Open or closed testing | Pre-release validation |
| `production` | All users | Release (needs the production permission) |

One run publishes to one track. To switch tracks without editing the config,
register the same project twice with different configs:

```bash
caricamento projects add myapp-qa   --path ~/work/myapp --config ~/.caricamento/projects/myapp-qa.config.ts
caricamento projects add myapp-beta --path ~/work/myapp --config ~/.caricamento/projects/myapp-beta.config.ts

caricamento release myapp-qa     # track: internal
caricamento release myapp-beta   # track: beta
```

## Behavior

- **AAB only.** Play does not accept APKs. When `play` is among the targets,
  `release` switches the build to AAB automatically; `upload --target play`
  picks an AAB by default.
- **`mapping.txt`** (R8 / ProGuard), if produced alongside the AAB, is
  uploaded so crashes are deobfuscated in Play Console.
- **versionCode must strictly increase.** Use
  `version: { strategy: 'auto-increment' }` to query the current maximum across
  tracks and add one (see [versioning.md](versioning.md)).
- If anything fails after the edit is opened (e.g. validation on commit), the
  edit is deleted, so no stale drafts are left in Play Console.
- The first production release is usually done manually; the API is most
  useful for internal / alpha / beta.

```bash
caricamento release myapp                                  # internal, auto-increment
caricamento release myapp --release-notes "Fix crash on launch"
caricamento release myapp --targets firebase,play          # both in one run
caricamento upload myapp --target play --artifact app-release.aab
```

## Idempotent re-runs

A versionCode cannot be uploaded twice, so tracks are probed before an edit is
opened:

- The versionCode is already on the target track → "already published",
  nothing is committed.
- It exists on another track → only a `tracks.update` with the existing code is
  committed. This gives basic promotion between tracks without rebuilding.

## Target SDK requirement

Since August 31, 2026, app updates on Google Play must target API level 36.
Play reports this as `Target SDK of artifact is too low: N`, where **N is the
artifact's versionCode, not the SDK level**. Raise `targetSdkVersion` in the
project.

## Not supported yet

- Promoting an existing build between tracks as a dedicated command (beyond
  the idempotent re-run behavior above)
- Staged rollout (`userFraction`)
- Several tracks in one run
- Localized release notes (only `en-US`)
- Custom release names (Play derives the name from versionName)

See [roadmap.md](roadmap.md).

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `401` / `403` | Service account not invited in Play Console (*Users and permissions*) or missing release permissions |
| `404` | `packageName` does not match an existing Play Console app |
| `Version code ... has already been used` | versionCode did not increase; use `auto-increment` |
| `APK ... not allowed` | Play accepts only AAB; `release` switches automatically, for `upload` pass `--artifact-type aab` |
| `auto-increment has no version source` | Configure `targets.play` (Android), `targets.appstore` (iOS) or `targets.firebase`, or set `version.source` |
