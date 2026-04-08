export declare const VERIFICATION_SNAPSHOT_EXCLUDE_NAMES: ReadonlySet<string>;
export declare function isVerificationSnapshotExcludedName(
  name: string,
): boolean;
export declare function isVerificationSnapshotExcludedPath(
  repoDir: string,
  currentPath: string,
): boolean;
export declare function computeVerificationSnapshotId(repoDir: string): string;
