window.__ModuleLoader__.load({
  id: '@char0nchengg/dsh-remote-suite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
    const NS = 'dsh-remote-suite'

    const zh = {
      nav: '远程服务器',
      title: '远程服务器',
      intro: '通过 Windows 本机 OpenSSH 或 WSL 连接服务器。服务器不需要安装 Agent，也不会主动连接外网。',
      refresh: '刷新',
      add: '添加服务器',
      edit: '编辑',
      remove: '删除',
      test: '测试连接',
      testing: '测试中…',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      close: '关闭',
      targets: '已配置服务器',
      noTargets: '还没有配置服务器。可以从下方的 SSH config 别名添加，或手动添加。',
      aliases: '~/.ssh/config 中的服务器',
      noAliases: '没有找到可用的 SSH config 别名。',
      configured: '已添加',
      addAlias: '添加',
      auth: '认证',
      account: '账户',
      key: 'SSH key',
      sshConfig: 'SSH config / key',
      agent: 'SSH key 或 ssh-agent',
      wsl: 'WSL 默认用户',
      defaultCwd: '默认目录',
      environment: '环境说明',
      environmentHint: '例如 module load、conda activate、Slurm 分区、登录节点注意事项。会预加载到系统提示。',
      prompt: '全局远程提示',
      promptHint: '对所有服务器生效的使用习惯，例如“登录节点不要跑重计算，优先 sbatch”。',
      savePrompt: '保存提示',
      passwordNote: '密码不会保存在插件或配置里。SSH 目标使用 key / ssh-agent；密码登录请先配置公钥，避免把密码写进 YAML 或聊天记录。',
      passwordUnsupported: '不支持密码登录',
      status: '状态',
      reachable: '可达',
      unreachable: '不可达',
      id: 'ID',
      label: '显示名称',
      transport: '连接方式',
      host: 'SSH 主机 / 别名',
      user: '用户名（留空沿用 SSH config）',
      port: '端口（留空沿用 SSH config）',
      distro: 'WSL 发行版（留空使用默认）',
      hostHint: '可以填 IP、域名，或 ~/.ssh/config 里的 Host 别名。',
      identity: '身份文件',
      identityFile: '身份文件（可选）',
      forwardAgent: 'ForwardAgent',
      confirmDelete: '确定删除这个服务器配置？',
      loading: '加载中…',
      error: '操作失败',
      saved: '已保存',
      noPrompt: '还没有全局提示。',
      sshConfigPath: 'SSH config 路径',
      emptyEnvironment: '未填写环境说明',
      addTitle: '添加服务器',
      editTitle: '编辑服务器',
      wslOnly: 'WSL 目标使用默认发行版用户；如需指定用户，请在 WSL 内配置。'
    }

    const en = {
      nav: 'Remote servers',
      title: 'Remote servers',
      intro: 'Connect through the Windows OpenSSH client or WSL. The server needs no agent and never connects outward.',
      refresh: 'Refresh',
      add: 'Add server',
      edit: 'Edit',
      remove: 'Remove',
      test: 'Test connection',
      testing: 'Testing…',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      close: 'Close',
      targets: 'Configured servers',
      noTargets: 'No servers configured yet. Add one from the SSH config list below, or add manually.',
      aliases: 'Servers in ~/.ssh/config',
      noAliases: 'No usable SSH config aliases found.',
      configured: 'Added',
      addAlias: 'Add',
      auth: 'Authentication',
      account: 'Account',
      key: 'SSH key',
      sshConfig: 'SSH config / key',
      agent: 'SSH key or ssh-agent',
      wsl: 'WSL default user',
      defaultCwd: 'Default directory',
      environment: 'Environment notes',
      environmentHint: 'For example module load, conda activate, Slurm partition, or login-node rules. Preloaded into the system prompt.',
      prompt: 'Global remote prompt',
      promptHint: 'Guidance that applies to every target, e.g. "do not run heavy compute on the login node; prefer sbatch".',
      savePrompt: 'Save prompt',
      passwordNote: 'Passwords are not stored in the plugin or config. SSH targets use a key or ssh-agent; configure a public key instead of putting a password in YAML or chat.',
      passwordUnsupported: 'Password login is not supported',
      status: 'Status',
      reachable: 'Reachable',
      unreachable: 'Unreachable',
      id: 'ID',
      label: 'Display name',
      transport: 'Transport',
      host: 'SSH host / alias',
      user: 'User (blank = SSH config)',
      port: 'Port (blank = SSH config)',
      distro: 'WSL distro (blank = default)',
      hostHint: 'An IP, hostname, or a Host alias from ~/.ssh/config.',
      identity: 'Identity file',
      identityFile: 'Identity file (optional)',
      forwardAgent: 'ForwardAgent',
      confirmDelete: 'Remove this server configuration?',
      loading: 'Loading…',
      error: 'Operation failed',
      saved: 'Saved',
      noPrompt: 'No global prompt yet.',
      sshConfigPath: 'SSH config path',
      emptyEnvironment: 'No environment notes',
      addTitle: 'Add server',
      editTitle: 'Edit server',
      wslOnly: 'WSL targets use the default distro user. Configure that user inside WSL if needed.'
    }

    const S = {
      page: { maxWidth: 920, padding: '4px 0 40px', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 },
      title: { margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 650 },
      intro: { margin: '7px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6, maxWidth: 680 },
      section: { marginTop: 22 },
      sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
      sectionTitle: { margin: 0, fontSize: 14, fontWeight: 650 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, lineHeight: 1.55 },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 12 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: 14, minWidth: 0 },
      cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
      cardTitle: { fontSize: 14, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardId: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, marginTop: 3, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      badge: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)', padding: '2px 7px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      row: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 8, marginTop: 8, fontSize: 12.5, lineHeight: 1.45 },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)' },
      rowValue: { minWidth: 0, overflowWrap: 'anywhere' },
      env: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 9, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, lineHeight: 1.6, maxHeight: 120, overflow: 'auto' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
      button: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', font: 'inherit' },
      primary: { border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', font: 'inherit' },
      danger: { border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', borderRadius: 7, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', font: 'inherit' },
      linkButton: { border: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary)', padding: 0, fontSize: 12.5, cursor: 'pointer', font: 'inherit' },
      input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', borderRadius: 7, padding: '7px 9px', fontSize: 13, font: 'inherit' },
      textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', borderRadius: 7, padding: '8px 9px', fontSize: 13, lineHeight: 1.55, font: 'inherit', resize: 'vertical' },
      label: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 4 },
      field: { marginTop: 10 },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      form: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: 14, marginTop: 12 },
      formHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
      notice: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: '9px 11px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      error: { border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'transparent', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 10 },
      success: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12.5 },
      aliasList: { display: 'flex', flexDirection: 'column', gap: 1, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, overflow: 'hidden' },
      aliasRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: 'var(--dsw-alias-bg-layer-1)', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      aliasMain: { flex: '1 1 auto', minWidth: 0 },
      aliasName: { fontSize: 13, fontWeight: 600 },
      aliasMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, lineHeight: 1.7, padding: '12px 0' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, overflowWrap: 'anywhere' }
    }

    function endpointText(target) {
      const auth = target.auth || {}
      const host = auth.hostName || target.host || ''
      const user = auth.user || target.user || ''
      const port = auth.port || target.port || ''
      if (target.transport === 'wsl') return target.distro || 'WSL'
      return `${user ? user + '@' : ''}${host}${port ? ':' + port : ''}`
    }

    function authText(target) {
      if (target.transport === 'wsl') return 'WSL'
      const kind = target.auth?.kind
      if (kind === 'key') return target.auth.identityFile || 'SSH key'
      if (kind === 'ssh-config') return target.auth.identityFile || 'SSH config'
      return 'SSH key / agent'
    }

    async function api(path, init) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-dsh-remote-ui': '1',
          ...(init && init.headers ? init.headers : {})
        }
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function Field({ label, children }) {
      return h('label', { style: S.field }, h('span', { style: S.label, children: label }), children)
    }

    function RemoteServers({ t }) {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [draft, setDraft] = useState(null)
      const [editingId, setEditingId] = useState(null)
      const [prompt, setPrompt] = useState('')
      const [promptDirty, setPromptDirty] = useState(false)
      const promptDirtyRef = useRef(false)
      const [probes, setProbes] = useState({})

      const refresh = useCallback(async (retry = 0) => {
        try {
          const data = await api('/plugins/dsh-remote-suite/state')
          setState(data.state)
          if (!promptDirtyRef.current) setPrompt(data.state.prompt || '')
          setError('')
          setLoading(false)
        } catch (e) {
          if (retry < 4) {
            window.setTimeout(() => { void refresh(retry + 1) }, 350)
            return
          }
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const targets = state?.targets || []
      const aliases = state?.aliases || []

      const beginAdd = () => {
        setEditingId(null)
        setError('')
        setNotice('')
        setDraft({
          id: '',
          label: '',
          transport: 'ssh',
          host: '',
          user: '',
          port: '',
          identityFile: '',
          defaultCwd: '~',
          distro: '',
          environment: ''
        })
      }

      const beginEdit = (target) => {
        setEditingId(target.id)
        setError('')
        setNotice('')
        setDraft({
          id: target.id,
          label: target.label || '',
          transport: target.transport,
          host: target.host || '',
          user: target.user || '',
          port: target.port ? String(target.port) : '',
          identityFile: target.identityFile || '',
          defaultCwd: target.defaultCwd || '~',
          distro: target.distro || '',
          environment: target.environment || ''
        })
      }

      const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const saveDraft = async (event) => {
        event.preventDefault()
        if (!draft) return
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const target = {
            id: draft.id.trim(),
            label: draft.label.trim() || draft.id.trim(),
            transport: draft.transport,
            defaultCwd: draft.defaultCwd.trim() || '~'
          }
          if (draft.transport === 'ssh') {
            if (!draft.host.trim()) throw new Error('host is required')
            target.host = draft.host.trim()
            if (draft.user.trim()) target.user = draft.user.trim()
            if (draft.port.trim()) target.port = Number(draft.port)
            if (draft.identityFile.trim()) target.identityFile = draft.identityFile.trim()
          } else {
            if (draft.distro.trim()) target.distro = draft.distro.trim()
          }
          if (draft.environment.trim()) target.environment = draft.environment
          const data = await api('/plugins/dsh-remote-suite/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'saveTarget', target })
          })
          setDraft(null)
          setEditingId(null)
          setNotice(t('saved'))
          await refresh()
          return data
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const removeTarget = async (id) => {
        if (!window.confirm(t('confirmDelete'))) return
        setBusy('remove:' + id)
        setError('')
        try {
          await api('/plugins/dsh-remote-suite/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'removeTarget', id })
          })
          setNotice(t('saved'))
          await refresh()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const probe = async (id) => {
        setBusy('probe:' + id)
        setProbes((current) => ({ ...current, [id]: { pending: true } }))
        try {
          const data = await api('/plugins/dsh-remote-suite/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'probe', targetId: id })
          })
          setProbes((current) => ({ ...current, [id]: data.result.probe }))
        } catch (e) {
          setProbes((current) => ({ ...current, [id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
        } finally {
          setBusy('')
        }
      }

      const savePrompt = async () => {
        setBusy('prompt')
        setError('')
        try {
          await api('/plugins/dsh-remote-suite/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'setPrompt', prompt })
          })
          setPromptDirty(false)
          promptDirtyRef.current = false
          setNotice(t('saved'))
          await refresh()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      const importAlias = async (alias) => {
        setBusy('alias:' + alias)
        setError('')
        try {
          await api('/plugins/dsh-remote-suite/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'importAlias', alias })
          })
          setNotice(t('saved'))
          await refresh()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy('')
        }
      }

      if (loading) return h('div', { style: S.page }, h('p', { style: S.muted, children: t('loading') }))

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', {},
            h('h2', { style: S.title, children: t('title') }),
            h('p', { style: S.intro, children: t('intro') })
          ),
          h('button', { type: 'button', style: S.button, onClick: () => { setPromptDirty(false); void refresh() }, disabled: busy === 'refresh', children: t('refresh') })
        ),
        error ? h('div', { style: S.error, children: error }) : null,
        notice ? h('div', { style: S.success, children: notice }) : null,

        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('h3', { style: S.sectionTitle, children: t('targets') }),
            h('button', { type: 'button', style: S.primary, onClick: beginAdd, children: t('add') })
          ),
          targets.length === 0 && !draft ? h('div', { style: S.empty, children: t('noTargets') }) : null,
          h('div', { style: S.cards },
            targets.map((target) => h('div', { key: target.id, style: S.card },
              h('div', { style: S.cardHead },
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: S.cardTitle, title: target.label, children: target.label }),
                  h('div', { style: S.cardId, children: `${target.id} · ${target.transport}` })
                ),
                h('span', { style: S.badge, children: target.transport === 'wsl' ? 'WSL' : 'SSH' })
              ),
              h('div', { style: S.row }, h('span', { style: S.rowLabel, children: t('account') }), h('span', { style: S.rowValue, children: target.auth?.user || '—' })),
              h('div', { style: S.row }, h('span', { style: S.rowLabel, children: 'Endpoint' }), h('span', { style: S.rowValue, children: endpointText(target) })),
              h('div', { style: S.row }, h('span', { style: S.rowLabel, children: t('auth') }), h('span', { style: S.rowValue, children: authText(target) })),
              h('div', { style: S.row }, h('span', { style: S.rowLabel, children: t('defaultCwd') }), h('span', { style: S.rowValue, children: target.defaultCwd || '~' })),
              probes[target.id]?.pending ? h('div', { style: S.muted, children: t('testing') }) : null,
              probes[target.id] && !probes[target.id].pending ? h('div', {
                style: probes[target.id].ok ? S.success : S.error,
                children: probes[target.id].ok
                  ? `${t('reachable')} · ${probes[target.id].latencyMs} ms${probes[target.id].detail ? ' · ' + probes[target.id].detail : ''}`
                  : `${t('unreachable')} · ${probes[target.id].error || ''}`
              }) : null,
              target.environment ? h('div', { style: S.env, children: target.environment }) : h('div', { style: S.env, children: t('emptyEnvironment') }),
              h('div', { style: S.actions },
                h('button', { type: 'button', style: S.button, onClick: () => void probe(target.id), disabled: busy === 'probe:' + target.id, children: busy === 'probe:' + target.id ? t('testing') : t('test') }),
                h('button', { type: 'button', style: S.button, onClick: () => beginEdit(target), children: t('edit') }),
                h('button', { type: 'button', style: S.danger, onClick: () => void removeTarget(target.id), disabled: busy === 'remove:' + target.id, children: t('remove') })
              )
            ))
          )
        ),

        draft ? h('form', { style: S.form, onSubmit: saveDraft },
          h('div', { style: S.formHead },
            h('h3', { style: S.sectionTitle, children: editingId ? t('editTitle') : t('addTitle') }),
            h('button', { type: 'button', style: S.linkButton, onClick: () => { setDraft(null); setEditingId(null) }, children: t('cancel') })
          ),
          h('div', { style: S.grid2 },
            h(Field, { label: t('id') }, h('input', { style: S.input, value: draft.id, disabled: Boolean(editingId), onChange: (e) => patchDraft({ id: e.target.value }), placeholder: 'myserver' })),
            h(Field, { label: t('label') }, h('input', { style: S.input, value: draft.label, onChange: (e) => patchDraft({ label: e.target.value }), placeholder: 'Example server' })),
            h(Field, { label: t('transport') }, h('select', { style: S.input, value: draft.transport, onChange: (e) => patchDraft({ transport: e.target.value }) },
              h('option', { value: 'ssh', children: 'SSH' }),
              h('option', { value: 'wsl', children: 'WSL' })
            )),
            h(Field, { label: t('defaultCwd') }, h('input', { style: S.input, value: draft.defaultCwd, onChange: (e) => patchDraft({ defaultCwd: e.target.value }), placeholder: '~' }))
          ),
          draft.transport === 'ssh' ? h('div', {},
            h('div', { style: S.grid2 },
              h(Field, { label: t('host') }, h('input', { style: S.input, value: draft.host, onChange: (e) => patchDraft({ host: e.target.value }), placeholder: 'server.example.edu' })),
              h(Field, { label: t('user') }, h('input', { style: S.input, value: draft.user, onChange: (e) => patchDraft({ user: e.target.value }), placeholder: 'Username' })),
              h(Field, { label: t('port') }, h('input', { style: S.input, value: draft.port, onChange: (e) => patchDraft({ port: e.target.value }), placeholder: '22' })),
              h(Field, { label: t('identityFile') }, h('input', { style: S.input, value: draft.identityFile, onChange: (e) => patchDraft({ identityFile: e.target.value }), placeholder: 'C:\\Users\\Username\\.ssh\\id_ed25519' }))
            ),
            h('p', { style: S.muted, children: t('hostHint') })
          ) : h('div', {},
            h(Field, { label: t('distro') }, h('input', { style: S.input, value: draft.distro, onChange: (e) => patchDraft({ distro: e.target.value }), placeholder: 'Ubuntu' })),
            h('p', { style: S.muted, children: t('wslOnly') })
          ),
          h(Field, { label: t('environment') }, h('textarea', { rows: 5, style: S.textarea, value: draft.environment, onChange: (e) => patchDraft({ environment: e.target.value }), placeholder: t('environmentHint') })),
          h('p', { style: S.muted, children: t('passwordNote') }),
          h('div', { style: S.actions },
            h('button', { type: 'submit', style: S.primary, disabled: busy === 'save', children: busy === 'save' ? t('saving') : t('save') }),
            h('button', { type: 'button', style: S.button, onClick: () => { setDraft(null); setEditingId(null) }, children: t('cancel') })
          )
        ) : null,

        h('div', { style: S.section },
          h('div', { style: S.sectionHead }, h('h3', { style: S.sectionTitle, children: t('prompt') })),
          h('textarea', { rows: 3, style: S.textarea, value: prompt, placeholder: t('promptHint'), onChange: (e) => { promptDirtyRef.current = true; setPrompt(e.target.value); setPromptDirty(true) } }),
          h('div', { style: S.actions },
            h('button', { type: 'button', style: S.primary, onClick: () => void savePrompt(), disabled: busy === 'prompt' || !promptDirty, children: busy === 'prompt' ? t('saving') : t('savePrompt') }),
            !promptDirty && !prompt.trim() ? h('span', { style: S.muted, children: t('noPrompt') }) : null
          )
        ),

        h('div', { style: S.section },
          h('div', { style: S.sectionHead },
            h('div', {},
              h('h3', { style: S.sectionTitle, children: t('aliases') }),
              h('div', { style: { ...S.muted, marginTop: 4, ...S.code }, children: state?.sshConfigPath || '~/.ssh/config' })
            )
          ),
          aliases.length === 0 ? h('div', { style: S.empty, children: t('noAliases') }) : h('div', { style: S.aliasList },
            aliases.map((alias) => h('div', { key: alias.alias, style: S.aliasRow },
              h('div', { style: S.aliasMain },
                h('div', { style: S.aliasName, children: alias.alias }),
                h('div', { style: S.aliasMeta, children: [alias.user, alias.hostName, alias.port].filter(Boolean).join(' · ') || alias.alias })
              ),
              alias.configured
                ? h('span', { style: S.badge, children: t('configured') })
                : h('button', { type: 'button', style: S.button, disabled: busy === 'alias:' + alias.alias, onClick: () => void importAlias(alias.alias), children: busy === 'alias:' + alias.alias ? t('saving') : t('addAlias') })
            ))
          )
        ),

        h('div', { style: { ...S.notice, marginTop: 22 } },
          h('strong', { children: t('passwordUnsupported') }),
          h('div', { style: { marginTop: 4 }, children: t('passwordNote') })
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-suite: locale')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'dsh-remote-suite', order: 35, label: () => t('nav'), inject: () => ({ t }) },
            RemoteServers
          )
        })
      }
    }
  }
})
