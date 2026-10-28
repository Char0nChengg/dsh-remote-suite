import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'
import { buildRemotePrompt, describeTarget, normalizeConfig, resolveTarget, shellQuote } from '../lib/remote.js'

test('shellQuote survives single quotes and dollar signs', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.equal(shellQuote('$HOME "x"'), "'$HOME \"x\"'")
})

test('ad-hoc SSH URI resolves user, host, and port', () => {
  const config = normalizeConfig({})
  const target = resolveTarget(config, 'ssh://Username@server.example.edu:2222')
  assert.equal(target.transport, 'ssh')
  assert.equal(target.user, 'Username')
  assert.equal(target.host, 'server.example.edu')
  assert.equal(target.port, 2222)
})

test('ad-hoc WSL target uses the default distro when empty', () => {
  const config = normalizeConfig({})
  const target = resolveTarget(config, 'wsl:')
  assert.equal(target.transport, 'wsl')
  assert.equal(target.distro, undefined)
  assert.equal(describeTarget(target), 'WSL default distro')
})

test('environment accepts a string or string array', () => {
  const config = normalizeConfig({
    targets: [
      { id: 'a', transport: 'ssh', host: 'a.example.edu', environment: 'module load a' },
      { id: 'b', transport: 'ssh', host: 'b.example.edu', environment: ['module load b', 'conda activate b'] }
    ]
  })
  assert.equal(config.targets[0].environment, 'module load a')
  assert.equal(config.targets[1].environment, 'module load b\nconda activate b')
})

test('preloaded prompt includes global guidance and per-target environment', () => {
  const config = normalizeConfig({
    prompt: 'Do not run heavy compute on the login node.',
    targets: [
      {
        id: 'myserver',
        label: 'Example login',
        transport: 'ssh',
        host: 'server.example.edu',
        user: 'Username',
        defaultCwd: '/home/Username/project',
        environment: 'module load intel/2022\nconda activate example-env'
      }
    ]
  })
  const prompt = buildRemotePrompt(config)
  assert.match(prompt, /Do not run heavy compute/)
  assert.match(prompt, /myserver — Example login/)
  assert.match(prompt, /module load intel\/2022/)
  assert.match(prompt, /default cwd: \/home\/Username\/project/)
})

test('preloaded prompt is omitted when no environment or global prompt exists', () => {
  const config = normalizeConfig({ targets: [{ id: 'a', transport: 'ssh', host: 'a.example.edu' }] })
  assert.equal(buildRemotePrompt(config), '')
})

test('environment and prompt limits reject oversized values', () => {
  assert.throws(() => normalizeConfig({
    targets: [{ id: 'a', transport: 'ssh', host: 'a.example.edu', environment: 'x'.repeat(4_001) }]
  }), /environment is limited/)
  assert.throws(() => normalizeConfig({ prompt: 'x'.repeat(6_001) }), /prompt is limited/)
})

test('apply registers all seven tools and the system-prompt section', () => {
  const tools = new Map()
  let section
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      }
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return {
        getSectionOrder: () => 1000,
        section(next) {
          section = next
          return () => {}
        }
      }
    },
    logger: { warn() {} }
  }
  apply(ctx, {
    prompt: 'Prefer tailing logs.',
    targets: [
      { id: 'myserver', transport: 'ssh', host: 'server.example.edu', environment: 'module load foo' }
    ]
  })
  assert.deepEqual([...tools.keys()].sort(), [
    'remote_config',
    'remote_exec',
    'remote_list',
    'remote_read',
    'remote_targets',
    'remote_transfer',
    'remote_write'
  ])
  assert.equal(section?.name, 'dsh-remote-suite:targets')
  assert.match(section.text, /module load foo/)
})

test('remote_config show and edit go through configEditor', async () => {
  let stored = {
    targets: [
      { id: 'wsl-ubuntu', transport: 'wsl', distro: 'Ubuntu', defaultCwd: '~', environment: 'local WSL' }
    ]
  }
  const entry = {
    options: {
      id: 'dsh-remote-suite',
      name: '@char0nchengg/dsh-remote-suite',
      get config() {
        return stored
      }
    }
  }
  const editor = {
    entries: () => [entry],
    async edit(_entry, change) {
      stored = change(structuredClone(stored), {})
    }
  }
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    get: (name) => name === 'configEditor' ? editor : undefined
  }
  apply(ctx, stored)
  const configTool = tools.get('remote_config')

  const shown = await configTool.execute({ action: 'show' })
  assert.match(shown.text, /wsl-ubuntu/)

  await configTool.execute({ action: 'set_environment', id: 'wsl-ubuntu', environment: 'updated notes' })
  assert.equal(stored.targets[0].environment, 'updated notes')

  await configTool.execute({
    action: 'upsert_target',
    target: { id: 'myserver', transport: 'ssh', host: 'server.example.edu', environment: 'module load foo' }
  })
  assert.equal(stored.targets.length, 2)
  assert.equal(stored.targets[1].id, 'myserver')

  await configTool.execute({ action: 'set_prompt', prompt: 'Prefer sbatch.' })
  assert.equal(stored.prompt, 'Prefer sbatch.')

  await configTool.execute({ action: 'remove_target', id: 'myserver' })
  assert.equal(stored.targets.length, 1)
})
