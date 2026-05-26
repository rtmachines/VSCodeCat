import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveBlarkExePath } from "../config";

export interface BlarkRunResult {
  stdout: string;
  stderr: string;
}

function quoteForLog(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export class BlarkProcess {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  async run(
    args: string[],
    token: vscode.CancellationToken,
    workspaceFolder?: string,
  ): Promise<BlarkRunResult> {
    const exePath = resolveBlarkExePath(this.context, workspaceFolder);
    this.output.appendLine("");
    this.output.appendLine(`> ${quoteForLog(exePath)} ${args.map(quoteForLog).join(" ")}`);

    return new Promise<BlarkRunResult>((resolve, reject) => {
      const child = spawn(exePath, args, {
        cwd: workspaceFolder ?? path.dirname(exePath),
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const cancellation = token.onCancellationRequested(() => {
        if (!child.killed) {
          child.kill();
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.output.append(text);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.output.append(text);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cancellation.dispose();
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        cancellation.dispose();
        if (token.isCancellationRequested) {
          reject(new Error("blark command was cancelled."));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `Process exited with code ${code}.`;
          reject(new Error(`blark failed${signal ? ` with signal ${signal}` : ""}: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
