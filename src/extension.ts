import * as cp from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as fssync from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const MANIFEST_FILENAME = "blark_twincat.json";
const PROJECT_CONFIG_FILENAME = "blark.json";
const PROJECT_METADATA_DIRNAME = ".blark";
const PROJECT_MANIFEST_FILENAME = "manifest.json";
const STAGED_DIRNAME = ".vscodecat";
const STAGED_FILENAME = "staged-objects.json";
const STAGED_MEMBERS_FILENAME = "staged-members.json";
const NATIVE_SCHEME = "vscodecat-native";

type SourceKind =
    | "program"
    | "functionBlock"
    | "function"
    | "interface"
    | "dutStruct"
    | "dutEnum"
    | "gvl";

const SOURCE_KINDS: readonly SourceKind[] = [
    "program",
    "functionBlock",
    "function",
    "interface",
    "dutStruct",
    "dutEnum",
    "gvl",
];

interface ManifestItem {
    id?: string;
    identifier: string;
    nativeIdentifier?: string;
    object_identifier: string;
    objectId?: string;
    type: string;
    kind?: string;
    part?: string;
    grammar_rule: string;
    grammarRule?: string;
    source_path: string;
    nativePath?: string;
    st_path: string;
    path?: string;
    st_start_line?: number;
    st_end_line?: number;
    st_begin_marker?: string;
    st_end_marker?: string;
}

interface ManifestFile {
    format: string;
    version: number;
    native_root: string;
    nativeRoot?: string;
    st_root: string;
    source_root?: string;
    sourceRoot?: string;
    native_entry: string;
    nativeEntry?: string;
    input_path: string;
    items: ManifestItem[];
}

interface ProjectConfigFile {
    format: string;
    version: number;
    manifest?: string;
    sourceRoot?: string;
    nativeRoot?: string;
    nativeEntry?: string;
}

interface StagedObject {
    id: string;
    kind: SourceKind;
    name: string;
    sourcePath: string;
    stagedPath: string;
    createdAt: string;
}

interface StagedMethod {
    name: string;
    code: string;
}

interface StagedProperty {
    name: string;
    code: string;
}

interface StagedMember {
    id: string;
    kind: "property";
    parentObjectIdentifier: string;
    parentSourcePath: string;
    parentStPath: string;
    name: string;
    returnType: string;
    stPaths: {
        getDeclaration: string;
        getImplementation: string;
    };
    createdAt: string;
}

interface ActiveWorkspace {
    root: string;
    manifestPath: string;
    manifest: ManifestFile;
    nativeRoot: string;
    stRoot: string;
    nativeEntryPath: string;
    items: ManifestItem[];
    staged: StagedObject[];
    stagedMembers: StagedMember[];
}

interface BackendInvocation {
    command: string;
    argsPrefix: string[];
    label: string;
}

interface BackendResult {
    code: number;
    stdout: string;
    stderr: string;
    commandLine: string;
}

interface ChangedFile {
    relativePath: string;
    originalPath: string;
    previewPath: string;
    status: "added" | "modified" | "removed";
}

class UserFacingError extends Error {}

function posixPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function fromManifestPath(root: string, manifestPathValue: string): string {
    return path.join(root, ...manifestPathValue.split("/"));
}

function toManifestPath(value: string): string {
    return posixPath(value).replace(/^\/+/, "");
}

function pathInside(child: string, parent: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function isSourceKind(value: unknown): value is SourceKind {
    return typeof value === "string" && SOURCE_KINDS.includes(value as SourceKind);
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function isNonEmptyDirectory(dirPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
            return true;
        }
        const entries = await fs.readdir(dirPath);
        return entries.length > 0;
    } catch {
        return false;
    }
}

async function listFiles(root: string): Promise<string[]> {
    const result: string[] = [];

    async function walk(current: string): Promise<void> {
        let entries: fssync.Dirent[];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                result.push(fullPath);
            }
        }
    }

    await walk(root);
    return result;
}

async function readJson<T>(filePath: string): Promise<T> {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeDiagnostics(...maps: Array<Map<string, vscode.Diagnostic[]>>): Map<string, vscode.Diagnostic[]> {
    const merged = new Map<string, vscode.Diagnostic[]>();
    for (const map of maps) {
        for (const [filePath, diagnostics] of map) {
            merged.set(filePath, [...(merged.get(filePath) ?? []), ...diagnostics]);
        }
    }
    return merged;
}

function splitCommandLine(commandLine: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | undefined;

    for (let index = 0; index < commandLine.length; index += 1) {
        const char = commandLine[index];
        if ((char === "\"" || char === "'") && !quote) {
            quote = char;
            continue;
        }
        if (quote === char) {
            quote = undefined;
            continue;
        }
        if (!quote && /\s/.test(char)) {
            if (current) {
                parts.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }

    if (current) {
        parts.push(current);
    }

    return parts;
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, "\\\"")}"`;
}

function titleForKind(kind: SourceKind): string {
    switch (kind) {
        case "program":
            return "Program";
        case "functionBlock":
            return "Function Block";
        case "function":
            return "Function";
        case "interface":
            return "Interface";
        case "dutStruct":
            return "DUT Struct";
        case "dutEnum":
            return "DUT Enum";
        case "gvl":
            return "GVL";
    }
}

function extensionForKind(kind: SourceKind): string {
    switch (kind) {
        case "interface":
            return ".TcIO";
        case "dutStruct":
        case "dutEnum":
            return ".TcDUT";
        case "gvl":
            return ".TcGVL";
        case "program":
        case "functionBlock":
        case "function":
            return ".TcPOU";
    }
}

function defaultFolderForKind(kind: SourceKind): string {
    switch (kind) {
        case "interface":
            return "Interfaces";
        case "dutStruct":
        case "dutEnum":
            return "DUTs";
        case "gvl":
            return "GVLs";
        case "program":
        case "functionBlock":
        case "function":
            return "POUs";
    }
}

function validateIdentifier(value: string): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        return "Use a valid TwinCAT identifier: letters, numbers, underscores, and no leading digit.";
    }
    return undefined;
}

function normalizeManifest(manifest: ManifestFile, config?: ProjectConfigFile): ManifestFile {
    return {
        ...manifest,
        native_root: manifest.native_root ?? manifest.nativeRoot ?? config?.nativeRoot ?? "native",
        st_root: manifest.st_root ?? manifest.source_root ?? manifest.sourceRoot ?? config?.sourceRoot ?? "st",
        native_entry: manifest.native_entry ?? manifest.nativeEntry ?? config?.nativeEntry ?? "",
        input_path: manifest.input_path ?? "",
        items: (manifest.items ?? []).map(normalizeManifestItem),
    };
}

function normalizeManifestItem(item: ManifestItem): ManifestItem {
    const identifier = item.identifier ?? item.nativeIdentifier ?? item.objectId ?? item.id ?? "";
    const objectIdentifier = item.object_identifier ?? item.objectId ?? identifier.split("/")[0] ?? "";
    return {
        ...item,
        identifier,
        object_identifier: objectIdentifier,
        type: item.type ?? item.kind ?? "",
        grammar_rule: item.grammar_rule ?? item.grammarRule ?? "",
        source_path: item.source_path ?? item.nativePath ?? "",
        st_path: item.st_path ?? item.path ?? "",
    };
}

function itemKind(item: ManifestItem): string {
    return (item.kind ?? item.type ?? "").toLowerCase();
}

function itemPart(item: ManifestItem): string {
    return (item.part ?? item.identifier.split("/").at(-1) ?? "").toLowerCase();
}

function isPropertyContainerKind(kind: string): boolean {
    return kind === "function_block" || kind === "interface";
}

function isPropertyContainerItem(item: ManifestItem): boolean {
    return isPropertyContainerKind(itemKind(item)) && itemPart(item) === "declaration";
}

function propertyContainerForItem(active: ActiveWorkspace, item: ManifestItem): ManifestItem | undefined {
    if (isPropertyContainerItem(item)) {
        return item;
    }
    return active.items.find((candidate) => candidate.source_path === item.source_path && isPropertyContainerItem(candidate));
}

function itemCanCreateProperty(active: ActiveWorkspace, item: ManifestItem | undefined): boolean {
    return item ? Boolean(propertyContainerForItem(active, item)) : false;
}

function getWordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    return range ? document.getText(range) : undefined;
}

function primarySymbolName(item: ManifestItem): string {
    const objectName = item.object_identifier?.split(".").at(-1);
    if (objectName) {
        return objectName;
    }
    const identifier = (item.identifier ?? item.st_path ?? item.source_path ?? "PLC Object").split("/")[0];
    return identifier.split(".").at(-1) ?? identifier;
}

function symbolNamesForItem(item: ManifestItem): string[] {
    const names = new Set<string>();
    const identifier = item.identifier ? item.identifier.split("/")[0] : undefined;
    for (const value of [item.object_identifier, identifier, primarySymbolName(item)]) {
        if (!value) {
            continue;
        }
        names.add(value);
        for (const part of value.split(".")) {
            if (part) {
                names.add(part);
            }
        }
    }
    return [...names];
}

function symbolKindForItem(item: ManifestItem): vscode.SymbolKind {
    const value = `${item.type} ${item.grammar_rule}`.toLowerCase();
    if (value.includes("function_block")) {
        return vscode.SymbolKind.Class;
    }
    if (value.includes("function")) {
        return vscode.SymbolKind.Function;
    }
    if (value.includes("interface")) {
        return vscode.SymbolKind.Interface;
    }
    if (value.includes("global")) {
        return vscode.SymbolKind.Namespace;
    }
    if (value.includes("data_type") || value.includes("dut")) {
        return vscode.SymbolKind.Struct;
    }
    if (value.includes("method") || value.includes("action")) {
        return vscode.SymbolKind.Method;
    }
    if (value.includes("property")) {
        return vscode.SymbolKind.Property;
    }
    return vscode.SymbolKind.Class;
}

