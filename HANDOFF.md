# 假面骑士吧长帖审阅助手：Codex 交接说明

> 交接基线：`1.0.0`，2026-08-17。本文面向下一位接手开发和实机验收的 Codex。开始工作前请同时阅读 `README.md`，并以源码与自动化测试为最终事实来源。

## 1. 项目目标与硬边界

这是一个面向 Chrome 的 Manifest V3 侧栏扩展，用于帮助贴吧吧务审阅长帖。1.0.0 已在 Chrome 实机验收；Edge 与 Tabbit 仅保留兼容实现。当前主流程是：

1. 吧务打开桌面版 `https://tieba.baidu.com/p/<tid>` 帖子并打开侧栏。
2. 扩展通过三个只读端点读取接口可见的全部主楼、普通楼层和楼中楼。
3. 只有覆盖校验确认“接口可见文字已经读完”后，才显示手动“开始 AI 初筛”入口；默认不会自动产生模型费用。
4. 模型返回结构化待复核线索与精简报告；扩展只把结构化回复引用映射为真实楼层和作者，供吧务点击回原帖复核。
5. 吧务明确选择当前处理对象、处理决定和唯一规范理由，再在贴吧官方界面自行处理。

硬边界：

- 不后台扫描首页或全吧，不做后台爬虫。
- 不自动发帖、删帖、封禁、屏蔽或调用任何吧务写入接口。
- 不读取密码，不把贴吧登录信息或 Cookie 值交给模型。
- 不做图片 OCR；图片只计数并显示为覆盖缺口。
- 不把模型结论包装成最终裁决；所有线索都必须回原帖人工核对。
- 不允许把 DOM 降级读取的部分内容当作完整整帖自动外发。
- 本地启发式分析器仍保留在源码和评估脚本中，但当前 UI 的违规线索只来自一次完整整帖模型结果。

## 2. 当前版本与技术栈

- 扩展版本：`1.0.0`
- 数据导出 schema：`1.0`
- 瞬态审阅会话 schema：`3`
- 云端分析器版本：`3.0.0`；整帖结果协议：`3`
- 云端设置 schema：`2`；整帖任务 cache schema：`3`
- 规则库版本：`2026.07`，16 个一级分类、112 条细化理由
- 浏览器最低版本：Chrome 140（持久密钥依赖 `storage.local.setAccessLevel` 对 local 区域的可信上下文限制）
- TypeScript 5.8、React 19、Vite 7、Zod 4、Vitest 3、jsdom 26
- Manifest V3：Side Panel + background service worker + 动态注入 content script
- 生产构建分两次完成：侧栏/后台由 `vite.config.ts` 构建，content script 由 `vite.content.config.ts` 以单文件 IIFE 构建

`dist/` 和 `node_modules/` 均被 Git 忽略。仓库提交源码和 lockfile，使用者在本地构建 `dist/`。

## 3. 权限模型

`public/manifest.json` 当前只声明：

- 普通权限：`scripting`、`storage`、`sidePanel`
- 固定站点权限：`https://tieba.baidu.com/*`
- 固定 AI 权限：当前配置的阿里云百炼工作区域名
- 可选权限：`https://api.deepseek.com/*`、`http://localhost/*`、`http://127.0.0.1/*`

没有 `tabs`、`activeTab` 或全站权限。贴吧固定权限是为兼容 Tabbit 不会因侧栏按钮授予 `activeTab` 的行为。

DeepSeek 权限必须由用户在侧栏点击授权按钮，通过真实用户手势授予。授予后会持续存在，直到用户在浏览器扩展设置中撤销或卸载扩展；不要在后台偷偷扩权。生产 UI 的服务商端点是只读固定值，不接受任意远端域名。

注意：贴吧只读请求使用 `credentials: "include"`，所以浏览器会按同源规则携带现有贴吧会话；代码本身不读取、记录或导出 Cookie 值。交接时不要把“代码不读取 Cookie”误写成“网络请求完全不使用登录会话”。

## 4. 架构与数据流

### 4.1 整帖读取

`src/sidepanel/App.tsx` 打开时加载设置和当前标签会话。设置 v2 默认 `autoReadWholeThread=true`、`autoAnalyzeWholeThread=false`：前者只触发免费的贴吧读取，后者必须由用户明确开启才会在完整快照后自动创建可能计费的模型请求。

`src/background.ts`：

- 通过 `GET_TAB_REVIEW_CONTEXT` 查询并严格校验指定 `tabId` 的 HTTPS 桌面贴吧帖子。
- 注入或复用 `content.js`。
- 接收 `CAPTURE_WHOLE_THREAD { tabId, requestId }`，为目标标签创建独立 generation/token；`CAPTURE_PROGRESS` 只返回阶段和真实 `completed/total`，不包含正文。
- 切换浏览器活动标签不会取消目标标签的读取；目标标签真实导航、同目标新读取或显式 `CANCEL_CAPTURE` 才会停止它。
- 调用 `captureTiebaThread()` 编排全部分页。

