import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  contentHash,
  findStructuredRoot,
  getOriginalNativeRoot,
  loadManifest,
  rebuildIndexAndDiagnostics,
  writeMetadataJson,
} from "../src/blark/Manifest";

async function makeTempStructuredRoot(): Promise<{ root: string; originalRoot: string }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "twincat-blark-test-"));
  const root = path.join(temp, "structured");
  const originalRoot = path.join(temp, "original");
  await fs.mkdir(path.join(root, ".blark"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "POUs", "MAIN"), { recursive: true });
  await fs.mkdir(path.join(root, "native", "POUs"), { recursive: true });
  await fs.mkdir(originalRoot, { recursive: true });
  await fs.writeFile(path.join(root, "src", "POUs", "MAIN", "implementation.st"), "x := x + 1;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "extra.st"), "PROGRAM Extra\nEND_PROGRAM\n", "utf8");
  await fs.writeFile(path.join(root, "native", "POUs", "MAIN.TcPOU"), "<TcPou />", "utf8");
  await fs.writeFile(path.join(originalRoot, "Project.sln"), "", "utf8");
  await fs.writeFile(
    path.join(root, ".blark", "manifest.json"),
    JSON.stringify(
      {
        format: "blark.twincat.project",
        version: 2,
        sourceRoot: "src",
        nativeRoot: "native",
        nativeEntry: "Project.sln",
        input_path: path.join(originalRoot, "Project.sln"),
        items: [
          {
            id: "POUs/MAIN.TcPOU::MAIN/implementation",
            path: "src/POUs/MAIN/implementation.st",
            nativePath: "POUs/MAIN.TcPOU",
            nativeIdentifier: "MAIN/implementation",
            objectId: "MAIN",
            kind: "program",
            part: "implementation",
            grammarRule: "statement_list",
            contentHash: "sha256:old",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, originalRoot };
}

test("findStructuredRoot locates the decoded folder from an ST file", async () => {
  const { root } = await makeTempStructuredRoot();
  const stFile = path.join(root, "src", "POUs", "MAIN", "implementation.st");
  assert.equal(await findStructuredRoot(stFile), root);
});

test("loadManifest and getOriginalNativeRoot use blark manifest fields", async () => {
  const { root, originalRoot } = await makeTempStructuredRoot();
  const manifest = await loadManifest(root);
  assert.equal(getOriginalNativeRoot(manifest), originalRoot);
});

test("rebuildIndexAndDiagnostics recomputes hashes and reports extra ST files", async () => {
  const { root } = await makeTempStructuredRoot();
  const manifest = await loadManifest(root);
  const rebuilt = await rebuildIndexAndDiagnostics(root, manifest);
  const expectedHash = contentHash("x := x + 1;\n");
  assert.equal(rebuilt.index.items[0].contentHash, expectedHash);
  assert.equal(rebuilt.diagnostics.diagnostics.length, 1);
  assert.equal(rebuilt.diagnostics.diagnostics[0].severity, "warning");
  assert.match(rebuilt.diagnostics.diagnostics[0].message, /Extra \.st file/);
});

test("writeMetadataJson writes formatted metadata under .blark", async () => {
  const { root } = await makeTempStructuredRoot();
  await writeMetadataJson(root, "index.json", { ok: true });
  const written = await fs.readFile(path.join(root, ".blark", "index.json"), "utf8");
  assert.match(written, /"ok": true/);
  assert.ok(written.endsWith("\n"));
});
