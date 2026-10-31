export default function ProjectHeader({ data }) {
  const { name, cards, color } = data;
  const work = cards.filter((c) => c.kind === "work");
  const latest = cards.length
    ? Math.max(...cards.map((c) => Date.parse(c.updated_at)))
    : null;
  return (
    <section
      className="project-header"
      style={{ "--project-color": color }}
      aria-label={`${name} 项目总览`}
    >
      <div className="project-kicker">
        PROJECT / {cards.length ? `${cards.length} 张卡片` : "待补充"}
      </div>
      <h2>{name}</h2>
      {cards.length ? (
        <div className="project-counts">
          {[
            ["blocked", "阻碍"],
            ["in_progress", "进行中"],
            ["planned", "待办"],
            ["done", "完成"],
          ].map(([status, label]) => (
            <span key={status} className={status}>
              {label} <b>{work.filter((c) => c.status === status).length}</b>
            </span>
          ))}
        </div>
      ) : (
        <p>尚未收到这个项目的工作记录。</p>
      )}
      <small>
        {latest
          ? `最近更新 ${new Date(latest).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
          : "新记录会归入本列"}{" "}
        · 点击工作卡查看详情
      </small>
    </section>
  );
}
