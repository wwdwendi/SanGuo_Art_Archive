# Archive Runtime Data

This directory contains local runtime data for the archive app.

Files intended for Git/SVN-style browsing-data sync:

- `archive-db.json`
- `web-clips/`
- `summary-model.env.example`

Files that must remain machine-local:

- `shared-root.txt`
- `svn-root.txt`
- `svn-auth.env`
- `paddle-ocr-python.txt`
- `archive-ai.env`
- `summary-model.env`
- browser profile folders
- logs, backups, OCR temp files, generated thumbnail caches

The machine-local files contain host-specific paths or credentials. Configure
them separately on each machine, or set equivalent environment variables before
starting the services.
