"""Read a construction drawing with Claude on the server ("Read drawing with AI" in Model Builder).

The Anthropic API key lives in PMC Settings and never reaches a browser. A reading takes
1-3 minutes, longer than a web request may run, so it runs as a background job:
start_reading() queues it and returns an id, the page polls get_reading(id) every few seconds.

The answer must match ai_schema.json (exported from frontend/src/ai/drawingSchema.ts by
frontend/tests/aiSchema.test.ts); the page turns it into the Model Builder form.
"""

import base64
import io
import json
import pathlib
import time

import frappe

from pmc_3d_progress.api import _parse, _require_modeller, _throw

DEFAULT_MODEL = "claude-opus-5-5"
MAX_REQUEST_BYTES = 30 * 1024 * 1024  # API request limit is 32 MB; keep headroom
MAX_IMAGE_EDGE = 2400  # px — enough to read dimension text; bigger images are scaled down
MAX_IMAGE_BYTES = int(3.5 * 1024 * 1024)
RESULT_TTL = 3600
SCHEMA = json.loads(pathlib.Path(__file__).with_name("ai_schema.json").read_text(encoding="utf-8"))

SYSTEM = """You read construction drawings (plans, sections, elevations, schedules) and extract the data needed to build a simple 3D structural model of the building, including its walls, doors and windows.

Coordinate and naming conventions you must follow, whatever labels the drawing uses:
- Grid lines: X1, X2, … are the vertical column lines on the plan from LEFT to RIGHT. Y1, Y2, … are the horizontal column lines from the BOTTOM edge of the plan (the front / entrance side) to the TOP. If the drawing has its own grid labels (A, B, C / 1, 2, 3), map them to this convention and say so in assumptions.
- Spacings are centre-to-centre of columns, in millimetres. If the drawing only gives clear inside dimensions (e.g. "3000 x 3000" with 230 mm walls), add the wall / column thickness to get centre-to-centre, and record that in assumptions.
- A grid point is written like "X1Y1". List every column position.
- Levels are measured from ground / plinth level (0). foundationDepthMm is how far the footing bottom is below it; roofLevelMm is the top of the roof beams (bottom of the roof slab) above it.
- Walls run along grid lines between columns. Each door / window / ventilator sits in one wall: give the two grid points at the ends of that wall and the distance from the first one to the opening centre (null when centred).
- Use the drawing's own marks for openings (D, D1, W, V …) and the sizes from its door / window schedule. Doors have sill 0.

Only use values you can read or reasonably derive from the drawing. When something is not shown (for example footing depth, beam depth or roof level), use a typical value for a small single-storey RCC building and list it in assumptions, so an engineer can check it. Set confidence to "low" if the drawing is unclear or not a building drawing."""

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
	s = frappe.get_single("PMC Settings")
	return (
		s.get_password("anthropic_api_key", raise_exception=False),
		(s.ai_model or DEFAULT_MODEL).strip(),
		s.ai_effort or "high",
	)


@frappe.whitelist(methods=["POST"])
def start_reading(drawing_ids):
	"""Queue a reading of these PMC Drawing records; returns {readingId}."""
	_require_modeller()
	ids = _parse(drawing_ids) or []
	if not ids:
		_throw("Upload the drawing first — then the AI can read it.")
	for name in ids:
		if not frappe.db.exists("PMC Drawing", name):
			_throw("A drawing is no longer on the server. Upload it again.")
	key, _model, _effort = _settings()
	if not key:
		_throw(
			"AI reading is not set up on this server. An administrator enters the Anthropic API key in PMC Settings."
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
	)
	return {"readingId": reading_id}


@frappe.whitelist()
def get_reading(reading_id):
	"""{status: queued|running|done|error, reading?, error?, model?, inputTokens?, outputTokens?, seconds?}"""
	state = _cache().get_value(_key(reading_id))
	if not state or state.get("user") != frappe.session.user:
		_throw("This AI reading was not found or has expired. Start it again.", frappe.DoesNotExistError)
	return {k: v for k, v in state.items() if k != "user"}


def _content_blocks(drawing_ids):
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
	blocks.append({"type": "text", "text": USER_TEXT})
	return blocks


def _error_message(e):
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


def run_reading(reading_id, drawing_ids, user):
	"""Background job: read the drawings and store the result for get_reading()."""
	import anthropic

	started = time.time()
	cache = _cache()
	cache.set_value(_key(reading_id), {"status": "running", "user": user}, expires_in_sec=RESULT_TTL)
	try:
		key, model, effort = _settings()
		content = _content_blocks(drawing_ids)
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
