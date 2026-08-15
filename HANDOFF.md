# 假面骑士吧长帖审阅助手：Codex 交接说明

> 交接基线：`0.3.1`，2026-08-15。本文面向下一位接手开发和实机验收的 Codex。开始工作前请同时阅读 `README.md`，并以源码与自动化测试为最终事实来源。

## 1. 项目目标与硬边界

这是一个面向 Chrome、Edge 和 Tabbit 的 Manifest V3 侧栏扩展，用于帮助贴吧吧务审阅长帖。当前主流程是：

1. 吧务打开桌面版 `https://tieba.baidu.com/p/<tid>` 帖子并打开侧栏。
2. 扩展通过三个只读端点读取接口可见的全部主楼、普通楼层和楼中楼。
3. 只有覆盖校验确认“接口可见文字已经读完”后，才把整帖脱敏文字和完整规范理由库一次性交给已配置模型。
4. 模型返回结构化线索与长文报告；扩展把匿名引用重新映射为真实楼层和作者，供吧务点击回原帖复核。
5. 吧务人工选择唯一的规范理由、复制原文并在贴吧官方界面自行处理。

硬边界：

- 不后台扫描首页或全吧，不做后台爬虫。
- 不自动发帖、删帖、封禁、屏蔽或调用任何吧务写入接口。
- 不读取密码，不把贴吧登录信息或 Cookie 值交给模型。
- 不做图片 OCR；图片只计数并显示为覆盖缺口。
- 不把模型结论包装成最终裁决；所有线索都必须回原帖人工核对。
- 不允许把 DOM 降级读取的部分内容当作完整整帖自动外发。
- 本地启发式分析器仍保留在源码和评估脚本中，但当前 UI 的违规线索只来自一次完整整帖模型结果。

## 2. 当前版本与技术栈

- 扩展版本：`0.3.1`
- 数据导出 schema：`1.0`
- 瞬态审阅会话 schema：`3`
- 云端分析协议版本：`2.3.0`
- 规则库版本：`2026.07`，16 个一级分类、112 条细化理由
- 浏览器最低版本：Chrome 116
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

`src/sidepanel/App.tsx` 打开时加载设置和当前标签会话；自动分析开启且没有会话时，会发送 `CAPTURE_WHOLE_THREAD`。

`src/background.ts`：

- 查询当前活动标签并严格校验为 HTTPS 桌面贴吧帖子。
- 注入或复用 `content.js`。
- 为本次读取创建 generation/token，切帖、重载或新读取会取消旧任务。
- 调用 `captureTiebaThread()` 编排全部分页。

`src/tiebaApiCapture.ts` 的主路径：

1. `/c/s/pc/sync` 获取读取所需令牌。
2. `/c/f/pb/page_pc` 读取全部主回复分页。
3. `/p/comment` 按父楼读取全部楼中楼分页。
4. 并发度为 3；按 PID/SPID 去重，并在每次请求前后复核标签页身份。
5. 核对主回复页数、楼中楼声明数、实际稳定 ID 数、失败请求数和贴吧标注回复数。

实际 fetch 在 content script 所在的贴吧同源环境执行，但 `src/lib/tiebaTransport.ts` 只允许上述三个端点、固定方法、固定参数和有限请求头；禁止重定向、自动重试、超大响应和任意 URL 代理。

只有 `coverage.captureMode === "api"` 且 `apiCoverage.readableTextComplete === true` 才允许自动整帖外发。API 失败时会降级到 legacy/SPA DOM 解析，保留部分证据并明确告警，不会冒充完整读取。

### 4.2 会话与覆盖率

`ThreadCapture` 经 `src/lib/session.ts` 合并为按标签页隔离的 `ReviewSession`，保存在 `chrome.storage.session`。官方站点 ID 优先作为去重键；离屏卸载不会删除已经读取的证据。

同一标签页离开原帖会立刻清除或挂起可操作状态，避免串帖。会话只在浏览器会话内存在；完整回复正文和作者名不会写入审核记录导出。

