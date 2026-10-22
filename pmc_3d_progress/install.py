import frappe

# Site Engineer records work, PMC Reviewer approves / returns it, Owner views approved progress.
PMC_ROLES = ("PMC Site Engineer", "PMC Reviewer", "PMC Owner")


def ensure_roles():
	for role in PMC_ROLES:
		if not frappe.db.exists("Role", role):
			frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1}).insert(ignore_permissions=True)


def after_install():
	ensure_roles()


def after_migrate():
	ensure_roles()
