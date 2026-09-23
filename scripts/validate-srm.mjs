// Headless validation for the srm showcase path (no browser, no Jev key).
// Usage: node scripts/validate-srm.mjs
import assert from "node:assert/strict";
import { generateWorld } from "../src/world.js";
import { Simulation } from "../src/simulation.js";
import { dist, move, pointAt, nearestOnPath, clamp } from "../src/math.js";
import { roadOccupancy, localRoads } from "../src/road-geometry.js";

// 1. Fixed path world: sequential trip start -> end.
const w = generateWorld(3, "srm");
assert.equal(w.type, "srm");
assert.equal(w.route.ids[0], w.startNode);
assert.equal(w.route.ids.at(-1), w.destination);
assert(w.route.length > 500);
for (let i = 1; i < w.route.ids.length; i++)
  assert(w.byId[w.route.ids[i - 1]].neighbors.includes(w.route.ids[i]));
const signals = w.nodes.filter((n) => n.control === "signal");
assert(signals.length >= 1);
console.log(
  `path: ${Math.round(w.route.length)}m, ${w.route.ids.length} nodes, ` +
    `${signals.length} signals (${signals.map((n) => n.id).join(",")})`,
);

// 2. Boot: no traffic, 24 pedestrians, guaranteed crosser, spawn on-road.
const sim = new Simulation(3, "srm");
assert.equal(sim.traffic.length, 0);
assert.equal(sim.pedestrians.length, 24);
const crossers = sim.pedestrians.filter((p) => p.crossing);
assert(crossers.length >= 1, "showcase needs a crossing pedestrian");
assert(
  roadOccupancy(sim.player, localRoads(sim.world, sim.player)).on_road,
  "spawn must be on-road",
);
console.log(`boot: 24 peds, ${crossers.length} crossing, spawn on-road`);

// 3. A crossing pedestrian actually walks within one signal cycle (24s).
// NOTE: step() clamps dt to 0.05, so 600 iterations = 30 sim-seconds.
let walked = false;
for (let i = 0; i < 600 && !walked; i++) {
  sim.step(0.05);
  walked = sim.pedestrians.some((p) => p.crossing && p.walking);
}
assert(walked, "no crossing pedestrian walked within 30s");
console.log("crossing: pedestrian walks during walk phase");

// 4. Planner sees the crossing pedestrian near the signal approach.
const state = sim.decisionState();
assert(Object.keys(state.vectors).length >= 2);
console.log(`plan: ${Object.keys(state.vectors).length} vectors`);

// 5. Full-path proxy drive completes without crash (traffic-free geometry).
{
  const drive = new Simulation(3, "srm");
  const v = drive.player;
  let worst = 0;
  let steps = 0;
  for (steps = 0; steps < 9000 && !drive.complete && !drive.crash; steps++) {
    const remaining = v.route.length - v.s;
    const cruise0 = Math.min(
      10,
      Math.sqrt(2 * 5 * Math.max(0, remaining - 1.5)),
    );
    const look = pointAt(v.route.points, v.s + 4 + Math.abs(v.speed) * 0.8);
    const want = Math.atan2(look.x - v.x, -(look.z - v.z));
    let dh = want - v.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const bend = Math.abs(dh);
    const cruise = Math.min(cruise0, bend > 0.5 ? 3 : bend > 0.26 ? 6 : 10);
    const err = cruise - v.speed;
    drive.pedals.throttle = err > 0.3 ? 1 : 0;
    drive.pedals.brake = err < -0.3 ? 1 : 0;
    drive.steeringInput = clamp(dh * 2, -1, 1);
    drive.step(0.05);
    worst = Math.max(worst, nearestOnPath(v, v.route.points).distance);
  }
  console.log(
    `full path: ${(steps * 0.05).toFixed(0)}s sim, worst offset ${worst.toFixed(1)}m, ` +
      `complete=${drive.complete}, crash=${!!drive.crash}`,
  );
  assert(!drive.crash, "proxy drive crashed");
  assert(drive.complete, "proxy drive did not finish the path");
}

// 6. Stop-line geometry exists at the signal crossings on the route.
const sigCrossings = sim.player.route.crossings.filter(
  (c) => sim.world.byId[c.nodeId].control === "signal",
);
assert(sigCrossings.length >= 1, "route should cross a signal");
for (const c of sigCrossings) assert(Number.isFinite(c.stopS));
console.log(`signals on route: ${sigCrossings.length} with stop lines`);

console.log("ALL SRM CHECKS PASSED");