`src/tiebaApiCapture.ts` 的主路径：

1. `/c/s/pc/sync` 获取读取所需令牌。
2. `/c/f/pb/page_pc` 以并发 3 读取主回复分页；每个新页面都可扩展有界分页前沿，不能只信第一页的 `total_page`。
3. 稳定预览数已经覆盖父楼声明数时直接完成该父楼；其余父楼通过 `/p/comment` 串行读取全部楼中楼分页，避免同时冲击更敏感的旧端点。
4. 按 PID/SPID 去重，并在每次请求前后复核标签页身份；读取失败不自动重试验证码、结构异常或限流响应。
5. 逐父楼核对当前端点数量、原始回复节点、实际稳定 ID、页内/跨页重复、未知结构、分页元数据漂移、失败请求和贴吧旧标注。终页数量大于实际节点数时必须再读取 `totalPages + 1`，且只接受精确的 `total_num=null,total_page=0` 空页哨兵；只有终页、结构、ID、去重、分页一致性和空页探测全部通过，差额才只进入 `unavailableReplyCount`。缺稳定 ID、ID 来源冲突、重复 ID、未知节点、分页漂移、探测异常、失败或未到终页都会阻断 `readableTextComplete`。

实际 fetch 在 content script 所在的贴吧同源环境执行，但 `src/lib/tiebaTransport.ts` 只允许上述三个端点、固定方法、固定参数和有限请求头；禁止重定向、自动重试、超大响应和任意 URL 代理。

只有 `coverage.captureMode === "api"` 且 `apiCoverage.readableTextComplete === true` 才允许进入 AI 初筛；手动开始与用户显式开启的自动模式都遵守这一边界。API 失败时会降级到 legacy/SPA DOM 解析，保留部分证据并明确告警，不会冒充完整读取。

### 4.2 会话与覆盖率

`ThreadCapture` 经 `src/lib/session.ts` 合并为按标签页隔离的 `ReviewSession`，保存在 `chrome.storage.session`。官方站点 ID 优先作为去重键；离屏卸载不会删除已经读取的证据。

切换活动标签只切换当前侧栏视图，不会取消其他标签的读取或已发送 AI 任务。审核选择、决定和展开状态按 `SnapshotId` 保存草稿，切回同一快照可恢复；同一标签真正离开原帖时，旧页面不能继续定位或保存。含完整回复正文与作者名的 `ReviewSession` 只在浏览器会话内存在；脱敏 AI 结果和最小人工决定会按后文边界持久保存。

覆盖率应同时查看：

- `mainRepliesFetched` / `mainPagesFetched`
- `nestedRepliesFetched` / `nestedRepliesDeclared`
- `failedRequestCount`
- `unavailableReplyCount`
- `imageCount`
- `readableTextComplete` 与更严格的 `isComplete`

`readableTextComplete` 只代表只读接口实际返回的回复节点已严格分类、所有文字分页已到终点且不存在结构或分页不确定；它不要求贴吧的计数元数据与实际节点数相等。`isComplete` 还要求没有站点统计差额、图片缺口等。不要把两者混用，也不要把 `readableTextComplete=true` 的统计差额写成“还有 N 条待抓取正文”。

### 4.3 云端模型分析

完整 API 快照就绪后，`App.tsx` 通过 `src/sidepanel/bridge.ts` 在保持打开的侧栏中直接等待整帖请求。任务归属是发起时的不可变快照，不是之后的活动标签；A 帖完成时先写 A 的 cache，当前正在查看 B 帖只会收到跨帖完成提示。

`src/lib/threadIdentity.ts` 对规范化帖子快照做 SHA-256 并只持久化 `SnapshotId`，不保存哈希前明文；再由快照、服务商、端点、模型、模式、规则版本、分析器版本和 transport 版本生成 `AnalysisKey`。`src/lib/threadCloudCache.ts` 的 cache v3 使用这个键，包含八种状态：`preparing`、`running`、`success`、`failed_before_send`、`failed_after_send`、`cancelled_before_send`、`cancelled_after_send`、`unknown_after_disconnect`。同一模块另按 `SnapshotId` 保存严格最小的 billing receipt，只含快照/分析哈希、attempt、状态和时间；开始任务必须先在 Snapshot 级 Web Lock 内原子 claim。回执不含帖子 ID、URL、正文、用户名、模型输出、端点或密钥，并独立于可删除的报告和临时 cache 存活。

- 只有所有本地验证完成、紧邻 `fetch` 前的 `beforeSend` 边界才写入 `sentAt/deadlineAt`。
- 已明确落盘为发送前失败或取消时可说明“正文尚未发送”，并只允许同 attempt/analysisKey 的非强制安全重试；若扩展在 Snapshot claim 后、状态收尾前中断而遗留 `preparing`，不能冒充安全失败，必须按断连未知展示并经过二次付费确认后才能 force claim。发送后失败、停止等待或断连同样必须提示请求可能已经计费。
- 发送后重试和对成功快照重新分析都要求再次付费确认，cache 未知时绝不自动重发。
- 同一侧栏最多同时运行两项付费分析；第三项不启动、不排队，之后也不会暗中补发。
- 保存设置只影响未来任务，不取消已经开始的任务。
- 切换标签不会取消任务；关闭整个侧栏仍会断开侧栏承载的长请求，不能宣称存在浏览器持久后台任务。旧 `pending` 只会保守迁移为 `unknown_after_disconnect`。

