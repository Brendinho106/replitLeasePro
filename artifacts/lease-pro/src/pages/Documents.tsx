import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetDocumentStats, useDeleteDocument, getGetDocumentStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  FileText,
  Trash2,
  UploadCloud,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  File,
  Download,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Cloud,
} from "lucide-react";
import { useDropzone } from "react-dropzone";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type SyncStatus = {
  connectionId: number | null;
  provider: string;
  siteUrl: string;
  rootFolderPath: string;
  syncStatus: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  isConfigured: boolean;
  isStub: boolean;
  message: string;
};

type TreeFile = {
  type: "file";
  id: number;
  name: string;
  fileType: string;
  status: string;
  chunkCount: number | null;
  source: string;
  relativePath: string | null;
  uploadedAt: string;
};

type TreeFolder = {
  type: "folder";
  id: number;
  name: string;
  path: string;
  isLocal: boolean;
  children: TreeNode[];
};

type TreeNode = TreeFolder | TreeFile;

type DocumentTreeResponse = {
  sync: SyncStatus;
  tree: TreeFolder[];
};

function getFileIcon(fileType: string) {
  if (fileType.includes("pdf")) return <FileText className="w-5 h-5 text-red-500" />;
  if (fileType.includes("excel") || fileType.includes("spreadsheet") || fileType.includes("csv"))
    return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
  if (fileType.includes("word") || fileType.includes("document"))
    return <FileText className="w-5 h-5 text-blue-600" />;
  return <File className="w-5 h-5 text-muted-foreground" />;
}

function collectFiles(node: TreeNode): TreeFile[] {
  if (node.type === "file") return [node];
  return node.children.flatMap(collectFiles);
}

