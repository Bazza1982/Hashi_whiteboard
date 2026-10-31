/**
 * Canonical Canvas relationship semantics.
 *
 * Persisted edges remain semantic triples: `source relation target`.
 * The visual flow can run in the opposite direction when the target enables
 * or produces the source. Keeping this rule in shared code prevents the
 * server-side layout and the renderer from disagreeing about arrow direction.
 */

export const CANVAS_EDGE_RELATIONS = Object.freeze([
  'related',
  'derived_from',
  'sent_to',
  'depends_on',
]);

const RELATION_FLOW = Object.freeze({
  related: Object.freeze({ directed: false, reverse: false }),
  derived_from: Object.freeze({ directed: true, reverse: true }),
  sent_to: Object.freeze({ directed: true, reverse: false }),
  depends_on: Object.freeze({ directed: true, reverse: true }),
});

export function normalizeCanvasEdgeRelation(value) {
  return CANVAS_EDGE_RELATIONS.includes(value) ? value : 'related';
}

/**
 * Resolve screen-facing flow without mutating the persisted semantic triple.
 *
 * Example: `recover depends_on input` is stored as recover -> input, while the
 * readable process flow is input -> recover.
 */
export function canvasEdgeFlowEndpoints(edge = {}) {
  const relation = normalizeCanvasEdgeRelation(edge.relation);
  const semantics = RELATION_FLOW[relation];
  const semanticSource = String(edge.source ?? '');
  const semanticTarget = String(edge.target ?? '');
  return {
    relation,
    directed: semantics.directed,
    reversed: semantics.reverse,
    semanticSource,
    semanticTarget,
    source: semantics.reverse ? semanticTarget : semanticSource,
    target: semantics.reverse ? semanticSource : semanticTarget,
  };
}
