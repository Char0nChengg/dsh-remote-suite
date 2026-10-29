/**
 * Transport core for dsh-remote.
 *
 * DSH runs on the Windows host. This module only starts local OpenSSH
 * (`ssh.exe` / `scp.exe`) or WSL (`wsl.exe`) processes, so the remote side
 * needs nothing more than a stock sshd. No agent, helper, reverse tunnel, or
 * outbound connection is required on the server.
 */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat as fsStat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { posix as pathPosix } from 'node:path'
import { pipeline } from 'node:stream/promises'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000
const MAX_TRANSFER_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DEFAULT_OUTPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_READ_BYTES = 256 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_LARGE_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_PREVIEW_BYTES = 4 * 1024
const MAX_TRANSFER_STDERR = 64 * 1024
const HOME_CACHE_LIMIT = 100
const MAX_ENVIRONMENT_CHARS = 4_000
const MAX_PROMPT_CHARS = 6_000

const homeCache = new Map()

function fail(message) {
  throw new Error(`dsh-remote: ${message}`)
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function firstLine(value, fallback = '') {
  const line = String(value ?? '').split(/\r?\n/).find((entry) => entry.trim().length > 0)
  return oneLine(line ?? fallback).slice(0, 500)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function numberOption(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail(`expected a number, got ${JSON.stringify(value)}`)
  return clamp(Math.trunc(parsed), min, max)
}

function textOption(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be a non-empty string`)
  return value.trim()
}

function validateSimpleToken(value, name, pattern = /^[^\s\0\r\n]+$/) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be a non-empty string`)
  const trimmed = value.trim()
  if (trimmed.startsWith('-') || !pattern.test(trimmed)) fail(`invalid ${name}: ${JSON.stringify(value)}`)
  return trimmed
}

function validateRemoteCwd(value, name = 'defaultCwd') {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') fail(`${name} must be a string`)
  const cwd = value.trim()
  if (cwd === '~' || cwd.startsWith('/')) return cwd
  fail(`${name} must be an absolute POSIX path or ~, got ${JSON.stringify(value)}`)
}

function expandLocalPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return path.resolve(value)
}

function resolveHostBinary(configValue, fallback) {
  if (configValue) return expandLocalPath(configValue)
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || 'C:\\Windows'
    const candidate = path.join(windir, 'System32', 'OpenSSH', `${fallback}.exe`)
    if (existsSync(candidate)) return candidate
  }
  return fallback
}

function resolveWslBinary(configValue) {
  if (configValue) return expandLocalPath(configValue)
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || 'C:\\Windows'
    const candidate = path.join(windir, 'System32', 'wsl.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'wsl'
}

function normalizeSshOptions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('sshOptions must be an array of strings')
  return value.map((option) => {
    if (typeof option !== 'string' || option.trim().length === 0 || /[\0\r\n]/.test(option)) {
      fail('sshOptions entries must be non-empty single-line strings')
    }
    return option.trim()
  })
}

function normalizeEnvironment(value, id) {
  if (value === undefined || value === null || value === '') return undefined
  let text
  if (typeof value === 'string') {
    text = value.trim()
  } else if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== 'string')) fail(`target "${id}": environment entries must be strings`)
    text = value.map((entry) => entry.trim()).filter(Boolean).join('\n')
  } else {
    fail(`target "${id}": environment must be a string or an array of strings`)
  }
  if (text.length === 0) return undefined
  if (text.length > MAX_ENVIRONMENT_CHARS) fail(`target "${id}": environment is limited to ${MAX_ENVIRONMENT_CHARS} characters`)
  return text
}

function normalizeTarget(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`targets[${index}] must be an object`)
  const id = validateSimpleToken(raw.id, `targets[${index}].id`, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const transport = raw.transport
  if (transport !== 'ssh' && transport !== 'wsl') fail(`target "${id}": transport must be "ssh" or "wsl"`)
  const target = {
    id,
    label: typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : id,
    transport,
    shell: typeof raw.shell === 'string' && raw.shell.trim().length > 0 ? validateSimpleToken(raw.shell, `target "${id}" shell`) : 'bash',
    defaultCwd: validateRemoteCwd(raw.defaultCwd, `target "${id}" defaultCwd`),
    environment: normalizeEnvironment(raw.environment, id),
    sshOptions: normalizeSshOptions(raw.sshOptions)
  }

  if (transport === 'ssh') {
    target.host = validateSimpleToken(raw.host, `target "${id}" host`, /^[^\s\0\r\n]+$/)
    if (target.host.includes('@')) fail(`target "${id}": host must not contain @; use the separate user field`)
    if (raw.user !== undefined && raw.user !== null && raw.user !== '') {
      target.user = validateSimpleToken(raw.user, `target "${id}" user`, /^[A-Za-z0-9._-]+$/)
    }
    if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
      const port = Number(raw.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`target "${id}": port must be an integer from 1 to 65535`)
      target.port = port
    }
    if (raw.identityFile !== undefined && raw.identityFile !== null && raw.identityFile !== '') {
      target.identityFile = expandLocalPath(textOption(raw.identityFile, `target "${id}" identityFile`))
    }
    if (raw.proxyJump !== undefined && raw.proxyJump !== null && raw.proxyJump !== '') {
      target.proxyJump = validateSimpleToken(raw.proxyJump, `target "${id}" proxyJump`)
    }
    target.endpoint = `${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`
  } else {
    if (raw.distro !== undefined && raw.distro !== null && raw.distro !== '') {
      target.distro = validateSimpleToken(raw.distro, `target "${id}" distro`)
    }
    target.endpoint = `WSL ${target.distro ?? 'default distro'}`
  }

  target.cacheKey = `${target.transport}|${target.endpoint}|${target.distro ?? ''}`
  return target
}