`src/lib/cloud.ts`：

- 将作者映射为 `U1/U2/...`，回复映射为本次请求内的 `P1/P2/...`。
- 删除帖子 URL、官方 PID/SPID、精确时间、原始用户名、图片和 DOM 定位信息。
- 对手机号、座机、邮箱、身份证、QQ、微信及用户名引用做脱敏，并在序列化前二次校验。
- 一次发送所有接口可读文字和 112 条版本化规则；超出 2 MB 或保守 60 万输入 token 上限时零请求，不截断前半帖。
- v3 要求模型输出 `summary + findings + report{overview,stages,interactions,notes}`。报告阶段最多 8 项、关键互动最多 5 项、待人工确认最多 5 项、正常激烈讨论最多 3 项；摘要和线索文案也有本地长度上限。
- 自由文案不得携带 P/U/R 编号；具体回复只通过同级 `replyIds` 传递并严格映射为本地回复 ID，未知、大小写错误或带空格的引用不能生成可点击目标。`primaryReasonId` 仍必须命中本地规则，公开规范始终读取 `reasons.ts` 原文。
- Zod 校验结构，未知回复 ID、未知规则 ID、无效置信度和截断结果会被拒绝或安全忽略。
- 主回复默认视为回应主题帖。只有父子关系、明确楼层引用、“楼上”、@、点名或可验证连续互动才能合并为同一互动链。
- `reasoning_content` 不显示、不缓存，只消费最终 `message.content`。
- 官方 DeepSeek V4 的整帖请求将 `max_tokens` 设为 384,000；单项分析及非 DeepSeek V4 端点仍维持较小输出预算。`finish_reason=length` 仍必须整份拒绝。
- 服务商返回标准 usage 时，结果只记录经过上限校验的输入、输出和合计 token；本机月度台账不含正文。缺少 usage 时不估算，人民币账单以服务商后台为准。

旧 cache 的成功结果仍可读取；旧版七段报告只在“旧版详细报告”中折叠展示，不会为了升级格式自动重新调用模型。

### 4.4 证据定位

`src/background.ts` 只把稳定定位字段发给 content script，不发送正文或作者名。

`src/content.ts` / `src/lib/evidence.ts` 的当前纯页内定位策略：

1. 目标已挂载时直接滚动并高亮。
2. 未挂载时优先在页面内安全切换“正序”。
3. 根据公开楼层、虚拟列表 `data-index` 和 PID 做有界扫描；最终成功必须验证真实 PID，不能只凭索引。
4. 楼中楼只点击明确列入白名单的“展开/查看更多回复”只读控件，同一 DOM 控件最多点击一次。
5. 仍找不到时在原页返回提示，保留当前帖子、排序和滚动状态；普通证据点击不得调用 `chrome.tabs.update`、`chrome.tabs.reload` 或其他会触发导航的路径。
6. legacy DOM 证据位于其他分页时同样只提示所在页码，由用户自行切页后重试，不得自动换页。

所有查找、点击、滚动和高亮之前都会检查 thread ID 和 jump generation。不要移除这些检查，否则快速切帖或连续点击可能把旧定位操作施加到新帖子。

### 4.5 AI 分析历史与人工决定

导航中的“记录”已重做为“历史”。每次成功的整帖 AI 分析以独立 `attemptId` 写入 `chrome.storage.local`，由 `src/lib/analysisHistory.ts` 的 strict schema 控制；扩展更新、重新加载和 Chrome 重启后仍可恢复。历史保存规范帖子链接与标题、快照/分析哈希、服务商/模型/模式/版本、覆盖数字、token 回执、脱敏后的模型摘要/线索/报告，以及被结果引用的楼层位置；不单独保存 API 密钥、端点、原始回复正文、用户名或证据摘录。模型生成的文字可能概括或复述讨论内容，因此 UI 必须继续如实说明它属于本机持久数据。

历史按 `kr_analysis_history_v1_<attemptId>` 分键存储，避免两个并行任务通过整数组 read-modify-write 相互覆盖；所有 mutation 还必须经过同一扩展 origin 的 Web Locks 独占锁，防止两个 Chrome 窗口的侧栏实例突破边界。总数上限 100，单条与全部历史共享 4 MiB 总预算；预算按持久 storage key 与 value JSON 的 UTF-8 字节计算，损坏的历史前缀项也计入。保存与导入会在首写前校验完整合并结果，超限时整批失败，不可静默删除旧报告或留下部分导入；损坏项、可信上下文限制失败或存储读取失败必须 fail-closed，不能当作空历史继续自动付费。导入采用 attempt 合并语义，不覆盖未出现在导入文件中的本机历史；相同 `attemptId` 的快照、分析键、帖子身份、服务商、模型、模式、版本或开始时间冲突必须拒绝。删除历史不得清除 API key、设置、token 台账或人工决定；成功结果缓存会同时清除，但独立的 Snapshot billing receipt 继续保留 `history_deleted` 状态，防止删除、版本升级或换模型后自动再次付费。

