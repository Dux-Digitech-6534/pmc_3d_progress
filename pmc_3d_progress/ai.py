"""Read a construction drawing with AI on the server ("Read drawing with AI" in Model Builder).

PMC Settings chooses the provider — Google Gemini (has a free tier, used for testing) or Anthropic
Claude — and holds its API key, which never reaches a browser. A reading takes
1-3 minutes, longer than a web request may run, so it runs as a background job:
start_reading() queues it and returns an id, the page polls get_reading(id) every few seconds.

The answer must match ai_schema.json for Claude / gemini_schema.json for Gemini (same shape, the
Gemini one with every sub-schema inlined), both exported from frontend/src/ai/drawingSchema.ts by
frontend/tests/aiSchema.test.ts; the page turns it into the Model Builder form.
"""

import base64
import io
import json
import pathlib
import time

import frappe

from pmc_3d_progress.api import _parse, _require_modeller, _throw

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
GEMINI = "Google Gemini"
MAX_REQUEST_BYTES = 30 * 1024 * 1024  # API request limit is 32 MB; keep headroom
MAX_GEMINI_REQUEST_BYTES = 19 * 1024 * 1024  # Gemini inline data limit is 20 MB per request
RETRY_SECONDS = (10, 30)
MAX_IMAGE_EDGE = 2400  # px — enough to read dimension text; bigger images are scaled down
MAX_IMAGE_BYTES = int(3.5 * 1024 * 1024)
RESULT_TTL = 3600
SCHEMA = json.loads(pathlib.Path(__file__).with_name("ai_schema.json").read_text(encoding="utf-8"))
GEMINI_SCHEMA = json.loads(pathlib.Path(__file__).with_name("gemini_schema.json").read_text(encoding="utf-8"))