/**
 * Validate the plugin row's config and fill in local defaults.
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (input.targets !== undefined && !Array.isArray(input.targets)) fail('targets must be an array')
  const targets = (input.targets ?? []).map((entry, index) => normalizeTarget(entry, index))
  const seen = new Set()
  for (const target of targets) {
    if (seen.has(target.id)) fail(`duplicate target id: ${target.id}`)
    seen.add(target.id)
  }
  const strict = input.strictHostKeyChecking ?? 'accept-new'
  if (!['yes', 'no', 'ask', 'accept-new'].includes(strict)) {
    fail('strictHostKeyChecking must be one of yes, no, ask, accept-new')
  }
  let prompt = ''
  if (input.prompt !== undefined && input.prompt !== null && input.prompt !== '') {
    if (typeof input.prompt !== 'string') fail('prompt must be a string')
    prompt = input.prompt.trim()
    if (prompt.length > MAX_PROMPT_CHARS) fail(`prompt is limited to ${MAX_PROMPT_CHARS} characters`)
  }
  return {
    targets,
    prompt,
    sshPath: resolveHostBinary(input.sshPath, 'ssh'),
    scpPath: resolveHostBinary(input.scpPath, 'scp'),
    wslPath: resolveWslBinary(input.wslPath),
    connectTimeoutSec: numberOption(input.connectTimeoutSec, 10, 1, 120),
    strictHostKeyChecking: strict,
    defaultTimeoutMs: numberOption(input.defaultTimeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
    transferTimeoutMs: numberOption(input.transferTimeoutMs, DEFAULT_TRANSFER_TIMEOUT_MS, 1_000, MAX_TRANSFER_TIMEOUT_MS),
    maxOutputBytes: numberOption(input.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES),
    defaultReadBytes: numberOption(input.defaultReadBytes, DEFAULT_READ_BYTES, 1_024, MAX_READ_BYTES),
    largeFileBytes: numberOption(input.largeFileBytes, DEFAULT_LARGE_FILE_BYTES, 1_024, 1024 * 1024 * 1024),
    previewBytes: numberOption(input.previewBytes, DEFAULT_PREVIEW_BYTES, 256, DEFAULT_READ_BYTES)
  }
}

function parseSshUri(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`invalid SSH target URI: ${value}`)
  }
  if (url.protocol !== 'ssh:') fail(`unsupported SSH target URI protocol: ${url.protocol}`)
  if (url.pathname && url.pathname !== '/') fail('SSH target URIs must not include a path; pass the remote path separately')
  const host = url.hostname
  if (!host) fail(`invalid SSH target URI: ${value}`)
  const target = {
    id: `ssh:${value.slice(4)}`,
    label: `SSH ${value.slice(4)}`,
    transport: 'ssh',
    host,
    shell: 'bash',
    sshOptions: [],
    endpoint: `${url.username ? `${decodeURIComponent(url.username)}@` : ''}${host}${url.port ? `:${url.port}` : ''}`
  }
  if (url.username) target.user = validateSimpleToken(decodeURIComponent(url.username), 'SSH user', /^[A-Za-z0-9._-]+$/)
  if (url.port) target.port = Number(url.port)
  target.cacheKey = `ssh|${target.endpoint}|`
  return target
}

/**
 * Resolve a configured target id, or an ad-hoc `ssh:` / `wsl:` target.
 * @param {object} config
 * @param {string} value
 * @returns {object}
 */
