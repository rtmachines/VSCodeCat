import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { projectDecodeArgs, projectEncodeArgs } from "./blark/arguments";
import { BlarkProcess } from "./blark/BlarkProcess";
import {
  compareTwinCatInputs,
  decodeOutputPath,
  isSameOrInside,
  isSupportedTwinCatInput,
  safeSuggestedDecodeOutputPath,
} from "./blark/DecodePaths";
import {
  createDecodedFolder,
  createDecodedMember,
  createDecodedProjectItem,
  FunctionBlockVariant,
  listProjectInterfaces,
  MemberItemKind,
  ProjectItemKind,
  validateDecodedFolderName,
  validateDecodedIdentifier,
} from "./blark/DecodedProjectCreation";
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
  return decodeOutputPath(root, inputPath);
}

function defaultStagingPath(context: vscode.ExtensionContext, structuredRoot: string): string {
  const workspaceFolder = workspaceFolderForPath(structuredRoot);
  const root = resolveSettingPath(settings().encodeStagingRoot, context, workspaceFolder);
  return path.join(root, sanitizePathSegment(path.basename(structuredRoot)));
}

async function pickTwinCatInput(defaultFolder?: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: defaultFolder ? vscode.Uri.file(defaultFolder) : undefined,
    filters: {
      "TwinCAT/blark supported": ["sln", "tsproj", "plcproj", "TcPOU", "TcGVL", "TcDUT", "TcIO", "TcTTO"],
    },
    title: "Select a TwinCAT project or source file to decode",
  });
  return picked?.[0]?.fsPath;
}

async function findTwinCatInputsInFolder(root: string, limit = 100): Promise<string[]> {
  const results: string[] = [];
  const ignoredDirectoryNames = new Set([".git", ".twincat-st", ".blark", "native", "node_modules", "build", "dist", "out"]);

  async function walk(directory: string): Promise<void> {
    if (results.length >= limit) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          await walk(child);
        }
      } else if (entry.isFile() && isSupportedTwinCatInput(child)) {
        results.push(child);
      }
      if (results.length >= limit) {
        return;
      }
    }
  }

  await walk(root);
  return results.sort(compareTwinCatInputs);
}

async function pickTwinCatInputFromFolder(folder: string): Promise<string | undefined> {
  const candidates = await findTwinCatInputsInFolder(folder);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    const picked = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: path.relative(folder, candidate),
        description: candidate,
        fsPath: candidate,
      })),
      {
        title: "Select a TwinCAT project or source file to decode",
        placeHolder: "Prefer the .sln file when decoding a full TwinCAT project.",
      },
    );
    return picked?.fsPath;
  }
  return pickTwinCatInput(folder);
}

async function resolveDecodeInput(uri?: vscode.Uri): Promise<string | undefined> {
  const selectedPath = uriToFsPath(uri);
  if (!selectedPath) {
    const picked = await pickTwinCatInput();
    if (!picked) {
      return undefined;
    }
    const stat = await fs.stat(picked);
    if (stat.isDirectory()) {
      return pickTwinCatInputFromFolder(picked);
    }
    return picked;
  }
  const stat = await fs.stat(selectedPath);
  if (stat.isDirectory()) {
    return pickTwinCatInputFromFolder(selectedPath);
  }
  return selectedPath;
}

async function defaultDialogFolderFromUri(uri?: vscode.Uri): Promise<string | undefined> {
  const selectedPath = uriToFsPath(uri);
  if (!selectedPath) {
    return workspaceFolderForPath();
  }
  try {
    const stat = await fs.stat(selectedPath);
    return stat.isDirectory() ? selectedPath : path.dirname(selectedPath);
  } catch {
    return path.dirname(selectedPath);
  }
}

async function resolveInputFromStandardDialog(uri?: vscode.Uri): Promise<string | undefined> {
  const selected = await pickTwinCatInput(await defaultDialogFolderFromUri(uri));
  if (!selected) {
    return undefined;
  }
  const stat = await fs.stat(selected);
  if (stat.isDirectory()) {
    return pickTwinCatInputFromFolder(selected);
  }
  return selected;
}

async function findLikelyNativeRoot(inputPath: string): Promise<string> {
  let current = path.dirname(path.resolve(inputPath));
  while (true) {
    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".sln")) {
        return current;
      }
    } catch {
      return path.dirname(path.resolve(inputPath));
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.dirname(path.resolve(inputPath));
    }
    current = parent;
  }
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

