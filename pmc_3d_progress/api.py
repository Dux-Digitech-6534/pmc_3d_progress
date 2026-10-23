"""Whitelisted server methods used by the PMC 3D Progress web page (/pmc-3d).

They mirror the frontend PmcRepository interface (frontend/src/data/repository.ts) one to one and
return the same JSON shapes, so the UI works unchanged against this server. Every write is
checked here: the user's PMC role, the Draft → Submitted → Approved / Returned workflow, and the
quantity / model rules in pmc_3d_progress.domain. The browser's own checks are only for speed.

Roles: PMC Site Engineer (records work), PMC Reviewer (approves / returns), PMC Owner (views).
A System Manager may act as any of them.
"""

import json

import frappe
from frappe.model.naming import make_autoname
from frappe.utils import cint, flt, get_datetime, get_fullname, now_datetime, nowdate

from pmc_3d_progress import domain

ROLE_TO_FRAPPE = {"site-engineer": "PMC Site Engineer", "pmc-reviewer": "PMC Reviewer", "owner": "PMC Owner"}
MAX_MODEL_TEXT = 10 * 1024 * 1024
DPR_FIELDS = [
	"name",
	"client_request_id",
	"project",
	"model_key",
	"model_id",
	"model_revision",
	"source_element_id",
	"element_code",
	"element_type",
	"activity_code",
	"activity_name",
	"date",
	"quantity",
	"unit",
	"remarks",
	"status",
	"review_remarks",
	"batch_id",
	"batch_mode",
	"batch_element_count",
	"batch_total",
	"batch_per_element",
	"history",
	"creation",
	"modified",
]


class PMCValidationError(frappe.ValidationError):
	pass


class PMCPossibleDuplicate(frappe.ValidationError):
	"""An identical-looking entry exists; the client may resend with confirmDuplicate."""


class PMCConflictError(frappe.ValidationError):
	pass


# ---------------------------------------------------------------- helpers


def _throw(errors, exc=PMCValidationError):
	"""One message per line; the web page splits them back into a list."""
	msgs = [errors] if isinstance(errors, str) else list(errors)
	frappe.throw("\n".join(msgs), exc=exc, title="PMC 3D Progress")


def _parse(value):
	if value is None or isinstance(value, (dict, list)):
		return value
	try:
		return json.loads(value)
	except ValueError:
		_throw("The request data is not valid JSON.")


def _json(value, default=None):
	if value in (None, ""):
		return default
	if isinstance(value, (dict, list)):
		return value
	try:
		return json.loads(value)
	except ValueError:
		return default


def _iso(value):
	return get_datetime(value).isoformat() if value else None


def _user_roles():
	"""The demo-style roles this user may act as, in a fixed order."""
	if frappe.session.user == "Guest":
		return []
	roles = set(frappe.get_roles())
	if "System Manager" in roles:
		return list(domain.ROLES)
	return [r for r in domain.ROLES if ROLE_TO_FRAPPE[r] in roles]


def _require_reader():
	if not _user_roles():
		_throw(
			"You do not have a PMC role. Ask the administrator for PMC Site Engineer, PMC Reviewer or PMC Owner.",
			frappe.PermissionError,
		)


def _require_modeller():
	"""Importing models / drawings: site engineers, reviewers and System Managers."""
	roles = _user_roles()
	if "site-engineer" not in roles and "pmc-reviewer" not in roles:
		_throw("Only a PMC Site Engineer or PMC Reviewer can create or change models and drawings.", frappe.PermissionError)


def _act_as(role):
	if role not in domain.ROLES:
		_throw(f"Unknown role {role}.", frappe.PermissionError)
	if role not in _user_roles():
		_throw(f"You are not allowed to act as {domain.ROLE_LABELS[role]}.", frappe.PermissionError)
	return role


def _history(role, action, note=None):
	item = {"at": now_datetime().isoformat(), "role": role, "action": action, "user": frappe.session.user}
	if note:
		item["note"] = note
	return item


