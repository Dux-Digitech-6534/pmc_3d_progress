import frappe
from frappe.sessions import get_csrf_token

no_cache = 1


def get_context(context):
	"""Full-screen PMC 3D Progress page. Login is required; data access is checked again by the API."""
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/pmc-3d"
		raise frappe.Redirect
	context.csrf_token = get_csrf_token()
	frappe.db.commit()  # get_csrf_token may have created the session's token
	return context
