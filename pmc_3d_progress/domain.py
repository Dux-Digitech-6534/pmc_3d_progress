"""PMC rules, enforced on the server.

A Python port of the frontend rules in frontend/src/domain (modelValidation.ts, workflow.ts,
allocation.ts). The browser checks the same things for quick feedback, but only these checks
are trusted. Messages are kept word-for-word identical so the UI reads the same either way.

No Frappe imports here: the module is plain Python so it can be unit-tested anywhere
(see pmc_3d_progress/tests/test_domain.py).
"""

import json
import math
import re
from datetime import date as _date

ELEMENT_TYPES = ("footing", "column", "beam", "slab", "wall", "lintel", "chhajja", "door", "window")
SUPPORTED_UNITS = ("kg", "m2", "m3", "m", "nos")
ROLES = ("site-engineer", "pmc-reviewer", "owner")
ROLE_LABELS = {"site-engineer": "Site Engineer", "pmc-reviewer": "PMC Reviewer", "owner": "Owner"}

QTY_DECIMALS = 3
QTY_EPSILON = 1e-6
MAX_REPORTED = 60
MAX_DIMENSION_M = 500
EPS = 1e-6


# ---------------------------------------------------------------- helpers


def round_qty(n, decimals=3):
	"""Same as the frontend roundQty: round half up at the given decimals."""
	f = 10**decimals
	return math.floor(n * f + 0.5 + 1e-9) / f


def js_num(n):
	"""Format a number the way JavaScript prints it in a template string (5 not 5.0)."""
	if isinstance(n, bool):
		return "true" if n else "false"
	if isinstance(n, int):
		return str(n)
	if isinstance(n, float):
		if math.isfinite(n) and n == int(n) and abs(n) < 1e21:
			return str(int(n))
		return repr(n)
	return str(n)


def js_json(v):
	"""JSON.stringify-like rendering of a value inside a message."""
	if v is None:
		return "undefined"
	if isinstance(v, (int, float)) and not isinstance(v, bool):
		return js_num(v)
	if isinstance(v, list):
		return "[" + ",".join(js_json(x) for x in v) + "]"
	return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _is_obj(v):
	return isinstance(v, dict)


def _is_str(v):
	return isinstance(v, str) and v.strip() != ""


def _is_num(v):
	return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def activity_applies(activity, element_type):
	applies_to = activity.get("appliesTo")
	return applies_to is None or element_type in applies_to


def wall_dims(size):
	along_x = size[0] >= size[2]
	return {
		"alongX": along_x,
		"length": size[0] if along_x else size[2],
		"height": size[1],
		"thickness": size[2] if along_x else size[0],
	}


# ---------------------------------------------------------------- model validation


def parse_and_validate_model(text):
	try:
		parsed = json.loads(text)
	except (ValueError, TypeError) as e:
		return {"ok": False, "errors": [f"File is not valid JSON: {e}"], "warnings": []}
	return validate_model_document(parsed)