SYSTEM = """You read construction drawings (plans, sections, elevations, schedules, structural details) and extract the data needed to build a simple 3D structural model with planned quantities.

First decide structureKind — what the drawing is for:
- "building": rooms such as a cabin, office, house or block with a roof slab. List EVERY room / space in "rooms" and EVERY door and window in "roomOpenings" — the walls, columns, beams and slab are worked out from the rooms, so the rooms must reproduce the plan exactly: each room is a rectangle (split an L-shaped space into rectangles), rooms that share a wall use the same line, and together they cover the whole floor plan (passages, toilets, stairs and verandas too). Name the staircase room "Stair" on every floor it is drawn on (a dog-legged stair is built in it up to the next floor or the roof). Give every space its kind: "room" for anything with walls all round (bedroom, kitchen, toilet, store, lobby, passage, stair); "open" for a space under the roof without walls of its own (parking, porch, verandah, open hall, sit-out); "balcony" for a projecting balcony on an upper floor; "terrace" for an open-to-sky area on an upper floor (nothing is built there). Also fill the column / footing schedules, levels, wall thickness, door / window sizes and lintel / chhajja as for any building; the grid fields may be minimal.
- "boundary-wall": a compound / boundary wall — piers (pillars) at regular spacing on a line or around a plot, with footings, a plinth beam, wall panels and a top / coping beam, and no roof. xSpansMm are the pier spacings along the wall; ySpansMm is [] for a straight wall, or the pier spacings along the other side when the wall goes around a plot. columns may be empty (every pier position is then filled with the first column type). roofLevelMm is the top of the wall (top of the coping beam) above ground and roofBeam is the coping / top beam; slab.present is false. When only a typical panel is drawn and the total length is not shown, repeat the typical spacing 10 times and say so in assumptions. Gates go in openings.
- "other": anything else (water tank, culvert, staircase, retaining wall …). Then list every element in "elements" as a box; the grid fields may be minimal.
If the drawing shows several structures (e.g. a boundary wall and a security cabin), model the one the engineer asked for; if they did not say, the main one in the title, and name the others in assumptions.

Coordinate and naming conventions you must follow, whatever labels the drawing uses:
- Grid lines: X1, X2, … are the vertical column lines on the plan from LEFT to RIGHT. Y1, Y2, … are the horizontal column lines from the BOTTOM edge of the plan (the front / entrance side) to the TOP. If the drawing has its own grid labels (A, B, C / 1, 2, 3), map them to this convention and say so in assumptions.
- Spacings are centre-to-centre of columns, in millimetres. If the drawing only gives clear inside dimensions (e.g. "3000 x 3000" with 230 mm walls), add the wall / column thickness to get centre-to-centre, and record that in assumptions.
- A grid point is written like "X1Y1". List every column position (a boundary wall may leave the list empty).
- Levels are measured from ground / plinth level (0). foundationDepthMm is how far the footing bottom is below it; roofLevelMm is the top of the roof beams (bottom of the roof slab) above it.
- Walls run along grid lines between columns. Each door / window / ventilator sits in one wall: give the two grid points at the ends of that wall and the distance from the first one to the opening centre (null when centred).
- Use the drawing's own marks for openings (D, D1, W, V …) and the sizes from its door / window schedule. Doors have sill 0.
- rooms (for "building"): x / y = the room's front-left corner, measured from the front-left (bottom-left) corner of the building, width along X (left to right), depth along Y (front to back), all in mm, measured on the wall centre lines. The front (y = 0) is the side towards the road / the main entrance, normally the bottom of the sheet. Read the overall dimensions and each room's size ("12 x 18 ft" = width 12 ft along X, depth 18 ft along Y unless the layout clearly shows it the other way). Feet and inches: 12'-6" = 12.5 ft = 3810 mm; 1 ft = 304.8 mm, 1 in = 25.4 mm. Room sizes written inside rooms are usually clear (inside) sizes: add one wall thickness to each (half a wall on every side) so neighbouring rooms meet on the shared wall centre line, and say so in assumptions.
- Check before answering, floor by floor: the rooms tile the outline with no overlaps and no gaps (a gap means a missing passage, lobby or open space); the room widths along each row add up to the overall width and the depths along each column to the overall depth (outside size minus one wall thickness, on centre lines); every door sits on a wall shared by the two spaces it connects or on an outside wall. Fix the rooms until these hold.
- roomOpenings (for "building"): every door and window with its centre on the wall line it sits in (same origin as the rooms), its width, height and sill (doors 0), and "between" = the two spaces it joins, using their names from rooms exactly, or "outside" for an outside wall (e.g. ["Drawing room", "Porch"], ["Bed room", "outside"]). The opening is built in the wall those two spaces share, so get "between" right: look at which wall the door's arc is hinged in or the window's thin lines cross — a room's door facing a porch is in the wall between the room and the porch, not in its front wall. Doors drawn as an arc: the opening is the straight side of the arc. The main entry is usually marked with an arrow. List only the openings drawn on the plan, each once — never add one that is not drawn; a mark like D/V or D2/V is one door (with a ventilator above it). Use the door / window schedule when there is one; otherwise typical sizes: main door 1000 × 2100, doors 900 × 2100, toilet doors 750 × 2100, windows 1200 × 1200 with sill 900, ventilators (V) 600 × 450 with sill 1800 — and list them in assumptions. A wide opening with no shutter (e.g. into parking) is not a door.
- Storeys: count them from the sections and elevations (G+1 = ground + one floor). "rooms" and "roomOpenings" above are the GROUND floor only. upperFloors (for "building"): one entry per floor above the ground floor, bottom to top, read from that floor's own plan (FIRST FLOOR PLAN, SECOND FLOOR PLAN …): its rooms and roomOpenings with the SAME origin as the ground floor (line the plans up on a common outer corner), and floorToFloorMm = from the roof level of the floor below to this floor's roof level (from the section, e.g. 3.05 m = 3050). A projecting balcony is kind "balcony" with its own rectangle (it may lie outside the floor below); an open terrace is kind "terrace". Empty for a single-storey building.
- mumty: present when the stair continues up to the roof with a stair cabin (often drawn as "MUMTY" / "STAIR HEAD ROOM" / a terrace or parapet floor plan with only the stair); heightMm from the section (often 2400–2700).
- parapet: present when the section or elevation shows a parapet wall on a roof or terrace, with its height (often 900–1000 mm) and thickness (often 115 mm).
- elements (only for "other"; empty otherwise): one box per footing, column, beam, slab, wall, lintel, chhajja, door or window, all in mm — xMm / yMm = centre on the plan from the left / front edge, bottomMm = level of its underside (0 = ground, negative below ground), lengthMm along X, widthMm along Y, heightMm. Use the drawing's marks as codes (F1, C1, B1 …), each code once (C1-1, C1-2 … for repeats).

Only use values you can read or reasonably derive from the drawing. When something is not shown (for example footing size, beam depth or roof level), use a typical value for a small RCC structure and list it in assumptions, so an engineer can check it. Set confidence to "low" if the drawing is unclear or not a construction drawing."""

