import { computerInstallCommand } from "../computer-install";
import { DeviceSettings, readClientIdentity, type ClientIdentity } from "./device-connection";
import { useEffect, useState } from "react";
import {
  Copy,
  RefreshCw,
  ExternalLink,
  Monitor,
  KeyRound,
  Server,
  MessageSquare,
  TerminalSquare,
} from "lucide-react";
import {
  api,
  request,
  getToken,
  setToken,
  type Bot,
  type Catalog,
} from "../api";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { OpenCodeProviders } from "./opencode-providers";
import { AppUpdates } from "./app-updates";
import { McpSettings } from "./mcp-settings";

type Node = {
  id: string;
  name: string;
  platform: string;
  arch: string;
  online: boolean;
  revokedAt?: string;
  lastSeenAt?: string;
  capabilities: { runner: boolean; browser: boolean; desktop: boolean };
};
export function SettingsModal({
  bots,
  onClose,
  onSaved,
  initialTab = "connection",
  onOpenComputer,
}: {
  bots: Bot[];
  onClose: () => void;
  onSaved: () => void;
  initialTab?: string;
  onOpenComputer?: (url: string) => void;
}) {
  const [identity, setIdentity] = useState<ClientIdentity | null>(null);
  useEffect(() => { void readClientIdentity().then(setIdentity).catch(() => {}); }, []);
  const [tab, setTab] = useState(initialTab);
  const [token, setValue] = useState(getToken());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [pairExpired, setPairExpired] = useState(false);
  const [installPlatform, setInstallPlatform] = useState<"unix" | "windows">("unix");
  const [pair, setPair] = useState<{ token: string; expiresAt: string } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramMode, setTelegramMode] = useState<"polling" | "webhook">(
    location.protocol === "https:" ? "webhook" : "polling",
  );
  const [publicUrl, setPublicUrl] = useState(
    location.origin.startsWith("https:") ? location.origin : "",
  );
  const [telegram, setTelegram] = useState<any>(null);
  const [link, setLink] = useState<{
    deepLink: string;
    expiresAt: string;
  } | null>(null);
  const [qr, setQr] = useState("");
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const loadNodes = async () =>
    setNodes((await request<{ nodes: Node[] }>("/api/nodes")).nodes);
  const loadTelegram = async () => {
    if (botId) {
      const result: any = await request(`/api/bots/${botId}/telegram`);
      setTelegram(result);
      if (result.config?.transport) setTelegramMode(result.config.transport);
    }
  };
  useEffect(() => {
    setError("");
    setNotice("");
    if (tab === "nodes") void action(loadNodes);
    if (tab === "runtime")
      void action(async () => setCatalog(await api.catalog()));
    if (tab === "telegram") void action(loadTelegram);
  }, [tab, botId]);
  useEffect(() => {
    if (tab !== "nodes") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible") {
        try {
          const result = await request<{ nodes: Node[] }>("/api/nodes", { signal: controller.signal });
          if (!disposed) setNodes(result.nodes);
        } catch { /* Keep the last known list; manual refresh displays errors. */ }
      }
      if (!disposed) timer = setTimeout(refresh, 5000);
    };
    timer = setTimeout(refresh, 5000);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [tab]);
  useEffect(() => {
    setPairExpired(Boolean(pair && Date.parse(pair.expiresAt) <= Date.now()));
    if (!pair) return;
    const timer = setTimeout(() => setPairExpired(true), Math.max(0, Date.parse(pair.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [pair]);
  useEffect(() => {
    if (tab !== "telegram" || !botId) return;
    const timer = window.setInterval(() => {
      void loadTelegram().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [tab, botId]);
  useEffect(() => {
    if (!link) {
      setQr("");
      return;
    }
    let valid = true;
    void import("qrcode")
      .then((m) =>
        m.toDataURL(link.deepLink, {
          width: 220,
          margin: 2,
          color: { dark: "#121110", light: "#f2eded" },
        }),
      )
      .then((v) => valid && setQr(v));
    return () => {
      valid = false;
    };
  }, [link]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied.");
      setError("");
    } catch {
      setError("Clipboard access was blocked. Select and copy the command instead.");
    }
  };
  const json = (value: unknown) => ({
    method: "POST",
    body: JSON.stringify(value),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="settings-dialog">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>
          Connections, computers, and services for your workspace.
        </DialogDescription>
        <Tabs value={tab} onValueChange={setTab} className="settings-layout">
          <TabsList aria-label="Settings sections" className="settings-nav">
            <TabsTrigger value="connection">
              <KeyRound size={16} />
              Connection
            </TabsTrigger>
            {identity?.role === "owner" && <TabsTrigger value="devices"><Monitor size={16} />Devices</TabsTrigger>}
            {identity?.role === "owner" && <TabsTrigger value="nodes">
              <Monitor size={16} />
              Computers
            </TabsTrigger>}
            {identity?.role === "owner" && <TabsTrigger value="telegram">
              <MessageSquare size={16} />
              Telegram
            </TabsTrigger>}
            {identity?.role === "owner" && <TabsTrigger value="runtime">
              <Server size={16} />
              OpenCode
            </TabsTrigger>}
            {identity?.role === "owner" && <TabsTrigger value="mcp">
              <Server size={16} />
              MCP
            </TabsTrigger>}
            {identity?.role === "owner" && <TabsTrigger value="updates">
              <RefreshCw size={16} />
              Updates
            </TabsTrigger>}
          </TabsList>
          <div className="settings-body">
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <p className="settings-notice" role="status">
                {notice}
              </p>
            )}
            <TabsContent value="connection">
              <h3>Connection</h3>
              <p>
                {identity?.role === "client" ? `Connected as ${identity.deviceName ?? "a paired device"}. This device has its own credential; the owner can revoke it in Devices.` : "Your owner connection is saved in this browser. Use Devices to connect another browser without sharing this token."}
              </p>
              <label className="field-label" htmlFor="settings-token">
                Application token
              </label>
              <input
                id="settings-token"
                className="settings-input"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setValue(e.target.value)}
              />
              <div className="setting-fact">
                <span>Control server</span>
                <code>{location.origin}</code>
              </div>
              <div className="settings-actions">
                <button
                  className="primary-btn"
                  onClick={() => {
                    setToken(token);
                    onSaved();
                    setNotice("Connection saved.");
                  }}
                >
                  Save connection
                </button>
                <button
                  className="soft-btn"
                  onClick={() => {
                    setToken("");
                    setValue("");
                    onSaved();
                    setNotice("Disconnected on this device.");
                  }}
                >
                  Disconnect
                </button>
              </div>
            </TabsContent>
            {identity?.role === "owner" && <TabsContent value="devices"><DeviceSettings /></TabsContent>}
            <TabsContent value="nodes">
              <div className="settings-section-head">
                <h3>Computers</h3>
                <button
                  className="icon-btn"
                  aria-label="Refresh computers"
                  onClick={() => void action(loadNodes)}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <p>
                Cloudflare hosts the default computer. Pair another computer you
                own through an outbound connection.
              </p>
              <div className="node-card">
                <Monitor size={20} />
                <div>
                  <strong>Cloudflare</strong>
                  <p>Default · managed sandbox</p>
                  <small>Runs, browser, files, and native OpenCode</small>
                </div>
              </div>
              {nodes
                .filter((n) => !n.revokedAt)
                .map((n) => (
                  <div className="node-card" key={n.id}>
                    <Monitor size={20} />
                    <div>
                      <strong>{n.name}</strong>
                      <p>
                        {n.platform} / {n.arch} ·{" "}
                        {n.online ? "Connected" : "Offline"}
                      </p>
                      <small>
                        {n.capabilities.runner
                          ? "Runner available"
                          : "Agent connected; runner unavailable"}
                      </small>
                    </div>
                    <button
                      className="soft-btn"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request(`/api/nodes/${n.id}/revoke`, json({}));
                          await loadNodes();
                        })
                      }
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              <button
                className="primary-btn"
                disabled={busy}
                onClick={() =>
                  void action(async () =>
                    setPair(
                      await request(
                        "/api/nodes/pairing",
                        json({ label: "Owned computer" }),
                      ),
                    ),
                  )
                }
              >
                {pairExpired ? "Generate a new pairing command" : "Pair a computer"}
              </button>
              {pair && (
                <div className="setup-detail">
                  <h4>Run on the computer you want to connect</h4>
                  <p>Paste this into a terminal on the other computer. The installer downloads the runtime, pairs it, and starts a background service. No Git checkout is needed.</p>
                  <p className="settings-muted">Keep this page open: your computer will appear automatically. Then choose it in a bot’s settings to run tasks there.</p>
                  <label className="field-label" htmlFor="computer-platform">Operating system</label>
                  <select id="computer-platform" value={installPlatform} onChange={event => setInstallPlatform(event.target.value as "unix" | "windows")}>
                    <option value="unix">macOS or Linux</option>
                    <option value="windows">Windows · PowerShell</option>
                  </select>
                  {pairExpired ? <p role="status">This pairing command has expired. Generate a new one above.</p> : <code className="copy-block">{computerInstallCommand(installPlatform, location.origin, pair.token)}</code>}
                  <button className="soft-btn" disabled={pairExpired} onClick={() => void copy(computerInstallCommand(installPlatform, location.origin, pair.token))}>
                    <Copy size={16} /> Copy install command
                  </button>
                  <p className="settings-muted">
                    Server: {location.origin}
                    <br />
                    Expires {new Date(pair.expiresAt).toLocaleTimeString()}
                  </p>
                </div>
              )}
            </TabsContent>
            <TabsContent value="telegram">
              <h3>Telegram</h3>
              <p>
                Use your own Telegram bot to message an OpenCode bot and receive
                its results.
              </p>
              {!bots.length ? (
                <p>Create an OpenCode bot before connecting Telegram.</p>
              ) : (
                <>
                  <label className="field-label" htmlFor="telegram-bot">
                    OpenCode bot
                  </label>
                  <select
                    id="telegram-bot"
                    className="settings-input"
                    value={botId}
                    onChange={(e) => {
                      setBotId(e.target.value);
                      setLink(null);
                    }}
                  >
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ol className="setup-steps">
                    <li>
                      Open{" "}
                      <a
                        href="https://t.me/BotFather"
                        target="_blank"
                        rel="noreferrer"
                      >
                        BotFather <ExternalLink size={12} />
                      </a>{" "}
                      and send <code>/newbot</code>.
                    </li>
                    <li>
                      Choose a name and username, then paste the token below.
                    </li>
                    <li>
                      Connect the service, then scan your pairing QR in
                      Telegram.
                    </li>
                  </ol>
                  {telegram?.health?.error && (
                    <div className="inline-error" role="alert">
                      {telegram.health.error === "conflict"
                        ? "Another process is receiving updates for this Telegram bot. Stop its other poller, or create a separate BotFather bot."
                        : "Telegram could not be reached. Check the server’s connection and bot token."}
                    </div>
                  )}
                  {telegram?.config && (
                    <div className="setting-fact">
                      <span>BotFather connection</span>
                      <strong>@{telegram.config.username}</strong>
                    </div>
                  )}
                  {telegram?.config && !telegram?.bindings?.length && (
                    <p className="inline-notice">
                      Account pairing is still required. Open the pairing link
                      below and press Start in Telegram before sending messages.
                    </p>
                  )}
                  <label className="field-label" htmlFor="telegram-token">
                    BotFather token
                  </label>
                  <input
                    id="telegram-token"
                    className="settings-input"
                    type="password"
                    autoComplete="off"
                    value={telegramToken}
                    onChange={(e) => setTelegramToken(e.target.value)}
                    placeholder={
                      telegram?.config
                        ? "Enter a replacement token"
                        : "123456:…"
                    }
                  />
                  <label className="field-label" htmlFor="telegram-mode">
                    Receive messages
                  </label>
                  <select
                    id="telegram-mode"
                    className="settings-input"
                    value={telegramMode}
                    onChange={(e) =>
                      setTelegramMode(e.target.value as "polling" | "webhook")
                    }
                  >
                    <option value="polling">
                      Polling — local or always-on server
                    </option>
                    <option value="webhook">
                      Webhook — Cloudflare deployment
                    </option>
                  </select>
                  {telegramMode === "webhook" && (
                    <>
                      <label className="field-label" htmlFor="telegram-url">
                        Public app URL
                      </label>
                      <input
                        id="telegram-url"
                        className="settings-input"
                        value={publicUrl}
                        onChange={(e) => setPublicUrl(e.target.value)}
                        placeholder="https://your-app.workers.dev"
                      />
                      <p className="settings-muted">
                        Telegram delivers messages to this HTTPS address. Your
                        Cloudflare deployment URL is filled automatically.
                      </p>
                    </>
                  )}
                  {telegramMode === "polling" && (
                    <p className="settings-muted">
                      The server checks Telegram through outbound requests. No
                      public URL or tunnel is needed; keep the server running.
                    </p>
                  )}
                  <div className="settings-actions">
                    <button
                      className="primary-btn"
                      disabled={
                        busy ||
                        !telegramToken ||
                        (telegramMode === "webhook" && !publicUrl)
                      }
                      onClick={() =>
                        void action(async () => {
                          const origin =
                            telegramMode === "webhook"
                              ? new URL(publicUrl).origin
                              : "";
                          if (
                            telegramMode === "webhook" &&
                            !origin.startsWith("https://")
                          )
                            throw Error(
                              "Use the public HTTPS address of this app.",
                            );
                          await request(
                            `/api/bots/${botId}/telegram/configure`,
                            json({
                              token: telegramToken,
                              transport: telegramMode,
                              ...(origin
                                ? {
                                    webhookUrl: `${origin}/api/integrations/telegram/webhook/${botId}`,
                                  }
                                : {}),
                            }),
                          );
                          setTelegramToken("");
                          await loadTelegram();
                          setLink(
                            await request(
                              `/api/bots/${botId}/telegram/pairing`,
                              json({}),
                            ),
                          );
                          setNotice(
                            "BotFather connected. Finish account pairing below to enable messages.",
                          );
                        })
                      }
                    >
                      Connect Telegram
                    </button>
                    {telegram?.config && (
                      <button
                        className="soft-btn"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            setLink(
                              await request(
                                `/api/bots/${botId}/telegram/pairing`,
                                json({}),
                              ),
                            );
                          })
                        }
                      >
                        Link my Telegram account
                      </button>
                    )}
                  </div>
                  {link && !telegram?.bindings?.length && (
                    <div className="telegram-pair">
                      {qr && (
                        <img
                          src={qr}
                          width="220"
                          height="220"
                          alt="Scan to pair your Telegram account"
                        />
                      )}
                      <div>
                        <h4>Open Telegram to finish linking</h4>
                        <p>
                          Scan this code or open the link, then press Start.
                          Keep this link private.
                        </p>
                        <a
                          className="soft-btn"
                          href={link.deepLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Telegram <ExternalLink size={14} />
                        </a>
                        <p className="settings-muted">
                          Expires{" "}
                          {new Date(link.expiresAt).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  )}
                  {telegram?.bindings?.map((b: any) => (
                    <div
                      className="setting-fact"
                      key={`${b.chatId}:${b.telegramUserId}`}
                    >
                      <span>Linked account {b.telegramUserId}</span>
                      <button
                        className="soft-btn"
                        onClick={() =>
                          void action(async () => {
                            await request(
                              `/api/bots/${botId}/telegram/unlink`,
                              json({
                                chatId: b.chatId,
                                telegramUserId: b.telegramUserId,
                              }),
                            );
                            await loadTelegram();
                          })
                        }
                      >
                        Unlink
                      </button>
                    </div>
                  ))}
                </>
              )}
            </TabsContent>
            <TabsContent value="runtime">
              <div className="settings-section-head">
                <h3>OpenCode</h3>
                <button
                  className="icon-btn"
                  aria-label="Refresh runtime catalog"
                  onClick={() =>
                    void action(async () => setCatalog(await api.catalog()))
                  }
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <p>
                The shared computer supplies its models, agents, commands, and
                MCP tools. Configure provider connections for this shared
                OpenCode runtime below.
              </p>
              <OpenCodeProviders onSaved={() => { onSaved(); void action(async () => setCatalog(await api.catalog())); }} />
              {catalog && (
                <>
                  <div className="setting-fact">
                    <span>Runtime</span>
                    <code>{catalog.runtime?.version ?? "OpenCode 2"}</code>
                  </div>
                  <div className="setting-fact">
                    <span>Models</span>
                    <strong>{catalog.models?.length ?? 0}</strong>
                  </div>
                  <div className="setting-fact">
                    <span>Agents</span>
                    <strong>{catalog.agents?.length ?? 0}</strong>
                  </div>
                  <div className="setting-fact">
                    <span>Custom commands</span>
                    <strong>{catalog.commands?.length ?? 0}</strong>
                  </div>
                  <div className="setting-fact">
                    <span>MCP services</span>
                    <strong>{catalog.mcp?.length ?? 0}</strong>
                  </div>
                </>
              )}
              <p className="settings-muted">
                <TerminalSquare size={14} /> Open Native OpenCode from a
                conversation to use its full command catalog and provider
                controls.
              </p>
            </TabsContent>
            <TabsContent value="mcp">
              <McpSettings onSaved={() => { onSaved(); void action(async () => setCatalog(await api.catalog())); }} onOpenComputer={onOpenComputer} />
            </TabsContent>
            <TabsContent value="updates">
              <AppUpdates />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
