# SateGraph

公开卫星目录与关系分析项目。后台使用 Cloudflare Workers、Durable Objects、D1 和私有服务绑定。Pages 可通过同源网关查询获准展示的资料；演示地球和本机导入的 OMM 与在线结果分开，不上传文件，也不能启动采集。

## 工程目录

| 目录 | 职责 |
| --- | --- |
| src/sg-pages | Pages：页面、轨道 Web Worker 和公开静态资源 |
| src/sg-api-gateway | Worker：同源 API 网关，负责会话验证与只读请求路由；无数据库、图或归档写凭据 |
| src/sg-data | Worker：CatalogReader 提供来源受限的目录和证据查询；FactCommands 委托 FactCommand DO 复核并提交 GP 分片 |
| src/sg-sync | Worker：唯一 Cron、协调器、采集与归档；storage/ 管理轨道写入和 D1 迁移 |
| src/sg-projector | Worker：内部投影 RPC、顺序提交与图端对账；独占图写凭据 |
| src/sg-graph | Worker：GraphReader 通过固定只读模板读取已有场景、成员、信息关系并做限定拓扑分析；不生产场景 |
| src/sg-assistant | Worker：AssistantReader 在单个请求内调用获批模型及命名只读入口，无持久会话和写绑定 |
| scripts/validation | 离线及隔离环境验证工具，不是部署服务 |
| infra/terraform | 独立 Cloudflare 资源及模拟计划测试 |
| scripts、tests | 构建、预览、配置生成与离线回归 |

## 本地开发

src/ 的每个直接子目录对应一个服务。每个 Worker 的入口 index.ts 和绑定模板 wrangler.template.jsonc 同目录；新增私有模块放回所属服务。Pages 的浏览器 Web Worker 是页面资源，不单独部署。

使用 Node.js 24 和锁定的依赖。运行 npm ci 后，npm start 在回环地址启动基于 Miniflare 的静态预览；PORT 可覆盖默认端口 8765。npm run build:pages 把可发布的公开资源输出到打印的新目录，不复制工作区、账号信息或本地快照。

Pages 的一方脚本位于 `src/sg-pages`，使用 TypeScript；图层和目录行由 React 组件绘制，轨道传播在独立 Web Worker 内执行。修改后运行 `npm run typecheck:pages` 检查浏览器和 Worker 两个环境，运行 `npm run build:pages` 生成静态 HTML、CSS、两个浏览器 JS 入口和公开资源。预览不需要外部 CDN；在线查询仍需同源网关。本地 OMM 不上传，工作台状态不自动保存。

- npm run typecheck：校验 Workers 和验证程序。
- npm test：运行本地测试；D1 和 Durable Objects 测试使用临时实例，外部写入使用模拟适配器。
- 运行 `npm run format` 修正一方源码，`npm run style:check` 只检查、不写文件；CI 执行同一检查。JS/TS 使用根目录 `.clang-format` 的 Google 预设，ESLint 检查控制语句花括号、变量声明及 const/let；TSX、HTML 和 CSS 使用支持这些语法的 Prettier。CSS 只在构建产物中压缩。范围限于一方代码，不包含依赖和构建产物。

## 资源与部署边界

Terraform 只管理本项目声明的 D1 与 Turnstile。既有私有 B2 桶、Neo4j 端点和数据库名通过 existing_services 输入引用，不创建、不导入、不销毁。Workers、Pages、Worker 绑定、DO 迁移及 Cron 由 Wrangler 管理。

唯一真实环境是 `prd`。Terraform 和 Wrangler 配置生成器都拒绝其他环境。云资源统一命名为 `sategraph-prd-{服务名或模块名}`，例如 `sategraph-prd-api-gateway`。只有从 `main` 手动触发的生产作业可以访问生产 state 或发布；其他分支和 PR 只使用模拟数据或临时本地实例，不创建云资源。

以下为生产流程中的只读导出与配置生成示例，不会执行部署。仅在获准访问生产 state 的 `main` 任务中使用；离线验证使用模拟绑定。已有图的 GRAPH_INSTANCE 必须与 GraphControl.instance_id 一致。首次启用专用空图时，先独立核对 Aura 地址、数据库和本次分配的固定实例标识，不得按猜测初始化。

    terraform -chdir=infra/terraform output -json bindings | GRAPH_INSTANCE='<已核验的图实例标识>' npm run config:workers

