import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  sandbox: {
    getProcess: vi.fn(),
    startProcess: vi.fn(),
    containerFetch: vi.fn(),
  },
  getSandbox: vi.fn(),
}));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: (...args: unknown[]) => mock.getSandbox(...args) }));
import { CloudflareHindsight } from "./hindsight-cloudflare";

beforeEach(() => {
  vi.clearAllMocks();
  mock.getSandbox.mockReturnValue(mock.sandbox);
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
    expect(mock.sandbox.containerFetch.mock.calls.every(([, init]) => !init.signal)).toBe(true);
  });

  it("discards a sandbox handle only after the deployment reset signal", async () => {
    const replacement = {
      getProcess: vi.fn().mockResolvedValue({ status: "running", waitForPort: vi.fn() }),
      startProcess: vi.fn(),
      containerFetch: vi.fn(async (url: string) => url.endsWith("/health")
        ? Response.json({ instanceId: "epoch-2", upstreamReady: true })
        : Response.json({ ok: true })),
    };
    let first = true;
    mock.sandbox.containerFetch.mockImplementation(async () => {
      if (first) {
        first = false;
        throw new Error("Durable Object reset because its code was updated");
      }
      return Response.json({ ok: true });
    });
    mock.getSandbox.mockReturnValueOnce(mock.sandbox).mockReturnValueOnce(replacement);
    const { service } = fixture();
    await expect(service.fetch("/v1/default/banks/test")).rejects.toThrow("Durable Object reset");
    await expect(service.fetch("/v1/default/banks/test")).resolves.toMatchObject({ ok: true });
    expect(mock.getSandbox).toHaveBeenCalledTimes(2);
  });

  it("also refreshes after the known inactive-instance connection close", async () => {
    const replacement = {
      getProcess: vi.fn().mockResolvedValue({ status: "running", waitForPort: vi.fn() }),
      startProcess: vi.fn(),
      containerFetch: vi.fn(async (url: string) => url.endsWith("/health")
        ? Response.json({ instanceId: "epoch-3", upstreamReady: true })
        : Response.json({ ok: true })),
    };
    let first = true;
    mock.sandbox.containerFetch.mockImplementation(async () => {
      if (first) {
        first = false;
        throw new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.");
      }
      return Response.json({ ok: true });
    });
    mock.getSandbox.mockReturnValueOnce(mock.sandbox).mockReturnValueOnce(replacement);
    const { service } = fixture();
    await expect(service.fetch("/v1/default/banks/test")).rejects.toThrow("no longer active");
    await expect(service.fetch("/v1/default/banks/test")).resolves.toMatchObject({ ok: true });
    expect(mock.getSandbox).toHaveBeenCalledTimes(2);
  });

  it("reuses the sandbox handle after an ordinary transport error", async () => {
    let first = true;
    mock.sandbox.containerFetch.mockImplementation(async (url: string) => {
      if (first) {
        first = false;
        throw new Error("upstream connection reset");
      }
      return url.endsWith("/health")
        ? Response.json({ instanceId: "epoch-1", upstreamReady: true })
        : Response.json({ ok: true });
    });
    const { service } = fixture();
    await expect(service.fetch("/v1/default/banks/test")).rejects.toThrow("connection reset");
    await expect(service.fetch("/v1/default/banks/test")).resolves.toMatchObject({ ok: true });
    expect(mock.getSandbox).toHaveBeenCalledTimes(1);
  });
});
