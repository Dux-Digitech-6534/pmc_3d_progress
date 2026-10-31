"""Unit tests for the server-side PMC rules. Plain unittest, no Frappe needed:

    python3 -m unittest discover -s pmc_3d_progress/tests -t .
"""

import json
import pathlib
import unittest

from pmc_3d_progress import domain as d

SAMPLES = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src" / "data" / "samples"
CONC = {"code": "CONC", "name": "Concreting", "unit": "m3", "appliesTo": None}
BRICK = {"code": "BRICK", "name": "Brickwork", "unit": "m3", "appliesTo": ["wall"]}
C01 = {"id": "C-01", "code": "C-01", "type": "column", "plannedQuantities": {"CONC": {"quantity": 0.19, "unit": "m3"}}}


def entry(**kw):
	base = {"id": "E1", "elementId": "C-01", "activityCode": "CONC", "unit": "m3", "status": "Approved", "quantity": 0.1, "date": "2026-10-20"}
	base.update(kw)
	return base


def sample(name):
	return json.loads((SAMPLES / name).read_text(encoding="utf-8"))


class ModelValidation(unittest.TestCase):
	def test_bundled_samples_are_valid(self):
		for name in ("security-cabin-a.json", "security-cabin-b.json"):
			res = d.validate_model_document(sample(name))
			self.assertTrue(res["ok"], res["errors"])

	def test_same_messages_as_the_frontend_for_a_broken_file(self):
		doc = sample("security-cabin-a.json")
		doc["model"]["revision"] = "R99-INVALID"
		doc["elements"][1]["id"] = doc["elements"][0]["id"]
		doc["elements"][2]["type"] = "staircase"
		doc["elements"][3]["geometry"]["size"] = [1.2, -0.4, 1.2]
		doc["elements"][4]["plannedQuantities"]["CONC"]["unit"] = "kg"
		del doc["elements"][5]["levelId"]
		errors = d.validate_model_document(doc)["errors"]
		self.assertEqual(
			errors,
			[
				'Element "SCA-F001": duplicate stable element id — every element id must be unique within the model.',
				'Element "SCA-F003": unsupported type "staircase". Supported: footing, column, beam, slab, wall, lintel, chhajja, door, window.',
				'Element "SCA-F004": geometry.size values must be greater than 0 and at most 500 m (found [1.2,-0.4,1.2]).',
				'Element "SCA-C001": planned Concreting unit is "kg" but the activity is measured in "m3".',
				'Element "SCA-C002": "levelId" is missing or unknown.',
			],
		)

	def test_not_json_and_not_an_object(self):
		self.assertIn("not valid JSON", d.parse_and_validate_model("{oops")["errors"][0])
		self.assertEqual(d.validate_model_document([])["errors"], ["The model file must contain a JSON object at the top level."])

	def test_wall_openings(self):
		doc = sample("security-cabin-a.json")
		wall = {
			"id": "W1", "code": "W1", "type": "wall", "buildingId": "BLD-SCA", "levelId": "GF",
			"geometry": {"shape": "wall", "position": [0, 1.35, 1.5], "size": [2.77, 2.7, 0.23],
				"openings": [{"center": 0, "bottom": 0, "width": 0.9, "height": 2.1}, {"center": 0.2, "bottom": 0.9, "width": 1, "height": 1}]},
			"plannedQuantities": {},
		}
		doc["elements"].append(wall)
		errors = d.validate_model_document(doc)["errors"]
		self.assertEqual(errors, ['Element "W1": opening 2 overlaps another opening.'])


	def test_bbs_steel_by_dia_and_grade(self):
		doc = sample("security-cabin-a.json")
		col = next(e for e in doc["elements"] if e["type"] == "column")
		kg = col["plannedQuantities"]["REINF"]["quantity"]
		col["steelByDia"] = {"8": kg * 0.25, "16": kg * 0.75}
		col["concreteGrade"] = "M25"
		v = d.validate_model_document(doc)
		self.assertEqual(v["errors"], [])
		self.assertFalse(any("steelByDia" in w for w in v["warnings"]))

		col["steelByDia"] = {"8": 1, "12": 2}
		v = d.validate_model_document(doc)
		self.assertTrue(v["ok"])
		self.assertTrue(any("steelByDia adds up to 3 kg" in w for w in v["warnings"]))

		col["steelByDia"] = {"5": 2, "12": -1, "abc": 3}
		col["concreteGrade"] = ""
		errs = "\n".join(d.validate_model_document(doc)["errors"])
		self.assertIn('bar diameter "5"', errs)
		self.assertIn('bar diameter "abc"', errs)
		self.assertIn('steelByDia["12"] must be a number of kg', errs)
		self.assertIn("concreteGrade", errs)


