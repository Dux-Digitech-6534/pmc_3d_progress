app_name = "pmc_3d_progress"
app_title = "PMC 3D Progress"
app_publisher = "Dux Digitech"
app_description = "Construction progress monitoring on an interactive 3D building model"
app_email = "support@duxdigitech.in"
app_license = "mit"
required_apps = ["frappe"]

# The UI is a full-screen web page (/pmc-3d) built from frontend/ — see README "Frappe app".
add_to_apps_screen = [
	{
		"name": "pmc_3d_progress",
		"logo": "/assets/frappe/images/frappe-framework-logo.svg",
		"title": "PMC 3D Progress",
		"route": "/pmc-3d",
	}
]

# Roles used by the app (created if missing).
after_install = "pmc_3d_progress.install.after_install"
after_migrate = "pmc_3d_progress.install.after_migrate"
