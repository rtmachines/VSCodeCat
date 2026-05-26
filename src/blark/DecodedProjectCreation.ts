import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSameOrInside } from "./DecodePaths";
import {
  BlarkManifest,
  BlarkManifestItem,
  contentHash,
  findStructuredRoot,
  loadManifest,
  manifestItemIdentifier,
  manifestItemNativePath,
  manifestItemStPath,
  manifestPath,
  manifestPathToFsPath,
  nativeRootName,
  rebuildIndexAndDiagnostics,
  sourceRootName,
  writeMetadataJson,
} from "./Manifest";

export type ProjectItemKind = "function" | "functionBlock" | "dut" | "interface";
export type FunctionBlockVariant = "normal" | "derived" | "abstract" | "implements";
export type MemberItemKind = "method" | "property";
export type PropertyAccessor = "get" | "set";

export interface CreateDecodedFolderRequest {
  targetPath: string;
  name: string;
}

export interface CreateDecodedProjectItemRequest {
  targetPath: string;
  name: string;
  kind: ProjectItemKind;
  functionBlockVariant?: FunctionBlockVariant;
  baseName?: string;
  implementedInterfaces?: string[];
}

export interface CreateDecodedMemberRequest {
  targetPath: string;
  name: string;
  kind: MemberItemKind;
  returnType?: string;
  declarationCode?: string;
  implementationCode?: string;
  propertyAccessors?: PropertyAccessor[];
}

export interface CreatedDecodedItem {
  structuredRoot: string;
  sourcePaths: string[];
  nativePaths: string[];
  openPath?: string;
}

interface DecodedProjectContext {
  structuredRoot: string;
  manifest: BlarkManifest;
  sourceRoot: string;
  nativeRoot: string;
  objects: DecodedObject[];
  plcProjects: string[];
}

interface DecodedObject {
  name: string;
  type?: string;
  sourceRoot: string;
  nativePath: string;
  items: BlarkManifestItem[];
}

