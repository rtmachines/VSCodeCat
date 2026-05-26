import { strict as assert } from "node:assert";
import * as path from "node:path";
import { test } from "node:test";
import {
  compareTwinCatInputs,
  decodeOutputPath,
  isSameOrInside,
  isSupportedTwinCatInput,
  safeSuggestedDecodeOutputPath,
  safeSiblingDecodeRoot,
} from "../src/blark/DecodePaths";

test("isSupportedTwinCatInput accepts blark project inputs case-insensitively", () => {
  assert.equal(isSupportedTwinCatInput("Project.sln"), true);
  assert.equal(isSupportedTwinCatInput("MAIN.TcPOU"), true);
  assert.equal(isSupportedTwinCatInput("notes.txt"), false);
});

test("isSameOrInside identifies recursive decode output paths", () => {
  const root = path.join("C:", "work", "project");
  assert.equal(isSameOrInside(path.join(root, "decoded"), root), true);
  assert.equal(isSameOrInside(root, root), true);
  assert.equal(isSameOrInside(path.join("C:", "work", ".twincat-st", "project"), root), false);
});

test("safeSuggestedDecodeOutputPath stays outside the native TwinCAT root", () => {
  const nativeRoot = path.join("C:", "Users", "rato", "Downloads", "tc-arch-coose-v9");
  const inputPath = path.join(nativeRoot, "k7.sln");
  const suggested = safeSuggestedDecodeOutputPath(inputPath, nativeRoot);
  assert.equal(suggested, path.join("C:", "Users", "rato", "Downloads", ".twincat-st", "k7"));
  assert.equal(isSameOrInside(suggested, nativeRoot), false);
  assert.equal(safeSiblingDecodeRoot(nativeRoot), path.join("C:", "Users", "rato", "Downloads", ".twincat-st"));
  assert.equal(decodeOutputPath(path.join("C:", "out"), inputPath), path.join("C:", "out", "k7"));
});

test("compareTwinCatInputs prefers full project files", () => {
  const sorted = ["z.TcPOU", "a.plcproj", "b.sln", "a.tsproj"].sort(compareTwinCatInputs);
  assert.deepEqual(sorted, ["b.sln", "a.tsproj", "a.plcproj", "z.TcPOU"]);
});
