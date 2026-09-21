import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { isComputerWarmingUpError, request } from "../api";

type FormField = {
  key: string;
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  value?: string | number | boolean;
  url?: string;
  href?: string;
  external?: boolean;
  options?: Array<string | { id?: string; value?: string; label?: string }>;
  when?: unknown;
};
type Method = {
  type: "key" | "env" | "oauth" | "command" | string;
  id?: string;
  label?: string;
  form?: FormField[] | { fields?: FormField[] };
  names?: string[];
  command?: string;
};
type Connection = { id?: string; type?: string; label?: string; name?: string };
type Integration = {
  id: string;
  name?: string;
  methods?: Method[];
  connections?: Connection[];
};
type Provider = {
  id: string;
  name?: string;
  integrationID?: string;
  [key: string]: unknown;
};
type ProviderData = {
  location?: string;
  providers?: Provider[];
  integrations?: Integration[];
};
type Attempt = {
  attemptID?: string;
  url?: string;
  instructions?: string;
  mode?: string;
  time?: number;
};

type ProviderValue = string | number | boolean | undefined;
type ProviderValues = Record<string, ProviderValue>;

const isPrimaryKeyField = (field: FormField) => field.key === "key";
const formFields = (method?: Method) => {
  if (!method?.form) return [];
  return Array.isArray(method.form) ? method.form : method.form.fields ?? [];
};
const fieldIsBoolean = (field: FormField) =>
  field.type === "boolean" || field.type === "checkbox";
const fieldIsNumber = (field: FormField) =>
  field.type === "number" || field.type === "integer";
const fieldIsHidden = (field: FormField) =>
  Boolean(field.hidden) || field.type === "hidden";
const fieldInputType = (field: FormField) =>
  fieldIsHidden(field) ||
  field.secret ||
  /key|token|secret|password/i.test(
    `${field.key} ${field.type ?? ""} ${field.title ?? ""}`,
  )
    ? "password"
    : fieldIsNumber(field)
      ? "number"
      : field.type === "url"
        ? "url"
      : "text";

const initialFieldValue = (field: FormField): ProviderValue =>
  field.default ?? field.value;
const hasValue = (value: ProviderValue) =>
  typeof value === "boolean" ? true : value !== undefined && String(value).trim() !== "";
const fieldIsVisible = (field: FormField, values: ProviderValues) => {
  if (!field.when || typeof field.when !== "object") return true;
  const condition = field.when as Record<string, unknown>;
  const key = String(condition.key ?? condition.field ?? condition.name ?? "");
  if (!key) return true;
  const actual = values[key];
  const expected = condition.eq ?? condition.equals ?? condition.value;
  const excluded = condition.neq ?? condition.notEquals;
  if (expected !== undefined) return String(actual ?? "") === String(expected);
  if (excluded !== undefined) return String(actual ?? "") !== String(excluded);
  return true;
};
const answerValue = (field: FormField, value: ProviderValue) => {
  if (value === undefined || value === "") return value;
  if (fieldIsBoolean(field)) return Boolean(value);
  if (fieldIsNumber(field)) return Number(value);
  return String(value);
};