interface ProjectContainerTarget {
  sourceFolder: string;
  nativeFolder: string;
  plcProjectPath: string;
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const invalidFolderNamePattern = /[<>:"/\\|?*\x00-\x1f]/;
const objectMemberFolders = new Set(["actions", "methods", "properties", "members"]);
const sourceTypesWithMembers = new Set(["function_block", "interface"]);
const topLevelSourceTypes = new Set(["dut", "function", "function_block", "interface", "program", "var_global"]);
const reservedIdentifiers = new Set([
  "ABSTRACT",
  "ACTION",
  "AND",
  "AND_THEN",
  "AT",
  "BY",
  "CASE",
  "CONTINUE",
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
  "END_UNION",
  "END_VAR",
  "END_WHILE",
  "EXIT",
  "EXTENDS",
  "FINAL",
  "FOR",
  "FUNCTION",
  "FUNCTION_BLOCK",
  "IF",
  "IMPLEMENTS",
  "INTERFACE",
  "METHOD",
  "OF",
  "OR",
  "OR_ELSE",
  "PRIVATE",
  "PROGRAM",
  "PROPERTY",
  "PROTECTED",
  "PUBLIC",
  "RETURN",
  "STRUCT",
  "THEN",
  "TYPE",
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "WHILE",
  "XOR",
]);

export function validateDecodedIdentifier(name: string, label = "Name"): string | undefined {
  if (!name.trim()) {
    return `${label} is required.`;
  }
  if (!identifierPattern.test(name)) {
    return `${label} must be an IEC identifier, for example FB_Motor or I_Device.`;
  }
  if (reservedIdentifiers.has(name.toUpperCase())) {
    return `${label} cannot be the reserved IEC keyword ${name}.`;
  }
  return undefined;
}

export function validateDecodedFolderName(name: string): string | undefined {
  if (!name.trim()) {
    return "Folder name is required.";
  }
  if (name === "." || name === ".." || invalidFolderNamePattern.test(name)) {
    return "Folder name cannot contain path separators or Windows-reserved characters.";
  }
  return undefined;
}

export async function listProjectInterfaces(targetPath: string): Promise<string[]> {
  const context = await loadDecodedProjectContext(targetPath);
  const plcProjectPath = resolvePlcProjectForTarget(context, targetPath);
  return objectsInProject(context, plcProjectPath)
    .filter((object) => object.type === "interface")
    .map((object) => object.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function createDecodedFolder(request: CreateDecodedFolderRequest): Promise<CreatedDecodedItem> {
  assertNoValidationError(validateDecodedFolderName(request.name));
  const context = await loadDecodedProjectContext(request.targetPath);
  const target = await resolveProjectContainerTarget(context, request.targetPath, "folder");
  const sourceFolder = path.join(target.sourceFolder, request.name);
  const nativeFolder = path.join(target.nativeFolder, request.name);

  if (await pathExists(sourceFolder)) {
    throw new Error(`A decoded source folder named ${request.name} already exists in ${target.sourceFolder}.`);
  }
  if (await pathExists(nativeFolder)) {
    throw new Error(`A native TwinCAT folder named ${request.name} already exists in ${target.nativeFolder}.`);
  }

  await fs.mkdir(sourceFolder, { recursive: true });
  await fs.mkdir(nativeFolder, { recursive: true });
  await updatePlcProject(target.plcProjectPath, {
    folderIncludes: projectFolderIncludes(target.plcProjectPath, nativeFolder),
  });
  await refreshMetadata(context);

  return {
    structuredRoot: context.structuredRoot,
    sourcePaths: [sourceFolder],
    nativePaths: [nativeFolder, target.plcProjectPath],
    openPath: sourceFolder,
  };
}

export async function createDecodedProjectItem(
  request: CreateDecodedProjectItemRequest,
): Promise<CreatedDecodedItem> {
  assertNoValidationError(validateDecodedIdentifier(request.name));
  if (request.functionBlockVariant === "derived") {
    assertNoValidationError(validateDecodedIdentifier(request.baseName ?? "", "Base function block"));
  }
  for (const interfaceName of request.implementedInterfaces ?? []) {
    assertNoValidationError(validateDecodedIdentifier(interfaceName, "Interface"));
  }

  const context = await loadDecodedProjectContext(request.targetPath);
  const target = await resolveProjectContainerTarget(context, request.targetPath, request.kind);
  assertProjectObjectNameAvailable(context, request.name, target.plcProjectPath);

  const template = buildProjectItemTemplate(request);
  const nativeFile = path.join(target.nativeFolder, `${request.name}${template.extension}`);
  const sourceObjectRoot = path.join(target.sourceFolder, request.name);
  if (await pathExists(nativeFile)) {
    throw new Error(`A native TwinCAT file named ${path.basename(nativeFile)} already exists in ${target.nativeFolder}.`);
  }
  if (await pathExists(sourceObjectRoot)) {
    throw new Error(`A decoded object folder named ${request.name} already exists in ${target.sourceFolder}.`);
  }

  const writtenSourcePaths: string[] = [];
  await fs.mkdir(sourceObjectRoot, { recursive: true });
  for (const block of template.blocks) {
    const sourcePath = path.join(sourceObjectRoot, block.filename);
    await fs.writeFile(sourcePath, block.code, "utf8");
    writtenSourcePaths.push(sourcePath);
  }

  await fs.mkdir(path.dirname(nativeFile), { recursive: true });
  await fs.writeFile(nativeFile, template.nativeXml, "utf8");
  await updatePlcProject(target.plcProjectPath, {
    compileIncludes: [projectRelativePath(target.plcProjectPath, nativeFile)],
    folderIncludes: projectFolderIncludes(target.plcProjectPath, target.nativeFolder),
  });

  const nativePath = relativeManifestPath(context.nativeRoot, nativeFile);
  const manifestItems = template.blocks.map((block) =>
    manifestItem({
      structuredRoot: context.structuredRoot,
      sourceFile: path.join(sourceObjectRoot, block.filename),
      nativePath,
      identifier: `${request.name}/${block.part}`,
      objectId: request.name,
      kind: template.manifestKind,
      part: block.part,
      grammarRule: block.grammarRule,
      implicitEnd: block.implicitEnd,
      code: block.code,
    }),
  );
  context.manifest.items.push(...manifestItems);
  await writeManifest(context);
  await refreshMetadata(context);

  if (request.kind === "functionBlock" && request.functionBlockVariant === "implements") {
    await createInterfaceMemberStubs(sourceObjectRoot, request.implementedInterfaces ?? []);
  }

  return {
    structuredRoot: context.structuredRoot,
    sourcePaths: writtenSourcePaths,
    nativePaths: [nativeFile, target.plcProjectPath],
    openPath: writtenSourcePaths[0],
  };
}

export async function createDecodedMember(request: CreateDecodedMemberRequest): Promise<CreatedDecodedItem> {
  assertNoValidationError(validateDecodedIdentifier(request.name));
  const context = await loadDecodedProjectContext(request.targetPath);
  const targetObject = resolveObjectTarget(context, request.targetPath);
  assertMemberObjectSupported(targetObject);
  assertObjectMemberNameAvailable(targetObject, request.name);

  const template = buildMemberTemplate(targetObject, request);
  const nativeFile = path.join(context.nativeRoot, ...targetObject.nativePath.split(/[\\/]/).filter(Boolean));
  if (!(await pathExists(nativeFile))) {
    throw new Error(`The native TwinCAT source file for ${targetObject.name} is missing: ${nativeFile}.`);
  }

  const writtenSourcePaths: string[] = [];
  for (const block of template.blocks) {
    const sourcePath = path.join(targetObject.sourceRoot, block.relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, block.code, "utf8");
    writtenSourcePaths.push(sourcePath);
  }

  await insertMemberXml(nativeFile, targetObject, template.nativeXml, request.name);
  const manifestItems = template.blocks.map((block) =>
    manifestItem({
      structuredRoot: context.structuredRoot,
      sourceFile: path.join(targetObject.sourceRoot, block.relativePath),
      nativePath: targetObject.nativePath,
      identifier: `${targetObject.name}.${block.identifierSuffix}/${block.part}`,
      objectId: targetObject.name,
      kind: block.kind,
      part: block.part,
      grammarRule: block.grammarRule,
      implicitEnd: block.implicitEnd,
      code: block.code,
    }),
  );
  context.manifest.items.push(...manifestItems);
  await writeManifest(context);
  await refreshMetadata(context);

  return {
    structuredRoot: context.structuredRoot,
    sourcePaths: writtenSourcePaths,
    nativePaths: [nativeFile],
    openPath: writtenSourcePaths[0],
  };
}

function assertNoValidationError(message: string | undefined): void {
  if (message) {
    throw new Error(message);
  }
}

async function loadDecodedProjectContext(targetPath: string): Promise<DecodedProjectContext> {
  const structuredRoot = await findStructuredRoot(targetPath);
  if (!structuredRoot) {
    throw new Error("Select a file or folder inside a decoded blark project before creating TwinCAT items.");
  }
  const manifest = await loadManifest(structuredRoot);
  const sourceRoot = path.join(structuredRoot, sourceRootName(manifest));
  const nativeRoot = path.join(structuredRoot, nativeRootName(manifest));
  return {
    structuredRoot,
    manifest,
    sourceRoot,
    nativeRoot,
    objects: deriveObjects(structuredRoot, sourceRoot, manifest),
    plcProjects: await findPlcProjects(nativeRoot),
  };
}

function deriveObjects(structuredRoot: string, sourceRoot: string, manifest: BlarkManifest): DecodedObject[] {
  const byName = new Map<string, DecodedObject>();
  for (const item of manifest.items) {
    const objectName = item.objectId ?? item.object_identifier ?? parseIdentifier(manifestItemIdentifier(item) ?? "").parts[0];
    const nativePath = manifestItemNativePath(item);
    const stPath = manifestItemStPath(item);
    if (!objectName || !nativePath || !stPath) {
      continue;
    }

    const sourceFile = manifestPathToFsPath(structuredRoot, stPath);
    if (!isSameOrInside(sourceFile, sourceRoot)) {
      continue;
    }

    const objectRoot = objectRootFromSourceFile(sourceRoot, sourceFile);
    const objectKey = `${nativePath.toLowerCase()}::${objectName.toLowerCase()}`;
    const existing = byName.get(objectKey) ?? {
      name: objectName,
      sourceRoot: objectRoot,
      nativePath,
      items: [],
    };
    const itemKind = item.kind ?? item.type;
    if (itemKind && topLevelSourceTypes.has(itemKind)) {
      existing.type = itemKind;
    }
    existing.items.push(item);
    byName.set(objectKey, existing);
  }

  return [...byName.values()].sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);
}

function objectRootFromSourceFile(sourceRoot: string, sourceFile: string): string {
  const relative = path.relative(sourceRoot, sourceFile);
  const parts = relative.split(path.sep).filter(Boolean);
  const markerIndex = parts.findIndex((part) => objectMemberFolders.has(part.toLowerCase()));
  if (markerIndex > 0) {
    return path.join(sourceRoot, ...parts.slice(0, markerIndex));
  }
  return path.dirname(sourceFile);
}

async function findPlcProjects(nativeRoot: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".plcproj") {
        result.push(child);
      }
    }
  }
  await walk(nativeRoot);
  return result.sort((left, right) => left.localeCompare(right));
}