export function resolveTarget(config, value) {
  const id = textOption(value, 'target')
  const configured = config.targets.find((target) => target.id === id)
  if (configured) return configured

  if (id.startsWith('ssh://')) return parseSshUri(id)

  if (id.startsWith('ssh:')) {
    const rest = id.slice(4).trim()
    if (!rest) fail('ssh: target needs a host or an ~/.ssh/config alias')
    if (/[\s\0\r\n]/.test(rest) || rest.startsWith('-') || rest.includes('/')) {
      fail(`invalid ad-hoc SSH target: ${JSON.stringify(rest)}`)
    }
    const at = rest.lastIndexOf('@')
    const user = at > 0 ? rest.slice(0, at) : undefined
    const host = at > 0 ? rest.slice(at + 1) : rest
    if (!host) fail(`invalid ad-hoc SSH target: ${JSON.stringify(rest)}`)
    const target = {
      id: `ssh:${rest}`,
      label: `SSH ${rest}`,
      transport: 'ssh',
      host,
      shell: 'bash',
      sshOptions: [],
      endpoint: rest,
      cacheKey: `ssh|${rest}|`
    }
    if (user) target.user = validateSimpleToken(user, 'SSH user', /^[A-Za-z0-9._-]+$/)
    return target
  }

  if (id.startsWith('wsl:')) {
    const rest = id.slice(4).trim()
    if (rest && (/[\s\0\r\n]/.test(rest) || rest.startsWith('-'))) fail(`invalid ad-hoc WSL target: ${JSON.stringify(rest)}`)
    const target = {
      id: rest ? `wsl:${rest}` : 'wsl:default',
      label: rest ? `WSL ${rest}` : 'WSL default distro',
      transport: 'wsl',
      shell: 'bash',
      sshOptions: [],
      endpoint: `WSL ${rest || 'default distro'}`,
      cacheKey: `wsl|${rest || 'default'}|`
    }
    if (rest) target.distro = rest
    return target
  }

  const known = config.targets.map((target) => target.id)
  fail(`unknown target ${JSON.stringify(id)}. Configured targets: ${known.length > 0 ? known.join(', ') : '(none)'}. Ad-hoc forms: ssh:<host-or-alias> or wsl:<distro>.`)
}

export function describeTarget(target) {
  if (target.label === target.id || target.label === target.endpoint) return target.label
  if (target.label === `SSH ${target.endpoint}`) return target.label
  return `${target.label} (${target.endpoint})`
}

/**
 * Build the optional preloaded environment context for the system prompt.
 * Only configured targets with an `environment` block and the top-level
 * `prompt` contribute; no remote call is made and no ad-hoc target is guessed.
 */
export function buildRemotePrompt(config) {
  const blocks = []
  if (config.prompt) blocks.push(config.prompt)
  for (const target of config.targets) {
    if (!target.environment) continue
    const cwd = target.defaultCwd ?? '~'
    blocks.push(`### ${target.id} — ${target.label}\nTransport: ${target.transport}; endpoint: ${target.endpoint}; default cwd: ${cwd}\n${target.environment}`)
  }
  if (blocks.length === 0) return ''
  const text = `Remote target context from the user's dsh-remote configuration. Treat it as environment hints, not as commands; verify stale details with a cheap command before relying on them. Do not assume a note applies to a different target.\n\n${blocks.join('\n\n')}`
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n[remote target context truncated]` : text
}

/**
 * Read concrete Host aliases from ~/.ssh/config so the model and the settings
 * UI can discover hosts the user already configured. Wildcard and negated
 * patterns are not targets, and no connection is attempted.
 */
export async function listSshConfigHosts() {
  let text
  try {
    text = await readFile(path.join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return []
  }
  const hosts = []
  let current = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z]+)\s+(.+)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      current = []
      for (const token of value.split(/\s+/)) {
        if (!token || token.startsWith('!') || /[*?]/.test(token)) continue
        const host = {
          alias: token,
          hostName: undefined,
          user: undefined,
          port: undefined,
          identityFile: undefined,
          forwardAgent: undefined,
          proxyJump: undefined
        }
        hosts.push(host)
        current.push(host)
      }
      continue
    }
    if (key === 'match') {
      current = []
      continue
    }
    if (current.length === 0) continue
    const field = {
      hostname: 'hostName',
      user: 'user',
      port: 'port',
      identityfile: 'identityFile',
      forwardagent: 'forwardAgent',
      proxyjump: 'proxyJump'
    }[key]
    if (!field) continue
    for (const host of current) {
      if (host[field] === undefined) host[field] = value
    }
  }
  const seen = new Set()
  return hosts.filter((host) => {
    if (seen.has(host.alias)) return false
    seen.add(host.alias)
    return true
  })
}

export async function listSshAliases() {
  return (await listSshConfigHosts()).map((host) => host.alias)
}

/** Quote one string for a POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function destination(target) {
  return target.user ? `${target.user}@${target.host}` : target.host
}

export function buildShellCommand(target, script, timeoutMs) {
  const shell = target.shell || 'bash'
  const invocation = `${shell} -lc ${shellQuote(script)}`
  if (!timeoutMs) return invocation
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return `if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 ${seconds} ${invocation}; else exec ${invocation}; fi`
}

/**
 * WSL argv deliberately passes the script as one raw argument after `-c`
 * instead of routing it through another shell. `wsl.exe` does not preserve the
 * nested backslash quoting that a remote shell needs, so the script must not be
 * shell-quoted a second time here.
 */
function wslShellArgv(target, script, timeoutMs) {
  const argv = []
  if (timeoutMs) argv.push('timeout', '-k', '5', String(Math.max(1, Math.ceil(timeoutMs / 1000))))
  argv.push(target.shell || 'bash', '-lc', script)
  return argv
}

export function sshArgs(target, remoteCommand, config) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${config.connectTimeoutSec}`,
    '-o', `StrictHostKeyChecking=${config.strictHostKeyChecking}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3'
  ]
  if (target.port) args.push('-p', String(target.port))
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')
  if (target.proxyJump) args.push('-J', target.proxyJump)
  for (const option of target.sshOptions ?? []) args.push('-o', option)
  args.push('--', destination(target), remoteCommand)
  return args
}

export function scpArgs(target, { source, destination: remoteDestination, recursive }, config) {
  const args = [
    '-q',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${config.connectTimeoutSec}`,
    '-o', `StrictHostKeyChecking=${config.strictHostKeyChecking}`
  ]
  if (recursive) args.push('-r')
  if (target.port) args.push('-P', String(target.port))
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')
  if (target.proxyJump) args.push('-J', target.proxyJump)
  for (const option of target.sshOptions ?? []) args.push('-o', option)
  args.push(source, remoteDestination)
  return args
}

