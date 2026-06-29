import json
import statistics
import sys
from pathlib import Path


def normalize_text(value):
    return " ".join(str(value or "").split()).strip()


def has_cjk(text):
    return any("\u4e00" <= char <= "\u9fff" for char in text)


def cjk_chars(text):
    return [char for char in text if "\u4e00" <= char <= "\u9fff"]


def flatten_text(value):
    texts = []
    if isinstance(value, str):
        text = normalize_text(value)
        if text:
            texts.append(text)
    elif isinstance(value, dict):
        for key in ("rec_text", "text", "transcription"):
            text = normalize_text(value.get(key))
            if text:
                texts.append(text)
        for key in ("rec_texts", "texts"):
            entries = value.get(key)
            if isinstance(entries, list):
                texts.extend(flatten_text(entries))
        for nested in value.values():
            if isinstance(nested, (list, tuple, dict)):
                texts.extend(flatten_text(nested))
    elif isinstance(value, (list, tuple)):
        if len(value) >= 2 and isinstance(value[1], (list, tuple)) and value[1] and isinstance(value[1][0], str):
            text = normalize_text(value[1][0])
            if text:
                texts.append(text)
        else:
            for entry in value:
                texts.extend(flatten_text(entry))
    return texts


def to_plain_result(value):
    if isinstance(value, dict):
        return value
    json_value = getattr(value, "json", None)
    if isinstance(json_value, dict):
        return json_value
    if callable(json_value):
        try:
            called = json_value()
            if isinstance(called, dict):
                return called
        except Exception:
            pass
    return None


def normalize_box(box):
    if not isinstance(box, (list, tuple)):
        return None
    if len(box) == 4 and all(isinstance(item, (int, float)) for item in box):
        x1, y1, x2, y2 = [float(item) for item in box]
    else:
        points = []
        for point in box:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                try:
                    points.append((float(point[0]), float(point[1])))
                except Exception:
                    pass
        if not points:
            return None
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    width = max(1.0, x2 - x1)
    height = max(1.0, y2 - y1)
    return {
        "x1": x1,
        "y1": y1,
        "x2": x2,
        "y2": y2,
        "width": width,
        "height": height,
        "cx": (x1 + x2) / 2,
        "cy": (y1 + y2) / 2,
    }


def make_entry(text, box, score=None):
    text = normalize_text(text)
    if not text or not box:
        return None
    return {
        "text": text,
        "score": score,
        **box,
    }


def extract_entries(result):
    entries = []
    result_items = result if isinstance(result, list) else [result]
    for item in result_items:
        plain = to_plain_result(item)
        res = plain.get("res") if isinstance(plain, dict) and isinstance(plain.get("res"), dict) else plain
        if not isinstance(res, dict):
            continue
        texts = res.get("rec_texts")
        boxes = res.get("rec_boxes")
        if boxes is None:
            boxes = res.get("rec_polys")
        if boxes is None:
            boxes = res.get("dt_polys")
        scores = res.get("rec_scores")
        if hasattr(texts, "tolist"):
            texts = texts.tolist()
        if hasattr(boxes, "tolist"):
            boxes = boxes.tolist()
        if hasattr(scores, "tolist"):
            scores = scores.tolist()
        if not isinstance(scores, list):
            scores = []
        if not isinstance(texts, list) or not isinstance(boxes, list):
            continue
        for index, text in enumerate(texts):
            box = normalize_box(boxes[index]) if index < len(boxes) else None
            entry = make_entry(text, box, scores[index] if index < len(scores) else None)
            if entry:
                entries.append(entry)
    return entries


def split_wide_vertical_entry(entry):
    chars = cjk_chars(entry["text"])
    if not (2 <= len(chars) <= 8):
        return [entry]
    if entry["width"] <= entry["height"] * 1.18:
        return [entry]

    char_width = entry["width"] / len(chars)
    split_entries = []
    for index, char in enumerate(chars):
        x1 = entry["x1"] + index * char_width
        x2 = x1 + char_width
        split_entries.append({
            **entry,
            "text": char,
            "x1": x1,
            "x2": x2,
            "width": max(1.0, x2 - x1),
            "cx": (x1 + x2) / 2,
            "splitFrom": entry["text"],
        })
    return split_entries


def is_vertical_candidate(entry):
    text = entry["text"]
    chars = cjk_chars(text)
    if not chars:
        return False
    compact_length = len("".join(chars))
    if compact_length > 8:
        return False
    if entry["height"] < 40:
        return False
    return entry["height"] >= entry["width"] * 0.55 or compact_length <= 3