# ---------------------------------------------------------------- shapes returned to the page


def _project_dict(p, model_keys):
	return {
		"id": p.name,
		"name": p.project_name,
		"location": p.location or None,
		"client": p.client or None,
		"activeModelKey": model_keys.get(p.active_model) if p.active_model else None,
		"createdAt": _iso(p.creation),
	}


def _model_dict(m, with_document=True):
	failed = m.status == "Failed"
	return {
		"key": m.model_key,
		"projectId": m.project or "(unknown)",
		"modelId": m.model_id,
		"name": m.model_name,
		"revision": m.revision,
		"sourceType": m.source_type,
		"sourceName": m.source_name,
		"importedAt": _iso(m.imported_on),
		"status": m.status,
		"elementCount": cint(m.element_count),
		"warnings": _json(m.warnings, []),
		"errors": _json(m.errors, []) if failed else None,
		"document": _json(m.document) if with_document and not failed else None,
	}


def _entry_dict(d, photos):
	batch = None
	if d.get("batch_id"):
		batch = {"id": d.batch_id, "mode": d.batch_mode, "elementCount": cint(d.batch_element_count)}
		if (d.batch_mode or "").startswith("total"):
			batch["total"] = flt(d.batch_total)
		else:
			batch["perElement"] = flt(d.batch_per_element)
	return {
		"id": d.name,
		"clientRequestId": d.client_request_id,
		"projectId": d.project,
		"modelKey": d.model_key,
		"modelId": d.model_id,
		"modelRevision": d.model_revision,
		"elementId": d.source_element_id,
		"elementCode": d.element_code,
		"elementType": d.element_type,
		"activityCode": d.activity_code,
		"activityName": d.activity_name,
		"date": str(d.date),
		"quantity": flt(d.quantity),
		"unit": d.unit,
		"remarks": d.remarks or "",
		"status": d.status,
		"photos": photos,
		"batch": batch,
		"reviewRemarks": d.review_remarks or None,
		"createdAt": _iso(d.creation),
		"updatedAt": _iso(d.modified),
		"history": _json(d.history, []),
	}


def _load_entries(filters, order_by="date desc, creation desc"):
	rows = frappe.get_all("PMC DPR", filters=filters, fields=DPR_FIELDS, order_by=order_by, limit_page_length=0)
	if not rows:
		return []
	photos = {}
	for ph in frappe.get_all(
		"PMC DPR Photo",
		filters={"parenttype": "PMC DPR", "parent": ["in", [r.name for r in rows]]},
		fields=["parent", "file", "file_name", "file_size", "content_type", "idx"],
		order_by="idx asc",
		limit_page_length=0,
	):
		photos.setdefault(ph.parent, []).append(
			{"id": ph.file, "name": ph.file_name, "type": ph.content_type, "size": cint(ph.file_size)}
		)
	return [_entry_dict(r, photos.get(r.name, [])) for r in rows]


def _entry(name):
	rows = _load_entries({"name": name})
	return rows[0] if rows else None


def _replayed(client_request_id):
	"""Idempotency: a retried save (same request id) returns what the first one created."""
	if not client_request_id:
		_throw("clientRequestId is required.")
	return _load_entries({"client_request_id": client_request_id}, order_by="creation asc")


def _active_context(project_id):
	project = frappe.db.get_value("PMC Project", project_id, ["name", "project_name", "active_model"], as_dict=True)
	if not project:
		_throw(f"Project {project_id} was not found.", frappe.DoesNotExistError)
	model = frappe.get_doc("PMC Model", project.active_model) if project.active_model else None
	document = _json(model.document) if model else None
	if not model or not document:
		_throw(f"Project {project.project_name} has no imported model yet.")
	return project, model, document


def _find_element(document, element_id):
	for e in document.get("elements", []):
		if e.get("id") == element_id:
			return e
	_throw(f'Element "{element_id}" is not part of the active model revision.')


