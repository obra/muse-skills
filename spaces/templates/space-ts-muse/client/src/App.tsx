// Muse web artifact scaffold. Replace this `App` with your real UI.
//
// What renders below is a deliberately plain "build in progress" placeholder.
// It is not a design. Replace it before submit.
//
// The QueryClientProvider is already wired in `main.tsx` using the SDK's
// `spaceQueryClient`. Just import what you need from `@tanstack/react-query`
// and your typed `api` from `./api`. Don't construct your own `QueryClient`;
// the client validator rejects it.
//
// Typical pattern:
//
//   import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
//   import { api, type ApiResponse } from "./api";
//
//   type Item = ApiResponse<typeof api, "listItems">["items"][number];
//
//   export function App() {
//     const queryClient = useQueryClient();
//
//     const items = useQuery({
//       queryKey: ["items"],
//       queryFn: () => api.listItems({ limit: 50 }),
//     });
//
//     const addItem = useMutation({
//       mutationFn: (text: string) => api.addItem({ text }),
//       onSuccess: () => queryClient.invalidateQueries({ queryKey: ["items"] }),
//     });
//
//     if (items.isPending) return <p>Loading…</p>;
//     if (items.error) return <p>Failed: {String(items.error)}</p>;
//     return (
//       <ul>{items.data.items.map((i: Item) => <li key={i.id}>{i.text}</li>)}</ul>
//     );
//   }
//
// Query keys are tuples: include any args that affect the response
// (`["items", { limit, topic }]`) so cached results don't bleed across
// filters. Derive types from actions with `ApiRequest<typeof api, "name">`
// and `ApiResponse<typeof api, "name">` (re-exported from `./api`).
//
// `App` must be a NAMED export (`export function App`), not `export default`,
// because `main.tsx` imports it as `{ App }`.
//
// Name every control you render. The audit addresses an element by its
// accessible name, and a placeholder is not one — two number inputs both
// reporting "-" are indistinguishable to it and to a screen reader:
//
//   <input aria-label="Weight in kg" placeholder="—" />
//   <button aria-label="Add item">+</button>
//
// A visible label works too, as long as it is bound to the field:
// `<label htmlFor="weight">` next to `<input id="weight">`.
//
// `SafeAreaTopScrim` below keeps scrolled content readable under the top
// safe-area inset. Keep it, or replace it with a fixed or sticky header that
// uses `pt-safe`; do not use both.

import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api } from "./api";
import { SettingsIcon } from "@space/icons";

export function App() {
  // Tiny placeholder query so the react-query wiring is exercised on first
  // load and the user sees a friendly screen if they open this artifact before
  // the real UI is in place.
  const scaffold = useQuery({
    queryKey: ["scaffold-status"],
    queryFn: () => Promise.resolve({ apiReady: api != null }),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Remove this if your real UI uses a fixed/sticky pt-safe top header. */}
      <SafeAreaTopScrim backgroundColor="var(--background)" />

      <main className="px-4 pb-6">
        {/* Hatch's header already shows the artifact's name: no title
            heading here, and no filler copy. */}
        <div className="py-12 text-center">
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <SettingsIcon size={16} decorative />
            {scaffold.isPending ? "Loading…" : "Setting up…"}
          </p>
        </div>
      </main>
    </div>
  );
}