def validate_model_document(doc):
	"""Validate an untrusted pmc-procedural-model v1 document. Errors block the import."""
	errors = []
	warnings = []

	def err(msg):
		if len(errors) < MAX_REPORTED:
			errors.append(msg)

	if not _is_obj(doc):
		return {"ok": False, "errors": ["The model file must contain a JSON object at the top level."], "warnings": warnings}

	if doc.get("format") != "pmc-procedural-model":
		err(f'"format" must be "pmc-procedural-model" (found {js_json(doc.get("format"))}).')
	if doc.get("formatVersion") != 1 or isinstance(doc.get("formatVersion"), bool):
		err(f'"formatVersion" must be 1 (found {js_json(doc.get("formatVersion"))}).')

	project = doc.get("project")
	if not _is_obj(project):
		err('"project" is required and must be an object with "id" and "name".')
	else:
		if not _is_str(project.get("id")):
			err('"project.id" is required (e.g. "PMC-SEC-001").')
		if not _is_str(project.get("name")):
			err('"project.name" is required.')

	model = doc.get("model")
	if not _is_obj(model):
		err('"model" is required and must be an object.')
	else:
		if not _is_str(model.get("id")):
			err('"model.id" is required (e.g. "SEC-CABIN-A").')
		if not _is_str(model.get("name")):
			err('"model.name" is required.')
		if not _is_str(model.get("revision")):
			err('"model.revision" is required (e.g. "R01").')
		if model.get("lengthUnit") != "m":
			err(f'"model.lengthUnit" must be "m" (found {js_json(model.get("lengthUnit"))}).')
		if "upAxis" in model and model.get("upAxis") != "y":
			err('"model.upAxis" must be "y" when given.')

	building_ids = set()
	buildings = doc.get("buildings")
	if not isinstance(buildings, list) or not buildings:
		err('"buildings" must be a non-empty array.')
	else:
		for i, b in enumerate(buildings):
			if not _is_obj(b) or not _is_str(b.get("id")) or not _is_str(b.get("name")):
				err(f'buildings[{i}] needs "id" and "name".')
				continue
			if b["id"] in building_ids:
				err(f'Duplicate building id "{b["id"]}".')
			building_ids.add(b["id"])

	level_ids = set()
	levels = doc.get("levels")
	if not isinstance(levels, list) or not levels:
		err('"levels" must be a non-empty array.')
	else:
		for i, lv in enumerate(levels):
			if not _is_obj(lv) or not _is_str(lv.get("id")) or not _is_str(lv.get("name")) or not _is_str(lv.get("buildingId")):
				err(f'levels[{i}] needs "id", "name" and "buildingId".')
				continue
			if lv["id"] in level_ids:
				err(f'Duplicate level id "{lv["id"]}".')
			if lv["buildingId"] not in building_ids:
				err(f'levels[{i}] ("{lv["id"]}") refers to unknown building "{lv["buildingId"]}".')
			if "elevation" in lv and not _is_num(lv.get("elevation")):
				err(f"levels[{i}].elevation must be a number.")
			level_ids.add(lv["id"])

	activities = {}
	acts = doc.get("activities")
	if not isinstance(acts, list) or not acts:
		err('"activities" must be a non-empty array (e.g. Reinforcement/kg, Shuttering/m2, Concreting/m3).')
	else:
		for i, a in enumerate(acts):
			if not _is_obj(a) or not _is_str(a.get("code")) or not _is_str(a.get("name")):
				err(f'activities[{i}] needs "code", "name" and "unit".')
				continue
			if a.get("unit") not in SUPPORTED_UNITS:
				err(
					f'activities[{i}] ("{a["code"]}") has unsupported unit {js_json(a.get("unit"))}. '
					f"Supported: {', '.join(SUPPORTED_UNITS)}."
				)
				continue
			if a["code"] in activities:
				err(f'Duplicate activity code "{a["code"]}".')
			applies_to = a.get("appliesTo")
			if "appliesTo" in a and (not isinstance(applies_to, list) or not all(t in ELEMENT_TYPES for t in applies_to)):
				err(f'activities[{i}] ("{a["code"]}"): "appliesTo" must be a list of element types ({", ".join(ELEMENT_TYPES)}).')
			activities[a["code"]] = {"code": a["code"], "name": a["name"], "unit": a["unit"], "appliesTo": applies_to}

	elements = doc.get("elements")
	if not isinstance(elements, list) or not elements:
		err('"elements" must be a non-empty array.')
	else:
		ids = set()
		codes = {}
		for i, e in enumerate(elements):
			if not _is_obj(e):
				err(f"elements[{i}] must be an object.")
				continue
			eid = e.get("id")
			label = f'Element "{eid}"' if _is_str(eid) else f"elements[{i}]"

			if not _is_str(eid):
				err(f'elements[{i}] is missing its stable "id".')
			elif eid in ids:
				err(f"{label}: duplicate stable element id — every element id must be unique within the model.")
			else:
				ids.add(eid)

			if not _is_str(e.get("code")):
				err(f'{label}: "code" (display code such as C-01) is required.')
			else:
				codes[e["code"]] = codes.get(e["code"], 0) + 1

			if e.get("type") not in ELEMENT_TYPES:
				err(f"{label}: unsupported type {js_json(e.get('type'))}. Supported: {', '.join(ELEMENT_TYPES)}.")
			if not _is_str(e.get("buildingId")) or e["buildingId"] not in building_ids:
				err(f'{label}: "buildingId" is missing or unknown.')
			if not _is_str(e.get("levelId")) or e["levelId"] not in level_ids:
				err(f'{label}: "levelId" is missing or unknown.')

			g = e.get("geometry")
			if not _is_obj(g):
				err(f'{label}: "geometry" is required.')
			else:
				shape = g.get("shape")
				if shape not in ("box", "wall", "stair"):
					err(f'{label}: geometry.shape must be "box", "wall" or "stair" (found {js_json(shape)}).')
				if shape == "stair":
					steps = g.get("steps")
					if not (isinstance(steps, int) and not isinstance(steps, bool) and 1 <= steps <= 100):
						err(f"{label}: geometry.steps must be a whole number from 1 to 100.")
					if g.get("up") not in ("+x", "-x", "+z", "-z"):
						err(f'{label}: geometry.up must be "+x", "-x", "+z" or "-z".')
					if not _is_num(g.get("waist")) or g["waist"] <= 0:
						err(f"{label}: geometry.waist must be a positive number (m).")
				pos = g.get("position")
				if not isinstance(pos, list) or len(pos) != 3 or not all(_is_num(n) for n in pos):
					err(f"{label}: geometry.position must be three finite numbers [x, y, z].")
				size = g.get("size")
				if not isinstance(size, list) or len(size) != 3 or not all(_is_num(n) for n in size):
					err(f"{label}: geometry.size must be three finite numbers [width, height, depth].")
				elif not all(0 < n <= MAX_DIMENSION_M for n in size):
					err(
						f"{label}: geometry.size values must be greater than 0 and at most {MAX_DIMENSION_M} m "
						f"(found {js_json(size)})."
					)
				elif shape == "wall":
					_validate_openings(size, g.get("openings"), "openings" in g, label, err)
				elif "openings" in g:
					err(f'{label}: only "wall" geometry can have openings.')

			sbd = e.get("steelByDia")
			if sbd is not None:
				if not _is_obj(sbd):
					err(f'{label}: "steelByDia" must be an object of bar diameter (mm) → kg, e.g. {{ "8": 12.5, "16": 30 }}.')
				else:
					for dia, kg in sbd.items():
						if not (isinstance(dia, str) and dia.isdigit() and 6 <= int(dia) <= 40):
							err(f'{label}: steelByDia bar diameter "{dia}" must be a whole number of mm from 6 to 40.')
						if not _is_num(kg) or kg < 0:
							err(f'{label}: steelByDia["{dia}"] must be a number of kg, 0 or more.')
					total = sum(kg for kg in sbd.values() if _is_num(kg))
					reinf = (e.get("plannedQuantities") or {}).get("REINF") if _is_obj(e.get("plannedQuantities")) else None
					if _is_obj(reinf) and _is_num(reinf.get("quantity")) and abs(total - reinf["quantity"]) > max(0.5, reinf["quantity"] * 0.01):
						warnings.append(
							f'Element "{eid}": steelByDia adds up to {js_num(round(total, 1))} kg but planned reinforcement is '
							f'{js_num(reinf["quantity"])} kg — the bar sizes are used as proportions.'
						)
			grade = e.get("concreteGrade")
			if grade is not None and (not _is_str(grade) or len(grade) > 20):
				err(f'{label}: "concreteGrade" must be a short text such as "M25".')

			pq = e.get("plannedQuantities")
			if not _is_obj(pq):
				err(f'{label}: "plannedQuantities" is required (use {{}} if none are known yet).')
			else:
				configured = list(pq.keys())
				for code in configured:
					act = activities.get(code)
					q = pq[code]
					if not act:
						err(f'{label}: planned quantity for unknown activity "{code}".')
						continue
					if not _is_obj(q) or not _is_num(q.get("quantity")):
						err(f"{label}: planned {act['name']} quantity must be a number.")
						continue
					if q["quantity"] < 0:
						err(f"{label}: planned {act['name']} quantity cannot be negative.")
					if q.get("unit") != act["unit"]:
						err(
							f"{label}: planned {act['name']} unit is {js_json(q.get('unit'))} but the activity is measured in "
							f'"{act["unit"]}".'
						)

				def applies(c):
					a = activities.get(c)
					return not a or a.get("appliesTo") is None or e.get("type") in a["appliesTo"]

				for c in configured:
					if c in activities and not applies(c):
						err(
							f"{label}: planned {activities[c]['name']} quantity, but that activity does not apply to type "
							f'"{e.get("type")}".'
						)
				missing = [
					c
					for c in activities
					if applies(c) and (c not in configured or (_is_obj(pq.get(c)) and pq[c].get("quantity") == 0))
				]
				if missing and _is_str(eid):
					names = ", ".join(activities[c]["name"] for c in missing)
					warnings.append(f'Element "{eid}" has no planned quantity for {names} — shown as "Not configured".')
		for code, count in codes.items():
			if count > 1:
				warnings.append(f'Display code "{code}" is used by {count} elements. Codes are labels only; stable ids stay unique.')

	if len(errors) >= MAX_REPORTED:
		errors.append("…further errors not shown. Fix the ones above and re-import.")

	if errors:
		return {"ok": False, "errors": errors, "warnings": warnings}
	return {"ok": True, "errors": [], "warnings": warnings, "document": doc}