def _find_activity(document, code):
	for a in document.get("activities", []):
		if a.get("code") == code:
			return {"code": a["code"], "name": a["name"], "unit": a["unit"], "appliesTo": a.get("appliesTo")}
	_throw(f'Unknown activity "{code}" for this model.')


def _element_link(model_name, source_element_id):
	return frappe.db.get_value("PMC Element", {"pmc_model": model_name, "source_element_id": source_element_id}, "name")


def _photo_rows(photos, allowed_existing=()):
	"""Photos must be files this user uploaded (or already on the entry being edited)."""
	rows = []
	for p in photos or []:
		url = (p or {}).get("id")
		file = frappe.db.get_value("File", {"file_url": url}, ["name", "owner", "file_size"], as_dict=True) if url else None
		if not file:
			_throw(f"Photo {p.get('name') or url} was not uploaded. Attach it again.")
		if url not in allowed_existing and file.owner != frappe.session.user and "System Manager" not in frappe.get_roles():
			_throw("A photo can only be attached by the user who uploaded it.", frappe.PermissionError)
		rows.append(
			{"file": url, "file_name": p.get("name"), "file_size": cint(p.get("size") or file.file_size), "content_type": p.get("type")}
		)
	return rows


def _attach_files(doc):
	for row in doc.photos:
		name = frappe.db.get_value("File", {"file_url": row.file, "attached_to_name": ["is", "not set"]}, "name")
		if name:
			frappe.db.set_value("File", name, {"attached_to_doctype": "PMC DPR", "attached_to_name": doc.name})


# ---------------------------------------------------------------- session


@frappe.whitelist()
def get_session():
	"""Who is using the page and which PMC roles they may act as."""
	if frappe.session.user == "Guest":
		frappe.throw("Please log in.", frappe.AuthenticationError)
	from pmc_3d_progress.ai import is_configured  # ai imports this module

	return {
		"user": frappe.session.user,
		"fullName": get_fullname(frappe.session.user),
		"roles": _user_roles(),
		"aiConfigured": is_configured(),
	}


# ---------------------------------------------------------------- projects & models


@frappe.whitelist()
def list_projects():
	_require_reader()
	projects = frappe.get_all(
		"PMC Project", fields=["name", "project_name", "location", "client", "active_model", "creation"], order_by="creation asc"
	)
	active = [p.active_model for p in projects if p.active_model]
	keys = {}
	if active:
		keys = {m.name: m.model_key for m in frappe.get_all("PMC Model", filters={"name": ["in", active]}, fields=["name", "model_key"])}
	return [_project_dict(p, keys) for p in projects]


@frappe.whitelist()
def get_project(project_id):
	return next((p for p in list_projects() if p["id"] == project_id), None)


_MODEL_FIELDS = [
	"name",
	"model_key",
	"project",
	"model_id",
	"model_name",
	"revision",
	"status",
	"source_type",
	"source_name",
	"imported_on",
	"element_count",
	"warnings",
	"errors",
	"document",
]


@frappe.whitelist()
def list_models(project_id=None):
	_require_reader()
	filters = {"project": project_id} if project_id else {}
	rows = frappe.get_all("PMC Model", filters=filters, fields=_MODEL_FIELDS, order_by="creation asc", limit_page_length=0)
	return [_model_dict(m) for m in rows]


@frappe.whitelist()
def get_project_model(project_id):
	_require_reader()
	active = frappe.db.get_value("PMC Project", project_id, "active_model")
	if not active:
		return None
	m = frappe.db.get_value("PMC Model", active, _MODEL_FIELDS, as_dict=True)
	return _model_dict(m) if m else None


