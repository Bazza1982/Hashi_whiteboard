import { memo } from "react";
import { Handle, Position } from "@xyflow/react";

export const statusLabels = {
  planned: "待开始",
  in_progress: "进行中",
  blocked: "有阻碍",
  done: "已完成",
};
export const mergeLabels = {
  not_applicable: "不涉及 PR",
  not_opened: "尚未创建 PR",
  open: "PR 待合并",
  merged: "PR 已合并",
  closed: "PR 已关闭",
};
// Adapted from Workbench Canvas NodeFrame/NoteNode: React Flow handles, a
// memoized card, and plain-text rendering. No Workbench runtime dependencies.
export default memo(function BoardCard({ data, selected }) {
  const { card, owner, memberCount } = data;
  const lines = card.body.split(/\r?\n/);
  const signatures = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*更新者[：:]/.test(line));
  const signature = signatures.at(-1);
  const author = signature?.line
    .replace(/^\s*更新者[：:]\s*/, "")
    .split(/[｜|]/)[0]
    .trim();
  const preview = lines
    .slice(signature ? signature.index + 1 : 0)
    .filter((line) => !/^\s*(负责人|更新者|更新时间|时间)[：:]/.test(line))
    .join("\n")
    .trim();
  const stale =
    card.kind === "work" &&
    card.status === "in_progress" &&
    Date.now() - Date.parse(card.updated_at) > 86400000;
  return (
    <article
      className={`board-card ${card.kind} ${card.status} ${selected ? "selected" : ""} ${card.archived_at ? "archived" : ""}`}
      data-card-id={card.id}
    >
      <Handle type="target" position={Position.Left} />
      {card.kind !== "topic" && (
        <Handle id="topic-in" type="target" position={Position.Top} />
      )}
      {card.kind === "topic" && (
        <Handle id="topic-out" type="source" position={Position.Bottom} />
      )}
      <div className="card-eyebrow">
        <span>
          {card.kind === "topic"
            ? "主题入口"
            : card.kind === "work"
              ? "工作"
              : card.kind === "image"
                ? "图片"
                : "便签"}{" "}
          / {card.project}
        </span>
        {card.kind === "work" && (
          <span className={`badge ${card.status}`}>
            {statusLabels[card.status]}
          </span>
        )}
      </div>
      <h3>{card.title}</h3>
      {card.kind === "topic" && (
        <span className="topic-count">{memberCount} 张成员卡 · 一卡一主题</span>
      )}
      {card.kind === "image" ? (
        <img
          className="card-image"
          src={`/api/assets/${card.asset_id}`}
          alt={card.body || card.title}
          draggable="false"
        />
      ) : (
        <p className="card-body">
          {preview || card.body || "写下想法、进展或需要大家知道的事。"}
        </p>
      )}
      {card.kind === "work" && card.work_key && (
        <div className="work-key">{card.work_key}</div>
      )}
      {card.blocker && card.status === "blocked" && (
        <p className="card-blocker">阻碍 · {card.blocker}</p>
      )}
      {card.branch && (
        <div className="card-meta">
          ⑂ {card.branch}
          {card.instance ? ` · ${card.instance}` : ""}
        </div>
      )}
      {card.merge_status !== "not_applicable" && (
        <div className={`merge-label ${card.merge_status}`}>
          {mergeLabels[card.merge_status]}
        </div>
      )}
      {card.next_step && (
        <div className="next-step">接下来 · {card.next_step}</div>
      )}
      <footer>
        <span className="owner-dot" />
        <span
          className="card-author"
          title={author || owner?.name || card.owner_id}
        >
          {author ? `更新 · ${author}` : owner?.name || card.owner_id}
        </span>
        <span className="spacer" />
        {card.archived_at
          ? "已归档"
          : stale
            ? "超过 24 小时未更新"
            : new Date(card.updated_at).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
        {card.comment_count > 0 ? ` · ${card.comment_count} 条评论` : ""}
      </footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
});
