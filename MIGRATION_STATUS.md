# DeckOps 迁移实施记录

更新：2026-09-05。**当前是已验证的源码候选，不是已发布/已切换状态。**

## 已完成

- 本仓分支 `codex/standalone-deckops-migration`，基线 `6092eaf12964dbfb08127e1e1a8d0a4e457d65cd`。M1 提交 `761fa08` 在 DeckParse 原名下完成云客户端内聚、类型/测试迁入及旧依赖清理。
- `src/cloud/` 由本产品拥有；无旧 SDK、DeckTools SDK/CLI、共享客户端包、构建时复制或相邻仓库依赖。普通 HTTP 库直接声明。来源、原 patch hash 和明确的 Node 行为差异见 [源码说明](src/cloud/README.md)。原 patch 从工作树删除，可从 Git 基线恢复。
- 本仓源码改为 `@deckflow/deckops@1.0.0`，唯一 binary 为 `deckops`；公开错误类改为 `DeckOpsError`，无旧名 alias。
- 保留 DeckIR/schema、manifest v1/v2、parser identity、`producer.deckparse` 和共享 UUID。
- 新增独立产品默认配置和显式 `config migrate [--dry-run]`；只补缺失有效字段，保留旧文件、目标值和 UUID，正常运行不回退旧产品路径。尚未对用户真实配置执行迁移。
- 旧仓库在 `codex/decktools-migration` 准备 `decktools@1.0.0`、`@deckflow/decktools-sdk@1.0.0`、Go/Python import/module、installer、发布配置及产品环境变量改名。它的实际基线是 `master` 上的 `4a5f70677d6cb7cd5e95ee6a89a88adf942687b0`；不要合入无关历史的 `origin/main`。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| 本仓 `pnpm check` | 189 个测试通过；Node/DOM-only 类型、构建、Browser SSR/独立消费者检查通过 |
| 独立安装/构建 | M1 的 Git archive 副本 frozen install + check 通过；只额外带入本产品的四个文档测试样本，没有兄弟仓库源码 |
| 新名包体积/安装验证 | `check:package` 通过：tarball 约 0.94 MiB；strict 安装约 43.92 MiB，默认约 72.77 MiB；包内 Worker/WASM 随包交付 |
| Browser 体积 | 35,148 bytes gzip，基线 35,715；实际浏览器交互 smoke 尚未完成（浏览器附加失败），不能据 mock/构建代替验收 |
| 旧 artifact | 用 M1 CLI 生成的 DOCX artifact 在改名 CLI 中命中 `artifact-cache`，本地 convert 复用 parse、`taskId:null` |
| DeckTools TypeScript/Node CLI | 完整 release check 通过：SDK 82、CLI 49 个测试 |
| DeckTools Go/Python | Go SDK 与 CLI 测试通过；Python 26 个测试通过 |
| 消费者预检 | 临时副本中 deckhtml、hyperdeck/deckhtml 编译通过；DeckRender Node/Browser 类型、90 个集成测试、构建和 Browser consumer 检查通过 |
| 真实云端 conformance | 未执行；需要测试凭据和专用测试操作，不以 mock 通过代替 |

消费者预检使用本地候选 SDK tarball 与临时目录，不代表 registry 安装和 lockfile 已验收。三个实际消费者仓库尚未修改。DeckRender 全量单测也未完成：旧 SDK 0.7.3 Browser 源码改写脚本及其单测需在正式切换时删除/替换，Browser 构建应解析正式 `@deckflow/decktools-sdk/browser` 入口；旧工具配置 fallback 和诊断提示也需清理，避免把新 DeckOps 当作旧 SDK。

## 当前阻塞和未做的外部操作

`npm whoami --registry=https://registry.npmjs.org/` 返回 E401，当前无法验证新包发布权限或发布。尚未发布 npm/Python/Go release、push/合并迁移分支、改 GitHub 仓库名、移动本地目录、改真实消费者及其 lockfile、调整全局 CLI 或用户配置。旧工作环境继续保留。

## 恢复实施顺序

1. 用户完成 npm 登录，并确认对 `@deckflow/decktools-sdk`、`decktools`、`@deckflow/deckops` 的发布权限；发布前重新核验名称及 1.0.0 是否可用。候选已设置 1.0.0，首次发布不要直接运行会额外 bump 的聚合 `release` 命令。
2. 补实际浏览器 smoke；有云端测试凭据时补 conformance，否则明确保留该验收限制。review 并合并本地源码候选至各仓库正确默认分支。
3. 旧仓库先改为 `deckflow/decktools`，更新 remote；按 SDK → CLI 顺序发布新包，验证空目录真实安装。Go/Python 按对应发布通道验证权限并发行；不要把源码改名等同于已发布。
4. 旧本地目录再移至 `/Volumes/workspace/caixuan/decktools`。在实际内部消费者直接更新依赖/import、处理 DeckRender Browser 适配与相关配置引用，生成新 lockfile，frozen install + 完整检查，再切换安装/部署。Hyperdeck 内的 deckhtml 本地分支落后远端，先重新核对并保留它的工作状态。
5. 检查并让出旧全局 `deckops` 命令，旧工具环境变量改为 `DECKTOOLS_*`。把 `deckflow/deckparse` 改为 `deckflow/deckops`，更新本仓 remote，发布并安装 `@deckflow/deckops`，核对 `command -v deckops` 和版本。
6. 更新本产品消费者 import / `DECKPARSE_*` 环境变量，先 dry-run 再执行一次性配置迁移，确认共享凭据/UUID 未变。最后将当前本地目录移至已释放的 `/Volumes/workspace/caixuan/deckops`，更新工作环境路径。

两个产品可独立 review/发布；不添加转发包、双命令、共享 SDK 或跨产品构建依赖。失败时回退源码提交/部署版本，原配置文件保持不动；已发布版本用修复版前进。
