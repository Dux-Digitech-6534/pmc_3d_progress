# Model JSON format — `pmc-procedural-model` v1

This is the import format that drives the 3D viewer, the element list and all progress
records. Both sample files use it:

- `src/data/samples/security-cabin-a.json` — 4 footings, 4 columns, 4 roof beams, 1 slab (13 elements)
- `src/data/samples/security-cabin-b.json` — 6 footings, 6 columns, 7 plinth + 7 roof beams, 1 slab (27 elements)

They can also be downloaded from **Model Register** in the app, and regenerated with
`npm run generate:samples` (`scripts/generate-samples.mjs`).

> The sample cabins are conceptual demonstration models, **not engineering-approved designs**.
> Quantities are illustrative only.

## Coordinate system

- Units: metres (`model.lengthUnit` must be `"m"`).
- Y axis is up (`model.upAxis` is `"y"` when given). Ground level is `y = 0`.
- Every element is one **box**: `position` is the box centre, `size` is `[width (X), height (Y), depth (Z)]`.

## Top-level structure

```jsonc
{
  "format": "pmc-procedural-model",   // required, exact value
  "formatVersion": 1,                  // required, exact value
  "project": {
    "id": "PMC-SEC-001",               // required — the project this model belongs to
    "name": "Security Cabin A",        // required
    "location": "Main Gate",           // optional
    "client": "Demo Owner"             // optional
  },
  "model": {
    "id": "SEC-CABIN-A",               // required — model identity within the project
    "name": "Security Cabin A — Structure", // required
    "revision": "R01",                 // required — a changed model MUST use a new revision
    "lengthUnit": "m",                 // required, must be "m"
    "upAxis": "y",                     // optional, must be "y"
    "source": { }                      // optional, free-form provenance (generator, drawing ref…)
  },
  "buildings": [ { "id": "BLD-SCA", "name": "Security Cabin A" } ],
  "levels": [
    { "id": "FDN", "name": "Foundation", "buildingId": "BLD-SCA", "elevation": -1.0 },
    { "id": "GF",  "name": "Ground Floor", "buildingId": "BLD-SCA", "elevation": 0 },
    { "id": "RF",  "name": "Roof", "buildingId": "BLD-SCA", "elevation": 3.0 }
  ],
  "activities": [
    { "code": "REINF", "name": "Reinforcement", "unit": "kg" },
    { "code": "SHUT",  "name": "Shuttering",    "unit": "m2" },
    { "code": "CONC",  "name": "Concreting",    "unit": "m3" }
  ],
  "elements": [ /* see below */ ]
}
```

## Element

```jsonc
{
  "id": "SCA-C001",           // STABLE source element id — unique within the model
  "code": "C-01",             // display code (label only; not a unique key)
  "type": "column",           // footing | column | beam | slab | wall | lintel | chhajja | door | window
  "buildingId": "BLD-SCA",    // must exist in buildings[]
  "levelId": "GF",            // must exist in levels[]
  "geometry": {
    "shape": "box",
    "position": [-1.5, 1.2, -1.5],
    "size": [0.23, 3.6, 0.23]
  },
  "plannedQuantities": {
    "REINF": { "quantity": 34.3, "unit": "kg" },
    "SHUT":  { "quantity": 3.31, "unit": "m2" },
    "CONC":  { "quantity": 0.19, "unit": "m3" }
  },
  "notes": "optional free text shown in the element panel"
}
```

## Walls with openings

A wall uses `"shape": "wall"`. It is an axis-aligned box (it runs along X when `size[0] ≥ size[2]`,
otherwise along Z) with optional rectangular openings cut through its thickness:

```jsonc
{
  "id": "SECCABIN-WAL-X1Y1-X2Y1", "code": "W-X1Y1-X2Y1", "type": "wall",
  "buildingId": "BLD-SECCABIN", "levelId": "GF",
  "geometry": {
    "shape": "wall",
    "position": [0, 1.35, 1.615],
    "size": [2.93, 2.7, 0.23],
    "openings": [
      // center: along the wall from its centre (m, + towards +X or +Z); bottom: sill above wall bottom
      { "center": 0, "bottom": 0, "width": 0.9, "height": 2.1 }
    ]
  },
  "plannedQuantities": { "BRICK": { "quantity": 1.343, "unit": "m3" }, "PLAST": { "quantity": 12.04, "unit": "m2" } }
}
```

Doors, windows, lintels and chhajjas are ordinary `box` elements of type `door`, `window`, `lintel`, `chhajja`.

## Activities per element type

An activity may list the element types it applies to. Without `appliesTo` it applies to all.

```jsonc
{ "code": "BRICK", "name": "Brickwork", "unit": "m3", "appliesTo": ["wall"] }
```

For other types the activity shows as **Not applicable** (not "Not configured") and entries are refused.

## Validation rules

Import is rejected (nothing changes) when any of these fail. The message names the element.

| Rule | Example message |
|---|---|
| File is JSON with an object at the top | `File is not valid JSON: …` |
| `format` / `formatVersion` exact | `"format" must be "pmc-procedural-model"` |
| Required metadata present | `"model.revision" is required (e.g. "R01").` |
| Unique building, level and activity ids | `Duplicate level id "GF".` |
| Activity unit supported (`kg`, `m2`, `m3`, `m`, `nos`) | `activities[0] ("REINF") has unsupported unit "tonne"` |
| **Unique stable element ids** | `Element "SCA-F001": duplicate stable element id …` |
| **Supported element type** | `unsupported type "staircase". Supported: footing, column, beam, slab, wall, lintel, chhajja, door, window.` |
| Wall openings fit inside the wall face and do not overlap | `opening 1 (1.5 × 1.2 m) does not fit inside the 2.930 × 2.700 m wall.` |
| Activity `appliesTo` lists valid element types; no planned quantity for an activity that does not apply | `planned Concreting quantity, but that activity does not apply to type "wall".` |
| Building / level references exist | `Element "SCA-C002": "levelId" is missing or unknown.` |
| **Valid geometry**: shape `box`, 3 finite numbers, sizes > 0 and ≤ 500 m | `geometry.size values must be greater than 0 …` |
| Planned quantity refers to a known activity, is a number ≥ 0 | `planned quantity for unknown activity "PCC".` |
| **Planned quantity unit equals the activity unit** | `planned Concreting unit is "kg" but the activity is measured in "m3".` |
| Target project matches (when a project is chosen in the import dialog) | `This model belongs to project "PMC-SEC-002" …` |
| Revision not already imported for this project + model | `… revision R01 is already imported …` |

Warnings (import still succeeds):

- An element has no planned quantity (or zero) for an activity → shown as **Not configured**; progress cannot be recorded for it until the model is revised.
- A display code is used by more than one element (codes are labels only).

Try **Model Register → "Try an invalid file"** to see these messages in the app.

## Identity and revisions

| Key | Built from | Used for |
|---|---|---|
| Model key | `project.id` + `model.id` + `model.revision` | model register, progress scoping |
| Element key | model key + element `id` | element ↔ progress mapping |

- Display names/codes and Three.js runtime object ids are **never** used as identifiers.
- Importing a new revision marks the previous one *Superseded*. Progress recorded on the
  old revision stays attached to it (visible in the DPR list and element history) and is
  **not** copied to the new revision. A reviewed migration step would be needed for that.
