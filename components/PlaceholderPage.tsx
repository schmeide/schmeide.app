import { copy } from "../data/copy";

// A route whose screen has its own ticket (see #43) and is not built yet.
export function PlaceholderPage({ title }: { readonly title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p>{copy.placeholder}</p>
    </>
  );
}
