# Agent 题全集 -- 基于小红书整理

> 数据来源：小红书搜索「agent 面试」，筛选半年内高赞帖子，共提取 7 篇面经原文。
> 生成时间：2026-03-17

## 数据来源

| 帖子标题 | 作者 | 点赞 | 链接 |
|---------|------|------|------|
| 字节agent开发实习一面 | 我会成为传奇耐面王吗 | 901 | https://www.xiaohongshu.com/explore/69aa551f0000000028021738 |
| 大模型应用开发-agent相关面经 | 不爱秋招爱整理 | 1194 | https://www.xiaohongshu.com/explore/697f48d5000000000e03c1d5 |
| 字节 大模型应用开发 一面面经 | Devs | 143 | https://www.xiaohongshu.com/explore/69b6b81d000000002800a800 |
| 2026大模型Agent面试全攻略(下) | AI实战领航员 | 81 | https://www.xiaohongshu.com/explore/69b4f22b000000002300777d |
| 今天面试了一个C9的agent应用方向 | AI speaker | 669 | https://www.xiaohongshu.com/explore/66e1a1770000000012012e92 |
| 淘天AI Agent二面面经 | 老夏聊编程 | 37 | https://www.xiaohongshu.com/explore/69b132c50000000008033411 |
| agent开发外包面试常用题 | AI折腾哥 | 82 | https://www.xiaohongshu.com/explore/693199e1000000001e015154 |

---

## 一、Agent 核心概念与架构设计

### Q1: Bot 和 Agent 的区别是什么？

**答：**

| 维度 | Bot | Agent |
|------|-----|-------|
| 决策能力 | 基于规则或固定流程，不具备自主决策 | 能根据目标自主规划、决策和执行 |
| 工具使用 | 通常不调用外部工具，或只有预设的固定接口 | 动态选择和调用工具（Function Calling） |
| 记忆 | 无状态或简单的 session 级记忆 | 具备短期记忆（对话上下文）和长期记忆（跨会话知识） |
| 规划 | 无规划能力，逐步响应 | 能将复杂任务分解为子任务并规划执行顺序 |
| 反思 | 无 | 能评估自身输出质量并自我纠错 |

核心区别：Agent = LLM + 记忆 + 工具 + 规划。Agent 不仅能对话，还能感知环境、自主决策、执行动作并根据反馈调整策略。

### Q2: Agent 的记忆、工具调用、知识库检索等关键组件是如何实现的？

**答：**

- **记忆**：短期记忆通过对话历史（Message List）存储在上下文中；长期记忆通过向量数据库或 KV 存储持久化，检索时用 embedding 相似度匹配。典型实现如 LangChain 的 ConversationBufferMemory（短期）和 VectorStoreRetrieverMemory（长期）。
- **工具调用**：通过 Function Calling 机制实现。将可用工具以 JSON Schema 描述注入系统提示词，LLM 判断何时需要调用工具并输出结构化的调用参数（函数名 + 参数 JSON），框架层解析后执行实际函数，再将结果返回给 LLM。
- **知识库检索（RAG）**：文档经切片、embedding 后存入向量数据库。用户查询时先做 embedding，在向量库中检索 Top-K 相似片段，将检索结果拼接到 Prompt 中作为上下文，再由 LLM 生成最终回答。

### Q3: 系统中的 Agent 包含哪些具体状态？

**答：**

典型 Agent 状态包括：

1. **对话状态**：当前对话历史（messages）、会话 ID
2. **任务状态**：当前任务目标、已完成的子任务、待执行步骤
3. **工具调用状态**：当前是否在等待工具返回、上一次工具调用的结果
4. **记忆状态**：短期记忆缓冲区、长期记忆索引
5. **规划状态**：任务计划（plan）、当前执行到哪一步
6. **元数据**：用户 ID、租户 ID、权限信息、配置参数

在 LangGraph 中，这些状态统一定义为 TypedDict，每个节点的执行都会读取和更新状态对象。

