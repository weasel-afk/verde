import { GameNode, GameTree, PropertyValue, effectiveClassName } from "./gameTree";

export type TreeAction =
    | { action: "create"; path: string[]; className?: string; properties?: Record<string, PropertyValue> }
    | { action: "update"; path: string[]; properties: Record<string, PropertyValue> }
    | { action: "delete"; path: string[] };

/**
 * Diffs a baseline tree against a target tree, producing the ordered actions
 * required to converge the baseline onto the target.
 *
 * Ordering guarantees: creates are emitted parents before children, and a
 * class change emits its delete before its create.
 */
export function diffTrees(baseline: GameTree, target: GameTree): TreeAction[] {
    const actions: TreeAction[] = [];
    diffNode([], baseline, target, actions);
    return actions;
}

function diffNode(path: string[], baseline: GameNode, target: GameNode, actions: TreeAction[]): void {
    // The DataModel root is never property-diffed.
    const baselineProperties = baseline.properties ?? {};
    const targetProperties = target.properties ?? {};
    if (
        path.length > 0 &&
        Object.keys(targetProperties).length > 0 &&
        !propertiesEqual(baselineProperties, targetProperties)
    ) {
        actions.push({
            action: "update",
            path: [...path],
            properties: targetProperties,
        });
    }

    // Union of child names, iterated in sorted order for determinism.
    const baselineChildren = baseline.children ?? {};
    const targetChildren = target.children ?? {};
    const names = new Set([...Object.keys(baselineChildren), ...Object.keys(targetChildren)]);
    for (const name of [...names].sort()) {
        const childPath = [...path, name];
        const baselineChild = baselineChildren[name];
        const targetChild = targetChildren[name];

        if (baselineChild && targetChild) {
            if (effectiveClassName(baselineChild, name) !== effectiveClassName(targetChild, name)) {
                // A class change replaces the instance: delete first so the create
                // cannot collide with the stale instance of the same name.
                if (emitDelete(childPath, actions)) {
                    emitCreate(childPath, targetChild, actions);
                    emitCreates(childPath, targetChild, actions);
                }
            } else {
                diffNode(childPath, baselineChild, targetChild, actions);
            }
        } else if (targetChild) {
            emitCreate(childPath, targetChild, actions);
            emitCreates(childPath, targetChild, actions);
        } else if (baselineChild) {
            emitDelete(childPath, actions);
        }
    }
}

/** Emits the create action for a single node. */
function emitCreate(path: string[], node: GameNode, actions: TreeAction[]): void {
    actions.push({
        action: "create",
        path: [...path],
        className: node.className,
        properties: node.properties ?? {},
    });
}

/** Emits create actions for an entire subtree, parents before children. */
function emitCreates(path: string[], node: GameNode, actions: TreeAction[]): void {
    const children = node.children ?? {};
    for (const name of Object.keys(children).sort()) {
        const childPath = [...path, name];
        emitCreate(childPath, children[name], actions);
        emitCreates(childPath, children[name], actions);
    }
}

/** Emits a delete action for a path. Top level services are not destroyable. */
function emitDelete(path: string[], actions: TreeAction[]): boolean {
    if (path.length <= 1) {
        console.warn(`Ignoring delete of top level service ${path[0] ?? ""}`);
        return false;
    }

    actions.push({ action: "delete", path: [...path] });
    return true;
}

/**
 * Applies actions to a game tree in memory. Used to merge tree exports with
 * pending game.json edits, and as a test oracle for the diff engine.
 *
 * Actions referencing unknown paths are tolerated as no-ops so that deletes
 * of instances also removed manually in Studio do not fail the merge.
 */
export function applyActions(tree: GameTree, actions: TreeAction[]): void {
    for (const action of actions) {
        if (action.path.length === 0) {
            continue; // the DataModel root cannot be created, updated or deleted
        }
        const name = action.path[action.path.length - 1];
        const parentPath = action.path.slice(0, -1);
        const parent = resolveNode(parentPath, tree);

        if (!parent) {
            continue;
        }
        parent.children = parent.children ?? {};

        if (action.action === "create") {
            parent.children[name] = {
                className: action.className,
                properties: action.properties ? { ...action.properties } : {},
                children: {},
            };
        } else if (action.action === "update") {
            const child = parent.children[name];
            if (child) {
                child.properties = { ...action.properties };
            }
        } else if (action.action === "delete") {
            delete parent.children[name];
        }
    }
}

/** Resolves a node by walking child names from the tree root. */
function resolveNode(path: string[], tree: GameTree): GameNode | undefined {
    let current: GameNode = tree;
    for (const segment of path) {
        const next = current.children?.[segment];
        if (!next) {
            return undefined;
        }
        current = next;
    }
    return current;
}

function propertiesEqual(
    a: Record<string, PropertyValue>,
    b: Record<string, PropertyValue>,
): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        if (!(key in b) || !propertyValuesEqual(a[key], b[key])) {
            return false;
        }
    }
    return true;
}

function propertyValuesEqual(a: PropertyValue, b: PropertyValue): boolean {
    const aTagged = typeof a === "object" && a !== null ? (a as Record<string, unknown>) : null;
    const bTagged = typeof b === "object" && b !== null ? (b as Record<string, unknown>) : null;

    if (!aTagged || !bTagged) {
        return a === b;
    }

    return JSON.stringify(sortKeys(aTagged)) === JSON.stringify(sortKeys(bTagged));
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
    }
    return sorted;
}
