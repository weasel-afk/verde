import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GameTree, parseGameTree, serializeGameTree } from "./gameTree";
import { TreeAction } from "./treeDiff";
import { TreeState, TreeStateIo } from "./treeState";
import { applyValidatedActions } from "./treeOps";
import { VerdeBackend } from "./backend";

/** Debounce for game.json change events before diffing. */
const DEBOUNCE_MS = 400;

/** Delay before retrying a failed delivery while a client is connected. */
const RETRY_DELAY_MS = 5000;

/** Aggregate result of draining the delivery queue. */
export type QueueDeliverySummary = {
    /** Whether at least one batch was acknowledged by the plugin. */
    delivered: boolean;
    /** Summed plugin-acknowledged action counts. */
    applied: number;
    /** Concatenated per-action failures reported by the plugin. */
    failed: string[];
    /** Actions still queued after this drain. */
    remaining: number;
    /** Last delivery error; a retry is scheduled when set. */
    error?: string;
};

/** Outcome of a synchronous (MCP-initiated) apply. Validation errors throw. */
export type TreeApplyResult =
    | { status: "applied"; applied: number; failed: string[]; queuedBefore: number }
    | { status: "queued-offline"; queued: number }
    | { status: "queued-retry"; queued: number; error: string }
    | { status: "no-change"; queued: number; baselineInitialised: boolean };

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
	private deliveryChain: Promise<QueueDeliverySummary> | null = null;
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

	/** Requests a fresh tree export from the plugin, ingests it and returns
	 * the merged tree (or null when no plugin replied). */
	public async exportFromStudio(): Promise<GameTree | null> {
		const tree = await this.backend.requestGameTree();
		if (!tree) {
			this.log("game tree export requested without a connected plugin");
			return null;
		}
		this.ingestExport(tree);
		return this.readCurrentTree();
	}

	/** Reads and parses the current game.json; null when absent, throws on
	 * parse errors. */
	public readCurrentTree(): GameTree | null {
		const text = this.readFileOrNull(this.gameJsonPath);
		if (text === null) {
			return null;
		}
		return parseGameTree(text);
	}

	/**
	 * Applies tree actions through the same machinery as a file edit, minus
	 * the watcher debounce: validates the batch (throws on the first invalid
	 * action), writes the new document atomically, enqueues the diff against
	 * the baseline and awaits delivery so the caller gets a real result.
	 */
	public async applyTreeActions(actions: TreeAction[]): Promise<TreeApplyResult> {
		const text = this.readFileOrNull(this.gameJsonPath);
		if (text === null) {
			throw new Error("game.json does not exist yet; connect the Studio plugin once or create the document first");
		}

		// Read, validate, write and enqueue synchronously: the extension host
		// is single-threaded, so concurrent callers cannot interleave here.
		const target = parseGameTree(text);
		const next = applyValidatedActions(target, actions);
		const nextText = serializeGameTree(next);
		this.writeAtomically(this.gameJsonPath, nextText);

		const queued = this.state.handleTargetChanged(nextText);
		if (queued === 0) {
			return { status: "no-change", queued: this.queue.length, baselineInitialised: this.state.baselineInitialised };
		}
		if (!this.backend.hasConnectedClient()) {
			this.log(`${queued} action(s) queued while no plugin is connected`);
			return { status: "queued-offline", queued: this.queue.length };
		}

		const queuedBefore = this.queue.length;
		const delivery = await this.flushQueue();
		if (delivery.delivered && delivery.error === undefined) {
			return { status: "applied", applied: delivery.applied, failed: delivery.failed, queuedBefore };
		}
		if (!this.backend.hasConnectedClient()) {
			return { status: "queued-offline", queued: this.queue.length };
		}
		return { status: "queued-retry", queued: this.queue.length, error: delivery.error ?? "delivery did not complete" };
	}

	/**
	 * Coalesces concurrent delivery attempts into one serialized drain: a
	 * caller that lands while a delivery is in flight awaits its result
	 * instead of silently no-op'ing.
	 */
	public flushQueue(): Promise<QueueDeliverySummary> {
		if (!this.deliveryChain) {
			this.deliveryChain = this.drainQueue().finally(() => {
				this.deliveryChain = null;
			});
		}
		return this.deliveryChain;
	}

	/** Actions queued for the plugin but not yet acknowledged. */
	public get pendingActionCount(): number {
		return this.queue.length;
	}

	/** Whether the baseline reflects a Studio export. */
	public get isBaselineInitialised(): boolean {
		return this.state.baselineInitialised;
	}

	/** Absolute path of the game tree document, or null without a workspace. */
	public get documentPath(): string | null {
		return this.gameJsonPath || null;
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
		void this.flushQueue();
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
				void this.flushQueue();
			}
		} catch (err) {
			// Invalid JSON is never fatal: warn and keep the previous baseline
			// until the next save.
			this.log(`ignoring unreadable game.json: ${this.errorText(err)}`);
		}
	}

	/** Delivers the queue to the plugin, aggregating acknowledged results. */
	private async drainQueue(): Promise<QueueDeliverySummary> {
		const summary: QueueDeliverySummary = { delivered: false, applied: 0, failed: [], remaining: 0 };

		if (this.delivering || this.disposed || this.queue.length === 0) {
			summary.remaining = this.queue.length;
			return summary;
		}
		if (!this.backend.hasConnectedClient()) {
			// The queue survives; it is delivered once a plugin reconnects
			// (its export ingest re-triggers delivery).
			this.log("actions queued while no plugin is connected");
			summary.remaining = this.queue.length;
			return summary;
		}

		this.delivering = true;
		try {
			while (!this.disposed && this.queue.length > 0 && this.backend.hasConnectedClient()) {
				const batch = [...this.queue];
				const result = await this.backend.applyTreeActions(batch);

				if (!result.success) {
					this.log(`delivery failed (${result.error}); will retry in ${RETRY_DELAY_MS / 1000}s`);
					this.scheduleRetry();
					summary.error = result.error;
					summary.remaining = this.queue.length;
					return summary;
				}

				this.queue.splice(0, batch.length);
				const resultSummary = result.data as { applied?: number; failed?: string[] } | undefined;
				summary.delivered = true;
				summary.applied += resultSummary?.applied ?? batch.length;
				if (resultSummary && Array.isArray(resultSummary.failed)) {
					summary.failed.push(...resultSummary.failed);
				}
				if (resultSummary && Array.isArray(resultSummary.failed) && resultSummary.failed.length > 0) {
					this.log(`applied ${resultSummary.applied ?? batch.length} action(s); ${resultSummary.failed.length} failed: ${resultSummary.failed.join("; ")}`);
				} else {
					this.log(`applied ${batch.length} action(s)`);
				}
			}
			summary.remaining = this.queue.length;
		} finally {
			this.delivering = false;
		}
		return summary;
	}

	private scheduleRetry(): void {
		if (this.retryTimer) {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.flushQueue();
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
