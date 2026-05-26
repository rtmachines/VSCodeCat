import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createDecodedFolder,
  createDecodedMember,
  createDecodedProjectItem,
  listProjectInterfaces,
} from "../src/blark/DecodedProjectCreation";
import { contentHash } from "../src/blark/Manifest";

async function makeDecodedRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "twincat-blark-create-test-"));
  await fs.mkdir(path.join(root, ".blark"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "POUs", "MAIN"), { recursive: true });
  await fs.mkdir(path.join(root, "native", "POUs"), { recursive: true });

  const nativeMainDeclaration = "PROGRAM MAIN\nVAR\nEND_VAR";
  const mainDeclaration = `${nativeMainDeclaration}\nEND_PROGRAM`;
  const mainImplementation = "RETURN;";
  await fs.writeFile(path.join(root, "src", "POUs", "MAIN", "declaration.st"), mainDeclaration, "utf8");
  await fs.writeFile(path.join(root, "src", "POUs", "MAIN", "implementation.st"), mainImplementation, "utf8");
  await fs.writeFile(
    path.join(root, "native", "POUs", "MAIN.TcPOU"),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<TcPlcObject Version="1.1.0.1">',
      '  <POU Name="MAIN" Id="{11111111-1111-1111-1111-111111111111}">',
      `    <Declaration><![CDATA[${nativeMainDeclaration}]]></Declaration>`,
      "    <Implementation>",
      `      <ST><![CDATA[${mainImplementation}]]></ST>`,
      "    </Implementation>",
      "  </POU>",
      "</TcPlcObject>",
      "",
    ].join("\r\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "native", "Project.plcproj"),
    [
      '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      "  <PropertyGroup>",
      "    <Name>Project</Name>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Include="POUs\\MAIN.TcPOU">',
      "      <SubType>Code</SubType>",
      "    </Compile>",
      "  </ItemGroup>",
      "  <ItemGroup>",
      '    <Folder Include="POUs" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\r\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, ".blark", "manifest.json"),
    JSON.stringify(
      {
        format: "blark.twincat.project",
        version: 2,
        native_root: "native",
        nativeRoot: "native",
        source_root: "src",
        sourceRoot: "src",
        st_root: "src",
        native_entry: "Project.plcproj",
        nativeEntry: "Project.plcproj",
        input_path: path.join(root, "native", "Project.plcproj"),
        items: [
          {
            id: "POUs/MAIN.TcPOU::MAIN/declaration",
            identifier: "MAIN/declaration",
            nativeIdentifier: "MAIN/declaration",
            object_identifier: "MAIN",
            objectId: "MAIN",
            type: "program",
            kind: "program",
            part: "declaration",
            grammar_rule: "program_declaration",
            grammarRule: "program_declaration",
            implicit_end: "END_PROGRAM",
            source_path: "POUs/MAIN.TcPOU",
            nativePath: "POUs/MAIN.TcPOU",
            st_path: "src/POUs/MAIN/declaration.st",
            path: "src/POUs/MAIN/declaration.st",
            contentHash: contentHash(mainDeclaration),
          },
          {
            id: "POUs/MAIN.TcPOU::MAIN/implementation",
            identifier: "MAIN/implementation",
            nativeIdentifier: "MAIN/implementation",
            object_identifier: "MAIN",
            objectId: "MAIN",
            type: "program",
            kind: "program",
            part: "implementation",
            grammar_rule: "statement_list",
            grammarRule: "statement_list",
            implicit_end: "",
            source_path: "POUs/MAIN.TcPOU",
            nativePath: "POUs/MAIN.TcPOU",
            st_path: "src/POUs/MAIN/implementation.st",
            path: "src/POUs/MAIN/implementation.st",
            contentHash: contentHash(mainImplementation),
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return root;
}

test("createDecodedProjectItem creates function block source, native XML, project entry, and manifest items", async () => {
  const root = await makeDecodedRoot();
  await createDecodedProjectItem({
    targetPath: path.join(root, "src", "POUs"),
    name: "FB_New",
    kind: "functionBlock",
    functionBlockVariant: "normal",
  });

  const declaration = await fs.readFile(path.join(root, "src", "POUs", "FB_New", "declaration.st"), "utf8");
  assert.match(declaration, /FUNCTION_BLOCK FB_New/);
  assert.ok(declaration.endsWith("END_FUNCTION_BLOCK"));

  const native = await fs.readFile(path.join(root, "native", "POUs", "FB_New.TcPOU"), "utf8");
  assert.match(native, /<POU Name="FB_New"/);

  const plcproj = await fs.readFile(path.join(root, "native", "Project.plcproj"), "utf8");
  assert.match(plcproj, /Compile Include="POUs\\FB_New\.TcPOU"/);

  const manifest = JSON.parse(await fs.readFile(path.join(root, ".blark", "manifest.json"), "utf8"));
  assert.ok(manifest.items.some((item: { identifier: string }) => item.identifier === "FB_New/declaration"));
  assert.ok(manifest.items.some((item: { identifier: string }) => item.identifier === "FB_New/implementation"));

  await assert.rejects(
    () =>
      createDecodedProjectItem({
        targetPath: path.join(root, "src", "POUs"),
        name: "FB_New",
        kind: "functionBlock",
      }),
    /already exists/,
  );
});

test("createDecodedFolder adds matching source/native folders and plcproj Folder includes", async () => {
  const root = await makeDecodedRoot();
  await createDecodedFolder({
    targetPath: path.join(root, "src"),
    name: "Utilities",
  });

  assert.equal((await fs.stat(path.join(root, "src", "Utilities"))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, "native", "Utilities"))).isDirectory(), true);
  const plcproj = await fs.readFile(path.join(root, "native", "Project.plcproj"), "utf8");
  assert.match(plcproj, /Folder Include="Utilities"/);
});

test("createDecodedMember validates object targets and creates function block methods", async () => {
  const root = await makeDecodedRoot();
  await createDecodedProjectItem({
    targetPath: path.join(root, "src", "POUs"),
    name: "FB_WithMethod",
    kind: "functionBlock",
  });

  await createDecodedMember({
    targetPath: path.join(root, "src", "POUs", "FB_WithMethod"),
    name: "DoWork",
    kind: "method",
  });

  const methodDeclaration = await fs.readFile(
    path.join(root, "src", "POUs", "FB_WithMethod", "methods", "DoWork", "declaration.st"),
    "utf8",
  );
  assert.match(methodDeclaration, /METHOD DoWork : BOOL/);
  assert.ok(methodDeclaration.endsWith("END_METHOD"));

  const native = await fs.readFile(path.join(root, "native", "POUs", "FB_WithMethod.TcPOU"), "utf8");
  assert.match(native, /<Method Name="DoWork"/);

  await assert.rejects(
    () =>
      createDecodedMember({
        targetPath: path.join(root, "src", "POUs", "MAIN"),
        name: "Invalid",
        kind: "method",
      }),
    /cannot contain methods or properties/,
  );
});

test("implementing function block can pick project interfaces and scaffold members", async () => {
  const root = await makeDecodedRoot();
  await createDecodedProjectItem({
    targetPath: path.join(root, "src"),
    name: "I_Device",
    kind: "interface",
  });
  await createDecodedMember({
    targetPath: path.join(root, "src", "Interfaces", "I_Device"),
    name: "Run",
    kind: "method",
  });

  assert.deepEqual(await listProjectInterfaces(path.join(root, "src")), ["I_Device"]);

  await createDecodedProjectItem({
    targetPath: path.join(root, "src"),
    name: "FB_Device",
    kind: "functionBlock",
    functionBlockVariant: "implements",
    implementedInterfaces: ["I_Device"],
  });

  const declaration = await fs.readFile(path.join(root, "src", "POUs", "FB_Device", "declaration.st"), "utf8");
  assert.match(declaration, /FUNCTION_BLOCK FB_Device IMPLEMENTS I_Device/);
  const stub = await fs.readFile(
    path.join(root, "src", "POUs", "FB_Device", "methods", "Run", "declaration.st"),
    "utf8",
  );
  assert.match(stub, /METHOD Run : BOOL/);
  assert.ok(stub.endsWith("END_METHOD"));
});
