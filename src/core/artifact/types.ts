export type ArtifactKind = 'apk' | 'aab' | 'ipa' | 'mapping' | 'dsym' | 'symbols';

export interface Artifact {
  kind: ArtifactKind;
  platform: 'android' | 'ios';
  path: string;
  sizeBytes?: number;
}
