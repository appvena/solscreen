import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import LoginScreen from "./components/LoginScreen";
import { trpc } from "./lib/trpc";

function AuthGate() {
  const session = trpc.appAuth.session.useQuery(undefined, { retry: 1, refetchOnWindowFocus: true });
  if (session.isLoading) return <div className="login-shell" aria-busy="true" />;
  if (session.isError) {
    return (
      <div className="login-shell">
        <div className="login-card"><h1 className="login-title">Server tidak terjangkau</h1><p className="login-copy">Coba muat ulang halaman beberapa saat lagi.</p></div>
      </div>
    );
  }
  return session.data?.authenticated ? <Home /> : <LoginScreen />;
}

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={AuthGate} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
