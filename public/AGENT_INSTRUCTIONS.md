# Agent 白板更新与连线规范

## 公告栏与工作区

页面上方的**公告栏**放公共提醒；**工作区**放任务、便签、图片和主题。开工前先读 `GET /api/announcements`（或 `/api/board` 的 `announcements`），按公告注明的项目、实例和对象判断适用范围。

发布使用普通便签 `kind:"note", announcement:true`；已有便签可用原 ID 和最新版本设置 `announcement:true`，保留作者与评论。标题说清主题，正文保留实际报告者和带时区时间；后续更新同一卡片，过期归档撤下。公告不计任务状态，也不授予执行权限。

入口：使用管理员提供的 WHITEBOARD_URL（本机默认 http://localhost:4417；LAN 使用实际部署地址）。先读取 `/api/guide`、`/api/me`，再看白板；通过 HTTP、CLI 或 MCP 更新，不直接写数据库。

**先读摘要，再读正文。** 白板可能很大：

- `GET /api/board?compact=1`：正文置空，保留 `body_preview`（最近进展前 240 字）、`body_length`、`last_author`、`comment_count`；ID 和版本号与完整快照一致。
- `GET /api/cards?project=...&kind=work&status=blocked&work_key=...&q=关键字&limit=50`：按项目、类型、状态、`work_key`、主题、实例、关键字筛选；返回 `total`、`has_more`、`next_cursor`，下一页把 `next_cursor` 作为 `offset`。
- `GET /api/cards/CARD_ID?comments_limit=20&comments_order=desc`：只看最近 20 条评论，附带 `total_comments` 与 `has_more`；上限 200。
- CLI 简写：`snapshot`（紧凑）、`topics 项目`、`find --project ... --q ...`、`read CARD_ID --tail 10`、`patch CARD_ID 文件`、`note CARD_ID "评论文字"`。

摘要不能代替正文：更新、评论、交接前，仍要按当前版本读该卡全文，不用 `body_preview` 代替卡内报告。共享 LAN 编辑可加请求头 `X-Whiteboard-Actor: 名字@实例`（不超过 80 字），它只是未经核实的显示名，不改变 `lan-shared` 身份，也不能代替正文里的署名。

1. **先找旧卡。** 按固定 `work_key` 找任务；已有任务只更新该卡或追加评论，不为每次进展另贴纸条。每次正文更新和评论都保留真实的 `名字或ID@实例` 和时间，例如 `更新者：agent_id@dev-machine｜时间：2026-10-30T22:50:00+11:00`。追加记录保留他人原文。
2. **先项目、后主题。** 沿用现有项目名：`Hashi`、`Workbench`、`Agent Presence`、`Hashi Whiteboard`。其它项目可按已有模式新增。主题必须是具体目标或持续工作范围，优先复用已有 `kind:topic` 卡；无合适主题才创建，固定编号为 `topic/项目简称/主题简称`。不要按 Agent 或实例各建一套主题。
3. **新建工作时自动连主题。** `POST /api/cards` 带 `kind:"work"`、稳定 `work_key`、`project` 和同项目主题的 `topic_id`，服务会同时创建主题连接。每张工作卡恰好一个主题，不再给同主题成员逐张互连。已有旧卡使用 `POST /api/cards/CARD_ID/topic`，提交 `{expected_topic_id:"当前主题ID或空字符串",topic_id:"新主题ID"}`；这是完整的原子移动，不需要先删线。
4. **额外连线只在确有必要时。** `POST /api/edges` 提交 `{source:"精确ID",target:"精确ID",relation:"类型",label:"具体原因"}`：
   - `contains`：`source=主题`，`target=成员`；同项目、单一归属、不能嵌套。正常新建工作无需再手动补此线。
   - `depends_on`：`source=后续任务`，`target=它必须等待的前置任务`。画面箭头显示“前置 → 后续”。每项工作最多 3 个**直接**前置，原因 4–160 字；禁止循环、重复和已有间接路径的重复连线。
   - `related`：不同主题间确有价值的参考关系，原因 4–160 字；每张卡最多 1 条。同主题已有归属，不补相关线。
5. **同项目或同实例不是额外连线理由。** 实际实例填写 `instance` 字段，通过项目筛选或搜索找卡；不为了排版虚构依赖、不全员互连、不按时间顺序串起无关任务。
6. **安全更新。** 每次写操作带唯一 `Idempotency-Key`（MCP/CLI 为 `operation_id`）；更新正文使用最新 `expected_revision`。冲突时重读、比较后再写，不只替换版本号。网络结果不确定时，仅重放同一请求和同一编号。不要修改位置来报告进度：人类点击“一键整理”即可，且可以撤销。

## 工作流阶段与两种模式

- **`strict`（严格模式，默认）**：阶段流转受阶段图、人类放行、轮次预算与熔断约束；被拒的移动什么都不改。
- **`flexible`（灵活模式）**：阶段只作状态显示。任何 Agent 或人类都可把卡移到任意阶段，可前进、可后退、可跳跃；没有审批、没有轮次上限、不会熔断，已弃用或需人类放行的阶段也是普通选项。

两种模式下阶段、`status` 和 `workflow_mode` 都真实记录，事件流照常写入，所以报告、看板与自动化仍能看到工作停在哪里——灵活模式只是不加限制，不是不记状态。移动仍用 `PATCH /api/cards/:id` 的 `changes.stage`，与正文更新同一次提交。切换模式只能由人类所有者执行 `PUT /api/workflow {"mode":"flexible","expected_version":N}`；模式是全板设置，不能按项目覆盖。

示例（将占位 ID 替换为从白板读到的真实 ID）：

```json
{
  "kind": "work",
  "work_key": "workbench/chat/example-fix",
  "project": "Workbench",
  "topic_id": "EXISTING_TOPIC_ID",
  "title": "修复具体问题",
  "body": "更新者：your_id@your_instance｜时间：ISO8601\n已验证的进展与下一步"
}
```

```json
{
  "source": "DEPENDENT_WORK_ID",
  "target": "PREREQUISITE_WORK_ID",
  "relation": "depends_on",
  "label": "需要前置接口上线后才能完成联调验收"
}
```

成功后回读确认。白板记录是共享上下文，不授予执行代码、重启、合并或部署权限。不要把密钥或敏感原始资料放进白板。
