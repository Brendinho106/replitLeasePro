import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, MessageSquare, ArrowRight, Building, Search, FileText } from "lucide-react";
import { useCreateOpenaiConversation } from "@workspace/api-client-react";
import { useLocation } from "wouter";

export function ChatList() {
  const [, setLocation] = useLocation();
  const createConversation = useCreateOpenaiConversation();

  const handleNewChat = () => {
    createConversation.mutate(
      { data: { title: "New Analysis" } },
      {
        onSuccess: (chat) => {
          setLocation(`/chat/${chat.id}`);
        },
      }
    );
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 md:p-12 max-w-4xl mx-auto w-full">
      <div className="text-center mb-12">
        <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-6">
          <MessageSquare className="w-8 h-8" />
        </div>
        <h1 className="text-3xl md:text-4xl font-serif font-medium text-foreground tracking-tight mb-4">
          Lease Intelligence
        </h1>
        <p className="text-lg text-muted-foreground max-w-lg mx-auto">
          Ask questions about your lease portfolio, extract critical dates, and verify tenant obligations across all your uploaded documents.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 w-full max-w-2xl mb-10">
        <Card className="bg-card hover-elevate transition-all border-border shadow-sm">
          <CardContent className="p-6 flex flex-col items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center text-primary">
              <Search className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h3 className="font-medium">Portfolio Search</h3>
              <p className="text-sm text-muted-foreground">Find specific clauses or terms across all 50+ uploaded leases instantly.</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card hover-elevate transition-all border-border shadow-sm">
          <CardContent className="p-6 flex flex-col items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center text-primary">
              <FileText className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h3 className="font-medium">Document Analysis</h3>
              <p className="text-sm text-muted-foreground">Compare rent rolls, verify escalation schedules, and summarize complex paragraphs.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Button 
        size="lg" 
        className="h-14 px-8 text-base shadow-md group"
        onClick={handleNewChat}
        disabled={createConversation.isPending}
      >
        <Plus className="w-5 h-5 mr-2" />
        Start New Analysis
        <ArrowRight className="w-4 h-4 ml-2 opacity-50 group-hover:translate-x-1 group-hover:opacity-100 transition-all" />
      </Button>
    </div>
  );
}
