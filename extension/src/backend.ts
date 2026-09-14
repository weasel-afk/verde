import * as vscode from "vscode";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { Snapshot, Node } from "./robloxExplorerProvider";
import { GameTree } from "./gameTree";
import { TreeAction } from "./treeDiff";

export type Operation =
    | { type: "move_node"; nodeId: string; newParentId: string | null }
    | { type: "rename_instance"; nodeId: string; newName: string }
    | { type: "duplicate_instance"; nodeId: string }
    | { type: "delete_instance"; nodeId: string }
    | { type: "copy_instance"; nodeIds: string[] }
    | { type: "paste_instance"; targetNodeId: string | null }
    | { type: "create_instance"; parentId: string; className: string }
    | { type: "get_properties"; nodeId: string }
    | { type: "deselect_instance" }
    | { type: "set_property"; nodeId: string; propertyName: string; propertyValue: any }
    | { type: "apply_tree_actions"; actions: TreeAction[] }
    | { type: "add_tag"; nodeId: string; tagName: string }
    | { type: "remove_tag"; nodeId: string; tagName: string }
    | { type: "add_attribute"; nodeId: string; attributeName: string; attributeType: string }
    | { type: "set_attribute"; nodeId: string; attributeName: string; attributeValue: any }
    | { type: "remove_attribute"; nodeId: string; attributeName: string }
    | { type: "rename_attribute"; nodeId: string; oldName: string; newName: string }
    | { type: "play_sound"; nodeId: string }
    | { type: "stop_sound"; nodeId: string }
    | { type: "set_sound_time_position"; nodeId: string; timePosition: number }
    | { type: "get_sound_playback_info" }
    | { type: "execute_luau"; code: string; description?: string; nodeId?: string; extensionId?: string }
    | { type: "undo" }
    | { type: "redo" }

export type OperationResult =
    | { success: true; data?: unknown }
    | { success: false; error: string };

export type PropertyInfo = {
    name: string;
    type: string;
    value: any;
    category: string;
    layoutOrder?: number;
    isEnum?: boolean;
    enumValues?: { name: string; value: number }[];
    isInstanceReference?: boolean;
    referencedInstanceId?: string;
    referencedInstanceName?: string;
    referencedInstanceClass?: string;
    isReadOnly?: boolean;
};

export type AttributeInfo = {
    name: string;
    type: string;
    value: any;
};

export type PropertiesData = {
    properties: PropertyInfo[];
    tags: string[];
    attributes: AttributeInfo[];
};

export type SoundPlaybackInfo = {
    playing: boolean;
    timePosition: number;
    timeLength: number;
    sourceId: string | null;
};

export type TextRange = {
    start: { line: number; character: number };
    end: { line: number; character: number };
};

export type ExplorerDeltaOp =
    | { type: "add_subtree"; timestamp: number; parentId: string | null; rootId: string; nodes: Snapshot["nodes"] }
    | { type: "remove_node"; timestamp: number; id: string }
    | { type: "update_node"; timestamp: number; id: string; name?: string; disabled?: boolean; runContext?: string; hasChildren?: boolean }
    | { type: "move_node"; timestamp: number; id: string; newParentId: string | null };

type RobloxInboundMessage =
    | { type: "explorer_snapshot"; requestId?: string; payload?: Snapshot }
    | { type: "explorer_delta"; ops: ExplorerDeltaOp[]; addedRootIds?: string[] }
    | { type: "operation_result"; requestId?: string; operationId: string; result: OperationResult }
    | { type: "property_update"; nodeId: string; properties: PropertiesData }
    | { type: "game_tree"; requestId?: string; payload?: GameTree }
    | { type: "game_tree_too_big"; requestId?: string }
    | { type: "handshake"; timestamp: number }
    | { type: "ack"; timestamp: number }
    | { type: string; requestId?: string; payload?: unknown };

type BackendOutboundMessage =
    | { type: "ack"; requestId?: string }
    | { type: "error"; requestId?: string; message: string }
    | { type: "operation"; requestId?: string; operationId: string; operation: Operation }
    | { type: "request_snapshot"; requestId?: string; full?: boolean }
    | { type: "request_game_tree"; requestId?: string }
    | { type: "request_children"; requestId?: string; parentIds: string[] }
    | { type: "release_subtree"; requestId?: string; parentIds: string[]; nodeIds: string[] }
    | { type: "request_search"; requestId?: string; query: string };

