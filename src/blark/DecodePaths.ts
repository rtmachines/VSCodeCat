import * as path from "node:path";

export const supportedTwinCatExtensions = new Set([
  ".sln",
  ".tsproj",
  ".plcproj",
  ".tcpou",
  ".tcgvl",
  ".tcdut",
  ".tcio",
  ".tctto",
]);

const extensionPriority = new Map([
  [".sln", 0],
  [".tsproj", 1],
  [".plcproj", 2],
  [".tcpou", 3],
  [".tcgvl", 4],
  [".tcdut", 5],
  [".tcio", 6],
  [".tctto", 7],
]);

export function isSupportedTwinCatInput(filePath: string): boolean {
  return supportedTwinCatExtensions.has(path.extname(filePath).toLowerCase());
}

export function isSameOrInside(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function compareTwinCatInputs(left: string, right: string): number {
  const leftPriority = extensionPriority.get(path.extname(left).toLowerCase()) ?? 99;
  const rightPriority = extensionPriority.get(path.extname(right).toLowerCase()) ?? 99;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.localeCompare(right);
}

export function safeSiblingDecodeRoot(nativeRoot: string): string {
  return path.join(path.dirname(path.resolve(nativeRoot)), ".twincat-st");
}

export function decodeOutputPath(parentRoot: string, inputPath: string): string {
  return path.join(parentRoot, path.basename(inputPath, path.extname(inputPath)));
}

export function safeSuggestedDecodeOutputPath(inputPath: string, nativeRoot: string): string {
  return decodeOutputPath(safeSiblingDecodeRoot(nativeRoot), inputPath);
}
