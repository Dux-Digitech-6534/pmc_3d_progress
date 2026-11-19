"""Planning for the reports-mobile branch (beta page /pmc-3d-beta).

What the site engineer plans to do on a date, "No work" when a planned job did not happen, and the
date an activity was started on an element. Kept per project as JSON in a global default
(`pmc3d_beta_plan::<project id>`), like the material variation settings: no new DocType, no migrate,
nothing the live page /pmc-3d reads. Every rule here is checked again on top of what the page checks.
"""

import json
import uuid

import frappe
from frappe.utils import getdate, now_datetime, nowdate

from pmc_3d_progress.api import _act_as, _active_context, _find_activity, _find_element, _parse, _require_reader, _throw

_PLANNERS = ("site-engineer", "pmc-reviewer")
# a "No work" plan: nothing will be done on these elements in these dates
NO_WORK_CODE = "NO-WORK"
_MAX_ITEMS = 20000


def _key(project_id):
	return f"pmc3d_beta_plan::{project_id}"


def _load(project_id):
	raw = frappe.defaults.get_global_default(_key(project_id))
	try:
		data = json.loads(raw) if raw else {}
	except ValueError:
		data = {}
	return {"plans": data.get("plans") or [], "starts": data.get("starts") or []}


def _save(project_id, data):
	if len(data["plans"]) + len(data["starts"]) > _MAX_ITEMS:
		_throw("Too many planning records for one project.")
	frappe.defaults.set_global_default(_key(project_id), json.dumps(data, separators=(",", ":")))
	return data


def _lock(project_id):
	# one writer at a time per project: the read-change-write of the JSON must not interleave
	frappe.db.sql("select name from `tabPMC Project` where name=%s for update", project_id)


def _planner(role):
	_act_as(role)
	if role not in _PLANNERS:
		_throw("Only a PMC Site Engineer or PMC Reviewer can change the planning.", frappe.PermissionError)


def _date(value, what="Date"):
	try:
		return str(getdate(value))
	except Exception:
		_throw(f"{what} is not a valid date.")


def _ids(value):
	ids = _parse(value) or []
	if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
		_throw("Select at least one element.")
	return list(dict.fromkeys(ids))


@frappe.whitelist()
def get_planning(project_id):
	_require_reader()
	if not frappe.db.exists("PMC Project", project_id):
		_throw(f"Project {project_id} was not found.", frappe.DoesNotExistError)
	return _load(project_id)


@frappe.whitelist(methods=["POST"])
def add_plans(project_id, date, activity_code, element_ids, role, note=None, to_date=None):
	"""Plan one activity on some elements for From (date) .. To (to_date). The same element, activity and dates again is skipped."""
	_planner(role)
	_lock(project_id)
	_, _, document = _active_context(project_id)
	day = _date(date, "From date")
	end = _date(to_date, "To date") if to_date else day
	if end < day:
		_throw('"To" date is before "From" date.')
	no_work = activity_code == NO_WORK_CODE
	activity = {"code": NO_WORK_CODE, "name": "No work"} if no_work else _find_activity(document, activity_code)
	ids = _ids(element_ids)
	for i in ids:
		el = _find_element(document, i)
		applies = None if no_work else activity.get("appliesTo")
		if applies and el.get("type") not in applies:
			_throw(f'{activity["name"]} does not apply to {el.get("code") or i}.')
	note = (note or "").strip()
	if len(note) > 300:
		_throw("The note must be 300 characters or fewer.")
	data = _load(project_id)
	have = {(p["elementId"], p["activityCode"], p["date"], p.get("to") or p["date"]) for p in data["plans"]}
	now = now_datetime().isoformat()
	added = 0
	for i in ids:
		if (i, activity["code"], day, end) in have:
			continue
		data["plans"].append(
			{
				"id": uuid.uuid4().hex[:12],
				"elementId": i,
				"activityCode": activity["code"],
				"date": day,
				"to": end,
				"note": note,
				"status": "draft",
				"createdBy": frappe.session.user,
				"createdAt": now,
			}
		)
		added += 1
	_save(project_id, data)
	return {"added": added, "skipped": len(ids) - added, **data}