export class VerdeBackend {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly onSnapshotReceived: (snapshot: Snapshot, isFull: boolean) => void;
    private readonly onDeltaReceived?: (ops: ExplorerDeltaOp[], addedRootIds?: string[]) => void;
    private readonly onConnectionLost?: () => void;
    private readonly onSearchResultReceived?: (query: string, nodes: Node[]) => void;
    private readonly onSnapshotTooBig?: () => void;
    private readonly onClientConnected?: () => void;
    private readonly onGameTreeReceived?: (tree: GameTree) => void;
    private readonly propertyUpdateCallbacks: ((nodeId: string, properties: PropertiesData) => void)[] = [];

    private webSocketServer: WebSocketServer | null = null;
    private clients: Set<WebSocket> = new Set();
    private connectionLostNotified: boolean = false;
    private operationCallbacks: Map<string, (result: OperationResult) => void> = new Map();
    private lastAckTime: number = 0;
    private ackTimeout: NodeJS.Timeout | null = null;
    private ackInterval: NodeJS.Timeout | null = null;
    private initialSyncComplete: boolean = false;
    private pendingFullSnapshot: {
        promise: Promise<Snapshot>;
        resolve: (snapshot: Snapshot) => void;
        reject: (reason: Error) => void;
        requestedAt: number;
        timeout: NodeJS.Timeout;
    } | null = null;
    private pendingGameTree: {
        promise: Promise<GameTree>;
        resolve: (tree: GameTree) => void;
        reject: (reason: Error) => void;
        requestedAt: number;
        timeout: NodeJS.Timeout;
    } | null = null;
    private static readonly FULL_SNAPSHOT_STALE_MS = 15000;
    private static readonly GAME_TREE_STALE_MS = 60000;
    private multiClientWarned = false;

    constructor(
        outputChannel: vscode.OutputChannel,
        statusBarItem: vscode.StatusBarItem,
        onSnapshotReceived: (snapshot: Snapshot, isFull: boolean) => void,
        onDeltaReceived?: (ops: ExplorerDeltaOp[], addedRootIds?: string[]) => void,
        onConnectionLost?: () => void,
        onSearchResultReceived?: (query: string, nodes: Node[]) => void,
        onSnapshotTooBig?: () => void,
        onClientConnected?: () => void,
        onGameTreeReceived?: (tree: GameTree) => void,
    ) {
        this.outputChannel = outputChannel;
        this.statusBarItem = statusBarItem;
        this.onSnapshotReceived = onSnapshotReceived;
        this.onDeltaReceived = onDeltaReceived;
        this.onConnectionLost = onConnectionLost;
        this.onSearchResultReceived = onSearchResultReceived;
        this.onSnapshotTooBig = onSnapshotTooBig;
        this.onClientConnected = onClientConnected;
        this.onGameTreeReceived = onGameTreeReceived;
        this.updateStatusBar();
    }

    public async start(): Promise<void> {
        if (this.webSocketServer) {
            const addressInfo = this.webSocketServer.address();
            if (addressInfo) {
                this.log(`websocket server already running on ${JSON.stringify(addressInfo)}`);
                return;
            }

            await this.stop();
        }

        const config = vscode.workspace.getConfiguration("verde");
        const port = config.get<number>("port", 9000);
        const hostSetting = config.get<string>("host", "localhost");
        const host = hostSetting;

        this.log(`starting websocket server on ws://${host}:${port}`);

        try {
            const wsOptions = { maxPayload: 256 * 1024 * 1024 };
            this.webSocketServer = new WebSocketServer(host ? { host, port, ...wsOptions } : { port, ...wsOptions });
        } catch (err) {
            this.log(`failed to start websocket server: ${String(err)}`);
            throw err;
        }

        this.webSocketServer.on("listening", () => {
            this.log("websocket server listening");
        });

        this.webSocketServer.on("connection", (socket) => {
            this.clients.add(socket);
            this.connectionLostNotified = false;
            this.log(`client connected (${this.clients.size} total)`);
            this.updateStatusBar();

            socket.on("message", (data) => this.onMessage(socket, data));
            socket.on("close", () => {
                this.clients.delete(socket);
                this.log(`client disconnected (${this.clients.size} total)`);
                if (this.clients.size === 0) {
                    this.initialSyncComplete = false;
                    this.handleAllClientsDisconnected("client disconnected");
                }
                this.updateStatusBar();
            });
            socket.on("error", (err) => {
                this.log(`socket error: ${String(err)}`);
            });

            this.lastAckTime = Date.now();
            this.initialSyncComplete = false;

            this.send(socket, { type: "ack" });
            this.startAckInterval();
            if (this.onClientConnected) {
                this.onClientConnected();
            }
        });

        this.webSocketServer.on("error", (err) => {
            this.log(`server error: ${String(err)}`);
            if ((err as any)?.code === "EADDRINUSE") {
                this.webSocketServer = null;
            }
        });
    }

