# Changelog

## 0.2.0 — 2026-10-29

- Add a visual **Remote servers** settings page: configured servers, SSH config
  aliases, accounts, authentication method, endpoint, default directory, and
  environment notes.
- Add connection testing, add/edit/delete, one-click import of SSH config
  aliases, and global prompt editing from the UI.
- Add a host settings API with same-origin checks and a UI request header; it
  exposes no passwords and writes only through the existing config editor.
- New/updated Client halves require a DSH restart before the settings page is
  visible; the host tools and chat config editing remain hot-reloadable.

## 0.1.4 — 2026-10-28

- Rename the plugin, package, and GitHub repository to `dsh-remote-suite` after
  checking npm, GitHub, DSH-Store, and dsh.so for collisions with
  `dsh-remote-shell`.

## 0.1.3 — 2026-10-28

- Remove the commented SSH key path from the default bundle patch after the
  bounded security scanner classified it as SSH key material.

## 0.1.2 — 2026-10-28

- Rename the plugin, package, and GitHub repository to `dsh-remote-shell` after
  DSH-Store reported that the original `dsh-remote` entry ID was already owned by
  another plugin.
- Keep the default bundle patch to scalar values so bounded marketplace
  validators can parse it without review.

## 0.1.1 — 2026-10-28

- Add `remote_config`: inspect and edit targets, per-server `environment` notes,
  and the global `prompt` from DSH chat. Edits validate, persist to the active
  profile patch, and apply through the Loader immediately.
- Include a short default WSL environment note so the preloaded prompt is
  active out of the box.
- Use generic `Username` / `myserver` examples instead of machine-specific sample
  names.

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
