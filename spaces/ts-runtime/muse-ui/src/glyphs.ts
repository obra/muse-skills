/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
// The glyphs the components draw themselves, copied at weight 400 from
// spaces/icons/icons.json.gz (XMDS Outline), the same icons and weight the Muse
// web app draws for these controls. Geometry only: builder-chosen icons arrive
// as props from `@space/icons`, resolved by the artifact build.
import type { IconGlyph } from "@hatch/space-sdk/icons";

export const CloseGlyph: IconGlyph<"x", 400> = {
  name: "x",
  weight: 400,
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M17.75 5.02C18.09 4.68 18.64 4.68 18.98 5.02C19.32 5.36 19.32 5.91 18.98 6.26L13.24 12L18.98 17.75C19.32 18.09 19.32 18.64 18.98 18.98C18.64 19.32 18.09 19.32 17.75 18.98L12 13.24L6.26 18.98C5.91 19.32 5.36 19.32 5.02 18.98C4.68 18.64 4.68 18.09 5.02 17.75L10.76 12L5.02 6.26C4.68 5.91 4.68 5.36 5.02 5.02C5.36 4.68 5.91 4.68 6.26 5.02L12 10.76L17.75 5.02Z",
      fill: "currentColor"
    }
  ],
};

export const CheckGlyph: IconGlyph<"check", 400> = {
  name: "check",
  weight: 400,
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M19.8 3.98C20.09 3.59 20.63 3.51 21.02 3.8C21.41 4.08 21.49 4.63 21.2 5.02L9.7 20.52C9.55 20.74 9.3 20.86 9.03 20.87C8.77 20.88 8.51 20.77 8.34 20.57L2.34 13.57C2.02 13.2 2.06 12.65 2.43 12.34C2.8 12.02 3.35 12.06 3.66 12.43L8.95 18.6L19.8 3.98Z",
      fill: "currentColor"
    }
  ],
};

// Toolbar.Back; Hatch back buttons use the same chevron.
export const BackGlyph: IconGlyph<"chevronLeft", 400> = {
  name: "chevronLeft",
  weight: 400,
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M14.38 3.38C14.72 3.04 15.28 3.04 15.62 3.38C15.96 3.72 15.96 4.28 15.62 4.62L8.24 12L15.62 19.38C15.96 19.72 15.96 20.28 15.62 20.62C15.28 20.96 14.72 20.96 14.38 20.62L6.38 12.62C6.04 12.28 6.04 11.72 6.38 11.38L14.38 3.38Z",
      fill: "currentColor"
    }
  ],
};

// Sidebar.Toggle; Hatch's menu button uses navicon.
export const MenuGlyph: IconGlyph<"navicon", 400> = {
  name: "navicon",
  weight: 400,
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M21.5 17.13C21.98 17.13 22.38 17.52 22.38 18C22.38 18.48 21.98 18.88 21.5 18.88H2.5C2.02 18.88 1.63 18.48 1.63 18C1.63 17.52 2.02 17.13 2.5 17.13H21.5Z",
      fill: "currentColor"
    },
    {
      d: "M21.5 11.13C21.98 11.13 22.38 11.52 22.38 12C22.38 12.48 21.98 12.88 21.5 12.88H2.5C2.02 12.88 1.63 12.48 1.63 12C1.63 11.52 2.02 11.13 2.5 11.13H21.5Z",
      fill: "currentColor"
    },
    {
      d: "M21.5 5.13C21.98 5.13 22.38 5.52 22.38 6C22.38 6.48 21.98 6.88 21.5 6.88H2.5C2.02 6.88 1.63 6.48 1.63 6C1.63 5.52 2.02 5.13 2.5 5.13H21.5Z",
      fill: "currentColor"
    }
  ],
};

// Sidebar.Search; as in Hatch's sidebar search field.
export const SearchGlyph: IconGlyph<"search", 400> = {
  name: "search",
  weight: 400,
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M10 1.13C14.9 1.13 18.88 5.1 18.88 10C18.88 12.14 18.12 14.09 16.86 15.63L21.62 20.38C21.96 20.72 21.96 21.28 21.62 21.62C21.28 21.96 20.72 21.96 20.38 21.62L15.63 16.86C14.09 18.12 12.14 18.88 10 18.88C5.1 18.88 1.13 14.9 1.13 10C1.13 5.1 5.1 1.13 10 1.13ZM10 2.88C6.06 2.88 2.88 6.06 2.88 10C2.88 13.94 6.06 17.13 10 17.13C13.94 17.13 17.13 13.94 17.13 10C17.13 6.06 13.94 2.88 10 2.88Z",
      fill: "currentColor"
    }
  ],
};