def _validate_openings(size, openings, present, label, err):
	if not present:
		return
	if not isinstance(openings, list):
		return err(f"{label}: geometry.openings must be a list.")
	dims = wall_dims(size)
	length, height = dims["length"], dims["height"]
	ok = []
	for i, o in enumerate(openings):
		at = f"{label}: opening {i + 1}"
		vals = [o.get(k) for k in ("center", "bottom", "width", "height")] if _is_obj(o) else []
		if not _is_obj(o) or not all(_is_num(v) for v in vals):
			err(f"{at} needs numeric center, bottom, width and height.")
			continue
		c, b, w, h = vals
		if w <= 0 or h <= 0 or b < 0:
			err(f"{at}: width and height must be > 0 and bottom ≥ 0.")
			continue
		if c - w / 2 < -length / 2 - EPS or c + w / 2 > length / 2 + EPS or b + h > height + EPS:
			err(f"{at} ({js_num(w)} × {js_num(h)} m) does not fit inside the {length:.3f} × {height:.3f} m wall.")
			continue
		r = (c - w / 2, c + w / 2, b, b + h)
		if any(r[0] < q[1] - EPS and q[0] < r[1] - EPS and r[2] < q[3] - EPS and q[2] < r[3] - EPS for q in ok):
			err(f"{at} overlaps another opening.")
		ok.append(r)


