import { randomUUID } from "crypto";
import { renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

function replaceAtomicSync(filePath: string, contents: string, mode?: number): void {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
      flush: true,
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  replaceAtomicSync(path, contents, 0o600);
}

/**
 * Replace an existing file atomically, keeping its current permission bits.
 * A rename would otherwise reset them to the process default, which would
 * silently break executable scripts and group-readable configs.
 */
export function writeFileAtomicSync(path: string, contents: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    mode = undefined;
  }
  replaceAtomicSync(path, contents, mode);
}
