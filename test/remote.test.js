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
  const target = resolveTarget(config, 'ssh://alice@gpu.example.edu:2222')
  assert.equal(target.transport, 'ssh')
  assert.equal(target.user, 'alice')
  assert.equal(target.host, 'gpu.example.edu')
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
        id: 'gpu',
        label: 'GPU login',
        transport: 'ssh',
        host: 'gpu.example.edu',
        user: 'alice',
        defaultCwd: '/data/project',
        environment: 'module load intel/2022\nconda activate torch'
      }
    ]
  })
  const prompt = buildRemotePrompt(config)
  assert.match(prompt, /Do not run heavy compute/)
  assert.match(prompt, /gpu — GPU login/)
  assert.match(prompt, /module load intel\/2022/)
  assert.match(prompt, /default cwd: \/data\/project/)
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

test('apply registers all six tools and the system-prompt section', () => {
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
      { id: 'gpu', transport: 'ssh', host: 'gpu.example.edu', environment: 'module load foo' }
    ]
  })
  assert.deepEqual([...tools.keys()].sort(), [
    'remote_exec',
    'remote_list',
    'remote_read',
    'remote_targets',
    'remote_transfer',
    'remote_write'
  ])
  assert.equal(section?.name, 'dsh-remote:targets')
  assert.match(section.text, /module load foo/)
})