USER_TEXT = (
	"Read the attached drawing(s) and return the structured data for the 3D model. "
	"Look at every view — plan, section, elevation, schedules and notes — before answering."
)


def _cache():
	c = frappe.cache
	return c if hasattr(c, "set_value") else c()


def _key(reading_id):
	return f"pmc3d:ai-reading:{reading_id}"


def _settings():
	"""(provider, key, model, effort) of the provider chosen in PMC Settings; key is None if not set."""
	s = frappe.get_single("PMC Settings")
	if (s.ai_provider or GEMINI) == GEMINI:
		return GEMINI, s.get_password("gemini_api_key", raise_exception=False), (s.gemini_model or DEFAULT_GEMINI_MODEL).strip(), None
	return (
		"Anthropic Claude",
		s.get_password("anthropic_api_key", raise_exception=False),
		(s.ai_model or DEFAULT_MODEL).strip(),
		s.ai_effort or "high",
	)


def is_configured():
	return bool(_settings()[1])


@frappe.whitelist(methods=["POST"])
def start_reading(drawing_ids, hint=None):
	"""Queue a reading of these PMC Drawing records; returns {readingId}. hint: what the engineer wants modelled."""
	_require_modeller()
	ids = _parse(drawing_ids) or []
	if not ids:
		_throw("Upload the drawing first — then the AI can read it.")
	for name in ids:
		if not frappe.db.exists("PMC Drawing", name):
			_throw("A drawing is no longer on the server. Upload it again.")
	provider, key, _model, _effort = _settings()
	if not key:
		_throw(
			f"AI reading is not set up on this server. An administrator enters the {provider} API key in PMC Settings."
		)
	reading_id = frappe.generate_hash(length=16)
	_cache().set_value(_key(reading_id), {"status": "queued", "user": frappe.session.user}, expires_in_sec=RESULT_TTL)
	frappe.enqueue(
		"pmc_3d_progress.ai.run_reading",
		queue="long",
		timeout=900,
		enqueue_after_commit=True,
		reading_id=reading_id,
		drawing_ids=ids,
		user=frappe.session.user,
		hint=(hint or "").strip()[:300] or None,
	)
	return {"readingId": reading_id}


@frappe.whitelist()
def get_reading(reading_id):
	"""{status: queued|running|done|error, reading?, error?, model?, inputTokens?, outputTokens?, seconds?}"""
	state = _cache().get_value(_key(reading_id))
	if not state or state.get("user") != frappe.session.user:
		_throw("This AI reading was not found or has expired. Start it again.", frappe.DoesNotExistError)
	return {k: v for k, v in state.items() if k != "user"}


def _user_text(hint):
	return f"{USER_TEXT}\nThe engineer wants this modelled: {hint}" if hint else USER_TEXT


