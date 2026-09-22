import { rng, choose, dist, heading, move, samplePolyline } from "./math.js";
import { generateHighway, makeHighwayRoute } from "./highway.js";
import osmData from "./osm-data.json" with { type: "json" };
export const THEMES = {
  city: {
    name: "Skyline City",
    subtitle: "Long avenues. A higher horizon.",
    size: 5,
    traffic: 28,
    buildings: 0.97,
    limit: 18,
  },
  town: {
    name: "Cedar Town",
    subtitle: "Room between the crossroads.",
    size: 5,
    traffic: 14,
    buildings: 0.62,
    limit: 14,
  },
  highway: {
    name: "Interstate 08",
    subtitle: "On-ramp, open road, small-town arrival.",
    size: 8,
    traffic: 18,
    buildings: 0,
    limit: 28,
    laneOffset: 9,
  },
  osm: {
    name: "SRM University",
    subtitle: "Neerukonda, Andhra Pradesh — real streets from OpenStreetMap.",
    traffic: 12,
    buildings: 0,
    limit: 14,
  },
};
export function generateWorld(seed, type = "town") {
  if (type === "highway") return generateHighway(seed, THEMES.highway);
  if (type === "osm") return loadOsmWorld(seed);
  const r = rng(seed),
    theme = THEMES[type],
    n = theme.size,
    xs = [0],
    zs = [0];
  for (let i = 1; i < n; i++) {
    xs.push(xs.at(-1) + (type === "city" ? 125 : 110) + Math.floor(r() * 55));
    zs.push(zs.at(-1) + (type === "city" ? 125 : 110) + Math.floor(r() * 55));
  }
  const cx = xs.at(-1) / 2,
    cz = zs.at(-1) / 2;
  xs.forEach((v, i) => (xs[i] = v - cx));
  zs.forEach((v, i) => (zs[i] = v - cz));
  const nodes = [],
    edges = [],
    objects = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      nodes.push({
        id: `j${j}-${i}`,
        i,
        j,
        x: xs[i],
        z: zs[j],
        control: (i + j) % 3 === 0 ? "stop" : "signal",
        offset: Math.floor(r() * 14),
        neighbors: [],
      });
  const link = (a, b) => {
    a.neighbors.push(b.id);
    b.neighbors.push(a.id);
    edges.push({
      id: `road-${edges.length}`,
      a: a.id,
      b: b.id,
      length: dist(a, b),
      width: 12,
      speedLimit: theme.limit,
      name:
        choose(r, [
          "Cedar",
          "Maple",
          "Willow",
          "Juniper",
          "Oak",
          "Birch",
          "Laurel",
        ]) + choose(r, [" Street", " Avenue", " Way"]),
    });
  };
  // All horizontal streets and a vertical spine ensure connectivity; other links vary.
  for (const p of nodes) {
    if (p.i < n - 1) link(p, nodes[p.j * n + p.i + 1]);
    if (p.j < n - 1 && (p.i === 2 || (p.i === 1 && p.j === 1) || r() > 0.16))
      link(p, nodes[(p.j + 1) * n + p.i]);
  }
  let id = 0;
  const add = (type, x, z, props = {}) =>
    objects.push({ id: `${type}-${id++}`, type, x, z, ...props });
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const x = (xs[i] + xs[i + 1]) / 2,
        z = (zs[j] + zs[j + 1]) / 2,
        w = xs[i + 1] - xs[i],
        d = zs[j + 1] - zs[j],
        park = r() > theme.buildings;
      add("parcel", x, z, { width: w - 17, depth: d - 17, park });
      for (const dx of [-1, 1])
        for (const dz of [-1, 1]) {
          const bx = x + dx * (w / 2 - 17),
            bz = z + dz * (d / 2 - 17);
          if (!park) {
            const style =
              type === "city"
                ? choose(r, ["skyscraper", "skyscraper", "apartment", "shop"])
                : choose(r, ["cottage", "cottage", "modern", "townhouse"]);
            add("building", bx, bz, {
              style,
              width: (type === "city" ? 16 : 10) + r() * 2,
              depth: (type === "city" ? 16 : 10) + r() * 2,
              height:
                style === "skyscraper"
                  ? 34 + r() * 58
                  : style === "apartment"
                    ? 18 + r() * 12
                    : style === "townhouse"
                      ? 8
                      : 4 + r() * 2,
              color: choose(r, [
                "#eadbc9",
                "#e6ad91",
                "#d9e2ce",
                "#e5c977",
                "#bdd3d0",
                "#ebd9ad",
              ]),
              roof: choose(r, ["#697577", "#a26f58", "#536d65"]),
              rotation: dz < 0 ? Math.PI : 0,
            });
          } else
            add("tree", bx, bz, {
              height: 5 + r() * 4,
              kind: r() > 0.4 ? "round" : "pine",
            });
        }
      if (!park) {
        for (const axis of ["x", "z"]) {
          const length = axis === "x" ? w : d;
          for (let t = -length / 2 + 39; t < length / 2 - 28; t += 24) {
            for (const side of [-1, 1]) {
              const bx = axis === "x" ? x + t : x + side * (w / 2 - 17);
              const bz = axis === "z" ? z + t : z + side * (d / 2 - 17);
              const style =
                type === "city"
                  ? choose(r, ["skyscraper", "skyscraper", "apartment"])
                  : choose(r, ["cottage", "modern"]);
              add("building", bx, bz, {
                style,
                width: (type === "city" ? 16 : 10) + r() * 2,
                depth: (type === "city" ? 16 : 10) + r() * 2,
                height:
                  style === "skyscraper"
                    ? 32 + r() * 65
                    : style === "apartment"
                      ? 18 + r() * 12
                      : 5 + r() * 3,
                color: choose(r, [
                  "#eadbc9",
                  "#d9e2ce",
                  "#e6ad91",
                  "#bdd3d0",
                  "#ebd9ad",
                ]),
                roof: choose(r, ["#697577", "#a26f58", "#536d65"]),
                rotation:
                  axis === "x"
                    ? side < 0
                      ? Math.PI
                      : 0
                    : side < 0
                      ? -Math.PI / 2
                      : Math.PI / 2,
              });
            }
          }
        }
      }
      for (let k = 0; k < (park ? 22 : 12); k++)
        add("tree", x + (r() - 0.5) * (w - 22), z + (r() - 0.5) * (d - 22), {
          height: 4 + r() * 5,
          kind: r() > 0.3 ? "round" : "pine",
        });
      if (park) add("bench", x, z, { rotation: 0 });
    }
  // Tree-lined outer boundary.
  for (let k = 0; k < 65; k++) {
    const side = k % 4;
    add(
      "tree",
      side < 2
        ? side === 0
          ? xs[0] - 17
          : xs.at(-1) + 17
        : xs[0] + r() * (xs.at(-1) - xs[0]),
      side >= 2
        ? side === 2
          ? zs[0] - 17
          : zs.at(-1) + 17
        : zs[0] + r() * (zs.at(-1) - zs[0]),
      { height: 5 + r() * 7, kind: choose(r, ["round", "pine"]) },
    );
  }
  const byId = Object.fromEntries(nodes.map((v) => [v.id, v]));
  for (const node of nodes)
    for (const nid of node.neighbors) {
      const other = byId[nid],
        h = heading(other, node),
        p = move(move(node, h, -9), h + Math.PI / 2, 6.9);
      add(node.control === "stop" ? "stop_sign" : "traffic_light", p.x, p.z, {
        nodeId: node.id,
        approach: h,
        height: node.control === "stop" ? 2.8 : 4.8,
      });
    }
  const startNode = nodes[n + 1],
    nextNode = nodes[2 * n + 1];
  // A random destination on the far half of the graph, always reachable.
  const destination = choose(
    r,
    nodes.filter((p) => p.i >= n - 2 && p.j >= 1 && p.j < n - 1),
  );
  const glassColors = ["#8aa4ac", "#829eaa", "#749699", "#a4bab9"];
  objects
    .filter((o) => o.style === "skyscraper")
    .forEach((o, i) => (o.color = glassColors[i % glassColors.length]));
  const buildings = objects.filter((o) => o.type === "building");
  const clearObjects = objects.filter(
    (o) =>
      o.type !== "tree" ||
      !buildings.some(
        (b) =>
          Math.abs(o.x - b.x) < b.width / 2 + 1.8 &&
          Math.abs(o.z - b.z) < b.depth / 2 + 1.8,
      ),
  );
  const world = {
    seed,
    type,
    theme,
    nodes,
    byId,
    edges,
    objects: clearObjects,
    xs,
    zs,
    bounds: {
      minX: xs[0] - 28,
      maxX: xs.at(-1) + 28,
      minZ: zs[0] - 28,
      maxZ: zs.at(-1) + 28,
    },
    startNode: startNode.id,
    nextNode: nextNode.id,
    destination: destination.id,
  };
  world.route = makeRoute(world, [
    startNode.id,
    ...shortestPath(world, nextNode.id, destination.id, startNode.id),
  ]);
  return world;
}
// Real-world street graph bundled from OpenStreetMap (see scripts/convert-osm.mjs).
// The map itself is static; the seed varies the trip (start/destination) and,
// downstream, traffic and pedestrians.
export function loadOsmWorld(seed) {
  const r = rng(seed),
    theme = THEMES.osm;
  const nodes = osmData.nodes.map((n) => ({
    ...n,
    neighbors: [...n.neighbors],
  }));
  const edges = osmData.edges.map((e) => ({ ...e }));
  const objects = (osmData.objects ?? []).map((o) => ({ ...o }));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const world = {
    seed,
    type: "osm",
    theme,
    nodes,
    byId,
    edges,
    objects,
    xs: osmData.xs,
    zs: osmData.zs,
    bounds: osmData.bounds,
  };
  // A random start street and far destination, always routable: the bundled
  // graph is one strongly connected component, but dead-end next nodes and
  // the no-U-turn start constraint can still reject a pair, so retry.
  let trip = null;
  for (let attempt = 0; attempt < 60 && !trip; attempt++) {
    const e = choose(r, edges);
    const s = byId[e.a],
      nx = byId[e.b];
    const cands = nodes.filter(
      (n) => n.id !== s.id && n.id !== nx.id && dist(n, s) > 200,
    );
    if (!cands.length) continue;
    const d = choose(r, cands);
    try {
      const rest = shortestPath(world, nx.id, d.id, s.id);
      if (rest.length >= 2) trip = { s, nx, d, ids: [s.id, ...rest] };
    } catch {
      /* unreachable under the start constraint — try another pair */
    }
  }
  if (!trip) throw new Error("OSM trip search failed");
  world.startNode = trip.s.id;
  world.nextNode = trip.nx.id;
  world.destination = trip.d.id;
  world.route = makeRoute(world, trip.ids);
  return world;
}
export function shortestPath(world, start, end, previousNode = null) {
  const cost = { [start]: 0 },
    prev = {},
    todo = new Set(world.nodes.map((p) => p.id));
  while (todo.size) {
    let u;
    for (const id of todo)
      if (u === undefined || (cost[id] ?? Infinity) < (cost[u] ?? Infinity))
        u = id;
    if (u === end) break;
    todo.delete(u);
    for (const v of world.byId[u].neighbors) {
      // Preserve the incoming direction when planning a new trip. The remaining
      // shortest path has no backtracking, so the initial route has no U-turns.
      if (u === start && v === previousNode) continue;
      const c = cost[u] + dist(world.byId[u], world.byId[v]);
      if (c < (cost[v] ?? Infinity)) {
        cost[v] = c;
        prev[v] = u;
      }
    }
  }
  const route = [end];
  while (route[0] !== start) {
    if (!prev[route[0]]) throw Error("Unreachable destination");
    route.unshift(prev[route[0]]);
  }
  return route;
}
export function makeRoute(world, ids, laneOffset) {
  if (world.type === "highway") return makeHighwayRoute(world, ids, laneOffset);
  const raw = [],
    crossings = [];
  const nodes = ids.map((id) => world.byId[id]);
  const legWidth = (a, b) =>
    world.edges.find(
      (e) =>
        (e.a === a.id && e.b === b.id) ||
        (!e.oneWay && e.a === b.id && e.b === a.id),
    )?.width ?? 12;
  // Right-lane offset that keeps the car body on asphalt: 3 m on normal
  // streets, closer to the centerline on narrow real-world roads, leaving
  // ~0.5 m of body margin. All town/city streets are 12 m wide, so their
  // routes are byte-identical to before.
  const offset = (p, h, w = 12) =>
    move(p, h + Math.PI / 2, Math.max(0.25, Math.min(3, w / 2 - 1.5)));
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i],
      hin = heading(nodes[Math.max(0, i - 1)], nodes[i === 0 ? 1 : i]),
      hout = i < nodes.length - 1 ? heading(p, nodes[i + 1]) : hin;
    if (i === 0) {
      raw.push(move(offset(p, hout, legWidth(p, nodes[1])), hout, 14));
      continue;
    }
    if (i === nodes.length - 1) {
      raw.push(move(offset(p, hin, legWidth(nodes[i - 1], p)), hin, -15));
      continue;
    }
    const win = legWidth(nodes[i - 1], p),
      wout = legWidth(p, nodes[i + 1]);
    const a = move(offset(p, hin, win), hin, -11),
      b = move(offset(p, hout, wout), hout, 11);
    raw.push(a);
    if (Math.cos(hout - hin) < -0.99) {
      // Dead-end traffic makes a continuous turn into the opposite lane.
      const center = move(p, hin, -11);
      for (let k = 1; k <= 24; k++) {
        const theta = (k / 24) * Math.PI;
        raw.push(
          move(
            move(center, hin, Math.sin(theta) * 3),
            hin + Math.PI / 2,
            Math.cos(theta) * 3,
          ),
        );
      }
    } else if (Math.abs(Math.sin(hout - hin)) < 0.1) {
      raw.push(b);
    } else {
      // True intersection of the incoming/outgoing lane lines is the
      // quadratic control point. On the axis-aligned town grid this is
      // exactly the old axis-snapped corner; on diagonal real-world
      // streets it avoids kinks that cut across sidewalks.
      const d1x = Math.sin(hin),
        d1z = -Math.cos(hin),
        d2x = Math.sin(hout),
        d2z = -Math.cos(hout);
      const denom = d1x * d2z - d1z * d2x;
      let c;
      if (Math.abs(denom) < 1e-6) {
        c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      } else {
        const t = ((b.x - a.x) * d2z - (b.z - a.z) * d2x) / denom;
        c = { x: a.x + d1x * t, z: a.z + d1z * t };
      }
      for (let k = 1; k <= 16; k++) {
        const t = k / 16,
          u = 1 - t;
        raw.push({
          x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
          z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
        });
      }
    }
    crossings.push({
      nodeId: p.id,
      x: p.x,
      z: p.z,
      approach: hin,
      exit: hout,
      width: win,
    });
  }
  const points = samplePolyline(raw);
  for (const c of crossings) {
    const target = move(offset(c, c.approach, c.width), c.approach, -10.5);
    let best = Infinity;
    for (const p of points) {
      const d = dist(p, target);
      if (d < best) {
        best = d;
        c.stopS = p.s;
      }
    }
  }
  return { ids, points, crossings, length: points.at(-1).s };
}
export function signalState(node, time, approach) {
  const phase = (time + node.offset) % 24,
    ns = Math.abs(Math.cos(approach)) > 0.5;
  if (phase >= 20) return { color: "red", walk: true, remaining: 24 - phase };
  if (ns)
    return {
      color: phase < 8 ? "green" : phase < 10 ? "amber" : "red",
      walk: false,
      remaining: phase < 8 ? 8 - phase : phase < 10 ? 10 - phase : 24 - phase,
    };
  return {
    color: phase >= 10 && phase < 18 ? "green" : phase >= 18 ? "amber" : "red",
    walk: false,
    remaining: phase < 10 ? 10 - phase : phase < 18 ? 18 - phase : 20 - phase,
  };
}
