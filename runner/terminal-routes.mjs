import { TerminalRegistry, httpError } from "./terminal.mjs";

/**
 * HTTP polling routes for the native TUI. The outer runner authenticates the
 * request with RUNNER_TOKEN; this module only handles terminal lifecycle.
 * `resolveConnection` is trusted runner code and is the sole source of the
 * OpenCode endpoint and credentials. Browser input cannot choose either.
 */
export function createTerminalRoutes(options = {}) {
  const registry = options.registry ?? new TerminalRegistry(options);
  const resolveConnection = options.resolveConnection;
  if (typeof resolveConnection !== "function") throw new Error("resolveConnection is required");

  async function handle(req, res) {
    const url = new URL(req.url, "http://runner");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "terminal" && segments[0] !== "terminals") return false;
    try {
      if ((segments.length === 1 || (segments.length === 2 && segments[1] === "attach")) && req.method === "POST") {
        const body = await readJson(req);
        if (body.serverUrl || body.authEnv || body.command) throw httpError(400, "terminal connection is runner-owned");
        if (!body.sessionId || typeof body.sessionId !== "string") throw httpError(400, "sessionId is required");
        const connection = await resolveConnection(body.sessionId);
        if (!connection || connection.sessionId !== body.sessionId) throw httpError(404, "session not found");
        return send(res, 201, await registry.attach(connection));
      }
      if (segments.length !== 2 && segments.length !== 3) throw httpError(404, "terminal route not found");
      const id = decodeURIComponent(segments[1]);
      const terminal = registry.get(id);
      if (!terminal) throw httpError(404, "terminal not found");
      if (segments.length === 3 && req.method === "GET" && segments[2] === "output") return send(res, 200, { terminalId: id, sessionId: terminal.sessionId, ...terminal.read(url.searchParams.get("after") ?? url.searchParams.get("offset")) });
      if (segments.length === 3 && req.method === "POST" && segments[2] === "input") {
        const body = await readJson(req);
        if (typeof body.data !== "string") throw httpError(400, "data is required");
        terminal.write(body.data);
        return send(res, 202, { accepted: body.data.length });
      }
      if (segments.length === 3 && req.method === "POST" && segments[2] === "resize") {
        const body = await readJson(req);
        return send(res, 200, { terminalId: id, ...terminal.resize(body.cols, body.rows) });
      }
      if (req.method === "DELETE") return send(res, 200, await registry.close(id));
      throw httpError(405, "method not allowed");
    } catch (error) { return send(res, error.statusCode ?? 500, { error: error.message ?? String(error) }); }
  }

  return { registry, handle };
}

function send(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; }
async function readJson(req) {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw httpError(413, "request body too large"); }
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw httpError(400, "invalid JSON"); }
}
