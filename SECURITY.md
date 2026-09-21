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

Paired browsers and agents receive independent revocable bearer credentials.
Pairing invitations expire and can be redeemed once; the database stores token
hashes. Paired clients are trusted operators of the shared computer, not isolated
guests. Administrative routes and MCP tools require the owner token. Revoke a
device from Settings → Devices if its credential is lost.

Chat uploads use generated workspace paths and canonical attachment IDs. Downloads
require authentication and force attachment disposition. Files are not executed
by uploading them; bots may subsequently process them using their tools and
permissions. Uploads share the computer's checkpoint/ephemeral-disk lifecycle.
