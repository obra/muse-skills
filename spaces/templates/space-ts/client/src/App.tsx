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
// The fixed gradient-mask layer below is Safe Areas approach B (top text
// protection). If your real UI has a fixed header at the top, replace
// the mask with approach A. See the Safe Areas section of the system
// prompt for both approaches.

import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api } from "./api";

export function App() {
  // Tiny placeholder query so the react-query wiring is exercised on first
  // load and the user sees a friendly screen if they open this artifact before
  // the real UI is in place.
  const scaffold = useQuery({
    queryKey: ["scaffold-status"],
    queryFn: () => Promise.resolve({ apiReady: api != null }),
  });

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Remove this if your real UI uses a fixed/sticky pt-safe top header. */}
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <main className="px-4 pb-6">
        <div className="py-12 text-center">
          <p className="text-sm uppercase tracking-wide text-[var(--dim)]">
            Setting up
          </p>
          <h1 className="mt-2 text-xl font-medium text-[var(--text)]">
            __SPACE_TITLE__
          </h1>
          <p className="mt-3 text-sm text-[var(--dim)]">
            {scaffold.isPending
              ? "Loading…"
              : "Your artifact is being set up. Check back in a moment."}
          </p>
        </div>
      </main>
    </div>
  );
}