### Q4: 什么是 Agent 的反思（Reflection）机制？

**答：**

反思机制让 Agent 在输出后自我评估质量并纠正错误。实现方式：

1. **自评估**：生成回答后，再用 LLM 评价该回答是否正确、完整、安全，不满意则重新生成。
2. **工具验证**：调用工具后检查返回结果是否合理（如 API 返回 404 则自动换策略）。
3. **多步反思**：在 LangGraph 中设置 Reflection Node，每步执行后由一个独立的评估节点判断是否需要回退。
4. **Critic Agent**：引入专门的评审 Agent 来检查主 Agent 的输出，类似 code review。

典型应用：心理咨询 Agent 在回答前检查语气是否专业；代码生成 Agent 在提交前运行测试。

### Q5: 长期记忆和短期记忆在设计上有什么区别？

**答：**

| 维度 | 短期记忆 | 长期记忆 |
|------|---------|---------|
| 存储位置 | LLM 上下文窗口（in-context） | 外部存储（向量数据库、KV 存储） |
| 生命周期 | 单次对话 | 跨会话持久化 |
| 容量 | 受 context window 限制（如 128K tokens） | 理论无限 |
| 读取方式 | 直接在 prompt 中 | 需要检索（embedding 相似度） |
| 写入方式 | 自动追加对话历史 | 需要显式提取和存储关键信息 |
| 典型内容 | 当前对话的消息列表 | 用户偏好、历史事实、学到的知识 |

**本质区别**：短期记忆是"工作记忆"（working memory），容量小但访问快；长期记忆是"参考记忆"（reference memory），容量大但需要检索。

### Q6: 在多轮对话 Agent 中，如何处理"状态爆炸"和"上下文溢出"？

**答：**

1. **State Schema 严格定义**：使用 TypedDict 只保存核心变量，避免状态对象无限膨胀。
2. **对话历史裁剪（Trim Strategy）**：不是简单截断，而是基于语义重要性保留。通常保留 System Prompt + 最近 N 轮对话 + 当前任务目标。
3. **摘要缓冲（Summary Buffer）**：将旧的对话压缩为摘要放在上下文头部。实现方式：每当对话历史超过阈值，调用 LLM 将前面部分总结为一段话。
4. **分层记忆**：核心信息放 context（短期），背景知识放向量库（长期），只在需要时检索。
5. **滑动窗口**：只保留最近 K 轮完整对话，更早的只保留摘要。

---

## 二、Function Calling 与工具调用

### Q7: Function Call 的原理是什么？模型生成的 JSON 如何触发代码执行？

**答：**

**原理**：Function Calling 是 LLM 经过专门训练后获得的能力，模型在推理时不仅能生成自然语言，还能输出结构化的函数调用指令。

**完整流程**：

1. **定义工具**：开发者以 JSON Schema 格式描述可用函数（名称、参数类型、描述）
2. **注入提示词**：将工具描述附加到 system prompt 或 API 请求的 tools 字段
3. **模型决策**：LLM 根据用户意图判断是否需要调用工具，如果需要则输出特殊格式的 JSON（包含 function name 和 arguments）
4. **框架解析**：应用层解析模型输出中的 function_call 结构，提取函数名和参数
5. **执行函数**：根据函数名映射到实际代码并执行，传入解析后的参数
6. **结果回传**：将函数执行结果以 tool message 形式追加到对话历史
7. **继续生成**：LLM 基于工具返回结果生成最终回答

### Q8: 如何保证 Agent 调用工具（Function Calling）的可靠性？

**答：**

- **语法层面**：使用 JSON Mode 或强类型约束（如 OpenAI 的 strict mode），确保输出是合法 JSON。
- **逻辑层面**：对高风险操作引入 Human-in-the-loop 确认机制（如删除数据、转账）。
- **重试与自修复**：如果 LLM 生成的参数不合法（如类型错误），将报错信息返回给 LLM，让其 Self-heal 重新生成。
- **参数校验**：在执行前对参数做 Schema 验证和业务规则检查。
- **超时与熔断**：对外部 API 调用设置超时，失败后走降级逻辑。
- **日志与审计**：记录每次工具调用的输入输出，便于回溯问题。