function FolderTreeItem({
  folder,
  selectedFolderId,
  onSelect,
  depth = 0,
}: {
  folder: TreeFolder;
  selectedFolderId: number | null;
  onSelect: (id: number) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = selectedFolderId === folder.id;
  const childFolders = folder.children.filter((c): c is TreeFolder => c.type === "folder");

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect(folder.id);
          setExpanded((e) => !e);
        }}
        className={`w-full flex items-center gap-1.5 py-1.5 px-2 rounded-md text-sm text-left hover:bg-muted/60 transition-colors ${
          isSelected ? "bg-primary/10 text-primary font-medium" : ""
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {childFolders.length > 0 ? (
          expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="w-4 h-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="w-4 h-4 shrink-0 text-amber-500" />
        )}
        <span className="truncate">{folder.name}</span>
      </button>
      {expanded &&
        childFolders.map((child) => (
          <FolderTreeItem
            key={child.id}
            folder={child}
            selectedFolderId={selectedFolderId}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

export function Documents() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  const { data: stats, isLoading: isStatsLoading } = useGetDocumentStats();
  const deleteDocument = useDeleteDocument();

  const { data: treeData, isLoading: isTreeLoading, refetch: refetchTree } = useQuery({
    queryKey: ["documents-tree"],
    queryFn: async (): Promise<DocumentTreeResponse> => {
      const res = await fetch(`${basePath}/api/documents/tree`);
      if (!res.ok) throw new Error("Failed to load document tree");
      return res.json();
    },
  });

  const sync = treeData?.sync;
  const tree = treeData?.tree ?? [];

  const folderMap = useMemo(() => {
    const map = new Map<number, TreeFolder>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "folder") {
          map.set(node.id, node);
          walk(node.children);
        }
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const uploadsFolder = useMemo(() => {
    for (const f of folderMap.values()) {
      if (f.name === "Uploads") return f;
    }
    return null;
  }, [folderMap]);

  const activeFolderId = selectedFolderId ?? uploadsFolder?.id ?? tree[0]?.id ?? null;
  const activeFolder = activeFolderId != null ? folderMap.get(activeFolderId) : null;
  const visibleFiles = activeFolder ? collectFiles(activeFolder).filter((f) => f.type === "file") : [];

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["documents-tree"] });
    queryClient.invalidateQueries({ queryKey: getGetDocumentStatsQueryKey() });
  }, [queryClient]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;

      setIsUploading(true);

      try {
        for (const file of acceptedFiles) {
          const formData = new FormData();
          formData.append("file", file);

          const response = await fetch(`${basePath}/api/documents/upload`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            throw new Error(`Failed to upload ${file.name}`);
          }
        }

        toast({
          title: "Upload successful",
          description: `Successfully uploaded ${acceptedFiles.length} document(s) to Uploads.`,
        });

        invalidateAll();
      } catch (error: unknown) {
        toast({
          title: "Upload failed",
          description: error instanceof Error ? error.message : "An error occurred while uploading.",
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
    },
    [invalidateAll, toast],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
      "text/csv": [".csv"],
    },
  });

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    deleteDocument.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Document deleted" });
          invalidateAll();
        },
        onError: () => {
          toast({ title: "Failed to delete document", variant: "destructive" });
        },
      },
    );
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch(`${basePath}/api/sync/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");

      toast({
        title: data.mode === "stub" ? "Sync (stub mode)" : "Sync complete",
        description: data.message,
      });
      invalidateAll();
      refetchTree();
    } catch (error: unknown) {
      toast({
        title: "Sync failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  if (isTreeLoading || isStatsLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6 md:p-10 space-y-8">
      <div>
        <h1 className="text-3xl font-serif font-medium tracking-tight mb-2">Document Library</h1>
        <p className="text-muted-foreground">
          Browse your SharePoint library mirror or upload documents manually.
        </p>
      </div>

      {sync && (
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Cloud className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">SharePoint Sync</span>
                {sync.isStub && (
                  <Badge variant="outline" className="text-xs">
                    Stub
                  </Badge>
                )}
                {sync.isConfigured && !sync.isStub && (
                  <Badge variant="outline" className="text-xs bg-green-500/10 text-green-700 border-green-500/20">
                    Configured
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate" title={sync.siteUrl}>
                {sync.siteUrl} → {sync.rootFolderPath}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{sync.message}</p>
              {sync.lastSyncedAt && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last sync: {format(new Date(sync.lastSyncedAt), "MMM d, yyyy h:mm a")}
                </p>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing} className="shrink-0">
            {isSyncing ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Sync now
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card shadow-sm border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Documents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium">{stats?.totalDocuments || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card shadow-sm border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-600" /> Ready
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium">{stats?.readyDocuments || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card shadow-sm border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="w-4 h-4 text-yellow-600" /> Processing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium">{stats?.processingDocuments || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-card shadow-sm border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive" /> Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium">{stats?.errorDocuments || 0}</div>
          </CardContent>
        </Card>
      </div>

      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-card/50"
        }`}
      >
        <input {...getInputProps()} />
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 text-primary">
          {isUploading ? <Loader2 className="w-6 h-6 animate-spin" /> : <UploadCloud className="w-6 h-6" />}
        </div>
        <h3 className="text-lg font-medium mb-1">
          {isDragActive ? "Drop documents here" : "Click or drag documents to upload"}
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Manual uploads go to the Uploads folder until SharePoint sync is connected
        </p>
        <Button variant="outline" disabled={isUploading}>
          Select Files
        </Button>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden flex flex-col md:flex-row min-h-[420px]">
        <div className="md:w-64 lg:w-72 border-b md:border-b-0 md:border-r border-border bg-muted/20 p-3 shrink-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 mb-2">
            Folders
          </h2>
          <div className="space-y-0.5">
            {tree.map((folder) => (
              <FolderTreeItem
                key={folder.id}
                folder={folder}
                selectedFolderId={activeFolderId}
                onSelect={setSelectedFolderId}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="p-4 border-b border-border bg-muted/30">
            <h2 className="font-medium">{activeFolder?.name ?? "Documents"}</h2>
            {activeFolder && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{activeFolder.path}</p>
            )}
          </div>

          {visibleFiles.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              {activeFolder?.name === "Leases (stub)"
                ? "SharePoint leases will appear here after sync is connected."
                : "No documents in this folder yet."}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {visibleFiles.map((doc) => (
                <div key={doc.id} className="p-4 flex items-center gap-4 hover:bg-muted/20 transition-colors">
                  <div className="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0">
                    {getFileIcon(doc.fileType)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm truncate" title={doc.name}>
                      {doc.name}
                    </h4>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{format(new Date(doc.uploadedAt), "MMM d, yyyy")}</span>
                      {doc.chunkCount ? (
                        <>
                          <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                          <span>{doc.chunkCount} chunks</span>
                        </>
                      ) : null}
                      {doc.source === "sharepoint" && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                          <span>SharePoint</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <Badge
                      variant="outline"
                      className={`
                    ${doc.status === "ready" ? "bg-green-500/10 text-green-700 border-green-500/20" : ""}
                    ${doc.status === "processing" || doc.status === "pending" ? "bg-yellow-500/10 text-yellow-700 border-yellow-500/20" : ""}
                    ${doc.status === "error" ? "bg-destructive/10 text-destructive border-destructive/20" : ""}
                  `}
                    >
                      {doc.status}
                    </Badge>

                    <a
                      href={`${basePath}/api/documents/${doc.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Download original file"
                    >
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary h-8 w-8">
                        <Download className="w-4 h-4" />
                      </Button>
                    </a>

                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive h-8 w-8"
                      onClick={() => handleDelete(doc.id)}
                      disabled={deleteDocument.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