function completionKindForSymbol(kind: vscode.SymbolKind): vscode.CompletionItemKind {
    switch (kind) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Struct:
        case vscode.SymbolKind.Interface:
            return vscode.CompletionItemKind.Class;
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Method:
            return vscode.CompletionItemKind.Function;
        case vscode.SymbolKind.Property:
            return vscode.CompletionItemKind.Property;
        case vscode.SymbolKind.Namespace:
            return vscode.CompletionItemKind.Module;
        default:
            return vscode.CompletionItemKind.Reference;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class BlarkBackend {
    private invocation?: BackendInvocation;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {}

    public clearCache(): void {
        this.invocation = undefined;
    }

    public async run(args: string[], cwd?: string): Promise<BackendResult> {
        const invocation = await this.getInvocation();
        return this.spawn(invocation, args, cwd);
    }

    private async getInvocation(): Promise<BackendInvocation> {
        if (this.invocation) {
            return this.invocation;
        }

        const candidates = await this.getCandidates();
        const errors: string[] = [];
        for (const candidate of candidates) {
            const result = await this.spawn(candidate, ["--version"], this.context.extensionPath, false);
            if (result.code === 0) {
                this.invocation = candidate;
                this.output.appendLine(`Using backend: ${candidate.label}`);
                return candidate;
            }
            errors.push(`${candidate.label}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
        }

        throw new UserFacingError(
            `Could not find a working blark backend. Configure "vscodecat.blark.command".\n${errors.join("\n")}`,
        );
    }

    private async getCandidates(): Promise<BackendInvocation[]> {
        const configured = vscode.workspace.getConfiguration("vscodecat").get<string>("blark.command", "auto").trim();
        if (configured && configured !== "auto") {
            const parts = splitCommandLine(configured);
            if (parts.length === 0) {
                throw new UserFacingError("The configured VSCodeCat backend command is empty.");
            }
            return [{ command: parts[0], argsPrefix: parts.slice(1), label: configured }];
        }

        const candidates: BackendInvocation[] = [];
        const extensionExe = path.join(this.context.extensionPath, "dist", "blark.exe");
        if (await exists(extensionExe)) {
            candidates.push({ command: extensionExe, argsPrefix: [], label: extensionExe });
        }

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const workspaceExe = path.join(folder.uri.fsPath, "dist", "blark.exe");
            if (await exists(workspaceExe)) {
                candidates.push({ command: workspaceExe, argsPrefix: [], label: workspaceExe });
            }
        }

        candidates.push(
            { command: "blark", argsPrefix: [], label: "blark" },
            { command: "python", argsPrefix: ["-m", "blark"], label: "python -m blark" },
        );
        if (process.platform === "win32") {
            candidates.push({ command: "py", argsPrefix: ["-m", "blark"], label: "py -m blark" });
        }
        return candidates;
    }

    private spawn(
        invocation: BackendInvocation,
        args: string[],
        cwd = this.context.extensionPath,
        log = true,
    ): Promise<BackendResult> {
        const fullArgs = [...invocation.argsPrefix, ...args];
        const commandLine = [invocation.command, ...fullArgs].map(shellQuote).join(" ");
        if (log) {
            this.output.appendLine(`$ ${commandLine}`);
        }

        return new Promise((resolve) => {
            const env = {
                ...process.env,
                PYTHONPATH: [this.context.extensionPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
            };
            const child = cp.spawn(invocation.command, fullArgs, {
                cwd,
                env,
                windowsHide: true,
            });

            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            child.on("error", (error) => {
                resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, commandLine });
            });
            child.on("close", (code) => {
                const result = { code: code ?? -1, stdout, stderr, commandLine };
                if (log) {
                    if (stdout.trim()) {
                        this.output.appendLine(stdout.trimEnd());
                    }
                    if (stderr.trim()) {
                        this.output.appendLine(stderr.trimEnd());
                    }
                }
                resolve(result);
            });
        });
    }
}

async function runBackendProjectEncode(backend: BlarkBackend, active: ActiveWorkspace, outputPath: string, overwrite = false): Promise<BackendResult> {
    const inputRoot = active.stagedMembers.length > 0
        ? await createBackendInputSnapshot(active)
        : active.root;
    try {
        const args = ["project", "encode", inputRoot, outputPath];
        if (overwrite) {
            args.push("--overwrite");
        }
        return await backend.run(args, inputRoot);
    } finally {
        if (inputRoot !== active.root) {
            await fs.rm(inputRoot, { recursive: true, force: true });
        }
    }
}

async function createBackendInputSnapshot(active: ActiveWorkspace): Promise<string> {
    const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vscodecat-backend-input-"));
    const excluded = new Set(
        active.stagedMembers
            .flatMap(stagedMemberPaths)
            .map((memberPath) => path.resolve(fromManifestPath(active.root, memberPath)).toLowerCase()),
    );
    await fs.cp(active.root, snapshotRoot, {
        recursive: true,
        filter: (source) => !excluded.has(path.resolve(source).toLowerCase()),
    });
    return snapshotRoot;
}

class ManifestService {
    private readonly changeEmitter = new vscode.EventEmitter<ActiveWorkspace | undefined>();
    public readonly onDidChange = this.changeEmitter.event;
    public active?: ActiveWorkspace;
    private knownManifestPaths: string[] = [];

    public async refresh(preferredManifestPath?: string): Promise<ActiveWorkspace | undefined> {
        const manifests = await this.discoverManifestPaths(preferredManifestPath);
        this.knownManifestPaths = manifests;
        const selected = preferredManifestPath ?? this.active?.manifestPath ?? manifests[0];
        if (!selected) {
            this.active = undefined;
            await this.updateContexts();
            this.changeEmitter.fire(undefined);
            return undefined;
        }

        this.active = await this.loadWorkspace(selected);
        await this.updateContexts();
        this.changeEmitter.fire(this.active);
        return this.active;
    }

    public async select(): Promise<ActiveWorkspace | undefined> {
        const manifests = await this.discoverManifestPaths();
        this.knownManifestPaths = manifests;
        if (manifests.length === 0) {
            vscode.window.showInformationMessage("No VSCodeCat decoded workspaces were found.");
            return undefined;
        }
        const pick = await vscode.window.showQuickPick(
            manifests.map((manifestPath) => ({
                label: path.basename(path.dirname(manifestPath)),
                description: manifestPath,
                manifestPath,
            })),
            { placeHolder: "Select the active TwinCAT mapping" },
        );
        if (!pick) {
            return this.active;
        }
        return this.refresh(pick.manifestPath);
    }

    public async requireActive(): Promise<ActiveWorkspace> {
        if (this.active) {
            return this.active;
        }
        const active = await this.refresh();
        if (!active) {
            throw new UserFacingError("Open or decode a VSCodeCat workspace first.");
        }
        return active;
    }

    public async setActiveFromFolder(folderPath: string): Promise<ActiveWorkspace> {
        const manifestPath = await this.findManifestInFolder(folderPath);
        if (!manifestPath) {
            throw new UserFacingError(`No ${MANIFEST_FILENAME} or ${PROJECT_CONFIG_FILENAME} found in ${folderPath}.`);
        }
        return this.setActiveFromManifest(manifestPath);
    }

    public async setActiveFromManifest(manifestPath: string): Promise<ActiveWorkspace> {
        const active = await this.refresh(manifestPath);
        if (!active) {
            throw new UserFacingError(`Could not load ${manifestPath}.`);
        }
        return active;
    }

    public getKnownManifestPaths(): string[] {
        return this.knownManifestPaths;
    }

    public activeItemForFile(filePath: string): ManifestItem | undefined {
        const active = this.active;
        if (!active) {
            return undefined;
        }
        const resolved = path.resolve(filePath);
        return active.items.find((item) => path.resolve(fromManifestPath(active.root, item.st_path)) === resolved);
    }

    public stagedObjectForFile(filePath: string): StagedObject | undefined {
        const active = this.active;
        if (!active) {
            return undefined;
        }
        const resolved = path.resolve(filePath);
        return active.staged.find((item) => path.resolve(fromManifestPath(active.root, item.stagedPath)) === resolved);
    }

    public stagedMemberForFile(filePath: string): StagedMember | undefined {
        const active = this.active;
        if (!active) {
            return undefined;
        }
        const resolved = path.resolve(filePath);
        return active.stagedMembers.find((member) => stagedMemberPaths(member).some((memberPath) => path.resolve(fromManifestPath(active.root, memberPath)) === resolved));
    }

    public itemsForStFile(filePath: string): ManifestItem[] {
        const active = this.active;
        if (!active) {
            return [];
        }
        const resolved = path.resolve(filePath);
        return active.items.filter((item) => path.resolve(fromManifestPath(active.root, item.st_path)) === resolved);
    }

    public async saveStaged(active: ActiveWorkspace, staged: StagedObject[]): Promise<void> {
        const stagedPath = path.join(active.root, STAGED_DIRNAME, STAGED_FILENAME);
        await writeJson(stagedPath, staged);
        active.staged = staged;
        this.changeEmitter.fire(active);
    }

    public async saveStagedMembers(active: ActiveWorkspace, stagedMembers: StagedMember[]): Promise<void> {
        const stagedPath = path.join(active.root, STAGED_DIRNAME, STAGED_MEMBERS_FILENAME);
        await writeJson(stagedPath, stagedMembers);
        active.stagedMembers = stagedMembers;
        this.changeEmitter.fire(active);
    }

    private async discoverManifestPaths(preferredManifestPath?: string): Promise<string[]> {
        const paths: string[] = [];
        if (preferredManifestPath && await exists(preferredManifestPath)) {
            paths.push(path.resolve(preferredManifestPath));
        }

        const foundLegacy = await vscode.workspace.findFiles(`**/${MANIFEST_FILENAME}`, "**/{.git,node_modules,out,build,dist}/**", 50);
        const foundProjects = await vscode.workspace.findFiles(`**/${PROJECT_CONFIG_FILENAME}`, "**/{.git,node_modules,out,build,dist}/**", 50);
        paths.push(...foundLegacy.map((uri) => path.resolve(uri.fsPath)));
        paths.push(...foundProjects.map((uri) => path.resolve(uri.fsPath)));

        const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (editorPath) {
            const foundUp = await this.findManifestUpward(editorPath);
            if (foundUp) {
                paths.push(foundUp);
            }
        }

        return unique(paths);
    }

    public async findManifestForPath(startPath: string): Promise<string | undefined> {
        return this.findManifestUpward(startPath);
    }

    private async findManifestUpward(startPath: string): Promise<string | undefined> {
        let current = path.dirname(startPath);
        while (true) {
            const candidate = await this.findManifestInFolder(current);
            if (candidate) {
                return candidate;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }

    private async findManifestInFolder(folderPath: string): Promise<string | undefined> {
        const candidates = [
            path.join(folderPath, MANIFEST_FILENAME),
            path.join(folderPath, PROJECT_CONFIG_FILENAME),
            path.join(folderPath, PROJECT_METADATA_DIRNAME, PROJECT_MANIFEST_FILENAME),
        ];
        for (const candidate of candidates) {
            if (await exists(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    private async loadWorkspace(manifestPath: string): Promise<ActiveWorkspace> {
        const resolved = await this.resolveWorkspaceManifest(manifestPath);
        const root = resolved.root;
        const manifest = normalizeManifest(await readJson<ManifestFile>(resolved.manifestPath), resolved.config);
        const nativeRoot = fromManifestPath(root, manifest.native_root);
        const stRoot = fromManifestPath(root, manifest.st_root);
        const nativeEntryPath = fromManifestPath(nativeRoot, manifest.native_entry);
        const staged = await this.loadStaged(root);
        const stagedMembers = await this.loadStagedMembers(root);
        return {
            root,
            manifestPath: resolved.manifestPath,
            manifest,
            nativeRoot,
            stRoot,
            nativeEntryPath,
            items: manifest.items ?? [],
            staged,
            stagedMembers,
        };
    }

    private async resolveWorkspaceManifest(manifestPath: string): Promise<{ root: string; manifestPath: string; config?: ProjectConfigFile }> {
        const resolved = path.resolve(manifestPath);
        const filename = path.basename(resolved).toLowerCase();
        const parentName = path.basename(path.dirname(resolved)).toLowerCase();
        if (filename === PROJECT_CONFIG_FILENAME.toLowerCase()) {
            const root = path.dirname(resolved);
            const config = await readJson<ProjectConfigFile>(resolved);
            const projectManifest = path.resolve(root, ...(config.manifest ?? `${PROJECT_METADATA_DIRNAME}/${PROJECT_MANIFEST_FILENAME}`).split("/"));
            if (!(await exists(projectManifest))) {
                throw new UserFacingError(`No project manifest found at ${projectManifest}.`);
            }
            return { root, manifestPath: projectManifest, config };
        }

        if (filename === PROJECT_MANIFEST_FILENAME.toLowerCase() && parentName === PROJECT_METADATA_DIRNAME.toLowerCase()) {
            return { root: path.dirname(path.dirname(resolved)), manifestPath: resolved };
        }

        return { root: path.dirname(resolved), manifestPath: resolved };
    }

    private async loadStaged(root: string): Promise<StagedObject[]> {
        const stagedPath = path.join(root, STAGED_DIRNAME, STAGED_FILENAME);
        if (!(await exists(stagedPath))) {
            return [];
        }
        const content = await readJson<{ objects?: StagedObject[] } | StagedObject[]>(stagedPath);
        return Array.isArray(content) ? content : content.objects ?? [];
    }

    private async loadStagedMembers(root: string): Promise<StagedMember[]> {
        const stagedPath = path.join(root, STAGED_DIRNAME, STAGED_MEMBERS_FILENAME);
        if (!(await exists(stagedPath))) {
            return [];
        }
        const content = await readJson<{ members?: StagedMember[] } | StagedMember[]>(stagedPath);
        return Array.isArray(content) ? content : content.members ?? [];
    }

    private async updateContexts(): Promise<void> {
        await vscode.commands.executeCommand("setContext", "vscodecat.hasDecodedWorkspace", Boolean(this.active));
        await this.updateEditorContexts();
    }

    public async updateEditorContexts(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const isSt = editor?.document.languageId === "twincat-st" || editor?.document.uri.fsPath.toLowerCase().endsWith(".st");
        const activeItem = editor ? this.activeItemForFile(editor.document.uri.fsPath) : undefined;
        const staged = editor ? this.stagedObjectForFile(editor.document.uri.fsPath) : undefined;
        const stagedMember = editor ? this.stagedMemberForFile(editor.document.uri.fsPath) : undefined;
        const mapped = editor ? Boolean(activeItem || staged || stagedMember) : false;
        await vscode.commands.executeCommand("setContext", "vscodecat.activeStEditor", Boolean(isSt));
        await vscode.commands.executeCommand("setContext", "vscodecat.activeMappedSt", mapped);
        await vscode.commands.executeCommand("setContext", "vscodecat.activeStagedFunctionBlock", staged?.kind === "functionBlock");
        await vscode.commands.executeCommand("setContext", "vscodecat.activePropertyContainer", Boolean(this.active && itemCanCreateProperty(this.active, activeItem)));
    }
}

class NativeSnapshotProvider implements vscode.TextDocumentContentProvider {
    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        return fs.readFile(uri.fsPath, "utf8");
    }
}

class TreeNode extends vscode.TreeItem {
    public children: TreeNode[] = [];

    public constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly nodeKind: string,
        public readonly manifestItem?: ManifestItem,
        public readonly stagedObject?: StagedObject,
        public readonly changedFile?: ChangedFile,
        public readonly filePath?: string,
    ) {
        super(label, collapsibleState);
        this.contextValue = nodeKind;
    }
}

abstract class RefreshableTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    protected readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    public readonly onDidChangeTreeData = this.changeEmitter.event;

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    public abstract getChildren(element?: TreeNode): Promise<TreeNode[]>;
}

class ObjectTreeProvider extends RefreshableTreeProvider {
    public constructor(private readonly manifests: ManifestService) {
        super();
    }

    public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (element) {
            return element.children;
        }
        const active = this.manifests.active;
        if (!active) {
            return [];
        }

        const root = new Map<string, TreeNode>();
        const leavesByStPath = new Map<string, ManifestItem>();
        for (const item of active.items) {
            if (!leavesByStPath.has(item.st_path)) {
                leavesByStPath.set(item.st_path, item);
            }
        }

        for (const item of leavesByStPath.values()) {
            const rel = posixPath(path.relative(active.stRoot, fromManifestPath(active.root, item.st_path)));
            const parts = rel.split("/").filter(Boolean);
            const leafLabel = item.object_identifier || path.basename(parts.at(-1) ?? item.identifier, ".st");
            let level = root;
            let parentChildren: TreeNode[] | undefined;

            for (const part of parts.slice(0, -1)) {
                let folder = level.get(part);
                if (!folder) {
                    folder = new TreeNode(part, vscode.TreeItemCollapsibleState.Collapsed, "folder");
                    folder.iconPath = new vscode.ThemeIcon("folder");
                    level.set(part, folder);
                    parentChildren?.push(folder);
                }
                parentChildren = folder.children;
                const childMap = new Map(folder.children.map((child) => [String(child.label), child]));
                level = childMap;
            }

            const nodeKind = itemCanCreateProperty(active, item) ? "mappedPropertyContainerObject" : "mappedObject";
            const leaf = new TreeNode(leafLabel, vscode.TreeItemCollapsibleState.None, nodeKind, item, undefined, undefined, fromManifestPath(active.root, item.st_path));
            leaf.description = item.type;
            leaf.tooltip = `${item.identifier}\n${item.st_path}`;
            leaf.iconPath = new vscode.ThemeIcon("symbol-class");
            leaf.command = { command: "vscodecat.openObject", title: "Open PLC Object", arguments: [leaf] };
            if (parentChildren) {
                parentChildren.push(leaf);
            } else {
                root.set(leafLabel, leaf);
            }
        }

        if (active.staged.length > 0) {
            const stagedRoot = new TreeNode("Staged Objects", vscode.TreeItemCollapsibleState.Expanded, "folder");
            stagedRoot.iconPath = new vscode.ThemeIcon("add");
            for (const staged of active.staged) {
                const nodeKind = staged.kind === "functionBlock" ? "stagedFunctionBlockObject" : "stagedObject";
                const leaf = new TreeNode(staged.name, vscode.TreeItemCollapsibleState.None, nodeKind, undefined, staged, undefined, fromManifestPath(active.root, staged.stagedPath));
                leaf.description = titleForKind(staged.kind);
                leaf.tooltip = `${staged.sourcePath}\n${staged.stagedPath}`;
                leaf.iconPath = new vscode.ThemeIcon("new-file");
                leaf.command = { command: "vscodecat.openObject", title: "Open PLC Object", arguments: [leaf] };
                stagedRoot.children.push(leaf);
            }
            root.set("Staged Objects", stagedRoot);
        }

        return [...root.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
}

class MappingTreeProvider extends RefreshableTreeProvider {
    public constructor(private readonly manifests: ManifestService) {
        super();
    }

    public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (element) {
            return element.children;
        }
        const active = this.manifests.active;
        if (!active) {
            return [];
        }

        const nodes = active.items.map((item) => {
            const node = new TreeNode(item.identifier, vscode.TreeItemCollapsibleState.None, "mappingItem", item);
            node.description = item.source_path;
            node.tooltip = `ST: ${item.st_path}\nNative: ${item.source_path}\nRule: ${item.grammar_rule}`;
            node.iconPath = new vscode.ThemeIcon("link");
            return node;
        });

        for (const staged of active.staged) {
            const nodeKind = staged.kind === "functionBlock" ? "stagedFunctionBlockObject" : "stagedObject";
            const node = new TreeNode(staged.name, vscode.TreeItemCollapsibleState.None, nodeKind, undefined, staged);
            node.description = `staged -> ${staged.sourcePath}`;
            node.tooltip = `Staged ST: ${staged.stagedPath}\nNative output: ${staged.sourcePath}`;
            node.iconPath = new vscode.ThemeIcon("add");
            nodes.push(node);
        }

        return nodes;
    }
}

class DiagnosticsTreeProvider extends RefreshableTreeProvider {
    private diagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];

    public setDiagnostics(diagnostics: [vscode.Uri, vscode.Diagnostic[]][]): void {
        this.diagnostics = diagnostics;
        this.refresh();
    }

    public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (element) {
            return element.children;
        }
        const nodes: TreeNode[] = [];
        for (const [uri, diagnostics] of this.diagnostics) {
            for (const diagnostic of diagnostics) {
                const label = `${path.basename(uri.fsPath)}:${diagnostic.range.start.line + 1}`;
                const node = new TreeNode(label, vscode.TreeItemCollapsibleState.None, "diagnostic", undefined, undefined, undefined, uri.fsPath);
                node.description = diagnostic.message;
                node.tooltip = diagnostic.message;
                node.iconPath = new vscode.ThemeIcon(diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning");
                node.command = {
                    command: "vscode.open",
                    title: "Open Diagnostic",
                    arguments: [uri, { selection: diagnostic.range }],
                };
                nodes.push(node);
            }
        }
        return nodes;
    }
}

class DiffTreeProvider extends RefreshableTreeProvider {
    private changedFiles: ChangedFile[] = [];

    public setChangedFiles(changedFiles: ChangedFile[]): void {
        this.changedFiles = changedFiles;
        this.refresh();
    }

    public getChangedFiles(): ChangedFile[] {
        return this.changedFiles;
    }

    public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (element) {
            return element.children;
        }
        return this.changedFiles.map((changed) => {
            const node = new TreeNode(changed.relativePath, vscode.TreeItemCollapsibleState.None, "changedFile", undefined, undefined, changed);
            node.description = changed.status;
            node.tooltip = changed.previewPath;
            node.iconPath = new vscode.ThemeIcon(changed.status === "added" ? "diff-added" : changed.status === "removed" ? "diff-removed" : "diff-modified");
            node.command = { command: "vscodecat.diffCurrentObject", title: "Open Diff", arguments: [node] };
            return node;
        });
    }
}

class DiagnosticsManager {
    private readonly collection = vscode.languages.createDiagnosticCollection("VSCodeCat");

    public constructor(
        private readonly backend: BlarkBackend,
        private readonly manifests: ManifestService,
        private readonly tree: DiagnosticsTreeProvider,
        private readonly output: vscode.OutputChannel,
    ) {}

    public dispose(): void {
        this.collection.dispose();
    }

    public clear(): void {
        this.collection.clear();
        this.tree.setDiagnostics([]);
    }

    public async validateManifestOnly(active: ActiveWorkspace): Promise<boolean> {
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        const add = (filePath: string, message: string, line = 0): void => {
            const uriPath = path.resolve(filePath);
            const range = new vscode.Range(line, 0, line, 1);
            const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
            diagnostic.source = "VSCodeCat";
            diagnostics.set(uriPath, [...(diagnostics.get(uriPath) ?? []), diagnostic]);
        };

        if (active.manifest.format !== "blark.twincat.project") {
            add(active.manifestPath, `Unsupported manifest format: ${active.manifest.format}`);
        }
        if (!(await exists(active.nativeRoot))) {
            add(active.manifestPath, `Missing native root: ${active.manifest.native_root}`);
        }
        if (!(await exists(active.stRoot))) {
            add(active.manifestPath, `Missing ST root: ${active.manifest.st_root}`);
        }

        const declaredStPaths = new Set<string>();
        for (const item of active.items) {
            const stPath = fromManifestPath(active.root, item.st_path);
            const sourcePath = fromManifestPath(active.nativeRoot, item.source_path);
            declaredStPaths.add(path.resolve(stPath));

            if (!pathInside(stPath, active.stRoot)) {
                add(active.manifestPath, `ST path escapes st root: ${item.st_path}`);
            }
            if (!pathInside(sourcePath, active.nativeRoot)) {
                add(active.manifestPath, `Native source path escapes native root: ${item.source_path}`);
            }
            if (!(await exists(stPath))) {
                add(active.manifestPath, `Mapped ST file is missing: ${item.st_path}`);
            }
            if (!(await exists(sourcePath))) {
                add(active.manifestPath, `Mapped native source file is missing: ${item.source_path}`);
            }

            if (item.st_begin_marker || item.st_end_marker) {
                await this.validateMarkers(item, stPath, add);
            }
        }
        for (const member of active.stagedMembers) {
            for (const memberPath of stagedMemberPaths(member)) {
                declaredStPaths.add(path.resolve(fromManifestPath(active.root, memberPath)));
            }
        }

        if (await exists(active.stRoot)) {
            const actualStFiles = (await listFiles(active.stRoot)).filter((file) => file.toLowerCase().endsWith(".st"));
            for (const stFile of actualStFiles) {
                if (!declaredStPaths.has(path.resolve(stFile))) {
                    add(stFile, "This .st file is under st/ but is not declared in the TwinCAT mapping manifest.");
                }
            }
        }

        this.publish(diagnostics);
        return diagnostics.size === 0;
    }

    public async validateWorkspace(active: ActiveWorkspace): Promise<boolean> {
        if (!(await this.validateManifestOnly(active))) {
            return false;
        }
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vscodecat-validate-"));
        try {
            const result = await runBackendProjectEncode(this.backend, active, path.join(tempRoot, "native"));
            if (result.code === 0) {
                const stagedDiagnostics = mergeDiagnostics(
                    await this.validateStagedObjects(active),
                    await this.validateStagedMembers(active),
                );
                if (stagedDiagnostics.size > 0) {
                    this.publish(stagedDiagnostics);
                    return false;
                }
                this.clear();
                return true;
            }
            this.publishBackendFailure(active, result.stderr || result.stdout || "Backend validation failed.");
            return false;
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    }

    public async validateCurrent(document: vscode.TextDocument): Promise<boolean> {
        const active = this.manifests.active;
        if (active && pathInside(document.uri.fsPath, active.stRoot)) {
            return this.validateWorkspace(active);
        }

        const staged = this.manifests.stagedObjectForFile(document.uri.fsPath);
        if (staged) {
            return this.validateStandaloneFile(document.uri.fsPath);
        }

        return this.validateStandaloneFile(document.uri.fsPath);
    }

    public snapshot(): [vscode.Uri, vscode.Diagnostic[]][] {
        const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
        this.collection.forEach((uri, diagnostics) => entries.push([uri, [...diagnostics]]));
        return entries;
    }

    private async validateStandaloneFile(filePath: string): Promise<boolean> {
        const result = await this.backend.run(["parse", filePath], path.dirname(filePath));
        if (result.code === 0) {
            this.collection.delete(vscode.Uri.file(filePath));
            this.tree.setDiagnostics(this.snapshot());
            return true;
        }
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        const diagnostic = this.diagnosticFromMessage(result.stderr || result.stdout || "Parse failed.");
        diagnostics.set(path.resolve(filePath), [diagnostic]);
        this.publish(diagnostics);
        return false;
    }

    private async validateStagedObjects(active: ActiveWorkspace): Promise<Map<string, vscode.Diagnostic[]>> {
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        for (const staged of active.staged) {
            const stagedPath = fromManifestPath(active.root, staged.stagedPath);
            if (!(await exists(stagedPath))) {
                diagnostics.set(path.resolve(stagedPath), [this.diagnosticFromMessage(`Staged ST file is missing: ${staged.stagedPath}`)]);
                continue;
            }
            const result = await this.backend.run(["parse", stagedPath], path.dirname(stagedPath));
            if (result.code !== 0) {
                diagnostics.set(path.resolve(stagedPath), [this.diagnosticFromMessage(result.stderr || result.stdout || "Parse failed.")]);
            }
        }
        return diagnostics;
    }

    private async validateStagedMembers(active: ActiveWorkspace): Promise<Map<string, vscode.Diagnostic[]>> {
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        for (const member of active.stagedMembers) {
            let memberHasMissingFile = false;
            const parentSourcePath = fromManifestPath(active.nativeRoot, member.parentSourcePath);
            if (!(await exists(parentSourcePath))) {
                diagnostics.set(path.resolve(parentSourcePath), [this.diagnosticFromMessage(`Staged property parent native source is missing: ${member.parentSourcePath}`)]);
                memberHasMissingFile = true;
            }
            for (const memberPath of stagedMemberPaths(member)) {
                const filePath = fromManifestPath(active.root, memberPath);
                if (!(await exists(filePath))) {
                    diagnostics.set(path.resolve(filePath), [this.diagnosticFromMessage(`Staged property file is missing: ${memberPath}`)]);
                    memberHasMissingFile = true;
                }
            }
            if (memberHasMissingFile) {
                continue;
            }

            const declarationPath = fromManifestPath(active.root, member.stPaths.getDeclaration);
            const implementationPath = fromManifestPath(active.root, member.stPaths.getImplementation);
            const tempPath = path.join(os.tmpdir(), `vscodecat-property-${randomUUID()}.st`);
            try {
                const [declaration, implementation] = await Promise.all([
                    fs.readFile(declarationPath, "utf8"),
                    fs.readFile(implementationPath, "utf8"),
                ]);
                await fs.writeFile(tempPath, decodedPropertyValidationCode(declaration, implementation), "utf8");
                const result = await this.backend.run(["parse", tempPath], path.dirname(tempPath));
                if (result.code !== 0) {
                    diagnostics.set(path.resolve(declarationPath), [this.diagnosticFromMessage(result.stderr || result.stdout || "Parse failed.")]);
                }
            } finally {
                await fs.rm(tempPath, { force: true });
            }
        }
        return diagnostics;
    }

    private async validateMarkers(
        item: ManifestItem,
        stPath: string,
        add: (filePath: string, message: string, line?: number) => void,
    ): Promise<void> {
        if (!item.st_begin_marker || !item.st_end_marker) {
            add(stPath, `Incomplete marker pair for ${item.identifier}`);
            return;
        }
        let content = "";
        try {
            content = await fs.readFile(stPath, "utf8");
        } catch {
            return;
        }
        const lines = content.split(/\r?\n/);
        const begin = lines.map((line, index) => ({ line: line.trim(), index })).filter((entry) => entry.line === item.st_begin_marker);
        const end = lines.map((line, index) => ({ line: line.trim(), index })).filter((entry) => entry.line === item.st_end_marker);
        if (begin.length !== 1 || end.length !== 1) {
            add(stPath, `Expected exactly one section marker pair for ${item.identifier}.`);
            return;
        }
        if (end[0].index <= begin[0].index) {
            add(stPath, `End marker appears before begin marker for ${item.identifier}.`, begin[0].index);
        }
    }

    private publishBackendFailure(active: ActiveWorkspace, message: string): void {
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        const fileMatch = message.match(/([A-Za-z]:\\[^\r\n:]+|\/[^\r\n:]+\.st)/i);
        const target = fileMatch?.[1] && fssync.existsSync(fileMatch[1])
            ? fileMatch[1]
            : active.manifestPath;
        diagnostics.set(path.resolve(target), [this.diagnosticFromMessage(message)]);
        this.publish(diagnostics);
    }

    private diagnosticFromMessage(message: string): vscode.Diagnostic {
        const lineMatch = message.match(/line\s+(\d+)(?:\s+col(?:umn)?\s+(\d+))?/i);
        const line = Math.max((lineMatch ? Number(lineMatch[1]) : 1) - 1, 0);
        const column = Math.max((lineMatch?.[2] ? Number(lineMatch[2]) : 1) - 1, 0);
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, column, line, column + 1),
            message.trim(),
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "VSCodeCat";
        return diagnostic;
    }

    private publish(diagnostics: Map<string, vscode.Diagnostic[]>): void {
        this.collection.clear();
        const entries: [vscode.Uri, vscode.Diagnostic[]][] = [...diagnostics.entries()].map(([filePath, items]) => [vscode.Uri.file(filePath), items]);
        this.collection.set(entries);
        this.tree.setDiagnostics(entries);
    }
}

class StDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const symbols: vscode.DocumentSymbol[] = [];
        const patterns: Array<[RegExp, vscode.SymbolKind]> = [
            [/^\s*FUNCTION_BLOCK\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Class],
            [/^\s*PROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Module],
            [/^\s*FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Function],
            [/^\s*INTERFACE\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Interface],
            [/^\s*METHOD\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Method],
            [/^\s*PROPERTY\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Property],
            [/^\s*ACTION\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Method],
            [/^\s*TYPE\s+([A-Za-z_][A-Za-z0-9_]*)/i, vscode.SymbolKind.Struct],
            [/^\s*VAR_GLOBAL\b/i, vscode.SymbolKind.Namespace],
        ];

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
            const line = document.lineAt(lineNumber);
            for (const [pattern, kind] of patterns) {
                const match = line.text.match(pattern);
                if (!match) {
                    continue;
                }
                const label = match[1] ?? "VAR_GLOBAL";
                const range = new vscode.Range(lineNumber, line.firstNonWhitespaceCharacterIndex, lineNumber, line.text.length);
                symbols.push(new vscode.DocumentSymbol(label, "", kind, range, range));
                break;
            }
        }
        return symbols;
    }
}

class StWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    public constructor(private readonly manifests: ManifestService) {}

    public provideWorkspaceSymbols(query: string): vscode.ProviderResult<vscode.SymbolInformation[]> {
        const active = this.manifests.active;
        if (!active) {
            return [];
        }
        const lower = query.toLowerCase();
        return active.items
            .filter((item) => {
                const identifier = item.identifier ?? "";
                const objectIdentifier = item.object_identifier ?? "";
                return !query || identifier.toLowerCase().includes(lower) || objectIdentifier.toLowerCase().includes(lower);
            })
            .map((item) => {
                const uri = vscode.Uri.file(fromManifestPath(active.root, item.st_path));
                const line = Math.max((item.st_start_line ?? 1) - 1, 0);
                return new vscode.SymbolInformation(
                    item.identifier ?? primarySymbolName(item),
                    vscode.SymbolKind.Class,
                    item.source_path ?? "",
                    new vscode.Location(uri, new vscode.Position(line, 0)),
                );
            });
    }
}

const ST_KEYWORD_COMPLETIONS = [
    "ACTION",
    "CASE",
    "DO",
    "ELSE",
    "ELSIF",
    "END_ACTION",
    "END_CASE",
    "END_FOR",
    "END_FUNCTION",
    "END_FUNCTION_BLOCK",
    "END_IF",
    "END_INTERFACE",
    "END_METHOD",
    "END_PROGRAM",
    "END_PROPERTY",
    "END_REPEAT",
    "END_STRUCT",
    "END_TYPE",
    "END_VAR",
    "END_WHILE",
    "FOR",
    "FUNCTION",
    "FUNCTION_BLOCK",
    "IF",
    "INTERFACE",
    "METHOD",
    "PROGRAM",
    "PROPERTY",
    "REPEAT",
    "RETURN",
    "STRUCT",
    "THEN",
    "TYPE",
    "UNTIL",
    "VAR",
    "VAR_GLOBAL",
    "VAR_INPUT",
    "VAR_IN_OUT",
    "VAR_OUTPUT",
    "WHILE",
];

const ST_TYPE_COMPLETIONS = [
    "BOOL",
    "BYTE",
    "DATE",
    "DATE_AND_TIME",
    "DINT",
    "DWORD",
    "INT",
    "LINT",
    "LREAL",
    "LTIME",
    "REAL",
    "SINT",
    "STRING",
    "TIME",
    "UDINT",
    "UINT",
    "ULINT",
    "USINT",
    "WORD",
    "WSTRING",
];

class StManifestLanguageProvider implements vscode.HoverProvider, vscode.DefinitionProvider, vscode.CompletionItemProvider, vscode.ReferenceProvider {
    public constructor(private readonly manifests: ManifestService) {}

    public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const word = getWordAt(document, position);
        if (!word) {
            return undefined;
        }
        const entry = this.findManifestEntry(word);
        if (!entry) {
            return undefined;
        }
        const active = this.manifests.active!;
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.appendMarkdown(`**${primarySymbolName(entry)}**\n\n`);
        markdown.appendMarkdown(`\`${entry.type}\` from \`${entry.source_path}\`\n\n`);
        markdown.appendMarkdown(`ST: \`${entry.st_path}\``);
        return new vscode.Hover(markdown, document.getWordRangeAtPosition(position));
    }

    public provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
        const word = getWordAt(document, position);
        if (!word) {
            return undefined;
        }
        const entry = this.findManifestEntry(word);
        if (!entry || !this.manifests.active) {
            return undefined;
        }
        return this.locationForEntry(this.manifests.active, entry);
    }

    public provideCompletionItems(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();

        for (const keyword of ST_KEYWORD_COMPLETIONS) {
            const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
            item.detail = "TwinCAT Structured Text keyword";
            items.push(item);
        }

        for (const typeName of ST_TYPE_COMPLETIONS) {
            const item = new vscode.CompletionItem(typeName, vscode.CompletionItemKind.TypeParameter);
            item.detail = "TwinCAT Structured Text type";
            items.push(item);
        }

        const active = this.manifests.active;
        if (!active) {
            return items;
        }

        for (const entry of active.items) {
            const label = primarySymbolName(entry);
            if (seen.has(label.toLowerCase())) {
                continue;
            }
            seen.add(label.toLowerCase());
            const item = new vscode.CompletionItem(label, completionKindForSymbol(symbolKindForItem(entry)));
            item.detail = entry.type;
            item.documentation = new vscode.MarkdownString(`\`${entry.identifier}\`\n\nNative: \`${entry.source_path}\``);
            items.push(item);
        }

        for (const staged of active.staged) {
            if (seen.has(staged.name.toLowerCase())) {
                continue;
            }
            seen.add(staged.name.toLowerCase());
            const item = new vscode.CompletionItem(staged.name, vscode.CompletionItemKind.Class);
            item.detail = `Staged ${titleForKind(staged.kind)}`;
            item.documentation = new vscode.MarkdownString(`Will be materialized as \`${staged.sourcePath}\`.`);
            items.push(item);
        }

        return items;
    }

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        _token: vscode.CancellationToken,
    ): Promise<vscode.Location[]> {
        const active = this.manifests.active;
        const word = getWordAt(document, position);
        if (!active || !word) {
            return [];
        }

        const files = unique([
            ...active.items.map((item) => fromManifestPath(active.root, item.st_path)),
            ...active.staged.map((item) => fromManifestPath(active.root, item.stagedPath)),
        ]);
        const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");
        const locations: vscode.Location[] = [];

        for (const file of files) {
            let text = "";
            try {
                text = await fs.readFile(file, "utf8");
            } catch {
                continue;
            }
            const lines = text.split(/\r?\n/);
            for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
                pattern.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(lines[lineNumber])) !== null) {
                    locations.push(new vscode.Location(
                        vscode.Uri.file(file),
                        new vscode.Range(lineNumber, match.index, lineNumber, match.index + word.length),
                    ));
                }
            }
        }

        return locations;
    }

    private findManifestEntry(word: string): ManifestItem | undefined {
        const active = this.manifests.active;
        if (!active) {
            return undefined;
        }
        const lower = word.toLowerCase();
        return active.items.find((entry) => symbolNamesForItem(entry).some((name) => name.toLowerCase() === lower));
    }

    private locationForEntry(active: ActiveWorkspace, entry: ManifestItem): vscode.Location {
        const uri = vscode.Uri.file(fromManifestPath(active.root, entry.st_path));
        const line = Math.max((entry.st_start_line ?? 1) - 1, 0);
        return new vscode.Location(uri, new vscode.Position(line, 0));
    }
}

