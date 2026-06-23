# Sketch DSL

Emit a diagram an operator can view inline and open in an interactive canvas. Put a
fenced block with the info-string `sketch` in any message. The body is a JSON
object `{ "shapes": [...], "layout"?: {...} }`. The dashboard renders a static SVG
preview inline; the operator can click **Open canvas** to edit it in tldraw and
send the result back as a PNG.

This is an **opt-in convention** — reference this page from your persona to adopt
it. It is not injected into every agent's context.

## Minimal example

```sketch
{
  "shapes": [
    { "id": "orch",  "type": "rect",    "text": "Orchestrator", "color": "blue" },
    { "id": "proxy", "type": "rect",    "text": "Proxy",        "color": "green" },
    { "id": "db",    "type": "ellipse", "text": "SQLite",       "color": "violet" },
    { "type": "arrow", "from": "orch", "to": "proxy", "text": "HTTP" },
    { "type": "arrow", "from": "orch", "to": "db" }
  ],
  "layout": { "mode": "flow", "direction": "row", "gap": 48 }
}
```

## Shape types

Every shape has a `type`. Most fields are optional — omit `x`/`y`/`w`/`h` and let
the layout place and size the shape. Give a shape an `id` so a connector or frame
can reference it.

| `type` | what it is | fields |
|---|---|---|
| `rect` | a box | `id, x, y, w, h, text, color, fill, z` |
| `ellipse` | an oval / circle | `id, x, y, w, h, text, color, fill, z` |
| `text` | a free text label (required `text`) | `id, x, y, w, color, z` |
| `note` | a sticky note (required `text`) | `id, x, y, color, z` |
| `frame` | a labeled container that groups shapes | `id, x, y, w, h, text, children, z` |
| `arrow` | a connector | `id, from, to` OR `x1, y1, x2, y2`; plus `text, color, dash, z` |
| `line` | a polyline (required `points`) | `id, points, color, dash, z` |

### Connectors by id (preferred)

Give two shapes an `id`, then connect them by reference:

```sketch
{
  "shapes": [
    { "id": "a", "type": "rect", "text": "A" },
    { "id": "b", "type": "rect", "text": "B" },
    { "type": "arrow", "from": "a", "to": "b", "text": "calls" }
  ]
}
```

`from`/`to` reference shape `id`s. The canvas computes the endpoints and **binds**
the arrow to the boxes, so it tracks them when the operator moves a box. Raw
coordinates (`x1,y1,x2,y2`) are a fallback that does not bind. A connector whose
`from`/`to` points at an id that is not present is dropped (the rest of the sketch
still renders).

### Frames (containers)

```sketch
{
  "shapes": [
    { "id": "orch", "type": "rect",  "text": "Orchestrator" },
    { "id": "db",   "type": "ellipse", "text": "SQLite" },
    { "id": "box",  "type": "frame", "text": "Docker :3000", "children": ["orch", "db"] }
  ]
}
```

A `frame` wraps the shapes named in `children`.

## Layout

Declare structure and let the canvas compute pixels. With a doc-level `layout`,
shapes that omit absolute coords flow in a row or column:

```json
"layout": { "mode": "flow", "direction": "row", "gap": 48 }
```

- `mode`: `flow` (the only mode in v1).
- `direction`: `row` (left → right) or `col` (top → bottom). Default `row`.
- `gap`: pixels between shapes. Default 48.

Absolute coords on a shape override the layout for that shape.

## Colors, fill, dash, z-order

- `color`: one of `black blue green red orange yellow violet light-blue
  light-green light-red light-violet grey white`. Default `black`.
- `fill` (rect/ellipse): `none semi solid pattern`. Default `none`.
- `dash` (arrow/line): `draw solid dashed dotted`.
- `z`: an integer draw order. Higher `z` draws in front.

## Limits

A sketch is validated before it renders. Beyond these limits the block degrades to
plain code:

- at most 500 shapes; the raw block is capped at 64 KB.
- numeric coords are bounded (`|value| <= 100000`); dimensions `0 < w,h <= 50000`.
- `text` <= 2 KB per shape; `id` <= 64 chars, `[A-Za-z0-9_-]` only.
- a `line` has 2..256 points.

One malformed shape is skipped (with a "shapes skipped" note); it does not blank
the whole sketch. An unparseable block falls back to a normal code block.
