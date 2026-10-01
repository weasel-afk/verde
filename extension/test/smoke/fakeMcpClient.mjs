#!/usr/bin/env node
/**
 * Headless smoke test for the Verde MCP bridge — impersonates an MCP client
 * (Claude Code style) against the extension's HTTP endpoint.
 *
 * Prereqs: an Extension Development Host with a scratch workspace folder whose
 * settings enable the whole stack on non-default ports (9000 is the
 * marketplace instance's):
 *   { "verde.port": 9123, "verde.gameJsonSync": true,
 *     "verde.mcp.enabled": true, "verde.mcp.port": 9124 }
 * and fakePlugin.mjs <workspace> 9123 --hold already past its "SMOKE OK"
 * (game.json written, Baseplate applied).
 *
 * Usage: node extension/test/smoke/fakeMcpClient.mjs [workspaceFolder] [url]
 *
 * Flow: initialize → tools/list → get_game_tree (live; also rewrites
 * game.json) → filtered summary → apply_tree_actions create (assert delivery
 * to the fake plugin + snapshot advance + journal) → get_game_tree again
 * (create visible through the plugin's modeled tree) → invalid apply
 * (isError) → verde_status → HTTP hardening spot-checks. Exits 0 on success.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2] ?? process.cwd();
const url = process.argv[3] ?? process.env.MCP_URL ?? "http://127.0.0.1:9124/mcp";
const gameJsonPath = join(workspace, "game.json");
const snapshotPath = join(workspace, ".verde", "snapshot.json");
const opsJournalPath = join(workspace, ".verde", "fake-plugin-ops.json");

const fail = (message) => {
    console.error(`FAIL: ${message}`);
    process.exit(1);
};

const waitFor = (label, check, timeoutMs = 20000) =>
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

let nextId = 1;
let protocolVersion = "2025-06-18";

/** Sends one JSON-RPC request; resolves {status, body} with the raw text. */
async function rpc(method, params) {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
    };
    if (method !== "initialize") {
        headers["MCP-Protocol-Version"] = protocolVersion;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const text = await response.text();
    return { status: response.status, text };
}

/** Sends a request and asserts a JSON-RPC result (not an error). */
async function call(method, params) {
    const { status, text } = await rpc(method, params);
    if (status !== 200) {
        fail(`${method} returned HTTP ${status}: ${text.slice(0, 500)}`);
    }
    const body = text ? JSON.parse(text) : null;
    if (!body || body.error) {
        fail(`${method} returned a JSON-RPC error: ${JSON.stringify(body?.error ?? body)}`);
    }
    return body.result;
}

async function notify(method, params) {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocolVersion,
    };
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    if (response.status !== 202) {
        fail(`${method} expected 202, got ${response.status}`);
    }
}

/** Calls a tool and returns {isError, payload} with the text content parsed
 * as JSON when possible. */
async function callTool(name, args = {}) {
    const result = await call("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") {
        fail(`tool ${name} returned no text content: ${JSON.stringify(result)}`);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = text;
    }
    return { isError: result.isError === true, payload };
}

const assert = (condition, message) => {
    if (!condition) {
        fail(message);
    }
};