def _content_blocks(drawing_ids, hint=None):
	from PIL import Image  # Pillow ships with Frappe

	blocks = []
	total = 0
	for name in drawing_ids:
		d = frappe.get_doc("PMC Drawing", name)
		data = frappe.get_doc("File", {"file_url": d.file}).get_content()
		if isinstance(data, str):
			data = data.encode()
		if d.kind == "pdf":
			b64 = base64.standard_b64encode(data).decode()
			blocks.append(
				{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}, "title": d.file_name}
			)
		else:
			img = Image.open(io.BytesIO(data))
			media = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}.get(img.format)
			if media and max(img.size) <= MAX_IMAGE_EDGE and len(data) <= MAX_IMAGE_BYTES:
				out = data
			else:
				img = img.convert("RGB")
				img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
				buf = io.BytesIO()
				img.save(buf, format="JPEG", quality=90)
				out, media = buf.getvalue(), "image/jpeg"
			b64 = base64.standard_b64encode(out).decode()
			blocks.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}})
		total += len(b64)
	if total > MAX_REQUEST_BYTES:
		raise ValueError(
			f"The drawings are too large to send together ({total / 1024 / 1024:.1f} MB after encoding, limit about 30 MB). "
			"Remove some drawings or upload smaller files."
		)
	blocks.append({"type": "text", "text": _user_text(hint)})
	return blocks


class GeminiError(Exception):
	"""A failed Gemini call, already in plain words for the engineer."""


def _gemini_parts(blocks):
	"""Claude content blocks → Gemini parts (same drawings, same prompt)."""
	parts = []
	for b in blocks:
		if b["type"] == "text":
			parts.append({"text": b["text"]})
		else:
			if b["type"] == "document":
				parts.append({"text": f"Drawing: {b['title']}"})
			parts.append({"inline_data": {"mime_type": b["source"]["media_type"], "data": b["source"]["data"]}})
	size = sum(len(p["inline_data"]["data"]) for p in parts if "inline_data" in p)
	if size > MAX_GEMINI_REQUEST_BYTES:
		raise GeminiError(
			f"The drawings are too large to send together ({size / 1024 / 1024:.1f} MB after encoding, Gemini limit about 20 MB). "
			"Remove some drawings or upload smaller files."
		)
	return parts


def _gemini_http_message(status, api_message):
	if status == 400 and "api key" in api_message.lower():
		return "The Gemini API key in PMC Settings was rejected. Check that it is a valid key from aistudio.google.com."
	if status in (401, 403):
		return "The Gemini API key in PMC Settings was rejected or may not use this model. Create a new key at aistudio.google.com."
	if status == 404:
		return f"The Gemini model in PMC Settings is not available for this key: {api_message}"
	if status == 429:
		return "The free Gemini limit is used up for now (too many requests or tokens). Wait a minute — or until tomorrow for the daily limit — and try again."
	if status >= 500:
		return "The Gemini service had a temporary problem. Try again in a moment."
	return f"Gemini request failed ({status}): {api_message}"


def _read_with_gemini(key, model, blocks):
	"""Returns (reading, model, input_tokens, output_tokens)."""
	import requests

	payload = {
		"system_instruction": {"parts": [{"text": SYSTEM}]},
		"contents": [{"role": "user", "parts": _gemini_parts(blocks)}],
		"generationConfig": {
			"responseMimeType": "application/json",
			"responseJsonSchema": GEMINI_SCHEMA,
			"maxOutputTokens": 32000,
		},
	}
	# Busy / rate-limited answers (429, 500, 503) are usually over in seconds: try up to 3 times.
	for attempt in range(3):
		if attempt:
			time.sleep(RETRY_SECONDS[attempt - 1])
		try:
			res = requests.post(
				f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
				headers={"Content-Type": "application/json", "x-goog-api-key": key},
				json=payload,
				timeout=600,
			)
		except requests.Timeout:
			raise GeminiError("The AI took too long to answer. Try again, or upload a smaller / clearer drawing.")
		except requests.RequestException:
			raise GeminiError("The server could not reach generativelanguage.googleapis.com. Check the server's internet access.")
		if res.status_code not in (429, 500, 503):
			break
	try:
		body = res.json()
	except ValueError:
		body = {}
	if not res.ok:
		raise GeminiError(_gemini_http_message(res.status_code, (body.get("error") or {}).get("message") or res.reason))
	block = (body.get("promptFeedback") or {}).get("blockReason")
	if block:
		raise GeminiError(f"Gemini declined to read this drawing ({block}).")
	cand = (body.get("candidates") or [{}])[0]
	finish = cand.get("finishReason")
	if finish == "MAX_TOKENS":
		raise GeminiError("The drawing has more detail than one reading can return. Try uploading one sheet at a time.")
	if finish and finish != "STOP":
		raise GeminiError(f"Gemini stopped without an answer ({finish}). Try again.")
	text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
	try:
		reading = json.loads(text)
	except ValueError:
		raise GeminiError("The Gemini answer could not be read as model data. Try again.")
	if not isinstance(reading, dict) or any(k not in reading for k in GEMINI_SCHEMA["required"]):
		raise GeminiError("The Gemini answer did not have all the model data. Try again.")
	usage = body.get("usageMetadata") or {}
	return (
		reading,
		body.get("modelVersion") or model,
		usage.get("promptTokenCount", 0),
		usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0),
	)


