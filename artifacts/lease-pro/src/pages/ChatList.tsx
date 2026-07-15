import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useCreateOpenaiConversation } from "@workspace/api-client-react";
import { useLocation } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function ChatList() {
  const [, setLocation] = useLocation();
  const createConversation = useCreateOpenaiConversation();

  const handleNewChat = () => {
    createConversation.mutate(
      { data: { title: "New Chat" } },
      {
        onSuccess: (chat) => {
          setLocation(`/chat/${chat.id}`);
        },
      },
    );
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-8 p-8">
      <div className="flex flex-col items-center gap-4">
        <img
          src={`${basePath}/logo.svg`}
          alt="LeasePro"
          className="w-16 h-16 rounded-2xl opacity-90"
        />
        <h1 className="font-serif text-3xl font-medium tracking-tight text-foreground">
          LeasePro
        </h1>
        <p className="text-muted-foreground text-sm">
          Ask a question about your lease portfolio to get started.
        </p>
      </div>

      <Button
        size="lg"
        onClick={handleNewChat}
        disabled={createConversation.isPending}
        className="px-8"
      >
        <Plus className="w-4 h-4 mr-2" />
        New Analysis
      </Button>
    </div>
  );
}