class StFormattingProvider implements vscode.DocumentFormattingEditProvider {
    public constructor(private readonly backend: BlarkBackend) {}

    public async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
        if (document.getText().includes("// blark:begin")) {
            return [];
        }
        const result = await this.backend.run(["format", document.uri.fsPath], path.dirname(document.uri.fsPath));
        if (result.code !== 0 || !result.stdout) {
            return [];
        }
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.lineAt(document.lineCount - 1).range.end,
        );
        return [vscode.TextEdit.replace(fullRange, result.stdout.trimEnd())];
    }
}

class StCodeActionProvider implements vscode.CodeActionProvider {
    public provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const vscodecatDiagnostics = context.diagnostics.filter((diagnostic) => diagnostic.source === "VSCodeCat");
        if (vscodecatDiagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        if (vscodecatDiagnostics.some((diagnostic) => /marker|section marker/i.test(diagnostic.message))) {
            const repair = new vscode.CodeAction("Repair Section Markers", vscode.CodeActionKind.QuickFix);
            repair.command = {
                command: "vscodecat.repairSectionMarkers",
                title: "Repair Section Markers",
                arguments: [document.uri],
            };
            repair.diagnostics = vscodecatDiagnostics;
            repair.isPreferred = true;
            actions.push(repair);
        }

        for (const action of [
            ["Validate ST Workspace", "vscodecat.validateWorkspace"],
            ["Refresh TwinCAT Mapping", "vscodecat.refreshManifest"],
            ["Open TwinCAT Mapping Manifest", "vscodecat.openManifestJson"],
            ["Show VSCodeCat Backend Log", "vscodecat.showBackendLog"],
        ] as const) {
            const quickFix = new vscode.CodeAction(action[0], vscode.CodeActionKind.QuickFix);
            quickFix.command = {
                command: action[1],
                title: action[0],
                arguments: [document.uri],
            };
            actions.push(quickFix);
        }

        return actions;
    }
}