export function OpenCodeProviders({ onSaved }: { onSaved?: () => void }) {
  const [data, setData] = useState<ProviderData>();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<ProviderValues>({});
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{
    integrationID: string;
    methodID?: string;
    value: Attempt;
  }>();
  const [oauthCode, setOauthCode] = useState("");
  const [oauthStatus, setOauthStatus] = useState("");
  const [editingConnection, setEditingConnection] = useState("");
  const [connectionLabel, setConnectionLabel] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const computerWarming = isComputerWarmingUpError(error);
  const integrations = data?.integrations ?? [];
  const providers = data?.providers ?? [];
  const providerChoices = useMemo(
    () =>
      integrations.map(
        (integration) =>
          providers.find(
            (provider) =>
              (provider.integrationID ?? provider.id) === integration.id,
          ) ??
          ({
            id: integration.id,
            name: integration.name,
            integrationID: integration.id,
          } as Provider),
      ),
    [integrations, providers],
  );
  const filtered = useMemo(
    () =>
      providerChoices.filter((item) =>
        `${item.name ?? ""} ${item.id}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [providerChoices, search],
  );
  const integration =
    integrations.find((item) => item.id === selected) ?? integrations[0];
  const methods = integration?.methods ?? [];
  const selectedProvider = providers.find(
    (provider) => (provider.integrationID ?? provider.id) === integration?.id,
  );
  const preferredIntegration = (items: Integration[]) =>
    items.find((item) => /open\s*code/i.test(`${item.id} ${item.name ?? ""}`)) ??
    items[0];

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await request<ProviderData>("/api/providers");
      setData(next);
      setSelected(
        (current) =>
          current ||
          preferredIntegration(next.integrations ?? [])?.id ||
          next.providers?.[0]?.integrationID ||
          next.providers?.[0]?.id ||
          "",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load OpenCode providers",
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!computerWarming) return;
    const timer = window.setInterval(() => void load(), 3500);
    return () => window.clearInterval(timer);
  }, [computerWarming]);
  useEffect(() => {
    const next: ProviderValues = {};
    for (const method of methods) {
      for (const field of formFields(method)) {
        const value = initialFieldValue(field);
        if (value !== undefined) next[field.key] = value;
      }
    }
    if (Object.keys(next).length) {
      setValues((current) => ({ ...next, ...current }));
    }
  }, [integration?.id]);
  useEffect(() => {
    if (!attempt?.value.attemptID) return;
    let stopped = false;
    let finished = false;
    const poll = async () => {
      if (stopped || finished) return;
      try {
        const result = await request<{
          status?: { status?: string; message?: string };
        }>("/api/providers/oauth/status", {
          method: "POST",
          body: JSON.stringify({
            integrationID: attempt.integrationID,
            attemptID: attempt.value.attemptID,
          }),
        });
        if (stopped) return;
        const status = result.status?.status ?? "";
        const message = (result.status?.message ?? status) || "Waiting for native sign-in…";
        setOauthStatus(message);
        if (/complete|connected|success|done/i.test(status)) {
          finished = true;
          setAttempt(undefined);
          setOauthCode("");
          setOauthStatus("");
          setValues({});
          setNotice("Provider connected.");
          await load();
          onSaved?.();
        } else if (/error|fail|expire|cancel/i.test(status)) {
          finished = true;
          setAttempt(undefined);
          setOauthCode("");
          setOauthStatus("");
          setValues({});
          setError(message || "Native sign-in ended before connecting.");
        }
      } catch {
        /* The native flow may remain in progress while the user completes it. */
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [attempt?.value.attemptID]);
  const run = async (fn: () => Promise<void>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveKey = async (method: Method) => {
    const key = typeof values.__key === "string" ? values.__key.trim() : "";
    if (!key || !integration) return setError("Enter the provider key first.");
    const answer = collectAnswer(method, values, true);
    await run(
      async () => {
        await request("/api/providers/key", {
          method: "POST",
          body: JSON.stringify({
            integrationID: integration.id,
            key,
            answer,
            label: label.trim() || undefined,
          }),
        });
        setValues({});
        setLabel("");
        await load();
        onSaved?.();
      },
      `${method.label ?? "Provider"} connected.`,
    );
  };
  const startOAuth = async (method: Method) => {
    if (!integration) return;
    const answer = collectAnswer(method, values);
    await run(async () => {
      const result = await request<{ attempt?: Attempt }>(
        "/api/providers/oauth/start",
        {
          method: "POST",
          body: JSON.stringify({
            integrationID: integration.id,
            methodID: method.id,
            ...(Object.keys(answer).length ? { answer } : {}),
            label: label.trim() || undefined,
          }),
        },
      );
      setOauthStatus("Starting native sign-in…");
      setAttempt({
        integrationID: integration.id,
        methodID: method.id,
        value: result.attempt ?? {},
      });
    }, "Continue the native sign-in flow.");
  };
  const completeOAuth = async () => {
    if (!attempt?.value.attemptID) return;
    await run(async () => {
      await request("/api/providers/oauth/complete", {
        method: "POST",
        body: JSON.stringify({
          integrationID: attempt.integrationID,
          attemptID: attempt.value.attemptID,
          code: oauthCode || undefined,
        }),
      });
      setAttempt(undefined);
      setOauthCode("");
      setOauthStatus("");
      setValues({});
      await load();
      onSaved?.();
    }, "Provider connected.");
  };
  const cancelOAuth = async () => {
    if (!attempt?.value.attemptID) return;
    await run(async () => {
      await request("/api/providers/oauth/cancel", {
        method: "POST",
        body: JSON.stringify({
          integrationID: attempt.integrationID,
          attemptID: attempt.value.attemptID,
        }),
      });
      setAttempt(undefined);
      setOauthCode("");
      setOauthStatus("");
      setValues({});
    }, "Sign-in cancelled.");
  };
  const credential = async (path: "activate" | "remove", id?: string) => {
    if (!id) return;
    await run(
      async () => {
        await request(`/api/providers/credentials/${path}`, {
          method: "POST",
          body: JSON.stringify({ credentialID: id }),
        });
        await load();
        onSaved?.();
      },
      path === "activate" ? "Credential activated." : "Credential removed.",
    );
  };
  const relabel = async (id?: string) => {
    if (!id || !connectionLabel.trim()) return;
    await run(async () => {
      await request("/api/providers/credentials/label", {
        method: "POST",
        body: JSON.stringify({
          credentialID: id,
          label: connectionLabel.trim(),
        }),
      });
      setEditingConnection("");
      setConnectionLabel("");
      await load();
    }, "Label updated.");
  };
  const keyMethod = methods.find((method) => method.type === "key");
  const fields = formFields(keyMethod).filter((field) => !isPrimaryKeyField(field));
  const visibleFields = fields.filter((field) => fieldIsVisible(field, values));
  const missingRequired = visibleFields.some((field) => field.required && !hasValue(values[field.key]));
  const collectAnswer = (method: Method, current: ProviderValues, excludePrimaryKey = false) => {
    const answer: Record<string, unknown> = {};
    for (const field of formFields(method)) {
      if (excludePrimaryKey && isPrimaryKeyField(field)) continue;
      if (!fieldIsVisible(field, current)) continue;
      const value = current[field.key] ?? initialFieldValue(field);
      if (value !== undefined) answer[field.key] = answerValue(field, value);
    }
    return answer;
  };

  return (
    <section
      className="provider-settings"
      aria-label="OpenCode provider connections"
    >
      <div className="provider-header">
        <div>
          <h4>Provider connections</h4>
          <p>
            Configure credentials through OpenCode’s native integrations. Secret
            values are sent once and never displayed here.
          </p>
        </div>
        <button
          className="icon-btn"
          aria-label="Refresh provider connections"
          onClick={() => void load()}
          disabled={busy}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {computerWarming
            ? "Your Computer is starting. Provider connections will appear automatically when OpenCode is ready."
            : error}
        </div>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      <div className="provider-actions">
        <span className="settings-muted">
          {integrations.length
            ? `${integrations.length} integrations available`
            : "Provider catalog"}
        </span>
        <button
          className="soft-btn"
          type="button"
          onClick={() => setCustomOpen((open) => !open)}
        >
          <Plus size={14} />{" "}
          {customOpen ? "Close custom provider" : "Add custom provider"}
        </button>
      </div>
      {customOpen && (
        <CustomProviderForm
          onSaved={() => {
            setCustomOpen(false);
            void load();
            onSaved?.();
          }}
        />
      )}
      <label className="field-label" htmlFor="provider-search">
        Find a provider
      </label>
      <div className="provider-search">
        <Search />
        <input
          id="provider-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search providers…"
        />
      </div>
      <div className="provider-picker" role="listbox" aria-label="Providers">
        {filtered.map((provider) => {
          const id = provider.integrationID ?? provider.id;
          return (
            <button
              type="button"
              role="option"
              aria-selected={selected === id}
              className={`provider-option ${selected === id ? "selected" : ""}`}
              key={provider.id}
              onClick={() => {
                setSelected(id);
                setValues({});
                setNotice("");
              }}
            >
              <span>{provider.name ?? provider.id}</span>
              <small>{provider.id}</small>
            </button>
          );
        })}
        {!filtered.length && (
          <p className="settings-muted">{computerWarming ? "Waiting for OpenCode to finish starting…" : busy && !data ? "Loading native provider catalog…" : "No providers match this search."}</p>
        )}
      </div>
      {integration && (
        <div className="provider-editor">
          <div className="provider-editor-title">
            <div>
              <h4>{selectedProvider?.name ?? integration.name ?? integration.id}</h4>
            </div>
            <ShieldCheck size={19} />
          </div>
          <label className="field-label" htmlFor="provider-label">
            Connection label <span>optional</span>
          </label>
          <input
            id="provider-label"
            className="settings-input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Work account"
          />
          {methods.map((method, index) => {
            const methodFields = formFields(method)
              .filter((field) => !isPrimaryKeyField(field))
              .filter((field) => fieldIsVisible(field, values));
            const activeAttempt =
              attempt?.integrationID === integration.id &&
              attempt.methodID === method.id;
            return (
            <div
              className="provider-method"
              key={`${method.type}-${method.id ?? index}`}
            >
              <div className="provider-method-title">
                <strong>
                  {method.label ??
                    (method.type === "key"
                      ? "API key"
                      : method.type === "oauth"
                        ? "Sign in with OAuth"
                        : method.type === "env"
                          ? "Environment credentials"
                          : "Native sign-in")}
                </strong>
                <span>{method.type}</span>
              </div>
              {method.type === "key" && (
                <>
                  <label className="field-label" htmlFor="provider-key">
                    API key
                  </label>
                  <input
                    id="provider-key"
                    className="settings-input"
                    type="password"
                    autoComplete="new-password"
                    value={typeof values.__key === "string" ? values.__key : ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        __key: event.target.value,
                      }))
                    }
                    placeholder="Enter key without displaying it"
                  />
                  {visibleFields.map((field) => (
                    <DynamicField
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(value) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: value,
                        }))
                      }
                    />
                  ))}
                  <button
                    className="primary-btn"
                    disabled={
                      busy ||
                      !(typeof values.__key === "string" && values.__key.trim()) ||
                      missingRequired
                    }
                    onClick={() => void saveKey(method)}
                  >
                    <KeyRound size={14} /> Save key
                  </button>
                </>
              )}
              {method.type === "oauth" && (
                <>
                  {methodFields.map((field) => (
                    <DynamicField
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(value) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: value,
                        }))
                      }
                    />
                  ))}
                  {activeAttempt &&
                    attempt.value.url && (
                      <p className="provider-instructions">
                        <ExternalLink size={14} />
                        <a
                          href={attempt.value.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open the native sign-in page
                        </a>
                      </p>
                    )}
                  {activeAttempt &&
                    attempt.value.instructions && (
                      <p className="provider-instructions">
                        {attempt.value.instructions}
                      </p>
                    )}
                  {activeAttempt && oauthStatus && (
                    <p className="provider-progress" role="status">
                      <LoaderCircle size={14} /> {oauthStatus}
                    </p>
                  )}
                  {activeAttempt && (
                    <>
                      <input
                        className="settings-input"
                        type="text"
                        value={oauthCode}
                        onChange={(event) => setOauthCode(event.target.value)}
                        placeholder="Paste the code if the native flow asks for one"
                      />
                      <div className="settings-actions">
                        <button
                          className="primary-btn"
                          disabled={busy}
                          onClick={() => void completeOAuth()}
                        >
                          <Check size={14} /> Complete sign-in
                        </button>
                        <button
                          className="soft-btn"
                          disabled={busy}
                          onClick={() => void cancelOAuth()}
                        >
                          <X size={14} /> Cancel
                        </button>
                      </div>
                    </>
                  )}
                  {!attempt && method.id && (
                    <button
                      className="primary-btn"
                      disabled={busy}
                      onClick={() => void startOAuth(method)}
                    >
                      <ExternalLink size={14} /> Start native sign-in
                    </button>
                  )}
                  {!attempt && !method.id && (
                    <p className="provider-fallback">
                      <ExternalLink size={14} /> This OAuth method has no
                      browser method id. Complete it in Native OpenCode.
                    </p>
                  )}
                </>
              )}
              {method.type === "command" && (
                <p className="provider-fallback">
                  <TerminalSquare size={14} /> This provider uses a native
                  command flow. Open Native OpenCode to complete it; browser
                  credentials are not accepted here.
                </p>
              )}
              {method.type === "env" && (
                <p className="provider-fallback">
                  <KeyRound size={14} /> This provider reads environment
                  credentials from the computer.{" "}
                  {method.names?.length ? (
                    <>
                      Set one of <code>{method.names.join(", ")}</code> on the
                      computer.
                    </>
                  ) : (
                    "Configure it in the native runtime."
                  )}
                </p>
              )}
            </div>
            );
          })}
        </div>
      )}
      {integration?.connections?.length ? (
        <div className="provider-connections">
          <h4>Saved connections</h4>
          {integration.connections.map((connection) => (
            <div
              className="provider-connection"
              key={connection.id ?? connection.label}
            >
              <div>
                <strong>
                  {connection.label ?? connection.name ?? "Unnamed connection"}
                </strong>
                <small>{connection.type ?? "OpenCode credential"}</small>
              </div>
              {/^env/i.test(connection.type ?? "") ? (
                <span className="settings-muted">Managed by environment</span>
              ) : <div className="connection-actions">
                {editingConnection === connection.id ? (
                  <>
                    <input
                      className="settings-input"
                      value={connectionLabel}
                      onChange={(event) =>
                        setConnectionLabel(event.target.value)
                      }
                      placeholder="New label"
                    />
                    <button
                      className="icon-btn"
                      aria-label="Save label"
                      onClick={() => void relabel(connection.id)}
                    >
                      <Check size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-btn"
                    aria-label="Rename connection"
                    onClick={() => {
                      setEditingConnection(connection.id ?? "");
                      setConnectionLabel(
                        connection.label ?? connection.name ?? "",
                      );
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                )}
                <button
                  className="soft-btn"
                  onClick={() => void credential("activate", connection.id)}
                  disabled={busy}
                >
                  Activate
                </button>
                <button
                  className="icon-btn danger"
                  aria-label="Remove connection"
                  onClick={() => void credential("remove", connection.id)}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                </button>
              </div>}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CustomProviderForm({ onSaved }: { onSaved: () => void }) {
  const [providerID, setProviderID] = useState("");
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [modelIDs, setModelIDs] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ids = modelIDs
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!providerID.trim() || !baseURL.trim() || !ids.length) {
      setError(
        "Provider ID, base URL, and at least one model ID are required.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        providerID: providerID.trim(),
        name: name.trim() || undefined,
        baseURL: baseURL.trim(),
        modelIDs: ids,
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await request("/api/providers/custom", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setApiKey("");
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save custom provider",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="custom-provider"
      onSubmit={submit}
      aria-label="Add custom provider"
    >
      <div className="custom-provider-heading">
        <div>
          <span className="settings-kicker">OpenAI-compatible</span>
          <h4>Add a custom provider</h4>
          <p>
            Point OpenCode at a compatible endpoint. Existing keys stay on the
            runtime when the key field is left empty.
          </p>
        </div>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="custom-provider-grid">
        <label className="dynamic-provider-field">
          <span>Provider ID *</span>
          <small>Stable name used by OpenCode.</small>
          <input
            className="settings-input"
            value={providerID}
            onChange={(event) => setProviderID(event.target.value)}
            placeholder="local-ai"
            autoComplete="off"
            required
          />
        </label>
        <label className="dynamic-provider-field">
          <span>Display name</span>
          <small>Optional label shown in model pickers.</small>
          <input
            className="settings-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Local AI"
            autoComplete="off"
          />
        </label>
        <label className="dynamic-provider-field">
          <span>Base URL *</span>
          <small>
            Use the provider's API root, usually ending in <code>/v1</code>.
          </small>
          <input
            className="settings-input"
            type="url"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="https://api.example.com/v1"
            required
          />
        </label>
        <label className="dynamic-provider-field">
          <span>Model IDs *</span>
          <small>One per line or separated by commas.</small>
          <textarea
            className="settings-input"
            rows={3}
            value={modelIDs}
            onChange={(event) => setModelIDs(event.target.value)}
            placeholder="model-name\nsecond-model"
            required
          />
        </label>
        <label className="dynamic-provider-field">
          <span>API key</span>
          <small>
            Optional. Leave empty to preserve the existing runtime key.
          </small>
          <input
            className="settings-input"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Enter only when changing it"
          />
        </label>
      </div>
      <button className="primary-btn" type="submit" disabled={busy}>
        {busy ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Plus size={14} />
        )}{" "}
        {busy ? "Saving provider…" : "Save custom provider"}
      </button>
    </form>
  );
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: ProviderValue;
  onChange: (value: ProviderValue) => void;
}) {
  if (fieldIsHidden(field)) {
    return <input type="hidden" name={field.key} value={String(value ?? "")} />;
  }
  const externalURL = field.url ?? field.href;
  if (
    externalURL &&
    (field.external || field.type === "external" || field.type === "link" || field.type === "external-link")
  ) {
    return (
      <div className="dynamic-provider-field provider-instructions">
        <span>{field.title ?? field.key}</span>
        {field.description && <small>{field.description}</small>}
        <a href={externalURL} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Open {field.title ?? "link"}
        </a>
      </div>
    );
  }
  const options = field.options ?? [];
  const checked = Boolean(value);
  return (
    <label className="dynamic-provider-field">
      <span>
        {field.title ?? field.key}
        {field.required ? " *" : ""}
      </span>
      {field.description && <small>{field.description}</small>}
      {fieldIsBoolean(field) ? (
        <input
          className="provider-checkbox"
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : options.length ? (
        <select
          className="settings-input"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose…</option>
          {options.map((option) => {
            const item =
              typeof option === "string"
                ? { value: option, label: option }
                : {
                    value: option.value ?? option.id ?? "",
                    label: option.label ?? option.value ?? option.id ?? "",
                  };
            return (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          className="settings-input"
          type={fieldInputType(field)}
          autoComplete="off"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