覆盖率应同时查看：

- `mainRepliesFetched` / `mainPagesFetched`
- `nestedRepliesFetched` / `nestedRepliesDeclared`
- `failedRequestCount`
- `unavailableReplyCount`
- `imageCount`
- `readableTextComplete` 与更严格的 `isComplete`

`readableTextComplete` 只代表只读接口实际可返回的文字分页已完整对账；`isComplete` 还要求没有不可见数量差额、图片缺口等。不要把两者混用。

### 4.3 云端模型分析

完整 API 快照就绪后，`App.tsx` 通过 `src/sidepanel/bridge.ts` 在保持打开的侧栏中直接等待整帖请求。这样可避免 Manifest V3 service worker 在长请求期间被浏览器回收。

`src/lib/cloud.ts`：

- 将作者映射为 `U1/U2/...`，回复映射为本次请求内的 `P1/P2/...`。
- 删除帖子 URL、官方 PID/SPID、精确时间、原始用户名、图片和 DOM 定位信息。
- 对手机号、座机、邮箱、身份证、QQ、微信及用户名引用做脱敏，并在序列化前二次校验。
- 一次发送所有接口可读文字和 112 条版本化规则；超出 2 MB 或保守 60 万输入 token 上限时零请求，不截断前半帖。
- 要求模型输出 JSON；Zod 校验结构，未知回复 ID、未知规则 ID、无效置信度和截断结果会被拒绝或安全忽略。
- 主回复默认视为回应主题帖。只有父子关系、明确楼层引用、“楼上”、@、点名或可验证连续互动才能合并为同一互动链。
- 模型自由文本中的 P-id 会在本地还原为可点击真实证据；公开理由文案始终从本地规则库读取，绝不直接采用模型改写。
- `reasoning_content` 不显示、不缓存，只消费最终 `message.content`。

同一标签页、帖子快照、端点、模型、模式和协议版本在当前浏览器会话中有缓存。失败或超时不会自动重试；人工点击“重新分析”可能产生新费用。

### 4.4 证据定位

`src/background.ts` 只把稳定定位字段发给 content script，不发送正文或作者名。

`src/content.ts` / `src/lib/evidence.ts` 的 `0.3.1` 策略：

1. 目标已挂载时直接滚动并高亮。
2. 未挂载时优先在页面内安全切换“正序”。
3. 根据公开楼层、虚拟列表 `data-index` 和 PID 做有界扫描；最终成功必须验证真实 PID，不能只凭索引。
4. 楼中楼只点击明确列入白名单的“展开/查看更多回复”只读控件，同一 DOM 控件最多点击一次。
5. 仍找不到时才走贴吧官方 PID/CID 深链；当前已是同一深链时，最后兜底才刷新。

所有查找、点击、滚动和高亮之前都会检查 thread ID 和 jump generation。不要移除这些检查，否则快速切帖或连续点击可能把旧定位操作施加到新帖子。

### 4.5 审核记录

审核记录存于 `chrome.storage.local`，由 `src/lib/records.ts` 的严格 schema 控制。导出只包含规范化帖子链接、回复 ID、最终决定、主理由、内部枚举标签、时间和分析器版本；任何额外字段（包括正文、用户名、自由文本备注）都会被拒绝。

## 5. 关键文件地图

