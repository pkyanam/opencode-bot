import { n as Sandbox } from "../sandbox-BtaWcmmG.js";
import { c as OpencodeStartupContext } from "../contexts-C186NnAB.js";
import { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Config } from "@opencode-ai/sdk/v2";

//#region src/opencode/types.d.ts
/**
 * Configuration options for starting OpenCode server
 */
interface OpencodeOptions {
  /** Port for OpenCode server (default: 4096) */
  port?: number;
  /** Working directory for OpenCode (default: container's cwd) */
  directory?: string;
  /** OpenCode configuration */
  config?: Config;
  /** Additional environment variables to pass to the OpenCode process */
  env?: Record<string, string>;
}
/**
 * Server lifecycle management
 */
interface OpencodeServer {
  /** Port the server is running on */
  port: number;
  /** Base URL for SDK client (http://localhost:{port}) */
  url: string;
  /** Close the server gracefully */
  close(): Promise<void>;
}
/**
 * Result from createOpencode()
 * Client type comes from @opencode-ai/sdk (user's version)
 */
interface OpencodeResult<TClient = OpencodeClient> {
  /** OpenCode SDK client with Sandbox transport */
  client: TClient;
  /** Server lifecycle management */
  server: OpencodeServer;
}
/**
 * Error thrown when OpenCode server fails to start
 */
declare class OpencodeStartupError extends Error {
  readonly code: "OPENCODE_STARTUP_FAILED";
  readonly context: OpencodeStartupContext;
  constructor(message: string, context: OpencodeStartupContext, options?: ErrorOptions);
}
//#endregion
//#region src/opencode/opencode.d.ts
/**
 * Starts an OpenCode server inside a Sandbox container.
 *
 * This function manages the server lifecycle only - use `createOpencode()` if you
 * also need a typed SDK client for programmatic access.
 *
 * If an OpenCode server is already running on the specified port, this function
 * will reuse it instead of starting a new one.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to server handle { port, url, close() }
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencodeServer } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const server = await createOpencodeServer(sandbox, {
 *   directory: '/home/user/my-project',
 *   config: {
 *     provider: {
 *       anthropic: {
 *         options: { apiKey: env.ANTHROPIC_KEY }
 *       },
 *       // Or use Cloudflare AI Gateway (with unified billing, no provider keys needed).
 *       // 'cloudflare-ai-gateway': {
 *       //   options: {
 *       //     accountId: env.CF_ACCOUNT_ID,
 *       //     gatewayId: env.CF_GATEWAY_ID,
 *       //     apiToken: env.CF_API_TOKEN
 *       //   },
 *       //   models: { 'anthropic/claude-sonnet-4-5-20250929': {} }
 *       // }
 *     }
 *   }
 * })
 *
 * // Proxy requests to the web UI
 * return sandbox.containerFetch(request, server.port)
 *
 * // When done
 * await server.close()
 * ```
 */
declare function createOpencodeServer(sandbox: Sandbox<unknown>, options?: OpencodeOptions): Promise<OpencodeServer>;
/**
 * Creates an OpenCode server inside a Sandbox container and returns a typed SDK client.
 *
 * This function is API-compatible with OpenCode's own createOpencode(), but uses
 * Sandbox process management instead of Node.js spawn. The returned client uses
 * a custom fetch adapter to route requests through the Sandbox container.
 *
 * If an OpenCode server is already running on the specified port, this function
 * will reuse it instead of starting a new one.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to { client, server }
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencode } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const { client, server } = await createOpencode(sandbox, {
 *   directory: '/home/user/my-project',
 *   config: {
 *     provider: {
 *       anthropic: {
 *         options: { apiKey: env.ANTHROPIC_KEY }
 *       },
 *       // Or use Cloudflare AI Gateway (with unified billing, no provider keys needed).
 *       // 'cloudflare-ai-gateway': {
 *       //   options: {
 *       //     accountId: env.CF_ACCOUNT_ID,
 *       //     gatewayId: env.CF_GATEWAY_ID,
 *       //     apiToken: env.CF_API_TOKEN
 *       //   },
 *       //   models: { 'anthropic/claude-sonnet-4-5-20250929': {} }
 *       // }
 *     }
 *   },
 *   // Optional: Pass additional environment variables (e.g., for OTEL telemetry)
 *   env: {
 *     OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
 *     TRACEPARENT: '00-abc123-def456-01'
 *   }
 * })
 *
 * // Use the SDK client for programmatic access
 * const session = await client.session.create()
 *
 * // When done
 * await server.close()
 * ```
 */
declare function createOpencode<TClient = OpencodeClient>(sandbox: Sandbox<unknown>, options?: OpencodeOptions): Promise<OpencodeResult<TClient>>;
/**
 * Proxy a request directly to the OpenCode server.
 *
 * Unlike `proxyToOpencode()`, this helper does not apply any web UI redirects
 * or query parameter rewrites. Use it for API/CLI traffic where raw request
 * forwarding is preferred.
 */
declare function proxyToOpencodeServer(request: Request, sandbox: Sandbox<unknown>, server: OpencodeServer): Promise<Response>;
/**
 * Proxy a request to the OpenCode web UI.
 *
 * This function handles the redirect and proxying only - you must start the
 * server separately using `createOpencodeServer()`.
 *
 * Specifically handles:
 * 1. Ensuring the `?url=` parameter is set (required for OpenCode's frontend to
 *    make API calls through the proxy instead of directly to localhost:4096)
 * 2. Proxying the request to the container
 *
 * @param request - The incoming HTTP request
 * @param sandbox - The Sandbox instance running OpenCode
 * @param server - The OpenCode server handle from createOpencodeServer()
 * @returns Response from OpenCode or a redirect response
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencodeServer, proxyToOpencode } from '@cloudflare/sandbox/opencode'
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const sandbox = getSandbox(env.Sandbox, 'opencode')
 *     const server = await createOpencodeServer(sandbox, {
 *       directory: '/home/user/project',
 *       config: {
 *         provider: {
 *           anthropic: {
 *             options: { apiKey: env.ANTHROPIC_KEY }
 *           },
 *           // Optional: Route all providers through Cloudflare AI Gateway
 *           'cloudflare-ai-gateway': {
 *             options: {
 *               accountId: env.CF_ACCOUNT_ID,
 *               gatewayId: env.CF_GATEWAY_ID,
 *               apiToken: env.CF_API_TOKEN
 *             }
 *           }
 *         }
 *       }
 *     })
 *     return proxyToOpencode(request, sandbox, server)
 *   }
 * }
 * ```
 */
declare function proxyToOpencode(request: Request, sandbox: Sandbox<unknown>, server: OpencodeServer): Response | Promise<Response>;
//#endregion
export { type OpencodeOptions, type OpencodeResult, type OpencodeServer, OpencodeStartupError, createOpencode, createOpencodeServer, proxyToOpencode, proxyToOpencodeServer };
//# sourceMappingURL=index.d.ts.map