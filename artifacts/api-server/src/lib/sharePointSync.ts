import { eq, isNull, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  documentsTable,
  syncConnectionsTable,
  syncFoldersTable,
  type SyncConnection,
  type SyncFolder,
  type Document,
} from "@workspace/db";
import { getSharePointConfig } from "./sharePointConfig";
import { GraphNotConfiguredError, MicrosoftGraphClient } from "./microsoftGraphClient";
import { logger } from "./logger";

export type SyncStatus = {
  connectionId: number | null;
  provider: string;
  siteUrl: string;
  rootFolderPath: string;
  syncStatus: string;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  isConfigured: boolean;
  isStub: boolean;
  message: string;
};

export type DocumentTreeFile = {
  type: "file";
  id: number;
  name: string;
  fileType: string;
  status: string;
  chunkCount: number | null;
  source: string;
  relativePath: string | null;
  uploadedAt: Date;
};

export type DocumentTreeFolder = {
  type: "folder";
  id: number;
  name: string;
  path: string;
  isLocal: boolean;
  children: DocumentTreeNode[];
};

export type DocumentTreeNode = DocumentTreeFolder | DocumentTreeFile;

const UPLOADS_FOLDER_NAME = "Uploads";
const STUB_LEASES_FOLDER_NAME = "Leases (stub)";

/** Ensure stub connection + folder tree exists for dev before SharePoint is provisioned. */
export async function ensureStubLayout(): Promise<{
  connection: SyncConnection;
  uploadsFolder: SyncFolder;
}> {
  const config = getSharePointConfig();

  let [connection] = await db.select().from(syncConnectionsTable).limit(1);

  if (!connection) {
    [connection] = await db
      .insert(syncConnectionsTable)
      .values({
        provider: "sharepoint",
        siteUrl: config.siteUrl,
        rootFolderPath: config.rootFolderPath,
        syncStatus: "idle",
      })
      .returning();
  } else {
    [connection] = await db
      .update(syncConnectionsTable)
      .set({
        siteUrl: config.siteUrl,
        rootFolderPath: config.rootFolderPath,
      })
      .where(eq(syncConnectionsTable.id, connection.id))
      .returning();
  }

  let [sharedRoot] = await db
    .select()
    .from(syncFoldersTable)
    .where(
      and(eq(syncFoldersTable.connectionId, connection.id), isNull(syncFoldersTable.parentId)),
    )
    .limit(1);

  if (!sharedRoot) {
    [sharedRoot] = await db
      .insert(syncFoldersTable)
      .values({
        connectionId: connection.id,
        name: "Shared Documents",
        path: "/Shared Documents",
        isLocal: false,
      })
      .returning();
  }

  const stubLeasesPath = `/Shared Documents/${STUB_LEASES_FOLDER_NAME}`;
  let [stubLeases] = await db
    .select()
    .from(syncFoldersTable)
    .where(eq(syncFoldersTable.path, stubLeasesPath))
    .limit(1);

  if (!stubLeases) {
    [stubLeases] = await db
      .insert(syncFoldersTable)
      .values({
        connectionId: connection.id,
        parentId: sharedRoot.id,
        name: STUB_LEASES_FOLDER_NAME,
        path: stubLeasesPath,
        isLocal: true,
      })
      .returning();
  }

  const uploadsPath = `/Shared Documents/${UPLOADS_FOLDER_NAME}`;
  let [uploadsFolder] = await db
    .select()
    .from(syncFoldersTable)
    .where(eq(syncFoldersTable.path, uploadsPath))
    .limit(1);

  if (!uploadsFolder) {
    [uploadsFolder] = await db
      .insert(syncFoldersTable)
      .values({
        connectionId: connection.id,
        parentId: sharedRoot.id,
        name: UPLOADS_FOLDER_NAME,
        path: uploadsPath,
        isLocal: true,
      })
      .returning();
  }

  // Assign legacy manual uploads to the Uploads folder.
  await db
    .update(documentsTable)
    .set({ folderId: uploadsFolder.id, source: "upload" })
    .where(and(isNull(documentsTable.folderId), eq(documentsTable.source, "upload")));

  return { connection, uploadsFolder };
}

export async function getUploadsFolderId(): Promise<number> {
  const { uploadsFolder } = await ensureStubLayout();
  return uploadsFolder.id;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const config = getSharePointConfig();
  const { connection } = await ensureStubLayout();

  let message: string;
  if (!config.isConfigured && config.isStub) {
    message =
      "SharePoint sync is in stub mode. Set SHAREPOINT_SITE_URL, SHAREPOINT_ROOT_FOLDER, and Azure credentials when ready.";
  } else if (!config.isConfigured) {
    message =
      "SharePoint site URL is set but Azure app credentials are missing. Add MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, and MICROSOFT_CLIENT_SECRET.";
  } else if (config.isStub) {
    message = "Azure credentials are set. Replace stub SharePoint URLs when the site library is provisioned.";
  } else {
    message = "SharePoint sync is configured. Run sync to mirror document additions and deletions.";
  }

  return {
    connectionId: connection.id,
    provider: connection.provider,
    siteUrl: connection.siteUrl,
    rootFolderPath: connection.rootFolderPath,
    syncStatus: connection.syncStatus,
    lastSyncedAt: connection.lastSyncedAt,
    lastSyncError: connection.lastSyncError,
    isConfigured: config.isConfigured,
    isStub: config.isStub,
    message,
  };
}

