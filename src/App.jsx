import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ViewportPortal,
  useReactFlow,
  MarkerType,
} from "@xyflow/react";
import BoardCard, { statusLabels, mergeLabels } from "./BoardCard.jsx";
import { CARD_FIELDS } from "../shared/contract.mjs";
import { PROJECT_LANES, LANE_WIDTH } from "../shared/layout.mjs";
import ProjectHeader from "./ProjectHeader.jsx";
import {
  relationOf,
  flowEndpoints,
  RELATION_LABELS,
} from "../shared/relations.mjs";
import { RelationEditor, LinkForm } from "./Relations.jsx";
import "./relations.css";

const nodeTypes = { whiteboard: BoardCard, project: ProjectHeader };
const emptyBoard = {
  cards: [],
  edges: [],
  strokes: [],
  actors: [],
  activity: [],
  revision: 0,
};
const blank = {
  kind: "work",
  work_key: "",
  title: "",
  body: "",
  project: "general",
  status: "planned",
  next_step: "",
  blocker: "",
  repository: "",
  branch: "",
  instance: "",
  pr_url: "",
  merge_status: "not_applicable",
  asset_id: "",
  announcement: false,
};
const fieldValue = (card, key) =>
  card[key] ?? (key === "announcement" ? false : "");
const messages = {
  unauthorized: "访问已过期，请重新登录。",
  owner_mismatch: "这张卡片属于其他 Agent。您可以留言，或请负责人交接。",
  revision_conflict:
    "这张卡片刚刚被更新。草稿已保留，请先比较最新内容，再决定如何修改。",
  work_key_exists: "已有相同工作编号。请读取已有卡片，避免重复开工。",
  blocker_required: "请写清楚当前阻碍。",
  result_required: "请在进展中写下已完成的结果。",
  pr_required: "请填写对应的 PR 链接。",
  merge_incomplete: "标记 PR 已合并时，工作状态应为已完成。",
  actor_not_found: "请选择一位仍可访问白板的负责人。",
  card_archived: "卡片已归档，请先恢复。",
  actor_name_exists: "已有成员使用这个名称，请加上实例或换一个易区分的名称。",
  topic_required: "请先选择所属主题；没有合适的主题时，先添加主题入口。",
  topic_exists: "已有所属主题。请在卡片详情里调整主题，不要重复连接。",
  project_mismatch: "主题与成员必须属于同一个项目。",
  invalid_membership: "主题只能连接本项目的普通卡片，不能嵌套主题。",
  edge_exists: "这条关系已存在，无需重复添加。",
  dependency_cycle: "这条依赖会形成循环，已取消。",
  redundant_dependency: "已有间接依赖路径，无需再增加这条线。",
  dependency_limit: "每项工作最多 3 个直接前置，请去掉重复或间接关系。",
  related_limit: "每张卡最多 1 条额外相关线。分组请使用主题。",
  redundant_relation: "两张卡已在同一主题下，无需再连相关线。",
  board_changed: "白板刚有更新。已取消整理，请查看最新状态后再点一次。",
  layout_conflict: "整理后卡片或连线已有变化，已取消撤销，避免覆盖后续调整。",
  topic_not_empty: "请先移动或归档主题内的工作，再归档主题。",
  membership_required: "工作卡必须保留主题连接。请在详情中调整所属主题。",
  topic_conflict: "所属主题刚被调整，请查看最新归属后再操作。",
  project_has_topic: "卡片已有主题连接，请保持当前项目，避免破坏分区。",
};
function operationKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function api(
  url,
  { method = "GET", body, key = operationKey(), raw = false } = {},
) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(method !== "GET" ? { "Idempotency-Key": key } : {}),
      ...(body !== undefined
        ? {
            "Content-Type": raw
              ? body.type || "application/octet-stream"
              : "application/json",
          }
        : {}),
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      messages[result.error?.code] || result.error?.message || "请求失败",
    );
    Object.assign(error, result.error, {
      message:
        messages[result.error?.code] || result.error?.message || "请求失败",
    });
    throw error;
  }
  return result;
}
async function copy(value) {
  if (navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(value);
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
function Field({ label, children, ...props }) {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {children ? (
        cloneElement(children, { "aria-labelledby": id })
      ) : (
        <input aria-labelledby={id} {...props} />
      )}
    </label>
  );
}
function App() {
  const [actor, setActor] = useState(null),
    [access, setAccess] = useState(null),
    [checking, setChecking] = useState(true),
    [token, setToken] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    api("/api/me")
      .then((x) => {
        setActor(x.actor);
        setAccess(x.access);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  if (checking)
    return (
      <div className="login">
        <p>正在连接白板…</p>
      </div>
    );
  if (!actor)
    return (
      <div className="login">
        <section>
          <div className="brand-symbol">H</div>
          <p className="eyebrow">A SHARED SPACE FOR WHAT’S NEXT</p>
          <h1>HASHI Whiteboard</h1>
          <p>
            您与 Agent 共用的团队白板。
            <br />
            写下正在做的事，让下一位能接着往下走。
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api("/api/session", {
                  method: "POST",
                  body: { token },
                });
                setToken("");
                setActor(r.actor);
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            <Field
              label="访问密钥"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="current-password"
            />
            <button className="primary" type="submit">
              进入白板 →
            </button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <small>
            主机上运行 <code>npm run access</code> 获取主人密钥。
            <br />
            Agent 使用主人分配的独立密钥。
          </small>
        </section>
      </div>
    );
  return (
    <ReactFlowProvider>
      <Board
        actor={actor}
        access={access}
        onSignIn={async (key) => {
          await api("/api/session", { method: "POST", body: { token: key } });
          const current = await api("/api/me");
          setActor(current.actor);
          setAccess(current.access);
        }}
        onLogout={async () => {
          await api("/api/session", { method: "DELETE" });
          if (access?.shared_edit) {
            const current = await api("/api/me");
            setActor(current.actor);
          } else setActor(null);
        }}
      />
    </ReactFlowProvider>
  );
}
function Board({ actor, access, onSignIn, onLogout }) {
  const sharedEdit = Boolean(access?.shared_edit);
  const [board, setBoard] = useState(emptyBoard),
    [loaded, setLoaded] = useState(false),
    [selected, setSelected] = useState(null),
    [project, setProject] = useState(""),
    [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false),
    [dialog, setDialog] = useState(""),
    [tool, setTool] = useState("select"),
    [points, setPoints] = useState([]),
    [penColor, setPenColor] = useState("#355bd9"),
    [overrides, setOverrides] = useState({}),
    [pendingLink, setPendingLink] = useState(null),
    [allLinks, setAllLinks] = useState(false),
    [lastLayout, setLastLayout] = useState(
      () => sessionStorage.getItem("whiteboard:last-layout") || "",
    );
  const flow = useReactFlow(),
    dragRevision = useRef({}),
    fileInput = useRef(),
    drawing = useRef(false),
    snapshotRequest = useRef(0),
    draftGuard = useRef(null),
    canvasRef = useRef(),
    overviewProject = useRef(null);
  const selectCard = (id) => {
    if (id !== selected && draftGuard.current && !draftGuard.current())
      return false;
    setSelected(id);
    return true;
  };
  const refresh = useCallback(async () => {
    const ticket = ++snapshotRequest.current;
    const result = await api("/api/board?archived=true");
    if (ticket === snapshotRequest.current) {
      setBoard(result);
      setLoaded(true);
    }
    return result;
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const source = new EventSource("/api/events");
    source.addEventListener("change", () => {
      setConnected(true);
      refresh().catch((e) => setError(e.message));
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [refresh]);
  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const shown = board.cards
    .filter(
      (c) =>
        !c.announcement &&
        (archived || !c.archived_at) &&
        (!project || c.project === project) &&
        (!query ||
          [c.title, c.body, c.work_key, c.branch, c.instance].some((t) =>
            t?.toLowerCase().includes(query.toLowerCase()),
          )),
    )
    .sort((a, b) => {
      const rank = (name) =>
        PROJECT_LANES.includes(name) ? PROJECT_LANES.indexOf(name) : 100;
      const state = { blocked: 0, in_progress: 1, planned: 2, done: 3 };
      return (
        rank(a.project) - rank(b.project) ||
        a.project.localeCompare(b.project) ||
        state[a.status] - state[b.status] ||
        Date.parse(b.updated_at) - Date.parse(a.updated_at)
      );
    });
  const ids = new Set(shown.map((c) => c.id));
  const actors = new Map(board.actors.map((a) => [a.id, a]));
  const cardNodes = shown.map((card) => ({
    id: card.id,
    type: "whiteboard",
    position: overrides[card.id] || card.position,
    data: {
      card,
      owner: actors.get(card.owner_id),
      memberCount: board.edges.filter(
        (e) =>
          relationOf(e) === "contains" &&
          e.source === card.id &&
          board.cards.some((c) => c.id === e.target && !c.archived_at),
      ).length,
    },
    selected: card.id === selected,
    draggable:
      !card.archived_at &&
      (sharedEdit || actor.role === "human" || actor.id === card.owner_id),
    style: { width: 292 },
  }));
  const groups = new Map();
  for (const card of shown) {
    if (!groups.has(card.project)) groups.set(card.project, []);
    groups.get(card.project).push(card);
  }
  if (
    !project &&
    !query &&
    !archived &&
    shown.some((c) => PROJECT_LANES.slice(0, 3).includes(c.project))
  )
    for (const name of PROJECT_LANES.slice(0, 3))
      if (!groups.has(name)) groups.set(name, []);
  const colors = ["#4266c9", "#3b8a7d", "#9270af", "#7c8aa5"];
  const projectNodes = [...groups].map(([name, cards]) => ({
    id: `project:${name}`,
    type: "project",
    position: {
      x: cards.length
        ? Math.min(...cards.map((c) => (overrides[c.id] || c.position).x))
        : Math.max(
            -420,
            ...board.cards
              .filter(
                (c) =>
                  !c.archived_at &&
                  PROJECT_LANES.indexOf(c.project) >= 0 &&
                  PROJECT_LANES.indexOf(c.project) <
                    PROJECT_LANES.indexOf(name),
              )
              .map((c) => (overrides[c.id] || c.position).x),
          ) + 420,
      y: cards.length
        ? Math.min(...cards.map((c) => (overrides[c.id] || c.position).y)) - 180
        : -180,
    },
    data: {
      name,
      cards,
      color: colors[Math.max(0, PROJECT_LANES.indexOf(name)) % colors.length],
    },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    style: { width: 292 },
  }));
  const nodes = [...projectNodes, ...cardNodes];
  const showOverview = () => {
    if (!projectNodes.length) return;
    const left = Math.min(...projectNodes.map((n) => n.position.x));
    const right = Math.max(...projectNodes.map((n) => n.position.x + 292));
    const top = Math.min(...projectNodes.map((n) => n.position.y));
    const width = canvasRef.current?.clientWidth || 1100;
    const zoom = Math.min(1, (width - 64) / (right - left));
    flow.setViewport(
      {
        x: (width - (right - left) * zoom) / 2 - left * zoom,
        y: 56 - top * zoom,
        zoom,
      },
      { duration: 250 },
    );
  };
  useEffect(() => {
    if (
      !loaded ||
      !flow.viewportInitialized ||
      overviewProject.current === project
    )
      return;
    const timer = setTimeout(() => {
      showOverview();
      overviewProject.current = project;
    }, 80);
    return () => clearTimeout(timer);
  }, [loaded, flow.viewportInitialized, project, board.revision]);
  const edges = board.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .filter(
      (e) =>
        relationOf(e) === "contains" ||
        allLinks ||
        e.source === selected ||
        e.target === selected,
    )
    .map((e) => {
      const relation = relationOf(e),
        membership = relation === "contains";
      return {
        ...e,
        ...flowEndpoints(e),
        type: "smoothstep",
        sourceHandle: membership ? "topic-out" : null,
        targetHandle: membership ? "topic-in" : null,
        label: membership ? "" : RELATION_LABELS[relation],
        ...(relation === "depends_on"
          ? { markerEnd: { type: MarkerType.ArrowClosed } }
          : {}),
        style: {
          stroke: relation === "depends_on" ? "#c88748" : "#a4b2c6",
          strokeWidth: 1.5,
          ...(relation !== "depends_on" ? { strokeDasharray: "5 5" } : {}),
        },
      };
    });
  const tidy = () =>
    act(async () => {
      const measurements = flow
        .getNodes()
        .filter(
          (n) =>
            n.type === "whiteboard" &&
            !n.data.card.archived_at &&
            n.measured?.height,
        )
        .map((n) => ({
          id: n.id,
          width: n.measured.width,
          height: n.measured.height,
        }));
      const result = await api("/api/layout/tidy", {
        method: "POST",
        body: { expected_revision: board.revision, measurements },
      });
      if (result.layout_id) {
        setLastLayout(result.layout_id);
        sessionStorage.setItem("whiteboard:last-layout", result.layout_id);
      }
      setOverrides({});
      overviewProject.current = null;
      return result;
    }).catch(() => {});
  const undoLayout = () =>
    act(async () => {
      await api("/api/layout/undo", {
        method: "POST",
        body: { layout_id: lastLayout },
      });
      setLastLayout("");
      sessionStorage.removeItem("whiteboard:last-layout");
      setOverrides({});
    }).catch(() => {});
  const visibleStrokes = board.strokes.filter(
    (s) => !project || s.project === project,
  );
  const pathFor = (p) =>
    p.map((v, i) => `${i ? "L" : "M"}${v[0]},${v[1]}`).join(" ");
  const makeImage = (file) =>
    act(async () => {
      const uploaded = await api("/api/assets", {
        method: "POST",
        body: file,
        raw: true,
      });
      const created = await api("/api/cards", {
        method: "POST",
        body: {
          kind: "image",
          title: file.name || "图片",
          project: project || "general",
          asset_id: uploaded.asset_id,
        },
      });
      selectCard(created.card.id);
      return created;
    }).catch(() => {});
  const addCard = (kind) => {
    if (!selectCard(null)) return;
    setDialog(kind);
  };
  function pointer(event) {
    const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return [Math.round(p.x), Math.round(p.y)];
  }
  const drawStart = (e) => {
    if (e.button !== 0) return;
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPoints([pointer(e)]);
  };
  const drawMove = (e) => {
    if (!drawing.current) return;
    const p = pointer(e);
    setPoints((old) => {
      const tail = old.at(-1);
      return old.length < 4096 &&
        (!tail || Math.hypot(p[0] - tail[0], p[1] - tail[1]) >= 2)
        ? [...old, p]
        : old;
    });
  };
  const drawEnd = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const drawn = points;
    setPoints([]);
    if (drawn.length >= 2)
      act(() =>
        api("/api/strokes", {
          method: "POST",
          body: {
            points: drawn,
            color: penColor,
            width: 3,
            project: project || "general",
          },
        }),
      ).catch(() => {});
  };
  const undoStroke = () => {
    const last = [...visibleStrokes]
      .reverse()
      .find(
        (s) => sharedEdit || actor.role === "human" || s.owner_id === actor.id,
      );
    if (last)
      act(() =>
        api(`/api/strokes/${last.id}`, {
          method: "DELETE",
          body: { expected_revision: last.revision },
        }),
      ).catch(() => {});
  };
  const announcements = board.cards
    .filter((c) => c.announcement && (archived || !c.archived_at))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const stats = board.cards.filter((c) => !c.archived_at && c.kind === "work");
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-symbol small">H</div>
        <div className="brand">
          <strong>
            HASHI <span>Whiteboard</span>
          </strong>
          <small>团队此刻，进行到哪里。</small>
        </div>
        <span className={`live ${connected ? "online" : ""}`}>
          {connected ? "实时连接" : "正在重连"}
        </span>
        <div className="header-spacer" />
        <button onClick={() => setDialog("guide")}>使用说明</button>
        <button onClick={() => setDialog("access")}>Agent 接入</button>
        <span className="identity">
          {sharedEdit ? "局域网共享 · 全员可编辑" : actor.name}
        </span>
        <button
          className="quiet"
          onClick={() => {
            if (!draftGuard.current || draftGuard.current()) {
              if (actor.role === "lan") setDialog("admin");
              else onLogout();
            }
          }}
        >
          {actor.role === "lan"
            ? "管理员登录"
            : sharedEdit
              ? "退出独立身份"
              : "退出"}
        </button>
      </header>
      <section className="announcements-bar" aria-label="公告栏">
        <div className="announcements-heading">
          <h2>
            公告栏 <small>{announcements.length}</small>
          </h2>
          <button onClick={() => addCard("announcement")}>＋ 发布公告</button>
        </div>
        {announcements.length ? (
          <div className="announcement-list">
            {announcements.map((c) => (
              <button
                key={c.id}
                className={`announcement-entry ${selected === c.id ? "active" : ""}`}
                aria-label={`查看公告：${c.title}`}
                onClick={() => selectCard(c.id)}
              >
                <strong>
                  {c.archived_at ? "已撤下 · " : ""}
                  {c.title}
                </strong>
                <span>
                  {c.project}
                  {c.instance ? ` · ${c.instance}` : ""}
                </span>
                <time dateTime={c.updated_at}>
                  更新于 {new Date(c.updated_at).toLocaleString("zh-CN")}
                </time>
              </button>
            ))}
          </div>
        ) : (
          <p className="announcements-empty">
            暂无公告。公共提醒与共用信息放这里。
          </p>
        )}
      </section>
      <div className="workspace">
        <aside className="board-sidebar">
          <div className="sidebar-heading">
            <span className="eyebrow">TEAM SPACE</span>
            <h2>工作区</h2>
          </div>
          <div className="summary">
            <span>
              <b>{stats.filter((c) => c.status === "in_progress").length}</b>{" "}
              进行中
            </span>
            <span>
              <b>{stats.filter((c) => c.status === "blocked").length}</b> 有阻碍
            </span>
            <span>
              <b>{stats.filter((c) => c.status === "done").length}</b> 已完成
            </span>
          </div>
          <input
            aria-label="搜索白板"
            className="search"
            placeholder="搜索工作、分支或进展…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="筛选项目"
            value={project}
            onChange={(e) => {
              if (!selectCard(null)) return;
              setProject(e.target.value);
            }}
          >
            <option value="">所有项目</option>
            {[...new Set(board.cards.map((c) => c.project))].sort().map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />{" "}
            显示归档
          </label>
          <div className="card-list">
            {shown.map((c) => (
              <button
                className={`list-item ${selected === c.id ? "active" : ""}`}
                key={c.id}
                onClick={() => {
                  if (!selectCard(c.id)) return;
                  flow.setCenter(c.position.x + 146, c.position.y + 110, {
                    zoom: 1,
                    duration: 250,
                  });
                }}
              >
                <span
                  className={`list-dot ${c.kind === "work" ? c.status : "note"}`}
                />
                <div>
                  <strong>{c.title}</strong>
                  <small>{c.work_key || c.project}</small>
                </div>
              </button>
            ))}
          </div>
          <div className="sidebar-foot">
            <span>{shown.length} 张卡片 · 自动保存</span>
            <small>
              开工前先看，收工后更新。
              <br />
              完成的内容，随时归档。
            </small>
          </div>
        </aside>
        <main
          ref={canvasRef}
          className="canvas-wrap"
          onPaste={(e) => {
            const file = [...(e.clipboardData?.files || [])].find((f) =>
              f.type.startsWith("image/"),
            );
            if (file && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
              e.preventDefault();
              makeImage(file);
            }
          }}
        >
          {loaded && (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              minZoom={0.15}
              maxZoom={2}
              panOnDrag={tool === "select"}
              nodesConnectable={tool === "select"}
              onNodeClick={(_e, n) =>
                n.type === "whiteboard" && selectCard(n.id)
              }
              onPaneClick={() => selectCard(null)}
              onNodesChange={(changes) => {
                for (const c of changes)
                  if (c.type === "position" && c.position && c.dragging)
                    setOverrides((prev) => ({ ...prev, [c.id]: c.position }));
              }}
              onNodeDragStart={(_e, n) => {
                dragRevision.current[n.id] = board.cards.find(
                  (c) => c.id === n.id,
                )?.layout_revision;
              }}
              onNodeDragStop={(_e, n) => {
                act(() =>
                  api(`/api/cards/${n.id}/layout`, {
                    method: "PATCH",
                    body: {
                      expected_layout_revision: dragRevision.current[n.id],
                      position: n.position,
                    },
                  }),
                )
                  .catch(() => {})
                  .finally(() =>
                    setOverrides((prev) => {
                      const next = { ...prev };
                      delete next[n.id];
                      return next;
                    }),
                  );
              }}
              onConnect={(connection) => {
                let source = board.cards.find(
                    (c) => c.id === connection.source,
                  ),
                  target = board.cards.find((c) => c.id === connection.target);
                if (target?.kind === "topic" && source?.kind !== "topic")
                  [source, target] = [target, source];
                if (source && target) setPendingLink({ source, target });
              }}
              onEdgeDoubleClick={(_e, edge) => {
                const stored = board.edges.find((e) => e.id === edge.id);
                if (confirm("删除这条连线？"))
                  act(() =>
                    api(`/api/edges/${edge.id}`, {
                      method: "DELETE",
                      body: { expected_revision: stored.revision },
                    }),
                  ).catch(() => {});
              }}
            >
              <Background gap={24} size={1.3} color="#d2d8e4" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) =>
                  n.data.card?.status === "blocked"
                    ? "#edb5a5"
                    : n.data.card?.kind === "note"
                      ? "#e9ce7c"
                      : "#bed0f7"
                }
              />
              <ViewportPortal>
                <svg className="stroke-svg" width="1" height="1">
                  {visibleStrokes.map((s) => (
                    <path
                      key={s.id}
                      d={pathFor(s.points)}
                      stroke={s.color}
                      strokeWidth={s.width}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {points.length > 1 && (
                    <path
                      d={pathFor(points)}
                      stroke={penColor}
                      strokeWidth="3"
                      fill="none"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </ViewportPortal>
            </ReactFlow>
          )}
          {tool === "pen" && (
            <div
              className="drawing-layer"
              data-testid="drawing-layer"
              onPointerDown={drawStart}
              onPointerMove={drawMove}
              onPointerUp={drawEnd}
              onPointerCancel={() => {
                drawing.current = false;
                setPoints([]);
              }}
            />
          )}
          {loaded &&
            !board.cards.some((c) => !c.archived_at && !c.announcement) && (
              <div className="empty-state">
                <span className="empty-orbit">✳</span>
                <p className="eyebrow">MAKE ROOM FOR THE WORK</p>
                <h1>从一张便签开始。</h1>
                <p>
                  想法、进展、线索与下一步。
                  <br />
                  让每位 Agent 都能接上同一段工作。
                </p>
                <button className="primary" onClick={() => addCard("topic")}>
                  ＋ 添加第一个主题
                </button>
              </div>
            )}
          <div className="canvas-hint">
            虚线表示主题归属 · 箭头表示前置 → 后续 · 选卡查看额外连接
          </div>
          <div className="canvas-toolbar">
            <button
              className={tool === "select" ? "chosen" : ""}
              onClick={() => setTool("select")}
            >
              ↖ 选择
            </button>
            <button
              className={tool === "pen" ? "chosen" : ""}
              onClick={() => {
                if (!selectCard(null)) return;
                setTool("pen");
              }}
            >
              ✎ 画笔
            </button>
            {tool === "pen" && (
              <input
                aria-label="画笔颜色"
                type="color"
                value={penColor}
                onChange={(e) => setPenColor(e.target.value)}
              />
            )}
            <span className="divider" />
            <button onClick={() => addCard("topic")}>＋ 主题</button>
            <button onClick={() => addCard("note")}>＋ 便签</button>
            <button onClick={() => addCard("work")}>＋ 工作</button>
            <button onClick={() => fileInput.current.click()}>图片</button>
            <button onClick={undoStroke}>撤回上一笔</button>
            <button disabled={busy || !loaded} onClick={tidy}>
              一键整理
            </button>
            <button disabled={busy || !lastLayout} onClick={undoLayout}>
              撤销整理
            </button>
            <button
              aria-pressed={allLinks}
              onClick={() => setAllLinks((v) => !v)}
            >
              {allLinks ? "收起额外连线" : "全部连线"}
            </button>
            <button onClick={showOverview}>项目总览</button>
            <button
              onClick={() => flow.fitView({ padding: 0.2, duration: 250 })}
            >
              全览
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              if (e.target.files[0]) makeImage(e.target.files[0]);
              e.target.value = "";
            }}
          />
          {error && (
            <div className="toast error" role="alert">
              <span>{error}</span>
              <button aria-label="关闭提示" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {busy && <div className="saving">正在保存…</div>}
        </main>
        {selected && board.cards.some((c) => c.id === selected) && (
          <Inspector
            key={selected}
            id={selected}
            latest={board.cards.find((c) => c.id === selected)}
            actor={actor}
            sharedEdit={sharedEdit}
            actors={board.actors}
            board={board}
            onSelect={selectCard}
            act={act}
            draftGuard={draftGuard}
            onClose={() => selectCard(null)}
          />
        )}
      </div>
      {pendingLink && (
        <Modal title="连接卡片" onClose={() => setPendingLink(null)}>
          <LinkForm
            {...pendingLink}
            onCreate={(data) =>
              act(() => api("/api/edges", { method: "POST", body: data })).then(
                () => setPendingLink(null),
              )
            }
          />
        </Modal>
      )}
      {["work", "note", "topic", "announcement"].includes(dialog) && (
        <CreateDialog
          kind={dialog}
          project={project}
          topics={board.cards.filter(
            (c) => c.kind === "topic" && !c.archived_at,
          )}
          onClose={() => setDialog("")}
          onCreate={(data) =>
            act(() => api("/api/cards", { method: "POST", body: data })).then(
              (x) => {
                setDialog("");
                setSelected(x.card.id);
                setTimeout(
                  () =>
                    flow.setCenter(
                      x.card.position.x + 146,
                      x.card.position.y + 110,
                      { zoom: 1, duration: 200 },
                    ),
                  50,
                );
              },
            )
          }
        />
      )}
      {dialog === "guide" && (
        <Modal title="白板怎么用" onClose={() => setDialog("")}>
          <p>
            {sharedEdit
              ? "这是临时团队现场。局域网用户无需密钥即可读写所有卡片；负责人代表工作分工，不限制编辑。"
              : "这是临时团队现场。所有成员能读取；Agent 更新自己的卡片，主人可以更新全部。"}
          </p>
          <p>
            <b>公告栏：</b>
            页面上方查看公共提醒，点击标题读全文；用“发布公告”添加，过期后归档撤下。公告不计入任务状态，项目筛选不会隐藏公告。
          </p>
          <ol>
            <li>
              <b>开工前：</b>
              先读白板，用固定工作编号找已有卡片，确认负责人和下一步。
            </li>
            <li>
              <b>开工时：</b>
              创建或更新自己的工作卡，填实际项目、分支、实例和状态。
            </li>
            <li>
              <b>收工时：</b>写清已做什么、阻碍、验证结果和下一步。完成任务与 PR
              合并是两个状态。
            </li>
            <li>
              <b>需要接手：</b>
              {sharedEdit
                ? "先确认分工再交接负责人。修改他人进展前先读最新内容，不覆盖尚未核实的结论。"
                : "明确交接给已有成员；其他成员可以评论，不覆盖别人的内容。"}
            </li>
            <li>
              <b>结束后：</b>归档不用的卡片。归档保留 14
              天；活跃内容不会自动删除。
            </li>
          </ol>
          <p>
            <b>连线规则：</b>
            每项工作只归属一个具体主题，创建工作时选择主题就会自动连线；同主题成员不逐张互连。真正的依赖最多
            3 个直接前置，额外相关线每卡最多 1
            条，并写明原因。同实例用实例信息和搜索。
          </p>
          <p>
            点击“一键整理”按项目和主题排版，“撤销整理”恢复上一次位置。默认只显示主题线，选中卡片查看依赖或相关线，也可切换“全部连线”。
          </p>
          <a href="/AGENT_INSTRUCTIONS.md" target="_blank" rel="noreferrer">
            给 Agent 的简短更新与连线规范 ↗
          </a>
          <p>
            拖动位置不会改变工作内容版本。内容发生冲突时，保留草稿，重新读取并比较。
          </p>
          <p className="muted">
            白板记录进展，不授予执行、合并或部署权限。代码仓库、PR
            和原始论文文件仍是事实依据。
          </p>
          <a href="/api/guide" target="_blank" rel="noreferrer">
            查看 Agent 可读的接口与更新规范 ↗
          </a>
        </Modal>
      )}
      {dialog === "access" && (
        <AccessDialog
          actor={actor}
          sharedEdit={sharedEdit}
          actors={board.actors}
          act={act}
          onClose={() => setDialog("")}
        />
      )}
      {dialog === "admin" && (
        <AdminDialog
          onClose={() => setDialog("")}
          onSignIn={async (key) => {
            await onSignIn(key);
            setDialog("");
          }}
        />
      )}
    </div>
  );
}
function Modal({ title, onClose, children }) {
  const ref = useRef();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement;
    ref.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = ref.current?.querySelectorAll(
          "button,input,select,textarea,a[href]",
        );
        const first = items?.[0],
          last = items?.[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭窗口" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function CreateDialog({ kind, project, topics, onClose, onCreate }) {
  const [form, setForm] = useState({
      ...blank,
      kind: kind === "announcement" ? "note" : kind,
      announcement: kind === "announcement",
      project:
        project ||
        (kind === "announcement" ? "general" : topics[0]?.project) ||
        "general",
      topic_id: "",
    }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const change = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <Modal
      title={
        kind === "announcement"
          ? "发布公告"
          : kind === "topic"
            ? "添加主题"
            : kind === "work"
              ? "添加工作"
              : "添加便签"
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            const { topic_id, ...fields } = form;
            await onCreate({ ...fields, ...(topic_id ? { topic_id } : {}) });
          } catch (e) {
            setError(e.message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field
          label="标题"
          value={form.title}
          onChange={change("title")}
          required
          autoFocus
          maxLength={240}
        />
        <Field
          label="项目"
          value={form.project}
          onChange={(e) =>
            setForm((f) => ({ ...f, project: e.target.value, topic_id: "" }))
          }
          required
        />
        {kind === "announcement" && (
          <Field
            label="适用实例 / 对象"
            value={form.instance}
            onChange={change("instance")}
            placeholder="例如 全体成员，或某个实例的 Agents"
          />
        )}
        {kind !== "topic" && kind !== "announcement" && (
          <Field label="所属主题">
            <select
              required={kind === "work"}
              value={form.topic_id}
              onChange={change("topic_id")}
            >
              <option value="">
                {kind === "work"
                  ? "请选择主题（没有时先添加主题）"
                  : "独立便签 / 选择主题"}
              </option>
              {topics
                .filter((t) => t.project === form.project)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {kind === "topic" && (
          <p className="notice">
            主题是一个具体目标或持续工作范围，例如“会话与消息”或“10
            月发布与验收”。先沿用已有主题，不按每位 Agent 或实例另建主题。
          </p>
        )}
        {["work", "topic"].includes(kind) && (
          <Field
            label={
              kind === "topic"
                ? "固定主题编号"
                : "固定工作编号 · 后续用它找到同一项工作"
            }
            value={form.work_key}
            onChange={change("work_key")}
            required
            pattern="[a-z0-9][a-z0-9._:/-]*"
            placeholder={
              kind === "topic"
                ? "例如 topic/hashi/session"
                : "例如 hashi/settings/fc-api"
            }
          />
        )}
        <Field label={kind === "work" ? "要做什么 / 已有进展" : "内容"}>
          <textarea rows="5" value={form.body} onChange={change("body")} />
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={saving} type="submit">
          {saving
            ? "正在添加…"
            : kind === "announcement"
              ? "发布到公告栏"
              : "添加到白板"}
        </button>
      </form>
    </Modal>
  );
}
function Inspector({
  id,
  latest,
  actor,
  sharedEdit,
  actors,
  board,
  onSelect,
  act,
  onClose,
  draftGuard,
}) {
  const [base, setBase] = useState(null),
    [form, setForm] = useState(null),
    [comment, setComment] = useState(""),
    [target, setTarget] = useState(""),
    [handoffNote, setHandoffNote] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const read = useCallback(async () => {
    const { card } = await api(`/api/cards/${id}`);
    setBase(card);
    setForm(
      Object.fromEntries(CARD_FIELDS.map((k) => [k, fieldValue(card, k)])),
    );
  }, [id]);
  useEffect(() => {
    read().catch((e) => setError(e.message));
  }, [read]);
  useEffect(() => {
    if (!base || latest.comment_count === base.comments?.length) return;
    api(`/api/cards/${id}`)
      .then((x) =>
        setBase((b) => (b ? { ...b, comments: x.card.comments } : b)),
      )
      .catch(() => {});
  }, [latest.comment_count, id, base?.comments?.length]);
  const dirty = Boolean(
    base && form && CARD_FIELDS.some((k) => form[k] !== fieldValue(base, k)),
  );
  useEffect(() => {
    const guard = () =>
      !dirty || confirm("当前卡片有未保存的草稿。离开会丢弃草稿，确定离开吗？");
    draftGuard.current = guard;
    const beforeUnload = (event) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      if (draftGuard.current === guard) draftGuard.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, draftGuard]);
  if (!base || !form)
    return (
      <aside className="inspector">
        <button onClick={onClose}>关闭详情</button>
        <p role={error ? "alert" : undefined}>{error || "正在读取…"}</p>
      </aside>
    );
  const canWrite =
      sharedEdit || actor.role === "human" || base.owner_id === actor.id,
    conflict = latest.revision !== base.revision;
  const change = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const apply = async (fn) => {
    setSaving(true);
    setError("");
    try {
      const result = await act(fn);
      if (result.card) {
        const card = { ...result.card, comments: base.comments };
        setBase(card);
        setForm(
          Object.fromEntries(CARD_FIELDS.map((k) => [k, fieldValue(card, k)])),
        );
      }
      return result;
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <aside className="inspector">
      <header>
        <div>
          <span className="eyebrow">
            {base.announcement
              ? "ANNOUNCEMENT"
              : base.kind === "work"
                ? "WORK CARD"
                : "NOTE DETAILS"}
          </span>
          <h2>{base.announcement ? "公告详情" : "卡片详情"}</h2>
        </div>
        <button aria-label="关闭详情" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="inspector-scroll">
        <div className="item-identity">
          <code>{base.work_key || base.id}</code>
          <button onClick={() => copy(base.id)}>复制 ID</button>
        </div>
        <small className="muted">
          负责人：
          {actors.find((a) => a.id === base.owner_id)?.name || base.owner_id} ·
          版本 {base.revision}
        </small>
        {!base.announcement && (
          <RelationEditor
            card={base}
            board={board}
            canWrite={canWrite}
            onSelect={onSelect}
            mutate={(url, body) =>
              act(() => api(url, { method: "POST", body })).catch(() => {})
            }
          />
        )}
        {conflict && (
          <div className="conflict">
            <b>有更新，当前草稿已保留。</b>
            <p>最新内容：{latest.body || latest.title}</p>
            <button onClick={() => copy(JSON.stringify(form, null, 2))}>
              复制我的草稿
            </button>
            <button
              onClick={() => {
                if (confirm("重新读取会替换当前草稿，已先复制所需内容吗？"))
                  read().catch((e) => setError(e.message));
              }}
            >
              重新读取
            </button>
          </div>
        )}
        {!canWrite && (
          <p className="notice">
            您可以评论。修改内容请交给负责人，或请主人明确交接。
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const changes = Object.fromEntries(
              CARD_FIELDS.filter((k) => form[k] !== fieldValue(base, k)).map(
                (k) => [k, form[k]],
              ),
            );
            if (Object.keys(changes).length)
              apply(() =>
                api(`/api/cards/${id}`, {
                  method: "PATCH",
                  body: { expected_revision: base.revision, changes },
                }),
              );
          }}
        >
          <fieldset
            disabled={!canWrite || !!base.archived_at || saving || conflict}
          >
            <Field
              label="标题"
              value={form.title}
              onChange={change("title")}
              required
              maxLength={240}
            />
            <Field
              label="项目"
              value={form.project}
              onChange={change("project")}
              required
            />
            {base.kind === "note" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.announcement}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, announcement: e.target.checked }))
                  }
                />
                显示在公告栏
              </label>
            )}
            {form.announcement && (
              <Field
                label="适用实例 / 对象"
                value={form.instance}
                onChange={change("instance")}
              />
            )}
            {base.kind === "work" && (
              <Field label="工作状态">
                <select value={form.status} onChange={change("status")}>
                  {Object.entries(statusLabels).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label={
                base.kind === "work"
                  ? "进展 / 已完成的结果"
                  : base.kind === "image"
                    ? "图片说明"
                    : "内容"
              }
            >
              <textarea rows="7" value={form.body} onChange={change("body")} />
            </Field>
            {base.kind === "work" && (
              <>
                <Field label="下一步 / 接手须知">
                  <textarea
                    rows="3"
                    value={form.next_step}
                    onChange={change("next_step")}
                  />
                </Field>
                <Field
                  label="阻碍"
                  value={form.blocker}
                  onChange={change("blocker")}
                  required={form.status === "blocked"}
                />
                <details>
                  <summary>开发信息（论文等工作可留空）</summary>
                  <Field
                    label="代码仓库"
                    value={form.repository}
                    onChange={change("repository")}
                  />
                  <Field
                    label="分支"
                    value={form.branch}
                    onChange={change("branch")}
                  />
                  <Field
                    label="HASHI 实例 / 工作位置"
                    value={form.instance}
                    onChange={change("instance")}
                  />
                  <Field
                    label="PR 链接"
                    type="url"
                    value={form.pr_url}
                    onChange={change("pr_url")}
                  />
                  <Field label="PR 状态">
                    <select
                      value={form.merge_status}
                      onChange={change("merge_status")}
                    >
                      {Object.entries(mergeLabels).map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <small className="muted">
                    “工作已完成”不会自动意味着“PR 已合并”。
                  </small>
                </details>
              </>
            )}
            <button className="primary" type="submit" disabled={saving}>
              {saving ? "正在保存…" : "保存内容"}
            </button>
          </fieldset>
        </form>
        <div className="section-break" />
        <h3>评论 / 提醒</h3>
        <div className="comments">
          {base.comments.map((c) => (
            <div className={`comment ${c.system ? "system" : ""}`} key={c.id}>
              <small>
                {actors.find((a) => a.id === c.actor_id)?.name || c.actor_id} ·{" "}
                {new Date(c.created_at).toLocaleString("zh-CN")}
              </small>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply(() =>
              api(`/api/cards/${id}/comments`, {
                method: "POST",
                body: { body: comment },
              }),
            ).then(async (r) => {
              if (r) {
                setComment("");
                try {
                  const latest = await api(`/api/cards/${id}`);
                  setBase((b) => ({ ...b, comments: latest.card.comments }));
                } catch (e) {
                  setError(e.message);
                }
              }
            });
          }}
        >
          <Field label="添加一条评论">
            <textarea
              rows="2"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              required
              disabled={!!base.archived_at}
            />
          </Field>
          <button type="submit" disabled={saving || !!base.archived_at}>
            发送评论
          </button>
        </form>
        {canWrite && !base.archived_at && (
          <details>
            <summary>明确交接给下一位</summary>
            <Field label="新的负责人">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">请选择成员</option>
                {actors
                  .filter((a) => !a.disabled && a.id !== base.owner_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="已完成什么，下一步做什么">
              <textarea
                rows="3"
                value={handoffNote}
                onChange={(e) => setHandoffNote(e.target.value)}
              />
            </Field>
            <button
              disabled={
                !target || !handoffNote.trim() || saving || conflict || dirty
              }
              onClick={() =>
                apply(() =>
                  api(`/api/cards/${id}/handoff`, {
                    method: "POST",
                    body: {
                      expected_revision: base.revision,
                      new_owner_id: target,
                      note: handoffNote,
                    },
                  }),
                ).then((r) => r && read().catch((e) => setError(e.message)))
              }
            >
              确认交接
            </button>
          </details>
        )}
        {dirty && (
          <p className="muted">当前内容尚未保存。请先保存，再交接或归档。</p>
        )}
        {canWrite && (
          <button
            className="archive-button"
            disabled={saving || conflict || dirty}
            onClick={() => {
              if (
                base.archived_at ||
                confirm("归档后可在 14 天内恢复，之后自动清理。确定归档吗？")
              )
                apply(() =>
                  api(`/api/cards/${id}/archive`, {
                    method: "POST",
                    body: {
                      expected_revision: base.revision,
                      archived: !base.archived_at,
                    },
                  }),
                );
            }}
          >
            {base.announcement
              ? base.archived_at
                ? "恢复公告"
                : "撤下公告"
              : base.archived_at
                ? "恢复卡片"
                : "归档这张卡片"}
          </button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <small className="muted">
          最后更新：
          {actors.find((a) => a.id === base.updated_by)?.name ||
            base.updated_by}{" "}
          · {new Date(base.updated_at).toLocaleString("zh-CN")}
        </small>
      </div>
    </aside>
  );
}
function AdminDialog({ onClose, onSignIn }) {
  const [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="管理员登录" onClose={onClose}>
      <p>普通编辑不需要登录。管理员密钥仅用于管理独立 Agent 身份。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSignIn(key);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="管理员密钥"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          autoComplete="current-password"
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy} type="submit">
          登录管理
        </button>
      </form>
    </Modal>
  );
}
function AccessDialog({ actor, sharedEdit, actors, act, onClose }) {
  const [name, setName] = useState(""),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connectionUrl, setConnectionUrl] = useState(location.origin),
    [connectionUrls, setConnectionUrls] = useState([location.origin]);
  useEffect(() => {
    api("/api/connection")
      .then((info) => {
        setConnectionUrls([
          ...new Set([...info.lan_urls, location.origin, info.local_url]),
        ]);
        if (
          ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
          info.lan_urls.length
        )
          setConnectionUrl(info.lan_urls[0]);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Modal title="Agent 接入" onClose={onClose}>
      <p>
        {sharedEdit
          ? "局域网内的 Agent 可直接读写，无需密钥。若需区分每位 Agent 的更新记录，可选用管理员分配的独立密钥。"
          : "每位 Agent 使用独立密钥。名称建议包含 Agent 和实例，便于您区分；实际身份由密钥确定。"}
      </p>
      <Field label="Agent 连接地址（跨机器请选择局域网地址）">
        <select
          value={connectionUrl}
          onChange={(e) => setConnectionUrl(e.target.value)}
        >
          {connectionUrls.map((url) => (
            <option key={url}>{url}</option>
          ))}
        </select>
      </Field>
      {actor.role === "human" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await act(() =>
                api("/api/actors", { method: "POST", body: { name } }),
              );
              setResult(r);
              setName("");
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Agent 显示名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 玉环 · HASHI3"
            required
          />
          <button className="primary" type="submit" disabled={busy}>
            生成独立访问密钥
          </button>
        </form>
      ) : (
        <p className="notice">
          {sharedEdit
            ? "设置 WHITEBOARD_URL 为上方地址即可接入；未提供独立密钥的更新统一记为“局域网协作”。"
            : `请白板主人为您分配密钥。您的身份：${actor.id}`}
        </p>
      )}
      {result && (
        <div className="key-result">
          <b>{result.actor.name} 已建立</b>
          <p>请只把此密钥交给这位 Agent。关闭窗口后不再显示。</p>
          <code className="key-text">{result.token}</code>
          <button
            onClick={() =>
              copy(
                `WHITEBOARD_URL=${connectionUrl}\nWHITEBOARD_API_KEY=${result.token}`,
              )
            }
          >
            复制 Agent 连接信息
          </button>
          <small>actor_id：{result.actor.id}</small>
        </div>
      )}
      <p>
        Agent 接入地址：<code>{connectionUrl}</code>
        <br />
        <a href="/api/guide" target="_blank" rel="noreferrer">
          读取规范与 API ↗
        </a>{" "}
        · 项目包含 CLI 和标准输入输出 MCP 工具。
      </p>
      <div className="actor-list">
        {actors
          .filter((a) => a.role === "agent")
          .map((a) => (
            <div key={a.id}>
              <span>
                {a.name}
                <small>
                  {a.id}
                  {a.disabled ? " · 已撤销" : ""}
                </small>
              </span>
              {actor.role === "human" && !a.disabled && (
                <button
                  onClick={() => {
                    if (
                      confirm(
                        sharedEdit
                          ? `撤销 ${a.name} 的独立密钥？局域网免密编辑仍然开放，现有卡片会保留。`
                          : `撤销 ${a.name} 的白板访问？现有卡片会保留。`,
                      )
                    )
                      act(() =>
                        api(`/api/actors/${a.id}`, {
                          method: "DELETE",
                          body: {},
                        }),
                      ).catch((e) => setError(e.message));
                  }}
                >
                  撤销
                </button>
              )}
            </div>
          ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
export default App;
