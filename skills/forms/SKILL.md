---
name: forms
description: Required conventions for every form in this project — useAppForm from @/shared, Zod validation, field anatomy, submit/secondary buttons, dialog forms. Use when creating, editing, migrating, or refactoring any form, input field, validation, or submit flow.
model: opus
effort: medium
---

## Quick start

```tsx
import { z } from "zod";
import { useAppForm } from "@/shared/use-app-form";
```

Rules every form MUST follow:

- Always use `useAppForm` — NEVER raw TanStack Form hooks
- Validate with Zod. If the form edits an entity that already has a schema in its module, import it and use `.pick()`/`.extend()` — NEVER duplicate field rules. If the form is standalone (auth, search, filters), define a local schema — see Patterns: validation schema
- Use `field.Control` with `render` prop to bind UI components
- Every field MUST include `field.Root`, `field.Label`, `field.Control`, `field.ErrorMessage`
- Forms inside Dialogs MUST use `render` prop on `DialogContent` — see Patterns: dialog forms
- Forms inside Dialogs MUST call `form.reset()` on close — see Patterns: form reset

## Patterns

### Form API

| Component | Use |
|-----------|-----|
| `form.Root` | Wrapper — provides form context, handles submit |
| `form.AppField` | Creates a field with access to field sub-components |
| `form.Submit` | Submit button — auto-disables when pristine/invalid/submitting; shows a spinner while submitting (never hand-roll one) |
| `form.Button` | Non-submit button (`type="button"`) for secondary in-form actions (cancel, resend) — auto-disables while submitting, merged with caller `disabled` |
| `form.Subscribe` | Subscribe to form state for custom rendering |

### Field API

All components available inside the `form.AppField` render callback:

| Component | Use |
|-----------|-----|
| `field.Root` | Wraps field, connects `aria-invalid` and `aria-describedby` |
| `field.Label` | Label — auto-connects to input via `for`/`id` |
| `field.Control` | Input wrapper — handles value/onChange binding |
| `field.ErrorMessage` | Shows validation errors |

### Validation schema

Two cases — pick the right one:

**1. Form bound to an entity** (create/edit forms over a table or domain object)

Import the entity's zod schema from its module and use `.pick()`/`.extend()`. Single source of truth for validation rules AND error messages — change them in `schema.ts`, both domain and form pick them up.

```ts
// modules/books/schema.ts (entity — single source of truth)
export const bookSchema = z.object({
  id: z.string().min(1, "Id is required"),
  title: z.string().min(1, "Title is required"),
  author: z.string().min(1, "Author is required"),
  year: z.coerce.number().int().min(0, "Invalid year"),
});
```

```tsx
// modules/books/edit-book-form.tsx
import { bookSchema } from "./schema";

const form = useAppForm({
  defaultValues: { title: "", author: "" },
  validators: { onSubmit: bookSchema.pick({ title: true, author: true }) },
  onSubmit: async ({ value }) => { /* ... */ },
});
```

If the form needs a field that doesn't exist on the entity (confirm-password, "agree to terms" toggle, captcha token), extend the picked schema instead of forking it:

```tsx
validators: {
  onSubmit: bookSchema.pick({ title: true }).extend({
    agreeToTerms: z.boolean().refine((v) => v, "Must accept terms"),
  }),
},
```

**2. Standalone form** (auth, search, filters — not tied to any entity)

Define a local zod schema right in the form file. There's nothing to reuse.

```tsx
const loginSchema = z.object({
  email: z.email("Invalid email"),
  password: z.string().min(8, "At least 8 characters"),
});

const form = useAppForm({
  defaultValues: { email: "", password: "" },
  validators: { onSubmit: loginSchema },
  onSubmit: async ({ value }) => { /* ... */ },
});
```

### Server errors

Zod handles client validation; failures from a server call surface on the relevant field via `errorMap.onSubmit` (renders through the same `field.ErrorMessage`):