### Q9: Agent 发生"工具调用"时，SSE 推送的事件结构中通常包含哪些字段？

**答：**

典型的 SSE 事件流在工具调用阶段包含：

```
event: tool_call_start
data: {"tool_call_id": "call_xxx", "function": {"name": "search", "arguments": ""}}

event: tool_call_delta
data: {"tool_call_id": "call_xxx", "function": {"arguments": "{\"query\": \"天气\"}"}}

event: tool_call_end
data: {"tool_call_id": "call_xxx"}

event: tool_result
data: {"tool_call_id": "call_xxx", "content": "北京今天晴，25度"}

event: message_delta
data: {"content": "根据查询结果，北京今天..."}
```

关键字段：`tool_call_id`（关联调用与结果）、`function.name`、`function.arguments`、`content`（结果）。

### Q10: Agent 工具调用的完整业务流程是怎样的？

**答：**

1. 用户发送消息 -> 后端构建 prompt（含工具描述 + 对话历史）
2. 调用 LLM API（streaming）
3. LLM 返回 tool_call 类型的 chunk -> SSE 推送给前端（显示"正在调用 XX 工具..."）
4. 后端解析完整的 function_call JSON
5. 执行实际工具函数（如查数据库、调 API）
6. 将结果以 tool message 追加到对话历史
7. 再次调用 LLM -> LLM 基于工具结果生成最终回答
8. 流式推送最终回答给前端

---

## 三、RAG（检索增强生成）

### Q11: RAG 的主要模式和工作流程是怎样的？

**答：**

**主要模式**：

| 模式 | 特点 |
|------|------|
| Naive RAG | 最基础：检索 -> 拼接 -> 生成 |
| Advanced RAG | 加入查询改写、重排序、多路召回 |
| Modular RAG | 模块化设计，每个环节可独立优化替换 |
| Agentic RAG | Agent 自主决定何时检索、检索什么、是否需要多次检索 |

**标准工作流**：

1. **文档处理**：加载 -> 切片 -> Embedding -> 存入向量数据库
2. **查询处理**：用户问题 -> 查询改写（可选） -> Embedding
3. **检索**：在向量库中检索 Top-K 相似片段（可结合 BM25 做混合检索）
4. **重排序**：用 Cross-Encoder 对候选片段做精排
5. **生成**：将检索结果 + 原始问题组装为 prompt，调用 LLM 生成回答

### Q12: Agent 一般在什么阶段查询向量知识库？通过什么方式查询？

**答：**

Agent 通常将"知识库检索"包装为一个 Tool，在 LLM 判断当前问题需要外部知识时，通过 Function Calling 自动触发。

**标准输入**：查询文本（query string），可选参数包括 top_k、过滤条件（metadata filter）。
**标准输出**：检索到的文档片段列表，每个片段包含 content（文本内容）、metadata（来源、页码等）、score（相似度分数）。

### Q13: RAG 中检索模块召回错误结果时如何处理？

**答：**

1. **查询改写**：对用户原始查询做同义词扩展、意图拆解、HyDE（让 LLM 先生成假设性答案再用它去检索）。
2. **重排序（Reranking）**：使用 Cross-Encoder 模型对 Top-K 结果做精排，过滤语义不相关的片段。
3. **混合检索**：结合向量检索（语义匹配）和 BM25（关键词匹配），互补弱点。
4. **Metadata 过滤**：利用文档元数据（时间、类别、来源）做前置筛选。
5. **置信度阈值**：设置最低相似度分数，低于阈值的不纳入上下文。
6. **反馈循环**：如果生成质量低，自动触发第二轮检索（换关键词或扩大范围）。

### Q14: RAG 出现漏召的情况如何优化检索模块？

**答：**