# ---------------------------------------------------------------- workflow


def can_create(role):
	return role == "site-engineer"


def can_edit(role, status):
	return role == "site-engineer" and status in ("Draft", "Returned")


def can_submit(role, status):
	return role == "site-engineer" and status == "Draft"


def can_delete(role, status):
	return role == "site-engineer" and status == "Draft"


def can_review(role, status):
	return role == "pmc-reviewer" and status == "Submitted"


def check_quantity(element, activity, quantity, unit, entries, mode, exclude_entry_id=None):
	"""Errors for a quantity against an element's plan.

	element: {id, code, type, plannedQuantities}; activity: {code, name, unit, appliesTo};
	entries: [{id, elementId, activityCode, unit, status, quantity}] of the same project + model revision;
	mode: "claim" (save/submit: approved + submitted + this <= planned) or "approve" (approved + this <= planned).
	"""
	errors = []
	name = f"{element['code']} {activity['name']}"

	if not _is_num(quantity):
		return ["Completed quantity must be a number."]
	if quantity < 0:
		errors.append("Completed quantity cannot be negative.")
	elif quantity == 0:
		errors.append("Completed quantity must be greater than zero.")
	elif round_qty(quantity, QTY_DECIMALS) != quantity:
		errors.append(f"Use at most {QTY_DECIMALS} decimals.")

	if element.get("type") and not activity_applies(activity, element["type"]):
		errors.append(f"{activity['name']} does not apply to {element['code']} ({element['type']}).")
		return errors

	if unit != activity["unit"]:
		errors.append(
			f"Unit mismatch: {activity['name']} is measured in {activity['unit']}, not {unit or '(blank)'}. "
			"Quantities in different units cannot be combined."
		)

	planned = (element.get("plannedQuantities") or {}).get(activity["code"])
	if not planned or not (_is_num(planned.get("quantity")) and planned["quantity"] > 0):
		errors.append(
			f"Planned quantity for {name} is not configured, so progress cannot be recorded against it. "
			"Update the model data first."
		)
	elif planned.get("unit") != activity["unit"]:
		errors.append(f"Planned {name} is in {planned.get('unit')} but the activity unit is {activity['unit']}. Fix the model data first.")
	if errors:
		return errors

	approved = 0.0
	pending = 0.0
	for e in entries:
		if e["id"] == exclude_entry_id:
			continue
		if e["elementId"] != element["id"] or e["activityCode"] != activity["code"] or e["unit"] != activity["unit"]:
			continue
		if e["status"] == "Approved":
			approved += e["quantity"]
		elif e["status"] == "Submitted":
			pending += e["quantity"]
	approved = round_qty(approved)
	pending = round_qty(pending)
	committed = round_qty(approved + pending) if mode == "claim" else approved
	available = round_qty(planned["quantity"] - committed)

	if quantity > available + QTY_EPSILON:
		parts = [f"planned {js_num(planned['quantity'])} {activity['unit']}", f"approved {js_num(approved)}"]
		if mode == "claim" and pending > 0:
			parts.append(f"awaiting review {js_num(pending)}")
		errors.append(
			f"{js_num(quantity)} {activity['unit']} exceeds the remaining quantity for {name} ({', '.join(parts)}; "
			f"available {js_num(max(available, 0))} {activity['unit']}). "
			"If the plan is wrong, revise the model quantities instead of over-reporting."
		)
	return errors


