import { describe, expect, it } from "vitest";
import { GameTree, parseGameTree, treesEqual } from "../../src/gameTree";
import { TreeAction, applyActions } from "../../src/treeDiff";
import { applyValidatedActions, pruneTree, subtreeAt, summarizeTree } from "../../src/treeOps";

/** Builds a game tree from a children JSON fragment. */
function tree(children: string): GameTree {
    return parseGameTree(`{"formatVersion":1,"className":"DataModel","children":${children}}`);
}

const base = () =>
    tree(`{"Workspace":{"children":{"Baseplate":{"className":"Part","properties":{"Anchored":true,"Size":{"type":"Vector3","x":512,"y":1,"z":512}}}}},"Lighting":{"properties":{"Brightness":2}}}`);

describe("subtreeAt", () => {
    it("empty path resolves the root", () => {
        const current = base();
        expect(subtreeAt(current, [])).toBe(current);
    });

    it("resolves a nested node", () => {
        const part = subtreeAt(base(), ["Workspace", "Baseplate"]);
        expect(part?.className).toBe("Part");
        expect(part?.properties?.Anchored).toBe(true);
    });

    it("returns undefined on a miss at any depth", () => {
        expect(subtreeAt(base(), ["Nope"])).toBeUndefined();
        expect(subtreeAt(base(), ["Workspace", "Nope"])).toBeUndefined();
        expect(subtreeAt(base(), ["Workspace", "Baseplate", "Deeper"])).toBeUndefined();
    });
});

describe("summarizeTree", () => {
    it("summarizes names, classes and child counts", () => {
        const summary = summarizeTree(base());
        expect(summary.name).toBe("DataModel");
        expect(summary.childCount).toBe(2);
        expect(Object.keys(summary.children ?? {})).toEqual(["Lighting", "Workspace"]);

        const workspace = summary.children?.Workspace;
        expect(workspace?.className).toBe("Workspace");
        expect(workspace?.childCount).toBe(1);
        expect(workspace?.children?.Baseplate?.className).toBe("Part");
        expect(workspace?.children?.Baseplate?.childCount).toBe(0);
    });

    it("className falls back to the keyed name", () => {
        // Lighting has no explicit className; the key is the class.
        expect(summarizeTree(base()).children?.Lighting?.className).toBe("Lighting");
    });

    it("maxDepth prunes and marks truncated", () => {
        const summary = summarizeTree(base(), 1);
        expect(summary.children).toBeDefined();
        expect(summary.children?.Workspace?.childCount).toBe(1);
        expect(summary.children?.Workspace?.children).toBeUndefined();
        expect(summary.children?.Workspace?.truncated).toBe(true);
        // Leaf nodes are never marked truncated.
        expect(summary.children?.Lighting?.truncated).toBeUndefined();
    });

    it("empty tree yields an empty root summary", () => {
        const summary = summarizeTree(tree(`{}`));
        expect(summary.childCount).toBe(0);
        expect(summary.children).toBeUndefined();
    });
});

describe("pruneTree", () => {
    it("keeps nodes within maxDepth and drops deeper ones", () => {
        const pruned = pruneTree(base(), 1);
        expect(Object.keys(pruned.children ?? {})).toHaveLength(2);
        expect(pruned.children?.Workspace?.children).toBeUndefined();
    });

    it("shares no references with the input", () => {
        const current = base();
        const pruned = pruneTree(current, 2);
        expect(pruned).not.toBe(current);
        expect(pruned.children?.Workspace).not.toBe(current.children?.Workspace);
    });
});