@frappe.whitelist(methods=["POST"])
def import_model(text, source_name, source_type, target_project_id=None):
	"""Validate and store a model revision (same rules and messages as the local prototype)."""
	_require_modeller()
	if not isinstance(text, str) or len(text) > MAX_MODEL_TEXT:
		_throw("The model file is too large (limit 10 MB).")
	source_name = (source_name or "model.json")[:140]

	def failed(errors, warnings=(), project_id=None):
		# Failed attempts are kept in the register so the import status is auditable.
		project_id = project_id or target_project_id
		doc = frappe.get_doc(
			{
				"doctype": "PMC Model",
				"project": project_id if project_id and frappe.db.exists("PMC Project", project_id) else None,
				"model_key": f"failed|{frappe.generate_hash(length=12)}",
				"model_id": "—",
				"revision": "—",
				"model_name": source_name,
				"status": "Failed",
				"source_type": source_type,
				"source_name": source_name,
				"imported_on": now_datetime(),
				"element_count": 0,
				"warnings": json.dumps(list(warnings)),
				"errors": json.dumps(list(errors)),
			}
		).insert(ignore_permissions=True)
		record = _model_dict(frappe._dict(doc.as_dict()))
		if not doc.project:
			record["projectId"] = project_id or "(unknown)"
		return {"ok": False, "errors": list(errors), "warnings": list(warnings), "record": record}

	try:
		parsed = json.loads(text)
	except ValueError as e:
		return failed([f"File is not valid JSON: {e}"])
	v = domain.validate_model_document(parsed)
	if not v["ok"]:
		file_project = parsed.get("project", {}).get("id") if isinstance(parsed, dict) and isinstance(parsed.get("project"), dict) else None
		return failed(v["errors"], v["warnings"], target_project_id or (file_project if isinstance(file_project, str) else None))
	doc = v["document"]
	pid, mid, rev = doc["project"]["id"], doc["model"]["id"], doc["model"]["revision"]

	if target_project_id and pid != target_project_id:
		return failed(
			[
				f'This model belongs to project "{pid}" but you are importing into "{target_project_id}". '
				'Choose the matching project, or import with "Use project from file".'
			],
			v["warnings"],
		)

	key = f"{pid}|{mid}|{rev}"
	if frappe.db.exists("PMC Model", {"model_key": key}):
		return failed(
			[
				f"Model {mid} revision {rev} is already imported for {pid}. A changed model must use a new revision "
				"(e.g. R02); existing revisions are never overwritten."
			],
			v["warnings"],
			pid,
		)

	created_project = False
	if not frappe.db.exists("PMC Project", pid):
		frappe.get_doc(
			{
				"doctype": "PMC Project",
				"project_code": pid,
				"project_name": doc["project"]["name"],
				"location": doc["project"].get("location"),
				"client": doc["project"].get("client"),
			}
		).insert(ignore_permissions=True)
		created_project = True

	previous = frappe.db.get_value("PMC Project", pid, "active_model")
	superseded_key = frappe.db.get_value("PMC Model", previous, "model_key") if previous else None
	for name in frappe.get_all("PMC Model", filters={"project": pid, "status": "Active"}, pluck="name"):
		frappe.db.set_value("PMC Model", name, "status", "Superseded")

	model = frappe.get_doc(
		{
			"doctype": "PMC Model",
			"project": pid,
			"model_key": key,
			"model_id": mid,
			"revision": rev,
			"model_name": doc["model"]["name"],
			"status": "Active",
			"source_type": source_type,
			"source_name": source_name,
			"imported_on": now_datetime(),
			"element_count": len(doc["elements"]),
			"warnings": json.dumps(v["warnings"]),
			"errors": json.dumps([]),
			"document": json.dumps(doc),
		}
	).insert(ignore_permissions=True)

	buildings = {b["id"]: b["name"] for b in doc["buildings"]}
	levels = {lv["id"]: lv["name"] for lv in doc["levels"]}
	for e in doc["elements"]:
		frappe.get_doc(
			{
				"doctype": "PMC Element",
				"pmc_model": model.name,
				"project": pid,
				"model_revision": rev,
				"source_element_id": e["id"],
				"code": e["code"],
				"element_type": e["type"],
				"building": buildings.get(e["buildingId"], e["buildingId"]),
				"level": levels.get(e["levelId"], e["levelId"]),
				"planned_quantities": json.dumps(e.get("plannedQuantities") or {}),
			}
		).insert(ignore_permissions=True)

	frappe.db.set_value("PMC Project", pid, "active_model", model.name)
	return {
		"ok": True,
		"errors": [],
		"warnings": v["warnings"],
		"record": _model_dict(frappe._dict(model.as_dict())),
		"createdProject": created_project,
		"supersededKey": superseded_key,
	}


