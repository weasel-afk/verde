import * as http from "http";
import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VerdeBackend } from "../backend";
import { GameJsonSync } from "../gameJsonSync";
import { McpToolContext, registerVerdeTools } from "./tools";

/**
 * A loopback-only MCP HTTP server hosted in the extension process. Each POST
 * is served by a fresh stateless McpServer + transport (the SDK's documented
 * stateless pattern): no sessions, no server-initiated SSE, JSON responses.
 * Tool state lives entirely in the backend, the current GameJsonSync and the
 * game.json document — never in the transport.
 */

/** The MCP server only ever binds loopback; not configurable. */
const MCP_HOST = "127.0.0.1";

/** Request bodies beyond this size are refused before parsing. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface McpBridgeOptions {
    backend: VerdeBackend;
    getGameJsonSync: () => GameJsonSync | null;
    outputChannel: vscode.OutputChannel;
    port: number;
    wsPort: () => number;
}

export class McpBridge implements vscode.Disposable {
    private readonly options: McpBridgeOptions;
    private server: http.Server | null = null;
    private disposed = false;

    constructor(options: McpBridgeOptions) {
        this.options = options;
    }

    public get running(): boolean {
        return this.server?.listening ?? false;
    }

    public get endpoint(): string {
        return `http://${MCP_HOST}:${this.options.port}/mcp`;
    }

    /** Starts listening; rejects on bind errors (e.g. EADDRINUSE). */
    public start(): Promise<void> {
        if (this.server || this.disposed) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const server = http.createServer((request, response) => {
                void this.handleRequest(request, response);
            });
            server.once("error", (err) => {
                if (this.server === server) {
                    this.server = null;
                }
                reject(err);
            });
            server.listen(this.options.port, MCP_HOST, () => {
                this.log(`listening on ${this.endpoint}`);
                if (server.listening) {
                    resolve();
                }
            });
            this.server = server;
        });
    }

    public dispose(): void {
        this.disposed = true;
        if (this.server) {
            this.server.close();
            this.server.closeAllConnections();
            this.server = null;
            this.log("stopped");
        }
    }

    private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        try {
            const url = new URL(request.url ?? "/", `http://${MCP_HOST}`);
            if (url.pathname !== "/mcp") {
                response.writeHead(404).end();
                return;
            }
            if (request.method !== "POST") {
                // Stateless server: no sessions to terminate and no
                // server-initiated SSE stream.
                response.writeHead(405, { "Content-Type": "application/json" }).end(
                    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
                );
                return;
            }
            if (request.headers.origin !== undefined) {
                // Browsers always send Origin; local MCP clients do not.
                // Refusing browser-originated POSTs blocks DNS-rebinding and
                // CSRF against the loopback listener.
                response.writeHead(403).end();
                return;
            }
            await this.handlePost(request, response);
        } catch (err) {
            this.log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (!response.headersSent) {
                response.writeHead(500).end();
            }
        }
    }

    private async handlePost(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const body = await this.readBody(request);
        if (body === null) {
            response.writeHead(413).end();
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            response.writeHead(400, { "Content-Type": "application/json" }).end(
                JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
            );
            return;
        }

        const server = new McpServer({ name: "verde", version: extensionVersion() });
        registerVerdeTools(server, this.toolContext());
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        response.on("close", () => {
            void transport.close().catch(() => {});
            void server.close().catch(() => {});
        });

        await server.connect(transport);
        await transport.handleRequest(request, response, parsed);
    }

    private readBody(request: http.IncomingMessage): Promise<string | null> {
        return new Promise((resolve) => {
            const chunks: Buffer[] = [];
            let size = 0;
            request.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    resolve(null);
                    request.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            request.on("error", () => resolve(null));
        });
    }

    private toolContext(): McpToolContext {
        return {
            backend: this.options.backend,
            getGameJsonSync: this.options.getGameJsonSync,
            wsPort: this.options.wsPort,
            mcpInfo: () => ({
                enabled: true,
                port: this.options.port,
                endpoint: this.endpoint,
                running: this.running,
            }),
        };
    }

    private log(message: string): void {
        this.options.outputChannel.appendLine(`[verde/mcp] ${message}`);
    }
}

function extensionVersion(): string {
    const extension = vscode.extensions.getExtension("Dvitash.verde");
    const version = extension?.packageJSON?.version;
    return typeof version === "string" ? version : "0.0.0";
}