class Quantities(unittest.TestCase):
	def test_over_plan_message_matches_frontend(self):
		errs = d.check_quantity(C01, CONC, 5, "m3", [], "claim")
		self.assertEqual(
			errs,
			[
				"5 m3 exceeds the remaining quantity for C-01 Concreting (planned 0.19 m3, approved 0; available 0.19 m3). "
				"If the plan is wrong, revise the model quantities instead of over-reporting."
			],
		)

	def test_claim_counts_submitted_approve_does_not(self):
		entries = [entry(id="A", status="Approved", quantity=0.1), entry(id="S", status="Submitted", quantity=0.05), entry(id="D", status="Draft", quantity=0.05)]
		self.assertIn("awaiting review 0.05", d.check_quantity(C01, CONC, 0.05, "m3", entries, "claim")[0])
		self.assertEqual(d.check_quantity(C01, CONC, 0.04, "m3", entries, "claim"), [])
		# approving the submitted 0.05 itself: approved 0.1 + 0.05 <= 0.19
		self.assertEqual(d.check_quantity(C01, CONC, 0.05, "m3", entries, "approve", exclude_entry_id="S"), [])

	def test_invalid_quantities_and_units(self):
		self.assertEqual(d.check_quantity(C01, CONC, -1, "m3", [], "claim")[0], "Completed quantity cannot be negative.")
		self.assertEqual(d.check_quantity(C01, CONC, 0, "m3", [], "claim")[0], "Completed quantity must be greater than zero.")
		self.assertEqual(d.check_quantity(C01, CONC, 0.0001, "m3", [], "claim")[0], "Use at most 3 decimals.")
		self.assertIn("Unit mismatch", d.check_quantity(C01, CONC, 0.1, "kg", [], "claim")[0])
		self.assertEqual(d.check_quantity(C01, CONC, "x", "m3", [], "claim"), ["Completed quantity must be a number."])

	def test_not_configured_and_not_applicable(self):
		no_plan = dict(C01, plannedQuantities={})
		self.assertIn("is not configured", d.check_quantity(no_plan, CONC, 0.1, "m3", [], "claim")[0])
		self.assertEqual(d.check_quantity(C01, BRICK, 0.1, "m3", [], "claim"), ["Brickwork does not apply to C-01 (column)."])

	def test_duplicates_and_dates(self):
		entries = [entry(id="X", status="Submitted", quantity=0.1)]
		self.assertEqual(d.find_possible_duplicate(entries, "C-01", "CONC", "2026-10-20", 0.1)["id"], "X")
		self.assertIsNone(d.find_possible_duplicate(entries, "C-01", "CONC", "2026-10-20", 0.1, exclude_id="X"))
		self.assertIsNone(d.find_possible_duplicate([entry(status="Returned")], "C-01", "CONC", "2026-10-20", 0.1))
		self.assertEqual(d.validate_date("2026-10-23", "2026-10-22"), ["Date cannot be in the future."])
		self.assertEqual(d.validate_date("2026-02-30", "2026-10-22"), ["Enter a valid date."])
		self.assertEqual(d.validate_date("2026-10-22", "2026-10-22"), [])

	def test_roles(self):
		self.assertTrue(d.can_create("site-engineer"))
		self.assertFalse(d.can_create("owner"))
		self.assertTrue(d.can_edit("site-engineer", "Returned"))
		self.assertFalse(d.can_edit("site-engineer", "Approved"))
		self.assertTrue(d.can_review("pmc-reviewer", "Submitted"))
		self.assertFalse(d.can_review("site-engineer", "Submitted"))


class Allocation(unittest.TestCase):
	def test_total_is_allocated_never_multiplied(self):
		ids = ["F1", "F2", "F3"]
		ok = d.resolve_batch_quantities("total", 0.3, ids, {"F1": 0.1, "F2": 0.1, "F3": 0.1})
		self.assertTrue(ok["ok"])
		self.assertEqual(d.sum_qty(ok["quantities"].values()), 0.3)
		bad = d.resolve_batch_quantities("total", 0.3, ids, {"F1": 0.3, "F2": 0.3, "F3": 0.3})
		self.assertEqual(bad["errors"], ["Allocated 0.9 does not match the entered total 0.3 (difference -0.6)."])
		self.assertFalse(d.resolve_batch_quantities("total", 0.3, ids)["ok"])

	def test_per_element_and_bad_input(self):
		self.assertEqual(d.resolve_batch_quantities("per-element", 2, ["A", "B"])["quantities"], {"A": 2, "B": 2})
		self.assertFalse(d.resolve_batch_quantities("per-element", -1, ["A"])["ok"])
		self.assertFalse(d.resolve_batch_quantities("per-element", 1, ["A", "A"])["ok"])
		self.assertEqual(d.resolve_batch_quantities("total", 2, ["A", "B"], {"A": 2})["errors"], ["No allocation entered for: B."])

	def test_rounding_matches_frontend(self):
		self.assertEqual(d.round_qty(0.1 + 0.2), 0.3)
		self.assertEqual(d.round_qty(2.3045), 2.305)
		self.assertEqual(d.js_num(5.0), "5")
		self.assertEqual(d.js_num(0.19), "0.19")


if __name__ == "__main__":
	unittest.main()