`ReviewRecord` 继续作为人工决定事实存在，并新增可空的 `analysisAttemptId/snapshotId/findingId` 关联。新决定在有 AI 结果时必须同时匹配 attempt、snapshot、thread 和实际存在的 finding；旧 v1 决定无法可靠反推调用，只在“未关联报告的人工决定”折叠区保留，绝不能伪造为 AI 历史。人工决定保存同样必须在独立的扩展 origin Web Lock 内重新读取、严格验证、按 UUID 合并并单次写入，再把持久层返回的权威数组更新到当前界面；禁止从某个侧栏实例的旧内存数组直接整表覆盖，以免两个 Chrome 窗口互相丢决定。

## 5. 关键文件地图

| 路径 | 职责 |
| --- | --- |
| `public/manifest.json` | 扩展版本、最低浏览器版本、权限和侧栏入口 |
| `src/background.ts` | 活动标签校验、脚本注入、整帖读取编排、会话生命周期、页内证据定位编排 |
| `src/content.ts` | 同源只读请求、DOM 降级解析入口、动态观察、纯页内无刷新定位 |
| `src/tiebaApiCapture.ts` | 主回复动态分页、楼中楼按需串行读取、去重、覆盖率计算和安全上限 |
| `src/lib/tiebaApi.ts` | 三个贴吧只读请求的构造、签名和响应解析 |
| `src/lib/tiebaTransport.ts` | 只读网络白名单、响应大小/重定向/方法/参数边界 |
| `src/lib/extractor.ts` | legacy 与 SPA DOM 适配器；API 失败时的降级读取 |
| `src/lib/evidence.ts` | 虚拟列表定位、正序控件识别、安全展开控件白名单 |
| `src/lib/session.ts` | 标签页级会话合并、同帖/换帖识别、覆盖信息聚合 |
| `src/lib/threadIdentity.ts` | 规范化快照与分析输入的 SHA-256 `SnapshotId/AnalysisKey`；不持久化哈希前明文 |
| `src/messages.ts` | side panel/background/content 的消息协议和错误码 |
| `src/lib/privacy.ts` | 用户别名与敏感字段脱敏、最终隐私守卫 |
| `src/lib/cloud.ts` | 整帖 prompt、请求体、DeepSeek/Qwen 差异、返回协议规范化与关系链校验 |
| `src/lib/cloudPermission.ts` | 固定服务商配置、端点校验、精确 host 权限 |
| `src/sidepanel/bridge.ts` | 侧栏网络调用、权限检查与取消；整帖长请求驻留侧栏 |
| `src/cloudBroker.ts` | 可选权限租约及旧的单线索分析通道；整帖固定权限请求不依赖它驻留 |
| `src/sidepanel/App.tsx` | 处理清单优先 UI、多帖子任务、分析状态、设置、理由库与 AI 历史 |
| `src/sidepanel/demo.ts` | `review-clean/typical/dense` 三套纯合成 V3 演示态 |
| `src/sidepanel/recordStore.ts` | 设置 v2、主题、持久 API key、token 月度台账、人工决定与分键 AI 历史存储 |
| `src/lib/threadCloudCache.ts` | 持久 cache v3、`AnalysisKey` 精确恢复、独立 Snapshot billing receipt 与原子 claim、八状态及旧 session cache 保守迁移 |
| `src/lib/analysisHistory.ts` | AI 历史 strict schema、脱敏投影、引用楼层最小化、导入导出与 attempt 合并 |
| `src/data/reasons.ts` | 16 类、112 条规范理由及稳定 ID |
| `src/lib/records.ts` | 审核记录严格 schema、规范化、导入导出 |
| `scripts/evaluate-corpus.ts` | 脱敏人工语料评估与 500 回复本地基准 |
| `src/test/fixtures/` | 经过脱敏的 DOM/API 测试夹具 |

测试与实现通常成对命名，例如 `src/lib/cloud.ts` 对应 `src/lib/cloud.test.ts`、`src/lib/cloud.deepseek.test.ts` 和 narrative fuzz 测试。修改协议或安全边界时必须同时扩展对应测试。

## 6. 已完成功能

