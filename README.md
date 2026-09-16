# NexLoop V0

**model-agnostic interaction layer** — 改变模型输出抵达用户的方式，而不是让模型更聪明。

```
传统:   User → Model → Complete Response → User
NexLoop: User → Model → m1 → wait → m2 → wait → m3 ...
                       └─ 用户中途插话 → pending 全部作废 → 基于新状态重新规划
```

V0 只证明一个 interaction primitive：

> 模型的单次长回复可以成为随时间展开、可被用户中途打断并重新规划的消息流。

## 核心架构

把 **已经发生的 conversation history** 和 **尚未发生的 future plan** 严格分开：

| 概念 | 内容 | 规则 |
|---|---|---|
| `committed_history` | 用户真正发送过的 + AI 真正发送过的消息 | 只有**实际送达**的 assistant message 才能进入 |
| `pending_plan` | 模型规划但尚未发送的消息 | 用户打断时整体作废，绝不让模型误以为旧 pending 已被看到 |

**并发安全**（V0 最重要的工程部分）：

- 每个 plan 有唯一 `plan_id`，另有单调递增的 `generation`。
- **只有当前 active plan 可以发送消息**：发送循环在每条消息前做一次「check-then-send」，检查与发送之间没有 `await`，不可能被并发请求插入。
- 用户新消息到达时，**同步**取消 active plan（先于任何 `await`），因此稍后醒来的旧异步任务必然通过不了检查。
- 多个 LLM 调用同时在途时，`generation` 保证只有最新一次请求能创建 plan；旧的直接丢弃（`superseded_before_start`），不会泄漏任何消息。

## 模型输出

不要求模型先生成完整长文再机械切句，而是让模型直接规划下一段 communication trajectory：

```json
{ "messages": [
  { "text": "...", "delay_ms": 0 },
  { "text": "...", "delay_ms": 3000 },
  { "text": "...", "delay_ms": 7000 }
] }
```

- 拆几条、每条说什么、顺序、delay，都由模型根据 conversation context 决定。
- 所有结构化输出经过 `parsePlanUnits()` 校验（条数/文本/delay 上限、markdown 围栏剥离、非 JSON 容错）。
- 解析失败：先带纠错信息重试一次；仍失败 → 记录 `MODEL_ERROR` + 发送一条 fallback 消息，系统不崩溃。

## 快速开始

### 零依赖（Node >= 18.13，无 npm install）

```bash
git clone <repo-url> nexloop && cd nexloop

# 方式一：mock provider（无需任何 API key，确定性行为，适合先跑起来）
NEXLOOP_MODE=mock node server.js
# → NEXLOOP_LISTENING http://127.0.0.1:3000

# 方式二：任意 OpenAI 兼容端点（OpenAI / llama.cpp / vLLM / Ark / DeepSeek / Moonshot ...）
cp .env.example .env   # 填入 NEXLOOP_API_KEY / BASE_URL / MODEL
node server.js
```

打开 http://127.0.0.1:3000 即可测试：

1. 发送 U1 → AI 分多条短消息逐条发出（mock 模式为 m1 → 3s → m2 → 3s → m3）
2. 在 m2/m3 之间插话 → 旧队列立即取消（事件日志出现 `USER_INTERRUPT` + `PLAN_CANCELLED`），m2/m3 永远不出现
3. AI 基于「已发送消息 + 新消息」重新规划并继续发送

左侧面板只显示 committed 消息；右侧是内部事件日志（每条含时间戳 + plan_id）。

### 真实模型：本地 llama.cpp（本仓库开发时使用的验证方式）

```bash
# 1) 启动 OpenAI 兼容的 llama.cpp server（任意 GGUF 模型均可）
llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --host 127.0.0.1 --port 8089 --jinja

# 2) 让 NexLoop 指向它
NEXLOOP_MODE=openai NEXLOOP_BASE_URL=http://127.0.0.1:8089/v1 \
NEXLOOP_API_KEY=sk-local NEXLOOP_MODEL=qwen node server.js
```

## API

| 端点 | 说明 |
|---|---|
| `GET /` | 最小交互测试台（public/index.html） |
| `POST /api/chat` `{"message": "..."}` | 唯一入口：取消 active plan（如有）→ 提交用户消息 → 生成并启动新 plan |
| `GET /api/stream` | SSE 事件流（见下） |
| `GET /api/history` | committed history + active plan 快照 |

### 可观测事件（每条含 `ts`、`plan_id`、必要 metadata）

`PLAN_CREATED` · `MESSAGE_SENT` · `PLAN_COMPLETED` · `USER_INTERRUPT` · `PLAN_CANCELLED` · `REPLAN_STARTED` · `USER_MESSAGE` · `MODEL_ERROR`

## 测试

```bash
npm test        # 等价于 node --test test/nexloop.test.js test/parse.test.js
```

覆盖（全部为真实 HTTP + SSE 集成测试，mock provider 由 `@@MOCK@@ <json>` 脚本驱动）：

| 用例 | 验证点 |
|---|---|
| TEST A | 正常流：m1 → delay → m2 → delay → m3，全部按序送达，无打断 |
| TEST B | 中途打断：m3/m4 永不发送；`USER_INTERRUPT`/`PLAN_CANCELLED` 记录；history = U1,m1,m2,U2,n1,n2 |
| TEST C | 早期打断：m1 后立即插话，剩余全部作废 |
| TEST D | 连续多次打断：任何 obsolete plan 不得恢复发送 |
| TEST E | 竞态：在下一单元即将发送时插话，旧 plan 不得泄漏消息 |
| TEST F | 模型输出非法 JSON：`MODEL_ERROR` + fallback，服务存活并恢复 |
| TEST G | 并发消息：三个请求同时在途，只有最新 generation 能发送 |

每个测试结束都会跑一遍**无泄漏不变量**：一旦某 plan 出现 `USER_INTERRUPT`/`PLAN_CANCELLED`，其后绝不允许出现该 plan 的 `MESSAGE_SENT`。

真实模型冒烟：`node scripts/smoke-real.js http://127.0.0.1:3100`（驱动真实 LLM 走一遍 正常流 + 打断 + 重规划）。

## 目录

```
server.js          HTTP + SSE + .env loader（零依赖）
engine.js          NexLoopEngine：committed_history / pending_plan / generation 并发控制
providers.js       openai 兼容 provider + mock provider + 输出校验/fallback
public/index.html  最小交互测试台
scripts/smoke-real.js  真实模型冒烟脚本
test/              集成测试（TEST A–G）+ 解析单元测试
.env.example       配置样例
```

## 已知限制（V0 有意为之）

- 单会话、无鉴权、无持久化（重启即清空 history）——V0 只验证 interaction primitive。
- 时间智能是 naive 的：delay 由模型给出、被逐条执行，无自适应 pacing。
- SSE 不重放历史事件；页面刷新后仅恢复 committed history。
- mock provider 的默认节奏固定为 0/3s/3s（便于人工演示打断）。
- 真实模型质量取决于模型本身（NexLoop 不提升模型智能，只改变送达方式）。

## 下一步最小建议

1. 给 plan 增加「可编辑/可跳过剩余单元」的显式用户控件（stop 按钮）。
2. 用 WebSocket 替代 SSE，支持服务端主动推送更多交互事件。
3. 将 `pending_plan` 落盘，页面刷新后恢复未完成 plan。
4. 真实模型上做一次针对 delay 与 unit 数量的 prompt 调优（当前 Qwen 1.5B 常只给 2 单元）。
