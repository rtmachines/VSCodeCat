import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileChange } from "./DiffService";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function backupChangedTargets(
  changes: FileChange[],
  targetRoot: string,
  backupRoot: string,
): Promise<number> {
  const stamp = timestamp();
  let count = 0;
  for (const change of changes) {
    const exists = await fs
      .stat(change.targetPath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!exists) {
      continue;
    }
    const relative = path.relative(targetRoot, change.targetPath);
    const backupPath = path.join(backupRoot, stamp, relative);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(change.targetPath, backupPath);
    count += 1;
  }
  return count;
}
