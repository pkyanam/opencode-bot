import { validateReleaseBundle, type ReleaseBundle } from "./updater";

export type UpdateRelease = {
  version: string;
  commit: string;
  image: { reference: string };
  updater?: { file: string; sha256: string; size: number };
};
const repository = "https://github.com/pkyanam/opencode-bot";
const trustedDownload = (url: string) => {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && ["github.com", "release-assets.githubusercontent.com"].includes(parsed.hostname);
};
export const newerVersion = (candidate: string, current: string) => {
  if (!/^v?\d+\.\d+\.\d+$/.test(candidate) || !/^v?\d+\.\d+\.\d+$/.test(current)) return false;
  const a = candidate.replace(/^v/, "").split(".").map(Number);
  const b = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
async function bytes(url: string, limit: number, fetcher: typeof fetch) {
  const result = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!result.ok || (result.url && !trustedDownload(result.url))) throw new Error("The release download is unavailable. Try again shortly.");
  if (Number(result.headers.get("content-length") ?? 0) > limit) throw new Error("The release download exceeds its size limit.");
  if (!result.body) throw new Error("The release download was empty.");
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = result.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("The release download exceeds its size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
export async function fetchUpdateRelease(version?: string, fetcher: typeof fetch = fetch): Promise<UpdateRelease> {
  if (version && !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
  const path = version ? `download/${version}` : "latest/download";
  const release = JSON.parse(new TextDecoder().decode(await bytes(`${repository}/releases/${path}/release-manifest.json`, 64 * 1024, fetcher)));
  if (release.schemaVersion !== 2 || !/^v\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{40}$/.test(release.commit) || (version && release.version !== version)) throw new Error("The release manifest is invalid.");
  if (!/^docker\.io\/preethamk\/opencode-bot@sha256:[a-f0-9]{64}$/.test(release.image?.reference ?? "")) throw new Error("The release image is not trusted.");
  if (release.updater && (release.updater.file !== "app-bundle.json" || !/^[a-f0-9]{64}$/.test(release.updater.sha256) || !Number.isSafeInteger(release.updater.size) || release.updater.size <= 0 || release.updater.size > 32 * 1024 * 1024)) throw new Error("The update bundle metadata is invalid.");
  return release;
}
export async function fetchUpdateBundle(version: string, fetcher: typeof fetch = fetch): Promise<ReleaseBundle> {
  const release = await fetchUpdateRelease(version, fetcher);
  if (!release.updater) throw new Error("This release does not include an in-app update bundle.");
  const data = await bytes(`${repository}/releases/download/${version}/app-bundle.json`, release.updater.size, fetcher);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(v => v.toString(16).padStart(2, "0")).join("");
  if (data.length !== release.updater.size || digest !== release.updater.sha256) throw new Error("Update bundle verification failed. Nothing has been changed.");
  const bundle = JSON.parse(new TextDecoder().decode(data)) as ReleaseBundle;
  if (bundle.version !== version || bundle.commit !== release.commit || bundle.computerImage.reference !== release.image.reference) throw new Error("The update bundle does not match its release.");
  // The verified digest belongs to the published file, never a self-reported field.
  bundle.bundleSha256 = digest;
  validateReleaseBundle(bundle);
  return bundle;
}
