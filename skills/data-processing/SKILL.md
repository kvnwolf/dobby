---
name: data-processing
description: The write-side conventions for this app — forms (useAppForm from @/shared, Zod validation, field + dialog anatomy) and mutation UX (submit-validated dialogs, optimistic in-place toggles, type-to-confirm, toasts). Use when creating, editing, migrating, or refactoring any form, input, validation, submit flow, or data mutation. Write-side partner to /dobby:data-fetching.
model: opus
effort: medium
---

This is the **write side** of the app — everything that changes server data, with forms as its primary surface. The read-side partner is `/dobby:data-fetching`. Form anatomy and validation come first; the **Mutations** section governs how a submit/toggle/delete behaves and feels.

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
- ALWAYS trim string values in `onSubmit` before sending — see Patterns: trim on submit

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

### Trim on submit

String values MUST be trimmed before they leave the form. TanStack Form's Standard Schema validation does NOT propagate transforms into the submitted value: a `z.string().trim()` in `validators` **validates against the trimmed value but still hands `onSubmit` the raw, untrimmed input** ([TanStack Form — submission handling](https://tanstack.com/form/latest/docs/framework/react/guides/submission-handling)). So trim explicitly in `onSubmit`.

Build the outgoing payload as an explicit `data` object, trimming each string field as you assemble it — email-type fields also `.toLowerCase()`. Submit `data`, never the raw `value`:

```tsx
onSubmit: async ({ formApi, value }) => {
  const data = {
    email: value.email.trim().toLowerCase(),
    firstName: value.firstName.trim(),
    lastName: value.lastName.trim(),
  };
  try {
    const res = await inviteAdmin(data);
    // ...success / server-error handling
  } catch {
    // ...
  }
},
```

Per-field and explicit — no generic trim-all helper. The same gotcha applies to ANY schema transform (`.toLowerCase()`, `.coerce`, etc.), so apply whatever normalization a field needs right here while building `data`.

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

## Mutations

How a write behaves once submitted. The default is **submit-validated**; optimism is the rare exception, not the baseline.

### Optimistic vs submit-validated

| Mutation | Strategy |
|----------|----------|
| In-place **faithful row toggle** — a boolean flip on a row already on screen (disable/reactivate, archive/unarchive) where the new UI state is fully known client-side and rollback is trivial | **Optimistic** — flip now, reconcile on response |
| Everything else — create, delete, edits with server-computed results, anything that needs server authority (auth, permissions, uniqueness) | **Submit-validated** — await the server, then reflect. NO optimism |

Optimism is justified only when the client already knows the exact post-state and a failure can cleanly roll back. A create can't (no server id yet); a permission-gated action can't (only the server knows the verdict). When unsure, submit-validated.

```tsx
// Optimistic in-place toggle: flip immediately, roll back on failure
async function toggleActive(row) {
  const next = !row.active;
  setRowActive(row.id, next);                 // optimistic flip
  const res = await setMemberActive(row.id, next);
  if (!res.ok) {
    setRowActive(row.id, row.active);         // rollback to prior state
    toast.error("Couldn't update — reverted");
  }
}
```

### Dialog & destructive mutations

- **FormDialog locks while submitting** — the dialog can't be closed or re-submitted mid-flight. `form.Submit` already shows the spinner; don't let `onOpenChange` dismiss while `form.state.isSubmitting`.
- **Type-to-confirm for destructive actions** — irreversible operations (delete, purge) require typing the entity's name/identifier to enable the destructive button. A bare "Are you sure?" is not enough.
- **Toasts** — every mutation reports its outcome: `toast.success` on completion, `toast.error` (with the reverted-state note for optimistic ones) on failure. Submit-validated mutations toast after the awaited response; optimistic ones toast only on the rollback path.

## Acceptance checklist

- [ ] Uses `useAppForm` from `@/shared/use-app-form`
- [ ] Validates with Zod via `validators.onSubmit`
- [ ] Entity-bound form: imports the entity schema and uses `.pick({...})` / `.extend({...})` — NEVER duplicates field rules or messages
- [ ] Standalone form (auth/search/filter): zod schema defined locally in the form file
- [ ] `onSubmit` builds an explicit `data` object trimming each string field (`value.x.trim()`, email also `.toLowerCase()`) and submits `data`, never raw `value`
- [ ] Form-only fields not present on the entity are added via `.extend({...})` on the picked schema
- [ ] Every field has `Root`, `Label`, `Control`, `ErrorMessage`
- [ ] Uses `form.Root` as wrapper, `form.Submit` for submit button
- [ ] Polymorphic fields use `render` prop, not manual binding
- [ ] Dialog forms use `render={<form.Root />}` on `DialogContent`/`AlertDialogContent`
- [ ] Dialog forms call `form.reset()` on close via `onOpenChange`
- [ ] Nested sub-forms inside modals also reset independently
- [ ] Mutation strategy chosen deliberately: optimistic ONLY for faithful in-place row toggles (with rollback); everything else submit-validated
- [ ] FormDialog can't close or re-submit while `form.state.isSubmitting`
- [ ] Destructive actions gated by type-to-confirm, not a bare confirm dialog
- [ ] Every mutation reports outcome via `toast.success` / `toast.error`
