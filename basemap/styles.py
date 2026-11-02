"""The light and dark MapLibre styles for the Montana basemap.

One layer list, two palettes. The light theme parallels OpenFreeMap's Positron
(a pale ground, white roads with soft casings, blue-grey water, quiet labels)
in the warm neutrals this dashboard already uses; the dark theme parallels
Dark Matter the same way. Every colour is in ``PALETTE`` so a reuse elsewhere
can swap the look without touching the layer logic.

The styles reference the archive as ``pmtiles://{base}/{archive}`` and the
glyphs as ``{base}/fonts/{fontstack}/{range}.pbf``, so the package is served
from one directory; ``base`` may be relative (the demo page) or a site path.

MapLibre allows a zoom expression only as the outermost ``interpolate`` or
``step``, so every width that varies by both zoom and class is written as a
zoom interpolation whose stops are ``match`` expressions on the class.
"""

from __future__ import annotations

PALETTE = {
    "light": {
        "ground": "#efe9dc", "landuse_federal": "#e3e7d6", "landuse_state": "#e7e5d3",
        "landuse_local": "#e9e4d6", "landuse_other": "#ebe6d9",
        "water": "#c3d5e2", "water_line": "#9fb8cb", "wetland": "#d4ddd0", "glacier": "#e8eef2",
        "boundary_state": "#6e6657", "boundary_county": "#9c927b", "boundary_city": "#b4ab99",
        "road_fill": "#ffffff", "road_case": "#c2b9a6", "road_major_fill": "#ffffff",
        "road_major_case": "#a89f8b", "road_minor": "#f3efe6", "track": "#ddd5c4",
        "building": "#dbd4c5", "building_line": "#cdc5b3", "building_unseen": "#e6e0d3",
        "text": "#4a4434", "text_muted": "#7d7566", "halo": "#efe9dc",
        "water_text": "#5a7a92", "poi_text": "#5c5547", "place_text": "#2e2a22",
    },
    "dark": {
        "ground": "#16140f", "landuse_federal": "#191d14", "landuse_state": "#1b1a13",
        "landuse_local": "#1b1915", "landuse_other": "#1a1813",
        "water": "#1d2831", "water_line": "#2d4150", "wetland": "#1a211b", "glacier": "#1f2426",
        "boundary_state": "#c6bfae", "boundary_county": "#6a6150", "boundary_city": "#514938",
        "road_fill": "#3a3428", "road_case": "#0f0d09", "road_major_fill": "#4e4636",
        "road_major_case": "#0f0d09", "road_minor": "#2b271d", "track": "#262218",
        "building": "#24201a", "building_line": "#2d2820", "building_unseen": "#1e1b16",
        "text": "#c6bfae", "text_muted": "#8d8778", "halo": "#16140f",
        "water_text": "#7a9ab2", "poi_text": "#b5ad9b", "place_text": "#e8e2d3",
    },
}
REGULAR = ["Noto Sans Regular"]
BOLD = ["Noto Sans Bold"]


def _zoom(*stops, base: float = 1.4):
    """A zoom interpolation from (zoom, value) pairs; a value may be an expression."""
    out = ["interpolate", ["exponential", base], ["zoom"]]
    for z, v in stops:
        out += [z, v]
    return out


def _by_class(a, b=None, c=None, d=None):
    """Width by road class 1..3 with a default for 4-5."""
    if b is None:
        return a
    return ["match", ["get", "class"], 1, a, 2, b, 3, c if c is not None else b, d if d is not None else (c if c is not None else b)]


