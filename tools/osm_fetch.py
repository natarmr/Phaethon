"""One-off OSM road-graph fetch for JevPilot (stdlib only).

Downloads a drivable road network for a small bbox from Overpass API,
simplifies it to real intersections (+ shape nodes where streets curve),
projects to local meters, keeps the largest strongly connected component
(one-ways respected), and dumps nodes/edges with tags to JSON for
scripts/convert-osm.mjs.

No third-party packages needed (osmnx wheels are blocked on this machine):
uses urllib + json + math only.

Usage: py tools/osm_fetch.py [out.json]

Default bbox: ~550m x ~620m around Castro St, Mountain View, CA.
"""
import json
import math
import sys
import urllib.request

BBOX = {  # degrees; override: py tools/osm_fetch.py out.json S W N E
    "north": 37.3938,
    "south": 37.3888,
    "east": -122.0780,
    "west": -122.0840,
}
OUT = sys.argv[1] if len(sys.argv) > 1 else "tools/osm_raw.json"
if len(sys.argv) > 5:
    BBOX = {
        "south": float(sys.argv[2]),
        "west": float(sys.argv[3]),
        "north": float(sys.argv[4]),
        "east": float(sys.argv[5]),
    }
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# Drivable road classes (mirrors osmnx network_type="drive", minus areas).
NON_DRIVE = {
    "footway", "cycleway", "path", "steps", "pedestrian", "bridleway",
    "corridor", "elevator", "platform", "proposed", "construction",
    "bus_guideway", "busway", "raceway", "escape", "track",
}
EARTH_R = 6371000.0


def overpass(query, tries=4):
    import time

    data = ("data=" + urllib.request.quote(query)).encode()
    last = None
    for attempt in range(tries):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(
                    url,
                    data=data,
                    method="POST",
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "JevPilotOSMImport/1.0",
                    },
                )
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.load(r)
            except Exception as e:  # try next mirror
                last = e
                print(f"overpass {url} failed: {e}, trying next")
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"all overpass mirrors failed: {last}")


