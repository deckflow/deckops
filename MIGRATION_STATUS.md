# DeckOps 架构迁移交付记录

更新：2026-09-07。源码、仓库、目录、npm 包、内部消费者和本机命令已切换。真实云端 conformance 尚未执行，不把 localhost fixture 验证等同于生产云端验收。

## 最终名称

| 对象 | 最终位置 / 发布名 |
| --- | --- |
| 原 DeckParse | deckflow/deckops；本地 /Volumes/workspace/caixuan/deckops；main |
| 解析 API / CLI | @deckflow/deckops@1.0.0；唯一命令 deckops |
| 原 DeckOps 工具仓库 | deckflow/decktools；本地 /Volumes/workspace/caixuan/decktools；原默认分支 master |
| 通用 SDK / CLI | @deckflow/decktools-sdk@1.0.0 / decktools@1.0.0；唯一命令 decktools |
| 实际内部消费者 | DeckRender 0.4.1、DeckHTML 0.6.5，固定新 SDK 1.0.0；hyperdeck/deckhtml 同步 main |

SDK scope 经用户确认使用现有 deckflow 组织。两个 GitHub 仓库保持各自 repository ID 和历史；旧工具仓库没有合入历史无关的 origin/main。

新 DeckOps 直接拥有 src/cloud 的实现、DTO 和测试，没有旧 SDK、DeckTools SDK/CLI、共享客户端包、兄弟仓库或构建时复制依赖。普通 HTTP/ZIP/XML 等社区库仍直接声明。来源与基线行为差异见 [cloud README](src/cloud/README.md)。

保留 deckir.v1、manifest v1/v2、parser identity（如 deckparse-pptx / deckparse-docx）、producer.deckparse 和共享 UUID。没有 CLI alias 或 npm 转发包；旧 registry 历史版本不删除。

## 实施与 review

- 761fa08：在 DeckParse 原名下内聚云客户端、类型和回归测试，解除旧 SDK / Browser patch 依赖。
- d0dd75a / 398f43e：新名称、产品配置、显式一次性迁移及最终 SDK scope 边界检查。
- 10131b7：修复干净 CI 缺少被忽略样本的问题，改用本仓确定性生成的合成 PDF/OOXML/IWA fixtures，不上传用户样本。
- DeckTools f23aee2 / 5f7280a：更名、发布与共享身份隔离；review 修复损坏配置 JSON 被覆盖的问题。
- DeckRender 99a7dad 起：真实依赖和 lockfile 切换，删除 Browser 源码改写桥，使用正式 /browser export，删除旧产品凭据 fallback。
- DeckHTML 0bfc001 / 5536ea6：真实依赖/import、registry、lockfile 和 CLI bin；hyperdeck 内副本 fast-forward 同步。
- DeckRender 0.4.0 曾发布旧 CLI 内嵌版本号的产物，已用 0.4.1 前进修复；5ed4bdb 增加 prepack 版本检查和强制重建。0.4.0 不是本次最终版本。
- Go CLI 与 SDK tag 同 commit 导致初次 Release 关联错误，已纠正为 go-cli/v1.0.0；b4111f6 固定后续发布使用触发 tag，没有重写 Git tags。

源码已合入各仓库原默认分支并 push。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 新 DeckOps pnpm check | 189 测试；Node / DOM-only 类型、Browser SSR、独立消费者、构建及依赖检查通过 |
| 独立 Git archive | frozen install + check + package-budget 通过，无兄弟仓库或额外用户样本 |
| CI | [Node 22.18 / 24 与 package-budget 全部通过](https://github.com/deckflow/deckops/actions/runs/34078770208) |
| 包预算 | tarball 0.94 MiB；strict 43.92 MiB；默认 72.77 MiB；独立验证冷启动 P95 70 ms、PDF RSS 161.80 MiB |
| 实际浏览器 | 新 DeckOps 16/16、DeckRender 21/21；双 localhost origin，覆盖 Worker/WASM、CORS、上传、SSE/polling、刷新、取消及超时 |
| Browser gzip | 新 DeckOps 35,148 bytes，DeckRender 43,928 bytes |
| 旧 artifact | M1 DOCX artifact 在新 CLI 中命中 artifact-cache，离线 convert，taskId 为 null |
| npm 安装运行 | DeckOps / DeckTools / DeckHTML / DeckRender 正式 registry 包安装与版本检查通过；新 DeckOps 严格预检本地 PDF 解析及 artifact convert 成功，taskId 为 null，convert reusedParse 为 true；已安装 DeckOps / DeckRender Browser SSR import 通过 |
| DeckTools | Node SDK 82 + CLI 51；Go SDK / CLI；Python 26 测试通过 |
| DeckRender | 239 单元、90 集成、32 CLI；[最终发布修复 CI 通过](https://github.com/deckflow/deckrender/actions/runs/34079164336) |
| DeckHTML | frozen install、build、CLI、139 单元测试；[CI 通过](https://github.com/deckflow/deckhtml/actions/runs/34078964388)；hyperdeck 内副本 frozen install + build 通过 |

PDF 降级质量告警仍按原策略返回，不因改名隐瞒结构解析局限。

## 配置与本机交接

- 共享 credentials / auth-uuid 位于 ~/.deckflow，仅跟随 DECKFLOW_CONFIG_DIR；Browser 保留 localStorage["df_uuid"]。
- 产品配置分别为 ~/.deckflow/deckops/config.json 与 ~/.deckflow/decktools/config.json。产品目录覆盖不会迁移身份。
- 已执行真实 config migrate dry-run、迁移、再次 dry-run：只补缺失的 apiBase。逐字段检查原目标值、共享 UUID 和旧配置文件未变，第二次无变化；记录不包含凭据值。
- /Users/fei/.local/bin 下 deckops / decktools / deckhtml / deckrender 启动各自已安装的 npm CLI，固定本机 Node 24（不改全局 Node 默认值）；版本分别为 1.0.0 / 1.0.0 / 0.6.5 / 0.4.1。
- 原 deckops 软链接备份为 /Users/fei/.local/bin/deckops.legacy-20260907，原 PDF-CLI/.venv 未改动；备份只供人工恢复，不是新产品兼容入口。
- 本地目录已交接，无旧目录 alias。编辑器保存的旧 DeckParse / 旧 DeckOps 项目需关闭后按最终路径重新打开，避免旧任务落到另一个产品目录；当前工具没有修改已有任务 cwd 的接口。

## Go / Python 分发与未验收项

- Go SDK github.com/deckflow/decktools/sdks/go@v1.0.0：远端 go mod download 验证通过。
- [Go CLI v1.0.0](https://github.com/deckflow/decktools/releases/tag/go-cli/v1.0.0)：六个平台归档、checksums 与 installer 已发布；下载 macOS arm64 二进制版本验证通过。
- [Python SDK v1.0.0](https://github.com/deckflow/decktools/releases/tag/python-sdk/v1.0.0)：wheel / sdist 已发布；独立 venv 从 GitHub 安装 wheel、import 与版本检查通过。发行名 decktools-sdk、import decktools；尚未发布 PyPI，README 提供可用 wheel 地址。
- 真实云端 conformance 未执行，需要专用测试凭据和操作。mock / localhost 结果不代表生产 API、云端解析质量或生产 CORS 已验收。
- GitHub 报告 DeckTools 既有依赖安全告警（本次 push 时 83 项）；未混入大范围依赖升级，需另行 triage，不代表完成安全审计。

回退使用源提交、旧部署版本及保留的配置/CLI 备份；已发布版本用修复版前进，不 unpublish、不重写历史，不恢复跨产品依赖。