@frappe.whitelist(methods=["POST"])
def delete_plans(project_id, plan_ids, role):
	_planner(role)
	_lock(project_id)
	ids = set(_ids(plan_ids))
	data = _load(project_id)
	if any(p["id"] in ids and p.get("status") == "submitted" for p in data["plans"]):
		_throw("A submitted plan cannot be removed.")
	data["plans"] = [p for p in data["plans"] if p["id"] not in ids]
	return _save(project_id, data)


@frappe.whitelist(methods=["POST"])
def change_plan_dates(project_id, plan_ids, date, to_date, role):
	"""New From / To dates for draft plans (a submitted plan is final)."""
	_planner(role)
	_lock(project_id)
	ids = set(_ids(plan_ids))
	day = _date(date, "From date")
	end = _date(to_date, "To date")
	if end < day:
		_throw('"To" date is before "From" date.')
	data = _load(project_id)
	for p in data["plans"]:
		if p["id"] in ids:
			if p.get("status") == "submitted":
				_throw("A submitted plan cannot be changed.")
			p["date"], p["to"] = day, end
	return _save(project_id, data)


@frappe.whitelist(methods=["POST"])
def submit_plans(project_id, plan_ids, role):
	"""Draft plans become final: plan vs actual is counted on them from now on."""
	_planner(role)
	_lock(project_id)
	ids = set(_ids(plan_ids))
	data = _load(project_id)
	now = now_datetime().isoformat()
	for p in data["plans"]:
		if p["id"] in ids and p.get("status") != "submitted":
			p["status"] = "submitted"
			p["submittedAt"] = now
			p["submittedBy"] = frappe.session.user
	return _save(project_id, data)


@frappe.whitelist(methods=["POST"])
def set_no_work(project_id, plan_ids, reason, role):
	"""Planned work that did not happen: the reason is required. Empty reason on an existing No work clears it."""
	_planner(role)
	_lock(project_id)
	ids = set(_ids(plan_ids))
	reason = (reason or "").strip()
	if len(reason) > 300:
		_throw("The reason must be 300 characters or fewer.")
	data = _load(project_id)
	now = now_datetime().isoformat()
	for p in data["plans"]:
		if p["id"] in ids:
			if reason:
				p["noWork"] = {"reason": reason, "by": frappe.session.user, "at": now}
			else:
				p.pop("noWork", None)
	return _save(project_id, data)


@frappe.whitelist(methods=["POST"])
def mark_started(project_id, element_ids, activity_code, date, role):
	"""The date an activity was started on elements (one start per element and activity; a new date replaces it)."""
	_planner(role)
	_lock(project_id)
	_, _, document = _active_context(project_id)
	day = _date(date, "Start date")
	if day > nowdate():
		_throw("The start date cannot be in the future.")
	activity = _find_activity(document, activity_code)
	ids = _ids(element_ids)
	for i in ids:
		_find_element(document, i)
	data = _load(project_id)
	now = now_datetime().isoformat()
	keep = [s for s in data["starts"] if not (s["activityCode"] == activity["code"] and s["elementId"] in ids)]
	keep += [{"elementId": i, "activityCode": activity["code"], "date": day, "by": frappe.session.user, "at": now} for i in ids]
	data["starts"] = keep
	return _save(project_id, data)


@frappe.whitelist(methods=["POST"])
def clear_started(project_id, element_ids, activity_code, role):
	_planner(role)
	_lock(project_id)
	ids = set(_ids(element_ids))
	data = _load(project_id)
	data["starts"] = [s for s in data["starts"] if not (s["activityCode"] == activity_code and s["elementId"] in ids)]
	return _save(project_id, data)
