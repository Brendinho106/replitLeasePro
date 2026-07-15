import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import {
  MessageSquare, Files, LogOut, Plus, MoreHorizontal,
  Pencil, Trash2, Check, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  useListOpenaiConversations,
  useCreateOpenaiConversation,
  useDeleteOpenaiConversation,
  getListOpenaiConversationsQueryKey,
} from "@workspace/api-client-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { ReactNode, useState, useRef, useEffect } from "react";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// ---------------------------------------------------------------------------
// ConversationItem — a single sidebar entry with rename + delete
// ---------------------------------------------------------------------------
function ConversationItem({
  conv,
  isActive,
}: {
  conv: { id: number; title: string; createdAt: string };
  isActive: boolean;
}) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const deleteConv = useDeleteOpenaiConversation();

  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameValue(conv.title);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [renaming, conv.title]);

  const submitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === conv.title) { setRenaming(false); return; }
    try {
      await fetch(`${basePath}/api/openai/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = () => {
    deleteConv.mutate(
      { id: conv.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          if (isActive) setLocation("/chat");
        },
      },
    );
    setDeleteDialogOpen(false);
  };

  const relativeDate = (() => {
    try {
      return formatDistanceToNow(new Date(conv.createdAt), { addSuffix: true });
    } catch {
      return "";
    }
  })();

  // Derive a short preview from the title (the backend already sets it to the
  // first message, so it doubles as a meaningful summary)
  const preview = conv.title.length > 60
    ? conv.title.slice(0, 60) + "…"
    : conv.title;

  return (
    <>
      <SidebarMenuItem>
        <div
          className={cn(
            "group relative flex w-full items-start rounded-md px-2 py-2 text-sm transition-colors cursor-pointer",
            "hover:bg-sidebar-accent",
            isActive && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
          )}
        >
          {renaming ? (
            /* ---- inline rename mode ---- */
            <div className="flex w-full items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Input
                ref={inputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="h-6 text-xs px-1 py-0 flex-1"
              />
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={submitRename}>
                <Check className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setRenaming(false)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            /* ---- normal display mode ---- */
            <>
              <Link
                href={`/chat/${conv.id}`}
                className="flex-1 min-w-0 flex flex-col gap-0.5"
              >
                <span className="truncate leading-snug text-sidebar-foreground">
                  {preview}
                </span>
                <span className="text-[10px] text-sidebar-foreground/40 leading-none">
                  {relativeDate}
                </span>
              </Link>

              {/* kebab menu — visible on hover or when open */}
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-6 w-6 shrink-0 ml-1 text-sidebar-foreground/40 hover:text-sidebar-foreground",
                      "opacity-0 group-hover:opacity-100 focus:opacity-100",
                      menuOpen && "opacity-100",
                    )}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="w-36">
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setRenaming(true); }}
                  >
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDeleteDialogOpen(true); }}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </SidebarMenuItem>

      {/* Delete confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{conv.title}&rdquo; and all its messages. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// SidebarLayout
// ---------------------------------------------------------------------------
export function SidebarLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();

  const { data: conversations } = useListOpenaiConversations();
  const createConversation = useCreateOpenaiConversation();
  const queryClient = useQueryClient();

  const handleNewChat = () => {
    createConversation.mutate(
      { data: { title: "New Chat" } },
      {
        onSuccess: (chat) => {
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          setLocation(`/chat/${chat.id}`);
        },
      },
    );
  };

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar variant="inset" className="border-r border-border bg-sidebar">
          <SidebarHeader className="h-16 flex items-center px-4 border-b border-sidebar-border">
            <Link href="/" className="flex items-center gap-3 w-full group">
              <img src={`${basePath}/logo.svg`} alt="LeasePro" className="w-8 h-8 rounded-lg" />
              <span className="font-serif font-semibold text-lg text-sidebar-foreground group-hover:text-primary transition-colors tracking-tight truncate">
                LeasePro
              </span>
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
              <SidebarGroupLabel className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider px-4">
                Navigation
              </SidebarGroupLabel>
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
              <SidebarGroup className="mt-2">
                <SidebarGroupLabel className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider px-4">
                  Recent
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {[...conversations].reverse().slice(0, 15).map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conv={conv}
                        isActive={location === `/chat/${conv.id}`}
                      />
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
                <AvatarFallback className="text-xs font-medium">
                  {user?.firstName?.charAt(0)}{user?.lastName?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col overflow-hidden">
                <span className="text-sm font-medium truncate text-sidebar-foreground">
                  {user?.fullName || user?.primaryEmailAddress?.emailAddress}
                </span>
                <span className="text-xs text-sidebar-foreground/60 truncate">Property Manager</span>
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
