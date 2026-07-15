import { Show } from "@clerk/react";
import { Redirect, Link } from "wouter";
import { ArrowRight, Building, FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/chat" />
      </Show>
      
      <Show when="signed-out">
        <div className="min-h-screen flex flex-col bg-background selection:bg-primary/20 selection:text-primary">
          <header className="px-6 h-20 flex items-center justify-between max-w-7xl mx-auto w-full">
            <div className="flex items-center gap-3">
              <img src={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/logo.svg`} alt="LeasePro" className="w-8 h-8 rounded-lg" />
              <span className="font-serif font-semibold text-xl text-primary tracking-tight">LeasePro</span>
            </div>
            <nav className="flex items-center gap-4">
              <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                Sign In
              </Link>
              <Link href="/sign-up">
                <Button className="font-medium">Get Started</Button>
              </Link>
            </nav>
          </header>

          <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 max-w-5xl mx-auto w-full">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/5 text-primary text-sm font-medium mb-8 border border-primary/10">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-40"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              The trusted advisor at your leasing desk
            </div>
            
            <h1 className="text-5xl md:text-7xl font-serif tracking-tight text-foreground max-w-4xl mx-auto mb-8 leading-[1.1]">
              Commercial lease intelligence, <span className="text-primary italic">clarified.</span>
            </h1>
            
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-12 leading-relaxed">
              Upload your complex portfolio of leases and ask questions in plain English. Get precise, authoritative answers backed by full-text search across all your documents.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full sm:w-auto">
              <Link href="/sign-up" className="w-full sm:w-auto">
                <Button size="lg" className="w-full sm:w-auto text-base h-14 px-8 group">
                  Start analyzing leases
                  <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </Button>
              </Link>
            </div>

            <div className="mt-32 grid md:grid-cols-3 gap-8 text-left w-full border-t border-border pt-16">
              <div className="space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                  <FileText className="w-6 h-6" />
                </div>
                <h3 className="font-serif text-xl font-medium">Any format accepted</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Upload PDFs, Word documents, or Excel rent rolls. LeasePro parses and structures the data automatically.
                </p>
              </div>
              <div className="space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                  <Search className="w-6 h-6" />
                </div>
                <h3 className="font-serif text-xl font-medium">Precise answers</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Ask about escalations, renewals, or responsibilities. Get specific answers with exact document citations.
                </p>
              </div>
              <div className="space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                  <Building className="w-6 h-6" />
                </div>
                <h3 className="font-serif text-xl font-medium">Portfolio-wide</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Search across 50 to 200 leases simultaneously. Identify risks and opportunities across your entire building.
                </p>
              </div>
            </div>
          </main>
        </div>
      </Show>
    </>
  );
}
