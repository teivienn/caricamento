/**
 * Pure formatting for git-derived release notes (SPEC §7): one bullet per
 * commit subject, empty subjects dropped.
 */
export function formatReleaseNotes(subjects: string[]): string {
  return subjects
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `- ${s}`)
    .join('\n');
}
