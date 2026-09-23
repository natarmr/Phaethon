// One-off builder: hand-picked SRM campus path -> src/srm-data.json.
//
// Input is plain lat/lng (right-click points from satellite view, ~15-30m
// apart plus at bends). When the walked GPX trace is done, replace TRACE
// with the GPX-derived points — same schema, nothing downstream changes.
//
// Projection MUST match tools/osm_fetch.py for the SRM bbox
// (S16.4520 W80.4970 N16.4740 E80.5170): equirectangular about its center.
// Usage: node scripts/build-srm.mjs [src/srm-data.json]
import { writeFileSync } from "node:fs";
import { dist, heading, move } from "../src/math.js";

const OUT = process.argv[2] ?? "src/srm-data.json";
// SRM bbox center (must match the osm_srm fetch frame).
const LAT0 = 16.463;
const LON0 = 80.507;
const R = 6371000.0;

// Hand-picked campus path: service road -> secondary -> residential north.
const TRACE = [
  [16.457955, 80.506437],
  [16.458027, 80.506934],
  [16.458782, 80.508407],
  [16.458881, 80.508472],
  [16.459115, 80.5085],
  [16.459232, 80.508238],
  [16.459331, 80.508144],
  [16.459502, 80.508107],
  [16.459502, 80.508388],
  [16.459457, 80.508529],
  [16.459304, 80.508829],
  [16.464241, 80.508847],
  [16.464295, 80.509054],
];
// Pedestrian-crossing showcase spots (snapped to nearest path node).
const SIGNALS = [
  [16.459502, 80.508107], // service road meets the secondary
  [16.46177, 80.508838], // mid-block on the north straight
];
const WIDTH = 12; // handoff default
const LIMIT = 14; // town limit (m/s)
const MAX_SEG = 25; // subdivide long legs to ~this spacing

const proj = ([lat, lon]) => ({
  x: (((lon - LON0) * Math.PI) / 180) * R * Math.cos((LAT0 * Math.PI) / 180),
  y: (((lat - LAT0) * Math.PI) / 180) * R,
});

// Densify to MAX_SEG spacing, keeping every hand-picked bend point.
const pts = [proj(TRACE[0])];
for (let i = 1; i < TRACE.length; i++) {
  const a = proj(TRACE[i - 1]);
  const b = proj(TRACE[i]);
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / MAX_SEG));
  for (let k = 1; k <= n; k++)
    pts.push({
      x: a.x + ((b.x - a.x) * k) / n,
      y: a.y + ((b.y - a.y) * k) / n,
    });
}

// Recenter: path midpoint -> (0,0), x east, z south.
const cx =
  (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
const cy =
  (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
const nodes = pts.map((p, i) => ({
  id: `srm-${i}`,
  x: Math.round((p.x - cx) * 100) / 100,
  z: Math.round(-(p.y - cy) * 100) / 100,
  offset: (i * 7) % 24,
  neighbors: [
    ...(i > 0 ? [`srm-${i - 1}`] : []),
    ...(i < pts.length - 1 ? [`srm-${i + 1}`] : []),
  ],
}));

// Tag the showcase crossings.
for (const s of SIGNALS) {
  const p = proj(s);
  const px = p.x - cx;
  const pz = -(p.y - cy);
  let best = nodes[0];
  for (const n of nodes)
    if (Math.hypot(n.x - px, n.z - pz) < Math.hypot(best.x - px, best.z - pz))
      best = n;
  if (Math.hypot(best.x - px, best.z - pz) > 30)
    throw new Error(`signal point too far from path: ${s}`);
  best.control = "signal";
  console.log(`signal: ${best.id} (offset ${best.offset})`);
}

const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const edges = [];
for (let i = 0; i < nodes.length - 1; i++) {
  const a = nodes[i];
  const b = nodes[i + 1];
  edges.push({
    id: `srm-e${i}`,
    a: a.id,
    b: b.id,
    length: Math.round(dist(a, b) * 100) / 100,
    width: WIDTH,
    speedLimit: LIMIT,
    name: "Campus Path",
  });
}

// Signal props, one per incoming approach (path is two-way: both sides).
const objects = [];
for (const node of nodes) {
  if (node.control !== "signal") continue;
  for (const pid of node.neighbors) {
    const other = byId[pid];
    const h = heading(other, node);
    const p = move(move(node, h, -9), h + Math.PI / 2, 6.9);
    objects.push({
      id: `srm-ctrl-${node.id}-${pid}`,
      type: "traffic_light",
      x: Math.round(p.x * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      nodeId: node.id,
      approach: Math.round(h * 1000) / 1000,
      height: 4.8,
    });
  }
}

const allX = nodes.map((n) => n.x);
const allZ = nodes.map((n) => n.z);
const doc = {
  type: "srm",
  theme: {
    name: "SRM Campus",
    subtitle: "Showcase walk path.",
    traffic: 0,
    buildings: 0,
    limit: LIMIT,
  },
  nodes,
  edges,
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
writeFileSync(OUT, JSON.stringify(doc));
const total = edges.reduce((s, e) => s + e.length, 0);
console.log(
  `nodes=${nodes.length} edges=${edges.length} signals=${nodes.filter((n) => n.control).length} length=${Math.round(total)}m -> ${OUT}`,
);
