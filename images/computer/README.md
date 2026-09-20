# Cloudflare computer image

The image is a qualification starting point for a Cloudflare Sandbox Linux
container. It contains Node, the pinned OpenCode CLI, the runner, Git, Python,
Chromium, and a minimal X server. It deliberately does not include model or
connector credentials.

Before publishing, build and run it in the selected Sandbox image path and
record the image digest, Chromium launch flags, egress behavior, memory limit,
and checkpoint/restore result. The base image and package install are not a
claim that every Cloudflare Sandbox size supports a desktop workload.
