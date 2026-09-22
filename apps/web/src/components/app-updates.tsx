import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { version as clientVersion } from "../../../../package.json";
import { api, type UpdateJob, type UpdateStatus } from "../api";

const terminalPhases = new Set(["completed", "failed", "rollback_required"]);

export const updatePhaseLabel = (phase?: string) => {
  switch ((phase ?? "").toLowerCase()) {
    case "queued":
      return "Waiting to start";
    case "verified":
      return "Release verified";
    case "quiescing":
      return "Waiting for active work to finish";
    case "checkpointing":
      return "Saving the Computer checkpoint";
    case "downloading":
      return "Downloading the update";
    case "uploading_assets":
      return "Uploading app assets";
    case "uploading_worker":
      return "Uploading the app update";
    case "promoting":
      return "Activating the app update";
    case "rolling_out_container":
      return "Updating the Computer image";
    case "waiting_container":
      return "Waiting for the Computer";
    case "restoring":
      return "Restoring the Computer checkpoint";
    case "health_check":
      return "Checking the updated app";
    case "completed":
      return "Update complete";
    case "failed":
      return "Update failed";
    case "rollback_required":
      return "Update needs attention";
    default:
      return phase ? "Working on the update" : "";
  }
};

export const needsClientReload = (
  job: UpdateJob | undefined,
  loadedVersion: string,
) => {
  if (job?.phase !== "completed" || !job.requestedVersion) return false;
  const target = job.requestedVersion.replace(/^v/, "").split(".").map(Number);
  const loaded = loadedVersion.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(target[i]) || !Number.isFinite(loaded[i]))
      return false;
    if (target[i] !== loaded[i]) return target[i] > loaded[i];
  }
  return false;
};

const isActiveJob = (job?: UpdateJob) =>
  Boolean(job && !terminalPhases.has((job.phase ?? "").toLowerCase()));

