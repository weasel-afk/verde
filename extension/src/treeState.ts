import { GameTree, cloneTree, emptyTree, parseGameTree, serializeGameTree, treesEqual } from "./gameTree";
import { TreeAction, applyActions, diffTrees } from "./treeDiff";

/**
 * Filesystem and queue access used by the tree state. Injected so the state
 * machine can run against in-memory fakes in tests.
 */
export interface TreeStateIo {
    /** Reads the game.json document text, or null when it does not exist. */
    readTarget(): string | null;
    /** Writes the game.json document text. */
    writeTarget(text: string): void;
    /** Reads the baseline snapshot text, or null when it does not exist. */
    readSnapshot(): string | null;
    /** Writes the baseline snapshot text. */
    writeSnapshot(text: string): void;
    /** Appends actions to the delivery queue for the plugin. */
    queueActions(actions: TreeAction[]): void;
}

/**
 * Manages the game tree baseline: the last known state of the game that
 * game.json edits are diffed against.
 *
 * The baseline persists to `.verde/snapshot.json` so edits made while the
 * extension is closed are still applied on the next start.
 */
export class TreeState {
    private readonly io: TreeStateIo;
    private baseline: GameTree = emptyTree();
    private initialised: boolean = true;

    constructor(io: TreeStateIo) {
        this.io = io;
    }

    /** Whether the baseline reflects a Studio export. While false, deletes
     * are unavailable: the existing document cannot safely be interpreted
     * as removals until a real tree has been seen. */
    public get baselineInitialised(): boolean {
        return this.initialised;
    }

    /**
     * Initialises the state from disk, creating the game.json document and
     * baseline snapshot when absent.
     */
    public load(): void {
        const snapshotText = this.io.readSnapshot();

        if (snapshotText !== null) {
            // Resume from the persisted baseline.
            this.baseline = parseGameTree(snapshotText);
            if (this.io.readTarget() === null) {
                this.io.writeTarget(serializeGameTree(this.baseline));
            }
            this.initialised = true;
            return;
        }

        const targetText = this.io.readTarget();
        if (targetText !== null) {
            // A document exists without a snapshot, so deletes are unavailable
            // until the plugin exports a tree to establish a baseline.
            this.baseline = emptyTree();
            this.initialised = false;
            return;
        }

        const empty = emptyTree();
        this.baseline = cloneTree(empty);
        this.initialised = true;
        this.io.writeSnapshot(serializeGameTree(empty));
        this.io.writeTarget(serializeGameTree(empty));
    }

    /**
     * Handles a game.json change: diffs the document against the baseline,
     * queues the resulting actions for the plugin, and advances the baseline.
     *
     * Returns the number of queued actions. Parse errors are thrown to the
     * caller, which keeps the previous baseline.
     */
    public handleTargetChanged(text: string): number {
        // Without a Studio-derived baseline, the existing document cannot
        // safely be interpreted as a set of removals. The first export
        // merges it in ingestExport.
        if (!this.initialised) {
            return 0;
        }

        const target = parseGameTree(text);
        const actions = diffTrees(this.baseline, target);
        if (actions.length === 0) {
            // No actions does not imply the trees are equal (suppressed
            // top-level deletes, unmanaged property removals); the baseline
            // is only advanced when actions are actually queued.
            return 0;
        }

        this.io.queueActions(actions);
        this.io.writeSnapshot(serializeGameTree(target));
        this.baseline = target;

        return actions.length;
    }

    /**
     * Ingests a tree export from the Studio plugin, merging the queued
     * delivery actions and any pending game.json edits on top of it so
     * Studio converges onto the edited document, then refreshes both
     * game.json and the snapshot.
     *
     * Actions already queued but not yet acknowledged by the plugin are
     * applied to the merged document in queue order ahead of the newly
     * pending edits, so the document matches what Studio will look like
     * once the whole queue has been delivered.
     *
     * Returns the number of newly queued actions. Parse errors are thrown
     * to the caller, leaving all state untouched.
     */
    public ingestExport(exportTree: GameTree, unacked: TreeAction[]): number {
        const targetText = this.io.readTarget();
        if (targetText === null) {
            throw new Error("game.json disappeared while merging a tree export");
        }
        const target = parseGameTree(targetText);

        // Pending edits made against the previous baseline. Without an
        // initialised baseline the export itself is the reference, and
        // deletes are suppressed: the document predates the first export.
        const reference = this.initialised ? this.baseline : exportTree;
        let pending = diffTrees(reference, target);
        if (!this.initialised) {
            pending = pending.filter((action) => action.action !== "delete");
        }

        // The export becomes the new baseline, with the queued actions and
        // pending edits layered on top in delivery order. Actions for paths
        // absent from the export are tolerated as no-ops.
        const merged = cloneTree(exportTree);
        applyActions(merged, [...unacked, ...pending]);

        if (pending.length > 0) {
            this.io.queueActions(pending);
        }

        const mergedText = serializeGameTree(merged);
        this.io.writeTarget(mergedText);
        this.io.writeSnapshot(mergedText);
        this.baseline = merged;
        this.initialised = true;

        return pending.length;
    }

    /** Structural equality of the baseline against another tree. */
    public baselineEquals(tree: GameTree): boolean {
        return treesEqual(this.baseline, tree);
    }
}