@frappe.whitelist(methods=["POST"])
def set_active_model(model_key):
	_require_modeller()
	target = frappe.db.get_value("PMC Model", {"model_key": model_key}, ["name", "project", "status", "document"], as_dict=True)
	if not target or target.status == "Failed" or not target.document or not target.project:
		_throw("That model revision cannot be activated.", frappe.DoesNotExistError)
	for name in frappe.get_all("PMC Model", filters={"project": target.project, "status": ["!=", "Failed"]}, pluck="name"):
		frappe.db.set_value("PMC Model", name, "status", "Active" if name == target.name else "Superseded")
	frappe.db.set_value("PMC Project", target.project, "active_model", target.name)


# ---------------------------------------------------------------- progress entries


@frappe.whitelist()
def list_progress_entries(project_id, model_key=None):
	_require_reader()
	filters = {"project": project_id}
	if model_key:
		filters["model_key"] = model_key
	return _load_entries(filters)


@frappe.whitelist()
def list_all_progress_entries():
	_require_reader()
	return _load_entries({})


@frappe.whitelist(methods=["POST"])
def save_progress_entry(input, role):
	data = _parse(input) or {}
	role = _act_as(role)
	replay = _replayed(data.get("clientRequestId"))
	if replay:
		return replay[0]
	if not domain.can_create(role):
		_throw(f"{domain.ROLE_LABELS[role]} cannot create or edit progress entries.", frappe.PermissionError)

	project, model, document = _active_context(data.get("projectId"))
	element = _find_element(document, data.get("elementId"))
	activity = _find_activity(document, data.get("activityCode"))
	scope = _load_entries({"project": project.name, "model_key": model.model_key})

	existing = None
	if data.get("id"):
		if not frappe.db.exists("PMC DPR", data["id"]):
			_throw(f"Entry {data['id']} no longer exists.", frappe.DoesNotExistError)
		existing = frappe.get_doc("PMC DPR", data["id"])
		if not domain.can_edit(role, existing.status):
			_throw(f"Entry {existing.name} is {existing.status} and can no longer be edited.", PMCConflictError)
		if existing.model_key != model.model_key:
			_throw(
				f"Entry {existing.name} belongs to model revision {existing.model_revision}; it cannot be moved to {model.revision}.",
				PMCConflictError,
			)

	remarks = (data.get("remarks") or "").strip()
	quantity = data.get("quantity")
	errors = (
		domain.validate_date(data.get("date"), nowdate())
		+ domain.check_quantity(element, activity, quantity, data.get("unit"), scope, "claim", data.get("id"))
		+ (["Remarks must be 500 characters or fewer."] if len(remarks) > 500 else [])
	)
	if errors:
		_throw(errors)

	if not data.get("confirmDuplicate"):
		dup = domain.find_possible_duplicate(scope, element["id"], activity["code"], data["date"], quantity, data.get("id"))
		if dup:
			_throw(
				f"An entry with the same element, activity, date and quantity already exists ({dup['id']}, {dup['status']}). "
				"Confirm it is separate work to save anyway.",
				PMCPossibleDuplicate,
			)

	existing_urls = [p.file for p in existing.photos] if existing else []
	photos = _photo_rows(data.get("photos"), existing_urls)

	if existing:
		history = _json(existing.history, [])
		history.append(_history(role, "Edited", "Corrected after return" if existing.status == "Returned" else None))
		existing.update({"date": data["date"], "quantity": flt(quantity), "unit": data["unit"], "remarks": remarks, "status": "Draft"})
		existing.set("photos", [])
		for row in photos:
			existing.append("photos", row)
		doc = existing
	else:
		history = [_history(role, "Created")]
		doc = frappe.get_doc(
			{
				"doctype": "PMC DPR",
				"client_request_id": data["clientRequestId"],
				"project": project.name,
				"pmc_model": model.name,
				"model_key": model.model_key,
				"model_id": model.model_id,
				"model_revision": model.revision,
				"element": _element_link(model.name, element["id"]),
				"source_element_id": element["id"],
				"element_code": element["code"],
				"element_type": element["type"],
				"activity_code": activity["code"],
				"activity_name": activity["name"],
				"date": data["date"],
				"quantity": flt(quantity),
				"unit": data["unit"],
				"remarks": remarks,
				"status": "Draft",
				"photos": photos,
			}
		)
	if data.get("submit"):
		doc.status = "Submitted"
		history.append(_history(role, "Submitted"))
	doc.history = json.dumps(history)
	doc.save(ignore_permissions=True) if existing else doc.insert(ignore_permissions=True)
	_attach_files(doc)
	return _entry(doc.name)


