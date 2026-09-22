import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SOURCE_REPOSITORY = "https://github.com/pkyanam/opencode-bot";
const MAX_DOC_BYTES = 8_000;
const MAX_MANIFEST_BYTES = 64_000;
const DOCS = Object.freeze({
  overview: "README.md",
  setup: "docs/getting-started.md",
  memory: "docs/memory.md",
  nodes: "docs/node-affinity.md",
  security: "SECURITY.md",
  development: "docs/self-development.md",
});
const CAPABILITY_LINKS = Object.freeze({
  memory: "docs/memory.md",
  nodes: "docs/node-affinity.md",
  setup: "docs/getting-started.md",
  security: "SECURITY.md",
  development: "docs/self-development.md",
});

function boundedText(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

function safeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = {};
  for (const key of ["version", "commit", "opencodeVersion", "sandboxVersion", "buildImageDigest"]) {
    const text = boundedText(value[key], 200);
    if (text) output[key] = text;
  }
  if (value.image && typeof value.image === "object") {
    const reference = boundedText(value.image.reference, 300);
    const fingerprint = boundedText(value.image.fingerprint, 100);
    if (reference || fingerprint) output.image = { ...(reference ? { reference } : {}), ...(fingerprint ? { fingerprint } : {}) };
  }
  return Object.keys(output).length ? output : undefined;
}

async function readManifest(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.basename(filePath) !== "release-manifest.json") return undefined;
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) return undefined;
    return safeManifest(JSON.parse(text));
  } catch { return undefined; }
}

function error(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

/**
 * Read-only, deliberately small self-awareness surface for a running bot.
 * All deployment identity comes from the caller's run context or an explicit
 * release manifest. It never scans the environment, filesystem, or git repo.
 */
export function createSelfContext(options = {}) {
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const manifest = safeManifest(options.releaseManifest);
  const buildpack = safeManifest(options.buildpack);
  const version = boundedText(options.version, 100) ?? manifest?.version ?? boundedText(process.env.RELEASE_VERSION, 100);
  const commit = manifest?.commit ?? boundedText(options.commit, 100) ?? boundedText(process.env.RELEASE_COMMIT, 100);
  const deploymentId = boundedText(context.deploymentId, 160) ?? boundedText(options.deploymentId, 160) ?? boundedText(process.env.OPENCODE_BOT_DEPLOYMENT_ID, 160);
  const hostingProvider = boundedText(context.hostingProvider, 40) ?? boundedText(options.hostingProvider, 40) ?? boundedText(process.env.OPENCODE_BOT_HOSTING_PROVIDER, 40) ?? "unknown";
  const nodeId = boundedText(context.executionNodeId, 160) ?? boundedText(context.nodeId, 160);
  const botName = boundedText(context.botName, 160);
  const model = boundedText(context.model, 240);
  const capabilities = Array.isArray(context.capabilities) ? context.capabilities.filter((item) => typeof item === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(item)).slice(0, 32) : [];

  async function inspect(topic = "all") {
    const requested = topic === undefined || topic === "" ? "all" : String(topic);
    const allowed = new Set(["all", "identity", "deployment", "source", "capabilities"]);
    if (!allowed.has(requested)) throw error(400, "unsupported self-awareness topic");
    const result = {
      trust: "limited_deployment_context",
      source: { repository: SOURCE_REPOSITORY, ...(commit ? { commit } : {}) },
      ...(version ? { version } : {}),
      ...(deploymentId ? { deploymentId } : {}),
      hostingProvider,
      ...(nodeId ? { nodeId } : {}),
      ...(botName ? { botName } : {}),
      ...(model ? { model } : {}),
      ...(requested === "all" || requested === "capabilities" ? { capabilities, capabilityDocs: CAPABILITY_LINKS } : {}),
    };
    if (requested === "identity") return { trust: result.trust, ...(botName ? { botName } : {}), ...(model ? { model } : {}), ...(nodeId ? { nodeId } : {}) };
    if (requested === "deployment") return { trust: result.trust, hostingProvider, ...(version ? { version } : {}), ...(deploymentId ? { deploymentId } : {}), ...(manifest ? { manifest } : {}), ...(buildpack ? { buildpack } : {}) };
    if (requested === "source") return { trust: result.trust, source: result.source };
    return result;
  }

  async function docs(topic) {
    const filename = DOCS[String(topic ?? "")];
    if (!filename) throw error(400, "unsupported self-documentation topic");
    const configuredRoot = options.docsRoot ?? process.env.OPENCODE_BOT_DOCS_ROOT;
    const root = path.resolve(typeof configuredRoot === "string" && path.isAbsolute(configuredRoot) ? configuredRoot : fileURLToPath(new URL("../", import.meta.url)));
    const target = path.resolve(root, filename);
    if (!target.startsWith(`${root}${path.sep}`)) throw error(400, "invalid documentation topic");
    try {
      const text = await fs.readFile(target, "utf8");
      return { topic, source: filename, content: text.slice(0, MAX_DOC_BYTES), truncated: text.length > MAX_DOC_BYTES };
    } catch { throw error(404, "documentation is unavailable"); }
  }

  return { inspect, docs };
}

export { DOCS, SOURCE_REPOSITORY, readManifest };