export function wslArgs(target, argv) {
  const args = []
  if (target.distro) args.push('-d', target.distro)
  // --exec bypasses wsl.exe's default-shell command-line re-parsing; -- does not.
  args.push('--exec', ...argv)
  return args
}

/**
 * Keep only the tail of a stream, or its head when a listing must stay ordered.
 * Draining continues after the cap, so the child never blocks on a full pipe.
 */
class Capture {
  constructor(maxBytes, mode = 'tail') {
    this.maxBytes = Math.max(0, maxBytes)
    this.mode = mode
    this.chunks = []
    this.bytes = 0
    this.omitted = 0
    this.total = 0
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return
    this.total += chunk.length
    if (this.maxBytes === 0) {
      this.omitted += chunk.length
      return
    }
    if (this.mode === 'head') {
      if (this.bytes >= this.maxBytes) {
        this.omitted += chunk.length
        return
      }
      const keep = chunk.subarray(0, this.maxBytes - this.bytes)
      this.chunks.push(keep)
      this.bytes += keep.length
      this.omitted += chunk.length - keep.length
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const first = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (first.length <= excess) {
        this.chunks.shift()
        this.bytes -= first.length
        this.omitted += first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.bytes -= excess
        this.omitted += excess
        break
      }
    }
  }

  value() {
    return this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks, this.bytes)
  }
}

function decodeText(buffer) {
  if (!buffer || buffer.length === 0) return ''
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (probe.includes(0) && buffer.length % 2 === 0) {
    const text = buffer.toString('utf16le')
    if (!text.includes('\u0000')) return text
  }
  return buffer.toString('utf8')
}

function cleanStderr(text, target) {
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    if (target.transport === 'wsl' && line.startsWith('wsl: ')) continue
    if (line.startsWith('Warning: Permanently added ')) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function looksBinary(buffer) {
  if (!buffer || buffer.length === 0) return false
  if (buffer.includes(0)) return true
  const sample = buffer.subarray(0, 8_192)
  let controls = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32) || byte === 127) controls += 1
  }
  if (controls / sample.length > 0.02) return true
  const text = sample.toString('utf8')
  if (text.includes('\uFFFD')) {
    let replacements = 0
    for (const character of text) if (character === '\uFFFD') replacements += 1
    if (replacements / Math.max(1, text.length) > 0.01) return true
  }
  return false
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    child.kill()
  } catch {
    // already gone
  }
  if (process.platform !== 'win32' || !child.pid) return
  try {
    const windir = process.env.WINDIR || 'C:\\Windows'
    const taskkill = path.join(windir, 'System32', 'taskkill.exe')
    const killer = spawn(existsSync(taskkill) ? taskkill : 'taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => {})
    killer.unref()
  } catch {
    // best effort; the remote timeout is the real backstop
  }
}

/**
 * Run one local process with bounded captured output.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: Buffer, stderr: Buffer, timedOut: boolean, aborted: boolean, durationMs: number}>}
 */
