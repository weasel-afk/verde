#!/usr/bin/env node
/**
 * Headless smoke test for game.json sync — impersonates the Studio plugin.
 *
 * Prereqs: the extension is running (F5 Extension Development Host) with a
 * scratch workspace folder as the first workspace folder, `verde.gameJsonSync`
 * enabled, and the WebSocket server started (dev port, e.g. 9123 — 9000 is
 * the marketplace instance's). Delete any existing game.json / .verde/ in
 * the workspace first.
 *
 * Usage: node extension/test/smoke/fakePlugin.mjs [workspaceFolder] [port] [--hold]
 *
 * Flow: connect → answer the explorer snapshot request → answer
 * request_game_tree with a canned tree → wait for game.json to be written →
 * edit game.json (add Workspace.Baseplate) → expect an apply_tree_actions
 * operation → acknowledge it → verify the snapshot advanced. Exits 0 on
 * success, 1 on any failure.
 *
 * The plugin models applied actions in memory: every acknowledged
 * apply_tree_actions batch mutates the current tree, and every
 * request_game_tree is answered from it — so repeated exports converge like
 * the real plugin.
 *
 * --hold: after the scripted assertions, stay connected servicing requests
 * until SIGINT (or 120s) so other clients (e.g. fakeMcpClient.mjs) can drive
 * the extension through this plugin. Every received apply batch is journaled
 * to <workspace>/.verde/fake-plugin-ops.json for cross-process assertions.
 */
import { WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const workspace = process.argv[2] ?? process.cwd();
const port = process.argv[3] ?? process.env.PORT ?? "9000";
const hold = process.argv.includes("--hold");
const gameJsonPath = join(workspace, "game.json");
const snapshotPath = join(workspace, ".verde", "snapshot.json");
const opsJournalPath = join(workspace, ".verde", "fake-plugin-ops.json");

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

const cannedTree = () => ({
    formatVersion: 1,
    className: "DataModel",
    properties: {},
    children: {
        Workspace: { properties: {}, children: {} },
    },
});

/** The plugin's live model of the Studio tree. */
let currentTree = cannedTree();

/** Applies a tree-actions batch to the modeled tree (plugin semantics). */
function modelApply(actions) {
    const resolve = (path) => {
        let node = currentTree;
        for (const segment of path) {
            node = node.children?.[segment];
            if (!node) {
                return undefined;
            }
        }
        return node;
    };

    for (const action of actions) {
        if (action.path.length === 0) {
            continue;
        }
        const name = action.path[action.path.length - 1];
        const parent = resolve(action.path.slice(0, -1));
        if (!parent) {
            continue;
        }
        parent.children = parent.children ?? {};
        if (action.action === "create") {
            parent.children[name] = {
                className: action.className,
                properties: action.properties ?? {},
                children: {},
            };
        } else if (action.action === "update") {
            if (parent.children[name]) {
                parent.children[name].properties = action.properties ?? {};
            }
        } else if (action.action === "delete") {
            delete parent.children[name];
        }
    }
}

/** Appends a received batch to the ops journal for cross-process checks. */
function journalApply(message) {
    mkdirSync(dirname(opsJournalPath), { recursive: true });
    let entries = [];
    if (existsSync(opsJournalPath)) {
        try {
            entries = JSON.parse(readFileSync(opsJournalPath, "utf8"));
        } catch {
            entries = [];
        }
    }
    entries.push({
        at: new Date().toISOString(),
        actions: message.operation.actions.map((action) => ({ action: action.action, path: action.path })),
    });
    writeFileSync(opsJournalPath, JSON.stringify(entries, null, 4) + "\n");
}

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
        console.log("got request_game_tree; sending the modeled export");
        socket.send(JSON.stringify({ type: "game_tree", requestId: message.requestId, payload: currentTree }));
        return;
    }

    if (message.type === "operation" && message.operation?.type === "apply_tree_actions") {
        sawApply = message;
        console.log(`got apply_tree_actions (${message.operation.actions.length} action(s))`);
        for (const action of message.operation.actions) {
            console.log(`  ${action.action} ${action.path.join(".")}`);
        }
        modelApply(message.operation.actions);
        journalApply(message);
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
socket.on("close", () => {
    if (hold) {
        console.log("connection closed; exiting hold mode");
        process.exit(0);
    }
});

try {
    // Start each run with a clean journal.
    mkdirSync(dirname(opsJournalPath), { recursive: true });
    writeFileSync(opsJournalPath, "[]\n");

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

    if (hold) {
        console.log(`HOLDING (ops journal: ${opsJournalPath}); Ctrl+C to exit`);
        const timer = setTimeout(() => {
            console.log("hold timeout (120s); exiting");
            process.exit(0);
        }, 120000);
        process.on("SIGINT", () => {
            clearTimeout(timer);
            socket.close();
            process.exit(0);
        });
        // Keep the process alive servicing messages.
        setInterval(() => {}, 60000);
    } else {
        socket.close();
        process.exit(0);
    }
} catch (err) {
    fail(String(err));
}