    public async stop(): Promise<void> {
        if (!this.webSocketServer) {
            return;
        }

        for (const socket of this.clients) {
            try {
                socket.close();
            } catch {
                // ignore
            }
        }

        this.clients.clear();
        this.webSocketServer.close();
        this.webSocketServer = null;

        if (this.ackTimeout) {
            clearTimeout(this.ackTimeout);
            this.ackTimeout = null;
        }

        if (this.ackInterval) {
            clearInterval(this.ackInterval);
            this.ackInterval = null;
        }

        this.initialSyncComplete = false;
        this.failPendingOperations("backend stopped");
        this.rejectPendingFullSnapshot("backend stopped");
        this.rejectPendingGameTree("backend stopped");
        this.updateStatusBar();
    }

    public requestSnapshot(full: boolean = false): Promise<Snapshot | null> {
        if (this.clients.size === 0) {
            return Promise.resolve(null);
        }

        if (!full) {
            this.broadcast({ type: "request_snapshot", full });
            return Promise.resolve(null);
        }

        if (this.pendingFullSnapshot) {
            if (Date.now() - this.pendingFullSnapshot.requestedAt < VerdeBackend.FULL_SNAPSHOT_STALE_MS) {
                return this.pendingFullSnapshot.promise;
            }
            this.rejectPendingFullSnapshot("snapshot_request_abandoned");
        }

        let resolveFn!: (snapshot: Snapshot) => void;
        let rejectFn!: (reason: Error) => void;
        const promise = new Promise<Snapshot>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        promise.catch(() => {});
        const timeout = setTimeout(
            () => this.rejectPendingFullSnapshot("snapshot timeout"),
            VerdeBackend.FULL_SNAPSHOT_STALE_MS,
        );
        this.pendingFullSnapshot = { promise, resolve: resolveFn, reject: rejectFn, requestedAt: Date.now(), timeout };

        this.broadcast({ type: "request_snapshot", full: true });

        return promise;
    }

    private handleAllClientsDisconnected(reason: string): void {
        this.failPendingOperations(reason);
        this.rejectPendingFullSnapshot(reason);
        this.rejectPendingGameTree(reason);
        if (!this.connectionLostNotified) {
            this.connectionLostNotified = true;
            if (this.onConnectionLost) {
                this.onConnectionLost();
            }
        }
    }

    private rejectPendingFullSnapshot(reason: string): void {
        if (!this.pendingFullSnapshot) {
            return;
        }

        const pending = this.pendingFullSnapshot;
        this.pendingFullSnapshot = null;
        clearTimeout(pending.timeout);
        pending.reject(new Error(reason));
    }

    private resolvePendingGameTree(tree: GameTree): void {
        if (!this.pendingGameTree) {
            return;
        }

        const pending = this.pendingGameTree;
        this.pendingGameTree = null;
        clearTimeout(pending.timeout);
        pending.resolve(tree);
    }

    private rejectPendingGameTree(reason: string): void {
        if (!this.pendingGameTree) {
            return;
        }

        const pending = this.pendingGameTree;
        this.pendingGameTree = null;
        clearTimeout(pending.timeout);
        pending.reject(new Error(reason));
    }

    public requestChildren(parentIds: string[]): void {
        if (parentIds.length === 0) return;
        this.log(`request_children for ${parentIds.length} parent(s): ${parentIds.join(", ")}`);
        this.broadcast({ type: "request_children", parentIds });
    }

