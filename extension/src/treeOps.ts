import { GameNode, GameTree, cloneTree, effectiveClassName, parseGameTree, serializeGameTree } from "./gameTree";
import { TreeAction } from "./treeDiff";

/**
 * Read-side tree helpers for the MCP bridge: subtree addressing, cheap
 * summaries for orientation, depth pruning and validated applies. Pure like
 * gameTree/treeDiff — no vscode, no SDK.
 */

/** Resolves the node at a root-first name path; undefined when absent. */
export function subtreeAt(tree: GameTree, path: string[]): GameNode | undefined {
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

/** A property-free, optionally depth-pruned view of a game node. */
export type SummaryNode = {
    name: string;
    className: string;
    childCount: number;
    /** True when the node has children that were pruned by maxDepth. */
    truncated?: boolean;
    children?: Record<string, SummaryNode>;
};

/**
 * Renders a summary of the tree: names, class names and child counts only.
 * maxDepth counts the root's children as depth 1; deeper levels are pruned
 * and marked truncated instead of silently missing.
 */
export function summarizeTree(tree: GameTree, maxDepth?: number): SummaryNode {
    return summarizeNode("DataModel", tree, maxDepth);
}

/**
 * Renders a summary of a single node (the name it is keyed under must be
 * supplied by the caller). Same depth semantics as summarizeTree.
 */
export function summarizeNode(name: string, node: GameNode, maxDepth?: number): SummaryNode {
    const children = node.children ?? {};
    const childNames = Object.keys(children);

    const summary: SummaryNode = {
        name,
        className: effectiveClassName(node, name),
        childCount: childNames.length,
    };

    if (childNames.length === 0) {
        return summary;
    }
    if (maxDepth !== undefined && maxDepth <= 0) {
        summary.truncated = true;
        return summary;
    }

    const nextDepth = maxDepth === undefined ? undefined : maxDepth - 1;
    summary.children = {};
    // Sorted like diffTrees and serializeGameTree, so output is deterministic
    // regardless of how the tree was built.
    for (const childName of childNames.sort()) {
        summary.children[childName] = summarizeNode(childName, children[childName], nextDepth);
    }
    return summary;
}

/**
 * Returns a copy of the tree with nodes beyond maxDepth removed (the root's
 * children count as depth 1). Used to bound full-mode reads.
 */
export function pruneTree(tree: GameTree, maxDepth: number): GameTree {
    return pruneNode(tree, maxDepth);
}

/**
 * Returns a depth-pruned copy of a single node (children count as depth 1).
 * The result shares no references with the input.
 */
export function pruneNode<T extends GameNode>(node: T, maxDepth: number): T {
    const pruned = cloneTree(node);
    pruneChildren(pruned, maxDepth);
    return pruned;
}

function pruneChildren(node: GameNode, remainingDepth: number): void {
    const children = node.children;
    if (!children || Object.keys(children).length === 0) {
        return;
    }
    if (remainingDepth <= 0) {
        delete node.children;
        return;
    }
    for (const child of Object.values(children)) {
        pruneChildren(child, remainingDepth - 1);
    }
}

/**
 * Validates and applies agent-submitted actions to a copy of the current
 * tree, throwing on the first invalid action so nothing reaches disk from a
 * malformed batch. Validation is cumulative — each action is checked against
 * the tree as mutated by its predecessors, so parents-first create batches
 * work.
 *
 * Semantics mirror treeDiff.applyActions (the file model is the truth):
 * create replaces the node wholesale, update replaces the node's whole
 * property map, delete removes the node. After all actions apply, the result
 * is round-tripped through serializeGameTree -> parseGameTree so malformed
 * property values fail here with gameTree's own validators.
 */
export function applyValidatedActions(current: GameTree, actions: TreeAction[]): GameTree {
    const next = cloneTree(current);
    for (let index = 0; index < actions.length; index++) {
        applyValidatedAction(next, actions[index], index);
    }

    try {
        return parseGameTree(serializeGameTree(next));
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`actions produced an invalid tree: ${reason}`);
    }
}

function applyValidatedAction(tree: GameTree, action: TreeAction, index: number): void {
    const where = `action ${index} (${action.action} ${action.path.join(".")})`;

    const invalidSegment = action.path.length === 0 || action.path.some((segment) => segment.length === 0);
    if (invalidSegment) {
        throw new Error(`${where}: path must be a non-empty array of non-empty instance names`);
    }

    const name = action.path[action.path.length - 1];
    const parentPath = action.path.slice(0, -1);
    const parent = subtreeAt(tree, parentPath);
    const existing = subtreeAt(tree, action.path);

    if (action.action === "create") {
        if (!parent) {
            throw new Error(`${where}: parent ${parentPath.join(".") || "(root)"} does not exist`);
        }
        parent.children = parent.children ?? {};
        parent.children[name] = {
            className: action.className,
            properties: action.properties ? { ...action.properties } : {},
            children: {},
        };
    } else if (action.action === "update") {
        if (!existing) {
            throw new Error(`${where}: node does not exist`);
        }
        existing.properties = { ...action.properties };
    } else if (action.action === "delete") {
        if (action.path.length <= 1) {
            throw new Error(`${where}: top-level services cannot be deleted`);
        }
        if (!existing || !parent?.children) {
            throw new Error(`${where}: node does not exist`);
        }
        delete parent.children[name];
    } else {
        throw new Error(`${where}: unknown action`);
    }
}