- **优化切片策略**：使用递归字符切片（按段落、句子自然边界切分）而非固定长度，保持语义完整性。增加 chunk overlap。
- **多路召回**：同时使用向量检索 + BM25 + 知识图谱检索，合并去重。
- **查询扩展**：将一个查询扩展为多个子查询（如用 LLM 生成 3 个不同角度的改写），每个子查询分别检索后合并。
- **父文档检索**：命中子片段后，返回其父文档（更大上下文），避免因切片过细丢失信息。
- **Embedding 模型升级**：换用更好的 embedding 模型（如 BGE-M3 支持多语言和多粒度）。
- **索引优化**：对高频查询建立专用索引，对长尾查询做 fallback 策略。

### Q15: 如何评估 RAG 系统的效果？有哪些评估指标？

**答：**

常用框架：**Ragas**、**TruLens**

| 指标 | 含义 |
|------|------|
| Context Precision | 检索到的片段中有多少是真正相关的 |
| Context Recall | 应该被检索到的片段实际检索到了多少 |
| Faithfulness | 生成的回答是否忠实于检索到的上下文（不编造） |
| Answer Relevancy | 回答与原始问题的相关度 |
| Answer Correctness | 回答是否与标准答案一致 |

**Ragas 评测中如果检索精度高但答案相关性低**，最可能的瓶颈在生成环节：LLM 虽然拿到了正确上下文，但没有正确利用它。原因可能是 prompt 模板设计不当、上下文过长导致 Lost-in-the-middle，或 LLM 能力不足。

### Q16: 在 RAG 中，递归字符切片相比固定长度切片优势在哪？

**答：**

- **固定长度切片**：按字符数硬切，可能把一句话、一段逻辑切断，导致语义碎片化。
- **递归字符切片**：按层级分隔符（`\n\n` -> `\n` -> `. ` -> ` `）递归切分，优先在自然段落边界断开，只有当片段仍然过长时才降级到更小的分隔符。

优势：保持语义完整性，切片边界对齐自然语言结构，检索时相关性更高，LLM 理解也更容易。

### Q17: 混合检索里 BM25 是在全文上做还是在特定字段上做？

**答：**

取决于场景：

- **全文 BM25**：适合通用问答，覆盖面广但噪声多。
- **字段级 BM25**：适合结构化文档（如 PDF 表格解析后的 Key-Value 字段），在特定字段上做 BM25 精度更高。例如对 MinerU 解析出的字段（标题、摘要、关键词）做 BM25 检索。
- **工程实践**：通常两者结合，用字段级 BM25 做精确匹配，全文 BM25 做兜底，再与向量检索做 RRF（Reciprocal Rank Fusion）融合。

### Q18: 在 Milvus 中使用多个 Collection 还是分区（Partition）效率高？

**答：**

- **多个 Collection**：每个 Collection 有独立的 Schema 和索引。适合不同类型的文档（如 FAQ vs 技术文档，Schema 不同）。开销大，不适合数量多时的场景。
- **分区（Partition）**：同一 Collection 内按条件（如租户 ID、文档类别）划分，共享 Schema 和索引。适合只需要在特定子集中检索的场景，查询时指定 partition 可大幅减少扫描范围。

结论：如果 Schema 相同且只是需要按条件过滤检索，使用分区效率更高；如果数据结构差异大，才用多个 Collection。

### Q19: 知识库运营（正确性、及时性、一致性）如何解决？

**答：**

- **正确性**：引入人工审核流程，设置内容更新审批机制；用 LLM 自动检测矛盾信息并标记。
- **及时性**：建立增量更新管道，源数据变更时自动重新切片和 embedding；对时效性强的内容设置过期时间。
- **一致性**：统一数据源（Single Source of Truth），同一事实不在多处维护；用版本号追踪文档变更。
- **监控**：定期用评估集跑 RAG 质量指标，发现退化及时告警。

---

## 四、MCP 与 Multi-Agent

### Q20: MCP 的交互流程是怎样的？Agent 如何与 MCP Server 连接通信？