def find_possible_duplicate(entries, element_id, activity_code, date, quantity, exclude_id=None):
	for e in entries:
		if (
			e["id"] != exclude_id
			and e["status"] != "Returned"
			and e["elementId"] == element_id
			and e["activityCode"] == activity_code
			and e["date"] == date
			and abs(e["quantity"] - quantity) < QTY_EPSILON
		):
			return e
	return None


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def validate_date(value, today):
	"""today: 'YYYY-MM-DD' (site date)."""
	if not isinstance(value, str) or not _DATE_RE.match(value):
		return ["Enter a valid date."]
	try:
		_date.fromisoformat(value)
	except ValueError:
		return ["Enter a valid date."]
	if value > today:
		return ["Date cannot be in the future."]
	return []


# ---------------------------------------------------------------- multi-element allocation


def sum_qty(values):
	return round_qty(sum(values), QTY_DECIMALS)


def validate_allocation(total, allocations):
	errors = []
	if not _is_num(total) or total <= 0:
		errors.append("Enter a total quantity greater than zero.")
	for i, q in enumerate(allocations):
		if not _is_num(q):
			errors.append(f"Row {i + 1}: allocation is not a number.")
		elif q < 0:
			errors.append(f"Row {i + 1}: allocation cannot be negative.")
		elif q == 0:
			errors.append(f"Row {i + 1}: allocation is zero — remove that element from the selection instead.")
		elif round_qty(q, QTY_DECIMALS) != q:
			errors.append(f"Row {i + 1}: use at most {QTY_DECIMALS} decimals.")
	allocated = sum_qty([q for q in allocations if _is_num(q)])
	difference = round_qty(total - allocated, QTY_DECIMALS) if _is_num(total) else 0
	if _is_num(total) and abs(difference) > QTY_EPSILON:
		sign = "+" if difference > 0 else ""
		errors.append(
			f"Allocated {js_num(allocated)} does not match the entered total {js_num(total)} (difference {sign}{js_num(difference)})."
		)
	return {"ok": not errors, "errors": errors, "allocated": allocated, "difference": difference}


def resolve_batch_quantities(mode, value, element_ids, allocations=None):
	"""Per-element quantities for a multi-element entry. A total is never copied onto each element."""
	if not element_ids:
		return {"ok": False, "errors": ["Select at least one element."]}
	if len(set(element_ids)) != len(element_ids):
		return {"ok": False, "errors": ["The selection contains duplicates."]}

	if mode == "per-element":
		if not _is_num(value) or value <= 0:
			return {"ok": False, "errors": ["Enter a quantity per element greater than zero."]}
		if round_qty(value, QTY_DECIMALS) != value:
			return {"ok": False, "errors": [f"Use at most {QTY_DECIMALS} decimals."]}
		return {"ok": True, "quantities": {eid: value for eid in element_ids}}

	if mode != "total":
		return {"ok": False, "errors": ["Choose whether the quantity is a total across the selection or a quantity per element."]}
	if not isinstance(allocations, dict):
		return {"ok": False, "errors": ["Allocate the total across the selected elements (manually or by an equal split)."]}
	extra = [k for k in allocations if k not in element_ids]
	if extra:
		return {"ok": False, "errors": [f"Allocation contains elements that are not selected: {', '.join(extra)}."]}
	missing = [k for k in element_ids if k not in allocations]
	if missing:
		return {"ok": False, "errors": [f"No allocation entered for: {', '.join(missing)}."]}
	check = validate_allocation(value, [allocations[k] for k in element_ids])
	if not check["ok"]:
		return {"ok": False, "errors": check["errors"]}
	return {"ok": True, "quantities": {k: allocations[k] for k in element_ids}}
