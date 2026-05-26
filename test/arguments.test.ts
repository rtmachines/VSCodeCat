import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectDecodeArgs, projectEncodeArgs } from "../src/blark/arguments";

test("projectDecodeArgs appends overwrite only when requested", () => {
  assert.deepEqual(projectDecodeArgs("in.sln", "structured", false), ["project", "decode", "in.sln", "structured"]);
  assert.deepEqual(projectDecodeArgs("in.sln", "structured", true), [
    "project",
    "decode",
    "in.sln",
    "structured",
    "--overwrite",
  ]);
});

test("projectEncodeArgs appends overwrite only when requested", () => {
  assert.deepEqual(projectEncodeArgs("structured", "native-out", false), ["project", "encode", "structured", "native-out"]);
  assert.deepEqual(projectEncodeArgs("structured", "native-out", true), [
    "project",
    "encode",
    "structured",
    "native-out",
    "--overwrite",
  ]);
});
