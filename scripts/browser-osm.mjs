// Browser smoke test for the OSM map (no Jev key needed).
// Loads ?world=osm, asserts no page errors, car spawns on-road, manual
// drive works, planner vectors render, screenshots to artifacts/.
// Usage: BASE_URL=http://localhost:5173 node scripts/browser-osm.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1200, height: 800 },
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
// Resolve the exact main.js module URL (bootstrap.js imports it dynamically)
// so `import()` below returns the live module instance, not a copy.
const MAIN = `
  performance.getEntriesByType("resource").map((r) => r.name)
    .find((u) => u.includes("/src/main.js"))
`;
const url = new URL(
  "/?world=osm&seed=7",
  process.env.BASE_URL || "http://localhost:5173",
).href;
try {
  await page.goto(url);
  await page.locator("#minimap").waitFor({ timeout: 30000 });
  // Wait for the 3D scene to finish loading (loader overlay blocks clicks).
  await page.locator("#scene-loader").waitFor({ state: "hidden", timeout: 90000 });
  // Trigger a planner run first so sim.lastPlan exists (manual mode only
  // plans on demand for the candidate preview). DOM click, not a
  // Playwright actionability click: the app never navigates, but the
  // loader transition confuses the navigation waiter.
  await page.evaluate(() =>
    document.querySelector("#candidates-toggle").click(),
  );
  await page.waitForTimeout(3000);
  const info = await page.evaluate(async (mainExpr) => {
    // eslint-disable-next-line no-eval
    const src = eval(mainExpr);
    if (!src) throw new Error("main.js module not loaded yet");
    const { sim } = await import(src);
    const w = sim.world;
    return {
      type: w.type,
      nodes: w.nodes.length,
      edges: w.edges.length,
      routeM: Math.round(w.route.length),
      theme: w.theme.name,
      player: { x: sim.player.x, z: sim.player.z },
      onRoad: sim.lastPlan?.road?.on_road,
      recovery: sim.lastPlan?.recovery?.active,
      vectors: Object.keys(sim.lastPlan?.vectors ?? {}).length,
      dropdown: document.querySelector("#world-select").value,
    };
  }, MAIN);
  console.log("OSM WORLD", JSON.stringify(info, null, 1));
  if (info.type !== "osm") throw new Error("world type is not osm");
  if (info.dropdown !== "osm") throw new Error("dropdown did not select osm");
  if (info.onRoad !== true) throw new Error("player spawn is off-road");
  // Manual drive: W for 2s should move the car and raise speed above 0.
  // (DOM events, not Playwright clicks: something in the dev-HMR page
  // makes the click action's navigation waiter hang spuriously.)
  await page.evaluate(() => document.querySelector("#world-canvas").click());
  await page.keyboard.down("w");
  await page.waitForTimeout(2000);
  await page.keyboard.up("w");
  const speed = Number(await page.locator("#speed").innerText());
  console.log("speed after W:", speed);
  if (!(speed > 0)) throw new Error("manual drive did not move the car");
  await page.keyboard.down("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.up("Space");
  // Planner vectors visible via the Candidates toggle (already on).
  await page.waitForTimeout(1500);
  const vectors = await page.evaluate(async (mainExpr) => {
    // eslint-disable-next-line no-eval
    const src = eval(mainExpr);
    const { scene } = await import(src);
    return scene.vectors.group.children.length;
  }, MAIN);
  console.log("candidate meshes:", vectors);
  if (!(vectors > 0)) throw new Error("no candidate vectors rendered");
  await page.screenshot({ path: "artifacts/osm.png" });
  // Switch worlds and back to prove the picker round-trips.
  await page.locator("#world-select").selectOption("town");
  await page.waitForTimeout(2000);
  await page.locator("#world-select").selectOption("osm");
  await page.waitForTimeout(2000);
  const back = await page.evaluate(async (mainExpr) => {
    // eslint-disable-next-line no-eval
    const src = eval(mainExpr);
    const { sim } = await import(src);
    return sim.world.type;
  }, MAIN);
  if (back !== "osm") throw new Error("world picker did not return to osm");
  if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
  console.log("PASS: OSM map loads, spawns on-road, drives, renders.");
} finally {
  await browser.close();
}