try {
    // 1. Initialize.
    const init = await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fakeMcpClient", version: "0.0.0" },
    });
    assert(init.serverInfo?.name === "verde", `unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`);
    if (init.protocolVersion) {
        protocolVersion = init.protocolVersion;
    }
    console.log(`initialized (protocol ${protocolVersion}, server ${init.serverInfo.version})`);
    await notify("notifications/initialized", {});
    console.log("initialized notification accepted (202)");

    // 2. Tool inventory.
    const list = await call("tools/list", {});
    const names = list.tools.map((tool) => tool.name).sort();
    assert(
        JSON.stringify(names) === JSON.stringify(["apply_tree_actions", "get_game_tree", "redo", "undo", "verde_status"]),
        `unexpected tool list: ${JSON.stringify(names)}`,
    );
    console.log(`tools/list: ${names.join(", ")}`);

    // 3. Live read (also rewrites game.json through the export ingest).
    const live = await callTool("get_game_tree", {});
    assert(live.isError === false, `get_game_tree errored: ${JSON.stringify(live.payload)}`);
    assert(live.payload.live === true, `expected a live read, got: ${JSON.stringify(live.payload).slice(0, 300)}`);
    assert(live.payload.node?.children?.Workspace !== undefined, "live read missing Workspace");
    const onDisk = JSON.parse(readFileSync(gameJsonPath, "utf8"));
    assert(onDisk.children?.Workspace !== undefined, "game.json on disk missing Workspace after the live read");
    console.log("get_game_tree: live read rewrote game.json with the export");

    // 4. Filtered summary.
    const summary = await callTool("get_game_tree", { path: ["Workspace"], mode: "summary", maxDepth: 1 });
    assert(summary.isError === false, `summary read errored: ${JSON.stringify(summary.payload)}`);
    assert(summary.payload.summary?.name === "Workspace", `summary name: ${JSON.stringify(summary.payload.summary)}`);
    assert(typeof summary.payload.summary?.childCount === "number" && summary.payload.summary.childCount >= 1, "summary childCount missing");
    console.log(`get_game_tree summary: Workspace has ${summary.payload.summary.childCount} child(ren)`);

    // 5. Apply a create through the MCP surface.
    const apply = await callTool("apply_tree_actions", {
        actions: [{ action: "create", path: ["Workspace", "McpPart"], className: "Part", properties: { Anchored: true } }],
    });
    assert(apply.isError === false, `apply_tree_actions errored: ${JSON.stringify(apply.payload)}`);
    assert(apply.payload.status === "applied", `expected applied, got: ${JSON.stringify(apply.payload)}`);
    assert(apply.payload.applied >= 1, `expected at least one applied action: ${JSON.stringify(apply.payload)}`);

    await waitFor("the snapshot to gain Workspace.McpPart", () => {
        if (!existsSync(snapshotPath)) return false;
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        return snapshot.children?.Workspace?.children?.McpPart !== undefined;
    });
    const journal = JSON.parse(readFileSync(opsJournalPath, "utf8"));
    const last = journal[journal.length - 1];
    assert(
        last && last.actions.length === 1 && last.actions[0].path.join(".") === "Workspace.McpPart",
        `ops journal's last batch is not the single McpPart create: ${JSON.stringify(last)}`,
    );
    console.log("apply_tree_actions: delivered as one batch, acked, snapshot advanced, plugin journaled");

    // 6. The create is visible through the plugin's modeled tree.
    const reread = await callTool("get_game_tree", { path: ["Workspace", "McpPart"] });
    assert(reread.isError === false, `reread errored: ${JSON.stringify(reread.payload)}`);
    assert(reread.payload.node !== undefined && reread.payload.live === true, "McpPart not visible in the live tree");
    console.log("get_game_tree: McpPart visible in the live tree (loop closed)");

    // 7. Invalid apply is rejected with the offending action.
    const invalid = await callTool("apply_tree_actions", {
        actions: [{ action: "update", path: ["Workspace", "DoesNotExist"], properties: {} }],
    });
    assert(invalid.isError === true, `expected isError for an unknown path: ${JSON.stringify(invalid.payload)}`);
    assert(
        JSON.stringify(invalid.payload).includes("Workspace.DoesNotExist"),
        `error should name the missing path: ${JSON.stringify(invalid.payload)}`,
    );
    console.log("apply_tree_actions: invalid batch rejected with the offending action");

    // 8. Status.
    const status = await callTool("verde_status", {});
    assert(status.payload.ws?.connectedClients >= 1, `expected a connected plugin: ${JSON.stringify(status.payload)}`);
    assert(status.payload.gameJsonSync?.enabled === true, "gameJsonSync should be enabled");
    assert(status.payload.gameJsonSync?.pendingQueue === 0, `expected an empty queue: ${JSON.stringify(status.payload)}`);
    assert(status.payload.gameJsonSync?.baselineInitialised === true, "baseline should be initialised");
    assert(status.payload.mcp?.running === true, "mcp should report running");
    console.log(`verde_status: ${JSON.stringify(status.payload)}`);

    // 9. HTTP hardening spot-checks.
    const get = await fetch(url, { method: "GET" });
    assert(get.status === 405, `GET expected 405, got ${get.status}`);
    const withOrigin = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} }),
    });
    assert(withOrigin.status === 403, `browser-origin POST expected 403, got ${withOrigin.status}`);
    console.log("hardening: GET 405, browser-origin POST 403");

    console.log("MCP SMOKE OK");
    process.exit(0);
} catch (err) {
    fail(String(err));
}