**答：**

MCP（Model Context Protocol）是 Anthropic 提出的标准化协议，让 LLM 应用以统一方式连接外部工具和数据。

**交互流程**：

1. **发现**：Client 连接 MCP Server，获取可用工具列表（tools/list）
2. **调用**：Agent 决定调用某工具时，Client 向 MCP Server 发送 tools/call 请求（含工具名 + 参数）
3. **执行**：MCP Server 执行实际操作（查数据库、调 API 等）
4. **返回**：Server 返回执行结果给 Client
5. **继续**：Client 将结果返回给 LLM 继续生成

**通信方式**：

- **stdio**：通过标准输入输出通信，适合本地进程，安全隔离好
- **SSE（HTTP）**：通过 HTTP Server-Sent Events，适合远程服务
- **Streamable HTTP**：最新传输方式，支持流式响应

### Q21: 主流 Multi-Agent 框架有哪些？状态同步难点在哪？

**答：**

**主流框架**：
- **LangGraph**：基于图的状态机，支持循环和条件分支
- **CrewAI**：基于角色的多 Agent 协作框架
- **AutoGen**：微软的多 Agent 对话框架
- **Swarm**：OpenAI 的轻量级 Agent 编排

**状态同步难点**：
1. **一致性**：多个 Agent 并行修改共享状态时的冲突解决
2. **可见性**：Agent A 修改的状态，Agent B 何时能看到
3. **回滚**：某个 Agent 执行失败，如何回退到之前的一致状态
4. **序列化开销**：状态对象随迭代膨胀，序列化/反序列化变慢
5. **死锁**：多 Agent 互相等待对方的输出

### Q22: 谈谈对 A2A 通信的理解。如何防止两个 Agent 陷入递归对话？

**答：**

A2A（Agent-to-Agent）是 Google 提出的 Agent 间通信协议，让不同厂商的 Agent 互相发现、协商和协作。

**防止递归对话的策略**：
1. **最大轮次限制**：设置对话最大回合数（如 max_turns=10），超过则强制终止
2. **收敛检测**：检测连续 N 轮对话内容高度相似（如余弦相似度 > 0.95），判定为死循环并退出
3. **Supervisor Agent**：引入协调者角色，由其决定何时终止子 Agent 对话
4. **单向委托**：设计为请求-响应模式而非自由对话，避免双向递归
5. **状态标记**：在状态中记录已访问的 Agent，避免重复调用同一 Agent

### Q23: LangGraph 中"节点"和"边"与传统工作流有何不同？

**答：**

- **传统工作流**：节点是固定的处理步骤，边是静态的连接关系，流程在设计时就完全确定。
- **LangGraph**：
  - **节点（Node）**：每个节点是一个函数，接收和返回状态对象。节点内部可以调用 LLM，因此行为是动态的。
  - **条件边（Conditional Edge）**：边的走向由 LLM 输出决定（如根据分类结果走不同分支），而非预设。
  - **支持循环（Cycles）**：这是与 DAG 工作流最大的区别。Agent 可以反复执行"思考-执行-反思"的循环直到达成目标。

### Q24: LangGraph 状态对象怎么设计？如何避免多轮迭代中序列化过慢？

**答：**

**设计原则**：
- 使用 TypedDict 或 Pydantic 模型定义严格的 Schema
- 只存核心变量，避免存大型中间结果
- 可变字段（如 messages）使用 Annotated 类型定义 reducer 函数

**避免序列化过慢**：
1. **精简状态**：只保留必要字段，中间结果写入外部存储（如 Redis）
2. **增量更新**：只序列化变更的部分而非整个状态
3. **消息裁剪**：对 messages 列表设置最大长度，超出后自动摘要
4. **异步 checkpoint**：状态持久化（如 SQLite、Postgres）异步执行，不阻塞主流程

---

## 五、大模型基础

### Q25: LoRA 高效参数微调的原理是什么？为什么要用低秩分解？

**答：**

