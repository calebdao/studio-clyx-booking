import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import BookPage from "@/pages/book";
import AdminPage from "@/pages/admin";
import { Shell } from "@/components/shell";
import { AdminProvider, BookingProvider } from "@/lib/booking-store";

function AppRouter() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={BookPage} />
        <Route path="/admin" component={AdminPage} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminProvider>
        <BookingProvider>
          <TooltipProvider>
            <Toaster />
            <Router hook={useHashLocation}>
              <AppRouter />
            </Router>
          </TooltipProvider>
        </BookingProvider>
      </AdminProvider>
    </QueryClientProvider>
  );
}

export default App;