    /**
     * Requests a full game tree export from the plugin. The plugin replies
     * with a pushed game_tree message (not an operation), so large exports
     * are not bound by operation timeouts. Resolves null when no client is
     * connected.
     */
    public requestGameTree(): Promise<GameTree | null> {
        if (this.clients.size === 0) {
            return Promise.resolve(null);
        }

        if (this.pendingGameTree) {
            if (Date.now() - this.pendingGameTree.requestedAt < VerdeBackend.GAME_TREE_STALE_MS) {
                return this.pendingGameTree.promise;
            }
            this.rejectPendingGameTree("game_tree_request_abandoned");
        }

        let resolveFn!: (tree: GameTree) => void;
        let rejectFn!: (reason: Error) => void;
        const promise = new Promise<GameTree>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        promise.catch(() => {});
        const timeout = setTimeout(
            () => this.rejectPendingGameTree("game tree timeout"),
            VerdeBackend.GAME_TREE_STALE_MS,
        );
        this.pendingGameTree = { promise, resolve: resolveFn, reject: rejectFn, requestedAt: Date.now(), timeout };

        this.warnMultipleClientsOnce();
        this.broadcast({ type: "request_game_tree" });

        return promise;
    }

    /**
     * Applies a batch of tree actions on the plugin as one operation (one
     * undo step). Delivery is at-least-once by contract: the caller keeps
     * the batch until this resolves with success.
     */
    public async applyTreeActions(
        actions: TreeAction[],
    ): Promise<{ success: true; data?: unknown } | { success: false; error: string }> {
        this.warnMultipleClientsOnce();
        return this.sendOperation({ type: "apply_tree_actions", actions });
    }

    private warnMultipleClientsOnce(): void {
        if (this.clients.size > 1 && !this.multiClientWarned) {
            this.multiClientWarned = true;
            this.log(
                `warning: ${this.clients.size} clients connected; tree sync targets all of them and only the first reply wins`,
            );
        }
    }

    public releaseSubtree(parentIds: string[], nodeIds: string[]): void {
        if (parentIds.length === 0) return;
        this.log(`release_subtree for ${parentIds.length} parent(s), ${nodeIds.length} node(s)`);
        this.broadcast({ type: "release_subtree", parentIds, nodeIds });
    }

    public requestSearch(query: string): boolean {
        if (this.clients.size === 0) {
            return false;
        }
        this.broadcast({ type: "request_search", query });
        return true;
    }

    public hasConnectedClient(): boolean {
        return this.clients.size > 0;
    }

    public connectedClientCount(): number {
        return this.clients.size;
    }

    public async sendOperation<TData = unknown>(
        operation: Operation,
    ): Promise<{ success: true; data?: TData } | { success: false; error: string }> {
        return new Promise((resolve) => {
            const operationId = crypto.randomUUID();

            this.operationCallbacks.set(operationId, resolve as (result: OperationResult) => void);

            this.broadcast({ type: "operation", operationId, operation });

            setTimeout(() => {
                if (this.operationCallbacks.has(operationId)) {
                    this.operationCallbacks.delete(operationId);
                    resolve({ success: false, error: "timeout" });
                }
            }, 30000);
        });
    }

    public async getProperties(nodeId: string): Promise<PropertiesData> {
        const result = await this.sendOperation({ type: "get_properties", nodeId });
        if (result.success && result.data) {
            return result.data as PropertiesData;
        }
        throw new Error(result.success ? "No data returned" : result.error);
    }

    public setPropertyUpdateCallback(callback: (nodeId: string, properties: PropertiesData) => void): void {
        this.propertyUpdateCallbacks.push(callback);
    }

