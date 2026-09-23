# Choose your host

Run the same installer for either target:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh | bash
```

The terminal asks where to host, then asks only questions for that provider.
Cloudflare is preselected. Explicit `--cloudflare` and `--boat` flags skip the
provider question; `--yes` also skips the remaining review prompts for automation.

| Capability | Cloudflare | Boat |
| --- | --- | --- |
| Bots, conversations, live collaboration | Shared application API; up to four concurrent conversations | Same application API and scheduler |
| Web, mobile, Telegram, external MCP clients | Same authentication and pairing | Same authentication and pairing |
| Files, browser, approvals, owned nodes | Managed Linux computer; additional paired nodes | Linux VM computer; additional paired nodes |
| Memory registry and Hindsight | Registry plus separately managed memory runtime | Registry plus local memory supervisor |
| Application updates | Worker/assets/container release, checkpoint and restore | Verified release, privileged service updater, rollback |
| Durable application data | Durable Object SQLite and R2 | SQLite and local object storage on the VM |
| Installation choices | Deployment name and computer size | VM size and lifetime |

Model credentials still belong to the execution runtime. Connecting a model
provider on one computer does not silently copy its secrets to every paired
computer. Hindsight needs its own supported text-model configuration; embedding
and reranking models are installed with the memory runtime.

## Different infrastructure, explicit behavior

Boat defaults to **Keep running** (`--no-auto-stop`), not Boat's one-hour default.
The installer checks that Boat reports no stop deadline. Persistent operation
requires a payment method; the installer fails with guidance if a trial account
rejects it. Timed sessions remain an explicit choice. This does not override
provider outages or billing limits.

A running Boat VM continues to consume its provider allocation even when the
application's execution computer is idle. To stop the whole VM, use `boat stop`;
its web server is then offline and its public URL can show an archived preview.
Use `boat resume <id> --no-auto-stop` to bring the VM back. An enabled service
plus a once-per-boot recovery check handles restored service files arriving after
systemd's boot targets. Recovery may take about a minute, plus desktop startup.
The recovery check does not undo a later intentional service stop.

Cloudflare rolls container images through its own deployment system. The updater
keeps a checkpoint while that rollout completes, then restores and checks health.
The web control server can stay available while its execution computer starts.
These infrastructure differences are intentional; application APIs and client
flows use the same implementation wherever possible.

[Boat setup](boat-setup.md) · [Cloudflare setup](getting-started.md)