export function AppUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [accountId, setAccountId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [replaceAccess, setReplaceAccess] = useState(false);
  const statusPollInFlight = useRef(false);

  const load = async () => {
    setChecking(true);
    try {
      const next = await api.updates();
      setStatus(next);
      setAccountId(next.configuration?.accountId ?? "");
      setWorkerName(next.configuration?.workerName ?? "");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check for updates");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const active = isActiveJob(status?.job);
  const recoveryRequired = status?.job?.phase === "rollback_required";
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      if (stopped || statusPollInFlight.current || document.hidden) return;
      statusPollInFlight.current = true;
      try {
        const next = await api.updates();
        if (!stopped) {
          setStatus(next);
          setError("");
        }
      } catch (e) {
        if (!stopped) {
          setError(
            e instanceof Error ? e.message : "Could not read update progress",
          );
        }
      } finally {
        statusPollInFlight.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const latest = status?.latestVersion;
  const canUpdate = Boolean(
    status?.configured &&
    status.available &&
    latest &&
    !active &&
    !busy &&
    !recoveryRequired,
  );
  const jobLabel = useMemo(
    () => updatePhaseLabel(status?.job?.phase),
    [status?.job?.phase],
  );

  const configure = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.configureUpdates({
        accountId: accountId.trim(),
        workerName: workerName.trim(),
        token,
      });
      setStatus(next);
      setToken("");
      setReplaceAccess(false);
      setNotice("Update access saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save update access");
    } finally {
      setBusy(false);
    }
  };
  const removeConfiguration = async () => {
    setBusy(true);
    setError("");
    try {
      await api.removeUpdatesConfiguration();
      setStatus(
        (current) =>
          current && {
            ...current,
            configured: false,
            configuration: undefined,
          },
      );
      setToken("");
      setNotice("Update access removed.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not remove update access",
      );
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!latest) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setStatus(await api.startUpdate(latest));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start update");
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setStatus(await api.recoverUpdate());
      setNotice("The update has resumed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resume the update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-updates" aria-label="Application updates">
      <div className="settings-section-head">
        <div>
          <h3>Updates</h3>
          <p>Update the app and its Computer from this control server.</p>
        </div>
        <button
          className="icon-btn"
          aria-label="Check for updates"
          onClick={() => void load()}
          disabled={checking || active}
        >
          <RefreshCw size={15} className={checking ? "spin" : ""} />
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {status?.checkError && (
        <div className="inline-error" role="alert">
          Could not check for a newer release: {status.checkError}
        </div>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      <div className="setting-fact">
        <span>Installed version</span>
        <code>{status?.currentVersion ?? "Checking…"}</code>
      </div>
      {status?.available && latest && (
        <div className="setting-fact">
          <span>Latest version</span>
          <strong>{latest}</strong>
        </div>
      )}
      {active && (
        <div className="update-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          <span>
            {jobLabel}. You can keep using Settings while this finishes.
          </span>
        </div>
      )}
      {needsClientReload(status?.job, clientVersion) && (
        <div className="settings-actions">
          <p className="settings-notice">
            Update complete. Reload the app to use the new version.
          </p>
          <button
            className="primary-btn"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      )}
      {(status?.job?.phase === "failed" ||
        status?.job?.phase === "rollback_required") && (
        <div className="inline-error" role="alert">
          {status.job.error ?? jobLabel}
        </div>
      )}
      {recoveryRequired && (
        <div className="update-recovery" role="status">
          <strong>The app is paused to protect the saved checkpoint.</strong>
          <span>
            Resolve the deployment issue, then resume the update. The updater
            will continue from its retained checkpoint.
          </span>
          <button
            className="primary-btn"
            onClick={() => void recover()}
            disabled={busy}
          >
            Resume update
          </button>
        </div>
      )}
      {status?.managedExternally ? (
        <div className="update-config" role="status">
          <h4>Updates are managed by Boat</h4>
          <p>
            {status.instructions ??
              "Update this Boat installation by running the Boat installer again."}
          </p>
          <p className="app-update-copy">
            Finish active work, then rerun the same installer command on the device
            you used to install this workspace. Your bots, files, and token are preserved.
          </p>
        </div>
      ) : (
        <>
          <p className="app-update-copy">
            Active work must finish first. The updater saves a Computer
            checkpoint before changing the app.
          </p>
          {!status?.configured || replaceAccess ? (
            <div className="update-config">
              <h4>
                {replaceAccess ? "Replace deployment token" : "Enable updates"}
              </h4>
              <p>
                {replaceAccess
                  ? "Replace the deployment token if the previous one expired or lacks permission."
                  : "Use a narrowly scoped Cloudflare deployment token with Workers Scripts Write and Containers Write. It is saved by the control server and never shown again."}
              </p>
              <label className="field-label" htmlFor="update-account">
                Cloudflare account ID
              </label>
              <input
                id="update-account"
                className="settings-input"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
              <label className="field-label" htmlFor="update-worker">
                Worker name
              </label>
              <input
                id="update-worker"
                className="settings-input"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
              />
              <label className="field-label" htmlFor="update-token">
                Deployment token
              </label>
              <input
                id="update-token"
                className="settings-input"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="settings-actions">
                <button
                  className="primary-btn"
                  onClick={() => void configure()}
                  disabled={
                    busy ||
                    !accountId.trim() ||
                    !workerName.trim() ||
                    !token.trim()
                  }
                >
                  Save update access
                </button>
                {replaceAccess && (
                  <button
                    className="soft-btn"
                    onClick={() => setReplaceAccess(false)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="settings-actions">
              <button
                className="primary-btn"
                onClick={() => void start()}
                disabled={!canUpdate}
              >
                {status?.available
                  ? `Update to ${latest}`
                  : "App is up to date"}
              </button>
              <button
                className="soft-btn"
                onClick={() => setReplaceAccess(true)}
                disabled={busy || active}
              >
                Replace deployment token
              </button>
              <button
                className="soft-btn"
                onClick={() => void removeConfiguration()}
                disabled={busy || active || recoveryRequired}
              >
                Remove update access
              </button>
              {status?.releaseUrl && (
                <a
                  className="soft-btn"
                  href={status.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} /> Release notes
                </a>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
