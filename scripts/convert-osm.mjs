// One-off converter: tools/osm_raw.json -> src/osm-data.json (JevPilot schema).
//
// Mapping (see handoff):
//   node.control : traffic_signals -> "signal", stop/give_way -> "stop", else omit
//   edge.oneWay  : from oneway=yes/-1 (stored only when true)
//   edge.width   : lanes * 3.5, fallback 12
//   edge.speedLimit : from maxspeed (m/s), fallback 14 (town limit)
//   edge.length  : recomputed from projected coords
// Coordinates: OSM x=east, y=north (meters) -> JevPilot x=east, z=south,
// recentered so the bbox center sits near (0,0).
//
// Usage: node scripts/convert-osm.mjs [tools/osm_raw.json] [src/osm-data.json]
import { readFileSync, writeFileSync } from "node:fs";
import { dist, heading, move } from "../src/math.js";
import { shortestPath, makeRoute } from "../src/world.js";

const IN = process.argv[2] ?? "tools/osm_raw.json";
const OUT = process.argv[3] ?? "src/osm-data.json";
const DEFAULT_LIMIT = 14; // town limit fallback (m/s)
const DEFAULT_WIDTH = 12; // JevPilot default road width (m)

const first = (v) => (Array.isArray(v) ? v[0] : v);

function parseLanes(v) {
  const n = parseInt(first(v), 10);
  return Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : null;
}