| 路径 | 职责 |
| --- | --- |
| `public/manifest.json` | 扩展版本、最低浏览器版本、权限和侧栏入口 |
| `src/background.ts` | 活动标签校验、脚本注入、整帖读取编排、会话生命周期、证据跳转兜底 |
| `src/content.ts` | 同源只读请求、DOM 降级解析入口、动态观察、无刷新优先定位 |
| `src/tiebaApiCapture.ts` | 主楼/楼中楼全分页并发读取、去重、覆盖率计算和安全上限 |
| `src/lib/tiebaApi.ts` | 三个贴吧只读请求的构造、签名和响应解析 |
| `src/lib/tiebaTransport.ts` | 只读网络白名单、响应大小/重定向/方法/参数边界 |
| `src/lib/extractor.ts` | legacy 与 SPA DOM 适配器；API 失败时的降级读取 |
| `src/lib/evidence.ts` | 虚拟列表定位、正序控件识别、安全展开控件白名单 |
| `src/lib/session.ts` | 标签页级会话合并、同帖/换帖识别、覆盖信息聚合 |
| `src/messages.ts` | side panel/background/content 的消息协议和错误码 |
| `src/lib/privacy.ts` | 用户别名与敏感字段脱敏、最终隐私守卫 |
| `src/lib/cloud.ts` | 整帖 prompt、请求体、DeepSeek/Qwen 差异、返回协议规范化与关系链校验 |
| `src/lib/cloudPermission.ts` | 固定服务商配置、端点校验、精确 host 权限 |
| `src/sidepanel/bridge.ts` | 侧栏网络调用、权限检查与取消；整帖长请求驻留侧栏 |
| `src/cloudBroker.ts` | 可选权限租约及旧的单线索分析通道；整帖固定权限请求不依赖它驻留 |
| `src/sidepanel/App.tsx` | 主 UI、自动读取/分析、报告和证据卡、设置、记录导入导出 |
| `src/sidepanel/recordStore.ts` | 本地设置、会话 API key 与审核记录存储 |
| `src/lib/threadCloudCache.ts` | 当前浏览器会话内的整帖模型结果/失败缓存 |
| `src/data/reasons.ts` | 16 类、112 条规范理由及稳定 ID |
| `src/lib/records.ts` | 审核记录严格 schema、规范化、导入导出 |
| `scripts/evaluate-corpus.ts` | 脱敏人工语料评估与 500 回复本地基准 |
| `src/test/fixtures/` | 经过脱敏的 DOM/API 测试夹具 |

测试与实现通常成对命名，例如 `src/lib/cloud.ts` 对应 `src/lib/cloud.test.ts`、`src/lib/cloud.deepseek.test.ts` 和 narrative fuzz 测试。修改协议或安全边界时必须同时扩展对应测试。

## 6. 已完成功能

- 贴吧只读接口的整帖主楼与楼中楼分页读取、并发、稳定 ID 去重和覆盖校验。
- legacy/新版 SPA DOM 降级解析，动态内容累积但不宣称完整。
- 16 类 112 条规则库、稳定理由 ID、搜索和规范原文复制。
- 完全由整帖模型结果驱动的风险线索与七段式长文报告。
- Qwen 与 DeepSeek 的 fast/deep 模式差异处理，最长等待时间分别受代码上限约束。
- DeepSeek 常见 JSON 形态兼容，但关键 ID、理由、证据和置信度仍执行严格白名单。
- 把模型 P-id/U-id 还原成可理解的真实楼层、楼中楼父子关系和用户名展示。
- 独立主回复不因楼层相邻、作者相同或话题相似被强行串成争吵链。
- 证据无刷新优先定位、正序切换、虚拟列表扫描、楼中楼安全展开与官方深链兜底。
- 严格最小化审核记录、本地导入导出以及隐私字段拒绝。
- 切帖、切标签、重载、并发读取/跳转和长请求的取消与防串帖机制。

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
4. 确认扩展卡片版本为 `0.3.1`。
5. 打开桌面贴吧帖子并点击扩展图标，侧栏应出现。

每次重新构建后，都要在扩展管理页点击“重新加载”。涉及 content script 的变更，还应对当前测试帖做一次普通刷新，让新脚本接管；这和每次点击证据都刷新不是一回事。

### 7.2 DeepSeek

1. 打开侧栏“设置”。
2. 服务商选择 DeepSeek；端点会固定为官方 API 域名。
3. 核对“模型名称”。源码默认值目前是 `deepseek-v4-pro`，但模型 ID 是否对当前账号可用应以服务商实际返回为准；若 400/404，不要假定默认字符串永远有效。
4. 推荐选择“深度”模式后，由用户本人输入 API 密钥并保存。
5. 首次整帖分析如提示未授权，点击“授权 DeepSeek 并分析”，接受精确的 `api.deepseek.com` 权限。
6. 保持侧栏打开直到返回；深度整帖请求最长可等待 10 分钟。

