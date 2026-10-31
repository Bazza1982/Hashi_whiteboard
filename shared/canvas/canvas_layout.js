import { canvasEdgeFlowEndpoints } from './canvas_edge_semantics.js';

/**
 * Deterministic, content-free Canvas layout shared by the renderer and server.
 *
 * The planner understands the one-level Group contract. Child coordinates stay
 * relative to their Group; the Group is resized to contain the planned child
 * layout. Graph meaning is never changed.
 */

const DEFAULT_COLUMN_GAP = 360;
const DEFAULT_ROW_GAP = 400;
const DEFAULT_ORIGIN = Object.freeze({ x: 80, y: 80 });
const NODE_GUTTER = Object.freeze({ x: 72, y: 64 });
const GROUP_INSET = Object.freeze({ left: 48, right: 48, top: 96, bottom: 48 });

function positiveDimension(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function estimatedNodeSize(node) {
  const type = String(node?.type || 'note');
  const measured = node?.measured || {};
  const width = positiveDimension(
    measured.width,
    node?.width,
    node?.data?.layout_width,
  ) || (type === 'group' ? 576 : 288);
  let fallbackHeight = 220;
  if (type === 'group') fallbackHeight = 420;
  else if (type === 'task') fallbackHeight = 340;
  else if (type === 'agent') fallbackHeight = 260;
  else if (type === 'approval') fallbackHeight = 240;
  else if (['artefact', 'message', 'result'].includes(type)) fallbackHeight = 360;
  const height = positiveDimension(
    measured.height,
    node?.height,
    node?.data?.layout_height,
  ) || fallbackHeight;
  return { width, height };
}

function causalEndpoints(edge) {
  const flow = canvasEdgeFlowEndpoints(edge);
  return { earlier: flow.source, later: flow.target };
}

function nodeOrder(left, right) {
  const leftTitle = String(left?.data?.title || left?.id || '');
  const rightTitle = String(right?.data?.title || right?.id || '');
  return leftTitle.localeCompare(rightTitle) || String(left.id).localeCompare(String(right.id));
}

function averageNeighbourOrder(nodeId, neighbours, order) {
  const values = (neighbours.get(String(nodeId)) || [])
    .map((id) => order.get(String(id)))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function orderedRows(columns, orderedColumns) {
  const order = new Map();
  for (const column of orderedColumns) {
    columns.get(column).forEach((node, index) => order.set(String(node.id), index));
  }
  return order;
}

function sortColumnByNeighbours(nodes, neighbours, order) {
  const stable = new Map(nodes.map((node, index) => [String(node.id), index]));
  nodes.sort((left, right) => {
    const leftScore = averageNeighbourOrder(left.id, neighbours, order);
    const rightScore = averageNeighbourOrder(right.id, neighbours, order);
    if (leftScore !== null && rightScore !== null && Math.abs(leftScore - rightScore) > 0.001) {
      return leftScore - rightScore;
    }
    if (leftScore !== null && rightScore === null) return -1;
    if (leftScore === null && rightScore !== null) return 1;
    return (stable.get(String(left.id)) || 0) - (stable.get(String(right.id)) || 0);
  });
}

function layoutLayered(nodes, edges, {
  annotationLane = false,
  columnGap = DEFAULT_COLUMN_GAP,
  direction = 'left_to_right',
  origin = DEFAULT_ORIGIN,
  rowGap = DEFAULT_ROW_GAP,
} = {}) {
  const scoped = [...(nodes || [])];
  if (!scoped.length) return [];
  const ids = new Set(scoped.map((node) => String(node.id)));
  const scopedEdges = (edges || []).filter((edge) => (
    ids.has(String(edge.source))
    && ids.has(String(edge.target))
    && String(edge.source) !== String(edge.target)
  ));
  const connected = new Set(scopedEdges.flatMap((edge) => [String(edge.source), String(edge.target)]));
  const annotations = annotationLane && connected.size
    ? scoped.filter((node) => node.type === 'note' && !connected.has(String(node.id)))
    : [];
  const annotationIds = new Set(annotations.map((node) => String(node.id)));
  const core = scoped.filter((node) => !annotationIds.has(String(node.id)));
  const layoutNodes = core.length ? core : scoped;
  const layoutIds = new Set(layoutNodes.map((node) => String(node.id)));
  const incoming = new Map([...layoutIds].map((id) => [id, 0]));
  const outgoing = new Map([...layoutIds].map((id) => [id, []]));
  const predecessors = new Map([...layoutIds].map((id) => [id, []]));

  for (const edge of scopedEdges) {
    const { earlier, later } = causalEndpoints(edge);
    if (!layoutIds.has(earlier) || !layoutIds.has(later)) continue;
    outgoing.get(earlier).push(later);
    predecessors.get(later).push(earlier);
    incoming.set(later, (incoming.get(later) || 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort();
  for (const sources of predecessors.values()) sources.sort();

  const level = new Map();
  const queue = [...layoutIds].filter((id) => (incoming.get(id) || 0) === 0).sort();
  if (!queue.length) queue.push([...layoutIds].sort()[0]);
  for (const id of queue) level.set(id, 0);
  const remainingIn = new Map(incoming);
  const queued = new Set(queue);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const nextLevel = (level.get(id) || 0) + 1;
    for (const target of outgoing.get(id) || []) {
      const left = (remainingIn.get(target) || 0) - 1;
      remainingIn.set(target, left);
      level.set(target, Math.max(level.get(target) ?? -1, nextLevel));
      if (left <= 0 && !queued.has(target)) {
        queue.push(target);
        queued.add(target);
      }
    }
  }
  for (const id of [...layoutIds].sort()) {
    if (!level.has(id)) level.set(id, 0);
  }

  const columns = new Map();
  for (const node of layoutNodes) {
    const column = level.get(String(node.id)) || 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  for (const list of columns.values()) list.sort(nodeOrder);

  // Alternating barycentric sweeps keep branches and merges aligned with their
  // neighbours instead of alphabetically introducing avoidable crossings.
  const orderedColumns = [...columns.keys()].sort((left, right) => left - right);
  for (let sweep = 0; sweep < 3; sweep += 1) {
    let order = orderedRows(columns, orderedColumns);
    for (const column of orderedColumns.slice(1)) {
      sortColumnByNeighbours(columns.get(column), predecessors, order);
      order = orderedRows(columns, orderedColumns);
    }
    order = orderedRows(columns, orderedColumns);
    for (const column of orderedColumns.slice(0, -1).toReversed()) {
      sortColumnByNeighbours(columns.get(column), outgoing, order);
      order = orderedRows(columns, orderedColumns);
    }
  }

  const positions = [];
  const secondarySpans = new Map();
  for (const column of orderedColumns) {
    const columnNodes = columns.get(column);
    let cursor = 0;
    let span = 0;
    columnNodes.forEach((node, index) => {
      const size = estimatedNodeSize(node);
      const secondarySpan = direction === 'top_to_bottom' ? size.width : size.height;
      span = cursor + secondarySpan;
      if (index < columnNodes.length - 1) {
        const gutter = direction === 'top_to_bottom' ? NODE_GUTTER.x : NODE_GUTTER.y;
        cursor += Math.max(rowGap, secondarySpan + gutter);
      }
    });
    secondarySpans.set(column, span);
  }
  const maximumSecondarySpan = Math.max(...secondarySpans.values());
  let primaryCursor = direction === 'top_to_bottom' ? origin.y : origin.x;
  for (const column of orderedColumns) {
    const columnNodes = columns.get(column);
    const primarySpan = Math.max(...columnNodes.map((node) => {
      const size = estimatedNodeSize(node);
      return direction === 'top_to_bottom' ? size.height : size.width;
    }));
    let secondaryCursor = (direction === 'top_to_bottom' ? origin.x : origin.y)
      + ((maximumSecondarySpan - secondarySpans.get(column)) / 2);
    for (const node of columnNodes) {
      const size = estimatedNodeSize(node);
      positions.push({
        id: node.id,
        position: direction === 'top_to_bottom'
          ? { x: secondaryCursor, y: primaryCursor }
          : { x: primaryCursor, y: secondaryCursor },
      });
      const secondarySpan = direction === 'top_to_bottom' ? size.width : size.height;
      const gutter = direction === 'top_to_bottom' ? NODE_GUTTER.x : NODE_GUTTER.y;
      secondaryCursor += Math.max(rowGap, secondarySpan + gutter);
    }
    const gutter = direction === 'top_to_bottom' ? NODE_GUTTER.y : NODE_GUTTER.x;
    primaryCursor += Math.max(columnGap, primarySpan + gutter);
  }

  if (annotations.length && core.length) {
    const byId = new Map(layoutNodes.map((node) => [String(node.id), node]));
    const bottom = positions.reduce((maximum, item) => {
      const node = byId.get(String(item.id));
      return Math.max(maximum, item.position.y + estimatedNodeSize(node).height);
    }, origin.y);
    let x = origin.x;
    const y = bottom + NODE_GUTTER.y;
    for (const node of [...annotations].sort(nodeOrder)) {
      positions.push({ id: node.id, position: { x, y } });
      x += Math.max(columnGap, estimatedNodeSize(node).width + NODE_GUTTER.x);
    }
  }
  return positions;
}

function positionMap(nodes, positions) {
  const output = new Map((nodes || []).map((node) => [String(node.id), node.position]));
  for (const item of positions || []) output.set(String(item.id), item.position);
  return output;
}

function groupDimensionChanges(nodes, groups) {
  const byId = new Map((nodes || []).map((node) => [String(node.id), node]));
  return (groups || []).some((item) => {
    const previous = byId.get(String(item.id));
    return !previous
      || Math.abs((Number(previous.data?.layout_width) || estimatedNodeSize(previous).width) - item.width) > 0.5
      || Math.abs((Number(previous.data?.layout_height) || estimatedNodeSize(previous).height) - item.height) > 0.5;
  });
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function orthogonalRoute(source, target) {
  const start = {
    x: source.x + source.width,
    y: source.y + (source.height / 2),
  };
  const end = {
    x: target.x,
    y: target.y + (target.height / 2),
  };
  if (Math.abs(start.y - end.y) <= 1) return [start, end];
  const middleX = end.x > start.x
    ? start.x + ((end.x - start.x) / 2)
    : Math.max(start.x, end.x) + (NODE_GUTTER.x / 2);
  return [
    start,
    { x: middleX, y: start.y },
    { x: middleX, y: end.y },
    end,
  ];
}

function routeSegments(points) {
  return points.slice(1).map((point, index) => ({ a: points[index], b: point }));
}

function between(value, first, second, inset = 0.5) {
  return value > Math.min(first, second) + inset && value < Math.max(first, second) - inset;
}

function segmentIntersectsRectangle(segment, rectangle) {
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  if (Math.abs(segment.a.y - segment.b.y) <= 1) {
    return segment.a.y > rectangle.y + 0.5
      && segment.a.y < bottom - 0.5
      && Math.max(segment.a.x, segment.b.x) > rectangle.x + 0.5
      && Math.min(segment.a.x, segment.b.x) < right - 0.5;
  }
  return segment.a.x > rectangle.x + 0.5
    && segment.a.x < right - 0.5
    && Math.max(segment.a.y, segment.b.y) > rectangle.y + 0.5
    && Math.min(segment.a.y, segment.b.y) < bottom - 0.5;
}

function orthogonalSegmentsCross(first, second) {
  const firstHorizontal = Math.abs(first.a.y - first.b.y) <= 1;
  const secondHorizontal = Math.abs(second.a.y - second.b.y) <= 1;
  if (firstHorizontal === secondHorizontal) return false;
  const horizontal = firstHorizontal ? first : second;
  const vertical = firstHorizontal ? second : first;
  return between(vertical.a.x, horizontal.a.x, horizontal.b.x, 0.5)
    && between(horizontal.a.y, vertical.a.y, vertical.b.y, 0.5);
}

function orthogonalSegmentsOverlap(first, second) {
  const firstHorizontal = Math.abs(first.a.y - first.b.y) <= 1;
  const secondHorizontal = Math.abs(second.a.y - second.b.y) <= 1;
  if (firstHorizontal !== secondHorizontal) return false;
  if (firstHorizontal) {
    if (Math.abs(first.a.y - second.a.y) > 1) return false;
    return Math.min(Math.max(first.a.x, first.b.x), Math.max(second.a.x, second.b.x))
      - Math.max(Math.min(first.a.x, first.b.x), Math.min(second.a.x, second.b.x)) > 1;
  }
  if (Math.abs(first.a.x - second.a.x) > 1) return false;
  return Math.min(Math.max(first.a.y, first.b.y), Math.max(second.a.y, second.b.y))
    - Math.max(Math.min(first.a.y, first.b.y), Math.min(second.a.y, second.b.y)) > 1;
}

/** Return content-free quality counters for diagnostics and regression tests. */
export function measureCanvasLayoutQuality(nodes, edges, positions = []) {
  const byId = new Map((nodes || []).map((node) => [String(node.id), node]));
  const positionsById = positionMap(nodes, positions);
  const scopes = new Map();
  for (const node of nodes || []) {
    const scope = String(node.parentId || '__root__');
    if (!scopes.has(scope)) scopes.set(scope, []);
    const position = positionsById.get(String(node.id)) || { x: 0, y: 0 };
    const size = estimatedNodeSize(node);
    scopes.get(scope).push({ id: String(node.id), ...position, ...size });
  }
  let overlaps = 0;
  for (const items of scopes.values()) {
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        if (rectanglesOverlap(items[left], items[right])) overlaps += 1;
      }
    }
  }

  const routesByScope = new Map();
  let backtracks = 0;
  let bends = 0;
  let ignoredEdges = 0;
  let routeLength = 0;
  for (const edge of edges || []) {
    const source = byId.get(String(edge.source));
    const target = byId.get(String(edge.target));
    if (!source || !target || String(source.parentId || '') !== String(target.parentId || '')) {
      ignoredEdges += 1;
      continue;
    }
    const flow = canvasEdgeFlowEndpoints(edge);
    const { earlier, later } = causalEndpoints(edge);
    const earlierNode = byId.get(earlier);
    const laterNode = byId.get(later);
    const earlierPosition = positionsById.get(earlier);
    const laterPosition = positionsById.get(later);
    if (!earlierNode || !laterNode || !earlierPosition || !laterPosition) continue;
    const earlierSize = estimatedNodeSize(earlierNode);
    const laterSize = estimatedNodeSize(laterNode);
    const sourceRect = { id: earlier, ...earlierPosition, ...earlierSize };
    const targetRect = { id: later, ...laterPosition, ...laterSize };
    const points = orthogonalRoute(sourceRect, targetRect);
    const segments = routeSegments(points);
    if (flow.directed && targetRect.x <= sourceRect.x + sourceRect.width + 1) backtracks += 1;
    bends += Math.max(0, points.length - 2);
    routeLength += segments.reduce((total, segment) => (
      total + Math.abs(segment.b.x - segment.a.x) + Math.abs(segment.b.y - segment.a.y)
    ), 0);
    const scope = String(source.parentId || '__root__');
    if (!routesByScope.has(scope)) routesByScope.set(scope, []);
    routesByScope.get(scope).push({
      segments,
      endpoints: new Set([String(edge.source), String(edge.target)]),
    });
  }
  let crossings = 0;
  let edgeOverlaps = 0;
  let nodeEdgeIntersections = 0;
  for (const [scope, routes] of routesByScope) {
    const rectangles = scopes.get(scope) || [];
    for (const route of routes) {
      for (const rectangle of rectangles) {
        if (route.endpoints.has(rectangle.id)) continue;
        if (route.segments.some((segment) => segmentIntersectsRectangle(segment, rectangle))) {
          nodeEdgeIntersections += 1;
        }
      }
    }
    for (let left = 0; left < routes.length; left += 1) {
      for (let right = left + 1; right < routes.length; right += 1) {
        if ([...routes[left].endpoints].some((id) => routes[right].endpoints.has(id))) continue;
        let crossed = false;
        let overlapped = false;
        for (const first of routes[left].segments) {
          for (const second of routes[right].segments) {
            crossed ||= orthogonalSegmentsCross(first, second);
            overlapped ||= orthogonalSegmentsOverlap(first, second);
          }
        }
        if (crossed) crossings += 1;
        if (overlapped) edgeOverlaps += 1;
      }
    }
  }
  return {
    overlaps,
    crossings,
    backtracks,
    node_edge_intersections: nodeEdgeIntersections,
    edge_overlaps: edgeOverlaps,
    bends,
    route_length: Math.round(routeLength),
    ignored_edges: ignoredEdges,
    score: (overlaps * 10_000)
      + (nodeEdgeIntersections * 2_500)
      + (crossings * 500)
      + (backtracks * 250)
      + (edgeOverlaps * 100)
      + bends,
  };
}

/**
 * Build an atomic tidy plan. `positions` includes both roots and Group
 * children; `groups` carries the containing dimensions required by the plan.
 */
export function computeTidyLayoutPlan(nodes, edges, options = {}) {
  const allNodes = nodes || [];
  const allEdges = edges || [];
  const roots = allNodes.filter((node) => !node.parentId);
  if (!roots.length) {
    const quality = measureCanvasLayoutQuality(allNodes, allEdges);
    return {
      positions: [],
      groups: [],
      changed: false,
      diagnostics: {
        algorithm: 'group_flow_v3',
        routing_model: 'orthogonal_ports_v1',
        measured_node_count: allNodes.filter(
          (node) => positiveDimension(node?.measured?.width) && positiveDimension(node?.measured?.height),
        ).length,
        reversed_flow_edge_count: allEdges.filter(
          (edge) => canvasEdgeFlowEndpoints(edge).reversed,
        ).length,
        root_count: 0,
        group_count: 0,
        child_count: 0,
        edge_count: allEdges.length,
        before: quality,
        after: quality,
      },
    };
  }

  const selected = options.selectedIds
    ? new Set([...options.selectedIds].map(String))
    : null;
  const rootsById = new Map(roots.map((node) => [String(node.id), node]));
  let scopedRoots = roots;
  if (selected?.size) {
    const scopedIds = new Set();
    for (const node of allNodes) {
      if (!selected.has(String(node.id))) continue;
      if (!node.parentId && rootsById.has(String(node.id))) scopedIds.add(String(node.id));
      else if (node.parentId && rootsById.has(String(node.parentId))) scopedIds.add(String(node.parentId));
    }
    scopedRoots = roots.filter((node) => scopedIds.has(String(node.id)));
    if (!scopedRoots.length) scopedRoots = roots;
  }

  const scopedRootIds = new Set(scopedRoots.map((node) => String(node.id)));
  const positions = [];
  const groups = [];
  let childCount = 0;
  for (const group of scopedRoots.filter((node) => node.type === 'group')) {
    const children = allNodes.filter((node) => String(node.parentId || '') === String(group.id));
    if (!children.length) continue;
    childCount += children.length;
    const childIds = new Set(children.map((node) => String(node.id)));
    const childEdges = allEdges.filter((edge) => (
      childIds.has(String(edge.source)) && childIds.has(String(edge.target))
    ));
    const childPositions = layoutLayered(children, childEdges, {
      annotationLane: true,
      columnGap: options.columnGap,
      direction: options.direction,
      origin: { x: GROUP_INSET.left, y: GROUP_INSET.top },
      rowGap: options.rowGap,
    });
    positions.push(...childPositions);
    const childById = new Map(children.map((node) => [String(node.id), node]));
    let right = GROUP_INSET.left;
    let bottom = GROUP_INSET.top;
    for (const item of childPositions) {
      const size = estimatedNodeSize(childById.get(String(item.id)));
      right = Math.max(right, item.position.x + size.width);
      bottom = Math.max(bottom, item.position.y + size.height);
    }
    groups.push({
      id: group.id,
      width: Math.max(576, Math.ceil(right + GROUP_INSET.right)),
      height: Math.max(420, Math.ceil(bottom + GROUP_INSET.bottom)),
    });
  }

  const groupPlans = new Map(groups.map((group) => [String(group.id), group]));
  const plannedRoots = scopedRoots.map((node) => {
    const group = groupPlans.get(String(node.id));
    return group
      ? {
        ...node,
        measured: { width: group.width, height: group.height },
        data: { ...node.data, layout_width: group.width, layout_height: group.height },
      }
      : node;
  });
  const rootPositions = layoutLayered(
    plannedRoots,
    allEdges.filter((edge) => (
      scopedRootIds.has(String(edge.source)) && scopedRootIds.has(String(edge.target))
    )),
    {
      columnGap: options.columnGap,
      direction: options.direction,
      origin: options.origin,
      rowGap: options.rowGap,
    },
  );
  positions.unshift(...rootPositions);

  const virtualNodes = allNodes.map((node) => {
    const group = groupPlans.get(String(node.id));
    return group
      ? {
        ...node,
        measured: { width: group.width, height: group.height },
        data: { ...node.data, layout_width: group.width, layout_height: group.height },
      }
      : node;
  });
  const before = measureCanvasLayoutQuality(allNodes, allEdges);
  const after = measureCanvasLayoutQuality(virtualNodes, allEdges, positions);
  const changed = tidyLayoutChangesPositions(allNodes, positions)
    || groupDimensionChanges(allNodes, groups);
  return {
    positions,
    groups,
    changed,
    diagnostics: {
      algorithm: 'group_flow_v3',
      routing_model: 'orthogonal_ports_v1',
      measured_node_count: allNodes.filter(
        (node) => positiveDimension(node?.measured?.width) && positiveDimension(node?.measured?.height),
      ).length,
      reversed_flow_edge_count: allEdges.filter(
        (edge) => canvasEdgeFlowEndpoints(edge).reversed,
      ).length,
      root_count: scopedRoots.length,
      group_count: groups.length,
      child_count: childCount,
      edge_count: allEdges.length,
      before,
      after,
    },
  };
}

/** Backwards-compatible positions-only facade. */
export function computeTidyLayout(nodes, edges, options = {}) {
  return computeTidyLayoutPlan(nodes, edges, options).positions;
}

export function tidyLayoutChangesPositions(beforeNodes, positions) {
  const byId = new Map((beforeNodes || []).map((node) => [String(node.id), node.position]));
  return (positions || []).some((item) => {
    const previous = byId.get(String(item.id));
    if (!previous) return true;
    return Math.abs(previous.x - item.position.x) > 0.5
      || Math.abs(previous.y - item.position.y) > 0.5;
  });
}
