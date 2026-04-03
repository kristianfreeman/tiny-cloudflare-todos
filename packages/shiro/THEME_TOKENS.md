# Theme Tokens

## Core Typography

- `--row-font-size`
- `--row-line-height`
- `--font-weight-normal`
- `--font-weight-medium`
- `--font-weight-strong`

## Row Grid Engine

- `--grid-row-height`
- `--row-border-width`
- `--grid-row-gap`
- `--grid-row-padding-inline`
- `--grid-row-padding-block`

## Control Sizing

- `--control-inline-padding`
- `--control-height`

## Surfaces

- `--bg`
- `--panel`
- `--panel-subtle`
- `--weekend-bg`

## Text Palette

- `--text`
- `--text-white`
- `--text-gray-1`
- `--text-gray-2`
- `--text-gray-3`
- `--text-muted`

## Semantic Colors

- `--accent`
- `--accent-strong`
- `--danger`
- `--alert`
- `--success`
- `--focus-ring`
- `--row-warning-bg`
- `--row-alert-bg`

## Row Text Style Mapping

- `style="primary"` -> `--text-gray-1`, medium, normal
- `style="secondary"` -> `--text-gray-2`, normal, normal
- `style="muted"` -> `--text-gray-3`, normal, normal
- `style="contrast"` -> `--text-muted`, normal, italic
- `style="warning"` -> `--alert`, medium, italic
- `style="alert"` -> `--danger`, strong, normal
- `style="title"` + `as="h1"` -> `--text-white`, strong, normal
- `style="title"` + `as="h2"` -> `--text-white`, normal, underline
- `style="title"` + `as="h3"` -> `--text-white`, medium, normal
- `style="group-header"` + `as="h3"` -> `--text-white`, medium, italic

## Notes

- `--grid-row-height` is the primary sizing knob; font size, spacing, and control insets derive from it.
- Default derivation targets ~`1rem` row text at `--grid-row-height: 2.1rem`; mobile can safely override only `--grid-row-height` for proportional scaling.
- All row spacing and height should derive from row tokens only.
- Buttons and inputs should derive size from `--control-height`.
- New themes should override tokens, not component class rules.