def vertical_column_lines(entries):
    expanded = []
    for entry in entries:
        expanded.extend(split_wide_vertical_entry(entry))

    candidates = [entry for entry in expanded if is_vertical_candidate(entry)]
    if len(candidates) < 5:
        return None

    widths = [entry["width"] for entry in candidates if entry["width"] > 0]
    median_width = statistics.median(widths) if widths else 120
    column_threshold = min(140, max(32, median_width * 0.38))

    def column_width(column):
        column_widths = [item["width"] for item in column["items"] if item["width"] > 0]
        return statistics.median(column_widths) if column_widths else column["x2"] - column["x1"]

    def same_column(entry, column):
        reference_width = max(1.0, column_width(column))
        width_ratio = entry["width"] / reference_width
        comparable_width = 0.35 <= width_ratio <= 2.85
        overlap = max(0.0, min(entry["x2"], column["x2"]) - max(entry["x1"], column["x1"]))
        overlap_ratio = overlap / max(1.0, min(entry["width"], column["x2"] - column["x1"]))
        center_close = abs(entry["cx"] - column["cx"]) <= column_threshold
        return comparable_width and (center_close or overlap_ratio >= 0.45)

    columns = []
    for entry in sorted(candidates, key=lambda item: item["cx"], reverse=True):
        target = None
        for column in columns:
            if same_column(entry, column):
                target = column
                break
        if target is None:
            columns.append({"cx": entry["cx"], "x1": entry["x1"], "x2": entry["x2"], "items": [entry]})
        else:
            target["items"].append(entry)
            target["cx"] = sum(item["cx"] for item in target["items"]) / len(target["items"])
            target["x1"] = min(item["x1"] for item in target["items"])
            target["x2"] = max(item["x2"] for item in target["items"])

    valid_columns = []
    for column in columns:
        items = sorted(column["items"], key=lambda item: (item["cy"], item["x1"]))
        if len(items) < 2:
            item = items[0]
            if not (len(cjk_chars(item["text"])) >= 4 and item["height"] > item["width"] * 2.5):
                continue
        y_span = max(item["cy"] for item in items) - min(item["cy"] for item in items)
        if len(items) >= 2 and y_span < max(80, statistics.median([item["height"] for item in items]) * 0.7):
            continue
        valid_columns.append({"cx": column["cx"], "items": items})

    if len(valid_columns) < 2 and not any(len(column["items"]) >= 4 for column in valid_columns):
        return None

    used = {id(item) for column in valid_columns for item in column["items"]}
    lines = []
    for column in sorted(valid_columns, key=lambda item: item["cx"], reverse=True):
        line = "".join(item["text"].replace(" ", "") for item in column["items"])
        if line:
            lines.append(line)

    leftovers = [
        entry for entry in expanded
        if id(entry) not in used and normalize_text(entry["text"]) and not is_vertical_candidate(entry)
    ]
    leftovers.sort(key=lambda item: (item["y1"], item["x1"]))
    lines.extend(entry["text"] for entry in leftovers)
    return dedupe_lines(lines), "vertical-rl"


def dedupe_lines(lines):
    deduped = []
    seen = set()
    for line in lines:
        normalized = normalize_text(line)
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(normalized)
    return deduped


def default_lines(result, entries):
    if entries:
        sorted_entries = sorted(entries, key=lambda item: (item["y1"], item["x1"]))
        return dedupe_lines(entry["text"] for entry in sorted_entries)
    return dedupe_lines(flatten_text(result))


def main():
    if len(sys.argv) < 2:
        raise SystemExit("missing image path")

    image_path = Path(sys.argv[1]).resolve()
    if not image_path.exists():
        raise SystemExit(f"image not found: {image_path}")

    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"PaddleOCR not installed: {error}"}))
        return

    try:
        try:
            ocr = PaddleOCR(use_doc_orientation_classify=True, use_doc_unwarping=True, use_textline_orientation=True)
        except TypeError:
            ocr = PaddleOCR(use_angle_cls=True, lang="ch")

        if hasattr(ocr, "predict"):
            result = ocr.predict(str(image_path))
        else:
            result = ocr.ocr(str(image_path), cls=True)

        entries = extract_entries(result)
        vertical_result = vertical_column_lines(entries)
        if vertical_result:
            lines, reading_mode = vertical_result
        else:
            lines = default_lines(result, entries)
            reading_mode = "horizontal"

        print(json.dumps({
            "ok": True,
            "engine": "paddleocr",
            "readingMode": reading_mode,
            "text": "\n".join(lines),
            "lineCount": len(lines),
        }))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))


if __name__ == "__main__":
    main()