// maxspeed tags: "25 mph", "50", "50|80", "signals", "none" ...
function parseMaxspeed(v) {
  const s = String(first(v) ?? "")
    .toLowerCase()
    .trim();
  const m = s.match(/([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = s.includes("mph") ? n * 0.44704 : n / 3.6;
  return Math.min(30, Math.max(4, ms));
}

function main() {
  const raw = JSON.parse(readFileSync(IN, "utf-8"));

  // Recenter: bbox center -> (0,0) so spawn sits near the origin.
  const xs = raw.nodes.map((n) => n.x);
  const ys = raw.nodes.map((n) => n.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const P = (x, y) => ({ x: x - cx, z: -(y - cy) });

  const byId = {};
  const nodes = raw.nodes.map((n) => {
    const p = P(n.x, n.y);
    const node = {
      id: `osm-${n.osmid}`,
      x: Math.round(p.x * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      control: n.traffic_signals ? "signal" : undefined,
      offset: 0,
      neighbors: [],
    };
    if (node.control === undefined) delete node.control;
    else node.offset = Number(n.osmid) % 24;
    byId[node.id] = node;
    return node;
  });
  const rawById = Object.fromEntries(raw.nodes.map((n) => [n.osmid, n]));

  // Snap OSM control points (signals/stops) to the nearest graph node.
  // simplify_graph often collapses the tagged nodes themselves.
  for (const c of raw.controls ?? []) {
    const p = P(c.x, c.y);
    let best = null;
    for (const node of nodes) {
      const d = Math.hypot(node.x - p.x, node.z - p.z);
      if (d < 25 && (best === null || d < best.d)) best = { node, d };
    }
    if (!best) continue;
    // A real signal wins over a stop; never downgrade.
    if (c.kind === "signal" || best.node.control === undefined) {
      best.node.control = c.kind;
      best.node.offset = Math.abs(Math.round(c.x + c.y)) % 24;
    }
  }

  const seen = new Set();
  const edges = [];
  for (const e of raw.edges) {
    const a = byId[`osm-${e.u}`];
    const b = byId[`osm-${e.v}`];
    if (!a || !b || e.u === e.v) continue; // pruned node or self-loop
    const [lo, hi] = e.u < e.v ? [e.u, e.v] : [e.v, e.u];
    const key = e.oneway ? `1:${e.u}>${e.v}` : `2:${lo}-${hi}`;
    if (seen.has(key)) continue; // parallel duplicate edge
    seen.add(key);
    const length = dist(a, b);
    if (length < 2) continue; // degenerate stub
    const lanes = parseLanes(e.lanes);
    const edge = {
      id: `osm-e${edges.length}`,
      a: a.id,
      b: b.id,
      length: Math.round(length * 100) / 100,
      width: lanes ? Math.round(lanes * 3.5 * 10) / 10 : DEFAULT_WIDTH,
      speedLimit: parseMaxspeed(e.maxspeed) ?? DEFAULT_LIMIT,
      name: first(e.name) ?? first(e.highway) ?? "Local Street",
    };
    if (typeof edge.name !== "string") edge.name = "Local Street";
    if (e.oneway) edge.oneWay = true;
    a.neighbors.push(b.id);
    if (!e.oneway) b.neighbors.push(a.id);
    edges.push(edge);
  }

  // Drop nodes left edgeless by dedupe/pruning.
  const used = new Set();
  for (const e of edges) {
    used.add(e.a);
    used.add(e.b);
  }
  let live = nodes.filter((n) => used.has(n.id));
  let liveById = Object.fromEntries(live.map((n) => [n.id, n]));
  let liveEdges = edges.filter((e) => liveById[e.a] && liveById[e.b]);

  // Short-edge stubs can bridge-filter the graph, so recompute the largest
  // strongly connected component on the FINAL edge set (one-ways respected).
  const succ = new Map();
  for (const e of liveEdges) {
    if (!succ.has(e.a)) succ.set(e.a, []);
    succ.get(e.a).push(e.b);
    if (!e.oneWay) {
      if (!succ.has(e.b)) succ.set(e.b, []);
      succ.get(e.b).push(e.a);
    }
  }
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let counter = 0;
  for (const root of succ.keys()) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const [node, ci] = work[work.length - 1];
      const children = succ.get(node) ?? [];
      if (ci < children.length) {
        work[work.length - 1][1]++;
        const m = children[ci];
        if (!index.has(m)) {
          index.set(m, counter);
          low.set(m, counter);
          counter++;
          stack.push(m);
          onStack.add(m);
          work.push([m, 0]);
        } else if (onStack.has(m)) {
          low.set(node, Math.min(low.get(node), index.get(m)));
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p), low.get(node)));
        }
        if (low.get(node) === index.get(node)) {
          const comp = [];
          for (;;) {
            const m = stack.pop();
            onStack.delete(m);
            comp.push(m);
            if (m === node) break;
          }
          comps.push(comp);
        }
      }
    }
  }
  const biggest = new Set(comps.sort((a, b) => b.length - a.length)[0] ?? []);
  live = live.filter((n) => biggest.has(n.id));
  liveById = Object.fromEntries(live.map((n) => [n.id, n]));
  liveEdges = liveEdges.filter((e) => liveById[e.a] && liveById[e.b]);
  for (const n of live) n.neighbors = n.neighbors.filter((id) => liveById[id]);

  if (live.length === 0) throw new Error("OSM conversion produced no nodes");

  // Stop-sign / signal props, one per incoming approach (predecessors, so
  // one-way streets get the sign on the correct side).
  const preds = {};
  for (const e of liveEdges) {
    (preds[e.b] ??= []).push(e.a);
    if (!e.oneWay) (preds[e.a] ??= []).push(e.b);
  }
  const objects = [];
  for (const node of live) {
    if (!node.control) continue;
    for (const pid of preds[node.id] ?? []) {
      const other = liveById[pid];
      const h = heading(other, node);
      const p = move(move(node, h, -9), h + Math.PI / 2, 6.9);
      objects.push({
        id: `osm-ctrl-${node.id}-${pid}`,
        type: node.control === "stop" ? "stop_sign" : "traffic_light",
        x: Math.round(p.x * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        nodeId: node.id,
        approach: Math.round(h * 1000) / 1000,
        height: node.control === "stop" ? 2.8 : 4.8,
      });
    }
  }

  const allX = live.map((n) => n.x);
  const allZ = live.map((n) => n.z);
  const world = {
    type: "osm",
    theme: {
      name: "SRM University",
      subtitle: "Neerukonda, Andhra Pradesh — real streets from OpenStreetMap.",
      traffic: 12,
      buildings: 0,
      limit: DEFAULT_LIMIT,
    },
    nodes: live,
    byId: liveById,
    edges: liveEdges,
    objects,
    xs: [Math.min(...allX), Math.max(...allX)],
    zs: [Math.min(...allZ), Math.max(...allZ)],
    bounds: {
      minX: Math.min(...allX) - 28,
      maxX: Math.max(...allX) + 28,
      minZ: Math.min(...allZ) - 28,
      maxZ: Math.max(...allZ) + 28,
    },
  };

  // Validate with the real routing code: every node reachable from the
  // center-most node, and a sample route builds clean stop lines.
  const center = live.reduce((a, b) =>
    Math.hypot(a.x, a.z) < Math.hypot(b.x, b.z) ? a : b,
  );
  let reached = 0;
  for (const n of live) {
    try {
      shortestPath(world, center.id, n.id);
      reached++;
    } catch {
      /* unreachable */
    }
  }
  console.log(
    `nodes=${live.length} edges=${edges.length} ` +
      `oneWay=${edges.filter((e) => e.oneWay).length} ` +
      `signals=${live.filter((n) => n.control === "signal").length} ` +
      `stops=${live.filter((n) => n.control === "stop").length} ` +
      `reachable=${reached}/${live.length}`,
  );
  if (reached < live.length)
    throw new Error(`unreachable OSM nodes remain (${live.length - reached})`);

  const far = [...live].sort(
    (a, b) =>
      Math.hypot(b.x - center.x, b.z - center.z) -
      Math.hypot(a.x - center.x, a.z - center.z),
  )[0];
  const probe = makeRoute(world, [
    center.id,
    ...shortestPath(world, center.neighbors[0], far.id, center.id),
  ]);
  console.log(
    `probe route: ${probe.ids.length} nodes, ${Math.round(probe.length)}m, ` +
      `${probe.crossings.length} crossings`,
  );

  // Strip runtime-only fields; loadOsmWorld() re-derives trip + route per seed.
  const doc = {
    ...world,
    byId: undefined,
    seed: undefined,
    route: undefined,
    startNode: undefined,
    nextNode: undefined,
    destination: undefined,
  };
  delete doc.byId;
  writeFileSync(OUT, JSON.stringify(doc));
  console.log(`wrote ${OUT} (${Buffer.byteLength(JSON.stringify(doc))} bytes)`);
}

main();
