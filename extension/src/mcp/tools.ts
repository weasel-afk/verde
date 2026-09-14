import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VerdeBackend } from "../backend";
import { GameJsonSync, TreeApplyResult } from "../gameJsonSync";
import { GameTree } from "../gameTree";
import { TreeAction } from "../treeDiff";
import { pruneNode, subtreeAt, summarizeNode } from "../treeOps";

/**
 * Verde's MCP tool surface. Tools are registered onto a fresh McpServer per
 * HTTP request (stateless bridge), so handlers only ever touch state that
 * lives outside the transport: the backend, the current GameJsonSync and
 * the game.json document on disk.
 */

/** Upper bound on actions accepted in a single apply_tree_actions call. */
export const MAX_ACTIONS_PER_CALL = 500;

/** Responses beyond this size are rejected with narrowing guidance instead
 * of silently truncated. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface McpToolContext {
    backend: VerdeBackend;
    /** Always resolves to the current instance (config-driven lifecycle). */
    getGameJsonSync: () => GameJsonSync | null;
    /** The configured plugin WebSocket port, for status reporting. */
    wsPort: () => number;
    mcpInfo: () => { enabled: boolean; port: number; endpoint: string; running: boolean };
}

const PathSchema = z
    .array(z.string().min(1))
    .min(1)
    .describe('Root-first instance names; the first segment is the service, e.g. ["Workspace","Baseplate"]');

const PropertyValueSchema = z
    .union([z.boolean(), z.number(), z.string(), z.object({ type: z.string() }).passthrough()])
    .describe(
        "A primitive (boolean/number/string) or a tagged value object like " +
        "{type:'Vector3',x,y,z}, {type:'Color3',r,g,b}, {type:'Enum',enumType,value} — " +
        "authoritative validation happens on apply",
    );

const TreeActionSchema = z.union([
    z.object({
        action: z.literal("create"),
        path: PathSchema,
        className: z.string().optional().describe("Defaults to the instance name"),
        properties: z.record(z.string(), PropertyValueSchema).optional(),
    }),
    z.object({
        action: z.literal("update"),
        path: PathSchema,
        properties: z.record(z.string(), PropertyValueSchema).describe("Replaces the node's whole property map"),
    }),
    z.object({
        action: z.literal("delete"),
        path: PathSchema,
    }),
]);

export function registerVerdeTools(server: McpServer, ctx: McpToolContext): void {
    registerGetGameTree(server, ctx);
    registerApplyTreeActions(server, ctx);
    registerVerdeStatus(server, ctx);
    registerHistory(server, ctx, "undo");
    registerHistory(server, ctx, "redo");
}

function registerGetGameTree(server: McpServer, ctx: McpToolContext): void {
    server.registerTool(
        "get_game_tree",
        {
            description:
                "Read the Roblox instance tree. Live from Studio when the plugin is connected " +
                "(also refreshes game.json); otherwise serves the game.json document with stale:true. " +
                "Prefer mode:'summary' (names, classNames, childCounts) to orient before full reads; " +
                "path selects a subtree; maxDepth bounds depth.",
            inputSchema: {
                path: PathSchema.optional().describe("Subtree to read; omit for the whole tree"),
                mode: z.enum(["full", "summary"]).default("full").describe("full = properties and children; summary = names/classes/counts only"),
                maxDepth: z.number().int().positive().max(64).optional().describe("Depth bound (the node's children count as depth 1)"),
            },
        },
        async (args) => {
            const sync = ctx.getGameJsonSync();
            if (!sync) {
                return jsonError("verde.gameJsonSync must be enabled: it owns game.json, the source of truth for tree tools");
            }

            let tree: GameTree | null = null;
            let live = false;
            let note: string | undefined;

            if (ctx.backend.hasConnectedClient()) {
                try {
                    const exported = await sync.exportFromStudio();
                    tree = exported;
                    live = exported !== null;
                    if (!live) {
                        note = "the plugin did not answer the export; serving the document from disk";
                    }
                } catch (err) {
                    note = `live export failed (${errorText(err)}); serving the document from disk`;
                }
            }
            if (tree === null) {
                note = note ?? "no Studio plugin connected; serving the game.json document, which may be behind Studio";
                try {
                    tree = sync.readCurrentTree();
                } catch (err) {
                    return jsonError(`game.json is unreadable: ${errorText(err)}`);
                }
                if (tree === null) {
                    return jsonError("no game.json yet — connect the Studio plugin (or run Verde: Export game.json from Studio) and retry");
                }
            }

            if (args.path) {
                const found = subtreeAt(tree, args.path);
                if (!found) {
                    const top = Object.keys(tree.children ?? {}).sort().join(", ");
                    return jsonError(`path ${args.path.join(".")} not found; top-level services: ${top || "(none)"}`);
                }
                if (args.mode === "summary") {
                    const summary = summarizeNode(args.path[args.path.length - 1], found, args.maxDepth);
                    return boundedResult({ live, stale: !live, mode: args.mode, path: args.path, note, summary });
                }
                const node = args.maxDepth !== undefined ? pruneNode(found, args.maxDepth) : found;
                return boundedResult({ live, stale: !live, mode: args.mode, path: args.path, note, node });
            }

            if (args.mode === "summary") {
                return boundedResult({ live, stale: !live, mode: args.mode, note, summary: summarizeNode("DataModel", tree, args.maxDepth) });
            }
            const node = args.maxDepth !== undefined ? pruneNode(tree, args.maxDepth) : tree;
            return boundedResult({ live, stale: !live, mode: args.mode, note, node });
        },
    );
}

