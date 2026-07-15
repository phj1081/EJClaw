import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { OutboundFile } from "./types";
import { isSensitiveArtifactName } from "./outbound-artifacts";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

function safeName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._()\[\] -]/g, "_");
  return base || "artifact";
}

export function spoolOutboundArtifacts(jobId: string, files: OutboundFile[], root: string): OutboundFile[] {
  if (files.length === 0) return [];
  const targetDir = join(resolve(root), jobId);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const copied: OutboundFile[] = [];

  try {
    files.forEach((file, index) => {
      if (isSensitiveArtifactName(file.name) || isSensitiveArtifactName(file.path)) {
        throw new Error(`${file.path}: credential성 파일명 거부`);
      }
      const targetName = `${String(index + 1).padStart(2, "0")}-${safeName(file.name)}`;
      const targetPath = join(targetDir, targetName);
      const sourceFd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let targetFd: number | null = null;
      try {
        const stat = fstatSync(sourceFd);
        if (!stat.isFile()) throw new Error(`${file.path}: 일반 파일 아님`);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`${file.path}: 25MB 초과`);
        targetFd = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        let offset = 0;
        while (offset < stat.size) {
          const bytesRead = readSync(sourceFd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (bytesRead <= 0) throw new Error(`${file.path}: 복사 중 조기 EOF`);
          let written = 0;
          while (written < bytesRead) {
            written += writeSync(targetFd, buffer, written, bytesRead - written);
          }
          offset += bytesRead;
        }
        fsyncSync(targetFd);
        copied.push({ path: targetPath, name: file.name });
      } finally {
        if (targetFd !== null) closeSync(targetFd);
        closeSync(sourceFd);
      }
    });
    return copied;
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }
}

export function removeOutboundSpool(jobId: string, root: string): void {
  rmSync(join(resolve(root), jobId), { recursive: true, force: true });
}
