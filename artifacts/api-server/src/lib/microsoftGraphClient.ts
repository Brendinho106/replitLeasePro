import { getSharePointConfig } from "./sharePointConfig";
import { logger } from "./logger";

export class GraphNotConfiguredError extends Error {
  constructor(message = "Microsoft Graph credentials are not configured") {
    super(message);
    this.name = "GraphNotConfiguredError";
  }
}

type GraphTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type DriveItem = {
  id: string;
  name: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
  eTag?: string;
  parentReference?: { path?: string };
  deleted?: { state: string };
};

type DeltaResponse = {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/**
 * Microsoft Graph client for SharePoint document library sync.
 * Stub-safe: throws GraphNotConfiguredError until Azure credentials are set.
 */
export class MicrosoftGraphClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  isConfigured(): boolean {
    return getSharePointConfig().isConfigured;
  }

  async getAccessToken(): Promise<string> {
    const config = getSharePointConfig();
    if (!config.isConfigured) {
      throw new GraphNotConfiguredError();
    }

    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.value;
    }

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const res = await fetch(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      logger.error({ status: res.status, detail }, "Graph token request failed");
      throw new Error(`Failed to obtain Graph access token (${res.status})`);
    }

    const data = (await res.json()) as GraphTokenResponse;
    this.cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  /** Resolve a SharePoint site URL to a site ID. */
  async resolveSiteId(siteUrl: string): Promise<string> {
    const token = await this.getAccessToken();
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname;

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      throw new Error(`Failed to resolve SharePoint site (${res.status})`);
    }

    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /** Get the default document library drive for a site. */
  async getDefaultDrive(siteId: string): Promise<{ id: string }> {
    const token = await this.getAccessToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to get site drive (${res.status})`);
    }

    return (await res.json()) as { id: string };
  }

  /**
   * List children of a folder (or drive root when folderItemId omitted).
   * Used for full tree walk during initial sync.
   */
  async listChildren(driveId: string, folderItemId?: string): Promise<DriveItem[]> {
    const token = await this.getAccessToken();
    const base = folderItemId
      ? `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderItemId}/children`
      : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;

    const items: DriveItem[] = [];
    let url: string | undefined = base;

    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`Failed to list drive children (${res.status})`);
      }
      const data = (await res.json()) as { value: DriveItem[]; "@odata.nextLink"?: string };
      items.push(...data.value);
      url = data["@odata.nextLink"];
    }

    return items;
  }

  /** Incremental sync via delta query. Returns added/updated/deleted items. */
  async getDelta(driveId: string, deltaLink?: string | null): Promise<DeltaResponse> {
    const token = await this.getAccessToken();
    const url =
      deltaLink ?? `https://graph.microsoft.com/v1.0/drives/${driveId}/root/delta`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Delta query failed (${res.status})`);
    }

    return (await res.json()) as DeltaResponse;
  }

  /** Download file content bytes for a drive item. */
  async downloadFile(driveId: string, itemId: string): Promise<Buffer> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      throw new Error(`Failed to download file (${res.status})`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}

export type { DriveItem, DeltaResponse };
