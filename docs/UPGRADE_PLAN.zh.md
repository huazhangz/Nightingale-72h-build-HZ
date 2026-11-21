# Nightingale → Agent 升级规划

依据：《Joe 的 Agent 实习路线》（Agent 开发方向）。本仓库承载路线中的 **项目 1（手写 Agent 循环）**、**项目 2（把 Nightingale 升级成 Agent）** 与 **项目 3（给 Agent 做评测）**；三者在这里合成一条可演示、可度量的交付链。

| 路线项目 | 本仓库中的落点 | 说明 |
| --- | --- | --- |
| 1 手写 Agent 循环 | `src/lib/agent/runtime/` | 不用框架，TypeScript 直接调 Messages API：工具定义 → 模型选工具 → 执行 → 回填结果 → 判断停止；最大步数、token 预算、超时、带抖动的重试。它不是练习品，而是项目 2 的生产引擎。 |
| 2 交班摘要 Agent | `src/lib/agent/handover/` + API + UI | 工具 `get_timeline` / `get_notes` / `get_glance_cards` / `create_followup`；权限与 PHI 脱敏放在工具层；「危急结果不可降级」是模型输出后的确定性校验；每条摘要必须带 note id 与原文引用，无出处直接拒绝。 |
| 3 评测 | `evals/` | 多次采样算 pass@k / pass^k；按病例聚类的置信区间；配对检验比较两版提示词；失败归类（选错工具 / 遗漏 / 编造）。评测集来自 PIN / AGREE / DISAGREE 反馈数据 + 对抗用例。 |
| 4 MCP Server（FRED） | 不在本仓库 | 独立作品，数据源与本项目无关。 |
| 5 数据分析 Agent / 开源 PR | 不在本仓库 | 路线标注为可选。 |

---

## 1. 现状评估（升级前基线）

逐项实测，不看 README：

| 检查 | 结果 | 影响 |
| --- | --- | --- |
| `npx vitest run` | 65 / 65 通过 | 测试基线可用 |
| `next build` | **失败**：`app/api/highlights/[id]/feedback/route.ts` 引入路径少一级 | 主分支无法生产部署 |
| `tsc --noEmit` | **6 个类型错误**（glance.ts、revision.ts、一处测试） | 类型系统没有守住接口 |
| 规格 v1.0 §2 NegEx / 既往史降级 | **未实现**（技术文档也承认只是“specified”） | “Patient denies chest pain” 会被标成 CRITICAL；Agent 的危急护栏会把假阳性强行塞进摘要 |
| 鉴权 | 只信任请求头 `x-user-id`，任何人可冒充任意用户 | Agent 接口会花钱并把 PHI 送往外部模型，不能建立在可伪造身份上 |
| 患者登录姓名比对 | 双向 `includes` 子串匹配，“El” 能匹配 “Elena Rossi” | 身份校验过宽 |
| CI | 无 | 回归靠人工 |
| LLM | 全项目没有一处调用模型 | 路线指出的最大缺口 |

## 2. 目标架构

```
CareShell (Glance 页)                         evals/run.ts (CLI)
  └─ HandoverPanel ──POST /api/patients/:id/handover──┐      │ 同一入口
                                                      ▼      ▼
                                   runHandoverAgent(actor, patientId, …)   ← 生产与评测共用
                                     │  RBAC：仅 STAFF/CLINICIAN/ADMIN，诊所隔离
                                     │  AgentRun 落库（状态、用量、轨迹元数据，不含原文）
                                     ▼
                     runAgentLoop()  手写循环（runtime/）
                       ├─ ModelClient ──► Anthropic Messages API（重试/预算/超时在循环里）
                       └─ ToolRegistry（zod 校验入参，错误以 is_error 回填）
                            ├─ get_glance_cards   ┐
                            ├─ get_timeline       │ 绑定到本次会话的 actor + patient：
                            ├─ get_notes          │ 模型不能传 patient_id，越权数据不可达；
                            ├─ create_followup    │ 输出一律经 redactPhi；写操作只生成“提议”
                            └─ submit_handover_summary（终止工具，strict schema）
                                     ▼
                     guardrails.ts  确定性后校验（不靠提示词）
                       1 结构校验  2 引用必须指向本次读过、且有权限的笔记
                       3 引文必须是该笔记原文子串  4 否定冲突检测（NegEx 复用）
                       5 危急结果：缺失则注入、降级则升回 CRITICAL，并标注来源
                       6 输出 PHI 再脱敏
                                     ▼
                     摘要 + 护栏报告 + 待确认的随访提议（人工接受后才写入 CareAction）
```