@frappe.whitelist(methods=["POST"])
def save_batch_entries(input, role):
	data = _parse(input) or {}
	role = _act_as(role)
	replay = _replayed(data.get("clientRequestId"))
	if replay:
		return replay
	if not domain.can_create(role):
		_throw(f"{domain.ROLE_LABELS[role]} cannot create progress entries.", frappe.PermissionError)

	project, model, document = _active_context(data.get("projectId"))
	activity = _find_activity(document, data.get("activityCode"))
	element_ids = data.get("elementIds") or []
	selected = [_find_element(document, eid) for eid in element_ids]
	mode = data.get("mode")
	if mode == "total" and not data.get("allocationMethod"):
		_throw("Choose how the total is allocated: manual allocation or an equal split.")
	resolved = domain.resolve_batch_quantities(
		mode, data.get("value"), element_ids, data.get("allocations") if mode == "total" else None
	)
	if not resolved["ok"]:
		_throw(resolved["errors"])
	quantities = resolved["quantities"]

	scope = _load_entries({"project": project.name, "model_key": model.model_key})
	remarks = (data.get("remarks") or "").strip()
	errors = list(domain.validate_date(data.get("date"), nowdate()))
	if len(remarks) > 500:
		errors.append("Remarks must be 500 characters or fewer.")
	for el in selected:
		for m in domain.check_quantity(el, activity, quantities[el["id"]], data.get("unit"), scope, "claim"):
			errors.append(m if m.startswith(el["code"]) else f"{el['code']}: {m}")
	if errors:
		_throw(list(dict.fromkeys(errors)))

	if not data.get("confirmDuplicate"):
		dups = [
			d
			for d in (
				domain.find_possible_duplicate(scope, el["id"], activity["code"], data["date"], quantities[el["id"]]) for el in selected
			)
			if d
		]
		if dups:
			listed = ", ".join(f"{d['elementCode']} ({d['id']}, {d['status']})" for d in dups)
			_throw(
				f"Identical entries already exist for {listed}. Confirm this is separate work to save anyway.",
				PMCPossibleDuplicate,
			)

	photos = _photo_rows(data.get("photos"))
	batch_id = make_autoname("BATCH-.#####")
	batch_mode = "per-element" if mode == "per-element" else ("total-equal" if data.get("allocationMethod") == "equal" else "total-manual")
	names = []
	for el in selected:
		history = [_history(role, "Created", f"Multi-element entry {batch_id}")]
		if data.get("submit"):
			history.append(_history(role, "Submitted"))
		doc = frappe.get_doc(
			{
				"doctype": "PMC DPR",
				"client_request_id": data["clientRequestId"],
				"project": project.name,
				"pmc_model": model.name,
				"model_key": model.model_key,
				"model_id": model.model_id,
				"model_revision": model.revision,
				"element": _element_link(model.name, el["id"]),
				"source_element_id": el["id"],
				"element_code": el["code"],
				"element_type": el["type"],
				"activity_code": activity["code"],
				"activity_name": activity["name"],
				"date": data["date"],
				"quantity": flt(quantities[el["id"]]),
				"unit": data["unit"],
				"remarks": remarks,
				"status": "Submitted" if data.get("submit") else "Draft",
				"photos": photos,
				"batch_id": batch_id,
				"batch_mode": batch_mode,
				"batch_element_count": len(selected),
				"batch_total": flt(data.get("value")) if mode == "total" else None,
				"batch_per_element": flt(data.get("value")) if mode == "per-element" else None,
				"history": json.dumps(history),
			}
		).insert(ignore_permissions=True)
		_attach_files(doc)
		names.append(doc.name)
	return [_entry(n) for n in names]