class ExtensionController {
    private readonly output = vscode.window.createOutputChannel("VSCodeCat");
    private readonly manifests = new ManifestService();
    private readonly backend: BlarkBackend;
    private readonly diagnosticsTree = new DiagnosticsTreeProvider();
    private readonly diffTree = new DiffTreeProvider();
    private readonly diagnostics: DiagnosticsManager;
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private readonly markerDecoration = vscode.window.createTextEditorDecorationType({
        opacity: "0.65",
        fontStyle: "italic",
        color: new vscode.ThemeColor("descriptionForeground"),
    });
    private markerDecorationsVisible = true;
    private previewPath?: string;
    private encodedOutputPath?: string;

    public constructor(private readonly context: vscode.ExtensionContext) {
        this.backend = new BlarkBackend(context, this.output);
        this.diagnostics = new DiagnosticsManager(this.backend, this.manifests, this.diagnosticsTree, this.output);
    }

    public async activate(): Promise<void> {
        const objectTree = new ObjectTreeProvider(this.manifests);
        const mappingTree = new MappingTreeProvider(this.manifests);
        const stManifestLanguage = new StManifestLanguageProvider(this.manifests);

        this.context.subscriptions.push(
            this.output,
            this.statusBar,
            this.markerDecoration,
            this.diagnostics,
            vscode.window.registerTreeDataProvider("vscodecat.objects", objectTree),
            vscode.window.registerTreeDataProvider("vscodecat.mapping", mappingTree),
            vscode.window.registerTreeDataProvider("vscodecat.diagnostics", this.diagnosticsTree),
            vscode.window.registerTreeDataProvider("vscodecat.diff", this.diffTree),
            vscode.workspace.registerTextDocumentContentProvider(NATIVE_SCHEME, new NativeSnapshotProvider()),
            vscode.languages.registerDocumentSymbolProvider({ language: "twincat-st" }, new StDocumentSymbolProvider()),
            vscode.languages.registerWorkspaceSymbolProvider(new StWorkspaceSymbolProvider(this.manifests)),
            vscode.languages.registerHoverProvider({ language: "twincat-st" }, stManifestLanguage),
            vscode.languages.registerDefinitionProvider({ language: "twincat-st" }, stManifestLanguage),
            vscode.languages.registerReferenceProvider({ language: "twincat-st" }, stManifestLanguage),
            vscode.languages.registerCompletionItemProvider({ language: "twincat-st" }, stManifestLanguage, ".", "_"),
            vscode.languages.registerDocumentFormattingEditProvider({ language: "twincat-st" }, new StFormattingProvider(this.backend)),
            vscode.languages.registerCodeActionsProvider(
                { language: "twincat-st" },
                new StCodeActionProvider(),
                { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
            ),
            vscode.workspace.onDidSaveTextDocument((document) => this.onDidSave(document)),
            vscode.window.onDidChangeActiveTextEditor(() => this.onActiveEditorChanged()),
            this.manifests.onDidChange(() => {
                objectTree.refresh();
                mappingTree.refresh();
                this.updateStatusBar();
                void this.manifests.updateEditorContexts();
            }),
        );

        this.registerCommands();
        await this.manifests.refresh();
        this.updateStatusBar();
        await this.onActiveEditorChanged();
    }

    private registerCommands(): void {
        const command = (id: string, callback: (...args: any[]) => Promise<unknown> | unknown): void => {
            this.context.subscriptions.push(vscode.commands.registerCommand(id, (...args: any[]) => this.safeRun(callback, args)));
        };

        command("vscodecat.decodeProject", (uri?: vscode.Uri) => this.decodeProject(uri));
        command("vscodecat.openDecodedWorkspace", (uri?: vscode.Uri) => this.openDecodedWorkspace(uri));
        command("vscodecat.refreshManifest", (uri?: vscode.Uri) => this.refreshManifest(uri));
        command("vscodecat.selectActiveWorkspace", () => this.manifests.select());
        command("vscodecat.encodeProject", (uri?: vscode.Uri) => this.encodeProject(uri));
        command("vscodecat.configureBackend", () => this.configureBackend());
        command("vscodecat.formatCurrentFile", () => this.formatCurrentFile());
        command("vscodecat.formatWorkspace", () => this.planned("Workspace formatting for combined decoded ST files needs section-aware backend formatting."));
        command("vscodecat.showCurrentObjectSummary", (target?: TreeNode | vscode.Uri) => this.showCurrentObjectSummary(target));
        command("vscodecat.copyObjectName", (node?: TreeNode) => this.copyObjectName(node));
        command("vscodecat.toggleSectionMarkerDecorations", () => this.toggleSectionMarkerDecorations());
        command("vscodecat.newPlcObject", (kind?: unknown) => this.newPlcObject(kind));
        command("vscodecat.newFunctionBlock", () => this.newPlcObject("functionBlock"));
        command("vscodecat.newProgram", () => this.newPlcObject("program"));
        command("vscodecat.newFunction", () => this.newPlcObject("function"));
        command("vscodecat.newInterface", () => this.newPlcObject("interface"));
        command("vscodecat.newDut", () => this.newPlcObject("dutStruct"));
        command("vscodecat.newGvl", () => this.newPlcObject("gvl"));
        command("vscodecat.newMethod", () => this.planned("Add METHOD blocks directly in a staged function block .st file. Command-driven method creation is planned."));
        command("vscodecat.newProperty", (target?: TreeNode | vscode.Uri) => this.newProperty(target));
        command("vscodecat.newAction", () => this.planned("Action staging is planned after backend support for adding child members."));
        command("vscodecat.openObject", (node?: TreeNode) => this.openObject(node));
        command("vscodecat.revealObjectInExplorer", (node?: TreeNode) => this.revealObjectInExplorer(node));
        command("vscodecat.openNativeSource", (node?: TreeNode) => this.openNativeSource(node));
        command("vscodecat.searchPlcSymbols", () => this.openObject());
        command("vscodecat.openContainingObject", () => this.openObject());
        command("vscodecat.validateCurrentFile", (uri?: vscode.Uri) => this.validateCurrentFile(uri));
        command("vscodecat.validateWorkspace", (uri?: vscode.Uri) => this.validateWorkspaceCommand(uri));
        command("vscodecat.validateManifest", (uri?: vscode.Uri) => this.validateManifestCommand(uri));
        command("vscodecat.explainDiagnostic", () => this.explainDiagnostic());
        command("vscodecat.clearDiagnostics", () => this.diagnostics.clear());
        command("vscodecat.repairSectionMarkers", (uri?: vscode.Uri) => this.repairSectionMarkers(uri));
        command("vscodecat.previewOutputDiff", (uri?: vscode.Uri) => this.previewOutputDiff(uri));
        command("vscodecat.diffCurrentObject", (node?: TreeNode) => this.diffCurrentObject(node));
        command("vscodecat.showChangedObjects", () => this.showChangedObjects());
        command("vscodecat.openPreviewFolder", () => this.openPreviewFolder());
        command("vscodecat.discardPreview", () => this.discardPreview());
        command("vscodecat.renameObject", () => this.planned("Object rename needs semantic reference updates and backend-native project edits."));
        command("vscodecat.moveObject", () => this.planned("Object moves need manifest and native project path updates."));
        command("vscodecat.renameSymbol", () => this.planned("Semantic rename needs a full symbol index."));
        command("vscodecat.extractMethod", () => this.planned("Extract method/action needs AST-safe rewrite support."));
        command("vscodecat.sortDeclarations", () => this.planned("Declaration sorting needs policy controls and backend rewrite support."));
        command("vscodecat.openInTwinCAT", () => this.openInTwinCAT());
        command("vscodecat.locateTwinCATXae", () => this.locateTwinCATXae());
        command("vscodecat.openEncodedOutput", () => this.openEncodedOutput());
        command("vscodecat.buildWithTwinCAT", () => this.planned("TwinCAT build automation is intentionally deferred beyond the MVP."));
        command("vscodecat.showBackendVersion", () => this.showBackendVersion());
        command("vscodecat.showBackendLog", () => this.output.show());
        command("vscodecat.openManifestJson", () => this.openManifestJson());
        command("vscodecat.exportSupportBundle", () => this.exportSupportBundle());
        command("vscodecat.runBackendSelfTest", () => this.runBackendSelfTest());
    }

    private async safeRun(callback: (...args: unknown[]) => Promise<unknown> | unknown, args: unknown[]): Promise<void> {
        try {
            await callback(...args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(message);
            if (error instanceof UserFacingError) {
                vscode.window.showWarningMessage(message);
            } else {
                vscode.window.showErrorMessage(message);
            }
        }
    }

    private async decodeProject(uri?: vscode.Uri): Promise<void> {
        const inputPath = uri?.fsPath ?? await this.pickNativeInput();
        if (!inputPath) {
            return;
        }

        const defaultOutput = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}${this.config("decode.outputFolderSuffix", "_vscodecat")}`);
        const outputPath = await vscode.window.showInputBox({
            title: "Decoded ST output folder",
            value: defaultOutput,
            prompt: "Choose a folder outside the native TwinCAT project tree.",
        });
        if (!outputPath) {
            return;
        }

        const args = ["project", "decode", inputPath, outputPath];
        if (await isNonEmptyDirectory(outputPath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `${outputPath} already exists and is not empty.`,
                { modal: true },
                "Replace decoded folder",
            );
            if (overwrite !== "Replace decoded folder") {
                return;
            }
            args.push("--overwrite");
        }

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Decoding TwinCAT project", cancellable: false }, async () => {
            const result = await this.backend.run(args, path.dirname(inputPath));
            if (result.code !== 0) {
                throw new UserFacingError(result.stderr || result.stdout || "Decode failed.");
            }
        });

        await this.manifests.setActiveFromFolder(outputPath);
        const openChoice = await vscode.window.showInformationMessage(
            "TwinCAT project decoded to editable ST.",
            "Open Workspace",
            "Open in New Window",
            "Stay Here",
        );
        if (openChoice === "Open Workspace" || openChoice === "Open in New Window") {
            await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(outputPath), openChoice === "Open in New Window");
        }
    }

    private async pickNativeInput(): Promise<string | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                "TwinCAT projects and sources": ["sln", "tsproj", "plcproj", "TcPOU", "TcGVL", "TcDUT", "TcIO", "TcTTO"],
            },
        });
        return picked?.[0]?.fsPath;
    }

    private async activateWorkspaceForResource(uri?: vscode.Uri): Promise<ActiveWorkspace | undefined> {
        if (!uri || uri.scheme !== "file") {
            return this.manifests.active;
        }

        const resourcePath = uri.fsPath;
        if (path.basename(resourcePath).toLowerCase() === MANIFEST_FILENAME.toLowerCase()) {
            return this.manifests.setActiveFromManifest(resourcePath);
        }

        const manifestPath = await this.manifests.findManifestForPath(resourcePath);
        if (manifestPath) {
            return this.manifests.setActiveFromManifest(manifestPath);
        }

        return this.manifests.active;
    }

    private async refreshManifest(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri);
        await this.manifests.refresh(active?.manifestPath);
    }

    private async openDecodedWorkspace(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri);
        const folder = active
            ? vscode.Uri.file(active.root)
            : (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0];
        if (!folder) {
            return;
        }
        await this.manifests.setActiveFromFolder(folder.fsPath);
        const newWindow = this.config("openDecodedWorkspaceInNewWindow", false);
        await vscode.commands.executeCommand("vscode.openFolder", folder, newWindow);
    }

    private async encodeProject(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri) ?? await this.manifests.requireActive();
        if (!(await this.diagnostics.validateWorkspace(active))) {
            throw new UserFacingError("Validation failed. Fix diagnostics before encoding.");
        }

        if (!this.previewPath) {
            const choice = await vscode.window.showWarningMessage(
                "No native output preview has been generated for the current session.",
                { modal: true },
                "Preview First",
                "Encode Anyway",
            );
            if (choice === "Preview First") {
                await this.previewOutputDiff(uri);
            } else if (choice !== "Encode Anyway") {
                return;
            }
        }

        const defaultOutput = `${active.root}${this.config("encode.outputFolderSuffix", "_twincat_out")}`;
        const outputPath = await vscode.window.showInputBox({
            title: "Native TwinCAT output folder",
            value: defaultOutput,
            prompt: "VSCodeCat writes to a separate output folder by default.",
        });
        if (!outputPath) {
            return;
        }

        let overwrite = false;
        if (await isNonEmptyDirectory(outputPath)) {
            const overwriteChoice = await vscode.window.showWarningMessage(
                `${outputPath} already exists and is not empty.`,
                { modal: true },
                "Replace output folder",
            );
            if (overwriteChoice !== "Replace output folder") {
                return;
            }
            overwrite = true;
        }

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Encoding TwinCAT native output", cancellable: false }, async () => {
            const result = await runBackendProjectEncode(this.backend, active, outputPath, overwrite);
            if (result.code !== 0) {
                throw new UserFacingError(result.stderr || result.stdout || "Encode failed.");
            }
            await this.materializeStagedObjects(active, outputPath);
            await this.materializeStagedMembers(active, outputPath);
        });

        this.encodedOutputPath = outputPath;
        const choice = await vscode.window.showInformationMessage("TwinCAT native output encoded.", "Open Folder", "Open in TwinCAT");
        if (choice === "Open Folder") {
            await vscode.env.openExternal(vscode.Uri.file(outputPath));
        } else if (choice === "Open in TwinCAT") {
            await this.openInTwinCAT();
        }
    }

    private async configureBackend(): Promise<void> {
        const configuration = vscode.workspace.getConfiguration("vscodecat");
        const current = configuration.get<string>("blark.command", "auto");
        const value = await vscode.window.showInputBox({
            title: "VSCodeCat backend command",
            value: current,
            prompt: "Use auto, blark, python -m blark, or a full executable path.",
        });
        if (!value) {
            return;
        }
        await configuration.update("blark.command", value, vscode.ConfigurationTarget.Global);
        this.backend.clearCache();
        await this.showBackendVersion();
    }

    private async formatCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new UserFacingError("Open a Structured Text file first.");
        }
        const document = editor.document;
        if (document.getText().includes("// blark:begin")) {
            throw new UserFacingError("The backend formatter cannot safely format combined decoded object files yet.");
        }
        const result = await this.backend.run(["format", document.uri.fsPath], path.dirname(document.uri.fsPath));
        if (result.code !== 0) {
            throw new UserFacingError(result.stderr || result.stdout || "Format failed.");
        }
        const tempPath = path.join(os.tmpdir(), `vscodecat-format-${Date.now()}.st`);
        await fs.writeFile(tempPath, result.stdout, "utf8");
        await vscode.commands.executeCommand(
            "vscode.diff",
            document.uri,
            vscode.Uri.file(tempPath),
            `Formatted preview: ${path.basename(document.uri.fsPath)}`,
        );
        const apply = await vscode.window.showInformationMessage("Apply formatted output to the current file?", "Apply", "Cancel");
        if (apply !== "Apply") {
            return;
        }
        const fullRange = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, result.stdout.trimEnd());
        await vscode.workspace.applyEdit(edit);
        await document.save();
    }

    private async showCurrentObjectSummary(target?: TreeNode | vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(target instanceof vscode.Uri ? target : undefined) ?? await this.manifests.requireActive();
        const item = target instanceof TreeNode ? target.manifestItem : this.manifests.activeItemForFile(target?.fsPath ?? "") ?? this.currentManifestItem();
        const staged = target instanceof TreeNode ? target.stagedObject : this.manifests.stagedObjectForFile(target?.fsPath ?? "") ?? this.currentStagedObject();
        if (!item && !staged) {
            throw new UserFacingError("No mapped or staged PLC object is active.");
        }

        const content = item
            ? this.summaryForManifestItem(active, item)
            : this.summaryForStagedObject(staged!);
        const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    private summaryForManifestItem(active: ActiveWorkspace, item: ManifestItem): string {
        const related = active.items.filter((candidate) => candidate.st_path === item.st_path);
        return [
            `# ${item.object_identifier || item.identifier}`,
            "",
            `- ST file: \`${item.st_path}\``,
            `- Native source: \`${item.source_path}\``,
            `- Type: \`${item.type}\``,
            `- Grammar rule: \`${item.grammar_rule}\``,
            "",
            "## Sections",
            "",
            ...related.map((section) => `- \`${section.identifier}\` (${section.grammar_rule})`),
            "",
        ].join("\n");
    }