**原理**：LoRA（Low-Rank Adaptation）冻结预训练模型的全部参数，在每个 Transformer 层的权重矩阵旁添加一对低秩矩阵 A 和 B。原始权重 W 不变，微调时只训练 W + BA（其中 B 的维度为 d x r，A 为 r x d，r 远小于 d）。

**为什么低秩**：
1. **参数高效**：大模型权重矩阵通常是 4096x4096，直接微调有 1600 万参数。低秩分解后 r=16 时只有 4096x16x2 = 13 万参数，减少 99%。
2. **理论依据**：研究表明预训练模型在下游任务微调时，权重变化矩阵的有效秩很低（intrinsic rank），大部分变化集中在少数几个方向上。
3. **实践优势**：显存占用低，可以在消费级 GPU 上微调大模型；多个 LoRA adapter 可以共享基座模型，按需切换。

### Q26: DPO 训练中模型输出变长是什么原因？如何解决？

**答：**

**原因**：DPO（Direct Preference Optimization）训练时，如果偏好数据中 chosen（好的回答）普遍比 rejected（差的回答）长，模型会学到"更长 = 更好"的虚假关联，导致输出越来越长。

**解决方法**：
1. **长度归一化**：在 DPO loss 中对 log probability 做长度归一化
2. **数据平衡**：确保 chosen 和 rejected 的长度分布相近
3. **长度惩罚**：在 reward 中加入长度惩罚项
4. **SimPO**：改用 SimPO 等改进算法，天然包含长度归一化

### Q27: 大模型出现复读机现象的原因和解决方法？

**答：**

**原因**：
1. **训练数据中的重复模式**：如果训练数据包含大量重复结构，模型会学到重复生成的倾向
2. **解码策略问题**：greedy decoding 容易陷入重复循环
3. **注意力退化**：长文本生成时，注意力逐渐集中在最近生成的 token 上，形成正反馈循环

**解决方法**：
1. **Repetition Penalty**：在采样时对已出现的 token 施加惩罚
2. **Frequency/Presence Penalty**：降低高频 token 的概率
3. **Temperature + Top-p 采样**：增加随机性，打破重复循环
4. **后处理检测**：检测到连续重复片段时强制停止或 re-sample

### Q28: SFT 微调后模型通用能力遗忘（Catastrophic Forgetting）如何处理？

**答：**

1. **数据混合**：SFT 数据中混入一定比例（如 10-20%）的通用任务数据
2. **学习率控制**：使用更小的学习率，减少对原始权重的扰动
3. **LoRA 微调**：只训练低秩增量，基座模型参数不变，天然缓解遗忘
4. **渐进训练**：先在通用数据上 warm-up，再逐步过渡到专用数据
5. **正则化**：如 EWC（Elastic Weight Consolidation），对重要参数的变化加惩罚
6. **评估监控**：在微调过程中同步跑通用 benchmark，发现退化及时停止

### Q29: vLLM 的 PagedAttention 原理？

**答：**

**问题**：传统 KV Cache 为每个请求分配连续的显存空间，导致显存碎片化和浪费（预分配最大长度但实际用不完）。

**PagedAttention**：借鉴操作系统的虚拟内存分页思想：

1. 将 KV Cache 切分为固定大小的 Block（如每个 Block 存 16 个 token 的 KV）
2. 不要求物理内存连续，通过 Block Table 映射虚拟块到物理块
3. 按需分配：生成新 token 时才分配新 Block
4. **Copy-on-Write**：多个请求共享相同的 prompt 前缀时，共享同一组 Block，只在分叉时复制

**优势**：显存利用率从约 50% 提升到 95%+，同时支持更大批次的并发推理。

### Q30: 如果用户 Prompt 特别长导致上下文窗口溢出，除了截断还有哪些策略？

**答：**

