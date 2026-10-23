# carleft-skills

个人 Qoder 技能合集。

## 技能列表

| 技能 | 说明 |
|---|---|
| [macos-cleanup](macos-cleanup/) | macOS 清理规划与执行：只读扫描 → 分级计划 → 逐项确认 → 移入废纸篓并可回滚 |

## macos-cleanup

覆盖 18 个模块：缓存、浏览器、开发缓存、构建产物、系统垃圾、包管理器、应用、应用残留、后台服务、设备与模拟器、虚拟机与容器、下载安装包、废纸篓、系统快照、终端配置、系统 PATH、失效软链。

报告分两部分：**可清理项**（按模块，ID 形如 `DEV-01`、`PKG-01`）和**正常软件占用**（应用与包管理器清单，带体积、版本和 shell 调用记录）。后者只用于判断哪些软件奇怪或长期没用，不会被自动列入清理。

### 安装

项目级：

```bash
mkdir -p .qoder/skills
cp -R macos-cleanup .qoder/skills/
```

用户级（所有项目可用）：

```bash
mkdir -p ~/.qoder/skills
cp -R macos-cleanup ~/.qoder/skills/
```

### 使用

```bash
# 1. 只读规划
node ~/.qoder/skills/macos-cleanup/scripts/audit.mjs --out ~/Desktop/plan.json

# 2. 预演（默认不改动）
node ~/.qoder/skills/macos-cleanup/scripts/apply.mjs \
  --plan ~/Desktop/plan.json --approve DEV-01,PKG-01

# 3. 执行
node ~/.qoder/skills/macos-cleanup/scripts/apply.mjs \
  --plan ~/Desktop/plan.json --approve DEV-01,PKG-01 --execute
```

回滚：

```bash
node ~/.qoder/skills/macos-cleanup/scripts/apply.mjs \
  --undo "$HOME/Library/Application Support/macos-cleanup/manifests/<timestamp>.json"
```

### 安全边界

- 扫描阶段只读，不修改任何文件。
- 执行必须显式提供 `--approve` 和 `--execute`。
- 删除一律移入 `~/.Trash/macos-cleanup-<timestamp>/`，不使用 `rm`。
- rc 文件修改前备份，支持按清单回滚。
- 不使用 sudo；需要提权的项目只输出操作说明。
- 保护 `/System`、`/usr/bin`、`~/Documents`、`~/Desktop`、`~/.ssh` 等路径。

### 要求

macOS + Node 18+，无第三方依赖。Homebrew 可选，未安装时相关检查自动跳过。