async function resolveSafeDecodeOutputPath(inputPath: string, requestedOutputPath: string): Promise<string | undefined> {
  let outputPath = path.resolve(requestedOutputPath);
  while (true) {
    const nativeRoot = await findLikelyNativeRoot(inputPath);
    if (!isSameOrInside(outputPath, nativeRoot)) {
      return outputPath;
    }

    const suggested = safeSuggestedDecodeOutputPath(inputPath, nativeRoot);
    const answer = await vscode.window.showWarningMessage(
      "The decode output folder is inside the TwinCAT project folder, so blark would copy the project into itself.",
      {
        modal: true,
        detail: `Selected output: ${outputPath}\nTwinCAT project folder: ${nativeRoot}\nSuggested output: ${suggested}`,
      },
      "Use Suggested Folder",
      "Choose Folder",
    );
    if (answer === "Use Suggested Folder") {
      outputPath = suggested;
      continue;
    }
    if (answer === "Choose Folder") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(path.dirname(nativeRoot)),
        title: "Choose decode output folder outside the TwinCAT project",
      });
      if (!picked?.[0]) {
        return undefined;
      }
      outputPath = picked[0].fsPath;
      continue;
    }
    return undefined;
  }
}

async function revealDecodedOutput(outputPath: string): Promise<void> {
  const srcRoot = path.join(outputPath, "src");
  if (!(await pathExists(srcRoot))) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const alreadyInWorkspace = workspaceFolders.some((folder) => isSameOrInside(srcRoot, folder.uri.fsPath));
  if (!alreadyInWorkspace) {
    vscode.workspace.updateWorkspaceFolders(workspaceFolders.length, 0, {
      uri: vscode.Uri.file(outputPath),
      name: `${path.basename(outputPath)} (blark ST)`,
    });
  }
  await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(srcRoot));
}

async function decodeInputPath(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  tree: NativeReadonlyTreeProvider,
  inputPath: string,
): Promise<void> {
  if (!isSupportedTwinCatInput(inputPath)) {
    throw new Error(`${inputPath} is not a supported TwinCAT/blark input file.`);
  }

  const defaultOutput = defaultDecodeOutputPath(context, inputPath);
  const requestedOutputPath = await vscode.window.showInputBox({
    title: "Decode TwinCAT project to Structured Text",
    prompt: "Structured output folder. It must be outside the TwinCAT project folder.",
    value: defaultOutput,
  });
  if (!requestedOutputPath) {
    return;
  }
  const outputPath = await resolveSafeDecodeOutputPath(inputPath, requestedOutputPath);
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
  await revealDecodedOutput(outputPath);
  vscode.window.showInformationMessage(`Decoded TwinCAT project to ${outputPath}. Edit ST files under src/.`);
}

async function decodeProject(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  tree: NativeReadonlyTreeProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const inputPath = await resolveDecodeInput(uri);
  if (!inputPath) {
    return;
  }
  await decodeInputPath(context, blark, tree, inputPath);
}

async function openProjectFrom(
  context: vscode.ExtensionContext,
  blark: BlarkProcess,
  tree: NativeReadonlyTreeProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const inputPath = await resolveInputFromStandardDialog(uri);
  if (!inputPath) {
    return;
  }
  await decodeInputPath(context, blark, tree, inputPath);
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

function decodedCommandTarget(uri?: vscode.Uri): string | undefined {
  return uriToFsPath(uri) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
}

async function promptForIdentifier(title: string, defaultValue: string, label = "Name"): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: `${label} for the new TwinCAT item.`,
    value: defaultValue,
    validateInput: (value) => validateDecodedIdentifier(value, label),
  });
}

