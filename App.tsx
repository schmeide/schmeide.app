import { Hero } from "./components/Hero";

// Root layout only: composes sections, holds no page content of its own.
export function App() {
  return (
    <main>
      <Hero />
    </main>
  );
}