def _error_message(e):
	if isinstance(e, (GeminiError, ValueError)):
		return str(e)
	import anthropic

	if isinstance(e, anthropic.AuthenticationError):
		return "The API key in PMC Settings was rejected. Check that it is a valid Anthropic API key."
	if isinstance(e, anthropic.PermissionDeniedError):
		return "The API key in PMC Settings is not allowed to use this model. Check its workspace and permissions."
	if isinstance(e, anthropic.RateLimitError):
		return "Too many requests or not enough API credit right now. Wait a minute and try again."
	if isinstance(e, anthropic.BadRequestError):
		return f"The request was not accepted: {e.message}"
	if isinstance(e, anthropic.APITimeoutError):
		return "The AI took too long to answer. Try again, or upload a smaller / clearer drawing."
	if isinstance(e, anthropic.APIConnectionError):
		return "The server could not reach api.anthropic.com. Check the server's internet access."
	if isinstance(e, anthropic.APIStatusError):
		return f"AI request failed ({e.status_code}): {e.message}"
	return str(e)


def run_reading(reading_id, drawing_ids, user, hint=None):
	"""Background job: read the drawings and store the result for get_reading()."""
	started = time.time()
	cache = _cache()
	cache.set_value(_key(reading_id), {"status": "running", "user": user}, expires_in_sec=RESULT_TTL)
	try:
		provider, key, model, effort = _settings()
		content = _content_blocks(drawing_ids, hint)
		if provider == GEMINI:
			reading, used_model, tokens_in, tokens_out = _read_with_gemini(key, model, content)
			state = {
				"status": "done",
				"user": user,
				"reading": reading,
				"model": used_model,
				"inputTokens": tokens_in,
				"outputTokens": tokens_out,
				"seconds": round(time.time() - started),
			}
			cache.set_value(_key(reading_id), state, expires_in_sec=RESULT_TTL)
			return
		import anthropic

		client = anthropic.Anthropic(api_key=key, max_retries=2, timeout=600)
		response = client.beta.messages.create(
			model=model,
			max_tokens=16000,
			system=SYSTEM,
			messages=[{"role": "user", "content": content}],
			output_config={"effort": effort, "format": {"type": "json_schema", "schema": SCHEMA}},
			# On a safety decline the API retries the request on Anthropic's recommended fallback model.
			betas=["server-side-fallback-2026-07-01"],
			fallbacks="default",
		)
		if response.stop_reason == "refusal":
			explanation = getattr(response.stop_details, "explanation", None) if response.stop_details else None
			raise ValueError(f"The AI declined to read this drawing{': ' + explanation if explanation else '.'}")
		if response.stop_reason == "max_tokens":
			raise ValueError("The drawing has more detail than one reading can return. Try uploading one sheet at a time.")
		text = next((b.text for b in response.content if b.type == "text"), None)
		if not text:
			raise ValueError("The AI answer could not be read as model data. Try again.")
		state = {
			"status": "done",
			"user": user,
			"reading": json.loads(text),
			"model": response.model,
			"inputTokens": response.usage.input_tokens,
			"outputTokens": response.usage.output_tokens,
			"seconds": round(time.time() - started),
		}
	except Exception as e:
		frappe.log_error(title="PMC 3D Progress: AI drawing reading failed")
		state = {"status": "error", "user": user, "error": _error_message(e)}
	cache.set_value(_key(reading_id), state, expires_in_sec=RESULT_TTL)