## 3. 关键设计决策与取舍

| 决策 | 选择 | 放弃的方案 | 理由 |
| --- | --- | --- | --- |
| Agent 循环 | 手写循环（Messages API） | SDK Tool Runner；Managed Agents | 路线项目 1 的要求；需要在循环里插入证据台账、终止工具、预算与轨迹记录；PHI 场景下 Managed Agents 目前不在 HIPAA/ZDR 覆盖内 |
| 权限边界 | 工具绑定会话（actor + patient），模型无 `patient_id` 参数 | 让模型传 id、工具里再校验 | 能力裁剪比事后校验更强：模型连“请求别的病人”的接口都没有；Agent 继承当前用户权限（委托），不是服务账号 |
| 写操作 | `create_followup` 只生成提议，临床人员点“接受”后才创建 CareAction | Agent 直接写库 | 临床记录不可由模型单方面修改；人在回路，且可审计 |
| 结构化输出 | 终止工具 `submit_handover_summary` + `strict: true` | `output_config.format` | 与工具循环天然兼容；Opus 5.5 不允许强制 `tool_choice`，用提示 + 一次提醒兜底 |
| 防幻觉 | 每条陈述必须带 `note_id + 原文引文`，代码校验引文是原文子串 | 只要求 note id | id 可以蒙对，原文子串蒙不对；校验完全确定 |
| 危急护栏 | 模型输出后由代码强制，注入/升级的条目标注“安全规则添加” | 写在系统提示词里 | 提示词可被注入或忽略；与反馈学习模块的“危急不降级”是同一不变量 |
| 引擎假阳性 | 在源头修：实现 NegEx、既往史降级，并新增“假设/安全网语境”降级（规格 v1.1） | 让模型“反驳”危急标记 | 护栏会放大引擎假阳性；修引擎是确定性的、可测试的 |
| 评测框架 | 自建 TypeScript 评测器 | promptfoo / Inspect AI | 必须调用与生产相同的入口（带 RBAC 的工具 + 夹具数据库）；统计部分（聚类 CI、配对置换检验）这些框架不提供，正是要展示的能力 |
| 评分对象 | 评“模型原始输出”（护栏前），护栏后另报安全指标 | 只评最终输出 | 护栏会掩盖模型失败；分开报才能同时说明“模型多可靠”和“护栏兜住了多少” |
| 模型 | 默认 `claude-opus-5-5`，`effort` 可配置 | — | 可通过环境变量切换；比较两个模型是用户的成本决定 |

## 4. 分阶段计划与验收标准

### Phase 0 基线修复
- 修复 feedback 路由路径；`tsc --noEmit` 清零；`next build` 通过。
- 高亮引擎：NegEx（规格列出的 5 类触发词，5 词窗口，列表并列项不占窗口）、既往史降级为 INFO、假设/安全网语境降级（v1.1，写入规格文档）、补齐规格中缺失的危急词（anaphylaxis、severe respiratory distress）与生命体征阈值（SpO2 < 90%、BP > 180/110）。现有词条的分级不动，规格与实现的分级差异列为待决事项（这是临床策略决定，不由工程方单方面改）。
- 鉴权：登录签发 HMAC 签名会话（HttpOnly Cookie）；生产环境禁用裸 `x-user-id`；开发/测试保留以兼容演示。
- 患者姓名改为规范化后精确匹配（保留别名表）。
- GitHub Actions：install → db push → tsc → test → build → 离线评测冒烟。
- **验收**：tsc 0 错误、全部测试通过、生产构建通过、新增引擎测试覆盖规格每条规则。

### Phase 1 Agent 运行时（项目 1）
- `ModelClient` 接口 + Anthropic 实现（SDK 自带重试关闭，重试由循环掌控并记录次数）。
- 循环：`max_steps`、累计 token 预算、整体截止时间、`stop_reason` 全分支处理（`end_turn` / `tool_use` / `max_tokens` / `refusal` / `pause_turn`）、并行工具结果合并为一条 user 消息、助手消息原样追加（兼容 preserved thinking）。
- 重试：429 / 5xx / 529 / 连接错误，指数退避 + 全抖动，尊重 `retry-after`；4xx 立即失败。
- **验收**：用脚本化假模型的单元测试覆盖每个停止分支、重试、预算、非法工具入参。