async function resolveProjectContainerTarget(
  context: DecodedProjectContext,
  targetPath: string,
  kind: ProjectItemKind | "folder",
): Promise<ProjectContainerTarget> {
  const selectedDirectory = await selectedDirectoryPath(targetPath);
  let sourceFolder: string;
  let plcProjectPath: string | undefined;

  if (isSameOrInside(selectedDirectory, context.sourceRoot)) {
    sourceFolder = selectedDirectory;
    const containingObject = findContainingObject(context, sourceFolder);
    if (containingObject) {
      throw new Error(
        `Cannot create project items inside ${containingObject.name}. Select a decoded project folder instead.`,
      );
    }

    const nativeFolder = path.join(context.nativeRoot, path.relative(context.sourceRoot, sourceFolder));
    plcProjectPath = findPlcProjectForNativeFolder(context, nativeFolder);
    if (!plcProjectPath && samePath(sourceFolder, context.sourceRoot) && context.plcProjects.length === 1) {
      plcProjectPath = context.plcProjects[0];
      sourceFolder = path.join(context.sourceRoot, path.relative(context.nativeRoot, path.dirname(plcProjectPath)));
    }
  } else if (isSameOrInside(selectedDirectory, context.structuredRoot)) {
    plcProjectPath = singlePlcProject(context);
    sourceFolder = path.join(context.sourceRoot, path.relative(context.nativeRoot, path.dirname(plcProjectPath)));
  } else {
    throw new Error("Create commands can only target folders inside the selected decoded blark project.");
  }

  if (!plcProjectPath) {
    throw new Error("Select a folder inside one decoded PLC project so the new item can be added to the correct .plcproj.");
  }
  if (kind !== "folder" && samePath(sourceFolder, projectSourceBase(context, plcProjectPath))) {
    sourceFolder = path.join(sourceFolder, defaultFolderForKind(kind));
  }

  const nativeFolder = path.join(context.nativeRoot, path.relative(context.sourceRoot, sourceFolder));
  if (!isSameOrInside(nativeFolder, path.dirname(plcProjectPath))) {
    throw new Error(`The target folder ${sourceFolder} is not inside the PLC project ${path.basename(plcProjectPath)}.`);
  }

  return {
    sourceFolder,
    nativeFolder,
    plcProjectPath,
  };
}

