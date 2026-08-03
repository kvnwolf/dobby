---
name: data-processing
description: The write-side conventions for this app — forms (useAppForm from @/shared, Zod validation, field + dialog anatomy) and mutation UX (submit-validated dialogs, optimistic in-place toggles, type-to-confirm, toasts). Use when touching any form, input, validation, submit flow, or data mutation. Write-side partner to /dobby:data-fetching.
---

This is the **write side** of the app — everything that changes server data, with forms as its primary surface. The read-side partner is `/dobby:data-fetching`. The **Mutations** section governs how a submit/toggle/delete behaves and feels.

## What the Gate now enforces

Rules below tagged `(enforced: Gate <id>)` are checked mechanically by `dobby check` on the stack path. The id is the convention inventory's ROW number, not a claim about the mechanism: `A*` rows mostly ship as native Biome rules, `B*` rows as the `conventions` filesystem scanner, `C*` rows as GritQL structural plugins — but a few rows moved tier without being renumbered (**A2** ships as a GritQL plugin; the cross-file **C2 / C3 / C12** ship as scanner checks).

- They surface **at edit time** (the PostToolUse hook reports findings on the file you just wrote) and again **at push** (the pre-push backstop refuses a red gate; `git push --no-verify` is the bypass).
- Every one is `error` severity, and the convention rules dobby ADDS carry no rewrite — `dobby check --fix` never rewrites convention code on their account. The already-enabled native Biome rules they ride alongside do apply their safe fix (A8 `useImportType` is corrected in place, at edit time too — the hook runs with `--write`).
- **Untagged rules are judgment.** Nothing checks them, so they hold only if you and review hold them. The conventions deliberately left unmechanized, each with its reason, are listed in `grit/CONTEXT.md` inside the `@kvnwolf/dobby` package — that list is the tier-(c) view, so it also names C2 / C3 / C12, which were re-landed as cross-file checks in the tier-(b) scanner (`src/conventions.ts` in the same package).

## Quick start

```tsx
import { z } from "zod";
import { useAppForm } from "@/shared/use-app-form";
```

Rules every form MUST follow:

- Always use `useAppForm` — NEVER raw TanStack Form hooks _(enforced: Gate A3 — the raw `@tanstack/react-form` hooks are importable only inside `src/shared`)_
- Validate with Zod _(enforced: Gate C18 — a `useAppForm({…})` whose inline options carry no `validators.onSubmit`)_. If the form edits an entity that already has a schema in its module, import it and use `.pick()`/`.extend()` — NEVER duplicate field rules. If the form is standalone (auth, search, filters), define a local schema — see Patterns: validation schema
- Use `field.Control` with `render` prop to bind UI components _(enforced: Gate C19)_
- Every field MUST include `field.Root`, `field.Label`, `field.Control`, `field.ErrorMessage` _(enforced: Gate C20)_
- Forms inside Dialogs MUST use `render` prop on `DialogContent` — see Patterns: dialog forms _(enforced: Gate C21)_
- Forms inside Dialogs MUST call `form.reset()` on close — see Patterns: form reset
- ALWAYS trim string values in `onSubmit` before sending — see Patterns: trim on submit _(enforced: Gate C23)_

## Patterns

### Form API

| Component | Use |
|-----------|-----|
| `form.Root` | Wrapper — provides form context, handles submit |
| `form.AppField` | Creates a field with access to field sub-components |
| `form.Submit` | Submit button — auto-disables when pristine/invalid/submitting; shows a spinner while submitting (never hand-roll one) _(enforced: Gate C25 — a `<Button type="submit">` inside a `form.Root` subtree)_ |
| `form.Button` | Non-submit button (`type="button"`) for secondary in-form actions (cancel, resend) — auto-disables while submitting, merged with caller `disabled` _(enforced: Gate C26 — a `<Button type="button">` inside a `form.Root` subtree)_ |
| `form.Subscribe` | Subscribe to form state for custom rendering |

### Field API

All components available inside the `form.AppField` render callback — all four of them, every time _(enforced: Gate C20)_:

| Component | Use |
|-----------|-----|
| `field.Root` | Wraps field, connects `aria-invalid` and `aria-describedby` _(enforced: Gate C27 — never hand-pass those props)_ |
| `field.Label` | Label — auto-connects to input via `for`/`id` _(enforced: Gate C27 — never hand-pass `htmlFor`)_ |
| `field.Control` | Input wrapper — handles value/onChange binding _(enforced: Gate C19 — always through its `render` prop)_ |
| `field.ErrorMessage` | Shows validation errors |

### Validation schema