export type SyncRunResult = {
  mode: "stub" | "live";
  added: number;
  deleted: number;
  skipped: number;
  message: string;
};

/**
 * Mirror SharePoint document additions and deletions into the local index.
 * In stub mode (no Azure credentials), returns without calling Graph API.
 */
export async function runSharePointSync(): Promise<SyncRunResult> {
  const config = getSharePointConfig();
  const { connection } = await ensureStubLayout();

  if (!config.isConfigured) {
    return {
      mode: "stub",
      added: 0,
      deleted: 0,
      skipped: 0,
      message:
        "Sync skipped — Azure app credentials not configured. Stub folder tree is ready for manual uploads.",
    };
  }

  if (config.isStub) {
    return {
      mode: "stub",
      added: 0,
      deleted: 0,
      skipped: 0,
      message:
        "Sync skipped — using stub SharePoint URLs. Set SHAREPOINT_SITE_URL and SHAREPOINT_ROOT_FOLDER to the real library.",
    };
  }

  await db
    .update(syncConnectionsTable)
    .set({ syncStatus: "syncing", lastSyncError: null })
    .where(eq(syncConnectionsTable.id, connection.id));

  const graph = new MicrosoftGraphClient();

  try {
    const siteId = connection.siteId ?? (await graph.resolveSiteId(config.siteUrl));
    const drive = connection.driveId
      ? { id: connection.driveId }
      : await graph.getDefaultDrive(siteId);

    if (!connection.siteId || !connection.driveId) {
      await db
        .update(syncConnectionsTable)
        .set({ siteId, driveId: drive.id })
        .where(eq(syncConnectionsTable.id, connection.id));
    }

    // Phase 2: delta query + download + ingest + delete tombstones.
    // Placeholder until dev Azure tenant is connected.
    logger.info({ siteId, driveId: drive.id }, "SharePoint sync configured — live sync not yet implemented");

    await db
      .update(syncConnectionsTable)
      .set({
        syncStatus: "idle",
        lastSyncedAt: new Date(),
        lastSyncError: null,
      })
      .where(eq(syncConnectionsTable.id, connection.id));

    return {
      mode: "live",
      added: 0,
      deleted: 0,
      skipped: 0,
      message:
        "Graph connection verified. Full delta sync (add/delete mirroring) will run once the dev site library is linked.",
    };
  } catch (err) {
    const errorMessage = err instanceof GraphNotConfiguredError ? err.message : err instanceof Error ? err.message : String(err);
    logger.error({ err }, "SharePoint sync failed");

    await db
      .update(syncConnectionsTable)
      .set({ syncStatus: "error", lastSyncError: errorMessage })
      .where(eq(syncConnectionsTable.id, connection.id));

    throw err;
  }
}

function docToTreeFile(doc: Document): DocumentTreeFile {
  return {
    type: "file",
    id: doc.id,
    name: doc.originalName,
    fileType: doc.fileType,
    status: doc.status,
    chunkCount: doc.chunkCount,
    source: doc.source,
    relativePath: doc.relativePath,
    uploadedAt: doc.uploadedAt,
  };
}

function buildFolderNode(
  folder: SyncFolder,
  allFolders: SyncFolder[],
  docsByFolder: Map<number, Document[]>,
): DocumentTreeFolder {
  const childFolders = allFolders
    .filter((f) => f.parentId === folder.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const children: DocumentTreeNode[] = [
    ...childFolders.map((f) => buildFolderNode(f, allFolders, docsByFolder)),
    ...(docsByFolder.get(folder.id) ?? []).map(docToTreeFile),
  ];

  return {
    type: "folder",
    id: folder.id,
    name: folder.name,
    path: folder.path,
    isLocal: folder.isLocal,
    children,
  };
}

/** Build nested folder tree with documents for the Document Library UI. */
export async function getDocumentTree(): Promise<{ sync: SyncStatus; tree: DocumentTreeFolder[] }> {
  await ensureStubLayout();
  const sync = await getSyncStatus();

  const [connection] = await db.select().from(syncConnectionsTable).limit(1);
  if (!connection) {
    return { sync, tree: [] };
  }

  const folders = await db
    .select()
    .from(syncFoldersTable)
    .where(eq(syncFoldersTable.connectionId, connection.id));

  const documents = await db.select().from(documentsTable);

  const docsByFolder = new Map<number, Document[]>();
  for (const doc of documents) {
    if (doc.folderId == null) continue;
    const list = docsByFolder.get(doc.folderId) ?? [];
    list.push(doc);
    docsByFolder.set(doc.folderId, list);
  }

  for (const [, docs] of docsByFolder) {
    docs.sort((a, b) => a.originalName.localeCompare(b.originalName));
  }

  const roots = folders
    .filter((f) => f.parentId == null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => buildFolderNode(f, folders, docsByFolder));

  return { sync, tree: roots };
}
