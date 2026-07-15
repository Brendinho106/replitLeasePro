import { useCallback, useState } from "react";
import { useListDocuments, useGetDocumentStats, useDeleteDocument, getListDocumentsQueryKey, getGetDocumentStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, Trash2, UploadCloud, AlertCircle, CheckCircle2, Clock, FileSpreadsheet, File } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function getFileIcon(fileType: string) {
  if (fileType.includes("pdf")) return <FileText className="w-5 h-5 text-red-500" />;
  if (fileType.includes("excel") || fileType.includes("spreadsheet") || fileType.includes("csv")) return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
  if (fileType.includes("word") || fileType.includes("document")) return <FileText className="w-5 h-5 text-blue-600" />;
  return <File className="w-5 h-5 text-muted-foreground" />;
}

export function Documents() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);

  const { data: documents, isLoading: isDocsLoading } = useListDocuments();
  const { data: stats, isLoading: isStatsLoading } = useGetDocumentStats();
  const deleteDocument = useDeleteDocument();

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;

    setIsUploading(true);
    
    try {
      // Upload files sequentially for simplicity, or Promise.all for parallel
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
        description: `Successfully uploaded ${acceptedFiles.length} document(s).`,
      });

      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDocumentStatsQueryKey() });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message || "An error occurred while uploading.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  }, [queryClient, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'text/csv': ['.csv']
    }
  });

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this document?")) return;
    
    deleteDocument.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Document deleted" });
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDocumentStatsQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to delete document", variant: "destructive" });
      }
    });
  };

  if (isDocsLoading || isStatsLoading) {
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
        <p className="text-muted-foreground">Manage your portfolio of leases, rent rolls, and amendments.</p>
      </div>

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
          Supports PDF, Word, Excel, and CSV files
        </p>
        <Button variant="outline" disabled={isUploading}>Select Files</Button>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border bg-muted/30">
          <h2 className="font-medium">Uploaded Documents</h2>
        </div>
        
        {(!documents || documents.length === 0) ? (
          <div className="p-12 text-center text-muted-foreground">
            No documents uploaded yet. Add your first lease to get started.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {documents.map((doc) => (
              <div key={doc.id} className="p-4 flex items-center gap-4 hover:bg-muted/20 transition-colors">
                <div className="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0">
                  {getFileIcon(doc.fileType)}
                </div>
                
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium text-sm truncate" title={doc.originalName}>
                    {doc.originalName}
                  </h4>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{format(new Date(doc.uploadedAt), "MMM d, yyyy")}</span>
                    {doc.chunkCount ? (
                      <>
                        <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                        <span>{doc.chunkCount} chunks</span>
                      </>
                    ) : null}
                  </div>
                  {doc.errorMessage && (
                    <p className="text-xs text-destructive mt-1 truncate">{doc.errorMessage}</p>
                  )}
                </div>
                
                <div className="flex items-center gap-4 shrink-0">
                  <Badge variant="outline" className={`
                    ${doc.status === 'ready' ? 'bg-green-500/10 text-green-700 border-green-500/20' : ''}
                    ${doc.status === 'processing' || doc.status === 'pending' ? 'bg-yellow-500/10 text-yellow-700 border-yellow-500/20' : ''}
                    ${doc.status === 'error' ? 'bg-destructive/10 text-destructive border-destructive/20' : ''}
                  `}>
                    {doc.status}
                  </Badge>
                  
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
  );
}