async function selectedDirectoryPath(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory() ? path.resolve(targetPath) : path.dirname(path.resolve(targetPath));
  } catch {
    return path.dirname(path.resolve(targetPath));
  }
}

function singlePlcProject(context: DecodedProjectContext): string {
  if (context.plcProjects.length === 1) {
    return context.plcProjects[0];
  }
  if (context.plcProjects.length === 0) {
    throw new Error("The decoded native tree does not contain a .plcproj file.");
  }
  throw new Error("This decoded project contains multiple PLC projects. Select a folder inside the project to create items.");
}

function findPlcProjectForNativeFolder(context: DecodedProjectContext, nativeFolder: string): string | undefined {
  const candidates = context.plcProjects
    .filter((plcProjectPath) => isSameOrInside(nativeFolder, path.dirname(plcProjectPath)))
    .sort((left, right) => path.dirname(right).length - path.dirname(left).length);
  return candidates[0];
}

function resolvePlcProjectForTarget(context: DecodedProjectContext, targetPath: string): string {
  const target = path.resolve(targetPath);
  const targetObject = context.objects.find((object) => isSameOrInside(target, object.sourceRoot));
  if (targetObject) {
    const nativeFile = objectNativeFile(context, targetObject);
    return findPlcProjectForNativeFolder(context, path.dirname(nativeFile)) ?? singlePlcProject(context);
  }

  if (isSameOrInside(target, context.sourceRoot)) {
    const nativeFolder = path.join(context.nativeRoot, path.relative(context.sourceRoot, target));
    const plcProjectPath = findPlcProjectForNativeFolder(context, nativeFolder);
    if (plcProjectPath) {
      return plcProjectPath;
    }
  }
  return singlePlcProject(context);
}

function objectsInProject(context: DecodedProjectContext, plcProjectPath: string): DecodedObject[] {
  const projectDirectory = path.dirname(plcProjectPath);
  return context.objects.filter((object) => isSameOrInside(objectNativeFile(context, object), projectDirectory));
}

function objectNativeFile(context: DecodedProjectContext, object: DecodedObject): string {
  return path.join(context.nativeRoot, ...object.nativePath.split(/[\\/]/).filter(Boolean));
}

function projectSourceBase(context: DecodedProjectContext, plcProjectPath: string): string {
  return path.join(context.sourceRoot, path.relative(context.nativeRoot, path.dirname(plcProjectPath)));
}

function defaultFolderForKind(kind: ProjectItemKind): string {
  if (kind === "dut") {
    return "DUTs";
  }
  if (kind === "interface") {
    return "Interfaces";
  }
  return "POUs";
}

function resolveObjectTarget(context: DecodedProjectContext, targetPath: string): DecodedObject {
  const selected = path.resolve(targetPath);
  const candidate = context.objects.find((object) => isSameOrInside(selected, object.sourceRoot));
  if (!candidate) {
    throw new Error("Select a decoded function block or interface object before creating a Method or Property.");
  }
  return candidate;
}

function findContainingObject(context: DecodedProjectContext, targetPath: string): DecodedObject | undefined {
  const selected = path.resolve(targetPath);
  return context.objects.find((object) => isSameOrInside(selected, object.sourceRoot));
}

function assertMemberObjectSupported(object: DecodedObject): void {
  if (!object.type || !sourceTypesWithMembers.has(object.type)) {
    throw new Error(`The selected object ${object.name} cannot contain methods or properties.`);
  }
}

function assertProjectObjectNameAvailable(context: DecodedProjectContext, name: string, plcProjectPath: string): void {
  if (objectsInProject(context, plcProjectPath).some((object) => object.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`An object named ${name} already exists in this decoded project.`);
  }
}

function assertObjectMemberNameAvailable(object: DecodedObject, name: string): void {
  const prefix = `${object.name}.${name}`.toLowerCase();
  const exists = object.items.some((item) => {
    const identifier = manifestItemIdentifier(item)?.toLowerCase() ?? "";
    return identifier === prefix || identifier.startsWith(`${prefix}/`) || identifier.startsWith(`${prefix}.`);
  });
  if (exists) {
    throw new Error(`${object.name} already contains a member named ${name}.`);
  }
}

