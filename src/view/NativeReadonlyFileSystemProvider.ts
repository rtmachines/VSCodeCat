import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export const nativeReadonlyScheme = "blark-native";

export function toNativeReadonlyUri(filePath: string): vscode.Uri {
  const encoded = Buffer.from(path.resolve(filePath), "utf8").toString("base64url");
  return vscode.Uri.from({ scheme: nativeReadonlyScheme, path: `/${encoded}` });
}

export function fromNativeReadonlyUri(uri: vscode.Uri): string {
  const encoded = uri.path.replace(/^\//, "");
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function fileTypeFromStat(stat: import("node:fs").Stats): vscode.FileType {
  if (stat.isDirectory()) {
    return vscode.FileType.Directory;
  }
  if (stat.isFile()) {
    return vscode.FileType.File;
  }
  if (stat.isSymbolicLink()) {
    return vscode.FileType.SymbolicLink;
  }
  return vscode.FileType.Unknown;
}

export class NativeReadonlyFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await fs.stat(fromNativeReadonlyUri(uri));
    return {
      type: fileTypeFromStat(stat),
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await fs.readdir(fromNativeReadonlyUri(uri), { withFileTypes: true });
    return entries.map((entry) => {
      const type = entry.isDirectory()
        ? vscode.FileType.Directory
        : entry.isFile()
          ? vscode.FileType.File
          : entry.isSymbolicLink()
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.Unknown;
      return [entry.name, type];
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return fs.readFile(fromNativeReadonlyUri(uri));
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("blark native files are read-only.");
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions("blark native files are read-only.");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("blark native files are read-only.");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("blark native files are read-only.");
  }
}
