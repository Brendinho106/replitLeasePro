import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useGetOpenaiConversation, useListOpenaiMessages, getListOpenaiMessagesQueryKey, getGetOpenaiConversationQueryKey } from "@workspace/api-client-react";
import { Send, Loader2, Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const QUICK_ACTIONS = [
  "Show me upcoming expirations",
  "Summarize escalation clauses",
  "List tenant responsibilities",
  "Show portfolio summary",
];

export function ActiveChat() {
  const [, params] = useRoute("/chat/:id");
  const chatId = params?.id ? parseInt(params.id, 10) : 0;
  
  const queryClient = useQueryClient();
  const { data: conversation, isLoading: isLoadingConv } = useGetOpenaiConversation(chatId, { 
    query: { enabled: !!chatId, queryKey: getGetOpenaiConversationQueryKey(chatId) } 
  });
  
  const { data: serverMessages, isLoading: isLoadingMsgs } = useListOpenaiMessages(chatId, {
    query: { enabled: !!chatId, queryKey: getListOpenaiMessagesQueryKey(chatId) }
  });

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Combine server messages with the currently streaming message
  const displayMessages = [...(serverMessages || [])].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [displayMessages, streamedContent]);

  const handleSend = async (content: string) => {
    if (!content.trim() || isStreaming || !chatId) return;
    
    const userMessageContent = content;
    setInput("");
    setIsStreaming(true);
    setStreamedContent("");

    // Optimistically add user message to cache
    const currentMessages = queryClient.getQueryData<any[]>(getListOpenaiMessagesQueryKey(chatId)) || [];
    const tempUserMsg = {
      id: Date.now(),
      conversationId: chatId,
      role: "user",
      content: userMessageContent,
      createdAt: new Date().toISOString()
    };
    
    queryClient.setQueryData(getListOpenaiMessagesQueryKey(chatId), [...currentMessages, tempUserMsg]);

    try {
      // Use raw fetch for SSE streaming
      const response = await fetch(`${basePath}/api/openai/conversations/${chatId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: userMessageContent }),
      });

      if (!response.ok) throw new Error("Failed to send message");
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      let finalContent = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataStr = line.slice(6);
              if (dataStr === "[DONE]") continue;
              
              try {
                const data = JSON.parse(dataStr);
                if (data.done) {
                  // Stream finished
                } else if (data.content) {
                  finalContent += data.content;
                  setStreamedContent(finalContent);
                }
              } catch (e) {
                console.error("Error parsing SSE data:", e);
              }
            }
          }
        }
      }

      // After streaming is complete, refetch messages to get the real saved messages
      await queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(chatId) });
      
    } catch (error) {
      console.error("Chat error:", error);
      // Revert optimistic update on error
      queryClient.setQueryData(getListOpenaiMessagesQueryKey(chatId), currentMessages);
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  if (isLoadingConv || isLoadingMsgs) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full border-x border-border bg-card/30">
      <header className="h-16 flex items-center px-6 border-b border-border bg-card shrink-0 sticky top-0 z-10">
        <div className="flex flex-col">
          <h2 className="font-serif font-medium text-lg tracking-tight truncate">
            {conversation?.title || "Analysis"}
          </h2>
          <span className="text-xs text-muted-foreground">Lease Intelligence Session</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {displayMessages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-6 text-muted-foreground">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center text-primary border border-primary/10">
              <Bot className="w-8 h-8" />
            </div>
            <div className="max-w-md space-y-2">
              <p className="text-lg font-medium text-foreground">How can I help with your portfolio?</p>
              <p className="text-sm">Ask questions in plain English. I'll search through your uploaded leases and extract precise answers.</p>
            </div>
          </div>
        )}

        {displayMessages.map((msg) => (
          <div 
            key={msg.id} 
            className={`flex gap-4 max-w-3xl ${msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"}`}
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-card border border-border text-primary"
            }`}>
              {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>
            
            <div className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
              <div className={`text-xs font-medium text-muted-foreground ${msg.role === "user" ? "mr-1" : "ml-1"}`}>
                {msg.role === "user" ? "You" : "LeasePro"}
              </div>
              <Card className={`p-4 shadow-sm ${
                msg.role === "user" 
                  ? "bg-primary text-primary-foreground border-transparent rounded-tr-sm" 
                  : "bg-card border-border rounded-tl-sm prose-card"
              }`}>
                {msg.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-muted prose-pre:border prose-pre:border-border text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )}
              </Card>
            </div>
          </div>
        ))}

        {isStreaming && (
          <div className="flex gap-4 max-w-3xl mr-auto">
            <div className="w-8 h-8 rounded-full bg-card border border-border text-primary flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            
            <div className="flex flex-col gap-1 items-start">
              <div className="text-xs font-medium text-muted-foreground ml-1">
                LeasePro
              </div>
              <Card className="p-4 shadow-sm bg-card border-border rounded-tl-sm w-full prose-card">
                {streamedContent ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {streamedContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="w-2 h-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-card border-t border-border shrink-0">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {displayMessages.length === 0 && !isStreaming && (
            <div className="flex flex-wrap gap-2 mb-2">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action}
                  onClick={() => handleSend(action)}
                  className="text-xs font-medium px-3 py-1.5 rounded-full bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors border border-transparent hover:border-primary/20"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
          
          <div className="relative">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your leases..."
              className="min-h-[60px] max-h-[200px] pr-14 py-4 resize-none bg-background shadow-sm border-border focus-visible:ring-primary"
              disabled={isStreaming}
            />
            <Button 
              size="icon" 
              className="absolute bottom-3 right-3 h-8 w-8 rounded-md"
              onClick={() => handleSend(input)}
              disabled={!input.trim() || isStreaming}
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <div className="text-[10px] text-center text-muted-foreground font-medium">
            LeasePro can make mistakes. Verify important legal and financial details.
          </div>
        </div>
      </div>
    </div>
  );
}