API 密钥只写入 `chrome.storage.session`，关闭浏览器会话后清除；端点、模型、模式和自动分析开关写入 `chrome.storage.local`。切换服务商会清空内存中的当前密钥，防止跨服务商误发。不要通过终端、日志、截图、测试夹具或交接文档读取/复制用户密钥。

完整快照准备好且自动分析开启时会自动产生一次模型请求和费用。失败不会自动重试；重新点击意味着可能再次计费。

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

以下结果在 2026-08-15、当前工作区源码上实际运行，不是推测：

- `npm run typecheck`：通过。
- `npm test`：27 个测试文件、295 个测试全部通过。
- 最终发布前完整测试中，500 条 SPA 文本回复 DOM 解析用时 1193 ms，低于 3 秒测试阈值。
- 定位链路单独回归：4 个测试文件、84 个测试全部通过（manifest 4、evidence 18、content 7、background 55）。
- `npm run build`：通过；`dist/manifest.json` 为 `0.3.1`，生产产物包括 `background.js`、`content.js`、`sidepanel.js`。
- `npm audit`：生产和开发依赖均为 0 个已知漏洞。
- `npm run evaluate:example`：工具运行成功，但只有 2 个示例案例；其结果只能证明格式和脚本可用，不能证明真实召回率或误报率。

历史上，含“3 秒”真实墙钟门槛的性能测试曾在 MuMu 模拟器或 WindowServer 高占用时超时；本次最新完整测试是绿色的，但后续若仅这一项偶发失败，先检查系统 CPU 竞争，不要立即放宽阈值或跳过测试。

不要夸大的部分：

- 尚未提交至少 30 个真实、人工标注、完全脱敏的私有长帖语料；正式严重争吵召回率 80% 验收没有完成。
- 当前 `0.3.1` 的“无刷新优先定位”完成了自动化测试和生产构建，但交接前没有在一条可控的真实 Chrome/Tabbit 帖子上重新走完整端到端验收。
- 早期版本曾在真实帖子上返回整帖模型报告，但这不能替代当前版本在热门/正序/倒序、主回复/楼中楼、虚拟卸载状态下的重新验收。
- 没有自动化测试能够证明贴吧未改接口、当前账号能看到所有站点数据，或某个 DeepSeek 模型 ID对用户账号持续可用。

## 10. 已知限制和风险

- 三个贴吧端点属于站点现有只读接口，但不是本项目拥有或控制的稳定公开契约；字段、签名、速率限制或访问策略随时可能变化。
- 已删除、审核中、权限不可见或接口不返回的内容无法绕过；数量差额必须继续显示。
- 贴吧顶部“回复数”的统计口径可能不等同于接口返回的稳定回复条数，主楼是否计入也可能造成 1 条差异；应依据覆盖明细解释，不能只比较一个总数。
- 图片、视频、表情图片中的文字不分析。
- 模型可能误解反讽、引用辱骂、熟人玩笑、虚构角色评价或事实真伪；人工复核不可删除。
- 深度模型可能耗时和计费较高；切页、关闭侧栏或切换设置会取消本地等待，但服务商侧请求是否已产生费用由服务商决定。
- DeepSeek 默认模型名是当前项目配置，不是永久兼容保证。
- Manifest 和默认配置会公开当前固定的百炼工作区域名；它不是 API 密钥，但属于可识别的部署端点。迁移或公开复用时应先由仓库所有者确认。
- `src/lib/tiebaApi.ts` 中的 PC 签名常量来自当前网页只读协议，不是个人凭据；它可能触发密钥扫描，也可能随贴吧改版失效。不要把它误当用户 API key，也不要在未验证协议前随意改动。
- 页面内定位依赖贴吧 DOM 与虚拟列表结构；若安全扫描不能验证 PID，官方深链兜底仍可能刷新一次页面。
- 首页风险队列、全吧巡检、OCR、多人协作后台、权限分级和自动处罚尚未实现。
- 仓库目前没有 LICENSE、CI、商店打包配置或正式发布流程；在公开分发前需要明确许可证和隐私说明。