function runProcess(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_BYTES
  const captureMode = options.capture ?? 'tail'
  return new Promise((resolve, reject) => {
    const stdout = new Capture(maxBytes, captureMode)
    const stderr = new Capture(maxBytes, captureMode)
    const started = Date.now()
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, WSL_UTF8: '1', ...(options.env ?? {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(new Error(`cannot start ${file}: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    let settled = false
    let timedOut = false
    let aborted = false
    let timeoutHandle
    let killHandle
    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (killHandle) clearTimeout(killHandle)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (code, signalName, failure) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) {
        reject(failure)
        return
      }
      resolve({
        code,
        signal: signalName,
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutOmitted: stdout.omitted,
        stderrOmitted: stderr.omitted,
        timedOut,
        aborted,
        durationMs: Date.now() - started
      })
    }
    const onAbort = () => {
      if (aborted) return
      aborted = true
      killProcessTree(child)
      killHandle = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        settle(null, null)
      }, 4_000)
      killHandle.unref?.()
    }

    child.on('error', (error) => settle(null, null, new Error(`cannot start ${file}: ${error.message}`)))
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signalName) => settle(code, signalName))
    child.stdin.on('error', () => {})

    timeoutHandle = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      killHandle = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        settle(null, null)
      }, 4_000)
      killHandle.unref?.()
    }, timeoutMs)
    timeoutHandle.unref?.()

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      child.stdin.end(options.input)
    } catch {
      // the close/error path reports the useful failure
    }
  })
}

async function remoteHome(target, config) {
  if (homeCache.has(target.cacheKey)) return homeCache.get(target.cacheKey)
  const lookup = (async () => {
    const result = await runRemoteShell(target, 'printf %s "$HOME"', config, {
      timeoutMs: 15_000,
      maxBytes: 4_096,
      capture: 'head'
    })
    if (result.code !== 0) {
      fail(`cannot determine home directory on ${describeTarget(target)}: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
    }
    const home = result.stdoutText.trim()
    if (!home.startsWith('/')) fail(`remote home directory is not absolute: ${JSON.stringify(home)}`)
    return home.replace(/\/+$/, '') || '/'
  })()
  homeCache.set(target.cacheKey, lookup)
  if (homeCache.size > HOME_CACHE_LIMIT) homeCache.delete(homeCache.keys().next().value)
  try {
    return await lookup
  } catch (error) {
    homeCache.delete(target.cacheKey)
    throw error
  }
}

async function resolveRemotePath(target, config, input, { allowRelative = true } = {}) {
  const value = textOption(input, 'path')
  if (value.includes('\0')) fail('remote path must not contain a NUL byte')
  if (value === '~') return remoteHome(target, config)
  if (value.startsWith('~/')) return pathPosix.join(await remoteHome(target, config), value.slice(2))
  if (value.startsWith('~')) fail(`only ~ and ~/... are supported for home-relative paths, got ${JSON.stringify(value)}`)
  if (value.startsWith('/')) return pathPosix.normalize(value)
  if (!allowRelative) fail(`remote path must be absolute, got ${JSON.stringify(value)}`)
  const base = target.defaultCwd
    ? await resolveRemotePath(target, config, target.defaultCwd, { allowRelative: false })
    : await remoteHome(target, config)
  return pathPosix.normalize(pathPosix.join(base, value))
}

function remoteCwd(target, value) {
  const cwd = value === undefined || value === null || value === '' ? target.defaultCwd ?? '~' : value
  if (typeof cwd !== 'string' || cwd.trim().length === 0) fail('cwd must be a non-empty string')
  const trimmed = cwd.trim()
  if (trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) fail('cwd must be one line')
  if (trimmed !== '~' && !trimmed.startsWith('/') && !trimmed.startsWith('.') && !trimmed.startsWith('..')) {
    // A bare relative cwd is still useful; the login shell resolves it from $HOME.
  }
  return trimmed
}

/**
 * Run a POSIX shell script on the target.
 * @param {object} target
 * @param {string} script
 * @param {object} config
 * @param {{timeoutMs?: number, maxBytes?: number, capture?: 'head'|'tail', input?: string|Buffer, signal?: AbortSignal, cwd?: string}} options
 */
export async function runRemoteShell(target, script, config, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs
  const args = target.transport === 'ssh'
    ? sshArgs(target, buildShellCommand(target, script, timeoutMs), config)
    : wslArgs(target, wslShellArgv(target, script, timeoutMs))
  const binary = target.transport === 'ssh' ? config.sshPath : config.wslPath
  const result = await runProcess(binary, args, {
    input: options.input,
    timeoutMs: Math.min(timeoutMs + 8_000, 24 * 60 * 60 * 1000),
    maxBytes: options.maxBytes ?? config.maxOutputBytes,
    capture: options.capture ?? 'tail',
    signal: options.signal,
    cwd: options.cwd
  })
  return {
    ...result,
    timedOut: result.timedOut || result.code === 124,
    stdoutText: decodeText(result.stdout),
    stderrText: cleanStderr(decodeText(result.stderr), target),
    target
  }
}

/**
 * Test connectivity and return the remote OS string when possible.
 */
export async function probeTarget(target, config) {
  const started = Date.now()
  try {
    const result = await runRemoteShell(target, 'printf "ok\\t"; uname -sr 2>/dev/null || true', config, {
      timeoutMs: 10_000,
      maxBytes: 8_192,
      capture: 'head'
    })
    const latencyMs = Date.now() - started
    if (result.code !== 0) {
      return {
        ok: false,
        latencyMs,
        error: firstLine(result.stderrText, `exit ${result.code}`)
      }
    }
    const detail = result.stdoutText.replace(/^ok\t?/, '').trim()
    return { ok: true, latencyMs, detail }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: firstLine(error instanceof Error ? error.message : String(error))
    }
  }
}

function parseStat(text) {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  if (!line) fail('stat returned no data')
  const parts = line.split('\t')
  if (parts.length < 6) fail(`unexpected stat output: ${oneLine(line)}`)
  const size = Number(parts[0])
  const mtime = Number(parts[1])
  if (!Number.isFinite(size) || !Number.isFinite(mtime)) fail(`unexpected stat output: ${oneLine(line)}`)
  const type = parts.slice(5).join('\t')
  return {
    size,
    mtimeMs: mtime * 1000,
    mode: parts[2].trim() || '?',
    owner: parts[3].trim() || '?',
    group: parts[4].trim() || '?',
    type,
    isDirectory: type === 'directory',
    isFile: type.startsWith('regular')
  }
}

/**
 * Stat one remote path. Symlinks are followed.
 */
export async function statRemote(target, config, remotePath, options = {}) {
  const resolved = await resolveRemotePath(target, config, remotePath)
  const format = '%s\t%Y\t%a\t%U\t%G\t%F'
  const result = await runRemoteShell(target, `LC_ALL=C stat --printf ${shellQuote(format)} -- ${shellQuote(resolved)}`, config, {
    timeoutMs: 30_000,
    maxBytes: 8_192,
    capture: 'head',
    signal: options.signal
  })
  if (result.code !== 0) {
    fail(`stat ${resolved} on ${describeTarget(target)} failed: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
  }
  return { path: resolved, ...parseStat(result.stdoutText) }
}

/**
 * Read a bounded portion of one remote file.
 */
export async function readRemote(target, config, remotePath, options = {}) {
  const mode = options.mode ?? 'auto'
  if (!['auto', 'head', 'tail', 'range'].includes(mode)) fail(`invalid read mode: ${mode}`)
  const info = await statRemote(target, config, remotePath, { signal: options.signal })
  if (info.isDirectory) fail(`${info.path} is a directory; use remote_list`)
  if (!info.isFile) fail(`${info.path} is not a regular file (${info.type})`)
  const maxBytes = numberOption(options.maxBytes, config.defaultReadBytes, 1_024, MAX_READ_BYTES)

  let offset = 0
  let length = maxBytes
  if (mode === 'auto') {
    length = info.size <= config.largeFileBytes ? Math.min(info.size, maxBytes) : Math.min(info.size, maxBytes, config.previewBytes)
  } else if (mode === 'head') {
    length = Math.min(info.size, numberOption(options.length, maxBytes, 1, MAX_READ_BYTES), maxBytes)
  } else if (mode === 'tail') {
    length = Math.min(info.size, numberOption(options.length, maxBytes, 1, MAX_READ_BYTES), maxBytes)
    offset = Math.max(0, info.size - length)
  } else {
    offset = numberOption(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    length = Math.min(info.size - offset, numberOption(options.length, maxBytes, 1, MAX_READ_BYTES), maxBytes)
  }

  if (length <= 0 || info.size === 0) {
    return {
      path: info.path,
      info,
      mode,
      offset,
      length: 0,
      content: '',
      binary: false,
      bytesRead: 0,
      truncated: info.size > 0,
      hasMore: offset < info.size,
      nextOffset: offset
    }
  }

  const readCommand = offset === 0
    ? `head -c ${length} -- ${shellQuote(info.path)}`
    : `tail -c +${offset + 1} -- ${shellQuote(info.path)} | head -c ${length}`
  const result = await runRemoteShell(target, readCommand, config, {
    timeoutMs: Math.max(30_000, Math.ceil(length / 1024) * 100),
    maxBytes: length + 4_096,
    capture: 'head',
    signal: options.signal
  })
  if (result.code !== 0) {
    fail(`read ${info.path} on ${describeTarget(target)} failed: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
  }
  const buffer = result.stdout
  const binary = looksBinary(buffer)
  const content = binary ? '' : decodeText(buffer)
  const bytesRead = buffer.length
  const nextOffset = offset + bytesRead
  return {
    path: info.path,
    info,
    mode,
    offset,
    length,
    content,
    binary,
    bytesRead,
    truncated: offset !== 0 || bytesRead < info.size,
    hasMore: nextOffset < info.size,
    nextOffset
  }
}

function parseFindEntry(buffer) {
  const fields = []
  let rest = buffer.toString('utf8')
  for (let index = 0; index < 5; index += 1) {
    const tab = rest.indexOf('\t')
    if (tab < 0) return undefined
    fields.push(rest.slice(0, tab))
    rest = rest.slice(tab + 1)
  }
  fields.push(rest)
  const [type, sizeText, mtimeText, mode, link, name] = fields
  const size = Number(sizeText)
  const mtime = Number(mtimeText)
  return {
    type,
    size: Number.isFinite(size) ? size : 0,
    mtimeMs: Number.isFinite(mtime) ? mtime * 1000 : 0,
    mode: mode || '?',
    link: link || undefined,
    name
  }
}

/**
 * List one remote directory, with metadata.
 */
export async function listRemote(target, config, remotePath, options = {}) {
  const resolved = await resolveRemotePath(target, config, remotePath)
  const maxEntries = numberOption(options.maxEntries, 200, 1, 1_000)
  const script = `LC_ALL=C find ${shellQuote(resolved)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%l\\t%f\\0'`
  const result = await runRemoteShell(target, script, config, {
    timeoutMs: 60_000,
    maxBytes: 4 * 1024 * 1024,
    capture: 'head',
    signal: options.signal
  })
  if (result.code !== 0) {
    fail(`list ${resolved} on ${describeTarget(target)} failed: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
  }
  const entries = []
  let start = 0
  const buffer = result.stdout
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    const parsed = parseFindEntry(buffer.subarray(start, index))
    if (parsed) entries.push(parsed)
    start = index + 1
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const truncated = entries.length > maxEntries || result.stdoutOmitted > 0
  return {
    path: resolved,
    entries: entries.slice(0, maxEntries),
    totalSeen: entries.length,
    truncated,
    omittedBytes: result.stdoutOmitted
  }
}

/**
 * Write a UTF-8 text file through a remote temporary file and atomic rename.
 */
export async function writeRemote(target, config, remotePath, content, options = {}) {
  if (typeof content !== 'string') fail('content must be a string')
  if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) fail('content is limited to 8 MiB; use remote_transfer for larger files')
  const resolved = await resolveRemotePath(target, config, remotePath)
  if (resolved.endsWith('/')) fail('remote file path must not end with /')
  const mode = options.mode === undefined || options.mode === null || options.mode === '' ? undefined : String(options.mode)
  if (mode !== undefined && !/^[0-7]{3,4}$/.test(mode)) fail(`invalid file mode: ${JSON.stringify(options.mode)}`)
  const createDirs = options.createDirs === true
  const pathLit = shellQuote(resolved)
  const parentLit = shellQuote(pathPosix.dirname(resolved))
  let script = 'set -eu\nexport LC_ALL=C\n'
  if (createDirs) script += `mkdir -p -- ${parentLit}\n`
  script += `tmp=$(mktemp ${pathLit}.dsh-remote.XXXXXX)\n`
  script += `trap 'rm -f -- "$tmp"' EXIT HUP INT TERM\n`
  script += 'cat > "$tmp"\n'
  script += `if [ -e ${pathLit} ]; then chmod --reference=${pathLit} "$tmp" 2>/dev/null || chmod 644 "$tmp"; else chmod 644 "$tmp"; fi\n`
  if (mode !== undefined) script += `chmod ${mode} "$tmp"\n`
  script += `mv -f -- "$tmp" ${pathLit}\n`
  const result = await runRemoteShell(target, script, config, {
    timeoutMs: 120_000,
    maxBytes: 32_768,
    capture: 'tail',
    input: content,
    signal: options.signal
  })
  if (result.code !== 0) {
    fail(`write ${resolved} on ${describeTarget(target)} failed: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
  }
  return { path: resolved, bytes: Buffer.byteLength(content, 'utf8') }
}

async function ensureRemoteDir(target, config, directory) {
  if (!directory || directory === '/' || directory === '.') return
  const result = await runRemoteShell(target, `mkdir -p -- ${shellQuote(directory)}`, config, {
    timeoutMs: 60_000,
    maxBytes: 16_384,
    capture: 'tail'
  })
  if (result.code !== 0) {
    fail(`cannot create ${directory} on ${describeTarget(target)}: ${firstLine(result.stderrText, `exit ${result.code}`)}`)
  }
}

async function localBytes(localPath) {
  let info
  try {
    info = await fsStat(localPath)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  const entries = await readdir(localPath, { withFileTypes: true })
  for (const entry of entries) {
    total += await localBytes(path.join(localPath, entry.name))
  }
  return total
}

async function runStreaming(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, WSL_UTF8: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(new Error(`cannot start ${file}: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const stderr = new Capture(MAX_TRANSFER_STDERR, 'tail')
    let settled = false
    let timedOut = false
    let ioError
    let timeoutHandle
    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (code, signalName, failure) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else resolve({ code, signal: signalName, timedOut, stderrText: cleanStderr(decodeText(stderr.value()), options.target) })
    }
    const onAbort = () => {
      killProcessTree(child)
    }
    const io = options.inputPath
      ? pipeline(createReadStream(options.inputPath), child.stdin)
      : options.outputPath
        ? pipeline(child.stdout, createWriteStream(options.outputPath))
        : Promise.resolve()
    if (!options.inputPath) child.stdin.end()
    if (!options.outputPath) child.stdout.resume()
    io.catch((error) => {
      ioError = error
      killProcessTree(child)
    })
    child.on('error', (error) => settle(null, null, new Error(`cannot start ${file}: ${error.message}`)))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signalName) => {
      if (timedOut) {
        settle(code, signalName, new Error(`transfer timed out after ${timeoutMs} ms`))
        return
      }
      if (ioError) {
        settle(code, signalName, new Error(`transfer stream failed: ${ioError instanceof Error ? ioError.message : String(ioError)}`))
        return
      }
      if (code !== 0) {
        settle(code, signalName, new Error(`transfer failed: ${firstLine(cleanStderr(decodeText(stderr.value()), options.target), `exit ${code}`)}`))
        return
      }
      settle(code, signalName)
    })
    timeoutHandle = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    timeoutHandle.unref?.()
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Copy one file between this host and a target. Directories are supported over
 * SSH only; WSL transfers use a byte stream and therefore files only.
 */
export async function transferRemote(target, config, request) {
  const direction = request.direction
  if (direction !== 'upload' && direction !== 'download') fail('direction must be upload or download')
  const localPath = path.resolve(expandLocalPath(request.localPath))
  const remotePath = await resolveRemotePath(target, config, request.remotePath)
  const recursive = request.recursive === true
  const createDirs = request.createDirs === true

  if (target.transport === 'ssh') {
    let localInfo
    try {
      localInfo = await fsStat(localPath)
    } catch {
      if (direction === 'upload') fail(`local path does not exist: ${localPath}`)
    }
    if (localInfo?.isDirectory() && !recursive) fail(`${localPath} is a directory; pass recursive: true`)
    if (direction === 'upload' && createDirs) await ensureRemoteDir(target, config, pathPosix.dirname(remotePath))
    if (direction === 'download' && createDirs) await mkdir(path.dirname(localPath), { recursive: true })
    // Modern OpenSSH scp uses the SFTP subsystem: the remote path is sent
    // literally, so it must NOT be shell-quoted here (quotes would become part
    // of the filename). Paths with spaces work because Node passes this whole
    // `host:path` value as one argument.
    const remoteDestination = `${destination(target)}:${remotePath}`
    const args = scpArgs(target, {
      source: direction === 'upload' ? localPath : remoteDestination,
      destination: direction === 'upload' ? remoteDestination : localPath,
      recursive
    }, config)
    const result = await runStreaming(config.scpPath, args, {
      timeoutMs: config.transferTimeoutMs,
      target,
      signal: request.signal
    })
    const bytes = await localBytes(localPath)
    return { direction, localPath, remotePath, bytes }
  }

  if (recursive) fail('WSL transfers support files only; use remote_exec with tar for directories')
  if (direction === 'upload') {
    let localInfo
    try {
      localInfo = await fsStat(localPath)
    } catch {
      fail(`local path does not exist: ${localPath}`)
    }
    if (!localInfo.isFile()) fail(`WSL upload supports regular files only: ${localPath}`)
    if (createDirs) await ensureRemoteDir(target, config, pathPosix.dirname(remotePath))
    const result = await runStreaming(config.wslPath, wslArgs(target, wslShellArgv(target, `cat > ${shellQuote(remotePath)}`, config.transferTimeoutMs)), {
      timeoutMs: config.transferTimeoutMs,
      inputPath: localPath,
      target,
      signal: request.signal
    })
    return { direction, localPath, remotePath, bytes: localInfo.size }
  }

  const remoteInfo = await statRemote(target, config, remotePath)
  if (!remoteInfo.isFile) fail(`WSL download supports regular files only: ${remotePath} (${remoteInfo.type})`)
  if (createDirs) await mkdir(path.dirname(localPath), { recursive: true })
  try {
    await runStreaming(config.wslPath, wslArgs(target, wslShellArgv(target, `cat -- ${shellQuote(remotePath)}`, config.transferTimeoutMs)), {
      timeoutMs: config.transferTimeoutMs,
      outputPath: localPath,
      target,
      signal: request.signal
    })
  } catch (error) {
    await unlink(localPath).catch(() => {})
    throw error
  }
  const localInfo = await fsStat(localPath)
  return { direction, localPath, remotePath, bytes: localInfo.size }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

export function formatTime(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown'
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, MAX_READ_BYTES }
