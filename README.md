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
| docs/design、docs/reference | 正式方案与 PRD、视觉参考和历史原型资料；不会进入公开资源目录 |

## 本地开发

src/ 的每个直接子目录对应一个服务。每个 Worker 的入口 index.ts 和绑定配置 wrangler.jsonc 同目录；新增私有模块放回所属服务。Pages 的浏览器 Web Worker 是页面资源，不单独部署。

使用 Node.js 24 和锁定的依赖。运行 npm ci 后，npm start 在回环地址启动基于 Miniflare 的静态预览；PORT 可覆盖默认端口 8765。npm run build:pages 把可发布的公开资源输出到打印的新目录，不复制工作区、账号信息或本地快照。历史 Python 服务不是开发或部署入口。

- npm run typecheck：校验 Workers 和验证程序。
- npm test：运行本地测试；D1 和 Durable Objects 测试使用临时实例，外部写入使用模拟适配器。
- 一方 JS/TS 使用仓库根目录 .clang-format 的 Google 预设；在 src、scripts、tests 中对改动文件执行 clang-format -i。不要格式化第三方依赖和历史交付物。

## 资源与部署边界

Terraform 只管理本项目声明的 D1 与 Turnstile。既有私有 B2 桶、Neo4j 端点和数据库名通过 existing_services 输入引用，不创建、不导入、不销毁。Workers、Pages、Worker 绑定、DO 迁移及 Cron 由 Wrangler 管理。各环境使用独立 state、数据库和应用凭据。

有已批准的 Terraform state 时，在项目根目录执行以下只读导出与本地配置生成，不会执行部署。GRAPH_INSTANCE 须与目标图中预先核验的 GraphControl.instance_id 一致，不允许按猜测初始化目标图。

    terraform -chdir=infra/terraform output -json bindings | GRAPH_INSTANCE='<已核验的图实例标识>' npm run config:workers

结果位于 dist/config/<环境>/。通过对应 Worker 的 Secret 配置 B2_KEY_ID、B2_APP_KEY（sync），GRAPH_AUTH（projector），TURNSTILE_SECRET、SESSION_KEYS（api-gateway）。不得放入 tfvars、Terraform 输出、Pages 构建或版本库。数据库迁移目录已写入生成配置；创建资源、应用迁移和发布都需单独授权。

配置生成命令输出六个 Worker 的 JSON 和独立的 pages.json；后者只指向本次新建的静态构建目录，没有服务绑定或机密。发布前须在获准使用的域名上验证同源分流：静态页面由 Pages 提供，/api/v1/ 请求交给 sg-api-gateway（环境配置文件为 api-gateway.json）。本地配置检查不代表域名、路由或远端资源已经生效。

## 验收边界

设计 §6.2.1 的六个 Worker 已有本地入口：api-gateway、data、sync、projector、graph、assistant；静态 Pages 另计。存在本地入口不表示已部署。

底部输入与展开面板共用内存会话。选择“手动查询与访问验证”可单独查目录或已有场景；缺少在线服务时不会返回演示答案。只有点击验证才加载 Turnstile；验证后由用户重新提交，不自动重放。助手默认无 AI 绑定，APPROVED_MODEL 为空。候选模型未经目标账号免费资格、许可及中文工具能力验收，不应启用。每个请求最多四次模型推理、八次工具读取；取消只阻止后续步骤，不保证已发推理停止或退回消耗。

运行 `node --test tests/assistant.test.js tests/online_workspace.test.js tests/assistant_rpc.test.js` 复验请求边界、取消、视图动作及手动回退。端到端用例经过本地 API 网关、AssistantReader、CatalogReader 和临时 D1，推理端使用测试替身，并非真实 Workers AI。

图查询需要给 graph 单独配置只读凭据 GRAPH_READ_AUTH；不要复用 projector 的 GRAPH_AUTH。graph 的 DISPLAY_SOURCES 默认空，与 data 分别配置。只有同步投影会写入轨道来源及证据；有轨道不等于有通信边，缺少经审核的场景时不返回演示路径。已有投影不会因查询而回填。

离线复验：运行 `node --test tests/graph_reader.test.js tests/graph_rpc.test.js`。前者验证请求、响应和投影参数，后者在临时 workerd 中从实际 API 网关入口经命名绑定调用 GraphReader；两者都不执行真实 Cypher。需要实测时，只有对本机专用空 Neo4j 的使用已获授权才执行 `SATEGRAPH_F1_LOCAL=1 node --test tests/f1_neo4j.test.js`。可用 SATEGRAPH_F1_PORT 指定本机端口，SATEGRAPH_F1_AUTH 通过环境安全注入。该用例只连回环地址，在一个未提交事务中装载合成样本并回滚；默认跳过。

目录读取默认关闭所有来源：仅在获得展示许可后，才在对应 data 环境配置 DISPLAY_SOURCES（逗号分隔的来源 ID）。API 网关仅转发已验证会话的目录 GET 请求，不转发会话或鉴权头。datasets/current 只指向已完整入库的轨道输入，不是整轮成功指针。命名入口隔离由应用和绑定保证，不等同于数据库表级权限。可运行 node --test tests/catalog_rpc.test.js 复验，无需启动预览。

实施清单见 .monkeycode/specs/sategraph/tasklist.md。日更按归档、预检、分批入库、投影和封存推进；只有确认提交才前移断点。投影排空不等于发布成功：在 D 阶段发布清单和恢复材料验收前，正常排空仍以 PUBLICATION_NOT_VERIFIED 结束，不推进成功指针。