async function openCreatedPath(createdPath?: string): Promise<void> {
  if (!createdPath) {
    return;
  }
  const uri = vscode.Uri.file(createdPath);
  try {
    const stat = await fs.stat(createdPath);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
  } catch {
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

function defaultProjectItemName(kind: ProjectItemKind): string {
  if (kind === "function") {
    return "F_NewFunction";
  }
  if (kind === "functionBlock") {
    return "FB_NewFunctionBlock";
  }
  if (kind === "dut") {
    return "ST_NewType";
  }
  return "I_NewInterface";
}

async function createDecodedFolderCommand(uri?: vscode.Uri): Promise<void> {
  const targetPath = decodedCommandTarget(uri);
  if (!targetPath) {
    throw new Error("Select a decoded blark project folder before creating a TwinCAT folder.");
  }
  const name = await vscode.window.showInputBox({
    title: "Create TwinCAT Folder",
    prompt: "Folder name to add to the decoded project and native PLC project.",
    value: "NewFolder",
    validateInput: validateDecodedFolderName,
  });
  if (!name) {
    return;
  }
  const created = await createDecodedFolder({ targetPath, name });
  await openCreatedPath(created.openPath);
  vscode.window.showInformationMessage(`Created TwinCAT folder ${name}.`);
}

async function createDecodedProjectItemCommand(
  kind: ProjectItemKind,
  functionBlockVariant: FunctionBlockVariant | undefined,
  uri?: vscode.Uri,
): Promise<void> {
  const targetPath = decodedCommandTarget(uri);
  if (!targetPath) {
    throw new Error("Select a decoded blark project folder before creating a TwinCAT item.");
  }

  let baseName: string | undefined;
  let implementedInterfaces: string[] | undefined;
  if (kind === "functionBlock" && functionBlockVariant === "derived") {
    baseName = await promptForIdentifier("Create Derived Function Block", "FB_Base", "Base function block");
    if (!baseName) {
      return;
    }
  }
  if (kind === "functionBlock" && functionBlockVariant === "implements") {
    const interfaces = await listProjectInterfaces(targetPath);
    if (interfaces.length === 0) {
      throw new Error("No interfaces were found in this decoded project.");
    }
    const picked = await vscode.window.showQuickPick(
      interfaces.map((interfaceName) => ({ label: interfaceName })),
      {
        canPickMany: true,
        title: "Select interfaces to implement",
        placeHolder: "The new function block will implement the selected project interface(s).",
      },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    implementedInterfaces = picked.map((item) => item.label);
  }

  const title =
    kind === "function"
      ? "Create Function"
      : kind === "functionBlock"
        ? "Create Function Block"
        : kind === "dut"
          ? "Create DUT"
          : "Create Interface";
  const name = await promptForIdentifier(title, defaultProjectItemName(kind));
  if (!name) {
    return;
  }

  const created = await createDecodedProjectItem({
    targetPath,
    name,
    kind,
    functionBlockVariant,
    baseName,
    implementedInterfaces,
  });
  await openCreatedPath(created.openPath);
  vscode.window.showInformationMessage(`Created TwinCAT ${title.replace("Create ", "").toLowerCase()} ${name}.`);
}

async function createDecodedMemberCommand(kind: MemberItemKind, uri?: vscode.Uri): Promise<void> {
  const targetPath = decodedCommandTarget(uri);
  if (!targetPath) {
    throw new Error("Select a decoded function block or interface before creating a member.");
  }
  const title = kind === "method" ? "Create Method" : "Create Property";
  const name = await promptForIdentifier(title, kind === "method" ? "NewMethod" : "NewProperty");
  if (!name) {
    return;
  }
  const created = await createDecodedMember({ targetPath, name, kind });
  await openCreatedPath(created.openPath);
  vscode.window.showInformationMessage(`Created TwinCAT ${kind} ${name}.`);
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
      "twincatBlark.openProjectFrom",
      handleCommandErrors((uri?: vscode.Uri) => openProjectFrom(context, blark, tree, uri)),
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
    vscode.commands.registerCommand(
      "twincatBlark.createFolder",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedFolderCommand(uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createFunction",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("function", undefined, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createFunctionBlock",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("functionBlock", "normal", uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createDerivedFunctionBlock",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("functionBlock", "derived", uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createAbstractFunctionBlock",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("functionBlock", "abstract", uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createImplementingFunctionBlock",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("functionBlock", "implements", uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createDut",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("dut", undefined, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createInterface",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedProjectItemCommand("interface", undefined, uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createMethod",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedMemberCommand("method", uri)),
    ),
    vscode.commands.registerCommand(
      "twincatBlark.createProperty",
      handleCommandErrors((uri?: vscode.Uri) => createDecodedMemberCommand("property", uri)),
    ),
    vscode.commands.registerCommand("twincatBlark.openNativeReadonly", handleCommandErrors(openNativeReadonly)),
    vscode.commands.registerCommand("twincatBlark.applyReadonlyExplorerGlobs", handleCommandErrors(applyReadonlyExplorerGlobs)),
    vscode.commands.registerCommand("twincatBlark.openOutput", () => output.show(true)),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context subscriptions.
}