结果位于 `dist/config/prd/`。真实发布只使用该目录的生成配置，不直接部署源码模板。以下 6 个运行时密钥只在 Cloudflare 对应 Worker 配置：`sync` 用 `B2_KEY_ID`、`B2_APP_KEY`；`projector` 用 `GRAPH_AUTH`；`graph` 用独立的只读 `GRAPH_READ_AUTH`；`api-gateway` 用 `TURNSTILE_SECRET`、`SESSION_KEYS`。它们不是 GitHub Secrets，不得放入 tfvars、Terraform 输出、Pages 构建或版本库。数据库迁移目录已写入生成配置；创建资源、应用迁移和发布都需单独授权。

配置生成命令输出六个 Worker 的 JSON 和独立的 pages.json；后者只指向本次新建的静态构建目录，没有服务绑定或机密。发布前须在获准使用的域名上验证同源分流：静态页面由 Pages 提供，/api/v1/ 请求交给对应环境的网关（生产为 `sategraph-prd-api-gateway`，配置文件为 api-gateway.json）。本地配置检查不代表域名、路由或远端资源已经生效。

## GitHub Actions 流水线

| 流水线 | 触发方式 | 执行内容 |
| --- | --- | --- |
| CI | 任意分支 push、PR 或手动运行 | Node.js 24 安装锁定依赖，执行类型检查、测试和 Pages 构建；不读取生产凭据。 |
| Terraform | 基础设施或流程文件变更时自动检查；也可手动运行 | 所有分支运行格式检查、验证和模拟计划。只有在 `main` 手动运行才访问生产 state；默认 `plan`，显式选择 `apply` 才应用本次生成的计划。 |
| Deploy | 在 Actions 中选择 `Deploy → Run workflow → main` | 先对同一提交运行 CI，通过后从生产 state 读取绑定，发布六个 Worker，最后发布 Pages。其他分支和标签不部署。 |

**生产启用前**

1. 在仓库 Settings → Environments 使用受保护的 `production` 环境，将部署规则设为仅允许名称为 `main` 的分支（不要添加标签规则）；保护 `main`，按团队要求设置审批。以下变量和密钥只放在该环境，不放在仓库级。GitHub 环境名称保持不变；生产云资源使用 `prd`。
2. 准备保存 Terraform state 的私有 Backblaze B2 桶。Terraform 和 Deploy 共用一对读写密钥，请将其权限限定到生产 state 桶。Deploy 只读取 state，但使用的密钥也有写权限。已有生产环境先核实桶名、区域和对象键；若仍在旧后端，须经授权迁移并核对现有资源后再切换。**不要把新空 state 指向已有生产资源**。流水线不会自动迁移 state。
3. 准备 Direct Upload Pages 项目 `sategraph-prd-pages`，生产分支设为 `main`；配置同源域名路由和 Worker 运行时密钥。Deploy 不创建 Pages 项目、不配置 DNS。部署前审查待执行的生产 D1 迁移；对已有线上实例，避开每日任务的写入时段。

**从旧命名切换：** 代码改名不会迁移线上数据。先对已有生产 state 运行 `plan` 并核对 D1 ID、备份和变更清单；若计划替换数据库，不要执行 `apply`，也不要移除 `prevent_destroy`。切流前核对 Turnstile 密钥、Worker 密钥和服务绑定、Durable Objects 状态及 Pages 域名，并协调新旧同步 Worker 的 Cron，避免同时写入。验证后再按批准的迁移方案停用旧资源。

| `production` 配置 | 名称 | 用途 |
| --- | --- | --- |
| Variables | `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_HOSTNAME`、`GRAPH_INSTANCE` | 指定生产账号、公开域名和已核验的图实例。 |
| Variables | `EXISTING_SERVICES` | JSON 对象，键为 `b2_bucket_id`、`neo4j_origin`、`neo4j_database`；不含密码。Deploy 在生成发布配置前逐项核对这三个值与 Terraform state；缺失、无效或不一致即停止，不发布 Worker，也不执行 D1 迁移。 |
| Variables | `B2_STATE_BUCKET`、`B2_STATE_KEY`、`B2_STATE_REGION` | state 桶的**名称**、state 对象键和桶的区域名（不是 URL）。区别于 `EXISTING_SERVICES` 中的业务归档桶 ID。 |
| Secrets | `B2_STATE_KEY_ID`、`B2_STATE_APP_KEY` | 仅传给 Terraform 的 `init`、`plan`、`apply` 步骤，以及 Deploy 读取生产 state 的步骤。 |
| Secrets | `CLOUDFLARE_TERRAFORM_API_TOKEN`、`CLOUDFLARE_DEPLOY_API_TOKEN` | 分开授权：前者管理 D1、Turnstile；后者读取目标 Pages 项目并发布 Workers、Pages。 |
| Secrets | `CLOUDFLARE_D1_MIGRATION_API_TOKEN` | 允许在生产账号的目标 D1 执行迁移并读取初始化结果。 |
| Secrets | `GRAPH_BOOTSTRAP_AUTH` | 专用 Neo4j Basic 授权头（含 `Basic ` 前缀）。需要读取目标图、建立唯一约束，并在首次授权时创建 GraphControl；不要复用运行时只读凭据。 |