### Phase 2 交班摘要 Agent（项目 2）
- 工具、证据台账、终止工具、两版提示词（v1 基线 / v2 改进）。
- 护栏六步（见架构图），输出 `GuardrailReport`。
- Prisma：`AgentRun`、`AgentFollowupProposal`；审计日志不含正文。
- API：生成摘要、查看历史、接受/驳回提议；未配置 API key 时返回 503 `AGENT_NOT_CONFIGURED`；按用户限流。
- UI：Glance 页 `HandoverPanel`，引用可跳转到时间线原文，护栏干预可见，五种语言。
- **验收**：RBAC 测试（患者 403、跨诊所 403、STAFF 看不到未发布的医生草稿）、护栏单测（伪造引用被拒、危急缺失被注入、降级被升回、PHI 被抹）、端到端测试（假模型走完整链路并落库）。

### Phase 3 评测（项目 3）
- **用例**：①反馈派生——把 PIN / AGREE 的高亮转成“必须覆盖”，DISAGREE 的非危急高亮转成“不应标为危急”（危急项受下限保护，仍须覆盖）；②对抗用例——否定陷阱、安全网语句陷阱、笔记内提示注入、同诊所跨病人泄漏、STAFF 视角的医生草稿、空病历、新旧笔记冲突、已解决/未解决的随访。种子数据没有真实反馈，反馈由作者人工标注并在用例中注明来源。
- **运行器**：变体 × 用例 × 重复次数；独立评测库；可断点续跑；`results.jsonl` / `errors.jsonl`（基础设施错误不计入模型分数）/ 完整轨迹；记录实际服务的模型、重试次数、usage、延迟。
- **统计**：pass@k、pass^k 无偏估计；按病例聚类的 t 区间 + 聚类 bootstrap；两版提示词的配对差异（配对 t、配对 bootstrap、精确符号翻转置换检验、单次采样时用 McNemar 精确检验）；报告噪声下限与最小可检测效应；多变体时 Holm 校正。
- **失败归类**：选错工具 / 遗漏信息 / 编造内容 / 危急降级 / 未提交 / 步数超限 / 拒答。
- **评分器自检**：满分基线（oracle）应接近 100%，空答案基线（null）应全部失败，否则评分器有 bug。
- **验收**：统计函数单测对齐已知数值；离线模拟模型跑通全流程并出报告；CI 冒烟通过。真实模型评测需要 API key 和费用确认（见 §6）。

### Phase 4 文档与交付
- `docs/AGENT_DESIGN.md`、`docs/EVALUATION.md`、README 更新；每个阶段单独提交并推送。

## 5. 评测成本估算（真实模型）

单次 Agent 运行约 4–6 次模型调用，输入约 2–3 万 token（系统提示与工具定义可缓存），输出约 2–4 千 token。按 Opus 5.5（$4 / $20 每百万 token）估算约 $0.12–0.20 / 次。

| 配置 | 运行次数 | 估算费用 |
| --- | --- | --- |
| 18 用例 × 3 次 × 2 版提示词 | 108 | 约 $13–22 |
| 18 用例 × 5 次 × 2 版提示词 | 180 | 约 $22–36 |

先跑 1 个用例 × 1 次核对真实单价，再决定规模。

## 6. 风险与待决事项

1. **规格与实现的分级差异**：规格把 fever、hyperpyrexia 列为 MEDIUM，代码里是 HIGH / CRITICAL；allergy 规格属 INFO，代码是 HIGH。会影响危急下限的覆盖面，需要产品负责人（你）决定。
2. **没有真实临床反馈数据**：评测里的 PIN / AGREE / DISAGREE 是作者标注的合成数据，结论只代表这些用例。
3. **真实评测需要 Anthropic API key 和费用确认**；离线部分（模拟模型、评分器自检、统计）不依赖 key。
4. 演示鉴权依旧不是生产级 SSO；签名会话只解决“可伪造身份”这一个问题。

## 7. 面试讲述要点

- **约束**：PHI、诊所隔离、危急结果不可降级、临床记录不可被模型直接改写。
- **取舍**：手写循环换可控性；能力裁剪的工具换安全；只生成提议换人在回路；确定性护栏换不依赖提示词；评“护栏前”的原始输出换诚实的可靠性数字。
- **证据**：pass@k 与 pass^k 的差距说明稳定性；配对检验说明 v2 提示词的提升是否显著、置信区间多宽；失败归类说明下一步该改哪里。
