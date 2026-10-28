# Security

`dsh-remote-suite` is a high-privilege plugin. It runs commands and writes files on
remote hosts with the permissions of the configured SSH user.

## What it can do

- Start local `ssh.exe`, `scp.exe`, or `wsl.exe` processes.
- Execute arbitrary shell commands on an SSH target or inside a WSL distro.
- Read, write, upload, and download files on those targets.
- Register a system-prompt section containing the `prompt` and per-target
  `environment` text from the profile configuration.
- Persist configuration edits to the active profile's `cordis.patch.yml` through
  `ctx.configEditor` when `remote_config` is used, and apply them through the
  Loader.

## What it does not do

- It does not install anything on the server.
- It does not make the server connect outbound; all connections start from the
  Windows host.
- It does not read, store, or pass passwords. Authentication is by SSH key or
  ssh-agent, with `BatchMode=yes`.
- It does not provide a persistent shell, port forwarding, reverse tunnels, or
  a remote DSH agent.

## Trust boundaries

- The profile configuration (`cordis.patch.yml`, `targets.example.yml`) is
  trusted input. A malicious target or `sshOptions` entry can change SSH
  behavior. Do not install untrusted profile patches.
- `prompt` and `environment` are sent to the model and recorded in sessions.
  Never put passwords, API tokens, private keys, or confidential data there.
- The plugin follows the user's `~/.ssh/config`; host aliases, `ProxyJump`, and
  `ForwardAgent` settings there apply. Prefer `ForwardAgent=no` unless needed.
- `StrictHostKeyChecking=accept-new` trusts a host key on first use and rejects
  later changes. Use `StrictHostKeyChecking=yes` with a pre-populated
  `known_hosts` for stricter operation.
- `remote_read` previews large files and reports binary files without dumping
  them, but `remote_exec` can still print anything the remote command emits.

## Reporting a vulnerability

Open a private security advisory at
<https://github.com/Char0nChengg/dsh-remote-suite/security/advisories/new>, or email
the maintainer listed in `package.json`. Do not include live credentials or
private server data in a public issue.

## Operator checklist

- Use a dedicated SSH key with the minimum required access.
- Keep the profile's target configuration under version control only if it
  contains no secrets.
- Review the `environment` notes before sharing screenshots or sessions.
- Rotate any credential that has been pasted into a chat, issue, or log.
