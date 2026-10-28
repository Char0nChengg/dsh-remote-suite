# Changelog

## 0.1.0 — 2026-10-28

- Initial public release.
- Six model-facing tools: `remote_targets`, `remote_exec`, `remote_read`,
  `remote_list`, `remote_write`, `remote_transfer`.
- SSH transport through the local Windows OpenSSH client, using keys or
  ssh-agent; no server-side agent and no reverse connection.
- WSL transport through `wsl.exe --exec`.
- Per-target `environment` notes and a global `prompt`, preloaded into the
  system prompt and shown by `remote_targets`.
- Bounded command output, large-file previews, byte ranges, binary detection,
  atomic writes, SFTP file/directory transfers, and timeout handling.
- MIT license, English/Chinese locale, icon, GitHub Actions CI.
