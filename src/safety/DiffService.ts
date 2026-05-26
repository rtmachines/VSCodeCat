import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileChange {
  relativePath: string;
  stagedPath: string;
  targetPath: string;
  kind: "add" | "modify";
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        result.push(child);
      }
    }
  }
  await walk(root);
  return result;
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
    return leftBytes.equals(rightBytes);
  } catch {
    return false;
  }
}

export async function diffTrees(stagingRoot: string, targetRoot: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const stagedPath of await listFiles(stagingRoot)) {
    const relativePath = path.relative(stagingRoot, stagedPath);
    const targetPath = path.join(targetRoot, relativePath);
    const exists = await fs
      .stat(targetPath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!exists) {
      changes.push({ relativePath, stagedPath, targetPath, kind: "add" });
      continue;
    }
    if (!(await sameFile(stagedPath, targetPath))) {
      changes.push({ relativePath, stagedPath, targetPath, kind: "modify" });
    }
  }
  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function applyChanges(changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    await fs.mkdir(path.dirname(change.targetPath), { recursive: true });
    await fs.copyFile(change.stagedPath, change.targetPath);
  }
}