```tsx
onSubmit: async ({ value, formApi }) => {
  const result = await verifyLoginCode(email, value.otp);
  if (!result.ok) {
    formApi.setFieldMeta("otp", (prev) => ({
      ...prev,
      errorMap: { ...prev.errorMap, onSubmit: { message: MESSAGES[result.reason] } },
      isTouched: true,
    }));
    return;
  }
  // success path
},
```

The next change-validation on the field clears the server error automatically.

### Polymorphic fields

`render` prop customizes the underlying element while keeping form state binding:

```tsx
<field.Root render={<InputGroup.Root />}>
  <field.Control render={<InputGroup.Input placeholder="Email" />} />
</field.Root>
```

### Programmatic control

| API | Use |
|-----|-----|
| `form.reset()` | Reset to default values |
| `form.setFieldValue("name", value)` | Set field value |
| `form.state.values` | Get current values |
| `form.validate()` | Trigger validation |

### Dialog forms

A form inside `DialogContent` or `AlertDialogContent` MUST use the `render` prop so the dialog content renders **as** the form. This makes fields and footer inherit the dialog's grid layout (`gap-6`) instead of being nested inside a separate form element.

```tsx
// Correct — DialogContent renders as the form
<DialogContent render={<form.Root form={form} />}>
  <DialogHeader>
    <DialogTitle>Add Item</DialogTitle>
  </DialogHeader>
  <FieldGroup>
    <form.AppField name="name">
      {(field) => (
        <field.Root>
          <field.Label>Name</field.Label>
          <field.Control render={<Input />} />
          <field.ErrorMessage />
        </field.Root>
      )}
    </form.AppField>
  </FieldGroup>
  <DialogFooter>
    <form.Submit>Create</form.Submit>
  </DialogFooter>
</DialogContent>
```

```tsx
// Wrong — form.Root nested inside DialogContent breaks grid spacing
<DialogContent>
  <form.Root form={form}>
    ...
  </form.Root>
</DialogContent>
```

If `render` is not viable (form is a child of a non-polymorphic container), use `className="contents"` on `form.Root` so it doesn't generate its own CSS box.

### Form reset

Forms inside Dialogs MUST call `form.reset()` when the container closes — prevents stale data and validation errors persisting on reopen.

- Call `form.reset()` in the Dialog's `onOpenChange` callback
- Call `form.reset()` in the `onSubmit` handler after async success
- Nested sub-forms (e.g. an OTP step inside a dialog) MUST reset independently

```tsx
const form = useAppForm({
  defaultValues: { name: "" },
  validators: { onSubmit: schema },
  onSubmit: async ({ value }) => {
    await createItem(value);
    form.reset();
    setOpen(false);
  },
});

<Dialog
  open={open}
  onOpenChange={(isOpen) => {
    if (!isOpen) form.reset();
    setOpen(isOpen);
  }}
>
  <DialogContent render={<form.Root form={form} />}>
    ...
  </DialogContent>
</Dialog>
```

**Do NOT reset** forms that persist on the page (settings cards, inline edit) — reset only applies when the container is unmounted or hidden.

### Accessibility

Base UI Field handles automatically — no manual wiring needed:

- `aria-invalid` on invalid fields
- `aria-describedby` linking inputs to error messages
- `for`/`id` linking labels to inputs
- Disabled state during submission

## Acceptance checklist

- [ ] Uses `useAppForm` from `@/shared/use-app-form`
- [ ] Validates with Zod via `validators.onSubmit`
- [ ] Entity-bound form: imports the entity schema and uses `.pick({...})` / `.extend({...})` — NEVER duplicates field rules or messages
- [ ] Standalone form (auth/search/filter): zod schema defined locally in the form file
- [ ] Form-only fields not present on the entity are added via `.extend({...})` on the picked schema
- [ ] Every field has `Root`, `Label`, `Control`, `ErrorMessage`
- [ ] Uses `form.Root` as wrapper, `form.Submit` for submit button
- [ ] Polymorphic fields use `render` prop, not manual binding
- [ ] Dialog forms use `render={<form.Root />}` on `DialogContent`/`AlertDialogContent`
- [ ] Dialog forms call `form.reset()` on close via `onOpenChange`
- [ ] Nested sub-forms inside modals also reset independently