## 11. 隐私与安全约束

后续修改必须保持这些不变量：

- 贴吧请求只允许 `tiebaTransport.ts` 白名单中的三个端点；不要做通用 fetch 代理。
- 不使用 `tabs`、`<all_urls>` 或任意 AI 域名权限来绕过问题。
- 任何 cloud payload 都必须先经过 `privacy.ts`，并继续测试原用户名、手机号、邮箱、证件、QQ、微信不外发。
- 不发送帖子 URL、官方 PID/SPID、精确时间、图片、Cookie 值或密码给模型。
- API key 只能放 `chrome.storage.session`；不得进入 Git、local storage、导出 JSON、错误日志或测试快照。
- 模型返回中的 reply ID 和 reason ID 必须命中本地白名单；不得因“兼容性”而接受模型虚构 ID。
- 公开删帖理由只能使用 `reasons.ts` 原文。
- 审核记录 schema 保持 strict；新增任何持久字段前先做隐私评审和迁移设计。
- 自动管理动作次数必须始终为零。定位只允许排序、滚动、高亮和明确只读展开控件。
- 真实吧友内容只能进入 Git 忽略的 `evaluation/private/`，且必须先人工脱敏；不要提交浏览器导出、HAR、控制台响应或截图中的原文。

## 12. 下一位 Codex 的建议接手顺序

1. 先运行 `git status`、`npm ci`、`npm run typecheck`、`npm test` 和 `npm run build`，建立自己的绿色基线。
2. 在 `chrome://extensions` 加载当前 `dist/`，确认版本、站点权限、service worker 无错误；不要直接修改权限扩大范围。
3. 由用户亲自打开一条用于测试的真实帖子并输入 API key。不要读取、复制或回显密钥。
4. 实测整帖读取：记录贴吧标注数、主层数、楼中楼实取/声明数、不可见差额和图片数；抽查数条作者、正文、楼层、父子关系和时间。
5. 实测模型：确认只有 `readableTextComplete` 快照会发送；网络负载不含原用户名、帖子 URL、官方 ID、精确时间或敏感字段；验证失败不自动重试。
6. 实测报告与证据：检查独立主回复不会被错误串联，P-id 引用都显示可理解的真实楼层和作者。
7. 在热门、正序和倒序分别测试任意主楼与楼中楼定位；确认多数情况不刷新、只安全展开、最终命中 PID。记录任何触发官方兜底的排序模式和目标类型，不要记录正文。
8. 再测试切帖、切网站、标签切换和重载，确认旧结果隐藏、请求取消、没有跨帖点击。
9. 用至少 30 个私有脱敏标注案例做模型质量评估。现有 `evaluate-corpus.ts` 仍调用本地旧分析器，若目标是评估纯 API 模型，需要设计独立、费用可控且不提交原文的新评估器；不要把现有示例指标冒充云模型指标。
10. 完成实机基线后再重构。优先修复可复现问题，并为每个权限、隐私、并发或定位回归补测试。

## 13. 常见故障排查

### “Cannot access contents…”或“未授予贴吧权限”

- 确认当前页面是 `https://tieba.baidu.com/p/<数字>`，不是搜索页、其他域名、浏览器内置页或 HTTP 页面。
- 确认加载的是刚构建的同一个 `dist/`，扩展卡片版本为 `0.3.1`。
- 在扩展管理页重新加载，并对帖子做一次刷新。
- 检查扩展“网站访问权限”是否允许 `tieba.baidu.com`。
- 不要通过新增 `activeTab`、`tabs` 或 `<all_urls>` 掩盖问题。