function buildProjectItemTemplate(request: CreateDecodedProjectItemRequest): {
  extension: string;
  manifestKind: string;
  blocks: Array<{
    filename: string;
    code: string;
    part: string;
    grammarRule: string;
    implicitEnd: string;
  }>;
  nativeXml: string;
} {
  const declaration = topLevelDeclaration(request);
  const implementation = topLevelImplementation(request);
  const manifestKind = request.kind === "functionBlock" ? "function_block" : request.kind;
  const extension = request.kind === "dut" ? ".TcDUT" : request.kind === "interface" ? ".TcIO" : ".TcPOU";
  const declarationImplicitEnd =
    request.kind === "function"
      ? "END_FUNCTION"
      : request.kind === "functionBlock"
        ? "END_FUNCTION_BLOCK"
        : request.kind === "interface"
          ? "END_INTERFACE"
          : "";
  const blocks = [
    {
      filename: "declaration.st",
      code: declaration,
      part: "declaration",
      grammarRule:
        request.kind === "function"
          ? "function_declaration"
          : request.kind === "functionBlock"
            ? "function_block_type_declaration"
            : request.kind === "interface"
              ? "interface_declaration"
              : "data_type_declaration",
      implicitEnd: declarationImplicitEnd,
    },
  ];
  if (implementation) {
    blocks.push({
      filename: "implementation.st",
      code: implementation,
      part: "implementation",
      grammarRule: "statement_list",
      implicitEnd: "",
    });
  }

  return {
    extension,
    manifestKind,
    blocks,
    nativeXml: topLevelNativeXml(request, stripImplicitEndLine(declaration, declarationImplicitEnd), implementation),
  };
}

function topLevelDeclaration(request: CreateDecodedProjectItemRequest): string {
  const name = request.name;
  if (request.kind === "function") {
    return `FUNCTION ${name} : BOOL\nVAR_INPUT\nEND_VAR\nEND_FUNCTION`;
  }
  if (request.kind === "functionBlock") {
    const modifiers: string[] = [];
    if (request.functionBlockVariant === "abstract") {
      modifiers.push("ABSTRACT");
    }
    const extendsClause = request.functionBlockVariant === "derived" ? ` EXTENDS ${request.baseName}` : "";
    const implementsClause =
      request.functionBlockVariant === "implements" && request.implementedInterfaces?.length
        ? ` IMPLEMENTS ${request.implementedInterfaces.join(", ")}`
        : "";
    const modifierClause = modifiers.length ? `${modifiers.join(" ")} ` : "";
    return `FUNCTION_BLOCK ${modifierClause}${name}${extendsClause}${implementsClause}\nVAR_INPUT\nEND_VAR\nVAR_OUTPUT\nEND_VAR\nVAR\nEND_VAR\nEND_FUNCTION_BLOCK`;
  }
  if (request.kind === "interface") {
    return `INTERFACE ${name}\nEND_INTERFACE`;
  }
  return `TYPE ${name} :\nSTRUCT\nEND_STRUCT\nEND_TYPE`;
}

function topLevelImplementation(request: CreateDecodedProjectItemRequest): string {
  if (request.kind === "function") {
    return `${request.name} := FALSE;`;
  }
  if (request.kind === "functionBlock") {
    return "RETURN;";
  }
  return "";
}

function topLevelNativeXml(request: CreateDecodedProjectItemRequest, declaration: string, implementation: string): string {
  const id = guid();
  const declarationXml = `    <Declaration>${cdata(declaration)}</Declaration>`;
  const implementationXml = implementation
    ? `\r\n    <Implementation>\r\n      <ST>${cdata(implementation)}</ST>\r\n    </Implementation>`
    : "";
  if (request.kind === "dut") {
    return xmlDocument(`  <DUT Name="${xmlAttr(request.name)}" Id="${id}">\r\n${declarationXml}\r\n  </DUT>`);
  }
  if (request.kind === "interface") {
    return xmlDocument(`  <Itf Name="${xmlAttr(request.name)}" Id="${id}">\r\n${declarationXml}\r\n  </Itf>`);
  }
  return xmlDocument(
    `  <POU Name="${xmlAttr(request.name)}" Id="${id}" SpecialFunc="None">\r\n${declarationXml}${implementationXml}\r\n  </POU>`,
  );
}

