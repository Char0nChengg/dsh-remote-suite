/**
 * dsh-remote: model-facing tools for operating WSL distros and SSH hosts from
 * the Windows DSH host. The remote side only needs a stock sshd (or WSL); DSH
 * starts the local OpenSSH/WSL client, so nothing is installed on the server
 * and the server never needs an outbound connection.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import {
  MAX_OUTPUT_BYTES,
  MAX_READ_BYTES,
  MAX_TIMEOUT_MS,
  buildRemotePrompt,
  describeTarget,
  formatBytes,
  formatTime,
  listRemote,
  listSshAliases,
  normalizeConfig,
  probeTarget,
  readRemote,
  resolveTarget,
  runRemoteShell,
  shellQuote,
  transferRemote,
  writeRemote
} from './lib/remote.js'

export const name = 'dsh-remote'
export const inject = ['tools']

const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string'
    }
  },
  required: ['text']
}

function textTool(definition) {
  return {
    ...definition,
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  }
}

function argsObject(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  return args
}

function requiredString(args, key, { trim = true } = {}) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  if (value.includes('\0')) throw new Error(`${key} must not contain a NUL byte`)
  return trim ? value.trim() : value
}

function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value.trim()
}

function optionalBoolean(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function optionalNumber(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`)
  return parsed
}

function boundedNumber(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  const parsed = Math.trunc(value)
  if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return parsed
}

function sessionDirectory(ctx, exec) {
  const directories = ctx.get('workingDirectory')
  if (directories && exec.agent) {
    try {
      return directories.get(exec.agent.session)
    } catch {
      // fall back to the host process directory
    }
  }
  return process.cwd()
}

function localPath(ctx, exec, input) {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2))
  return path.resolve(sessionDirectory(ctx, exec), input)
}

function outputLines(parts) {
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join('\n')
}

function indented(text, prefix = '  ') {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join('\n')
}

function cdScript(cwd) {
  if (cwd === '~') return `cd ~ || { printf 'dsh-remote: cannot cd to %s\\n' "$HOME" >&2; exit 97; }`
  const quoted = shellQuote(cwd)
  return `cd -- ${quoted} || { printf 'dsh-remote: cannot cd to %s\\n' ${quoted} >&2; exit 97; }`
}

function execText(target, cwd, result, timeoutMs, maxBytes) {
  const parts = [
    `target: ${describeTarget(target)}`,
    `cwd: ${cwd}`
  ]
  if (result.stdoutText.length > 0) parts.push(result.stdoutText.replace(/\s+$/, ''))
  else parts.push('(no stdout)')
  if (result.stderrText.length > 0) parts.push(`[stderr]\n${result.stderrText.replace(/\s+$/, '')}`)
  if (result.stdoutOmitted > 0) parts.push(`[stdout truncated: ${result.stdoutOmitted} bytes omitted from the start; maxBytes=${maxBytes}]`)
  if (result.stderrOmitted > 0) parts.push(`[stderr truncated: ${result.stderrOmitted} bytes omitted from the start; maxBytes=${maxBytes}]`)
  if (result.timedOut) parts.push(`[timed out after ${timeoutMs} ms]`)
  if (result.signal) parts.push(`[killed by signal: ${result.signal}]`)
  parts.push(result.code === null ? '[exit code: unknown]' : `[exit code: ${result.code}]`)
  parts.push(`[duration: ${result.durationMs} ms]`)
  if (result.code === 255) parts.push('[SSH connection or authentication failed; check the host, key/agent, and known_hosts]')
  return outputLines(parts)
}

function readText(target, result) {
  const info = result.info
  const parts = [
    `target: ${describeTarget(target)}`,
    `path: ${result.path}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.size)} (${info.size} bytes)`,
    `mtime: ${formatTime(info.mtimeMs)}`,
    `mode: ${info.mode} owner: ${info.owner} group: ${info.group}`,
    '---'
  ]
  if (result.binary) {
    parts.push('[binary file: content not displayed; use remote_transfer to download it or a domain tool to inspect it]')
  } else if (result.content.length === 0) {
    parts.push('[empty file]')
  } else {
    parts.push(result.content.endsWith('\n') ? result.content.slice(0, -1) : result.content)
  }
  if (result.truncated) {
    const end = result.offset + result.bytesRead - 1
    parts.push(`[partial read: bytes ${result.offset}-${Math.max(result.offset, end)} of ${info.size}; next offset ${result.nextOffset}]`)
  }
  return outputLines(parts)
}

function listText(target, result) {
  const parts = [
    `target: ${describeTarget(target)}`,
    `path: ${result.path}`,
    `entries: ${result.entries.length}${result.truncated ? ' (truncated)' : ''}`
  ]
  if (result.entries.length === 0) {
    parts.push('(empty directory)')
    return outputLines(parts)
  }
  for (const entry of result.entries) {
    const suffix = entry.type === 'd' ? '/' : ''
    const link = entry.type === 'l' && entry.link ? ` -> ${entry.link}` : ''
    parts.push(`${entry.type} ${formatTime(entry.mtimeMs)} ${String(entry.size).padStart(8, ' ')} ${String(entry.mode).padStart(4, '0')} ${entry.name}${suffix}${link}`)
  }
  if (result.truncated) parts.push(`[listing truncated${result.omittedBytes ? `; ${result.omittedBytes} bytes omitted` : ''}]`)
  return outputLines(parts)
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  const remotePrompt = buildRemotePrompt(config)
  if (remotePrompt) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      let order = 1000
      try {
        order = systemPrompt.getSectionOrder('TOOL_BASH') + 1
      } catch {
        // a conservative fixed order still places the notes near other tool guidance
      }
      try {
        systemPrompt.section({
          name: 'dsh-remote:targets',
          order,
          text: remotePrompt
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-remote: could not register preloaded environment prompt: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  ctx.tools.register(textTool({
    name: 'remote_targets',
    description: 'List configured remote targets (WSL distros or SSH hosts), Host aliases from ~/.ssh/config, and optionally test connectivity. Use this first when unsure which target id to pass. Every remote tool also accepts an ad-hoc target: `ssh:<host-or-ssh-config-alias>` (e.g. `ssh:gpu` or `ssh://user@host:22`) or `wsl:<distro>` (e.g. `wsl:Ubuntu`).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description: 'Optional target id or ad-hoc target to describe/check. Omit to inspect all configured targets.'
        },
        check: {
          type: 'boolean',
          description: 'Test connectivity with a short remote command. Default false; checking can take a few seconds per target.'
        }
      }
    },
    async execute(rawArgs) {
      const args = argsObject(rawArgs)
      const check = optionalBoolean(args, 'check')
      const requested = optionalString(args, 'target')

      if (requested !== undefined) {
        const target = resolveTarget(config, requested)
        const lines = [
          `target: ${target.id}`,
          `label: ${target.label}`,
          `transport: ${target.transport}`,
          `endpoint: ${target.endpoint}`,
          `defaultCwd: ${target.defaultCwd ?? '(home)'}`
        ]
        if (target.environment) lines.push(`environment:\n${indented(target.environment)}`)
        if (check) {
          const probe = await probeTarget(target, config)
          lines.push(probe.ok
            ? `status: reachable (${probe.latencyMs} ms)${probe.detail ? ` — ${probe.detail}` : ''}`
            : `status: unreachable — ${probe.error}`)
        }
        return { text: outputLines(lines) }
      }

      const lines = []
      const aliases = await listSshAliases()
      if (config.targets.length === 0) {
        lines.push('No configured targets.')
      } else {
        lines.push(`Configured targets (${config.targets.length}):`)
        const probes = check
          ? await Promise.all(config.targets.map((target) => probeTarget(target, config)))
          : []
        config.targets.forEach((target, index) => {
          const endpoint = target.label === target.endpoint ? '' : ` — ${target.endpoint}`
          lines.push(`- ${target.id}: ${target.label} — ${target.transport}${endpoint} — cwd ${target.defaultCwd ?? '(home)'}`)
          if (target.environment) lines.push(`  environment:\n${indented(target.environment, '    ')}`)
          if (check) {
            const probe = probes[index]
            lines.push(probe.ok
              ? `  reachable in ${probe.latencyMs} ms${probe.detail ? ` — ${probe.detail}` : ''}`
              : `  unreachable — ${probe.error}`)
          }
        })
      }
      if (aliases.length > 0) {
        lines.push(`SSH config aliases (not checked): ${aliases.join(', ')}`)
      }
      lines.push('Ad-hoc targets also work: ssh:<host-or-alias>, ssh://user@host:port, or wsl:<distro>.')
      return { text: outputLines(lines) }
    }
  }))

  ctx.tools.register(textTool({
    name: 'remote_exec',
    description: 'Run a shell command on a remote target over SSH or inside WSL. DSH starts the connection from this Windows host; no agent or bridge is installed on the server and the server makes no outbound connection. Each call uses a fresh login shell. Nonzero exits are reported as command results, not tool errors. Output is bounded; set maxBytes or redirect to a file for long logs. For long-running work use the server\'s own scheduler or nohup.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Configured target id, ssh:<host-or-alias>, ssh://user@host:port, or wsl:<distro>.' },
        command: { type: 'string', description: 'POSIX shell command to run. It executes inside bash -lc after cd to cwd.' },
        cwd: { type: 'string', description: 'Remote working directory. Absolute or ~; defaults to the target defaultCwd, else the login home.' },
        timeoutMs: { type: 'number', description: 'Remote timeout in milliseconds (1000-600000). The command is killed when it expires.' },
        maxBytes: { type: 'number', description: 'Maximum captured bytes per stream (1024-4194304). Older bytes are dropped and reported.' }
      },
      required: ['target', 'command']
    },
    async execute(rawArgs, exec) {
      const args = argsObject(rawArgs)
      const target = resolveTarget(config, requiredString(args, 'target'))
      const command = requiredString(args, 'command', { trim: false })
      const cwd = optionalString(args, 'cwd') ?? target.defaultCwd ?? '~'
      if (cwd.includes('\n') || cwd.includes('\r') || cwd.includes('\0')) throw new Error('cwd must be one line')
      const timeoutMs = boundedNumber(optionalNumber(args, 'timeoutMs'), config.defaultTimeoutMs, 1_000, MAX_TIMEOUT_MS, 'timeoutMs')
      const maxBytes = boundedNumber(optionalNumber(args, 'maxBytes'), config.maxOutputBytes, 1_024, MAX_OUTPUT_BYTES, 'maxBytes')
      const script = `${cdScript(cwd)}\n${command}\n`
      const result = await runRemoteShell(target, script, config, {
        timeoutMs,
        maxBytes,
        capture: 'tail',
        signal: exec.signal
      })
      if (result.aborted) throw new Error('tool call aborted')
      return { text: execText(target, cwd, result, timeoutMs, maxBytes) }
    }
  }))

  ctx.tools.register(textTool({
    name: 'remote_read',
    description: 'Read a file on a remote target. Always returns metadata (type, size, mtime, mode, owner). Text files are read as UTF-8; binary files are reported without dumping bytes. Large files return only a small preview in auto mode; use mode=range or mode=tail with offset/length to read a bounded window. Relative paths resolve against defaultCwd.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Configured target id or ad-hoc ssh:/wsl: target.' },
        path: { type: 'string', description: 'Remote file path. Absolute, ~, or relative to defaultCwd.' },
        mode: { type: 'string', enum: ['auto', 'head', 'tail', 'range'], description: 'auto (default): whole small file or a preview of a large one; head/tail/range: explicit byte window.' },
        offset: { type: 'number', description: 'Byte offset for mode=range. Default 0.' },
        length: { type: 'number', description: 'Byte length for head/tail/range. Defaults to maxBytes (capped at 2 MiB).' },
        maxBytes: { type: 'number', description: 'Maximum bytes returned (1024-2097152). Default 262144.' }
      },
      required: ['target', 'path']
    },
    async execute(rawArgs, exec) {
      const args = argsObject(rawArgs)
      const target = resolveTarget(config, requiredString(args, 'target'))
      const mode = optionalString(args, 'mode') ?? 'auto'
      if (!['auto', 'head', 'tail', 'range'].includes(mode)) throw new Error('mode must be auto, head, tail, or range')
      const offset = optionalNumber(args, 'offset')
      const length = optionalNumber(args, 'length')
      const maxBytes = boundedNumber(optionalNumber(args, 'maxBytes'), config.defaultReadBytes, 1_024, MAX_READ_BYTES, 'maxBytes')
      const result = await readRemote(target, config, requiredString(args, 'path'), {
        mode,
        offset,
        length,
        maxBytes,
        signal: exec.signal
      })
      return { text: readText(target, result) }
    }
  }))

  ctx.tools.register(textTool({
    name: 'remote_list',
    description: 'List one directory on a remote target with type, size, mtime, mode, and symlink target. Use remote_read to get metadata for a file. Relative paths resolve against defaultCwd.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Configured target id or ad-hoc ssh:/wsl: target.' },
        path: { type: 'string', description: 'Remote directory path. Absolute, ~, or relative to defaultCwd.' },
        maxEntries: { type: 'number', description: 'Maximum entries to return (1-1000). Default 200.' }
      },
      required: ['target', 'path']
    },
    async execute(rawArgs, exec) {
      const args = argsObject(rawArgs)
      const target = resolveTarget(config, requiredString(args, 'target'))
      const maxEntries = boundedNumber(optionalNumber(args, 'maxEntries'), 200, 1, 1_000, 'maxEntries')
      const result = await listRemote(target, config, requiredString(args, 'path'), {
        maxEntries,
        signal: exec.signal
      })
      return { text: listText(target, result) }
    }
  }))

  ctx.tools.register(textTool({
    name: 'remote_write',
    description: 'Write a UTF-8 text file on a remote target atomically (temporary file, then rename). Use this to submit scripts or edit server-side configs; set mode="755" for an executable script. Parent directories are only created when createDirs is true. Relative paths resolve against defaultCwd.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Configured target id or ad-hoc ssh:/wsl: target.' },
        path: { type: 'string', description: 'Remote destination file path. Absolute, ~, or relative to defaultCwd.' },
        content: { type: 'string', description: 'Complete UTF-8 file content.' },
        createDirs: { type: 'boolean', description: 'Create missing parent directories. Default false.' },
        mode: { type: 'string', description: 'Optional octal mode such as 755 or 0644.' }
      },
      required: ['target', 'path', 'content']
    },
    async execute(rawArgs, exec) {
      const args = argsObject(rawArgs)
      const target = resolveTarget(config, requiredString(args, 'target'))
      const content = args.content
      if (typeof content !== 'string') throw new Error('content must be a string')
      const mode = optionalString(args, 'mode')
      if (mode !== undefined && !/^[0-7]{3,4}$/.test(mode)) throw new Error('mode must be 3 or 4 octal digits')
      const result = await writeRemote(target, config, requiredString(args, 'path'), content, {
        createDirs: optionalBoolean(args, 'createDirs'),
        mode,
        signal: exec.signal
      })
      return { text: `wrote ${formatBytes(result.bytes)} (${result.bytes} bytes) to ${result.path} on ${describeTarget(target)}` }
    }
  }))

  ctx.tools.register(textTool({
    name: 'remote_transfer',
    description: 'Copy a file between this Windows host and a remote target. Over SSH, recursive directory transfer is supported; WSL transfers streams files and does not support directories. Use remote_read for a preview instead of downloading a large file. Relative local paths resolve against the session working directory; relative remote paths resolve against defaultCwd.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Configured target id or ad-hoc ssh:/wsl: target.' },
        direction: { type: 'string', enum: ['upload', 'download'], description: 'upload: local to remote; download: remote to local.' },
        localPath: { type: 'string', description: 'Windows path on this host. Absolute, ~, or relative to the session working directory.' },
        remotePath: { type: 'string', description: 'Remote path. Absolute, ~, or relative to defaultCwd.' },
        recursive: { type: 'boolean', description: 'Copy directories recursively (SSH only). Default false.' },
        createDirs: { type: 'boolean', description: 'Create the receiving side parent directory. Default false.' }
      },
      required: ['target', 'direction', 'localPath', 'remotePath']
    },
    async execute(rawArgs, exec) {
      const args = argsObject(rawArgs)
      const target = resolveTarget(config, requiredString(args, 'target'))
      const direction = requiredString(args, 'direction')
      if (direction !== 'upload' && direction !== 'download') throw new Error('direction must be upload or download')
      const local = localPath(ctx, exec, requiredString(args, 'localPath'))
      const result = await transferRemote(target, config, {
        direction,
        localPath: local,
        remotePath: requiredString(args, 'remotePath'),
        recursive: optionalBoolean(args, 'recursive'),
        createDirs: optionalBoolean(args, 'createDirs'),
        signal: exec.signal
      })
      return {
        text: `${direction === 'upload' ? 'uploaded' : 'downloaded'} ${formatBytes(result.bytes)} (${result.bytes ?? '?'} bytes)\nlocal: ${result.localPath}\nremote: ${result.remotePath}\ntarget: ${describeTarget(target)}`
      }
    }
  }))
}
