import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GameTree } from "./gameTree";
import { TreeAction } from "./treeDiff";
import { TreeState, TreeStateIo } from "./treeState";
import { VerdeBackend } from "./backend";

/** Debounce for game.json change events before diffing. */
const DEBOUNCE_MS = 400;

/** Delay before retrying a failed delivery while a client is connected. */
const RETRY_DELAY_MS = 5000;

/**
 * Keeps game.json in the workspace synchronized with the Roblox instance
 * tree: watches the document, diffs it against the persisted baseline and
 * delivers ordered tree actions to the plugin; tree exports from the plugin
 * are merged back over pending edits and rewrite both documents.
 *
 * The delivery queue is at-least-once: a batch is only dropped after the
 * plugin acknowledges it, and re-delivery is safe because updates carry
 * full property maps and creates are idempotence-guarded plugin-side.
 */
export class GameJsonSync implements vscode.Disposable {
	private readonly backend: VerdeBackend;
	private readonly outputChannel: vscode.OutputChannel;
	private readonly state: TreeState;
	private readonly gameJsonPath: string;
	private readonly snapshotPath: string;
	private readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
	private watcher: vscode.FileSystemWatcher | null = null;
	private queue: TreeAction[] = [];
	private delivering = false;
	private debounceTimer: NodeJS.Timeout | null = null;
	private retryTimer: NodeJS.Timeout | null = null;
	private disposed = false;

	constructor(backend: VerdeBackend, outputChannel: vscode.OutputChannel) {
		this.backend = backend;
		this.outputChannel = outputChannel;

		this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const root = this.workspaceFolder?.uri.fsPath;
		if (!root) {
			this.log("no workspace folder open; game.json sync is inactive");
			this.gameJsonPath = "";
			this.snapshotPath = "";
			this.state = new TreeState({
				readTarget: () => null,
				writeTarget: () => {},
				readSnapshot: () => null,
				writeSnapshot: () => {},
				queueActions: () => {},
			});
			return;
		}

		const relativePath = vscode.workspace
			.getConfiguration("verde")
			.get<string>("gameJsonPath", "game.json");
		this.gameJsonPath = path.isAbsolute(relativePath)
			? relativePath
			: path.join(root, relativePath);
		this.snapshotPath = path.join(root, ".verde", "snapshot.json");

		this.state = new TreeState(this.makeIo());
		try {
			this.state.load();
		} catch (err) {
			this.log(`failed to initialise game.json state: ${this.errorText(err)}`);
		}

		const pattern = new vscode.RelativePattern(
			this.workspaceFolder,
			path.isAbsolute(relativePath) ? path.relative(root, relativePath) || path.basename(relativePath) : relativePath,
		);
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
		this.watcher.onDidChange(() => this.scheduleApply());
		this.watcher.onDidCreate(() => this.scheduleApply());
		this.watcher.onDidDelete(() => this.scheduleApply());

		this.log(`watching ${path.basename(this.gameJsonPath)} (baseline at ${path.relative(root, this.snapshotPath)})`);
	}

	/** Requests a fresh tree export from the plugin and ingests it. */
	public async exportFromStudio(): Promise<void> {
		const tree = await this.backend.requestGameTree();
		if (!tree) {
			this.log("game tree export requested without a connected plugin");
			return;
		}
		this.ingestExport(tree);
	}

	/** Called when a plugin client connects: refresh the document from Studio. */
	public handleClientConnected(): void {
		void this.exportFromStudio();
	}

	/** Called for every game_tree push from the plugin. */
	public ingestExport(tree: GameTree): void {
		try {
			const pending = this.state.ingestExport(tree, this.queue);
			this.log(`ingested tree export (${pending} pending action(s) queued for Studio)`);
		} catch (err) {
			this.log(`failed to ingest tree export: ${this.errorText(err)}`);
			return;
		}
		void this.deliverQueue();
	}

	public dispose(): void {
		this.disposed = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.watcher) {
			this.watcher.dispose();
			this.watcher = null;
		}
	}

	private makeIo(): TreeStateIo {
		return {
			readTarget: () => this.readFileOrNull(this.gameJsonPath),
			writeTarget: (text) => this.writeAtomically(this.gameJsonPath, text),
			readSnapshot: () => this.readFileOrNull(this.snapshotPath),
			writeSnapshot: (text) => this.writeAtomically(this.snapshotPath, text),
			queueActions: (actions) => {
				this.queue.push(...actions);
			},
		};
	}

	private scheduleApply(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.applyDocument();
		}, DEBOUNCE_MS);
	}

	private applyDocument(): void {
		const text = this.readFileOrNull(this.gameJsonPath);
		if (text === null) {
			// A deleted document is recreated from the snapshot on load; a
			// mid-session delete is ignored until it reappears.
			return;
		}

		try {
			const queued = this.state.handleTargetChanged(text);
			if (queued > 0) {
				this.log(`game.json changed: queued ${queued} action(s) for Studio`);
				void this.deliverQueue();
			}
		} catch (err) {
			// Invalid JSON is never fatal: warn and keep the previous baseline
			// until the next save.
			this.log(`ignoring unreadable game.json: ${this.errorText(err)}`);
		}
	}

	private async deliverQueue(): Promise<void> {
		if (this.delivering || this.disposed || this.queue.length === 0) {
			return;
		}
		if (!this.backend.hasConnectedClient()) {
			// The queue survives; it is delivered once a plugin reconnects
			// (its export ingest re-triggers delivery).
			this.log("actions queued while no plugin is connected");
			return;
		}

		this.delivering = true;
		try {
			while (!this.disposed && this.queue.length > 0 && this.backend.hasConnectedClient()) {
				const batch = [...this.queue];
				const result = await this.backend.applyTreeActions(batch);

				if (!result.success) {
					this.log(`delivery failed (${result.error}); will retry in ${RETRY_DELAY_MS / 1000}s`);
					this.scheduleRetry();
					return;
				}

				this.queue.splice(0, batch.length);
				const summary = result.data as { applied?: number; failed?: string[] } | undefined;
				if (summary && Array.isArray(summary.failed) && summary.failed.length > 0) {
					this.log(`applied ${summary.applied ?? batch.length} action(s); ${summary.failed.length} failed: ${summary.failed.join("; ")}`);
				} else {
					this.log(`applied ${batch.length} action(s)`);
				}
			}
		} finally {
			this.delivering = false;
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer) {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.deliverQueue();
		}, RETRY_DELAY_MS);
	}

	private readFileOrNull(file: string): string | null {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return null;
		}
	}

	/** Writes via a temp file and rename so watchers never see partials. */
	private writeAtomically(file: string, text: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.tmp`;
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, file);
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[verde/game.json] ${message}`);
	}

	private errorText(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
