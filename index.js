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
  listSshConfigHosts,
  normalizeConfig,
  probeTarget,
  readRemote,
  resolveTarget,
  runRemoteShell,
  shellQuote,
  transferRemote,
  writeRemote
} from './lib/remote.js'

export const name = 'dsh-remote-suite'
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

const CONFIG_ENTRY_ID = 'dsh-remote-suite'
const CONFIG_PACKAGE_NAME = '@char0nchengg/dsh-remote-suite'
const TARGET_FIELDS = [
  'id', 'label', 'transport', 'host', 'user', 'port', 'identityFile',
  'proxyJump', 'sshOptions', 'distro', 'defaultCwd', 'shell', 'environment'
]

function cleanTarget(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('target must be an object')
  const target = {}
  for (const key of TARGET_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null) target[key] = raw[key]
  }
  return target
}

function sanitizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const result = {}
  if (typeof source.prompt === 'string') result.prompt = source.prompt
  result.targets = Array.isArray(source.targets) ? source.targets.map((target) => cleanTarget(target)) : []
  for (const key of [
    'strictHostKeyChecking', 'connectTimeoutSec', 'defaultTimeoutMs', 'transferTimeoutMs',
    'maxOutputBytes', 'defaultReadBytes', 'largeFileBytes', 'previewBytes',
    'sshPath', 'scpPath', 'wslPath'
  ]) {
    if (source[key] !== undefined && source[key] !== null) result[key] = source[key]
  }
  return result
}

function configEditorHandle(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor) throw new Error('this profile does not expose ctx.configEditor, so dsh-remote-suite config cannot be edited from chat')
  const entry = editor.entries().find((candidate) => (
    candidate.options?.id === CONFIG_ENTRY_ID && candidate.options?.name === CONFIG_PACKAGE_NAME
  ))
  if (!entry) throw new Error(`cannot find the active ${CONFIG_ENTRY_ID} entry (${CONFIG_PACKAGE_NAME}) in the profile`)
  return { editor, entry }
}

async function editConfig(ctx, mutate) {
  const { editor, entry } = configEditorHandle(ctx)
  await editor.edit(entry, (current) => {
    const source = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
    const next = structuredClone(source)
    const result = mutate(next)
    normalizeConfig(result)
    return result
  })
  return entry
}

const SETTINGS_API_PREFIX = '/plugins/dsh-remote-suite'

function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function sameOrigin(request, origin) {
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const requestOrigin = request.headers.origin
  return !requestOrigin || requestOrigin === origin
}

function readJsonBody(request, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
  })
}

function currentConfigFor(ctx, fallback) {
  try {
    const editor = ctx.get('configEditor')
    if (!editor) return fallback
    const entry = editor.entries().find((candidate) => (
      candidate.options?.id === CONFIG_ENTRY_ID && candidate.options?.name === CONFIG_PACKAGE_NAME
    ))
    return entry?.options?.config ?? fallback
  } catch {
    return fallback
  }
}

function targetAuth(target, sshHosts) {
  if (target.transport === 'wsl') {
    return {
      kind: 'wsl',
      user: 'default WSL user',
      hostName: null,
      port: null,
      identityFile: null,
      forwardAgent: null,
      password: false
    }
  }
  const alias = sshHosts.find((host) => host.alias === target.host)
  const identityFile = target.identityFile ?? alias?.identityFile
  const kind = identityFile ? 'key' : alias ? 'ssh-config' : 'agent'
  return {
    kind,
    user: target.user ?? alias?.user ?? null,
    hostName: alias?.hostName ?? target.host,
    port: target.port ?? alias?.port ?? null,
    identityFile: identityFile ?? null,
    forwardAgent: alias?.forwardAgent ?? null,
    password: false
  }
}

async function settingsState(ctx, fallback) {
  const raw = currentConfigFor(ctx, fallback)
  const sanitized = sanitizeConfig(raw)
  const sshHosts = await listSshConfigHosts()
  return {
    targets: sanitized.targets.map((target) => ({
      ...target,
      auth: targetAuth(target, sshHosts)
    })),
    aliases: sshHosts.map((host) => ({
      ...host,
      configured: sanitized.targets.some((target) => target.transport === 'ssh' && target.host === host.alias)
    })),
    prompt: sanitized.prompt ?? '',
    sshConfigPath: path.join(homedir(), '.ssh', 'config'),
    passwordSupported: false
  }
}

