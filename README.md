# Phaethon

A Three.js driving simulator with a Jev-powered autopilot, plus a real-world
OpenStreetMap district (SRM University, Andhra Pradesh).

## Run locally

```sh
npm ci
cp .env.example .env
# Set TYPESAFE_API_KEY in .env.
npm run dev
```

Open http://localhost:5173. Local dev skips login — Jev calls use your own key.

**J** autopilot · **WASD** drive · **Space** brake · **C** camera · **P** pause.

## Maps

Skyline City, Small town, Interstate 08 (procedural), and SRM University
(real streets from OpenStreetMap, bundled in `src/osm-data.json`).

Regenerate the OSM data:

```sh
py tools/osm_fetch.py tools/osm_raw.json <south west north east>
py tools/osm_controls.py tools/osm_raw.json <south west north east>
node scripts/convert-osm.mjs tools/osm_raw.json src/osm-data.json
```

## Checks

```sh
node scripts/validate-osm.mjs
npm run build
```