def _check_on_active_revision(doc, verb):
	project, model, document = _active_context(doc.project)
	if doc.model_key != model.model_key:
		_throw(
			f"Entry {doc.name} was recorded on revision {doc.model_revision}, which is no longer active. "
			f"It is kept as history and cannot be {verb}.",
			PMCConflictError,
		)
	return project, model, document


@frappe.whitelist(methods=["POST"])
def submit_progress_entry(entry_id, role):
	role = _act_as(role)
	if not frappe.db.exists("PMC DPR", entry_id):
		_throw(f"Entry {entry_id} was not found.", frappe.DoesNotExistError)
	doc = frappe.get_doc("PMC DPR", entry_id)
	if doc.status == "Submitted":
		_throw(f"Entry {entry_id} has already been submitted.", PMCConflictError)
	if not domain.can_submit(role, doc.status):
		_throw(f"{domain.ROLE_LABELS[role]} cannot submit an entry that is {doc.status}.", frappe.PermissionError)
	project, model, document = _check_on_active_revision(doc, "submitted")
	scope = _load_entries({"project": project.name, "model_key": model.model_key})
	errors = domain.check_quantity(
		_find_element(document, doc.source_element_id),
		_find_activity(document, doc.activity_code),
		flt(doc.quantity),
		doc.unit,
		scope,
		"claim",
		doc.name,
	)
	if errors:
		_throw(errors)
	history = _json(doc.history, [])
	history.append(_history(role, "Submitted"))
	doc.status = "Submitted"
	doc.history = json.dumps(history)
	doc.save(ignore_permissions=True)
	return _entry(doc.name)


@frappe.whitelist(methods=["POST"])
def review_progress_entry(entry_id, decision, remarks, role):
	role = _act_as(role)
	if not frappe.db.exists("PMC DPR", entry_id):
		_throw(f"Entry {entry_id} was not found.", frappe.DoesNotExistError)
	doc = frappe.get_doc("PMC DPR", entry_id)
	if doc.status != "Submitted":
		_throw(f"Entry {entry_id} is {doc.status}; only Submitted entries can be reviewed.", PMCConflictError)
	if not domain.can_review(role, doc.status):
		_throw(f"{domain.ROLE_LABELS[role]} cannot review entries.", frappe.PermissionError)
	if decision not in ("approve", "return"):
		_throw("Decision must be approve or return.")
	note = (remarks or "").strip()
	if decision == "return" and not note:
		_throw("Enter a reason so the site engineer knows what to correct.")
	if decision == "approve":
		project, model, document = _active_context(doc.project)
		if doc.model_key != model.model_key:
			_throw(
				f"Entry {entry_id} belongs to inactive revision {doc.model_revision}. "
				"Progress is never transferred between revisions automatically.",
				PMCConflictError,
			)
		scope = _load_entries({"project": project.name, "model_key": model.model_key})
		errors = domain.check_quantity(
			_find_element(document, doc.source_element_id),
			_find_activity(document, doc.activity_code),
			flt(doc.quantity),
			doc.unit,
			scope,
			"approve",
			doc.name,
		)
		if errors:
			_throw(errors)
	history = _json(doc.history, [])
	history.append(_history(role, "Approved" if decision == "approve" else "Returned", note or None))
	doc.status = "Approved" if decision == "approve" else "Returned"
	doc.review_remarks = note or None
	doc.history = json.dumps(history)
	doc.save(ignore_permissions=True)
	return _entry(doc.name)


