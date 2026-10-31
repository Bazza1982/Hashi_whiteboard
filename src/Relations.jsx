import { useState } from "react";
import { RELATION_LABELS, relationOf } from "../shared/relations.mjs";

export function RelationEditor({ card, board, canWrite, mutate, onSelect }) {
  const parent = board.edges.find(
    (e) => relationOf(e) === "contains" && e.target === card.id,
  );
  const [topic, setTopic] = useState("");
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const topics = board.cards.filter(
    (c) => c.kind === "topic" && !c.archived_at && c.project === card.project,
  );
  const links = board.edges.filter(
    (e) => e.source === card.id || e.target === card.id,
  );
  return (
    <section className="relation-editor">
      <h3>主题与连接</h3>
      {card.kind !== "topic" && (
        <>
          <p>
            所属主题：<b>{byId.get(parent?.source)?.title || "尚未归入主题"}</b>
          </p>
          {canWrite && !card.archived_at && (
            <div className="topic-picker">
              <select
                aria-label="调整所属主题"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              >
                <option value="">选择本项目的主题…</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <button
                disabled={!topic || topic === parent?.source}
                onClick={() =>
                  mutate(`/api/cards/${card.id}/topic`, {
                    expected_topic_id: parent?.source || "",
                    topic_id: topic,
                  })
                }
              >
                归入主题
              </button>
            </div>
          )}
        </>
      )}
      <ul>
        {links.map((e) => {
          const other = byId.get(e.source === card.id ? e.target : e.source);
          if (!other) return null;
          const caption =
            relationOf(e) === "contains"
              ? e.source === card.id
                ? "主题成员"
                : "所属主题"
              : relationOf(e) === "depends_on"
                ? e.source === card.id
                  ? "前置任务"
                  : "后续任务"
                : "相关";
          return (
            <li key={e.id}>
              <small>{caption}</small>{" "}
              <button className="quiet" onClick={() => onSelect(other.id)}>
                {other.title}
              </button>
              {relationOf(e) !== "contains" && (
                <p className="muted">{e.label}</p>
              )}
            </li>
          );
        })}
      </ul>
      <small className="muted">
        每卡一个主题；最多 3 个直接前置、1
        条额外相关。同项目或同实例不构成额外连线理由。
      </small>
    </section>
  );
}

export function LinkForm({ source, target, onCreate }) {
  const [relation, setRelation] = useState(
    source.kind === "topic" && target.kind !== "topic"
      ? "contains"
      : "depends_on",
  );
  const [label, setLabel] = useState("");
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onCreate({
            source: source.id,
            target: target.id,
            relation,
            label: relation === "contains" ? "主题归属" : label,
          });
        } catch (e) {
          setError(e.message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <p>
        <b>{source.title}</b> → <b>{target.title}</b>
      </p>
      <label className="field">
        <span>连线含义</span>
        <select
          aria-label="连线含义"
          value={relation}
          onChange={(e) => setRelation(e.target.value)}
        >
          {Object.entries(RELATION_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <p className="notice">
        {relation === "contains"
          ? "从主题连向成员，只能在同一项目内，每个成员只归属一个主题。"
          : relation === "depends_on"
            ? "表示左边的任务必须等右边的前置任务完成。保存后，画布箭头按“前置 → 后续”显示。"
            : "仅用于不同主题之间有明确理由的参考关系，每张卡最多一条。"}
      </p>
      {relation !== "contains" && (
        <label className="field">
          <span>具体原因</span>
          <textarea
            aria-label="具体原因"
            minLength={4}
            maxLength={160}
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      )}
      <p className="muted">
        同主题使用主题归属，不逐张互连；同实例使用实例信息和搜索。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={saving}>
        保存连接
      </button>
    </form>
  );
}
