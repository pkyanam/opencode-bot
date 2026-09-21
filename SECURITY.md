# Security

This preview is for one trusted owner. Bots on the same computer share its
filesystem, browser, and execution environment. It is not a multi-tenant service.
Keep the application token private: it grants control over that computer.

Report vulnerabilities through GitHub's **Security → Report a vulnerability**
feature. Please do not include live credentials, private conversations, or
workspace archives in public issues.

Never commit `.dev.vars`, `.opencode-bot`, `.wrangler`, or runtime checkpoints.
If a credential is exposed, revoke it at its issuer; deleting a file from Git
is not sufficient.