@frappe.whitelist(methods=["POST"])
def delete_draft_entry(entry_id, role):
	role = _act_as(role)
	if not frappe.db.exists("PMC DPR", entry_id):
		_throw(f"Entry {entry_id} was not found.", frappe.DoesNotExistError)
	status = frappe.db.get_value("PMC DPR", entry_id, "status")
	if not domain.can_delete(role, status):
		_throw(f"Only Draft entries can be deleted by the site engineer (this one is {status}).", frappe.PermissionError)
	frappe.delete_doc("PMC DPR", entry_id, ignore_permissions=True)


# ---------------------------------------------------------------- drawings (PDF / image) for Model Builder


def _drawing_dict(d):
	return {
		"id": d.name,
		"projectId": d.project_code,
		"name": d.file_name,
		"kind": d.kind,
		"type": d.content_type or ("application/pdf" if d.kind == "pdf" else "image/*"),
		"size": cint(d.file_size),
		"uploadedAt": _iso(d.creation),
		"url": d.file,
	}


@frappe.whitelist()
def list_drawings(project_id):
	_require_reader()
	rows = frappe.get_all(
		"PMC Drawing",
		filters={"project_code": project_id},
		fields=["name", "project_code", "file", "file_name", "kind", "file_size", "content_type", "creation"],
		order_by="creation asc",
	)
	return [_drawing_dict(r) for r in rows]


@frappe.whitelist(methods=["POST"])
def add_drawing(project_id, file_url, file_name, kind, content_type=None, size=0):
	"""Register a file uploaded through /api/method/upload_file as a project drawing."""
	_require_modeller()
	if kind not in ("pdf", "image"):
		_throw("Only PDF, JPG, PNG or WebP drawings can be uploaded.")
	if not (project_id or "").strip():
		_throw("Enter the Project ID first — drawings are kept with the project.")
	file = frappe.db.get_value("File", {"file_url": file_url}, ["name", "owner"], as_dict=True)
	if not file or (file.owner != frappe.session.user and "System Manager" not in frappe.get_roles()):
		_throw("The drawing upload was not found. Upload it again.")
	doc = frappe.get_doc(
		{
			"doctype": "PMC Drawing",
			"project_code": project_id.strip(),
			"file": file_url,
			"file_name": file_name,
			"kind": kind,
			"file_size": cint(size),
			"content_type": content_type,
		}
	).insert(ignore_permissions=True)
	frappe.db.set_value("File", file.name, {"attached_to_doctype": "PMC Drawing", "attached_to_name": doc.name})
	return _drawing_dict(frappe._dict(doc.as_dict()))


@frappe.whitelist(methods=["POST"])
def delete_drawing(drawing_id):
	_require_modeller()
	if frappe.db.exists("PMC Drawing", drawing_id):
		for name in frappe.get_all("File", filters={"attached_to_doctype": "PMC Drawing", "attached_to_name": drawing_id}, pluck="name"):
			frappe.delete_doc("File", name, ignore_permissions=True)
		frappe.delete_doc("PMC Drawing", drawing_id, ignore_permissions=True)


@frappe.whitelist(methods=["POST"])
def reassign_drawings(from_project_id, to_project_id):
	"""Drawings uploaded under a draft project id follow the project when the user changes the ID."""
	_require_modeller()
	if from_project_id == to_project_id or frappe.db.exists("PMC Project", from_project_id):
		return
	for name in frappe.get_all("PMC Drawing", filters={"project_code": from_project_id}, pluck="name"):
		frappe.db.set_value("PMC Drawing", name, "project_code", to_project_id)
