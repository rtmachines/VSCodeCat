import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface ExtensionSettings {
  exePath: string;
  decodeOutputRoot: string;
  encodeStagingRoot: string;
  backupsEnabled: boolean;
  backupsLocation: string;
  confirmNativeApply: boolean;
  validateOnRebuild: boolean;
}

export function settings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("twincatBlark");
  return {
    exePath: config.get<string>("exePath", ""),
    decodeOutputRoot: config.get<string>("decodeOutputRoot", "${workspaceFolder}/.twincat-st"),
    encodeStagingRoot: config.get<string>("encodeStagingRoot", "${workspaceFolder}/.blark/encoded"),
    backupsEnabled: config.get<boolean>("backups.enabled", true),
    backupsLocation: config.get<string>("backups.location", "${workspaceFolder}/.blark/backups"),
    confirmNativeApply: config.get<boolean>("confirmNativeApply", true),
    validateOnRebuild: config.get<boolean>("validateOnRebuild", true),
  };
}

export function workspaceFolderForPath(filePath?: string): string | undefined {
  if (filePath) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function resolveSettingPath(
  rawValue: string,
  context: vscode.ExtensionContext,
  workspaceFolder?: string,
): string {
  const home = os.homedir();
  const value = rawValue
    .replaceAll("${workspaceFolder}", workspaceFolder ?? "")
    .replaceAll("${extensionPath}", context.extensionPath)
    .replace(/^~(?=$|[\\/])/, home);
  return path.resolve(value);
}

export function resolveBlarkExePath(
  context: vscode.ExtensionContext,
  workspaceFolder?: string,
): string {
  const configured = settings().exePath.trim();
  const candidate = configured
    ? resolveSettingPath(configured, context, workspaceFolder)
    : context.asAbsolutePath(path.join("resources", "bin", "win32-x64", "blark.exe"));

  if (!fs.existsSync(candidate)) {
    const source = configured
      ? "`twincatBlark.exePath` points to a missing file"
      : "no bundled `resources/bin/win32-x64/blark.exe` was found";
    throw new Error(
      `Unable to find compiled blark.exe: ${source} (${candidate}). ` +
        "Build blark.exe or configure `twincatBlark.exePath` to its absolute path.",
    );
  }
  return candidate;
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\.+$/g, "_") || "project";
}
