import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { MessageSquare, Files, LogOut, Plus, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useListOpenaiConversations, useCreateOpenaiConversation } from "@workspace/api-client-react";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ReactNode } from "react";
import { format } from "date-fns";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SidebarLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  
  const { data: conversations } = useListOpenaiConversations();
  const createConversation = useCreateOpenaiConversation();

  const handleNewChat = () => {
    createConversation.mutate(
      { data: { title: "New Conversation" } },
      {
        onSuccess: (chat) => {
          setLocation(`/chat/${chat.id}`);
        },
      }
    );
  };

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar variant="inset" className="border-r border-border bg-sidebar">
          <SidebarHeader className="h-16 flex items-center px-4 border-b border-sidebar-border">
            <Link href="/" className="flex items-center gap-3 w-full group">
              <img src={`${basePath}/logo.svg`} alt="LeasePro" className="w-8 h-8 rounded-lg" />
              <span className="font-serif font-semibold text-lg text-sidebar-foreground group-hover:text-primary transition-colors tracking-tight truncate">LeasePro</span>
            </Link>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <div className="px-2 py-2">
                <Button 
                  onClick={handleNewChat} 
                  className="w-full justify-start font-medium" 
                  size="sm"
                  disabled={createConversation.isPending}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Analysis
                </Button>
              </div>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider px-4">Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton 
                      asChild 
                      isActive={location.startsWith("/chat")}
                      className="font-medium"
                    >
                      <Link href="/chat">
                        <MessageSquare className="h-4 w-4" />
                        <span>Conversations</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton 
                      asChild 
                      isActive={location.startsWith("/documents")}
                      className="font-medium"
                    >
                      <Link href="/documents">
                        <Files className="h-4 w-4" />
                        <span>Document Library</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {conversations && conversations.length > 0 && (
              <SidebarGroup className="mt-4">
                <SidebarGroupLabel className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider px-4">Recent</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {conversations.slice(0, 10).map((conv) => (
                      <SidebarMenuItem key={conv.id}>
                        <SidebarMenuButton 
                          asChild 
                          isActive={location === `/chat/${conv.id}`}
                          className="text-sm"
                        >
                          <Link href={`/chat/${conv.id}`}>
                            <span className="truncate">{conv.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-9 w-9 border border-sidebar-border bg-background">
                <AvatarImage src={user?.imageUrl} />
                <AvatarFallback className="text-xs font-medium">{user?.firstName?.charAt(0)}{user?.lastName?.charAt(0)}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col overflow-hidden">
                <span className="text-sm font-medium truncate text-sidebar-foreground">
                  {user?.fullName || user?.primaryEmailAddress?.emailAddress}
                </span>
                <span className="text-xs text-sidebar-foreground/60 truncate">
                  Property Manager
                </span>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="ml-auto text-sidebar-foreground/60 hover:text-destructive shrink-0" 
                onClick={() => signOut({ redirectUrl: basePath || "/" })}
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col min-w-0">
          <header className="h-16 flex items-center px-4 md:hidden border-b border-border shrink-0">
            <SidebarTrigger />
            <span className="ml-4 font-serif font-medium">LeasePro</span>
          </header>
          <div className="flex-1 overflow-auto bg-background">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