def build_style(theme: str, base: str, archive: str) -> dict:
    p = PALETTE[theme]
    src = "mt"
    L: list[dict] = []

    def layer(id, type, source_layer, *, filter=None, minzoom=None, maxzoom=None, layout=None, paint=None):
        d = {"id": id, "type": type, "source": src, "source-layer": source_layer}
        if filter is not None: d["filter"] = filter
        if minzoom is not None: d["minzoom"] = minzoom
        if maxzoom is not None: d["maxzoom"] = maxzoom
        if layout: d["layout"] = layout
        if paint: d["paint"] = paint
        L.append(d)

    round_line = {"line-cap": "round", "line-join": "round"}
    is_river = ["==", ["get", "class"], "river"]
    cls = lambda n: ["==", ["get", "class"], n]

    L.append({"id": "background", "type": "background", "paint": {"background-color": p["ground"]}})

    # ground: public lands as a faint wash
    layer("landuse", "fill", "landuse", minzoom=6, paint={"fill-color": [
        "match", ["get", "class"], "federal", p["landuse_federal"], "state", p["landuse_state"],
        "local_government", p["landuse_local"], p["landuse_other"]], "fill-opacity": 0.9})

    # water
    layer("water-major", "fill", "water_major", maxzoom=10, paint={"fill-color": p["water"]})
    layer("water", "fill", "water", minzoom=10,
          filter=["!", ["in", ["get", "class"], ["literal", ["wetland", "glacier"]]]],
          paint={"fill-color": p["water"]})
    layer("wetland", "fill", "water", minzoom=10, filter=cls("wetland"),
          paint={"fill-color": p["wetland"], "fill-opacity": 0.8})
    layer("glacier", "fill", "water", minzoom=10, filter=cls("glacier"), paint={"fill-color": p["glacier"]})
    layer("waterway-major", "line", "waterway_major", minzoom=5, maxzoom=9, layout=round_line,
          paint={"line-color": p["water_line"], "line-width": _zoom((5, 0.4), (8, 1.2))})
    layer("waterway", "line", "waterway", minzoom=9, filter=["!=", ["get", "class"], "canal"], layout=round_line,
          paint={"line-color": p["water_line"],
                 "line-width": _zoom((9, ["case", is_river, 1.2, 0.3]), (12, ["case", is_river, 2.0, 0.7]),
                                     (15, ["case", is_river, 4.0, 1.6])),
                 "line-opacity": _zoom((9, ["case", is_river, 1, 0.5]), (12, ["case", is_river, 1, 0.9]), base=1)})
    layer("canal", "line", "waterway", minzoom=11, filter=cls("canal"),
          paint={"line-color": p["water_line"], "line-width": _zoom((11, 0.4), (15, 1.2)), "line-dasharray": [4, 2]})

    # boundaries
    layer("boundary-city", "line", "boundary", minzoom=9, filter=["==", ["get", "level"], 8],
          paint={"line-color": p["boundary_city"], "line-width": _zoom((9, 0.6), (14, 1.4)), "line-dasharray": [3, 2]})
    layer("boundary-county", "line", "boundary", filter=["==", ["get", "level"], 6],
          paint={"line-color": p["boundary_county"], "line-width": _zoom((4, 0.4), (8, 0.9), (13, 1.6)),
                 "line-opacity": _zoom((4, 0.6), (9, 0.9), base=1)})
    layer("boundary-state", "line", "boundary", filter=["==", ["get", "level"], 4],
          paint={"line-color": p["boundary_state"], "line-width": _zoom((4, 1.0), (10, 2.2))})

    # buildings (overzoomed from z13)
    layer("building", "fill", "building", minzoom=13,
          paint={"fill-color": ["case", ["==", ["get", "src"], 4], p["building_unseen"], p["building"]],
                 "fill-outline-color": p["building_line"],
                 "fill-opacity": _zoom((13, 0.6), (15, 1), base=1)})

    # roads below z9: the dissolved primary (from z4) and secondary (from z6) routes
    layer("road-major-lo-case", "line", "transportation_major", maxzoom=9, filter=["==", ["get", "class"], 1],
          layout=round_line, paint={"line-color": p["road_major_case"], "line-width": _zoom((4, 1.2), (8, 3.2))})
    layer("road-secondary-lo-case", "line", "transportation_major", minzoom=6, maxzoom=9, filter=["==", ["get", "class"], 2],
          layout=round_line, paint={"line-color": p["road_major_case"], "line-width": _zoom((6, 0.8), (8, 2.2))})
    layer("road-major-lo", "line", "transportation_major", maxzoom=9, filter=["==", ["get", "class"], 1],
          layout=round_line, paint={"line-color": p["road_major_fill"], "line-width": _zoom((4, 0.6), (8, 1.8))})
    layer("road-secondary-lo", "line", "transportation_major", minzoom=6, maxzoom=9, filter=["==", ["get", "class"], 2],
          layout=round_line, paint={"line-color": p["road_major_fill"], "line-width": _zoom((6, 0.4), (8, 1.2))})
    # roads from z9: every road, cased for classes 1-3, faint for private roads and tracks
    layer("road-private", "line", "transportation", minzoom=12, filter=["==", ["get", "class"], 4],
          paint={"line-color": p["track"], "line-width": _zoom((12, 0.5), (16, 1.6))})
    layer("road-track", "line", "transportation", minzoom=12, filter=["==", ["get", "class"], 5],
          paint={"line-color": p["track"], "line-width": _zoom((12, 0.5), (16, 1.4)), "line-dasharray": [3, 2]})
    layer("road-minor-case", "line", "transportation", minzoom=11, filter=["==", ["get", "class"], 3], layout=round_line,
          paint={"line-color": p["road_case"], "line-width": _zoom((11, 1.0), (14, 3.4), (17, 11))})
    layer("road-minor", "line", "transportation", minzoom=9, filter=["==", ["get", "class"], 3], layout=round_line,
          paint={"line-color": ["step", ["zoom"], p["road_minor"], 11, p["road_fill"]],
                 "line-width": _zoom((9, 0.3), (11, 0.5), (14, 2.2), (17, 9))})
    layer("road-major-case", "line", "transportation", minzoom=9, filter=["<=", ["get", "class"], 2], layout=round_line,
          paint={"line-color": p["road_major_case"],
                 "line-width": _zoom((9, _by_class(3.6, 2.4)), (14, _by_class(8, 5.5)), (17, _by_class(20, 14)))})
    layer("road-major", "line", "transportation", minzoom=9, filter=["<=", ["get", "class"], 2], layout=round_line,
          paint={"line-color": p["road_major_fill"],
                 "line-width": _zoom((9, _by_class(2.2, 1.4)), (14, _by_class(5.5, 3.8)), (17, _by_class(16, 11)))})

    # labels
    halo = lambda color, w: {"text-color": color, "text-halo-color": p["halo"], "text-halo-width": w}
    layer("water-name", "symbol", "water", minzoom=11, filter=["!=", ["get", "name"], ""],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 11, "text-max-width": 8, "text-padding": 2},
          paint=halo(p["water_text"], 1.2))
    layer("waterway-name", "symbol", "waterway", minzoom=11, filter=["!=", ["get", "name"], ""],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 10.5, "symbol-placement": "line",
                  "symbol-spacing": 400, "text-letter-spacing": 0.05, "text-padding": 2},
          paint=halo(p["water_text"], 1.2))
    layer("road-ref-lo", "symbol", "transportation_major", minzoom=6, maxzoom=9, filter=["!=", ["get", "ref"], ""],
          layout={"text-font": BOLD, "text-field": ["get", "ref"], "text-size": 10, "symbol-placement": "line",
                  "symbol-spacing": 350, "text-rotation-alignment": "viewport", "text-pitch-alignment": "viewport"},
          paint={"text-color": p["text"], "text-halo-color": p["road_major_fill"], "text-halo-width": 2})
    layer("road-ref", "symbol", "transportation", minzoom=9, maxzoom=13, filter=["!=", ["get", "ref"], ""],
          layout={"text-font": BOLD, "text-field": ["get", "ref"], "text-size": 10.5, "symbol-placement": "line",
                  "symbol-spacing": 400, "text-rotation-alignment": "viewport", "text-pitch-alignment": "viewport"},
          paint={"text-color": p["text"], "text-halo-color": p["road_major_fill"], "text-halo-width": 2})
    layer("road-name-major", "symbol", "transportation", minzoom=11,
          filter=["all", ["<=", ["get", "class"], 2], ["!=", ["get", "name"], ""]],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 11, "symbol-placement": "line",
                  "symbol-spacing": 350, "text-padding": 2},
          paint=halo(p["text"], 1.4))
    layer("road-name", "symbol", "transportation", minzoom=13,
          filter=["all", ["==", ["get", "class"], 3], ["!=", ["get", "name"], ""]],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 10.5, "symbol-placement": "line",
                  "symbol-spacing": 300, "text-padding": 2},
          paint=halo(p["text_muted"], 1.4))
    layer("road-name-track", "symbol", "transportation", minzoom=15,
          filter=["all", [">=", ["get", "class"], 4], ["!=", ["get", "name"], ""]],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 10, "symbol-placement": "line",
                  "symbol-spacing": 300, "text-padding": 2},
          paint=halo(p["text_muted"], 1.2))
    layer("address-number", "symbol", "address", minzoom=16,
          layout={"text-font": REGULAR, "text-field": ["get", "num"], "text-size": 9.5, "text-padding": 1},
          paint=halo(p["text_muted"], 1))
    layer("poi", "symbol", "poi", minzoom=12,
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 10.5, "text-max-width": 9,
                  "text-anchor": "top", "text-offset": [0, 0.3], "text-padding": 4},
          paint=halo(p["poi_text"], 1.3))
    layer("place-county", "symbol", "place", minzoom=6, maxzoom=10, filter=cls("county"),
          layout={"text-font": REGULAR, "text-field": ["upcase", ["get", "name"]], "text-size": 10,
                  "text-letter-spacing": 0.15, "text-max-width": 7},
          paint={**halo(p["text_muted"], 1.2), "text-opacity": 0.8})
    layer("place-hamlet", "symbol", "place", minzoom=10, filter=["==", ["get", "rank"], 4],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": 11, "text-max-width": 8},
          paint=halo(p["place_text"], 1.4))
    layer("place-town", "symbol", "place", minzoom=8, filter=["==", ["get", "rank"], 3],
          layout={"text-font": REGULAR, "text-field": ["get", "name"], "text-size": _zoom((8, 11), (12, 14), base=1)},
          paint=halo(p["place_text"], 1.5))
    layer("place-city", "symbol", "place", minzoom=6, filter=["==", ["get", "rank"], 2],
          layout={"text-font": BOLD, "text-field": ["get", "name"], "text-size": _zoom((6, 11), (12, 16), base=1)},
          paint=halo(p["place_text"], 1.6))
    layer("place-major", "symbol", "place", minzoom=4, filter=["==", ["get", "rank"], 1],
          layout={"text-font": BOLD, "text-field": ["get", "name"], "text-size": _zoom((4, 12), (12, 19), base=1)},
          paint=halo(p["place_text"], 1.8))

    return {
        "version": 8,
        "name": f"Montana basemap ({theme})",
        "metadata": {"theme": theme,
                     "source": "Montana State Library frameworks; Microsoft building footprints (ODbL)"},
        "glyphs": f"{base}/fonts/{{fontstack}}/{{range}}.pbf",
        "sources": {src: {"type": "vector", "url": f"pmtiles://{base}/{archive}",
                          "attribution": "Montana State Library; Microsoft (ODbL)"}},
        "layers": L,
    }
