import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { projectDecodeArgs, projectEncodeArgs } from "./blark/arguments";
import { BlarkProcess } from "./blark/BlarkProcess";
import {
  findStructuredRoot,
  getOriginalNativeRoot,
  loadManifest,
  manifestPath,
  rebuildIndexAndDiagnostics,
  writeMetadataJson,
} from "./blark/Manifest";
import { resolveSettingPath, sanitizePathSegment, settings, workspaceFolderForPath } from "./config";
import { backupChangedTargets } from "./safety/BackupService";
import { applyChanges, diffTrees } from "./safety/DiffService";
import { withNotificationProgress } from "./ui/Progress";
import {
  fromNativeReadonlyUri,
  nativeReadonlyScheme,
  NativeReadonlyFileSystemProvider,
  toNativeReadonlyUri,
} from "./view/NativeReadonlyFileSystemProvider";
import { NativeReadonlyTreeProvider } from "./view/NativeReadonlyTreeProvider";

const supportedTwinCatExtensions = new Set([
  ".sln",
  ".tsproj",
  ".plcproj",
  ".tcpou",
  ".tcgvl",
  ".tcdut",
  ".tcio",
  ".tctto",
]);

function uriToFsPath(uri?: vscode.Uri | string | { fsPath?: string }): string | undefined {
  if (typeof uri === "string") {
    return uri;
  }
  if (uri && "scheme" in uri && typeof uri.scheme === "string") {
    if (uri.scheme === nativeReadonlyScheme) {
      return fromNativeReadonlyUri(uri);
    }
    return uri.fsPath;
  }
  return uri && "fsPath" in uri && typeof uri.fsPath === "string" ? uri.fsPath : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

async function isNonEmptyDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory() && (await fs.readdir(target)).length > 0;
  } catch {
    return false;
  }
}

function defaultDecodeOutputPath(context: vscode.ExtensionContext, inputPath: string): string {
  const workspaceFolder = workspaceFolderForPath(inputPath);
  const root = resolveSettingPath(settings().decodeOutputRoot, context, workspaceFolder);
  return path.join(root, path.basename(inputPath, path.extname(inputPath)));
}

function defaultStagingPath(context: vscode.ExtensionContext, structuredRoot: string): string {
  const workspaceFolder = workspaceFolderForPath(structuredRoot);
  const root = resolveSettingPath(settings().encodeStagingRoot, context, workspaceFolder);
  return path.join(root, sanitizePathSegment(path.basename(structuredRoot)));
}

async function pickTwinCatInput(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "TwinCAT/blark supported": ["sln", "tsproj", "plcproj", "TcPOU", "TcGVL", "TcDUT", "TcIO", "TcTTO"],
    },
    title: "Select a TwinCAT project or source file to decode",
  });
  return picked?.[0]?.fsPath;
}

async function pickStructuredRoot(uri?: vscode.Uri | string): Promise<string | undefined> {
  const candidate = uriToFsPath(uri) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (candidate) {
    const root = await findStructuredRoot(candidate);
    if (root) {
      return root;
    }
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Select a decoded blark structured folder",
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) {
    return undefined;
  }
  const root = await findStructuredRoot(folder);
  if (!root) {
    throw new Error(`No .blark/manifest.json was found under ${folder}.`);
  }
  return root;
}

async function confirmOverwriteOutput(outputPath: string): Promise<boolean | undefined> {
  if (!(await isNonEmptyDirectory(outputPath))) {
    return false;
  }
  const answer = await vscode.window.showWarningMessage(
    `The output folder already exists and is not empty: ${outputPath}`,
    { modal: true, detail: "Decoding with overwrite replaces the existing structured folder, including ST files." },
    "Overwrite",
  );
  return answer === "Overwrite" ? true : undefined;
}

async function decodeProject(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  tree: NativeReadonlyTreeProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const inputPath = uriToFsPath(uri) ?? (await pickTwinCatInput());
  if (!inputPath) {
    return;
  }
  if (!supportedTwinCatExtensions.has(path.extname(inputPath).toLowerCase())) {
    throw new Error(`${inputPath} is not a supported TwinCAT/blark input file.`);
  }

  const defaultOutput = defaultDecodeOutputPath(context, inputPath);
  const outputPath = await vscode.window.showInputBox({
    title: "Decode TwinCAT project to Structured Text",
    prompt: "Structured output folder",
    value: defaultOutput,
  });
  if (!outputPath) {
    return;
  }

  const overwrite = await confirmOverwriteOutput(outputPath);
  if (overwrite === undefined) {
    return;
  }

  const workspaceFolder = workspaceFolderForPath(inputPath);
  await withNotificationProgress("Decoding TwinCAT project with blark", (token) =>
    blark.run(projectDecodeArgs(inputPath, outputPath, overwrite), token, workspaceFolder),
  );

  tree.refresh();
  const srcRoot = path.join(outputPath, "src");
  if (await pathExists(srcRoot)) {
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(srcRoot));
  }
  vscode.window.showInformationMessage(`Decoded TwinCAT project to ${outputPath}. Edit ST files under src/.`);
}

function changedFilesDetail(changes: Awaited<ReturnType<typeof diffTrees>>): string {
  const shown = changes.slice(0, 12).map((change) => `${change.kind}: ${change.relativePath}`);
  const remaining = changes.length > shown.length ? [`...and ${changes.length - shown.length} more.`] : [];
  return [...shown, ...remaining].join("\n");
}

async function confirmApplyNativeChanges(changes: Awaited<ReturnType<typeof diffTrees>>, targetRoot: string): Promise<boolean> {
  if (!settings().confirmNativeApply) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `Apply ${changes.length} generated TwinCAT file change(s) to ${targetRoot}?`,
    {
      modal: true,
      detail: changedFilesDetail(changes),
    },
    "Apply Changes",
  );
  return answer === "Apply Changes";
}