function buildMemberTemplate(
  object: DecodedObject,
  request: CreateDecodedMemberRequest,
): {
  blocks: Array<{
    relativePath: string;
    code: string;
    identifierSuffix: string;
    kind: string;
    part: string;
    grammarRule: string;
    implicitEnd: string;
  }>;
  nativeXml: string;
} {
  if (request.kind === "method") {
    const declaration =
      request.declarationCode ?? `METHOD ${request.name} : ${request.returnType ?? "BOOL"}\nVAR_INPUT\nEND_VAR\nEND_METHOD`;
    const implementation = object.type === "interface" ? "" : (request.implementationCode ?? defaultReturnAssignment(request.name, declaration));
    const blocks = [
      {
        relativePath: path.join("methods", request.name, "declaration.st"),
        code: declaration,
        identifierSuffix: request.name,
        kind: "method",
        part: "declaration",
        grammarRule: "function_block_method_declaration",
        implicitEnd: "END_METHOD",
      },
    ];
    if (implementation) {
      blocks.push({
        relativePath: path.join("methods", request.name, "implementation.st"),
        code: implementation,
        identifierSuffix: request.name,
        kind: "method",
        part: "implementation",
        grammarRule: "statement_list",
        implicitEnd: "",
      });
    }
    return {
      blocks,
      nativeXml: methodNativeXml(request.name, stripImplicitEndLine(declaration, "END_METHOD"), implementation),
    };
  }

  const accessors: PropertyAccessor[] = request.propertyAccessors?.length ? request.propertyAccessors : ["get", "set"];
  const declaration = request.declarationCode ?? `PROPERTY ${request.name} : ${request.returnType ?? "INT"}\nEND_PROPERTY`;
  const { baseDeclaration, accessorDeclaration } = splitPropertyDeclaration(declaration);
  const blocks: ReturnType<typeof buildMemberTemplate>["blocks"] = [];
  for (const accessor of accessors) {
    const accessorSuffix = `${request.name}.${accessor}`;
    blocks.push({
      relativePath: path.join("properties", request.name, accessor, "declaration.st"),
      code: declaration,
      identifierSuffix: accessorSuffix,
      kind: accessor === "get" ? "property_get" : "property_set",
      part: "declaration",
      grammarRule: "function_block_property_declaration",
      implicitEnd: "END_PROPERTY",
    });
    if (object.type !== "interface") {
      const implementation =
        accessor === "get"
          ? (request.implementationCode ?? defaultReturnAssignment(request.name, declaration))
          : "RETURN;";
      blocks.push({
        relativePath: path.join("properties", request.name, accessor, "implementation.st"),
        code: implementation,
        identifierSuffix: accessorSuffix,
        kind: accessor === "get" ? "property_get" : "property_set",
        part: "implementation",
        grammarRule: "statement_list",
        implicitEnd: "",
      });
    }
  }

  return {
    blocks,
    nativeXml: propertyNativeXml(request.name, baseDeclaration, accessorDeclaration, object.type === "interface", accessors),
  };
}

function methodNativeXml(name: string, declaration: string, implementation: string): string {
  const implementationXml = implementation
    ? `\r\n      <Implementation>\r\n        <ST>${cdata(implementation)}</ST>\r\n      </Implementation>`
    : "";
  return `    <Method Name="${xmlAttr(name)}" Id="${guid()}">\r\n      <Declaration>${cdata(declaration)}</Declaration>${implementationXml}\r\n    </Method>`;
}

function propertyNativeXml(
  name: string,
  baseDeclaration: string,
  accessorDeclaration: string,
  interfaceOnly: boolean,
  accessors: PropertyAccessor[],
): string {
  const children = accessors.map((accessor) => {
    const tag = accessor === "get" ? "Get" : "Set";
    const implementation =
      interfaceOnly ? "" : accessor === "get" ? defaultReturnAssignment(name, baseDeclaration) : "RETURN;\n";
    const implementationXml = implementation
      ? `\r\n        <Implementation>\r\n          <ST>${cdata(implementation)}</ST>\r\n        </Implementation>`
      : "";
    return `      <${tag} Name="${tag}" Id="${guid()}">\r\n        <Declaration>${cdata(accessorDeclaration)}</Declaration>${implementationXml}\r\n      </${tag}>`;
  });
  return `    <Property Name="${xmlAttr(name)}" Id="${guid()}">\r\n      <Declaration>${cdata(baseDeclaration)}</Declaration>\r\n${children.join("\r\n")}\r\n    </Property>`;
}

function splitPropertyDeclaration(declaration: string): { baseDeclaration: string; accessorDeclaration: string } {
  const lines = stripImplicitEndLine(declaration, "END_PROPERTY").split(/\r?\n/);
  const propertyLineIndex = lines.findIndex((line) => line.trim().toUpperCase().startsWith("PROPERTY "));
  if (propertyLineIndex < 0) {
    return { baseDeclaration: declaration, accessorDeclaration: "" };
  }
  const baseDeclaration = lines[propertyLineIndex];
  const rest = [...lines.slice(0, propertyLineIndex), ...lines.slice(propertyLineIndex + 1)].join("\n").trim();
  return { baseDeclaration, accessorDeclaration: rest };
}

function stripImplicitEndLine(code: string, implicitEnd: string): string {
  if (!implicitEnd) {
    return code;
  }
  const lines = code.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  if (lines.length && lines[lines.length - 1].trim().replace(/;$/, "").toUpperCase() === implicitEnd.toUpperCase()) {
    lines.pop();
  }
  return lines.join("\n");
}

