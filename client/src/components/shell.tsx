import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Sun, Moon, Eye } from "lucide-react";
import { ClyxLogo } from "@/components/clyx-logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const isAdmin = location.startsWith("/admin");

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-card-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="max-w-[1280px] mx-auto px-5 lg:px-8 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center" data-testid="link-home">
            <ClyxLogo />
          </Link>

          <nav className="flex items-center gap-1.5">
            <NavLink href="/" active={!isAdmin} testid="nav-book">
              Book
            </NavLink>
            <NavLink href="/admin" active={isAdmin} testid="nav-admin">
              <Eye className="w-3.5 h-3.5 mr-1.5" />
              Operator
            </NavLink>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
              data-testid="button-theme-toggle"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-card-border">
        <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-6 text-xs text-muted-foreground flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>© {new Date().getFullYear()} Studio Clyx</span>
        </div>
      </footer>
    </div>
  );
}

function NavLink({
  href,
  active,
  children,
  testid,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testid}
      className={cn(
        "px-3 py-1.5 rounded-md text-sm font-medium transition flex items-center",
        "hover-elevate",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </Link>
  );
}
