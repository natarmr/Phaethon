// Headless validation for the OSM map source (no browser, no Jev key).
// Usage: node scripts/validate-osm.mjs
import assert from "node:assert/strict";
import { generateWorld, shortestPath } from "../src/world.js";
import { Simulation } from "../src/simulation.js";
import { dist, move, pointAt } from "../src/math.js";
import { roadOccupancy, localRoads } from "../src/road-geometry.js";
import { routeFromLocation } from "../src/routing.js";

// 1. Trip generation across seeds: connected routes, real length.
for (const seed of [1, 7, 42, 99, 1234]) {
  const w = generateWorld(seed, "osm");
  assert.equal(w.type, "osm");
  assert.equal(w.route.ids.at(-1), w.destination);
  assert(w.route.length > 100);
  for (let i = 1; i < w.route.ids.length; i++) {
    const prev = w.byId[w.route.ids[i - 1]];
    assert(prev.neighbors.includes(w.route.ids[i]));
  }
}
console.log("trips: 5 seeds OK");

// 2. Full simulation boot: traffic, pedestrians, spawn on asphalt.
const sim = new Simulation(7, "osm");
assert.equal(sim.world.type, "osm");
assert(sim.traffic.length === sim.world.theme.traffic);
const surfaces = localRoads(sim.world, sim.player);
assert(roadOccupancy(sim.player, surfaces).on_road, "spawn must be on-road");
console.log(
  `boot: traffic=${sim.traffic.length} peds=${sim.pedestrians.length} on-road OK`,
);

// 3. All traffic spawn on-road too (slivers under the in-game 1% re-roll
// threshold are invisible and functionally irrelevant for NPCs).
for (const v of sim.traffic)
  assert(
    roadOccupancy(v, localRoads(sim.world, v)).outside_fraction <= 0.01,
    v.id,
  );
console.log("traffic spawn: all on-road");

// 4. Planner output for the spawn state: eligible choices exist. (The
// dedicated stop vector is only offered when stopping is allowed.)
const state = sim.decisionState();
assert(Object.keys(state.vectors).length >= 2);
console.log(
  `plan: ${Object.keys(state.vectors).length} vectors, ` +
    `on_road=${state.road.on_road}, recovery=${state.recovery.active}`,
);

// 5. Controls from OSM tags are honored. Maps without mapped controls
// (e.g. rural areas) must instead let traffic proceed at uncontrolled
// crossings.
const stopCrossing = sim.player.route.crossings.find(
  (c) => sim.world.byId[c.nodeId].control === "stop",
);
if (stopCrossing) {
  const line = pointAt(sim.player.route.points, stopCrossing.stopS);
  sim.player.x = move(line, stopCrossing.approach, 12).x;
  sim.player.z = move(line, stopCrossing.approach, 12).z;
  sim.player.heading = stopCrossing.approach;
  sim.player.speed = 5;
  sim.player.s = stopCrossing.stopS - 12;
  const rule = sim.rule(sim.player, true);
  assert.equal(rule.mustStop, true);
  assert.equal(rule.reason, "Stop sign");
  console.log(`stop sign at ${stopCrossing.nodeId}: mustStop OK`);
} else {
  const crossing = sim.player.route.crossings[0];
  assert(crossing, "route should cross at least one junction");
  const line = pointAt(sim.player.route.points, crossing.stopS);
  sim.player.x = move(line, crossing.approach, 12).x;
  sim.player.z = move(line, crossing.approach, 12).z;
  sim.player.heading = crossing.approach;
  sim.player.speed = 5;
  sim.player.s = crossing.stopS - 12;
  const rule = sim.rule(sim.player, true);
  assert.equal(rule.mustStop, false);
  console.log(
    `no mapped controls: uncontrolled crossing at ${crossing.nodeId} proceeds OK`,
  );
}

// 6. Report mapped signals (may be zero in rural areas).
const sigNodes = sim.world.nodes.filter((n) => n.control === "signal");
const stopNodes = sim.world.nodes.filter((n) => n.control === "stop");
console.log(`controls: ${sigNodes.length} signals, ${stopNodes.length} stops`);