    private summaryForStagedObject(staged: StagedObject): string {
        return [
            `# ${staged.name}`,
            "",
            `- Status: staged`,
            `- Kind: \`${titleForKind(staged.kind)}\``,
            `- ST file: \`${staged.stagedPath}\``,
            `- Native output: \`${staged.sourcePath}\``,
            "",
            "This object is materialized into native TwinCAT XML only during preview or encode.",
            "",
        ].join("\n");
    }

    private async copyObjectName(node?: TreeNode): Promise<void> {
        const name = node?.manifestItem?.identifier
            ?? node?.stagedObject?.name
            ?? this.currentManifestItem()?.identifier
            ?? this.currentStagedObject()?.name;
        if (!name) {
            throw new UserFacingError("No PLC object is selected or active.");
        }
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied ${name}`);
    }

    private toggleSectionMarkerDecorations(): void {
        this.markerDecorationsVisible = !this.markerDecorationsVisible;
        void this.updateMarkerDecorations(vscode.window.activeTextEditor);
    }

    private async newPlcObject(presetKind?: unknown): Promise<void> {
        const active = await this.manifests.requireActive();
        const kind = isSourceKind(presetKind) ? presetKind : await this.pickSourceKind();
        if (!kind) {
            return;
        }
        const name = await vscode.window.showInputBox({
            title: `New ${titleForKind(kind)}`,
            prompt: "PLC object name",
            validateInput: validateIdentifier,
        });
        if (!name) {
            return;
        }
        const placement = await this.pickPlacement(active, kind);
        if (!placement) {
            return;
        }

        const stagedPath = toManifestPath(path.join(STAGED_DIRNAME, "staged", `${name}.st`));
        const sourcePath = toManifestPath(path.posix.join(placement.sourceDir, `${name}${extensionForKind(kind)}`));
        const staged: StagedObject = {
            id: randomUUID(),
            kind,
            name,
            sourcePath,
            stagedPath,
            createdAt: new Date().toISOString(),
        };
        const stagedAbs = fromManifestPath(active.root, stagedPath);
        if (await exists(stagedAbs)) {
            throw new UserFacingError(`${stagedPath} already exists.`);
        }
        await fs.mkdir(path.dirname(stagedAbs), { recursive: true });
        await fs.writeFile(stagedAbs, templateForKind(kind, name), "utf8");
        await this.manifests.saveStaged(active, [...active.staged, staged]);
        await vscode.window.showTextDocument(vscode.Uri.file(stagedAbs));
        vscode.window.showInformationMessage(`${titleForKind(kind)} ${name} staged.`);
    }

    private async newProperty(target?: TreeNode | vscode.Uri): Promise<void> {
        const active = await this.manifests.requireActive();
        const staged = this.stagedObjectFromTarget(target);
        if (staged) {
            await this.newStagedProperty(active, staged);
            return;
        }

        const item = this.manifestItemFromTarget(target) ?? this.currentManifestItem();
        if (item) {
            await this.newDecodedProperty(active, item);
            return;
        }

        throw new UserFacingError("Open or select a Function Block or Interface before adding a property.");
    }

    private async newStagedProperty(active: ActiveWorkspace, staged: StagedObject): Promise<void> {
        if (!staged) {
            throw new UserFacingError("Open or select a staged Function Block before adding a property.");
        }
        if (staged.kind !== "functionBlock") {
            throw new UserFacingError("Properties can only be staged inside a Function Block.");
        }

        const stagedAbs = fromManifestPath(active.root, staged.stagedPath);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(stagedAbs));
        const existingMembers = stagedFunctionBlockMemberNames(document.getText());
        const name = await vscode.window.showInputBox({
            title: `New Property in ${staged.name}`,
            prompt: "Property name",
            validateInput: (value) => {
                const identifierError = validateIdentifier(value);
                if (identifierError) {
                    return identifierError;
                }
                return existingMembers.has(value.toLowerCase())
                    ? `${value} already exists in ${staged.name}.`
                    : undefined;
            },
        });
        if (!name) {
            return;
        }

        const returnType = await vscode.window.showInputBox({
            title: `New Property ${name}`,
            prompt: "Property return type",
            value: "BOOL",
            validateInput: (value) => value.trim() ? undefined : "Property return type is required.",
        });
        if (!returnType) {
            return;
        }

        await insertBlockBeforeEnd(document, "END_FUNCTION_BLOCK", propertyTemplate(name, returnType.trim()));
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Property ${name} staged in ${staged.name}.`);
    }

    private async newDecodedProperty(active: ActiveWorkspace, item: ManifestItem): Promise<void> {
        const parent = propertyContainerForItem(active, item);
        if (!parent) {
            throw new UserFacingError("Properties can only be created under a decoded Function Block or Interface.");
        }

        const parentDir = posixPath(path.posix.dirname(posixPath(parent.st_path)));
        if (path.posix.basename(parent.st_path).toLowerCase() !== "declaration.st") {
            throw new UserFacingError("This decoded object does not use the folder-per-object layout required for property staging.");
        }

        const existingMembers = decodedPropertyNames(active, parent);
        const name = await vscode.window.showInputBox({
            title: `New Property in ${parent.object_identifier}`,
            prompt: "Property name",
            validateInput: (value) => {
                const identifierError = validateIdentifier(value);
                if (identifierError) {
                    return identifierError;
                }
                return existingMembers.has(value.toLowerCase())
                    ? `${value} already exists in ${parent.object_identifier}.`
                    : undefined;
            },
        });
        if (!name) {
            return;
        }

        const returnType = await vscode.window.showInputBox({
            title: `New Property ${name}`,
            prompt: "Property return type",
            value: "BOOL",
            validateInput: (value) => value.trim() ? undefined : "Property return type is required.",
        });
        if (!returnType) {
            return;
        }

        const propertyRoot = toManifestPath(path.posix.join(parentDir, "properties", name));
        const getDeclaration = toManifestPath(path.posix.join(propertyRoot, "get", "declaration.st"));
        const getImplementation = toManifestPath(path.posix.join(propertyRoot, "get", "implementation.st"));
        const files = [
            [getDeclaration, decodedPropertyDeclarationTemplate(name, returnType.trim())],
            [getImplementation, decodedPropertyGetterImplementationTemplate(name, returnType.trim())],
        ] as const;
        for (const [manifestPathValue] of files) {
            if (await exists(fromManifestPath(active.root, manifestPathValue))) {
                throw new UserFacingError(`${manifestPathValue} already exists.`);
            }
        }

        for (const [manifestPathValue, content] of files) {
            const filePath = fromManifestPath(active.root, manifestPathValue);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, "utf8");
        }

        const member: StagedMember = {
            id: randomUUID(),
            kind: "property",
            parentObjectIdentifier: parent.object_identifier,
            parentSourcePath: parent.source_path,
            parentStPath: parentDir,
            name,
            returnType: returnType.trim(),
            stPaths: {
                getDeclaration,
                getImplementation,
            },
            createdAt: new Date().toISOString(),
        };
        await this.manifests.saveStagedMembers(active, [...active.stagedMembers, member]);
        await vscode.window.showTextDocument(vscode.Uri.file(fromManifestPath(active.root, getDeclaration)), { preview: false });
        vscode.window.showInformationMessage(`Property ${name} staged in ${parent.object_identifier}.`);
    }

    private stagedObjectFromTarget(target?: TreeNode | vscode.Uri): StagedObject | undefined {
        if (target instanceof TreeNode) {
            return target.stagedObject;
        }
        if (target instanceof vscode.Uri) {
            return this.manifests.stagedObjectForFile(target.fsPath);
        }
        return this.currentStagedObject();
    }

    private manifestItemFromTarget(target?: TreeNode | vscode.Uri): ManifestItem | undefined {
        if (target instanceof TreeNode) {
            return target.manifestItem;
        }
        if (target instanceof vscode.Uri) {
            return this.manifests.activeItemForFile(target.fsPath);
        }
        return undefined;
    }

    private async pickSourceKind(): Promise<SourceKind | undefined> {
        const picks: Array<vscode.QuickPickItem & { sourceKind: SourceKind }> = [
            { label: "Function Block", sourceKind: "functionBlock" },
            { label: "Program", sourceKind: "program" },
            { label: "Function", sourceKind: "function" },
            { label: "Interface", sourceKind: "interface" },
            { label: "DUT Struct", sourceKind: "dutStruct" },
            { label: "DUT Enum", sourceKind: "dutEnum" },
            { label: "GVL", sourceKind: "gvl" },
        ];
        return (await vscode.window.showQuickPick(picks, { placeHolder: "PLC object kind" }))?.sourceKind;
    }

    private async pickPlacement(active: ActiveWorkspace, kind: SourceKind): Promise<{ sourceDir: string } | undefined> {
        const ext = extensionForKind(kind).toLowerCase();
        const dirs = unique(
            active.items
                .map((item) => item.source_path)
                .filter((sourcePath): sourcePath is string => typeof sourcePath === "string" && sourcePath.toLowerCase().endsWith(ext))
                .map((sourcePath) => posixPath(path.posix.dirname(posixPath(sourcePath)))),
        );
        if (dirs.length === 0) {
            dirs.push(defaultFolderForKind(kind));
        }
        const pick = await vscode.window.showQuickPick(
            dirs.map((dir) => ({ label: dir, sourceDir: dir })),
            { placeHolder: "Native TwinCAT folder for the new object" },
        );
        return pick ? { sourceDir: pick.sourceDir } : undefined;
    }

    private async openObject(node?: TreeNode): Promise<void> {
        const active = await this.manifests.requireActive();
        const selected = node?.manifestItem ?? node?.stagedObject ? node : undefined;
        if (selected?.manifestItem) {
            await this.openManifestItem(active, selected.manifestItem);
            return;
        }
        if (selected?.stagedObject) {
            await vscode.window.showTextDocument(vscode.Uri.file(fromManifestPath(active.root, selected.stagedObject.stagedPath)));
            return;
        }

        const picks = [
            ...unique(active.items.map((item) => item.st_path)).map((stPath) => {
                const item = active.items.find((candidate) => candidate.st_path === stPath)!;
                return {
                    label: item.object_identifier || item.identifier,
                    description: item.st_path,
                    item,
                };
            }),
            ...active.staged.map((staged) => ({
                label: staged.name,
                description: `staged: ${staged.stagedPath}`,
                staged,
            })),
        ];
        const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Open PLC object" });
        if (!pick) {
            return;
        }
        if ("item" in pick) {
            await this.openManifestItem(active, pick.item);
        } else {
            await vscode.window.showTextDocument(vscode.Uri.file(fromManifestPath(active.root, pick.staged.stagedPath)));
        }
    }

    private async openManifestItem(active: ActiveWorkspace, item: ManifestItem): Promise<void> {
        const uri = vscode.Uri.file(fromManifestPath(active.root, item.st_path));
        const line = Math.max((item.st_start_line ?? 1) - 1, 0);
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) });
    }

    private async revealObjectInExplorer(node?: TreeNode): Promise<void> {
        const active = await this.manifests.requireActive();
        const filePath = node?.filePath
            ?? (node?.manifestItem ? fromManifestPath(active.root, node.manifestItem.st_path) : undefined)
            ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!filePath) {
            throw new UserFacingError("No PLC object file is active.");
        }
        await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(filePath));
    }

    private async openNativeSource(node?: TreeNode): Promise<void> {
        const active = await this.manifests.requireActive();
        const item = node?.manifestItem ?? this.currentManifestItem();
        if (!item) {
            throw new UserFacingError("No mapped PLC object is selected or active.");
        }
        const sourcePath = fromManifestPath(active.nativeRoot, item.source_path);
        const uri = vscode.Uri.file(sourcePath).with({ scheme: NATIVE_SCHEME });
        await vscode.window.showTextDocument(uri, { preview: true });
    }

    private async validateCurrentFile(uri?: vscode.Uri): Promise<void> {
        await this.activateWorkspaceForResource(uri);
        const document = uri
            ? await vscode.workspace.openTextDocument(uri)
            : vscode.window.activeTextEditor?.document;
        if (!document) {
            throw new UserFacingError("Open a Structured Text file first.");
        }
        const ok = await this.diagnostics.validateCurrent(document);
        vscode.window.showInformationMessage(ok ? "Current ST file is valid." : "Current ST file has diagnostics.");
    }

    private async validateWorkspaceCommand(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri) ?? await this.manifests.requireActive();
        const ok = await this.diagnostics.validateWorkspace(active);
        vscode.window.showInformationMessage(ok ? "ST workspace is valid." : "ST workspace has diagnostics.");
    }

    private async validateManifestCommand(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri) ?? await this.manifests.requireActive();
        const ok = await this.diagnostics.validateManifestOnly(active);
        vscode.window.showInformationMessage(ok ? "TwinCAT mapping manifest is valid." : "TwinCAT mapping manifest has diagnostics.");
    }

    private explainDiagnostic(): void {
        const diagnostics = this.diagnostics.snapshot().flatMap(([, items]) => items);
        const message = diagnostics[0]?.message ?? "No VSCodeCat diagnostics are currently active.";
        vscode.window.showInformationMessage(message, { modal: true });
    }

    private async repairSectionMarkers(uri?: vscode.Uri): Promise<void> {
        const targetUri = uri?.scheme === "file"
            ? uri
            : vscode.window.activeTextEditor?.document.uri;
        if (!targetUri || targetUri.scheme !== "file") {
            throw new UserFacingError("Open a mapped Structured Text file first.");
        }

        await this.activateWorkspaceForResource(targetUri) ?? await this.manifests.requireActive();
        const document = await vscode.workspace.openTextDocument(targetUri);
        const items = this.manifests.itemsForStFile(document.uri.fsPath)
            .filter((item) => item.st_begin_marker || item.st_end_marker);
        if (items.length === 0) {
            throw new UserFacingError("No manifest section markers are mapped to this ST file.");
        }

        const edit = new vscode.WorkspaceEdit();
        const warnings: string[] = [];
        let editCount = 0;
        const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const beginLineIndexFromManifest = (line: number | undefined): number | undefined => {
            if (!line || line < 1 || line > document.lineCount) {
                return undefined;
            }
            return line - 1;
        };
        const endLineIndexFromManifest = (line: number | undefined): number | undefined => {
            if (!line || line < 1) {
                return undefined;
            }
            return Math.min(line - 1, document.lineCount - 1);
        };

        for (const item of items) {
            const beginMarker = item.st_begin_marker;
            const endMarker = item.st_end_marker;
            if (!beginMarker || !endMarker) {
                warnings.push(`${item.identifier}: incomplete marker pair in manifest.`);
                continue;
            }

            const beginCount = this.countMarkerOccurrences(document, beginMarker);
            const endCount = this.countMarkerOccurrences(document, endMarker);
            if (beginCount > 1 || endCount > 1) {
                warnings.push(`${item.identifier}: duplicate markers need manual review.`);
                continue;
            }

            if (beginCount === 0) {
                const lineIndex = beginLineIndexFromManifest(item.st_start_line);
                if (lineIndex === undefined) {
                    warnings.push(`${item.identifier}: no usable begin marker line in manifest.`);
                } else {
                    edit.insert(document.uri, new vscode.Position(lineIndex, 0), `${beginMarker}${newline}`);
                    editCount += 1;
                }
            }

            if (endCount === 0) {
                const lineIndex = endLineIndexFromManifest(item.st_end_line);
                if (lineIndex === undefined) {
                    warnings.push(`${item.identifier}: no usable end marker line in manifest.`);
                } else {
                    const line = document.lineAt(lineIndex);
                    edit.insert(document.uri, line.range.end, `${newline}${endMarker}`);
                    editCount += 1;
                }
            }
        }

        if (editCount === 0) {
            const suffix = warnings.length > 0 ? ` ${warnings.slice(0, 3).join(" ")}` : "";
            vscode.window.showInformationMessage(`No missing section markers were repairable.${suffix}`);
            return;
        }

        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new UserFacingError("Could not apply section marker repairs.");
        }
        if (!(await document.save())) {
            throw new UserFacingError("Section markers were repaired, but the file could not be saved.");
        }

        await this.diagnostics.validateCurrent(document);
        await this.updateMarkerDecorations(vscode.window.activeTextEditor);
        const message = warnings.length > 0
            ? `Repaired ${editCount} section marker(s). ${warnings.slice(0, 3).join(" ")}`
            : `Repaired ${editCount} section marker(s).`;
        vscode.window.showInformationMessage(message);
    }

    private countMarkerOccurrences(document: vscode.TextDocument, marker: string): number {
        let count = 0;
        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
            if (document.lineAt(lineNumber).text.trim() === marker) {
                count += 1;
            }
        }
        return count;
    }

    private async previewOutputDiff(uri?: vscode.Uri): Promise<void> {
        const active = await this.activateWorkspaceForResource(uri) ?? await this.manifests.requireActive();
        if (!(await this.diagnostics.validateWorkspace(active))) {
            throw new UserFacingError("Validation failed. Fix diagnostics before previewing native output.");
        }

        const previewRoot = await this.createPreviewRoot();
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Encoding native preview", cancellable: false }, async () => {
            const result = await runBackendProjectEncode(this.backend, active, previewRoot);
            if (result.code !== 0) {
                throw new UserFacingError(result.stderr || result.stdout || "Preview encode failed.");
            }
            await this.materializeStagedObjects(active, previewRoot);
            await this.materializeStagedMembers(active, previewRoot);
        });

        this.previewPath = previewRoot;
        const changed = await this.computeChangedFiles(active.nativeRoot, previewRoot);
        this.diffTree.setChangedFiles(changed);
        await vscode.commands.executeCommand("setContext", "vscodecat.hasPreview", true);
        if (changed.length === 0) {
            vscode.window.showInformationMessage("Preview generated with no native output changes.");
            return;
        }
        await this.showChangedObjects();
    }

    private async createPreviewRoot(): Promise<string> {
        const storageRoot = this.context.globalStorageUri.fsPath;
        const previewRoot = path.join(storageRoot, "previews");
        await fs.mkdir(previewRoot, { recursive: true });
        return fs.mkdtemp(path.join(previewRoot, "preview-"));
    }

    private async computeChangedFiles(nativeRoot: string, previewRoot: string): Promise<ChangedFile[]> {
        const previewFiles = await listFiles(previewRoot);
        const changed: ChangedFile[] = [];
        for (const previewPath of previewFiles) {
            const relativePath = posixPath(path.relative(previewRoot, previewPath));
            const originalPath = path.join(nativeRoot, ...relativePath.split("/"));
            if (!(await exists(originalPath))) {
                changed.push({ relativePath, originalPath, previewPath, status: "added" });
                continue;
            }
            const [previewBytes, originalBytes] = await Promise.all([fs.readFile(previewPath), fs.readFile(originalPath)]);
            if (!previewBytes.equals(originalBytes)) {
                changed.push({ relativePath, originalPath, previewPath, status: "modified" });
            }
        }
        return changed.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }

    private async showChangedObjects(): Promise<void> {
        if (!this.previewPath) {
            await this.previewOutputDiff();
            return;
        }
        const changed = this.diffTree.getChangedFiles();
        if (changed.length === 0) {
            vscode.window.showInformationMessage("No native output changes in the current preview.");
            return;
        }
        const pick = await vscode.window.showQuickPick(
            changed.map((file) => ({
                label: file.relativePath,
                description: file.status,
                file,
            })),
            { placeHolder: "Open native output diff" },
        );
        if (pick) {
            await this.openChangedFileDiff(pick.file);
        }
    }

    private async diffCurrentObject(node?: TreeNode): Promise<void> {
        if (node?.changedFile) {
            await this.openChangedFileDiff(node.changedFile);
            return;
        }
        const active = await this.manifests.requireActive();
        if (!this.previewPath) {
            throw new UserFacingError("Generate a native output preview first.");
        }
        const item = node?.manifestItem ?? this.currentManifestItem();
        if (!item) {
            throw new UserFacingError("No mapped PLC object is active.");
        }
        const previewPath = path.join(this.previewPath, ...item.source_path.split("/"));
        const originalPath = fromManifestPath(active.nativeRoot, item.source_path);
        if (!(await exists(previewPath))) {
            throw new UserFacingError("This object was not found in the current preview.");
        }
        await this.openChangedFileDiff({ relativePath: item.source_path, originalPath, previewPath, status: "modified" });
    }

    private async openChangedFileDiff(file: ChangedFile): Promise<void> {
        if (file.status === "added" || !(await exists(file.originalPath))) {
            await vscode.window.showTextDocument(vscode.Uri.file(file.previewPath), { preview: true });
            return;
        }
        await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.file(file.originalPath),
            vscode.Uri.file(file.previewPath),
            `VSCodeCat native diff: ${file.relativePath}`,
        );
    }

    private async openPreviewFolder(): Promise<void> {
        if (!this.previewPath) {
            throw new UserFacingError("No preview folder has been generated.");
        }
        await vscode.env.openExternal(vscode.Uri.file(this.previewPath));
    }

    private async discardPreview(): Promise<void> {
        if (!this.previewPath) {
            return;
        }
        const storageRoot = path.join(this.context.globalStorageUri.fsPath, "previews");
        if (pathInside(this.previewPath, storageRoot)) {
            await fs.rm(this.previewPath, { recursive: true, force: true });
        }
        this.previewPath = undefined;
        this.diffTree.setChangedFiles([]);
        await vscode.commands.executeCommand("setContext", "vscodecat.hasPreview", false);
    }

    private async openInTwinCAT(): Promise<void> {
        const active = await this.manifests.requireActive();
        const base = this.encodedOutputPath ?? this.previewPath;
        if (!base) {
            throw new UserFacingError("Encode or preview native output first.");
        }
        const entry = path.join(base, ...active.manifest.native_entry.split("/"));
        const xaePath = this.config("twincat.xaePath", "");
        if (xaePath) {
            cp.spawn(xaePath, [entry], { detached: true, windowsHide: false });
            return;
        }
        await vscode.env.openExternal(vscode.Uri.file(entry));
    }

    private async locateTwinCATXae(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { "Executables": ["exe"], "All files": ["*"] },
        });
        if (!picked?.[0]) {
            return;
        }
        await vscode.workspace.getConfiguration("vscodecat").update("twincat.xaePath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    }

    private async openEncodedOutput(): Promise<void> {
        if (!this.encodedOutputPath) {
            throw new UserFacingError("No encoded output folder is available yet.");
        }
        await vscode.env.openExternal(vscode.Uri.file(this.encodedOutputPath));
    }

    private async showBackendVersion(): Promise<void> {
        const result = await this.backend.run(["--version"]);
        if (result.code !== 0) {
            throw new UserFacingError(result.stderr || result.stdout || "Backend version check failed.");
        }
        vscode.window.showInformationMessage(`VSCodeCat backend: ${result.stdout.trim()}`);
    }

    private async openManifestJson(): Promise<void> {
        const active = await this.manifests.requireActive();
        await vscode.window.showTextDocument(vscode.Uri.file(active.manifestPath), { preview: true });
    }

    private async exportSupportBundle(): Promise<void> {
        const active = this.manifests.active;
        const bundle = {
            generatedAt: new Date().toISOString(),
            backendCommand: vscode.workspace.getConfiguration("vscodecat").get("blark.command", "auto"),
            activeWorkspace: active
                ? {
                    root: active.root,
                    nativeEntry: active.manifest.native_entry,
                    itemCount: active.items.length,
                    stagedCount: active.staged.length,
                    stagedMemberCount: active.stagedMembers.length,
                }
                : undefined,
            diagnostics: this.diagnostics.snapshot().map(([uri, diagnostics]) => ({
                file: uri.fsPath,
                diagnostics: diagnostics.map((diagnostic) => ({
                    message: diagnostic.message,
                    line: diagnostic.range.start.line + 1,
                    severity: diagnostic.severity,
                })),
            })),
        };
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(bundle, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async runBackendSelfTest(): Promise<void> {
        const version = await this.backend.run(["--version"]);
        if (version.code !== 0) {
            throw new UserFacingError(version.stderr || version.stdout || "Backend version check failed.");
        }
        const sample = path.join(this.context.extensionPath, "blark", "tests", "source", "array_initializer.st");
        if (await exists(sample)) {
            const parsed = await this.backend.run(["parse", sample], this.context.extensionPath);
            if (parsed.code !== 0) {
                throw new UserFacingError(parsed.stderr || parsed.stdout || "Backend parse self-test failed.");
            }
        }
        vscode.window.showInformationMessage("VSCodeCat backend self-test passed.");
    }

    private async materializeStagedObjects(active: ActiveWorkspace, outputRoot: string): Promise<void> {
        for (const staged of active.staged) {
            const stagedAbs = fromManifestPath(active.root, staged.stagedPath);
            if (!(await exists(stagedAbs))) {
                throw new UserFacingError(`Staged ST file is missing: ${staged.stagedPath}`);
            }
            const sourceAbs = path.join(outputRoot, ...staged.sourcePath.split("/"));
            if (await exists(sourceAbs)) {
                throw new UserFacingError(`Cannot materialize staged object because output already exists: ${staged.sourcePath}`);
            }
            const stCode = await fs.readFile(stagedAbs, "utf8");
            await fs.mkdir(path.dirname(sourceAbs), { recursive: true });
            await fs.writeFile(sourceAbs, nativeXmlForStagedObject(staged, stCode), "utf8");
            await this.addCompileItem(outputRoot, sourceAbs, staged);
        }
    }

    private async materializeStagedMembers(active: ActiveWorkspace, outputRoot: string): Promise<void> {
        for (const member of active.stagedMembers) {
            if (member.kind !== "property") {
                continue;
            }
            const sourceAbs = path.join(outputRoot, ...member.parentSourcePath.split("/"));
            if (!(await exists(sourceAbs))) {
                throw new UserFacingError(`Cannot materialize staged property because output source is missing: ${member.parentSourcePath}`);
            }

            const declarationPath = fromManifestPath(active.root, member.stPaths.getDeclaration);
            const implementationPath = fromManifestPath(active.root, member.stPaths.getImplementation);
            if (!(await exists(declarationPath))) {
                throw new UserFacingError(`Staged property declaration is missing: ${member.stPaths.getDeclaration}`);
            }
            if (!(await exists(implementationPath))) {
                throw new UserFacingError(`Staged property implementation is missing: ${member.stPaths.getImplementation}`);
            }

            const declaration = await fs.readFile(declarationPath, "utf8");
            const implementation = await fs.readFile(implementationPath, "utf8");
            const xml = await fs.readFile(sourceAbs, "utf8");
            if (new RegExp(`<Property\\s+Name="${escapeRegExp(escapeXmlAttribute(member.name))}"\\b`, "i").test(xml)) {
                throw new UserFacingError(`Cannot materialize staged property because ${member.name} already exists in ${member.parentSourcePath}.`);
            }
            await fs.writeFile(sourceAbs, insertNativeMemberXml(xml, member.parentSourcePath, nativeXmlForDecodedProperty(member, declaration, implementation)), "utf8");
        }
    }

    private async addCompileItem(outputRoot: string, sourceAbs: string, staged: StagedObject): Promise<void> {
        const plcproj = await this.findNearestPlcproj(path.dirname(sourceAbs), outputRoot);
        if (!plcproj) {
            throw new UserFacingError(`Could not find a .plcproj for ${staged.sourcePath}.`);
        }

        const rel = path.relative(path.dirname(plcproj), sourceAbs).replace(/\//g, "\\");
        let xml = await fs.readFile(plcproj, "utf8");
        if (!xml.includes(`Compile Include="${rel}"`)) {
            const compileBlock = [
                `    <Compile Include="${rel}">`,
                "      <SubType>Code</SubType>",
                staged.kind === "gvl" ? "      <LinkAlways>true</LinkAlways>" : undefined,
                "    </Compile>",
            ].filter(Boolean).join(os.EOL);
            const itemGroups = [...xml.matchAll(/<ItemGroup>[\s\S]*?<\/ItemGroup>/g)];
            const compileGroup = itemGroups.find((match) => match[0].includes("<Compile"));
            if (!compileGroup) {
                throw new UserFacingError(`Could not find a Compile ItemGroup in ${plcproj}.`);
            }
            const replacement = compileGroup[0].replace(/(\r?\n\s*<\/ItemGroup>)/, `${os.EOL}${compileBlock}$1`);
            xml = `${xml.slice(0, compileGroup.index)}${replacement}${xml.slice((compileGroup.index ?? 0) + compileGroup[0].length)}`;
        }

        const folderRel = path.dirname(rel);
        if (folderRel !== "." && !xml.includes(`Folder Include="${folderRel}"`)) {
            const folderBlock = `    <Folder Include="${folderRel}" />`;
            const folderGroup = [...xml.matchAll(/<ItemGroup>[\s\S]*?<\/ItemGroup>/g)].find((match) => match[0].includes("<Folder"));
            if (folderGroup) {
                const replacement = folderGroup[0].replace(/(\r?\n\s*<\/ItemGroup>)/, `${os.EOL}${folderBlock}$1`);
                xml = `${xml.slice(0, folderGroup.index)}${replacement}${xml.slice((folderGroup.index ?? 0) + folderGroup[0].length)}`;
            }
        }

        await fs.writeFile(plcproj, xml, "utf8");
    }

    private async findNearestPlcproj(startDir: string, stopDir: string): Promise<string | undefined> {
        let current = startDir;
        while (pathInside(current, stopDir)) {
            const entries = await fs.readdir(current, { withFileTypes: true });
            const plcproj = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".plcproj"));
            if (plcproj) {
                return path.join(current, plcproj.name);
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
        return undefined;
    }

    private currentManifestItem(): ManifestItem | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor ? this.manifests.activeItemForFile(editor.document.uri.fsPath) : undefined;
    }

    private currentStagedObject(): StagedObject | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor ? this.manifests.stagedObjectForFile(editor.document.uri.fsPath) : undefined;
    }

    private async onDidSave(document: vscode.TextDocument): Promise<void> {
        if (!this.config("validateOnSave", true)) {
            return;
        }
        if (document.languageId !== "twincat-st" && !document.uri.fsPath.toLowerCase().endsWith(".st")) {
            return;
        }
        if (this.manifests.activeItemForFile(document.uri.fsPath) || this.manifests.stagedObjectForFile(document.uri.fsPath) || this.manifests.stagedMemberForFile(document.uri.fsPath)) {
            await this.diagnostics.validateCurrent(document);
        }
    }

    private async onActiveEditorChanged(): Promise<void> {
        await this.manifests.updateEditorContexts();
        await this.updateMarkerDecorations(vscode.window.activeTextEditor);
    }

    private async updateMarkerDecorations(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor || !this.markerDecorationsVisible) {
            editor?.setDecorations(this.markerDecoration, []);
            return;
        }
        const ranges: vscode.Range[] = [];
        for (let index = 0; index < editor.document.lineCount; index += 1) {
            const line = editor.document.lineAt(index);
            if (/^\s*\/\/\s*blark:(begin|end)\b/i.test(line.text)) {
                ranges.push(line.range);
            }
        }
        editor.setDecorations(this.markerDecoration, ranges);
    }

    private updateStatusBar(): void {
        const active = this.manifests.active;
        if (!active) {
            this.statusBar.text = "$(circuit-board) VSCodeCat";
            this.statusBar.tooltip = "No decoded TwinCAT workspace active";
        } else {
            this.statusBar.text = `$(circuit-board) VSCodeCat: ${path.basename(active.root)}`;
            this.statusBar.tooltip = active.root;
        }
        this.statusBar.command = "vscodecat.selectActiveWorkspace";
        this.statusBar.show();
    }

    private config<T>(key: string, fallback: T): T {
        return vscode.workspace.getConfiguration("vscodecat").get<T>(key, fallback);
    }

    private planned(message: string): void {
        vscode.window.showInformationMessage(message);
    }
}

