# Changelog

Notable changes to caricamento. Dates follow the npm publish time.

This file is the package history. [docs/changelog.md](docs/changelog.md) is
something else: it describes how the CLI builds release notes from the target
project's git history.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-26

### Changed

- Install instructions point at `npm install -g caricamento`.

## [0.1.0] - 2026-09-26

First published release.

### Added

- One-command build, sign, verify and publish for native Android, native iOS,
  React Native CLI and Expo (bare / prebuilt).
- Firebase App Distribution, Google Play (tracks and Internal App Sharing) and
  App Store Connect / TestFlight.
- Signing and version injection that leaves project files untouched.
- Project registry (`~/.caricamento`) and macOS Keychain secrets, with the same
  config reading secrets from environment variables in CI.
- qa / prod variants, version auto-increment, release notes from git, idempotent
  re-uploads, and `caricamento apk` (AAB to a universal APK via bundletool).

TestFlight upload is implemented and unit-tested. It has not been verified
against a real Apple Developer account.

[0.1.1]: https://www.npmjs.com/package/caricamento/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/caricamento/v/0.1.0
