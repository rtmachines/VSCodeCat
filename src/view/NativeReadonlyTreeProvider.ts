import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { manifestPath } from "../blark/Manifest";
import { toNativeReadonlyUri } from "./NativeReadonlyFileSystemProvider";

type NodeKind = "root" | "directory" | "file";

export interface NativeTreeNode {
  kind: NodeKind;
  label: string;
  fsPath: string;
}

async function existsDirectory(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

export class NativeReadonlyTreeProvider implements vscode.TreeDataProvider<NativeTreeNode> {
  private readonly emitter = new vscode.EventEmitter<NativeTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: NativeTreeNode): vscode.TreeItem {
    const collapsibleState =
      element.kind === "file" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.contextValue = element.kind === "file" ? "blarkNativeReadonlyFile" : "blarkNativeReadonlyDirectory";
    item.tooltip = element.fsPath;
    item.iconPath = new vscode.ThemeIcon(element.kind === "file" ? "file" : "folder");
    if (element.kind === "file") {
      item.resourceUri = toNativeReadonlyUri(element.fsPath);
      item.command = {
        command: "twincatBlark.openNativeReadonly",
        title: "Open Read-only",
        arguments: [element.fsPath],
      };
    }
    return item;
  }

  async getChildren(element?: NativeTreeNode): Promise<NativeTreeNode[]> {
    if (!element) {
      const manifests = await vscode.workspace.findFiles("**/.blark/manifest.json", "**/{node_modules,.git,out}/**", 50);
      return manifests
        .map((uri) => path.dirname(path.dirname(uri.fsPath)))
        .filter((root, index, roots) => roots.indexOf(root) === index)
        .map((root) => ({
          kind: "root" as const,
          label: path.basename(root),
          fsPath: root,
        }));
    }

    if (element.kind === "file") {
      return [];
    }

    if (element.kind === "root") {
      const children: NativeTreeNode[] = [];
      const nativeDir = path.join(element.fsPath, "native");
      const metadataDir = path.dirname(manifestPath(element.fsPath));
      if (await existsDirectory(nativeDir)) {
        children.push({ kind: "directory", label: "native", fsPath: nativeDir });
      }
      if (await existsDirectory(metadataDir)) {
        children.push({ kind: "directory", label: ".blark", fsPath: metadataDir });
      }
      return children;
    }

    const entries = await fs.readdir(element.fsPath, { withFileTypes: true });
    return entries
      .map((entry) => ({
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        label: entry.name,
        fsPath: path.join(element.fsPath, entry.name),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
  }
}