- 贴吧只读接口的整帖主楼与楼中楼分页读取、并发、稳定 ID 去重和覆盖校验。
- 指定 `tabId/requestId` 的读取、真实阶段进度、显式取消；单纯切换浏览器标签不中断读取。
- legacy/新版 SPA DOM 降级解析，动态内容累积但不宣称完整。
- 普通/夜间两套贴吧风格主题、窄屏布局、键盘焦点和带焦点圈定的付费确认弹窗。
- 16 类 112 条规则库、单分类展开、分批搜索结果和规范原文复制。
- 处理清单优先的结果页：总览、最高优先级、待复核线索、显式当前处理对象、待确认项和默认折叠详情；第一条线索与决定均不再自动选择。
- v3 精简报告 `overview/stages/interactions/notes`；旧七段式成功结果兼容读取并折叠展示。
- Qwen 与 DeepSeek 的 fast/deep 模式差异处理，最长等待时间分别受代码上限约束。
- DeepSeek 常见 JSON 形态兼容，但关键 ID、理由、证据和置信度仍执行严格白名单。
- 结构化 `replyIds` 严格映射为真实楼层、楼中楼父子关系和用户名；自由文案中的 P/U/R 编号会被移除。
- 独立主回复不因楼层相邻、作者相同或话题相似被强行串成争吵链。
- 证据纯页内无刷新定位、正序切换、虚拟列表扫描、楼中楼安全展开与原页失败提示。
- 按 attempt 分键的持久 AI 历史、严格导入导出、关联人工决定与隐私字段拒绝。
- `SnapshotId/AnalysisKey`、cache v3 八状态、最多两项付费任务且无队列、跨标签继续与防串帖机制。
- 服务商 token usage 的本机月度台账；人民币金额只认服务商后台账单。
- `review-clean`、`review-typical`、`review-dense` 三套纯合成演示态，不调用模型、不保存真实语料。

## 7. 安装与配置

### 7.1 本地构建与加载

```bash
npm ci
npm run build
```

在 `chrome://extensions`：

1. 开启开发者模式。
2. 选择“加载已解压的扩展”。
3. 指向仓库下新生成的 `dist/`。
4. 确认扩展卡片版本为 `1.0.0`。
5. 打开桌面贴吧帖子并点击扩展图标，侧栏应出现。

每次重新构建后，都要在扩展管理页点击“重新加载”。涉及 content script 的变更，还应由测试者对当前测试帖做一次普通刷新，让新脚本接管；完成这次安装刷新后，点击证据本身不得再刷新或替换帖子页面。

### 7.2 DeepSeek

1. 打开侧栏“设置”。
2. 服务商选择 DeepSeek；端点会固定为官方 API 域名。
3. 核对“模型名称”。源码默认值目前是 `deepseek-v4-pro`，但模型 ID 是否对当前账号可用应以服务商实际返回为准；若 400/404，不要假定默认字符串永远有效。
4. 推荐选择“深度”模式后，由用户本人输入 API 密钥并保存。已保存密钥不会回填到输入框，界面只显示当前服务商的配置状态。
5. 完整快照就绪后点击“开始 AI 初筛”；首次如提示未授权，再由用户点击授权按钮并接受精确的 `api.deepseek.com` 权限。
6. 保持侧栏打开直到返回；深度整帖请求最长可等待 10 分钟。

API 密钥按服务商分别写入 `chrome.storage.local` 的独立 secret 项，Chrome 重启、扩展更新和重新加载后仍保留；普通设置项、任务缓存、AI 历史、人工决定和导出数据均不含密钥。写入前会将整个 local 区域限制为 `TRUSTED_CONTEXTS`，但 Chrome 扩展存储不是操作系统密钥库级加密。卸载扩展、更换 Chrome 配置文件或清除扩展数据会删除凭据。端点、模型、模式、`autoReadWholeThread` 和 `autoAnalyzeWholeThread` 写入设置 v2；旧设置迁移时保留自动读取、关闭自动付费。共享旧密钥只会迁移到持久设置已经确认的服务商，切换服务商只读取各自凭据。除非用户针对当前操作明确授权，不要通过终端、日志、截图、测试夹具或交接文档读取/复制用户密钥。

默认只自动读取，不自动付费。只有用户手动开始，或明确开启“完整读取后自动创建 AI 请求”，才会发送模型请求。发送后失败、结果未知和重新分析成功快照均需二次费用确认；系统不会自动重试或排队。

### 7.3 阿里云百炼

阿里云路径使用 Manifest 中固定的工作区域名，默认模型在 `CLOUD_PROVIDER_DEFAULTS` 中。它不是通用任意 endpoint 输入框。迁移到其他工作区时，必须同时评估并更新 Manifest 精确权限、默认配置、权限测试和 README，不能扩大为全站权限。

## 8. 开发、构建与测试命令

```bash
# TypeScript 严格检查
npm run typecheck

# 全部 Vitest 测试
npm test

# 监听模式
npm run test:watch

# 生产构建（内部先跑一次 typecheck）
npm run build

# 只检查示例评估文件的格式和工具链，不代表模型质量验收
npm run evaluate:example

# 正式私有语料评估
npm run evaluate -- evaluation/private/corpus.json
```

定位链路的快速回归命令：

```bash
npx vitest run src/content.test.ts src/lib/evidence.test.ts src/background.test.ts src/manifest.test.ts
```

