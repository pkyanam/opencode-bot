import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  sandbox: {
    getProcess: vi.fn(),
    startProcess: vi.fn(),
    containerFetch: vi.fn(),
  },
}));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => mock.sandbox }));
import { CloudflareHindsight } from "./hindsight-cloudflare";

beforeEach(() => {
  vi.clearAllMocks();
  mock.sandbox.getProcess.mockResolvedValue({
    status: "running",
    waitForPort: vi.fn(),
  });
});
function fixture() {
  const instance = vi.fn();
  return {
    instance,
    service: new CloudflareHindsight({
      namespace: {},
      token: "service-secret",
      origin: async () => "https://workspace.test",
      modelToken: async () => "scoped-model-secret",
      instance,
    }),
  };
}
describe("native Hindsight readiness", () => {
  it("waits for actual upstream readiness before forwarding bank operations", async () => {
    mock.sandbox.containerFetch.mockImplementation(async (url: string) =>
      url.endsWith("/configure")
        ? Response.json({ configured: true })
        : Response.json(
            { instanceId: "epoch-1", upstreamReady: false },
            { status: 503 },
          ),
    );
    const { service, instance } = fixture();
    await expect(service.fetch("/v1/default/banks/test")).rejects.toThrow(
      "starting its database",
    );
    expect(instance).toHaveBeenCalledWith("epoch-1");
    expect(
      mock.sandbox.containerFetch.mock.calls.some(([url]) =>
        url.includes("/banks/"),
      ),
    ).toBe(false);
  });
  it("uses supervisor upstreamReady and supplies only the scoped model credential", async () => {
    mock.sandbox.containerFetch.mockImplementation(async (url: string) =>
      url.endsWith("/health")
        ? Response.json({ instanceId: "epoch-2", upstreamReady: true })
        : Response.json({ ok: true }),
    );
    const { service } = fixture();
    expect((await service.fetch("/v1/default/banks/test")).ok).toBe(true);
    const configure = mock.sandbox.containerFetch.mock.calls.find(([url]) =>
      url.endsWith("/configure"),
    );
    expect(JSON.parse(configure![1].body)).toEqual({
      llmBaseUrl: "https://workspace.test/internal/hindsight/ai/v1",
      llmApiKey: "scoped-model-secret",
      llmModel: "@cf/zai-org/glm-5.3-flash",
    });
    expect(mock.sandbox.containerFetch.mock.calls.at(-1)![0]).toContain(
      "/banks/test",
    );
  });
});