function registerApplyTreeActions(server: McpServer, ctx: McpToolContext): void {
    server.registerTool(
        "apply_tree_actions",
        {
            description:
                "Mutate the tree: create/update/delete by name path. Validated against game.json, applied in " +
                "Studio as one undo step; game.json stays the source of truth. Rules: top-level services cannot " +
                "be deleted; update replaces the node's whole property map (keys you omit become unmanaged, not " +
                "unset); duplicate sibling names are unsupported; create replaces an existing node of the same " +
                "name. The response reports the delivered diff (plugin counts), not an echo of your actions.",
            inputSchema: {
                actions: z.array(TreeActionSchema).min(1).max(MAX_ACTIONS_PER_CALL).describe("Applied in order; parents must be created before children"),
            },
        },
        async (args) => {
            const sync = ctx.getGameJsonSync();
            if (!sync) {
                return jsonError("verde.gameJsonSync must be enabled: it owns game.json, the source of truth for tree tools");
            }

            let result: TreeApplyResult;
            try {
                result = await sync.applyTreeActions(args.actions as TreeAction[]);
            } catch (err) {
                return jsonError(errorText(err));
            }

            if (result.status === "applied" && result.failed.length > 0) {
                return jsonResult({
                    ...result,
                    warning: `${result.failed.length} action(s) reported failures by Studio (not retried): ${result.failed.join("; ")}`,
                });
            }
            return jsonResult(result);
        },
    );
}

function registerVerdeStatus(server: McpServer, ctx: McpToolContext): void {
    server.registerTool(
        "verde_status",
        {
            description:
                "Connection and sync status: plugin WebSocket, game.json sync state, pending queue and the MCP " +
                "endpoint. Use it to check whether Studio is connected before mutating.",
            inputSchema: {},
        },
        async () => {
            const sync = ctx.getGameJsonSync();
            return jsonResult({
                ws: { port: ctx.wsPort(), connectedClients: ctx.backend.connectedClientCount() },
                gameJsonSync: sync
                    ? {
                        enabled: true,
                        document: sync.documentPath,
                        pendingQueue: sync.pendingActionCount,
                        baselineInitialised: sync.isBaselineInitialised,
                    }
                    : { enabled: false },
                mcp: ctx.mcpInfo(),
            });
        },
    );
}

function registerHistory(server: McpServer, ctx: McpToolContext, kind: "undo" | "redo"): void {
    server.registerTool(
        kind,
        {
            description:
                `${kind === "undo" ? "Undo" : "Redo"} the last Studio change-history step (one apply_tree_actions ` +
                "call = one step). Applies in Studio only — game.json is not rewritten; call get_game_tree " +
                "afterwards to refresh the document.",
            inputSchema: {},
        },
        async () => {
            const result = await ctx.backend.sendOperation({ type: kind });
            if (!result.success) {
                return jsonError(`${kind} failed: ${result.error}`);
            }
            return jsonResult({ done: true, note: "Studio-only; call get_game_tree to refresh game.json" });
        },
    );
}

/** Serializes a result payload, refusing oversized responses outright. */
function boundedResult(payload: unknown): { content: { type: "text"; text: string }[] } {
    const text = JSON.stringify(payload, null, 2);
    if (text.length > MAX_RESPONSE_BYTES) {
        return jsonError(
            `response too large (${text.length} bytes); narrow it with path, mode:'summary' and/or maxDepth`,
        );
    }
    return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): { content: { type: "text"; text: string }[] } {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function jsonError(message: string): { content: { type: "text"; text: string }[]; isError: boolean } {
    return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