`npm run dev` 只能方便查看 Vite 页面，不能代替加载完整 MV3 扩展和真实浏览器测试。项目目前没有 lint 脚本，也没有 GitHub Actions CI。

## 9. 本次交接时的测试事实

以下结果在 2026-08-16、当前工作区源码上实际运行，不是推测：

- `npm run typecheck`：通过。
- `npm test`：31 个测试文件、435 个测试全部通过。
- 本轮完整测试中，500 条 SPA 文本回复 DOM 解析低于 3 秒测试阈值；具体耗时受机器负载影响，不作为发行承诺。
- 定位相关套件当前共 84 个测试（manifest 4、evidence 19、content 6、background 55）；本轮完整测试均通过。
- `npm run build`：最终交付前必须通过；`dist/manifest.json` 应为 `1.0.0`，生产产物包括 `background.js`、`content.js`、`sidepanel.js`。
- `npm audit`：生产和开发依赖均为 0 个已知漏洞。
- `npm run evaluate:example`：工具运行成功，但只有 2 个示例案例；其结果只能证明格式和脚本可用，不能证明真实召回率或误报率。

历史上，含“3 秒”真实墙钟门槛的性能测试曾在 MuMu 模拟器或 WindowServer 高占用时超时；本次最新完整测试是绿色的，但后续若仅这一项偶发失败，先检查系统 CPU 竞争，不要立即放宽阈值或跳过测试。

不要夸大的部分：

- 尚未提交至少 30 个真实、人工标注、完全脱敏的私有长帖语料；正式严重争吵召回率 80% 验收没有完成。
- 当前纯页内无刷新定位已完成自动化测试；本轮最终交付只在用户明确指定的 Chrome 中验收，不得连接或控制 Tabbit。
- 早期版本曾在真实帖子上返回整帖模型报告，但这不能替代当前版本在热门/正序/倒序、主回复/楼中楼、虚拟卸载状态下的重新验收。
- 没有自动化测试能够证明贴吧未改接口、当前账号能看到所有站点数据，或某个 DeepSeek 模型 ID对用户账号持续可用。

## 10. 已知限制和风险

- 三个贴吧端点属于站点现有只读接口，但不是本项目拥有或控制的稳定公开契约；字段、签名、速率限制或访问策略随时可能变化。
- 已删除、审核中、权限不可见或接口不返回的内容无法绕过；数量差额必须继续显示。
- 贴吧顶部“回复数”的统计口径可能不等同于接口返回的稳定回复条数，主楼是否计入也可能造成 1 条差异；应依据覆盖明细解释，不能只比较一个总数。
- 图片、视频、表情图片中的文字不分析。
- 模型可能误解反讽、引用辱骂、熟人玩笑、虚构角色评价或事实真伪；人工复核不可删除。
- 深度模型可能耗时和计费较高；切换浏览器标签或修改设置不会取消已开始任务，但必须保持侧栏开启。关闭侧栏可能在请求发出后失去结果，cache 会标记为未知；服务商是否计费以其后台为准。
- 任务并未迁入浏览器持久后台：service worker 不能保证替关闭的侧栏继续持有长请求。不要把“切标签可继续”误写成“关闭侧栏也可继续”。
- DeepSeek 默认模型名是当前项目配置，不是永久兼容保证。
- Manifest 和默认配置会公开当前固定的百炼工作区域名；它不是 API 密钥，但属于可识别的部署端点。迁移或公开复用时应先由仓库所有者确认。
- `src/lib/tiebaApi.ts` 中的 PC 签名常量来自当前网页只读协议，不是个人凭据；它可能触发密钥扫描，也可能随贴吧改版失效。不要把它误当用户 API key，也不要在未验证协议前随意改动。
- 页面内定位依赖贴吧 DOM 与虚拟列表结构；若安全扫描不能验证 PID，会保留原页面并提示目标尚未加载，用户需要自行切换分页、排序或展开内容后重试。
- 首页风险队列、全吧巡检、OCR、多人协作后台、权限分级和自动处罚尚未实现。
- 仓库已有 `PRIVACY.md`、1.0.0 版本记录和可重复的无 source map ZIP 打包脚本，但仍没有 LICENSE、CI、Chrome Web Store 图形/上架配置；公开分发前必须由所有者明确许可证并完成商店合规项。

## 11. 隐私与安全约束

后续修改必须保持这些不变量：