    public async setProperty(nodeId: string, propertyName: string, propertyValue: any): Promise<void> {
        const result = await this.sendOperation({ type: "set_property", nodeId, propertyName, propertyValue });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async addTag(nodeId: string, tagName: string): Promise<void> {
        const result = await this.sendOperation({ type: "add_tag", nodeId, tagName });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async removeTag(nodeId: string, tagName: string): Promise<void> {
        const result = await this.sendOperation({ type: "remove_tag", nodeId, tagName });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async addAttribute(nodeId: string, attributeName: string, attributeType: string): Promise<void> {
        const result = await this.sendOperation({ type: "add_attribute", nodeId, attributeName, attributeType });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async setAttribute(nodeId: string, attributeName: string, attributeValue: any): Promise<void> {
        const result = await this.sendOperation({ type: "set_attribute", nodeId, attributeName, attributeValue });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async removeAttribute(nodeId: string, attributeName: string): Promise<void> {
        const result = await this.sendOperation({ type: "remove_attribute", nodeId, attributeName });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async renameAttribute(nodeId: string, oldName: string, newName: string): Promise<void> {
        const result = await this.sendOperation({ type: "rename_attribute", nodeId, oldName, newName });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async playSound(nodeId: string): Promise<void> {
        const result = await this.sendOperation({ type: "play_sound", nodeId });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async stopSound(nodeId: string): Promise<void> {
        const result = await this.sendOperation({ type: "stop_sound", nodeId });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async setSoundTimePosition(nodeId: string, timePosition: number): Promise<void> {
        const result = await this.sendOperation({ type: "set_sound_time_position", nodeId, timePosition });
        if (!result.success) {
            throw new Error(result.error);
        }
    }

    public async getSoundPlaybackInfo(): Promise<SoundPlaybackInfo> {
        const result = await this.sendOperation({ type: "get_sound_playback_info" });
        if (result.success && result.data) {
            return result.data as unknown as SoundPlaybackInfo;
        }
        return { playing: false, timePosition: 0, timeLength: 0, sourceId: null };
    }

    public async undo(): Promise<void> {
        await this.sendOperation({ type: "undo" });
    }

    public async redo(): Promise<void> {
        await this.sendOperation({ type: "redo" });
    }

    private onMessage(socket: WebSocket, rawData: RawData): void {
        const text = rawData.toString();

        let message: RobloxInboundMessage;
        try {
            message = JSON.parse(text);
        } catch {
            this.send(socket, { type: "error", message: "invalid_json" });
            return;
        }

        switch (message.type) {
            case "explorer_snapshot": {
                this.lastAckTime = Date.now();
                const payload = message.payload as Snapshot;

                if (
                    !payload ||
                    !Array.isArray(payload.nodes) ||
                    !Array.isArray(payload.rootIds)
                ) {
                    this.send(socket, {
                        type: "error",
                        requestId: message.requestId,
                        message: "invalid_snapshot_payload"
                    });
                    return;
                }

                this.log(`received explorer snapshot (${payload.nodes.length} nodes)`);
                const isFull = (message as { isFull?: boolean }).isFull === true;
                this.deliverSnapshot(payload, isFull);

                this.send(socket, { type: "ack", requestId: message.requestId });

                if (!this.initialSyncComplete) {
                    this.initialSyncComplete = true;
                    this.lastAckTime = Date.now();
                    this.startAckInterval();
                }
                return;
            }

            case "snapshot_too_big": {
                this.lastAckTime = Date.now();

                if (this.onSnapshotTooBig) {
                    this.onSnapshotTooBig();
                }

                this.rejectPendingFullSnapshot("snapshot_too_big");
                this.send(socket, { type: "ack", requestId: (message as any).requestId });
                return;
            }

            case "search_result": {
                this.lastAckTime = Date.now();
                const searchResultMessage = message as { type: "search_result"; query: string; nodes: Node[]; truncated?: boolean; requestId?: string };
                const nodes = Array.isArray(searchResultMessage.nodes) ? searchResultMessage.nodes : [];

                if (searchResultMessage.truncated === true) {
                    this.log(`search results for "${searchResultMessage.query}" truncated at ${nodes.length} nodes`);
                }

                if (this.onSearchResultReceived) {
                    this.onSearchResultReceived(searchResultMessage.query ?? "", nodes);
                }

                this.send(socket, { type: "ack", requestId: searchResultMessage.requestId });
                return;
            }

            case "explorer_delta": {
                this.lastAckTime = Date.now();
                const deltaMessage = message as { type: "explorer_delta"; ops: ExplorerDeltaOp[]; addedRootIds?: string[] };
                const ops = deltaMessage.ops ?? [];
                if (!Array.isArray(ops) || ops.length === 0) {
                    this.send(socket, { type: "ack", requestId: (message as any).requestId });
                    return;
                }
                const opCounts = ops.reduce<Record<string, number>>((acc, op) => {
                    acc[op.type] = (acc[op.type] ?? 0) + 1;
                    return acc;
                }, {});
                const opSummary = Object.entries(opCounts).map(([t, n]) => `${t}×${n}`).join(", ");
                this.log(`explorer_delta: ${ops.length} op(s) [${opSummary}]`);
                if (this.onDeltaReceived) {
                    this.onDeltaReceived(ops, deltaMessage.addedRootIds);
                }
                this.send(socket, { type: "ack", requestId: (message as any).requestId });
                return;
            }

            case "operation_result": {
                this.lastAckTime = Date.now();
                const operationResultMessage = message as { type: "operation_result"; operationId: string; result: OperationResult };
                const callback = this.operationCallbacks.get(operationResultMessage.operationId);

                if (callback) {
                    this.operationCallbacks.delete(operationResultMessage.operationId);
                    callback(operationResultMessage.result);
                }

                this.send(socket, { type: "ack", requestId: message.requestId });
                return;
            }

            case "game_tree": {
                this.lastAckTime = Date.now();
                const gameTreeMessage = message as { type: "game_tree"; payload?: GameTree };
                const payload = gameTreeMessage.payload;

                if (
                    !payload ||
                    typeof payload !== "object" ||
                    (payload as { formatVersion?: unknown }).formatVersion !== 1
                ) {
                    this.log("received invalid game_tree payload");
                    this.send(socket, {
                        type: "error",
                        requestId: message.requestId,
                        message: "invalid_game_tree_payload",
                    });
                    return;
                }

                this.log("received game_tree export");
                this.resolvePendingGameTree(payload);
                if (this.onGameTreeReceived) {
                    this.onGameTreeReceived(payload);
                }

                this.send(socket, { type: "ack", requestId: message.requestId });
                return;
            }

            case "game_tree_too_big": {
                this.lastAckTime = Date.now();
                this.log("plugin reported the game tree is too big to export");
                this.rejectPendingGameTree("game_tree_too_big");
                this.send(socket, { type: "ack", requestId: message.requestId });
                return;
            }

            case "handshake": {
                this.lastAckTime = Date.now();
                this.send(socket, { type: "ack" });
                return;
            }

            case "property_update": {
                this.lastAckTime = Date.now();
                const propertyUpdateMessage = message as { type: "property_update"; nodeId: string; properties: PropertiesData; requestId?: string };
                for (const callback of this.propertyUpdateCallbacks) {
                    callback(propertyUpdateMessage.nodeId, propertyUpdateMessage.properties);
                }
                this.send(socket, { type: "ack", requestId: propertyUpdateMessage.requestId });
                return;
            }

            case "ack": {
                this.lastAckTime = Date.now();
                return;
            }

            default: {
                this.log(`unhandled message type: ${message.type}`);
                this.send(socket, { type: "ack", requestId: (message as any).requestId });
                return;
            }
        }
    }

    private deliverSnapshot(snapshot: Snapshot, isFull: boolean): void {
        this.log(`delivering snapshot (${snapshot.nodes.length} nodes, isFull=${isFull})`);

        if (!isFull) {
            this.rejectPendingFullSnapshot("superseded_by_partial_snapshot");
        }

        this.onSnapshotReceived(snapshot, isFull);

        if (isFull && this.pendingFullSnapshot) {
            const pending = this.pendingFullSnapshot;
            this.pendingFullSnapshot = null;
            clearTimeout(pending.timeout);
            pending.resolve(snapshot);
        }
    }

    private failPendingOperations(reason: string): void {
        if (this.operationCallbacks.size === 0) {
            return;
        }
        const callbacks = Array.from(this.operationCallbacks.values());
        this.operationCallbacks.clear();
        for (const callback of callbacks) {
            try {
                callback({ success: false, error: reason });
            } catch (err) {
                this.log(`operation callback threw during cleanup: ${String(err)}`);
            }
        }
    }

    private send(socket: WebSocket, message: BackendOutboundMessage): void {
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }

        socket.send(JSON.stringify(message));
    }

    private broadcast(message: BackendOutboundMessage): void {
        for (const socket of this.clients) {
            this.send(socket, message);
        }
    }

    private startAckInterval(): void {
        if (this.ackInterval) {
            return;
        }

        this.ackInterval = setInterval(() => {
            if (this.clients.size === 0) {
                if (this.ackInterval) {
                    clearInterval(this.ackInterval);
                    this.ackInterval = null;
                }
                return;
            }

            const now = Date.now();
            const timeSinceLastAck = now - this.lastAckTime;
            if (timeSinceLastAck > 5000) {

                const socketsToDisconnect: WebSocket[] = [];
                for (const socket of this.clients) {
                    socketsToDisconnect.push(socket);
                }

                for (const socket of socketsToDisconnect) {
                    try {
                        socket.close();
                    } catch {
                        // ignore
                    }
                    this.clients.delete(socket);
                }

                if (this.clients.size === 0) {
                    this.handleAllClientsDisconnected("client disconnected");
                }

                this.updateStatusBar();
                return;
            }

            this.broadcast({ type: "ack" });
        }, 1000);
    }


    private updateStatusBar(): void {
        const running = this.webSocketServer !== null;
        const clientCount = this.clients.size;

        this.statusBarItem.text = running
            ? `Verde: ${clientCount} client(s)`
            : "Verde: stopped";

        this.statusBarItem.show();
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[verde] ${message}`);
    }
}