1. **摘要压缩**：用 LLM 将长 prompt 压缩为更短的摘要
2. **层级检索**：不把所有信息塞进 prompt，而是通过 RAG 按需检索相关部分
3. **Map-Reduce**：将长文本切分，分别处理每段，再汇总结果
4. **滑动窗口**：只保留最近的上下文窗口，历史信息存外部记忆
5. **Prompt 压缩工具**：如 LLMLingua，通过删除冗余 token 压缩 prompt 到原来的 1/5 而保持语义
6. **选择长上下文模型**：换用支持 128K/1M 上下文的模型

### Q31: 大模型出现幻觉（Hallucination），在 Prompt 层面或后处理层面有什么方法？

**答：**

**Prompt 层面**：
1. 明确指令"只基于给定信息回答，不知道就说不知道"
2. 提供结构化的上下文（带来源标注）
3. 使用 CoT（Chain-of-Thought）让模型先推理再给结论
4. Few-shot 示例中包含"无法回答"的案例

**后处理层面**：
1. **事实核查**：将回答中的关键事实用检索验证
2. **一致性检查**：多次采样同一问题，如果回答不一致说明可能存在幻觉
3. **置信度过滤**：检查生成 token 的概率分布，低置信度部分标记为不确定
4. **引用追溯**：要求模型生成时附带引用来源，无法对应来源的内容标记为潜在幻觉

---

## 六、工程实践

### Q32: SSE（Server-Sent Events）在前后端是如何交互的？

**答：**

**后端**：
- 使用流式接口（如 FastAPI 的 StreamingResponse），Content-Type 为 `text/event-stream`
- 每个事件格式为 `data: {json}\n\n`，按 token 或 chunk 逐步推送

**前端**：
- 使用 EventSource API 或 fetch + ReadableStream
- 解析每个 SSE 事件，逐步渲染到 UI（打字机效果）
- 监听 `error` 事件做断线重连

**数据格式**：通常使用 OpenAI 兼容的格式：
```json
data: {"choices": [{"delta": {"content": "你好"}}]}
data: {"choices": [{"delta": {"content": "世界"}}]}
data: [DONE]
```

### Q33: 如何设计多模型支持架构？多租户下的模型热切换？

**答：**

**架构设计**：
1. **统一抽象层**：定义 LLMProvider 接口（chat/complete/embed），各模型实现该接口
2. **路由层**：根据租户配置、任务类型、模型可用性选择具体模型
3. **配置中心**：每个租户的模型配置存数据库，支持动态修改

**热切换**：
- 配置变更通知：通过 webhook 或轮询配置中心
- 无状态设计：每次请求独立读取配置，不缓存模型实例
- 连接池：对 API 类模型维护连接池，切换时只更换路由目标
- 多租户之间相互独立：一个租户切换模型不影响其他租户

### Q34: 安全护栏（Guardrails）怎么做？

**答：**

1. **输入过滤**：检测和拦截 prompt injection、有害内容、敏感信息（PII）
2. **输出过滤**：检测生成内容中的有害信息、不合规内容
3. **话题限制**：限制 Agent 只回答业务相关问题，拒绝无关请求
4. **工具权限控制**：不同用户/场景可调用的工具不同，高危操作需确认
5. **速率限制**：防止 API 滥用
6. **审计日志**：记录所有输入输出供事后审查

实现方式：可以用独立的分类模型做输入/输出审核，也可以在 prompt 中嵌入安全指令。

### Q35: Python 的 multiprocessing 和 threading 如何结合使用提高吞吐量？

**答：**

由于 GIL 限制，Python 的 threading 只能并发不能并行（适合 IO 密集）。结合策略：

1. **multiprocessing 做 CPU 密集任务**：如 embedding 计算、数据预处理。每个进程有独立 GIL。
2. **threading/asyncio 做 IO 密集任务**：如并发调用多个 LLM API、数据库查询。
3. **典型架构**：主进程用 asyncio event loop 处理请求，CPU 密集任务 offload 到 ProcessPoolExecutor。