- 贴吧请求只允许 `tiebaTransport.ts` 白名单中的三个端点；不要做通用 fetch 代理。
- 不使用 `tabs`、`<all_urls>` 或任意 AI 域名权限来绕过问题。
- 任何 cloud payload 都必须先经过 `privacy.ts`，并继续测试原用户名、手机号、邮箱、证件、QQ、微信不外发。
- 不发送帖子 URL、官方 PID/SPID、精确时间、图片、Cookie 值或密码给模型。
- API key 只能按服务商放入受 `TRUSTED_CONTEXTS` 保护的 `chrome.storage.local` 独立 secret 项；不得进入 Git、网页 `localStorage`、普通设置、缓存、导出 JSON、错误日志或测试快照。空输入必须保留旧值，清除必须是显式操作。
- 模型返回中的 reply ID 和 reason ID 必须命中本地白名单；不得因“兼容性”而接受模型虚构 ID。
- 公开删帖理由只能使用 `reasons.ts` 原文。
- 审核记录 schema 保持 strict；新增任何持久字段前先做隐私评审和迁移设计。
- 自动管理动作次数必须始终为零。定位只允许当前页内排序、滚动、高亮和明确只读展开控件；不得自动刷新、换页或打开证据深链。
- 真实吧友内容只能进入 Git 忽略的 `evaluation/private/`，且必须先人工脱敏；不要提交浏览器导出、HAR、控制台响应或截图中的原文。

## 12. 下一位 Codex 的建议接手顺序

1. 先运行 `git status`、`npm ci`、`npm run typecheck`、`npm test` 和 `npm run build`，建立自己的绿色基线。
2. 在 `chrome://extensions` 加载当前 `dist/`，确认版本、站点权限、service worker 无错误；不要直接修改权限扩大范围。
3. 由用户亲自打开一条用于测试的真实帖子并输入 API key。不要读取、复制或回显密钥。
4. 实测整帖读取：记录贴吧标注数、主层数、楼中楼实取/声明数、不可见差额和图片数；抽查数条作者、正文、楼层、父子关系和时间。
5. 实测模型：确认只有 `readableTextComplete` 快照会发送；网络负载不含原用户名、帖子 URL、官方 ID、精确时间或敏感字段；验证失败不自动重试。
6. 实测报告与证据：检查处理清单顺序、显式处理对象、V3 折叠详情及独立主回复关系；模型自由文案不得显示 P/U/R 编号，结构化 `replyIds` 应定位到正确楼层和作者。
7. 在热门、正序和倒序分别测试任意主楼与楼中楼定位；确认所有普通点击都不刷新、不换页，只安全展开并在可加载时最终命中 PID。另测未挂载目标和 legacy 跨页目标，确认原页提示清楚且帖子状态不变；不要记录正文。
8. 再测试 A 帖分析后切到 B 帖、快速 A→B→C、原标签导航、重载和关闭侧栏：切换标签不应取消 A，A 的结果不得出现在 B；导航和断连应显示正确的发送前/后费用语义，且不得静默重发。
9. 用至少 30 个私有脱敏标注案例做模型质量评估。现有 `evaluate-corpus.ts` 仍调用本地旧分析器，若目标是评估纯 API 模型，需要设计独立、费用可控且不提交原文的新评估器；不要把现有示例指标冒充云模型指标。
10. 完成实机基线后再重构。优先修复可复现问题，并为每个权限、隐私、并发或定位回归补测试。

## 13. 常见故障排查

### “Cannot access contents…”或“未授予贴吧权限”

- 确认当前页面是 `https://tieba.baidu.com/p/<数字>`，不是搜索页、其他域名、浏览器内置页或 HTTP 页面。
- 确认加载的是刚构建的同一个 `dist/`，扩展卡片版本为 `1.0.0`。
- 在扩展管理页重新加载，并对帖子做一次刷新。
- 检查扩展“网站访问权限”是否允许 `tieba.baidu.com`。
- 不要通过新增 `activeTab`、`tabs` 或 `<all_urls>` 掩盖问题。

### “固定 AI 端点权限尚未生效”或“未授予该 AI 端点的网络权限”

- Manifest 更新后必须先重载扩展。
- DeepSeek 是可选权限；必须由用户点击侧栏中的授权按钮，程序化自动授权不会获得有效用户手势。
- 在 Chrome 扩展详情页检查 `api.deepseek.com` 权限是否已授予。
- DeepSeek 与阿里云密钥按服务商分别持久保存；切回时只加载该服务商自己的密钥，绝不把一家密钥复用给另一家。只有该服务商尚未保存密钥时才需要输入。

### “整帖只读接口不可用”或 AI 初筛不可开始

- 打开 service worker 和侧栏 DevTools，区分 rate limit、网络、结构解析、帖子身份变化和响应过大。
- 检查 `coverage.apiCoverage`，不要只看总回复数。
- DOM 降级结果可以帮助人工查看，但按设计不能作为完整整帖自动外发。
- 端点字段变动时先更新脱敏夹具和解析测试，不要静默吞掉未知结构。

### 云端 401/403/400、超时或连接中断

- 401/403：让用户重新确认密钥和账号权限，不要要求其把密钥贴到聊天中。
- 400/404：优先核对当前服务商真实模型 ID 和请求字段；尤其不要假设默认 DeepSeek 模型名永久存在。
- 深度模式允许较长等待，必须保持侧栏打开；后台 service worker 不是整帖长请求承载者。
- 先看 cache v3 状态和 `sentAt`：`failed_before_send/cancelled_before_send` 可明确正文未发送；`failed_after_send/cancelled_after_send/unknown_after_disconnect` 都必须按可能已计费处理。
- 失败不会自动重试或进入队列。发送后重试必须经过付费确认，并先建议用户核对服务商后台。
- 调试时可记录状态码和错误类型，不要打印 Authorization header、请求正文或含用户内容的完整响应。

