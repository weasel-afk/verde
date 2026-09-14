#!/usr/bin/env node
/**
 * Headless smoke test for game.json sync — impersonates the Studio plugin.
 *
 * Prereqs: the extension is running (F5 Extension Development Host) with a
 * scratch workspace folder as the first workspace folder, `verde.gameJsonSync`
 * enabled, and the WebSocket server started (default port 9000). Delete any
 * existing game.json / .verde/ in the workspace first.
 *
 * Usage: node extension/test/smoke/fakePlugin.mjs [workspaceFolder] [port]
 *
 * Flow: connect → answer the explorer snapshot request → answer
 * request_game_tree with a canned tree → wait for game.json to be written →
 * edit game.json (add Workspace.Baseplate) → expect an apply_tree_actions
 * operation → acknowledge it → verify the snapshot advanced. Exits 0 on
 * success, 1 on any failure.
 */
import { WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2] ?? process.cwd();
const port = process.argv[3] ?? process.env.PORT ?? "9000";
const gameJsonPath = join(workspace, "game.json");
const snapshotPath = join(workspace, ".verde", "snapshot.json");

const fail = (message) => {
    console.error(`FAIL: ${message}`);
    process.exit(1);
};

const waitFor = (label, check, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            let result;
            try {
                result = check();
            } catch {
                result = false;
            }
            if (result) {
                resolve(result);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`timed out waiting for ${label}`));
                return;
            }
            setTimeout(tick, 200);
        };
        tick();
    });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cannedTree = {
    formatVersion: 1,
    className: "DataModel",
    properties: {},
    children: {
        Workspace: { properties: {}, children: {} },
    },
};

const socket = new WebSocket(`ws://localhost:${port}`);
let sawGameTreeRequest = false;
let sawApply = null;

socket.on("open", () => {
    console.log("connected to the Verde extension");
});

socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());

    // Keep the server's ack watchdog happy.
    if (message.type === "ack") {
        socket.send(JSON.stringify({ type: "ack", timestamp: Date.now() }));
        return;
    }

    if (message.type === "request_snapshot") {
        socket.send(
            JSON.stringify({
                type: "explorer_snapshot",
                requestId: message.requestId,
                isFull: true,
                payload: { rootIds: [], nodes: [] },
            }),
        );
        return;
    }

    if (message.type === "request_game_tree") {
        sawGameTreeRequest = true;
        console.log("got request_game_tree; sending canned export");
        socket.send(JSON.stringify({ type: "game_tree", requestId: message.requestId, payload: cannedTree }));
        return;
    }

    if (message.type === "operation" && message.operation?.type === "apply_tree_actions") {
        sawApply = message;
        console.log(`got apply_tree_actions (${message.operation.actions.length} action(s))`);
        for (const action of message.operation.actions) {
            console.log(`  ${action.action} ${action.path.join(".")}`);
        }
        socket.send(
            JSON.stringify({
                type: "operation_result",
                operationId: message.operationId,
                result: {
                    success: true,
                    data: { applied: message.operation.actions.length, failed: [] },
                },
            }),
        );
    }
});

socket.on("error", (err) => fail(`websocket error: ${String(err)}`));

try {
    await waitFor("the connection to open", () => socket.readyState === WebSocket.OPEN, 5000);

    if (!sawGameTreeRequest) {
        await waitFor("request_game_tree", () => sawGameTreeRequest);
    }

    await waitFor("game.json to be written from the export", () => {
        if (!existsSync(gameJsonPath)) return false;
        const tree = JSON.parse(readFileSync(gameJsonPath, "utf8"));
        return tree.children?.Workspace !== undefined;
    });
    console.log("game.json contains the exported Workspace service");

    // Edit: add a Baseplate Part under Workspace.
    const tree = JSON.parse(readFileSync(gameJsonPath, "utf8"));
    tree.children.Workspace.children = tree.children.Workspace.children ?? {};
    tree.children.Workspace.children.Baseplate = {
        className: "Part",
        properties: { Anchored: true, Size: { type: "Vector3", x: 512, y: 20, z: 512 } },
    };
    writeFileSync(gameJsonPath, JSON.stringify(tree, null, 4) + "\n");
    console.log("edited game.json (added Workspace.Baseplate)");

    await waitFor("apply_tree_actions", () => sawApply !== null, 20000);
    const create = sawApply.operation.actions.find(
        (action) => action.action === "create" && action.path.join(".") === "Workspace.Baseplate",
    );
    if (!create) {
        fail("apply_tree_actions did not contain a create for Workspace.Baseplate");
    }

    await waitFor("the baseline snapshot to advance", () => {
        if (!existsSync(snapshotPath)) return false;
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        return snapshot.children?.Workspace?.children?.Baseplate !== undefined;
    });
    console.log(".verde/snapshot.json advanced past the edit");

    console.log("SMOKE OK");
    socket.close();
    process.exit(0);
} catch (err) {
    fail(String(err));
}
