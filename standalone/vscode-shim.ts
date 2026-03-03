/**
 * Minimal VS Code API shim for standalone mode.
 *
 * The extension's src/ modules import `vscode` for type annotations and a few
 * runtime calls. This shim provides safe no-op values so those modules can be
 * bundled and executed outside VS Code.
 *
 * Known runtime references that hit this shim:
 * - fileWatcher.ts line 160: `vscode.window.activeTerminal` → resolves to undefined
 * - assetLoader.ts: `vscode.Webview` used only as parameter type (duck-typed)
 */

export const window = {
	activeTerminal: undefined as unknown,
	terminals: [] as unknown[],
	createTerminal: () => { throw new Error('VS Code terminals not available in standalone mode'); },
	onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
	onDidCloseTerminal: () => ({ dispose: () => {} }),
};

export const workspace = {
	workspaceFolders: undefined as unknown,
};

export const env = {
	openExternal: () => Promise.resolve(false),
};

// URI stubs (never actually called in standalone paths)
export const Uri = {
	joinPath: (..._args: unknown[]) => ({ fsPath: '' }),
	file: (_path: string) => ({ fsPath: _path }),
};
