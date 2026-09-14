import { describe, expect, it } from "vitest";
import { GameTree, parseGameTree } from "../../src/gameTree";
import { TreeAction, applyActions, diffTrees } from "../../src/treeDiff";

/** Builds a game tree from a children JSON fragment. */
function tree(children: string): GameTree {
    return parseGameTree(`{"formatVersion":1,"className":"DataModel","children":${children}}`);
}

/** Diffs two children JSON fragments. */
function diff(baseline: string, target: string): TreeAction[] {
    return diffTrees(tree(baseline), tree(target));
}

describe("diffTrees", () => {
    it("no change produces no actions", () => {
        const children = `{"Workspace":{"children":{"Baseplate":{"className":"Part","properties":{"Anchored":true}}}}}`;
        expect(diff(children, children)).toEqual([]);
    });

    it("property change emits update with the full map", () => {
        const actions = diff(
            `{"Lighting":{"properties":{"Brightness":2}}}`,
            `{"Lighting":{"properties":{"Brightness":3,"ShadowSoftness":0.5}}}`,
        );

        expect(actions).toHaveLength(1);
        const action = actions[0];
        expect(action.action).toBe("update");
        if (action.action === "update") {
            expect(action.path).toEqual(["Lighting"]);
            // The full target map is sent, not a delta.
            expect(Object.keys(action.properties)).toHaveLength(2);
            expect(action.properties.Brightness).toBe(3);
            expect(action.properties.ShadowSoftness).toBe(0.5);
        }
    });

    it("removed property leaves the instance unmanaged", () => {
        // Removing a key cannot unset it in v1, so no action is emitted.
        const actions = diff(`{"Lighting":{"properties":{"Brightness":2}}}`, `{"Lighting":{}}`);
        expect(actions).toEqual([]);
    });

    it("empty target properties emit no update", () => {
        // The full map is only sent when the target actually has properties.
        const actions = diff(`{"Workspace":{"properties":{"Brightness":2}}}`, `{"Workspace":{"properties":{"Other":1}}}`);
        expect(actions).toHaveLength(1);
        expect(actions[0].action).toBe("update");
    });

    it("added subtree creates parents before children", () => {
        const actions = diff(
            `{"Workspace":{}}`,
            `{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{"className":"Part","properties":{"Anchored":true}}}}}}}`,
        );

        expect(actions).toHaveLength(2);
        const folderIndex = actions.findIndex(
            (action) => action.action === "create" && action.path.join(".") === "Workspace.Folder",
        );
        const partIndex = actions.findIndex(
            (action) => action.action === "create" && action.path.join(".") === "Workspace.Folder.Part",
        );

        expect(folderIndex).toBeGreaterThanOrEqual(0);
        expect(partIndex).toBeGreaterThan(folderIndex);
        const partAction = actions[partIndex];
        if (partAction.action === "create") {
            expect(partAction.className).toBe("Part");
            expect(partAction.properties?.Anchored).toBe(true);
        }
    });

    it("removed subtree deletes the shallowest node only", () => {
        const actions = diff(
            `{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{"className":"Part"}}}}}}`,
            `{"Workspace":{}}`,
        );

        expect(actions).toEqual([{ action: "delete", path: ["Workspace", "Folder"] }]);
    });

    it("top level service deletes are suppressed", () => {
        const actions = diff(`{"Workspace":{},"Lighting":{}}`, `{"Workspace":{}}`);
        expect(actions).toEqual([]);
    });

    it("rename is delete and create", () => {
        const actions = diff(
            `{"Workspace":{"children":{"Old":{"className":"Part"}}}}`,
            `{"Workspace":{"children":{"New":{"className":"Part"}}}}`,
        );

        // Independent paths, so create/delete order between them is irrelevant.
        expect(actions).toContainEqual({ action: "delete", path: ["Workspace", "Old"] });
        expect(
            actions.some(
                (action) => action.action === "create" && action.path.join(".") === "Workspace.New",
            ),
        ).toBe(true);
    });

    it("class change deletes before create", () => {
        const actions = diff(
            `{"Workspace":{"children":{"Thing":{"className":"Part","properties":{"Anchored":true}}}}}`,
            `{"Workspace":{"children":{"Thing":{"className":"Folder"}}}}`,
        );

        expect(actions).toHaveLength(2);
        expect(actions[0].action).toBe("delete");
        expect(actions[1].action).toBe("create");
    });

    it("top level service class change is suppressed", () => {
        const actions = diff(
            `{"Workspace":{"className":"Workspace"}}`,
            `{"Workspace":{"className":"Folder","children":{"Thing":{}}}}`,
        );

        expect(actions).toEqual([]);
    });

    it("is deterministic across key orders", () => {
        const a = diff(
            `{"Workspace":{},"Lighting":{"properties":{"Brightness":2}}}`,
            `{"Lighting":{"properties":{"Brightness":3}},"Workspace":{"children":{"Part":{}}}}`,
        );
        const b = diff(
            `{"Lighting":{"properties":{"Brightness":2}},"Workspace":{}}`,
            `{"Workspace":{"children":{"Part":{}}},"Lighting":{"properties":{"Brightness":3}}}`,
        );

        expect(a).toEqual(b);
    });
});

describe("applyActions", () => {
    it("converges the baseline onto the target", () => {
        const cases: [string, string][] = [
            // Property changes
            [
                `{"Lighting":{"properties":{"Brightness":2}}}`,
                `{"Lighting":{"properties":{"Brightness":3,"ShadowSoftness":0.5}}}`,
            ],
            // Added subtrees
            [
                `{"Workspace":{}}`,
                `{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{}}}}}}`,
            ],
            // Removed subtrees
            [
                `{"Workspace":{"children":{"Folder":{"children":{"Part":{}}}}}}`,
                `{"Workspace":{}}`,
            ],
            // Renames
            [
                `{"Workspace":{"children":{"Old":{"className":"Part"}}}}`,
                `{"Workspace":{"children":{"New":{}}}}`,
            ],
            // Class changes
            [
                `{"Workspace":{"children":{"Thing":{"className":"Part","properties":{"Anchored":true}}}}}`,
                `{"Workspace":{"children":{"Thing":{"className":"Folder","children":{"Inner":{}}}}}}`,
            ],
        ];

        for (const [baseline, target] of cases) {
            const baselineTree = tree(baseline);
            const targetTree = tree(target);
            const result = structuredClone(baselineTree);
            applyActions(result, diffTrees(baselineTree, targetTree));
            expect(result).toEqual(targetTree);
        }
    });

    it("tolerates unknown paths", () => {
        const gameTree = tree(`{"Workspace":{}}`);
        applyActions(gameTree, [
            { action: "delete", path: ["Workspace", "Missing"] },
            { action: "update", path: ["Nowhere", "Missing"], properties: {} },
            { action: "create", path: [], className: "Part" },
        ]);

        expect(gameTree).toEqual(tree(`{"Workspace":{}}`));
    });
});
