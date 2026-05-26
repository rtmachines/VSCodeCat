export function projectDecodeArgs(
  inputPath: string,
  outputPath: string,
  overwrite: boolean,
): string[] {
  const args = ["project", "decode", inputPath, outputPath];
  if (overwrite) {
    args.push("--overwrite");
  }
  return args;
}

export function projectEncodeArgs(
  structuredRoot: string,
  outputPath: string,
  overwrite: boolean,
): string[] {
  const args = ["project", "encode", structuredRoot, outputPath];
  if (overwrite) {
    args.push("--overwrite");
  }
  return args;
}