function templateForKind(kind: SourceKind, name: string): string {
    switch (kind) {
        case "program":
            return `PROGRAM ${name}
VAR
END_VAR
END_PROGRAM
`;
        case "functionBlock":
            return `FUNCTION_BLOCK ${name}
VAR_INPUT
END_VAR
VAR_OUTPUT
END_VAR
VAR
END_VAR
END_FUNCTION_BLOCK

`;
        case "function":
            return `FUNCTION ${name} : BOOL;
VAR_INPUT
END_VAR

${name} := FALSE;
END_FUNCTION
`;
        case "interface":
            return `INTERFACE ${name}
END_INTERFACE
`;
        case "dutStruct":
            return `TYPE ${name} :
STRUCT
    Value : INT;
END_STRUCT
END_TYPE
`;
        case "dutEnum":
            return `TYPE ${name} :
(
    First,
    Second
);
END_TYPE
`;
        case "gvl":
            return `{attribute 'qualified_only'}
VAR_GLOBAL
END_VAR
`;
    }
}

function propertyTemplate(name: string, returnType: string): string {
    const defaultValue = defaultPropertyValue(returnType);
    const implementation = defaultValue
        ? `${name} := ${defaultValue};`
        : `// TODO: assign ${name} before using this property.`;
    return `PROPERTY ${name} : ${returnType}
VAR
END_VAR

${implementation}
END_PROPERTY
`;
}