function defaultReturnAssignment(name: string, declaration: string): string {
  const returnType = parseReturnType(declaration).toUpperCase();
  if (returnType === "BOOL") {
    return `${name} := FALSE;`;
  }
  if (/^(S?INT|D?INT|L?INT|U(S?INT|D?INT|L?INT)|REAL|LREAL|BYTE|WORD|DWORD|LWORD)$/.test(returnType)) {
    return `${name} := 0;`;
  }
  return "RETURN;";
}

function parseReturnType(declaration: string): string {
  const firstLine = declaration.split(/\r?\n/).find((line) => /\b(METHOD|PROPERTY|FUNCTION)\b/i.test(line)) ?? "";
  const match = firstLine.match(/:\s*([^;\n]+)$/);
  return match?.[1]?.trim() ?? "";
}

async function createInterfaceMemberStubs(sourceObjectRoot: string, interfaceNames: string[]): Promise<void> {
  if (interfaceNames.length === 0) {
    return;
  }
  const context = await loadDecodedProjectContext(sourceObjectRoot);
  const targetObject = resolveObjectTarget(context, sourceObjectRoot);
  const plcProjectPath = resolvePlcProjectForTarget(context, targetObject.sourceRoot);
  const createdMemberNames = new Set<string>();
  for (const interfaceName of interfaceNames) {
    const interfaceObject = objectsInProject(context, plcProjectPath).find(
      (object) => object.name.toLowerCase() === interfaceName.toLowerCase(),
    );
    if (!interfaceObject) {
      throw new Error(`Interface ${interfaceName} was not found in this decoded project.`);
    }
    for (const member of await interfaceMembers(context, interfaceObject)) {
      if (createdMemberNames.has(member.name.toLowerCase())) {
        continue;
      }
      createdMemberNames.add(member.name.toLowerCase());
      await createDecodedMember({
        targetPath: sourceObjectRoot,
        name: member.name,
        kind: member.kind,
        declarationCode: member.declarationCode,
        propertyAccessors: member.accessors,
      });
    }
  }
}

async function interfaceMembers(
  context: DecodedProjectContext,
  interfaceObject: DecodedObject,
): Promise<Array<{ name: string; kind: MemberItemKind; declarationCode: string; accessors?: PropertyAccessor[] }>> {
  const methods = new Map<string, string>();
  const properties = new Map<string, { declarationCode: string; accessors: Set<PropertyAccessor> }>();
  for (const item of interfaceObject.items) {
    const identifier = manifestItemIdentifier(item);
    const stPath = manifestItemStPath(item);
    if (!identifier || !stPath || item.part !== "declaration") {
      continue;
    }
    const parsed = parseIdentifier(identifier);
    const memberName = parsed.parts[1];
    if (!memberName) {
      continue;
    }
    const code = await fs.readFile(manifestPathToFsPath(context.structuredRoot, stPath), "utf8");
    const kind = item.kind ?? item.type;
    if (kind === "method") {
      methods.set(memberName, code);
    } else if (kind === "property_get" || kind === "property_set") {
      const existing = properties.get(memberName) ?? { declarationCode: code, accessors: new Set<PropertyAccessor>() };
      existing.accessors.add(kind === "property_get" ? "get" : "set");
      properties.set(memberName, existing);
    }
  }

  return [
    ...[...methods].map(([name, declarationCode]) => ({ name, kind: "method" as const, declarationCode })),
    ...[...properties].map(([name, property]) => ({
      name,
      kind: "property" as const,
      declarationCode: property.declarationCode,
      accessors: [...property.accessors],
    })),
  ];
}

async function insertMemberXml(nativeFile: string, object: DecodedObject, memberXml: string, memberName: string): Promise<void> {
  const xml = await fs.readFile(nativeFile, "utf8");
  const escapedName = escapeRegex(memberName);
  if (new RegExp(`<(?:Method|Property)\\b[^>]*\\bName="${escapedName}"`, "i").test(xml)) {
    throw new Error(`${object.name} already contains a native member named ${memberName}.`);
  }

  const eol = detectEol(xml);
  const closingTag = object.type === "interface" ? "</Itf>" : "</POU>";
  const index = xml.lastIndexOf(closingTag);
  if (index < 0) {
    throw new Error(`Could not find ${closingTag} in ${nativeFile}.`);
  }
  const normalizedMember = memberXml.replace(/\r?\n/g, eol);
  const prefix = xml[index - 1] === "\n" ? "" : eol;
  const updated = `${xml.slice(0, index)}${prefix}${normalizedMember}${eol}${xml.slice(index)}`;
  await fs.writeFile(nativeFile, updated, "utf8");
}

