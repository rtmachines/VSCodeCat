import * as vscode from "vscode";

export async function withNotificationProgress<T>(
  title: string,
  task: (token: vscode.CancellationToken) => Thenable<T> | Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (_progress, token) => task(token),
  );
}