function decodedPropertyDeclarationTemplate(name: string, returnType: string): string {
    return `PROPERTY ${name} : ${returnType}
VAR
END_VAR
END_PROPERTY
`;
}

function decodedPropertyGetterImplementationTemplate(name: string, returnType: string): string {
    const defaultValue = defaultPropertyValue(returnType);
    return defaultValue
        ? `${name} := ${defaultValue};\n`
        : `// TODO: assign ${name} before using this property.\n`;
}

function defaultPropertyValue(returnType: string): string | undefined {
    const normalized = returnType.trim().replace(/\(.+\)$/, "").toUpperCase();
    if (normalized === "BOOL") {
        return "FALSE";
    }
    if (normalized === "STRING" || normalized === "WSTRING") {
        return "''";
    }
    if (new Set(["BYTE", "WORD", "DWORD", "LWORD", "SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "LINT", "ULINT", "REAL", "LREAL"]).has(normalized)) {
        return "0";
    }
    return undefined;
}

function decodedPropertyNames(active: ActiveWorkspace, parent: ManifestItem): Set<string> {
    const names = new Set<string>();
    const propertyPrefix = `${posixPath(path.posix.dirname(posixPath(parent.st_path))).toLowerCase()}/properties/`;
    for (const item of active.items) {
        const stPath = posixPath(item.st_path).toLowerCase();
        if (!stPath.startsWith(propertyPrefix)) {
            continue;
        }
        const propertyName = posixPath(item.st_path).slice(propertyPrefix.length).split("/")[0];
        if (propertyName) {
            names.add(propertyName.toLowerCase());
        }
    }
    for (const member of active.stagedMembers) {
        if (member.parentSourcePath === parent.source_path) {
            names.add(member.name.toLowerCase());
        }
    }
    return names;
}

function stagedMemberPaths(member: StagedMember): string[] {
    return [
        member.stPaths.getDeclaration,
        member.stPaths.getImplementation,
    ];
}

async function insertBlockBeforeEnd(document: vscode.TextDocument, endKeyword: string, block: string): Promise<void> {
    const lines = document.getText().split(/\r?\n/);
    const endLine = findLastEndLine(lines, endKeyword);
    if (endLine < 0) {
        throw new UserFacingError(`Cannot add the property because ${endKeyword} was not found.`);
    }

    const previousLine = lines[endLine - 1]?.trim();
    const leadingBlank = previousLine ? "\n" : "";
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(endLine, 0), `${leadingBlank}${block.trimEnd()}\n\n`);
    if (!(await vscode.workspace.applyEdit(edit))) {
        throw new UserFacingError("Could not update the staged Function Block.");
    }
    await document.save();
}

function findLastEndLine(lines: string[], endKeyword: string): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isEndKeywordLine(lines[index], endKeyword)) {
            return index;
        }
    }
    return -1;
}