### “固定 AI 端点权限尚未生效”或“未授予该 AI 端点的网络权限”

- Manifest 更新后必须先重载扩展。
- DeepSeek 是可选权限；必须由用户点击侧栏中的授权按钮，程序化自动授权不会获得有效用户手势。
- 在 Chrome 扩展详情页检查 `api.deepseek.com` 权限是否已授予。
- 若切换了服务商，重新输入该服务商密钥并保存；密钥不会跨服务商保留。

### “整帖只读接口不可用”或自动分析被禁止

- 打开 service worker 和侧栏 DevTools，区分 rate limit、网络、结构解析、帖子身份变化和响应过大。
- 检查 `coverage.apiCoverage`，不要只看总回复数。
- DOM 降级结果可以帮助人工查看，但按设计不能作为完整整帖自动外发。
- 端点字段变动时先更新脱敏夹具和解析测试，不要静默吞掉未知结构。

### 云端 401/403/400、超时或连接中断

- 401/403：让用户重新确认密钥和账号权限，不要要求其把密钥贴到聊天中。
- 400/404：优先核对当前服务商真实模型 ID 和请求字段；尤其不要假设默认 DeepSeek 模型名永久存在。
- 深度模式允许较长等待，必须保持侧栏打开；后台 service worker 不是整帖长请求承载者。
- 失败不会自动重试。人工重试前先说明可能再次计费。
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

- 正常预期是先在页内定位；只有有界扫描、正序切换和安全展开后仍无法验证 PID 才走官方深链。
- 先确认扩展和帖子都在使用新构建脚本。
- 复现时只记录帖子结构、当前排序、主楼/楼中楼类型、楼层和是否有稳定 PID，不复制正文或用户名。
- 检查 content/background 的 jump generation 与 expectedThreadId，不要删除竞态保护来换取表面成功。

### “会话已失效/页面已切换”

这是防串帖机制。返回原帖后重新点击读取即可；不要恢复旧会话并继续保存、定位或外发。

## 14. 发布与仓库注意事项

- 目标仓库：`https://github.com/Morphling0717/Tieba`。
- `.gitignore` 已排除 `node_modules/`、`dist/`、coverage、日志和 `evaluation/private/`；推送前再次检查未跟踪文件和 staged diff。
- 永远不要提交 API key、浏览器存储、HAR、真实回复语料、用户名、完整模型响应或包含它们的截图。
- 提交 `package-lock.json`，以保持依赖可复现。
- 升级版本时至少同步：`package.json`、`package-lock.json`、`public/manifest.json`、`src/manifest.test.ts`、README 中版本说明，然后重建并检查 `dist/manifest.json`。
- `dist/` 当前不提交；交接或测试机必须自行 `npm ci && npm run build`。如果未来改为发布 zip，应另写可重复打包脚本，并决定是否包含 source map。
- 发布前运行完整测试、类型检查、生产构建，再做 Chrome/Edge/Tabbit 至少一项真实端到端验收；自动测试通过不能替代实机验收。
- 项目尚无 LICENSE。公开协作或分发前，请仓库所有者选择明确许可证；不要擅自添加代表所有者法律意图的许可证。
- 贴吧只读接口与规则 PDF 的使用、服务商条款和隐私说明需要由仓库所有者在公开发布前确认。

## 15. 完成交接的判断标准

下一阶段不能只以“模型有返回”或“测试全绿”为完成。最低应同时满足：

- 当前真实帖的接口可见主楼与楼中楼全部分页完成，覆盖缺口与贴吧标注差额解释清楚。
- 一次完整模型请求成功，隐私负载抽查通过，报告结构与证据映射可用。
- 任意模型引用都能从热门/正序/倒序进入正确主楼或父楼，常规目标无刷新优先，楼中楼展开不触碰写操作。
- 切帖、重载、切标签和失败重试不串会话、不重复静默计费。
- 保存并导出的审核记录不含正文、用户名、自由文本或其他隐私字段。
- 全程自动删帖、封禁、发帖和账号操作次数为零。
