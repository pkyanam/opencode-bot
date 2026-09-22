export type BundleModule = {
  name: string;
  contentBase64: string;
  contentType: string;
};

export type BundleAsset = {
  path: string;
  contentBase64: string;
  hash: string;
  sha256: string;
  size: number;
  contentType?: string;
};

export type ReleaseBundle = {
  schemaVersion: 1;
  version: string;
  commit: string;
  worker: {
    requiredBindings: Array<{ name: string; type: string }>;
    mainModule: string;
    modules: BundleModule[];
    compatibilityDate: string;
    compatibilityFlags: string[];
    metadata: { assets: { config: typeof import("./build-bundle.mjs").ASSETS_ROUTING_CONFIG } };
  };
  assets: BundleAsset[];
  computerImage: { reference: string; digest: string; fingerprint?: string };
  runtime: { opencodeVersion: string; sandboxVersion: string };
  bundleSha256: string;
};

export const CONTENT_TYPES: typeof import("./build-bundle.mjs").CONTENT_TYPES;
export const ASSETS_ROUTING_CONFIG: {
  readonly not_found_handling: "single-page-application";
  readonly run_worker_first: readonly ["/api/*", "/internal/*"];
};
export function sha256(bytes: Uint8Array | Buffer): string;
export function buildBundle(options: {
  output: string;
  workerDirectory: string;
  assetsDirectory: string;
  version: string;
  commit: string;
  imageReference: string;
  imageDigest: string;
  imageFingerprint?: string;
  skipBuild?: boolean;
}): Promise<ReleaseBundle>;
