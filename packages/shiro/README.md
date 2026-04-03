# SHIRO (Strictly Horizontal Interface Rows Only)

SHIRO is a row-first UI primitive package.

## Usage

```ts
import "shiro/styles.css";
import { Row, RowStack, Panel, ClickableRow, Button } from "shiro";
```

## Notes

- Row is the core primitive.
- `secondaryText` and `actions` are mutually exclusive by TypeScript type.
- Heading semantics are allowed only for title-style rows.