```python
import asyncio
from concurrent.futures import ProcessPoolExecutor

executor = ProcessPoolExecutor(max_workers=4)

async def handle_request(query):
    # IO 密集：并发调 LLM
    llm_task = call_llm(query)
    # CPU 密集：offload 到子进程
    embed_task = asyncio.get_event_loop().run_in_executor(
        executor, compute_embedding, query
    )
    llm_result, embedding = await asyncio.gather(llm_task, embed_task)
```

### Q36: asyncio.gather 和 asyncio.as_completed 的区别？超时如何降级？

**答：**

| 方法 | 行为 | 适用场景 |
|------|------|---------|
| `asyncio.gather` | 等所有任务完成后一起返回结果 | 需要所有结果才能继续 |
| `asyncio.as_completed` | 哪个先完成先处理哪个 | 尽早处理可用结果 |

**超时降级**：
```python
# gather + timeout
try:
    results = await asyncio.wait_for(
        asyncio.gather(task_a, task_b), timeout=10
    )
except asyncio.TimeoutError:
    # 降级：用缓存结果或默认值
    results = [cached_result_a, default_result_b]

# as_completed + 逐个超时
for coro in asyncio.as_completed([task_a, task_b], timeout=10):
    try:
        result = await coro
        process(result)
    except asyncio.TimeoutError:
        use_fallback()
```

### Q37: 在 FastAPI 中，中间件和依赖注入分别适合处理什么业务逻辑？

**答：**

| 维度 | 中间件（Middleware） | 依赖注入（Depends） |
|------|-------------------|-------------------|
| 作用范围 | 全局，所有请求都经过 | 路由级别，按需声明 |
| 适合场景 | 日志记录、CORS、请求计时、全局鉴权 | 数据库连接、用户认证、参数校验 |
| 执行位置 | 请求前 + 响应后 | 请求处理前 |
| 访问请求体 | 可以但需手动读取 | 通过参数自动注入 |

**最佳实践**：中间件处理与业务无关的横切关注点；依赖注入处理与业务相关的前置逻辑。

---

## 七、面试经验与准备建议

### 来自面经的高频考点总结

根据 7 篇面经的出题频率统计：

| 排名 | 考点 | 出现次数 |
|------|------|---------|
| 1 | RAG 架构与优化 | 7/7 篇 |
| 2 | Function Calling / 工具调用 | 6/7 篇 |
| 3 | Agent 记忆机制（长短期） | 5/7 篇 |
| 4 | Multi-Agent 协作 | 4/7 篇 |
| 5 | 大模型微调（LoRA/SFT/DPO） | 3/7 篇 |
| 6 | LangGraph/LangChain 框架 | 3/7 篇 |
| 7 | SSE 流式交互 | 3/7 篇 |
| 8 | Prompt Engineering | 3/7 篇 |
| 9 | 向量数据库（Milvus/FAISS） | 3/7 篇 |
| 10 | MCP 协议 | 2/7 篇 |

### 面试准备清单

1. **必须掌握**：RAG 全链路（切片、embedding、检索、重排序、生成、评估）；Function Calling 原理和工程实现；Agent 状态管理和记忆设计。

2. **项目准备**：至少准备一个完整的 Agent/RAG 项目，能讲清楚架构决策、遇到的问题和解决方案。面试官会深入追问细节（如"检索召回率低怎么办"、"工具调用失败怎么兜底"）。

3. **框架实操**：LangChain/LangGraph 是目前最常被问到的框架，建议实际跑过 demo。了解 CrewAI、AutoGen 等框架的定位和差异。

4. **算法基础**：手撕题仍然是必考环节（LRU 缓存、链表操作、编辑距离等经典题）。SQL 题也可能出现。

5. **大模型原理**：LoRA、DPO、PagedAttention 等核心概念需要理解原理而非只停留在使用层面。

6. **工程能力**：Python 异步编程（asyncio）、流式接口（SSE）、向量数据库使用是工程面的高频考点。

7. **前沿关注**：MCP 协议、A2A 通信、Agentic RAG 等新概念在最新面试中已开始出现。
