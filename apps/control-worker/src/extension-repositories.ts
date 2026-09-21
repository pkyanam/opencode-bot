import { parse as parseYaml } from "yaml";
/** Safe discovery helpers for public GitHub Agent Skills repositories.
 *
 * Repository contents are untrusted data. These helpers only use GitHub's
 * read APIs, cap response sizes, reject traversal paths, and never execute
 * repository code. Files are handed to the runner only after SKILL.md
 * metadata has been validated.
 */

export const EXTENSION_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS extension_repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  ref TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const MAX_TREE_ENTRIES = 2_000;
export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_DOWNLOAD_BYTES = 10_000_000;

export type GitHubRepository = {
  owner: string;
  name: string;
  ref: string;
  url: string;
};

export type RepositoryTreeEntry = {
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha?: string;
};

export class ExtensionRepositoryError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ExtensionRepositoryError";
  }
}

const repoPart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** Normalize only public github.com owner/repository URLs. */
export function parseGitHubRepositoryUrl(value: string): GitHubRepository {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ExtensionRepositoryError(400, "a valid GitHub repository URL is required"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash)
    throw new ExtensionRepositoryError(400, "repository URL must be an https github.com URL without credentials or query parameters");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || !repoPart.test(parts[0]) || !repoPart.test(parts[1]))
    throw new ExtensionRepositoryError(400, "repository URL must look like https://github.com/owner/repository");
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/, "");
  if (!repoPart.test(name)) throw new ExtensionRepositoryError(400, "invalid repository name");
  const ref = parts[2] ? safeRelativePath(decodeURIComponent(parts[2])) : "HEAD";
  return { owner, name, ref, url: `https://github.com/${owner}/${name}${parts[2] ? `/${encodeURIComponent(ref)}` : ""}` };
}

/** Paths are repository-relative and may not cross a directory boundary. */
export function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.startsWith("/") || value.includes("\\"))
    throw new ExtensionRepositoryError(400, "a safe relative path is required");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
    throw new ExtensionRepositoryError(400, "path contains a forbidden segment");
  return parts.join("/");
}

export function repositoryId(repo: Pick<GitHubRepository, "owner" | "name" | "ref">): string {
  return `${repo.owner}/${repo.name}@${repo.ref}`;
}

