import json
import sys
from pathlib import Path


def flatten_text(value):
    texts = []
    if isinstance(value, str):
        text = value.strip()
        if text:
            texts.append(text)
    elif isinstance(value, dict):
        for key in ("rec_text", "text", "transcription"):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        for key in ("rec_texts", "texts"):
            entries = value.get(key)
            if isinstance(entries, list):
                texts.extend(flatten_text(entries))
        for nested in value.values():
            if isinstance(nested, (list, tuple, dict)):
                texts.extend(flatten_text(nested))
    elif isinstance(value, (list, tuple)):
        if len(value) >= 2 and isinstance(value[1], (list, tuple)) and value[1] and isinstance(value[1][0], str):
            texts.append(value[1][0].strip())
        else:
            for entry in value:
                texts.extend(flatten_text(entry))
    return texts


def main():
    if len(sys.argv) < 2:
        raise SystemExit("missing image path")

    image_path = Path(sys.argv[1]).resolve()
    if not image_path.exists():
        raise SystemExit(f"image not found: {image_path}")

    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"PaddleOCR 未安装：{error}"}))
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

        lines = []
        seen = set()
        for text in flatten_text(result):
            normalized = " ".join(text.split())
            if normalized and normalized not in seen:
                seen.add(normalized)
                lines.append(normalized)

        print(json.dumps({"ok": True, "engine": "paddleocr", "text": "\n".join(lines), "lineCount": len(lines)}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))


if __name__ == "__main__":
    main()