async function updatePlcProject(
  plcProjectPath: string,
  update: { compileIncludes?: string[]; folderIncludes?: string[] },
): Promise<void> {
  let xml = await fs.readFile(plcProjectPath, "utf8");
  for (const include of update.folderIncludes ?? []) {
    xml = ensureItemInclude(xml, "Folder", include, undefined);
  }
  for (const include of update.compileIncludes ?? []) {
    xml = ensureItemInclude(xml, "Compile", include, ["      <SubType>Code</SubType>"]);
  }
  await fs.writeFile(plcProjectPath, xml, "utf8");
}

function ensureItemInclude(xml: string, tag: "Compile" | "Folder", include: string, bodyLines: string[] | undefined): string {
  if (hasItemInclude(xml, tag, include)) {
    return xml;
  }

  const eol = detectEol(xml);
  const entry = bodyLines
    ? [`    <${tag} Include="${xmlAttr(include)}">`, ...bodyLines, `    </${tag}>`].join(eol)
    : `    <${tag} Include="${xmlAttr(include)}" />`;
  const itemGroup = findItemGroup(xml, tag);
  if (itemGroup) {
    return `${xml.slice(0, itemGroup.closeIndex)}${entry}${eol}${xml.slice(itemGroup.closeIndex)}`;
  }

  const projectCloseIndex = xml.lastIndexOf("</Project>");
  if (projectCloseIndex < 0) {
    throw new Error("The PLC project file does not contain a closing </Project> tag.");
  }
  const itemGroupXml = `  <ItemGroup>${eol}${entry}${eol}  </ItemGroup>${eol}`;
  return `${xml.slice(0, projectCloseIndex)}${itemGroupXml}${xml.slice(projectCloseIndex)}`;
}

function hasItemInclude(xml: string, tag: string, include: string): boolean {
  const escapedTag = escapeRegex(tag);
  const includePattern = escapeRegex(include).replace(/\\\\/g, "[\\\\/]");
  return new RegExp(`<${escapedTag}\\b[^>]*\\bInclude="${includePattern}"`, "i").test(xml);
}

function findItemGroup(xml: string, tag: string): { closeIndex: number } | undefined {
  const itemGroupPattern = /<ItemGroup\b[^>]*>[\s\S]*?<\/ItemGroup>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemGroupPattern.exec(xml)) !== null) {
    if (new RegExp(`<${escapeRegex(tag)}\\b`, "i").test(match[0])) {
      const closeRelative = match[0].lastIndexOf("</ItemGroup>");
      return { closeIndex: match.index + closeRelative };
    }
  }
  return undefined;
}

function projectFolderIncludes(plcProjectPath: string, nativeFolder: string): string[] {
  const projectDirectory = path.dirname(plcProjectPath);
  const relative = path.relative(projectDirectory, nativeFolder);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return [];
  }
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("\\"));
}

function projectRelativePath(plcProjectPath: string, nativePath: string): string {
  const relative = path.relative(path.dirname(plcProjectPath), nativePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${nativePath} is outside ${path.dirname(plcProjectPath)}.`);
  }
  return relative.split(path.sep).join("\\");
}

function manifestItem(options: {
  structuredRoot: string;
  sourceFile: string;
  nativePath: string;
  identifier: string;
  objectId: string;
  kind: string;
  part: string;
  grammarRule: string;
  implicitEnd: string;
  code: string;
}): BlarkManifestItem {
  const stPath = relativeManifestPath(options.structuredRoot, options.sourceFile);
  return {
    id: `${options.nativePath}::${options.identifier}`,
    identifier: options.identifier,
    nativeIdentifier: options.identifier,
    object_identifier: options.objectId,
    objectId: options.objectId,
    type: options.kind,
    kind: options.kind,
    part: options.part,
    grammar_rule: options.grammarRule,
    grammarRule: options.grammarRule,
    implicit_end: options.implicitEnd,
    source_path: options.nativePath,
    nativePath: options.nativePath,
    st_path: stPath,
    path: stPath,
    contentHash: contentHash(options.code),
  };
}

async function writeManifest(context: DecodedProjectContext): Promise<void> {
  await fs.writeFile(manifestPath(context.structuredRoot), `${JSON.stringify(context.manifest, null, 2)}\n`, "utf8");
}

async function refreshMetadata(context: DecodedProjectContext): Promise<void> {
  const manifest = await loadManifest(context.structuredRoot);
  const rebuilt = await rebuildIndexAndDiagnostics(context.structuredRoot, manifest);
  await writeMetadataJson(context.structuredRoot, "index.json", rebuilt.index);
  await writeMetadataJson(context.structuredRoot, "diagnostics.json", rebuilt.diagnostics);
}

function relativeManifestPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function parseIdentifier(identifier: string): { parts: string[]; part?: string } {
  const [name, part] = identifier.split("/");
  return {
    parts: name ? name.split(".") : [],
    part,
  };
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function xmlDocument(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n${inner}\r\n</TcPlcObject>\r\n`;
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function xmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function guid(): string {
  return `{${crypto.randomUUID()}}`;
}

function detectEol(contents: string): string {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