function isEndKeywordLine(line: string, endKeyword: string): boolean {
    return new RegExp(`^\\s*${endKeyword}\\s*;?\\s*$`, "i").test(line);
}

function nativeXmlForStagedObject(staged: StagedObject, stCode: string): string {
    const id = `{${randomUUID()}}`;
    switch (staged.kind) {
        case "gvl":
            return plcObjectXml(`<GVL Name="${staged.name}" Id="${id}">
    <Declaration><![CDATA[${safeCdata(stCode.trimEnd())}]]></Declaration>
  </GVL>`);
        case "dutStruct":
        case "dutEnum":
            return plcObjectXml(`<DUT Name="${staged.name}" Id="${id}">
    <Declaration><![CDATA[${safeCdata(stCode.trimEnd())}]]></Declaration>
  </DUT>`);
        case "interface": {
            const declaration = stripTrailingEnd(stCode, "END_INTERFACE");
            return plcObjectXml(`<Itf Name="${staged.name}" Id="${id}">
    <Declaration><![CDATA[${safeCdata(declaration)}]]></Declaration>
  </Itf>`);
        }
        case "program":
        case "functionBlock":
        case "function": {
            const endKeyword = staged.kind === "program"
                ? "END_PROGRAM"
                : staged.kind === "function"
                    ? "END_FUNCTION"
                    : "END_FUNCTION_BLOCK";
            const pou = staged.kind === "functionBlock"
                ? splitStagedFunctionBlock(stCode)
                : { code: stCode, methods: [], properties: [] };
            const [declaration, implementation] = splitPouCode(pou.code, endKeyword);
            const methods = pou.methods.map(nativeXmlForStagedMethod).join("");
            const properties = pou.properties.map(nativeXmlForStagedProperty).join("");
            return plcObjectXml(`<POU Name="${staged.name}" Id="${id}" SpecialFunc="None">
    <Declaration><![CDATA[${safeCdata(declaration)}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${safeCdata(implementation)}]]></ST>
    </Implementation>
${methods}${properties}  </POU>`);
        }
    }
}

function nativeXmlForStagedMethod(method: StagedMethod): string {
    const [declaration, implementation] = splitPouCode(method.code, "END_METHOD");
    return `    <Method Name="${escapeXmlAttribute(method.name)}" Id="{${randomUUID()}}">
      <Declaration><![CDATA[${safeCdata(declaration)}]]></Declaration>
      <Implementation>
        <ST><![CDATA[${safeCdata(implementation)}]]></ST>
      </Implementation>
    </Method>
`;
}

function nativeXmlForStagedProperty(property: StagedProperty): string {
    const [declaration, implementation] = splitPouCode(property.code, "END_PROPERTY");
    return `    <Property Name="${escapeXmlAttribute(property.name)}" Id="{${randomUUID()}}">
      <Declaration><![CDATA[${safeCdata(declaration)}]]></Declaration>
      <Get Name="Get" Id="{${randomUUID()}}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[${safeCdata(implementation)}]]></ST>
        </Implementation>
      </Get>
    </Property>
`;
}

function nativeXmlForDecodedProperty(member: StagedMember, declarationCode: string, implementationCode: string): string {
    const declaration = splitDecodedPropertyDeclaration(declarationCode);
    return `    <Property Name="${escapeXmlAttribute(member.name)}" Id="{${randomUUID()}}">
      <Declaration><![CDATA[${safeCdata(declaration.propertyDeclaration)}]]></Declaration>
      <Get Name="Get" Id="{${randomUUID()}}">
        <Declaration><![CDATA[${safeCdata(declaration.accessorDeclaration)}]]></Declaration>
        <Implementation>
          <ST><![CDATA[${safeCdata(implementationCode.trimEnd())}]]></ST>
        </Implementation>
      </Get>
    </Property>
`;
}

function splitDecodedPropertyDeclaration(code: string): { propertyDeclaration: string; accessorDeclaration: string } {
    const lines = code.trimEnd().split(/\r?\n/);
    if (isEndKeywordLine(lines.at(-1) ?? "", "END_PROPERTY")) {
        lines.pop();
    }

    const varIndex = lines.findIndex((line) => /^\s*VAR(?:\b|_)/i.test(line));
    if (varIndex < 0) {
        return {
            propertyDeclaration: `${lines.join("\n").trimEnd()}\n`,
            accessorDeclaration: "",
        };
    }

    return {
        propertyDeclaration: `${lines.slice(0, varIndex).join("\n").trimEnd()}\n`,
        accessorDeclaration: `${lines.slice(varIndex).join("\n").trimEnd()}\n`,
    };
}

function decodedPropertyValidationCode(declarationCode: string, implementationCode: string): string {
    const lines = declarationCode.trimEnd().split(/\r?\n/);
    if (isEndKeywordLine(lines.at(-1) ?? "", "END_PROPERTY")) {
        lines.pop();
    }
    return `${lines.join("\n").trimEnd()}\n\n${implementationCode.trimEnd()}\nEND_PROPERTY\n`;
}

function insertNativeMemberXml(xml: string, sourcePath: string, memberXml: string): string {
    const closeTag = sourcePath.toLowerCase().endsWith(".tcio") ? "</Itf>" : "</POU>";
    const insertAt = xml.lastIndexOf(closeTag);
    if (insertAt < 0) {
        throw new UserFacingError(`Cannot add staged property because ${closeTag} was not found in ${sourcePath}.`);
    }
    return `${xml.slice(0, insertAt)}${memberXml}${xml.slice(insertAt)}`;
}

function splitStagedFunctionBlock(code: string): { code: string; methods: StagedMethod[]; properties: StagedProperty[] } {
    const lines = code.trimEnd().split(/\r?\n/);
    const functionBlockLines: string[] = [];
    const methods: StagedMethod[] = [];
    const properties: StagedProperty[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        if (!isMethodStartLine(lines[index]) && !isPropertyStartLine(lines[index])) {
            functionBlockLines.push(lines[index]);
            continue;
        }

        const memberPrefix: string[] = [];
        while (functionBlockLines.length > 0 && isAttributeLine(functionBlockLines.at(-1)!)) {
            memberPrefix.unshift(functionBlockLines.pop()!);
        }

        if (isMethodStartLine(lines[index])) {
            const endIndex = findEndMethodLine(lines, index);
            if (endIndex < 0) {
                throw new UserFacingError(`Staged method is missing END_METHOD near line ${index + 1}.`);
            }

            const methodLines = [...memberPrefix, ...lines.slice(index, endIndex + 1)];
            methods.push({
                name: methodNameFromLines(methodLines, index + 1),
                code: `${methodLines.join("\n")}\n`,
            });
            index = endIndex;
            continue;
        }

        const endIndex = findEndPropertyLine(lines, index);
        if (endIndex < 0) {
            throw new UserFacingError(`Staged property is missing END_PROPERTY near line ${index + 1}.`);
        }

        const propertyLines = [...memberPrefix, ...lines.slice(index, endIndex + 1)];
        properties.push({
            name: propertyNameFromLines(propertyLines, index + 1),
            code: `${propertyLines.join("\n")}\n`,
        });
        index = endIndex;
    }

    return {
        code: `${functionBlockLines.join("\n").trimEnd()}\n`,
        methods,
        properties,
    };
}

function isMethodStartLine(line: string): boolean {
    return /^\s*METHOD\b/i.test(line);
}

function isPropertyStartLine(line: string): boolean {
    return /^\s*PROPERTY\b/i.test(line);
}

function isAttributeLine(line: string): boolean {
    return /^\s*\{attribute\b.*\}\s*$/i.test(line);
}

function findEndMethodLine(lines: string[], startIndex: number): number {
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        if (isEndKeywordLine(lines[index], "END_METHOD")) {
            return index;
        }
    }
    return -1;
}

function findEndPropertyLine(lines: string[], startIndex: number): number {
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        if (isEndKeywordLine(lines[index], "END_PROPERTY")) {
            return index;
        }
    }
    return -1;
}

function methodNameFromLines(lines: string[], sourceLine: number): string {
    const methodLine = lines.find((line) => isMethodStartLine(line));
    const declaration = methodLine?.replace(/^\s*METHOD\s+/i, "").split(":")[0].trim() ?? "";
    const modifiers = new Set(["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL", "FINAL", "ABSTRACT"]);
    const name = declaration
        .split(/\s+/)
        .filter((part) => part && !modifiers.has(part.toUpperCase()))
        .at(-1);

    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) {
        throw new UserFacingError(`Could not determine staged method name near line ${sourceLine}.`);
    }

    return name;
}

function propertyNameFromLines(lines: string[], sourceLine: number): string {
    const propertyLine = lines.find((line) => isPropertyStartLine(line));
    const declaration = propertyLine?.replace(/^\s*PROPERTY\s+/i, "").split(":")[0].trim() ?? "";
    const modifiers = new Set(["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL", "FINAL", "ABSTRACT"]);
    const name = declaration
        .split(/\s+/)
        .filter((part) => part && !modifiers.has(part.toUpperCase()))
        .at(-1);

    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) {
        throw new UserFacingError(`Could not determine staged property name near line ${sourceLine}.`);
    }

    return name;
}

function stagedFunctionBlockMemberNames(code: string): Set<string> {
    const names = new Set<string>();
    const lines = code.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        if (isMethodStartLine(lines[index])) {
            names.add(methodNameFromLines([lines[index]], index + 1).toLowerCase());
        } else if (isPropertyStartLine(lines[index])) {
            names.add(propertyNameFromLines([lines[index]], index + 1).toLowerCase());
        }
    }
    return names;
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function plcObjectXml(inner: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  ${inner}
</TcPlcObject>
`;
}

function safeCdata(value: string): string {
    return value.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function stripTrailingEnd(code: string, endKeyword: string): string {
    const lines = code.trimEnd().split(/\r?\n/);
    if (isEndKeywordLine(lines.at(-1) ?? "", endKeyword)) {
        lines.pop();
    }
    return `${lines.join("\n")}\n`;
}

function splitPouCode(code: string, endKeyword: string): [string, string] {
    const lines = code.trimEnd().split(/\r?\n/);
    const endIndex = lines.findIndex((line) => isEndKeywordLine(line, endKeyword));
    if (endIndex < 0) {
        return [`${lines.join("\n")}\n`, ""];
    }

    const beforeEnd = lines.slice(0, endIndex);
    const afterEnd = lines.slice(endIndex + 1).join("\n").trim();
    if (afterEnd) {
        return [`${beforeEnd.join("\n")}\n`, afterEnd];
    }

    let declarationEnd = -1;
    for (let index = beforeEnd.length - 1; index >= 0; index -= 1) {
        if (beforeEnd[index].trim().toUpperCase() === "END_VAR") {
            declarationEnd = index;
            break;
        }
    }

    if (declarationEnd < 0 && beforeEnd.length > 1) {
        declarationEnd = 0;
    }

    if (declarationEnd >= 0 && declarationEnd < beforeEnd.length - 1) {
        const declaration = beforeEnd.slice(0, declarationEnd + 1).join("\n");
        const implementation = beforeEnd.slice(declarationEnd + 1).join("\n").trim();
        return [`${declaration}\n`, implementation];
    }

    const declaration = beforeEnd.join("\n");
    const implementation = "";
    return [`${declaration}\n`, implementation];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await new ExtensionController(context).activate();
}

export function deactivate(): void {
    // VS Code disposes registered subscriptions from the extension context.
}
