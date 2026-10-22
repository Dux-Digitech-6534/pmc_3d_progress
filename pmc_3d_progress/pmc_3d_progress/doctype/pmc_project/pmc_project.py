# Copyright (c) 2026, Dux Digitech and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class PMCProject(Document):
	# Records are created and changed through pmc_3d_progress.api, which applies the PMC rules
	# (validation, workflow, model revisions).
	pass