def main():
    s, w, n, e = BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"]
    bbox = f"{s},{w},{n},{e}"
    ways_q = f"""[out:json][timeout:90];
(way["highway"]["area"!~"yes"]({bbox}););
out geom;"""
    ctrl_q = f"""[out:json][timeout:90];
(node["highway"~"^(traffic_signals|stop|give_way)$"]({bbox}););
out geom;"""
    ways = overpass(ways_q)["elements"]
    try:
        ctrls = overpass(ctrl_q)["elements"]
    except RuntimeError as ex:
        print(f"control-point fetch skipped: {ex}")
        ctrls = []
    print(f"ways={len(ways)} control_pts={len(ctrls)}")

    # Local projection: equirectangular about bbox center (cm-accurate here).
    lat0 = math.radians((s + n) / 2)
    lon0 = math.radians((w + e) / 2)

    def proj(lat, lon):
        return (
            (math.radians(lon) - lon0) * EARTH_R * math.cos(lat0),
            (math.radians(lat) - lat0) * EARTH_R,
        )

    # Build vertex sequences per way, with drivable tags.
    seqs = []
    for el in ways:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        hw = tags.get("highway", "")
        if hw in NON_DRIVE or tags.get("area") == "yes":
            continue
        if tags.get("motor_vehicle") == "no" or tags.get("access") in (
            "no", "private",
        ):
            continue
        geom = el["geometry"]
        if len(geom) < 2:
            continue
        oneway = tags.get("oneway", "no")
        implied = hw == "motorway" or tags.get("junction") == "roundabout"
        if oneway == "-1":
            directed, flip = True, True
        elif oneway in ("yes", "true", "1") or (implied and oneway != "no"):
            directed, flip = True, False
        else:
            directed, flip = False, False
        pts = [proj(p["lat"], p["lon"]) for p in geom]
        if flip:
            pts.reverse()
        seqs.append({
            "pts": pts,
            "oneway": directed,
            "lanes": tags.get("lanes"),
            "maxspeed": tags.get("maxspeed"),
            "name": tags.get("name"),
            "highway": hw,
        })
    print(f"drivable ways={len(seqs)}")

    # Vertex identity: round to 0.5m grid (shared intersections coincide).
    def key(p):
        return (round(p[0] * 2), round(p[1] * 2))

    # Count distinct adjacent vertices per vertex (topology).
    adj = {}
    for sq in seqs:
        ks = [key(p) for p in sq["pts"]]
        for i, k in enumerate(ks):
            s_ = adj.setdefault(k, set())
            if i > 0:
                s_.add(ks[i - 1])
            if i < len(ks) - 1:
                s_.add(ks[i + 1])

    # Keep: intersections, dead-ends, tag-change points, curve points.
    # Tag signature per segment decides tag-change keeps.
    def sig(sq):
        return (sq["oneway"], sq["lanes"], sq["maxspeed"], sq["name"])

    # Map vertex -> set of incident segment sigs.
    vert_sig = {}
    for sq in seqs:
        ks = [key(p) for p in sq["pts"]]
        for i in range(len(ks) - 1):
            for k in (ks[i], ks[i + 1]):
                vert_sig.setdefault(k, set()).add(sig(sq))

    keep = set()
    for k, nb in adj.items():
        if len(nb) != 2 or len(vert_sig.get(k, ())) > 1:
            keep.add(k)

    # Densify: keep intermediate vertices where the street curves, so that
    # endpoint-to-endpoint length stays accurate after collapsing.
    def dev(a, b, p):
        # perpendicular distance of p from segment a-b
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1e-9
        return abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L

    kept_seqs = []
    for sq in seqs:
        pts, ks = sq["pts"], [key(p) for p in sq["pts"]]
        # split at kept vertices first
        cuts = [0]
        for i in range(1, len(ks) - 1):
            if ks[i] in keep:
                cuts.append(i)
        cuts.append(len(ks) - 1)
        for c0, c1 in zip(cuts, cuts[1:]):
            # recursively split curved runs
            stack = [(c0, c1)]
            bounds = []
            while stack:
                a, b = stack.pop()
                worst, wi = 0, -1
                for i in range(a + 1, b):
                    d = dev(pts[a], pts[b], pts[i])
                    if d > worst:
                        worst, wi = d, i
                if worst > 2.0 and wi > 0:
                    stack += [(a, wi), (wi, b)]
                else:
                    bounds.append((a, b))
            for a, b in bounds:
                kept_seqs.append({**sq, "pts": pts[a:b + 1]})
                keep.add(ks[a])
                keep.add(ks[b])

    # Collapse into edges between kept vertices.
    coord = {}
    for sq in kept_seqs:
        for p in sq["pts"]:
            coord.setdefault(key(p), p)
    edges, seen = [], set()
    for sq in kept_seqs:
        ks = [key(p) for p in sq["pts"]]
        a, b = coord[ks[0]], coord[ks[-1]]
        if a == b:
            continue
        if sq["oneway"]:
            ek = ("1", ks[0], ks[-1])
        else:
            ek = ("2",) + tuple(sorted([ks[0], ks[-1]]))
        if ek in seen:
            continue
        seen.add(ek)
        true_len = sum(
            math.hypot(q[0] - p[0], q[1] - p[1])
            for p, q in zip(sq["pts"], sq["pts"][1:])
        )
        edges.append({
            "u": ks[0], "v": ks[-1],
            "oneway": sq["oneway"], "reversed": False,
            "lanes": sq["lanes"], "maxspeed": sq["maxspeed"],
            "name": sq["name"], "highway": sq["highway"],
            "length": true_len,
        })
    nodes = [
        {"osmid": f"{k[0]}_{k[1]}", "x": p[0], "y": p[1], "highway": None}
        for k, p in coord.items() if k in keep
    ]
    # Drop edges touching pruned vertices.
    valid = {n["osmid"] for n in nodes}
    edges = [ed for ed in edges
             if f"{ed['u'][0]}_{ed['u'][1]}" in valid
             and f"{ed['v'][0]}_{ed['v'][1]}" in valid]
    for ed in edges:
        ed["u"] = f"{ed['u'][0]}_{ed['u'][1]}"
        ed["v"] = f"{ed['v'][0]}_{ed['v'][1]}"
    print(f"collapsed: {len(nodes)} nodes, {len(edges)} edges")

    # Largest strongly connected component (iterative Tarjan).
    succ = {}
    for ed in edges:
        succ.setdefault(ed["u"], []).append(ed["v"])
        if not ed["oneway"]:
            succ.setdefault(ed["v"], []).append(ed["u"])
    index, low, onst, st, comps = {}, {}, set(), [], []
    counter = [0]
    for root in list(succ):
        if root in index:
            continue
        work = [(root, iter(succ.get(root, [])))]
        index[root] = low[root] = counter[0]
        counter[0] += 1
        st.append(root)
        onst.add(root)
        while work:
            node, it = work[-1]
            adv = False
            for m in it:
                if m not in index:
                    index[m] = low[m] = counter[0]
                    counter[0] += 1
                    st.append(m)
                    onst.add(m)
                    work.append((m, iter(succ.get(m, []))))
                    adv = True
                    break
                elif m in onst:
                    low[node] = min(low[node], index[m])
            if adv:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                comp = []
                while True:
                    m = st.pop()
                    onst.discard(m)
                    comp.append(m)
                    if m == node:
                        break
                comps.append(comp)
    biggest = set(max(comps, key=len)) if comps else set()
    nodes = [nd for nd in nodes if nd["osmid"] in biggest]
    edges = [ed for ed in edges if ed["u"] in biggest and ed["v"] in biggest]
    print(f"connected: {len(nodes)} nodes, {len(edges)} edges")

    controls = [
        {"kind": "signal"
         if el.get("tags", {}).get("highway") == "traffic_signals" else "stop",
         "x": proj(el["lat"], el["lon"])[0],
         "y": proj(el["lat"], el["lon"])[1]}
        for el in ctrls if "lat" in el
    ]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"bbox": BBOX, "crs": "local-equirectangular",
                   "nodes": nodes, "edges": edges, "controls": controls}, f)
    print(f"wrote {OUT} ({len(controls)} control points)")


if __name__ == "__main__":
    main()
