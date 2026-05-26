import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BlarkManifestItem {
  id?: string;
  path?: string;
  st_path?: string;
  nativePath?: string;
  source_path?: string;
  nativeIdentifier?: string;
  identifier?: string;
  objectId?: string;
  object_identifier?: string;
  kind?: string;
  type?: string;
  part?: string;
  grammarRule?: string;
  grammar_rule?: string;
  contentHash?: string;
}

export interface BlarkManifest {
  format?: string;
  version?: number;
  nativeRoot?: string;
  native_root?: string;
  sourceRoot?: string;
  source_root?: string;
  st_root?: string;
  nativeEntry?: string;
  native_entry?: string;
  input_path?: string;
  items: BlarkManifestItem[];
}

export interface MetadataDiagnostic {
  severity: "error" | "warning";
  message: string;
  path?: string;
  source: "twincatBlark";
}

export interface RebuiltIndex {
  format: "blark.twincat.index";
  version: 1;
  items: Array<Record<string, string | undefined>>;
}

export interface RebuiltDiagnostics {
  format: "blark.diagnostics";
  version: 1;
  diagnostics: MetadataDiagnostic[];
}

export function manifestPath(structuredRoot: string): string {
  return path.join(structuredRoot, ".blark", "manifest.json");
}

export function metadataPath(structuredRoot: string, filename: string): string {
  return path.join(structuredRoot, ".blark", filename);
}

export function sourceRootName(manifest: BlarkManifest): string {
  return manifest.sourceRoot ?? manifest.source_root ?? manifest.st_root ?? "src";
}

export function nativeRootName(manifest: BlarkManifest): string {
  return manifest.nativeRoot ?? manifest.native_root ?? "native";
}

export function nativeEntry(manifest: BlarkManifest): string {
  return manifest.nativeEntry ?? manifest.native_entry ?? "";
}

export function manifestItemStPath(item: BlarkManifestItem): string | undefined {
  return item.st_path ?? item.path;
}

export function manifestItemNativePath(item: BlarkManifestItem): string | undefined {
  return item.source_path ?? item.nativePath;
}

export function manifestItemIdentifier(item: BlarkManifestItem): string | undefined {
  return item.identifier ?? item.nativeIdentifier;
}

export function manifestPathToFsPath(root: string, manifestRelativePath: string): string {
  return path.join(root, ...manifestRelativePath.split(/[\\/]/).filter(Boolean));
}

export async function loadManifest(structuredRoot: string): Promise<BlarkManifest> {
  const raw = await fs.readFile(manifestPath(structuredRoot), "utf8");
  const parsed = JSON.parse(raw) as BlarkManifest;
  if (!Array.isArray(parsed.items)) {
    throw new Error(`${manifestPath(structuredRoot)} does not include a manifest items array.`);
  }
  return parsed;
}

export async function findStructuredRoot(startPath: string): Promise<string | undefined> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    try {
      await fs.access(manifestPath(current));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

export function getOriginalNativeRoot(manifest: BlarkManifest): string {
  if (!manifest.input_path) {
    throw new Error("The blark manifest does not include input_path; cannot locate original TwinCAT project root.");
  }
  const entry = nativeEntry(manifest);
  let root = path.dirname(path.resolve(manifest.input_path));
  const entryParentParts = entry.split(/[\\/]/).filter(Boolean).slice(0, -1);
  for (const _part of entryParentParts) {
    root = path.dirname(root);
  }
  return root;
}

export function contentHash(contents: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
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

function toManifestPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export async function rebuildIndexAndDiagnostics(
  structuredRoot: string,
  manifest: BlarkManifest,
): Promise<{ index: RebuiltIndex; diagnostics: RebuiltDiagnostics }> {
  const sourceRoot = path.join(structuredRoot, sourceRootName(manifest));
  const nativeRoot = path.join(structuredRoot, nativeRootName(manifest));
  const diagnostics: MetadataDiagnostic[] = [];
  const declaredStPaths = new Set<string>();

  const indexItems: RebuiltIndex["items"] = [];
  for (const item of manifest.items) {
    const stPathValue = manifestItemStPath(item);
    const nativePathValue = manifestItemNativePath(item);
    const identifier = manifestItemIdentifier(item);
    let hash = item.contentHash;

    if (!stPathValue) {
      diagnostics.push({
        severity: "error",
        source: "twincatBlark",
        message: "Manifest item is missing its Structured Text path.",
      });
    } else {
      const stPath = manifestPathToFsPath(structuredRoot, stPathValue);
      declaredStPaths.add(path.resolve(stPath));
      try {
        hash = contentHash(await fs.readFile(stPath));
      } catch {
        diagnostics.push({
          severity: "error",
          source: "twincatBlark",
          path: stPathValue,
          message: "Manifest references a missing Structured Text file.",
        });
      }
    }

    if (nativePathValue) {
      const nativePath = manifestPathToFsPath(nativeRoot, nativePathValue);
      if (!(await fileExists(nativePath))) {
        diagnostics.push({
          severity: "error",
          source: "twincatBlark",
          path: nativePathValue,
          message: "Manifest references a missing native baseline file.",
        });
      }
    }

    indexItems.push({
      id: item.id,
      path: stPathValue,
      nativePath: nativePathValue,
      nativeIdentifier: identifier,
      objectId: item.objectId ?? item.object_identifier,
      kind: item.kind ?? item.type,
      part: item.part,
      grammarRule: item.grammarRule ?? item.grammar_rule,
      contentHash: hash,
    });
  }

  for (const file of await listFiles(sourceRoot)) {
    if (path.extname(file).toLowerCase() !== ".st") {
      continue;
    }
    const resolved = path.resolve(file);
    if (!declaredStPaths.has(resolved)) {
      diagnostics.push({
        severity: "warning",
        source: "twincatBlark",
        path: toManifestPath(structuredRoot, file),
        message: "Extra .st file is not declared in the blark manifest and will not be encoded.",
      });
    }
  }

  return {
    index: {
      format: "blark.twincat.index",
      version: 1,
      items: indexItems,
    },
    diagnostics: {
      format: "blark.diagnostics",
      version: 1,
      diagnostics,
    },
  };
}

export async function writeMetadataJson(structuredRoot: string, filename: string, value: unknown): Promise<void> {
  const target = metadataPath(structuredRoot, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