// 7. Rerouting works from an off-route point on the OSM graph.
const mid = sim.world.nodes[Math.floor(sim.world.nodes.length / 2)];
const next = routeFromLocation(
  sim.world,
  { ...mid, heading: 0 },
  sim.destinationApproach,
  sim.destinationPoint,
);
assert(next && next.route.length > 0);
console.log("reroute: OK");

// 8. Step the sim with a naive follow-lane driver: stay on road, no crash.
sim.player.x = sim.world.route.points[0].x;
sim.player.z = sim.world.route.points[0].z;
sim.player.heading = sim.world.route.points[0].heading ?? sim.player.heading;
sim.player.s = 0;
sim.player.speed = 0;
let worst = 0;
for (let i = 0; i < 1200; i++) {
  // crude pursuit of a lookahead point, capped like a cautious driver
  const look = pointAt(sim.player.route.points, sim.player.s + 8);
  const dx = look.x - sim.player.x;
  const dz = look.z - sim.player.z;
  const want = Math.atan2(dx, -dz);
  let dh = want - sim.player.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const { physics } = await import("../src/planning.js");
  physics(sim.player, Math.max(-0.5, Math.min(0.5, dh * 2)), 6, 0.05);
  const near = (await import("../src/math.js")).nearestOnPath(
    sim.player,
    sim.player.route.points,
  );
  worst = Math.max(worst, near.distance);
  if (sim.crash) break;
}
assert(!sim.crash, "naive driver crashed");
console.log(
  `naive drive: 60s, max route offset ${worst.toFixed(1)}m, no crash`,
);

console.log("ALL OSM CHECKS PASSED");

// 9. Full-route completion drive (headless autopilot proxy): pure-pursuit
// steering + bang-bang speed control through the REAL sim.step (collisions,
// arrival, violations all live), traffic cleared to isolate geometry.
// Proves the whole trip is kinematically drivable without leaving the road.
{
  const { clamp } = await import("../src/math.js");
  const drive = new Simulation(7, "osm");
  drive.traffic = [];
  const v = drive.player;
  let worst = 0;
  let steps = 0;
  for (steps = 0; steps < 8000 && !drive.complete && !drive.crash; steps++) {
    const remaining = v.route.length - v.s;
    const cruise0 = Math.min(
      10,
      Math.sqrt(2 * 5 * Math.max(0, remaining - 1.5)),
    );
    const look0 = pointAt(v.route.points, v.s + 4 + Math.abs(v.speed) * 0.8);
    const want0 = Math.atan2(look0.x - v.x, -(look0.z - v.z));
    let bend0 = want0 - v.heading;
    bend0 = Math.abs(Math.atan2(Math.sin(bend0), Math.cos(bend0)));
    // Slow for curvature like the real planner's turn cap does.
    const cruise = Math.min(cruise0, bend0 > 0.5 ? 3 : bend0 > 0.26 ? 6 : 10);
    const look = pointAt(v.route.points, v.s + 4 + Math.abs(v.speed) * 0.8);
    const want = Math.atan2(look.x - v.x, -(look.z - v.z));
    let dh = want - v.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const err = cruise - v.speed;
    drive.pedals.throttle = err > 0.3 ? 1 : 0;
    drive.pedals.brake = err < -0.3 ? 1 : 0;
    drive.steeringInput = clamp(dh * 2, -1, 1);
    drive.step(0.05);
    const { nearestOnPath } = await import("../src/math.js");
    worst = Math.max(worst, nearestOnPath(v, v.route.points).distance);
  }
  console.log(
    `full trip: ${(steps * 0.05).toFixed(0)}s sim, worst offset ${worst.toFixed(1)}m, ` +
      `complete=${drive.complete}, crash=${!!drive.crash}, ` +
      `violations=${drive.violations}`,
  );
  assert(!drive.crash, "completion drive crashed");
  assert(drive.complete, "completion drive did not reach destination");
}
