"""Retryable OSM control-point fetch (traffic signals / stop signs).

Merges results into an existing tools/osm_raw.json (sets "controls").
Stdlib only. Usage: py tools/osm_controls.py [tools/osm_raw.json]
"""
import json
import math
import sys

from osm_fetch import BBOX, overpass  # noqa: F401  (same dir, stdlib impl)

OUT = sys.argv[1] if len(sys.argv) > 1 else "tools/osm_raw.json"
if len(sys.argv) > 5:
    BBOX.update(
        {
            "south": float(sys.argv[2]),
            "west": float(sys.argv[3]),
            "north": float(sys.argv[4]),
            "east": float(sys.argv[5]),
        }
    )
EARTH_R = 6371000.0


def main():
    s, w, n, e = BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"]
    lat0 = math.radians((s + n) / 2)
    lon0 = math.radians((w + e) / 2)

    def proj(lat, lon):
        return (
            math.radians(lon - lon0) * EARTH_R * math.cos(lat0),
            math.radians(lat - lat0) * EARTH_R,
        )

    q = f"""[out:json][timeout:90];
(node["highway"~"^(traffic_signals|stop|give_way)$"]"""
    q += f"({s},{w},{n},{e}););out geom;"
    els = overpass(q)["elements"]
    controls = [
        {
            "kind": (
                "signal"
                if el.get("tags", {}).get("highway") == "traffic_signals"
                else "stop"
            ),
            "x": proj(el["lat"], el["lon"])[0],
            "y": proj(el["lat"], el["lon"])[1],
        }
        for el in els
        if "lat" in el
    ]
    with open(OUT, encoding="utf-8") as f:
        raw = json.load(f)
    raw["controls"] = controls
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(raw, f)
    print(f"merged {len(controls)} control points into {OUT}")


if __name__ == "__main__":
    main()
