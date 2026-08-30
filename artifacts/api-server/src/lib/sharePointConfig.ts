export type SharePointConfig = {
  siteUrl: string;
  rootFolderPath: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** True when Azure app credentials are present (ready for Graph API). */
  isConfigured: boolean;
  /** True when using placeholder URLs until real SharePoint is provisioned. */
  isStub: boolean;
};

const STUB_SITE_URL = "https://contoso.sharepoint.com/sites/leasing-dev-stub";
const STUB_ROOT_FOLDER = "Shared Documents/Leases";

/**
 * SharePoint sync configuration from environment.
 * Uses stub placeholders until real site URL and Azure credentials are provided.
 */
export function getSharePointConfig(): SharePointConfig {
  const siteUrl = process.env["SHAREPOINT_SITE_URL"]?.trim() || STUB_SITE_URL;
  const rootFolderPath = process.env["SHAREPOINT_ROOT_FOLDER"]?.trim() || STUB_ROOT_FOLDER;
  const tenantId = process.env["MICROSOFT_TENANT_ID"]?.trim() ?? "";
  const clientId = process.env["MICROSOFT_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"]?.trim() ?? "";

  const isConfigured = Boolean(tenantId && clientId && clientSecret);
  const isStub =
    !process.env["SHAREPOINT_SITE_URL"]?.trim() || !process.env["SHAREPOINT_ROOT_FOLDER"]?.trim();

  return {
    siteUrl,
    rootFolderPath,
    tenantId,
    clientId,
    clientSecret,
    isConfigured,
    isStub,
  };
}
