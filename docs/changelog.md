# Release notes from git

Instead of writing release notes by hand, caricamento can generate them from
the target project's git history:

```typescript
export default {
  // ...
  changelog: { source: 'git', maxCommits: 20 },
};
```

| Field | Type | Default | Description |
|---|---|---|---|
| `source` | `'git'` | — | Required when the block is present; the only supported source |
| `maxCommits` | number | `20` | How many recent commits to use when the repository has no tags |

## How notes are built

- Commits since the last tag (`git describe --tags --abbrev=0`), excluding
  merge commits (`git log --no-merges`), one line per commit: `- <subject>`.
- If the repository has no tags, the last `maxCommits` commits are used.

## Precedence

For each target, release notes come from the first available source:

1. `--release-notes <text>` on the command line
2. The target's own text: `releaseNotes` ([Firebase](firebase.md),
   [Play](google-play.md)) or `whatToTest` ([TestFlight](app-store.md))
3. The generated git changelog

The changelog step only runs when at least one target lacks its own notes.
Internal App Sharing has no release notes.