async function encodeProject(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  output: vscode.OutputChannel,
  uri?: vscode.Uri | string,
): Promise<void> {
  const structuredRoot = await pickStructuredRoot(uri);
  if (!structuredRoot) {
    return;
  }

  const workspaceFolder = workspaceFolderForPath(structuredRoot);
  const stagingRoot = defaultStagingPath(context, structuredRoot);
  await withNotificationProgress("Encoding ST source of truth with blark", (token) =>
    blark.run(projectEncodeArgs(structuredRoot, stagingRoot, true), token, workspaceFolder),
  );

  const manifest = await loadManifest(structuredRoot);
  const targetRoot = getOriginalNativeRoot(manifest);
  const changes = await diffTrees(stagingRoot, targetRoot);
  output.appendLine("");
  output.appendLine(`Staged native output: ${stagingRoot}`);
  output.appendLine(`Original TwinCAT target: ${targetRoot}`);
  for (const change of changes) {
    output.appendLine(`${change.kind.toUpperCase()} ${change.relativePath}`);
  }

  if (changes.length === 0) {
    vscode.window.showInformationMessage("blark encode completed. No native TwinCAT files changed.");
    return;
  }

  if (!(await confirmApplyNativeChanges(changes, targetRoot))) {
    vscode.window.showInformationMessage(`Generated TwinCAT output remains staged at ${stagingRoot}.`);
    return;
  }

  if (settings().backupsEnabled) {
    const backupRoot = resolveSettingPath(settings().backupsLocation, context, workspaceFolder);
    const backedUp = await backupChangedTargets(changes, targetRoot, backupRoot);
    output.appendLine(`Backed up ${backedUp} existing file(s) to ${backupRoot}.`);
  }

  await applyChanges(changes);
  vscode.window.showInformationMessage(`Applied ${changes.length} generated TwinCAT file change(s).`);
}

async function rebuildMetadata(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  uri?: vscode.Uri | string,
): Promise<void> {
  const structuredRoot = await pickStructuredRoot(uri);
  if (!structuredRoot) {
    return;
  }
  const manifest = await loadManifest(structuredRoot);
  const rebuilt = await rebuildIndexAndDiagnostics(structuredRoot, manifest);

  let validationError: unknown;
  if (settings().validateOnRebuild) {
    const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "twincat-blark-validate-"));
    try {
      const workspaceFolder = workspaceFolderForPath(structuredRoot);
      await withNotificationProgress("Validating current ST source with blark", (token) =>
        blark.run(projectEncodeArgs(structuredRoot, validationRoot, true), token, workspaceFolder),
      );
    } catch (error) {
      rebuilt.diagnostics.diagnostics.push({
        severity: "error",
        source: "twincatBlark",
        message: `blark validation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      validationError = error;
    } finally {
      await fs.rm(validationRoot, { recursive: true, force: true });
    }
  }

  await writeMetadataJson(structuredRoot, "index.json", rebuilt.index);
  await writeMetadataJson(structuredRoot, "diagnostics.json", rebuilt.diagnostics);
  if (validationError) {
    throw validationError;
  }
  const errorCount = rebuilt.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  vscode.window.showInformationMessage(
    `Rebuilt blark metadata for ${path.basename(structuredRoot)} with ${errorCount} error(s).`,
  );
}

async function openNativeReadonly(uriOrPath?: vscode.Uri | string | { fsPath?: string }): Promise<void> {
  const filePath = uriToFsPath(uriOrPath) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!filePath) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(toNativeReadonlyUri(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function applyReadonlyExplorerGlobs(): Promise<void> {
  const config = vscode.workspace.getConfiguration("files");
  const current = config.get<Record<string, boolean>>("readonlyInclude", {});
  const updated = {
    ...current,
    "**/.twincat-st/**/native/**": true,
    "**/.twincat-st/**/.blark/**": true,
  };
  await config.update("readonlyInclude", updated, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("TwinCAT native and blark metadata folders are now read-only in this workspace.");
}

function handleCommandErrors(command: (...args: never[]) => Promise<void>): (...args: never[]) => Promise<void> {
  return async (...args: never[]) => {
    try {
      await command(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(message, "Open Log").then((selection) => {
        if (selection === "Open Log") {
          vscode.commands.executeCommand("twincatBlark.openOutput");
        }
      });
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("TwinCAT blark");
  const blark = new BlarkProcess(context, output);
  const tree = new NativeReadonlyTreeProvider();

  context.subscriptions.push(
    output,
    vscode.workspace.registerFileSystemProvider(nativeReadonlyScheme, new NativeReadonlyFileSystemProvider(), {
      isReadonly: true,
    }),
    vscode.window.registerTreeDataProvider("twincatBlark.nativeReadonly", tree),
    vscode.commands.registerCommand(
      "twincatBlark.decodeProject",
      handleCommandErrors((uri?: vscode.Uri) => decodeProject(context, blark, tree, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.encodeProject",
      handleCommandErrors((uri?: vscode.Uri) => encodeProject(context, blark, output, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.encodeCurrentStFile",
      handleCommandErrors((uri?: vscode.Uri) => encodeProject(context, blark, output, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.rebuildMetadata",
      handleCommandErrors((uri?: vscode.Uri) => rebuildMetadata(context, blark, uri)),
    ),
    vscode.commands.registerCommand("twincatBlark.openNativeReadonly", handleCommandErrors(openNativeReadonly)),
    vscode.commands.registerCommand("twincatBlark.applyReadonlyExplorerGlobs", handleCommandErrors(applyReadonlyExplorerGlobs)),
    vscode.commands.registerCommand("twincatBlark.openOutput", () => output.show(true)),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context subscriptions.
}