function boundedHeader(headers: Headers): Headers {
  const out = new Headers({ "user-agent": "opencode-bot", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
  const token = headers.get("authorization");
  if (token && /^Bearer [A-Za-z0-9._-]{1,500}$/.test(token)) out.set("authorization", token);
  return out;
}

async function githubJson<T>(url: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const headers = boundedHeader(new Headers(init.headers));
  const response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ExtensionRepositoryError(response.status === 404 ? 404 : [403,429].includes(response.status) ? 429 : 502, `GitHub request failed (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 2_000_000) throw new ExtensionRepositoryError(502, "GitHub response is too large");
  try { return await response.json() as T; } catch { throw new ExtensionRepositoryError(502, "GitHub returned invalid JSON"); }
}

const treeCache = new Map<string, {expires:number; promise:Promise<RepositoryTreeEntry[]>}>();
export async function listRepositoryTree(repo: GitHubRepository, fetchImpl: typeof fetch = fetch): Promise<RepositoryTreeEntry[]> {
  const key = repositoryId(repo);
  const cached = treeCache.get(key);
  if (fetchImpl === fetch && cached && cached.expires > Date.now()) return cached.promise;
  const promise = readRepositoryTree(repo, fetchImpl).catch(error => { treeCache.delete(key); throw error; });
  if (fetchImpl === fetch) { if(treeCache.size >= 10) treeCache.delete(treeCache.keys().next().value!); treeCache.set(key,{expires:Date.now()+300000,promise}); }
  return promise;
}
async function readRepositoryTree(repo: GitHubRepository, fetchImpl: typeof fetch): Promise<RepositoryTreeEntry[]> {
  const encoded = `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  let data;
  try { data = await githubJson<{ truncated?: boolean; tree?: Array<{ path?: unknown; type?: unknown; size?: unknown; sha?: unknown; mode?: string }> }>(
    `https://api.github.com/repos/${encoded}/git/trees/${encodeURIComponent(repo.ref)}?recursive=1`, {}, fetchImpl); }
  catch(error) {
    if (!(error instanceof ExtensionRepositoryError) || error.status !== 429) throw error;
    return archiveRepositoryTree(repo, fetchImpl);
  }
  if (data.truncated || !Array.isArray(data.tree) || data.tree.length > MAX_TREE_ENTRIES) throw new ExtensionRepositoryError(502, "repository tree is too large");
  return data.tree.flatMap((entry) => entry.mode !== "120000" && typeof entry.path === "string" && (entry.type === "blob" || entry.type === "tree")
    ? [{ path: entry.path, type: entry.type, ...(typeof entry.size === "number" ? { size: entry.size } : {}), ...(typeof entry.sha === "string" ? { sha: entry.sha } : {}) }] : []);
}

export async function fetchRepositoryBytes(repo: GitHubRepository, filePath: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const safe = safeRelativePath(filePath);
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(repo.ref)}/${safe.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetchImpl(raw, { headers: { accept: "application/octet-stream", "user-agent": "opencode-bot" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ExtensionRepositoryError(response.status === 404 ? 404 : 502, `GitHub file request failed (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_FILE_BYTES) throw new ExtensionRepositoryError(502, "repository file is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtensionRepositoryError(502, "repository file is too large");
  return bytes;
}

export async function fetchRepositoryFile(repo: GitHubRepository, filePath: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  return new TextDecoder().decode(await fetchRepositoryBytes(repo, filePath, fetchImpl));
}

export type SkillMetadata = { name: string; description: string; license?: string; compatibility?: string; metadata?: Record<string, unknown> };

/** Validate the required Agent Skills frontmatter without interpreting Markdown. */
export function parseSkillMarkdown(markdown: string, expectedName?: string): SkillMetadata {
  if (typeof markdown !== "string" || markdown.length < 1 || markdown.length > MAX_FILE_BYTES) throw new ExtensionRepositoryError(400, "SKILL.md is missing or too large");
  const match = markdown.match(/^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new ExtensionRepositoryError(400, "SKILL.md must start with YAML frontmatter");
  let fields: Record<string, unknown>;
  try { fields = parseYaml(match[1], {maxAliasCount:10}); } catch { throw new ExtensionRepositoryError(400, "SKILL.md has invalid YAML frontmatter"); }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new ExtensionRepositoryError(400, "SKILL.md frontmatter must be a mapping");
  const values = new Map(Object.entries(fields).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
  const name = values.get("name") ?? "";
  const description = values.get("description") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--") || name.length > 64)
    throw new ExtensionRepositoryError(400, "SKILL.md has an invalid name");
  if (expectedName && name !== expectedName) throw new ExtensionRepositoryError(400, "skill name does not match its directory");
  if (!description || description.length > 1024) throw new ExtensionRepositoryError(400, "SKILL.md has an invalid description");
  return { name, description, ...(values.get("license") ? { license: values.get("license") } : {}), ...(values.get("compatibility") ? { compatibility: values.get("compatibility") } : {}) };
}

export function skillDirectoryFromPath(skillPath: string): string {
  const clean = safeRelativePath(skillPath).replace(/\/$/, "");
  if (clean.endsWith("/SKILL.md")) return clean.slice(0, -"/SKILL.md".length);
  if (clean === "SKILL.md") return "";
  throw new ExtensionRepositoryError(400, "skillPath must point to SKILL.md");
}

export function normalizeTreeFiles(entries: RepositoryTreeEntry[], directory: string): string[] {
  const prefix = directory ? `${directory}/` : "";
  const files = entries.filter((entry) => {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) return false;
    const relative = entry.path.slice(prefix.length);
    return relative.length > 0 && relative.split("/").every((part) => part !== ".." && !part.startsWith("."));
  }).map((entry) => entry.path);
  if (files.length < 1 || files.length > MAX_FILES || !files.includes(`${prefix}SKILL.md`)) throw new ExtensionRepositoryError(400, "skill directory must contain SKILL.md and a bounded number of files");
  return files;
}

export function extensionRepositoryView(row: any): Record<string, unknown> {
  return { id: row.id, owner: row.owner, name: row.name, ref: row.ref, url: row.url, createdAt: row.created_at, updatedAt: row.updated_at };
}


/** Public archives avoid GitHub's shared anonymous API quota on cloud egress. */
async function archiveRepositoryTree(repo: GitHubRepository, fetchImpl: typeof fetch): Promise<RepositoryTreeEntry[]> {
  const response = await fetchImpl(`https://codeload.github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/tar.gz/${encodeURIComponent(repo.ref)}`, {signal:AbortSignal.timeout(20000),headers:{"user-agent":"opencode-bot"}});
  if (!response.ok || !response.body) throw new ExtensionRepositoryError(502,"Could not download the public repository archive");
  const reader = response.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[]=[]; let size=0;
  try { for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>16_000_000)throw new ExtensionRepositoryError(413,"Repository archive exceeds the 16 MB discovery limit"); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>undefined); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return parseRepositoryArchive(bytes);
}

export function parseRepositoryArchive(bytes:Uint8Array):RepositoryTreeEntry[] {
  const decoder=new TextDecoder(); const entries:RepositoryTreeEntry[]=[];
  const text=(start:number,length:number)=>decoder.decode(bytes.subarray(start,start+length)).replace(/\0.*$/s,"");
  let nextPath:string|undefined;
  for(let offset=0;offset+512<=bytes.length;) {
    const name=text(offset,100); if(!name)break;
    const rawSize=text(offset+124,12).trim();
    if(!/^[0-7]+$/.test(rawSize))throw new ExtensionRepositoryError(502,"Invalid repository archive");
    const size=parseInt(rawSize,8), type=text(offset+156,1), prefix=text(offset+345,155);
    if(offset+512+size>bytes.length)throw new ExtensionRepositoryError(502,"Incomplete repository archive");
    let fullPath=nextPath ?? (prefix?`${prefix}/${name}`:name); nextPath=undefined;
    if(type==="x") { const pax=text(offset+512,size); const found=pax.match(/(?:^|\n)\d+ path=([^\n]+)/); nextPath=found?.[1]; }
    else if(type==="L") nextPath=text(offset+512,size);
    else if(["0","","5"].includes(type)) {
      const slash=fullPath.indexOf("/"); const relative=slash<0?"":fullPath.slice(slash+1).replace(/\/$/,"");
      if(relative) { try {safeRelativePath(relative);entries.push({path:relative,type:type==="5"?"tree":"blob",size});}catch{} }
      if(entries.length>MAX_TREE_ENTRIES)throw new ExtensionRepositoryError(413,"Repository has too many files");
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  return entries;
}