合计 7 个 Variables、6 个 Secrets。若只发布应用，Deploy 读取全部 7 个 Variables 和其中 5 个 Secrets：共用的 B2 密钥对、Cloudflare 发布令牌、D1 迁移令牌、图初始化凭据。不要另建 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` 或 `TF_VAR_*`；工作流会自动映射。D1 ID 和 Turnstile 公开站点密钥来自 Terraform 输出，不需要手填。

首次发布顺序：在 `main` 手动运行 Terraform `plan`，核对后运行 `apply`，再运行 Deploy。仅在首次启用已核实的专用空图、且 D1 无运行记录时勾选 `initialize_empty_graph`；以后重跑无需勾选。已有控制节点不会被重置。非空图缺少控制节点、实例或游标不匹配时停止发布，须先对账，不能用首次初始化代替恢复。

Deploy 发布内部 Worker 后应用未执行的 D1 迁移、核验已实现的数据源及解析器登记，并建立或核验图控制、实体及场景的唯一约束。通过后才发布本次的 Cron Worker、网关和 Pages。该步骤不导入轨道、不授予来源展示权、不写 B2 对象、不创建 DO 运行或伪造成功指针；这些业务状态仍由每日任务产生。Terraform 生产操作和 Deploy 共用并发组；初始化失败不会回滚已发布的内部 Worker。

## 验收边界

六个 Worker 已有本地入口：api-gateway、data、sync、projector、graph、assistant；静态 Pages 另计。存在本地入口不表示已部署。

底部输入与展开面板共用内存会话。选择“手动查询与访问验证”可单独查目录或已有场景；缺少在线服务时不会返回演示答案。只有点击验证才加载 Turnstile；验证后由用户重新提交，不自动重放。助手默认不配置 AI 绑定或 `APPROVED_MODEL`，不会调用模型。候选模型未经目标账号免费资格、许可及中文工具能力验收，不应启用。每个请求最多四次模型推理、八次工具读取；取消只阻止后续步骤，不保证已发推理停止或退回消耗。

运行 `node --test tests/assistant.test.js tests/online_workspace.test.js tests/assistant_rpc.test.js` 复验请求边界、取消、视图动作及手动回退。端到端用例经过本地 API 网关、AssistantReader、CatalogReader 和临时 D1，推理端使用测试替身，并非真实 Workers AI。

`graph` 与 `data` 都默认不展示任何来源，无需配置空的 `DISPLAY_SOURCES`。获得展示许可后，只在获准服务的 Wrangler 源码模板中显式设置该变量，不在 GitHub 或生成目录重复配置。只有同步投影会写入轨道来源及证据；有轨道不等于有通信边，缺少经审核的场景时不返回演示路径。已有投影不会因查询而回填。

离线复验：运行 `node --test tests/graph_reader.test.js tests/graph_rpc.test.js`。前者验证请求、响应和投影参数，后者在临时 workerd 中从实际 API 网关入口经命名绑定调用 GraphReader；两者都不执行真实 Cypher。需要实测时，只有对本机专用空 Neo4j 的使用已获授权才执行 `SATEGRAPH_F1_LOCAL=1 node --test tests/f1_neo4j.test.js`。可用 SATEGRAPH_F1_PORT 指定本机端口，SATEGRAPH_F1_AUTH 通过环境安全注入。该用例只连回环地址，在一个未提交事务中装载合成样本并回滚；默认跳过。

目录读取默认关闭所有来源：仅在获得展示许可后，才在对应 data 环境配置 DISPLAY_SOURCES（逗号分隔的来源 ID）。API 网关仅转发已验证会话的目录 GET 请求，不转发会话或鉴权头。datasets/current 只指向已完整入库的轨道输入，不是整轮成功指针。命名入口隔离由应用和绑定保证，不等同于数据库表级权限。可运行 node --test tests/catalog_rpc.test.js 复验，无需启动预览。

日更按归档、预检、分批入库、投影和封存推进；只有确认提交才前移断点。投影排空不等于发布成功：在 D 阶段发布清单和恢复材料验收前，正常排空仍以 PUBLICATION_NOT_VERIFIED 结束，不推进成功指针。