function aliasTargetId(alias, targets) {
  const base = alias.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ssh-target'
  let id = base
  let suffix = 2
  while (targets.some((target) => target.id === id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

async function applySettingsAction(ctx, fallback, body) {
  const action = body?.action
  if (action === 'state') return settingsState(ctx, fallback)

  if (action === 'probe') {
    const raw = currentConfigFor(ctx, fallback)
    const parsed = normalizeConfig(raw)
    const target = resolveTarget(parsed, String(body.targetId ?? body.id ?? ''))
    return { probe: await probeTarget(target, parsed) }
  }

  if (action === 'saveTarget') {
    const target = cleanTarget(body.target)
    if (typeof target.id !== 'string' || target.id.trim().length === 0) throw new Error('target.id is required')
    if (target.transport !== 'ssh' && target.transport !== 'wsl') throw new Error('target.transport must be ssh or wsl')
    await editConfig(ctx, (next) => {
      const targets = Array.isArray(next.targets) ? [...next.targets] : []
      const index = targets.findIndex((candidate) => candidate?.id === target.id)
      if (index < 0) targets.push(target)
      else targets[index] = target
      next.targets = targets
      return next
    })
    return { saved: target.id }
  }

  if (action === 'removeTarget') {
    const id = String(body.id ?? '')
    if (!id) throw new Error('id is required')
    let found = false
    await editConfig(ctx, (next) => {
      const targets = Array.isArray(next.targets) ? next.targets : []
      const filtered = targets.filter((target) => target?.id !== id)
      found = filtered.length !== targets.length
      next.targets = filtered
      return next
    })
    if (!found) throw new Error(`unknown target id: ${id}`)
    return { removed: id }
  }

  if (action === 'setEnvironment') {
    const id = String(body.id ?? '')
    const environment = body.environment
    if (!id) throw new Error('id is required')
    if (typeof environment !== 'string' && !Array.isArray(environment)) throw new Error('environment must be a string or string array')
    let found = false
    await editConfig(ctx, (next) => {
      const targets = Array.isArray(next.targets) ? next.targets : []
      const index = targets.findIndex((target) => target?.id === id)
      if (index < 0) throw new Error(`unknown target id: ${id}`)
      const target = { ...targets[index] }
      const empty = typeof environment === 'string'
        ? environment.trim().length === 0
        : environment.every((entry) => entry.trim().length === 0)
      if (empty) delete target.environment
      else target.environment = environment
      targets[index] = target
      next.targets = targets
      found = true
      return next
    })
    if (!found) throw new Error(`target not found: ${id}`)
    return { saved: id }
  }

  if (action === 'setPrompt') {
    const prompt = body.prompt
    if (typeof prompt !== 'string') throw new Error('prompt must be a string')
    await editConfig(ctx, (next) => {
      if (prompt.trim().length === 0) delete next.prompt
      else next.prompt = prompt
      return next
    })
    return { saved: 'prompt' }
  }

  if (action === 'importAlias') {
    const alias = String(body.alias ?? '')
    const hosts = await listSshConfigHosts()
    const host = hosts.find((candidate) => candidate.alias === alias)
    if (!host) throw new Error(`unknown SSH config alias: ${alias}`)
    const raw = currentConfigFor(ctx, fallback)
    const existing = sanitizeConfig(raw).targets
    if (existing.some((target) => target.transport === 'ssh' && target.host === alias)) {
      throw new Error(`alias is already configured: ${alias}`)
    }
    const target = {
      id: aliasTargetId(alias, existing),
      label: alias,
      transport: 'ssh',
      host: alias,
      defaultCwd: '~'
    }
    await editConfig(ctx, (next) => {
      const targets = Array.isArray(next.targets) ? [...next.targets] : []
      targets.push(target)
      next.targets = targets
      return next
    })
    return { saved: target.id }
  }

  throw new Error(`unknown action: ${String(action ?? '')}`)
}

function registerSettingsApi(ctx, fallbackConfig) {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  const origin = webServer.getOrigin()
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: SETTINGS_API_PREFIX,
    handler: async (request, response) => {
      try {
        if (!sameOrigin(request, origin)) {
          sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        const url = new URL(request.url ?? '/', origin)
        if (url.pathname === `${SETTINGS_API_PREFIX}/state` && request.method === 'GET') {
          sendJson(response, 200, { ok: true, state: await settingsState(ctx, fallbackConfig) })
          return
        }
        if (url.pathname === `${SETTINGS_API_PREFIX}/action` && request.method === 'POST') {
          if (request.headers['x-dsh-remote-ui'] !== '1') {
            sendJson(response, 403, { ok: false, error: 'missing DSH remote UI header' })
            return
          }
          const body = await readJsonBody(request)
          const result = await applySettingsAction(ctx, fallbackConfig, body)
          sendJson(response, 200, { ok: true, result })
          return
        }
        sendJson(response, 404, { ok: false, error: 'not found' })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'dsh-remote-suite: settings API')
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
          name: 'dsh-remote-suite:targets',
          order,
          text: remotePrompt
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-remote-suite: could not register preloaded environment prompt: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  registerSettingsApi(ctx, config)

  ctx.tools.register(textTool({
    name: 'remote_targets',
    description: 'List configured remote targets (WSL distros or SSH hosts), Host aliases from ~/.ssh/config, and optionally test connectivity. Use this first when unsure which target id to pass. Every remote tool also accepts an ad-hoc target: `ssh:<host-or-ssh-config-alias>` (e.g. `ssh:myserver` or `ssh://Username@host:22`) or `wsl:<distro>` (e.g. `wsl:Ubuntu`).',
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

  ctx.tools.register(textTool({
    name: 'remote_config',
    description: 'Read or change this plugin\'s configuration through DSH. Changes are validated, persisted to the active profile patch, and applied through the Loader immediately. Use action=show to inspect; set_prompt for the global prompt; upsert_target with a complete target object; set_environment for one target\'s module/Conda/Slurm notes; remove_target to delete one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'set_prompt', 'upsert_target', 'set_environment', 'remove_target'],
          description: 'Configuration operation.'
        },
        prompt: {
          type: 'string',
          description: 'Global preloaded prompt. Empty string removes it. Use action=set_prompt.'
        },
        id: {
          type: 'string',
          description: 'Target id. Use action=set_environment or remove_target.'
        },
        environment: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Per-server environment notes. Empty string removes them. Use action=set_environment.'
        },
        target: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Unique target id.' },
            label: { type: 'string', description: 'Display label.' },
            transport: { type: 'string', enum: ['ssh', 'wsl'], description: 'Connection type.' },
            host: { type: 'string', description: 'SSH host, IP, or ~/.ssh/config alias.' },
            user: { type: 'string', description: 'SSH user; omit to use ssh config.' },
            port: { type: 'number', description: 'SSH port; omit to use ssh config.' },
            identityFile: { type: 'string', description: 'SSH private key path.' },
            proxyJump: { type: 'string', description: 'ssh -J destination.' },
            sshOptions: { type: 'array', items: { type: 'string' }, description: 'Additional -o options.' },
            distro: { type: 'string', description: 'WSL distro name; omit for the default distro.' },
            defaultCwd: { type: 'string', description: 'Remote default cwd; ~ or an absolute path.' },
            shell: { type: 'string', description: 'Remote shell, default bash.' },
            environment: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'Per-server environment notes.'
            }
          },
          required: ['id', 'transport'],
          description: 'Complete target object. Upsert replaces the target with this id.'
        }
      },
      required: ['action']
    },
    async execute(rawArgs) {
      const args = argsObject(rawArgs)
      const action = requiredString(args, 'action')

      if (action === 'show') {
        let raw = config
        try {
          const editor = ctx.get('configEditor')
          if (editor) {
            const entry = editor.entries().find((candidate) => (
              candidate.options?.id === CONFIG_ENTRY_ID && candidate.options?.name === CONFIG_PACKAGE_NAME
            ))
            if (entry) raw = entry.options.config ?? config
          }
        } catch {
          // fall back to the config this activation received
        }
        return { text: `dsh-remote-suite config:\n${JSON.stringify(sanitizeConfig(raw), null, 2)}` }
      }

      if (action === 'set_prompt') {
        const prompt = args.prompt
        if (typeof prompt !== 'string') throw new Error('prompt must be a string')
        await editConfig(ctx, (next) => {
          if (prompt.trim().length === 0) delete next.prompt
          else next.prompt = prompt
          return next
        })
        return { text: prompt.trim().length === 0 ? 'removed the global prompt' : 'updated the global prompt' }
      }

      if (action === 'set_environment') {
        const id = requiredString(args, 'id')
        const environment = args.environment
        if (typeof environment !== 'string' && !Array.isArray(environment)) throw new Error('environment must be a string or an array of strings')
        if (Array.isArray(environment) && environment.some((entry) => typeof entry !== 'string')) throw new Error('environment entries must be strings')
        let found = false
        await editConfig(ctx, (next) => {
          const targets = Array.isArray(next.targets) ? next.targets : []
          const index = targets.findIndex((candidate) => candidate?.id === id)
          if (index < 0) throw new Error(`unknown target id: ${id}; use upsert_target to add it first`)
          const target = { ...targets[index] }
          const isEmpty = typeof environment === 'string' ? environment.trim().length === 0 : environment.every((entry) => entry.trim().length === 0)
          if (isEmpty) delete target.environment
          else target.environment = environment
          targets[index] = target
          next.targets = targets
          found = true
          return next
        })
        if (!found) throw new Error(`target not written: ${id}`)
        return { text: `updated environment notes for ${id}` }
      }

      if (action === 'upsert_target') {
        const target = cleanTarget(args.target)
        if (typeof target.id !== 'string' || target.id.trim().length === 0) throw new Error('target.id is required')
        if (target.transport !== 'ssh' && target.transport !== 'wsl') throw new Error('target.transport must be ssh or wsl')
        await editConfig(ctx, (next) => {
          const targets = Array.isArray(next.targets) ? [...next.targets] : []
          const index = targets.findIndex((candidate) => candidate?.id === target.id)
          if (index < 0) targets.push(target)
          else targets[index] = target
          next.targets = targets
          return next
        })
        return { text: `saved target ${target.id}` }
      }

      if (action === 'remove_target') {
        const id = requiredString(args, 'id')
        let found = false
        await editConfig(ctx, (next) => {
          const targets = Array.isArray(next.targets) ? next.targets : []
          const filtered = targets.filter((candidate) => candidate?.id !== id)
          found = filtered.length !== targets.length
          next.targets = filtered
          return next
        })
        if (!found) throw new Error(`unknown target id: ${id}`)
        return { text: `removed target ${id}` }
      }

      throw new Error(`unknown action: ${action}`)
    }
  }))
}
