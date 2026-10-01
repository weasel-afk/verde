import { describe, expect, it } from "vitest";
import { GameTree, parseGameTree, serializeGameTree } from "../../src/gameTree";
import { TreeAction, TreeState, TreeStateIo } from "../../src/treeState";

/** In-memory implementation of the state IO. */
class MemoryIo implements TreeStateIo {
    public target: string | null = null;
    public snapshot: string | null = null;
    public queued: TreeAction[] = [];

    public readTarget(): string | null {
        return this.target;
    }
    public writeTarget(text: string): void {
        this.target = text;
    }
    public readSnapshot(): string | null {
        return this.snapshot;
    }
    public writeSnapshot(text: string): void {
        this.snapshot = text;
    }
    public queueActions(actions: TreeAction[]): void {
        this.queued.push(...actions);
    }
}

function parse(text: string | null): GameTree {
    if (text === null) {
        throw new Error("no document");
    }
    return parseGameTree(text);
}

/** A minimal export tree from the plugin. */
const EXPORT_TREE = parseGameTree(`{
    "formatVersion": 1,
    "className": "DataModel",
    "children": {
        "Workspace": {
            "children": { "Baseplate": { "className": "Part", "properties": { "Anchored": true } } }
        }
    }
}`);

describe("TreeState.load", () => {
    it("creates empty documents when neither exists", () => {
        const io = new MemoryIo();
        new TreeState(io).load();

        expect(io.target).not.toBeNull();
        expect(io.snapshot).toBe(io.target);
        expect(parse(io.target).children).toEqual({});
    });

    it("resumes from the snapshot and rewrites a missing game.json", () => {
        const io = new MemoryIo();
        new TreeState(io).load();
        io.target = serialize({ Workspace: {} });
        new TreeState(io).load();
        expect(io.target).not.toBeNull();

        // Deleting game.json again restores it from the snapshot.
        const keptSnapshot = io.snapshot;
        io.target = null;
        new TreeState(io).load();
        expect(io.target).toBe(keptSnapshot);
    });

    it("treats a document without a snapshot as uninitialised", () => {
        const io = new MemoryIo();
        io.target = serialize({ Workspace: { children: { Thing: {} } } });

        const state = new TreeState(io);
        state.load();

        expect(state.baselineInitialised).toBe(false);
        // Edits are held back until the first export.
        expect(state.handleTargetChanged(io.target!)).toBe(0);
        expect(io.queued).toEqual([]);
    });

    function serialize(children: Record<string, unknown>): string {
        return JSON.stringify(
            { formatVersion: 1, className: "DataModel", children },
            null,
            4,
        ) + "\n";
    }
});

describe("TreeState.handleTargetChanged", () => {
    it("queues actions and advances the baseline", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();

        const edited = serialize({
            Workspace: { children: { Baseplate: { className: "Part", properties: { Anchored: true } } } },
        });
        const queued = state.handleTargetChanged(edited);

        expect(queued).toBeGreaterThan(0);
        expect(io.queued).toHaveLength(queued);
        expect(io.queued[0].action).toBe("create");
        expect(io.snapshot).toBe(serializeGameTree(parseGameTree(edited)));
    });

    it("keeps the baseline when the diff is empty", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();

        const before = io.snapshot;
        // A removed top-level service produces no actions (suppressed
        // delete), and the baseline must not advance past it.
        expect(state.handleTargetChanged(serialize({}))).toBe(0);
        expect(io.snapshot).toBe(before);
    });

    it("throws on invalid JSON without touching state", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();
        const snapshotBefore = io.snapshot;

        expect(() => state.handleTargetChanged("{invalid")).toThrow();
        expect(io.snapshot).toBe(snapshotBefore);
        expect(io.queued).toEqual([]);
    });

    function serialize(children: Record<string, unknown>): string {
        return JSON.stringify(
            { formatVersion: 1, className: "DataModel", children },
            null,
            4,
        ) + "\n";
    }
});

describe("TreeState.ingestExport", () => {
    it("refreshes game.json and the snapshot from the export", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();

        const pending = state.ingestExport(EXPORT_TREE, []);

        expect(pending).toBe(0);
        expect(parse(io.target)).toEqual(EXPORT_TREE);
        expect(io.snapshot).toBe(io.target);
        expect(state.baselineInitialised).toBe(true);
    });

    it("merges pending edits so Studio converges onto the document", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();

        // The user adds a Folder; the edit is queued but not acknowledged
        // when the export arrives, so the caller passes the queue along.
        const edited = serialize({
            Workspace: { children: { Baseplate: { className: "Part" }, Folder: { className: "Folder" } } },
        });
        state.handleTargetChanged(edited);
        const unacked = [...io.queued];

        const pending = state.ingestExport(EXPORT_TREE, unacked);
        expect(pending).toBe(0);

        const document = parse(io.target);
        // The unacked create keeps the Folder in the merged document.
        expect(document.children?.Workspace?.children?.Folder?.className).toBe("Folder");
        // Export content is kept alongside the edit.
        expect(document.children?.Workspace?.children?.Baseplate?.className).toBe("Part");
        // Nothing new is queued: the create is already in the queue.
        expect(io.queued).toEqual(unacked);
    });

    it("suppresses deletes from a document predating the first export", () => {
        const io = new MemoryIo();
        io.target = serialize({ Workspace: {} });
        const state = new TreeState(io);
        state.load();
        expect(state.baselineInitialised).toBe(false);

        // The export does not contain Workspace, but the document predates
        // it: the removal must not be interpreted as a delete.
        const pending = state.ingestExport(EXPORT_TREE, []);

        expect(pending).toBe(0);
        expect(io.queued).toEqual([]);
        expect(state.baselineInitialised).toBe(true);
    });

    it("applies the unacked queue in delivery order", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();

        // An export establishes the baseline, then the user deletes the
        // Baseplate (queued, unacknowledged) and re-adds it (queued too).
        // Delivery order is delete then create, so Studio ends up with the
        // Baseplate — and the merged document must agree.
        state.ingestExport(EXPORT_TREE, []);
        state.handleTargetChanged(serialize({ Workspace: {} }));
        expect(io.queued.some((action) => action.action === "delete")).toBe(true);

        state.handleTargetChanged(serialize({
            Workspace: { children: { Baseplate: { className: "Part", properties: { Anchored: true } } } },
        }));
        const unacked = [...io.queued];

        const pending = state.ingestExport(EXPORT_TREE, unacked);
        expect(pending).toBe(0);

        const document = parse(io.target);
        expect(document.children?.Workspace?.children?.Baseplate).toBeDefined();
    });

    it("throws on an unreadable document without changing state files", () => {
        const io = new MemoryIo();
        const state = new TreeState(io);
        state.load();
        const targetBefore = io.target;
        const snapshotBefore = io.snapshot;

        io.target = "{invalid";
        expect(() => state.ingestExport(EXPORT_TREE, [])).toThrow();

        expect(io.target).toBe("{invalid");
        expect(io.snapshot).toBe(snapshotBefore);
        expect(targetBefore).not.toBeNull();
        expect(io.queued).toEqual([]);
    });

    function serialize(children: Record<string, unknown>): string {
        return JSON.stringify(
            { formatVersion: 1, className: "DataModel", children },
            null,
            4,
        ) + "\n";
    }
});