### “云端返回结构不符合协议”

- 先把失败归类到具体字段，并用完全合成/脱敏的最小 fixture 复现。
- 可以对服务商常见的非关键外形差异做白名单规范化，但不能放松 offending reply IDs、reason IDs、evidence、confidence、完整输出或关系链校验。
- `finish_reason === "length"` 必须整份拒绝，不能采用半份报告。

### 回复数与贴吧显示不一致

- 分别看主层（含主帖）、楼中楼声明/实取、不可见差额和图片数。
- 删除、审核中、权限不可见和站点统计口径都可能造成差异。
- 如果 `readableTextComplete` 为真但 `isComplete` 为假，通常是接口分页对账完成但仍有站点不可见数量或图片缺口，不是同一个概念。

### 点击楼层仍刷新

- 这是定位回归：普通证据点击在目标缺失、未挂载或 legacy 跨页时都应留在原页，只显示提示。
- 先确认扩展和帖子都在使用新构建脚本，再检查 side panel 和 background 是否仍存在 `chrome.tabs.update`、`chrome.tabs.reload` 或导航地址分支。
- 复现时只记录帖子结构、当前排序、主楼/楼中楼类型、楼层、是否跨页和是否有稳定 PID，不复制正文或用户名。
- 同时检查 content/background 的 jump generation 与 `expectedThreadId`，不要删除竞态保护来换取表面成功。

### “会话已失效/页面已切换”

先区分“切换浏览器活动标签”和“原标签真正导航”：

- 只切到另一个标签时，原帖读取/分析应继续，侧栏只改为显示新标签上下文；A 帖结果必须保存给 A。
- 原标签离开帖子后，旧页面定位和保存必须失效；尚未发出的工作可取消，已经发出的模型请求仍按原 `SnapshotId/AnalysisKey` 处理。
- 关闭整个侧栏不是可恢复的持久后台场景；重新打开后若 cache 显示断连未知，不得自动重发。

## 14. 发布与仓库注意事项

- 目标仓库：`https://github.com/Morphling0717/Tieba`。
- `.gitignore` 已排除 `node_modules/`、`dist/`、coverage、日志和 `evaluation/private/`；推送前再次检查未跟踪文件和 staged diff。
- 永远不要提交 API key、浏览器存储、HAR、真实回复语料、用户名、完整模型响应或包含它们的截图。
- 提交 `package-lock.json`，以保持依赖可复现。
- 升级版本时至少同步：`package.json`、`package-lock.json`、`public/manifest.json`、`src/manifest.test.ts`、README 中版本说明，然后重建并检查 `dist/manifest.json`。
- `dist/` 与 `release/` 当前不提交；交接或测试机使用 `npm run release:verify` 运行全量测试、重建并只从 `dist/` 白名单生成固定顺序/时间戳的 ZIP、SHA-256 与构建清单。正式 ZIP 不包含 source map，根目录直接包含 `manifest.json`。
- 发布前运行完整测试、类型检查、生产构建，再做 Chrome 真实端到端验收；自动测试通过不能替代实机验收。只有完成 Edge/Tabbit 独立实机矩阵后，才可把它们写成正式支持平台。
- 项目尚无 LICENSE。公开协作或分发前，请仓库所有者选择明确许可证；不要擅自添加代表所有者法律意图的许可证。
- 贴吧只读接口与规则 PDF 的使用、服务商条款和隐私说明需要由仓库所有者在公开发布前确认。

## 15. 完成交接的判断标准

下一阶段不能只以“模型有返回”或“测试全绿”为完成。最低应同时满足：

- 当前真实帖的接口可见主楼与楼中楼全部分页完成，覆盖缺口与贴吧标注差额解释清楚。
- 一次完整模型请求成功，隐私负载抽查通过，V3 处理清单、结构化证据映射与旧报告折叠兼容可用。
- 任意模型引用在热门、正序和倒序下都只进行页内定位；可加载目标进入正确主楼或父楼，未挂载及 legacy 跨页目标在原页提示，所有普通点击都不自动刷新或换页，楼中楼展开不触碰写操作。
- A 帖任务在切到 B 帖后继续且结果只归 A；同一 Snapshot 即使切换模型/模式也只能由一个非强制任务取得发送资格；最多两项不同快照的付费任务并行，第三项不排队；重载、断连、报告删除、缓存损坏和失败重试均不串会话、不静默重复计费。
- AI 历史在扩展更新/重载/Chrome 重启后仍可恢复，导入导出只通过 strict schema；不单独保存原始回复正文、用户名、证据摘录、端点或密钥。人工决定能关联到准确 attempt/finding，旧决定不伪造关联。
- 全程自动删帖、封禁、发帖和账号操作次数为零。
