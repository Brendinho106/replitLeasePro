---
name: SharePoint Sync
description: SharePoint document library mirror — stub mode, schema, and future live sync.
---

## Scope
- Mirror **document additions and deletions** from a SharePoint site library into LeasePro RAG index
- **No live in-document change sync** — edits in SharePoint are ignored until manually re-synced (future option)
- One shared library for all users; future RBAC filters subsets of the same pool

## Stub mode (current)
Until Azure dev app + real site URL are provisioned:
- `SHAREPOINT_SITE_URL` defaults to `https://contoso.sharepoint.com/sites/leasing-dev-stub`
- `SHAREPOINT_ROOT_FOLDER` defaults to `Shared Documents/Leases`
- `POST /api/sync/run` returns stub result without calling Graph API
- Stub folder tree seeded on startup: `Shared Documents` → `Leases (stub)` + `Uploads`
- Manual uploads go to **Uploads** folder

## Env vars (when ready)
```
SHAREPOINT_SITE_URL=https://tenant.sharepoint.com/sites/your-site
SHAREPOINT_ROOT_FOLDER=Shared Documents/Leases
MICROSOFT_TENANT_ID=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
```

## Azure app (production target)
- Application permissions: `Sites.Selected` + `Files.Read.All`
- Admin grants app access to the specific SharePoint site
- Client credentials flow (no user login required for scheduled sync)

## API
- `GET /api/sync/status` — connection state, stub/config flags
- `POST /api/sync/run` — trigger mirror sync
- `GET /api/documents/tree` — nested folder tree for UI

## Schema
- `sync_connections` — one row per linked library
- `sync_folders` — folder tree mirror
- `documents` extended: `folderId`, `externalItemId`, `source`, `relativePath`, `visibility` (default `all`)

## Phase 2 (when dev Azure connected)
- Graph delta query on configured drive/folder
- Download new files → GCS → existing OCR pipeline
- Delete local docs when Graph reports deletion
- Ignore modified items (same externalItemId, new etag)

## Future RBAC
- `documents.visibility` = `restricted` + `document_access` junction table
- RAG search filters by user role; tree hides unauthorized folders/files