describe("applyValidatedActions", () => {
    it("creates nested nodes from a parents-first batch", () => {
        const actions: TreeAction[] = [
            { action: "create", path: ["Workspace", "Folder"], className: "Folder" },
            { action: "create", path: ["Workspace", "Folder", "Part"], className: "Part", properties: { Anchored: true } },
        ];
        const next = applyValidatedActions(base(), actions);
        expect(subtreeAt(next, ["Workspace", "Folder", "Part"])?.properties?.Anchored).toBe(true);
    });

    it("create on an existing name replaces the node wholesale", () => {
        const actions: TreeAction[] = [
            { action: "create", path: ["Workspace", "Baseplate"], className: "Part", properties: { Anchored: false } },
        ];
        const next = applyValidatedActions(base(), actions);
        const part = subtreeAt(next, ["Workspace", "Baseplate"]);
        expect(part?.properties).toEqual({ Anchored: false });
    });

    it("update replaces the node's whole property map", () => {
        const actions: TreeAction[] = [
            { action: "update", path: ["Workspace", "Baseplate"], properties: { Anchored: false } },
        ];
        const next = applyValidatedActions(base(), actions);
        expect(subtreeAt(next, ["Workspace", "Baseplate"])?.properties).toEqual({ Anchored: false });
    });

    it("deletes a node", () => {
        const next = applyValidatedActions(base(), [{ action: "delete", path: ["Workspace", "Baseplate"] }]);
        expect(subtreeAt(next, ["Workspace", "Baseplate"])).toBeUndefined();
        expect(subtreeAt(next, ["Workspace"])).toBeDefined();
    });

    it("matches the applyActions oracle on valid batches", () => {
        const actions: TreeAction[] = [
            { action: "create", path: ["Workspace", "Folder"], className: "Folder" },
            { action: "update", path: ["Lighting"], properties: { Brightness: 3 } },
            { action: "delete", path: ["Workspace", "Baseplate"] },
        ];
        const oracle = base();
        applyActions(oracle, actions);
        expect(treesEqual(applyValidatedActions(base(), actions), oracle)).toBe(true);
    });

    it("throws on create with a missing parent", () => {
        expect(() =>
            applyValidatedActions(base(), [{ action: "create", path: ["Workspace", "Missing", "Part"], className: "Part" }]),
        ).toThrow(/action 0 \(create Workspace\.Missing\.Part\): parent Workspace\.Missing does not exist/);
    });

    it("throws on update of a missing node", () => {
        expect(() =>
            applyValidatedActions(base(), [{ action: "update", path: ["Workspace", "DoesNotExist"], properties: {} }]),
        ).toThrow(/action 0 \(update Workspace\.DoesNotExist\): node does not exist/);
    });

    it("throws on delete of a missing node", () => {
        expect(() =>
            applyValidatedActions(base(), [{ action: "delete", path: ["Workspace", "DoesNotExist"] }]),
        ).toThrow(/node does not exist/);
    });

    it("throws on delete of a top-level service", () => {
        expect(() => applyValidatedActions(base(), [{ action: "delete", path: ["Lighting"] }])).toThrow(
            /action 0 \(delete Lighting\): top-level services cannot be deleted/,
        );
    });

    it("throws on an empty path and empty segments", () => {
        expect(() => applyValidatedActions(base(), [{ action: "delete", path: [] }])).toThrow(/path must be a non-empty array/);
        expect(() =>
            applyValidatedActions(base(), [{ action: "create", path: ["Workspace", ""], className: "Part" }]),
        ).toThrow(/path must be a non-empty array/);
    });

    it("throws on an unknown tagged value via the round-trip", () => {
        expect(() =>
            applyValidatedActions(base(), [
                { action: "create", path: ["Workspace", "Bad"], className: "Part", properties: { Size: { type: "Nope" } as never } },
            ]),
        ).toThrow(/actions produced an invalid tree: .*unsupported property type "Nope"/);
    });

    it("validates cumulatively: later actions see earlier creates", () => {
        const actions: TreeAction[] = [
            { action: "create", path: ["Workspace", "Folder"], className: "Folder" },
            { action: "update", path: ["Workspace", "Folder", "Child"], properties: {} },
        ];
        expect(() => applyValidatedActions(base(), actions)).toThrow(/action 1 .*: node does not exist/);
    });

    it("shares no references with the input tree", () => {
        const current = base();
        const next = applyValidatedActions(current, [
            { action: "update", path: ["Workspace", "Baseplate"], properties: { Anchored: false } },
        ]);
        expect(next).not.toBe(current);
        expect(next.children?.Workspace).not.toBe(current.children?.Workspace);
        // The input tree is untouched.
        expect(subtreeAt(current, ["Workspace", "Baseplate"])?.properties?.Anchored).toBe(true);
    });
});
