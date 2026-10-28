# dsh-remote

[![CI](https://github.com/Char0nChengg/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/Char0nChengg/dsh-remote/actions/workflows/ci.yml)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）在 Windows 上直接操作 WSL 发行版或远端 SSH 服务器：执行命令、读取/写入文件、上传下载，并为每个服务器预置 `module`、Conda、Slurm/PBS 等环境提示。

**服务器不需要安装 Agent、桥接程序，也不需要主动连接外网。** 连接始终由 Windows 本机的 `ssh.exe` / `scp.exe` / `wsl.exe` 发起；服务器只需要已有的 SSH 服务（WSL 目标则完全本地）。

## 环境要求

- Windows 上的 DSH Desktop / Web Profile；
- Windows 自带 OpenSSH Client（`ssh.exe`、`scp.exe`），或自行配置 `sshPath` / `scpPath`；
- 可选：WSL 2 和至少一个发行版；
- SSH 目标：Linux + `sshd` + GNU coreutils（`bash`、`stat`、`find`、`head`、`tail`、`timeout`）；
- 认证：SSH key 或 ssh-agent。插件不读取、不保存密码，`BatchMode=yes` 禁止交互式密码提示。

## 安装

### 从 GitHub 安装

```powershell
git clone https://github.com/Char0nChengg/dsh-remote.git D:\dsh-remote
```

然后在 DSH 里让 Agent 安装这个本地 bundle：

```text
plugin_manager install_bundle({ target: "D:\\dsh-remote" })
```

安装后插件会出现在 **设置 → 插件**，名称为 **远程终端与文件 / Remote Shell & Files**。bundle 默认带一个 WSL 目标 `wsl-ubuntu`，没有 WSL 时可以删掉，直接使用 SSH 目标或临时目标。

### npm

包名预留为 `@char0nchengg/dsh-remote`。发布到 npm 后可以用 DSH 的插件安装器直接安装；目前推荐 GitHub 安装。

## 快速使用

不需要记工具名，直接在聊天里说：

```text
列出 myserver 上 ~/project 的文件
读一下 myserver 上 ~/project/run.log 最后 100 行
把 myserver 上的 submit.sh 下载到 D:\results
在 myserver 的 ~/project 下提交 sbatch submit.sh
在 WSL Ubuntu 里看一下当前目录
```

如果服务器已经在 `~/.ssh/config` 里有别名，可以直接用 `ssh:<别名>`，不需要改插件配置：

```sshconfig
Host myserver
  HostName server.example.edu
  User Username
  IdentityFile C:\Users\Username\.ssh\id_ed25519
  IdentitiesOnly yes
```

```text
remote_targets({ "check": true })
remote_exec({ "target": "ssh:myserver", "command": "hostname; pwd" })
```

`remote_targets` 会列出已配置目标和 `~/.ssh/config` 里的 Host 别名（不会主动连接它们）。

## 配置服务器与环境提示

配置服务器有两种方式：**直接在聊天里用 `remote_config` 改**，或者手动编辑 profile 的 `cordis.patch.yml`。

### 在 DSH 里直接改（推荐）

`remote_config` 会把修改写入当前 profile 的 patch，并通过 Loader 立即生效，通常不需要重启 DSH：

```text
看看远程插件的配置
把 wsl-ubuntu 的环境说明改成：默认用户，已装 conda
给 myserver 加上环境：module load intel/2022；conda activate example-env
把 myserver 的 conda 环境改成 example-env-v2
删除 myserver 这个目标
把全局远程提示改成：登录节点不要跑重计算，优先 sbatch
```

对应操作：

| 你说的话 | 实际动作 |
|---|---|
| 看看配置 | `remote_config({ action: "show" })` |
| 改某个服务器的环境说明 | `set_environment`，只改 `environment`，不影响其他字段 |
| 新增/整体替换服务器 | `upsert_target`，传入完整 target |
| 删除服务器 | `remove_target` |
| 改全局提示 | `set_prompt` |

`set_environment` 适合只改 module/conda/Slurm 说明；新增服务器时 `upsert_target` 需要完整字段（`id`、`transport`，SSH 还需要 `host` 等）。改完会立即更新系统提示，下一次请求就能看到新的环境说明。

### 手动编辑 YAML

在 profile 的 `cordis.patch.yml` 追加/覆盖 `dsh-remote` 这一行。`config` 会整体替换，所以需要把想保留的 WSL 目标一起写上。完整示例见 [`targets.example.yml`](targets.example.yml)。

```yaml
- id: dsh-remote
  name: '@char0nchengg/dsh-remote'
  config:
    # 可选：所有目标共享的使用习惯
    prompt: |
      不要在登录节点跑重计算；优先用 sbatch 提交。
      读日志优先用 remote_read 的 tail/range，不要整文件 cat。
    targets:
      - id: wsl-ubuntu
        label: WSL Ubuntu
        transport: wsl
        distro: Ubuntu
        defaultCwd: "~"
        environment: |
          Local WSL distro; no sshd required. Use the distro's default user.
      - id: myserver
        label: 示例登录节点
        transport: ssh
        host: myserver                # 复用 ~/.ssh/config 的 Host 别名
        defaultCwd: /home/Username/project
        environment: |
          - Slurm 登录节点，批处理分区常用 `fat`，示例脚本 32 核。
          - `module load intel/2022 netcdf/4.7.4`
          - Conda：`conda activate example-env`。
          - 项目数据在 `/home/Username/project`，临时目录在 `/scratch/$USER`。
          - 不要在登录节点跑长时间计算；用 `sbatch` 提交后读 `.out` / `.err`。
```

`environment` 也可以写成字符串数组：

```yaml
environment:
  - "module load intel/2022 netcdf/4.7.4"
  - "conda activate example-env"
```

### 预加载提示词是怎么工作的

当配置里存在 `prompt` 或任一 `targets[].environment` 时，插件会在 **system prompt** 中注册一段 `dsh-remote:targets` 上下文。模型在每次请求开始前就能看到这些环境说明，不必先调用 `remote_targets`。

- 只注入配置里的文字，**不会自动执行** `module load`、`conda activate` 或任何命令；
- 它只是提示，环境变化后模型仍应用 `remote_exec` 验证；
- 每个目标的 `environment` 最多 4000 字符，整段提示最多 6000 字符；
- `remote_targets` 也会显示同样的环境说明，方便核对；
- 不要把密码、token、私钥内容写进 `environment`，它会进入模型上下文和会话记录。

## 工具

| 工具 | 作用 |
|---|---|
| `remote_targets` | 列出已配置目标、SSH config 别名、环境提示，可选连通性检查 |
| `remote_exec` | 在目标上以 `bash -lc` 执行命令，返回退出码、stdout/stderr（有界） |
| `remote_read` | 读取远端文本文件；总是返回大小、mtime、权限、属主；大文件只给预览，支持 `head`/`tail`/`range` 字节窗口 |
| `remote_list` | 列目录，返回类型、大小、mtime、权限、符号链接目标 |
| `remote_write` | 原子写入 UTF-8 文件（临时文件 + rename），可设 `mode=755` 提交脚本 |
| `remote_transfer` | Windows 与目标之间上传/下载；SSH 支持目录递归，WSL 仅文件 |
| `remote_config` | 在 DSH 聊天里查看/修改目标、环境说明和全局 prompt，自动保存到 profile patch 并立即生效 |

所有工具都接受临时目标：

- `ssh:myserver`：使用 `~/.ssh/config` 的 `Host myserver`，或直接主机名；
- `ssh://Username@server.example.edu:2222`；
- `wsl:Ubuntu`（或 `wsl:` 使用默认发行版）。

大文件/二进制文件不要直接 `cat`：`remote_read` 的 `auto` 模式对超过 2 MiB 的文件只返回元数据和 4 KiB 预览；需要完整数据时用 `remote_transfer` 下载，或 `remote_exec` 调用 `ncdump -h`、`h5dump -H` 等领域工具看参数。

## 配置字段

| 字段 | 说明 |
|---|---|
| `prompt` | 可选，所有目标共享的预加载说明 |
| `targets[].id` | 工具里使用的目标 id，唯一 |
| `targets[].label` | 显示名称 |
| `targets[].transport` | `ssh` 或 `wsl` |
| `targets[].host` | SSH 主机名、IP 或 `~/.ssh/config` 别名 |
| `targets[].user` / `port` | 可选；不填则沿用 ssh config |
| `targets[].identityFile` | 私钥路径，支持 `~` |
| `targets[].proxyJump` | 可选，对应 `ssh -J` |
| `targets[].sshOptions` | 追加的 `-o` 选项数组 |
| `targets[].distro` | WSL 发行版名；省略表示默认发行版 |
| `targets[].defaultCwd` | 远端默认工作目录；`~` 或绝对路径 |
| `targets[].environment` | 该服务器的环境说明，字符串或字符串数组 |
| `strictHostKeyChecking` | `accept-new`（默认）/ `yes` / `no` / `ask` |
| `connectTimeoutSec` | SSH 连接超时，默认 10 秒 |
| `defaultTimeoutMs` | `remote_exec` 默认远端超时，默认 120000 |
| `transferTimeoutMs` | 单次上传/下载超时，默认 1800000（30 分钟） |
| `maxOutputBytes` | `remote_exec` 每路输出上限，默认 262144 |
| `defaultReadBytes` | `remote_read` 默认上限，默认 262144 |
| `largeFileBytes` / `previewBytes` | `auto` 模式的大文件阈值 / 预览字节数 |
| `sshPath` / `scpPath` / `wslPath` | 可选，覆盖本机客户端路径 |

## 安全模型

这是一个**高权限**插件：`remote_exec` 等价于远端 SSH 用户的 shell 权限，`remote_write` / `remote_transfer` 可以修改或覆盖远端文件，`remote_config` 会写当前 profile 的 `cordis.patch.yml` 并热应用配置。

- 只使用专用、最小权限的 SSH key；不要把密码写进配置或环境说明；
- `remote_config` 的写入目标是当前 DSH profile 的配置；只应在信任的会话里使用，改动前先 `action: "show"` 看一下当前配置；
- 默认 `StrictHostKeyChecking=accept-new`，首次连接记录指纹，之后指纹变化会拒绝；
- `BatchMode=yes` 禁止密码提示，避免密码进入进程参数或日志；
- 服务器只接受 Windows 的入站 SSH，不需要反向连接或外网访问；
- 如果你的 `~/.ssh/config` 开了 `ForwardAgent yes`，认证 agent 会被转发到服务器；不需要时在目标里加 `sshOptions: ["ForwardAgent=no"]`；
- `prompt` / `environment` 会进入模型上下文，不要放密钥、token 或隐私数据。

## 限制

- 只面向 Linux 远端（依赖 GNU `stat --printf`、`find -printf`、`head -c`/`tail -c`、`timeout`）。macOS/BSD 和 Windows OpenSSH 服务器未适配。
- SSH 文件传输使用本机 `scp` 的 SFTP 模式；服务器需要启用 SFTP 子系统（OpenSSH 默认启用）。
- WSL 的目录上传/下载未实现；需要时在 WSL 内用 `tar`，或通过 `remote_exec` 操作。
- `remote_write` 单次内容上限 8 MiB；更大的文件或二进制文件用 `remote_transfer`，脚本请使用 LF 换行。
- 不提供持久 shell、端口转发、反向隧道或远程 DSH Agent；长任务用 Slurm/PBS 或 `nohup`。
- 服务器必须能被 Windows 主动访问（VPN 或端口映射）。

## 发布到插件市场

仓库结构满足 [dsh.so](https://www.dsh.so/zh/submit/) 和 [DSH-Store](https://github.com/AI-Scarlett/DSH-Store) 的静态上架要求：

- 标准 DSH Bundle，`package.json` 声明 `dsh.bundle.patch`；
- 唯一入口 id `dsh-remote`，不覆盖任何 `@deepseek-ai/*` 官方组件；
- MIT 许可证、README、图标、en/zh locale；
- 没有 `preinstall` / `install` / `postinstall` / `prepare` 生命周期脚本；
- 无运行依赖、无原生构建；
- `dsh.compatibility.dshReleases` 精确声明已在 `0.2.1-rc.3` 上验证。

提交入口：

- dsh.so：<https://www.dsh.so/zh/submit/>
- DSH-Store：<https://github.com/AI-Scarlett/DSH-Store/issues/new?template=plugin-submission.yml>

插件会执行任意远端 Shell，属于高权限工具；提交时应在权限说明中明确文件、网络、命令访问范围。

## 开发与测试

```bash
npm test
npm run check
```

测试只覆盖本地纯函数、配置解析和假的 `configEditor`，不连接网络、不写真实 Profile：

- shell 引号转义；
- ad-hoc `ssh:` / `wsl:` 目标解析；
- `environment` / `prompt` 归一化与长度限制；
- 预加载提示词内容；
- `remote_config` 的 show / set_prompt / set_environment / upsert_target / remove_target 流程。

端到端验证记录：

- WSL Ubuntu：连通性检查、命令执行/非零退出/超时、含引号和 `$` 的路径写入与读取、目录列表、大文件预览、二进制识别、文件上传下载；
- 临时 WSL sshd：公钥认证、首次主机指纹、命令、文件读写、带空格路径、文件与目录 scp 传输，验证后已停止并移除；
- 开发阶段没有对公网第三方服务器做自动化测试；真实目标由使用者自行配置。

## License

MIT © 2026 Char0nChengg