**Name fields and word messages in the project's glossary.** Field names AND the error-message copy must use the exact domain terms from the project's `CONTEXT.md` glossary — not synonyms or invented labels: if the entity is a `Member`, the field is `member` and the message is `"Member is required"`, never "user"/"account"/"person". Entity-bound forms inherit both from the entity schema via `.pick()` (below); standalone forms have no entity to borrow from, so match the glossary by hand.

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

Define a local zod schema right in the form file. There's nothing to reuse. Zod v4 top-level validators only — `z.email("Invalid email")`, never the v3 chain `z.string().email()` _(enforced: Gate C33)_.

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

Build the outgoing payload as an explicit `data` object, trimming each string field as you assemble it — email-type fields also `.toLowerCase()` _(enforced: Gate C24 — an email-keyed property trimmed but not lowercased)_. Submit `data`, never the raw `value` _(enforced: Gate C23)_:

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

`render` prop customizes the underlying element while keeping form state binding _(enforced: Gate C19 — a `field.Control` without its `render` prop)_:

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

A form inside `DialogContent` or `AlertDialogContent` MUST use the `render` prop so the dialog content renders **as** the form _(enforced: Gate C21 — a `form.Root` nested in `DialogContent`/`AlertDialogContent` children instead of its `render` prop)_. This makes fields and footer inherit the dialog's grid layout (`gap-6`) instead of being nested inside a separate form element.

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

Base UI Field handles automatically — no manual wiring needed _(enforced: Gate C27 — `aria-invalid` / `aria-describedby` / `htmlFor` hand-passed to a `field.*` component)_:

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

A create can't be optimistic (no server id yet); a permission-gated action can't (only the server knows the verdict). When unsure, submit-validated.

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

## Testing

Test a form through its **public interface** — fill it, submit it, and assert on the observable outcome: a validation error rendered through `field.ErrorMessage`, the trimmed payload handed to the mutation, the `toast.success`/`toast.error`, the optimistic flip and its rollback. Do NOT reach into `form.state`, the Zod schema object, TanStack Form internals, or a specific component's props _(enforced: Gate C29 — `form.state` reached in a `*.test.*` / `*.spec.*` file)_. A good test reads like a rule from this skill ("submitting a blank required field shows its glossary message", "a failed optimistic toggle rolls the row back and toasts the revert").

The checkable criterion: the test **survives an internal refactor** — swapping `field.Control`'s underlying element, renaming a helper, or restructuring the submit handler must leave it green. If it wouldn't, it tested implementation, not behavior — rewrite it against the observable outcome. (This is the same behavior-not-implementation discipline `dobby:test-author` enforces.)

## Acceptance checklist

- [ ] Validation field names AND messages use the project glossary's exact terms (via the entity schema for bound forms; matched by hand for standalone) — no synonyms, no drift
- [ ] Uses `useAppForm` from `@/shared/use-app-form` _(enforced: Gate A3)_
- [ ] Validates with Zod via `validators.onSubmit` _(enforced: Gate C18 — inline options only)_
- [ ] Entity-bound form: imports the entity schema and uses `.pick({...})` / `.extend({...})` — NEVER duplicates field rules or messages
- [ ] Standalone form (auth/search/filter): zod schema defined locally in the form file, on zod v4 top-level validators (`z.email(…)`) _(enforced: Gate C33)_
- [ ] `onSubmit` builds an explicit `data` object trimming each string field (`value.x.trim()`, email also `.toLowerCase()`) and submits `data`, never raw `value` _(enforced: Gate C23+C24)_
- [ ] Form-only fields not present on the entity are added via `.extend({...})` on the picked schema
- [ ] Every field has `Root`, `Label`, `Control`, `ErrorMessage` _(enforced: Gate C20)_
- [ ] Uses `form.Root` as wrapper, `form.Submit` for submit button _(enforced: Gate C25; secondary in-form buttons are `form.Button`: C26)_
- [ ] Polymorphic fields use `render` prop, not manual binding _(enforced: Gate C19 for `field.Control`, C27 for hand-passed a11y props)_
- [ ] Dialog forms use `render={<form.Root />}` on `DialogContent`/`AlertDialogContent` _(enforced: Gate C21)_
- [ ] Dialog forms call `form.reset()` on close via `onOpenChange`
- [ ] Nested sub-forms inside modals also reset independently
- [ ] Mutation strategy chosen deliberately: optimistic ONLY for faithful in-place row toggles (with rollback); everything else submit-validated
- [ ] FormDialog can't close or re-submit while `form.state.isSubmitting`
- [ ] Destructive actions gated by type-to-confirm, not a bare confirm dialog
- [ ] Every mutation reports outcome via `toast.success` / `toast.error`
- [ ] Any tests drive the form's public interface and assert on observable outcomes (rendered errors, submitted payload, toasts, optimistic rollback) — never internal `form.state`/schema/component internals; they survive an internal refactor _(enforced: Gate C29 for `form.state` in a test file)_
