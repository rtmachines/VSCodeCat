import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { backupChangedTargets } from "../src/safety/BackupService";
import { applyChanges, diffTrees } from "../src/safety/DiffService";

test("diffTrees, backupChangedTargets, and applyChanges stage safe native writes", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "twincat-blark-diff-"));
  const staged = path.join(temp, "staged");
  const target = path.join(temp, "target");
  const backup = path.join(temp, "backup");
  await fs.mkdir(path.join(staged, "POUs"), { recursive: true });
  await fs.mkdir(path.join(target, "POUs"), { recursive: true });
  await fs.writeFile(path.join(staged, "POUs", "MAIN.TcPOU"), "new", "utf8");
  await fs.writeFile(path.join(target, "POUs", "MAIN.TcPOU"), "old", "utf8");

  const changes = await diffTrees(staged, target);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "modify");

  const backedUp = await backupChangedTargets(changes, target, backup);
  assert.equal(backedUp, 1);
  await applyChanges(changes);
  assert.equal(await fs.readFile(path.join(target, "POUs", "MAIN.TcPOU"), "utf8"), "new");

  const backupFiles = await fs.readdir(backup);
  assert.equal(backupFiles.length, 1);
  assert.equal(await fs.readFile(path.join(backup, backupFiles[0], "POUs", "MAIN.TcPOU"), "utf8"), "old");
});
